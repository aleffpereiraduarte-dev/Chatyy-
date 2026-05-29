#!/usr/bin/env node
/**
 * Suporte dashboard full QA sweep.
 *  - Logs in (JWT), probes every READ-only admin.php action via API.
 *  - Cold-boots the SPA authenticated (support_token injected), navigates every
 *    hash route, screenshots each, captures pageerror / console errors / 4xx-5xx.
 * Destructive actions (delete/suspend/restart/restore/reset/queue/ticket-write/
 * AI-cost) are intentionally NOT exercised.
 * Out: /var/www/mail/data/qa-robot/suporte-qa/
 */
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path'); const https = require('https');

const BASE = 'https://suporte.chatyy.com.br';
const RESOLVE = '127.0.0.1';
const EMAIL = 'aleffpereiraduarte@gmail.com';
const PASS = 'Aleff2009@';
const SAMPLE_EMAIL = 'duarte@chatyy.com.br';
const OUT = '/var/www/mail/data/qa-robot/suporte-qa';

// READ-only actions safe to probe. [action, params]
const READ_ACTIONS = [
  ['check_auth', {}], ['dashboard', {}], ['clients', {}], ['accounts', {}],
  ['tickets', {}], ['mail_queue', {}], ['mail_stats', {}], ['system_status', {}],
  ['recovery_log', {}], ['security_logs', {}], ['ssl_status', {}], ['storage_ranking', {}],
  ['top_users', {}], ['errors', {}], ['config_view', {}], ['dns_records', {}],
  ['connection_test', {}], ['ai_usage', {}], ['ai_account_health', {}],
  ['blacklist_check', {}], ['log_tail', {}],
  ['clients', { search: 'duarte' }], ['accounts', { search: 'duarte' }],
  ['investigate', { q: 'duarte', limit: 10 }],
  ['client_detail', { email: SAMPLE_EMAIL }], ['client_emails', { email: SAMPLE_EMAIL, folder: 'INBOX', limit: 5 }],
  ['client_delivery', { email: SAMPLE_EMAIL, days: 7 }], ['client_activity', { email: SAMPLE_EMAIL }],
  ['recovery_dates', { email: SAMPLE_EMAIL }],
];

const ROUTES = ['dashboard','analytics','clients','tickets','investigate','queue','accounts',
  'new-accounts','plans','recovery','status','security','ai-health','ai-tools','ai-usage',
  'diagnostics','logs','reports','maintenance','calls','chatyy','tokens','revenue'];

function api(action, params, method, token) {
  return new Promise((resolve) => {
    let url = `${BASE}/api/admin.php?action=${action}`;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let body = null;
    if (method === 'GET') { Object.entries(params).forEach(([k,v]) => { if (v!=='' && v!=null) url += `&${k}=${encodeURIComponent(v)}`; }); }
    else body = JSON.stringify(params);
    const u = new URL(url);
    const req = https.request({ hostname: RESOLVE, servername: u.hostname, port: 443, path: u.pathname + u.search,
      method: method, headers, rejectUnauthorized: false }, (res) => {
      let b=''; res.on('data',c=>b+=c); res.on('end',()=>{ let j=null; try{j=JSON.parse(b);}catch(e){} resolve({ status: res.statusCode, ok: j?.success, msg: j?.message, raw: b.slice(0,120) }); });
    });
    req.on('error', e => resolve({ status: 0, err: e.message }));
    if (body) req.write(body); req.end();
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const report = []; const log = (...a) => { const s = a.join(' '); console.log(s); report.push(s); };

  // 1) login
  const lr = await api('login', { email: EMAIL, password: PASS }, 'POST', null);
  if (!lr.ok) { log('FATAL login failed', JSON.stringify(lr)); process.exit(2); }
  const token = JSON.parse(lr.raw.length>=120 ? '{}' : '{}'); // raw truncated; re-login full
  const full = await new Promise((resolve) => {
    const data = JSON.stringify({ email: EMAIL, password: PASS });
    const req = https.request({ hostname: RESOLVE, servername: 'suporte.chatyy.com.br', port: 443, path: '/api/admin.php?action=login', method: 'POST', headers: { 'Content-Type':'application/json','Content-Length':Buffer.byteLength(data) }, rejectUnauthorized:false }, r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>resolve(JSON.parse(b)));});
    req.write(data); req.end();
  });
  const TOK = full.data.token;
  log('=== LOGIN OK ===');

  // 2) probe read actions
  log('\n=== BACKEND READ-ACTION PROBES ===');
  const apiIssues = [];
  for (const [action, params] of READ_ACTIONS) {
    const method = (action==='check_auth') ? 'GET' : 'GET';
    const r = await api(action, params, 'GET', TOK);
    const tag = `${action}${Object.keys(params).length?'('+Object.keys(params).join(',')+')':''}`;
    const verdict = r.status===200 && r.ok!==false ? 'OK' : (r.status>=500 ? 'SERVER_ERROR' : (r.ok===false ? 'FALSE' : 'HTTP'+r.status));
    if (verdict!=='OK') apiIssues.push(`${tag}: ${verdict} ${r.msg||r.raw||r.err||''}`);
    log(`  ${verdict.padEnd(12)} ${tag} ${verdict!=='OK'?('— '+(r.msg||r.raw||r.err||r.status)):''}`);
  }

  // 3) SPA route sweep
  log('\n=== SPA ROUTE SWEEP ===');
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP suporte.chatyy.com.br '+RESOLVE,'--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  await ctx.addInitScript((t)=>{ try{ localStorage.setItem('support_token', t); localStorage.setItem('suporte_remember_email','aleffpereiraduarte@gmail.com'); }catch(e){} }, TOK);
  const page = await ctx.newPage();
  const crashes = []; page.on('pageerror', e => crashes.push(String(e?.message||e).slice(0,200)));
  await page.goto(`${BASE}/#dashboard`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
  await page.waitForTimeout(3000);

  const routeIssues = [];
  for (const r of ROUTES) {
    const before = crashes.length; const cerr = []; const http5 = []; const http4 = new Set();
    const oc = m => { if (m.type()==='error') cerr.push(m.text().slice(0,160)); };
    const orsp = resp => { const s = resp.status(); const u = resp.url(); if (s>=500) http5.push(`${s} ${u.slice(-50)}`); else if ((s===403||s===404) && /admin\.php/.test(u)) http4.add(`${s} ${u.split('action=')[1]?.split('&')[0]||''}`); };
    page.on('console', oc); page.on('response', orsp);
    try { await page.goto(`${BASE}/#${r}`, { waitUntil:'domcontentloaded', timeout:30000 }); } catch(e){ crashes.push('nav '+r+': '+e.message); }
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(OUT, `route-${r}.png`) }).catch(()=>{});
    // detect blank / error-boundary / raw text
    const body = await page.evaluate(()=>document.body.innerText.slice(0,400)).catch(()=>'');
    const blank = body.trim().length < 20;
    const errBoundary = /erro|error|undefined|NaN|\[object Object\]|cannot read/i.test(body);
    page.off('console', oc); page.off('response', orsp);
    const newCrashes = crashes.slice(before);
    const flags = [];
    if (newCrashes.length) flags.push(`JS_CRASH(${newCrashes.length}): ${newCrashes[0]}`);
    if (cerr.length) flags.push(`console_err(${cerr.length}): ${cerr[0]}`);
    if (http5.length) flags.push(`5xx: ${http5[0]}`);
    if (http4.size) flags.push(`4xx: ${[...http4][0]}`);
    if (blank) flags.push('BLANK_SCREEN');
    if (flags.length) routeIssues.push(`#${r}: ${flags.join(' | ')}`);
    log(`  ${flags.length?'⚠️':'✓ '} #${r} ${flags.join(' | ')}`);
  }
  await browser.close();

  log('\n=== SUMMARY ===');
  log(`backend read-action issues: ${apiIssues.length}`);
  apiIssues.forEach(i => log('  • '+i));
  log(`route issues: ${routeIssues.length}`);
  routeIssues.forEach(i => log('  • '+i));
  fs.writeFileSync(path.join(OUT, 'report.txt'), report.join('\n'));
  log('\nDONE. Screenshots + report in ' + OUT);
})();
