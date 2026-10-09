/**
 * [2026-10-09 system-integration] iCloud Drive backup (WhatsApp-style: the
 * encrypted chat backup lives in the user's own iCloud, hidden app container,
 * shown under Ajustes > [nome] > iCloud > Gerenciar armazenamento > Chatyy).
 *
 * Native side already exists: modules/expo-chat-backup/ios/ExpoChatBackupModule.swift
 * (ubiquity container iCloud.com.onemundo.mail; iCloudStatus / iCloudSaveFile /
 * iCloudListFiles / iCloudFetchFile used by services/chatBackupCloud.js).
 * Without these entitlements url(forUbiquityContainerIdentifier:) returns nil
 * and the app silently keeps the server/Drive paths.
 *
 * GATE — OFF by default, because the MAIN app's provisioning profile must carry
 * the iCloud capability first (otherwise the archive fails code-signing):
 *   CHATYY_ICLOUD=1 → adds the entitlements + NSUbiquitousContainers.
 *
 * PORTAL (founder, developer.apple.com — NOT done by this plugin):
 *   1. Identifiers > iCloud Containers > "+" > iCloud.com.onemundo.mail
 *   2. Identifiers > App IDs > com.onemundo.mail > Capabilities > iCloud
 *      (Include CloudKit support NOT required; "iCloud Documents" is enough)
 *      > Configure > select iCloud.com.onemundo.mail > Save
 *   3. Profiles > regenerate the App Store profile of com.onemundo.mail,
 *      update IOS_PROFILE base64 secret / Mac 207 profile, then build with
 *      CHATYY_ICLOUD=1.
 */
const { withEntitlementsPlist, withInfoPlist } = require('expo/config-plugins');

const CONTAINER = 'iCloud.com.onemundo.mail';

function gateOn() {
  const v = String(process.env.CHATYY_ICLOUD || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

function addUnique(arr, v) {
  const a = Array.isArray(arr) ? arr.slice() : [];
  if (!a.includes(v)) a.push(v);
  return a;
}

module.exports = function withICloudBackup(config) {
  if (!gateOn()) {
    console.log('[with-icloud-backup] OFF — CHATYY_ICLOUD!=1 (needs iCloud capability on com.onemundo.mail profile)');
    return config;
  }
  console.log('[with-icloud-backup] ON — iCloud Documents entitlements');
  config = withEntitlementsPlist(config, (cfg) => {
    const e = cfg.modResults;
    e['com.apple.developer.icloud-container-identifiers'] = addUnique(e['com.apple.developer.icloud-container-identifiers'], CONTAINER);
    e['com.apple.developer.icloud-services'] = addUnique(e['com.apple.developer.icloud-services'], 'CloudDocuments');
    e['com.apple.developer.ubiquity-container-identifiers'] = addUnique(e['com.apple.developer.ubiquity-container-identifiers'], CONTAINER);
    return cfg;
  });
  config = withInfoPlist(config, (cfg) => {
    const cur = cfg.modResults.NSUbiquitousContainers || {};
    cur[CONTAINER] = {
      // Hidden (like WhatsApp): not a browsable folder in Files; restore goes
      // through iCloudListFiles. Name shown in iCloud storage management.
      NSUbiquitousContainerIsDocumentScopePublic: false,
      NSUbiquitousContainerName: 'Chatyy',
      NSUbiquitousContainerSupportedFolderLevels: 'None',
    };
    cfg.modResults.NSUbiquitousContainers = cur;
    return cfg;
  });
  return config;
};
