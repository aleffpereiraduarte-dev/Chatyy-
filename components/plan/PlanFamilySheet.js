// [2026-10-20 plano-premium] Família no plano Pro (backend REAL plans.php:
// plan_family_list / plan_family_add / plan_family_remove). Cada pessoa
// adicionada recebe o Pro na própria conta (espaço e conversas separados);
// o titular paga. Só o titular gerencia. Folha nativa (pageSheet no iOS).
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Modal, Pressable, TextInput, ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, KeyboardAvoidingView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as api from '../../services/api';
import { useLanguage } from '../../context/LanguageContext';
import { useGroupedColors } from '../settings/SettingsKit';
import AvatarCircle from '../AvatarCircle';
import { IconX, IconUsers, IconUserPlus } from '../Icons';

// RN-web: Alert.alert não faz nada → confirm/alert do navegador.
function showAlert(title, message, buttons) {
  if (Platform.OS === 'web') {
    try {
      const ok = (buttons || []).find((b) => b && b.style !== 'cancel');
      const cancel = (buttons || []).find((b) => b && b.style === 'cancel');
      if (ok && ok.onPress) { if (window.confirm(`${title}\n\n${message || ''}`)) ok.onPress(); else if (cancel && cancel.onPress) cancel.onPress(); }
      else window.alert(`${title}\n\n${message || ''}`);
    } catch {}
    return;
  }
  Alert.alert(title, message, buttons);
}

function errText(t, msg) {
  const m = String(msg || '').toLowerCase();
  if (m.includes('another family')) return t('planHub.famErrOtherFamily');
  if (m.includes('active plan')) return t('planHub.famErrHasPlan');
  if (m.includes('limit')) return t('planHub.famErrLimit');
  if (m.includes('invalid member') || m.includes('invalid email')) return t('planHub.famErrEmail');
  if (m.includes('yourself')) return t('planHub.famErrSelf');
  return t('planHub.famErrGeneric');
}

export default function PlanFamilySheet({ visible, onClose, planName, maxMembers = 6, onChanged }) {
  const { t } = useLanguage();
  const g = useGroupedColors();
  const insets = useSafeAreaInsets();
  const [members, setMembers] = useState(null); // null = carregando
  const [unsupported, setUnsupported] = useState(false);
  const [failed, setFailed] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setFailed(false); setUnsupported(false);
    try {
      const r = await api.apiCall('plan_family_list');
      if (r?.success && r.data) { setMembers(Array.isArray(r.data.members) ? r.data.members : []); return; }
      if (r?.__httpStatus === 403 || /family plan required/i.test(String(r?.message || ''))) { setUnsupported(true); setMembers([]); return; }
      setFailed(true); setMembers([]);
    } catch { setFailed(true); setMembers([]); }
  }, []);
  useEffect(() => { if (visible) { setMembers(null); setErr(''); setEmail(''); load(); } }, [visible, load]);

  const slotsLeft = Math.max(0, (maxMembers - 1) - (members ? members.length : 0));
  const add = async () => {
    const e = email.trim().toLowerCase();
    if (!e || busy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { setErr(t('planHub.famErrEmail')); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.apiCall('plan_family_add', { member_email: e }, 'POST');
      if (r?.success) {
        setMembers(Array.isArray(r.data?.members) ? r.data.members : (members || []).concat([{ member_email: e }]));
        setEmail('');
        onChanged && onChanged();
      } else setErr(errText(t, r?.message));
    } catch { setErr(t('planHub.famErrGeneric')); }
    finally { setBusy(false); }
  };
  const remove = (memberEmail) => {
    showAlert(
      t('planHub.famRemoveTitle'),
      t('planHub.famRemoveBody', { email: memberEmail, plan: planName }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('planHub.famRemove'), style: 'destructive', onPress: async () => {
            try {
              const r = await api.apiCall('plan_family_remove', { member_email: memberEmail }, 'POST');
              if (r?.success) {
                setMembers(Array.isArray(r.data?.members) ? r.data.members : (members || []).filter((m) => m.member_email !== memberEmail));
                onChanged && onChanged();
              } else showAlert(t('common.error'), t('planHub.famErrGeneric'));
            } catch { showAlert(t('common.error'), t('planHub.famErrGeneric')); }
          },
        },
      ],
    );
  };

  const inputBg = g.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(118,118,128,0.10)';
  return (
    <Modal visible={visible} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} onRequestClose={onClose} transparent={false}>
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: g.pageBg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[s.head, { paddingTop: Platform.OS === 'ios' ? 14 : insets.top + 10 }]}>
          <Text style={[s.headTitle, { color: g.text }]} accessibilityRole="header">{t('planHub.famTitle')}</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('common.close')} style={[s.close, { backgroundColor: g.fill }]} testID="plan-family-close">
            <IconX size={16} color={g.text} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 + insets.bottom }} keyboardShouldPersistTaps="handled">
          <View style={{ alignItems: 'center', marginBottom: 20 }}>
            <View style={[s.bigIcon, { backgroundColor: g.ink }]}><IconUsers size={28} color={g.onInk} /></View>
            <Text style={[s.lead, { color: g.text }]}>{t('planHub.famLead', { plan: planName, n: maxMembers })}</Text>
            <Text style={[s.sub, { color: g.secondary }]}>{t('planHub.famSub')}</Text>
          </View>

          {members === null ? (
            <ActivityIndicator color={g.secondary} style={{ marginVertical: 24 }} />
          ) : unsupported ? (
            <View style={[s.card, { backgroundColor: g.cardBg, padding: 16 }]}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: g.text }}>{t('planHub.famSoonTitle')}</Text>
              <Text style={{ fontSize: 13, lineHeight: 18, color: g.secondary, marginTop: 4 }}>{t('planHub.famSoonBody')}</Text>
            </View>
          ) : (
            <>
              <Text style={[s.section, { color: g.header }]}>{t('planHub.famMembersHeader', { n: members.length + 1, max: maxMembers }).toUpperCase()}</Text>
              <View style={[s.card, { backgroundColor: g.cardBg }]}>
                <View style={s.row}>
                  <View style={[s.youDot, { backgroundColor: g.ink }]}><Text style={{ color: g.onInk, fontWeight: '700', fontSize: 13 }}>{t('planHub.famYouShort')}</Text></View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 16, color: g.text }} numberOfLines={1}>{t('planHub.famYou')}</Text>
                    <Text style={{ fontSize: 13, color: g.secondary }}>{t('planHub.famOwner')}</Text>
                  </View>
                </View>
                {members.map((m) => (
                  <View key={m.member_email} style={[s.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: g.separator }]}>
                    <AvatarCircle email={m.member_email} name={m.member_email} size={36} />
                    <View style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
                      <Text style={{ fontSize: 16, color: g.text }} numberOfLines={1}>{m.member_email}</Text>
                      <Text style={{ fontSize: 13, color: g.secondary }}>{t('planHub.famMember')}</Text>
                    </View>
                    <Pressable onPress={() => remove(m.member_email)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('planHub.famRemove') + ' ' + m.member_email} style={[s.pill, { borderColor: g.separator }]}>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: g.destructive }}>{t('planHub.famRemove')}</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
              {failed ? <Text style={{ fontSize: 13, color: g.secondary, marginTop: 8, marginHorizontal: 4 }}>{t('planHub.famErrGeneric')}</Text> : null}

              {slotsLeft > 0 ? (
                <>
                  <Text style={[s.section, { color: g.header, marginTop: 24 }]}>{t('planHub.famAddHeader').toUpperCase()}</Text>
                  <View style={[s.card, { backgroundColor: g.cardBg, padding: 12 }]}>
                    <TextInput
                      value={email}
                      onChangeText={(v) => { setEmail(v); if (err) setErr(''); }}
                      placeholder={t('planHub.famEmailPh')}
                      placeholderTextColor={g.secondary}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="email-address"
                      textContentType="emailAddress"
                      returnKeyType="done"
                      onSubmitEditing={add}
                      style={[s.input, { color: g.text, backgroundColor: inputBg }]}
                      testID="plan-family-email"
                    />
                    <Pressable onPress={add} disabled={busy || !email.trim()} accessibilityRole="button" style={[s.addBtn, { backgroundColor: g.ink, opacity: busy || !email.trim() ? 0.45 : 1 }]} testID="plan-family-add">
                      {busy ? <ActivityIndicator color={g.onInk} /> : (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <IconUserPlus size={17} color={g.onInk} />
                          <Text style={{ color: g.onInk, fontSize: 15, fontWeight: '700' }}>{t('planHub.famAdd')}</Text>
                        </View>
                      )}
                    </Pressable>
                  </View>
                  {err ? <Text style={{ fontSize: 13, color: g.destructive, marginTop: 8, marginHorizontal: 4 }}>{err}</Text> : null}
                  <Text style={{ fontSize: 13, lineHeight: 18, color: g.header, marginTop: 8, marginHorizontal: 4 }}>{t('planHub.famSlots', { n: slotsLeft })}</Text>
                </>
              ) : (
                <Text style={{ fontSize: 13, lineHeight: 18, color: g.header, marginTop: 12, marginHorizontal: 4 }}>{t('planHub.famFull')}</Text>
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingBottom: 10 },
  headTitle: { fontSize: 17, fontWeight: '600' },
  close: { position: 'absolute', right: 16, bottom: 8, width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  bigIcon: { width: 60, height: 60, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  lead: { fontSize: 20, fontWeight: '700', textAlign: 'center', letterSpacing: -0.3 },
  sub: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 6, maxWidth: 420 },
  section: { fontSize: 13, letterSpacing: 0.3, marginBottom: 7, marginHorizontal: 4 },
  card: { borderRadius: 14, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, minHeight: 56 },
  youDot: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  input: { minHeight: 46, borderRadius: 10, paddingHorizontal: 12, fontSize: 16, ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }) },
  addBtn: { marginTop: 10, minHeight: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
});
