// [2026-05-15 #827] Patch ChatyyBroadcastExtension target in project.pbxproj
// to use Manual signing with the broadcast provisioning profile. The Expo
// config plugin (with-broadcast-extension.js) sets CODE_SIGN_STYLE=Automatic
// in the buildSettings it generates, but our CI uses Manual signing across
// all targets (the main app + ShareExtension are already Manual). Leaving
// Broadcast on Automatic causes xcodebuild to fail with
// "No profiles for 'com.onemundo.mail.broadcast' were found" because
// Automatic looks for an Xcode-managed profile in the keychain that doesn't
// exist on the GitHub Actions runner.
//
// This script mirrors patch-shareext-signing.js but for the broadcast
// extension. The provisioning profile UUID is read from env BROADCAST_UUID
// (set by the workflow Install provisioning profiles step) since each user
// generates their own profile and Apple assigns a unique UUID per profile.

const fs = require('fs');
const path = 'ios/Chatyy.xcodeproj/project.pbxproj';
let txt = fs.readFileSync(path, 'utf8');

const BROADCAST_PROFILE = process.env.BROADCAST_UUID;
if (!BROADCAST_PROFILE) {
  console.error('::error::BROADCAST_UUID env not set — workflow step "Install provisioning profiles" must export it.');
  process.exit(1);
}
const TEAM = 'XN9XN27QCE';

txt = txt.replace(
  /(buildSettings = \{[^}]*?com\.onemundo\.mail\.broadcast[^}]*?\};)/g,
  (block) => {
    let cleaned = block
      .replace(/\s+CODE_SIGN_STYLE = [^;]+;/g, '')
      .replace(/\s+PROVISIONING_PROFILE = [^;]+;/g, '')
      .replace(/\s+PROVISIONING_PROFILE_SPECIFIER = [^;]+;/g, '')
      .replace(/\s+"CODE_SIGN_IDENTITY\[sdk=iphoneos\*\]" = [^;]+;/g, '')
      .replace(/\s+CODE_SIGN_IDENTITY = [^;]+;/g, '')
      .replace(/\s+DEVELOPMENT_TEAM = [^;]+;/g, '');
    const inject =
      '\n\t\t\t\tCODE_SIGN_STYLE = Manual;' +
      '\n\t\t\t\tDEVELOPMENT_TEAM = ' + TEAM + ';' +
      '\n\t\t\t\tCODE_SIGN_IDENTITY = "Apple Distribution";' +
      '\n\t\t\t\t"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";' +
      '\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "' + BROADCAST_PROFILE + '";' +
      '\n\t\t\t\tPROVISIONING_PROFILE = "' + BROADCAST_PROFILE + '";';
    return cleaned.replace(/\s*\};$/, inject + '\n\t\t\t};');
  }
);

fs.writeFileSync(path, txt);
console.log('Patched BroadcastExtension signing with profile UUID:', BROADCAST_PROFILE);

const blocks = txt.match(/buildSettings = \{[^}]*?com\.onemundo\.mail\.broadcast[^}]*?\};/g) || [];
console.log('BroadcastExtension buildSettings blocks:', blocks.length);
blocks.forEach((b, i) => {
  console.log('--- block', i, '---');
  ['CODE_SIGN_STYLE', 'DEVELOPMENT_TEAM', 'PROVISIONING_PROFILE_SPECIFIER', 'PROVISIONING_PROFILE'].forEach(k => {
    const m = b.match(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' = [^;]+;'));
    console.log(' ', m ? m[0] : `${k}: MISSING`);
  });
});
