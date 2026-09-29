import http.server, socketserver, json

state = {"scenario": "happy", "polls": 0, "hits": 0, "rotated": 0, "rotate_seen": []}

SUB_OK = {"has_subscription": True, "subscription": {
    "subscription_url": "https://sub.example.invalid/abc", "is_active": True,
    "is_expired": False, "status": "active", "tariff_name": "Тариф Про"}}

class H(http.server.BaseHTTPRequestHandler):
    def reply(self, code, obj, headers=None, raw=None):
        body = raw if raw is not None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "text/html" if raw else "application/json")
        self.send_header("content-length", str(len(body)))
        for k, v in (headers or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n) if n else b""
        sc = state["scenario"]
        if not self.path.startswith("/__"): state["hits"] += 1
        if self.path == "/__stats":
            return self.reply(200, {"hits": state["hits"]})
        if self.path == "/__scenario":
            state["scenario"] = json.loads(body)["scenario"]; state["polls"] = 0
            return self.reply(200, {"ok": True})
        if self.path.endswith("/auth/refresh"):
            d = json.loads(body or b"{}")
            # rotate=true must come back with a NEW refresh token; without the
            # flag the answer is byte-identical to the old behaviour.
            state["rotate_seen"].append(bool(d.get("rotate")))
            if d.get("rotate") is True:
                state["rotated"] += 1
                return self.reply(200, {"access_token": "acc", "expires_in": 900,
                                        "refresh_token": "ref%d" % (state["rotated"] + 1)})
            return self.reply(200, {"access_token": "acc", "expires_in": 900})
        # Called by the confirmation page in the browser, never by the client.
        # Here only so the stub answers the same set of routes as the cabinet.
        if self.path.endswith("/deeplink/link"):
            if json.loads(body or b"{}").get("token") != "t" * 32:
                return self.reply(410, {"detail": "Token expired, invalid or already used"})
            return self.reply(200, {"status": "linked"})
        if self.path.endswith("/deeplink/request"):
            if sc == "req_429":
                return self.reply(429, {"detail": "Too many requests"}, {"Retry-After": "60"})
            if sc == "req_botmissing":
                # Cabinet behaviour since 29.09.2026: the token is issued and
                # only bot_username comes back empty, so the site route lives.
                return self.reply(200, {"token": "t" * 32, "bot_username": "", "expires_in": 300})
            if sc == "req_botmissing_legacy":
                return self.reply(503, {"detail": "Bot not configured"})
            ttl = 6 if sc == "timeout" else 300
            return self.reply(200, {"token": "t" * 32, "bot_username": "SlavaNetBot", "expires_in": ttl})
        if self.path.endswith("/deeplink/poll"):
            state["polls"] += 1; p = state["polls"]
            if sc == "timeout": return self.reply(202, {"detail": "Waiting for confirmation"})
            if sc == "poll_netdrop" and p <= 2:
                # Connection dies with no answer: the client must keep polling
                # rather than fail a login the person may already have confirmed.
                self.close_connection = True
                try: self.connection.close()
                except Exception: pass
                return
            if sc == "poll_gone": return self.reply(410, {"detail": "Token expired or not found"})
            if sc == "poll_forbidden": return self.reply(403, {"detail": "Account is deactivated"})
            if sc == "poll_422_array":
                return self.reply(422, {"detail": [{"loc": ["body", "token"], "msg": "too short", "type": "value_error"}]})
            if sc == "poll_500_html":
                return self.reply(500, None, raw=b"<html><body>Internal Server Error</body></html>")
            if sc == "poll_429_recover" and p <= 2:
                return self.reply(429, {"detail": "Too many requests"}, {"Retry-After": "1"})
            if p < 3 and sc in ("happy", "no_sub", "revoked", "expired"):
                return self.reply(202, {"detail": "Waiting for confirmation"})
            return self.reply(200, {"access_token": "acc", "refresh_token": "ref",
                                    "token_type": "bearer", "expires_in": 900, "user": {"id": 1}})
        return self.reply(404, {"detail": "not found"})

    def do_GET(self):
        sc = state["scenario"]
        state["hits"] += 1
        if self.path.startswith("/connect-app"):
            tok = self.path.split("token=")[-1] if "token=" in self.path else ""
            page = ("<!doctype html><meta charset=utf-8><h1>Подтверждение входа</h1>"
                    "<p>Код запроса: <b>%s</b></p>" % tok[:8])
            return self.reply(200, None, raw=page.encode())
        if self.path.endswith("/cabinet/subscription"):
            if sc == "no_sub": return self.reply(200, {"has_subscription": False, "subscription": None})
            if sc == "revoked":
                d = json.loads(json.dumps(SUB_OK)); d["subscription"]["subscription_url"] = ""
                return self.reply(200, d)
            if sc == "expired":
                d = json.loads(json.dumps(SUB_OK)); d["subscription"]["is_expired"] = True
                d["subscription"]["is_active"] = False; d["subscription"]["status"] = "expired"
                return self.reply(200, d)
            return self.reply(200, SUB_OK)
        return self.reply(404, {"detail": "not found"})

    def log_message(self, *a): pass

# Threaded on purpose: with the website route a browser sits on the
# confirmation page, and a single-threaded server makes the client's polls
# queue behind it until they time out.
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

with Server(("127.0.0.1", 8899), H) as s:
    print("cabinet stub up", flush=True); s.serve_forever()
