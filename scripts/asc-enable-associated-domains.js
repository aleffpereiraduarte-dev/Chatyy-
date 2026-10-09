#!/usr/bin/env node
// [2026-10-09 universal-links + passkeys] Enable the "Associated Domains"
// capability (com.apple.developer.associated-domains) on the MAIN app bundle
// com.onemundo.mail through the App Store Connect API, regenerate the main App
// Store provisioning profile so it carries the entitlement, and save it to
// credentials/chatyy-main.mobileprovision. plugins/with-associated-domains.js
// adds applinks:chatyy.com.br + webcredentials:chatyy.com.br ONLY when the main
// profile contains the key (or CHATYY_ASSOC_DOMAINS=1), so builds never break
// before this runs. Any other capability already enabled on the bundle (e.g.
// Communication Notifications) is carried by the new profile automatically.
//
// Usage (from /root/webmail-app):  node scripts/asc-enable-associated-domains.js
// Dry run (no Apple writes):        DRY_RUN=1 node scripts/asc-enable-associated-domains.js
// NOT run automatically — the founder/agent runs it on purpose.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KEY_ID = 'QSYM3KX73P';
const ISSUER = '494360d0-0420-4f1f-a1db-6be19eeb2d89';
const KEY_PATH = path.join(ROOT, 'asc_key.p8');
const BASE = 'https://api.appstoreconnect.apple.com/v1';

const MAIN_IDENTIFIER = 'com.onemundo.mail';
const MAIN_BUNDLE_RESOURCE_ID = 'J4X7H3GDFA'; // com.onemundo.mail (asc-inventory)
const DIST_CERT_ID = '85BYC8CH9Q';            // Apple Distribution: Aleff Pereira duarte
const CAPABILITY = 'ASSOCIATED_DOMAINS';
const ENTITLEMENT = 'com.apple.developer.associated-domains';
const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const PROFILE_PREFIX = 'Chatyy Main AppStore AssocDomains';
const PROFILE_NAME = `${PROFILE_PREFIX} ${STAMP}`;
const OUT_PROFILE = path.join(ROOT, 'credentials', 'chatyy-main.mobileprovision');
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

function manualSteps() {
  return [
    '',
    '=== AÇÃO MANUAL (se a API recusar a capability) ===',
    '1. https://developer.apple.com/account/resources/identifiers/list',
    `2. Abrir "${MAIN_IDENTIFIER}" → Capabilities → marcar "Associated Domains" → Save`,
    '3. Rodar este script de novo (ele só regenera o profile e verifica).',
    '',
  ].join('\n');
}

(async () => {
  // 1. Capability on the main bundle
  const caps = await api('GET', `/bundleIds/${MAIN_BUNDLE_RESOURCE_ID}/bundleIdCapabilities`);
  const has = (caps.data || []).some(c => c.attributes.capabilityType === CAPABILITY);
  if (has) {
    console.log(`✓ ${CAPABILITY} já habilitada em ${MAIN_IDENTIFIER}`);
  } else {
    console.log(`→ habilitando ${CAPABILITY} em ${MAIN_IDENTIFIER}...`);
    try {
      await api('POST', '/bundleIdCapabilities', {
        data: {
          type: 'bundleIdCapabilities',
          attributes: { capabilityType: CAPABILITY },
          relationships: { bundleId: { data: { type: 'bundleIds', id: MAIN_BUNDLE_RESOURCE_ID } } },
        },
      });
      console.log(`✓ ${CAPABILITY} habilitada`);
    } catch (e) {
      console.error(`✗ API recusou ${CAPABILITY}: ${e.message.split('\n')[0]}`);
      console.error(manualSteps());
      process.exit(2);
    }
  }

  // 2. New App Store profile for the main bundle (keeps older ones)
  const profiles = await api('GET', `/profiles?filter[profileType]=IOS_APP_STORE&limit=200`);
  for (const p of (profiles.data || [])) {
    const name = p.attributes.name || '';
    if (name.startsWith(PROFILE_PREFIX) && name !== PROFILE_NAME) {
      console.log(`→ removendo profile antigo deste script ${p.id} (${name})`);
      await api('DELETE', `/profiles/${p.id}`);
    } else if (name === PROFILE_NAME) {
      console.log(`→ removendo profile homônimo ${p.id} (re-run no mesmo dia)`);
      await api('DELETE', `/profiles/${p.id}`);
    }
  }
  console.log(`→ criando profile "${PROFILE_NAME}"...`);
  const profile = await api('POST', '/profiles', {
    data: {
      type: 'profiles',
      attributes: { name: PROFILE_NAME, profileType: 'IOS_APP_STORE' },
      relationships: {
        bundleId: { data: { type: 'bundleIds', id: MAIN_BUNDLE_RESOURCE_ID } },
        certificates: { data: [{ type: 'certificates', id: DIST_CERT_ID }] },
      },
    },
  });
  const profileB64 = profile.data.attributes.profileContent || '';
  const profileUuid = profile.data.attributes.uuid;
  console.log(`✓ profile criado: uuid=${profileUuid} id=${profile.data.id}`);
  if (DRY_RUN) { console.log('\n[dry-run] fim — nada escrito.'); return; }

  // 3. Verify
  const bytes = Buffer.from(profileB64, 'base64');
  const txt = bytes.toString('latin1');
  if (!txt.includes(ENTITLEMENT)) {
    console.error(`\n✗ O profile NÃO contém ${ENTITLEMENT}. Não salvei nada.`);
    console.error(manualSteps());
    process.exit(3);
  }
  for (const must of ['aps-environment', 'group.com.onemundo.mail']) {
    if (!txt.includes(must)) console.warn(`! atenção: profile novo não contém "${must}" — confira antes de usar`);
  }
  console.log(`✓ profile contém ${ENTITLEMENT}`);

  // 4. Save (backup the previous main profile)
  fs.mkdirSync(path.dirname(OUT_PROFILE), { recursive: true });
  if (fs.existsSync(OUT_PROFILE)) {
    const bak = `${OUT_PROFILE}.bak-${STAMP}`;
    fs.copyFileSync(OUT_PROFILE, bak);
    console.log(`✓ backup ${path.relative(ROOT, bak)}`);
  }
  fs.writeFileSync(OUT_PROFILE, bytes);
  console.log(`✓ salvo ${path.relative(ROOT, OUT_PROFILE)}`);

  console.log('\n=== SUCESSO ===');
  console.log(`Profile UUID: ${profileUuid}`);
  console.log('\nPróximos passos:');
  console.log('  # CI (GitHub Actions build-native.yml decodifica IOS_PROFILE_MAIN_BASE64):');
  console.log(`  gh secret set IOS_PROFILE_MAIN_BASE64 --repo aleffpereiraduarte-dev/Chatyy- --body "$(base64 -w0 < ${path.relative(ROOT, OUT_PROFILE)})"`);
  console.log(`  # Mac 207: instalar em ~/Library/MobileDevice/Provisioning\\ Profiles/${profileUuid}.mobileprovision`);
  console.log(`  #   e exportar IOS_MAIN_PROFILE_UUID=${profileUuid} (plugins/withManualIosSigning.js) + CHATYY_ASSOC_DOMAINS=1 antes do prebuild.`);
  console.log('  # O plugin with-associated-domains liga o entitlement sozinho quando o profile o contém');
  console.log('  #   (ou force com CHATYY_ASSOC_DOMAINS=1 no env do build). Depois: build iOS + TestFlight.');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
