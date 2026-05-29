import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  ActivityIndicator, Alert, Platform, RefreshControl, Animated, Easing,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
let Clipboard = null;
try { Clipboard = require('expo-clipboard'); } catch {}
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { Colors } from '../constants/theme';
import * as api from '../services/api';
import { useConfirm } from '../components/ConfirmModal';
import {
  IconArrowLeft, IconVideo, IconCopy, IconCheck, IconX,
  IconClock, IconEdit, IconTrash, IconUsers, IconCalendar, IconUser,
  IconMapPin, IconLock, IconShare, IconSparkles, IconPlus, IconStarFilled,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';

const ACCENT = '#7C3AED';
const ACCENT_DARK = '#5B21B6';
const ACCENT_DEEP = '#3B0F75';

function formatDate(dateStr, locale) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(locale || undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(dateStr, locale) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(locale || undefined, { hour: '2-digit', minute: '2-digit' });
}

function canJoin(meeting) {
  if (!meeting) return false;
  if (meeting.status === 'active') return true;
  if (meeting.status === 'scheduled' && meeting.scheduled_at) {
    // start é um number (ms epoch) — antes chamava .getTime() em number
    // e quebrava com TypeError na primeira reunião agendada.
    const start = new Date(meeting.scheduled_at).getTime();
    if (isNaN(start)) return false;
    return Date.now() >= start - 10 * 60 * 1000;
  }
  return false;
}

export default function MeetingDetailScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const confirm = useConfirm();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id, room_id } = useLocalSearchParams();

  const [meeting, setMeeting] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [isHost, setIsHost] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [joining, setJoining] = useState(false);
  const [rsvpLoading, setRsvpLoading] = useState(null);
  const [copied, setCopied] = useState(false);
  const [myRsvp, setMyRsvp] = useState(null);

  // Copy-link toast — slides down from header.
  const toastAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (copied) {
      Animated.spring(toastAnim, { toValue: 1, tension: 220, friction: 12, useNativeDriver: true }).start();
    } else {
      Animated.timing(toastAnim, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }
  }, [copied, toastAnim]);
  const toastTranslate = toastAnim.interpolate({ inputRange: [0, 1], outputRange: [-30, 0] });

  // Live pulse anim for "Ao vivo" status badge — pulsing red dot.
  const livePulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (meeting?.status !== 'active') return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(livePulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(livePulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [meeting?.status, livePulse]);
  const pulseScale = livePulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] });
  const pulseOpacity = livePulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] });

  const loadInfo = useCallback(async () => {
    try {
      const r = await api.meetInfo(room_id || id);
      if (r.success && r.data) {
        const m = r.data.meeting || r.data;
        setMeeting(m);
        setParticipants(r.data.participants || []);
        setIsHost(!!r.data.is_host || !!m.is_host);
        const me = (r.data.participants || []).find(
          p => (p.email || '').toLowerCase() === (user?.email || '').toLowerCase()
        );
        if (me) setMyRsvp(me.rsvp_status || null);
      }
    } catch (e) {
      console.warn('[MeetingDetail] loadInfo error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [room_id, id, user]);

  useEffect(() => { loadInfo(); }, [loadInfo]);

  const handleJoin = async () => {
    setJoining(true);
    try {
      const r = await api.meetJoin(room_id);
      if (r.success) {
        router.push('/meet/' + room_id);
      }
    } catch {} finally { setJoining(false); }
  };

  const handleRsvp = async (status) => {
    setRsvpLoading(status);
    try {
      const r = await api.meetRsvp(meeting?.room_id || room_id, status);
      if (r.success) {
        setMyRsvp(status);
        loadInfo();
      } else {
        Alert.alert(t('common.error') || 'Error', r.message || (t('meetingDetail.rsvpError') || 'Falha ao confirmar presença'));
      }
    } catch (e) {
      try { console.warn('[meetingDetail] rsvp error', e); } catch {}
      Alert.alert(t('common.error') || 'Error', t('meetingDetail.rsvpError') || 'Falha ao confirmar presença');
    } finally { setRsvpLoading(null); }
  };

  const handleCancel = async () => {
    const doCancel = async () => {
      try {
        const r = await api.meetCancel(meeting.room_id || id);
        if (r.success) router.back();
      } catch {}
    };
    const ok = Platform.OS === 'web'
      ? (typeof window !== 'undefined' && window.confirm(t('meetingDetail.cancelConfirm')))
      : await confirm({
          title: t('meetingDetail.cancelMeeting'),
          message: t('meetingDetail.cancelConfirm'),
          confirmLabel: t('meetingDetail.yesCancel'),
          cancelLabel: t('meetingDetail.no'),
          destructive: true,
        });
    if (ok) doCancel();
  };

  const handleDelete = async () => {
    const doDelete = async () => {
      try {
        const r = await api.meetDelete(meeting.room_id || room_id);
        if (r.success) router.back();
        else Alert.alert(t('common.error') || 'Error', r.message || 'Delete failed');
      } catch (e) {
        Alert.alert(t('common.error') || 'Error', e.message || 'Delete failed');
      }
    };
    const ok = Platform.OS === 'web'
      ? (typeof window !== 'undefined' && window.confirm(t('meetingDetail.deleteConfirm')))
      : await confirm({
          title: t('meetingDetail.deleteMeeting'),
          message: t('meetingDetail.deleteConfirm'),
          confirmLabel: t('meetingDetail.yesDelete'),
          cancelLabel: t('meetingDetail.no'),
          destructive: true,
        });
    if (ok) doDelete();
  };

  const handleCopyLink = async () => {
    const base = Platform.OS === 'web'
      ? (typeof window !== 'undefined' && window.location?.origin) || 'https://chatyy.com.br'
      : 'https://chatyy.com.br';
    const link = `${base}/meet/${room_id}`;
    try {
      if (Clipboard?.setStringAsync) {
        await Clipboard.setStringAsync(link);
      } else if (Platform.OS === 'web' && navigator.clipboard) {
        await navigator.clipboard.writeText(link);
      }
    } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading && !meeting) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      </View>
    );
  }

  if (!meeting) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={[styles.headerBar, { backgroundColor: colors.background }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('meetingDetail.title')}</Text>
        </View>
        <View style={styles.center}>
          <IconCalendar size={56} color={colors.textTertiary} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('meetingDetail.notFound')}</Text>
          <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
            {t('meetingDetail.notFoundDesc') || ''}
          </Text>
        </View>
      </View>
    );
  }

  const ended = meeting.status === 'ended';
  const cancelled = meeting.status === 'cancelled';
  const active = meeting.status === 'active';
  const scheduled = meeting.status === 'scheduled';
  const joinable = canJoin(meeting);
  const isFinished = ended || cancelled || meeting.is_finished;
  const recapId = meeting.recap_id || (isFinished ? (meeting.room_id || id) : null);

  // Status pill config.
  let statusCfg;
  if (active) statusCfg = { label: t('meetingDetail.statusActive') || 'Ao vivo', bg: '#ef4444', dotColor: '#fff', pulse: true };
  else if (scheduled) statusCfg = { label: t('meetingDetail.statusScheduled') || 'Em breve', bg: '#f59e0b', dotColor: '#fff', pulse: false };
  else if (ended) statusCfg = { label: t('meetingDetail.statusEnded') || 'Finalizada', bg: 'rgba(255,255,255,0.22)', dotColor: 'rgba(255,255,255,0.9)', pulse: false };
  else statusCfg = { label: t('meetingDetail.statusCancelled') || 'Cancelada', bg: 'rgba(255,255,255,0.22)', dotColor: 'rgba(255,255,255,0.9)', pulse: false };

  const hostParticipant = (participants || []).find(p => p.role === 'host');
  const hostName = meeting.host_name
    || (hostParticipant && (hostParticipant.display_name || hostParticipant.email))
    || meeting.host_email
    || t('meetingDetail.unknown');
  const hostEmail = (hostParticipant && hostParticipant.email) || meeting.host_email;
  const locale = t('_locale');

  // Detail pills data.
  const pills = [];
  if (meeting.scheduled_at) {
    pills.push({
      icon: IconCalendar,
      tint: ACCENT,
      label: t('meetingDetail.dateLabel') || 'Data',
      value: formatDate(meeting.scheduled_at, locale),
      sub: formatTime(meeting.scheduled_at, locale),
    });
  }
  if (meeting.duration_minutes > 0) {
    const dm = meeting.duration_minutes;
    const valueText = dm >= 60
      ? `${Math.floor(dm / 60)}h${dm % 60 ? ` ${dm % 60}m` : ''}`
      : `${dm} min`;
    pills.push({
      icon: IconClock,
      tint: '#f59e0b',
      label: t('meetingDetail.durationLabel') || 'Duração',
      value: valueText,
    });
  }
  if (meeting.location) {
    pills.push({
      icon: IconMapPin,
      tint: '#10b981',
      label: t('meetingDetail.locationLabel') || 'Local',
      value: meeting.location,
    });
  }
  pills.push({
    icon: IconUsers,
    tint: '#3b82f6',
    label: t('meetingDetail.participantsLabel') || 'Participantes',
    value: String(participants.length || 0),
  });
  if (meeting.is_private || meeting.private) {
    pills.push({
      icon: IconLock,
      tint: '#64748b',
      label: t('meetingDetail.privacyLabel') || 'Privacidade',
      value: t('meetingDetail.private') || 'Privada',
    });
  }

  const attachments = Array.isArray(meeting.attachments) ? meeting.attachments : [];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, Spacing.lg) + Spacing.lg + 72 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadInfo(); }} colors={[ACCENT]} tintColor={ACCENT} />}
      >
        {/* HERO — purple gradient effect via stacked overlays */}
        <View style={[styles.hero, { paddingTop: insets.top + Spacing.sm }]}>
          <View style={[styles.heroBg, { backgroundColor: ACCENT_DEEP }]} />
          <View style={[styles.heroBgOverlay1, { backgroundColor: ACCENT_DARK }]} />
          <View style={[styles.heroBgOverlay2, { backgroundColor: ACCENT }]} />
          {/* soft glow blobs (visual gradient feel without expo-linear-gradient) */}
          <View style={styles.heroGlow1} />
          <View style={styles.heroGlow2} />

          <View style={styles.heroTopRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtnHero} activeOpacity={0.7}>
              <IconArrowLeft size={22} color="#fff" />
            </TouchableOpacity>
            <View style={[styles.statusPill, { backgroundColor: statusCfg.bg }]}>
              {statusCfg.pulse && (
                <View style={styles.pulseWrap}>
                  <Animated.View style={[styles.pulseRing, { backgroundColor: statusCfg.dotColor, transform: [{ scale: pulseScale }], opacity: pulseOpacity }]} />
                  <View style={[styles.pulseDot, { backgroundColor: statusCfg.dotColor }]} />
                </View>
              )}
              {!statusCfg.pulse && <View style={[styles.pulseDot, { backgroundColor: statusCfg.dotColor }]} />}
              <Text style={styles.statusPillText}>{statusCfg.label}</Text>
            </View>
          </View>

          <Text style={styles.heroTitle} numberOfLines={3}>
            {meeting.title || t('meetingDetail.untitled')}
          </Text>

          <View style={styles.heroOrganizerRow}>
            <AvatarCircle name={hostName} email={hostEmail} size={36} style={{ marginRight: Spacing.sm }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.heroOrganizerName} numberOfLines={1}>{hostName}</Text>
              <Text style={styles.heroOrganizerLabel}>
                {t('meetingDetail.organizer')}
              </Text>
            </View>
            {meeting.scheduled_at && (
              <View style={styles.heroDateBox}>
                <Text style={styles.heroDateText}>{formatDate(meeting.scheduled_at, locale)}</Text>
                <Text style={styles.heroTimeText}>{formatTime(meeting.scheduled_at, locale)}</Text>
              </View>
            )}
          </View>
        </View>

        {/* Copy-link toast — overlay below hero. */}
        {copied && (
          <Animated.View pointerEvents="none" style={[
            styles.copyToast,
            { top: insets.top + 56, backgroundColor: isDark ? colors.surface : colors.text, opacity: toastAnim, transform: [{ translateY: toastTranslate }] },
          ]}>
            <IconCheck size={14} color={isDark ? ACCENT : colors.background} />
            <Text style={[styles.copyToastText, { color: isDark ? colors.text : colors.background }]}>
              {t('meetingDetail.copied')}
            </Text>
          </Animated.View>
        )}

        {/* PRIMARY CTA — sticky-ish (top of action area, big purple) */}
        <View style={styles.actionsWrap}>
          {!isFinished && scheduled && !joinable && meeting.scheduled_at && (
            <View style={[styles.primaryCtaDisabled, { backgroundColor: isDark ? colors.surfaceVariant || '#2a2a35' : '#eef2f7' }]}>
              <IconClock size={18} color={isDark ? colors.textSecondary : '#64748b'} style={{ marginRight: Spacing.sm }} />
              <Text style={[styles.primaryCtaDisabledText, { color: isDark ? colors.textSecondary : '#64748b' }]}>
                {(() => {
                  const start = new Date(meeting.scheduled_at).getTime();
                  const mins = Math.ceil((start - 10 * 60 * 1000 - Date.now()) / 60000);
                  return mins > 60
                    ? `${t('meetingDetail.availableIn') || 'Disponível em'} ${Math.ceil(mins / 60)}h`
                    : `${t('meetingDetail.availableIn') || 'Disponível em'} ${mins} min`;
                })()}
              </Text>
            </View>
          )}

          {/* RECAP card — show when ended/finished */}
          {isFinished && recapId && (
            <TouchableOpacity
              style={[styles.recapCard, { backgroundColor: isDark ? '#1c1430' : '#f5f0ff', borderColor: ACCENT + '55' }]}
              onPress={() => router.push('/meeting-recap?id=' + recapId)}
              activeOpacity={0.85}
            >
              <View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { backgroundColor: 'rgba(167,139,250,0.08)', borderRadius: 18 }]} />
              <View pointerEvents="none" style={[styles.recapGradientBlob]} />
              <View style={[styles.recapIconWrap, { backgroundColor: ACCENT }]}>
                <IconSparkles size={22} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.recapTitle, { color: isDark ? '#fff' : ACCENT_DARK }]}>
                  {t('meetingDetail.viewRecapTitle') || 'Resumo da IA'}
                </Text>
                <Text style={[styles.recapSubtitle, { color: isDark ? colors.textSecondary : '#6b5b8a' }]}>
                  {t('meetingDetail.viewRecapSub') || 'Veja insights, tópicos e decisões'}
                </Text>
              </View>
              <Text style={[styles.recapArrow, { color: ACCENT }]}>›</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* DETALHES grid — 2-col pills */}
        {pills.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              {t('meetingDetail.detailsSection') || 'Detalhes'}
            </Text>
            <View style={styles.pillGrid}>
              {pills.map((p, i) => {
                const Icon = p.icon;
                return (
                  <View
                    key={i}
                    style={[styles.detailPill, {
                      backgroundColor: colors.surface,
                      borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)',
                      shadowColor: isDark ? '#000' : '#94a3b8',
                    }]}
                  >
                    <View style={[styles.detailPillIcon, { backgroundColor: p.tint + '1a' }]}>
                      <Icon size={18} color={p.tint} />
                    </View>
                    <Text style={[styles.detailPillLabel, { color: colors.textSecondary }]}>{p.label}</Text>
                    <Text style={[styles.detailPillValue, { color: colors.text }]} numberOfLines={2}>{p.value}</Text>
                    {p.sub ? (
                      <Text style={[styles.detailPillSub, { color: colors.textTertiary }]}>{p.sub}</Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {/* RSVP card (non-host, not ended/cancelled) */}
        {!isHost && !isFinished && (
          <View style={styles.section}>
            <View style={[styles.cardSoft, { backgroundColor: colors.surface, borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)' }]}>
              <Text style={[styles.sectionTitle, { color: colors.text, marginBottom: Spacing.md, marginTop: 0 }]}>
                {t('meetingDetail.yourResponse')}
              </Text>
              <View style={styles.rsvpRow}>
                {['accepted', 'tentative', 'declined'].map((s) => {
                  const active = myRsvp === s;
                  const cfg = {
                    accepted: { bg: ACCENT, label: t('meetingDetail.accept') },
                    tentative: { bg: '#f59e0b', label: t('meetingDetail.maybe') },
                    declined: { bg: '#ef4444', label: t('meetingDetail.decline') },
                  };
                  const c = cfg[s];
                  return (
                    <TouchableOpacity
                      key={s}
                      style={[
                        styles.rsvpBtn,
                        { borderColor: c.bg },
                        active && { backgroundColor: c.bg },
                      ]}
                      onPress={() => handleRsvp(s)}
                      disabled={rsvpLoading !== null}
                      activeOpacity={0.7}
                    >
                      {rsvpLoading === s ? (
                        <ActivityIndicator size="small" color={active ? '#fff' : c.bg} />
                      ) : (
                        <Text style={[styles.rsvpBtnText, { color: active ? '#fff' : c.bg }]}>{c.label}</Text>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </View>
        )}

        {/* PARTICIPANTES — horizontal scroll */}
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={[styles.sectionTitle, { color: colors.text, marginBottom: 0, marginTop: 0 }]}>
              {t('meetingDetail.participantsSection') || 'Participantes'}
            </Text>
            <View style={[styles.countChip, { backgroundColor: ACCENT + '1a' }]}>
              <Text style={[styles.countChipText, { color: ACCENT }]}>{participants.length}</Text>
            </View>
          </View>

          {participants.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.participantsScroll}
            >
              {participants.map((p, i) => (
                <TouchableOpacity
                  key={p.user_id || p.email || i}
                  style={styles.participantTile}
                  activeOpacity={0.7}
                  onPress={() => {
                    if (p.email) router.push('/profile?email=' + encodeURIComponent(p.email));
                  }}
                >
                  <View style={styles.participantAvatarWrap}>
                    <AvatarCircle name={p.display_name || p.email} email={p.email} size={48} />
                    {p.role === 'host' && (
                      <View style={[styles.hostStar, { backgroundColor: ACCENT, borderColor: colors.background }]}>
                        <IconStarFilled size={10} color="#fff" />
                      </View>
                    )}
                  </View>
                  <Text style={[styles.participantTileName, { color: colors.text }]} numberOfLines={1}>
                    {p.display_name || (p.email || '').split('@')[0]}
                  </Text>
                  {p.rsvp_status === 'accepted' && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <IconCheck size={13} color={ACCENT} />
                      <Text style={[styles.participantRsvp, { color: ACCENT }]} numberOfLines={1}>{t('meetings.rsvpAccepted')}</Text>
                    </View>
                  )}
                  {p.rsvp_status === 'declined' && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <IconX size={13} color="#ef4444" />
                      <Text style={[styles.participantRsvp, { color: '#ef4444' }]} numberOfLines={1}>{t('meetings.rsvpDeclined')}</Text>
                    </View>
                  )}
                  {p.rsvp_status === 'tentative' && (
                    <Text style={[styles.participantRsvp, { color: '#f59e0b' }]} numberOfLines={1}>? {t('meetings.rsvpTentative')}</Text>
                  )}
                </TouchableOpacity>
              ))}
              {isHost && (
                <TouchableOpacity
                  style={[styles.inviteTile, { borderColor: ACCENT + '55', backgroundColor: ACCENT + '10' }]}
                  activeOpacity={0.7}
                  onPress={() => router.push('/contacts?pick=1&room_id=' + (meeting.room_id || room_id))}
                >
                  <View style={[styles.inviteIconWrap, { backgroundColor: ACCENT }]}>
                    <IconPlus size={22} color="#fff" />
                  </View>
                  <Text style={[styles.inviteLabel, { color: ACCENT }]} numberOfLines={1}>
                    {t('meetingDetail.invite') || 'Convidar'}
                  </Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          ) : (
            <View style={[styles.emptyParticipants, { backgroundColor: colors.surface, borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)' }]}>
              <IconUsers size={36} color={colors.textTertiary} />
              <Text style={{ color: colors.textTertiary, fontSize: FontSize.sm, marginTop: Spacing.xs }}>
                {t('meetingDetail.noParticipants')}
              </Text>
            </View>
          )}
        </View>

        {/* DESCRIÇÃO */}
        {!!meeting.description && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              {t('meetingDetail.descriptionSection') || 'Descrição'}
            </Text>
            <View style={[styles.cardSoft, { backgroundColor: colors.surface, borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)' }]}>
              <Text style={[styles.descriptionText, { color: colors.text }]}>
                {meeting.description}
              </Text>
            </View>
          </View>
        )}

        {/* ANEXOS */}
        {attachments.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              {t('meetingDetail.attachmentsSection') || 'Anexos'}
            </Text>
            <View style={styles.attachmentsWrap}>
              {attachments.map((a, i) => (
                <TouchableOpacity
                  key={a.id || a.url || i}
                  style={[styles.attachmentChip, { backgroundColor: colors.surface, borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)' }]}
                  activeOpacity={0.7}
                  onPress={() => {
                    if (a.url && Platform.OS === 'web' && typeof window !== 'undefined') {
                      window.open(a.url, '_blank');
                    }
                  }}
                >
                  <View style={[styles.attachmentIconWrap, { backgroundColor: ACCENT + '18' }]}>
                    <IconCopy size={16} color={ACCENT} />
                  </View>
                  <Text style={[styles.attachmentName, { color: colors.text }]} numberOfLines={1}>
                    {a.name || a.filename || t('meetingDetail.attachment') || 'Anexo'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* AÇÕES SECUNDÁRIAS — 4 icon button row */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            {t('meetingDetail.actionsSection') || 'Ações'}
          </Text>
          <View style={styles.secondaryActionsRow}>
            <SecondaryAction
              icon={IconCalendar}
              tint={ACCENT}
              label={t('meetingDetail.addToCalendar') || 'Agenda'}
              onPress={() => router.push('/calendar?meeting=' + (meeting.room_id || id))}
              colors={colors}
              isDark={isDark}
            />
            <SecondaryAction
              icon={copied ? IconCheck : IconShare}
              tint={copied ? ACCENT : '#3b82f6'}
              label={copied ? (t('meetingDetail.copied') || 'Copiado') : (t('meetingDetail.share') || 'Compartilhar')}
              onPress={handleCopyLink}
              colors={colors}
              isDark={isDark}
            />
            {isHost && !isFinished && (
              <SecondaryAction
                icon={IconEdit}
                tint="#10b981"
                label={t('meetingDetail.edit') || 'Editar'}
                onPress={() => router.push('/meeting-create?edit=' + (meeting.room_id || room_id))}
                colors={colors}
                isDark={isDark}
              />
            )}
            {isHost && !isFinished && (
              <SecondaryAction
                icon={IconX}
                tint="#ef4444"
                label={t('common.cancel') || 'Cancelar'}
                onPress={handleCancel}
                colors={colors}
                isDark={isDark}
              />
            )}
            {isHost && (isFinished) && (
              <SecondaryAction
                icon={IconTrash}
                tint="#ef4444"
                label={t('meetingDetail.deleteMeeting') || 'Excluir'}
                onPress={handleDelete}
                colors={colors}
                isDark={isDark}
              />
            )}
          </View>
        </View>
      </ScrollView>
      {!isFinished && (active || joinable) && (
        <TouchableOpacity
          style={[styles.primaryCta, styles.primaryCtaSticky, { bottom: insets.bottom + 16 }, joining && { opacity: 0.7 }]}
          onPress={handleJoin}
          disabled={joining}
          activeOpacity={0.85}
        >
          {joining ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <IconVideo size={20} color="#fff" style={{ marginRight: Spacing.sm }} />
              <Text style={styles.primaryCtaText}>{t('meetingDetail.joinMeeting') || 'Entrar na reunião'}</Text>
            </>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
}

function SecondaryAction({ icon: Icon, tint, label, onPress, colors, isDark }) {
  return (
    <TouchableOpacity style={styles.secondaryAction} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.secondaryActionIcon, {
        backgroundColor: tint + '18',
        borderColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(15,23,42,0.04)',
      }]}>
        <Icon size={20} color={tint} />
      </View>
      <Text style={[styles.secondaryActionLabel, { color: colors.textSecondary }]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.xl, paddingVertical: Spacing.xl * 2 },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '700', marginTop: Spacing.md },
  emptySubtitle: { fontSize: FontSize.sm, textAlign: 'center', marginTop: Spacing.xs },
  headerBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    marginRight: Spacing.sm,
  },
  headerTitle: { flex: 1, fontSize: FontSize.xl, fontWeight: '700' },

  /* HERO */
  hero: {
    position: 'relative',
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.xl,
    overflow: 'hidden',
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
  },
  heroBg: { ...StyleSheet.absoluteFillObject },
  heroBgOverlay1: {
    position: 'absolute', left: 0, right: 0, top: '30%', bottom: 0,
    opacity: 0.95,
  },
  heroBgOverlay2: {
    position: 'absolute', left: 0, right: 0, top: '65%', bottom: 0,
    opacity: 0.55,
  },
  heroGlow1: {
    position: 'absolute', width: 280, height: 280, borderRadius: 140,
    backgroundColor: 'rgba(255,255,255,0.10)',
    top: -80, right: -60,
  },
  heroGlow2: {
    position: 'absolute', width: 200, height: 200, borderRadius: 100,
    backgroundColor: 'rgba(124,58,237,0.45)',
    bottom: -40, left: -40,
  },
  heroTopRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: Spacing.lg,
  },
  backBtnHero: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  statusPill: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
    gap: 8,
  },
  pulseWrap: { width: 10, height: 10, alignItems: 'center', justifyContent: 'center' },
  pulseRing: {
    position: 'absolute', width: 10, height: 10, borderRadius: 5,
  },
  pulseDot: { width: 8, height: 8, borderRadius: 4 },
  statusPillText: {
    color: '#fff', fontSize: FontSize.xs, fontWeight: '800',
    letterSpacing: 0.6, textTransform: 'uppercase',
  },
  heroTitle: {
    color: '#fff', fontSize: 28, fontWeight: '800',
    letterSpacing: -0.5, lineHeight: 34,
    marginBottom: Spacing.lg,
  },
  heroOrganizerRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    borderRadius: 16,
  },
  heroOrganizerName: { color: '#fff', fontSize: FontSize.base, fontWeight: '700' },
  heroOrganizerLabel: { color: 'rgba(255,255,255,0.7)', fontSize: FontSize.xs, fontWeight: '500', marginTop: 1 },
  heroDateBox: { alignItems: 'flex-end', marginLeft: Spacing.sm },
  heroDateText: { color: '#fff', fontSize: FontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  heroTimeText: { color: 'rgba(255,255,255,0.75)', fontSize: FontSize.xs, fontWeight: '500', marginTop: 1 },

  /* Copy toast */
  copyToast: {
    position: 'absolute', alignSelf: 'center', zIndex: 100,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 16, paddingVertical: 10,
    borderRadius: 22,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 8,
  },
  copyToastText: { fontSize: FontSize.sm, fontWeight: '700', letterSpacing: -0.1 },

  /* PRIMARY CTA + RECAP */
  actionsWrap: {
    paddingHorizontal: Spacing.lg,
    marginTop: -Spacing.md,
  },
  primaryCta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: ACCENT,
    paddingVertical: 16,
    borderRadius: 18,
    shadowColor: ACCENT,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 8,
    ...(Platform.OS === 'web' ? { boxShadow: '0 8px 22px rgba(124,58,237,0.4)', cursor: 'pointer', transition: 'transform 180ms ease' } : {}),
  },
  primaryCtaText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '800', letterSpacing: -0.3 },
  primaryCtaSticky: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 50,
  },
  primaryCtaDisabled: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 18,
  },
  primaryCtaDisabledText: { fontSize: FontSize.base, fontWeight: '700' },

  recapCard: {
    flexDirection: 'row', alignItems: 'center',
    padding: Spacing.md,
    borderRadius: 18,
    borderWidth: 1.5,
    marginTop: Spacing.md,
    overflow: 'hidden',
  },
  recapGradientBlob: {
    position: 'absolute', right: -30, top: -30,
    width: 140, height: 140, borderRadius: 70,
    backgroundColor: 'rgba(167,139,250,0.18)',
  },
  recapIconWrap: {
    width: 44, height: 44, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    marginRight: Spacing.md,
  },
  recapTitle: { fontSize: FontSize.base, fontWeight: '800', letterSpacing: -0.2 },
  recapSubtitle: { fontSize: FontSize.sm, fontWeight: '500', marginTop: 2 },
  recapArrow: { fontSize: 26, fontWeight: '300', marginLeft: Spacing.sm },

  /* Sections */
  section: {
    paddingHorizontal: Spacing.lg,
    marginTop: Spacing.xl,
  },
  sectionTitle: {
    fontSize: FontSize.base,
    fontWeight: '800',
    letterSpacing: -0.2,
    marginBottom: Spacing.md,
    marginTop: 0,
    textTransform: 'uppercase',
    opacity: 0.85,
  },
  sectionHeaderRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: Spacing.md,
  },
  countChip: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12, minWidth: 28, alignItems: 'center' },
  countChipText: { fontSize: FontSize.sm, fontWeight: '800' },

  cardSoft: {
    borderRadius: 16,
    padding: Spacing.md,
    borderWidth: 1,
  },

  /* Detail pills */
  pillGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  detailPill: {
    width: '47%',
    maxWidth: 280,
    flexGrow: 1,
    minWidth: 140,
    borderRadius: 16,
    padding: Spacing.md,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  detailPillIcon: {
    width: 36, height: 36, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  detailPillLabel: {
    fontSize: FontSize.xs, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.4,
    marginBottom: 2,
  },
  detailPillValue: { fontSize: FontSize.base, fontWeight: '700', letterSpacing: -0.2 },
  detailPillSub: { fontSize: FontSize.sm, fontWeight: '500', marginTop: 2 },

  /* RSVP */
  rsvpRow: { flexDirection: 'row', gap: Spacing.sm },
  rsvpBtn: {
    flex: 1, borderWidth: 2, borderRadius: 14,
    paddingVertical: 12, alignItems: 'center', justifyContent: 'center',
    minHeight: 44,
  },
  rsvpBtnText: { fontWeight: '700', fontSize: FontSize.base },

  /* Participants horizontal */
  participantsScroll: { paddingVertical: Spacing.xs, paddingRight: 16, gap: Spacing.md },
  participantTile: {
    width: 76,
    alignItems: 'center',
  },
  participantAvatarWrap: { position: 'relative', marginBottom: Spacing.xs },
  hostStar: {
    position: 'absolute', right: -4, bottom: -4,
    width: 18, height: 18, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2,
  },
  hostStarText: { color: '#fff', fontSize: 10, fontWeight: '900', lineHeight: 12 },
  participantTileName: {
    fontSize: FontSize.sm, fontWeight: '700',
    textAlign: 'center', marginTop: 2,
  },
  participantRsvp: { fontSize: 10, fontWeight: '700', marginTop: 1 },
  inviteTile: {
    width: 76,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    paddingVertical: Spacing.sm,
  },
  inviteIconWrap: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.xs,
  },
  inviteLabel: { fontSize: FontSize.sm, fontWeight: '800' },
  emptyParticipants: {
    alignItems: 'center', paddingVertical: Spacing.xl,
    borderRadius: 16, borderWidth: 1,
  },

  /* Description */
  descriptionText: { fontSize: FontSize.base, lineHeight: 24, fontWeight: '400' },

  /* Attachments */
  attachmentsWrap: {
    flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm,
  },
  attachmentChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.sm + 2, paddingVertical: Spacing.sm,
    borderRadius: 14,
    borderWidth: 1,
    maxWidth: '100%',
    gap: Spacing.sm,
  },
  attachmentIconWrap: {
    width: 30, height: 30, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  attachmentName: { fontSize: FontSize.sm, fontWeight: '600', maxWidth: 200 },

  /* Secondary actions */
  secondaryActionsRow: {
    flexDirection: 'row',
    gap: Spacing.md,
    flexWrap: 'wrap',
  },
  secondaryAction: {
    alignItems: 'center',
    minWidth: 64,
    flexGrow: 0,
  },
  secondaryActionIcon: {
    width: 52, height: 52, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
    marginBottom: Spacing.xs,
  },
  secondaryActionLabel: {
    fontSize: FontSize.xs, fontWeight: '700',
    textAlign: 'center', maxWidth: 76,
  },
});
