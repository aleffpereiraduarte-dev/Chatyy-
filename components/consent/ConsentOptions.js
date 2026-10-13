// [2026-10-13 consent-lgpd] As duas opções OPCIONAIS (consentimento específico,
// art. 8º LGPD) como caixas de seleção — DESMARCADAS por padrão, independentes,
// com texto curto + "Saiba mais" (abre a Política no item certo).
// Usado no fim do cadastro (signup-phone / signup-username) e no aviso
// "Atualizamos nossos Termos" (TermsUpdateNotice). Controlado: value/onChange.
import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useLanguage } from '../../context/LanguageContext';
import { IconCheck } from '../Icons';
import { recordSignupConsents, setConsent } from '../../services/consents';

export const OPTIONAL_CONSENTS = ['chat_interests', 'marketing'];

function CheckRow({ checked, onToggle, title, desc, colors, learnMore, onLearnMore, testID }) {
  return (
    <Pressable
      onPress={onToggle}
      style={({ pressed }) => [st.row, { opacity: pressed ? 0.85 : 1 }]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: !!checked }}
      accessibilityLabel={title}
      testID={testID}
      hitSlop={4}
    >
      <View style={[st.box, {
        borderColor: checked ? colors.text : (colors.textTertiary || colors.border),
        backgroundColor: checked ? colors.text : 'transparent',
      }]}>
        {checked ? <IconCheck size={14} color={colors.background} strokeWidth={3} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[st.title, { color: colors.text }]}>{title}</Text>
        <Text style={[st.desc, { color: colors.textSecondary }]}>
          {desc}{' '}
          <Text style={{ color: colors.text, fontWeight: '600', textDecorationLine: 'underline' }} onPress={onLearnMore} accessibilityRole="link">
            {learnMore}
          </Text>
        </Text>
      </View>
    </Pressable>
  );
}

export default function ConsentOptions({ value = {}, onChange, colors, showHint = true, style }) {
  const { t } = useLanguage();
  const router = useRouter();
  const learnMore = t('consents.learnMore');
  const openPolicy = () => { try { router.push({ pathname: '/legal', params: { doc: 'privacy' } }); } catch {} };
  const toggle = (k) => onChange && onChange({ ...value, [k]: !value[k] });
  return (
    <View style={[{ alignSelf: 'stretch', gap: 14 }, style]}>
      <CheckRow
        checked={!!value.chat_interests}
        onToggle={() => toggle('chat_interests')}
        title={t('consents.chatInterestsTitle')}
        desc={t('consents.chatInterestsShort')}
        learnMore={learnMore}
        onLearnMore={openPolicy}
        colors={colors}
        testID="consent-chat-interests"
      />
      <CheckRow
        checked={!!value.marketing}
        onToggle={() => toggle('marketing')}
        title={t('consents.marketingTitle')}
        desc={t('consents.marketingShort')}
        learnMore={learnMore}
        onLearnMore={openPolicy}
        colors={colors}
        testID="consent-marketing"
      />
      {showHint && (
        <Text style={[st.hint, { color: colors.textTertiary || colors.textSecondary }]}>{t('consents.optionalHint')}</Text>
      )}
    </View>
  );
}

// Bloco da etapa final do cadastro (conta já criada → já há sessão). Ao montar
// grava a PROVA: aceite dos Termos/Política (versão atual) + as duas opções como
// foram apresentadas (desmarcadas). Cada toque grava a mudança (canal 'signup').
export function SignupConsentBlock({ colors, style }) {
  const { t } = useLanguage();
  const [value, setValue] = useState({ chat_interests: false, marketing: false });
  const recordedRef = useRef(false);
  useEffect(() => {
    if (recordedRef.current) return;
    recordedRef.current = true;
    recordSignupConsents({ chat_interests: false, marketing: false }).catch(() => {});
  }, []);
  const onChange = (next) => {
    OPTIONAL_CONSENTS.forEach((k) => {
      if (!!next[k] !== !!value[k]) setConsent(k, !!next[k], 'signup').catch(() => {});
    });
    setValue(next);
  };
  return (
    <View style={[{ alignSelf: 'stretch' }, style]}>
      <Text style={[st.blockTitle, { color: colors.text }]}>{t('consents.signupTitle')}</Text>
      <ConsentOptions value={value} onChange={onChange} colors={colors} />
    </View>
  );
}

const st = StyleSheet.create({
  blockTitle: { fontSize: 15, fontWeight: '700', marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  title: { fontSize: 14, fontWeight: '600', lineHeight: 19 },
  desc: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  hint: { fontSize: 12, lineHeight: 17 },
});
