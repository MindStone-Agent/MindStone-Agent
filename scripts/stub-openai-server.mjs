// Minimal OpenAI-compatible stub server for local-model route smokes.
// Serves GET /v1/models and POST /v1/chat/completions (SSE + non-streaming).
// Prints {"port": N} on stdout once listening; keeps running until killed.
import { createServer } from "node:http";

const SENTINEL = process.env.STUB_OPENAI_SENTINEL ?? "STUB-OK local route verified";

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model", owned_by: "stub" }] }));
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/v1/chat/completions")) {
      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        // fall through with empty body
      }
      const created = Math.floor(Date.now() / 1000);
      const model = typeof parsed.model === "string" ? parsed.model : "stub-model";
      const usage = { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 };
      if (parsed.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created, model };
        const chunks = [
          { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: { content: SENTINEL }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { ...base, choices: [], usage },
        ];
        for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion",
          created,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: SENTINEL }, finish_reason: "stop" }],
          usage,
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `stub: no route for ${req.method} ${req.url}`, type: "invalid_request_error" } }));
  });
});

server.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ port: server.address().port }));
});
