/**
 * /privacy-personalization — Ajustes > Privacidade > "Personalização e ofertas".
 * [2026-10-13 consent-lgpd]
 *
 *   - Recomendações personalizadas (legítimo interesse; LIGADO por padrão —
 *     desligar = oposição → feed por popularidade/recentes).
 *   - Usar interesses das minhas conversas e e-mails (consentimento; DESLIGADO
 *     por padrão; extração no aparelho — recurso ainda desligado no produto, o
 *     switch só grava a preferência).
 *   - Receber ofertas e promoções do Chatyy e parceiros (consentimento; DESLIGADO).
 * Cada mudança vira um registro no servidor (services/consents.js → consent_set,
 * canal 'settings'). Revogar é tão fácil quanto consentir: um toque.
 */
import { useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useLanguage } from '../context/LanguageContext';
import FadeSlideIn from '../components/FadeSlideIn';
import { SettingsScreen, SettingsGroup, SettingsRow, SettingsSwitchRow, useGroupedColors } from '../components/settings/SettingsKit';
import { useConsentState, setConsent, TERMS_VERSION } from '../services/consents';

export default function PrivacyPersonalizationScreen() {
  const { t } = useLanguage();
  const router = useRouter();
  const g = useGroupedColors();
  const s = useConsentState();
  const [failed, setFailed] = useState(false);

  const change = (purpose) => async (v) => {
    setFailed(false);
    const ok = await setConsent(purpose, v, 'settings');
    if (!ok) setFailed(true); // fica na fila e reenvia sozinho
  };

  return (
    <SettingsScreen title={t('consents.title')}>
      {!s.loaded ? null : (
      <FadeSlideIn>
        <Text style={{ color: g.secondary, fontSize: 14, lineHeight: 20, marginHorizontal: 16, marginBottom: 14 }}>
          {t('consents.intro')}
        </Text>

        <SettingsGroup header={t('consents.sectionRecommendations')} footer={t('consents.personalizedFooter')}>
          <SettingsSwitchRow
            title={t('consents.personalizedTitle')}
            subtitle={t('consents.personalizedDesc')}
            value={s.personalization !== false}
            onValueChange={change('personalization')}
            testID="consent-personalization-switch"
          />
        </SettingsGroup>

        <SettingsGroup header={t('consents.sectionOptional')} footer={t('consents.recordNote')}>
          <SettingsSwitchRow
            title={t('consents.chatInterestsTitle')}
            subtitle={t('consents.chatInterestsDesc')}
            value={s.chat_interests === true}
            onValueChange={change('chat_interests')}
            testID="consent-chat-interests-switch"
          />
          <SettingsSwitchRow
            title={t('consents.marketingTitle')}
            subtitle={t('consents.marketingDesc')}
            value={s.marketing === true}
            onValueChange={change('marketing')}
            testID="consent-marketing-switch"
          />
        </SettingsGroup>

        {(failed || s.pendingCount > 0) && (
          <View style={{ marginHorizontal: 16, marginBottom: 14 }}>
            <Text style={{ color: g.secondary, fontSize: 13, lineHeight: 18 }}>{t('consents.saveFailed')}</Text>
          </View>
        )}

        <SettingsGroup header={t('consents.sectionDocs')} footer={`${t('legal.version')} ${TERMS_VERSION}`}>
          <SettingsRow
            title={t('plans.privacyPolicy')}
            onPress={() => router.push({ pathname: '/legal', params: { doc: 'privacy' } })}
          />
          <SettingsRow
            title={t('plans.termsOfUse')}
            onPress={() => router.push({ pathname: '/legal', params: { doc: 'terms' } })}
          />
        </SettingsGroup>
      </FadeSlideIn>
      )}
    </SettingsScreen>
  );
}
