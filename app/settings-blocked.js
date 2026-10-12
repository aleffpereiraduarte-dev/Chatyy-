// [2026-10-11 settings-unify] /settings-blocked — sub-tela do hub de Configurações.
// Conteúdo único em components/settings/SettingsPanels.js (BlockedContactsPanel);
// antes duplicado no ProfileSettingsSheet / ChatProfileTab.
import React from 'react';
import { useResponsive } from '../utils/responsive';
import { useLanguage } from '../context/LanguageContext';
import { SettingsScreen } from '../components/settings/SettingsKit';
import { BlockedContactsPanel } from '../components/settings/SettingsPanels';

export default function SettingsBlockedScreen() {
  const { t } = useLanguage();
  const { contentMaxWidth } = useResponsive();
  return (
    <SettingsScreen title={t('settings.blockedContacts') || 'Contatos bloqueados'} contentStyle={{ maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }}>
      <BlockedContactsPanel />
    </SettingsScreen>
  );
}
