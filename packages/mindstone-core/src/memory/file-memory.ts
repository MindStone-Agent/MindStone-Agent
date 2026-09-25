import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { MindStoneConfig } from "../config/index.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import type { MemoryDocument, MemoryKind } from "./types.js";

export type FileMemoryDiscoveryOptions = {
  config?: MindStoneConfig;
  paths?: MindStoneRuntimePaths;
};

type ParsedMarkdown = {
  frontmatter: Record<string, string>;
  body: string;
};

function resolveConfiguredPath(defaultPath: string, dataDir: string, value: string | undefined): string {
  if (!value) return defaultPath;
  return isAbsolute(value) ? value : resolve(dataDir, value);
}

/** Exported for test: the frontmatter contract is load-bearing and must be verifiable. */
export function parseMarkdown(raw: string): ParsedMarkdown {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized.trim() };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: normalized.trim() };
  const frontmatterText = normalized.slice(4, end).trim();
  const body = normalized.slice(end + "\n---".length).trim();
  const frontmatter: Record<string, string> = {};
  const lines = frontmatterText.split("\n");

  // Three behaviours this parser needs and did not have. Each was verified
  // against the real loop before being fixed, and each fails SILENTLY:
  //
  //  1. Block scalars. `invariant: >-` captured the literal ">-" as the value.
  //     A field that exists and says ">-" is worse than an absent one: it
  //     reports as covered, injects as present, and carries no rule.
  //
  //  2. Top-level precedence. Lines were trimmed before matching, so an
  //     indented `critical: false` under a `metadata:` block OVERWROTE a
  //     top-level `critical: true` on a later line. Last-wins silently
  //     demoted binding rules. Top level must win.
  //
  //  3. Container keys. `metadata:` itself matched with an empty value and
  //     landed in the map as noise.
  const topLevel = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const indented = /^\s/.test(line);
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();

    // A block scalar indicator means the value is the following indented lines.
    if (value === ">" || value === ">-" || value === "|" || value === "|-") {
      const fold = value.startsWith(">");
      const collected: string[] = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() === "") { collected.push(""); continue; }
        if (!/^\s/.test(lines[j])) break;
        collected.push(lines[j].trim());
        i = j;
      }
      value = fold ? collected.join(" ").trim() : collected.join("\n").trim();
    } else {
      value = value.replace(/^['"]|['"]$/g, "").trim();
    }

    // A container key (`metadata:` with nothing after it) is structure, not data.
    if (value === "" && !indented) { topLevel.add(key); continue; }

    if (indented && topLevel.has(key)) continue; // top level wins
    if (!indented) topLevel.add(key);
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

function firstMarkdownTitle(body: string): string | undefined {
  return body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "))
    ?.replace(/^#\s+/, "")
    .trim();
}

function kindFromFrontmatter(value: string | undefined, fallback: MemoryKind): MemoryKind {
  const normalized = value?.trim() as MemoryKind | undefined;
  if (!normalized) return fallback;
  const allowed: MemoryKind[] = ["identity", "journal", "doc", "wiki", "transcript", "checkpoint", "log", "index", "kb", "custom"];
  return allowed.includes(normalized) ? normalized : fallback;
}

function readMarkdownDocument(params: {
  path: string;
  root: string;
  fallbackKind: MemoryKind;
  idPrefix: string;
}): MemoryDocument | undefined {
  if (!existsSync(params.path) || !statSync(params.path).isFile()) return undefined;
  const raw = readFileSync(params.path, "utf-8");
  const parsed = parseMarkdown(raw);
  if (!parsed.body.trim()) return undefined;
  const relativePath = relative(params.root, params.path) || params.path;
  const title = parsed.frontmatter.description || firstMarkdownTitle(parsed.body) || parsed.frontmatter.name || relativePath;
  return {
    id: `${params.idPrefix}:${relativePath}`,
    kind: kindFromFrontmatter(parsed.frontmatter.type, params.fallbackKind),
    text: parsed.body,
    path: params.path,
    title,
    metadata: {
      relativePath,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      critical: parsed.frontmatter.critical,
      invariant: parsed.frontmatter.invariant,
      evergreen: parsed.frontmatter.evergreen,
      hits: parsed.frontmatter.hits,
      prevented: parsed.frontmatter.prevented,
      last_applied: parsed.frontmatter.last_applied,
    },
  };
}

function walkMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const output: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (name === "node_modules") continue;
      output.push(...walkMarkdownFiles(path));
      continue;
    }
    if (stats.isFile() && name.toLowerCase().endsWith(".md")) output.push(path);
  }
  return output;
}

export function discoverFileMemoryDocuments(options: FileMemoryDiscoveryOptions = {}): MemoryDocument[] {
  const paths = options.paths ?? runtimePathsFromEnv();
  const config = options.config;
  const filesConfig = config?.memory?.files ?? {};
  if (filesConfig.enabled === false) return [];

  const memoryDir = resolveConfiguredPath(paths.memoryDir, paths.dataDir, filesConfig.memoryDir);
  const journalsDir = resolveConfiguredPath(paths.journalDir, paths.dataDir, filesConfig.journalsDir);
  const logPath = resolveConfiguredPath(paths.logPath, paths.dataDir, filesConfig.logPath);
  const indexPath = resolveConfiguredPath(paths.memoryIndexPath, paths.dataDir, filesConfig.indexPath);
  const includeMemoryFiles = filesConfig.includeMemoryFiles ?? true;
  const includeJournals = filesConfig.includeJournals ?? true;
  const includeLog = filesConfig.includeLog ?? true;

  const docs: MemoryDocument[] = [];
  const seen = new Set<string>();
  const push = (doc: MemoryDocument | undefined) => {
    if (!doc || seen.has(doc.path ?? doc.id)) return;
    seen.add(doc.path ?? doc.id);
    docs.push(doc);
  };

  if (includeMemoryFiles) {
    push(readMarkdownDocument({ path: indexPath, root: paths.dataDir, fallbackKind: "index", idPrefix: "memory" }));
    for (const path of walkMarkdownFiles(memoryDir)) {
      push(readMarkdownDocument({ path, root: paths.dataDir, fallbackKind: path === indexPath ? "index" : "custom", idPrefix: "memory" }));
    }
  }

  if (includeJournals) {
    for (const path of walkMarkdownFiles(journalsDir)) {
      if (path.endsWith("/README.md")) continue;
      push(readMarkdownDocument({ path, root: paths.dataDir, fallbackKind: "journal", idPrefix: "journal" }));
    }
  }

  if (includeLog) {
    push(readMarkdownDocument({ path: logPath, root: paths.dataDir, fallbackKind: "log", idPrefix: "log" }));
  }

  return docs;
}
