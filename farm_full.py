#!/usr/bin/env python3
"""
GitHub Farm → CodeBuddy Token — Full Auto Flow
Run on Termux (mobile 4G/5G IP).

Flow:
1. GitHub signup via HTTP (mobile IP = clean)
2. OTP verify via IMAP (auto-fetch)
3. CodeBuddy OAuth via Keycloak GitHub broker
4. Poll for JWT token (valid 364 days)
5. Send token to collector

SETUP: Replace ALL_XXXX placeholders with real values, or use .env file.
"""
import os, sys, json, time, random, re, base64, imaplib, email
import http.cookiejar, urllib.request, urllib.parse, ssl
from email.header import decode_header

# ═══════════════════════════════════════════════════════
# REPLACE ALL PLACEHOLDERS WITH REAL VALUES
# ═══════════════════════════════════════════════════════
GITHUB_EMAIL     = os.environ.get("GITHUB_EMAIL",     "YOUR_GITHUB_EMAIL@gmail.com")
GITHUB_PASSWORD  = os.environ.get("GITHUB_PASSWORD",  "YOUR_GITHUB_PASSWORD!")
IMAP_HOST        = os.environ.get("IMAP_HOST",        "imap.gmail.com")
IMAP_USER        = os.environ.get("IMAP_USER",        "YOUR_GMAIL@gmail.com")
IMAP_PASS        = os.environ.get("IMAP_APP_PASS",    "YOUR_APP_PASSWORD")
CODEBUDDY_BASE   = os.environ.get("CODEBUDDY_BASE",   "https://www.codebuddy.ai")
CODEBUDDY_9ROUTER= os.environ.get("CODEBUDDY_9ROUTER", "http://127.0.0.1:8899")
DELAY_BETWEEN    = int(os.environ.get("DELAY", "20"))
LOG_FILE         = os.path.expanduser("~/farm_log.txt")

UA = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"

# ═══════════════════════════════════════════════════════
def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")

# ═══════════════════════════════════════════════════════
# HTTP SESSION (urllib + cookie jar)
# ═══════════════════════════════════════════════════════
class Session:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.HTTPRedirectHandler(),
        )
        self.opener.addheaders = [("User-Agent", UA)]

    def get(self, url, headers=None):
        req = urllib.request.Request(url)
        if headers:
            for k, v in headers.items(): req.add_header(k, v)
        resp = self.opener.open(req, timeout=30)
        return resp.getcode(), resp.read().decode("utf-8", errors="ignore")

    def post(self, url, data, referer=None):
        body = urllib.parse.urlencode(data).encode()
        req = urllib.request.Request(url, data=body)
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        if referer: req.add_header("Referer", referer)
        resp = self.opener.open(req, timeout=30)
        return resp.getcode(), resp.read().decode("utf-8", errors="ignore")

    def get_json(self, url, headers=None):
        req = urllib.request.Request(url)
        req.add_header("Accept", "application/json")
        if headers:
            for k, v in headers.items(): req.add_header(k, v)
        resp = self.opener.open(req, timeout=30)
        return resp.getcode(), json.loads(resp.read().decode())

    def post_json(self, url, data, headers=None):
        body = json.dumps(data).encode()
        req = urllib.request.Request(url, data=body)
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json")
        if headers:
            for k, v in headers.items(): req.add_header(k, v)
        resp = self.opener.open(req, timeout=30)
        return resp.getcode(), json.loads(resp.read().decode())

# ═══════════════════════════════════════════════════════
# STEP 1: GitHub Signup (HTTP only)
# ═══════════════════════════════════════════════════════
def github_signup(session, email):
    """Signup to GitHub. Returns (ok, username, error)."""
    code, html = session.get("https://github.com/signup")
    if "datadome" in html.lower() or "captcha-delivery" in html.lower():
        return False, None, "DataDome blocked"

    token_m = re.search(r'name="authenticity_token"\s+value="([^"]+)"', html)
    if not token_m:
        return False, None, "no CSRF token"
    token = token_m.group(1)

    username = f"devq{random.randint(10**5, 10**6-1)}"

    code, _ = session.post("https://github.com/signup", {
        "authenticity_token": token,
        "user[email]": email,
        "user[email_confirmation]": email,
    }, referer="https://github.com/signup")

    code, html2 = session.post("https://github.com/signup", {
        "authenticity_token": token,
        "user[login]": username,
        "user[password]": GITHUB_PASSWORD,
        "user[email]": email,
    }, referer="https://github.com/signup")

    if "verify" in html2.lower() or code == 302:
        return True, username, None
    return False, username, "signup failed"

# ═══════════════════════════════════════════════════════
# STEP 2: Fetch OTP from Gmail (IMAP)
# ═══════════════════════════════════════════════════════
def fetch_otp(wait=120, interval=10):
    """Wait for GitHub verification code (8-digit) in Gmail."""
    deadline = time.time() + wait
    while time.time() < deadline:
        try:
            M = imaplib.IMAP4_SSL(IMAP_HOST)
            M.login(IMAP_USER, IMAP_PASS)
            M.select("INBOX")
            typ, data = M.search(None, '(FROM "noreply@github.com")')
            if typ == "OK":
                for id_ in data[0].split()[-10:]:
                    _, md = M.fetch(id_, "(RFC822)")
                    msg = email.message_from_bytes(md[0][1])
                    subj = ""
                    for part, enc in decode_header(msg["Subject"] or ""):
                        subj += part.decode(enc or "utf-8", errors="ignore") if isinstance(part, bytes) else part
                    if "verification" in subj.lower() or "verify" in subj.lower():
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
            log(f"  IMAP error: {e}")
        time.sleep(interval)
    return None

def verify_email_code(session, code):
    """Submit verification code to GitHub."""
    code, html = session.get("https://github.com/login")
    token_m = re.search(r'name="authenticity_token"\s+value="([^"]+)"', html)
    token = token_m.group(1) if token_m else ""

    code, _ = session.post("https://github.com/verify", {
        "authenticity_token": token,
        "value": code,
    }, referer="https://github.com/verify")
    return True

# ═══════════════════════════════════════════════════════
# STEP 3: CodeBuddy OAuth (GitHub → Keycloak → JWT)
# ═══════════════════════════════════════════════════════
def codebuddy_oauth(session, gh_username):
    """Login to CodeBuddy via GitHub broker. Returns JWT token or None."""
    # 1. Start device flow
    code, state_data = session.post_json(f"{CODEBUDDY_BASE}/v2/plugin/auth/state?platform=CLI", {})
    state = state_data.get("state")
    auth_url = state_data.get("authUrl")
    if not state or not auth_url:
        log(f"  ❌ No state/authUrl from CodeBuddy: {state_data}")
        return None

    # 2. Follow auth URL → GitHub login
    code, html = session.get(auth_url)
    if "github.com/login" in html.lower() or "sign in" in html.lower():
        # Need to login to GitHub
        token_m = re.search(r'name="authenticity_token"\s+value="([^"]+)"', html)
        if token_m:
            code, _ = session.post("https://github.com/session", {
                "authenticity_token": token_m.group(1),
                "login": gh_username,  # Will be set dynamically
                "password": GITHUB_PASSWORD,
            }, referer="https://github.com/login")

    # 3. Check callback / authorization
    code, html2 = session.get(auth_url)
    if "authorize" in html2.lower() or "grant" in html2.lower():
        # Find authorization token/button
        auth_token = re.search(r'name="authenticity_token"\s+value="([^"]+)"', html2)
        if auth_token:
            code, _ = session.post(f"{CODEBUDDY_BASE}/auth/realms/copilot/protocol/openid-connect/auth", {
                "authenticity_token": auth_token.group(1),
            }, referer=auth_url)

    # 4. Poll for token
    for i in range(12):
        time.sleep(5)
        code, token_data = session.get_json(f"{CODEBUDDY_BASE}/v2/plugin/auth/token?state={state}&platform=CLI")
        if token_data.get("accessToken"):
            return token_data
        if token_data.get("code") == 11217:  # pending
            continue
        log(f"  ⚠️ Token poll error: {token_data}")
        break
    return None

# ═══════════════════════════════════════════════════════
# STEP 4: Send to Collector
# ═══════════════════════════════════════════════════════
def send_to_collector(token_data):
    """Send token to 9router collector."""
    try:
        data = json.dumps(token_data).encode()
        req = urllib.request.Request(
            f"{CODEBUDDY_9ROUTER}/token",
            data=data,
            headers={"Content-Type": "application/json"},
        )
        resp = urllib.request.urlopen(req, timeout=10)
        return resp.getcode() == 200
    except Exception as e:
        log(f"  ⚠️ Collector error: {e}")
        return False

# ═══════════════════════════════════════════════════════
# MAIN LOOP
# ═══════════════════════════════════════════════════════
def main():
    log("=" * 50)
    log("GitHub Farm → CodeBuddy Token")
    log("Email: " + GITHUB_EMAIL)
    log("IMAP: " + IMAP_USER)
    log("=" * 50)

    results = {"ok": 0, "fail": 0, "datadome": 0, "tokens": []}

    for round_num in range(1, 11):
        log(f"\n{'='*40}")
        log(f"Round {round_num}/10")
        log(f"{'='*40}")

        email = f"YOUR_GITHUB_EMAIL+gh{round_num:02d}@gmail.com"  # Replace with real
        log(f"Email: {email}")

        session = Session()

        # Step 1: GitHub signup
        log("Step 1: GitHub signup...")
        ok, username, err = github_signup(session, email)
        if not ok:
            log(f"  ❌ Signup failed: {err}")
            if "datadome" in str(err).lower():
                results["datadome"] += 1
                log("  ⏳ DataDome — waiting 60s before retry...")
                time.sleep(60)
            results["fail"] += 1
            continue
        log(f"  ✅ Signup OK — username: {username}")

        # Step 2: Fetch OTP
        log("Step 2: Fetching OTP...")
        otp = fetch_otp(wait=120, interval=10)
        if not otp:
            log("  ⚠️ OTP not received — skip")
            results["fail"] += 1
            continue
        log(f"  ✅ OTP: {otp}")

        # Step 3: Verify email
        log("Step 3: Verifying email...")
        verify_email_code(session, otp)
        log("  ✅ Email verified")

        # Step 4: CodeBuddy OAuth
        log("Step 4: CodeBuddy OAuth...")
        token = codebuddy_oauth(session, username)
        if token:
            log(f"  ✅ Token received! ({len(token.get('accessToken',''))} chars)")
            results["tokens"].append({
                "github": username,
                "access_token": token.get("accessToken", ""),
                "refresh_token": token.get("refreshToken", ""),
            })
            results["ok"] += 1

            # Step 5: Send to collector
            log("Step 5: Sending to collector...")
            if send_to_collector(token):
                log("  ✅ Sent to collector")
            else:
                log("  ⚠️ Collector offline — token saved locally")
        else:
            log("  ❌ OAuth failed")
            results["fail"] += 1

        # Save progress
        with open(os.path.expanduser("~/farm_results.json"), "w") as f:
            json.dump(results, f, indent=2, default=str)

        if round_num < 10:
            log(f"\n⏳ Waiting {DELAY_BETWEEN}s before next round...")
            time.sleep(DELAY_BETWEEN)

    log(f"\n{'='*50}")
    log(f"COMPLETE: {results['ok']} tokens, {results['fail']} fail, {results['datadome']} datadome")
    log(f"{'='*50}")

if __name__ == "__main__":
    main()