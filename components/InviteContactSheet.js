// [2026-10-13 contacts-invite] Folha "Convidar para o Chatyy" — o que abre ao
// tocar num contato que NÃO tem conta Chatyy (não há perfil p/ abrir).
// iOS/Android: sheet do sistema (NativeSheetDialog); web: Modal com backdrop.
//
// <InviteContactSheet visible contact={{ name, phone, email }} onClose
//    onEdit?={() => …} onSave?={() => …} />
import React, { useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import NativeSheetDialog from './NativeSheetDialog';
import { runAfterNativeSheet } from './NativeSheet';
import AvatarCircle from './AvatarCircle';
import {
  IconShare, IconMessageSquare, IconMessageCircle, IconMail, IconPhone, IconCopy, IconEdit, IconPlus,
} from './Icons';
import {
  prefetchInviteRef, shareInvite, inviteBySms, inviteByWhatsApp, inviteByEmail,
  callNumber, smsNumber, copyText,
} from '../services/inviteContact';
import { isPstnEnabled } from '../constants/featureFlags'; // [2026-10-17 sem-pstn]

function Row({ icon: Icon, label, onPress, colors, strong }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={st.row}
    >
      <View style={[st.iconWrap, { backgroundColor: strong ? colors.text : (colors.surfaceVariant || colors.borderLight) }]}>
        <Icon size={18} color={strong ? colors.background : colors.text} />
      </View>
      <Text style={[st.rowLabel, { color: colors.text, fontWeight: strong ? '700' : '500' }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function InviteContactSheet({ visible, contact, onClose, onEdit, onSave }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const name = String(contact?.name || '').trim();
  const phone = String(contact?.phone || '').trim();
  const email = String(contact?.email || '').trim();
  const title = name || phone || email || '?';
  const native = Platform.OS !== 'web';

  // Código de indicação em 2º plano (1x, cache 30d) — nunca bloqueia o toque.
  useEffect(() => { if (visible) { try { prefetchInviteRef(); } catch {} } }, [visible]);

  // Fecha a folha e só então executa (Share/Modal/abrir app) — o sistema
  // ignora uma apresentação nova enquanto o sheet ainda está descendo.
  const run = (fn) => () => { try { onClose?.(); } catch {} runAfterNativeSheet(() => { try { fn(); } catch {} }); };
  const tr = (k, fb, p) => { const v = t(k, p); return v && v !== k ? v : fb; };

  return (
    <NativeSheetDialog
      visible={!!visible}
      onClose={onClose}
      animationType="slide"
      overlayStyle={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}
      panelStyle={{
        backgroundColor: colors.surface || colors.background,
        borderTopLeftRadius: 20, borderTopRightRadius: 20,
        paddingHorizontal: 16, paddingTop: 18, paddingBottom: 24,
        width: '100%', maxWidth: 520, alignSelf: 'center',
      }}
    >
      <View style={st.header}>
        <AvatarCircle name={title} email={email} size={48} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[st.name, { color: colors.text }]} numberOfLines={1}>{title}</Text>
          <Text style={[st.sub, { color: colors.textSecondary }]} numberOfLines={2}>
            {tr('invite.notOnChatyy', 'Ainda não está no Chatyy')}
          </Text>
        </View>
      </View>

      <Row strong icon={IconShare} colors={colors} label={tr('invite.toChatyy', 'Convidar para o Chatyy')} onPress={run(() => shareInvite(t, name))} />
      {!!phone && native && (
        <Row icon={IconMessageSquare} colors={colors} label={tr('invite.viaSms', 'Convidar por SMS')} onPress={run(() => inviteBySms(t, phone, name))} />
      )}
      {!!phone && (
        <Row icon={IconMessageCircle} colors={colors} label={tr('invite.viaWhatsApp', 'Convidar pelo WhatsApp')} onPress={run(() => inviteByWhatsApp(t, phone, name))} />
      )}
      {!!email && email.includes('@') && (
        <Row icon={IconMail} colors={colors} label={tr('invite.viaEmail', 'Convidar por e-mail')} onPress={run(() => inviteByEmail(t, email, name))} />
      )}

      {!!phone && <View style={[st.sep, { backgroundColor: colors.borderLight || colors.border }]} />}
      {/* [2026-10-17 sem-pstn] Ligações só pelo Chatyy: sem "Ligar" (tel:) p/ quem não tem Chatyy. */}
      {!!phone && native && isPstnEnabled() && (
        <Row icon={IconPhone} colors={colors} label={tr('invite.call', 'Ligar')} onPress={run(() => callNumber(phone))} />
      )}
      {!!phone && native && (
        <Row icon={IconMessageSquare} colors={colors} label={tr('invite.sendSms', 'Enviar SMS')} onPress={run(() => smsNumber(phone))} />
      )}
      {!!phone && (
        <Row icon={IconCopy} colors={colors} label={tr('invite.copyNumber', 'Copiar número')} onPress={run(() => copyText(phone, t, tr('invite.numberCopied', 'Número copiado')))} />
      )}

      {(onSave || onEdit) && <View style={[st.sep, { backgroundColor: colors.borderLight || colors.border }]} />}
      {!!onSave && (
        <Row icon={IconPlus} colors={colors} label={tr('invite.saveContact', 'Salvar nos meus contatos')} onPress={run(onSave)} />
      )}
      {!!onEdit && (
        <Row icon={IconEdit} colors={colors} label={tr('contacts.editContact', 'Editar contato')} onPress={run(onEdit)} />
      )}

      <TouchableOpacity onPress={onClose} accessibilityRole="button" style={st.cancel} activeOpacity={0.6}>
        <Text style={[st.cancelText, { color: colors.textSecondary }]}>{tr('common.cancel', 'Cancelar')}</Text>
      </TouchableOpacity>
    </NativeSheetDialog>
  );
}

const st = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 14 },
  name: { fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
  sub: { fontSize: 13, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10, minHeight: 48 },
  iconWrap: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  rowLabel: { flex: 1, fontSize: 16 },
  sep: { height: StyleSheet.hairlineWidth, marginVertical: 6, marginLeft: 50 },
  cancel: { alignItems: 'center', paddingVertical: 14, marginTop: 4 },
  cancelText: { fontSize: 15, fontWeight: '600' },
});
