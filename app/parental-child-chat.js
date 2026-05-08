import { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator, TextInput, Alert, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconArrowLeft, IconEye, IconShield, IconCamera, IconVideo, IconMusic, IconPaperclip,
  IconNavigation, IconFilm, IconSearch, IconAlertTriangle, IconChevronRight,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import * as api from '../services/api';

const ACCENT = '#7C3AED';

const FILTERS = [
  { key: 'today',  labelKey: 'parental.filterToday', fallback: 'Hoje' },
  { key: 'week',   labelKey: 'parental.filterWeek',  fallback: 'Esta semana' },
  { key: 'month',  labelKey: 'parental.filterMonth', fallback: 'Este mês' },
  { key: 'all',    labelKey: 'parental.filterAll',   fallback: 'Tudo' },
];

function withinFilter(ts, filter) {
  if (!ts) return true;
  let date;
  try {
    date = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
    if (isNaN(date.getTime())) return true;
  } catch { return true; }
  const now = new Date();
  if (filter === 'all') return true;
  if (filter === 'today') {
    return date.toDateString() === now.toDateString();
  }
  if (filter === 'week') {
    const ms = now - date;
    return ms >= 0 && ms <= 7 * 86400 * 1000;
  }
  if (filter === 'month') {
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  }
  return true;
}

// Heuristic risk score from message volume + late-night ratio.
// Returns { level: 'low' | 'med' | 'high', score: 0..100 }
function computeRiskScore(messages) {
  if (!messages || messages.length === 0) return { level: 'low', score: 0 };
  let lateNight = 0;
  const total = messages.length;
  let last24h = 0;
  const now = Date.now();
  messages.forEach((m) => {
    try {
      const d = new Date(m.created_at);
      if (isNaN(d.getTime())) return;
      const h = d.getHours();
      if (h >= 23 || h < 6) lateNight++;
      if ((now - d.getTime()) <= 86400 * 1000) last24h++;
    } catch {}
  });
  const lateRatio = total > 0 ? lateNight / total : 0;
  const volumeScore = Math.min(50, last24h * 1.5); // 33 msgs/day → 50pts
  const lateScore = Math.round(lateRatio * 40);
  const score = Math.min(100, volumeScore + lateScore);
  let level = 'low';
  if (score >= 60) level = 'high';
  else if (score >= 30) level = 'med';
  return { level, score };
}

export default function ParentalChildChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  // expo-router pode retornar params como string[] em deep links — sempre
  // extrai o primeiro pra evitar passar array pra API/comparações.
  const childEmail = Array.isArray(params.child_email) ? params.child_email[0] : params.child_email;
  const conversationId = Array.isArray(params.conversation_id) ? params.conversation_id[0] : params.conversation_id;
  const chatName = Array.isArray(params.chat_name) ? params.chat_name[0] : (params.chat_name || t('parental.chats'));
  const otherEmail = Array.isArray(params.other_email) ? params.other_email[0] : params.other_email;

  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [flaggedIds, setFlaggedIds] = useState(() => new Set());

  const loadMessages = useCallback(async () => {
    if (!childEmail || !conversationId) { setLoading(false); return; }
    setLoading(true);
    try {
      const r = await api.parentalChildMessages(childEmail, conversationId);
      if (r.success) setMessages(r.data?.messages || []);
    } catch {} finally { setLoading(false); }
  }, [childEmail, conversationId]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

  const isChild = (senderEmail) => senderEmail === childEmail;

  const risk = useMemo(() => computeRiskScore(messages), [messages]);

  const filtered = useMemo(() => {
    const q = (search || '').trim().toLowerCase();
    return messages.filter((m) => {
      if (!withinFilter(m.created_at, filter)) return false;
      if (!q) return true;
      const txt = (m.content || m.file_name || '').toLowerCase();
      return txt.includes(q);
    });
  }, [messages, filter, search]);

  const handleFlag = useCallback((msg) => {
    const isFlagged = flaggedIds.has(msg.id);
    const titlePending = isFlagged
      ? (t('parental.unflagTitle') || 'Remover marcação?')
      : (t('parental.flagTitle') || 'Marcar como inadequado?');
    const titleDesc = isFlagged
      ? (t('parental.unflagDesc') || 'A mensagem deixará de aparecer no painel de revisão.')
      : (t('parental.flagDesc') || 'A mensagem aparecerá no painel de revisão dos pais.');

    const doFlag = async () => {
      // Optimistic toggle
      setFlaggedIds(prev => {
        const next = new Set(prev);
        if (isFlagged) next.delete(msg.id); else next.add(msg.id);
        return next;
      });
      try {
        // TODO: backend endpoint pending — parental_flag_message(child_email, message_id, flagged)
        if (api.parentalFlagMessage) {
          await api.parentalFlagMessage(childEmail, msg.id, !isFlagged);
        }
      } catch {}
    };

    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(titlePending + '\n\n' + titleDesc)) {
        doFlag();
      }
    } else {
      Alert.alert(
        titlePending, titleDesc,
        [
          { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
          { text: isFlagged ? (t('common.remove') || 'Remover') : (t('parental.flag') || 'Marcar'), style: 'destructive', onPress: doFlag },
        ]
      );
    }
  }, [childEmail, flaggedIds, t]);

  const renderMessage = ({ item }) => {
    const fromChild = isChild(item.sender_email);
    const senderName = item.sender_name || item.sender_email?.split('@')[0] || '?';
    const time = (_d => isNaN(_d.getTime()) ? '' : _d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))(new Date(item.created_at));
    const flagged = flaggedIds.has(item.id);

    let content = item.content;
    let contentIcon = null;
    if (item.type === 'image') { contentIcon = <IconCamera size={16} color="#64748b" />; content = t('parental.image') + (item.file_name ? ` (${item.file_name})` : ''); }
    else if (item.type === 'video') { contentIcon = <IconVideo size={16} color="#64748b" />; content = t('parental.video'); }
    else if (item.type === 'audio' || item.type === 'voice') { contentIcon = <IconMusic size={16} color="#64748b" />; content = t('parental.audio'); }
    else if (item.type === 'file') { contentIcon = <IconPaperclip size={16} color="#64748b" />; content = item.file_name || t('parental.unknown'); }
    else if (item.type === 'location') { contentIcon = <IconNavigation size={16} color="#3b82f6" />; content = t('parental.locationMsg'); }
    else if (item.type === 'gif') { contentIcon = <IconFilm size={16} color="#64748b" />; content = t('parental.gif'); }

    return (
      <TouchableOpacity
        onLongPress={() => handleFlag(item)}
        delayLongPress={350}
        activeOpacity={0.85}
        style={[s.msgRow, fromChild ? s.msgRowRight : s.msgRowLeft]}
        accessibilityHint={t('parental.flag') || 'Marcar como inadequado'}
      >
        <View style={[
          s.msgBubble,
          fromChild
            ? { backgroundColor: isDark ? '#4C1D95' : '#EDE9FE', borderBottomRightRadius: 4 }
            : { backgroundColor: isDark ? '#1e293b' : '#fff', borderBottomLeftRadius: 4 },
          flagged && { borderWidth: 2, borderColor: '#ef4444' },
        ]}>
          {!fromChild && <Text style={[s.msgSender, { color: ACCENT }]}>{senderName}</Text>}
          {contentIcon ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {contentIcon}
              <Text style={[s.msgText, { color: colors.text }]}>{content}</Text>
            </View>
          ) : (
            <Text style={[s.msgText, { color: colors.text }]}>{content}</Text>
          )}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginTop: 4 }}>
            {flagged && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <IconAlertTriangle size={11} color="#ef4444" />
                <Text style={{ fontSize: 10, color: '#ef4444', fontWeight: '700' }}>
                  {t('parental.flagged') || 'Inadequado'}
                </Text>
              </View>
            )}
            <Text style={[s.msgTime, { color: colors.textSecondary }]}>{time}</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  // Risk chip palette
  const RISK_PALETTE = {
    low:  { bg: '#10b98120', fg: '#10b981', label: t('parental.riskLow')  || 'Baixo' },
    med:  { bg: '#f59e0b20', fg: '#f59e0b', label: t('parental.riskMed')  || 'Médio' },
    high: { bg: '#ef444420', fg: '#ef4444', label: t('parental.riskHigh') || 'Alto'  },
  };
  const riskInfo = RISK_PALETTE[risk.level];

  return (
    <View style={[s.container, { backgroundColor: colors.background }]}>
      {/* Header — avatar + name + risk chip */}
      <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <AvatarCircle email={otherEmail} name={chatName} size={36} />
        <View style={{ flex: 1 }}>
          <Text style={[s.headerTitle, { color: colors.text }]} numberOfLines={1}>{chatName}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <IconEye size={11} color='#f59e0b' />
            <Text style={[s.headerSub, { color: '#f59e0b' }]}>{t('parental.readOnly')}</Text>
          </View>
        </View>
        <View style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, backgroundColor: riskInfo.bg }}>
          <Text style={{ fontSize: 11, fontWeight: '800', color: riskInfo.fg }}>
            {(t('parental.risk') || 'Risco') + ' ' + riskInfo.label}
          </Text>
        </View>
        <TouchableOpacity onPress={() => setSearchOpen(o => !o)} style={s.iconBtn} accessibilityRole="button" accessibilityLabel="Buscar">
          <IconSearch size={20} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Search bar */}
      {searchOpen && (
        <View style={[s.searchBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
          <IconSearch size={16} color={colors.textSecondary} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={t('parental.searchPlaceholder') || 'Buscar nas mensagens'}
            placeholderTextColor={colors.textSecondary}
            style={[s.searchInput, { color: colors.text }]}
            autoFocus
          />
          {!!search && (
            <TouchableOpacity onPress={() => setSearch('')} accessibilityRole="button" accessibilityLabel="Limpar">
              <Text style={{ color: colors.textSecondary, fontSize: 18 }}>×</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Filter chips */}
      <View style={[s.filters, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        {FILTERS.map(f => {
          const active = filter === f.key;
          return (
            <TouchableOpacity
              key={f.key}
              onPress={() => setFilter(f.key)}
              activeOpacity={0.7}
              style={[
                s.filterChip,
                {
                  backgroundColor: active ? ACCENT + '22' : (isDark ? '#1e293b' : '#f3f4f6'),
                  borderColor: active ? ACCENT : 'transparent',
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel={t(f.labelKey) || f.fallback}
            >
              <Text style={{
                fontSize: 12, fontWeight: '700',
                color: active ? ACCENT : (isDark ? '#cbd5e1' : '#475569'),
              }}>
                {t(f.labelKey) || f.fallback}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Monitoring Banner */}
      <View style={[s.banner, { backgroundColor: isDark ? '#1a2332' : '#fef3cd' }]}>
        <IconShield size={14} color="#f59e0b" />
        <Text style={[s.bannerText, { color: isDark ? '#fbbf24' : '#856404' }]}>{t('parental.viewingChild')}</Text>
        <Text style={{ fontSize: 11, color: isDark ? '#fbbf24' : '#856404', opacity: 0.85 }}>
          {t('parental.longPressFlag') || 'Toque longo para marcar'}
        </Text>
      </View>

      {/* Messages */}
      {loading ? (
        <ActivityIndicator size="large" color={ACCENT} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item, i) => String(item.id ?? item.created_at ?? i)}
          renderItem={renderMessage}
          contentContainerStyle={{ padding: 12, paddingBottom: 20 }}
          ListEmptyComponent={
            <Text style={[s.emptyText, { color: colors.textSecondary }]}>
              {search
                ? (t('parental.noResults') || 'Nada encontrado')
                : (t('parental.noMessages') || 'Nenhuma mensagem')}
            </Text>
          }
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, gap: 10 },
  backBtn: { padding: 4 },
  iconBtn: { padding: 6 },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  headerSub: { fontSize: 11 },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1 },
  filterChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1 },
  banner: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, gap: 8 },
  bannerText: { fontSize: 12, flex: 1 },
  msgRow: { marginBottom: 4, paddingHorizontal: 8 },
  msgRowLeft: { alignItems: 'flex-start' },
  msgRowRight: { alignItems: 'flex-end' },
  msgBubble: { maxWidth: '80%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  msgSender: { fontSize: 12, fontWeight: '700', marginBottom: 2 },
  msgText: { fontSize: 15, lineHeight: 20 },
  msgTime: { fontSize: 10 },
  emptyText: { textAlign: 'center', marginTop: 40, fontSize: 14 },
});
