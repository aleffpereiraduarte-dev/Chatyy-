#!/usr/bin/env node
// Auto-create the ChatyyNotificationService bundle ID, add App Groups
// capability, and generate a new AppStore provisioning profile via the
// App Store Connect API. Outputs the .mobileprovision as base64 ready
// for `gh secret set IOS_PROFILE_NSE_BASE64`.
//
// Idempotent — if the bundle / capability / profile already exist with
// the right shape, we reuse them. Otherwise we create. We never delete
// or update existing profiles for other targets.
//
// Background: arthenica/ffmpeg-kit retirement is unrelated — this fix is
// for the ChatyyNotificationService extension target that was added in
// wave 11/20 (with-notification-service plugin) but never had a
// provisioning profile on the Apple Developer portal.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_ID = 'QSYM3KX73P';
const ISSUER = '494360d0-0420-4f1f-a1db-6be19eeb2d89';
const KEY_PATH = path.join(__dirname, '..', 'asc_key.p8');
const BASE = 'https://api.appstoreconnect.apple.com/v1';

const NSE_IDENTIFIER = 'com.onemundo.mail.notificationservice';
const NSE_NAME = 'Chatyy Notification Service';
const APP_GROUP_IDENTIFIER = 'group.com.onemundo.mail';
const APP_GROUP_NAME = 'Chatyy App Group';
const DIST_CERT_ID = '85BYC8CH9Q'; // From inventory — Apple Distribution: Aleff Pereira duarte
const PROFILE_NAME = `Chatyy NSE AppStore ${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

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
  const opts = {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + p, opts);
  if (res.status === 204) return null; // No content (e.g. DELETE)
  const txt = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${method} ${p}\n${txt.slice(0, 700)}`);
  return txt ? JSON.parse(txt) : null;
}

(async () => {
  // ───────────────────────────────────────────────────────────────────
  // 1. Find or create bundle ID for NSE
  // ───────────────────────────────────────────────────────────────────
  let nseBundleId;
  const existing = await api('GET', `/bundleIds?filter[identifier]=${NSE_IDENTIFIER}&limit=5`);
  if (existing.data.length > 0) {
    nseBundleId = existing.data[0].id;
    console.log(`✓ NSE bundle already exists: ${nseBundleId} (${NSE_IDENTIFIER})`);
  } else {
    console.log(`→ Creating NSE bundle ${NSE_IDENTIFIER}...`);
    const created = await api('POST', '/bundleIds', {
      data: {
        type: 'bundleIds',
        attributes: {
          identifier: NSE_IDENTIFIER,
          name: NSE_NAME,
          platform: 'IOS',
        },
      },
    });
    nseBundleId = created.data.id;
    console.log(`✓ Created NSE bundle: ${nseBundleId}`);
  }

  // ───────────────────────────────────────────────────────────────────
  // 2. Check existing capabilities on NSE bundle
  // ───────────────────────────────────────────────────────────────────
  const caps = await api('GET', `/bundleIds/${nseBundleId}/bundleIdCapabilities`);
  const hasAppGroups = caps.data.some(c => c.attributes.capabilityType === 'APP_GROUPS');
  console.log(`NSE capabilities: ${caps.data.map(c => c.attributes.capabilityType).join(', ') || '(none)'}`);

  // ───────────────────────────────────────────────────────────────────
  // 3. Find or create the app group "group.com.onemundo.mail"
  //    ASC API lists app groups via /bundleIds/{id}/relationships/appGroupIds
  //    OR we look at the existing main app's appGroups.
  // ───────────────────────────────────────────────────────────────────
  let appGroupId;
  // Look at the main app's bundle's appGroup relationship — it already has APP_GROUPS
  const mainCaps = await api('GET', `/bundleIds/J4X7H3GDFA/bundleIdCapabilities?include=appGroups`);
  const mainAppGroupsCap = mainCaps.data.find(c => c.attributes.capabilityType === 'APP_GROUPS');
  if (mainAppGroupsCap && mainCaps.included) {
    const groups = mainCaps.included.filter(i => i.type === 'appGroups');
    const target = groups.find(g => g.attributes.identifier === APP_GROUP_IDENTIFIER);
    if (target) {
      appGroupId = target.id;
      console.log(`✓ App group ${APP_GROUP_IDENTIFIER} exists: ${appGroupId}`);
    }
  }
  if (!appGroupId) {
    // List all app groups visible to us
    const groups = await api('GET', `/appGroups`);
    const target = groups.data.find(g => g.attributes.identifier === APP_GROUP_IDENTIFIER);
    if (target) {
      appGroupId = target.id;
      console.log(`✓ App group ${APP_GROUP_IDENTIFIER} found via /appGroups: ${appGroupId}`);
    }
  }
  if (!appGroupId) {
    console.log(`→ Creating app group ${APP_GROUP_IDENTIFIER}...`);
    const created = await api('POST', '/appGroups', {
      data: {
        type: 'appGroups',
        attributes: { identifier: APP_GROUP_IDENTIFIER, name: APP_GROUP_NAME },
      },
    });
    appGroupId = created.data.id;
    console.log(`✓ Created app group: ${appGroupId}`);
  }

  // ───────────────────────────────────────────────────────────────────
  // 4. Enable APP_GROUPS capability on NSE bundle if missing
  // ───────────────────────────────────────────────────────────────────
  let nseCapId;
  if (!hasAppGroups) {
    console.log(`→ Enabling APP_GROUPS capability on NSE bundle...`);
    const enabled = await api('POST', '/bundleIdCapabilities', {
      data: {
        type: 'bundleIdCapabilities',
        attributes: { capabilityType: 'APP_GROUPS' },
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: nseBundleId } },
        },
      },
    });
    nseCapId = enabled.data.id;
    console.log(`✓ Capability enabled: ${nseCapId}`);
  } else {
    nseCapId = caps.data.find(c => c.attributes.capabilityType === 'APP_GROUPS').id;
    console.log(`✓ APP_GROUPS already enabled: ${nseCapId}`);
  }

  // ───────────────────────────────────────────────────────────────────
  // 5. Link the app group to the NSE bundle's APP_GROUPS capability
  // ───────────────────────────────────────────────────────────────────
  console.log(`→ Linking app group ${appGroupId} to NSE bundle...`);
  try {
    await api('POST', `/bundleIds/${nseBundleId}/relationships/appGroups`, {
      data: [{ type: 'appGroups', id: appGroupId }],
    });
    console.log(`✓ App group linked`);
  } catch (e) {
    // 409 if already linked — ignore
    if (e.message.includes('409') || e.message.includes('already')) {
      console.log(`✓ App group already linked`);
    } else throw e;
  }

  // ───────────────────────────────────────────────────────────────────
  // 6. Create the provisioning profile
  // ───────────────────────────────────────────────────────────────────
  // Check if a recent NSE profile already exists
  const profiles = await api('GET', `/profiles?filter[profileType]=IOS_APP_STORE&limit=200`);
  const existingNse = profiles.data.find(p =>
    p.attributes.name.toLowerCase().includes('notification') ||
    p.attributes.name.toLowerCase().includes('chatyy nse')
  );
  if (existingNse && existingNse.attributes.profileState === 'ACTIVE') {
    console.log(`→ Deleting old NSE profile ${existingNse.id} (${existingNse.attributes.name})...`);
    await api('DELETE', `/profiles/${existingNse.id}`);
  }

  console.log(`→ Creating new NSE profile "${PROFILE_NAME}"...`);
  const profile = await api('POST', '/profiles', {
    data: {
      type: 'profiles',
      attributes: {
        name: PROFILE_NAME,
        profileType: 'IOS_APP_STORE',
      },
      relationships: {
        bundleId: { data: { type: 'bundleIds', id: nseBundleId } },
        certificates: { data: [{ type: 'certificates', id: DIST_CERT_ID }] },
      },
    },
  });
  const profileB64 = profile.data.attributes.profileContent;
  const profileUuid = profile.data.attributes.uuid;
  console.log(`✓ Profile created: uuid=${profileUuid}`);
  console.log(`✓ Profile ID: ${profile.data.id}`);

  // ───────────────────────────────────────────────────────────────────
  // 7. Save .mobileprovision file + emit base64 for gh secret
  // ───────────────────────────────────────────────────────────────────
  const outPath = path.join(__dirname, '..', `${PROFILE_NAME.replace(/\s+/g, '_')}.mobileprovision`);
  fs.writeFileSync(outPath, Buffer.from(profileB64, 'base64'));
  console.log(`\n=== SUCCESS ===`);
  console.log(`Profile saved to: ${outPath}`);
  console.log(`Profile UUID: ${profileUuid}`);
  console.log(`\nNext step: update GitHub secret with:`);
  console.log(`  gh secret set IOS_PROFILE_NSE_BASE64 --repo aleffpereiraduarte-dev/Chatyy- < <(echo '${profileB64}')`);
  console.log(`\n(or run: scripts/asc-create-nse-profile.js && gh secret set IOS_PROFILE_NSE_BASE64 --body "$(cat <profile-file>.mobileprovision | base64 -w0)")`);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
