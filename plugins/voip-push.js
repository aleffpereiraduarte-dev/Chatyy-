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
    if (!bgModes.includes('fetch')) {
      bgModes.push('fetch');
    }
    if (!bgModes.includes('remote-notification')) {
      bgModes.push('remote-notification');
    }
    config.modResults.UIBackgroundModes = bgModes;
    return config;
  });

  // Add push entitlement
  config = withEntitlementsPlist(config, (config) => {
    config.modResults['aps-environment'] =
      config.modResults['aps-environment'] || 'production';
    return config;
  });

  return config;
}

module.exports = withVoipPush;
