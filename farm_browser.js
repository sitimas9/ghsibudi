#!/usr/bin/env node
/**
 * GitHub Farm → CodeBuddy Token — Browser Edition (Termux)
 * Uses puppeteer-core + system Chromium (real browser = real TLS = bypass DataDome)
 *
 * Flow:
 * 1. Launch Chromium (headless)
 * 2. Open github.com/signup → fill email → fill password+username → submit
 * 3. Fetch OTP from Gmail via Python subprocess (imaplib)
 * 4. Submit OTP → GitHub account created
 * 5. CodeBuddy OAuth via Keycloak GitHub broker → JWT token
 * 6. Send token to collector
 */

const puppeteer = require('puppeteer-core');
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');

// ═══ CONFIG (from .env) ═══
const GITHUB_EMAIL    = process.env.GITHUB_EMAIL    || 'YOUR_GITHUB_EMAIL@gmail.com';
const GITHUB_PASSWORD = process.env.GITHUB_PASSWORD || 'YOUR_PASSWORD';
const IMAP_USER       = process.env.IMAP_USER       || 'YOUR_GMAIL@gmail.com';
const IMAP_PASS       = process.env.IMAP_APP_PASS   || 'YOUR_APP_PASS';
const COLLECTOR_URL   = process.env.COLLECTOR_URL   || 'http://43.153.194.107:8899/token';
const DELAY           = parseInt(process.env.DELAY || '20');
const CHROMIUM_PATH   = '/data/data/com.termux/files/usr/bin/chromium-browser';
const ROUNDS          = parseInt(process.env.ROUNDS || '5');

function log(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync('/data/data/com.termux/files/home/farm_log.txt', line + '\n');
}

// ═══ IMAP OTP FETCH (Python subprocess) ═══
function fetchOTP(waitSec = 120) {
  const pyScript = `
import imaplib, email, re, time, sys
from email.header import decode_header
M = imaplib.IMAP4_SSL("imap.gmail.com")
M.login("${IMAP_USER}", "${IMAP_PASS}")
deadline = time.time() + ${waitSec}
while time.time() < deadline:
    M.select("INBOX")
    typ, data = M.search(None, '(FROM "noreply@github.com")')
    for id_ in data[0].split()[-10:]:
        _, md = M.fetch(id_, "(RFC822)")
        msg = email.message_from_bytes(md[0][1])
        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    body += part.get_payload(decode=True).decode("utf-8", errors="ignore")
        else:
            body = msg.get_payload(decode=True).decode("utf-8", errors="ignore")
        codes = re.findall(r"\\b\\d{8}\\b", body)
        if codes:
            print(codes[0])
            M.logout()
            sys.exit(0)
    M.close()
    time.sleep(10)
M.logout()
sys.exit(1)
`;
  try {
    const result = execFileSync('python3', ['-c', pyScript], {
      timeout: waitSec * 1000 + 10000,
      encoding: 'utf8'
    }).trim();
    return result || null;
  } catch (e) {
    return null;
  }
}

// ═══ RANDOM USERNAME ═══
function randomUser() {
  return 'devq' + Math.floor(Math.random() * 900000 + 100000);
}

// ═══ GITHUB SIGNUP (browser) ═══
async function githubSignup(page, email) {
  log('Step 1: Open github.com/signup...');
  await page.goto('https://github.com/signup', { waitUntil: 'networkidle2', timeout: 60000 });

  // Check if DataDome blocked
  const bodyText = await page.evaluate(() => document.body.innerText);
  if (bodyText.includes('DataDome') || bodyText.includes('captcha-delivery')) {
    return { ok: false, err: 'DataDome blocked' };
  }

  // Debug: what page did we actually get?
  const pageUrl = page.url();
  const pageTitle = await page.title();
  const bodySnippet = await page.evaluate(() => document.body.innerText.substring(0, 300));
  log(`  URL: ${pageUrl}`);
  log(`  Title: ${pageTitle}`);
  log(`  Body: ${bodySnippet.replace(/\n/g, ' | ').substring(0, 200)}`);

  // Debug: dump all input fields on page
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input, select, textarea')).map(el => ({
      tag: el.tagName,
      type: el.type,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    }));
  });
  log('  Fields: ' + JSON.stringify(inputs).substring(0, 500));

  // If no fields, wait for JS render and retry once
  if (inputs.length === 0) {
    log('  No fields found — waiting 8s for JS render...');
    await page.waitForTimeout(8000);
    const retry = await page.evaluate(() => document.querySelectorAll('input').length);
    log(`  After wait: ${retry} input fields`);
    if (retry === 0) {
      return { ok: false, err: `Page has no inputs. URL=${pageUrl} Title=${pageTitle}` };
    }
  }

  await page.screenshot({ path: '/data/data/com.termux/files/home/signup_debug.png' });

  // Try multiple selectors for email
  const emailSelector = 'input[name="user[email]"], input[type="email"], #email, input[name="email"], input[autocomplete="email"]';
  log('  Filling email...');
  await page.waitForSelector(emailSelector, { timeout: 15000 });
  await page.type(emailSelector, email, { delay: 50 });
  await page.waitForTimeout(1500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);

  // Fill password
  log('  Filling password...');
  await page.waitForSelector('input[name="user[password]"], input[type="password"]', { timeout: 15000 });
  await page.type('input[name="user[password]"], input[type="password"]', GITHUB_PASSWORD, { delay: 50 });
  await page.waitForTimeout(1500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);

  // Fill username
  log('  Filling username...');
  await page.waitForSelector('input[name="user[login]"]', { timeout: 15000 });
  const username = randomUser();
  await page.type('input[name="user[login]"]', username, { delay: 50 });
  await page.waitForTimeout(1500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);

  // Skip email preferences (if asked)
  const notNow = await page.$('text/Don\'t use a free email') ;
  // may ask about email preferences — click "skip"
  try {
    const skipBtn = await page.$('button:has-text("Skip")') || await page.$('text/Skip');
    if (skipBtn) { await skipBtn.click(); await page.waitForTimeout(2000); }
  } catch (e) {}

  // Puzzle/captcha — wait for verify page
  log('  Waiting for verify page...');
  await page.waitForTimeout(5000);

  return { ok: true, username };
}

// ═══ VERIFY OTP ═══
async function verifyOTP(page) {
  log('Step 2: Fetching OTP from Gmail...');
  const otp = fetchOTP(120);
  if (!otp) {
    return { ok: false, err: 'OTP not received' };
  }
  log(`  OTP: ${otp}`);

  log('Step 3: Submitting OTP...');
  // Look for OTP input field
  const otpInput = await page.$('input[type="text"]') || await page.$('input[name="otp"]') || await page.$('#otp');
  if (otpInput) {
    await otpInput.type(otp, { delay: 100 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);
    return { ok: true };
  }
  return { ok: false, err: 'OTP input field not found' };
}

// ═══ CODEBUDDY OAUTH ═══
async function codebuddyOAuth(page, username) {
  log('Step 4: CodeBuddy OAuth...');

  // Start auth state
  const stateResp = await page.evaluate(async () => {
    const r = await fetch('https://www.codebuddy.ai/v2/plugin/auth/state?platform=CLI', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    return r.json();
  });

  const state = stateResp.state;
  const authUrl = stateResp.authUrl;
  if (!state || !authUrl) {
    return { ok: false, err: 'No state/authUrl' };
  }
  log(`  State: ${state.substring(0, 20)}...`);

  // Navigate to auth URL → GitHub OAuth → auto authorize (already logged in)
  log('  Following OAuth URL...');
  await page.goto(authUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForTimeout(5000);

  // If "Authorize" button appears, click it
  try {
    const authBtn = await page.$('button:has-text("Authorize")') || await page.$('input[name="authorize"]');
    if (authBtn) {
      await authBtn.click();
      await page.waitForTimeout(5000);
    }
  } catch (e) {}

  // Poll for token
  log('  Polling for token...');
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(5000);
    const tokenResp = await page.evaluate(async (s) => {
      const r = await fetch(`https://www.codebuddy.ai/v2/plugin/auth/token?state=${s}&platform=CLI`);
      return r.json();
    }, state);

    if (tokenResp.accessToken) {
      log(`  ✅ Token received! (${tokenResp.accessToken.length} chars)`);
      return { ok: true, token: tokenResp };
    }
  }
  return { ok: false, err: 'Token poll timeout' };
}

// ═══ SEND TO COLLECTOR ═══
async function sendToCollector(tokenData) {
  try {
    const resp = await fetch(COLLECTOR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokenData)
    });
    return resp.ok;
  } catch (e) {
    log(`  ⚠️ Collector error: ${e.message}`);
    return false;
  }
}

// ═══ MAIN ═══
async function main() {
  log('═══════════════════════════════════════');
  log('GitHub Farm → CodeBuddy (Browser Edition)');
  log(`Email: ${GITHUB_EMAIL}`);
  log(`Rounds: ${ROUNDS}`);
  log('═══════════════════════════════════════');

  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
    ]
  });

  const results = { ok: 0, fail: 0, tokens: [] };

  for (let round = 1; round <= ROUNDS; round++) {
    log(`\n${'═'.repeat(40)}\nRound ${round}/${ROUNDS}\n${'═'.repeat(40)}`);

    // Dot-trick email
    const email = GITHUB_EMAIL.replace('@', `+gh${String(round).padStart(2,'0')}@`);
    log(`Email: ${email}`);

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36');

    // Step 1: Signup
    const signup = await githubSignup(page, email);
    if (!signup.ok) {
      log(`  ❌ Signup failed: ${signup.err}`);
      results.fail++;
      await page.close();
      if (signup.err.includes('DataDome')) {
        log('  ⏳ Waiting 60s...');
        await new Promise(r => setTimeout(r, 60000));
      }
      continue;
    }
    log(`  ✅ Signup OK — username: ${signup.username}`);

    // Step 2+3: OTP
    const otp = await verifyOTP(page);
    if (!otp.ok) {
      log(`  ❌ OTP failed: ${otp.err}`);
      results.fail++;
      await page.close();
      continue;
    }
    log('  ✅ Email verified');

    // Step 4: CodeBuddy OAuth
    const oauth = await codebuddyOAuth(page, signup.username);
    if (oauth.ok) {
      log('  ✅ OAuth success!');
      results.tokens.push({ github: signup.username, token: oauth.token.accessToken });
      results.ok++;

      // Step 5: Send to collector
      log('Step 5: Sending to collector...');
      const sent = await sendToCollector(oauth.token);
      log(sent ? '  ✅ Sent!' : '  ⚠️ Collector offline — saved locally');
    } else {
      log(`  ❌ OAuth failed: ${oauth.err}`);
      results.fail++;
    }

    // Save progress
    fs.writeFileSync('/data/data/com.termux/files/home/farm_results.json', JSON.stringify(results, null, 2));

    await page.close();

    if (round < ROUNDS) {
      log(`\n⏳ Waiting ${DELAY}s...`);
      await new Promise(r => setTimeout(r, DELAY * 1000));
    }
  }

  await browser.close();
  log(`\n${'═'.repeat(50)}`);
  log(`COMPLETE: ${results.ok} tokens, ${results.fail} fail`);
  log(`Tokens saved: ~/farm_results.json`);
  log(`${'═'.repeat(50)}`);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });