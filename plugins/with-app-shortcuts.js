/**
 * [2026-10-08 android-otp-shortcuts] App-icon quick actions (long-press icon).
 *
 * STATIC items (both platforms) [2026-10-15]: Nova conversa · Câmera do status · Buscar.
 *   onemundomail://chat-new              → app/chat-new.js
 *   onemundomail://chat?new=1            → app/chat.js requestNewStatus (status camera)
 *   onemundomail://search?tab=messages   → app/search.js (message search)
 *
 * Android: res/xml/chatyy_shortcuts.xml + vector icons + labels (English
 *   default, one values-<locale> per app locale) + <meta-data android:name="android.app.shortcuts"> on
 *   MainActivity. Shortcuts are ACTION_VIEW deep links → Linking/expo-router.
 * iOS: Info.plist UIApplicationShortcutItems with UserInfo.url; launches are
 *   handled by modules/expo-native-toolkit/ios/ExpoAppShortcutsModule.swift
 *   (AppShortcutsAppDelegateSubscriber) + services/appShortcuts.js.
 *
 * DYNAMIC items (recent conversations) are set at runtime by
 * services/appShortcuts.js → ExpoAppShortcuts native module.
 */
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod, withInfoPlist, AndroidConfig } = require('@expo/config-plugins');

const SCHEME = 'onemundomail';

// [2026-10-15 system-integration] Founder spec (WhatsApp/Telegram): Nova
// conversa · Câmera do status · Buscar (+ dynamic recents, pinned first —
// services/appShortcuts.js). "Escrever e-mail" left the icon menu (the e-mail
// tab is one tap away; iOS shows at most 4 actions total, so a 4th static item
// would hide every recent conversation).
//   status camera → /chat?new=1 (chat.js requestNewStatus → native camera)
//   search        → /search?tab=messages (global message search)
// Labels: curated pt/en/es below; every other app locale is read from the JS
// i18n tables (i18nKey) at prebuild, falling back to English.
const ITEMS = [
  {
    key: 'new_chat', iosType: 'newchat', url: `${SCHEME}://chat-new`,
    pt: ['Nova conversa', 'Iniciar nova conversa'], en: ['New chat', 'Start a new chat'], es: ['Nuevo chat', 'Iniciar un nuevo chat'],
    i18nKey: 'chat.newChat',
    iosSymbol: 'square.and.pencil', iosIconType: 'UIApplicationShortcutIconTypeCompose',
    glyph: 'M20,2H4c-1.1,0 -2,0.9 -2,2v18l4,-4h14c1.1,0 2,-0.9 2,-2V4c0,-1.1 -0.9,-2 -2,-2zM17,11h-4v4h-2v-4H7V9h4V5h2v4h4v2z',
  },
  {
    key: 'status_camera', iosType: 'statuscamera', url: `${SCHEME}://chat?new=1`,
    pt: ['Novo status', 'Câmera do status'], en: ['New status', 'Status camera'], es: ['Nuevo estado', 'Cámara de estados'],
    i18nKey: 'status.addStatus',
    iosSymbol: 'camera', iosIconType: 'UIApplicationShortcutIconTypeCapturePhoto',
    glyph: 'M9,2L7.17,4H4c-1.1,0 -2,0.9 -2,2v12c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V6c0,-1.1 -0.9,-2 -2,-2h-3.17L15,2H9zM12,17c-2.76,0 -5,-2.24 -5,-5s2.24,-5 5,-5 5,2.24 5,5 -2.24,5 -5,5zM12,8.8c-1.77,0 -3.2,1.43 -3.2,3.2s1.43,3.2 3.2,3.2 3.2,-1.43 3.2,-3.2 -1.43,-3.2 -3.2,-3.2z',
  },
  {
    key: 'search', iosType: 'search', url: `${SCHEME}://search?tab=messages`,
    pt: ['Buscar', 'Buscar mensagens'], en: ['Search', 'Search messages'], es: ['Buscar', 'Buscar mensajes'],
    i18nKey: 'common.search',
    iosSymbol: 'magnifyingglass', iosIconType: 'UIApplicationShortcutIconTypeSearch',
    glyph: 'M15.5,14h-0.79l-0.28,-0.27C15.41,12.59 16,11.11 16,9.5 16,5.91 13.09,3 9.5,3S3,5.91 3,9.5 5.91,16 9.5,16c1.61,0 3.09,-0.59 4.23,-1.57l0.27,0.28v0.79l5,4.99L20.49,19l-4.99,-5zM9.5,14C7.01,14 5,11.99 5,9.5S7.01,5 9.5,5 14,7.01 14,9.5 11.99,14 9.5,14z',
  },
];
// Static iOS types shipped by older builds (filtered out of Info.plist).
const LEGACY_IOS_TYPES = ['camera', 'compose'];

// ---------------------------------------------------------------------------
// Localization: app locales (i18n/manifest.json) → labels per locale.
// ---------------------------------------------------------------------------
function appLocales(projectRoot) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(projectRoot, 'i18n', 'manifest.json'), 'utf8'));
    return [...new Set([...(m.core || []), ...Object.keys(m.locales || {})])]
      .filter((x) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(x));
  } catch {
    return ['pt-BR', 'en', 'es'];
  }
}

const _i18nCache = {};
/** Last definition of `key` in i18n/<locale>.js (plain string literal), or null. */
function i18nValue(projectRoot, locale, key) {
  if (!(locale in _i18nCache)) {
    try { _i18nCache[locale] = fs.readFileSync(path.join(projectRoot, 'i18n', `${locale}.js`), 'utf8'); } catch { _i18nCache[locale] = ''; }
  }
  const src = _i18nCache[locale];
  if (!src) return null;
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`['"]${k}['"]\\s*:\\s*(['"])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1`, 'g');
  let m; let last = null;
  while ((m = re.exec(src))) last = m[2];
  if (last == null) return null;
  const v = last.replace(/\\(['"\\])/g, '$1').replace(/\s*(\.\.\.|…)$/, '').trim();
  return v && !/[{}<>]/.test(v) ? v : null;
}

/** [short, long] for an item in an app locale (curated pt/en/es first). */
function labelsFor(projectRoot, it, locale) {
  const base = locale.split('-')[0];
  if (base === 'pt') return it.pt;
  if (base === 'en') return it.en;
  if (base === 'es') return it.es;
  const v = i18nValue(projectRoot, locale, it.i18nKey);
  return v ? [v, v] : it.en;
}

/** i18n locale → Android resource qualifier dirs (legacy he/id aliases too). */
function androidQualifiers(locale) {
  const [l, r] = locale.split('-');
  const lang = l.toLowerCase();
  const one = (code) => {
    if (code.length === 2) return r ? `values-${code}-r${r.toUpperCase()}` : `values-${code}`;
    return r ? `values-b+${code}+${r.toUpperCase()}` : `values-b+${code}`;
  };
  const out = [one(lang)];
  if (lang === 'he') out.push(one('iw'));
  if (lang === 'id') out.push(one('in'));
  return out;
}

/**
 * iOS: UIApplicationShortcutItemTitle is localized through InfoPlist.strings
 * with the (English) Info.plist title as KEY. Consumed by
 * plugins/with-ios-localizations.js → { appleLocale: { "New chat": "…" } }.
 */
function iosShortcutTitleStrings(projectRoot) {
  const APPLE_CODE = { 'zh-CN': 'zh-Hans' };
  const out = {};
  for (const loc of appLocales(projectRoot)) {
    if (loc === 'en') continue;
    const map = {};
    for (const it of ITEMS) {
      const t = labelsFor(projectRoot, it, loc)[0];
      if (t && t !== it.en[0]) map[it.en[0]] = t;
    }
    if (Object.keys(map).length) out[APPLE_CODE[loc] || loc] = map;
  }
  return out;
}

// Must match ExpoAppShortcutsModule.kt / ChatMessagingStyleHandler.kt
// (packageName + this suffix).
const SHARE_TARGET_CATEGORY_SUFFIX = '.category.SHARE_TARGET';
const SHARE_TARGET_MIMES = ['text/*', 'image/*', 'video/*', 'audio/*', 'application/pdf'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '\\"').replace(/'/g, "\\'");

function shortcutsXml(pkg) {
  const body = ITEMS.map((it) => [
    `  <shortcut android:shortcutId="chatyy_static_${it.key}" android:enabled="true"`,
    `      android:icon="@drawable/chatyy_sc_${it.key}"`,
    `      android:shortcutShortLabel="@string/chatyy_sc_${it.key}"`,
    `      android:shortcutLongLabel="@string/chatyy_sc_${it.key}_long">`,
    `    <intent android:action="android.intent.action.VIEW"`,
    `        android:targetPackage="${pkg}"`,
    `        android:targetClass="${pkg}.MainActivity"`,
    `        android:data="${it.url.replace(/&/g, '&amp;')}" />`,
    '  </shortcut>',
  ].join('\n')).join('\n');
  // [2026-10-09 notif-native] Sharing Shortcuts (Android 10+ Direct Share):
  // dynamic conversation shortcuts carrying SHARE_TARGET_CATEGORY (set by
  // ExpoAppShortcutsModule + ChatMessagingStyleHandler) show up as the row of
  // recent chats on top of the system share sheet. The share lands on
  // MainActivity's existing SEND filters with EXTRA_SHORTCUT_ID = chat_<id>;
  // /share-receive preselects that chat. MIME types mirror those filters.
  const shareTarget = [
    `  <share-target android:targetClass="${pkg}.MainActivity">`,
    ...SHARE_TARGET_MIMES.map((m) => `    <data android:mimeType="${m}" />`),
    `    <category android:name="${pkg}${SHARE_TARGET_CATEGORY_SUFFIX}" />`,
    '  </share-target>',
  ].join('\n');
  // [2026-10-09 system-integration] Google Assistant App Actions (built-in
  // intents CREATE_MESSAGE / CREATE_CALL): "Mandar mensagem no Chatyy para Ana",
  // "Ligar para Ana no Chatyy". The URL lands on app/assistant-action/[kind].js,
  // which resolves the name against the cached conversations and opens the
  // chat (prefilled text) or starts the call through the in-chat pipeline.
  const target = `android:targetPackage="${pkg}" android:targetClass="${pkg}.MainActivity"`;
  const capabilities = [
    '  <capability android:name="actions.intent.CREATE_MESSAGE">',
    `    <intent android:action="android.intent.action.VIEW" ${target}>`,
    `      <url-template android:value="${SCHEME}://assistant-action/message{?name,text}" />`,
    '      <parameter android:name="message.recipient.name" android:key="name" />',
    '      <parameter android:name="message.text" android:key="text" />',
    '    </intent>',
    '  </capability>',
    '  <capability android:name="actions.intent.CREATE_CALL">',
    `    <intent android:action="android.intent.action.VIEW" ${target}>`,
    `      <url-template android:value="${SCHEME}://assistant-action/call{?name}" />`,
    '      <parameter android:name="call.participant.name" android:key="name" />',
    '    </intent>',
    '  </capability>',
  ].join('\n');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- Generated by plugins/with-app-shortcuts.js -->',
    '<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">',
    capabilities,
    body,
    shareTarget,
    '</shortcuts>',
    '',
  ].join('\n');
}

function iconXml(glyph) {
  // 48dp launcher-shortcut icon: light circle + brand-blue 24dp glyph centered.
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<vector xmlns:android="http://schemas.android.com/apk/res/android"',
    '    android:width="48dp" android:height="48dp"',
    '    android:viewportWidth="48" android:viewportHeight="48">',
    '  <path android:fillColor="#FFF1F5FF" android:pathData="M24,2a22,22 0,1 1,0 44a22,22 0,1 1,0 -44z"/>',
    '  <group android:translateX="12" android:translateY="12">',
    `    <path android:fillColor="#FF2563EB" android:pathData="${glyph}"/>`,
    '  </group>',
    '</vector>',
    '',
  ].join('\n');
}

function stringsXml(labelsOf) {
  const rows = [];
  for (const it of ITEMS) {
    const [short, long] = labelsOf(it);
    rows.push(`  <string name="chatyy_sc_${it.key}">${esc(short)}</string>`);
    rows.push(`  <string name="chatyy_sc_${it.key}_long">${esc(long)}</string>`);
  }
  return ['<?xml version="1.0" encoding="utf-8"?>', '<resources>', ...rows, '</resources>', ''].join('\n');
}

function withAndroidShortcutFiles(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const pkg = cfg.android?.package || 'com.onemundo.mail';
    const projectRoot = cfg.modRequest.projectRoot;
    const res = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');
    const write = (rel, content) => {
      const p = path.join(res, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    };
    write('xml/chatyy_shortcuts.xml', shortcutsXml(pkg));
    for (const it of ITEMS) write(`drawable/chatyy_sc_${it.key}.xml`, iconXml(it.glyph));
    // [2026-10-15] Default = English (any device language without a table);
    // generic values-pt = pt-BR wording; then one dir per app locale.
    write('values/chatyy_shortcuts_strings.xml', stringsXml((it) => it.en));
    write('values-pt/chatyy_shortcuts_strings.xml', stringsXml((it) => it.pt));
    for (const loc of appLocales(projectRoot)) {
      const xml = stringsXml((it) => labelsFor(projectRoot, it, loc));
      for (const q of androidQualifiers(loc)) write(`${q}/chatyy_shortcuts_strings.xml`, xml);
    }
    return cfg;
  }]);
}

function withAndroidShortcutMeta(config) {
  return withAndroidManifest(config, (cfg) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults);
    activity['meta-data'] = (activity['meta-data'] || []).filter(
      (m) => m?.$?.['android:name'] !== 'android.app.shortcuts'
    );
    activity['meta-data'].push({
      $: { 'android:name': 'android.app.shortcuts', 'android:resource': '@xml/chatyy_shortcuts' },
    });
    return cfg;
  });
}

function withIosShortcutItems(config) {
  return withInfoPlist(config, (cfg) => {
    const bundleId = cfg.ios?.bundleIdentifier || 'com.onemundo.mail';
    const ours = new Set([...ITEMS.map((it) => it.iosType), ...LEGACY_IOS_TYPES].map((t) => `${bundleId}.${t}`));
    const existing = Array.isArray(cfg.modResults.UIApplicationShortcutItems)
      ? cfg.modResults.UIApplicationShortcutItems.filter((x) => !ours.has(x?.UIApplicationShortcutItemType))
      : [];
    cfg.modResults.UIApplicationShortcutItems = [
      ...ITEMS.map((it) => ({
        UIApplicationShortcutItemType: `${bundleId}.${it.iosType}`,
        // English base; localized via <lang>.lproj/InfoPlist.strings
        // (iosShortcutTitleStrings → plugins/with-ios-localizations.js).
        UIApplicationShortcutItemTitle: it.en[0],
        UIApplicationShortcutItemIconSymbolName: it.iosSymbol,
        UIApplicationShortcutItemIconType: it.iosIconType,
        UIApplicationShortcutItemUserInfo: { url: it.url },
      })),
      ...existing,
    ];
    return cfg;
  });
}

module.exports = function withAppShortcuts(config) {
  config = withAndroidShortcutFiles(config);
  config = withAndroidShortcutMeta(config);
  config = withIosShortcutItems(config);
  return config;
};
module.exports.iosShortcutTitleStrings = iosShortcutTitleStrings;
module.exports._test = { ITEMS, appLocales, i18nValue, labelsFor, androidQualifiers, stringsXml };
