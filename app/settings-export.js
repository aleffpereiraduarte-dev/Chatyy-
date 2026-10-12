// [2026-10-11 settings-unify] /settings-export — sub-tela do hub de Configurações.
// Conteúdo único em components/settings/SettingsPanels.js (ExportDataPanel);
// antes duplicado no ProfileSettingsSheet / ChatProfileTab.
import React from 'react';
import { useResponsive } from '../utils/responsive';
import { useLanguage } from '../context/LanguageContext';
import { SettingsScreen } from '../components/settings/SettingsKit';
import { ExportDataPanel } from '../components/settings/SettingsPanels';

export default function SettingsExportScreen() {
  const { t } = useLanguage();
  const { contentMaxWidth } = useResponsive();
  return (
    <SettingsScreen title={t('settings.exportData') || 'Baixar meus dados'} contentStyle={{ maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }}>
      <ExportDataPanel />
    </SettingsScreen>
  );
}
