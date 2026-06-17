export const WEBCHAT_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MindStone WebChat</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101014;
      --panel: #181820;
      --panel-2: #20202a;
      --text: #f4f0df;
      --muted: #b7ad92;
      --gold: #d7a935;
      --gold-2: #f0ca5a;
      --danger: #ff7066;
      --ok: #6ee7a8;
      --border: #363241;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at top left, #252033 0, var(--bg) 42rem);
      color: var(--text);
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
    }
    header {
      border-bottom: 1px solid var(--border);
      background: rgba(16, 16, 20, 0.84);
      backdrop-filter: blur(14px);
      padding: 1rem clamp(1rem, 3vw, 2rem);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    h1 { margin: 0; font-size: 1.05rem; letter-spacing: 0.03em; }
    .brand { display: flex; align-items: center; gap: 0.7rem; }
    .diamond {
      width: 1rem; height: 1rem; transform: rotate(45deg);
      background: linear-gradient(135deg, var(--gold), var(--gold-2));
      box-shadow: 0 0 24px rgba(215, 169, 53, 0.45);
    }
    .status { color: var(--muted); font-size: 0.85rem; }
    main {
      display: grid;
      grid-template-columns: minmax(15rem, 22rem) 1fr;
      gap: 1rem;
      padding: 1rem clamp(1rem, 3vw, 2rem);
      min-height: 0;
    }
    aside, section.chat {
      border: 1px solid var(--border);
      background: rgba(24, 24, 32, 0.86);
      border-radius: 16px;
      overflow: hidden;
    }
    aside { padding: 1rem; }
    label { display: block; color: var(--muted); font-size: 0.78rem; margin: 0.8rem 0 0.35rem; }
    input, textarea, select, button {
      width: 100%; border: 1px solid var(--border); border-radius: 10px;
      background: var(--panel-2); color: var(--text); padding: 0.7rem;
      font: inherit;
    }
    input:focus, textarea:focus { outline: 1px solid var(--gold); }
    button {
      cursor: pointer; background: linear-gradient(180deg, #3a3018, #262117);
      border-color: #67501c; color: var(--gold-2); font-weight: 650;
    }
    button.secondary { background: var(--panel-2); color: var(--text); border-color: var(--border); }
    button.danger { color: var(--danger); border-color: #6b2b2a; background: #2b1718; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
    .hint { color: var(--muted); font-size: 0.78rem; line-height: 1.35; margin-top: 0.75rem; }
    section.chat { display: grid; grid-template-rows: auto 1fr auto; min-height: 0; }
    .chatbar { padding: 0.8rem 1rem; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 0.82rem; display: flex; justify-content: space-between; gap: 1rem; }
    #messages { padding: 1rem; overflow: auto; min-height: 0; }
    .message { margin: 0 0 0.85rem; max-width: 56rem; }
    .meta { color: var(--muted); font-size: 0.75rem; margin-bottom: 0.2rem; }
    .bubble { white-space: pre-wrap; line-height: 1.4; border: 1px solid var(--border); background: var(--panel-2); padding: 0.75rem 0.85rem; border-radius: 12px; }
    .message.user .bubble { border-color: #4c5e8f; background: #1b2235; }
    .message.assistant .bubble { border-color: #5f4a18; background: #2d2618; }
    .message.event .bubble { color: var(--muted); font-style: italic; }
    form { display: grid; grid-template-columns: 1fr auto; gap: 0.7rem; padding: 1rem; border-top: 1px solid var(--border); }
    form textarea { min-height: 3rem; max-height: 12rem; resize: vertical; }
    form button { width: 8rem; }
    @media (max-width: 800px) {
      main { grid-template-columns: 1fr; }
      aside { order: 2; }
      section.chat { min-height: 65vh; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand"><div class="diamond" aria-hidden="true"></div><h1>MindStone WebChat</h1></div>
    <div class="status" id="status">loading…</div>
  </header>
  <main>
    <aside>
      <label for="baseUrl">Gateway base URL</label>
      <input id="baseUrl" autocomplete="off" />

      <label for="token">Bearer token / X-MindStone-Token</label>
      <input id="token" type="password" autocomplete="off" placeholder="optional" />

      <div class="row">
        <div>
          <label for="agentId">Agent</label>
          <input id="agentId" value="default" />
        </div>
        <div>
          <label for="limit">History limit</label>
          <input id="limit" type="number" min="1" max="500" value="100" />
        </div>
      </div>

      <label for="sessionKey">Session key</label>
      <input id="sessionKey" placeholder="blank = canonical default" />
      <div class="hint">Leave blank to use MindStone-Agent’s canonical default: <code>agent:default:main</code>.</div>

      <label for="senderId">Sender ID</label>
      <input id="senderId" value="webchat-local" />

      <div class="row" style="margin-top: 1rem;">
        <button id="refresh" type="button">Refresh</button>
        <button id="save" type="button" class="secondary">Save</button>
      </div>
      <button id="abort" type="button" class="danger" style="margin-top: 0.5rem;">Abort active run</button>

      <p class="hint">This is a thin native MindStone surface over Gateway WebChat endpoints. It is not OpenWebUI. Transcript continuity is owned by the Gateway.</p>
    </aside>
    <section class="chat">
      <div class="chatbar"><span id="sessionDisplay">session: resolving…</span><span id="countDisplay">0 entries</span></div>
      <div id="messages" aria-live="polite"></div>
      <form id="composer">
        <textarea id="message" placeholder="Message MindStone…"></textarea>
        <button type="submit">Send</button>
      </form>
    </section>
  </main>
<script>
const $ = (id) => document.getElementById(id);
const state = {
  baseUrl: localStorage.getItem("mindstone.webchat.baseUrl") || window.location.origin,
  token: localStorage.getItem("mindstone.webchat.token") || "",
  agentId: localStorage.getItem("mindstone.webchat.agentId") || "default",
  sessionKey: localStorage.getItem("mindstone.webchat.sessionKey") || "",
  senderId: localStorage.getItem("mindstone.webchat.senderId") || "webchat-local",
  limit: localStorage.getItem("mindstone.webchat.limit") || "100",
};
for (const key of Object.keys(state)) if ($(key)) $(key).value = state[key];

function saveSettings() {
  for (const key of ["baseUrl", "token", "agentId", "sessionKey", "senderId", "limit"]) {
    state[key] = $(key).value.trim();
    localStorage.setItem("mindstone.webchat." + key, state[key]);
  }
}

function headers() {
  const h = { "content-type": "application/json" };
  if (state.token) {
    h.authorization = "Bearer " + state.token;
    h["x-mindstone-token"] = state.token;
  }
  return h;
}

function params() {
  const p = new URLSearchParams();
  if (state.agentId) p.set("agentId", state.agentId);
  if (state.sessionKey) p.set("sessionKey", state.sessionKey);
  if (state.senderId) p.set("senderId", state.senderId);
  if (state.limit) p.set("limit", state.limit);
  return p;
}

async function api(path, init = {}) {
  const response = await fetch(state.baseUrl + path, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  if (!response.ok && !(path === "/chat/send" && response.status === 501 && body.persisted)) {
    throw new Error(body.error || body?.error?.message || (response.status + " " + response.statusText));
  }
  return { status: response.status, body };
}

function render(entries, sessionKey) {
  $("sessionDisplay").textContent = "session: " + (sessionKey || "unknown");
  $("countDisplay").textContent = entries.length + " entr" + (entries.length === 1 ? "y" : "ies");
  $("messages").innerHTML = "";
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "message " + (entry.role || "event");
    const meta = document.createElement("div");
    meta.className = "meta";
    const source = entry.source ? (entry.source.substrate || "?") + "/" + (entry.source.channel || "?") + "/" + (entry.source.chatType || "?") : "unknown-source";
    meta.textContent = (entry.role || "event") + " · " + source + " · " + (entry.id || "");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = entry.text || JSON.stringify(entry.content ?? "", null, 2);
    item.append(meta, bubble);
    $("messages").appendChild(item);
  }
  $("messages").scrollTop = $("messages").scrollHeight;
}

async function refresh() {
  saveSettings();
  $("status").textContent = "loading history…";
  try {
    const authHeaders = state.token ? { authorization: "Bearer " + state.token, "x-mindstone-token": state.token } : {};
    const { body } = await api("/chat/history?" + params().toString(), { method: "GET", headers: authHeaders });
    render(body.entries || [], body.sessionKey);
    $("status").textContent = "connected";
  } catch (error) {
    $("status").textContent = "error: " + error.message;
  }
}

async function sendMessage(event) {
  event.preventDefault();
  saveSettings();
  const text = $("message").value.trim();
  if (!text) return;
  $("message").value = "";
  $("status").textContent = "sending…";
  try {
    await api("/chat/send", {
      method: "POST",
      body: JSON.stringify({
        agentId: state.agentId || "default",
        sessionKey: state.sessionKey || undefined,
        senderId: state.senderId || undefined,
        text,
      }),
    });
    await refresh();
  } catch (error) {
    $("status").textContent = "error: " + error.message;
  }
}

async function abortRun() {
  saveSettings();
  $("status").textContent = "requesting abort…";
  try {
    await api("/chat/abort", {
      method: "POST",
      body: JSON.stringify({ agentId: state.agentId || "default", sessionKey: state.sessionKey || undefined, senderId: state.senderId || undefined }),
    });
    await refresh();
  } catch (error) {
    $("status").textContent = "error: " + error.message;
  }
}

$("save").addEventListener("click", () => { saveSettings(); refresh(); });
$("refresh").addEventListener("click", refresh);
$("abort").addEventListener("click", abortRun);
$("composer").addEventListener("submit", sendMessage);
refresh();
</script>
</body>
</html>`;
