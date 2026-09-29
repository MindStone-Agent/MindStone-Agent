import { lookup } from "node:dns/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { networkInterfaces } from "node:os";
import { bareHost, ipv4Of, isNonPublicHost } from "../provider/enterprise.js";

/**
 * External KB source providers (issue #23): feed OUTSIDE content into the #13
 * deterministic ingest pipeline. Two providers ship — `folder` (any local
 * directory, which also covers Obsidian vaults via wikilink normalization)
 * and `url` (fetched at INGEST TIME ONLY — never during search or recall).
 * Cloud providers (Notion, Drive, OneDrive/SharePoint, GitHub, RSS) are a
 * documented plan behind this same seam.
 *
 * TRUST BOUNDARY: external sources are declared in the KB's `kb.json`, which
 * is operator-authored configuration. No model-facing tool writes kb.json, so
 * URLs and folder paths are operator-trusted inputs. Fetched/parsed CONTENT
 * is still untrusted reference material — it flows into recall as clearly
 * labeled reference summaries, never as memory.
 */

export type MindStoneKbExternalSource = {
  id: string;
  type: "folder" | "url";
  /** folder: absolute path, or path relative to the KB dir. */
  path?: string;
  /** url: http(s) URL fetched at ingest time. */
  url?: string;
  /** Optional sensitivity label stamped on every entry from this source (e.g. "internal"). */
  sensitivity?: string;
  /**
   * url refresh policy: entries older than this are reported STALE by
   * `kb status` (re-run `kb ingest` to refresh). Absent = manual (never
   * auto-stale). Folder sources use real file mtimes instead.
   */
  refreshMs?: number;
};

export function parseExternalSources(raw: unknown): MindStoneKbExternalSource[] {
  if (!Array.isArray(raw)) return [];
  const sources: MindStoneKbExternalSource[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined;
    const type = record.type === "folder" || record.type === "url" ? record.type : undefined;
    if (!id || !type) continue;
    const path = typeof record.path === "string" && record.path.trim() ? record.path.trim() : undefined;
    const url = typeof record.url === "string" && record.url.trim() ? record.url.trim() : undefined;
    if (type === "folder" && !path) continue;
    if (type === "url" && !/^https?:\/\//.test(url ?? "")) continue;
    sources.push({
      id,
      type,
      path,
      url,
      sensitivity: typeof record.sensitivity === "string" && record.sensitivity.trim() ? record.sensitivity.trim() : undefined,
      refreshMs: typeof record.refreshMs === "number" && record.refreshMs > 0 ? record.refreshMs : undefined,
    });
  }
  return sources;
}

/**
 * A path segment that may be a credential, by the gateway's masking rule for
 * config reads (`maskUrlCredentials`): a colon, 24 or more characters, or 16
 * or more mixing letters and digits.
 */
function isSecretPathSegment(segment: string): boolean {
  if (segment.includes(":") || segment.length >= 24) return true;
  return segment.length >= 16 && /[A-Za-z]/.test(segment) && /\d/.test(segment);
}

/**
 * An address as it may be written down: in an error, a citation, recall text
 * (#125). No user name or password, no query and no fragment (shown as `?…`
 * when there was one, since no list of credential names is complete), matrix
 * parameters (`;jsessionid=…`) cut from each path segment, and a segment that
 * may be a credential written as `***`. What is fetched is the stored address.
 */
export function publicAddress(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname
      .split("/")
      .map((segment) => {
        const plain = segment.split(";")[0] ?? "";
        if (!plain) return plain;
        let decoded: string;
        try {
          decoded = decodeURIComponent(plain);
        } catch {
          // A stray "%" can't be read, so the segment isn't shown.
          return "***";
        }
        // Either form may look like a credential (the gateway checks the raw one).
        return isSecretPathSegment(decoded) || isSecretPathSegment(plain) ? "***" : plain;
      })
      .join("/");
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search || parsed.hash ? "?…" : ""}`;
  } catch {
    return "(an address that doesn't parse)";
  }
}

/** A response body as text, refused past `maxBytes` (read in chunks, never all at once first). */
async function readTextCapped(response: Response, maxBytes: number, sourceId: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`url source "${sourceId}" is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** One document yielded by a provider, ready for the deterministic section parser. */
export type ExternalSourceDocument = {
  /** Virtual source path, namespaced to avoid clashing with KB-local sources (e.g. "folder:notes/a.md"). */
  sourcePath: string;
  /** Absolute provenance: absolute file path or the URL. Rides into citations and recall metadata. */
  origin: string;
  raw: string;
  /** Real file mtime for folder docs; fetch time for url docs. */
  mtimeMs: number;
  fetchedAt?: string;
  sensitivity?: string;
  /** Title hint when the transport knows better than the markdown parser (e.g. HTML <title>). */
  titleHint?: string;
};

/**
 * Obsidian-style wikilink normalization: `[[Note|Label]]` → `Label`,
 * `[[Note]]` → `Note`, `![[embed]]` → `embed`. Applied to every folder-source
 * document — harmless for plain markdown, makes Obsidian vaults readable.
 */
export function normalizeWikilinks(text: string): string {
  return text.replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, label?: string) => (label ?? target).trim());
}

function walkMarkdownFilesUnder(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const output: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      output.push(...walkMarkdownFilesUnder(path));
      continue;
    }
    if (stats.isFile() && (name.toLowerCase().endsWith(".md") || name.toLowerCase().endsWith(".markdown"))) output.push(path);
  }
  return output;
}

export function loadFolderSourceDocuments(source: MindStoneKbExternalSource, kbDir: string): ExternalSourceDocument[] {
  const base = isAbsolute(source.path ?? "") ? resolve(source.path ?? "") : resolve(kbDir, source.path ?? "");
  const documents: ExternalSourceDocument[] = [];
  for (const path of walkMarkdownFilesUnder(base)) {
    documents.push({
      sourcePath: `folder:${source.id}/${relative(base, path)}`,
      origin: path,
      raw: normalizeWikilinks(readFileSync(path, "utf-8")),
      mtimeMs: statSync(path).mtimeMs,
      sensitivity: source.sensitivity,
    });
  }
  return documents;
}

/**
 * Deterministic HTML → text extraction (no dependencies, no model calls):
 * drop script/style/nav/header/footer, turn h1/h2 into markdown headings so
 * the section parser sees structure, strip remaining tags, decode the common
 * entities, collapse whitespace.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Elements whose content is dropped: code, styling and page chrome. */
const HTML_SKIPPED = new Set(["script", "style", "nav", "header", "footer", "noscript"]);
/** Elements that start a new line. */
const HTML_BLOCKS = new Set(["p", "div", "li", "br", "tr"]);

/**
 * The text of an HTML page as markdown-ish lines: its title, `#`/`##` for
 * h1/h2, a line per block element, everything else as spaces.
 *
 * One pass over the page with `indexOf`, never a backtracking regex: the
 * gateway runs this on fetched pages (#125), and a page built to be slow
 * ("<title>" repeated a million times) must not hold its event loop (#142
 * review). Every search starts where the last one ended, or is skipped once
 * it is known to find nothing.
 */
export function extractHtmlText(html: string): { title?: string; markdown: string } {
  // ASCII only, so every position in it is the same position in the page:
  // "İ".toLowerCase() is two characters long (#142 review).
  const lower = html.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  const tagName = (at: number): string => {
    let end = at;
    while (end < html.length && end - at < 16 && /[a-z0-9]/.test(lower[end]!)) end += 1;
    return lower.slice(at, end);
  };
  // The first <title ...>...</title>.
  let title: string | undefined;
  const titleAt = lower.indexOf("<title");
  if (titleAt >= 0) {
    const open = lower.indexOf(">", titleAt);
    const close = open >= 0 ? lower.indexOf("</title", open) : -1;
    if (close >= 0) {
      const raw = html.slice(open + 1, close).replace(/\s+/g, " ").trim();
      title = raw ? decodeHtmlEntities(raw) : undefined;
    }
  }
  // From the first <body ...> to the last </body>, or the whole page.
  let from = 0;
  let to = html.length;
  const bodyAt = lower.indexOf("<body");
  const bodyOpen = bodyAt >= 0 ? lower.indexOf(">", bodyAt) : -1;
  const bodyClose = lower.lastIndexOf("</body");
  if (bodyOpen >= 0 && bodyClose > bodyOpen) {
    from = bodyOpen + 1;
    to = bodyClose;
  }
  const out: string[] = [];
  // A skipped element whose closing tag is known to be missing is read as text, as before.
  const noClose = new Set<string>();
  let heading: string | undefined;
  let i = from;
  while (i < to) {
    const lt = html.indexOf("<", i);
    if (lt < 0 || lt >= to) {
      out.push(html.slice(i, to));
      break;
    }
    out.push(html.slice(i, lt));
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0 || gt >= to) {
      // No tag ends before the body does: the rest is text.
      out.push(html.slice(lt, to));
      break;
    }
    const closing = html[lt + 1] === "/";
    const name = tagName(lt + (closing ? 2 : 1));
    i = gt + 1;
    if (!closing && HTML_SKIPPED.has(name) && !noClose.has(name)) {
      const close = lower.indexOf(`</${name}`, i);
      const closeEnd = close >= 0 && close < to ? html.indexOf(">", close) : -1;
      if (closeEnd >= 0 && closeEnd < to) {
        out.push(" ");
        i = closeEnd + 1;
        continue;
      }
      noClose.add(name);
    }
    if ((name === "h1" || name === "h2") && !closing) {
      heading = name;
      out.push(`\n${name === "h1" ? "#" : "##"} `);
    } else if (closing && name === heading) {
      heading = undefined;
      out.push("\n");
    } else if (!closing && HTML_BLOCKS.has(name)) {
      out.push("\n");
    } else {
      out.push(" ");
    }
  }
  const markdown = decodeHtmlEntities(out.join(""))
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, markdown };
}

/** This machine's own addresses, every interface: a service on it listening on all of them is reachable at each (#142 review). */
function ownAddresses(): Set<string> {
  const own = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) own.add(bareHost(entry.address));
  }
  return own;
}

/** This machine or a link-local network (the cloud metadata addresses live there). */
function isThisMachineOrLinkLocal(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host === "::" || host === "::1" || /^fe[89ab][0-9a-f]?:/.test(host)) return true;
  const v4 = ipv4Of(host);
  return v4 !== undefined && (v4[0] === 127 || v4[0] === 0 || (v4[0] === 169 && v4[1] === 254) || (v4[0] === 168 && v4[1] === 63 && v4[2] === 129 && v4[3] === 16));
}

/**
 * Whether a private KB's URL may not reach this host (#142 review). Set only
 * by the gateway host's own environment, never from the Console:
 * - default: public hosts only, never one of this machine's own addresses;
 * - `MINDSTONE_KB_PRIVATE_HOSTS=1`: private networks too (an intranet wiki),
 *   still never this machine, link-local or metadata addresses;
 * - `MINDSTONE_KB_PRIVATE_HOSTS=any`: everything, for a test stub on this machine.
 */
export function kbUrlHostRefused(hostname: string): boolean {
  const mode = process.env.MINDSTONE_KB_PRIVATE_HOSTS;
  if (mode === "any") return false;
  const host = bareHost(hostname);
  if (ownAddresses().has(host) || isThisMachineOrLinkLocal(host)) return true;
  return mode === "1" ? false : isNonPublicHost(host);
}

/** Bounds on a private KB's URL fetch (#125, #142 review). */
export const KB_URL_FETCH_LIMITS = { timeoutMs: 20_000, maxBytes: 5 * 1024 * 1024, redirects: 5 } as const;

/** What a KB page may be: the extractor reads HTML, and markdown and plain text as they are. */
const KB_TEXT_TYPES = new Set(["text/html", "application/xhtml+xml", "text/markdown", "text/x-markdown", "text/plain"]);

class UrlHostRefused extends Error {}
class UrlBodyTooLarge extends Error {}

/**
 * The addresses to connect to: the host must not be refused by name, nor by
 * any address it resolves to (#142 review). A name refused for what it
 * resolves to fails like one that can't be fetched, so the errors don't say
 * which internal names exist. The lookup counts toward the time limit.
 */
async function checkedAddresses(hostname: string, refused: (host: string) => boolean, signal: AbortSignal): Promise<Array<{ address: string; family: number }>> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (refused(host)) throw new UrlHostRefused();
  const literal = isIP(host);
  if (literal) return [{ address: host, family: literal }];
  const resolved = await new Promise<Array<{ address: string; family: number }>>((resolveLookup, reject) => {
    const aborted = () => reject(new Error("timed out"));
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
    lookup(host, { all: true, verbatim: true }).then(resolveLookup, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
  if (!resolved.length || resolved.some((entry) => refused(entry.address))) throw new Error("not fetched");
  return resolved;
}

/**
 * One GET to the addresses that were checked, never a second lookup, so DNS
 * can't change them in between. All of them, so a host whose first address
 * doesn't answer (IPv6 before IPv4) is still reached on the next.
 * Exported for the URL guard smoke only.
 */
export function requestPinned(url: URL, pinned: Array<{ address: string; family: number }>, signal: AbortSignal): Promise<IncomingMessage> {
  const pinnedLookup = ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, pinned);
    else callback(null, pinned[0]!.address, pinned[0]!.family);
  }) as unknown as LookupFunction;
  return new Promise((resolveResponse, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const options: RequestOptions & { autoSelectFamily: boolean } = {
      method: "GET",
      headers: { Accept: "text/html, text/markdown, text/plain", "Accept-Encoding": "gzip, br" },
      signal,
      lookup: pinnedLookup,
      // Try each checked address in turn (the lookup is asked for all of them).
      autoSelectFamily: true,
      agent: false,
    };
    const request = send(url, options);
    request.on("response", resolveResponse);
    request.on("error", reject);
    request.end();
  });
}

/** The body, decompressed, and refused past `maxBytes` of text. */
async function readCappedBody(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const encoding = String(response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip()
    : encoding === "deflate" ? createInflate()
    : encoding === "br" ? createBrotliDecompress()
    : undefined;
  if (!decoder && encoding !== "identity" && encoding !== "") {
    response.destroy();
    throw new Error("unsupported encoding");
  }
  let stream: Readable = response;
  if (decoder) {
    response.on("error", (error) => decoder.destroy(error));
    response.on("aborted", () => decoder.destroy(new Error("aborted")));
    stream = response.pipe(decoder);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += (chunk as Buffer).length;
      if (total > maxBytes) throw new UrlBodyTooLarge();
      chunks.push(chunk as Buffer);
    }
  } finally {
    if (total > maxBytes || !response.complete) {
      response.destroy();
      decoder?.destroy();
    }
  }
  return Buffer.concat(chunks);
}

/**
 * A private KB's URL, fetched for the gateway (#125, #142 review):
 * - every hop's host is checked, by name and resolved address, and the
 *   connection goes to the checked address (no DNS rebinding);
 * - redirects are followed by hand, at most 5, each one checked again;
 * - HTML, markdown or plain text only, no NUL bytes, at most `maxBytes`
 *   after decompression, all within `timeoutMs`;
 * - errors say what went wrong in general terms (refused, timed out, an
 *   HTTP status), never a socket error code, and name the stored address
 *   as `publicAddress` writes it, never a redirect target.
 */
async function fetchPrivateKbUrl(
  start: string,
  sourceId: string,
  options: { refusedHost?: (host: string) => boolean; timeoutMs: number; maxBytes: number },
): Promise<{ contentType: string; raw: string }> {
  const refused = options.refusedHost ?? kbUrlHostRefused;
  const shown = publicAddress(start);
  const fail = (why: string) => new Error(`url source "${sourceId}" ${why}: ${shown}`);
  const signal = AbortSignal.timeout(options.timeoutMs);
  let url: URL;
  try {
    url = new URL(start);
  } catch {
    throw fail("is not an http or https address");
  }
  for (let hop = 0; ; hop += 1) {
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw fail(hop ? "redirected to an address that can't be fetched" : "is not an http or https address");
    }
    let response: IncomingMessage;
    try {
      response = await requestPinned(url, await checkedAddresses(url.hostname, refused, signal), signal);
    } catch (error) {
      if (error instanceof UrlHostRefused) {
        throw fail(hop ? "redirected to this machine or a private network, which isn't fetched" : "is on this machine or a private network, which isn't fetched");
      }
      throw fail(signal.aborted ? "timed out" : "could not be fetched");
    }
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      if (!location) throw fail("redirected with no address");
      if (hop >= KB_URL_FETCH_LIMITS.redirects) throw fail("redirected too many times");
      try {
        url = new URL(location, url);
      } catch {
        throw fail("redirected to an address that can't be fetched");
      }
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw fail(`fetch failed: HTTP ${status}`);
    }
    const contentType = String(response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (contentType && !KB_TEXT_TYPES.has(contentType)) {
      response.destroy();
      throw fail("is not HTML, markdown or plain text");
    }
    let body: Buffer;
    try {
      body = await readCappedBody(response, options.maxBytes);
    } catch (error) {
      if (error instanceof UrlBodyTooLarge) throw new Error(`url source "${sourceId}" is larger than ${options.maxBytes} bytes`);
      throw fail(signal.aborted ? "timed out" : "could not be fetched");
    }
    if (body.includes(0)) throw fail("is not text");
    return { contentType, raw: new TextDecoder().decode(body) };
  }
}

/**
 * `timeoutMs` and `maxBytes` bound a fetch; the CLI's `kb ingest` of a
 * global KB passes neither, as before. `privateKb` is a persona's private
 * KB (#125): its URLs come from the admin API, so they are fetched by
 * `fetchPrivateKbUrl`, public hosts only unless the host allows private ones.
 */
export async function loadUrlSourceDocument(
  source: MindStoneKbExternalSource,
  options: {
    now?: string;
    timeoutMs?: number;
    maxBytes?: number;
    /** `refusedHost` replaces `kbUrlHostRefused`, for tests on this machine only. */
    privateKb?: { refusedHost?: (host: string) => boolean };
  } = {},
): Promise<ExternalSourceDocument> {
  const url = source.url ?? "";
  if (options.privateKb) {
    const fetched = await fetchPrivateKbUrl(url, source.id, {
      refusedHost: options.privateKb.refusedHost,
      timeoutMs: options.timeoutMs ?? KB_URL_FETCH_LIMITS.timeoutMs,
      maxBytes: options.maxBytes ?? KB_URL_FETCH_LIMITS.maxBytes,
    });
    // Read as HTML only when it says it is HTML, or says nothing and starts
    // like HTML: a markdown page is kept as it is (#142 review).
    return urlDocument(source, url, fetched.contentType, fetched.raw, options.now, true);
  }
  // Errors name the address without its user name, password or query, which can hold a token (#125).
  const shown = publicAddress(url);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "text/html, text/markdown, text/plain" },
      ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
    });
  } catch (error) {
    // The reason by its code (ENOTFOUND, ECONNREFUSED, a TLS code), never
    // fetch's own message, which can repeat the address.
    const code = (error as { cause?: { code?: unknown } })?.cause?.code;
    const reason = error instanceof Error && error.name === "TimeoutError"
      ? "timed out"
      : `could not be fetched${typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? ` (${code})` : ""}`;
    throw new Error(`url source "${source.id}" ${reason}: ${shown}`);
  }
  if (!response.ok) {
    throw new Error(`url source "${source.id}" fetch failed: HTTP ${response.status} for ${shown}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const raw = options.maxBytes ? await readTextCapped(response, options.maxBytes, source.id) : await response.text();
  return urlDocument(source, url, contentType, raw, options.now);
}

function urlDocument(source: MindStoneKbExternalSource, url: string, contentType: string, raw: string, at?: string, byType = false): ExternalSourceDocument {
  const now = at ?? new Date().toISOString();
  let markdown = raw;
  let titleHint: string | undefined;
  const html = byType
    ? contentType.includes("html") || (!contentType && /^\s*</.test(raw))
    : contentType.includes("text/html") || /^\s*</.test(raw);
  if (html) {
    const extracted = extractHtmlText(raw);
    markdown = extracted.markdown;
    titleHint = extracted.title;
  }
  return {
    sourcePath: `url:${source.id}`,
    // The index, citations and recall text carry the public address (#125):
    // a token in the query stays out of every prompt.
    origin: publicAddress(url),
    raw: markdown,
    mtimeMs: Date.parse(now),
    fetchedAt: now,
    sensitivity: source.sensitivity,
    titleHint,
  };
}
