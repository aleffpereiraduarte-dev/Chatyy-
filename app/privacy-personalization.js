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
 *   - [mural-cerebro 2026-10-20] Mural: "Personalizar o Mural com base na minha atividade" (LIGADO;
 *     desligar = Mural em ordem de tempo e nada de comportamento guardado) + "Limpar histórico de
 *     interesses" (Mural e Reels; services/muralSignals → mural_prefs / mural_interest_clear).
 * Cada mudança vira um registro no servidor (services/consents.js → consent_set,
 * canal 'settings'). Revogar é tão fácil quanto consentir: um toque.
 */
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useLanguage } from '../context/LanguageContext';
import FadeSlideIn from '../components/FadeSlideIn';
import { SettingsScreen, SettingsGroup, SettingsRow, SettingsSwitchRow, useGroupedColors } from '../components/settings/SettingsKit';
import { useConsentState, setConsent, TERMS_VERSION } from '../services/consents';
import { muralPrefsGet, muralPrefsSet, muralInterestClear } from '../services/muralSignals';

export default function PrivacyPersonalizationScreen() {
  const { t } = useLanguage();
  const router = useRouter();
  const g = useGroupedColors();
  const s = useConsentState();
  const [failed, setFailed] = useState(false);
  const [mural, setMural] = useState(null); // { personalize } — null = carregando / sem rede
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    let alive = true;
    muralPrefsGet().then((d) => { if (alive && d) setMural({ personalize: d.personalize !== false }); });
    return () => { alive = false; };
  }, []);
  const toggleMural = async (v) => {
    const prev = mural;
    setMural({ personalize: !!v });
    const d = await muralPrefsSet(!!v);
    if (!d) { setMural(prev); setFailed(true); }
  };
  const clearMural = async () => {
    let ok = false;
    try {
      ok = await require('../utils/confirm').confirmAsync({
        title: t('mural.prefs.clearTitle'), message: t('mural.prefs.clearMsg'),
        confirmLabel: t('mural.prefs.clearConfirm'), destructive: true,
      });
    } catch { ok = false; }
    if (!ok) return;
    setClearing(true);
    const done = await muralInterestClear();
    setClearing(false);
    try { require('../components/ui/Toast').showToast({ message: done ? t('mural.prefs.cleared') : t('mural.prefs.clearFailed'), kind: done ? 'success' : 'error' }); } catch {}
  };

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

        <SettingsGroup header={t('mural.prefs.section')} footer={t('mural.prefs.footer')}>
          <SettingsSwitchRow
            title={t('mural.prefs.personalizeTitle')}
            subtitle={t('mural.prefs.personalizeDesc')}
            value={mural ? mural.personalize : true}
            disabled={!mural}
            onValueChange={toggleMural}
            testID="mural-personalize-switch"
          />
          <SettingsRow
            title={t('mural.prefs.clear')}
            destructive
            disabled={clearing}
            onPress={clearMural}
            testID="mural-clear-interests"
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
