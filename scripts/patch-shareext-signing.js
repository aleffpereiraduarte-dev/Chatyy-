const fs = require('fs');
const path = 'ios/Chatyy.xcodeproj/project.pbxproj';
let txt = fs.readFileSync(path, 'utf8');

const SHAREEXT_PROFILE = 'd302e18b-f58a-43b8-8b1f-9bf4b2d05194';
const TEAM = 'XN9XN27QCE';

txt = txt.replace(
  /(buildSettings = \{[^}]*?com\.onemundo\.mail\.share-extension[^}]*?\};)/g,
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
      '\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "' + SHAREEXT_PROFILE + '";' +
      '\n\t\t\t\tPROVISIONING_PROFILE = "' + SHAREEXT_PROFILE + '";';
    return cleaned.replace(/\s*\};$/, inject + '\n\t\t\t};');
  }
);

fs.writeFileSync(path, txt);
console.log('Patched ShareExtension signing settings.');

const blocks = txt.match(/buildSettings = \{[^}]*?com\.onemundo\.mail\.share-extension[^}]*?\};/g) || [];
console.log('ShareExtension buildSettings blocks:', blocks.length);
blocks.forEach((b, i) => {
  console.log('--- block', i, '---');
  ['CODE_SIGN_STYLE', 'DEVELOPMENT_TEAM', 'PROVISIONING_PROFILE_SPECIFIER', 'PROVISIONING_PROFILE'].forEach(k => {
    const m = b.match(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' = [^;]+;'));
    console.log(' ', m ? m[0] : `${k}: MISSING`);
  });
});
