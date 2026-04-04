// Expo config plugin: Android Auto Backup
// Configures backup_rules.xml so SQLite DB + MMKV survive reinstall
// Excludes media cache to keep backup small

const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');
const { mkdirSync, writeFileSync } = require('fs');
const { resolve, join } = require('path');

function withAndroidBackup(config) {
  // Step 1: Set allowBackup and fullBackupContent in AndroidManifest.xml
  config = withAndroidManifest(config, (config) => {
    const mainApp = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    mainApp.$['android:allowBackup'] = 'true';
    mainApp.$['android:fullBackupContent'] = '@xml/backup_rules';
    // For Android 12+ (API 31+)
    mainApp.$['android:dataExtractionRules'] = '@xml/data_extraction_rules';
    return config;
  });

  // Step 2: Create backup_rules.xml and data_extraction_rules.xml
  const { withDangerousMod } = require('expo/config-plugins');
  config = withDangerousMod(config, ['android', (config) => {
    const resXmlDir = join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
    mkdirSync(resXmlDir, { recursive: true });

    // Android 11 and below
    writeFileSync(join(resXmlDir, 'backup_rules.xml'),
`<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
  <!-- SQLite databases (chat history, cache) -->
  <include domain="database" path="chatyy.db" />
  <include domain="database" path="chatyy_cache.db" />

  <!-- MMKV preferences -->
  <include domain="file" path="mmkv/" />

  <!-- Shared preferences -->
  <include domain="sharedpref" path="." />

  <!-- Exclude large cache files -->
  <exclude domain="cache" path="." />
  <exclude domain="file" path="audio-cache/" />
  <exclude domain="file" path="chat-media-cache/" />
  <exclude domain="file" path="photo_thumbs/" />
  <exclude domain="database" path="RKStorage" />
  <exclude domain="file" path="expo-updates/" />
</full-backup-content>`);

    // Android 12+ (API 31+)
    writeFileSync(join(resXmlDir, 'data_extraction_rules.xml'),
`<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
    <include domain="database" path="chatyy.db" />
    <include domain="database" path="chatyy_cache.db" />
    <include domain="file" path="mmkv/" />
    <include domain="sharedpref" path="." />
    <exclude domain="cache" path="." />
    <exclude domain="file" path="audio-cache/" />
    <exclude domain="file" path="chat-media-cache/" />
    <exclude domain="file" path="photo_thumbs/" />
    <exclude domain="database" path="RKStorage" />
    <exclude domain="file" path="expo-updates/" />
  </cloud-backup>
  <device-transfer>
    <include domain="database" path="chatyy.db" />
    <include domain="database" path="chatyy_cache.db" />
    <include domain="file" path="mmkv/" />
    <include domain="sharedpref" path="." />
    <exclude domain="cache" path="." />
  </device-transfer>
</data-extraction-rules>`);

    return config;
  }]);

  return config;
}

module.exports = withAndroidBackup;
