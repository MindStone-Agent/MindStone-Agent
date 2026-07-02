# Local models and Ollama Cloud

MindStone-Agent supports three model-source lanes. All of them store state only in
this project's isolated runtime (`.runtime/pi-agent/`) — never in global Pi state.

| Lane | How | Claim status |
|------|-----|--------------|
| Cloud/subscription provider (OpenAI Codex, Claude, Copilot, API keys) | isolated Pi `auth.json` via `mindstone auth login <provider>` or the wizard | implemented, smoke-tested (`smoke:onboard-model-setup`, `smoke:config-pi-models`); live chat validated only per-account |
| Local model (Ollama / LM Studio / OpenAI-compatible) | provider entry in isolated `models.json` via onboarding or `mindstone config --section routing` | implemented, smoke-tested end-to-end against a live local endpoint (`smoke:local-route`, `smoke:onboard-model-setup`) |
| Ollama Cloud | provider entry in isolated `models.json` + ollama.com API key | implemented, smoke-tested at the config/registry layer (`smoke:config-pi-models`); **live chat validation pending** (needs an ollama.com key) — see below |

## How it works

Pi's `ModelRegistry` merges custom providers from `<agentDir>/models.json` with its
built-in catalog. MindStone writes provider entries there (`.runtime/pi-agent/models.json`,
mode 0600) and routes through the normal `pi-session` path — there is no separate
"local model client". A provider becomes *available* once it has an `apiKey` value in
`models.json` or an entry in the isolated `auth.json`; keyless local servers get a
placeholder key (for example `ollama`), which local servers ignore.

## Local model setup (Ollama / LM Studio / OpenAI-compatible)

During onboarding choose **"Use a local model (Ollama / LM Studio / OpenAI-compatible)"**,
or later run:

```bash
mindstone config --section routing
```

and pick **"Local model (Ollama / LM Studio / OpenAI-compatible)"** in the provider list.

The wizard:

1. asks which server you run — Ollama (`http://localhost:11434/v1`), LM Studio
   (`http://localhost:1234/v1`), or any OpenAI-compatible base URL;
2. probes `GET <baseUrl>/models` and lists the models actually installed;
3. registers the provider + models in the isolated `models.json`;
4. sets `routing.mode = "pi-session"` with your selected model as default.

If the endpoint is down, you can still register it with a manually entered model id —
it just needs to be running by chat time.

## Ollama Cloud setup

During onboarding choose **"Use Ollama Cloud"**, or the **"Ollama Cloud"** entry in the
config-wizard provider list. You need an ollama.com account and an API key from
<https://ollama.com/settings/keys>.

The wizard:

1. stores the key as either an env-var reference (default `$OLLAMA_API_KEY`, recommended)
   or a literal value in the isolated `models.json` (0600);
2. probes `https://ollama.com/v1/models` (this endpoint lists models even without a key;
   chat calls require one);
3. registers the provider and sets the selected cloud model as routing default.

### Live validation status (honest claim)

`https://ollama.com/v1/models` was verified live on 2026-07-01 (model listing responds).
A live **chat** turn through Ollama Cloud has **not** been validated yet because it
requires an ollama.com API key. To validate once a key exists:

```bash
export OLLAMA_API_KEY=...   # from https://ollama.com/settings/keys
mindstone config --section routing   # choose Ollama Cloud, pick a model
mindstone chat --once "hello from MindStone via Ollama Cloud"
```

Expected: a real model answer, an assistant entry in the canonical transcript
(`mindstone status` shows the transcript path), and `mindstone doctor` reporting the
`ollama-cloud` custom provider with `auth: env: OLLAMA_API_KEY`.

## Status and doctor visibility

- `mindstone doctor` reports each custom provider in the isolated `models.json` with
  base URL, model count, and a sanitized auth summary (`models.json key (stored)`,
  `env: OLLAMA_API_KEY`, or `none`). Key material is never printed.
- A malformed `models.json` is reported as a warning and is never overwritten by setup
  flows.

## Smoke coverage

```bash
npm run smoke:config-pi-models     # models.json merge/permissions/sanitization + Pi registry pickup
npm run smoke:onboard-model-setup  # onboarding lanes incl. local lane against a live stub endpoint
npm run smoke:local-route          # fresh runtime -> wizard-equivalent registration -> real chat turn
                                   # through pi-session against a local OpenAI-compatible endpoint
```
