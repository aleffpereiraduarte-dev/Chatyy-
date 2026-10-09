// [2026-10-09 universal-links] iOS Associated Domains entitlement:
//   applinks:chatyy.com.br        → Universal Links (/u, /j, /g, /ch, /live, /feed, /meet, /call, /chat, /stickers)
//   webcredentials:chatyy.com.br  → Passkeys (rpId chatyy.com.br) + password autofill
//
// GATED like with-notification-service's communicationNotifGate: an entitlement
// the provisioning profile lacks BREAKS code signing, and the current
// credentials/chatyy-main.mobileprovision does NOT carry
// com.apple.developer.associated-domains.
//   ON  when CHATYY_ASSOC_DOMAINS=1, or the main profile already contains the key
//       (after scripts/asc-enable-associated-domains.js regenerates it).
//   OFF when CHATYY_ASSOC_DOMAINS=0 (forced) or neither of the above.
// Android App Links need no plugin: app.json android.intentFilters (autoVerify).
const fs = require('fs');
const path = require('path');
const { withEntitlementsPlist } = require('expo/config-plugins');

const KEY = 'com.apple.developer.associated-domains';
const DOMAINS = ['applinks:chatyy.com.br', 'webcredentials:chatyy.com.br'];

function associatedDomainsGate(projectRoot) {
  const force = (process.env.CHATYY_ASSOC_DOMAINS || '').trim().toLowerCase();
  if (force === '0' || force === 'false' || force === 'off') return { on: false, why: 'CHATYY_ASSOC_DOMAINS=0' };
  if (force === '1' || force === 'true' || force === 'on') return { on: true, why: 'CHATYY_ASSOC_DOMAINS=1' };
  try {
    const prof = path.join(projectRoot || '', 'credentials', 'chatyy-main.mobileprovision');
    if (fs.existsSync(prof) && fs.readFileSync(prof).toString('latin1').includes(KEY)) {
      return { on: true, why: 'main profile carries the capability' };
    }
  } catch {}
  return { on: false, why: 'main profile lacks the capability — run scripts/asc-enable-associated-domains.js' };
}

module.exports = function withAssociatedDomains(config) {
  return withEntitlementsPlist(config, (cfg) => {
    const gate = associatedDomainsGate(cfg.modRequest.projectRoot);
    if (gate.on) {
      const cur = Array.isArray(cfg.modResults[KEY]) ? cfg.modResults[KEY] : [];
      cfg.modResults[KEY] = Array.from(new Set([...cur, ...DOMAINS]));
    } else {
      delete cfg.modResults[KEY];
    }
    console.log(`[with-associated-domains] Associated Domains ${gate.on ? 'ON' : 'OFF'} (${gate.why})`);
    return cfg;
  });
};
module.exports.associatedDomainsGate = associatedDomainsGate;
