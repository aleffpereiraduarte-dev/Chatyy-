#!/usr/bin/env node
/**
 * iPad App Store screenshots — renders the production web bundle (same JS as the
 * native OTA) at 12.9" iPad Pro resolution (2048×2732 px = 1024×1366 viewport @2x
 * deviceScaleFactor). All Macs are offline so a native iPad simulator isn't
 * reachable; the web app is the identical React-Native-Web UI, so these are real
 * app screenshots at the exact size App Store Connect requires for the
 * 12.9"/13" iPad display class.
 *
 * Auth: cold-boot authenticated by injecting token + offline_user + intro flags
 * into localStorage (same trick as scripts/qa-robot.js).
 *
 * Output: /var/www/mail/data/qa-robot/ipad-prints/<NN>-<screen>.png
 * Run: node scripts/ipad-prints.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE  = process.env.IPAD_BASE  || 'https://chatyy.com.br';
const EMAIL = process.env.IPAD_EMAIL || 'apitest@onemundo.com.br';
const PWD   = process.env.IPAD_PWD   || 'LBfypvbERr4cm1Hd1nZe3yT';
const OUT   = '/var/www/mail/data/qa-robot/ipad-prints';

const INTRO_FLAGS = [
  'chatyy_intro_seen', 'chatyy_onboarding_done', 'hasSeenIntro',
  'chatyy_find_friends_dismissed', 'chatyy_contact_banner_dismissed',
];

// Showcase screens for the App Store iPad set (max 10 slots). Order = sell order.
// Self-contained feature screens that render full regardless of demo-account
// content (chat is the only content-dependent one, and apitest has a seeded
// thread). Avoids the empty feed / blurry reels / location-off map problem.
const SHOTS = [
  { p: '/chat',                              n: '1-messaging',    settle: 2500 },
  { p: '/chat-conversation?id=872',          n: '2-conversation', settle: 3000 },
  { p: '/one',                               n: '3-ai',           settle: 2500 },
  { p: '/profile',                           n: '4-profile',      settle: 2800 },
  { p: '/wallet',                            n: '5-wallet',       settle: 2500 },
  { p: '/photos',                            n: '6-photos',       settle: 2800 },
];

function api(action, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = https.request(`${BASE}/api/email.php?action=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      rejectUnauthorized: false,
    }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b.slice(0, 200))); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let token, user;
  try { const r = await api('login', { email: EMAIL, password: PWD }); token = r?.data?.token; user = r?.data; } catch (e) { console.log('login err', e.message); }
  if (!token) { console.log('FATAL: API login failed for ' + EMAIL); process.exit(2); }
  console.log('auth OK as', EMAIL);

  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=2'] });
  // 1024×1366 @ dsf2 = 2048×2732 px screenshots (12.9" iPad Pro portrait).
  const ctx = await browser.newContext({
    viewport: { width: 1024, height: 1366 },
    deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  });
  await ctx.addInitScript(([t, u, flags]) => { try {
    localStorage.setItem('mail_token', t);
    localStorage.setItem('chatyy_offline_user', JSON.stringify(u));
    flags.forEach(k => localStorage.setItem(k, '1'));
  } catch (e) {} }, [token, user, INTRO_FLAGS]);

  const page = await ctx.newPage();
  // warm-boot once so auth + service worker settle
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  let i = 1;
  for (const s of SHOTS) {
    const file = path.join(OUT, `${String(i).padStart(2, '0')}-${s.n}.png`);
    try {
      await page.goto(`${BASE}${s.p}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(s.settle || 2000);
      // Dismiss any global incoming-call / ringing overlay so it doesn't cover
      // the screen (apitest gets a phantom call_invite on WS cold-boot). Click
      // Decline/Recusar + clear call state, then re-settle.
      await page.evaluate(() => {
        try {
          [...document.querySelectorAll('*')].forEach(e => {
            const t = (e.textContent || '').trim();
            if (e.children.length === 0 && /^(Decline|Recusar|Encerrar|Dispensar|Hang ?up)$/i.test(t)) { try { e.click(); } catch (_) {} }
          });
          Object.keys(localStorage).filter(k => /call|ring|incoming|offer/i.test(k)).forEach(k => localStorage.removeItem(k));
        } catch (_) {}
      }).catch(() => {});
      await page.waitForTimeout(900);
      // exact-viewport shot (App Store rejects wrong dimensions; no fullPage)
      await page.screenshot({ path: file });
      const sz = fs.statSync(file).size;
      console.log(`shot ${i} ${s.n} -> ${file} (${Math.round(sz/1024)}KB)`);
    } catch (e) {
      console.log(`shot ${i} ${s.n} FAILED: ${e.message}`);
    }
    i++;
  }
  await browser.close();
  console.log('DONE. Prints in ' + OUT);
})();
