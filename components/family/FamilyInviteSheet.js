// [2026-10-19 family-hub] Folha "Convidar familiar" — sheet do sistema
// (NativeSheetDialog → UISheetPresentationController / BottomSheet; web = Modal).
//
// Passo 1: papel (Adulto / Cônjuge / Criança) + para quem (opcional: e-mail,
//          telefone ou um contato da agenda via seletor NATIVO do sistema —
//          expo-contacts presentContactPickerAsync, sem pedir permissão no iOS).
// Passo 2: convite pronto → QR + código + Compartilhar / Copiar.
//
// O token vem de family_invite {target, role} (validade 7 dias, 10/24 h).
// Link do app: onemundomail://family/join/<token> (o servidor ainda devolve
// chatyy://…, esquema que o app não registra) — app/+native-intent.js leva
// esse caminho para /family?join=<token>.
import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, Alert, Share, Platform, StyleSheet } from 'react-native';
import NativeSheetDialog from '../NativeSheetDialog';
import { useLanguage } from '../../context/LanguageContext';
import { haptic } from '../../constants/theme';
import * as api from '../../services/api';
import { IconCheck, IconShare, IconCopy, IconUsers, IconHeartOutline, IconShield } from '../Icons';
import { useFamilyColors, IconContactBook, IconQr } from './familyUi';

let QRCode = null;
try { QRCode = require('react-native-qrcode-svg').default; } catch { QRCode = null; }

export const APP_SCHEME = 'onemundomail';
export function familyJoinLink(token) { return `${APP_SCHEME}://family/join/${token}`; }

export const ROLE_OPTIONS = [
  { key: 'parent', Icon: IconUsers, label: 'family.hub.role.adult', sub: 'family.hub.role.adultSub' },
  { key: 'spouse', Icon: IconHeartOutline, label: 'family.role.spouse', sub: 'family.hub.role.spouseSub' },
  { key: 'child', Icon: IconShield, label: 'family.role.child', sub: 'family.hub.role.childSub' },
];

export default function FamilyInviteSheet({ visible, onClose, initialRole = 'child', familyName, members = [], myEmail = '', onInvited }) {
  const c = useFamilyColors();
  const { t } = useLanguage();
  const [step, setStep] = useState('form');
  const [role, setRole] = useState(initialRole);
  const [target, setTarget] = useState('');
  const [picked, setPicked] = useState(null); // nome do contato escolhido
  const [sending, setSending] = useState(false);
  const [invite, setInvite] = useState(null); // { token, link }
  const [contactPickerOk, setContactPickerOk] = useState(Platform.OS !== 'web');

  useEffect(() => {
    if (!visible) return;
    setStep('form'); setRole(initialRole || 'child'); setTarget(''); setPicked(null); setInvite(null); setSending(false);
  }, [visible, initialRole]);

  const pickContact = async () => {
    try {
      const Contacts = require('expo-contacts');
      if (typeof Contacts?.presentContactPickerAsync !== 'function') { setContactPickerOk(false); return; }
      const ct = await Contacts.presentContactPickerAsync();
      if (!ct) return;
      const email = (ct.emails || []).map(e => e?.email).find(Boolean);
      const phone = (ct.phoneNumbers || []).map(p => p?.number || p?.digits).find(Boolean);
      const v = email || phone || '';
      if (!v) { Alert.alert(t('family.invite.title'), t('family.hub.contactNoInfo')); return; }
      try { haptic.select(); } catch {}
      setTarget(String(v).trim());
      setPicked(ct.name || [ct.firstName, ct.lastName].filter(Boolean).join(' ') || null);
    } catch {
      setContactPickerOk(false);
    }
  };

  const generate = async () => {
    const tgt = target.trim();
    const low = tgt.toLowerCase();
    if (tgt && low === String(myEmail || '').toLowerCase()) { Alert.alert(t('family.invite.title'), t('family.invite.self')); return; }
    if (tgt && members.some(m => String(m.email || '').toLowerCase() === low)) { Alert.alert(t('family.invite.title'), t('family.invite.already')); return; }
    setSending(true);
    try {
      const r = await api.familyInvite(tgt || 'link', role);
      if (r?.success && r?.data?.token) {
        try { haptic.success(); } catch {}
        setInvite({ token: r.data.token, link: familyJoinLink(r.data.token) });
        setStep('done');
        onInvited && onInvited();
      } else {
        // Rate-limit (10/24 h) e afins já chegam com mensagem pt-BR.
        Alert.alert(t('family.invite.title'), r?.message || t('family.invite.sendFailed'));
      }
    } catch {
      Alert.alert(t('family.invite.title'), t('common.networkError'));
    } finally { setSending(false); }
  };

  const shareMsg = invite ? t('family.hub.shareMsg', { family: familyName || t('family.myFamilyLower'), link: invite.link, code: invite.token }) : '';
  const share = () => { if (invite) Share.share({ message: shareMsg }).catch(() => {}); };
  const copy = async () => {
    if (!invite) return;
    try { await require('../../services/inviteContact').copyText(invite.token, t, t('family.hub.codeCopied')); } catch {}
    try { haptic.light(); } catch {}
  };

  const roleRow = (opt, idx) => {
    const on = role === opt.key;
    return (
      <Pressable key={opt.key} onPress={() => { try { haptic.select(); } catch {} setRole(opt.key); }}
        accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={t(opt.label)}
        style={({ pressed }) => [st.roleRow, pressed && { backgroundColor: c.chip }]}>
        <View style={[st.roleIcon, { backgroundColor: c.tileBg }]}><opt.Icon size={17} color={c.tileFg} /></View>
        <View style={[st.roleBody, idx < ROLE_OPTIONS.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.separator }]}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: c.text, fontSize: 16, fontWeight: '600' }}>{t(opt.label)}</Text>
            <Text style={{ color: c.secondary, fontSize: 13, marginTop: 2 }} numberOfLines={2}>{t(opt.sub)}</Text>
          </View>
          <View style={[st.radio, { borderColor: on ? c.chipOn : c.tertiary, backgroundColor: on ? c.chipOn : 'transparent' }]}>
            {on && <IconCheck size={13} color={c.onChipOn} strokeWidth={3} />}
          </View>
        </View>
      </Pressable>
    );
  };

  const form = (
    <View>
      <Text style={[st.title, { color: c.text }]} accessibilityRole="header">{t('family.invite.cta')}</Text>
      <Text style={[st.sub, { color: c.secondary }]}>{t('family.hub.inviteSub')}</Text>

      <Text style={[st.label, { color: c.header }]}>{t('family.invite.roleLabel')}</Text>
      <View style={[st.group, { backgroundColor: c.cardBg }]}>{ROLE_OPTIONS.map(roleRow)}</View>

      <Text style={[st.label, { color: c.header }]}>{t('family.hub.whoLabel')}</Text>
      <View style={[st.group, st.inputRow, { backgroundColor: c.cardBg }]}>
        <TextInput
          value={target}
          onChangeText={(v) => { setTarget(v); if (picked) setPicked(null); }}
          placeholder={t('family.invite.targetPh')}
          placeholderTextColor={c.secondary}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          style={[st.input, { color: c.text }]}
          accessibilityLabel={t('family.invite.targetLabel')}
        />
        {contactPickerOk && (
          <Pressable onPress={pickContact} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('family.hub.pickContact')} style={({ pressed }) => [st.pickBtn, { backgroundColor: c.chip }, pressed && { opacity: 0.6 }]}>
            <IconContactBook size={18} color={c.text} />
          </Pressable>
        )}
      </View>
      <Text style={[st.foot, { color: c.secondary }]}>{picked ? t('family.hub.pickedContact', { name: picked }) : t('family.hub.whoFoot')}</Text>

      <Pressable onPress={generate} disabled={sending} accessibilityRole="button" accessibilityLabel={t('family.invite.generate')}
        style={({ pressed }) => [st.primary, { backgroundColor: c.pill, opacity: sending ? 0.6 : pressed ? 0.85 : 1 }]}>
        {sending ? <ActivityIndicator color={c.onPill} /> : (
          <>
            <IconQr size={18} color={c.onPill} />
            <Text style={[st.primaryText, { color: c.onPill }]}>{t('family.invite.generate')}</Text>
          </>
        )}
      </Pressable>
    </View>
  );

  const roleLabel = t((ROLE_OPTIONS.find(r => r.key === role) || ROLE_OPTIONS[2]).label);
  const done = invite && (
    <View style={{ alignItems: 'center' }}>
      <Text style={[st.title, { color: c.text, textAlign: 'center' }]} accessibilityRole="header">{t('family.invite.created')}</Text>
      <Text style={[st.sub, { color: c.secondary, textAlign: 'center' }]}>{t('family.hub.scanSub', { role: roleLabel })}</Text>
      <View style={[st.qrWrap, { backgroundColor: '#FFFFFF' }]}>
        {QRCode ? <QRCode value={invite.link} size={188} color="#000000" backgroundColor="#FFFFFF" /> : <IconQr size={120} color="#000000" />}
      </View>
      <Text style={[st.label, { color: c.header, marginTop: 18, alignSelf: 'center' }]}>{t('family.hub.codeLabel')}</Text>
      <Pressable onPress={copy} accessibilityRole="button" accessibilityLabel={t('family.hub.copyCode')} style={({ pressed }) => [st.codeBox, { backgroundColor: c.cardBg }, pressed && { opacity: 0.7 }]}>
        <Text style={{ color: c.text, fontSize: 14, fontWeight: '600', letterSpacing: 0.4, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) }} numberOfLines={1} selectable>{invite.token}</Text>
      </Pressable>
      <View style={{ flexDirection: 'row', gap: 10, alignSelf: 'stretch', marginTop: 18 }}>
        <Pressable onPress={copy} accessibilityRole="button" style={({ pressed }) => [st.secondary, { backgroundColor: c.chip }, pressed && { opacity: 0.7 }]}>
          <IconCopy size={17} color={c.text} />
          <Text style={[st.primaryText, { color: c.text }]}>{t('family.hub.copyCode')}</Text>
        </Pressable>
        <Pressable onPress={share} accessibilityRole="button" style={({ pressed }) => [st.secondary, { backgroundColor: c.pill }, pressed && { opacity: 0.85 }]}>
          <IconShare size={17} color={c.onPill} />
          <Text style={[st.primaryText, { color: c.onPill }]}>{t('common.share')}</Text>
        </Pressable>
      </View>
      <Text style={[st.foot, { color: c.secondary, textAlign: 'center', marginTop: 14 }]}>{t('family.hub.expires')}</Text>
      <Pressable onPress={onClose} accessibilityRole="button" style={{ paddingVertical: 12, marginTop: 2 }}>
        <Text style={{ color: c.text, fontSize: 16, fontWeight: '600' }}>{t('common.done')}</Text>
      </Pressable>
    </View>
  );

  return (
    <NativeSheetDialog
      visible={visible}
      onClose={onClose}
      overlayStyle={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}
      panelStyle={{ backgroundColor: c.pageBg, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 16, paddingTop: 22, paddingBottom: 28, width: '100%', maxWidth: 560, alignSelf: 'center' }}
      animationType="slide"
    >
      {step === 'done' && invite ? done : form}
    </NativeSheetDialog>
  );
}

const st = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3, paddingHorizontal: 4 },
  sub: { fontSize: 15, lineHeight: 20, marginTop: 5, paddingHorizontal: 4 },
  label: { fontSize: 13, fontWeight: '600', letterSpacing: 0.3, textTransform: 'uppercase', marginTop: 20, marginBottom: 7, marginLeft: 4 },
  group: { borderRadius: 14, overflow: 'hidden' },
  roleRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14 },
  roleIcon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  roleBody: { flex: 1, flexDirection: 'row', alignItems: 'center', marginLeft: 12, paddingVertical: 11, paddingRight: 14 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.6, alignItems: 'center', justifyContent: 'center', marginLeft: 10 },
  inputRow: { flexDirection: 'row', alignItems: 'center', paddingRight: 8 },
  input: { flex: 1, fontSize: 16, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 14 : 11 },
  pickBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  foot: { fontSize: 13, lineHeight: 18, marginTop: 7, marginHorizontal: 4 },
  primary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 999, paddingVertical: 15, marginTop: 22 },
  primaryText: { fontSize: 16, fontWeight: '600' },
  secondary: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 999, paddingVertical: 14 },
  qrWrap: { padding: 14, borderRadius: 20, marginTop: 18 },
  codeBox: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, maxWidth: '100%' },
});
