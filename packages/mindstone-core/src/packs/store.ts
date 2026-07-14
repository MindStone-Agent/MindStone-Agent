/**
 * Pack state on disk (design §8): lock file, trust store, receipts, staging.
 * State writes use the atomic temp-file + rename pattern (as ApprovalStore
 * does). Corrupt state files surface as errors for doctor to report — pack
 * state is a security record, never silently replaced.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { MindStoneConfig } from "../config/types.js";
import { runtimePathsFromEnv, type MindStoneRuntimePaths } from "../paths/runtime.js";
import type { PackLock, PackReceipt, PackTrustStore } from "./types.js";

export type PackPaths = {
  packsDir: string;
  lockPath: string;
  trustPath: string;
  stagingDir: string;
  installedDir: string;
};

export function packPathsFromConfig(config: MindStoneConfig | undefined, paths?: MindStoneRuntimePaths): PackPaths {
  const resolved = paths ?? runtimePathsFromEnv();
  const packsDir = resolve(config?.packs?.dir ?? join(resolved.dataDir, "packs"));
  return {
    packsDir,
    lockPath: join(packsDir, "packs.lock.json"),
    trustPath: join(packsDir, "trust", "publishers.json"),
    stagingDir: join(packsDir, "staging"),
    installedDir: join(packsDir, "installed"),
  };
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

function readJson<T>(path: string, label: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (error) {
    throw new Error(`${label} is corrupt at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function readPackLock(paths: PackPaths): PackLock {
  return readJson<PackLock>(paths.lockPath, "packs.lock.json") ?? { schemaVersion: 1, packs: [] };
}

export function writePackLock(paths: PackPaths, lock: PackLock): void {
  writeJsonAtomic(paths.lockPath, lock);
}

/**
 * Trust store. There is no harness-shipped key yet (first-party publishing
 * starts with Phase 2), so an absent store means NO keys are trusted — every
 * signed verification fails until the operator seeds a key (packs trust-add
 * via CLI or by editing publishers.json). Fail closed by default.
 */
export function readTrustStore(paths: PackPaths): PackTrustStore {
  return readJson<PackTrustStore>(paths.trustPath, "trust/publishers.json") ?? { schemaVersion: 1, publishers: [] };
}

export function writeTrustStore(paths: PackPaths, store: PackTrustStore): void {
  writeJsonAtomic(paths.trustPath, store);
}

export function trustedKeysForPublisher(store: PackTrustStore, publisherId: string, now = new Date()): string[] {
  return store.publishers
    .filter((key) => key.publisherId === publisherId)
    .filter((key) => !key.revoked)
    .filter((key) => !key.expiresAt || Date.parse(key.expiresAt) > now.getTime())
    .map((key) => key.publicKey);
}

export function receiptPath(paths: PackPaths, packId: string): string {
  // Pack ids contain "/" (publisher/name); flatten for the directory name.
  return join(paths.installedDir, packId.replace("/", "__"), "receipt.json");
}

export function installedPackDir(paths: PackPaths, packId: string): string {
  return join(paths.installedDir, packId.replace("/", "__"));
}

export function readReceipt(paths: PackPaths, packId: string): PackReceipt | undefined {
  return readJson<PackReceipt>(receiptPath(paths, packId), `receipt for ${packId}`);
}

export function writeReceipt(paths: PackPaths, receipt: PackReceipt): void {
  writeJsonAtomic(receiptPath(paths, receipt.packId), receipt);
}

export function listInstalledPackIds(paths: PackPaths): string[] {
  if (!existsSync(paths.installedDir)) return [];
  return readdirSync(paths.installedDir)
    .filter((name) => existsSync(join(paths.installedDir, name, "receipt.json")))
    .map((name) => name.replace("__", "/"))
    .sort();
}

/** Find which installed pack (if any) owns an artifact store path. */
export function findOwningPack(paths: PackPaths, storePath: string, excludePackId?: string): string | undefined {
  for (const packId of listInstalledPackIds(paths)) {
    if (packId === excludePackId) continue;
    const receipt = readReceipt(paths, packId);
    if (receipt?.files.some((file) => file.storePath === storePath)) return packId;
  }
  return undefined;
}

export function clearStaging(paths: PackPaths, packId: string): void {
  const staging = join(paths.stagingDir, packId.replace("/", "__"));
  rmSync(staging, { recursive: true, force: true });
}

/** Stale staging dirs are inert; doctor warns and any pack command may clean them. */
export function listStaleStaging(paths: PackPaths): string[] {
  if (!existsSync(paths.stagingDir)) return [];
  return readdirSync(paths.stagingDir).sort();
}
