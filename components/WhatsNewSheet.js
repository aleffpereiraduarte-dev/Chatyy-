/**
 * WhatsNewSheet — One-time tour of features shipped this session.
 *
 * Surfaces a 10-tile guided tour to existing users on the first launch
 * after upgrading to v2.5.0. Bottom sheet on mobile, centered modal on
 * desktop. Skipping or completing the tour persists a flag in
 * AsyncStorage so we never show it again on this device.
 *
 * Mounted from app/_layout.js once the user is logged in. The visibility
 * gate lives there — this component is purely presentational and emits
 * `onClose` (tap outside / X / Pular tudo / final CTA) and `onTileCta`
 * (tap on a tile / Experimentar / final "Começar a usar"), which the
 * parent translates into router.push() navigation.
 *
 * IMPORTANT: no new i18n keys — every string falls back via `t() || '…'`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Modal, Pressable, ScrollView, Animated, Platform,
  Dimensions, StyleSheet, useWindowDimensions,
} from 'react-native';
import {
  IconBuilding, IconBookmark, IconMic, IconCalendar, IconHome, IconShield,
  IconSend, IconZap, IconPhone, IconLock, IconX, IconChevronLeft,
  IconChevronRight, IconSparkles,
} from './Icons';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';

const STORAGE_KEY = 'chatyy_whatsnew_v2_5_0';
const VERSION_KEY = 'chatyy_last_seen_version';
const CURRENT_VERSION = '2.5.0';

const BRAND_PURPLE = '#7C3AED';
const BRAND_PURPLE_DARK = '#5B21B6';
const BRAND_PINK = '#EC4899';

// ─── Module-level helpers exposed for parent (gate) ──────────────────

let AsyncStorageRef = null;
function _getAsync() {
  if (AsyncStorageRef) return AsyncStorageRef;
  try {
    AsyncStorageRef = require('@react-native-async-storage/async-storage').default;
  } catch {}
  return AsyncStorageRef;
}

/**
 * Returns true if we should show the What's New tour.
 *  - Never shows on cold install (signup-fresh users): if VERSION_KEY is
 *    missing, set it to CURRENT_VERSION and return false. Next upgrade
 *    will then surface the tour.
 *  - Returns false if user already saw v2.5.0 (STORAGE_KEY set).
 *  - Returns true only when last-seen version differs from current AND
 *    the dismiss flag isn't set.
 */
export async function shouldShowWhatsNew() {
  const A = _getAsync();
  if (!A) return false;
  try {
    const dismissed = await A.getItem(STORAGE_KEY);
    if (dismissed === 'true') return false;
    const lastSeen = await A.getItem(VERSION_KEY);
    if (!lastSeen) {
      // Cold install — bookmark current version, don't show tour to brand-new users
      try { await A.setItem(VERSION_KEY, CURRENT_VERSION); } catch {}
      return false;
    }
    if (lastSeen === CURRENT_VERSION) return false;
    // Upgrade detected
    return true;
  } catch {
    return false;
  }
}

/** Mark the tour as seen and bookmark the current version. */
export async function markWhatsNewSeen() {
  const A = _getAsync();
  if (!A) return;
  try {
    await A.setItem(STORAGE_KEY, 'true');
    await A.setItem(VERSION_KEY, CURRENT_VERSION);
  } catch {}
}

// ─── Custom icons (megaphone + robot + phone-arrow + lock-shield) ────
// IconSend / IconZap / IconPhone / IconLock are reused as graceful
// fallbacks — only IconBookmark, IconBuilding, IconMic, IconCalendar,
// IconHome, IconShield map exactly. The stylized cards below use a
// gradient halo behind whatever icon we hand them, so visually they
// all land in the same family even if the SVG isn't a 1:1 match.

// ─── Tile catalog ────────────────────────────────────────────────────

function buildTiles(t) {
  const tx = (k, fb) => (typeof t === 'function' ? (t(k) || fb) : fb);
  return [
    {
      key: 'communities',
      icon: IconBuilding,
      title: tx('whatsnew.communities.title', 'Comunidades'),
      desc: tx('whatsnew.communities.desc', 'Junte-se a milhares de pessoas em grupos públicos.'),
      ctaRoute: '/community/discover',
      gradient: ['#7C3AED', '#A855F7'],
    },
    {
      key: 'saved',
      icon: IconBookmark,
      title: tx('whatsnew.saved.title', 'Mensagens Salvas'),
      desc: tx('whatsnew.saved.desc', 'Suas anotações e arquivos importantes em um só lugar.'),
      ctaRoute: '/saved-messages',
      gradient: ['#0EA5E9', '#3B82F6'],
    },
    {
      key: 'voicemail',
      icon: IconMic,
      title: tx('whatsnew.voicemail.title', 'Mensagem de voz'),
      desc: tx('whatsnew.voicemail.desc', 'Deixe um recado quando ninguém atender.'),
      ctaRoute: null, // descriptive only
      gradient: ['#F59E0B', '#EF4444'],
    },
    {
      key: 'callSchedule',
      icon: IconCalendar,
      title: tx('whatsnew.callSchedule.title', 'Agendar chamadas'),
      desc: tx('whatsnew.callSchedule.desc', 'Marque reuniões com lembretes automáticos.'),
      ctaRoute: '/call-schedule',
      gradient: ['#10B981', '#06B6D4'],
      secondaryIcon: IconPhone,
    },
    {
      key: 'family',
      icon: IconHome,
      title: tx('whatsnew.family.title', 'Família compartilhada'),
      desc: tx('whatsnew.family.desc', 'Compartilhe planos, fotos e localização.'),
      ctaRoute: '/family',
      gradient: ['#EC4899', '#F97316'],
    },
    {
      key: 'privacy',
      icon: IconShield,
      title: tx('whatsnew.privacy.title', 'Privacidade avançada'),
      desc: tx('whatsnew.privacy.desc', 'Sealed sender, mensagens que somem e tradução de conversas.'),
      ctaRoute: '/settings',
      gradient: ['#6366F1', '#8B5CF6'],
    },
    {
      key: 'broadcast',
      icon: IconSend, // megaphone fallback
      title: tx('whatsnew.broadcast.title', 'Listas de transmissão'),
      desc: tx('whatsnew.broadcast.desc', 'Mande a mesma mensagem pra vários sem criar grupo.'),
      ctaRoute: '/chat-new',
      gradient: ['#F43F5E', '#EC4899'],
    },
    {
      key: 'bots',
      icon: IconZap, // robot fallback
      title: tx('whatsnew.bots.title', 'Bots & APIs'),
      desc: tx('whatsnew.bots.desc', 'Crie integrações personalizadas pro seu fluxo.'),
      ctaRoute: '/bots',
      gradient: ['#14B8A6', '#0EA5E9'],
    },
    {
      key: 'changePhone',
      icon: IconPhone,
      title: tx('whatsnew.changePhone.title', 'Mudar número'),
      desc: tx('whatsnew.changePhone.desc', 'Trocou de SIM? Mantenha suas conversas.'),
      ctaRoute: '/change-phone',
      gradient: ['#3B82F6', '#6366F1'],
    },
    {
      key: 'pin',
      icon: IconLock,
      title: tx('whatsnew.pin.title', 'PIN de segurança'),
      desc: tx('whatsnew.pin.desc', 'Proteção extra contra SIM swap.'),
      ctaRoute: '/settings',
      gradient: ['#0F766E', '#14B8A6'],
      secondaryIcon: IconShield,
    },
  ];
}

// ─── Confetti SVG burst (final page) ─────────────────────────────────

function ConfettiBurst({ size = 120 }) {
  // Pure RN — render colored dots arranged in a radial burst. No SVG
  // dependency beyond what Icons.js already pulls in.
  const pieces = useMemo(() => {
    const colors = ['#F59E0B', '#EC4899', '#7C3AED', '#10B981', '#3B82F6', '#F97316', '#EF4444'];
    return Array.from({ length: 18 }).map((_, i) => {
      const angle = (i / 18) * Math.PI * 2;
      const r = 36 + (i % 3) * 10;
      const cx = Math.cos(angle) * r;
      const cy = Math.sin(angle) * r;
      const w = 4 + (i % 3) * 2;
      const h = 8 + (i % 4) * 3;
      const rot = `${(angle * 180) / Math.PI + 30}deg`;
      return {
        x: cx, y: cy, w, h, rot,
        color: colors[i % colors.length],
      };
    });
  }, []);
  const burst = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(burst, {
      toValue: 1, duration: 700, useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [burst]);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={{
          position: 'absolute',
          width: size, height: size,
          alignItems: 'center', justifyContent: 'center',
          opacity: burst,
          transform: [{ scale: burst.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }],
        }}
      >
        {pieces.map((p, i) => (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: size / 2 + p.x - p.w / 2,
              top: size / 2 + p.y - p.h / 2,
              width: p.w, height: p.h, borderRadius: 2,
              backgroundColor: p.color,
              transform: [{ rotate: p.rot }],
            }}
          />
        ))}
      </Animated.View>
      <View style={{
        width: 56, height: 56, borderRadius: 28,
        backgroundColor: BRAND_PURPLE,
        alignItems: 'center', justifyContent: 'center',
        shadowColor: BRAND_PURPLE, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 8,
      }}>
        <IconSparkles size={28} color="#fff" />
      </View>
    </View>
  );
}

// ─── Tile card ──────────────────────────────────────────────────────

function TileCard({ tile, colors, isDark, onCta, t }) {
  const Icon = tile.icon;
  const Secondary = tile.secondaryIcon;
  const tx = (k, fb) => (typeof t === 'function' ? (t(k) || fb) : fb);

  return (
    <View style={{
      flex: 1, alignItems: 'center', justifyContent: 'center',
      paddingHorizontal: 28, paddingVertical: 24,
    }}>
      {/* Gradient halo behind icon (faked with two stacked colored circles) */}
      <View style={{
        width: 124, height: 124, borderRadius: 62,
        alignItems: 'center', justifyContent: 'center',
        marginBottom: 24,
      }}>
        <View style={{
          position: 'absolute',
          width: 124, height: 124, borderRadius: 62,
          backgroundColor: tile.gradient[0], opacity: 0.18,
        }} />
        <View style={{
          position: 'absolute',
          width: 88, height: 88, borderRadius: 44,
          backgroundColor: tile.gradient[1], opacity: 0.22,
        }} />
        <View style={{
          width: 68, height: 68, borderRadius: 34,
          backgroundColor: tile.gradient[0],
          alignItems: 'center', justifyContent: 'center',
          shadowColor: tile.gradient[0],
          shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.45,
          shadowRadius: 16, elevation: 10,
        }}>
          <Icon size={32} color="#fff" />
          {Secondary ? (
            <View style={{
              position: 'absolute', right: -6, bottom: -6,
              width: 28, height: 28, borderRadius: 14,
              backgroundColor: tile.gradient[1],
              alignItems: 'center', justifyContent: 'center',
              borderWidth: 2, borderColor: colors?.background || '#fff',
            }}>
              <Secondary size={14} color="#fff" />
            </View>
          ) : null}
        </View>
      </View>

      <Text
        style={{
          fontSize: 22, fontWeight: '800',
          color: colors?.text || '#111',
          textAlign: 'center', marginBottom: 12,
          letterSpacing: -0.4,
        }}
        accessibilityRole="header"
      >
        {tile.title}
      </Text>
      <Text style={{
        fontSize: 15, lineHeight: 22,
        color: colors?.textSecondary || '#666',
        textAlign: 'center', marginBottom: 28,
        maxWidth: 320,
      }}>
        {tile.desc}
      </Text>

      {tile.ctaRoute ? (
        <Pressable
          onPress={() => onCta?.(tile)}
          accessibilityRole="button"
          accessibilityLabel={tx('whatsnew.try', 'Experimentar')}
          style={({ pressed }) => ({
            paddingHorizontal: 26, paddingVertical: 12,
            borderRadius: 24,
            backgroundColor: tile.gradient[0],
            opacity: pressed ? 0.85 : 1,
            transform: [{ scale: pressed ? 0.97 : 1 }],
            shadowColor: tile.gradient[0],
            shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35,
            shadowRadius: 10, elevation: 6,
          })}
        >
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14, letterSpacing: 0.3 }}>
            {tx('whatsnew.try', 'Experimentar')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ─── Final celebration page ─────────────────────────────────────────

function FinalPage({ colors, t, onFinish }) {
  const tx = (k, fb) => (typeof t === 'function' ? (t(k) || fb) : fb);
  return (
    <View style={{
      flex: 1, alignItems: 'center', justifyContent: 'center',
      paddingHorizontal: 28, paddingVertical: 24,
    }}>
      <ConfettiBurst size={140} />
      <Text style={{
        fontSize: 26, fontWeight: '800',
        color: colors?.text || '#111',
        marginTop: 28, marginBottom: 12, letterSpacing: -0.5,
        textAlign: 'center',
      }}>
        {tx('whatsnew.done.title', 'Tudo certo!')}
      </Text>
      <Text style={{
        fontSize: 15, lineHeight: 22,
        color: colors?.textSecondary || '#666',
        textAlign: 'center', marginBottom: 32, maxWidth: 320,
      }}>
        {tx('whatsnew.done.desc', 'Aproveite as novidades. Você pode revisitar cada uma quando quiser.')}
      </Text>
      <Pressable
        onPress={onFinish}
        accessibilityRole="button"
        accessibilityLabel={tx('whatsnew.start', 'Começar a usar')}
        style={({ pressed }) => ({
          paddingHorizontal: 32, paddingVertical: 14,
          borderRadius: 28,
          backgroundColor: BRAND_PURPLE,
          opacity: pressed ? 0.9 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
          shadowColor: BRAND_PURPLE,
          shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4,
          shadowRadius: 14, elevation: 8,
        })}
      >
        <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15, letterSpacing: 0.4 }}>
          {tx('whatsnew.start', 'Começar a usar')}
        </Text>
      </Pressable>
    </View>
  );
}

// ─── Main sheet component ────────────────────────────────────────────

export default function WhatsNewSheet({ visible, onClose, onTileCta }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const tx = useCallback((k, fb) => (typeof t === 'function' ? (t(k) || fb) : fb), [t]);

  const tiles = useMemo(() => buildTiles(t), [t]);
  const totalPages = tiles.length + 1; // +1 for final celebration

  const { width: winW, height: winH } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && winW >= 900;

  const [pageIdx, setPageIdx] = useState(0);
  const fade = useRef(new Animated.Value(1)).current;
  const slide = useRef(new Animated.Value(0)).current;

  // Reset to first page each time the sheet opens
  useEffect(() => {
    if (visible) {
      setPageIdx(0);
      fade.setValue(1);
      slide.setValue(0);
    }
  }, [visible, fade, slide]);

  const goToPage = useCallback((next) => {
    if (next < 0 || next >= totalPages) return;
    const direction = next > pageIdx ? 1 : -1;
    Animated.parallel([
      Animated.timing(fade, { toValue: 0, duration: 140, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(slide, { toValue: direction * -16, duration: 140, useNativeDriver: Platform.OS !== 'web' }),
    ]).start(() => {
      setPageIdx(next);
      slide.setValue(direction * 16);
      Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(slide, { toValue: 0, duration: 180, useNativeDriver: Platform.OS !== 'web' }),
      ]).start();
    });
  }, [pageIdx, totalPages, fade, slide]);

  const handleNext = useCallback(() => {
    if (pageIdx < totalPages - 1) goToPage(pageIdx + 1);
    else handleFinish();
  }, [pageIdx, totalPages, goToPage]);

  const handlePrev = useCallback(() => {
    if (pageIdx > 0) goToPage(pageIdx - 1);
  }, [pageIdx, goToPage]);

  const handleFinish = useCallback(() => {
    markWhatsNewSeen().catch(() => {});
    onClose?.();
  }, [onClose]);

  const handleSkip = useCallback(() => {
    markWhatsNewSeen().catch(() => {});
    onClose?.();
  }, [onClose]);

  const handleTileCta = useCallback((tile) => {
    if (!tile?.ctaRoute) {
      // No nav target — treat as "next page"
      handleNext();
      return;
    }
    markWhatsNewSeen().catch(() => {});
    // Hand off to parent for navigation; parent should also call onClose.
    onTileCta?.(tile);
  }, [onTileCta, handleNext]);

  if (!visible) return null;

  const isFinalPage = pageIdx === totalPages - 1;
  const currentTile = !isFinalPage ? tiles[pageIdx] : null;

  // Sheet sizing: bottom sheet on mobile (full width, ~78% height),
  // centered card on desktop (520×640).
  const sheetWidth = isDesktop ? 520 : winW;
  const sheetHeight = isDesktop ? 640 : Math.min(winH * 0.85, 720);
  const sheetRadius = isDesktop ? 24 : 24;
  const sheetAnchor = isDesktop ? 'center' : 'flex-end';

  const bg = colors?.background || (isDark ? '#0d0d0d' : '#fff');
  const surface = colors?.surface || (isDark ? '#1a1a1a' : '#fff');

  return (
    <Modal
      visible={visible}
      transparent
      animationType={Platform.OS === 'web' ? 'fade' : 'slide'}
      onRequestClose={handleSkip}
      statusBarTranslucent
    >
      <Pressable
        onPress={handleSkip}
        accessibilityLabel={tx('whatsnew.dismiss', 'Fechar')}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.55)',
          justifyContent: sheetAnchor,
          alignItems: 'center',
        }}
      >
        <Pressable
          onPress={() => { /* swallow taps inside the sheet */ }}
          style={{
            width: sheetWidth,
            height: sheetHeight,
            backgroundColor: bg,
            borderTopLeftRadius: sheetRadius,
            borderTopRightRadius: sheetRadius,
            borderBottomLeftRadius: isDesktop ? sheetRadius : 0,
            borderBottomRightRadius: isDesktop ? sheetRadius : 0,
            overflow: 'hidden',
            shadowColor: '#000', shadowOffset: { width: 0, height: -4 },
            shadowOpacity: 0.25, shadowRadius: 24, elevation: 16,
          }}
        >
          {/* ── Gradient header ── */}
          <View style={{
            backgroundColor: BRAND_PURPLE_DARK,
            paddingTop: Platform.OS === 'ios' ? 18 : 14,
            paddingBottom: 16,
            paddingHorizontal: 18,
            flexDirection: 'row',
            alignItems: 'center',
          }}>
            {/* Subtle gradient cheat: stack two semi-transparent layers */}
            <View pointerEvents="none" style={{
              position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
              backgroundColor: BRAND_PURPLE,
              opacity: 0.85,
            }} />
            <View pointerEvents="none" style={{
              position: 'absolute', left: '40%', right: -40, top: -20, bottom: -20,
              backgroundColor: BRAND_PINK,
              opacity: 0.35,
              borderRadius: 200,
            }} />
            <View style={{ flex: 1 }}>
              <Text style={{
                fontSize: 11, fontWeight: '700', color: 'rgba(255,255,255,0.75)',
                letterSpacing: 1, textTransform: 'uppercase',
              }}>
                v{CURRENT_VERSION}
              </Text>
              <Text style={{
                fontSize: 22, fontWeight: '800', color: '#fff',
                marginTop: 2, letterSpacing: -0.3,
              }}>
                {tx('whatsnew.title', 'Novidades')}
              </Text>
            </View>
            <Pressable
              onPress={handleSkip}
              accessibilityRole="button"
              accessibilityLabel={tx('whatsnew.dismiss', 'Fechar')}
              hitSlop={12}
              style={({ pressed }) => ({
                width: 36, height: 36, borderRadius: 18,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: 'rgba(255,255,255,0.16)',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <IconX size={18} color="#fff" />
            </Pressable>
          </View>

          {/* ── Page content (cross-fade + slide) ── */}
          <Animated.View
            style={{
              flex: 1,
              opacity: fade,
              transform: [{ translateX: slide }],
            }}
          >
            <ScrollView
              contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
              showsVerticalScrollIndicator={false}
            >
              {isFinalPage ? (
                <FinalPage colors={colors} t={t} onFinish={handleFinish} />
              ) : (
                <TileCard
                  tile={currentTile}
                  colors={colors}
                  isDark={isDark}
                  onCta={handleTileCta}
                  t={t}
                />
              )}
            </ScrollView>
          </Animated.View>

          {/* ── Page indicator dots ── */}
          <View style={{
            flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
            gap: 6, paddingVertical: 10,
          }}>
            {Array.from({ length: totalPages }).map((_, i) => {
              const active = i === pageIdx;
              return (
                <View
                  key={i}
                  style={{
                    width: active ? 18 : 6, height: 6, borderRadius: 3,
                    backgroundColor: active ? BRAND_PURPLE : (colors?.border || 'rgba(0,0,0,0.18)'),
                  }}
                />
              );
            })}
          </View>

          {/* ── Footer (Prev / Continuar / Pular) ── */}
          {!isFinalPage ? (
            <View style={{
              flexDirection: 'row', alignItems: 'center',
              paddingHorizontal: 18, paddingTop: 4, paddingBottom: Platform.OS === 'ios' ? 28 : 18,
              gap: 10,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors?.border || 'rgba(0,0,0,0.06)',
            }}>
              <Pressable
                onPress={handleSkip}
                accessibilityRole="button"
                accessibilityLabel={tx('whatsnew.skipAll', 'Pular tudo')}
                style={({ pressed }) => ({
                  paddingHorizontal: 14, paddingVertical: 12,
                  opacity: pressed ? 0.5 : 1,
                })}
              >
                <Text style={{
                  color: colors?.textSecondary || '#666',
                  fontSize: 14, fontWeight: '500',
                }}>
                  {tx('whatsnew.skipAll', 'Pular tudo')}
                </Text>
              </Pressable>

              <View style={{ flex: 1 }} />

              {pageIdx > 0 ? (
                <Pressable
                  onPress={handlePrev}
                  accessibilityRole="button"
                  accessibilityLabel={tx('whatsnew.prev', 'Voltar')}
                  hitSlop={8}
                  style={({ pressed }) => ({
                    width: 44, height: 44, borderRadius: 22,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: colors?.surface || 'rgba(0,0,0,0.05)',
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <IconChevronLeft size={20} color={colors?.text || '#111'} />
                </Pressable>
              ) : null}

              <Pressable
                onPress={handleNext}
                accessibilityRole="button"
                accessibilityLabel={tx('whatsnew.continue', 'Continuar')}
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'center', gap: 8,
                  paddingHorizontal: 22, paddingVertical: 12,
                  borderRadius: 22,
                  backgroundColor: BRAND_PURPLE,
                  opacity: pressed ? 0.85 : 1,
                  transform: [{ scale: pressed ? 0.97 : 1 }],
                })}
              >
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14, letterSpacing: 0.3 }}>
                  {tx('whatsnew.continue', 'Continuar')}
                </Text>
                <IconChevronRight size={16} color="#fff" />
              </Pressable>
            </View>
          ) : (
            <View style={{ height: Platform.OS === 'ios' ? 28 : 18 }} />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
