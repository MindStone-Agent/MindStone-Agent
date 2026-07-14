/**
 * Pack build tool (design §14 Phase 1): turn a pack source directory into a
 * signed .mspack archive. Dev tooling — production key management is a
 * Phase 2+ concern, but the output format is the real one, so build-tool
 * archives exercise the exact install path.
 *
 * Source layout = archive layout: pack.json at root, artifact dirs
 * (personas/, skills/, workflows/, knowledgebases/, memory/), optional
 * identity.md. MANIFEST.sha256 is generated (never hand-authored) and
 * safety.promptSurfaces is verified against the rule-derived set (or filled
 * in with --derive-surfaces).
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createTarGz, type TarFile } from "./tar.js";
import { sha256Hex, signArchiveDigest } from "./signing.js";
import { denylistScan, derivePromptSurfaces, formatFileDigests, parsePackManifest, promptSurfacesMatch } from "./manifest.js";
import type { PackManifest } from "./types.js";

export type PackBuildResult =
  | { ok: true; archivePath: string; signaturePath?: string; digest: string; manifest: PackManifest; warnings: string[] }
  | { ok: false; errors: string[] };

function walkFiles(root: string, dir = root): string[] {
  const output: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    const stats = statSync(path);
    if (stats.isDirectory()) output.push(...walkFiles(root, path));
    else if (stats.isFile()) output.push(relative(root, path).split("\\").join("/"));
  }
  return output;
}

export function buildPack(sourceDir: string, options: {
  outDir: string;
  /** "ed25519-priv:<base64>" — omit to produce an unsigned archive (dev only). */
  signingKey?: string;
  /** Overwrite safety.promptSurfaces with the rule-derived set instead of failing on mismatch. */
  deriveSurfaces?: boolean;
} ): PackBuildResult {
  const manifestPath = join(sourceDir, "pack.json");
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (error) {
    return { ok: false, errors: [`cannot read pack.json: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const relativePaths = walkFiles(sourceDir).filter((path) => path !== "pack.json" && path !== "MANIFEST.sha256");
  const warnings: string[] = [];

  // Derive-or-verify prompt surfaces BEFORE final validation so --derive-surfaces
  // can fill an empty list during authoring.
  const provisional = parsePackManifest(manifestRaw);
  if (!provisional.ok) return { ok: false, errors: provisional.errors };
  const manifest = provisional.manifest;

  const derived = derivePromptSurfaces(manifest, relativePaths);
  if (options.deriveSurfaces) {
    manifest.safety.promptSurfaces = derived;
    warnings.push(`promptSurfaces derived (${derived.length} file(s))`);
  } else if (!promptSurfacesMatch(manifest.safety.promptSurfaces, derived)) {
    return {
      ok: false,
      errors: [
        "safety.promptSurfaces does not match the rule-derived set (declared vs derived):",
        `  declared: ${JSON.stringify([...manifest.safety.promptSurfaces].sort())}`,
        `  derived:  ${JSON.stringify(derived)}`,
        "  (use --derive-surfaces to regenerate during authoring)",
      ],
    };
  }

  const files: TarFile[] = relativePaths.map((path) => ({ path, data: readFileSync(join(sourceDir, path)) }));

  const denylist = denylistScan(files);
  if (denylist.length > 0) return { ok: false, errors: ["denylist scan failed:", ...denylist.map((f) => `  ${f}`)] };

  const digests = new Map<string, string>();
  for (const file of files) digests.set(file.path, sha256Hex(file.data));
  const manifestJson = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  digests.set("pack.json", sha256Hex(manifestJson));

  const archiveFiles: TarFile[] = [
    { path: "pack.json", data: manifestJson },
    { path: "MANIFEST.sha256", data: Buffer.from(formatFileDigests(digests)) },
    ...files,
  ];
  const archive = createTarGz(archiveFiles);
  const digest = sha256Hex(archive);

  const baseName = `${manifest.id.replace("/", "__")}-${manifest.version}.mspack`;
  const archivePath = join(options.outDir, baseName);
  writeFileSync(archivePath, archive);

  let signaturePath: string | undefined;
  if (options.signingKey) {
    signaturePath = `${archivePath}.sig`;
    writeFileSync(signaturePath, `${signArchiveDigest(digest, options.signingKey)}\n`);
  } else {
    warnings.push("UNSIGNED archive (no signing key provided) — installable only via the two-act unsigned escape hatch");
  }

  return { ok: true, archivePath, signaturePath, digest, manifest, warnings };
}
