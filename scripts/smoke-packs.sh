#!/usr/bin/env bash
set -euo pipefail

# Pack registry Phase 1 smoke (#28 design §14):
#   1. fixture pack roundtrip: install -> user-modify -> update -> conflict surfaced -> remove retains user file
#   2. tampered-archive refusal (signature)
#   3. unsigned refusal + two-act escape hatch (config + flag)
#   4. zip-slip fixture refusal
#   5. collision refusal (+ --force user-backup path)
#   6. promptSurfaces-mismatch refusal (signed archive with a lying manifest)
#   7. verify drift detection
# Pure CLI — no gateway, no ports, no network.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-packs-smoke.XXXXXX")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-packs-work.XXXXXX")"

cleanup() {
  rm -rf "${TEMP_RUNTIME}" "${WORK}"
}
trap cleanup EXIT

export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"

cd "${PROJECT_ROOT}"

echo "== Pack registry Phase 1 smoke =="

npm run build:mindstone
./scripts/init-runtime.sh

MS="./scripts/mindstone"
DATA_DIR="${TEMP_RUNTIME}/mindstone"

# --- Fixture pack source (a content-class Persona Pack) ---
FIX="${WORK}/fixture"
mkdir -p "${FIX}/personas/cti-lite" "${FIX}/skills/triage" "${FIX}/workflows/daily-pull" "${FIX}/knowledgebases/ot-refs" "${FIX}/memory"
cat > "${FIX}/personas/cti-lite/PERSONA.md" <<'EOF'
# CTI Analyst (Lite)
You are operating in the CTI analyst role: triage sources, extract indicators, stay factual.
EOF
cat > "${FIX}/personas/cti-lite/safety.md" <<'EOF'
Never auto-block or auto-report without approval.
EOF
printf '%s\n' '{"name": "CTI Analyst (Lite)", "version": "0.1.0"}' > "${FIX}/personas/cti-lite/metadata.json"
printf '%s\n' '["triage"]' > "${FIX}/personas/cti-lite/skills.json"
printf '%s\n' '{"id": "triage", "label": "Source triage"}' > "${FIX}/skills/triage/skill.json"
cat > "${FIX}/skills/triage/SKILL.md" <<'EOF'
# Source triage
Rank sources by reliability before extraction.
EOF
printf '%s\n' '{"id": "daily-pull"}' > "${FIX}/workflows/daily-pull/workflow.json"
printf '%s\n' '{"id": "ot-refs", "sources": []}' > "${FIX}/knowledgebases/ot-refs/kb.json"
cat > "${FIX}/memory/seed-note.md" <<'EOF'
Seeded starting note for the CTI role.
EOF
cat > "${FIX}/pack.json" <<'EOF'
{
  "schemaVersion": 1,
  "id": "mindstone/cti-lite",
  "class": "content",
  "name": "CTI Analyst (Lite)",
  "description": "Fixture persona pack for the Phase 1 smoke.",
  "version": "0.1.0",
  "tier": "free",
  "engines": { "mindstone": ">=0.0.0" },
  "artifacts": {
    "personas": ["cti-lite"],
    "skills": ["triage"],
    "workflows": ["daily-pull"],
    "knowledgebases": ["ot-refs"],
    "memorySeeds": "memory/"
  },
  "safety": {
    "reviewStatus": "reviewed",
    "reviewedBy": "smoke-fixture",
    "reviewedAt": "2026-07-14T00:00:00Z",
    "promptSurfacesRule": 1,
    "promptSurfaces": []
  },
  "files": "MANIFEST.sha256"
}
EOF

# --- Keys + trust ---
KEYS_JSON="$(${MS} packs keygen --json)"
PUB_KEY="$(node -e 'console.log(JSON.parse(process.argv[1]).publicKey)' "${KEYS_JSON}")"
PRIV_KEY="$(node -e 'console.log(JSON.parse(process.argv[1]).privateKey)' "${KEYS_JSON}")"
${MS} packs trust-add mindstone "${PUB_KEY}" --key-id smoke-key >/dev/null

# --- Build v0.1.0 (signed) ---
DIST="${WORK}/dist"
mkdir -p "${DIST}"
${MS} packs build "${FIX}" --out "${DIST}" --key "${PRIV_KEY}" --derive-surfaces
ARCHIVE_1="${DIST}/mindstone__cti-lite-0.1.0.mspack"
test -f "${ARCHIVE_1}" && test -f "${ARCHIVE_1}.sig"

# --- 1a. Install (signed, reviewed -> proceeds non-interactively) ---
${MS} packs install "${ARCHIVE_1}" --json > /tmp/packs-install-1.json
node -e 'const r=JSON.parse(require("node:fs").readFileSync("/tmp/packs-install-1.json","utf8")); if(!r.ok||!r.trusted) process.exit(1);'
test -f "${DATA_DIR}/personas/cti-lite/PERSONA.md"
test -f "${DATA_DIR}/skills/triage/SKILL.md"
test -f "${DATA_DIR}/workflows/daily-pull/workflow.json"
test -f "${DATA_DIR}/knowledgebases/ot-refs/kb.json"
test -f "${TEMP_RUNTIME}/mindstone/memory/seed-note.md"
test -f "${DATA_DIR}/packs/installed/mindstone__cti-lite/receipt.json"
grep -q '"mindstone/cti-lite"' "${DATA_DIR}/packs/packs.lock.json"
grep -rq 'pack_installed' "${DATA_DIR}/transcripts/"
echo "leg 1a ok: signed install, artifacts in stores, receipt+lock+event"

# --- 1b. User-modify then update to v0.2.0 -> conflict surfaced, unmodified replaced ---
echo "user tweak" >> "${DATA_DIR}/skills/triage/SKILL.md"
node -e '
const fs = require("node:fs");
const path = process.argv[1];
fs.writeFileSync(path, fs.readFileSync(path, "utf8").replace("0.1.0", "0.2.0"));
' "${FIX}/pack.json"
cat > "${FIX}/personas/cti-lite/PERSONA.md" <<'EOF'
# CTI Analyst (Lite) v2
You are operating in the CTI analyst role, second edition.
EOF
cat > "${FIX}/skills/triage/SKILL.md" <<'EOF'
# Source triage v2
Rank sources by reliability AND freshness before extraction.
EOF
${MS} packs build "${FIX}" --out "${DIST}" --key "${PRIV_KEY}" --derive-surfaces
ARCHIVE_2="${DIST}/mindstone__cti-lite-0.2.0.mspack"
${MS} packs install "${ARCHIVE_2}" --json > /tmp/packs-update.json
node -e '
const r = JSON.parse(require("node:fs").readFileSync("/tmp/packs-update.json","utf8"));
if (!r.ok) { console.error(r.errors); process.exit(1); }
if (!r.conflicts.some((c) => c.includes("skills/triage/SKILL.md"))) { console.error("expected SKILL.md conflict"); process.exit(1); }
'
grep -q "v2" "${DATA_DIR}/personas/cti-lite/PERSONA.md"          # unmodified file replaced
grep -q "user tweak" "${DATA_DIR}/skills/triage/SKILL.md"        # user file kept
test -f "${DATA_DIR}/skills/triage/SKILL.md.pack-new"            # incoming staged alongside
test -f "${TEMP_RUNTIME}/mindstone/memory/seed-note.md"          # seeds not re-applied/unwound
echo "leg 1b ok: update replaced unmodified, kept user file, staged .pack-new"

# --- 7. verify: user-modified reported (exit 0), drift detected (exit 1) ---
${MS} packs verify mindstone/cti-lite --json > /tmp/packs-verify-1.json
node -e '
const r = JSON.parse(require("node:fs").readFileSync("/tmp/packs-verify-1.json","utf8")).reports[0];
const skill = r.files.find((f) => f.storePath.includes("SKILL.md"));
if (!skill || skill.status !== "conflict-pending") { console.error("expected conflict-pending on SKILL.md, got", skill); process.exit(1); }
'
mv "${DATA_DIR}/personas/cti-lite/PERSONA.md" "${WORK}/persona-stash.md"   # unexplained deletion = drift
if ${MS} packs verify mindstone/cti-lite >/tmp/packs-verify-2.out 2>&1; then
  echo "verify should have failed on drift" >&2; exit 1
fi
grep -q "unexplained drift" /tmp/packs-verify-2.out
mv "${WORK}/persona-stash.md" "${DATA_DIR}/personas/cti-lite/PERSONA.md"
echo "leg 7 ok: verify distinguishes conflicts from drift and fails on drift"

# --- 1c. Remove: retains user-modified, removes owned, keeps seeds + tombstone ---
${MS} packs remove mindstone/cti-lite --json > /tmp/packs-remove.json
node -e 'const r=JSON.parse(require("node:fs").readFileSync("/tmp/packs-remove.json","utf8")); if(!r.ok) { console.error(r.errors); process.exit(1); }'
test ! -f "${DATA_DIR}/personas/cti-lite/PERSONA.md"             # owned + unmodified -> removed
test -f "${DATA_DIR}/skills/triage/SKILL.md"                     # user-modified -> retained
test -f "${TEMP_RUNTIME}/mindstone/memory/seed-note.md"          # memory never unwound
test ! -f "${DATA_DIR}/packs/installed/mindstone__cti-lite/receipt.json"
test -d "${DATA_DIR}/packs/installed/mindstone__cti-lite/payload"  # tombstone retained
grep -rq 'pack_removed' "${DATA_DIR}/transcripts/"
echo "leg 1c ok: remove retained user file, kept seeds + tombstone, event recorded"

# --- 5. Collision refusal (the retained user SKILL.md) + --force user-backup ---
if ${MS} packs install "${ARCHIVE_2}" >/tmp/packs-collision.out 2>&1; then
  echo "install should have refused the user-authored collision" >&2; exit 1
fi
grep -q "user-authored" /tmp/packs-collision.out
${MS} packs install "${ARCHIVE_2}" --force --json > /tmp/packs-force.json
node -e 'const r=JSON.parse(require("node:fs").readFileSync("/tmp/packs-force.json","utf8")); if(!r.ok) { console.error(r.errors); process.exit(1); }'
test -f "${DATA_DIR}/skills/triage/SKILL.md.user-backup"
${MS} packs remove mindstone/cti-lite --purge --json >/dev/null
echo "leg 5 ok: collision refused without --force; --force preserved a user-backup"

# --- 2. Tampered archive refusal: a VALID archive (v0.2.0) with the WRONG
#       signature (v0.1.0's). Extraction succeeds; the digest the sig covers
#       no longer matches -> signature verification must fail. (A corrupted-gzip
#       tamper is caught earlier at extraction; this exercises the sig path.) ---
cp "${ARCHIVE_2}" "${WORK}/tampered.mspack"
cp "${ARCHIVE_1}.sig" "${WORK}/tampered.mspack.sig"
if ${MS} packs install "${WORK}/tampered.mspack" >/tmp/packs-tampered.out 2>&1; then
  echo "tampered archive must be refused" >&2; exit 1
fi
grep -q "signature verification FAILED" /tmp/packs-tampered.out
echo "leg 2 ok: valid archive + wrong signature refused by the sig check"

# --- 3. Unsigned refusal + two-act escape hatch ---
mkdir -p "${WORK}/unsigned"
${MS} packs build "${FIX}" --out "${WORK}/unsigned" --derive-surfaces
UNSIGNED="${WORK}/unsigned/mindstone__cti-lite-0.2.0.mspack"
if ${MS} packs install "${UNSIGNED}" >/tmp/packs-unsigned-1.out 2>&1; then
  echo "unsigned archive must be refused without the two acts" >&2; exit 1
fi
grep -q "two deliberate acts" /tmp/packs-unsigned-1.out
if ${MS} packs install "${UNSIGNED}" --unsigned >/tmp/packs-unsigned-2.out 2>&1; then
  echo "flag alone must not admit an unsigned archive (config act missing)" >&2; exit 1
fi
node -e '
const fs = require("node:fs");
const path = `${process.env.MINDSTONE_AGENT_RUNTIME_DIR}/mindstone/config.json`;
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.packs = { allowUnsigned: true };
fs.writeFileSync(path, JSON.stringify(config, null, 2));
'
${MS} packs install "${UNSIGNED}" --unsigned --json > /tmp/packs-unsigned-3.json
node -e 'const r=JSON.parse(require("node:fs").readFileSync("/tmp/packs-unsigned-3.json","utf8")); if(!r.ok||r.trusted!==false) process.exit(1);'
${MS} packs status --json > /tmp/packs-status.json
node -e 'const s=JSON.parse(require("node:fs").readFileSync("/tmp/packs-status.json","utf8")); if(s.unsigned!==1) { console.error("expected 1 unsigned install, got", s.unsigned); process.exit(1); }'
${MS} packs remove mindstone/cti-lite --purge --json >/dev/null
echo "leg 3 ok: unsigned needs config AND flag; escape hatch marks trusted:false"

# --- 4. Zip-slip refusal (hand-crafted hostile ustar entry) ---
node -e '
const { gzipSync } = require("node:zlib");
const { writeFileSync } = require("node:fs");
function header(name, size) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf-8");
  h.write("0000644\0", 100, 8, "ascii");
  h.write("0000000\0", 108, 8, "ascii");
  h.write("0000000\0", 116, 8, "ascii");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  h.write("00000000000\0", 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");
  h.write("0", 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}
const evil = Buffer.from("owned\n");
const pad = Buffer.alloc(512 - evil.length);
const tar = Buffer.concat([header("../evil.md", evil.length), evil, pad, Buffer.alloc(1024)]);
writeFileSync(process.argv[1], gzipSync(tar));
' "${WORK}/zipslip.mspack"
if ${MS} packs install "${WORK}/zipslip.mspack" --unsigned >/tmp/packs-zipslip.out 2>&1; then
  echo "zip-slip archive must be refused" >&2; exit 1
fi
grep -q "unsafe archive path" /tmp/packs-zipslip.out
test ! -f "${DATA_DIR}/../evil.md"
echo "leg 4 ok: traversal entry refused at extraction"

# --- 6. promptSurfaces-mismatch refusal (SIGNED archive whose manifest lies) ---
node -e '
(async () => {
  const { pathToFileURL } = require("node:url");
  const core = await import(pathToFileURL(`${process.cwd()}/packages/mindstone-core/dist/index.js`).href);
  const { readFileSync, writeFileSync } = require("node:fs");
  const fixture = process.argv[1];
  const manifest = JSON.parse(readFileSync(`${fixture}/pack.json`, "utf8"));
  // Lie: declare only PERSONA.md, omit safety.md + SKILL.md (undeclared prompt surfaces).
  manifest.safety.promptSurfaces = ["personas/cti-lite/PERSONA.md"];
  const paths = [
    "personas/cti-lite/PERSONA.md", "personas/cti-lite/safety.md", "personas/cti-lite/metadata.json",
    "personas/cti-lite/skills.json", "skills/triage/skill.json", "skills/triage/SKILL.md",
    "workflows/daily-pull/workflow.json", "knowledgebases/ot-refs/kb.json", "memory/seed-note.md",
  ];
  const files = paths.map((p) => ({ path: p, data: readFileSync(`${fixture}/${p}`) }));
  const digests = new Map(files.map((f) => [f.path, core.sha256Hex(f.data)]));
  const manifestJson = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  digests.set("pack.json", core.sha256Hex(manifestJson));
  const archive = core.createTarGz([
    { path: "pack.json", data: manifestJson },
    { path: "MANIFEST.sha256", data: Buffer.from(core.formatFileDigests(digests)) },
    ...files,
  ]);
  writeFileSync(process.argv[2], archive);
  writeFileSync(`${process.argv[2]}.sig`, core.signArchiveDigest(core.sha256Hex(archive), process.argv[3]) + "\n");
})().catch((e) => { console.error(e); process.exit(1); });
' "${FIX}" "${WORK}/lying.mspack" "${PRIV_KEY}"
if ${MS} packs install "${WORK}/lying.mspack" >/tmp/packs-lying.out 2>&1; then
  echo "manifest with undeclared prompt surfaces must be refused" >&2; exit 1
fi
grep -q "prompt-surface integrity FAILURE" /tmp/packs-lying.out
echo "leg 6 ok: signed-but-lying promptSurfaces refused"

# --- Doctor surfaces pack checks (no packs installed now; expects the info/no-packs line) ---
${MS} doctor > /tmp/packs-doctor.out 2>/dev/null || true
grep -q "packs.catalog" /tmp/packs-doctor.out
echo "doctor leg ok: packs.catalog check present"

echo "Pack registry Phase 1 smoke test passed."
