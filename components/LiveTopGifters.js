/**
 * LiveTopGifters — top-3 gifters stacked avatars (top-right of a live).
 *
 * Visual:
 *   • Up to 3 circular avatars (28px) overlapping each other (-8px gap)
 *   • Each ring with gold border (#fbbf24, 1.5px)
 *   • Inline trophy SVG (gold fill) to the right of the stack
 *   • Tap → modal full-screen leaderboard (avatar + name + diamond total)
 *
 * Data:
 *   • Calls `chat_live_top_gifters` with { session_id } and renders the top 3
 *   • Refreshes when sessionId changes or when `refreshKey` bumps (used by
 *     parents to invalidate after a fresh live_gift WS event)
 *
 * Designed to drop into both live-broadcast.js (host POV) and live-viewer.js
 * (viewer POV) — same screen real estate (top-right under the close button,
 * above the viewer count pill).
 */

import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, FlatList,
  ActivityIndicator, Platform, Pressable,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import AvatarCircle from './AvatarCircle';
import { IconX } from './Icons';
import * as api from '../services/api';

const GOLD = '#fbbf24';
const GOLD_DEEP = '#d97706';

// Inline trophy SVG. No emoji per design rule (Icons.js + react-native-svg).
function IconTrophy({ size = 16, color = GOLD }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke={GOLD_DEEP} strokeWidth={1}>
      <Path d="M7 4h10v2h3a2 2 0 0 1 2 2v2a4 4 0 0 1-4 4h-.35a6 6 0 0 1-3.65 3.32V19h3v2H8v-2h3v-1.68A6 6 0 0 1 7.35 14H7a4 4 0 0 1-4-4V8a2 2 0 0 1 2-2h2V4Zm0 4H5v2a2 2 0 0 0 2 2V8Zm10 0v4a2 2 0 0 0 2-2V8h-2Z" />
    </Svg>
  );
}

// Compact diamond count formatter — 1234 → "1.2k", 1500000 → "1.5M".
function formatDiamonds(n) {
  const num = Number(n) || 0;
  if (num < 1000) return String(num);
  if (num < 1_000_000) {
    const v = num / 1000;
    return (Math.floor(v * 10) / 10).toFixed(v % 1 === 0 ? 0 : 1) + 'k';
  }
  const v = num / 1_000_000;
  return (Math.floor(v * 10) / 10).toFixed(v % 1 === 0 ? 0 : 1) + 'M';
}

export default function LiveTopGifters({
  sessionId,
  style,
  refreshKey = 0,
  i18n = {},
}) {
  // DIAMANTE DESLIGADO — leaderboard de "top gifters" (totais de diamante)
  // escondido (no-op), já que o envio de presente pago foi desligado.
  return null;
  // eslint-disable-next-line no-unreachable
  const [gifters, setGifters] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const res = await api.liveTopGifters(sessionId, 50);
      const list = Array.isArray(res?.data?.gifters) ? res.data.gifters
                 : Array.isArray(res?.gifters) ? res.gifters
                 : [];
      setGifters(list);
    } catch (e) {
      // Soft-fail — leaderboard is a "nice to have", don't break the live UI.
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  // Refetch every 30s while mounted — gift events also trigger refreshKey
  // bumps but a poll covers the case where WS missed an event.
  useEffect(() => {
    if (!sessionId) return;
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [sessionId, load]);

  const top3 = gifters.slice(0, 3);

  // Always render the trophy pill, even before gifters exist — it acts as
  // an entry point to the (empty) leaderboard. If we hide entirely on empty
  // the affordance disappears and the host can't preview the feature.
  return (
    <>
      <TouchableOpacity
        onPress={() => setShowModal(true)}
        activeOpacity={0.75}
        style={[styles.wrap, style]}
        accessibilityRole="button"
        accessibilityLabel={i18n.topGifters || 'Top gifters'}
      >
        <View style={styles.stack}>
          {top3.length === 0 ? (
            <View style={[styles.avatarSlot, styles.emptySlot]}>
              <IconTrophy size={14} color={GOLD} />
            </View>
          ) : (
            top3.map((g, idx) => (
              <View
                key={(g.email || '') + idx}
                style={[
                  styles.avatarSlot,
                  { marginLeft: idx === 0 ? 0 : -10, zIndex: top3.length - idx },
                ]}
              >
                <AvatarCircle name={g.name || g.email} email={g.email} size={28} />
              </View>
            ))
          )}
        </View>
        {top3.length > 0 ? (
          <View style={styles.trophyChip}>
            <IconTrophy size={13} color={GOLD} />
          </View>
        ) : null}
      </TouchableOpacity>

      <Modal
        visible={showModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowModal(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setShowModal(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation?.()}>
            <View style={styles.handle} />
            <View style={styles.headerRow}>
              <View style={styles.headerTitleRow}>
                <IconTrophy size={20} color={GOLD} />
                <Text style={styles.title}>{i18n.topGifters || 'Top gifters'}</Text>
              </View>
              <TouchableOpacity onPress={() => setShowModal(false)} style={styles.closeBtn}>
                <IconX size={20} color="#fff" />
              </TouchableOpacity>
            </View>
            {loading && gifters.length === 0 ? (
              <View style={styles.loading}>
                <ActivityIndicator color={GOLD} />
              </View>
            ) : gifters.length === 0 ? (
              <View style={styles.empty}>
                <IconTrophy size={42} color="rgba(251,191,36,0.3)" />
                <Text style={styles.emptyText}>
                  {i18n.noGiftersYet || 'Ninguém enviou presentes ainda'}
                </Text>
                <Text style={styles.emptyHint}>
                  {i18n.noGiftersHint || 'Seja o primeiro a apoiar este criador!'}
                </Text>
              </View>
            ) : (
              <FlatList
                data={gifters}
                keyExtractor={(item, i) => (item.email || '') + i}
                contentContainerStyle={styles.listContent}
                renderItem={({ item, index }) => (
                  <View style={styles.row}>
                    <View style={styles.rankBadge}>
                      <Text style={[
                        styles.rankText,
                        index === 0 && styles.rankGold,
                        index === 1 && styles.rankSilver,
                        index === 2 && styles.rankBronze,
                      ]}>
                        {index + 1}
                      </Text>
                    </View>
                    <AvatarCircle name={item.name || item.email} email={item.email} size={38} />
                    <View style={styles.rowMid}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {item.name || (item.email || '').split('@')[0]}
                      </Text>
                      <Text style={styles.rowEmail} numberOfLines={1}>{item.email}</Text>
                    </View>
                    <View style={styles.diamondPill}>
                      <DiamondSpark size={12} />
                      <Text style={styles.diamondText}>{formatDiamonds(item.total_diamonds)}</Text>
                    </View>
                  </View>
                )}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

// Tiny inline diamond glyph — used in the leaderboard row.
function DiamondSpark({ size = 12 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="#60a5fa" stroke="#1d4ed8" strokeWidth={1}>
      <Path d="M6 3h12l4 6-10 12L2 9l4-6Z" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.4)',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
    } : {}),
  },
  stack: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatarSlot: {
    width: 28, height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: GOLD,
    backgroundColor: '#000',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptySlot: {
    backgroundColor: 'rgba(251,191,36,0.12)',
    borderColor: 'rgba(251,191,36,0.6)',
  },
  trophyChip: {
    marginLeft: 4,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },

  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#15151a',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 24,
    maxHeight: '78%',
    minHeight: '40%',
  },
  handle: {
    alignSelf: 'center',
    width: 40, height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
  },
  closeBtn: {
    width: 32, height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  loading: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  empty: {
    paddingVertical: 36,
    alignItems: 'center',
    gap: 10,
  },
  emptyText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    marginTop: 6,
  },
  emptyHint: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
  },

  listContent: {
    paddingBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  rankBadge: {
    width: 24,
    alignItems: 'center',
  },
  rankText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 14,
    fontWeight: '800',
  },
  rankGold: { color: GOLD },
  rankSilver: { color: '#cbd5e1' },
  rankBronze: { color: '#fb923c' },
  rowMid: {
    flex: 1,
    minWidth: 0,
  },
  rowName: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  rowEmail: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11,
    marginTop: 1,
  },
  diamondPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: 'rgba(96,165,250,0.15)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(96,165,250,0.35)',
  },
  diamondText: {
    color: '#bfdbfe',
    fontSize: 12,
    fontWeight: '800',
  },
});
