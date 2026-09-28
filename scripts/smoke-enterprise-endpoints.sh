#!/usr/bin/env bash
# Enterprise model endpoints smoke (#126): Azure OpenAI / AI Foundry, Amazon
# Bedrock, Google Vertex AI and an OpenAI-compatible enterprise gateway,
# registered through the admin API.
#   - keys only from stored secrets, with the provider-key guards (#80): never a
#     gateway credential or a connector's token, never echoed or audited
#   - https to a public host only; private hosts only when the gateway host
#     sets MINDSTONE_ENTERPRISE_PRIVATE_HOSTS=1
#   - what lands in Pi's models.json and auth.json (0600, literal keys)
#   - the live Test: one completion through Pi, the provider's values redacted
# Binds gateway port base+31 and stubs on base+32 and base+33. Synthetic secrets only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMP_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/mindstone-agent-enterprise-smoke.XXXXXX")"
SMOKE_PORT_BASE="${MINDSTONE_SMOKE_PORT_BASE:-19800}"
GATEWAY_PORT="$((SMOKE_PORT_BASE + 31))"
STUB_PORT="$((SMOKE_PORT_BASE + 32))"
OTHER_PORT="$((SMOKE_PORT_BASE + 33))"
stop_gateway() { if [[ -n "${gateway_pid:-}" ]]; then kill "${gateway_pid}" >/dev/null 2>&1 || true; wait "${gateway_pid}" >/dev/null 2>&1 || true; unset gateway_pid; fi; }
cleanup() { stop_gateway; for pid in "${stub_pid:-}" "${other_pid:-}"; do [[ -n "${pid}" ]] && kill "${pid}" >/dev/null 2>&1 || true; done; [[ -n "${ENT_SMOKE_KEEP:-}" ]] || rm -rf "${TEMP_RUNTIME}"; }
trap cleanup EXIT
export MINDSTONE_AGENT_RUNTIME_DIR="${TEMP_RUNTIME}"
export MINDSTONE_AGENT_GATEWAY_PORT="${GATEWAY_PORT}"
export PI_CODING_AGENT_DIR="${TEMP_RUNTIME}/pi-agent"
export ENT_SMOKE_TOKEN="ent-smoke-service-token"
export ENT_SMOKE_ADMIN_TOKEN="ent-smoke-admin-token"
unset MINDSTONE_ENTERPRISE_PRIVATE_HOSTS MSA_ALLOW_HOST_PROVIDER_ENV AWS_BEARER_TOKEN_BEDROCK AWS_SESSION_TOKEN EMBEDDER_BASE_URL EMBEDDER_API_KEY AZURE_OPENAI_BASE_URL AZURE_OPENAI_API_VERSION
cd "${PROJECT_ROOT}"
echo "== Enterprise endpoints smoke test =="
npm run build:mindstone
./scripts/init-runtime.sh >"${TEMP_RUNTIME}/init.log"
CONFIG="${TEMP_RUNTIME}/mindstone/config.json"
DATA="${TEMP_RUNTIME}/mindstone"
SECRETS="${DATA}/secrets"
MODELS_JSON="${PI_CODING_AGENT_DIR}/models.json"
AUTH_JSON="${PI_CODING_AGENT_DIR}/auth.json"
AUDIT="${DATA}/admin/audit.jsonl"
BASE="http://127.0.0.1:${GATEWAY_PORT}"
python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["MINDSTONE_AGENT_RUNTIME_DIR"]) / "mindstone" / "config.json"
c = json.loads(p.read_text())
gw = c.setdefault("gateway", {})
gw["auth"] = {"mode": "token", "tokenEnv": "ENT_SMOKE_TOKEN", "tokenFile": "secrets/gateway-token"}
gw["admin"] = {"tokenEnv": "ENT_SMOKE_ADMIN_TOKEN"}
c["routing"] = {"mode": "mock", "defaultAgentId": "default", "defaultModel": "mindstone/mock"}
c["channels"] = {"telegram": {"enabled": False, "tokenFile": "secrets/connector-token"}}
p.write_text(json.dumps(c, indent=2) + "\n")
PY
start_gateway() {
  ./scripts/start-gateway.sh >>"${TEMP_RUNTIME}/gateway.log" 2>&1 &
  gateway_pid=$!
  for _ in $(seq 1 30); do curl -sf "${BASE}/health" >/dev/null 2>&1 && break; sleep 0.5; done
}
BODY="${TEMP_RUNTIME}/body.json"
ADMIN=(-H "Authorization: Bearer ${ENT_SMOKE_TOKEN}" -H "x-mindstone-admin-token: ${ENT_SMOKE_ADMIN_TOKEN}" -H 'x-mindstone-user-role: admin' -H 'x-mindstone-user-id: smoke-admin' -H 'content-type: application/json')
post() { curl -s -o "${BODY}" -w '%{http_code}' -X POST "${ADMIN[@]}" -d "$2" "${BASE}$1"; }
get() { curl -s -o "${BODY}" -w '%{http_code}' "${ADMIN[@]}" "${BASE}$1"; }
del() { curl -s -o "${BODY}" -w '%{http_code}' -X DELETE "${ADMIN[@]}" "${BASE}$1"; }
expect() { local got="$1" want="$2" label="$3"; [[ "${got}" == "${want}" ]] || { echo "${label}: expected ${want}, got ${got}: $(cat "${BODY}")" >&2; exit 1; }; }
mode_of() { node -e 'console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$1"; }
# Reads a value from a JSON file: jsonv <file> <js expression over j>.
jsonv() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=(new Function("j","return ("+process.argv[2]+")"))(j); console.log(typeof v==="string"?v:JSON.stringify(v))' "$1" "$2"; }
grant() { expect "$(post /admin/permissions/advanced '{"enabled":true,"confirm":"enable advanced settings"}')" 200 "granting advanced settings"; }
secret() { expect "$(post "/admin/secrets/$1" "$(node -e 'console.log(JSON.stringify({value: process.argv[1]}))' "$2")")" 200 "storing secret $1"; }

start_gateway
# 1. Refusals before anything is written.
secret az.key 'AZ-KEY-6610'
expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"https://smoke-res.openai.azure.com","models":["gpt-4o"],"secret":"az.key"}')" 403 "registering without the advanced permission"
grant
expect "$(post /admin/providers/enterprise/nope '{}')" 404 "an unknown kind"
expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"https://smoke-res.openai.azure.com","models":["gpt-4o"],"apiKey":"PLAIN-KEY-1"}')" 400 "a plain key in the body"
expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"https://smoke-res.openai.azure.com","secret":"az.key"}')" 400 "Azure without deployments"
expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"https://smoke-res.openai.azure.com","models":["gpt-4o"]}')" 400 "Azure without a key"
expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"https://smoke-res.openai.azure.com","models":["gpt-4o"],"secret":"missing.key"}')" 400 "a secret that isn't stored"
for bad in "http://smoke-res.openai.azure.com" "https://127.0.0.1/openai/v1" "http://127.0.0.1:${STUB_PORT}/openai/v1" "https://10.1.2.3" "https://169.254.169.254" "https://[::ffff:a9fe:a9fe]" "https://metadata.google.internal" "https://intranet" "https://u:p@smoke-res.openai.azure.com" "https://smoke-res.openai.azure.com/?api-version=1" "file:///etc/passwd"; do
  expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"'"${bad}"'","models":["gpt-4o"],"secret":"az.key"}')" 400 "the endpoint ${bad}"
done
expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"https://smoke-res.openai.azure.com","models":["gpt-4o"],"secret":"az.key","apiVersion":"1; rm"}')" 400 "a malformed api version"
# The gateway's own credentials and a connector's token are never a provider key.
mkdir -p "${SECRETS}"; printf '%s\n' "${ENT_SMOKE_TOKEN}" > "${SECRETS}/gateway-token"; printf 'CONNECTOR-TOKEN-6610\n' > "${SECRETS}/connector-token"
secret copied.key "${ENT_SMOKE_ADMIN_TOKEN}"
expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"https://smoke-res.openai.azure.com","models":["gpt-4o"],"secret":"gateway-token"}')" 422 "the gateway token file as a key"
expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"https://smoke-res.openai.azure.com","models":["gpt-4o"],"secret":"connector-token"}')" 422 "a connector's token as a key"
expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"https://smoke-res.openai.azure.com","models":["gpt-4o"],"secret":"copied.key"}')" 422 "a secret holding the admin credential"
expect "$(post /admin/providers/enterprise/bedrock '{"region":"us-east-1","models":["m"],"bearerTokenSecret":"gateway-token"}')" 422 "the gateway token as a Bedrock key"
expect "$(post /admin/providers/enterprise/enterprise-openai '{"baseUrl":"https://llm.example.com/v1","secret":"az.key","models":["m"],"headers":{"X-Sub":{"secret":"connector-token"}}}')" 422 "a connector's token as a header"
ln -s "${SECRETS}/gateway-token" "${SECRETS}/link.key"
expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"https://smoke-res.openai.azure.com","models":["gpt-4o"],"secret":"link.key"}')" 422 "a link to the gateway token"
# Bedrock and Vertex shapes.
secret aws.id 'AKIASMOKE6610'; secret aws.secret 'AWS-SECRET-6610'; secret bedrock.key 'BEDROCK-KEY-6610'
expect "$(post /admin/providers/enterprise/bedrock '{"region":"nowhere","models":["m"],"bearerTokenSecret":"bedrock.key"}')" 400 "a malformed region"
expect "$(post /admin/providers/enterprise/bedrock '{"region":"us-east-1","models":["m"]}')" 400 "Bedrock without credentials"
expect "$(post /admin/providers/enterprise/bedrock '{"region":"us-east-1","models":["m"],"accessKeyIdSecret":"aws.id"}')" 400 "an access key id without its secret"
expect "$(post /admin/providers/enterprise/bedrock '{"region":"us-east-1","models":["m"],"accessKeyIdSecret":"aws.id","secretAccessKeySecret":"aws.secret","bearerTokenSecret":"bedrock.key"}')" 400 "access keys and an API key together"
secret vertex.notjson 'not json'
secret vertex.external '{"type":"external_account","credential_source":{"executable":{"command":"touch /tmp/x"}}}'
secret vertex.sa '{"type":"service_account","project_id":"smoke-proj","private_key_id":"k","private_key":"-----BEGIN PRIVATE KEY-----\nVERTEX-PK-6610\n-----END PRIVATE KEY-----\n","client_email":"smoke@smoke-proj.iam.gserviceaccount.com"}'
expect "$(post /admin/providers/enterprise/vertex '{"models":["gemini-2.5-flash"],"serviceAccountSecret":"vertex.notjson","project":"smoke-proj","location":"us-central1"}')" 400 "a service account key that isn't JSON"
expect "$(post /admin/providers/enterprise/vertex '{"models":["gemini-2.5-flash"],"serviceAccountSecret":"vertex.external","project":"smoke-proj","location":"us-central1"}')" 400 "an external_account credential"
expect "$(post /admin/providers/enterprise/vertex '{"models":["gemini-2.5-flash"],"serviceAccountSecret":"vertex.sa"}')" 400 "a service account without project and location"
secret vertex.othertoken '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----\n","client_email":"a@b.iam.gserviceaccount.com","token_uri":"http://127.0.0.1:9/token"}'
expect "$(post /admin/providers/enterprise/vertex '{"models":["gemini-2.5-flash"],"serviceAccountSecret":"vertex.othertoken","project":"smoke-proj","location":"us-central1"}')" 400 "a service account key with another token address"
# Pi reads these Vertex keys as "no key" and signs in with the host's own Google login.
secret vertex.placeholder '  <anything>  '
secret vertex.named 'gcp-vertex-credentials'
expect "$(post /admin/providers/enterprise/vertex '{"models":["gemini-2.5-flash"],"secret":"vertex.placeholder","project":"smoke-proj","location":"us-central1"}')" 400 "a placeholder-looking Vertex key"
expect "$(post /admin/providers/enterprise/vertex '{"models":["gemini-2.5-flash"],"secret":"vertex.named"}')" 400 "Pi's own Vertex placeholder as a key"
expect "$(post /admin/providers/enterprise/enterprise-openai '{"baseUrl":"https://llm.example.com/v1","secret":"az.key","models":["m"],"headers":{"Authorization":"x"}}')" 400 "overriding the Authorization header"
expect "$(post /admin/providers/enterprise/enterprise-openai '{"baseUrl":"https://llm.example.com/v1","secret":"az.key","models":["m"],"headers":{"X-A":"a\r\nX-B: b"}}')" 400 "a header value with a line break"
[[ ! -e "${MODELS_JSON}" || "$(jsonv "${MODELS_JSON}" 'Object.keys(j.providers).filter(k=>k.startsWith("enterprise-")).length')" == "0" ]] || { echo "a refused registration wrote to models.json" >&2; exit 1; }
echo "refusal assertions passed"

# 2. Registrations: what Pi is given.
# A key that looks like a Pi template stays literal.
secret az.key '$HOME!AZ-KEY-6610'
expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"https://smoke-res.openai.azure.com/","models":["gpt-4o","gpt-4o-mini"],"apiVersion":"2025-04-01-preview","secret":"az.key"}')" 200 "registering Azure"
grep -q 'AZ-KEY-6610' "${BODY}" && { echo "the Azure key was echoed" >&2; exit 1; }
[[ "$(jsonv "${BODY}" 'j.models.join(",")')" == "enterprise-azure/gpt-4o,enterprise-azure/gpt-4o-mini" ]] || { echo "Azure models: $(cat "${BODY}")" >&2; exit 1; }
[[ "$(jsonv "${MODELS_JSON}" 'j.providers["enterprise-azure"].api+" "+j.providers["enterprise-azure"].baseUrl')" == "azure-openai-responses https://smoke-res.openai.azure.com" ]] || { echo "Azure models.json entry: $(cat "${MODELS_JSON}")" >&2; exit 1; }
grep -q 'AZ-KEY-6610' "${MODELS_JSON}" && { echo "a key was written to models.json" >&2; exit 1; }
[[ "$(mode_of "${AUTH_JSON}")" == "600" && "$(mode_of "${MODELS_JSON}")" == "600" ]] || { echo "auth.json and models.json must be 0600" >&2; exit 1; }
[[ "$(jsonv "${AUTH_JSON}" 'j["enterprise-azure"].env.AZURE_OPENAI_BASE_URL+" "+j["enterprise-azure"].env.AZURE_OPENAI_API_VERSION')" == "https://smoke-res.openai.azure.com 2025-04-01-preview" ]] || { echo "Azure auth.json env: $(cat "${AUTH_JSON}")" >&2; exit 1; }
PI_RESOLVE="${PROJECT_ROOT}/vendor/pi/packages/coding-agent/dist/core/resolve-config-value.js"
AUTH_JSON="${AUTH_JSON}" node --input-type=module -e '
const { resolveConfigValue } = await import(process.argv[1]);
const a = JSON.parse((await import("node:fs")).readFileSync(process.env.AUTH_JSON, "utf8"))["enterprise-azure"];
if (resolveConfigValue(a.key, a.env) !== "$HOME!AZ-KEY-6610") { console.error("the stored key did not stay literal"); process.exit(1); }' "${PI_RESOLVE}" || exit 1
expect "$(post /admin/providers/enterprise/bedrock '{"region":"eu-west-2","models":["anthropic.claude-sonnet-4-5-20250929-v1:0"],"bearerTokenSecret":"bedrock.key"}')" 200 "registering Bedrock with an API key"
[[ "$(jsonv "${MODELS_JSON}" 'j.providers["enterprise-bedrock"].baseUrl')" == "https://bedrock-runtime.eu-west-2.amazonaws.com" ]] || { echo "Bedrock base URL" >&2; exit 1; }
[[ "$(jsonv "${AUTH_JSON}" 'j["enterprise-bedrock"].env.AWS_REGION+" "+j["enterprise-bedrock"].env.AWS_BEARER_TOKEN_BEDROCK')" == "eu-west-2 BEDROCK-KEY-6610" ]] || { echo "Bedrock auth.json env: $(cat "${AUTH_JSON}")" >&2; exit 1; }
expect "$(post /admin/providers/enterprise/bedrock '{"region":"us-east-1","models":["m"],"accessKeyIdSecret":"aws.id","secretAccessKeySecret":"aws.secret"}')" 200 "re-registering Bedrock with access keys"
[[ "$(jsonv "${AUTH_JSON}" 'Object.keys(j["enterprise-bedrock"].env).sort().join(",")')" == "AWS_ACCESS_KEY_ID,AWS_REGION,AWS_SECRET_ACCESS_KEY" ]] || { echo "switching Bedrock to access keys must drop the API key: $(cat "${AUTH_JSON}")" >&2; exit 1; }
expect "$(post /admin/providers/enterprise/vertex '{"models":["gemini-2.5-flash"],"serviceAccountSecret":"vertex.sa","project":"smoke-proj","location":"us-central1"}')" 200 "registering Vertex with a service account"
SA_COPY="${PI_CODING_AGENT_DIR}/enterprise-vertex-service-account.json"
[[ "$(jsonv "${AUTH_JSON}" 'j["enterprise-vertex"].env.GOOGLE_APPLICATION_CREDENTIALS')" == "$(node -e 'console.log(require("path").resolve(process.argv[1]))' "${SA_COPY}")" ]] || { echo "Vertex should read the gateway's own copy of the key, never a secret: $(cat "${AUTH_JSON}")" >&2; exit 1; }
[[ "$(mode_of "${SA_COPY}")" == "600" && "$(jsonv "${SA_COPY}" 'j.type+" "+j.token_uri+" "+Object.keys(j).sort().join(",")')" == "service_account https://oauth2.googleapis.com/token client_email,private_key,private_key_id,project_id,token_uri,type" ]] || { echo "the key copy should be a plain service account, 0600: $(cat "${SA_COPY}")" >&2; exit 1; }
# Replacing the secret afterwards changes nothing Google's client reads (#126 review).
secret vertex.sa '{"type":"external_account","credential_source":{"file":"secrets/gateway-token"},"token_url":"http://127.0.0.1:9/token"}'
grep -q 'external_account' "${SA_COPY}" && { echo "a replaced secret reached the key file Google reads" >&2; exit 1; }
[[ "$(jsonv "${AUTH_JSON}" 'j["enterprise-vertex"].key')" == "<gcp-service-account>" ]] || { echo "Vertex service account mode needs the placeholder key" >&2; exit 1; }
[[ "$(jsonv "${MODELS_JSON}" 'j.providers["enterprise-vertex"].apiKey')" != \<* ]] || { echo "models.json must never hold a placeholder that falls back to the host's Google login" >&2; exit 1; }
grep -q 'VERTEX-PK-6610' "${AUTH_JSON}" "${MODELS_JSON}" && { echo "the service account key reached auth.json or models.json" >&2; exit 1; }
# An API key registration keeps no project, location or key file.
secret vertex.key 'VERTEX-API-KEY-6610'
expect "$(post /admin/providers/enterprise/vertex '{"models":["gemini-2.5-flash"],"secret":"vertex.key","project":"smoke-proj","location":"us-central1"}')" 200 "registering Vertex with an API key"
[[ "$(jsonv "${AUTH_JSON}" 'JSON.stringify(j["enterprise-vertex"].env ?? null)')" == "null" && ! -e "${SA_COPY}" ]] || { echo "API key mode should leave no settings or key file: $(cat "${AUTH_JSON}")" >&2; exit 1; }
secret vertex.sa '{"type":"service_account","project_id":"smoke-proj","private_key_id":"k","private_key":"-----BEGIN PRIVATE KEY-----\nVERTEX-PK-6610\n-----END PRIVATE KEY-----\n","client_email":"smoke@smoke-proj.iam.gserviceaccount.com"}'
expect "$(post /admin/providers/enterprise/vertex '{"models":["gemini-2.5-flash"],"serviceAccountSecret":"vertex.sa","project":"smoke-proj","location":"us-central1"}')" 200 "registering Vertex with a service account again"
expect "$(del /admin/providers/enterprise-vertex)" 200 "removing Vertex"
[[ ! -e "${SA_COPY}" ]] || { echo "removing Vertex should remove its key file" >&2; exit 1; }
secret sub.key 'SUB-KEY-6610'
expect "$(post /admin/providers/enterprise/enterprise-openai '{"baseUrl":"https://llm.example.com/v1","secret":"az.key","models":["corp-large"],"headers":{"X-Team":"$USER","Ocp-Apim-Subscription-Key":{"secret":"sub.key"}}}')" 200 "registering an enterprise gateway with headers"
[[ "$(jsonv "${MODELS_JSON}" 'j.providers["enterprise-openai"].headers["X-Team"]+" "+j.providers["enterprise-openai"].headers["Ocp-Apim-Subscription-Key"]')" == '$$USER SUB-KEY-6610' ]] || { echo "headers must be stored literal: $(cat "${MODELS_JSON}")" >&2; exit 1; }
# Re-registering replaces: nothing from before follows the provider to a new address.
expect "$(post /admin/providers/enterprise/enterprise-openai '{"baseUrl":"https://other.example.com/v1","secret":"az.key","models":["other"]}')" 200 "re-registering the gateway elsewhere"
[[ "$(jsonv "${MODELS_JSON}" 'JSON.stringify([j.providers["enterprise-openai"].headers ?? null, j.providers["enterprise-openai"].models.map(m=>m.id)])')" == '[null,["other"]]' ]] || { echo "old headers or models followed the provider: $(cat "${MODELS_JSON}")" >&2; exit 1; }
# Listing: the kinds, and the registered providers without key material.
expect "$(get /admin/models)" 200 "listing models"
[[ "$(jsonv "${BODY}" 'j.enterprise.map(k=>k.kind).join(",")')" == "azure-openai,bedrock,vertex,enterprise-openai" ]] || { echo "GET /admin/models should list the enterprise kinds" >&2; exit 1; }
[[ "$(jsonv "${BODY}" 'j.registered.filter(p=>p.kind).map(p=>p.auth).join(",")')" == "stored credentials,stored credentials,stored credentials" ]] || { echo "enterprise providers should be listed with a safe auth summary: $(cat "${BODY}")" >&2; exit 1; }
grep -q '6610' "${BODY}" && { echo "GET /admin/models showed key material" >&2; exit 1; }
grep -q '6610' "${AUDIT}" && { echo "key material reached the audit log" >&2; exit 1; }
grep -q '"action":"provider_registered".*"kind":"vertex".*"keySources":\["secret:vertex.sa"\]' "${AUDIT}" || { echo "the registration was not audited" >&2; exit 1; }
grep -q 'VERTEX-API-KEY-6610' "${AUDIT}" && { echo "a key reached the audit log" >&2; exit 1; }
# Removing a provider removes its credentials.
expect "$(del /admin/providers/enterprise-openai)" 200 "removing the enterprise gateway"
[[ "$(jsonv "${MODELS_JSON}" '"enterprise-openai" in j.providers')" == "false" && "$(jsonv "${AUTH_JSON}" '"enterprise-openai" in j')" == "false" ]] || { echo "removal left the provider or its key" >&2; exit 1; }
expect "$(del /admin/providers/local-openai)" 404 "removing a non-enterprise provider here"
# The Test.
expect "$(post /admin/providers/nope/test '{}')" 404 "testing an unregistered provider"
expect "$(post /admin/providers/enterprise-azure/test '{"model":"not-there"}')" 400 "testing a model the provider doesn't have"
printf '{"advancedSettings":false}\n' > "${DATA}/admin/permissions.json"
expect "$(post /admin/providers/enterprise-azure/test '{}')" 403 "testing without the advanced permission"
expect "$(del /admin/providers/enterprise-azure)" 403 "removing without the advanced permission"
stop_gateway
echo "registration assertions passed"

# 3. Against a stub, with the host's switch for private hosts: the live Test
#    through Pi, a Bedrock API key on the host, and redirects.
STUB_LOG="${TEMP_RUNTIME}/stub.log"
OTHER_LOG="${TEMP_RUNTIME}/other.log"
: > "${OTHER_LOG}"
OTHER_PORT="${OTHER_PORT}" OTHER_LOG="${OTHER_LOG}" node -e '
require("http").createServer((req, res) => {
  require("fs").appendFileSync(process.env.OTHER_LOG, JSON.stringify({ url: req.url, headers: req.headers }) + "\n");
  res.writeHead(500); res.end();
}).listen(Number(process.env.OTHER_PORT), "127.0.0.1");' &
other_pid=$!
STUB_PORT="${STUB_PORT}" OTHER_PORT="${OTHER_PORT}" STUB_LOG="${STUB_LOG}" node -e '
const sse = (res, events) => { res.writeHead(200, { "content-type": "text/event-stream" }); for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`); res.end("data: [DONE]\n\n"); };
require("http").createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)).on("end", () => {
    require("fs").appendFileSync(process.env.STUB_LOG, JSON.stringify({ url: req.url, auth: req.headers.authorization ?? null, apiKey: req.headers["api-key"] ?? null, sub: req.headers["ocp-apim-subscription-key"] ?? null }) + "\n");
    const key = req.headers["api-key"] ?? req.headers.authorization ?? "";
    // Another origin: a chat or Test that follows it would carry the headers there.
    if (req.url.startsWith("/hop/")) { res.writeHead(307, { location: `http://127.0.0.1:${process.env.OTHER_PORT}${req.url.slice(4)}` }); res.end(); return; }
    if (req.url.startsWith("/redirect/")) { res.writeHead(302, { location: `http://127.0.0.1:${process.env.STUB_PORT}/v1/models` }); res.end(); return; }
    if (req.url.startsWith("/deny/")) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `bad key ${key}` } })); return; }
    if (req.url === "/openai/v1/embeddings" || req.url === "/v1/embeddings") {
      const input = JSON.parse(body).input;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: input.map((_, index) => ({ object: "embedding", index, embedding: [0.1, 0.2, 0.3] })) }));
      return;
    }
    if (req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "corp-large" }] })); return; }
    if (req.url === "/v1/chat/completions") {
      sse(res, [
        { id: "c1", object: "chat.completion.chunk", created: 1, model: "corp-large", choices: [{ index: 0, delta: { role: "assistant", content: "ready" }, finish_reason: null }] },
        { id: "c1", object: "chat.completion.chunk", created: 1, model: "corp-large", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
      ]);
      return;
    }
    if (req.url.startsWith("/openai/v1/responses")) {
      const item = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ready", annotations: [] }] };
      const response = { id: "resp_1", object: "response", status: "completed", model: "gpt-4o", output: [item], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 0 } } };
      sse(res, [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg_1", part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "ready" },
        { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "msg_1", text: "ready" },
        { type: "response.content_part.done", output_index: 0, content_index: 0, item_id: "msg_1", part: { type: "output_text", text: "ready", annotations: [] } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response },
      ]);
      return;
    }
    res.writeHead(404); res.end();
  });
}).listen(Number(process.env.STUB_PORT), "127.0.0.1");' &
stub_pid=$!
sleep 0.5
STUB="http://127.0.0.1:${STUB_PORT}"
export MINDSTONE_ENTERPRISE_PRIVATE_HOSTS=1
# scripts/env.sh drops host provider variables unless the host opts in; this host does.
export MSA_ALLOW_HOST_PROVIDER_ENV=1
export AWS_BEARER_TOKEN_BEDROCK="HOST-BEDROCK-6610" AWS_SESSION_TOKEN="HOST-SESSION-6610"
# A generic embedder in the gateway's environment: never used for an enterprise endpoint.
export EMBEDDER_BASE_URL="http://127.0.0.1:9/not-used" EMBEDDER_API_KEY="ENV-EMBED-KEY"
start_gateway
grant
expect "$(post /admin/providers/enterprise/bedrock '{"region":"us-east-1","models":["m"],"accessKeyIdSecret":"aws.id","secretAccessKeySecret":"aws.secret"}')" 409 "access keys while the host sets a session token"
grep -q 'AWS_SESSION_TOKEN' "${BODY}" || { echo "the refusal should name the host's session token: $(cat "${BODY}")" >&2; exit 1; }
secret aws.session 'AWS-SESSION-6610'
expect "$(post /admin/providers/enterprise/bedrock '{"region":"us-east-1","models":["m"],"accessKeyIdSecret":"aws.id","secretAccessKeySecret":"aws.secret","sessionTokenSecret":"aws.session"}')" 409 "access keys while the host sets a Bedrock API key"
grep -q 'AWS_BEARER_TOKEN_BEDROCK' "${BODY}" || { echo "the refusal should name the host's Bedrock API key: $(cat "${BODY}")" >&2; exit 1; }
expect "$(post /admin/providers/enterprise/bedrock '{"region":"us-east-1","models":["m"],"bearerTokenSecret":"bedrock.key"}')" 200 "a Bedrock API key while the host sets one"
expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"http://10.1.2.3/openai/v1","models":["gpt-4o"],"secret":"az.key"}')" 400 "plain http to a private host, even with the switch"
expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"https://10.1.2.3/openai/v1","models":["gpt-4o"],"secret":"az.key"}')" 200 "https to a private host with the switch"
secret az.key 'AZ-KEY-6610'
expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"'"${STUB}"'/openai/v1","models":["gpt-4o"],"secret":"az.key"}')" 200 "registering Azure at the stub"
expect "$(post /admin/providers/enterprise-azure/test '{"model":"enterprise-azure/gpt-4o"}')" 200 "testing Azure"
[[ "$(jsonv "${BODY}" 'j.ok+" "+j.reply+" "+j.model')" == "true ready enterprise-azure/gpt-4o" ]] || { echo "the Azure test should answer through Pi: $(cat "${BODY}")" >&2; cat "${STUB_LOG}" >&2; exit 1; }
grep -q '"url":"/openai/v1/responses.*"apiKey":"AZ-KEY-6610"' "${STUB_LOG}" || { echo "Azure should send its key as api-key to the registered endpoint: $(cat "${STUB_LOG}")" >&2; exit 1; }
# The provider's own settings in auth.json win over models.json and the environment: with models.json
# pointing nowhere, the Test still goes to AZURE_OPENAI_BASE_URL from auth.json.
node -e 'const f=process.argv[1]; const fs=require("fs"); const c=JSON.parse(fs.readFileSync(f,"utf8")); c.providers["enterprise-azure"].baseUrl="https://models-json-not-used.invalid/openai/v1"; fs.writeFileSync(f, JSON.stringify(c,null,2))' "${MODELS_JSON}"
before="$(grep -c '/openai/v1/responses' "${STUB_LOG}")"
expect "$(post /admin/providers/enterprise-azure/test '{}')" 200 "testing Azure with models.json pointing elsewhere"
[[ "$(jsonv "${BODY}" 'j.ok')" == "true" && "$(grep -c '/openai/v1/responses' "${STUB_LOG}")" -gt "${before}" ]] || { echo "Azure should use the endpoint in its auth.json settings: $(cat "${BODY}")" >&2; exit 1; }
expect "$(post /admin/providers/enterprise/enterprise-openai '{"baseUrl":"'"${STUB}"'/v1","secret":"az.key","headers":{"Ocp-Apim-Subscription-Key":{"secret":"sub.key"}}}')" 200 "registering a gateway by listing its models"
[[ "$(jsonv "${BODY}" 'j.models.join(",")')" == "enterprise-openai/corp-large" ]] || { echo "listed models: $(cat "${BODY}")" >&2; exit 1; }
grep -q '"url":"/v1/models","auth":"Bearer AZ-KEY-6610","apiKey":null,"sub":"SUB-KEY-6610"' "${STUB_LOG}" || { echo "the listing should send the key and headers: $(cat "${STUB_LOG}")" >&2; exit 1; }
expect "$(post /admin/providers/enterprise-openai/test '{}')" 200 "testing the gateway"
[[ "$(jsonv "${BODY}" 'j.ok+" "+j.reply')" == "true ready" ]] || { echo "the gateway test: $(cat "${BODY}")" >&2; exit 1; }
grep -q '"url":"/v1/chat/completions","auth":"Bearer AZ-KEY-6610","apiKey":null,"sub":"SUB-KEY-6610"' "${STUB_LOG}" || { echo "the chat should send the key and headers" >&2; exit 1; }
# A chat or Test never follows a redirect to another origin with the key or headers (#126 review).
expect "$(post /admin/providers/enterprise/enterprise-openai '{"baseUrl":"'"${STUB}"'/hop/v1","secret":"az.key","models":["corp-large"],"headers":{"Ocp-Apim-Subscription-Key":{"secret":"sub.key"}}}')" 200 "registering a gateway that redirects its chats"
expect "$(post /admin/providers/enterprise-openai/test '{}')" 200 "testing a gateway that redirects"
[[ "$(jsonv "${BODY}" 'j.ok')" == "false" ]] || { echo "a redirected test must fail: $(cat "${BODY}")" >&2; exit 1; }
expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"'"${STUB}"'/hop/openai/v1","models":["gpt-4o"],"secret":"az.key"}')" 200 "registering Azure behind a redirect"
expect "$(post /admin/providers/enterprise-azure/test '{}')" 200 "testing Azure behind a redirect"
[[ "$(jsonv "${BODY}" 'j.ok')" == "false" ]] || { echo "a redirected Azure test must fail: $(cat "${BODY}")" >&2; exit 1; }
grep -q '/hop/v1/chat/completions' "${STUB_LOG}" && grep -q '/hop/openai/v1/responses' "${STUB_LOG}" || { echo "the redirect tests never reached the stub: $(cat "${STUB_LOG}")" >&2; exit 1; }
[[ ! -s "${OTHER_LOG}" ]] || { echo "a key or header followed a redirect to another origin: $(cat "${OTHER_LOG}")" >&2; exit 1; }
# The same for a chat from the CLI, which runs Pi in its own process (#126 review).
# Both routing modes: "pi" (a one-shot provider) and "pi-session" (the session executor, the default).
for mode in pi pi-session; do
  cp "${CONFIG}" "${CONFIG}.bak"
  ROUTING_MODE="${mode}" python3 - "${CONFIG}" <<'PY'
import json, os, sys
p = sys.argv[1]; c = json.load(open(p))
c["routing"] = {"mode": os.environ["ROUTING_MODE"], "defaultAgentId": "default", "defaultModel": "enterprise-openai/corp-large"}
json.dump(c, open(p, "w"), indent=2)
PY
  before="$(grep -c '/hop/v1/chat/completions' "${STUB_LOG}")"
  ./scripts/mindstone chat --once "hello" >"${TEMP_RUNTIME}/cli-chat-${mode}.log" 2>&1 || true
  mv "${CONFIG}.bak" "${CONFIG}"
  [[ "$(grep -c '/hop/v1/chat/completions' "${STUB_LOG}")" -gt "${before}" ]] || { echo "the ${mode} CLI chat never reached the gateway's address: $(tail -5 "${TEMP_RUNTIME}/cli-chat-${mode}.log")" >&2; exit 1; }
  [[ ! -s "${OTHER_LOG}" ]] || { echo "a ${mode} CLI chat followed a redirect to another origin with the key or headers: $(cat "${OTHER_LOG}")" >&2; exit 1; }
done
expect "$(post /admin/providers/enterprise/azure-openai '{"endpoint":"'"${STUB}"'/openai/v1","models":["gpt-4o"],"secret":"az.key"}')" 200 "registering Azure at the stub again"
# A listing that redirects is refused: the key and headers only go to the registered address.
before="$(grep -c '/v1/models' "${STUB_LOG}")"
expect "$(post /admin/providers/enterprise/enterprise-openai '{"baseUrl":"'"${STUB}"'/redirect","secret":"az.key","headers":{"Ocp-Apim-Subscription-Key":{"secret":"sub.key"}}}')" 422 "a listing that redirects"
[[ "$(grep -c '/v1/models' "${STUB_LOG}")" == "${before}" ]] || { echo "the listing followed a redirect with the key" >&2; exit 1; }
# A failing test says why, without the provider's key or headers.
expect "$(post /admin/providers/enterprise/enterprise-openai '{"baseUrl":"'"${STUB}"'/deny","secret":"az.key","models":["corp-large"],"headers":{"Ocp-Apim-Subscription-Key":{"secret":"sub.key"}}}')" 200 "registering a gateway that refuses"
expect "$(post /admin/providers/enterprise-openai/test '{}')" 200 "testing a gateway that refuses"
[[ "$(jsonv "${BODY}" 'j.ok')" == "false" ]] || { echo "a refused test must be ok:false: $(cat "${BODY}")" >&2; exit 1; }
grep -q 'AZ-KEY-6610\|SUB-KEY-6610' "${BODY}" && { echo "a failed test showed the key: $(cat "${BODY}")" >&2; exit 1; }
grep -q '401' "${BODY}" || { echo "a failed test should say what the provider answered: $(cat "${BODY}")" >&2; exit 1; }
grep -q '"action":"provider_tested".*"ok":false' "${AUDIT}" || { echo "tests are not audited" >&2; exit 1; }
# Embeddings through the same endpoints: the registered address and key, nothing from the environment.
expect "$(post /admin/memory/check '{"embeddingProvider":"enterprise-vertex:x"}')" 400 "an enterprise kind memory can't embed through"
expect "$(post /admin/memory/check '{"embeddingProvider":"enterprise-azure:text-embedding-3-small"}')" 200 "checking Azure embeddings"
[[ "$(jsonv "${BODY}" 'j.ok+" "+j.dimensions')" == "true 3" ]] || { echo "Azure embeddings should work: $(cat "${BODY}")" >&2; exit 1; }
grep -q '"url":"/openai/v1/embeddings","auth":null,"apiKey":"AZ-KEY-6610"' "${STUB_LOG}" || { echo "Azure embeddings should send the api-key to the registered endpoint: $(cat "${STUB_LOG}")" >&2; exit 1; }
# The gateway is registered at /deny now: the refusal comes back without the key.
expect "$(post /admin/memory/check '{"embeddingProvider":"enterprise-openai:corp-embed"}')" 200 "checking embeddings at a gateway that refuses"
[[ "$(jsonv "${BODY}" 'j.ok')" == "false" ]] || { echo "a refused embedding check must be ok:false" >&2; exit 1; }
grep -q 'AZ-KEY-6610\|SUB-KEY-6610' "${BODY}" && { echo "a failed embedding check showed the key: $(cat "${BODY}")" >&2; exit 1; }
expect "$(post /admin/providers/enterprise/enterprise-openai '{"baseUrl":"'"${STUB}"'/v1","secret":"az.key","models":["corp-large"],"headers":{"Ocp-Apim-Subscription-Key":{"secret":"sub.key"}}}')" 200 "registering the gateway again"
expect "$(post /admin/memory/check '{"embeddingProvider":"enterprise-openai:corp-embed"}')" 200 "checking gateway embeddings"
[[ "$(jsonv "${BODY}" 'j.ok')" == "true" ]] || { echo "gateway embeddings should work: $(cat "${BODY}")" >&2; exit 1; }
grep -q '"url":"/v1/embeddings","auth":"Bearer AZ-KEY-6610","apiKey":null,"sub":"SUB-KEY-6610"' "${STUB_LOG}" || { echo "gateway embeddings should send the key and headers" >&2; exit 1; }
grep -q 'ENV-EMBED-KEY' "${STUB_LOG}" && { echo "an environment key reached an enterprise endpoint" >&2; exit 1; }
# An embedding request that redirects is refused, like the listing.
expect "$(post /admin/providers/enterprise/enterprise-openai '{"baseUrl":"'"${STUB}"'/redirect","secret":"az.key","models":["corp-large"]}')" 200 "registering a gateway that redirects"
before="$(grep -c '"/v1/models"' "${STUB_LOG}")"
expect "$(post /admin/memory/check '{"embeddingProvider":"enterprise-openai:corp-embed"}')" 200 "checking embeddings at a gateway that redirects"
[[ "$(jsonv "${BODY}" 'j.ok')" == "false" && "$(grep -c '"/v1/models"' "${STUB_LOG}")" == "${before}" ]] || { echo "an embedding request followed a redirect: $(cat "${BODY}")" >&2; exit 1; }
# Not registered: says so, and sends nothing anywhere.
expect "$(del /admin/providers/enterprise-azure)" 200 "removing Azure"
lines="$(wc -l < "${STUB_LOG}")"
expect "$(post /admin/memory/check '{"embeddingProvider":"enterprise-azure:text-embedding-3-small"}')" 200 "checking embeddings through a removed provider"
grep -q "isn't registered" "${BODY}" || { echo "a removed provider should say it isn't registered: $(cat "${BODY}")" >&2; exit 1; }
[[ "$(wc -l < "${STUB_LOG}")" == "${lines}" ]] || { echo "a removed provider still sent a request" >&2; exit 1; }
grep -q '6610' "${AUDIT}" && { echo "key material reached the audit log" >&2; exit 1; }
stop_gateway
echo "enterprise endpoint assertions passed"
