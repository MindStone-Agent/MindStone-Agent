#!/usr/bin/env bash
# A secret typed at a hidden prompt is not shown on a real terminal (#129).
# Runs the CLI's terminal prompter under a pseudo-terminal, types a secret and
# then a plain answer: the secret must not appear in what the terminal shows,
# and the plain answer must (control: echo works). No ports.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-secret-echo.XXXXXX")"
trap 'rm -rf "${TEMP_DIR}"' EXIT
cd "${PROJECT_ROOT}"
echo "== CLI secret echo smoke test =="
npm run build:mindstone
cat > "${TEMP_DIR}/prompt.mts" <<'TS'
import { makeTerminalPrompter } from "PROJECT_ROOT/packages/mindstone-cli/src/terminal-prompter.ts";
const prompter = makeTerminalPrompter();
const secret = await prompter.text({ message: "Secret", sensitive: true });
const name = await prompter.text({ message: "Name" });
prompter.close();
process.stdout.write(`\nRESULT ${JSON.stringify({ secretLength: secret.length, secretOk: secret === "SMOKE-SECRET-4471", name })}\n`);
process.exit(0);
TS
sed -i.bak "s#PROJECT_ROOT#${PROJECT_ROOT}#" "${TEMP_DIR}/prompt.mts"
TSX="${PROJECT_ROOT}/node_modules/.bin/tsx" SCRIPT="${TEMP_DIR}/prompt.mts" python3 - <<'PY'
import os, pty, select, sys, time, json
pid, fd = pty.fork()
if pid == 0:
    os.environ["MINDSTONE_AGENT_SCROLL_ONBOARDING"] = "1"
    os.execv(os.environ["TSX"], [os.environ["TSX"], os.environ["SCRIPT"]])
seen = b""
def read_until(marker, timeout=30):
    global seen
    end = time.time() + timeout
    while marker not in seen:
        if time.time() > end:
            sys.exit(f"timed out waiting for {marker!r}; saw {seen[-300:]!r}")
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                seen += os.read(fd, 4096)
            except OSError:
                break
read_until(b"Secret")
time.sleep(0.3)
for ch in b"SMOKE-SECRET-4471":
    os.write(fd, bytes([ch])); time.sleep(0.01)
os.write(fd, b"\r")
read_until(b"Name")
time.sleep(0.3)
os.write(fd, b"bob-plain\r")
read_until(b"RESULT")
read_until(b"}")
os.waitpid(pid, 0)
text = seen.decode("utf8", "replace")
result = json.loads(text[text.index("RESULT ") + 7:].splitlines()[0])
if not result["secretOk"]:
    sys.exit(f"the secret was not read correctly: {result}")
if result["name"] != "bob-plain":
    sys.exit(f"the plain answer after the secret was wrong: {result}")
import re
# Also catch an echo split by escape codes or shown in part: strip ANSI codes
# and look for any 4-character piece of the secret (#130 review).
shown = text.split("RESULT")[0]
shown = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", shown)  # OSC sequences
shown = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", shown)  # CSI sequences
shown = re.sub(r"[\u200b-\u200d\u2060\ufeff]", "", shown)  # zero-width characters
secret = "SMOKE-SECRET-4471"
pieces = [secret[i:i + 4] for i in range(len(secret) - 3)]
if any(piece in shown for piece in pieces):
    sys.exit("the secret, or part of it, was shown on the terminal")
if "bob-plain" not in text.split("RESULT")[0]:
    sys.exit("control: a plain answer should be echoed on the terminal")
print("secret echo assertions passed")
PY
echo "CLI secret echo smoke test passed."
