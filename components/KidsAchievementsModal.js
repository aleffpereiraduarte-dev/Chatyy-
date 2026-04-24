/**
 * KidsAchievementsModal — shows the kid's trophy wall.
 *
 * Fetches /api/?action=kids_achievements and renders a grid of unlocked +
 * locked badges. Unlocked ones pop in with a bounce; locked ones appear
 * grayed out with just the name visible. Stats header shows level + stars
 * + streak + total questions answered.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, ScrollView, ActivityIndicator,
  Animated, Platform, StyleSheet, Dimensions,
} from 'react-native';
import Svg, { Path, Circle as SvgCircle } from 'react-native-svg';
import * as api from '../services/api';

const { width: SCREEN_W } = Dimensions.get('window');

function IconX({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M18 6L6 18M6 6l12 12" />
    </Svg>
  );
}
function IconStar({ size = 14, color = '#fbbf24' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <Path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </Svg>
  );
}
function IconFire({ size = 14, color = '#f97316' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M12 23c-4.97 0-9-3.58-9-8 0-3.19 2.13-6.17 3.45-7.58.37-.39 1-.1 1 .46v1.97c0 1.9 1.84 3.4 3.55 2.59.87-.42 1.5-1.27 1.5-2.25V2.5c0-.55.56-.87 1-.58C16.62 4.27 21 8.55 21 15c0 4.42-4.03 8-9 8z" />
    </Svg>
  );
}

function BadgeTile({ badge, delay }) {
  const scale = useRef(new Animated.Value(badge.unlocked ? 0.5 : 1)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, delay, tension: 100, friction: 8, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, delay, duration: 220, useNativeDriver: true }),
    ]).start();
  }, []);
  const u = badge.unlocked;
  return (
    <Animated.View style={{
      width: (SCREEN_W - 48) / 3,
      alignItems: 'center',
      paddingVertical: 12,
      opacity,
      transform: [{ scale }],
    }}>
      <View style={{
        width: 72, height: 72, borderRadius: 36,
        backgroundColor: u ? '#fef3c7' : '#e5e7eb',
        alignItems: 'center', justifyContent: 'center', marginBottom: 6,
        ...(u && Platform.OS === 'web' ? { boxShadow: '0 6px 16px rgba(251,191,36,0.35)' } : {}),
        borderWidth: u ? 2 : 1,
        borderColor: u ? '#fbbf24' : '#d1d5db',
      }}>
        <Text style={{ fontSize: 36, opacity: u ? 1 : 0.3 }}>{badge.emoji}</Text>
      </View>
      <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: '700', color: u ? '#111' : '#9ca3af', textAlign: 'center' }}>
        {badge.name}
      </Text>
      <Text numberOfLines={2} style={{ fontSize: 10, color: u ? '#6b7280' : '#9ca3af', textAlign: 'center', marginTop: 2, paddingHorizontal: 2 }}>
        {badge.desc}
      </Text>
    </Animated.View>
  );
}

export default function KidsAchievementsModal({ visible, onClose, colors, isDark, t }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const r = await api.kidsAchievements();
        if (alive && r?.success) setData(r.data);
      } catch {} finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [visible]);

  const stats = data?.stats || {};
  const achievements = data?.achievements || [];
  const unlocked = data?.unlocked_count || 0;
  const total = data?.total || achievements.length;

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: isDark ? '#0f0720' : '#faf5ff',
          borderTopLeftRadius: 28, borderTopRightRadius: 28,
          maxHeight: '90%',
        }}>
          {/* Gradient header */}
          <View style={[styles.header, Platform.OS === 'web'
            ? { background: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 50%, #ef4444 100%)' }
            : { backgroundColor: '#f59e0b' },
          ]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.headerTitle}>{t?.('kids.achievements.title') || 'Minhas conquistas'}</Text>
              <Text style={styles.headerSub}>
                {unlocked}/{total} {t?.('kids.achievements.unlocked') || 'desbloqueadas'}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityLabel="Fechar">
              <IconX size={22} color="#fff" />
            </TouchableOpacity>
          </View>

          {/* Stats row */}
          <View style={styles.statsRow}>
            <View style={styles.statPill}>
              <Text style={styles.statNum}>Lv.{stats.level || 1}</Text>
              <Text style={styles.statLabel}>{t?.('kids.level') || 'Nível'}</Text>
            </View>
            <View style={[styles.statPill, { backgroundColor: '#fef3c7' }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <IconStar size={18} color="#fbbf24" />
                <Text style={[styles.statNum, { color: '#92400e' }]}>{stats.stars || 0}</Text>
              </View>
              <Text style={[styles.statLabel, { color: '#92400e' }]}>{t?.('kids.stars') || 'Estrelas'}</Text>
            </View>
            <View style={[styles.statPill, { backgroundColor: '#ffedd5' }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <IconFire size={18} color="#f97316" />
                <Text style={[styles.statNum, { color: '#9a3412' }]}>{stats.streak || 0}d</Text>
              </View>
              <Text style={[styles.statLabel, { color: '#9a3412' }]}>{t?.('kids.streak') || 'Sequência'}</Text>
            </View>
          </View>

          {loading ? (
            <View style={{ padding: 40, alignItems: 'center' }}>
              <ActivityIndicator color="#f59e0b" size="large" />
            </View>
          ) : (
            <ScrollView style={{ maxHeight: 440 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 28 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-start' }}>
                {achievements.map((a, i) => (
                  <BadgeTile key={a.key} badge={a} delay={i * 45} />
                ))}
              </View>
              {achievements.length === 0 && (
                <Text style={{ textAlign: 'center', color: isDark ? '#9ca3af' : '#6b7280', marginTop: 40 }}>
                  {t?.('kids.achievements.empty') || 'Responda perguntas pra desbloquear conquistas!'}
                </Text>
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 20,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
  },
  headerTitle: { fontSize: 22, fontWeight: '800', color: '#fff', letterSpacing: 0.3 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.9)', fontWeight: '600', marginTop: 2 },
  closeBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' },
  statsRow: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  statPill: {
    flex: 1, paddingVertical: 10, paddingHorizontal: 12,
    borderRadius: 16, backgroundColor: '#ede9fe', alignItems: 'center',
  },
  statNum: { fontSize: 18, fontWeight: '800', color: '#5b21b6' },
  statLabel: { fontSize: 11, fontWeight: '700', color: '#5b21b6', opacity: 0.7, marginTop: 2 },
});
