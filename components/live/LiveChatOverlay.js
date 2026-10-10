/**
 * LiveChatOverlay — TikTok-grade floating comment stream over the video.
 *
 * [lives-engage 2026-10-10] Reescrito sobre ScrollView:
 *   • Rola de verdade (últimas 40 mensagens) com auto-scroll suave quando o
 *     usuário está no fim; se ele rolou pra cima, o fluxo NÃO pula e aparece
 *     a pílula "N novas" (toque → desce até o fim).
 *   • Selos P&B: HOST (branco sólido), MOD / CONVIDADO (contorno), #1-#3 para
 *     os top fãs da live (ranking do hub).
 *   • Menções: "@nome" em negrito; menção a VOCÊ destaca a linha inteira.
 *   • Presente no chat (só com presentes ligados): pílula branca com a arte SVG.
 *
 * Contrato de props antigo mantido (messages, commentHearts, onPressMessage,
 * onOpenSheet, onLongPressHost, isHostView, hasMore, seeAllLabel, hostEmail);
 * novos opcionais: engage (store de engajamento), modEmails.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Animated, ScrollView, Dimensions,
} from 'react-native';
import AvatarCircle from '../AvatarCircle';
import { IconHeart, IconUserPlus, IconChevronDown } from '../Icons';
import formatLiveChatContent from '../../utils/formatLiveChatContent';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import LiveGiftGlyph from './LiveGiftGlyph';
import { giftMeta, giftLabel } from './liveEngageConfig';
import { useEngageSelector, selTopFans } from './liveEngageStore';

const MAX_ROWS = 40;
const MENTION_RE = /(@[A-Za-z0-9_.\-À-ɏ]+)/g;

function entryStyle(entry) {
  if (!entry) return null;
  return {
    opacity: entry,
    transform: [
      { translateY: entry.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
      { scale: entry.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
    ],
  };
}

function renderWithMentions(text, meTokens) {
  const parts = String(text || '').split(MENTION_RE);
  let mentionsMe = false;
  const nodes = parts.map((p, i) => {
    if (i % 2 === 1) {
      const tok = p.slice(1).toLowerCase();
      const me = meTokens.has(tok);
      if (me) mentionsMe = true;
      return <Text key={i} style={[styles.mention, me && styles.mentionMe]}>{p}</Text>;
    }
    return p;
  });
  return { nodes, mentionsMe };
}

const Badge = memo(function Badge({ label, solid }) {
  return (
    <View style={[styles.badge, solid ? styles.badgeSolid : styles.badgeLine]}>
      <Text style={[styles.badgeText, solid && styles.badgeTextSolid]}>{label}</Text>
    </View>
  );
});

const CommentRow = memo(function CommentRow({
  m, isHostView, onPressMessage, onLongPressHost, role, fanRank, heartAnim, meTokens, labels,
}) {
  const { nodes, mentionsMe } = useMemo(
    () => renderWithMentions(formatLiveChatContent(m.content), meTokens),
    [m.content, meTokens],
  );
  return (
    <Animated.View style={entryStyle(m.entry)}>
      <TouchableOpacity
        onPress={() => onPressMessage?.(m)}
        onLongPress={isHostView ? () => onLongPressHost?.(m) : undefined}
        delayLongPress={350}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`${labels.reply} ${m.name}`}
        style={[styles.row, mentionsMe && styles.rowMention]}
      >
        <AvatarCircle name={m.name} email={m.email} size={26} />
        <View style={styles.body}>
          <View style={styles.nameLine}>
            <Text style={[styles.name, role === 'host' && styles.nameHost]} numberOfLines={1}>{m.name}</Text>
            {role === 'host' ? <Badge label={labels.host} solid /> : null}
            {role === 'mod' ? <Badge label={labels.mod} /> : null}
            {role === 'guest' ? <Badge label={labels.guest} /> : null}
            {fanRank ? <Badge label={`#${fanRank}`} /> : null}
          </View>
          <Text style={styles.text} numberOfLines={4}>{nodes}</Text>
        </View>
        {heartAnim ? (
          <Animated.View
            pointerEvents="none"
            style={[styles.heartChip, {
              opacity: heartAnim,
              transform: [
                { scale: heartAnim.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) },
                { translateY: heartAnim.interpolate({ inputRange: [0, 1], outputRange: [10, -4] }) },
              ],
            }]}
          >
            <IconHeart size={14} color="#fff" />
          </Animated.View>
        ) : null}
      </TouchableOpacity>
    </Animated.View>
  );
});

const SystemRow = memo(function SystemRow({ m }) {
  return (
    <Animated.View style={[styles.systemRow, entryStyle(m.entry)]} pointerEvents="none">
      <View style={styles.systemPill}>
        {m.email ? (
          <View style={styles.systemAvatarWrap}>
            <AvatarCircle name={m.name} email={m.email} size={16} />
          </View>
        ) : (
          <IconUserPlus size={11} color="#fff" />
        )}
        <Text style={styles.systemText} numberOfLines={1}>
          <Text style={styles.systemName}>{m.name}</Text>
          <Text>{` ${formatLiveChatContent(m.text || m.content || '')}`}</Text>
        </Text>
      </View>
    </Animated.View>
  );
});

const GiftRow = memo(function GiftRow({ m, t }) {
  const meta = giftMeta(m.gift);
  return (
    <Animated.View style={[styles.giftRow, entryStyle(m.entry)]} pointerEvents="none">
      <View style={styles.giftPill}>
        <AvatarCircle name={m.name} email={m.email} size={20} />
        <Text style={styles.giftText} numberOfLines={1}>
          <Text style={styles.giftName}>{m.name}</Text>
          {` ${t('liveEng.giftSent')} ${giftLabel(t, meta.icon, meta.label)}`}
        </Text>
        <LiveGiftGlyph icon={meta.icon} size={22} />
      </View>
    </Animated.View>
  );
});

function LiveChatOverlay({
  messages = [],
  commentHearts = {},
  onPressMessage,
  onOpenSheet,
  onLongPressHost,
  isHostView = false,
  hasMore = false,
  seeAllLabel = '',
  hostEmail = null,
  engage = null,
  modEmails = null,
}) {
  const { t } = useLanguage();
  let user = null;
  try { user = useAuth()?.user || null; } catch { user = null; }
  const topFans = useEngageSelector(engage, selTopFans);
  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);
  const lastIdRef = useRef(null);
  const [unseen, setUnseen] = useState(0);
  const maxH = useMemo(() => {
    const h = Dimensions.get('window').height;
    return Math.max(150, Math.min(270, Math.round(h * 0.28)));
  }, []);

  const visible = useMemo(() => messages.slice(-MAX_ROWS), [messages]);

  const meTokens = useMemo(() => {
    const s = new Set();
    const name = String(user?.name || '').toLowerCase();
    if (name) { s.add(name.replace(/\s+/g, '')); s.add(name.split(/\s+/)[0]); }
    const local = String(user?.email || '').toLowerCase().split('@')[0];
    if (local) s.add(local);
    return s;
  }, [user?.name, user?.email]);

  const fanRanks = useMemo(() => {
    const m = {};
    (topFans || []).forEach((f, i) => { if (f?.email) m[String(f.email).toLowerCase()] = i + 1; });
    return m;
  }, [topFans]);

  const modSet = useMemo(() => new Set((modEmails || []).map(e => String(e).toLowerCase())), [modEmails]);
  const host = String(hostEmail || '').toLowerCase();

  const labels = useMemo(() => ({
    host: t('liveEng.badgeHost'),
    mod: t('liveEng.badgeMod'),
    guest: t('liveEng.badgeGuest'),
    reply: t('liveEng.replyTo'),
  }), [t]);

  // Novas mensagens: rola se estava no fim, senão conta "N novas".
  useEffect(() => {
    const last = visible.length ? visible[visible.length - 1].id : null;
    const prev = lastIdRef.current;
    lastIdRef.current = last;
    if (last == null || last === prev) return;
    if (atBottomRef.current) return; // onContentSizeChange cuida do scroll
    const idx = prev == null ? -1 : visible.findIndex(m => m.id === prev);
    const added = idx >= 0 ? visible.length - 1 - idx : 1;
    if (added > 0) setUnseen(u => Math.min(99, u + added));
  }, [visible]);

  const onScroll = useCallback((e) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent || {};
    if (!contentOffset) return;
    const atBottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
    atBottomRef.current = atBottom;
    if (atBottom) setUnseen(u => (u ? 0 : u));
  }, []);

  const onContentSizeChange = useCallback(() => {
    if (atBottomRef.current) {
      try { scrollRef.current?.scrollToEnd({ animated: true }); } catch {}
    }
  }, []);

  const jumpToEnd = useCallback(() => {
    atBottomRef.current = true;
    setUnseen(0);
    try { scrollRef.current?.scrollToEnd({ animated: true }); } catch {}
  }, []);

  const roleOf = (m) => {
    const e = String(m.email || '').toLowerCase();
    if (m.tier === 'host' || (host && e === host)) return 'host';
    if (m.tier === 'mod' || (e && modSet.has(e))) return 'mod';
    if (m.tier === 'guest' || m.tier === 'cohost') return 'guest';
    return null;
  };

  return (
    <View style={styles.overlay}>
      {hasMore && onOpenSheet ? (
        <TouchableOpacity
          onPress={onOpenSheet}
          style={styles.seeAllChip}
          activeOpacity={0.8}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
          accessibilityRole="button"
          accessibilityLabel={seeAllLabel}
        >
          <Text style={styles.seeAllText}>{seeAllLabel}</Text>
        </TouchableOpacity>
      ) : null}

      <ScrollView
        ref={scrollRef}
        style={[styles.scroll, { maxHeight: maxH }]}
        contentContainerStyle={styles.scrollContent}
        onScroll={onScroll}
        scrollEventThrottle={32}
        onContentSizeChange={onContentSizeChange}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {visible.map((m) => {
          if (m.isSystem || m.type === 'system') return <SystemRow key={m.id} m={m} />;
          if (m.type === 'gift' || m.gift) return <GiftRow key={m.id} m={m} t={t} />;
          return (
            <CommentRow
              key={m.id}
              m={m}
              isHostView={isHostView}
              onPressMessage={onPressMessage}
              onLongPressHost={onLongPressHost}
              role={roleOf(m)}
              fanRank={fanRanks[String(m.email || '').toLowerCase()] || 0}
              heartAnim={commentHearts[m.id]}
              meTokens={meTokens}
              labels={labels}
            />
          );
        })}
      </ScrollView>

      {unseen > 0 ? (
        <TouchableOpacity
          onPress={jumpToEnd}
          style={styles.newPill}
          activeOpacity={0.85}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel={t('liveEng.newComments').replace('{n}', String(unseen))}
        >
          <IconChevronDown size={14} color="#000" />
          <Text style={styles.newPillText}>{t('liveEng.newComments').replace('{n}', String(unseen))}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

// memo: só re-renderiza quando messages/props mudam (não a cada tick da tela).
export default memo(LiveChatOverlay);

const styles = StyleSheet.create({
  overlay: {
    paddingRight: 70, // espaço do right rail
    marginBottom: 8,
  },
  scroll: {
    flexGrow: 0,
    ...(Platform.OS === 'web' ? {
      WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.35) 10%, #000 30%)',
      maskImage: 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.35) 10%, #000 30%)',
    } : {}),
  },
  scrollContent: { gap: 6, paddingTop: 8 },
  seeAllChip: {
    alignSelf: 'flex-start',
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  seeAllText: { color: 'rgba(255,255,255,0.9)', fontSize: 11, fontWeight: '700', letterSpacing: 0.2 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    maxWidth: '96%',
    paddingVertical: 3,
    paddingHorizontal: 4,
    borderRadius: 12,
    alignSelf: 'flex-start',
  },
  rowMention: {
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.45)',
  },
  body: { flexShrink: 1 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 1 },
  name: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.1,
    flexShrink: 1,
    textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2,
  },
  nameHost: { color: '#fff' },
  badge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 },
  badgeSolid: { backgroundColor: '#fff' },
  badgeLine: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)', backgroundColor: 'rgba(0,0,0,0.35)' },
  badgeText: { color: '#fff', fontSize: 8.5, fontWeight: '900', letterSpacing: 0.5 },
  badgeTextSolid: { color: '#000' },
  text: {
    color: '#fff',
    fontSize: 13.5,
    lineHeight: 18,
    fontWeight: '500',
    textShadowColor: 'rgba(0,0,0,0.75)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3,
  },
  mention: { fontWeight: '800', color: '#fff' },
  mentionMe: { textDecorationLine: 'underline' },

  systemRow: { alignSelf: 'flex-start', maxWidth: '88%' },
  systemPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingLeft: 4, paddingRight: 11, paddingVertical: 3,
    backgroundColor: 'rgba(0,0,0,0.4)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', borderRadius: 14,
  },
  systemAvatarWrap: { borderRadius: 10, overflow: 'hidden', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.55)' },
  systemText: { color: 'rgba(255,255,255,0.96)', fontSize: 11.5, fontWeight: '500' },
  systemName: { fontWeight: '800', color: '#fff' },

  giftRow: { alignSelf: 'flex-start', maxWidth: '94%' },
  giftPill: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingLeft: 4, paddingRight: 8, paddingVertical: 4,
    backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: 16,
  },
  giftText: { color: 'rgba(0,0,0,0.8)', fontSize: 12, fontWeight: '600', flexShrink: 1 },
  giftName: { color: '#000', fontWeight: '900' },

  heartChip: {
    marginLeft: 6,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: '#111',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: '#fff',
  },
  newPill: {
    position: 'absolute',
    bottom: 4,
    alignSelf: 'center',
    left: '30%',
    flexDirection: 'row', alignItems: 'center', gap: 4,
    height: 30, paddingHorizontal: 12, borderRadius: 15,
    backgroundColor: '#fff',
    ...(Platform.OS === 'web' ? { boxShadow: '0 4px 14px rgba(0,0,0,0.35)' } : { elevation: 3 }),
  },
  newPillText: { color: '#000', fontSize: 12, fontWeight: '800' },
});
