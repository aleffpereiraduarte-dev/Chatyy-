import { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator, Platform, ScrollView, TextInput, Switch, Alert, Animated } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconMessageSquare, IconPhone, IconAlertCircle, IconChevronRight, IconShield, IconEye, IconLock, IconClock, IconBarChart, IconX, IconPlus, IconUser, IconMail, IconTrash, IconAlertTriangle, IconFilter } from '../components/Icons';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';

const ACCENT = '#25D366';
const TIME_LIMITS = [
  { value: 30, label: '30 min' },
  { value: 60, label: '1h' },
  { value: 120, label: '2h' },
  { value: 180, label: '3h' },
  { value: 240, label: '4h' },
  { value: 0, label: null }, // unlimited - label set from i18n
];

export default function ParentalMonitorScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const childEmail = params.child_email;
  const childName = params.child_name || childEmail?.split('@')[0] || 'Filho';

  const [tab, setTab] = useState('chats');
  const [chats, setChats] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [calls, setCalls] = useState([]);
  const [restrictions, setRestrictions] = useState({});
  const [screenTime, setScreenTime] = useState(null);
  const [whitelist, setWhitelist] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [newContact, setNewContact] = useState('');
  const [sosLoading, setSosLoading] = useState(false);
  const slideAnim = useRef(new Animated.Value(0)).current;

  // ─── Data Loaders ───

  const loadChats = useCallback(async () => {
    try { const c = await getCached('parental_chats_' + childEmail); if (c?.length) setChats(c); } catch {}
    try {
      const r = await api.parentalChildChats(childEmail);
      if (r.success) { setChats(r.data?.chats || []); setCache('parental_chats_' + childEmail, r.data?.chats || [], 2592000000).catch(() => {}); }
    } catch {}
  }, [childEmail]);

  const loadAlerts = useCallback(async () => {
    try { const c = await getCached('parental_alerts_' + childEmail); if (c?.length) setAlerts(c); } catch {}
    try {
      const r = await api.parentalAlerts(childEmail);
      if (r.success) { setAlerts(r.data?.alerts || []); setCache('parental_alerts_' + childEmail, r.data?.alerts || [], 2592000000).catch(() => {}); }
    } catch {}
  }, [childEmail]);

  const loadCalls = useCallback(async () => {
    try {
      const r = await api.parentalCallHistory(childEmail);
      if (r.success) setCalls(r.data?.calls || []);
    } catch {}
  }, [childEmail]);

  const loadRestrictions = useCallback(async () => {
    try {
      const r = await api.parentalGetRestrictions(childEmail);
      if (r.success) setRestrictions(r.data?.restrictions || {});
    } catch {}
  }, [childEmail]);

  const loadScreenTime = useCallback(async () => {
    try {
      const r = await api.parentalScreenTime(childEmail);
      if (r.success) setScreenTime(r.data || null);
    } catch {}
  }, [childEmail]);

  const loadWhitelist = useCallback(async () => {
    try {
      const r = await api.parentalContactWhitelist(childEmail);
      if (r.success) setWhitelist(r.data?.contacts || []);
    } catch {}
  }, [childEmail]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadChats(), loadAlerts(), loadCalls(), loadRestrictions(), loadScreenTime(), loadWhitelist()])
      .finally(() => setLoading(false));
  }, [loadChats, loadAlerts, loadCalls, loadRestrictions, loadScreenTime, loadWhitelist]);

  useEffect(() => {
    slideAnim.setValue(0);
    Animated.spring(slideAnim, { toValue: 1, useNativeDriver: Platform.OS !== 'web', tension: 80, friction: 12 }).start();
  }, [tab]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => { if (updateDebounceRef.current) clearTimeout(updateDebounceRef.current); };
  }, []);

  // ─── Restriction Helpers ───

  const updateDebounceRef = useRef(null);
  const pendingRestrictionsRef = useRef(null);
  const updateRestriction = (key, value) => {
    const updated = { ...restrictions, [key]: value };
    setRestrictions(updated);
    pendingRestrictionsRef.current = updated;
    // Debounce API call to avoid rapid-fire requests from toggles
    if (updateDebounceRef.current) clearTimeout(updateDebounceRef.current);
    setSaving(true);
    updateDebounceRef.current = setTimeout(async () => {
      updateDebounceRef.current = null;
      const payload = pendingRestrictionsRef.current;
      try {
        await api.parentalUpdateRestrictions(childEmail, payload);
        setSavedMsg(t('parental.saved'));
        setTimeout(() => setSavedMsg(''), 2000);
      } catch {
        // Rollback: reload from server on error
        loadRestrictions?.();
      } finally { setSaving(false); }
    }, 500);
  };

  const handleAddContact = async () => {
    const email = newContact.trim().toLowerCase();
    if (!email || !email.includes('@')) return Alert.alert('', t('parental.contactEmail'));
    try {
      await api.parentalAddContact(childEmail, email);
      setNewContact('');
      loadWhitelist();
    } catch {}
  };

  const handleRemoveContact = async (contactEmail) => {
    Alert.alert(t('parental.removeContact'), contactEmail, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'OK', onPress: async () => {
        try {
          await api.parentalRemoveContact(childEmail, contactEmail);
          loadWhitelist();
        } catch {}
      }},
    ]);
  };

  // ─── Tab Config ───

  const tabs = [
    { key: 'chats', label: t('parental.calls') ? undefined : 'Conversas', i18n: null, icon: IconMessageSquare },
    { key: 'calls', label: t('parental.calls'), icon: IconPhone },
    { key: 'restrictions', label: t('parental.restrictions'), icon: IconLock },
    { key: 'screenTime', label: t('parental.screenTime'), icon: IconBarChart },
    { key: 'alerts', label: 'Alertas', icon: IconAlertCircle, badge: alerts.filter(a => !a.read_at).length },
  ];
  // Fix chats label
  tabs[0].label = 'Conversas';

  // ─── Render: Chats Tab ───

  const renderChat = ({ item }) => (
    <TouchableOpacity
      style={[s.card, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}
      onPress={() => router.push(`/parental-child-chat?child_email=${encodeURIComponent(childEmail)}&conversation_id=${item.id}&chat_name=${encodeURIComponent(item.name || 'Chat')}`)}
      activeOpacity={0.7}
    >
      <View style={[s.cardIcon, { backgroundColor: ACCENT + '15' }]}>
        <IconMessageSquare size={18} color={ACCENT} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[s.cardTitle, { color: colors.text }]}>{item.name || 'Chat'}</Text>
        <Text style={[s.cardSub, { color: colors.textSecondary }]} numberOfLines={1}>{item.last_message || 'Sem mensagens'}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[s.cardMeta, { color: colors.textSecondary }]}>{item.total_messages} msgs</Text>
        <IconChevronRight size={16} color={colors.textSecondary} />
      </View>
    </TouchableOpacity>
  );

  const renderChatsTab = () => (
    <FlatList
      data={chats}
      keyExtractor={item => String(item.id)}
      renderItem={renderChat}
      contentContainerStyle={s.listContent}
      ListEmptyComponent={<EmptyState icon={IconMessageSquare} text="Nenhuma conversa encontrada" />}
    />
  );

  // ─── Render: Calls Tab ───

  const callTypeConfig = {
    incoming: { color: '#22c55e', label: t('parental.callIncoming'), icon: '📞' },
    outgoing: { color: '#3b82f6', label: t('parental.callOutgoing'), icon: '📱' },
    missed: { color: '#ef4444', label: t('parental.callMissed'), icon: '📵' },
  };

  const formatDuration = (seconds) => {
    if (!seconds || seconds <= 0) return '--';
    const m = Math.floor(seconds / 60);
    const s2 = seconds % 60;
    return m > 0 ? `${m}m ${s2}s` : `${s2}s`;
  };

  const renderCall = ({ item }) => {
    const ct = callTypeConfig[item.type] || callTypeConfig.outgoing;
    const time = new Date(item.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return (
      <View style={[s.card, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
        <View style={[s.cardIcon, { backgroundColor: ct.color + '15' }]}>
          <Text style={{ fontSize: 18 }}>{ct.icon}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.cardTitle, { color: colors.text }]}>{item.contact_name || item.contact_email || 'Desconhecido'}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            <View style={[s.pill, { backgroundColor: ct.color + '18' }]}>
              <Text style={[s.pillText, { color: ct.color }]}>{ct.label}</Text>
            </View>
            {item.is_video && (
              <View style={[s.pill, { backgroundColor: '#8b5cf618' }]}>
                <Text style={[s.pillText, { color: '#8b5cf6' }]}>Video</Text>
              </View>
            )}
          </View>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[s.cardMeta, { color: colors.textSecondary }]}>{time}</Text>
          <Text style={[s.cardMetaSm, { color: colors.textSecondary }]}>{t('parental.duration')}: {formatDuration(item.duration)}</Text>
        </View>
      </View>
    );
  };

  const renderCallsTab = () => (
    <FlatList
      data={calls}
      keyExtractor={(item, i) => String(item.id || i)}
      renderItem={renderCall}
      contentContainerStyle={s.listContent}
      ListEmptyComponent={<EmptyState icon={IconPhone} text={t('parental.noCallsYet')} />}
    />
  );

  // ─── Render: Restrictions Tab ───

  const timeLimitIndex = TIME_LIMITS.findIndex(tl => tl.value === (restrictions.daily_limit_minutes || 0));
  const currentLimitIdx = timeLimitIndex >= 0 ? timeLimitIndex : TIME_LIMITS.length - 1;

  const renderRestrictionsTab = () => (
    <ScrollView contentContainerStyle={s.listContent} showsVerticalScrollIndicator={false}>
      {/* Save indicator */}
      {(saving || savedMsg) && (
        <View style={[s.saveIndicator, { backgroundColor: saving ? '#f59e0b20' : '#22c55e20' }]}>
          {saving ? <ActivityIndicator size="small" color="#f59e0b" /> : null}
          <Text style={{ color: saving ? '#f59e0b' : '#22c55e', fontWeight: '600', fontSize: 13 }}>
            {saving ? t('parental.saving') : savedMsg}
          </Text>
        </View>
      )}

      {/* Toggle restrictions */}
      <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>{t('parental.restrictions').toUpperCase()}</Text>

      <View style={[s.settingsGroup, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
        <SettingRow
          icon={<IconMail size={18} color="#3b82f6" />}
          label={t('parental.canSendEmail')}
          colors={colors}
          isDark={isDark}
          right={
            <Switch
              value={restrictions.can_send_email !== false}
              onValueChange={(v) => updateRestriction('can_send_email', v)}
              trackColor={{ false: '#767577', true: ACCENT + '60' }}
              thumbColor={restrictions.can_send_email !== false ? ACCENT : '#f4f3f4'}
            />
          }
        />
        <View style={[s.divider, { backgroundColor: isDark ? '#334155' : '#f1f5f9' }]} />
        <SettingRow
          icon={<IconTrash size={18} color="#ef4444" />}
          label={t('parental.canDeleteMessages')}
          colors={colors}
          isDark={isDark}
          right={
            <Switch
              value={restrictions.can_delete_messages !== false}
              onValueChange={(v) => updateRestriction('can_delete_messages', v)}
              trackColor={{ false: '#767577', true: ACCENT + '60' }}
              thumbColor={restrictions.can_delete_messages !== false ? ACCENT : '#f4f3f4'}
            />
          }
        />
        <View style={[s.divider, { backgroundColor: isDark ? '#334155' : '#f1f5f9' }]} />
        <SettingRow
          icon={<IconLock size={18} color="#f59e0b" />}
          label={t('parental.canChangePassword')}
          colors={colors}
          isDark={isDark}
          right={
            <Switch
              value={restrictions.can_change_password !== false}
              onValueChange={(v) => updateRestriction('can_change_password', v)}
              trackColor={{ false: '#767577', true: ACCENT + '60' }}
              thumbColor={restrictions.can_change_password !== false ? ACCENT : '#f4f3f4'}
            />
          }
        />
      </View>

      {/* Daily time limit */}
      <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 24 }]}>{t('parental.dailyLimit').toUpperCase()}</Text>

      <View style={[s.settingsGroup, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0', padding: 16 }]}>
        <View style={s.timeLimitRow}>
          {TIME_LIMITS.map((tl, idx) => {
            const isActive = idx === currentLimitIdx;
            const label = tl.value === 0 ? t('parental.unlimited') : tl.label;
            return (
              <TouchableOpacity
                key={idx}
                style={[s.timeLimitChip, {
                  backgroundColor: isActive ? ACCENT : (isDark ? '#0f172a' : '#f1f5f9'),
                  borderColor: isActive ? ACCENT : (isDark ? '#475569' : '#e2e8f0'),
                }]}
                onPress={() => updateRestriction('daily_limit_minutes', tl.value)}
              >
                <Text style={[s.timeLimitText, { color: isActive ? '#fff' : colors.text }]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Bedtime */}
      <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 24 }]}>{t('parental.bedtime').toUpperCase()}</Text>

      <View style={[s.settingsGroup, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0', padding: 16 }]}>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={[s.bedtimeLabel, { color: colors.textSecondary }]}>{t('parental.bedtimeStart')}</Text>
            <TextInput
              style={[s.bedtimeInput, { backgroundColor: isDark ? '#0f172a' : '#f8fafc', color: colors.text, borderColor: isDark ? '#475569' : '#e2e8f0' }]}
              value={restrictions.bedtime_start || '22:00'}
              onChangeText={(v) => setRestrictions(prev => ({ ...prev, bedtime_start: v }))}
              onBlur={() => updateRestriction('bedtime_start', restrictions.bedtime_start || '22:00')}
              placeholder="22:00"
              placeholderTextColor={colors.textSecondary}
              keyboardType="numbers-and-punctuation"
              maxLength={5}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.bedtimeLabel, { color: colors.textSecondary }]}>{t('parental.bedtimeEnd')}</Text>
            <TextInput
              style={[s.bedtimeInput, { backgroundColor: isDark ? '#0f172a' : '#f8fafc', color: colors.text, borderColor: isDark ? '#475569' : '#e2e8f0' }]}
              value={restrictions.bedtime_end || '07:00'}
              onChangeText={(v) => setRestrictions(prev => ({ ...prev, bedtime_end: v }))}
              onBlur={() => updateRestriction('bedtime_end', restrictions.bedtime_end || '07:00')}
              placeholder="07:00"
              placeholderTextColor={colors.textSecondary}
              keyboardType="numbers-and-punctuation"
              maxLength={5}
            />
          </View>
        </View>
        <Text style={[s.bedtimeHint, { color: colors.textSecondary }]}>
          {t('parental.bedtime')}: {restrictions.bedtime_start || '22:00'} - {restrictions.bedtime_end || '07:00'}
        </Text>
      </View>

      {/* Contact Whitelist */}
      <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 24 }]}>{t('parental.whitelist').toUpperCase()}</Text>

      <View style={[s.settingsGroup, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0', padding: 16 }]}>
        {/* Add contact input */}
        <View style={s.addContactRow}>
          <TextInput
            style={[s.addContactInput, { backgroundColor: isDark ? '#0f172a' : '#f8fafc', color: colors.text, borderColor: isDark ? '#475569' : '#e2e8f0' }]}
            value={newContact}
            onChangeText={setNewContact}
            placeholder={t('parental.contactEmail')}
            placeholderTextColor={colors.textSecondary}
            keyboardType="email-address"
            autoCapitalize="none"
            onSubmitEditing={handleAddContact}
          />
          <TouchableOpacity style={[s.addContactBtn, { backgroundColor: ACCENT }]} onPress={handleAddContact}>
            <IconPlus size={18} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Whitelist entries */}
        {whitelist.length === 0 ? (
          <Text style={[s.emptyInline, { color: colors.textSecondary }]}>{t('parental.noContacts')}</Text>
        ) : (
          whitelist.map((contact, idx) => (
            <View key={contact.email || idx} style={[s.whitelistItem, idx < whitelist.length - 1 && { borderBottomWidth: 1, borderBottomColor: isDark ? '#334155' : '#f1f5f9' }]}>
              <View style={[s.whitelistAvatar, { backgroundColor: ACCENT + '15' }]}>
                <IconUser size={16} color={ACCENT} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[s.whitelistName, { color: colors.text }]}>{contact.name || contact.email}</Text>
                {contact.name && <Text style={[s.whitelistEmail, { color: colors.textSecondary }]}>{contact.email}</Text>}
              </View>
              <TouchableOpacity onPress={() => handleRemoveContact(contact.email)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <IconX size={16} color="#ef4444" />
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>

      {/* Content Filters */}
      <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 24 }]}>{t('parental.contentFilters') || 'CONTENT FILTERS'}</Text>

      <View style={[s.settingsGroup, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
        <SettingRow
          icon={<IconShield size={18} color="#ef4444" />}
          label={t('parental.filterAdult') || 'Block adult content'}
          colors={colors}
          isDark={isDark}
          right={
            <Switch
              value={restrictions.filter_adult !== false}
              onValueChange={(v) => updateRestriction('filter_adult', v)}
              trackColor={{ false: '#767577', true: ACCENT + '60' }}
              thumbColor={restrictions.filter_adult !== false ? ACCENT : '#f4f3f4'}
            />
          }
        />
        <View style={[s.divider, { backgroundColor: isDark ? '#334155' : '#f1f5f9' }]} />
        <SettingRow
          icon={<IconAlertTriangle size={18} color="#f59e0b" />}
          label={t('parental.filterViolence') || 'Block violence'}
          colors={colors}
          isDark={isDark}
          right={
            <Switch
              value={restrictions.filter_violence === true}
              onValueChange={(v) => updateRestriction('filter_violence', v)}
              trackColor={{ false: '#767577', true: ACCENT + '60' }}
              thumbColor={restrictions.filter_violence === true ? ACCENT : '#f4f3f4'}
            />
          }
        />
        <View style={[s.divider, { backgroundColor: isDark ? '#334155' : '#f1f5f9' }]} />
        <SettingRow
          icon={<IconFilter size={18} color="#8b5cf6" />}
          label={t('parental.filterProfanity') || 'Filter profanity'}
          colors={colors}
          isDark={isDark}
          right={
            <Switch
              value={restrictions.filter_profanity === true}
              onValueChange={(v) => updateRestriction('filter_profanity', v)}
              trackColor={{ false: '#767577', true: ACCENT + '60' }}
              thumbColor={restrictions.filter_profanity === true ? ACCENT : '#f4f3f4'}
            />
          }
        />
        <View style={[s.divider, { backgroundColor: isDark ? '#334155' : '#f1f5f9' }]} />
        <SettingRow
          icon={<IconEye size={18} color="#3b82f6" />}
          label={t('parental.safeSearch') || 'Safe search'}
          colors={colors}
          isDark={isDark}
          right={
            <Switch
              value={restrictions.safe_search === true}
              onValueChange={(v) => updateRestriction('safe_search', v)}
              trackColor={{ false: '#767577', true: ACCENT + '60' }}
              thumbColor={restrictions.safe_search === true ? ACCENT : '#f4f3f4'}
            />
          }
        />
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );

  // ─── Render: Screen Time Tab ───

  const todayMinutes = screenTime?.today_minutes || 0;
  const dailyLimit = restrictions.daily_limit_minutes || 0;
  const todayProgress = dailyLimit > 0 ? Math.min(todayMinutes / dailyLimit, 1) : (todayMinutes > 0 ? 0.5 : 0);
  const weeklyData = screenTime?.weekly || [];
  const maxWeekly = Math.max(...weeklyData.map(d => d.minutes || 0), 1);
  const activeHours = screenTime?.active_hours || [];
  const topContacts = screenTime?.top_contacts || [];
  const dayLabels = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

  const renderScreenTimeTab = () => (
    <ScrollView contentContainerStyle={s.listContent} showsVerticalScrollIndicator={false}>
      {/* Today's usage */}
      <View style={[s.screenTimeCard, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
        <View style={s.screenTimeHeader}>
          <IconClock size={18} color={ACCENT} />
          <Text style={[s.screenTimeLabel, { color: colors.text }]}>{t('parental.dailyLimit')}</Text>
        </View>
        <View style={s.progressOuter}>
          <View style={[s.progressBarBg, { backgroundColor: isDark ? '#0f172a' : '#f1f5f9' }]}>
            <View style={[s.progressBarFill, {
              width: `${todayProgress * 100}%`,
              backgroundColor: todayProgress > 0.8 ? '#ef4444' : todayProgress > 0.5 ? '#f59e0b' : ACCENT,
            }]} />
          </View>
          <Text style={[s.progressText, { color: colors.text }]}>
            <Text style={{ fontWeight: '800', fontSize: 28 }}>{todayMinutes}</Text>
            <Text style={{ color: colors.textSecondary }}> {t('parental.minutesToday')}</Text>
            {dailyLimit > 0 && <Text style={{ color: colors.textSecondary }}> / {dailyLimit} min</Text>}
          </Text>
        </View>
      </View>

      {/* Weekly bar chart */}
      <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 20 }]}>{t('parental.weeklyUsage').toUpperCase()}</Text>

      <View style={[s.screenTimeCard, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
        <View style={s.barChartContainer}>
          {(weeklyData.length > 0 ? weeklyData : dayLabels.map((_, i) => ({ day: i, minutes: 0 }))).map((item, idx) => {
            const barHeight = maxWeekly > 0 ? Math.max((item.minutes / maxWeekly) * 120, 4) : 4;
            const isToday = idx === new Date().getDay();
            return (
              <View key={idx} style={s.barCol}>
                <Text style={[s.barValue, { color: colors.textSecondary }]}>{item.minutes > 0 ? item.minutes : ''}</Text>
                <View style={[s.bar, {
                  height: barHeight,
                  backgroundColor: isToday ? ACCENT : (isDark ? '#475569' : '#cbd5e1'),
                  borderRadius: 4,
                }]} />
                <Text style={[s.barLabel, { color: isToday ? ACCENT : colors.textSecondary, fontWeight: isToday ? '700' : '500' }]}>
                  {dayLabels[item.day !== undefined ? item.day : idx]}
                </Text>
              </View>
            );
          })}
        </View>
      </View>

      {/* Most active hours */}
      {activeHours.length > 0 && (
        <>
          <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 20 }]}>{t('parental.mostActive').toUpperCase()}</Text>
          <View style={[s.screenTimeCard, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
            <View style={s.hoursGrid}>
              {activeHours.slice(0, 6).map((h, i) => (
                <View key={i} style={[s.hourChip, { backgroundColor: ACCENT + (Math.round((h.percentage || 0.5) * 40 + 10).toString(16)) }]}>
                  <Text style={[s.hourText, { color: colors.text }]}>{String(h.hour).padStart(2, '0')}:00</Text>
                  <Text style={[s.hourPct, { color: colors.textSecondary }]}>{Math.round((h.percentage || 0) * 100)}%</Text>
                </View>
              ))}
            </View>
          </View>
        </>
      )}

      {/* Most contacted */}
      {topContacts.length > 0 && (
        <>
          <Text style={[s.sectionLabel, { color: colors.textSecondary, marginTop: 20 }]}>{t('parental.mostContacted').toUpperCase()}</Text>
          <View style={[s.settingsGroup, { backgroundColor: isDark ? '#1e293b' : '#fff', borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
            {topContacts.slice(0, 5).map((c, idx) => (
              <View key={c.email || idx} style={[s.contactRow, idx < topContacts.length - 1 && idx < 4 && { borderBottomWidth: 1, borderBottomColor: isDark ? '#334155' : '#f1f5f9' }]}>
                <View style={[s.contactAvatar, { backgroundColor: '#3b82f615' }]}>
                  <IconUser size={16} color="#3b82f6" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[s.contactName, { color: colors.text }]}>{c.name || c.email}</Text>
                  <Text style={[s.contactMeta, { color: colors.textSecondary }]}>{c.message_count} msgs</Text>
                </View>
              </View>
            ))}
          </View>
        </>
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );

  // ─── Render: Alerts Tab ───

  const handleMarkRead = async (alertId) => {
    try {
      await api.parentalMarkAlertRead(alertId);
      setAlerts(prev => prev.map(a => a.id === alertId ? { ...a, read_at: new Date().toISOString() } : a));
    } catch {}
  };

  const renderAlert = ({ item }) => {
    const sevColors = { info: '#3b82f6', warning: '#f59e0b', critical: '#ef4444' };
    const sevColor = sevColors[item.severity] || '#3b82f6';
    const isUnread = !item.read_at;
    return (
      <TouchableOpacity
        style={[s.card, {
          backgroundColor: isDark ? (isUnread ? '#1a2332' : '#1e293b') : (isUnread ? '#fefce8' : '#fff'),
          borderColor: isDark ? '#334155' : '#e2e8f0',
          borderLeftWidth: 4,
          borderLeftColor: sevColor,
        }]}
        onPress={() => isUnread && handleMarkRead(item.id)}
        activeOpacity={0.8}
      >
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[s.cardTitle, { color: colors.text }]}>{item.title}</Text>
            {isUnread && <View style={s.unreadDot} />}
          </View>
          <Text style={[s.cardSub, { color: colors.textSecondary, marginTop: 4 }]}>{item.body}</Text>
          <Text style={[s.cardMetaSm, { color: colors.textSecondary, marginTop: 6 }]}>{new Date(item.created_at).toLocaleString()}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderAlertsTab = () => (
    <FlatList
      data={alerts}
      keyExtractor={item => String(item.id)}
      renderItem={renderAlert}
      contentContainerStyle={s.listContent}
      ListEmptyComponent={<EmptyState icon={IconAlertCircle} text="Nenhum alerta" />}
    />
  );

  // ─── Tab Content Map ───

  const tabContent = {
    chats: renderChatsTab,
    calls: renderCallsTab,
    restrictions: renderRestrictionsTab,
    screenTime: renderScreenTimeTab,
    alerts: renderAlertsTab,
  };

  // ─── Main Render ───

  return (
    <View style={[s.container, { backgroundColor: colors.background }]}>
      {/* Modern gradient header */}
      <View style={[s.header,
        Platform.OS === 'web'
          ? { background: 'linear-gradient(135deg, #059669 0%, #10b981 50%, #34d399 100%)' }
          : { backgroundColor: ACCENT }
      ]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityLabel="Back" accessibilityRole="button">
          <IconArrowLeft size={24} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[s.headerTitle, { color: '#fff' }]}>{childName}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <IconEye size={13} color="rgba(255,255,255,0.8)" />
            <Text style={[s.headerSub, { color: 'rgba(255,255,255,0.8)' }]}>Modo monitoramento</Text>
          </View>
        </View>
        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' }}>
          <IconShield size={22} color="#fff" />
        </View>
      </View>

      {/* Tabs - scrollable */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[s.tabsScroll, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}
        contentContainerStyle={s.tabsContent}
      >
        {tabs.map(t2 => (
          <TouchableOpacity
            key={t2.key}
            style={[s.tab, tab === t2.key && { borderBottomColor: ACCENT }]}
            onPress={() => setTab(t2.key)}
          >
            <t2.icon size={15} color={tab === t2.key ? ACCENT : colors.textSecondary} />
            <Text style={[s.tabText, { color: tab === t2.key ? ACCENT : colors.textSecondary }]}>{t2.label}</Text>
            {t2.badge > 0 && <View style={s.tabBadge}><Text style={s.tabBadgeText}>{t2.badge}</Text></View>}
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* SOS Emergency Button */}
      {!loading && (
        <View style={[s.sosContainer, { backgroundColor: isDark ? '#1e293b' : '#fff', borderBottomColor: isDark ? '#334155' : '#f1f5f9' }]}>
          <TouchableOpacity
            style={s.sosButton}
            onPress={async () => {
              if (sosLoading) return;
              setSosLoading(true);
              try {
                const r = await api.parentalGetLocation(childEmail);
                if (r.success && r.data) {
                  Alert.alert(
                    t('parental.childLocation') || 'Child Location',
                    `${r.data.latitude?.toFixed(5)}, ${r.data.longitude?.toFixed(5)}\n${t('parental.lastUpdated') || 'Updated'}: ${r.data.updated_at ? new Date(r.data.updated_at).toLocaleTimeString() : '--'}`,
                    [{ text: 'OK' }]
                  );
                } else {
                  Alert.alert(t('parental.locationUnavailable') || 'Location unavailable', t('parental.locationUnavailableDesc') || 'Could not retrieve location. Child may be offline.');
                }
              } catch {
                Alert.alert(t('parental.error') || 'Error', t('parental.connectionError') || 'Connection error');
              } finally { setSosLoading(false); }
            }}
            activeOpacity={0.7}
            accessibilityLabel="SOS - Find child location"
            accessibilityRole="button"
          >
            {sosLoading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <IconAlertCircle size={18} color="#fff" />
                <Text style={s.sosButtonText}>{t('parental.findChild') || 'Find Child'}</Text>
              </>
            )}
          </TouchableOpacity>

          {/* Screen time quick bar */}
          {screenTime?.today_minutes !== undefined && (
            <View style={s.quickTimeBar}>
              <IconClock size={14} color={colors.textSecondary} />
              <View style={[s.quickTimeBg, { backgroundColor: isDark ? '#0f172a' : '#f1f5f9' }]}>
                <View style={[s.quickTimeFill, {
                  width: `${Math.min((screenTime.today_minutes / Math.max(restrictions.daily_limit_minutes || 180, 1)) * 100, 100)}%`,
                  backgroundColor: (screenTime.today_minutes / Math.max(restrictions.daily_limit_minutes || 180, 1)) > 0.8 ? '#ef4444' : ACCENT,
                }]} />
              </View>
              <Text style={[s.quickTimeText, { color: colors.textSecondary }]}>{screenTime.today_minutes}m</Text>
            </View>
          )}
        </View>
      )}

      {/* Content */}
      {loading ? (
        <View style={s.loadingContainer}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      ) : (
        <Animated.View style={{ flex: 1, opacity: slideAnim }}>
          {tabContent[tab]()}
        </Animated.View>
      )}
    </View>
  );
}

// ─── Shared Components ───

function SettingRow({ icon, label, right, colors }) {
  return (
    <View style={s.settingRow}>
      <View style={s.settingLeft}>
        {icon}
        <Text style={[s.settingLabel, { color: colors.text }]}>{label}</Text>
      </View>
      {right}
    </View>
  );
}

function EmptyState({ icon: Icon, text }) {
  return (
    <View style={s.emptyContainer}>
      <Icon size={40} color="#94a3b8" />
      <Text style={s.emptyText}>{text}</Text>
    </View>
  );
}

// ─── Styles ───

const s = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 16, gap: 14 },
  backBtn: { padding: 6, minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 22, fontWeight: '800' },
  headerSub: { fontSize: 13, fontWeight: '500' },

  // Tabs
  tabsScroll: { borderBottomWidth: 1, maxHeight: 48 },
  tabsContent: { paddingHorizontal: 4 },
  tab: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 5, borderBottomWidth: 2.5, borderBottomColor: 'transparent' },
  tabText: { fontSize: 12, fontWeight: '600' },
  tabBadge: { backgroundColor: '#ef4444', minWidth: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  tabBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },

  // Cards (shared)
  card: { flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 20, borderWidth: 1, marginBottom: 12, gap: 14 },
  cardIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  cardSub: { fontSize: 14, marginTop: 3 },
  cardMeta: { fontSize: 12 },
  cardMetaSm: { fontSize: 11, marginTop: 2 },
  listContent: { padding: 18, paddingBottom: 30 },

  // Pills
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  pillText: { fontSize: 11, fontWeight: '600' },

  // Unread dot
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#3b82f6' },

  // Settings group
  sectionLabel: { fontSize: 12, fontWeight: '800', letterSpacing: 0.8, marginBottom: 10, paddingHorizontal: 4 },
  settingsGroup: { borderRadius: 20, borderWidth: 1, overflow: 'hidden' },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 16, minHeight: 56 },
  settingLeft: { flexDirection: 'row', alignItems: 'center', gap: 14, flex: 1 },
  settingLabel: { fontSize: 16, fontWeight: '600' },
  divider: { height: 1, marginHorizontal: 16 },

  // Time limit chips
  timeLimitRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  timeLimitChip: { paddingHorizontal: 18, paddingVertical: 12, borderRadius: 16, borderWidth: 2, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  timeLimitText: { fontSize: 15, fontWeight: '700' },

  // Bedtime
  bedtimeLabel: { fontSize: 13, fontWeight: '700', marginBottom: 8 },
  bedtimeInput: { height: 54, borderRadius: 16, paddingHorizontal: 18, fontSize: 20, fontWeight: '800', textAlign: 'center', borderWidth: 2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  bedtimeHint: { fontSize: 13, marginTop: 14, textAlign: 'center' },

  // Whitelist
  addContactRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  addContactInput: { flex: 1, height: 44, borderRadius: 12, paddingHorizontal: 14, fontSize: 14, borderWidth: 1 },
  addContactBtn: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  whitelistItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  whitelistAvatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  whitelistName: { fontSize: 14, fontWeight: '600' },
  whitelistEmail: { fontSize: 12, marginTop: 1 },
  emptyInline: { fontSize: 13, textAlign: 'center', paddingVertical: 16 },

  // Screen time
  screenTimeCard: { borderRadius: 20, borderWidth: 1, padding: 18 },
  screenTimeHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 },
  screenTimeLabel: { fontSize: 17, fontWeight: '700' },
  progressOuter: { gap: 10 },
  progressBarBg: { height: 12, borderRadius: 6, overflow: 'hidden' },
  progressBarFill: { height: 12, borderRadius: 6 },
  progressText: { fontSize: 15, marginTop: 6 },

  // Bar chart
  barChartContainer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', height: 170, paddingTop: 10 },
  barCol: { alignItems: 'center', flex: 1, justifyContent: 'flex-end', gap: 5 },
  bar: { width: 32, minHeight: 4, borderRadius: 6 },
  barValue: { fontSize: 11, fontWeight: '700' },
  barLabel: { fontSize: 12, marginTop: 5 },

  // Active hours
  hoursGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hourChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  hourText: { fontSize: 14, fontWeight: '700' },
  hourPct: { fontSize: 11, marginTop: 1 },

  // Contacts list
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  contactAvatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  contactName: { fontSize: 14, fontWeight: '600' },
  contactMeta: { fontSize: 12, marginTop: 1 },

  // Save indicator
  saveIndicator: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 8, borderRadius: 10, marginBottom: 12 },

  // Loading / Empty
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyContainer: { alignItems: 'center', justifyContent: 'center', paddingTop: 60, gap: 12 },
  emptyText: { textAlign: 'center', fontSize: 14, color: '#94a3b8' },

  // SOS button
  sosContainer: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 10, gap: 12, borderBottomWidth: 1 },
  sosButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#ef4444', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 14, minHeight: 40, minWidth: 120 },
  sosButtonText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  quickTimeBar: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  quickTimeBg: { flex: 1, height: 8, borderRadius: 4, overflow: 'hidden' },
  quickTimeFill: { height: 8, borderRadius: 4 },
  quickTimeText: { fontSize: 12, fontWeight: '700', minWidth: 30, textAlign: 'right' },
});
