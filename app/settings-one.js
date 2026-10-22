// [2026-10-11 settings-unify] /settings-one — sub-tela do hub de Configurações.
// Conteúdo único em components/settings/SettingsPanels.js (ChatyyOnePanel);
// antes duplicado no ProfileSettingsSheet / ChatProfileTab.
import React from 'react';
import { useResponsive } from '../utils/responsive';
import { useLanguage } from '../context/LanguageContext';
import { SettingsScreen } from '../components/settings/SettingsKit';
import { ChatyyOnePanel } from '../components/settings/SettingsPanels';
import { PLAN_NAME } from '../services/brandPlan';
import { usePlanState, planDisplayName } from '../services/planState';

export default function SettingsOneScreen() {
  const { t } = useLanguage();
  const { contentMaxWidth } = useResponsive();
  // [2026-10-19 plano-consistente] assinante Pro via "Chatyy Plus" no título e
  // "Chatyy Pro" no cartão → título = plano ATUAL quando pago.
  const { plan } = usePlanState();
  const title = plan && plan.isPaid && plan.planId !== 'free' ? planDisplayName(plan.planId, t) : (t('chatyyOne.title') || PLAN_NAME);
  return (
    // [2026-10-22 plano-titulo] padrão Ajustes do iPhone: título grande que ROLA com o conteúdo e
    // colapsa no título pequeno centralizado da barra. Barra SÓLIDA (opaqueHeader, = manage-storage):
    // no vidro transparente o título grande ficava fixo e o cartão passava por baixo
    // (prints 20261022-075733 e 20261022-213156; o largeTitle={false} anterior não pegava porque
    // a rota no _layout já nascia com headerLargeTitle).
    <SettingsScreen title={title} opaqueHeader contentStyle={{ maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }}>
      <ChatyyOnePanel />
    </SettingsScreen>
  );
}
