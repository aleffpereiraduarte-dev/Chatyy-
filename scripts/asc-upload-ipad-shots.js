#!/usr/bin/env node
/**
 * App Store Connect — iPad screenshot uploader (12.9" iPad Pro display set).
 *
 * Two modes:
 *   node scripts/asc-upload-ipad-shots.js            → INSPECT (read-only):
 *        prints the app's iOS versions + states + existing iPad screenshot sets
 *        so we know whether the editable version can take new screenshots.
 *   node scripts/asc-upload-ipad-shots.js --upload   → replace the iPad 12.9"
 *        screenshots on the editable version with the PNGs in OUT (sorted).
 *
 * Auth: ES256 JWT signed with asc_key.p8 (key id + issuer from CLAUDE.md).
 * Safe by design: --upload aborts unless the version is in an editable state
 * (PREPARE_FOR_SUBMISSION / DEVELOPER_REJECTED / REJECTED / METADATA_REJECTED).
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const https = require('https');

const KEY_ID   = 'QSYM3KX73P';
const ISSUER   = '494360d0-0420-4f1f-a1db-6be19eeb2d89';
const APP_ID   = '6759975575';
const KEY_PATH = path.join(__dirname, '..', 'asc_key.p8');
const OUT      = '/var/www/mail/data/qa-robot/ipad-prints';
const DISPLAY_TYPE = 'APP_IPAD_PRO_3GEN_129'; // 2048×2732 (12.9"/13" iPad Pro)
const EDITABLE_STATES = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];

function jwt() {
  const key = fs.readFileSync(KEY_PATH, 'utf8');
  const header = { alg: 'ES256', kid: KEY_ID, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: ISSUER, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.createSign('SHA256').update(signingInput).sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${sig.toString('base64url')}`;
}

function api(method, urlPath, body, rawBody, extraHeaders) {
  return new Promise((resolve, reject) => {
    const isAbs = urlPath.startsWith('http');
    const u = new URL(isAbs ? urlPath : `https://api.appstoreconnect.apple.com${urlPath}`);
    const data = rawBody != null ? rawBody : (body ? JSON.stringify(body) : null);
    const headers = { 'Authorization': `Bearer ${jwt()}`, ...(extraHeaders || {}) };
    if (data && !rawBody) headers['Content-Type'] = 'application/json';
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers }, (res) => {
      let b = []; res.on('data', c => b.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(b);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (!buf.length) return resolve({});
          try { resolve(JSON.parse(buf.toString())); } catch { resolve({ _raw: buf.toString() }); }
        } else {
          reject(new Error(`${method} ${u.pathname} → ${res.statusCode}: ${buf.toString().slice(0, 400)}`));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function putBytes(url, headers, bytes) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = {}; (headers || []).forEach(x => { h[x.name] = x.value; });
    h['Content-Length'] = bytes.length;
    const req = https.request({ method: 'PUT', hostname: u.hostname, path: u.pathname + u.search, headers: h }, (res) => {
      let b = []; res.on('data', c => b.push(c));
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300)
        ? resolve() : reject(new Error(`PUT upload → ${res.statusCode}: ${Buffer.concat(b).toString().slice(0,200)}`)));
    });
    req.on('error', reject); req.write(bytes); req.end();
  });
}

(async () => {
  const doUpload = process.argv.includes('--upload');
  console.log('ASC iPad screenshots —', doUpload ? 'UPLOAD MODE' : 'INSPECT (read-only)');

  // 1. iOS versions + states
  const vers = await api('GET', `/v1/apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&limit=10`);
  const editable = [];
  for (const v of vers.data || []) {
    const ed = EDITABLE_STATES.includes(v.attributes.appStoreState);
    console.log(`  v${v.attributes.versionString}  state=${v.attributes.appStoreState}  ${ed ? '← EDITÁVEL' : ''}  id=${v.id}`);
    if (ed) editable.push(v);
  }
  if (!editable.length) {
    console.log('\n⚠️  Nenhuma versão editável. Pra trocar screenshots, a versão precisa estar em "Prepare for Submission" (ou rejeitada). Se a 3.0.1 está em review, crie uma nova versão ou aguarde.');
    return;
  }
  const ver = editable[0];
  console.log(`\nUsando versão editável: ${ver.attributes.versionString} (${ver.id})`);

  // 2. localizations
  const locs = await api('GET', `/v1/appStoreVersions/${ver.id}/appStoreVersionLocalizations?limit=50`);
  console.log('Locales:', (locs.data || []).map(l => l.attributes.locale).join(', '));

  // load PNGs (sorted)
  const files = fs.readdirSync(OUT).filter(f => /^\d.*\.png$/.test(f)).sort();
  console.log('Screenshots locais:', files.join(', '));

  for (const loc of locs.data || []) {
    const locId = loc.id, locale = loc.attributes.locale;
    // existing iPad sets
    const sets = await api('GET', `/v1/appStoreVersionLocalizations/${locId}/appScreenshotSets?limit=50`);
    let set = (sets.data || []).find(s => s.attributes.screenshotDisplayType === DISPLAY_TYPE);
    const existing = set ? await api('GET', `/v1/appScreenshotSets/${set.id}/appScreenshots?limit=50`) : { data: [] };
    console.log(`  [${locale}] iPad12.9 set=${set ? set.id : 'NONE'} — ${(existing.data||[]).length} screenshots atuais`);

    if (!doUpload) continue;

    // create set if missing
    if (!set) {
      const created = await api('POST', '/v1/appScreenshotSets', {
        data: { type: 'appScreenshotSets', attributes: { screenshotDisplayType: DISPLAY_TYPE },
          relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: locId } } } }
      });
      set = created.data;
      console.log(`    + criado set ${set.id}`);
    }
    // delete existing (replace)
    for (const sc of existing.data || []) {
      await api('DELETE', `/v1/appScreenshots/${sc.id}`).catch(e => console.log('    del warn', e.message));
    }
    // upload each
    for (const f of files) {
      const bytes = fs.readFileSync(path.join(OUT, f));
      const reserve = await api('POST', '/v1/appScreenshots', {
        data: { type: 'appScreenshots', attributes: { fileName: f, fileSize: bytes.length },
          relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: set.id } } } }
      });
      const scId = reserve.data.id;
      for (const op of reserve.data.attributes.uploadOperations || []) {
        await putBytes(op.url, op.requestHeaders, bytes.slice(op.offset, op.offset + op.length));
      }
      const md5 = crypto.createHash('md5').update(bytes).digest('hex');
      await api('PATCH', `/v1/appScreenshots/${scId}`, {
        data: { type: 'appScreenshots', id: scId, attributes: { uploaded: true, sourceFileChecksum: md5 } }
      });
      console.log(`    ✓ ${f} (${(bytes.length/1024|0)}KB)`);
    }
  }
  console.log(doUpload ? '\n✅ Upload concluído.' : '\n(inspeção — rode com --upload pra trocar de verdade)');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
