# Configure yourself to run on Qwen3.5 through Ollama Cloud

**Who this is for.** You, a MindStone agent, setting up your own model route. Your human reads along; the steps that only a person can do (creating the ollama.com account, choosing a plan, generating the key) are written so you can hand them over word for word.

**Verified.** September 9, 2026, macOS, Node 24, this repository at `e50b8132`: `mindstone doctor` reported the provider, and `mindstone chat --once` returned a real answer from `qwen3.5:397b` on Ollama Cloud, persisted to the canonical transcript. Tool calling and the reasoning field were exercised on the same path. The full Ollama Cloud lane (gateway, streaming, compaction) is in `docs/operations/LOCAL_MODELS.md`; this note is the one-model walkthrough.

## Step 0. Get the key from your human

You cannot create the account or the key. Ask your human for one thing: an ollama.com API key, and how they want it stored (environment variable is the default and the recommendation). If they do not have an account yet, give them these steps:

1. Go to <https://ollama.com/signup>. Sign up with an email address, or continue with Google or GitHub. There is a human check on the page.
2. Pick a plan at <https://ollama.com/pricing>. As of September 9, 2026: Free ($0) includes starter usage credits and starter models, with one concurrent request; Pro ($20 per month) adds monthly usage credits, larger models, and three concurrent requests; Max ($100 per month) adds more credits and ten concurrent requests; Team starts at $500 per month with shared billing. Credits can be added to any plan to unlock all models. The pricing page does not say per model which tier includes Qwen3.5 397B; if a chat call later fails with an authorization or quota error, the fix is on the plan or credits side, not in MindStone.
3. Create an API key at <https://ollama.com/settings/keys> and copy it once; ollama.com does not show it again.
4. Hand the key to the agent through the environment (step 1), not in chat, and never in a file the agent commits.

Ollama's published terms for the cloud (ollama.com/cloud, September 9, 2026): prompt and response data are never logged or trained on; compute is hosted primarily in the United States and may be routed to Europe and Singapore for capacity. Tell your human that, because their conversations with you will go through it.

## Step 1. Put the key where `mindstone` runs

The key has to exist in the environment of the process that runs you:

- CLI use: `export OLLAMA_API_KEY=...` in the shell that runs `mindstone`, or in that shell's profile.
- Gateway under systemd: an `EnvironmentFile` (mode 600) referenced by the unit, then `systemctl restart`.
- Docker: an `-e OLLAMA_API_KEY` or an env file on the container.

MindStone will store only the reference `$OLLAMA_API_KEY` in its isolated runtime, so the key itself never sits in a config file unless your human chooses the literal-key option below.

## Step 2. Register the provider and the model

**The model id is `qwen3.5:397b`.** That is what Ollama Cloud's OpenAI-compatible listing (`GET https://ollama.com/v1/models`) reports. `qwen3.5:cloud` and `qwen3.5:397b-cloud` also resolve at `https://ollama.com/v1/chat/completions` as aliases of the same model, but register the plain id so it matches the listing. The 397B model is the only Qwen3.5 served on the cloud tier; the smaller Qwen3.5 tags (0.8b to 122b) are local downloads.

**Path A, the wizard (interactive, needs your human at the terminal or you driving a TTY):**

```bash
mindstone config --section routing
```

Choose **Ollama Cloud**, then **Use an environment variable** (keep `OLLAMA_API_KEY`), accept the base URL `https://ollama.com/v1`, and pick `qwen3.5:397b` from the list the wizard fetches. If the wizard cannot list models (the variable is not set in that shell), choose **Enter model id manually** and type `qwen3.5:397b`. The wizard writes the provider into this project's isolated `.runtime/pi-agent/models.json` (mode 0600), sets `routing.mode` to `pi-session`, and sets `routing.defaultModel` to `ollama-cloud/qwen3.5:397b`. No global Pi config or auth state is touched.

**Path B, write the two files yourself (non-interactive; this is exactly what the wizard produces and it is the form that was verified):**

`.runtime/pi-agent/models.json`, created with mode 0600:

```json
{
  "providers": {
    "ollama-cloud": {
      "name": "Ollama Cloud",
      "baseUrl": "https://ollama.com/v1",
      "api": "openai-completions",
      "apiKey": "$OLLAMA_API_KEY",
      "models": [
        {
          "id": "qwen3.5:397b",
          "name": "Qwen3.5 397B (Ollama Cloud)",
          "contextWindow": 262144,
          "reasoning": true,
          "input": ["text", "image"]
        }
      ]
    }
  }
}
```

If a `models.json` already exists, add the `ollama-cloud` entry under `providers` rather than replacing the file; `mindstone doctor` warns on a malformed file and setup flows never overwrite one.

`.runtime/mindstone/config.json`, the `routing` block:

```json
"routing": {
  "mode": "pi-session",
  "defaultAgentId": "default",
  "defaultModel": "ollama-cloud/qwen3.5:397b"
}
```

To store the key literally instead of by reference (your human's choice), put the key itself in `apiKey`; the file is already 0600.

## Step 3. Verify, then report

```bash
mindstone doctor
```

Expect these lines among the checks:

```
✓ routing.model: Default model is configured
    ollama-cloud/qwen3.5:397b
✓ provider.custom.ollama-cloud: Custom provider Ollama Cloud is registered in isolated models.json
    https://ollama.com/v1 · 1 models · auth: env: OLLAMA_API_KEY
```

`doctor` reports the reference, not whether the key resolves, so run one real turn:

```bash
mindstone chat --once "Reply with exactly: MindStone via Ollama Cloud OK"
```

Expect the model's answer on stdout and an assistant entry in the canonical transcript (`mindstone status` shows the path). Then tell your human, in one message: the model you are now on, where the key reference lives, that the test turn succeeded, and the data-handling terms from step 0. If the turn fails with an authorization or quota error, say so and point them at the plan or credits; if it fails because the variable is unset where you run, say which process is missing it.

## What to know about this model

- It is a thinking model. On the `/v1` path the response carries a `reasoning` field alongside `content`, and the reasoning tokens count as completion tokens (a one-word answer cost about 135 completion tokens). `"reasoning": true` in the registration is what tells Pi to expect it.
- Tool calling works on the `/v1` path (a function-call round trip returned `finish_reason: tool_calls` with well-formed arguments).
- Context window 256K tokens; text and image input.
- Usage is billed per token by ollama.com, with a higher peak rate on weekday afternoons UTC; current rates are on <https://ollama.com/pricing> and the model page <https://ollama.com/library/qwen3.5:397b-cloud>.

## Things that bite

- **The variable has to exist where `mindstone` runs.** A key exported in one terminal is invisible to a gateway started by systemd or by another shell.
- **Register the plain id.** `/v1/models` lists `qwen3.5:397b`; the `:cloud` aliases work for chat but will not match the listing.
- **Only the isolated runtime counts.** `.runtime/pi-agent/` is the only place MindStone reads providers from; never put the key in global Pi state.
- **Concurrency is a plan limit.** Free allows one request at a time; parallel tool runs or a second session will queue behind it.
- **Switching back** to a local or mock model is a `routing.defaultModel` change (for example `mindstone/mock`); the Ollama Cloud provider entry can stay registered.
