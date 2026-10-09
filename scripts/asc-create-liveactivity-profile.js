#!/usr/bin/env node
// [2026-10-07 ios-native] Provision the ChatyyCallActivity WidgetKit extension
// (Live Activity / Dynamic Island for ongoing calls, bundle
// com.onemundo.mail.CallActivity) through the App Store Connect API, then wire
// the result into the repo so the next iOS build embeds the extension:
//
//   1. find/create bundle id com.onemundo.mail.CallActivity (NO capabilities —
//      the widget only renders local ActivityKit state; no App Group, no push)
//   2. create an App Store provisioning profile (Apple Distribution cert)
//   3. save credentials/chatyy-liveactivity.mobileprovision
//   4. add `ios.ChatyyCallActivity` to credentials.json (EAS cloud)
//   5. set CHATYY_LIVE_ACTIVITY=1 in eas.json build.production.env (gate read
//      by plugins/with-live-activity.js on the EAS worker)
//
// [2026-10-09] The same extension (same bundle id / profile) also hosts the
// large-upload Live Activity (modules/expo-background-upload/ios/
// UploadLiveActivity.swift) — one profile turns on BOTH call and upload.
//
// NOT RUN AUTOMATICALLY. Modeled on scripts/asc-create-broadcast-profile.js
// (same auth, same cert). Idempotent: re-running reuses the bundle id and
// replaces only OUR CallActivity profile.
//
// Usage (from /root/webmail-app):   node scripts/asc-create-liveactivity-profile.js
// Dry run (no Apple writes):         DRY_RUN=1 node scripts/asc-create-liveactivity-profile.js
//
// Follow-ups it prints: gh secret set IOS_PROFILE_LIVEACT_BASE64 (CI — the
// ios-build-local.yml prebuild step turns CHATYY_LIVE_ACTIVITY on when that
// secret is present) and the Mac 207 profile install + IOS_LIVEACT_PROFILE_UUID.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KEY_ID = 'QSYM3KX73P';
const ISSUER = '494360d0-0420-4f1f-a1db-6be19eeb2d89';
const KEY_PATH = path.join(ROOT, 'asc_key.p8');
const BASE = 'https://api.appstoreconnect.apple.com/v1';

const EXT_TARGET_NAME = 'ChatyyCallActivity';
const EXT_IDENTIFIER = 'com.onemundo.mail.CallActivity';
const EXT_NAME = 'Chatyy Call Live Activity';
const DIST_CERT_ID = '85BYC8CH9Q'; // Apple Distribution: Aleff Pereira duarte
const PROFILE_PREFIX = 'Chatyy CallActivity AppStore';
const PROFILE_NAME = `${PROFILE_PREFIX} ${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
const OUT_PROFILE = path.join(ROOT, 'credentials', 'chatyy-liveactivity.mobileprovision');
const CREDENTIALS_JSON = path.join(ROOT, 'credentials.json');
const EAS_JSON = path.join(ROOT, 'eas.json');
const DRY_RUN = process.env.DRY_RUN === '1';

function jwt() {
  const header = { alg: 'ES256', kid: KEY_ID, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: ISSUER, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.createSign('SHA256').update(input)
    .sign({ key: fs.readFileSync(KEY_PATH), dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

const TOKEN = jwt();

async function api(method, p, body) {
  if (DRY_RUN && method !== 'GET') {
    console.log(`[dry-run] ${method} ${p} ${body ? JSON.stringify(body).slice(0, 200) : ''}`);
    return { data: { id: 'DRY_RUN', attributes: { uuid: 'DRY_RUN', profileContent: '' } } };
  }
  const opts = { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + p, opts);
  if (res.status === 204) return null;
  const txt = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${method} ${p}\n${txt.slice(0, 700)}`);
  return txt ? JSON.parse(txt) : null;
}

(async () => {
  // 1. Bundle id
  let extBundleId;
  const existing = await api('GET', `/bundleIds?filter[identifier]=${EXT_IDENTIFIER}&limit=5`);
  const exact = (existing.data || []).find(b => b.attributes.identifier === EXT_IDENTIFIER);
  if (exact) {
    extBundleId = exact.id;
    console.log(`✓ bundle já existe: ${extBundleId} (${EXT_IDENTIFIER})`);
  } else {
    console.log(`→ criando bundle ${EXT_IDENTIFIER}...`);
    const created = await api('POST', '/bundleIds', {
      data: { type: 'bundleIds', attributes: { identifier: EXT_IDENTIFIER, name: EXT_NAME, platform: 'IOS' } },
    });
    extBundleId = created.data.id;
    console.log(`✓ bundle criado: ${extBundleId}`);
  }

  // 2. Profile — replace only OUR previous CallActivity profiles
  const profiles = await api('GET', `/profiles?filter[profileType]=IOS_APP_STORE&limit=200`);
  for (const p of (profiles.data || [])) {
    const name = p.attributes.name || '';
    if (name.startsWith(PROFILE_PREFIX)) {
      console.log(`→ removendo profile antigo ${p.id} (${name})`);
      await api('DELETE', `/profiles/${p.id}`);
    }
  }
  console.log(`→ criando profile "${PROFILE_NAME}"...`);
  const profile = await api('POST', '/profiles', {
    data: {
      type: 'profiles',
      attributes: { name: PROFILE_NAME, profileType: 'IOS_APP_STORE' },
      relationships: {
        bundleId: { data: { type: 'bundleIds', id: extBundleId } },
        certificates: { data: [{ type: 'certificates', id: DIST_CERT_ID }] },
      },
    },
  });
  const profileB64 = profile.data.attributes.profileContent || '';
  const profileUuid = profile.data.attributes.uuid;
  console.log(`✓ profile criado: uuid=${profileUuid} id=${profile.data.id}`);

  if (DRY_RUN) { console.log('\n[dry-run] fim — nada escrito.'); return; }

  // 3. Write files + repo wiring
  const profileBytes = Buffer.from(profileB64, 'base64');
  fs.mkdirSync(path.dirname(OUT_PROFILE), { recursive: true });
  fs.writeFileSync(OUT_PROFILE, profileBytes);
  console.log(`✓ salvo ${path.relative(ROOT, OUT_PROFILE)}`);

  if (fs.existsSync(CREDENTIALS_JSON)) {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_JSON, 'utf8'));
    creds.ios = creds.ios || {};
    const main = creds.ios.Chatyy || {};
    creds.ios[EXT_TARGET_NAME] = {
      provisioningProfilePath: path.relative(ROOT, OUT_PROFILE),
      distributionCertificate: main.distributionCertificate || { path: 'credentials/apple-dist.p12', password: '' },
    };
    fs.writeFileSync(CREDENTIALS_JSON, JSON.stringify(creds, null, 2) + '\n');
    console.log(`✓ credentials.json: ios.${EXT_TARGET_NAME} adicionado`);
  } else {
    console.warn(`! credentials.json não encontrado — adicione ios.${EXT_TARGET_NAME} manualmente`);
  }

  if (fs.existsSync(EAS_JSON)) {
    const eas = JSON.parse(fs.readFileSync(EAS_JSON, 'utf8'));
    eas.build = eas.build || {};
    eas.build.production = eas.build.production || {};
    eas.build.production.env = Object.assign({}, eas.build.production.env, { CHATYY_LIVE_ACTIVITY: '1' });
    fs.writeFileSync(EAS_JSON, JSON.stringify(eas, null, 2) + '\n');
    console.log('✓ eas.json: build.production.env.CHATYY_LIVE_ACTIVITY=1');
  }

  console.log('\n=== SUCESSO ===');
  console.log(`Profile UUID: ${profileUuid}`);
  console.log('\nPróximos passos:');
  console.log(`  # CI (GitHub Actions ios-build-local.yml): o prebuild liga CHATYY_LIVE_ACTIVITY quando o secret existe`);
  console.log(`  gh secret set IOS_PROFILE_LIVEACT_BASE64 --repo aleffpereiraduarte-dev/Chatyy- --body "$(base64 -w0 < ${path.relative(ROOT, OUT_PROFILE)})"`);
  console.log(`  # Mac 207 (build local): copiar o .mobileprovision para ~/Library/MobileDevice/Provisioning\\ Profiles/${profileUuid}.mobileprovision`);
  console.log(`  #   e exportar CHATYY_LIVE_ACTIVITY=1 IOS_LIVEACT_PROFILE_UUID=${profileUuid} antes do prebuild (plugins/with-live-activity.js).`);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
