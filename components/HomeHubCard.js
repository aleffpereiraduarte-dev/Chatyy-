/**
 * HomeHubCard — the "platform" hub at the very top of the chat home.
 * ---------------------------------------------------------------------------
 * Brief (2026-06-09): the home "looks like just a conversation list"; it should
 * make the user understand in seconds that Chatyy is a platform (comms first,
 * productivity right behind). This compact card sits above the chat list and
 * surfaces the productivity pillars as premium quick-access tiles.
 *
 * SAFETY: fully self-contained — owns its own (minimal) hooks so it can NEVER
 * change ChatListTab's hook order (that file has a history of "rendered more
 * hooks" crashes). It does NO network calls (zero perf cost on the hottest
 * screen); live counts are a deliberate follow-up. If anything is off it still
 * renders as a clean launcher. One-line injection into the list header.
 */
import React, { useRef, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Animated, Easing, Platform, AppState } from 'react-native';
import Svg, { Path, Circle, Rect, Line, Defs, LinearGradient as SvgLinearGradient, Stop } from 'react-native-svg';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { getFolders, taskList, calEvents } from '../services/api';

// Local YYYY-MM-DDT00:00:00 stamp (matches what the calendar API expects).
function dayStamp(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00:00`;
}

// ── Live counts for the pillar tiles (the "intelligent hub" part of the brief) ──
// Kept deliberately cheap + fail-safe: only the two counts that are NOT a heavy
// IMAP scan on the hot path — INBOX unread (fast Rust folders path) and pending
// tasks (a SQLite count). Each fetch is independent + best-effort; on any failure
// the tile simply renders with no badge (never blocks/breaks the launcher). A
// module-level cache + 30s TTL stops a refetch storm when the home re-mounts.
const _hubCountsCache = { email: null, tasks: null, calendar: null, ts: 0 };
const HUB_COUNTS_TTL = 30000;

function useHubCounts() {
  const [counts, setCounts] = useState(() => ({ email: _hubCountsCache.email, tasks: _hubCountsCache.tasks, calendar: _hubCountsCache.calendar }));
  useEffect(() => {
    let alive = true;
    const fetchCounts = async () => {
      // Email — INBOX unread off the (fast) folders list.
      getFolders().then((r) => {
        if (!alive) return;
        const inbox = r?.data?.folders?.find((f) => f.name === 'INBOX');
        const n = inbox ? (inbox.unread || inbox.unseen || 0) : 0;
        _hubCountsCache.email = n; setCounts((c) => ({ ...c, email: n }));
      }).catch(() => {});
      // Tasks — pending count (cheap SQLite).
      taskList('pending').then((r) => {
        if (!alive) return;
        const n = r?.success ? (r.data?.tasks?.length || 0) : 0;
        _hubCountsCache.tasks = n; setCounts((c) => ({ ...c, tasks: n }));
      }).catch(() => {});
      // Agenda — events happening today (today-only window → count = today's events).
      const today = new Date();
      const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
      calEvents(dayStamp(today), dayStamp(tomorrow)).then((r) => {
        if (!alive) return;
        const n = r?.data?.events?.length || 0;
        _hubCountsCache.calendar = n; setCounts((c) => ({ ...c, calendar: n }));
      }).catch(() => {});
      _hubCountsCache.ts = Date.now();
    };
    // Let the chat list settle first, and skip if we fetched recently.
    const fresh = _hubCountsCache.ts && (Date.now() - _hubCountsCache.ts) < HUB_COUNTS_TTL;
    const timer = setTimeout(fetchCounts, fresh ? 0 : 1000);
    if (fresh) clearTimeout(timer);
    // Refresh when the app returns to foreground (counts may have changed).
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && (!_hubCountsCache.ts || Date.now() - _hubCountsCache.ts > HUB_COUNTS_TTL)) fetchCounts();
    });
    return () => { alive = false; clearTimeout(timer); sub?.remove?.(); };
  }, []);
  return counts;
}

function Glyph({ kind, color }) {
  const s = { stroke: color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' };
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      {kind === 'ai' && <><Path d="M12 3 L13.4 9 L19 10.4 L13.4 11.8 L12 18 L10.6 11.8 L5 10.4 L10.6 9 Z" {...s} /><Path d="M18.5 15 L19.2 17.3 L21.5 18 L19.2 18.7 L18.5 21 L17.8 18.7 L15.5 18 L17.8 17.3 Z" {...s} /></>}
      {kind === 'email' && <><Rect x={3} y={5} width={18} height={14} rx={3} {...s} /><Path d="M4 7 L12 13 L20 7" {...s} /></>}
      {kind === 'calendar' && <><Rect x={4} y={5} width={16} height={15} rx={3} {...s} /><Line x1={4} y1={9} x2={20} y2={9} {...s} /><Line x1={9} y1={3} x2={9} y2={6} {...s} /><Line x1={15} y1={3} x2={15} y2={6} {...s} /></>}
      {kind === 'drive' && <Path d="M3 8 C3 6 4.5 5 6 5 L10 5 L12.5 7.5 L18 7.5 C19.5 7.5 21 8.5 21 10.5 L21 16 C21 18 19.5 19 18 19 L6 19 C4.5 19 3 18 3 16 Z" {...s} />}
      {kind === 'photos' && <><Rect x={4} y={5} width={16} height={14} rx={3} {...s} /><Circle cx={9} cy={10} r={1.8} {...s} /><Path d="M5 17 L10 12 L13 15 L16 13 L19 16" {...s} /></>}
      {kind === 'tasks' && <><Rect x={4} y={4} width={16} height={16} rx={4} {...s} /><Path d="M8 12 L11 15 L16 9" {...s} /></>}
    </Svg>
  );
}

const TILES = [
  { kind: 'ai', route: '/one', c1: '#A78BFA', c2: '#7C3AED', key: 'home.hub.ai', fallback: 'One' },
  { kind: 'email', route: '/inbox', c1: '#60A5FA', c2: '#2563EB', key: 'home.hub.email', fallback: 'E-mail' },
  { kind: 'calendar', route: '/calendar', c1: '#34D399', c2: '#059669', key: 'home.hub.calendar', fallback: 'Agenda' },
  { kind: 'drive', route: '/drive', c1: '#FBBF24', c2: '#D97706', key: 'home.hub.drive', fallback: 'Drive' },
  { kind: 'tasks', route: '/tasks', c1: '#22D3EE', c2: '#0891B2', key: 'home.hub.tasks', fallback: 'Tarefas' },
  { kind: 'photos', route: '/photos', c1: '#F472B6', c2: '#DB2777', key: 'home.hub.photos', fallback: 'Fotos' },
];

function HubTile({ tile, colors, t, badge, onPress }) {
  const scale = useRef(new Animated.Value(1)).current;
  const gid = `hub${tile.c1.slice(1)}${tile.c2.slice(1)}`;
  const hasBadge = typeof badge === 'number' && badge > 0;
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      onPressIn={() => Animated.spring(scale, { toValue: 0.93, useNativeDriver: true, friction: 6 }).start()}
      onPressOut={() => Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 6 }).start()}
      style={styles.tile}
    >
      <Animated.View style={[styles.tileIcon, { transform: [{ scale }] }, Shadow.cardRest]}>
        <Svg width={48} height={48} viewBox="0 0 48 48" style={StyleSheet.absoluteFill}>
          <Defs>
            <SvgLinearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={tile.c1} />
              <Stop offset="1" stopColor={tile.c2} />
            </SvgLinearGradient>
          </Defs>
          <Rect x="0" y="0" width="48" height="48" rx="15" fill={`url(#${gid})`} />
        </Svg>
        <Glyph kind={tile.kind} color="#fff" />
        {hasBadge && (
          <View style={[styles.badge, { borderColor: colors.surface }]}>
            <Text style={styles.badgeText} numberOfLines={1}>{badge > 99 ? '99+' : badge}</Text>
          </View>
        )}
      </Animated.View>
      <Text style={[styles.tileLabel, { color: colors.textSecondary }]} numberOfLines={1}>
        {t?.(tile.key) || tile.fallback}
      </Text>
    </TouchableOpacity>
  );
}

// First name, capitalized — from name/display_name, falling back to the email
// local-part. Keeps the greeting warm without leaking a full email address.
function firstNameOf(user) {
  const raw = (user?.name || user?.display_name || user?.full_name || (user?.email || '').split('@')[0] || '').trim();
  if (!raw) return '';
  const first = raw.split(/[\s.]+/)[0];
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : '';
}

export default function HomeHubCard({ colors, isDark, t, router, user }) {
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(10)).current;
  const counts = useHubCounts();
  // Time-of-day greeting. new Date() is fine in app code (only blocked in
  // workflow scripts). Falls back to a generic title if there's no name yet.
  const hour = new Date().getHours();
  const greetKey = hour < 12 ? 'home.hub.greetMorning' : hour < 18 ? 'home.hub.greetAfternoon' : 'home.hub.greetEvening';
  const greetWord = t?.(greetKey) || (hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite');
  const name = firstNameOf(user);
  const greeting = name ? `${greetWord}, ${name}` : (t?.('home.hub.title') || 'Acesso rápido');
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 380, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(slide, { toValue: 0, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [fade, slide]);

  const go = (route) => { try { router?.push?.(route); } catch {} };

  return (
    <Animated.View style={[styles.wrap, { opacity: fade, transform: [{ translateY: slide }] }]}>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, Shadow.cardRest]}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{greeting}</Text>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.scroll}
          contentContainerStyle={styles.row}
        >
          {TILES.map((tile) => (
            <HubTile key={tile.kind} tile={tile} colors={colors} t={t} badge={counts[tile.kind]} onPress={() => go(tile.route)} />
          ))}
        </ScrollView>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 },
  card: { borderRadius: BorderRadius.xl, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 12, paddingHorizontal: 4 },
  header: { paddingHorizontal: 12, marginBottom: 8 },
  title: { fontSize: FontSize.lg, fontWeight: '800', letterSpacing: -0.2 },
  subtitle: { fontSize: FontSize.sm, marginTop: 1 },
  row: { paddingHorizontal: 8, gap: 6, ...(Platform.OS === 'web' ? {} : {}) },
  tile: { alignItems: 'center', width: 64, marginHorizontal: 2 },
  // overflow stays visible so the count badge can sit just outside the icon's
  // top-right corner (WhatsApp/iOS launcher pattern). The gradient Rect is
  // already clipped to the rounded icon by its own viewBox, so nothing leaks.
  tileIcon: { width: 48, height: 48, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute', top: -5, right: -6, minWidth: 18, height: 18,
    borderRadius: 9, paddingHorizontal: 4, backgroundColor: '#EF4444',
    alignItems: 'center', justifyContent: 'center', borderWidth: 2,
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800', lineHeight: 13 },
  tileLabel: { fontSize: FontSize.xs, fontWeight: '600', marginTop: 6, textAlign: 'center' },
});
