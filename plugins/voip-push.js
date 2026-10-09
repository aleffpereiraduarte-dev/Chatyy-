/**
 * Config plugin for react-native-voip-push-notification
 * Adds VoIP background mode and push entitlement for iOS
 */
const { withInfoPlist, withEntitlementsPlist } = require('expo/config-plugins');

function withVoipPush(config) {
  // Add 'voip' to UIBackgroundModes
  config = withInfoPlist(config, (config) => {
    const bgModes = config.modResults.UIBackgroundModes || [];
    if (!bgModes.includes('voip')) {
      bgModes.push('voip');
    }
    if (!bgModes.includes('audio')) {
      bgModes.push('audio');
    }
    if (!bgModes.includes('fetch')) {
      bgModes.push('fetch');
    }
    if (!bgModes.includes('remote-notification')) {
      bgModes.push('remote-notification');
    }
    config.modResults.UIBackgroundModes = bgModes;
    // [2026-10-09 recents-redial] Phone.app Recents / CarPlay / Siri hand the
    // app an INStartCallIntent user activity (CallIntentAppDelegateSubscriber).
    // Merge — never drop INSendMessageIntent (Communication Notifications).
    const activityTypes = Array.isArray(config.modResults.NSUserActivityTypes)
      ? config.modResults.NSUserActivityTypes
      : [];
    for (const type of ['INStartCallIntent', 'INStartAudioCallIntent', 'INStartVideoCallIntent']) {
      if (!activityTypes.includes(type)) activityTypes.push(type);
    }
    config.modResults.NSUserActivityTypes = activityTypes;
    return config;
  });

  // Add push entitlement
  config = withEntitlementsPlist(config, (config) => {
    config.modResults['aps-environment'] =
      config.modResults['aps-environment'] || 'production';
    // [2026-10-09 pip-camera] Camera keeps running while the video call is in
    // Picture-in-Picture (CallMultitaskingCamera). MANAGED entitlement: Apple
    // must grant it to the team first (request form "Multitasking Camera
    // Access"), and the App ID / provisioning profile must include it —
    // otherwise signing fails. Gated OFF until then.
    if (process.env.CHATYY_MULTITASK_CAMERA === '1') {
      config.modResults['com.apple.developer.avfoundation.multitasking-camera-access'] = true;
    }
    return config;
  });

  return config;
}

module.exports = withVoipPush;
