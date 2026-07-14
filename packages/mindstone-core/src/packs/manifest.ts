/**
 * Pack manifest validation — the §4 invariants of the approved #28 design.
 * Every check fails CLOSED: a manifest we cannot fully understand (unknown
 * schemaVersion, unknown promptSurfacesRule) refuses to install rather than
 * degrading. Prompt surfaces are re-derived at install time by the same
 * versioned rule the build tool used, and compared by exact sorted-list
 * equality — an undeclared prompt surface is an integrity FAILURE, because it
 * is exactly what an attacker would want.
 */
import type { TarFile } from "./tar.js";
import type { PackManifest } from "./types.js";
import { parseSemVer } from "./semver.js";

export const SUPPORTED_SCHEMA_VERSION = 1;
export const SUPPORTED_PROMPT_SURFACES_RULE = 1;
export const PACK_ID_RE = /^[a-z0-9-]{1,64}\/[a-z0-9-]{1,64}$/;
const ARTIFACT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export type ManifestValidation = { ok: true; manifest: PackManifest } | { ok: false; errors: string[] };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function parsePackManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  const m = raw as Partial<PackManifest> | null;
  if (!m || typeof m !== "object") return { ok: false, errors: ["pack.json is not an object"] };

  if (m.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return { ok: false, errors: [`unsupported manifest schemaVersion ${String(m.schemaVersion)} (this harness supports ${SUPPORTED_SCHEMA_VERSION}) — refusing (fail closed)`] };
  }
  if (typeof m.id !== "string" || !PACK_ID_RE.test(m.id)) errors.push(`invalid pack id ${JSON.stringify(m.id)}: expected <publisher>/<name>, segments [a-z0-9-]{1,64}`);
  if (m.class !== "content" && m.class !== "agent") errors.push(`invalid class ${JSON.stringify(m.class)}: expected "content" | "agent"`);
  if (typeof m.name !== "string" || !m.name.trim()) errors.push("missing pack name");
  if (typeof m.version !== "string" || !parseSemVer(m.version)) errors.push(`invalid SemVer version ${JSON.stringify(m.version)}`);
  if (typeof m.files !== "string" || !m.files.trim()) errors.push("missing files (MANIFEST.sha256 reference)");

  // Class invariants (§4): content MUST NOT carry runtime/identitySeed; agent MUST pin its image by digest.
  if (m.class === "content") {
    if (m.runtime !== undefined) errors.push('class "content" must not contain a runtime block');
    if (m.artifacts?.identitySeed !== undefined) errors.push('class "content" must not declare identitySeed');
  }
  if (m.class === "agent") {
    const ref = m.runtime?.image?.ref;
    if (typeof ref !== "string" || !/@sha256:[0-9a-f]{64}$/.test(ref)) {
      errors.push('class "agent" requires runtime.image.ref pinned by digest (…@sha256:<64 hex>); tag-only refs are rejected');
    }
  }

  if (!m.artifacts || typeof m.artifacts !== "object") {
    errors.push("missing artifacts block");
  } else {
    for (const kind of ["personas", "skills", "workflows", "knowledgebases"] as const) {
      const list = m.artifacts[kind];
      if (list === undefined) continue;
      if (!isStringArray(list)) { errors.push(`artifacts.${kind} must be a string array`); continue; }
      for (const id of list) {
        if (!ARTIFACT_ID_RE.test(id)) errors.push(`artifacts.${kind} id ${JSON.stringify(id)}: expected lowercase letters, digits, hyphens`);
      }
    }
  }

  if (m.dependencies !== undefined) {
    if (typeof m.dependencies !== "object" || Array.isArray(m.dependencies)) errors.push("dependencies must be an object of packId -> range");
    else {
      for (const [depId, range] of Object.entries(m.dependencies)) {
        if (!PACK_ID_RE.test(depId)) errors.push(`dependency id ${JSON.stringify(depId)} is not a valid pack id`);
        if (typeof range !== "string" || !range.trim()) errors.push(`dependency ${depId} has an empty range`);
      }
    }
  }

  if (!m.safety || typeof m.safety !== "object") {
    errors.push("missing safety block (review metadata is mandatory)");
  } else {
    if (!["reviewed", "unreviewed", "revoked"].includes(String(m.safety.reviewStatus))) {
      errors.push(`invalid safety.reviewStatus ${JSON.stringify(m.safety.reviewStatus)}`);
    }
    if (m.safety.promptSurfacesRule !== SUPPORTED_PROMPT_SURFACES_RULE) {
      errors.push(`unknown promptSurfacesRule ${String(m.safety.promptSurfacesRule)} (this harness supports rule ${SUPPORTED_PROMPT_SURFACES_RULE}) — refusing (fail closed)`);
    }
    if (!isStringArray(m.safety.promptSurfaces)) errors.push("safety.promptSurfaces must be a string array");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: m as PackManifest };
}

/**
 * Prompt-surface derivation, rule 1 (§4): EVERY archive-relative path whose
 * name ends in `.md` (case-insensitive), plus the declared identitySeed even
 * if it is not markdown — as a byte-wise-sorted list of POSIX relative paths.
 * Implemented identically at build and install so the two derivations cannot
 * drift.
 *
 * Loader-agnostic and exhaustive by DESIGN (adversarial QA #28, Findings 1 & 2):
 * the runtime loaders that inject markdown into the model context — persona /
 * safety overlays, skill SKILL.md, memory-seed recall (case-INsensitive:
 * `EVIL.MD` loads), and knowledgebase markdown source ingestion under each
 * knowledgebases/<id>/sources/ dir — do not share one hand-listed subset, so
 * a hand-listed subset always risks
 * missing a file a loader will inject. Enumerating every `.md` case-
 * insensitively closes that gap; over-listing a non-loaded `.md` is harmless
 * (the integrity check is exact-match), but missing a loaded one is the whole
 * integrity hole. Prompt text embedded in JSON artifacts (workflow steps,
 * skill.json fields, kb.json) remains covered by per-file digests and
 * whole-artifact review, per §4.
 */
export function derivePromptSurfaces(manifest: PackManifest, archivePaths: string[]): string[] {
  const surfaces = new Set<string>();
  for (const path of archivePaths) {
    if (path.toLowerCase().endsWith(".md")) surfaces.add(path);
  }
  if (manifest.artifacts.identitySeed) surfaces.add(manifest.artifacts.identitySeed);
  return [...surfaces].sort();
}

/** Exact sorted-list equality (a path-set comparison; no content canonicalization involved). */
export function promptSurfacesMatch(declared: string[], derived: string[]): boolean {
  if (declared.length !== derived.length) return false;
  const sorted = [...declared].sort();
  return sorted.every((path, index) => path === derived[index]);
}

/**
 * Denylist scan (§4 final invariant): packs must not contain secrets,
 * absolute host paths, or executable content outside deploy/. Runs at build
 * and at install. Textual heuristics — the scan REFUSES on hits; it is a
 * gate, not a guarantee, and the safety review remains the human layer.
 */
const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "private key material" },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, label: "provider API key (sk-…)" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, label: "Slack token" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, label: "GitHub token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key id" },
  { re: /\bed25519-priv:[A-Za-z0-9+/=]+/, label: "pack signing private key" },
];

export function denylistScan(files: TarFile[]): string[] {
  const findings: string[] = [];
  for (const file of files) {
    // Executable/interpreter content outside deploy/ (agent class). Content packs
    // ship inert data (markdown, JSON) — anything runnable is suspect. Broadened
    // past shells/binaries to interpreter scripts (adversarial QA #28, Finding 5).
    if (/\.(sh|bash|zsh|ps1|psm1|exe|dylib|so|bin|py|rb|pl|js|mjs|cjs|bat|cmd|com|scpt|command|jar|war|app)$/i.test(file.path) && !file.path.startsWith("deploy/")) {
      findings.push(`${file.path}: executable/interpreter content outside deploy/`);
      continue;
    }
    // Only scan text-ish payloads; digests protect binary integrity regardless.
    const text = file.data.toString("utf-8");
    if (text.includes("�")) continue;
    for (const { re, label } of SECRET_PATTERNS) {
      if (re.test(text)) findings.push(`${file.path}: ${label}`);
    }
    const absolute = /(?:^|[\s"'=])(\/(?:Users|home)\/[A-Za-z0-9._-]+\/)/.exec(text);
    if (absolute) findings.push(`${file.path}: absolute host path ${absolute[1]}…`);
  }
  return findings;
}

/** Parse MANIFEST.sha256 ("<sha256>  <path>" per line, sha256sum format). */
export function parseFileDigests(text: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([0-9a-f]{64})\s+(.+)$/.exec(trimmed);
    if (!match) throw new Error(`MANIFEST.sha256: unparseable line: ${trimmed}`);
    digests.set(match[2].trim(), match[1]);
  }
  return digests;
}

export function formatFileDigests(digests: Map<string, string>): string {
  return [...digests.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, digest]) => `${digest}  ${path}`)
    .join("\n") + "\n";
}
