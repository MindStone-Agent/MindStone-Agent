/**
 * Pack lifecycle — install / update / remove / verify (design §7.1, §7.2,
 * §10, D8). The staging discipline is the spine: every check runs against
 * staged, in-memory content; the live artifact stores are touched only at
 * the single COMMIT step, so a failure anywhere earlier leaves the runtime
 * exactly as it was (the skills drafts→install promotion, generalized).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MindStoneConfig } from "../config/types.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import { extractTarGz, type TarFile } from "./tar.js";
import { sha256Hex, verifyArchiveDigest } from "./signing.js";
import {
  denylistScan,
  derivePromptSurfaces,
  parseFileDigests,
  parsePackManifest,
  promptSurfacesMatch,
} from "./manifest.js";
import { satisfiesRange } from "./semver.js";
import {
  clearStaging,
  findOwningPack,
  installedPackDir,
  listInstalledPackIds,
  packPathsFromConfig,
  readPackLock,
  readReceipt,
  readTrustStore,
  trustedKeysForPublisher,
  writePackLock,
  writeReceipt,
  type PackPaths,
} from "./store.js";
import type { PackManifest, PackReceipt, PackReceiptFile } from "./types.js";

export function harnessVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINDSTONE_AGENT_VERSION ?? "0.0.0";
}

const ARTIFACT_ROOTS = ["personas", "skills", "workflows", "knowledgebases"] as const;

export type PackSafetySummary = {
  packId: string;
  version: string;
  tier?: string;
  class: string;
  signature: "verified" | "unsigned";
  reviewStatus: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewId?: string;
  promptSurfaces: string[];
  riskNotes: string[];
  boundaries: string[];
  installsInto: string[];
  dependencies: Array<{ id: string; range: string; installed?: string; satisfied: boolean }>;
};

export type PackInstallOptions = {
  config?: MindStoneConfig;
  paths?: MindStoneRuntimePaths;
  /** Detached signature (base64) — from <archive>.sig or --sig. */
  signature?: string;
  /** Two-act unsigned escape hatch: config packs.allowUnsigned AND this flag. */
  unsigned?: boolean;
  /** Accept an unreviewed pack non-interactively. */
  acceptUnreviewed?: boolean;
  /** Third act of the revoked-local-archive path (see design §7.1 step 9). */
  acceptRevoked?: boolean;
  /** Overwrite user-authored artifact collisions (backs the user file up first). */
  force?: boolean;
  /** Callback for the interactive confirm; absent = non-interactive. */
  confirm?: (summary: PackSafetySummary) => Promise<boolean>;
};

export type PackOperationResult =
  | {
      ok: true;
      packId: string;
      version: string;
      summary: string[];
      warnings: string[];
      conflicts: string[];
      trusted: boolean;
    }
  | { ok: false; errors: string[] };

type StagedPack = {
  manifest: PackManifest;
  files: TarFile[];
  archiveDigest: string;
  trusted: boolean;
  /** archivePath -> storePath (relative to dataDir). */
  installPlan: Map<string, string>;
};

/** Map an archive path to its live-store relative path; undefined = not an installable file. */
function storePathFor(manifest: PackManifest, archivePath: string): string | undefined {
  for (const root of ARTIFACT_ROOTS) {
    if (archivePath.startsWith(`${root}/`)) return archivePath;
  }
  const memorySeeds = manifest.artifacts.memorySeeds?.replace(/\/+$/, "");
  if (memorySeeds && archivePath.startsWith(`${memorySeeds}/`)) return undefined; // seeds are handled separately
  return undefined;
}

function artifactIdsFromArchive(files: TarFile[], root: string): Set<string> {
  const ids = new Set<string>();
  for (const file of files) {
    const match = new RegExp(`^${root}/([^/]+)/`).exec(file.path);
    if (match) ids.add(match[1]);
  }
  return ids;
}

function capabilityIdsFromJson(data: Buffer | undefined, key: string): string[] {
  if (!data) return [];
  try {
    const parsed = JSON.parse(data.toString("utf-8")) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown> | null)?.[key];
    return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Steps 1–7 of §7.1: verify, extract (guarded), validate, digest-check,
 * prompt-surface re-derivation, dependency + reference check. Pure staging —
 * no live-store writes.
 */
function stagePack(archive: Buffer, packPaths: PackPaths, dataDir: string, options: PackInstallOptions): { ok: true; staged: StagedPack; warnings: string[] } | { ok: false; errors: string[] } {
  const warnings: string[] = [];
  const archiveDigest = sha256Hex(archive);

  // Step 3 first mechanically (we need pack.json to know the publisher), but
  // nothing is trusted until the signature verdict below.
  let files: TarFile[];
  try {
    files = extractTarGz(archive);
  } catch (error) {
    return { ok: false, errors: [`archive refused: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const manifestFile = files.find((file) => file.path === "pack.json");
  if (!manifestFile) return { ok: false, errors: ["archive has no pack.json at root"] };
  const validation = parsePackManifest(JSON.parse(manifestFile.data.toString("utf-8")));
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const manifest = validation.manifest;

  // Step 2 — signature against the LOCAL trust store.
  let trusted = false;
  const publisherId = manifest.id.split("/")[0];
  if (options.signature) {
    const trust = readTrustStore(packPaths);
    const keys = trustedKeysForPublisher(trust, publisherId);
    trusted = keys.some((key) => verifyArchiveDigest(archiveDigest, options.signature as string, key));
    if (!trusted) {
      return { ok: false, errors: [`signature verification FAILED for publisher "${publisherId}" (no pinned trust-store key verifies this archive)`] };
    }
  } else {
    const allowUnsigned = options.config?.packs?.allowUnsigned === true;
    if (!(allowUnsigned && options.unsigned === true)) {
      return {
        ok: false,
        errors: [
          "archive is unsigned (no .sig found and no --sig given). Unsigned installs require BOTH",
          "  packs.allowUnsigned: true in config AND --unsigned on the command (two deliberate acts).",
        ],
      };
    }
    warnings.push("UNSIGNED install (allowUnsigned + --unsigned): receipt will be marked trusted:false and doctor will warn while it is installed");
  }

  // Step 4 remainder — engines.
  if (manifest.engines?.mindstone && !satisfiesRange(harnessVersion(), manifest.engines.mindstone)) {
    return { ok: false, errors: [`harness version ${harnessVersion()} does not satisfy engines.mindstone ${manifest.engines.mindstone}`] };
  }
  if (manifest.class === "agent") {
    return { ok: false, errors: ['class "agent" packs are not installable yet (Phase 3 of the #28 design); Phase 1 covers content packs'] };
  }

  // Step 5 — per-file digests: every file listed and matching, nothing extra/missing.
  const digestFile = files.find((file) => file.path === manifest.files);
  if (!digestFile) return { ok: false, errors: [`digest list ${manifest.files} missing from archive`] };
  let digests: Map<string, string>;
  try {
    digests = parseFileDigests(digestFile.data.toString("utf-8"));
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
  const errors: string[] = [];
  for (const file of files) {
    if (file.path === manifest.files) continue;
    const expected = digests.get(file.path);
    if (!expected) { errors.push(`file present but unlisted in ${manifest.files}: ${file.path}`); continue; }
    if (sha256Hex(file.data) !== expected) errors.push(`digest mismatch: ${file.path}`);
  }
  for (const listed of digests.keys()) {
    if (!files.some((file) => file.path === listed)) errors.push(`file listed but absent: ${listed}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  // Step 6 — prompt-surface re-derivation (exact sorted-list equality).
  const derived = derivePromptSurfaces(manifest, files.map((file) => file.path).filter((path) => path !== "pack.json" && path !== manifest.files));
  if (!promptSurfacesMatch(manifest.safety.promptSurfaces, derived)) {
    return {
      ok: false,
      errors: [
        "prompt-surface integrity FAILURE: declared safety.promptSurfaces != rule-derived set (an undeclared prompt surface is refused, not warned)",
        `  declared: ${JSON.stringify([...manifest.safety.promptSurfaces].sort())}`,
        `  derived:  ${JSON.stringify(derived)}`,
      ],
    };
  }

  // §4 final invariant — denylist scan at install (build also runs it).
  const denylist = denylistScan(files);
  if (denylist.length > 0) return { ok: false, errors: ["denylist scan failed:", ...denylist.map((finding) => `  ${finding}`)] };

  // Artifact well-formedness: declared ids must exist as valid artifact dirs.
  const wellFormed: Array<[string, string[], string[]]> = [
    ["personas", manifest.artifacts.personas ?? [], ["PERSONA.md"]],
    ["skills", manifest.artifacts.skills ?? [], ["skill.json", "SKILL.md"]],
    ["knowledgebases", manifest.artifacts.knowledgebases ?? [], ["kb.json"]],
    ["workflows", manifest.artifacts.workflows ?? [], []],
  ];
  for (const [root, ids, requiredFiles] of wellFormed) {
    const present = artifactIdsFromArchive(files, root);
    for (const id of ids) {
      if (!present.has(id)) { errors.push(`declared ${root} artifact "${id}" has no ${root}/${id}/ directory in the archive`); continue; }
      for (const required of requiredFiles) {
        if (!files.some((file) => file.path === `${root}/${id}/${required}`)) {
          errors.push(`${root}/${id} is missing required ${required}`);
        }
      }
    }
    for (const id of present) {
      if (!ids.includes(id)) errors.push(`archive contains undeclared ${root} artifact "${id}"`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // Step 7 — dependencies + persona reference resolution.
  const lock = readPackLock(packPaths);
  for (const [depId, range] of Object.entries(manifest.dependencies ?? {})) {
    const installed = lock.packs.find((entry) => entry.id === depId);
    if (!installed) {
      errors.push(`dependency not installed: ${depId} (${range}) — run: mindstone packs install <path-to-${depId.split("/")[1]}>`);
    } else if (!satisfiesRange(installed.version, range)) {
      errors.push(`dependency ${depId} installed at ${installed.version}, which does not satisfy ${range}`);
    }
  }
  const packSkillIds = artifactIdsFromArchive(files, "skills");
  const packKbIds = artifactIdsFromArchive(files, "knowledgebases");
  const packWorkflowIds = artifactIdsFromArchive(files, "workflows");
  const onDisk = (root: string, id: string): boolean => existsSync(join(dataDir, root, id));
  for (const personaId of manifest.artifacts.personas ?? []) {
    const refFile = (name: string) => files.find((file) => file.path === `personas/${personaId}/${name}`)?.data;
    for (const skillId of capabilityIdsFromJson(refFile("skills.json"), "skills")) {
      if (!packSkillIds.has(skillId) && !onDisk("skills", skillId)) errors.push(`persona ${personaId} references skill "${skillId}" which is neither in this pack nor installed`);
    }
    for (const kbId of capabilityIdsFromJson(refFile("knowledgebases.json"), "knowledgebases")) {
      if (!packKbIds.has(kbId) && !onDisk("knowledgebases", kbId)) errors.push(`persona ${personaId} references knowledgebase "${kbId}" which is neither in this pack nor installed`);
    }
    for (const workflowId of capabilityIdsFromJson(refFile("workflows.json"), "workflows")) {
      if (!packWorkflowIds.has(workflowId) && !onDisk("workflows", workflowId)) errors.push(`persona ${personaId} references workflow "${workflowId}" which is neither in this pack nor installed`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // Install plan: archive artifact files -> live-store relative paths.
  const installPlan = new Map<string, string>();
  for (const file of files) {
    if (file.path === "pack.json" || file.path === manifest.files) continue;
    const storePath = storePathFor(manifest, file.path);
    if (storePath) installPlan.set(file.path, storePath);
  }

  // Refuse a malformed archive where one entry is a file AND a directory
  // prefix of another (e.g. `personas/foo` alongside `personas/foo/PERSONA.md`)
  // — those cannot coexist on a filesystem and would throw mid-COMMIT
  // (adversarial QA #28, Finding 3). Test each path against ALL its ancestor
  // directories, not just its sorted neighbor: `a.md` sorts BETWEEN `a` and
  // `a/b` ('.' < '/'), so an adjacent-pair scan misses the `a` vs `a/b`
  // collision (round-3 QA). Scanning every archive path (not just the artifact
  // install plan) also covers memory-seed and payload-mirror collisions.
  const filePathSet = new Set(files.map((file) => file.path));
  for (const path of filePathSet) {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i += 1) {
      const ancestor = segments.slice(0, i).join("/");
      if (filePathSet.has(ancestor)) {
        return { ok: false, errors: [`malformed archive: "${ancestor}" is both a file and a directory prefix of "${path}"`] };
      }
    }
  }

  // Whitelist knowledgebase pack contents (round-3 QA — the case-sensitive
  // index.json refusal was bypassable by `INDEX.JSON` on a case-insensitive
  // filesystem, which the KB loader resolves). A shipped KB dir may contain
  // ONLY `kb.json` and files under `sources/` — the exact set the loader reads
  // as reviewed content. Anything else (a pre-built `index.json` in any casing,
  // or a novel filename) is refused: the index MUST be built post-install from
  // the reviewed, digest-covered, surface-enumerated sources
  // (`mindstone kb ingest`), so all KB content reaching the model derives from
  // reviewed sources. A whitelist is casing-robust where a denylist regex was not.
  for (const file of files) {
    const kbMatch = /^knowledgebases\/[^/]+\/(.+)$/.exec(file.path);
    if (!kbMatch) continue;
    const withinKb = kbMatch[1];
    if (withinKb !== "kb.json" && !withinKb.startsWith("sources/")) {
      return { ok: false, errors: [`knowledgebase pack file not allowed: ${file.path} — a KB pack may ship only kb.json and sources/**; the index is built post-install via 'mindstone kb ingest' (a shipped index or stray file is unreviewed recall-injected content)`] };
    }
  }

  return { ok: true, staged: { manifest, files, archiveDigest, trusted, installPlan }, warnings };
}

export function buildSafetySummary(staged: StagedPack, packPaths: PackPaths): PackSafetySummary {
  const lock = readPackLock(packPaths);
  const manifest = staged.manifest;
  return {
    packId: manifest.id,
    version: manifest.version,
    tier: manifest.tier,
    class: manifest.class,
    signature: staged.trusted ? "verified" : "unsigned",
    reviewStatus: manifest.safety.reviewStatus,
    reviewedBy: manifest.safety.reviewedBy,
    reviewedAt: manifest.safety.reviewedAt,
    reviewId: manifest.safety.reviewId,
    promptSurfaces: [...manifest.safety.promptSurfaces].sort(),
    riskNotes: manifest.safety.riskNotes ?? [],
    boundaries: manifest.safety.boundaries ?? [],
    installsInto: [...new Set([...staged.installPlan.values()].map((path) => path.split("/").slice(0, 2).join("/")))].sort(),
    dependencies: Object.entries(manifest.dependencies ?? {}).map(([id, range]) => {
      const installed = lock.packs.find((entry) => entry.id === id);
      return { id, range, installed: installed?.version, satisfied: installed ? satisfiesRange(installed.version, range) : false };
    }),
  };
}

async function safetyGate(staged: StagedPack, packPaths: PackPaths, options: PackInstallOptions): Promise<string[] | undefined> {
  const status = staged.manifest.safety.reviewStatus;
  const summary = buildSafetySummary(staged, packPaths);
  if (status === "revoked") {
    const allowUnsigned = options.config?.packs?.allowUnsigned === true;
    if (!(allowUnsigned && options.acceptRevoked === true)) {
      return [
        "pack is marked REVOKED — refusing to install.",
        "A revoked local archive installs only via the dedicated unsafe path: packs.allowUnsigned: true",
        "AND --accept-revoked AND interactive confirmation of the pack id (three deliberate acts).",
      ];
    }
    if (options.confirm) {
      const confirmed = await options.confirm(summary);
      if (!confirmed) return ["revoked-pack install not confirmed"];
    } else {
      return ["revoked-pack install requires interactive confirmation — refuse in non-interactive mode"];
    }
    return undefined;
  }
  if (status === "unreviewed" && options.config?.packs?.confirmUnreviewed !== false) {
    if (options.acceptUnreviewed === true) return undefined;
    if (options.confirm) {
      const confirmed = await options.confirm(summary);
      if (!confirmed) return ["unreviewed-pack install not confirmed"];
      return undefined;
    }
    return ["pack is unreviewed: interactive confirm required, or pass --accept-unreviewed"];
  }
  return undefined;
}

/** §7.1 — the local install path. Also the entry point for same-pack upgrades (routes to update semantics). */
export async function installPackArchive(archivePath: string, options: PackInstallOptions = {}): Promise<PackOperationResult> {
  const runtimePaths = options.paths ?? runtimePathsFromEnv();
  const packPaths = packPathsFromConfig(options.config, runtimePaths);
  let archive: Buffer;
  try {
    archive = readFileSync(archivePath);
  } catch (error) {
    return { ok: false, errors: [`cannot read archive: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const stagedResult = stagePack(archive, packPaths, runtimePaths.dataDir, options);
  if (!stagedResult.ok) return stagedResult;
  const { staged, warnings } = stagedResult;
  const manifest = staged.manifest;

  const existingReceipt = readReceipt(packPaths, manifest.id);
  if (existingReceipt) {
    return applyUpdate(staged, existingReceipt, packPaths, runtimePaths, options, warnings);
  }

  // Step 8 — collision check per artifact store path.
  const collisions: string[] = [];
  const userBackups: string[] = [];
  for (const storePath of staged.installPlan.values()) {
    const owner = findOwningPack(packPaths, storePath, manifest.id);
    if (owner) return { ok: false, errors: [`artifact collision: ${storePath} is owned by installed pack ${owner} — packs may not claim each other's artifacts (no override)`] };
    const liveTarget = join(runtimePaths.dataDir, storePath);
    if (existsSync(liveTarget)) {
      if (options.force === true) userBackups.push(storePath);
      else collisions.push(storePath);
    }
  }
  if (collisions.length > 0) {
    return { ok: false, errors: ["user-authored files exist at these paths (use --force to preserve them as <file>.user-backup and proceed):", ...collisions.map((path) => `  ${path}`)] };
  }

  // Step 9 — safety gate.
  const refusal = await safetyGate(staged, packPaths, options);
  if (refusal) return { ok: false, errors: refusal };

  // Step 10 — COMMIT. Transactional (adversarial QA #28, Finding 3): every
  // live-store write is tracked, and ANY failure before the receipt lands
  // rolls the whole set back so the runtime is left exactly as it was — no
  // orphaned, receipt-less, loadable artifacts. The installedDir (payload +
  // pack.json) is also removed on failure so a re-run stages cleanly.
  const summary: string[] = [];
  const receiptFiles: PackReceiptFile[] = [];
  const written: string[] = [];
  // --force user-file backups, tracked so rollback can RESTORE the user's file
  // to its real path (round-2 QA): otherwise a mid-COMMIT throw would unlink the
  // pack data written over the user file and leave the original only as
  // `.user-backup` litter — data displacement, the opposite of "left as it was".
  const backups: Array<{ target: string; backup: string }> = [];
  const installedDir = installedPackDir(packPaths, manifest.id);
  let seededAt: string | undefined;
  const seededFiles: string[] = [];
  try {
    for (const [archiveFilePath, storePath] of staged.installPlan) {
      const data = staged.files.find((file) => file.path === archiveFilePath)?.data as Buffer;
      const liveTarget = join(runtimePaths.dataDir, storePath);
      mkdirSync(dirname(liveTarget), { recursive: true });
      if (userBackups.includes(storePath)) {
        copyFileSync(liveTarget, `${liveTarget}.user-backup`);
        backups.push({ target: liveTarget, backup: `${liveTarget}.user-backup` });
        summary.push(`preserved user file: ${storePath} -> ${storePath}.user-backup`);
      }
      writeFileSync(liveTarget, data);
      written.push(liveTarget);
      receiptFiles.push({ storePath, archivePath: archiveFilePath, sha256AtInstall: sha256Hex(data), currentStatus: "owned" });
    }

    // Memory seeds — first install only, never overwrite existing memory.
    const memorySeedsRoot = manifest.artifacts.memorySeeds?.replace(/\/+$/, "");
    if (memorySeedsRoot) {
      for (const file of staged.files) {
        if (!file.path.startsWith(`${memorySeedsRoot}/`)) continue;
        const relativeSeed = file.path.slice(memorySeedsRoot.length + 1);
        const target = join(runtimePaths.memoryDir, relativeSeed);
        if (existsSync(target)) { summary.push(`memory seed skipped (exists): ${relativeSeed}`); continue; }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.data);
        written.push(target);
        seededFiles.push(relativeSeed);
      }
      if (seededFiles.length > 0) {
        seededAt = new Date().toISOString();
        summary.push(`memory seeds applied (first install): ${seededFiles.length} file(s)`);
      }
    }

    mkdirSync(join(installedDir, "payload"), { recursive: true });
    for (const file of staged.files) {
      const payloadTarget = join(installedDir, "payload", file.path);
      mkdirSync(dirname(payloadTarget), { recursive: true });
      writeFileSync(payloadTarget, file.data);
    }
    writeFileSync(join(installedDir, "pack.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const receipt: PackReceipt = {
      packId: manifest.id,
      version: manifest.version,
      archiveDigest: staged.archiveDigest,
      installedAt: new Date().toISOString(),
      trusted: staged.trusted,
      ...(options.acceptRevoked && manifest.safety.reviewStatus === "revoked" ? { revokedOverride: true } : {}),
      ...(seededAt ? { seededAt, seededFiles } : {}),
      files: receiptFiles,
    };
    writeReceipt(packPaths, receipt);

    const lock = readPackLock(packPaths);
    lock.packs = [
      ...lock.packs.filter((entry) => entry.id !== manifest.id),
      { id: manifest.id, version: manifest.version, digest: staged.archiveDigest, installedAt: receipt.installedAt, trusted: staged.trusted, channel: manifest.updates?.channel ?? "stable" },
    ].sort((a, b) => a.id.localeCompare(b.id));
    writePackLock(packPaths, lock);
  } catch (error) {
    // Roll back every live-store write; drop the half-written installedDir.
    for (const path of written) {
      try { unlinkSync(path); } catch { /* best-effort */ }
    }
    // Restore any --force-displaced user files from their backups FIRST (before
    // pruning empty dirs), then remove the backup litter, so the user's file is
    // back exactly where the runtime loads it.
    for (const { target, backup } of backups) {
      try { copyFileSync(backup, target); unlinkSync(backup); } catch { /* best-effort */ }
    }
    for (const path of written) {
      try { removeEmptyDirs(dirname(path), runtimePaths.dataDir); removeEmptyDirs(dirname(path), runtimePaths.memoryDir); } catch { /* best-effort */ }
    }
    rmSync(installedDir, { recursive: true, force: true });
    clearStaging(packPaths, manifest.id);
    return { ok: false, errors: [`install aborted and rolled back (no partial state): ${error instanceof Error ? error.message : String(error)}`] };
  }
  clearStaging(packPaths, manifest.id);

  summary.unshift(`installed ${manifest.id}@${manifest.version} — ${receiptFiles.length} file(s) into ${[...new Set(receiptFiles.map((file) => file.storePath.split("/")[0]))].join(", ")}`);
  return { ok: true, packId: manifest.id, version: manifest.version, summary, warnings, conflicts: [], trusted: staged.trusted };
}

/** §10 / D8 — update semantics: replace unmodified, keep-user + .pack-new on modified, respect deletions, never re-seed. */
async function applyUpdate(
  staged: StagedPack,
  previous: PackReceipt,
  packPaths: PackPaths,
  runtimePaths: MindStoneRuntimePaths,
  options: PackInstallOptions,
  warnings: string[],
): Promise<PackOperationResult> {
  const manifest = staged.manifest;
  const refusal = await safetyGate(staged, packPaths, options);
  if (refusal) return { ok: false, errors: refusal };

  const summary: string[] = [];
  const conflicts: string[] = [];
  const receiptFiles: PackReceiptFile[] = [];
  const previousByStore = new Map(previous.files.map((file) => [file.storePath, file]));

  for (const [archiveFilePath, storePath] of staged.installPlan) {
    const data = staged.files.find((file) => file.path === archiveFilePath)?.data as Buffer;
    const incomingSha = sha256Hex(data);
    const liveTarget = join(runtimePaths.dataDir, storePath);
    const prior = previousByStore.get(storePath);

    if (!prior) {
      // New artifact file in the new version. Collision rules still apply — and
      // (adversarial QA #28, Finding 4) a pre-existing UN-owned user file must
      // never be silently clobbered here the way the first-install path would
      // refuse it. Another pack's file → refuse; a user-authored file → keep it,
      // stage the incoming version as .pack-new, surface a conflict.
      const owner = findOwningPack(packPaths, storePath, manifest.id);
      if (owner) return { ok: false, errors: [`artifact collision on update: ${storePath} is owned by ${owner}`] };
      if (existsSync(liveTarget)) {
        writeFileSync(`${liveTarget}.pack-new`, data);
        receiptFiles.push({ storePath, archivePath: archiveFilePath, sha256AtInstall: sha256Hex(readFileSync(liveTarget)), currentStatus: "conflict", incomingSha256: incomingSha });
        conflicts.push(`${storePath} (pre-existing user file; incoming version at ${storePath}.pack-new)`);
        continue;
      }
      mkdirSync(dirname(liveTarget), { recursive: true });
      writeFileSync(liveTarget, data);
      receiptFiles.push({ storePath, archivePath: archiveFilePath, sha256AtInstall: incomingSha, currentStatus: "owned" });
      summary.push(`added: ${storePath}`);
      continue;
    }

    if (!existsSync(liveTarget)) {
      // User deleted it — respect the deletion; do not resurrect.
      receiptFiles.push({ storePath, archivePath: archiveFilePath, sha256AtInstall: incomingSha, currentStatus: "user-deleted" });
      summary.push(`respected user deletion: ${storePath}`);
      continue;
    }

    const currentSha = sha256Hex(readFileSync(liveTarget));
    if (currentSha === prior.sha256AtInstall) {
      writeFileSync(liveTarget, data);
      receiptFiles.push({ storePath, archivePath: archiveFilePath, sha256AtInstall: incomingSha, currentStatus: "owned" });
      if (currentSha !== incomingSha) summary.push(`updated: ${storePath}`);
    } else {
      // User-modified: keep the user's file, stage the incoming version alongside.
      writeFileSync(`${liveTarget}.pack-new`, data);
      receiptFiles.push({ storePath, archivePath: archiveFilePath, sha256AtInstall: prior.sha256AtInstall, currentStatus: "conflict", incomingSha256: incomingSha });
      conflicts.push(`${storePath} (user-modified; incoming version at ${storePath}.pack-new)`);
    }
  }

  // Artifacts dropped by the new version: remove only if unmodified.
  for (const prior of previous.files) {
    if (staged.installPlan.has(prior.archivePath) || [...staged.installPlan.values()].includes(prior.storePath)) continue;
    const liveTarget = join(runtimePaths.dataDir, prior.storePath);
    if (!existsSync(liveTarget)) continue;
    const currentSha = sha256Hex(readFileSync(liveTarget));
    if (currentSha === prior.sha256AtInstall) {
      unlinkSync(liveTarget);
      removeEmptyDirs(dirname(liveTarget), runtimePaths.dataDir);
      summary.push(`removed (dropped by new version): ${prior.storePath}`);
    } else {
      summary.push(`retained user-modified file dropped by new version: ${prior.storePath}`);
    }
  }

  // Refresh payload + manifest; receipts/lock update after the file pass.
  const installedDir = installedPackDir(packPaths, manifest.id);
  rmSync(join(installedDir, "payload"), { recursive: true, force: true });
  mkdirSync(join(installedDir, "payload"), { recursive: true });
  for (const file of staged.files) {
    const payloadTarget = join(installedDir, "payload", file.path);
    mkdirSync(dirname(payloadTarget), { recursive: true });
    writeFileSync(payloadTarget, file.data);
  }
  writeFileSync(join(installedDir, "pack.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const receipt: PackReceipt = {
    ...previous,
    version: manifest.version,
    archiveDigest: staged.archiveDigest,
    updatedAt: new Date().toISOString(),
    trusted: staged.trusted,
    files: receiptFiles,
  };
  writeReceipt(packPaths, receipt);

  const lock = readPackLock(packPaths);
  lock.packs = lock.packs.map((entry) => entry.id === manifest.id
    ? { ...entry, version: manifest.version, digest: staged.archiveDigest, trusted: staged.trusted }
    : entry);
  writePackLock(packPaths, lock);
  clearStaging(packPaths, manifest.id);

  summary.unshift(`updated ${manifest.id} ${previous.version} -> ${manifest.version}${conflicts.length ? ` with ${conflicts.length} conflict(s)` : ""}`);
  return { ok: true, packId: manifest.id, version: manifest.version, summary, warnings, conflicts, trusted: staged.trusted };
}

function removeEmptyDirs(dir: string, stopAt: string): void {
  let current = dir;
  while (current.startsWith(stopAt) && current !== stopAt) {
    try {
      if (readdirSync(current).length > 0) return;
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

/** §7.2 — remove. Never touches user data; memory seeds are never unwound. */
export function removePack(packId: string, options: { config?: MindStoneConfig; paths?: MindStoneRuntimePaths; purge?: boolean; force?: boolean } = {}): PackOperationResult {
  const runtimePaths = options.paths ?? runtimePathsFromEnv();
  const packPaths = packPathsFromConfig(options.config, runtimePaths);
  const receipt = readReceipt(packPaths, packId);
  if (!receipt) return { ok: false, errors: [`pack not installed: ${packId}`] };

  // Dependents check.
  const dependents: string[] = [];
  for (const otherId of listInstalledPackIds(packPaths)) {
    if (otherId === packId) continue;
    const installed = installedPackDir(packPaths, otherId);
    try {
      const manifest = JSON.parse(readFileSync(join(installed, "pack.json"), "utf-8")) as PackManifest;
      if (manifest.dependencies && Object.keys(manifest.dependencies).includes(packId)) dependents.push(otherId);
    } catch {
      // unreadable dependent manifest is a doctor concern, not a remove blocker
    }
  }
  if (dependents.length > 0 && options.force !== true) {
    return { ok: false, errors: [`packs depend on ${packId}: ${dependents.join(", ")} — remove them first or use --force (marks dependents depsBroken)`] };
  }

  const summary: string[] = [];
  for (const file of receipt.files) {
    const liveTarget = join(runtimePaths.dataDir, file.storePath);
    if (!existsSync(liveTarget)) continue;
    const currentSha = sha256Hex(readFileSync(liveTarget));
    if (currentSha === file.sha256AtInstall || options.purge === true) {
      unlinkSync(liveTarget);
      removeEmptyDirs(dirname(liveTarget), runtimePaths.dataDir);
      if (currentSha !== file.sha256AtInstall) summary.push(`purged user-modified file: ${file.storePath}`);
    } else {
      summary.push(`retained user-modified file: ${file.storePath}`);
    }
    const packNew = `${liveTarget}.pack-new`;
    if (existsSync(packNew)) unlinkSync(packNew);
  }

  if (options.force === true && dependents.length > 0) {
    for (const dependentId of dependents) {
      const dependentReceipt = readReceipt(packPaths, dependentId);
      if (dependentReceipt) writeReceipt(packPaths, { ...dependentReceipt, depsBroken: true });
    }
    summary.push(`marked depsBroken on: ${dependents.join(", ")}`);
  }

  const installedDir = installedPackDir(packPaths, packId);
  if (options.purge === true) {
    rmSync(installedDir, { recursive: true, force: true });
    summary.push("purged payload tombstone");
  } else {
    // Keep payload/ + pack.json as the tombstone; drop the receipt so the pack reads uninstalled.
    rmSync(join(installedDir, "receipt.json"), { force: true });
    summary.push("payload tombstone retained (packs remove --purge to delete)");
  }

  const lock = readPackLock(packPaths);
  lock.packs = lock.packs.filter((entry) => entry.id !== packId);
  writePackLock(packPaths, lock);

  summary.unshift(`removed ${packId}@${receipt.version}`);
  return { ok: true, packId, version: receipt.version, summary, warnings: [], conflicts: [], trusted: receipt.trusted };
}

export type PackVerifyFileReport = {
  storePath: string;
  status: "ok" | "user-modified" | "user-deleted" | "conflict-pending" | "drift";
};

export type PackVerifyReport = {
  packId: string;
  version: string;
  trusted: boolean;
  files: PackVerifyFileReport[];
  payloadIntact: boolean;
};

/** packs verify — offline integrity re-check: receipts vs disk, payload vs MANIFEST (design §7 table). */
export function verifyPack(packId: string, options: { config?: MindStoneConfig; paths?: MindStoneRuntimePaths } = {}): PackVerifyReport | { ok: false; errors: string[] } {
  const runtimePaths = options.paths ?? runtimePathsFromEnv();
  const packPaths = packPathsFromConfig(options.config, runtimePaths);
  const receipt = readReceipt(packPaths, packId);
  if (!receipt) return { ok: false, errors: [`pack not installed: ${packId}`] };

  const files: PackVerifyFileReport[] = receipt.files.map((file) => {
    const liveTarget = join(runtimePaths.dataDir, file.storePath);
    // A missing file with no recorded user deletion is unexplained drift (fail-level);
    // a recorded deletion is respected state.
    if (!existsSync(liveTarget)) return { storePath: file.storePath, status: file.currentStatus === "user-deleted" ? "user-deleted" : "drift" };
    const currentSha = sha256Hex(readFileSync(liveTarget));
    if (file.currentStatus === "conflict") return { storePath: file.storePath, status: "conflict-pending" };
    if (currentSha === file.sha256AtInstall) return { storePath: file.storePath, status: "ok" };
    // Changed content is reported as a user modification (warn-level: legitimate but
    // worth knowing — design §9). Payload-tombstone corruption below is what fails.
    return { storePath: file.storePath, status: "user-modified" };
  });

  // Payload vs its own MANIFEST.sha256.
  let payloadIntact = true;
  const payloadDir = join(installedPackDir(packPaths, packId), "payload");
  try {
    const digestText = readFileSync(join(payloadDir, receiptManifestName(packPaths, packId)), "utf-8");
    for (const [path, digest] of parseFileDigests(digestText)) {
      const payloadFile = join(payloadDir, path);
      if (!existsSync(payloadFile) || sha256Hex(readFileSync(payloadFile)) !== digest) { payloadIntact = false; break; }
    }
  } catch {
    payloadIntact = false;
  }

  return { packId, version: receipt.version, trusted: receipt.trusted, files, payloadIntact };
}

function receiptManifestName(packPaths: PackPaths, packId: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(installedPackDir(packPaths, packId), "pack.json"), "utf-8")) as PackManifest;
    return manifest.files;
  } catch {
    return "MANIFEST.sha256";
  }
}
