// [2026-10-15 settings-split] Categoria "Bia": cabeçalho, ativar, canal de
// aviso (checkmark) e personalização (/bia-settings). Chaves locais
// one_enabled / one_notif_level.
import { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../../context/ThemeContext';
import { useLanguage } from '../../../context/LanguageContext';
import { IconSparkles, IconMail, IconBell, IconPhone } from '../../Icons';
import { SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsIconTile, useGroupedColors } from '../SettingsKit';
import { useLocalKeys, setStorage } from './shared';

export default function BiaCategory() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const gc = useGroupedColors();
  const router = useRouter();
  const [enabled, setEnabled] = useState(true);
  const [level, setLevel] = useState('push');
  useLocalKeys(['one_enabled', 'one_notif_level'], (kv) => {
    if (kv.one_enabled === 'false') setEnabled(false);
    if (kv.one_notif_level) setLevel(kv.one_notif_level);
  });
  return (
    <View>
      <SettingsGroup nativeHeader>
        <View style={st.header}>
          <SettingsIconTile Icon={IconSparkles} size={64} />
          <Text style={[st.name, { color: colors.text }]} numberOfLines={1}>Bia</Text>
          <Text style={[st.desc, { color: gc.secondary }]}>{t('settings.oneAssistantDesc')}</Text>
        </View>
      </SettingsGroup>
      <SettingsGroup footer={t('settings.oneEnabledDesc')}>
        <SettingsSwitchRow title={t('settings.oneEnabled')} value={enabled} onValueChange={(v) => { setEnabled(v); setStorage('one_enabled', String(v)); }} />
      </SettingsGroup>
      {enabled && (
        <SettingsGroup header={t('settings.oneNotifPrefs')} footer={t('settings.oneNotifUrgentDesc')}>
          {[
            { val: 'email', label: t('settings.oneNotifEmail'), Icon: IconMail },
            { val: 'push', label: t('settings.oneNotifPush'), Icon: IconBell },
            { val: 'urgent', label: t('settings.oneNotifUrgent'), Icon: IconPhone },
          ].map(opt => (
            <SettingsRow
              key={opt.val}
              icon={opt.Icon}
              iconTile={false}
              title={opt.label}
              checked={level === opt.val}
              accessibilityRole="radio"
              onPress={() => { setLevel(opt.val); setStorage('one_notif_level', opt.val); }}
            />
          ))}
        </SettingsGroup>
      )}
      <SettingsGroup header={t('settings.rd2.personalization') || 'Personalização'}>
        <SettingsRow
          title={t('settings.rd2.biaVoice') || 'Tom, assinatura e estilo'}
          subtitle={t('settings.biaDesc') || 'Ensine seu tom e assinatura pra ela escrever na sua voz'}
          onPress={() => router.push('/bia-settings')}
        />
      </SettingsGroup>
    </View>
  );
}

const st = StyleSheet.create({
  header: { alignItems: 'center', paddingTop: 22, paddingBottom: 18, paddingHorizontal: 16 },
  name: { fontSize: 22, fontWeight: '600', letterSpacing: -0.3, marginTop: 12 },
  desc: { fontSize: 14, lineHeight: 19, marginTop: 6, textAlign: 'center', maxWidth: 320 },
});
