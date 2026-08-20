#!/usr/bin/env python3
"""GitHub Signup Farm — TERMUX EDITION (pure stdlib, NO pip packages needed).
Uses HTTP requests only (urllib) + IMAP OTP (imaplib).
Runs on mobile 4G/5G IP = clean residential → bypasses DataDome.
"""
import os, sys, json, time, random, string, re, ssl, urllib.request, urllib.parse
import http.cookiejar
import imaplib, email
from email.header import decode_header

# ── CONFIG ──────────────────────────────────────────────
IMAP_HOST = "imap.gmail.com"
IMAP_USER = os.environ.get("IMAP_USER", "YOUR_GMAIL@gmail.com")
IMAP_PASS = os.environ.get("IMAP_APP_PASS", "YOUR_APP_PASSWORD")
GH_PASSWORD = os.environ.get("GH_PASSWORD", "YOUR_GH_PASSWORD!")
DELAY_MIN = int(os.environ.get("DELAY_MIN", "15"))
LOG_FILE = os.path.expanduser("~/github_farm_log.txt")

UA = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"

# ── LOG ────────────────────────────────────────────────
def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except: pass

# ── HTTP Session (urllib + cookie jar) ─────────────────
class HTTPSession:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.HTTPRedirectHandler(),
        )
        self.opener.addheaders = [
            ("User-Agent", UA),
            ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
            ("Accept-Language", "en-US,en;q=0.9"),
        ]
    def get(self, url, headers=None):
        req = urllib.request.Request(url)
        if headers:
            for k, v in headers.items():
                req.add_header(k, v)
        resp = self.opener.open(req, timeout=30)
        return resp.getcode(), resp.read().decode("utf-8", errors="ignore"), resp.headers
    def post(self, url, data, headers=None, referer=None):
        body = urllib.parse.urlencode(data).encode()
        req = urllib.request.Request(url, data=body)
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        if referer:
            req.add_header("Referer", referer)
        if headers:
            for k, v in headers.items():
                req.add_header(k, v)
        resp = self.opener.open(req, timeout=30)
        return resp.getcode(), resp.read().decode("utf-8", errors="ignore"), resp.headers

# ── GitHub Signup Flow ─────────────────────────────────
def github_signup(session, email):
    """Attempt GitHub signup via HTTP only. Returns (ok, stage, info)."""
    try:
        # 1. GET signup page → collect authenticity token + cookies
        code, html, headers = session.get("https://github.com/signup")
        if code != 200:
            return False, "signup_page", f"HTTP {code}"
        
        # DataDome check
        if "datadome" in html.lower() or "captcha-delivery" in html.lower():
            return False, "datadome", "blocked by DataDome"
        
        # Extract authenticity_token
        m = re.search(r'name="authenticity_token"\s+value="([^"]+)"', html)
        token = m.group(1) if m else None
        if not token:
            return False, "token", "no authenticity_token found"
        
        # 2. POST email step
        code, html2, _ = session.post(
            "https://github.com/signup",
            data={
                "authenticity_token": token,
                "user[email]": email,
                "user[email_confirmation]": email,
            },
            referer="https://github.com/signup",
        )
        if code not in (200, 302):
            return False, "email_post", f"HTTP {code}"
        
        # 3. POST username+password step (may need new token from html2)
        m2 = re.search(r'name="authenticity_token"\s+value="([^"]+)"', html2)
        token2 = m2.group(1) if m2 else token
        
        # Generate username
        username = f"devq{random.randint(10**5, 10**6-1)}"
        
        code, html3, _ = session.post(
            "https://github.com/signup",
            data={
                "authenticity_token": token2,
                "user[login]": username,
                "user[password]": GH_PASSWORD,
                "user[email]": email,
                "user[email_confirmation]": email,
            },
            referer="https://github.com/signup",
        )
        
        if code not in (200, 302):
            return False, "user_post", f"HTTP {code}"
        
        # 4. Check result — success pages contain "Verify your email" or redirect to check
        if "verify" in html3.lower() or "check your email" in html3.lower() or code == 302:
            return True, "created", username
        if "error" in html3.lower() and "already" in html3.lower():
            return False, "email_taken", "email already registered"
        return True, "created", username
    except urllib.error.HTTPError as e:
        return False, "httperror", f"HTTP {e.code}"
    except Exception as e:
        return False, "exception", str(e)[:120]

# ── IMAP OTP Fetcher ───────────────────────────────────
def fetch_otp(target_email, wait=90, interval=8):
    base = target_email.split("@")[0].replace(".", "").split("+")[0]
    deadline = time.time() + wait
    while time.time() < deadline:
        try:
            M = imaplib.IMAP4_SSL(IMAP_HOST)
            M.login(IMAP_USER, IMAP_PASS)
            M.select("INBOX")
            typ, data = M.search(None, '(FROM "noreply@github.com")')
            if typ == "OK":
                ids = data[0].split()
                for id_ in ids[-10:]:
                    typ2, msg_data = M.fetch(id_, "(RFC822)")
                    if typ2 != "OK": continue
                    msg = email.message_from_bytes(msg_data[0][1])
                    subj = ""
                    for part, enc in decode_header(msg["Subject"] or ""):
                        if isinstance(part, bytes):
                            subj += part.decode(enc or "utf-8", errors="ignore")
                        else:
                            subj += part
                    if "verification" in subj.lower():
                        body = ""
                        if msg.is_multipart():
                            for part in msg.walk():
                                if part.get_content_type() == "text/plain":
                                    body += part.get_payload(decode=True).decode("utf-8", errors="ignore")
                        else:
                            body = msg.get_payload(decode=True).decode("utf-8", errors="ignore")
                        codes = re.findall(r"\b\d{8}\b", body)
                        if codes:
                            M.logout()
                            return codes[0]
            M.logout()
        except Exception as e:
            log(f"  IMAP: {e}")
        time.sleep(interval)
    return None

# ── Main ───────────────────────────────────────────────
def main():
    emails_file = os.path.expanduser("~/emails.txt")
    if not os.path.exists(emails_file):
        log("❌ emails.txt not found! Download: curl -O https://github.com/sitimas9/scriptbox")
        return
    
    with open(emails_file) as f:
        emails = [l.strip() for l in f if l.strip()]
    
    log(f"=== GitHub Farm HTTP (Termux) — {len(emails)} emails ===")
    log(f"User: {IMAP_USER} | Password: {'SET' if IMAP_PASS != 'MASUKKAN_APP_PASSWORD_DISINI' else 'NOT SET!'}")
    
    if IMAP_PASS == "MASUKKAN_APP_PASSWORD_DISINI":
        log("⚠️  Edit file ini: ganti IMAP_PASS di bagian CONFIG dengan App Password Gmail 16 digit!")
        return
    
    results = {"ok": 0, "fail": 0, "datadome": 0}
    
    for i, email in enumerate(emails):
        log(f"\n[{i+1}/{len(emails)}] {email}")
        session = HTTPSession()
        ok, stage, info = github_signup(session, email)
        
        if ok:
            log(f"  ✅ Signup created ({info}) — checking OTP...")
            otp = fetch_otp(email)
            if otp:
                log(f"  ✅ OTP received: {otp}")
            else:
                log(f"  ⚠️ OTP not yet — email may need manual verify")
            results["ok"] += 1
        else:
            if stage == "datadome":
                log(f"  ❌ DataDome blocked")
                results["datadome"] += 1
            else:
                log(f"  ❌ Failed ({stage}): {info}")
                results["fail"] += 1
        
        # Progress save
        try:
            with open(os.path.expanduser("~/github_farm_results.json"), "w") as f:
                json.dump({"results": results, "last_email": email, "stage": stage}, f, indent=2)
        except: pass
        
        if i < len(emails) - 1:
            log(f"  ⏳ waiting {DELAY_MIN}s...")
            time.sleep(DELAY_MIN)
    
    log(f"\n=== DONE: {results['ok']} ok, {results['fail']} fail, {results['datadome']} datadome ===")

if __name__ == "__main__":
    main()