#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-auto-compact-smoke.XXXXXX")"
GATEWAY_PORT="19808"

cleanup() {
  if [[ -n "${gateway_pid:-}" ]]; then
    kill "${gateway_pid}" >/dev/null 2>&1 || true
    wait "${gateway_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TEMP_RUNTIME}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"

cd "${PROJECT_ROOT}"

echo "== Auto-compact runtime policy smoke test =="

npm run build:mindstone
./scripts/init-runtime.sh

python3 - <<'PY'
import json, os, pathlib
config_path = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
config = json.loads(config_path.read_text())
config["routing"] = {"mode": "mock", "defaultModel": "mindstone/mock", "mock": {"responsePrefix": "auto-compact-smoke"}}
config["agents"]["default"]["contextWindowTokens"] = 400
config["contextManagement"] = {
  "mode": "auto_compact",
  "checkpointWarningPercent": 20,
  "compactTargetPercent": 30,
  "keepRecentTokens": 120,
  "emergencyAutoHandoff": True,
}
config_path.write_text(json.dumps(config, indent=2) + "\n")
print(config_path)
PY

./scripts/start-gateway.sh >/tmp/mindstone-agent-auto-compact-gateway.log 2>&1 &
gateway_pid=$!
sleep 1

node <<'NODE'
const fs = await import("node:fs");
const path = await import("node:path");
const base = `http://127.0.0.1:${process.env.MINDSTONE_AGENT_GATEWAY_PORT}`;
const text = "Auto compact smoke payload. ".repeat(120);

async function request(path, init, expectedStatus) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json();
  console.log(`${path} -> ${response.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (response.status !== expectedStatus) process.exit(1);
  return body;
}

const send = await request(
  "/chat/send",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  },
  200,
);
if (!send.ok || send.provider !== "mock") process.exit(1);
if (send.handoffReplay) process.exit(1);
if (send.promptWindow.mode !== "auto_compact") process.exit(1);
if (!send.promptWindow.autoCompact || send.promptWindow.autoCompact.event !== "auto_compact_required") process.exit(1);
if (send.promptWindow.autoCompact.action !== "request_compaction") process.exit(1);
if (send.promptWindow.autoCompact.reserveTokens <= 0) process.exit(1);

let history = await request("/chat/history", undefined, 200);
const compactEvent = history.entries.find((entry) => entry.metadata?.event === "auto_compact_required");
if (!compactEvent) process.exit(1);
if (compactEvent.metadata?.compactTargetPercent !== 30) process.exit(1);
if (compactEvent.metadata?.keepRecentTokens !== 120) process.exit(1);
if (compactEvent.metadata?.handoff?.written !== true) process.exit(1);
if (compactEvent.metadata?.compaction?.requested !== false) process.exit(1);
const latest = path.join(process.env.MINDSTONE_AGENT_RUNTIME_DIR, "mindstone", "transcripts", ".handoff.md");
if (compactEvent.metadata.handoff.path !== latest) process.exit(1);
if (compactEvent.metadata.handoff.latestPath !== latest) process.exit(1);
if (!fs.existsSync(latest)) process.exit(1);
if (!fs.readFileSync(latest, "utf-8").includes("MindStone-Agent Auto-Compact Handoff")) process.exit(1);

const status = await request("/status", undefined, 200);
if (!status.handoff?.exists) process.exit(1);
if (status.handoff.path !== latest) process.exit(1);
if (!status.handoff.sha256 || status.handoff.bytes <= 0) process.exit(1);

const replay = await request(
  "/chat/send",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "resume after handoff" }),
  },
  200,
);
if (!replay.ok || replay.provider !== "mock") process.exit(1);
if (!replay.handoffReplay) process.exit(1);
if (replay.handoffReplay.path !== latest) process.exit(1);
if (replay.handoffReplay.sha256 !== status.handoff.sha256) process.exit(1);

history = await request("/chat/history", undefined, 200);
const replayEvent = history.entries.find((entry) => entry.metadata?.event === "handoff_replayed");
if (!replayEvent) process.exit(1);
if (replayEvent.metadata?.durable !== false) process.exit(1);
if (replayEvent.metadata?.handoff?.sha256 !== status.handoff.sha256) process.exit(1);
NODE

echo "Auto-compact runtime policy smoke test passed."
