/**
 * Expo config plugin — Chatyy ShareExtension (iOS): NATIVE share UI + Siri
 * share-sheet suggestions, applied on every `expo prebuild --clean` (ios/ is
 * gitignored).
 *
 * What ships (FINALIZED mod, i.e. after expo-share-intent's XCODEPROJ mod wrote
 * its template into ios/ShareExtension/):
 *   ios/ShareExtension/ShareViewController.swift
 *       = expo-share-intent template, class renamed to
 *         ChatyyShareIntentFallbackController (+ chatyyLegacyAllowed /
 *         chatyyStartLegacyFlow hooks) → the OLD flow (copy to App Group, open
 *         the app at /share-receive), kept as the fallback
 *       + native-ios/share-extension/ChatyyNativeShare.swift appended
 *         (`final class ShareViewController: ChatyyShareIntentFallbackController`,
 *         UIKit picker / preview / caption / background send)
 *       + suggestion capture (chatyy.share_target, used by the fallback)
 *   ios/ShareExtension/ShareExtension-Info.plist
 *       NSExtensionAttributes.IntentsSupported += INSendMessageIntent,
 *       ChatyyNativeShare = true|false (native code present)
 *   ios/<MainTarget>/Info.plist  NSUserActivityTypes += INSendMessageIntent
 *
 * Build gate: CHATYY_NATIVE_SHARE=0 → template only. Runtime gates (App Group,
 * written by the app): see ChatyyNativeShare.swift header.
 */
const { withInfoPlist, withFinalizedMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// [2026-10-18 native-share] Compartilhar 100% nativo (UIKit, sem abrir o RN):
// native-ios/share-extension/ChatyyNativeShare.swift é ANEXADO ao
// ShareViewController.swift do template do expo-share-intent (o target da
// extensão só compila esse arquivo). O template vira a classe-base
// ChatyyShareIntentFallbackController = fallback "abre o app em /share-receive".
// CHATYY_NATIVE_SHARE=0 no prebuild → só o template (comportamento antigo).
// (O antigo native-ios/share-extension/ShareViewController.swift NUNCA embarcou:
// o mod XCODEPROJ do expo-share-intent reescrevia o arquivo depois do dangerous
// mod que o copiava. Este plugin não o usa mais — é só referência histórica.)
const NATIVE_SRC = path.join(__dirname, '..', 'native-ios', 'share-extension', 'ChatyyNativeShare.swift');
const NATIVE_MARK = '// [chatyy native share v1]';
const BASE_CLASS = 'ChatyyShareIntentFallbackController';

function nativeShareGateOn() {
  const v = String(process.env.CHATYY_NATIVE_SHARE == null ? '1' : process.env.CHATYY_NATIVE_SHARE).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

/**
 * Pure (exported for tests): template VC source → template renamed to the
 * fallback base class + legacy hooks + the native Swift appended. Returns null
 * when the template anchors are not found (expo-share-intent changed) → the
 * caller keeps the template untouched (old behaviour, never a broken build).
 */
function composeNativeShareSource(templateSrc, nativeSrc) {
  if (templateSrc.includes(NATIVE_MARK)) return templateSrc;
  const classRe = /^class ShareViewController: UIViewController \{[ \t]*$/m;
  const handleAnchor = 'private func handleViewLoad() {';
  const classMatches = templateSrc.match(new RegExp(classRe.source, 'gm')) || [];
  if (classMatches.length !== 1) return null;
  if (templateSrc.split(handleAnchor).length !== 2) return null;
  if (!/super\.viewDidLoad\(\)/.test(templateSrc)) return null;
  let src = templateSrc.replace(classRe, [
    `class ${BASE_CLASS}: UIViewController {`,
    '  // [chatyy native share] false = a subclasse nativa assumiu; o fluxo do template não roda.',
    '  var chatyyLegacyAllowed: Bool = true',
    '  /// Fallback sob demanda (sem token/snapshot, erro, "Mais opções no Chatyy").',
    '  func chatyyStartLegacyFlow() {',
    '    chatyyLegacyAllowed = true',
    '    view.backgroundColor = .clear',
    '    view.isOpaque = false',
    '    handleViewLoad()',
    '  }',
  ].join('\n'));
  src = src.replace(handleAnchor, `${handleAnchor}\n    guard chatyyLegacyAllowed else { return }`);
  // imports do arquivo nativo sobem para o topo (junto dos do template)
  const nativeLines = nativeSrc.split('\n');
  const imports = [];
  const body = [];
  for (const line of nativeLines) {
    const m = /^import\s+([A-Za-z0-9_]+)\s*$/.exec(line);
    if (m) { imports.push(m[1]); } else { body.push(line); }
  }
  const have = new Set();
  src.replace(/^import\s+([A-Za-z0-9_]+)\s*$/gm, (_, mod) => { have.add(mod); return _; });
  const add = imports.filter((m) => !have.has(m)).map((m) => `import ${m}`);
  if (add.length) src = `${add.join('\n')}\n${src}`;
  return `${src}\n\n${NATIVE_MARK} — appended by plugins/with-custom-share-extension.js\n${body.join('\n')}\n`;
}

const withMainAppIntentTypes = (config) =>
  withInfoPlist(config, (cfg) => {
    const plist = cfg.modResults;
    const existing = Array.isArray(plist.NSUserActivityTypes)
      ? plist.NSUserActivityTypes
      : [];
    // Apple resolves Share Sheet suggestions when the app declares it
    // handles INSendMessageIntent activity types. Without this entry,
    // donations succeed but the system silently drops them for surface
    // purposes — that's why "ações rápidas" stayed empty in TestFlight.
    const required = ['INSendMessageIntent'];
    const merged = Array.from(new Set([...existing, ...required]));
    plist.NSUserActivityTypes = merged;
    return cfg;
  });

// [2026-10-09 notif-native] Share-sheet SUGGESTIONS (row of recent chats on
// top of the iOS share sheet). Two gaps made them never show / never route:
//   1. The extension's Info.plist lacked NSExtensionAttributes.IntentsSupported
//      = [INSendMessageIntent] → iOS never offers our donated conversations.
//   2. The ShareViewController that actually ships is expo-share-intent's
//      template (it is (re)written by expo-share-intent's XCODEPROJ mod, which
//      runs AFTER every dangerous mod — so withCustomShareExtensionSwift above
//      never wins on a clean prebuild). We therefore inject a tiny capture into
//      WHATEVER VC is on disk: the tapped suggestion's conversationIdentifier /
//      recipient handle is parked in the App Group ("chatyy.share_target") and
//      /share-receive preselects that chat (ExpoChatyyIntents.consumeShareTarget).
// Runs as a FINALIZED mod (after xcodeproj) so it sees the final files.
const SHARE_EXT_DIR = 'ShareExtension';
const SHARE_TARGET_MARK = '// [chatyy share-target capture v1]';
const shareTargetExt = (cls) => `

${SHARE_TARGET_MARK} — injected by plugins/with-custom-share-extension.js
extension ${cls} {
  func chatyyRecordShareTarget() {
    guard #available(iOS 14.0, *),
          let intent = extensionContext?.intent as? INSendMessageIntent else { return }
    let conv = intent.conversationIdentifier ?? ""
    let handle = intent.recipients?.first?.personHandle?.value ?? ""
    if conv.isEmpty && handle.isEmpty { return }
    guard let ud = UserDefaults(suiteName: "group.com.onemundo.mail") else { return }
    ud.set(["conv": conv, "handle": handle, "at": Date().timeIntervalSince1970], forKey: "chatyy.share_target")
  }
}
`;

/** Pure (exported for tests): inject the suggestion capture into the VC source. */
function injectShareTargetCapture(src) {
  if (src.includes(SHARE_TARGET_MARK)) return src;
  const anchor = 'super.viewDidLoad()';
  const i = src.indexOf(anchor);
  if (i < 0) return null;
  const cls = src.includes(`class ${BASE_CLASS}:`) ? BASE_CLASS : 'ShareViewController';
  if (cls === 'ShareViewController' && !/class ShareViewController\b/.test(src)) return null;
  let out = src.slice(0, i + anchor.length) + '\n    chatyyRecordShareTarget()' + src.slice(i + anchor.length);
  if (!/^import Intents\b/m.test(out)) {
    out = out.replace(/^import UIKit\b.*$/m, (m) => `${m}\nimport Intents`);
    if (!/^import Intents\b/m.test(out)) out = `import Intents\n${out}`;
  }
  return out + shareTargetExt(cls);
}

const withShareSuggestionsSupport = (config) =>
  withFinalizedMod(config, [
    'ios',
    async (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, SHARE_EXT_DIR);
      const vcPath = path.join(dir, 'ShareViewController.swift');
      // 1) ShareViewController → native UI (subclass) + fallback base class
      let nativeOn = false;
      try {
        if (nativeShareGateOn() && fs.existsSync(vcPath) && fs.existsSync(NATIVE_SRC)) {
          const composed = composeNativeShareSource(fs.readFileSync(vcPath, 'utf8'), fs.readFileSync(NATIVE_SRC, 'utf8'));
          if (composed) {
            fs.writeFileSync(vcPath, composed);
            nativeOn = true;
            console.log(`[with-custom-share-extension] native share UI appended (${composed.length} chars)`);
          } else {
            console.warn('[with-custom-share-extension] template anchors not found — native share OFF (template fallback only)');
          }
        } else if (!nativeShareGateOn()) {
          console.log('[with-custom-share-extension] CHATYY_NATIVE_SHARE=0 — template only');
        }
      } catch (e) {
        nativeOn = false;
        console.warn('[with-custom-share-extension] native share compose failed:', e?.message || e);
      }
      // 2) Info.plist → IntentsSupported + ChatyyNativeShare flag
      try {
        const plistPath = path.join(dir, 'ShareExtension-Info.plist');
        if (fs.existsSync(plistPath)) {
          const plist = require('@expo/plist').default || require('@expo/plist');
          const obj = plist.parse(fs.readFileSync(plistPath, 'utf8'));
          obj.NSExtension = obj.NSExtension || {};
          const attrs = obj.NSExtension.NSExtensionAttributes || {};
          const cur = Array.isArray(attrs.IntentsSupported) ? attrs.IntentsSupported : [];
          if (!cur.includes('INSendMessageIntent')) attrs.IntentsSupported = [...cur, 'INSendMessageIntent'];
          obj.NSExtension.NSExtensionAttributes = attrs;
          obj.ChatyyNativeShare = nativeOn;
          fs.writeFileSync(plistPath, plist.build(obj));
          console.log(`[with-custom-share-extension] ShareExtension IntentsSupported=[INSendMessageIntent] ChatyyNativeShare=${nativeOn}`);
        } else {
          console.warn(`[with-custom-share-extension] ${plistPath} missing — share suggestions NOT enabled`);
        }
      } catch (e) {
        console.warn('[with-custom-share-extension] Info.plist patch failed:', e?.message || e);
      }
      // 3) ShareViewController → capture the tapped suggestion (legacy /share-receive path)
      try {
        if (fs.existsSync(vcPath)) {
          const src = fs.readFileSync(vcPath, 'utf8');
          const out = injectShareTargetCapture(src);
          if (out === null) {
            console.warn('[with-custom-share-extension] viewDidLoad anchor not found — share-target capture skipped');
          } else if (out !== src) {
            fs.writeFileSync(vcPath, out);
            console.log('[with-custom-share-extension] share-target capture injected');
          }
        }
      } catch (e) {
        console.warn('[with-custom-share-extension] share-target capture failed:', e?.message || e);
      }
      return cfg;
    },
  ]);

module.exports = function withCustomShareExtension(config) {
  config = withMainAppIntentTypes(config);
  config = withShareSuggestionsSupport(config);
  return config;
};
module.exports.composeNativeShareSource = composeNativeShareSource;
module.exports.injectShareTargetCapture = injectShareTargetCapture;
