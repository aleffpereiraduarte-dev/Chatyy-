// [2026-10-18 otp-autofill] Linha de atalhos da tela do código: "Abrir WhatsApp"
// (canal WhatsApp) + colar o código ao voltar (iOS). A lógica fica em
// services/otpAutofill.js (useOtpAutofillAssist); este componente só desenha.
// iOS 16+: botão NATIVO de colar (UIPasteControl, sem prompt); senão "Colar
// código", que lê o clipboard só no toque.
import { Text, TouchableOpacity, View } from 'react-native';
import { useLanguage } from '../context/LanguageContext';
import { IconCopy, IconMessageCircle } from './Icons';
import { getNativePasteButton } from '../services/otpAutofill';

export default function OtpAssist({ assist, colors, style }) {
  const { t } = useLanguage();
  if (!assist || (!assist.showOpenWhatsApp && !assist.pasteVisible)) return null;
  const NativePaste = assist.pasteVisible && assist.nativePaste ? getNativePasteButton() : null;
  const pill = {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    minHeight: 44, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 999,
  };
  return (
    <View style={[{ alignItems: 'center', gap: 10, marginTop: 14 }, style]}>
      {assist.pasteVisible && (
        NativePaste ? (
          <NativePaste
            onPress={assist.onNativePaste}
            acceptedContentTypes={['plain-text']}
            displayMode="iconAndLabel"
            cornerStyle="capsule"
            backgroundColor={colors.primary}
            foregroundColor={colors.onPrimary || '#ffffff'}
            style={{ width: 150, height: 44 }}
          />
        ) : (
          <TouchableOpacity
            onPress={assist.onPasteTap}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel={t('otpAssist.pasteCode')}
            style={[pill, { backgroundColor: colors.primary }]}
          >
            <IconCopy size={16} color={colors.onPrimary || '#ffffff'} />
            <Text style={{ fontSize: 14, fontWeight: '700', color: colors.onPrimary || '#ffffff' }}>{t('otpAssist.pasteCode')}</Text>
          </TouchableOpacity>
        )
      )}
      {assist.showOpenWhatsApp && !assist.pasteVisible && (
        <>
          <TouchableOpacity
            onPress={assist.openWhatsApp}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel={t('otpAssist.openWhatsapp')}
            style={[pill, { backgroundColor: `${colors.primary}14` }]}
          >
            <IconMessageCircle size={16} color={colors.primary} />
            <Text style={{ fontSize: 14, fontWeight: '700', color: colors.primary }}>{t('otpAssist.openWhatsapp')}</Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 12, lineHeight: 17, color: colors.textSecondary, textAlign: 'center', paddingHorizontal: 12 }}>
            {t('otpAssist.copyHint')}
          </Text>
        </>
      )}
    </View>
  );
}
