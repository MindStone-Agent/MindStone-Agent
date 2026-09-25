#!/usr/bin/env python3
"""Logging proxy for the Console spike: LibreChat -> :19790 -> gateway :19789. Logs every request (method, path,
headers, body) and the response status/headers/first bytes to proxy.log, so the spike records what LibreChat
actually sends (stream flag, user field, headers) rather than what its docs say."""
import http.server, urllib.request, json, sys, time
UP = "http://127.0.0.1:19789"
LOG = open("proxy.log", "a")
def log(*a):
    LOG.write(time.strftime("%H:%M:%S ") + " ".join(str(x) for x in a) + "\n"); LOG.flush()
class H(http.server.BaseHTTPRequestHandler):
    def _fwd(self):
        n = int(self.headers.get("content-length") or 0); body = self.rfile.read(n) if n else b""
        log("REQ", self.command, self.path, json.dumps({k: v for k, v in self.headers.items()}))
        if body: log("REQ-BODY", body.decode("utf-8", "replace")[:4000])
        req = urllib.request.Request(UP + self.path, data=body or None, method=self.command)
        for k, v in self.headers.items():
            if k.lower() not in ("host", "content-length", "connection", "accept-encoding"): req.add_header(k, v)
        try:
            r = urllib.request.urlopen(req, timeout=120); status, hdrs, data = r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            status, hdrs, data = e.code, e.headers, e.read()
        log("RES", status, json.dumps({k: v for k, v in hdrs.items()}), data[:600].decode("utf-8", "replace"))
        self.send_response(status)
        for k, v in hdrs.items():
            if k.lower() not in ("transfer-encoding", "connection", "content-length"): self.send_header(k, v)
        self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)
    do_GET = do_POST = _fwd
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("0.0.0.0", 19790), H).serve_forever()
