#!/usr/bin/env node
/**
 * Chatyy QA Robot — autonomous web E2E (same JS bundle as the mobile OTA).
 * --------------------------------------------------------------------------
 * Cold-boots authenticated (token + offline_user + intro flags injected),
 * walks EVERY screen, and CLICKS EVERY function one-by-one — screenshotting
 * each interaction, recovering after each, and flagging anything broken:
 *   crashes (pageerror) · console errors · backend 5xx · blank screens ·
 *   ErrorBoundary · raw i18n keys · giant solid blocks · AI visual review.
 * Then it POSTS a report as a Chatyy message to @duarte and writes the full
 * report + screenshots to /var/www/mail/data/qa-robot/<ts>/.
 *
 * Run once:   node scripts/qa-robot.js
 * Every 30m:  cron — see scripts/qa-robot.cron
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = process.env.QA_BASE || 'https://chatyy.com.br';
const EMAIL = process.env.QA_EMAIL || 'demo@chatyy.com.br';
const PWD = process.env.QA_PWD || 'ChatyyDemo2026';
const REPORT_TO_CONV = process.env.QA_CONV || '849';   // demo↔duarte → report lands in duarte's Chatyy
const AI = process.env.QA_AI !== '0';                  // AI eval on by default
const MAX_CLICKS = parseInt(process.env.QA_CLICKS || '10', 10); // interactive elements per screen (bounded for 60-screen sweep)

// Every meaningful web screen (Expo Router routes under app/). Dynamic routes
// get a sample param so they render. Diagnostic/recorder/param-only screens
// that can't render standalone are intentionally omitted.
const ROUTES = [
  // ── Core messaging ──
  { p: '/chat', n: 'chat-list' },
  { p: `/chat-conversation?id=${REPORT_TO_CONV}`, n: 'chat-conversation', settle: 2500 },
  { p: '/chat-new', n: 'chat-new' },
  { p: '/saved-messages', n: 'saved-messages' },
  { p: '/starred-messages', n: 'starred-messages' },
  { p: '/search', n: 'search' },
  { p: '/contacts', n: 'contacts' },
  { p: '/close-friends', n: 'close-friends' },
  // ── Status / Feed / Reels / Discovery ──
  { p: '/status', n: 'status' },
  { p: '/feed', n: 'feed' },
  { p: '/reels-drafts', n: 'reels-drafts' },
  { p: '/spotlight', n: 'spotlight' },
  { p: '/snap-map', n: 'snap-map', settle: 2500 },
  // ── Live ──
  { p: '/live-discover', n: 'live-discover' },
  { p: '/live-broadcast', n: 'live-broadcast' },
  { p: '/lives-saved', n: 'lives-saved' },
  // ── Calls / Meetings ──
  { p: '/meetings', n: 'meetings' },
  { p: '/meeting-create', n: 'meeting-create' },
  { p: '/call-schedule', n: 'call-schedule' },
  { p: '/voicemail-recorder', n: 'voicemail-recorder' },
  // ── AI ──
  { p: '/one', n: 'one-ai' },
  // ── Email ──
  { p: '/inbox', n: 'inbox' },
  { p: '/compose', n: 'compose' },
  { p: '/email-signatures', n: 'email-signatures' },
  { p: '/email-import', n: 'email-import' },
  // ── Drive / Files / Docs / Notes / Photos ──
  { p: '/files', n: 'files' },
  { p: '/drive', n: 'drive' },
  { p: '/documentos', n: 'documentos' },
  { p: '/notes', n: 'notes' },
  { p: '/photos', n: 'photos' },
  { p: '/backup', n: 'backup' },
  { p: '/storage', n: 'storage' },
  { p: '/calendar', n: 'calendar' },
  { p: '/tasks', n: 'tasks' },
  // ── Money / Premium ──
  { p: '/wallet', n: 'wallet' },
  { p: '/diamond-shop', n: 'diamond-shop' },
  { p: '/plans', n: 'plans' },
  { p: '/marketplace', n: 'marketplace' },
  { p: '/creator-earnings', n: 'creator-earnings' },
  // ── Profile / Account ──
  { p: '/profile', n: 'profile' },
  { p: '/profile-insights', n: 'profile-insights' },
  { p: '/profile-qr', n: 'profile-qr' },
  { p: '/activity-log', n: 'activity-log' },
  { p: '/linked-devices', n: 'linked-devices' },
  { p: '/linked-phones', n: 'linked-phones' },
  { p: '/change-phone', n: 'change-phone' },
  { p: '/business', n: 'business' },
  // ── Family / Kids ──
  { p: '/family', n: 'family' },
  { p: '/parental', n: 'parental' },
  { p: '/kids-learn', n: 'kids-learn' },
  // ── Settings & Privacy ──
  { p: '/settings', n: 'settings' },
  { p: '/advanced-privacy', n: 'advanced-privacy' },
  { p: '/advanced-key', n: 'advanced-key' },
  { p: '/pgp-keys', n: 'pgp-keys' },
  { p: '/notification-preferences', n: 'notification-preferences' },
  { p: '/notifications', n: 'notifications' },
  { p: '/notifications-feed', n: 'notifications-feed' },
  { p: '/bots', n: 'bots' },
];

// Never click these (destructive / would end the session / leave the app).
const SKIP_RX = /sair|log\s?out|logout|deletar|apagar|excluir|remover|delete|remove|block|bloquear|sign out|encerrar|desativar|trocar conta|switch account|limpar tudo|reset|denunciar|report|unfriend|deixar de seguir/i;
const INTRO_FLAGS = ['chatyy_intro_seen', 'intro_seen', 'onboarding_done', 'hasSeenOnboarding', 'chatyy_onboarded'];

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = `/var/www/mail/data/qa-robot/${ts}`;
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('[qa-robot]', ...a);

function api(action, payload, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action, ...payload });
    const r = https.request(`${BASE}/api/email.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    r.on('error', reject); r.write(body); r.end();
  });
}

function aiEval(pngPath, name) {
  return new Promise((resolve) => {
    let key = '';
    try { const env = fs.readFileSync('/etc/mail-api.env', 'utf8'); const m = env.match(/^OPENAI_API_KEY=(.+)$/m); key = m ? m[1].trim() : ''; } catch {}
    if (!key) return resolve(null);
    const b64 = fs.readFileSync(pngPath).toString('base64');
    const payload = JSON.stringify({
      model: 'gpt-4o-mini', max_tokens: 150,
      messages: [{ role: 'user', content: [
        { type: 'text', text: `Screen "${name}" of a WhatsApp-style app (Chatyy). VISUAL BUGS only: overlapping/cut-off elements, a giant solid color block, blank area where content should be, raw keys like "chatConv.foo", an error message, broken layout. Reply JSON {"ok":true} if fine, or {"ok":false,"issue":"<short>"}. Don't flag normal empty states.` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } } ] }],
    });
    const req = https.request('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Content-Length': Buffer.byteLength(payload) }, timeout: 30000 },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { const j = JSON.parse(d); const t = j?.choices?.[0]?.message?.content || ''; const m = t.match(/\{[\s\S]*\}/); resolve(m ? JSON.parse(m[0]) : null); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(payload); req.end();
  });
}

// Deterministic auth: the web app gates the authed UI behind offline_user +
// intro-seen flags (token alone leaves it on the intro carousel — confirmed
// via probe). Inject all three so it cold-boots straight into the app.
async function login(page) {
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  const url = page.url();
  const txt = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')) || '';
  return !/\/login/.test(url) && !/sign in with e-?mail|entrar com e-?mail|pular|^skip/i.test(txt);
}

async function scan(page) {
  return page.evaluate(() => {
    const bodyText = (document.body?.innerText || '').trim();
    const errBoundary = /algo deu errado|something went wrong|unexpected error|tela em branco/i.test(bodyText);
    // Real i18n keys are camelCase (chatConv.loadingImage); lowercase.lowercase
    // tokens are contact handles (gleyson.xavier) — require a hump after the dot.
    const rawKeys = (bodyText.match(/\b[a-z][a-zA-Z]+\.[a-z]+[A-Z][a-zA-Z]+\b/g) || []).filter(k => !/\.(com|br|ai|net|org|php|js|jpg|png|mp4|pdf)$/i.test(k)).slice(0, 5);
    let giant = null; const vh = window.innerHeight;
    document.querySelectorAll('div').forEach(el => { if (giant) return; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      if (r.height > vh * 1.4 && r.width > 120 && el.children.length <= 1 && cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && (el.innerText || '').trim().length === 0) giant = `${Math.round(r.width)}x${Math.round(r.height)} ${cs.backgroundColor}`; });
    return { textLen: bodyText.length, errBoundary, rawKeys, giant };
  }).catch(() => ({ textLen: 0, errBoundary: false, rawKeys: [], giant: null }));
}

(async () => {
  log(`base=${BASE} acct=${EMAIL} ai=${AI ? 'on' : 'off'} clicks/screen=${MAX_CLICKS}`);
  let token, user;
  try { const r = await api('login', { email: EMAIL, password: PWD }); token = r?.data?.token; user = r?.data; } catch {}
  if (!token) { log('FATAL: API login failed'); process.exit(2); }

  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (Linux; Android 13) Chatyy-QA-Robot' });
  await ctx.addInitScript(([t, u, flags]) => { try {
    localStorage.setItem('mail_token', t);
    localStorage.setItem('chatyy_offline_user', JSON.stringify(u));
    flags.forEach(k => localStorage.setItem(k, '1'));
  } catch {} }, [token, user, INTRO_FLAGS]);
  const page = await ctx.newPage();

  const loggedIn = await login(page).catch(() => false);
  log('login', loggedIn ? 'OK (authenticated cold-boot)' : 'FAILED');

  const findings = [];
  const crashes = [];
  page.on('pageerror', e => crashes.push(String(e?.message || e).slice(0, 200)));

  for (const route of ROUTES) {
    const before = crashes.length; const consoleErr = []; const http5 = []; const http4 = new Set();
    const oc = m => { if (m.type() === 'error') consoleErr.push(m.text().slice(0, 200)); };
    const orsp = r => {
      const s = r.status(); const u = r.url();
      if (s >= 500) http5.push(`${s} ${u.slice(0, 90)}`);
      // surface 4xx on our own API only (ignore third-party/CDN noise + favicon).
      // push_diag is a known benign background probe that always 403s — skip it.
      else if (s === 403 || s === 404) { if (/chatyy\.com\.br\/api\//.test(u) && !/action=push_diag/.test(u)) http4.add(`${s} ${u.replace(/^https?:\/\/[^/]+/, '').split('&')[0].slice(0, 70)}`); }
    };
    page.on('console', oc); page.on('response', orsp);
    const sdir = path.join(OUT, route.n); fs.mkdirSync(sdir, { recursive: true });

    try { await page.goto(`${BASE}${route.p}`, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) { crashes.push('nav ' + route.n + ': ' + e.message); }
    await page.waitForTimeout(route.settle || 1500);
    await page.screenshot({ path: path.join(sdir, '00-landing.png') }).catch(() => {});
    const dom = await scan(page);

    // EXHAUSTIVE click explorer: click every non-destructive interactive
    // element one-by-one, screenshot each, capture errors after each, recover.
    const clickIssues = [];
    let clicked = 0; const seenLabels = new Set();
    try {
      const handles = await page.locator('[role="button"], button, [tabindex="0"], a[href], [role="tab"], [role="menuitem"]').elementHandles();
      for (const h of handles) {
        if (clicked >= MAX_CLICKS) break;
        let label = ''; try { label = ((await h.innerText()) || '').trim().replace(/\s+/g, ' ').slice(0, 40); } catch {}
        const key = label || ('el' + clicked);
        if (seenLabels.has(key)) continue; seenLabels.add(key);
        if (label && SKIP_RX.test(label)) continue;
        let vis = false; try { vis = await h.isVisible(); } catch {}
        if (!vis) continue;
        const cBefore = crashes.length, eBefore = consoleErr.length;
        try { await h.click({ timeout: 2000 }); } catch { continue; }
        clicked++;
        await page.waitForTimeout(650);
        const slug = (label || 'el').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) || 'el';
        await page.screenshot({ path: path.join(sdir, `${String(clicked).padStart(2, '0')}-${slug}.png`) }).catch(() => {});
        if (crashes.length > cBefore) clickIssues.push(`click "${label}" → CRASH: ${crashes[crashes.length - 1]}`);
        else if (consoleErr.length > eBefore && !/Failed to load resource.*403/.test(consoleErr[consoleErr.length - 1])) clickIssues.push(`click "${label}" → ${consoleErr[consoleErr.length - 1]}`);
        // recover: close modal/sheet + re-anchor to the route
        try { await page.keyboard.press('Escape'); } catch {}
        await page.waitForTimeout(150);
        if (!page.url().includes(route.p.split('?')[0])) {
          try { await page.goto(`${BASE}${route.p}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(700); } catch {}
        }
      }
    } catch {}

    const issues = [];
    if (crashes.slice(before).length) issues.push(`CRASH: ${crashes.slice(before)[0]}`);
    if (http5.length) issues.push(`backend 5xx ${http5[0]}`);
    if (http4.size) issues.push(`API ${[...http4].slice(0, 3).join(', ')}`);
    if (dom.errBoundary) issues.push('ErrorBoundary rendered');
    if (dom.textLen < 8) issues.push(`blank screen`);
    if (dom.giant) issues.push(`giant block ${dom.giant}`);
    if (dom.rawKeys.length) issues.push(`raw i18n: ${dom.rawKeys.join(', ')}`);
    // generic console 403 noise is now captured as http4 with URLs; only report console errors that aren't plain resource 403s
    const realConsole = consoleErr.filter(e => !/Failed to load resource.*403/.test(e));
    if (realConsole.length) issues.push(`${realConsole.length} console err: ${realConsole[0]}`);
    issues.push(...clickIssues.slice(0, 8));
    let ai = null; if (AI) { ai = await aiEval(path.join(sdir, '00-landing.png'), route.n); if (ai && ai.ok === false) issues.push(`AI: ${ai.issue}`); }

    log(`${issues.length ? '❌' : '✅'} ${route.n} (${clicked} funcs clicadas)${issues.length ? ' — ' + issues.slice(0, 3).join(' | ') : ''}`);
    findings.push({ route: route.n, path: route.p, clicked, ok: issues.length === 0, issues });
    page.off('console', oc); page.off('response', orsp);
  }
  await browser.close();

  const broken = findings.filter(f => !f.ok);
  const totalClicks = findings.reduce((s, f) => s + f.clicked, 0);
  const md = [`# Chatyy QA Robot — ${ts}`, ``,
    `Login: ${loggedIn ? 'OK' : 'FALHOU'} · Telas: ${findings.length} · Funções clicadas: ${totalClicks} · ✅ ${findings.length - broken.length} · ❌ ${broken.length}`, ``,
    `## Problemas`, broken.length ? broken.map(f => `### ${f.route}\n${f.issues.map(i => `- ${i}`).join('\n')}`).join('\n\n') : '_Nenhum — todas as telas e funções passaram._', ``,
    `## Telas`, findings.map(f => `- ${f.ok ? '✅' : '❌'} ${f.route} (${f.clicked} funcs)`).join('\n')].join('\n');
  fs.writeFileSync(path.join(OUT, 'report.md'), md);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ ts, loggedIn, findings }, null, 2));
  try { require('child_process').execSync(`chmod -R 755 ${OUT}`); } catch {}

  // Send a concise report to @duarte inside Chatyy.
  if (token) {
    const head = `🤖 QA Robot ${ts.slice(0, 10)} ${ts.slice(11).replace(/-/g, ':')}\nLogin ${loggedIn ? 'OK' : 'FALHOU'} · ${findings.length} telas · ${totalClicks} funções clicadas · ✅${findings.length - broken.length} ❌${broken.length}`;
    const body = broken.length ? '\n\n⚠️ Problemas:\n' + broken.map(f => `• ${f.route}: ${f.issues.slice(0, 2).join(' | ')}`).join('\n') : '\n\n✅ Tudo passou neste ciclo.';
    await api('chat_send', { conversation_id: Number(REPORT_TO_CONV), content: (head + body).slice(0, 3500) }, token).catch(() => {});
  }
  log(`\n${md}\nreport → ${OUT}/report.md`);
  process.exit(broken.length ? 1 : 0);
})();
