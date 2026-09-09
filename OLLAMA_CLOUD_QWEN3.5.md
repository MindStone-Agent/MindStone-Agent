# Running MindStone-Agent on Qwen3.5 through Ollama Cloud

Verified on September 9, 2026 (macOS, Node 24, this repository at `e50b8132`): `mindstone doctor` reported the provider, and `mindstone chat --once` returned a real answer from `qwen3.5:397b` on Ollama Cloud, persisted to the canonical transcript. The full Ollama Cloud lane, including the gateway and streaming paths, is documented in `docs/operations/LOCAL_MODELS.md`; this note is the short version for one model.

## What you need

- An ollama.com account and an API key from <https://ollama.com/settings/keys>.
- The key available to whatever process runs `mindstone` (your shell for the CLI; the `EnvironmentFile` of a systemd unit for the gateway). MindStone stores only a reference to it by default.
- Nothing local: Qwen3.5 on Ollama Cloud runs on ollama.com hardware. There is no Ollama daemon to install for this lane.

## The model id

Ollama Cloud's OpenAI-compatible listing (`GET https://ollama.com/v1/models`) reports the model as **`qwen3.5:397b`**. That is the id to register. `qwen3.5:cloud` and `qwen3.5:397b-cloud` also resolve at `https://ollama.com/v1/chat/completions` as aliases of the same model (all three were exercised on September 9, 2026). The 397B model is the only Qwen3.5 served on the cloud tier; the smaller Qwen3.5 tags (0.8b to 122b) are local downloads, not cloud models.

Facts about the model that affect how MindStone uses it, from the model page and the live calls:

- It is a thinking model. On the `/v1` path the response carries a `reasoning` field alongside `content`, and the reasoning tokens count as completion tokens (a one-word answer cost about 135 completion tokens). Register it with `"reasoning": true` so Pi treats the field correctly.
- Tool calling works on the `/v1` path (a function-call round trip returned `finish_reason: tool_calls` with well-formed arguments).
- Context window 256K tokens; text and image input.
- Usage is billed per token by ollama.com; current rates are on <https://ollama.com/library/qwen3.5:397b-cloud>.

## Path 1: the wizard

```bash
export OLLAMA_API_KEY=...          # from https://ollama.com/settings/keys
mindstone config --section routing
```

Choose **Ollama Cloud**, then **Use an environment variable** (keep `OLLAMA_API_KEY`), accept the base URL `https://ollama.com/v1`, and pick **`qwen3.5:397b`** from the list the wizard fetches. The wizard writes the provider into this project's isolated `.runtime/pi-agent/models.json` (mode 0600), sets `routing.mode` to `pi-session`, and sets `routing.defaultModel` to `ollama-cloud/qwen3.5:397b`. No global Pi config or auth state is touched.

If the wizard cannot list models (for example the variable is not set in that shell), choose **Enter model id manually** and type `qwen3.5:397b`.

## Path 2: write the two files by hand

This is exactly what the wizard produces, and it is the form that was verified.

`.runtime/pi-agent/models.json` (create it with mode 0600):

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

`.runtime/mindstone/config.json`, the `routing` block:

```json
"routing": {
  "mode": "pi-session",
  "defaultAgentId": "default",
  "defaultModel": "ollama-cloud/qwen3.5:397b"
}
```

To store the key literally instead of by reference, put the key itself in `apiKey`; the file is already 0600. The `$OLLAMA_API_KEY` form is the recommended one because the key then never sits in a file.

## Check it

```bash
mindstone doctor
```

Expect, among the checks:

```
✓ routing.model: Default model is configured
    ollama-cloud/qwen3.5:397b
✓ provider.custom.ollama-cloud: Custom provider Ollama Cloud is registered in isolated models.json
    https://ollama.com/v1 · 1 models · auth: env: OLLAMA_API_KEY
```

Then one real turn:

```bash
mindstone chat --once "Reply with exactly: MindStone via Ollama Cloud OK"
```

Expect the model's answer on stdout and an assistant entry in the canonical transcript (`mindstone status` shows the path).

## Things that bite

- **The variable has to exist where `mindstone` runs.** A key exported in one terminal is not visible to a gateway started by systemd or by another shell. `doctor` still shows `auth: env: OLLAMA_API_KEY` in that case, because it reports the reference, not whether the value resolves; the chat turn is the test.
- **Register the plain id.** `/v1/models` lists `qwen3.5:397b`; the `:cloud` aliases work for chat but will not match the listing if you compare them.
- **Do not put the key in global Pi state.** The isolated `.runtime/pi-agent/` directory is the only place MindStone reads providers from.
- **Switching back to a local or mock model** is a `routing.defaultModel` change (for example `mindstone/mock`); the Ollama Cloud provider entry can stay registered.
