#!/usr/bin/env node
// Inventory App Store Connect state for our app: bundle IDs, capabilities,
// certificates, profiles, iCloud containers, app groups. Read-only — no
// mutations. Used as a first step before regen-ios-profiles.js so we know
// what already exists and what needs to be created.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_ID = 'QSYM3KX73P';
const ISSUER = '494360d0-0420-4f1f-a1db-6be19eeb2d89';
const KEY_PATH = path.join(__dirname, '..', 'asc_key.p8');
const BASE = 'https://api.appstoreconnect.apple.com/v1';

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

async function api(path) {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${res.status} ${path}\n${txt.slice(0, 400)}`);
  }
  return res.json();
}

(async () => {
  // 1. Bundle IDs
  console.log('=== BUNDLE IDS ===');
  const bundles = await api(`/bundleIds?filter[identifier]=com.onemundo.mail,com.onemundo.mail.notificationservice,com.onemundo.mail.ShareExtension,com.onemundo.mail.BroadcastExtension&limit=20`);
  for (const b of bundles.data) {
    console.log(`  ${b.id}  ${b.attributes.identifier}  (${b.attributes.name})`);
  }
  const main = bundles.data.find(b => b.attributes.identifier === 'com.onemundo.mail');
  const nse = bundles.data.find(b => b.attributes.identifier === 'com.onemundo.mail.notificationservice');

  // 2. Capabilities on main app
  if (main) {
    console.log(`\n=== CAPABILITIES on ${main.attributes.identifier} ===`);
    const caps = await api(`/bundleIds/${main.id}/bundleIdCapabilities`);
    for (const c of caps.data) {
      console.log(`  ${c.attributes.capabilityType}`);
      if (c.attributes.settings) {
        console.log(`    settings: ${JSON.stringify(c.attributes.settings).slice(0, 200)}`);
      }
    }
  }

  // 3. Capabilities on NSE
  if (nse) {
    console.log(`\n=== CAPABILITIES on ${nse.attributes.identifier} ===`);
    const caps = await api(`/bundleIds/${nse.id}/bundleIdCapabilities`);
    for (const c of caps.data) {
      console.log(`  ${c.attributes.capabilityType}`);
    }
  } else {
    console.log(`\n=== NSE bundle ID does NOT exist yet ===`);
  }

  // 4. Certificates (Distribution)
  console.log('\n=== DISTRIBUTION CERTIFICATES ===');
  const certs = await api(`/certificates?filter[certificateType]=IOS_DISTRIBUTION,DISTRIBUTION&limit=20`);
  for (const c of certs.data) {
    console.log(`  ${c.id}  ${c.attributes.certificateType}  ${c.attributes.name}  expires=${c.attributes.expirationDate}`);
  }

  // 5. iCloud Containers
  console.log('\n=== iCLOUD CONTAINERS ===');
  try {
    const cont = await api(`/iCloudContainers?filter[identifier]=iCloud.com.onemundo.mail&limit=10`);
    for (const c of cont.data) {
      console.log(`  ${c.id}  ${c.attributes.identifier}  (${c.attributes.name})`);
    }
    if (cont.data.length === 0) console.log('  (none — needs to be created)');
  } catch (e) {
    console.log('  ERR', e.message);
  }

  // 6. App Groups
  console.log('\n=== APP GROUPS ===');
  try {
    const grp = await api(`/appGroups?filter[identifier]=group.com.onemundo.mail&limit=10`);
    for (const g of grp.data) {
      console.log(`  ${g.id}  ${g.attributes.identifier}  (${g.attributes.name})`);
    }
    if (grp.data.length === 0) console.log('  (none)');
  } catch (e) {
    console.log('  ERR', e.message);
  }

  // 7. Provisioning profiles — list all referencing our bundle IDs
  console.log('\n=== PROFILES ===');
  const profs = await api(`/profiles?filter[profileType]=IOS_APP_STORE&limit=200`);
  for (const p of profs.data) {
    if (p.attributes.name.toLowerCase().includes('chatyy') || p.attributes.name.toLowerCase().includes('onemundo') || p.attributes.name.toLowerCase().includes('shareext') || p.attributes.name.toLowerCase().includes('notification')) {
      console.log(`  ${p.id}  ${p.attributes.uuid}  ${p.attributes.profileState}  ${p.attributes.name}  expires=${p.attributes.expirationDate}`);
    }
  }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
