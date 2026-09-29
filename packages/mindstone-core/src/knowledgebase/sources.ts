import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

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

export function extractHtmlText(html: string): { title?: string; markdown: string } {
  const rawTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim();
  const title = rawTitle ? decodeHtmlEntities(rawTitle) : undefined;
  let body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  body = decodeHtmlEntities(
    body
      .replace(/<(script|style|nav|header|footer|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, text: string) => `\n# ${text.replace(/<[^>]+>/g, "").trim()}\n`)
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, text: string) => `\n## ${text.replace(/<[^>]+>/g, "").trim()}\n`)
      .replace(/<(p|div|li|br|tr)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
  const markdown = body
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, markdown };
}

/**
 * `timeoutMs` and `maxBytes` bound a fetch the gateway makes for the admin
 * API (#125); the CLI's `kb ingest` passes neither, as before.
 */
export async function loadUrlSourceDocument(
  source: MindStoneKbExternalSource,
  options: { now?: string; timeoutMs?: number; maxBytes?: number } = {},
): Promise<ExternalSourceDocument> {
  const url = source.url ?? "";
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
  const now = options.now ?? new Date().toISOString();
  let markdown = raw;
  let titleHint: string | undefined;
  if (contentType.includes("text/html") || /^\s*</.test(raw)) {
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
