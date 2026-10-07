/**
 * [2026-10-07 bgsync] Config plugin for the WhatsApp-style background chat sync.
 *
 * iOS (Info.plist):
 *   - BGTaskSchedulerPermittedIdentifiers += com.onemundo.mail.chat.refresh
 *     (BGAppRefreshTask registered by
 *     modules/expo-callkit/ios/ChatBgSyncAppDelegateSubscriber.swift — it
 *     refuses to register when this key is missing, so an old prebuild can
 *     never crash at launch).
 *   - UIBackgroundModes ⊇ fetch, remote-notification (already in app.json;
 *     re-asserted idempotently so removing them there can't silently kill the
 *     task).
 * Android needs nothing here: WorkManager is a normal library dependency
 * (modules/expo-callkit/android/build.gradle) and the FCM service already
 * exists. The NSE App Group entitlement is gated in with-notification-service.js.
 */
const { withInfoPlist } = require('expo/config-plugins');

const TASK_ID = 'com.onemundo.mail.chat.refresh';

module.exports = function withBgChatSync(config) {
  return withInfoPlist(config, (cfg) => {
    const ids = Array.isArray(cfg.modResults.BGTaskSchedulerPermittedIdentifiers)
      ? cfg.modResults.BGTaskSchedulerPermittedIdentifiers : [];
    if (!ids.includes(TASK_ID)) ids.push(TASK_ID);
    cfg.modResults.BGTaskSchedulerPermittedIdentifiers = ids;
    const modes = Array.isArray(cfg.modResults.UIBackgroundModes) ? cfg.modResults.UIBackgroundModes : [];
    for (const m of ['fetch', 'remote-notification']) if (!modes.includes(m)) modes.push(m);
    cfg.modResults.UIBackgroundModes = modes;
    return cfg;
  });
};
