#!/usr/bin/env node
// [2026-10-06 screen-share iOS] Provision the ChatyyBroadcastExtension
// (ReplayKit Broadcast Upload Extension, bundle com.onemundo.mail.broadcast)
// through the App Store Connect API, then wire the result into the repo so
// the next iOS build embeds the extension:
//
//   1. find/create bundle id com.onemundo.mail.broadcast
//   2. enable APP_GROUPS on it and link group.com.onemundo.mail
//   3. create an App Store provisioning profile (Apple Distribution cert)
//   4. save credentials/chatyy-broadcast.mobileprovision
//   5. add `ios.ChatyyBroadcastExtension` to credentials.json (EAS cloud)
//   6. set CHATYY_BROADCAST_EXT=1 in eas.json build.production.env (the gate
//      plugins/with-broadcast-extension.js reads on the EAS worker, where the
//      gitignored credentials/ folder is not present)
//   7. verify the profile actually carries the App Group entitlement — the
//      extension's entitlements request it, so a profile without it fails
//      code signing. If Apple's API refused the link, the script prints the
//      manual developer.apple.com steps and exits non-zero.
//
// Modeled on scripts/asc-create-nse-profile.js (same auth, same cert).
// Idempotent: re-running reuses bundle id / capability / group and replaces
// only OUR broadcast profile.
//
// Usage (from /root/webmail-app):   node scripts/asc-create-broadcast-profile.js
// Dry run (no Apple writes):         DRY_RUN=1 node scripts/asc-create-broadcast-profile.js
//
// Follow-ups it prints: gh secret set IOS_PROFILE_BROADCAST_BASE64 (CI) and
// the Mac 207 profile install + IOS_BROADCAST_PROFILE_UUID for local builds.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KEY_ID = 'QSYM3KX73P';
const ISSUER = '494360d0-0420-4f1f-a1db-6be19eeb2d89';
const KEY_PATH = path.join(ROOT, 'asc_key.p8');
const BASE = 'https://api.appstoreconnect.apple.com/v1';

const EXT_TARGET_NAME = 'ChatyyBroadcastExtension';
const EXT_IDENTIFIER = 'com.onemundo.mail.broadcast';
const EXT_NAME = 'Chatyy Broadcast Extension';
const MAIN_BUNDLE_RESOURCE_ID = 'J4X7H3GDFA'; // com.onemundo.mail (from asc-inventory)
const APP_GROUP_IDENTIFIER = 'group.com.onemundo.mail';
const APP_GROUP_NAME = 'Chatyy App Group';
const DIST_CERT_ID = '85BYC8CH9Q'; // Apple Distribution: Aleff Pereira duarte
const PROFILE_PREFIX = 'Chatyy Broadcast AppStore';
const PROFILE_NAME = `${PROFILE_PREFIX} ${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
const OUT_PROFILE = path.join(ROOT, 'credentials', 'chatyy-broadcast.mobileprovision');
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

function manualAppGroupInstructions() {
  return [
    '',
    '=== AÇÃO MANUAL NECESSÁRIA (App Group) ===',
    '1. https://developer.apple.com/account/resources/identifiers/list',
    `2. Abrir "${EXT_IDENTIFIER}" → Capabilities → App Groups → Configure`,
    `3. Marcar "${APP_GROUP_IDENTIFIER}" → Continue → Save`,
    '4. Rodar este script de novo (ele regenera o profile já com o grupo).',
    '',
  ].join('\n');
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

  // 2. App group id (prefer the one already linked to the main app)
  let appGroupId;
  try {
    const mainCaps = await api('GET', `/bundleIds/${MAIN_BUNDLE_RESOURCE_ID}/bundleIdCapabilities?include=appGroups`);
    const groups = (mainCaps.included || []).filter(i => i.type === 'appGroups');
    const target = groups.find(g => g.attributes.identifier === APP_GROUP_IDENTIFIER);
    if (target) appGroupId = target.id;
  } catch (e) {
    console.log(`(main app capabilities lookup failed: ${e.message.split('\n')[0]})`);
  }
  if (!appGroupId) {
    try {
      const groups = await api('GET', `/appGroups?limit=200`);
      const target = (groups.data || []).find(g => g.attributes.identifier === APP_GROUP_IDENTIFIER);
      if (target) appGroupId = target.id;
    } catch (e) {
      console.log(`(/appGroups lookup failed: ${e.message.split('\n')[0]})`);
    }
  }
  if (!appGroupId && !DRY_RUN) {
    // [2026-10-06] A API pública do ASC NÃO expõe /appGroups (404 "path does
    // not match a defined resource type"). O grupo já existe no portal (usado
    // pelo app + NSE) — segue sem criar; o check do profile abaixo decide.
    try {
      console.log(`→ criando app group ${APP_GROUP_IDENTIFIER}...`);
      const created = await api('POST', '/appGroups', {
        data: { type: 'appGroups', attributes: { identifier: APP_GROUP_IDENTIFIER, name: APP_GROUP_NAME } },
      });
      appGroupId = created.data.id;
    } catch (e) {
      console.log(`! /appGroups indisponível na API (${e.message.split('\n')[0]}) — assumindo grupo já existente no portal`);
    }
  }
  console.log(`✓ app group: ${appGroupId || '(dry-run)'}`);

  // 3. APP_GROUPS capability on the extension bundle
  const caps = extBundleId === 'DRY_RUN' ? { data: [] } : await api('GET', `/bundleIds/${extBundleId}/bundleIdCapabilities`);
  const hasAppGroups = (caps.data || []).some(c => c.attributes.capabilityType === 'APP_GROUPS');
  if (!hasAppGroups) {
    console.log('→ habilitando APP_GROUPS no bundle da extensão...');
    await api('POST', '/bundleIdCapabilities', {
      data: {
        type: 'bundleIdCapabilities',
        attributes: { capabilityType: 'APP_GROUPS' },
        relationships: { bundleId: { data: { type: 'bundleIds', id: extBundleId } } },
      },
    });
    console.log('✓ APP_GROUPS habilitado');
  } else {
    console.log('✓ APP_GROUPS já habilitado');
  }

  // 4. Link the group (Apple's public API only partially exposes this; fall
  //    back to manual portal steps if it refuses — the profile check below is
  //    what decides whether we are actually good).
  let linkOk = false;
  if (appGroupId) {
    try {
      await api('POST', `/bundleIds/${extBundleId}/relationships/appGroups`, {
        data: [{ type: 'appGroups', id: appGroupId }],
      });
      linkOk = true;
      console.log('✓ app group vinculado ao bundle da extensão');
    } catch (e) {
      if (/409|already/i.test(e.message)) { linkOk = true; console.log('✓ app group já vinculado'); }
      else console.log(`! vínculo via API falhou (${e.message.split('\n')[0]}) — vou checar o profile`);
    }
  }

  // 5. Profile — replace only OUR previous broadcast profiles
  const profiles = await api('GET', `/profiles?filter[profileType]=IOS_APP_STORE&limit=200`);
  for (const p of (profiles.data || [])) {
    const name = p.attributes.name || '';
    if (name.startsWith(PROFILE_PREFIX) || /broadcast/i.test(name)) {
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

  // 6. Verify the App Group is inside the profile's entitlements. The CMS
  //    blob embeds the entitlements plist as plain XML, so a substring search
  //    is enough.
  const profileBytes = Buffer.from(profileB64, 'base64');
  const hasGroupInProfile = profileBytes.toString('latin1').includes(APP_GROUP_IDENTIFIER);
  if (!hasGroupInProfile) {
    console.error(`\n✗ O profile NÃO contém ${APP_GROUP_IDENTIFIER} (vínculo API ${linkOk ? 'ok' : 'falhou'}).`);
    console.error('  Assinar a extensão com ele falharia (entitlements pedem o App Group).');
    console.error(manualAppGroupInstructions());
    process.exit(2);
  }
  console.log(`✓ profile contém ${APP_GROUP_IDENTIFIER}`);

  // 7. Write files + repo wiring
  fs.mkdirSync(path.dirname(OUT_PROFILE), { recursive: true });
  fs.writeFileSync(OUT_PROFILE, profileBytes);
  console.log(`✓ salvo ${path.relative(ROOT, OUT_PROFILE)}`);

  // credentials.json: ios.ChatyyBroadcastExtension (same cert as the app)
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
    console.warn('! credentials.json não encontrado — adicione ios.ChatyyBroadcastExtension manualmente');
  }

  // eas.json: gate for the config plugin on the EAS worker
  if (fs.existsSync(EAS_JSON)) {
    const eas = JSON.parse(fs.readFileSync(EAS_JSON, 'utf8'));
    eas.build = eas.build || {};
    eas.build.production = eas.build.production || {};
    eas.build.production.env = Object.assign({}, eas.build.production.env, { CHATYY_BROADCAST_EXT: '1' });
    fs.writeFileSync(EAS_JSON, JSON.stringify(eas, null, 2) + '\n');
    console.log('✓ eas.json: build.production.env.CHATYY_BROADCAST_EXT=1');
  }

  console.log('\n=== SUCESSO ===');
  console.log(`Profile UUID: ${profileUuid}`);
  console.log('\nPróximos passos:');
  console.log(`  # CI (GitHub Actions ios-build-local.yml)`);
  console.log(`  gh secret set IOS_PROFILE_BROADCAST_BASE64 --repo aleffpereiraduarte-dev/Chatyy- --body "$(base64 -w0 < ${path.relative(ROOT, OUT_PROFILE)})"`);
  console.log(`  # Mac 207 (build local): copiar o .mobileprovision para ~/Library/MobileDevice/Provisioning\\ Profiles/${profileUuid}.mobileprovision`);
  console.log(`  #   e exportar IOS_BROADCAST_PROFILE_UUID=${profileUuid} antes do prebuild (plugins/withManualIosSigning.js).`);
  console.log(`  # EAS cloud: credentials.json + eas.json já ajustados — commit eas.json; depois build iOS normal (TestFlight).`);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
