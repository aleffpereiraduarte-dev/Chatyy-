/**
 * [central-moderacao 2026-10-14] Minhas denúncias — status de cada denúncia enviada (em análise /
 * medidas tomadas / sem violação; nunca diz o que aconteceu com a outra pessoa) + status da própria
 * conta (suspensão, avisos recentes) com recurso. Settings › Privacidade › Minhas denúncias.
 * Backend: email.php?action=mod_my_reports / mod_my_status / appeal_suspension.
 */
import { useEffect, useState, useCallback } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, RefreshControl, ActivityIndicator, Alert, Platform, TextInput, Modal, Pressable } from 'react-native';
import SheetKeyboardAvoider from '../components/chat/SheetKeyboardAvoider'; // [2026-10-22 kb-uniforme] Android: teclado não cobre campos (edge-to-edge)
import { useRouter, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderIconButton } from '../components/nativeHeader';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing } from '../constants/theme';
import { IconArrowLeft, IconFlag, IconRefresh, IconShield, IconAlertTriangle, IconCheckCircle, IconClock } from '../components/Icons';
import * as api from '../services/api';
import FadeSlideIn from '../components/FadeSlideIn';

const STATUS_STYLE = {
  in_review: { Icon: IconClock, key: 'mod.status.in_review' },
  action_taken: { Icon: IconCheckCircle, key: 'mod.status.action_taken' },
  no_violation: { Icon: IconShield, key: 'mod.status.no_violation' },
};

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z'));
  if (isNaN(d.getTime())) return '';
  try { return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return d.toISOString().slice(0, 10); }
}

export default function MyReportsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reports, setReports] = useState([]);
  const [acct, setAcct] = useState(null);
  const [appealOpen, setAppealOpen] = useState(false);
  const [appealText, setAppealText] = useState('');
  const [appealBusy, setAppealBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([api.modMyReports().catch(() => null), api.modMyStatus().catch(() => null)]);
      const rd = r?.data || r || {};
      setReports(Array.isArray(rd.reports) ? rd.reports : []);
      const sd = s?.data || s || null;
      setAcct(sd && sd.status ? sd : null);
    } finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const sendAppeal = useCallback(async () => {
    const txt = appealText.trim();
    if (txt.length < 20 || appealBusy) return;
    setAppealBusy(true);
    try {
      const r = await api.appealSuspension(txt);
      if (r && r.success === false) throw new Error(r.message || 'fail');
      setAppealOpen(false); setAppealText('');
      Alert.alert(t('mod.appeal'), t('mod.appealSent'));
    } catch (e) {
      Alert.alert(t('mod.appeal'), (e && e.message) || t('mod.failed'));
    } finally { setAppealBusy(false); }
  }, [appealText, appealBusy, t]);

  const suspended = acct?.status === 'suspended';
  const susp = acct?.suspension || null;
  const warnings = Array.isArray(acct?.warnings) ? acct.warnings : [];

  const Header = (
    <View style={{ padding: Spacing.md }}>
      <Text style={[st.section, { color: colors.textSecondary }]}>{t('mod.accountStatus')}</Text>
      <View style={[st.card, { borderColor: suspended ? (colors.error || '#ef4444') : colors.borderLight, backgroundColor: colors.surface }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {suspended ? <IconAlertTriangle size={22} color={colors.error || '#ef4444'} /> : <IconShield size={22} color={colors.text} />}
          <Text style={{ color: colors.text, fontSize: FontSize.md || 15, fontWeight: '600', flex: 1 }}>
            {suspended ? t('mod.accountSuspended') : t('mod.accountOk')}
          </Text>
        </View>
        {suspended && susp ? (
          <View style={{ marginTop: 8 }}>
            {susp.reason ? <Text style={{ color: colors.textSecondary, fontSize: 13.5 }}>{String(susp.reason)}</Text> : null}
            <Text style={{ color: colors.textSecondary, fontSize: 13.5, marginTop: 4 }}>
              {susp.permanent ? t('mod.suspendedPermanent') : t('mod.suspendedUntil', { date: fmtDate(susp.expires_at) })}
            </Text>
            <TouchableOpacity onPress={() => setAppealOpen(true)} style={[st.btn, { borderColor: colors.primary }]} accessibilityRole="button">
              <Text style={{ color: colors.primary, fontWeight: '700' }}>{t('mod.appeal')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {warnings.length ? (
          <View style={{ marginTop: 10 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 12.5, marginBottom: 4 }}>{t('mod.warnings')}</Text>
            {warnings.slice(0, 5).map((w, i) => (
              <Text key={i} style={{ color: colors.text, fontSize: 13.5, marginTop: 2 }} numberOfLines={2}>
                {fmtDate(w.created_at)} · {t('mod.type.' + (w.content_type || 'profile'))}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
      <Text style={[st.section, { color: colors.textSecondary, marginTop: Spacing.lg || 20 }]}>{t('mod.reportsHeader')}</Text>
    </View>
  );

  const renderItem = ({ item }) => {
    const S = STATUS_STYLE[item.status] || STATUS_STYLE.in_review;
    const tint = item.status === 'action_taken' ? colors.text : item.status === 'no_violation' ? colors.textSecondary : colors.text;
    return (
      <View style={[st.row, { borderBottomColor: colors.borderLight }]}>
        <View style={[st.badge, { backgroundColor: colors.primaryLight }]}><IconFlag size={18} color={colors.text} /></View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>{t('mod.reason.' + item.reason)}</Text>
          <Text style={{ color: colors.textSecondary, fontSize: 13 }} numberOfLines={1}>{t('mod.type.' + item.content_type)} · {fmtDate(item.created_at)}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <S.Icon size={15} color={tint} />
          <Text style={{ color: tint, fontSize: 12.5, fontWeight: '600' }}>{t(S.key)}</Text>
        </View>
      </View>
    );
  };

  return (
    <View style={[st.container, { backgroundColor: colors.background, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors, isDark, title: t('mod.myReports'),
          headerRight: () => (
            <HeaderIconButton onPress={onRefresh} accessibilityLabel={t('common.refresh')}><IconRefresh size={20} color={colors.text} /></HeaderIconButton>
          ),
        })} />
      ) : (
        <View style={[st.header, { borderBottomColor: colors.borderLight }]}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }} accessibilityLabel={t('common.back')}>
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={[st.title, { color: colors.text }]} numberOfLines={1}>{t('mod.myReports')}</Text>
          <TouchableOpacity onPress={onRefresh} hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }} accessibilityLabel={t('common.refresh')}>
            <IconRefresh size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      )}
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <FadeSlideIn>
          <FlatList
            data={reports}
            keyExtractor={(i) => String(i.id)}
            renderItem={renderItem}
            ListHeaderComponent={Header}
            ListEmptyComponent={
              <View style={st.empty}>
                <IconFlag size={34} color={colors.textTertiary} />
                <Text style={{ color: colors.textTertiary, marginTop: 10, fontSize: 14, textAlign: 'center' }}>{t('mod.empty')}</Text>
              </View>
            }
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
            contentContainerStyle={{ paddingBottom: 32 + insets.bottom }}
          />
        </FadeSlideIn>
      )}
      <Modal visible={appealOpen} transparent animationType="fade" onRequestClose={() => setAppealOpen(false)}>
        <SheetKeyboardAvoider style={{ flex: 1 }}>{/* [2026-10-22 kb-uniforme] */}
        <Pressable style={st.backdrop} onPress={() => setAppealOpen(false)}>
          <Pressable style={[st.dialog, { backgroundColor: colors.surface }]} onPress={() => {}}>
            <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700', marginBottom: 6 }}>{t('mod.appeal')}</Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13.5, marginBottom: 8 }}>{t('mod.appealPrompt')}</Text>
            <TextInput value={appealText} onChangeText={setAppealText} multiline maxLength={2000} autoFocus
              style={[st.input, { color: colors.text, borderColor: colors.border }]} placeholderTextColor={colors.textTertiary} />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 16, marginTop: 12 }}>
              <TouchableOpacity onPress={() => setAppealOpen(false)}><Text style={{ color: colors.textSecondary, fontSize: 15 }}>{t('mod.cancel')}</Text></TouchableOpacity>
              <TouchableOpacity onPress={sendAppeal} disabled={appealText.trim().length < 20 || appealBusy}>
                {appealBusy ? <ActivityIndicator color={colors.primary} /> : (
                  <Text style={{ color: colors.primary, fontSize: 15, fontWeight: '700', opacity: appealText.trim().length < 20 ? 0.4 : 1 }}>{t('mod.appeal')}</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
        </SheetKeyboardAvoider>
      </Modal>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: Spacing.md || 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, fontSize: 18, fontWeight: '700' },
  section: { fontSize: 12.5, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14 },
  btn: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 16, marginTop: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: Spacing.md || 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  badge: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 20 },
  dialog: { borderRadius: 16, padding: 18, maxWidth: 520, width: '100%', alignSelf: 'center' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, minHeight: 110, fontSize: 14, textAlignVertical: 'top', ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null) },
});
