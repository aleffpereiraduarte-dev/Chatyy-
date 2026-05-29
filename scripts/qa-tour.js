// Interactive QA tour — Android-sized viewport, deterministic auth, screenshots.
// Usage: node scripts/qa-tour.js "route1:name1" "route2:name2" ...
// Screens land in /tmp/qa/<name>.png  (read them back to eyeball bugs).
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'https://chatyy.com.br';
const TOKEN = process.env.QA_TOKEN || 'qa_star_verify_1780071464_tok';
const USER = { email: 'duarte@chatyy.com.br', name: 'Aleff Duarte', token: TOKEN, plan: 'free' };
const INTRO = ['chatyy_intro_seen','intro_seen','onboarding_done','hasSeenOnboarding','chatyy_onboarded','seen_find_friends'];
const OUT = '/tmp/qa';
fs.mkdirSync(OUT, { recursive: true });

const routes = process.argv.slice(2).map(s => { const [p, n] = s.split('@@'); return { p, n: n || p.replace(/[^a-z0-9]/gi,'_') }; });

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
  });
  await ctx.addInitScript(([t,u,flags]) => { try {
    localStorage.setItem('mail_token', t);
    localStorage.setItem('chatyy_offline_user', JSON.stringify(u));
    localStorage.setItem('chatyy_token', t);
    flags.forEach(k => localStorage.setItem(k,'1'));
  } catch(e){} }, [TOKEN, USER, INTRO]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + String(e.message||e).slice(0,160)));
  page.on('console', m => { if (m.type()==='error') errs.push('CONSOLE ' + m.text().slice(0,160)); });
  const http = [];
  page.on('response', r => { const s=r.status(), u=r.url(); if (s>=500 || (s>=400 && /chatyy\.com\.br\/api\//.test(u) && !/push_diag/.test(u))) http.push(`${s} ${u.replace(/^https?:\/\/[^/]+/,'').split('&')[0].slice(0,70)}`); });

  for (const rt of routes) {
    errs.length = 0; http.length = 0;
    try { await page.goto(`${BASE}${rt.p}`, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch(e){ errs.push('NAV '+e.message.slice(0,100)); }
    await page.waitForTimeout(rt.p.includes('snap')||rt.p.includes('conversation') ? 3500 : 2200);
    await page.screenshot({ path: `${OUT}/${rt.n}.png` }).catch(()=>{});
    const title = await page.evaluate(() => document.title).catch(()=>'');
    const bodyLen = await page.evaluate(() => (document.body?.innerText||'').length).catch(()=>0);
    // raw i18n key leak detection (text that looks like a.b.c untranslated)
    const rawKeys = await page.evaluate(() => {
      const t = document.body?.innerText || '';
      const m = t.match(/\b[a-z]+\.[a-z]+\.[a-zA-Z]+\b/g) || [];
      return [...new Set(m)].slice(0,8);
    }).catch(()=>[]);
    console.log(`\n=== ${rt.n} (${rt.p}) ===`);
    console.log(`  bodyLen=${bodyLen} title="${title}"`);
    if (rawKeys.length) console.log(`  ⚠ possível i18n cru: ${rawKeys.join(', ')}`);
    if (errs.length) console.log('  JS errs:\n   ' + [...new Set(errs)].slice(0,5).join('\n   '));
    if (http.length) console.log('  HTTP errs: ' + [...new Set(http)].slice(0,5).join(' | '));
  }
  await browser.close();
  console.log('\nDONE — prints em ' + OUT);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
