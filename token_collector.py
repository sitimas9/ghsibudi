#!/usr/bin/env python3
"""VPS Token Collector — terima token dari ghbudi-termux di HP."""
import json, os, sqlite3, time
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timezone

PORT = 8899
DB = os.path.expanduser("~/.9router/db/data.sqlite")

class Collector(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {fmt % args}")

    def do_POST(self):
        if self.path != "/token":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        data = json.loads(body)
        
        token = data.get("token", "")
        email = data.get("email", "?")
        gh_user = data.get("github_user", "?")
        
        # Simpan ke file
        log_file = os.path.expanduser("~/cb_tokens.txt")
        with open(log_file, "a") as f:
            f.write(f"{datetime.now().isoformat()} | {email} | {gh_user} | {token[:60]}...\n")
        
        # Inject ke 9router DB kalau ada
        injected = False
        if os.path.exists(DB):
            try:
                conn = sqlite3.connect(DB)
                cur = conn.cursor()
                # Cek duplikat
                cur.execute("SELECT id FROM providerConnections WHERE provider='openai-compatible-chat-08c66fbb68a244308eaba847e51874d7' AND json_extract(data, '$.accessToken')=?", (token,))
                if cur.fetchone():
                    self.log_message(f"⚠️ Duplikat: {gh_user}")
                else:
                    cur.execute("SELECT MAX(CAST(name AS INTEGER)) FROM providerConnections WHERE provider='openai-compatible-chat-08c66fbb68a244308eaba847e51874d7'")
                    max_idx = cur.fetchone()[0] or 0
                    new_idx = int(max_idx) + 1
                    uid = str(time.time_ns())
                    now = datetime.now(timezone.utc).isoformat()
                    data_json = json.dumps({
                        "accessToken": token,
                        "refreshToken": "",
                        "testStatus": "active",
                        "consecutiveUseCount": 0,
                        "user": {"email": email}
                    })
                    cur.execute("""INSERT INTO providerConnections
                        (id, provider, name, data, createdAt, updatedAt, active)
                        VALUES (?, ?, ?, ?, ?, ?, 1)""",
                        (uid, "openai-compatible-chat-08c66fbb68a244308eaba847e51874d7",
                         f"{new_idx}", data_json, now, now))
                    conn.commit()
                    self.log_message(f"✅ Injected {gh_user} → 9router idx={new_idx}")
                    injected = True
                conn.close()
            except Exception as e:
                self.log_message(f"❌ DB error: {e}")
        
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({
            "status": "ok",
            "injected": injected,
            "user": gh_user,
            "email": email
        }).encode())

    def do_GET(self):
        if self.path == "/status":
            count = 0
            if os.path.exists(os.path.expanduser("~/cb_tokens.txt")):
                with open(os.path.expanduser("~/cb_tokens.txt")) as f:
                    count = sum(1 for _ in f)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"tokens": count, "uptime": time.time()}).encode())
        else:
            self.send_error(404)

print(f"🚀 Collector running on :{PORT}")
print(f"   POST /token  — terima token dari Termux")
print(f"   GET  /status — cek jumlah token")
print(f"   DB: {DB}")
print(f"   Log: ~/cb_tokens.txt")
HTTPServer(("0.0.0.0", PORT), Collector).serve_forever()