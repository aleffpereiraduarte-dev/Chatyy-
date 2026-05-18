// Patch ChatyyNotificationService target signing settings in the generated
// pbxproj. The with-notification-service Expo plugin sets CODE_SIGN_STYLE=Automatic;
// our CI uses Manual signing for every target. Mirrors patch-shareext-signing.js
// and patch-broadcast-signing.js verbatim — same fields, different bundle id
// + profile UUID.
//
// Why this script (vs just relying on ExportOptions.plist provisioningProfiles):
// xcodebuild's ARCHIVE phase reads PROVISIONING_PROFILE_SPECIFIER from the
// per-target XCBuildConfiguration in the pbxproj, NOT from ExportOptions.plist
// (that file only controls the EXPORT phase, after archive). Without the
// pbxproj patch, archive fails with "X requires a provisioning profile" even
// though the .mobileprovision is on disk and ExportOptions has the mapping.
const fs = require('fs');
const path = 'ios/Chatyy.xcodeproj/project.pbxproj';
let txt = fs.readFileSync(path, 'utf8');

const NSE_PROFILE = '695e2ec7-6a2f-4193-8919-9ad98a4e81c5';
const TEAM = 'XN9XN27QCE';
const NSE_BUNDLE = 'com.onemundo.mail.notificationservice';

txt = txt.replace(
  /(buildSettings = \{[^}]*?com\.onemundo\.mail\.notificationservice[^}]*?\};)/g,
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
      '\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "' + NSE_PROFILE + '";' +
      '\n\t\t\t\tPROVISIONING_PROFILE = "' + NSE_PROFILE + '";';
    return cleaned.replace(/\s*\};$/, inject + '\n\t\t\t};');
  }
);

fs.writeFileSync(path, txt);
console.log('Patched ChatyyNotificationService signing settings.');

const blocks = txt.match(/buildSettings = \{[^}]*?com\.onemundo\.mail\.notificationservice[^}]*?\};/g) || [];
console.log('ChatyyNotificationService buildSettings blocks:', blocks.length);
blocks.forEach((b, i) => {
  console.log('--- block', i, '---');
  ['CODE_SIGN_STYLE', 'DEVELOPMENT_TEAM', 'PROVISIONING_PROFILE_SPECIFIER', 'PROVISIONING_PROFILE'].forEach(k => {
    const m = b.match(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' = [^;]+;'));
    console.log(' ', m ? m[0] : `${k}: MISSING`);
  });
});
