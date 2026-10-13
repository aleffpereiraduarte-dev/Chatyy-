/**
 * [2026-10-12 native-polish] Android Auto messaging (WhatsApp/Telegram parity):
 * incoming chats read aloud in the car + voice reply + "mark as read".
 *
 * The notification side is ALREADY Auto-compliant (expo-callkit
 * ChatMessagingStyleHandler.kt): MessagingStyle + Person, Reply action with
 * RemoteInput + SEMANTIC_ACTION_REPLY + setShowsUserInterface(false), Mark-read
 * with SEMANTIC_ACTION_MARK_AS_READ, both handled by ChatActionReceiver without
 * opening the UI. Android Auto only lists an app that declares the
 * "notification" automotive capability — that is all this plugin adds:
 *
 *   <meta-data android:name="com.google.android.gms.car.application"
 *              android:resource="@xml/automotive_app_desc"/>
 *   res/xml/automotive_app_desc.xml → <automotiveApp><uses name="notification"/></automotiveApp>
 *
 * GATE: opt-in CHATYY_ANDROID_AUTO=1. Declaring it makes Play run the Android
 * Auto review on the next release (founder must opt in to the Android Auto form
 * factor in Play Console first). OFF by default so a release is never held by
 * that review unexpectedly. No code, no dependency.
 */
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod, AndroidConfig } = require('@expo/config-plugins');

const META = 'com.google.android.gms.car.application';
const XML_NAME = 'automotive_app_desc';

function gateOn() {
  const v = String(process.env.CHATYY_ANDROID_AUTO || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

function withAutoManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app['meta-data'] = app['meta-data'] || [];
    if (!app['meta-data'].some((m) => m.$ && m.$['android:name'] === META)) {
      app['meta-data'].push({ $: { 'android:name': META, 'android:resource': `@xml/${XML_NAME}` } });
    }
    return cfg;
  });
}

function withAutoXml(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${XML_NAME}.xml`),
        '<?xml version="1.0" encoding="utf-8"?>\n<automotiveApp>\n    <uses name="notification"/>\n</automotiveApp>\n'
      );
      return cfg;
    },
  ]);
}

module.exports = function withAndroidAuto(config) {
  if (!gateOn()) {
    console.log('[with-android-auto] OFF (opt-in: CHATYY_ANDROID_AUTO=1)');
    return config;
  }
  config = withAutoManifest(config);
  config = withAutoXml(config);
  return config;
};
