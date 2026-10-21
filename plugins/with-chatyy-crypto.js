/**
 * [e2ee5 WP-03] Config plugin do núcleo E2EE v5 (modules/expo-chatyy-crypto).
 *
 * GATE: só age quando o núcleo vai no binário — os artefatos do WP-02 estão no módulo
 * (native/chatyy-crypto/ci/fetch-prebuilt.sh, input `chatyy_crypto=true` dos workflows) ou
 * CHATYY_CRYPTO=1. Build normal (sem artefatos) = NADA muda (o módulo compila como stub).
 * CHATYY_CRYPTO=0 desliga mesmo com artefatos.
 *
 * iOS (CONTRATO §1.3/§6.10: senha do store e device_id no Keychain, compartilhados app+NSE+extensões):
 *   - app: keychain-access-groups = [$(AppIdentifierPrefix)com.onemundo.mail (1º → o grupo PADRÃO
 *     dos itens que os outros módulos gravam NÃO muda), $(AppIdentifierPrefix)com.onemundo.mail.e2ee5];
 *     Info.plist ChatyyE2EE5KeychainGroup = $(AppIdentifierPrefix)com.onemundo.mail.e2ee5.
 *   - NSE (ChatyyNotificationService) e ShareExtension: o mesmo par (próprio bundle id 1º), aplicado
 *     no mod FINALIZED (depois que with-notification-service / expo-share-intent escreveram os
 *     .entitlements). CHATYY_CRYPTO_EXT_KEYCHAIN=0 pula as extensões.
 *   Os perfis atuais (credentials/*.mobileprovision: main, nse, shareext) já trazem
 *   keychain-access-groups = XN9XN27QCE.* — o grupo novo não exige perfil novo.
 *   O App Group (group.com.onemundo.mail) do app já existe; o da NSE segue o gate
 *   CHATYY_NSE_APP_GROUP do with-notification-service (sem ele a NSE não abre o store: WP-10).
 *
 * Android (store em noBackupFilesDir/e2ee5, já fora do Auto Backup/D2D pelo sistema):
 *   - por garantia, acrescenta <exclude domain="root" path="no_backup/e2ee5/"/> nos XML de backup
 *     que o manifesto referencia (fullBackupContent / dataExtractionRules), sem criar seções novas.
 *   - R8: as regras de JNA/bindings vêm do consumer-rules.pro do módulo.
 */
const fs = require('fs');
const path = require('path');
const { withEntitlementsPlist, withInfoPlist, withFinalizedMod, AndroidConfig } = require('@expo/config-plugins');

const MODULE_DIR = path.join(__dirname, '..', 'modules', 'expo-chatyy-crypto');
const GROUP_SUFFIX = 'com.onemundo.mail.e2ee5';
const PREFIX = '$(AppIdentifierPrefix)';
const SHARED_GROUP = PREFIX + GROUP_SUFFIX;
const EXTENSIONS = [
  { dir: 'ChatyyNotificationService', file: 'ChatyyNotificationService.entitlements', bundle: 'com.onemundo.mail.notificationservice' },
  { dir: 'ShareExtension', file: 'ShareExtension.entitlements', bundle: 'com.onemundo.mail.share-extension' },
];
const ANDROID_EXCLUDE = '<exclude domain="root" path="no_backup/e2ee5/" />';
const TAG = '[with-chatyy-crypto]';

function envFlag(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return null;
}

function coreGate(platform) {
  const f = envFlag('CHATYY_CRYPTO');
  if (f === false) return { on: false, why: 'CHATYY_CRYPTO=0' };
  if (f === true) return { on: true, why: 'CHATYY_CRYPTO=1' };
  try {
    if (platform === 'ios') {
      const ok = fs.existsSync(path.join(MODULE_DIR, 'ios', 'ChatyyCryptoCore.xcframework')) &&
        fs.existsSync(path.join(MODULE_DIR, 'ios', 'Generated', 'ChatyyCryptoCore.swift'));
      return ok ? { on: true, why: 'xcframework presente' } : { on: false, why: 'sem xcframework (stub)' };
    }
    const jni = path.join(MODULE_DIR, 'android', 'src', 'main', 'jniLibs');
    const ok = fs.existsSync(jni) && fs.readdirSync(jni).some((abi) => fs.existsSync(path.join(jni, abi, 'libchatyy_crypto.so')));
    return ok ? { on: true, why: 'libchatyy_crypto.so presente' } : { on: false, why: 'sem .so (stub)' };
  } catch (e) {
    return { on: false, why: 'erro lendo artefatos: ' + e.message };
  }
}

/** Lista final de grupos: o próprio app-id primeiro (preserva o grupo padrão), depois o compartilhado. */
function withGroups(existing, ownBundle) {
  const out = Array.isArray(existing) ? existing.slice() : [];
  const own = PREFIX + ownBundle;
  if (out.length === 0) out.push(own);
  if (!out.includes(SHARED_GROUP)) out.push(SHARED_GROUP);
  return out;
}

function withIos(config) {
  config = withEntitlementsPlist(config, (cfg) => {
    const gate = coreGate('ios');
    console.log(`${TAG} iOS keychain group ${gate.on ? 'ON' : 'OFF'} (${gate.why})`);
    if (!gate.on) return cfg;
    const bundle = (cfg.ios && cfg.ios.bundleIdentifier) || 'com.onemundo.mail';
    cfg.modResults['keychain-access-groups'] = withGroups(cfg.modResults['keychain-access-groups'], bundle);
    return cfg;
  });
  config = withInfoPlist(config, (cfg) => {
    if (coreGate('ios').on) cfg.modResults.ChatyyE2EE5KeychainGroup = SHARED_GROUP;
    return cfg;
  });
  config = withFinalizedMod(config, [
    'ios',
    async (cfg) => {
      if (!coreGate('ios').on || envFlag('CHATYY_CRYPTO_EXT_KEYCHAIN') === false) return cfg;
      let plist;
      try {
        plist = require('@expo/plist').default || require('@expo/plist');
      } catch (e) {
        console.warn(`${TAG} @expo/plist ausente — extensões sem keychain group (${e.message})`);
        return cfg;
      }
      for (const ext of EXTENSIONS) {
        const f = path.join(cfg.modRequest.platformProjectRoot, ext.dir, ext.file);
        if (!fs.existsSync(f)) {
          console.log(`${TAG} ${ext.dir}: sem ${ext.file} (alvo ausente) — pulado`);
          continue;
        }
        try {
          const obj = plist.parse(fs.readFileSync(f, 'utf8')) || {};
          obj['keychain-access-groups'] = withGroups(obj['keychain-access-groups'], ext.bundle);
          fs.writeFileSync(f, plist.build(obj), 'utf8');
          console.log(`${TAG} ${ext.dir}: keychain-access-groups += ${SHARED_GROUP}`);
        } catch (e) {
          console.warn(`${TAG} ${ext.dir}: falhou (${e.message}) — entitlements intactos`);
        }
      }
      return cfg;
    },
  ]);
  return config;
}

function addExcludes(xml) {
  if (xml.includes('no_backup/e2ee5/')) return xml;
  let out = xml;
  // data_extraction_rules: só nas seções que já existem (não muda a semântica do arquivo).
  for (const sec of ['cloud-backup', 'device-transfer']) {
    // (tag de abertura, não a autofechada `<sec/>`)
    out = out.replace(new RegExp(`(<${sec}\\b(?:[^>]*[^/>])?>)`, 'g'), `$1\n    ${ANDROID_EXCLUDE}`);
  }
  if (out === xml) {
    out = xml.replace(/(<full-backup-content\b(?:[^>]*[^/>])?>)/, `$1\n  ${ANDROID_EXCLUDE}`);
  }
  return out;
}

function withAndroid(config) {
  return withFinalizedMod(config, [
    'android',
    async (cfg) => {
      const gate = coreGate('android');
      console.log(`${TAG} Android backup excludes ${gate.on ? 'ON' : 'OFF'} (${gate.why})`);
      if (!gate.on) return cfg;
      try {
        const root = cfg.modRequest.platformProjectRoot;
        const manifestPath = path.join(root, 'app', 'src', 'main', 'AndroidManifest.xml');
        if (!fs.existsSync(manifestPath)) return cfg;
        const manifest = await AndroidConfig.Manifest.readAndroidManifestAsync(manifestPath);
        const app = AndroidConfig.Manifest.getMainApplication(manifest);
        const attrs = (app && app.$) || {};
        const refs = [attrs['android:fullBackupContent'], attrs['android:dataExtractionRules']]
          .filter((r) => typeof r === 'string' && r.startsWith('@xml/'));
        for (const ref of refs) {
          const f = path.join(root, 'app', 'src', 'main', 'res', 'xml', ref.slice(5) + '.xml');
          if (!fs.existsSync(f)) continue;
          const xml = fs.readFileSync(f, 'utf8');
          const next = addExcludes(xml);
          if (next !== xml) {
            fs.writeFileSync(f, next, 'utf8');
            console.log(`${TAG} ${path.basename(f)}: + exclude no_backup/e2ee5/`);
          }
        }
      } catch (e) {
        console.warn(`${TAG} Android: backup rules intactas (${e.message})`);
      }
      return cfg;
    },
  ]);
}

module.exports = function withChatyyCrypto(config) {
  config = withIos(config);
  config = withAndroid(config);
  return config;
};
module.exports._test = { withGroups, addExcludes, coreGate };
