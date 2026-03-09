/**
 * Expo Config Plugin: Fix JitPack dependency resolution
 *
 * The EAS Build servers cannot access jitpack.io, which causes Gradle to fail
 * when resolving version ranges for transitive dependencies (like org.bouncycastle).
 *
 * This plugin modifies the root build.gradle to:
 * 1. Exclude JitPack from the repositories list
 * 2. Force a specific version of bouncycastle so Gradle doesn't need to resolve ranges
 */
const { withProjectBuildGradle, withSettingsGradle } = require('expo/config-plugins');

function withFixJitpack(config) {
  // Fix settings.gradle - remove JitPack from dependencyResolutionManagement
  config = withSettingsGradle(config, (config) => {
    let contents = config.modResults.contents;

    // Remove any JitPack maven repository blocks
    contents = contents.replace(
      /\s*maven\s*\{\s*url\s*['"]https?:\/\/(?:www\.)?jitpack\.io['"]\s*\}/g,
      ''
    );
    // Also handle the format: maven { url = uri("https://jitpack.io") }
    contents = contents.replace(
      /\s*maven\s*\{\s*url\s*=\s*uri\(\s*['"]https?:\/\/(?:www\.)?jitpack\.io['"]\s*\)\s*\}/g,
      ''
    );

    config.modResults.contents = contents;
    return config;
  });

  // Fix build.gradle - add resolution strategy and remove JitPack
  config = withProjectBuildGradle(config, (config) => {
    let contents = config.modResults.contents;

    // Remove any JitPack maven repository blocks
    contents = contents.replace(
      /\s*maven\s*\{\s*url\s*['"]https?:\/\/(?:www\.)?jitpack\.io['"]\s*\}/g,
      ''
    );
    contents = contents.replace(
      /\s*maven\s*\{\s*url\s*=\s*uri\(\s*['"]https?:\/\/(?:www\.)?jitpack\.io['"]\s*\)\s*\}/g,
      ''
    );

    // Add resolution strategy to force bouncycastle version
    // This goes into allprojects block
    const forceResolution = `
    // Fix: Force bouncycastle version to avoid JitPack resolution
    subprojects {
        configurations.all {
            resolutionStrategy {
                force 'org.bouncycastle:bcprov-jdk15to18:1.81'
                force 'org.bouncycastle:bcutil-jdk15to18:1.81'
                force 'org.bouncycastle:bcpkix-jdk15to18:1.81'
                force 'org.bouncycastle:bctls-jdk15to18:1.81'
            }
        }
    }`;

    // Add before the last closing brace or at the end
    if (contents.includes('allprojects')) {
      // Add inside allprojects block
      contents = contents.replace(
        /(allprojects\s*\{[^}]*)(})/,
        `$1${forceResolution}\n$2`
      );
    } else {
      // Add at the end
      contents += `\n${forceResolution}\n`;
    }

    config.modResults.contents = contents;
    return config;
  });

  return config;
}

module.exports = withFixJitpack;
