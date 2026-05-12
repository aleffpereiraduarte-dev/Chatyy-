// QA dual-account: login 2 accounts (host + viewer), host opens a live,
// viewer joins from the home strip. Screenshots every key step so we
// can see what's broken end-to-end.
//
// Run: node scripts/qa-live-dual.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://chatyy.com.br';
const HOST = { email: 'apitest@onemundo.com.br', pwd: 'LBfypvbERr4cm1Hd1nZe3yT', label: 'host' };
const VIEWER = { email: 'duarte@chatyy.com.br', pwd: 'Aleff2009@@', label: 'viewer' };

const OUT_DIR = '/var/www/mail/data/uploads/qa-live';
fs.mkdirSync(OUT_DIR, { recursive: true });
let stepN = 0;
const ts = () => new Date().toISOString().slice(11, 19);
function snap(page, who, label) {
  const n = String(++stepN).padStart(2, '0');
  const fname = `live-${n}-${who}-${label}.png`;
  return page.screenshot({ path: path.join(OUT_DIR, fname), fullPage: false })
    .then(() => console.log(`[${ts()}] 📸 ${fname}`));
}

async function clickIfPresent(page, selectors, label) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      try {
        await loc.click({ timeout: 2000 });
        console.log(`[${ts()}] ✓ clicked ${label} (${sel})`);
        return true;
      } catch {}
    }
  }
  return false;
}

async function login(page, who) {
  console.log(`[${ts()}] login ${who.label} ${who.email}`);
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  await snap(page, who.label, 'login-or-intro');

  // Skip onboarding intro carousel if present. "Skip" jumps straight
  // to login. Sometimes the click is missed by a frame so we retry
  // until either the phone-form ("Your number") OR the email-only
  // "Sign in with email" link appears.
  for (let attempt = 0; attempt < 6; attempt++) {
    // Phone form already showing? bail.
    if (await page.locator('text=Your number, text=Sign in with email').first().count().catch(() => 0)) break;
    await clickIfPresent(page, ['text=Skip', 'text=Pular'], `skip-intro-${attempt}`);
    await page.waitForTimeout(800);
    if (await page.locator('text=Sign in with email').first().count().catch(() => 0)) break;
    // Still on a carousel page — push Continue.
    await clickIfPresent(page, ['button:has-text("Continue")'], `intro-continue-${attempt}`);
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(800);
  await snap(page, who.label, 'phone-or-email-form');

  // Login screen now defaults to phone-first ("Your number"). Click
  // the "Sign in with email" link to flip to the email/password form.
  await clickIfPresent(page, [
    'text=Sign in with email',
    'text=Entrar com email',
    'text=Entrar com e-mail',
    'text=Sign in with e-mail',
  ], 'switch-to-email');
  await page.waitForTimeout(800);
  await snap(page, who.label, 'login-form');

  // Email/username input → CTA. New login uses a plain text input
  // labeled "Email or username" so we match by placeholder/aria too.
  const emailInput = page.locator(
    'input[type="email"], input[autocomplete="email"], input[autocomplete="username"], ' +
    'input[placeholder*="mail" i], input[placeholder*="usuário" i], input[placeholder*="username" i]'
  ).first();
  if (await emailInput.count().catch(() => 0)) {
    await emailInput.click().catch(() => {});
    await emailInput.fill(who.email);
    await page.waitForTimeout(400);
    await clickIfPresent(page, [
      'button:has-text("Next")',
      'button:has-text("Continuar")',
      'button:has-text("Continue")',
      'button:has-text("Entrar")',
      'button:has-text("Login")',
      'button:has-text("Próximo")',
      'button[type="submit"]',
    ], 'submit-email');
  } else {
    console.log(`[${ts()}] ⚠ no email input visible on ${who.label}`);
  }
  await page.waitForTimeout(1500);
  await snap(page, who.label, 'after-email');

  // Password step — Welcome screen uses placeholder "Enter your password".
  // Match by placeholder or aria-label since the SignIn input may not be
  // type="password" (custom eye-toggle component).
  const pwdInput = page.locator(
    'input[type="password"], input[placeholder*="password" i], input[placeholder*="senha" i], input[aria-label*="password" i]'
  ).first();
  if (await pwdInput.count().catch(() => 0)) {
    if (who.pwd) {
      await pwdInput.click().catch(() => {});
      await pwdInput.fill(who.pwd);
      await page.waitForTimeout(400);
      await clickIfPresent(page, [
        'button:has-text("Sign in")',
        'button:has-text("Sign In")',
        'button:has-text("Entrar")',
        'button:has-text("Login")',
        'button:has-text("Continuar")',
        'button[type="submit"]',
      ], 'submit-password');
    } else {
      console.log(`[${ts()}] ⚠ no password for ${who.label}`);
    }
  } else {
    console.log(`[${ts()}] ℹ no password input — maybe Face ID flow or already logged in`);
  }
  await page.waitForTimeout(4000);
  await snap(page, who.label, 'post-login');
}

(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium-browser',
    headless: true,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=AudioServiceOutOfProcess'],
  });

  const hostCtx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile',
    permissions: ['camera', 'microphone'],
  });
  const viewerCtx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile',
    permissions: ['camera', 'microphone'],
  });

  const hostPage = await hostCtx.newPage();
  const viewerPage = await viewerCtx.newPage();

  // Surface console errors to our log so we can spot WebRTC / WS failures.
  for (const [p, lbl] of [[hostPage, 'host'], [viewerPage, 'viewer']]) {
    p.on('console', m => { if (m.type() === 'error') console.log(`[${ts()}] [${lbl}.console] ${m.text().slice(0,200)}`); });
    p.on('pageerror', e => console.log(`[${ts()}] [${lbl}.pageerror] ${String(e).slice(0,200)}`));
  }

  try {
    await login(hostPage, HOST);
  } catch (e) {
    console.log(`[${ts()}] host login err: ${e.message}`);
  }
  await snap(hostPage, 'host', 'home-after-login');

  try {
    await login(viewerPage, VIEWER);
  } catch (e) {
    console.log(`[${ts()}] viewer login err: ${e.message}`);
  }
  await snap(viewerPage, 'viewer', 'home-after-login');

  // --- LIVE flow ---
  // Host: go to Feed → Go Live (FAB or live button) → broadcast.
  // Viewer: home → tap on live indicator on host avatar.
  console.log(`[${ts()}] starting live flow`);

  try {
    // Skip the FAB hunt — go directly to the broadcast route. This is
    // how the app navigates internally anyway (router.push('/live-broadcast'))
    // and avoids selector flakiness from the bottom-nav vs sub-tab
    // ambiguity ("Reels" appears in both).
    await hostPage.goto(`${BASE}/live-broadcast`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await hostPage.waitForTimeout(3500);
    await snap(hostPage, 'host', 'live-broadcast-screen');
    // Title prompt (Instagram-style): set title then "Iniciar live".
    const titleInput = hostPage.locator('input[placeholder*="título" i], input[placeholder*="title" i]').first();
    if (await titleInput.count().catch(() => 0)) {
      await titleInput.fill('QA dual test');
    }
    await hostPage.waitForTimeout(500);
    await snap(hostPage, 'host', 'pre-start');
    await clickIfPresent(hostPage, [
      'button:has-text("Iniciar live")',
      'button:has-text("Iniciar transmissão")',
      'button:has-text("Iniciar")',
      'button:has-text("Start broadcast")',
      'button:has-text("Start live")',
      'button:has-text("Start")',
      'button:has-text("Go Live")',
    ], 'host-start-live');
    await hostPage.waitForTimeout(6000);
    await snap(hostPage, 'host', 'broadcasting');
  } catch (e) {
    console.log(`[${ts()}] host live err: ${e.message}`);
  }

  try {
    // Viewer: refresh home so live_started broadcast lands; tap live ring.
    await viewerPage.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await viewerPage.waitForTimeout(3500);
    await snap(viewerPage, 'viewer', 'home-with-live-strip');
    // Tap any element labeled "Ao vivo" / "AO VIVO" / "LIVE" chip on home.
    const liveChip = viewerPage.locator('text=AO VIVO, text=LIVE, text=Ao vivo').first();
    if (await liveChip.count().catch(() => 0)) {
      await liveChip.click().catch(() => {});
      console.log(`[${ts()}] ✓ viewer tapped live chip`);
    } else {
      console.log(`[${ts()}] ⚠ no live chip visible on viewer home`);
    }
    await viewerPage.waitForTimeout(5000);
    await snap(viewerPage, 'viewer', 'live-viewer-screen');
    await viewerPage.waitForTimeout(3000);
    await snap(viewerPage, 'viewer', 'live-connected-or-stuck');
  } catch (e) {
    console.log(`[${ts()}] viewer live err: ${e.message}`);
  }

  // Final state shots.
  await snap(hostPage, 'host', 'final');
  await snap(viewerPage, 'viewer', 'final');

  console.log(`[${ts()}] done — screenshots in ${OUT_DIR}`);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
