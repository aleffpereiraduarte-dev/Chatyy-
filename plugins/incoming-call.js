/**
 * Config plugin for native incoming call UI
 * - Android: Full-screen intent notification for lock screen call UI
 * - iOS: CallKit integration for native phone call UI
 */
const {
  withAndroidManifest,
  withInfoPlist,
  withEntitlementsPlist,
} = require('expo/config-plugins');

function withIncomingCall(config) {
  // ─── Android: Full-Screen Intent ───
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const app = manifest.manifest.application?.[0];
    if (!app) return config;

    // Add IncomingCallActivity that shows over lock screen
    if (!app.activity) app.activity = [];

    const hasCallActivity = app.activity.some(
      (a) => a.$?.['android:name'] === '.IncomingCallActivity'
    );

    if (!hasCallActivity) {
      app.activity.push({
        $: {
          'android:name': '.IncomingCallActivity',
          'android:theme': '@style/Theme.AppCompat.NoActionBar',
          'android:showOnLockScreen': 'true',
          'android:showWhenLocked': 'true',
          'android:turnScreenOn': 'true',
          'android:taskAffinity': '',
          'android:excludeFromRecents': 'true',
          'android:exported': 'false',
          'android:launchMode': 'singleInstance',
        },
      });
    }

    return config;
  });

  // ─── iOS: CallKit + VoIP background mode ───
  config = withInfoPlist(config, (config) => {
    // Ensure voip is in UIBackgroundModes
    const bgModes = config.modResults.UIBackgroundModes || [];
    if (!bgModes.includes('voip')) {
      bgModes.push('voip');
    }
    config.modResults.UIBackgroundModes = bgModes;
    return config;
  });

  config = withEntitlementsPlist(config, (config) => {
    // Enable push notification entitlement (needed for VoIP)
    config.modResults['aps-environment'] =
      config.modResults['aps-environment'] || 'production';
    return config;
  });

  return config;
}

module.exports = withIncomingCall;
