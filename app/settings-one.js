// [2026-10-11 settings-unify] /settings-one — sub-tela do hub de Configurações.
// Conteúdo único em components/settings/SettingsPanels.js (ChatyyOnePanel);
// antes duplicado no ProfileSettingsSheet / ChatProfileTab.
import React from 'react';
import { useResponsive } from '../utils/responsive';
import { useLanguage } from '../context/LanguageContext';
import { SettingsScreen } from '../components/settings/SettingsKit';
import { ChatyyOnePanel } from '../components/settings/SettingsPanels';
import { PLAN_NAME } from '../services/brandPlan';

export default function SettingsOneScreen() {
  const { t } = useLanguage();
  const { contentMaxWidth } = useResponsive();
  return (
    <SettingsScreen title={t('chatyyOne.title') || PLAN_NAME} contentStyle={{ maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }}>
      <ChatyyOnePanel />
    </SettingsScreen>
  );
}
