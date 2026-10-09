/**
 * [2026-10-08 android-otp-shortcuts] App-icon quick actions (long-press icon).
 *
 * STATIC items (both platforms): Nova conversa · Câmera · Escrever e-mail.
 *   onemundomail://chat-new        → app/chat-new.js
 *   onemundomail://photos?camera=1 → app/photos.js (same as the chat header camera)
 *   onemundomail://compose         → app/compose.js
 *
 * Android: res/xml/chatyy_shortcuts.xml + vector icons + labels (pt default,
 *   en/es overrides) + <meta-data android:name="android.app.shortcuts"> on
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

const ITEMS = [
  {
    key: 'new_chat', iosType: 'newchat', url: `${SCHEME}://chat-new`,
    pt: ['Nova conversa', 'Iniciar nova conversa'], en: ['New chat', 'Start a new chat'], es: ['Nuevo chat', 'Iniciar un nuevo chat'],
    iosSymbol: 'plus.bubble', iosIconType: 'UIApplicationShortcutIconTypeCompose',
    glyph: 'M20,2H4c-1.1,0 -2,0.9 -2,2v18l4,-4h14c1.1,0 2,-0.9 2,-2V4c0,-1.1 -0.9,-2 -2,-2zM17,11h-4v4h-2v-4H7V9h4V5h2v4h4v2z',
  },
  {
    key: 'camera', iosType: 'camera', url: `${SCHEME}://photos?camera=1`,
    pt: ['Câmera', 'Abrir câmera'], en: ['Camera', 'Open camera'], es: ['Cámara', 'Abrir cámara'],
    iosSymbol: 'camera', iosIconType: 'UIApplicationShortcutIconTypeCapturePhoto',
    glyph: 'M9,2L7.17,4H4c-1.1,0 -2,0.9 -2,2v12c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V6c0,-1.1 -0.9,-2 -2,-2h-3.17L15,2H9zM12,17c-2.76,0 -5,-2.24 -5,-5s2.24,-5 5,-5 5,2.24 5,5 -2.24,5 -5,5zM12,8.8c-1.77,0 -3.2,1.43 -3.2,3.2s1.43,3.2 3.2,3.2 3.2,-1.43 3.2,-3.2 -1.43,-3.2 -3.2,-3.2z',
  },
  {
    key: 'compose', iosType: 'compose', url: `${SCHEME}://compose`,
    pt: ['Escrever e-mail', 'Escrever novo e-mail'], en: ['Write email', 'Write a new email'], es: ['Escribir correo', 'Escribir un correo nuevo'],
    iosSymbol: 'envelope', iosIconType: 'UIApplicationShortcutIconTypeMail',
    glyph: 'M20,4H4c-1.1,0 -1.99,0.9 -1.99,2L2,18c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V6c0,-1.1 -0.9,-2 -2,-2zM20,8l-8,5 -8,-5V6l8,5 8,-5v2z',
  },
];

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

function stringsXml(lang) {
  const rows = [];
  for (const it of ITEMS) {
    const [short, long] = it[lang];
    rows.push(`  <string name="chatyy_sc_${it.key}">${esc(short)}</string>`);
    rows.push(`  <string name="chatyy_sc_${it.key}_long">${esc(long)}</string>`);
  }
  return ['<?xml version="1.0" encoding="utf-8"?>', '<resources>', ...rows, '</resources>', ''].join('\n');
}

function withAndroidShortcutFiles(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const pkg = cfg.android?.package || 'com.onemundo.mail';
    const res = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');
    const write = (rel, content) => {
      const p = path.join(res, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    };
    write('xml/chatyy_shortcuts.xml', shortcutsXml(pkg));
    for (const it of ITEMS) write(`drawable/chatyy_sc_${it.key}.xml`, iconXml(it.glyph));
    write('values/chatyy_shortcuts_strings.xml', stringsXml('pt'));
    write('values-en/chatyy_shortcuts_strings.xml', stringsXml('en'));
    write('values-es/chatyy_shortcuts_strings.xml', stringsXml('es'));
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
    const ours = new Set(ITEMS.map((it) => `${bundleId}.${it.iosType}`));
    const existing = Array.isArray(cfg.modResults.UIApplicationShortcutItems)
      ? cfg.modResults.UIApplicationShortcutItems.filter((x) => !ours.has(x?.UIApplicationShortcutItemType))
      : [];
    cfg.modResults.UIApplicationShortcutItems = [
      ...ITEMS.map((it) => ({
        UIApplicationShortcutItemType: `${bundleId}.${it.iosType}`,
        UIApplicationShortcutItemTitle: it.pt[0],
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
