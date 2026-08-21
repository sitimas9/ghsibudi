#!/usr/bin/env node
/**
 * GitHub Farm → CodeBuddy Token — Browser Edition v2 (Termux)
 * puppeteer-core + system Chromium
 */
const puppeteer = require('puppeteer-core');
const { execFileSync } = require('child_process');
const fs = require('fs');

// ═══ CONFIG ═══
const GITHUB_EMAIL    = process.env.GITHUB_EMAIL    || 'YOUR_GMAIL@gmail.com';
const GITHUB_PASSWORD = process.env.GITHUB_PASSWORD || 'YOUR_PASSWORD';
const IMAP_USER       = process.env.IMAP_USER       || 'YOUR_GMAIL@gmail.com';
const IMAP_PASS       = process.env.IMAP_APP_PASS   || 'YOUR_APP_PASS';
const COLLECTOR_URL   = process.env.COLLECTOR_URL   || 'http://43.153.194.107:8899/token';
const DELAY           = parseInt(process.env.DELAY || '20');
const CHROMIUM_PATH   = process.env.CHROMIUM_PATH   || '/data/data/com.termux/files/usr/bin/chromium-browser';
const ROUNDS          = parseInt(process.env.ROUNDS || '5');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync('/data/data/com.termux/files/home/farm_log.txt', line + '\n');
}

function fetchOTP(waitSec = 120) {
  const pyScript = `
import imaplib, email, re, time, sys
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
            print(codes[0]); M.logout(); sys.exit(0)
    time.sleep(10)
M.logout(); sys.exit(1)
`;
  try {
    return execFileSync('python3', ['-c', pyScript], { timeout: waitSec*1000+10000, encoding: 'utf8' }).trim() || null;
  } catch (e) { return null; }
}

const randomUser = () => 'devq' + Math.floor(Math.random()*900000+100000);

async function diagnose(page, label) {
  const url = page.url();
  const title = await page.title();
  const info = await page.evaluate(() => ({
    htmlLen: document.documentElement.outerHTML.length,
    bodyText: document.body ? document.body.innerText.substring(0,150) : '(no body)',
    inputs: document.querySelectorAll('input').length,
    frames: document.querySelectorAll('iframe').length,
  }));
  log(`  [${label}] URL=${url}`);
  log(`  [${label}] Title="${title}" html=${info.htmlLen}ch inputs=${info.inputs} iframes=${info.frames}`);
  log(`  [${label}] Body="${info.bodyText.replace(/\n/g,' | ').substring(0,120)}"`);
  return info;
}

async function solveDataDome(page) {
  // Detect DataDome challenge iframe
  const ddUrl = await page.evaluate(() => {
    const f = document.querySelector('iframe');
    return f ? f.src : '';
  });
  if (!ddUrl || (!ddUrl.includes('captcha-delivery') && !ddUrl.includes('datadome'))) {
    log(`  No DataDome iframe (${ddUrl.substring(0,60)})`);
    return false;
  }
  log('  🛡️ DataDome challenge detected — solving slider...');

  const ddFrame = page.frames().find(f => f.url().includes('captcha-delivery') || f.url().includes('datadome'));
  if (!ddFrame) { log('  Frame not accessible'); return false; }

  await sleep(3000);

  // Debug: dump all clickable elements inside the frame
  const frameDebug = await ddFrame.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, [role="button"], input, div[id], span[id]'));
    return els.slice(0, 20).map(el => ({
      tag: el.tagName, id: el.id, cls: (el.className||'').toString().substring(0,50),
      text: (el.innerText||'').substring(0,30)
    }));
  }).catch(e => 'frame eval error: '+e.message);
  log(`  Frame elements: ${JSON.stringify(frameDebug).substring(0, 400)}`);

  // Find the slider button
  const sliderHandle = await ddFrame.$('#slider-captcha-button, [id*="slider"], [class*="slider"] button, button[aria-label*="drag"], button, [role="button"]');
  if (!sliderHandle) {
    log('  Slider element not found in frame');
    await page.screenshot({ path: '/data/data/com.termux/files/home/datadome_debug.png' });
    return false;
  }
  const box = await sliderHandle.boundingBox();
  if (!box) { log('  Slider no bounding box'); return false; }

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await sleep(500);
  await page.mouse.down();
  await sleep(300);

  // Human-like drag with slight jitter
  const distance = 260;
  const steps = 30;
  for (let i = 1; i <= steps; i++) {
    const x = startX + (distance * i / steps);
    const y = startY + Math.sin(i / 4) * 4;
    await page.mouse.move(x, y);
    await sleep(15 + Math.floor(Math.random() * 35));
  }
  await sleep(400);
  await page.mouse.up();
  log('  Slider dragged — waiting for verification...');
  await sleep(8000);

  // Check result
  const after = await page.evaluate(() => ({
    inputs: document.querySelectorAll('input').length,
    htmlLen: document.documentElement.outerHTML.length,
    stillChallenge: !!document.querySelector('iframe[src*="captcha-delivery"]')
  }));
  log(`  After solve: inputs=${after.inputs} challenge=${after.stillChallenge}`);
  return !after.stillChallenge && after.inputs > 0;
}

async function githubSignup(page, email) {
  log('Step 1: Session warming — open homepage first...');
  await page.goto('https://github.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(6000);
  const warm = await diagnose(page, 'warm');

  // If homepage also blank, reload once
  if (warm.htmlLen < 2000) {
    log('  Homepage blank — reloading...');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(8000);
    await diagnose(page, 'warm-reload');
  }

  log('Step 1b: Navigate to /signup in same session...');
  await page.goto('https://github.com/signup', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);
  let d1 = await diagnose(page, 'load1');

  // DataDome challenge → try slider solve (up to 3 attempts)
  if (d1.inputs === 0) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      log(`  DataDome solve attempt ${attempt}/3...`);
      const solved = await solveDataDome(page);
      if (solved) { d1 = await diagnose(page, 'after-solve'); break; }
      await sleep(5000);
    }
  }

  // If blank, try reload once
  if (d1.inputs === 0 && d1.htmlLen < 2000) {
    log('  Page blank — reloading...');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(8000);
    await diagnose(page, 'reload');
  }

  // Wait for email input up to 30s
  log('  Waiting for email field...');
  let emailSel;
  try {
    await page.waitForFunction(() => {
      const el = document.querySelector('input[type="email"], input[name="user[email]"], #email, input[name="email"]');
      return el && !!(el.offsetWidth || el.offsetHeight);
    }, { timeout: 30000 });
    emailSel = await page.evaluate(() => {
      const el = document.querySelector('input[type="email"], input[name="user[email]"], #email, input[name="email"]');
      return el.name ? `input[name="${el.name}"]` : (el.id ? '#'+el.id : 'input[type="email"]');
    });
  } catch (e) {
    await page.screenshot({ path: '/data/data/com.termux/files/home/signup_debug.png' });
    const html = await page.evaluate(() => document.documentElement.outerHTML.substring(0, 1000));
    fs.writeFileSync('/data/data/com.termux/files/home/signup_debug.html', html);
    return { ok: false, err: 'email field never appeared (screenshot+html saved)' };
  }

  log(`  Filling email via ${emailSel}...`);
  await page.click(emailSel);
  await page.type(emailSel, email, { delay: 60 });
  await sleep(1000);
  await page.keyboard.press('Enter');
  await sleep(4000);

  // Password
  log('  Filling password...');
  await page.waitForFunction(() => {
    const el = document.querySelector('input[type="password"]');
    return el && !!(el.offsetWidth || el.offsetHeight);
  }, { timeout: 20000 });
  const passSel = await page.evaluate(() => {
    const el = document.querySelector('input[type="password"]');
    return el.name ? `input[name="${el.name}"]` : 'input[type="password"]';
  });
  await page.click(passSel);
  await page.type(passSel, GITHUB_PASSWORD, { delay: 60 });
  await sleep(1000);
  await page.keyboard.press('Enter');
  await sleep(4000);

  // Username
  log('  Filling username...');
  await page.waitForFunction(() => {
    const el = document.querySelector('input[name="user[login]"], input[name="login"]:not([type="password"])');
    return el && !!(el.offsetWidth || el.offsetHeight);
  }, { timeout: 20000 }).catch(() => {});
  const userSel = await page.evaluate(() => {
    const el = document.querySelector('input[name="user[login]"]');
    return el ? 'input[name="user[login]"]' : null;
  });
  const username = randomUser();
  if (userSel) {
    await page.click(userSel);
    await page.type(userSel, username, { delay: 60 });
    await sleep(1000);
    await page.keyboard.press('Enter');
    await sleep(4000);
  } else {
    log('  ⚠️ username field not found — continuing anyway');
  }

  await page.screenshot({ path: '/data/data/com.termux/files/home/signup_step1.png' });
  return { ok: true, username };
}

async function verifyOTP(page) {
  log('Step 2: Fetching OTP from Gmail...');
  const otp = fetchOTP(120);
  if (!otp) return { ok: false, err: 'OTP not received' };
  log(`  OTP: ${otp}`);

  // Look for OTP inputs (GitHub uses one input or several single-digit boxes)
  const filled = await page.evaluate((code) => {
    const inp = document.querySelector('input[name="otp"], input[autocomplete="one-time-code"], input[inputmode="numeric"]');
    if (inp) { inp.value = code; inp.dispatchEvent(new Event('input', {bubbles:true})); return true; }
    return false;
  }, otp);

  if (!filled) {
    // fallback: type into focused element
    log('  No otp input found — typing raw...');
    await page.keyboard.type(otp, { delay: 120 });
  }
  await sleep(2000);
  await page.keyboard.press('Enter');
  await sleep(5000);
  return { ok: true };
}

async function codebuddyOAuth(page) {
  log('Step 4: CodeBuddy OAuth...');
  const stateResp = await page.evaluate(async () => {
    const r = await fetch('https://www.codebuddy.ai/v2/plugin/auth/state?platform=CLI', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    return r.json();
  });
  const state = stateResp.state;
  const authUrl = stateResp.authUrl;
  if (!state || !authUrl) return { ok: false, err: 'no state/authUrl: '+JSON.stringify(stateResp).substring(0,100) };

  log('  Following OAuth URL...');
  await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(6000);

  // Click Authorize if present
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('button[value="Authorize"], input[name="authorize"], button[name="authorize"]');
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (clicked) { log('  Clicked Authorize'); await sleep(6000); }

  log('  Polling token...');
  for (let i = 0; i < 15; i++) {
    await sleep(5000);
    const tok = await page.evaluate(async (s) => {
      const r = await fetch(`https://www.codebuddy.ai/v2/plugin/auth/token?state=${s}&platform=CLI`);
      return r.json();
    }, state);
    if (tok.accessToken) {
      log(`  ✅ Token received (${tok.accessToken.length} chars)`);
      return { ok: true, token: tok };
    }
  }
  return { ok: false, err: 'token poll timeout' };
}

async function sendToCollector(tokenData) {
  try {
    const resp = await fetch(COLLECTOR_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokenData)
    });
    return resp.ok;
  } catch (e) { log(`  ⚠️ collector: ${e.message}`); return false; }
}

async function main() {
  log('═══════════════════════════════════════');
  log('GitHub Farm → CodeBuddy (Browser v2)');
  log(`Email: ${GITHUB_EMAIL} | Rounds: ${ROUNDS}`);
  log('═══════════════════════════════════════');

  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
  });

  const results = { ok: 0, fail: 0, tokens: [] };

  for (let round = 1; round <= ROUNDS; round++) {
    log(`\n${'═'.repeat(40)}\nRound ${round}/${ROUNDS}\n${'═'.repeat(40)}`);
    const email = GITHUB_EMAIL.replace('@', `+gh${String(round).padStart(2,'0')}@`);
    log(`Email: ${email}`);

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36');
    await page.setViewport({ width: 412, height: 915, isMobile: true });

    const signup = await githubSignup(page, email);
    if (!signup.ok) {
      log(`  ❌ ${signup.err}`); results.fail++;
      await page.close(); continue;
    }
    log(`  ✅ Signup OK — ${signup.username}`);

    const otp = await verifyOTP(page);
    if (!otp.ok) { log(`  ❌ ${otp.err}`); results.fail++; await page.close(); continue; }
    log('  ✅ Verified');

    const oauth = await codebuddyOAuth(page);
    if (oauth.ok) {
      results.tokens.push({ github: signup.username, access_token: oauth.token.accessToken, refresh_token: oauth.token.refreshToken });
      results.ok++;
      const sent = await sendToCollector(oauth.token);
      log(sent ? '  ✅ Sent to collector' : '  ⚠️ collector offline — saved locally');
    } else {
      log(`  ❌ OAuth: ${oauth.err}`); results.fail++;
    }

    fs.writeFileSync('/data/data/com.termux/files/home/farm_results.json', JSON.stringify(results, null, 2));
    await page.close();

    if (round < ROUNDS) { log(`⏳ ${DELAY}s...`); await sleep(DELAY*1000); }
  }

  await browser.close();
  log(`\nDONE: ${results.ok} tokens, ${results.fail} fail → ~/farm_results.json`);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });