/**
 * `mindstone packs` — the Phase 1 CLI surface of the #28 pack registry design
 * (local content-pack lifecycle; registry commands arrive with Phase 2).
 * Follows the CLI conventions: argv[3] subcommand, --json everywhere,
 * exit 0 success / 1 operational failure / 2 usage error, transcript audit
 * events via appendTranscriptEntry (the persona_activated pattern).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  appendTranscriptEntry,
  buildPack,
  generatePackKeypair,
  harnessVersion,
  installPackArchive,
  installedPackDir,
  listInstalledPackIds,
  listStaleStaging,
  loadMindStoneConfig,
  packPathsFromConfig,
  readPackLock,
  readReceipt,
  readTrustStore,
  removePack,
  resolveConfigPath,
  resolveConfiguredSessionKey,
  runtimePathsFromEnv,
  verifyPack,
  writeTrustStore,
  type MindStoneConfig,
  type PackManifest,
  type PackOperationResult,
  type PackSafetySummary,
} from "@mindstone-agent/core";
import { dirname, join } from "node:path";

const gold = (text: string) => `\x1b[38;5;220m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

function optionValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) return undefined;
  return argv[index + 1];
}

function usage(): string {
  return [
    "Usage: mindstone packs <subcommand>",
    "",
    "  packs list [--json]                       Installed packs (id, class, version, tier, review, flags)",
    "  packs inspect <path|id> [--json]          Manifest + safety block + prompt surfaces (archive or installed)",
    "  packs install <path.mspack> [--sig <path>] [--force] [--unsigned] [--accept-unreviewed] [--accept-revoked] [--yes] [--json]",
    "  packs remove <id> [--purge] [--force] [--json]",
    "  packs verify [id] [--json]                Offline integrity re-check (receipts vs disk, payload vs digests)",
    "  packs status [--json]                     Counts, pending conflicts, unsigned installs, stale staging",
    "  packs build <sourceDir> [--out <dir>] [--key <ed25519-priv:...>] [--derive-surfaces] [--json]",
    "  packs keygen [--out <file>] [--json]      Generate a signing keypair; --out writes the private key to a chmod-600 file and prints only the public key",
    "  packs trust-add <publisherId> <ed25519:...> [--key-id <label>] [--json]",
    "",
    "Local-first: no subcommand contacts a network. Registry commands arrive with Phase 2 of the design.",
  ].join("\n");
}

function emitResult(json: boolean, result: PackOperationResult): void {
  if (json) {
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (!result.ok) {
    output.write(`${gold("🔶")} FAILED:\n${result.errors.map((error) => `  ${error}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  for (const line of result.summary) output.write(`${gold("🔶")} ${line}\n`);
  for (const conflict of result.conflicts) output.write(`${gold("⚠")} conflict: ${conflict}\n`);
  for (const warning of result.warnings) output.write(`${dim(`warning: ${warning}`)}\n`);
}

function renderSafetySummary(summary: PackSafetySummary): string {
  const lines = [
    `Installing  ${bold(summary.packId)} @ ${summary.version}   (${summary.tier ?? "free"} · ${summary.class} · signature ${summary.signature.toUpperCase()} · ${summary.reviewStatus})`,
    summary.reviewedBy ? `Review      ${summary.reviewStatus} by ${summary.reviewedBy}${summary.reviewedAt ? `, ${summary.reviewedAt}` : ""}${summary.reviewId ? ` (${summary.reviewId})` : ""}` : `Review      ${summary.reviewStatus}`,
    `Prompt surfaces (${summary.promptSurfaces.length})`,
    ...summary.promptSurfaces.map((surface) => `  ${surface}`),
  ];
  if (summary.riskNotes.length > 0) lines.push(`Risk notes  ${summary.riskNotes.join(" · ")}`);
  if (summary.boundaries.length > 0) lines.push(`Boundaries  ${summary.boundaries.join(" · ")}`);
  if (summary.installsInto.length > 0) lines.push("Installs into", `  ${summary.installsInto.join("   ")}`);
  if (summary.dependencies.length > 0) {
    lines.push("Dependencies");
    for (const dep of summary.dependencies) {
      lines.push(`  ${dep.id} ${dep.range} (${dep.installed ? `installed: ${dep.installed} ${dep.satisfied ? "✓" : "✗"}` : "NOT INSTALLED"})`);
    }
  }
  return lines.join("\n");
}

function appendPackEvent(config: MindStoneConfig, event: "pack_installed" | "pack_updated" | "pack_removed", packId: string, version: string, digest: string | undefined, trusted: boolean): void {
  try {
    const agentId = config.routing?.defaultAgentId ?? "default";
    const sessionKey = resolveConfiguredSessionKey(config, { agentId });
    appendTranscriptEntry({
      sessionKey,
      agentId,
      role: "event",
      text: `Pack ${event.replace("pack_", "")}: ${packId}@${version}.`,
      source: { substrate: "mindstone-cli", channel: "terminal", chatType: "internal" },
      metadata: { event, packId, version, digest, trusted, decidedBy: "operator-cli" },
    });
  } catch {
    // The audit event is best-effort; the receipt is the durable record.
  }
}

export async function runPacksCommand(argv: string[]): Promise<void> {
  const sub = argv[3];
  const json = argv.includes("--json");
  const paths = runtimePathsFromEnv();
  const loaded = loadMindStoneConfig(resolveConfigPath(process.env, paths));
  const config: MindStoneConfig = loaded.config ?? {};
  const packPaths = packPathsFromConfig(config, paths);

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    output.write(`${usage()}\n`);
    if (!sub) process.exitCode = 2;
    return;
  }

  if (sub === "list") {
    const lock = readPackLock(packPaths);
    const rows = listInstalledPackIds(packPaths).map((packId) => {
      const receipt = readReceipt(packPaths, packId);
      let manifest: PackManifest | undefined;
      try {
        manifest = JSON.parse(readFileSync(join(installedPackDir(packPaths, packId), "pack.json"), "utf-8")) as PackManifest;
      } catch {
        manifest = undefined;
      }
      const conflicts = receipt?.files.filter((file) => file.currentStatus === "conflict").length ?? 0;
      return {
        id: packId,
        version: receipt?.version,
        class: manifest?.class,
        tier: manifest?.tier ?? "free",
        reviewStatus: manifest?.safety.reviewStatus,
        trusted: receipt?.trusted ?? false,
        conflicts,
        depsBroken: receipt?.depsBroken === true,
        channel: lock.packs.find((entry) => entry.id === packId)?.channel,
      };
    });
    if (json) { output.write(`${JSON.stringify({ packs: rows }, null, 2)}\n`); return; }
    if (rows.length === 0) { output.write(`${gold("🔶")} No packs installed.\n`); return; }
    output.write(`${gold("🔶 Installed packs")}\n\n`);
    for (const row of rows) {
      const flags = [
        row.trusted ? undefined : "UNSIGNED",
        row.conflicts ? `${row.conflicts} conflict(s)` : undefined,
        row.depsBroken ? "depsBroken" : undefined,
      ].filter(Boolean).join(", ");
      output.write(`${bold(row.id)} v${row.version} ${dim(`(${row.class} · ${row.tier} · ${row.reviewStatus})`)}${flags ? ` ${gold(`[${flags}]`)}` : ""}\n`);
    }
    return;
  }

  if (sub === "inspect") {
    const target = argv[4];
    if (!target || target.startsWith("--")) throw new Error(`Usage: mindstone packs inspect <path.mspack|installed-id>\n\n${usage()}`);
    let manifest: PackManifest;
    if (existsSync(target) && target.endsWith(".mspack")) {
      const { extractTarGz } = await import("@mindstone-agent/core");
      const files = extractTarGz(readFileSync(target));
      const manifestFile = files.find((file) => file.path === "pack.json");
      if (!manifestFile) throw new Error("archive has no pack.json");
      manifest = JSON.parse(manifestFile.data.toString("utf-8")) as PackManifest;
    } else {
      const packDir = installedPackDir(packPaths, target);
      if (!existsSync(join(packDir, "pack.json"))) throw new Error(`not an archive path or installed pack id: ${target}`);
      manifest = JSON.parse(readFileSync(join(packDir, "pack.json"), "utf-8")) as PackManifest;
    }
    if (json) { output.write(`${JSON.stringify(manifest, null, 2)}\n`); return; }
    output.write(`${gold("🔶")} ${bold(manifest.id)} @ ${manifest.version} (${manifest.class} · ${manifest.tier ?? "free"} · ${manifest.safety.reviewStatus})\n`);
    output.write(`${manifest.description ?? manifest.name}\n\n`);
    output.write(`Prompt surfaces (${manifest.safety.promptSurfaces.length}):\n`);
    for (const surface of [...manifest.safety.promptSurfaces].sort()) output.write(`  ${surface}\n`);
    if (manifest.safety.riskNotes?.length) output.write(`Risk notes: ${manifest.safety.riskNotes.join(" · ")}\n`);
    if (manifest.safety.boundaries?.length) output.write(`Boundaries: ${manifest.safety.boundaries.join(" · ")}\n`);
    if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
      output.write("Dependencies:\n");
      for (const [depId, range] of Object.entries(manifest.dependencies)) output.write(`  ${depId} ${range}\n`);
    }
    return;
  }

  if (sub === "install") {
    const archivePath = argv[4];
    if (!archivePath || archivePath.startsWith("--")) throw new Error(`Usage: mindstone packs install <path.mspack> [flags]\n\n${usage()}`);
    let signature = optionValue(argv, "--sig");
    if (!signature && existsSync(`${archivePath}.sig`)) signature = `${archivePath}.sig`;
    const signatureText = signature ? readFileSync(signature, "utf-8").trim() : undefined;

    const assumeYes = argv.includes("--yes");
    const interactiveConfirm = async (summary: PackSafetySummary): Promise<boolean> => {
      output.write(`${renderSafetySummary(summary)}\n`);
      if (assumeYes && summary.reviewStatus !== "revoked") return true;
      if (!input.isTTY) return false;
      const rl = createInterface({ input, output });
      try {
        if (summary.reviewStatus === "revoked") {
          const typed = await rl.question(`This pack is REVOKED. Re-type the pack id to proceed anyway: `);
          return typed.trim() === summary.packId;
        }
        const answer = await rl.question("Proceed? [y/N] ");
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    };

    const result = await installPackArchive(archivePath, {
      config,
      paths,
      signature: signatureText,
      unsigned: argv.includes("--unsigned"),
      acceptUnreviewed: argv.includes("--accept-unreviewed") || assumeYes,
      acceptRevoked: argv.includes("--accept-revoked"),
      force: argv.includes("--force"),
      confirm: interactiveConfirm,
    });
    emitResult(json, result);
    if (result.ok) {
      const event = result.summary[0]?.startsWith("updated") ? "pack_updated" : "pack_installed";
      appendPackEvent(config, event, result.packId, result.version, undefined, result.trusted);
    }
    return;
  }

  if (sub === "remove") {
    const packId = argv[4];
    if (!packId || packId.startsWith("--")) throw new Error(`Usage: mindstone packs remove <id> [--purge] [--force]\n\n${usage()}`);
    const result = removePack(packId, { config, paths, purge: argv.includes("--purge"), force: argv.includes("--force") });
    emitResult(json, result);
    if (result.ok) appendPackEvent(config, "pack_removed", result.packId, result.version, undefined, result.trusted);
    return;
  }

  if (sub === "verify") {
    const target = argv[4] && !argv[4].startsWith("--") ? [argv[4]] : listInstalledPackIds(packPaths);
    const reports = [];
    let failed = false;
    for (const packId of target) {
      const report = verifyPack(packId, { config, paths });
      if ("errors" in report) { failed = true; reports.push({ packId, errors: report.errors }); continue; }
      if (report.files.some((file) => file.status === "drift") || !report.payloadIntact) failed = true;
      reports.push(report);
    }
    if (json) { output.write(`${JSON.stringify({ reports }, null, 2)}\n`); if (failed) process.exitCode = 1; return; }
    for (const report of reports) {
      if ("errors" in report) { output.write(`${gold("🔶")} ${report.packId}: ${report.errors.join("; ")}\n`); continue; }
      const drift = report.files.filter((file) => file.status === "drift");
      const modified = report.files.filter((file) => file.status === "user-modified");
      const conflicts = report.files.filter((file) => file.status === "conflict-pending");
      const verdict = drift.length > 0 || !report.payloadIntact ? "DRIFT DETECTED" : "ok";
      output.write(`${gold("🔶")} ${bold(report.packId)} v${report.version}: ${verdict}${report.payloadIntact ? "" : " (payload tombstone corrupt)"}\n`);
      for (const file of drift) output.write(`  ${gold("✗")} unexplained drift: ${file.storePath}\n`);
      for (const file of modified) output.write(`  ${dim(`user-modified: ${file.storePath}`)}\n`);
      for (const file of conflicts) output.write(`  ${gold("⚠")} pending conflict: ${file.storePath} (.pack-new)\n`);
    }
    if (failed) process.exitCode = 1;
    return;
  }

  if (sub === "status") {
    const ids = listInstalledPackIds(packPaths);
    const receipts = ids.map((packId) => readReceipt(packPaths, packId));
    const summary = {
      installed: ids.length,
      unsigned: receipts.filter((receipt) => receipt && !receipt.trusted).length,
      revokedOverrides: receipts.filter((receipt) => receipt?.revokedOverride).length,
      pendingConflicts: receipts.reduce((total, receipt) => total + (receipt?.files.filter((file) => file.currentStatus === "conflict").length ?? 0), 0),
      depsBroken: receipts.filter((receipt) => receipt?.depsBroken).length,
      staleStaging: listStaleStaging(packPaths).length,
      harnessVersion: harnessVersion(),
    };
    if (json) { output.write(`${JSON.stringify(summary, null, 2)}\n`); return; }
    output.write(`${gold("🔶 MindStone packs status")}\n\n`);
    output.write(`Installed: ${summary.installed} · unsigned: ${summary.unsigned} · pending conflicts: ${summary.pendingConflicts} · depsBroken: ${summary.depsBroken}\n`);
    if (summary.revokedOverrides > 0) output.write(`${gold("✗")} revoked-override installs present: ${summary.revokedOverrides}\n`);
    if (summary.staleStaging > 0) output.write(`${dim(`stale staging dirs: ${summary.staleStaging}`)}\n`);
    return;
  }

  if (sub === "build") {
    const sourceDir = argv[4];
    if (!sourceDir || sourceDir.startsWith("--")) throw new Error(`Usage: mindstone packs build <sourceDir> [--out <dir>] [--key <ed25519-priv:...>] [--derive-surfaces]\n\n${usage()}`);
    const outDir = optionValue(argv, "--out") ?? process.cwd();
    const result = buildPack(sourceDir, {
      outDir,
      signingKey: optionValue(argv, "--key"),
      deriveSurfaces: argv.includes("--derive-surfaces"),
    });
    if (json) { output.write(`${JSON.stringify(result, null, 2)}\n`); if (!result.ok) process.exitCode = 1; return; }
    if (!result.ok) {
      output.write(`${gold("🔶")} BUILD FAILED:\n${result.errors.map((error) => `  ${error}`).join("\n")}\n`);
      process.exitCode = 1;
      return;
    }
    output.write(`${gold("🔶")} Built ${bold(result.archivePath)} (sha256 ${result.digest.slice(0, 16)}…)${result.signaturePath ? ` + signature` : ""}\n`);
    for (const warning of result.warnings) output.write(`${dim(`warning: ${warning}`)}\n`);
    return;
  }

  if (sub === "keygen") {
    const keypair = generatePackKeypair();
    // --out writes the PRIVATE key to a chmod-600 file and prints ONLY the public
    // key. Use this for a real publisher key: the private key never touches stdout
    // (so it can't leak into a terminal log, CI output, or an agent transcript).
    const outPath = optionValue(argv, "--out");
    if (outPath) {
      if (existsSync(outPath)) throw new Error(`refusing to overwrite existing key file: ${outPath}`);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${keypair.privateKey}\n`, { mode: 0o600 });
      if (json) { output.write(`${JSON.stringify({ publicKey: keypair.publicKey, privateKeyFile: outPath }, null, 2)}\n`); return; }
      output.write(`${gold("🔶")} Publisher keypair generated.\n`);
      output.write(`  ${bold("public key")} (share this / pin it in the trust store):\n    ${keypair.publicKey}\n`);
      output.write(`  ${bold("PRIVATE key")} written to ${outPath} (chmod 600).\n`);
      output.write(`  ${dim("Move it to a password manager or offline store. NEVER commit it, NEVER paste it into chat/logs. It is your release-signing key.")}\n`);
      return;
    }
    if (json) { output.write(`${JSON.stringify(keypair, null, 2)}\n`); return; }
    output.write(`${gold("🔶")} Dev signing keypair (store the private key OUTSIDE any pack source dir; use --out <file> for a real publisher key):\n`);
    output.write(`  public:  ${keypair.publicKey}\n  private: ${keypair.privateKey}\n`);
    return;
  }

  if (sub === "trust-add") {
    const publisherId = argv[4];
    const publicKey = argv[5];
    if (!publisherId || !publicKey || publisherId.startsWith("--") || publicKey.startsWith("--")) {
      throw new Error(`Usage: mindstone packs trust-add <publisherId> <ed25519:...> [--key-id <label>]\n\n${usage()}`);
    }
    if (!/^ed25519:[A-Za-z0-9+/=]+$/.test(publicKey)) throw new Error("public key must be of the form ed25519:<base64>");
    const store = readTrustStore(packPaths);
    const keyId = optionValue(argv, "--key-id") ?? `${publisherId}-${new Date().toISOString().slice(0, 10)}`;
    store.publishers = [...store.publishers.filter((key) => key.publicKey !== publicKey), { keyId, publisherId, publicKey }];
    writeTrustStore(packPaths, store);
    if (json) { output.write(`${JSON.stringify({ added: keyId, publisherId }, null, 2)}\n`); return; }
    output.write(`${gold("🔶")} Pinned key ${bold(keyId)} for publisher ${bold(publisherId)}\n`);
    return;
  }

  throw new Error(`Unknown packs subcommand: ${sub}\n\n${usage()}`);
}
