#!/usr/bin/env node
/**
 * shot-all.js — login + screenshot EVERY page of Chatyy at Android phone size.
 * Captures pre-auth pages (login/signup/forgot) first WITHOUT a token, then
 * cold-boots authenticated and screenshots every app route. One PNG per page
 * (full page). Zips everything at the end.
 *
 *   node scripts/shot-all.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const BASE = process.env.QA_BASE || 'https://chatyy.com.br';
const EMAIL = process.env.QA_EMAIL || 'demo@chatyy.com.br';
const PWD = process.env.QA_PWD || 'ChatyyDemo2026';
const SHOT_CONV = process.env.QA_SHOT_CONV || '851';

// Pages BEFORE login (no token injected).
const PUBLIC_ROUTES = [
  { p: '/login', n: '00-login' },
  { p: '/signup', n: '01-signup' },
  { p: '/forgot', n: '02-forgot' },
];

// Every authenticated app screen.
const ROUTES = [
  { p: '/chat', n: 'chat-list' },
  { p: `/chat-conversation?id=${SHOT_CONV}`, n: 'chat-conversation', settle: 2500 },
  { p: '/chat-new', n: 'chat-new' },
  { p: '/saved-messages', n: 'saved-messages' },
  { p: '/starred-messages', n: 'starred-messages' },
  { p: '/search', n: 'search' },
  { p: '/contacts', n: 'contacts' },
  { p: '/close-friends', n: 'close-friends' },
  { p: '/feed', n: 'feed' },
  { p: '/reels-drafts', n: 'reels-drafts' },
  { p: '/spotlight', n: 'spotlight' },
  { p: '/snap-map', n: 'snap-map', settle: 2500 },
  { p: '/live-discover', n: 'live-discover' },
  { p: '/live-broadcast', n: 'live-broadcast' },
  { p: '/lives-saved', n: 'lives-saved' },
  { p: '/meetings', n: 'meetings' },
  { p: '/meeting-create', n: 'meeting-create' },
  { p: '/call-schedule', n: 'call-schedule' },
  { p: '/voicemail-recorder', n: 'voicemail-recorder' },
  { p: '/one', n: 'one-ai' },
  { p: '/inbox', n: 'inbox' },
  { p: '/compose', n: 'compose' },
  { p: '/email-signatures', n: 'email-signatures' },
  { p: '/email-import', n: 'email-import' },
  { p: '/files', n: 'files' },
  { p: '/drive', n: 'drive' },
  { p: '/documentos', n: 'documentos' },
  { p: '/notes', n: 'notes' },
  { p: '/photos', n: 'photos' },
  { p: '/backup', n: 'backup' },
  { p: '/storage', n: 'storage' },
  { p: '/calendar', n: 'calendar' },
  { p: '/tasks', n: 'tasks' },
  { p: '/marketplace', n: 'marketplace' },
  { p: '/profile', n: 'profile' },
  { p: '/profile-insights', n: 'profile-insights' },
  { p: '/profile-qr', n: 'profile-qr' },
  { p: '/activity-log', n: 'activity-log' },
  { p: '/linked-devices', n: 'linked-devices' },
  { p: '/linked-phones', n: 'linked-phones' },
  { p: '/change-phone', n: 'change-phone' },
  { p: '/business', n: 'business' },
  { p: '/family', n: 'family' },
  { p: '/parental', n: 'parental' },
  { p: '/kids-learn', n: 'kids-learn' },
  { p: '/settings', n: 'settings' },
  { p: '/advanced-privacy', n: 'advanced-privacy' },
  { p: '/advanced-key', n: 'advanced-key' },
  { p: '/pgp-keys', n: 'pgp-keys' },
  { p: '/notification-preferences', n: 'notification-preferences' },
  { p: '/notifications', n: 'notifications' },
  { p: '/notifications-feed', n: 'notifications-feed' },
  { p: '/bots', n: 'bots' },
];

const INTRO_FLAGS = ['chatyy_intro_seen', 'intro_seen', 'onboarding_done', 'hasSeenOnboarding', 'chatyy_onboarded'];
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = `/var/www/mail/data/qa-robot/shots-${ts}`;
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('[shot-all]', ...a);

function api(action, payload, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action, ...payload });
    const r = https.request(`${BASE}/api/email.php`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    r.on('error', reject); r.write(body); r.end();
  });
}

async function shoot(page, route, n) {
  try { await page.goto(`${BASE}${route.p}`, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) { log('nav fail', route.n, e.message); }
  await page.waitForTimeout(route.settle || 1600);
  const file = path.join(OUT, `${String(n).padStart(2, '0')}-${route.n}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  log(`📸 ${route.n}`);
}

(async () => {
  log(`base=${BASE} acct=${EMAIL} out=${OUT}`);
  let token, user;
  try { const r = await api('login', { email: EMAIL, password: PWD }); token = r?.data?.token; user = r?.data; } catch {}
  if (!token) { log('FATAL: API login failed'); process.exit(2); }

  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  // ── Phase 1: public pages, NO token (real login screen) ──
  const pubCtx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (Linux; Android 13) Chatyy-Shot' });
  const pubPage = await pubCtx.newPage();
  let n = 0;
  for (const route of PUBLIC_ROUTES) { await shoot(pubPage, route, n++); }
  await pubCtx.close();

  // ── Phase 2: authenticated cold-boot ──
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (Linux; Android 13) Chatyy-Shot' });
  await ctx.addInitScript(([t, u, flags]) => { try {
    localStorage.setItem('mail_token', t);
    localStorage.setItem('chatyy_offline_user', JSON.stringify(u));
    flags.forEach(k => localStorage.setItem(k, '1'));
  } catch {} }, [token, user, INTRO_FLAGS]);
  const page = await ctx.newPage();
  // warm the session
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3500);

  for (const route of ROUTES) { await shoot(page, route, n++); }
  await browser.close();

  // ── Zip ──
  const zip = `/var/www/mail/data/qa-robot/chatyy-screenshots-${ts}.zip`;
  try { execSync(`cd ${OUT} && zip -q -r ${zip} . && chmod 644 ${zip}`); } catch (e) { log('zip fail', e.message); }
  try { execSync(`chmod -R 755 ${OUT}`); } catch {}
  const count = fs.readdirSync(OUT).filter(f => f.endsWith('.png')).length;
  log(`\n✅ ${count} screenshots → ${OUT}`);
  log(`📦 zip → ${zip}`);
  console.log(JSON.stringify({ count, dir: OUT, zip, url: zip.replace('/var/www/mail', BASE) }));
  process.exit(0);
})();
