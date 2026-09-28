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
const pasted = await prompter.text({ message: "Pasted", sensitive: true });
const ended = await prompter.text({ message: "EndedBy", sensitive: true });
const name = await prompter.text({ message: "Name" });
prompter.close();
process.stdout.write(`\nRESULT ${JSON.stringify({ secretLength: secret.length, secretOk: secret === "SMOKE-SECRET-4471", pastedOk: pasted === "PASTE-KEY-7788", pasted: JSON.stringify(pasted).length, endedOk: ended === "abc", name })}\n`);
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
# A key pasted together with its newline arrives as one chunk (#131).
read_until(b"Pasted")
time.sleep(0.3)
os.write(fd, b"PASTE-KEY-7788\r")
# Ctrl-D ends the prompt (#131).
read_until(b"EndedBy")
time.sleep(0.3)
os.write(fd, b"a\tbc"); time.sleep(0.1); os.write(fd, b"\x04")  # a Tab is ignored
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
if not result["pastedOk"]:
    sys.exit(f"a key pasted with its newline was not read as the key alone: {result}")
if not result["endedOk"]:
    sys.exit(f"Ctrl-D should end the hidden prompt with what was typed: {result}")
if result["name"] != "bob-plain":
    sys.exit(f"the plain answer after the secret was wrong: {result}")
import re
# Also catch an echo split by escape codes or shown in part: strip ANSI codes
# and look for any 4-character piece of the secret (#130 review).
shown = text.split("RESULT")[0]
shown = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", shown)  # OSC sequences
shown = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", shown)  # CSI sequences
shown = re.sub(r"[\u200b-\u200d\u2060\ufeff]", "", shown)  # zero-width characters
pieces = [secret[i:i + 4] for secret in ("SMOKE-SECRET-4471", "PASTE-KEY-7788") for i in range(len(secret) - 3)]
if any(piece in shown for piece in pieces):
    sys.exit("the secret, or part of it, was shown on the terminal")
if "bob-plain" not in text.split("RESULT")[0]:
    sys.exit("control: a plain answer should be echoed on the terminal")
print("secret echo assertions passed")
PY
# Key handling in hidden prompts (#133), each case a hidden prompt followed by a
# plain one, so input that leaks past the hidden prompt shows up there.
cat > "${TEMP_DIR}/cases.mts" <<'TS'
import { makeTerminalPrompter } from "PROJECT_ROOT/packages/mindstone-cli/src/terminal-prompter.ts";
const prompter = makeTerminalPrompter();
const results: Array<Record<string, unknown>> = [];
for (let i = 1; i <= Number(process.env.CASES); i++) {
  let hidden: Record<string, unknown>;
  try { hidden = { ok: true, value: await prompter.text({ message: `K${i}`, sensitive: true }) }; }
  catch (error) { hidden = { ok: false, error: String(error) }; }
  const plain = await prompter.text({ message: `N${i}` });
  results.push({ i, hidden, plain });
}
prompter.close();
process.stdout.write(`\nCASES ${JSON.stringify(results)}\n`);
process.exit(0);
TS
sed -i.bak "s#PROJECT_ROOT#${PROJECT_ROOT}#" "${TEMP_DIR}/cases.mts"
TSX="${PROJECT_ROOT}/node_modules/.bin/tsx" SCRIPT="${TEMP_DIR}/cases.mts" python3 - <<'PY'
import os, pty, select, sys, time, json
# (label, chunks sent with a short gap, expected hidden result: a value, or None for cancelled)
CASES = [
    ("backspace", [b"abX\x7fc\r"], "abc"),
    ("arrow key inside a chunk", [b"ab\x1b[Acd\r"], "abcd"),
    ("escape sequence split across chunks", [b"ab\x1b", b"[A", b"cd\r"], "abcd"),
    ("multi-line paste in two chunks", [b"line1\nline2-", b"tail-of-the-paste\n"], "line1"),
    ("CR and LF in separate chunks", [b"key5\r", b"\n"], "key5"),
    ("bracketed paste", [b"\x1b[200~PAST\nED\x1b[201~\r"], "PASTED"),
    ("Ctrl-C cancels", [b"ab\x03"], None),
    ("Ctrl-D on an empty prompt cancels", [b"\x04"], None),
    ("Ctrl-D after typing submits", [b"xy\x04"], "xy"),
    ("a lone Esc, then a pasted key", [b"\x1b", b"sk-abc\r"], "sk-abc"),
    ("Ctrl-C inside an unterminated paste", [b"\x1b[200~abc\x03"], None),
]
os.environ["CASES"] = str(len(CASES))
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
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                seen += os.read(fd, 4096)
            except OSError:
                break
for i, (label, chunks, _) in enumerate(CASES, start=1):
    read_until(f"K{i}".encode()); time.sleep(0.2)
    for n, chunk in enumerate(chunks):
        if n: time.sleep(0.01)
        os.write(fd, chunk)
    read_until(f"N{i}".encode()); time.sleep(0.2)
    os.write(fd, f"plain-{i}\r".encode())
read_until(b"CASES "); read_until(b"]\r\n")
os.waitpid(pid, 0)
text = seen.decode("utf8", "replace")
results = json.loads(text[text.index("CASES ") + 6:].splitlines()[0])
failures = []
for (label, _, expected), got in zip(CASES, results):
    if got["plain"] != f"plain-{got['i']}":
        failures.append(f"{label}: input leaked into the next prompt, which got {got['plain']!r}")
    if expected is None and got["hidden"]["ok"]:
        failures.append(f"{label}: the prompt should be cancelled, got {got['hidden']!r}")
    if expected is not None and got["hidden"] != {"ok": True, "value": expected}:
        failures.append(f"{label}: expected {expected!r}, got {got['hidden']!r}")
if failures:
    sys.exit("hidden-input cases failed:\n  " + "\n  ".join(failures))
print(f"hidden-input key handling: {len(CASES)} cases passed")
PY
echo "CLI secret echo smoke test passed."
