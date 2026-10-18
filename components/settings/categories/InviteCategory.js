// [2026-10-15 settings-split] Categoria "Convidar amigos": código (toque
// copia) e compartilhar. Dados: settingsCache 'referral'.
import { View, Text, ActivityIndicator, Alert, Platform, Share, StyleSheet } from 'react-native';
import { useTheme } from '../../../context/ThemeContext';
import { useLanguage } from '../../../context/LanguageContext';
import { IconCopy, IconShare } from '../../Icons';
import { SettingsGroup, SettingsRow, useGroupedColors } from '../SettingsKit';
import { useSection } from './shared';

export default function InviteCategory() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const gc = useGroupedColors();
  const ref = useSection('referral');
  const code = (ref && ref.code) || '';
  const count = (ref && ref.referred_count) || 0;
  const share = async () => {
    const link = `https://chatyy.com.br/signup?ref=${code}`;
    const msg = t('referral.shareMessage').replace('{code}', code).replace('{link}', link);
    if (Platform.OS === 'web') {
      try { await navigator.clipboard.writeText(msg); Alert.alert(t('referral.copied')); }
      catch { try { await navigator.share({ text: msg }); } catch {} }
    } else {
      try { await Share.share({ message: msg }); } catch {}
    }
  };
  return (
    <View>
      <SettingsGroup
        header={t('referral.inviteFriends') || 'Convidar amigos'}
        footer={`${t('referral.subtitle') || '1 GB grátis pra cada amigo que entrar'} · ${(count === 1
          ? (t('settings.rd.referralStatsOne') || '1 amigo convidado · +1 GB')
          : (t('settings.rd.referralStats') || '{n} amigos convidados · +{n} GB')).split('{n}').join(String(count || 0))}`}
      >
        {code ? (
          <SettingsRow
            title={t('referral.yourCode') || 'Seu código'}
            accessibilityLabel={t('referral.copyCode') || 'Tocar pra copiar código'}
            native={{ val: code, acc: 'n' }}
            onPress={async () => {
              try {
                const Clipboard = require('expo-clipboard');
                await Clipboard.setStringAsync(code);
                Alert.alert(t('referral.copied') || 'Código copiado');
              } catch {}
            }}
            right={(
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[st.code, { color: colors.text }]}>{code}</Text>
                <IconCopy size={17} color={gc.secondary} style={{ marginLeft: 10 }} />
              </View>
            )}
          />
        ) : (
          <SettingsRow title={t('referral.yourCode') || 'Seu código'} right={<ActivityIndicator size="small" color={colors.text} />} />
        )}
        {!!code && (
          <SettingsRow title={t('settings.rd.shareInvite') || 'Compartilhar convite'} onPress={share} chevron={false} right={<IconShare size={18} color={gc.secondary} />} native={{ acc: 'c' }} />
        )}
      </SettingsGroup>
    </View>
  );
}

const st = StyleSheet.create({
  code: { fontSize: 16, fontWeight: '600', letterSpacing: 1.5, fontVariant: ['tabular-nums'] },
});
