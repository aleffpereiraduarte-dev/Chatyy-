/**
 * [2026-10-15 photos-native] Config plugin do backup de fotos nativo
 * (modules/expo-photos-backup).
 *
 * iOS (Info.plist):
 *   - BGTaskSchedulerPermittedIdentifiers += com.onemundo.mail.photos.backup
 *     (BGProcessingTask) e com.onemundo.mail.photos.refresh (BGAppRefreshTask).
 *     O PhotosBackupAppDelegateSubscriber só registra ids presentes aqui →
 *     prebuild sem o plugin nunca crasha no launch.
 *   - UIBackgroundModes ⊇ fetch, processing.
 *   - NSPhotoLibraryUsageDescription já existe no app.json (não mexe).
 * Android: permissões/serviço vêm do AndroidManifest do próprio módulo.
 */
const { withInfoPlist } = require('expo/config-plugins');

const TASK_IDS = ['com.onemundo.mail.photos.backup', 'com.onemundo.mail.photos.refresh'];

module.exports = function withPhotosBackup(config) {
  return withInfoPlist(config, (cfg) => {
    const ids = Array.isArray(cfg.modResults.BGTaskSchedulerPermittedIdentifiers)
      ? cfg.modResults.BGTaskSchedulerPermittedIdentifiers : [];
    for (const id of TASK_IDS) if (!ids.includes(id)) ids.push(id);
    cfg.modResults.BGTaskSchedulerPermittedIdentifiers = ids;
    const modes = Array.isArray(cfg.modResults.UIBackgroundModes) ? cfg.modResults.UIBackgroundModes : [];
    for (const m of ['fetch', 'processing']) if (!modes.includes(m)) modes.push(m);
    cfg.modResults.UIBackgroundModes = modes;
    return cfg;
  });
};
