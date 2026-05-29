/**
 * ChildRestrictionGuard -- Enforces parental restrictions on child accounts.
 * Shows bedtime blocker + graduation celebration modal.
 * Design: YouTube Kids / Messenger Kids inspired - friendly, colorful, animated.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, Platform, AppState, TouchableOpacity, Animated } from 'react-native';
import Svg, { Path, Circle as SvgCircle, Line, Rect, G, Polygon, Defs, LinearGradient, Stop, RadialGradient } from 'react-native-svg';
import { isChildAccount, getChildRestrictions, refreshChildRestrictions } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useRouter } from 'expo-router';
import { IconLock } from './Icons';

let mailWs = null;
try { mailWs = require('../services/websocket').default; } catch {}

// ─── SVG Icons ───

function IconMoon({ size = 90 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Defs>
        <LinearGradient id="moonGrad" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#fbbf24" />
          <Stop offset="1" stopColor="#f59e0b" />
        </LinearGradient>
      </Defs>
      <Path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" fill="url(#moonGrad)" />
    </Svg>
  );
}

function IconStar({ size = 12, color = '#fbbf24' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <Path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </Svg>
  );
}

function IconTrophy({ size = 90 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Defs>
        <LinearGradient id="trophyGrad" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#fbbf24" />
          <Stop offset="1" stopColor="#f59e0b" />
        </LinearGradient>
      </Defs>
      <Path d="M8 21h8M12 17v4M17 3H7v4a5 5 0 0010 0V3z" stroke="url(#trophyGrad)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M7 3H4v2a3 3 0 003 3M17 3h3v2a3 3 0 01-3 3" stroke="url(#trophyGrad)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <SvgCircle cx="12" cy="8" r="2" fill="#fbbf24" />
    </Svg>
  );
}

function IconGraduationCap({ size = 24, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 3L1 9l11 6 9-4.91V17h2V9L12 3z" fill={color} />
      <Path d="M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82z" fill={color} opacity={0.85} />
    </Svg>
  );
}

function IconMail({ size = 18, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="2" y="4" width="20" height="16" rx="2" />
      <Path d="M22 4l-10 8L2 4" />
    </Svg>
  );
}

function IconMessageCircle({ size = 18, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
    </Svg>
  );
}

function IconLayout({ size = 18, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <Line x1="3" y1="9" x2="21" y2="9" />
      <Line x1="9" y1="21" x2="9" y2="9" />
    </Svg>
  );
}

function IconFolder({ size = 18, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </Svg>
  );
}

function IconVideo({ size = 18, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Polygon points="23,7 16,12 23,17" fill="none" stroke={color} />
      <Rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </Svg>
  );
}

function IconArrowRight({ size = 20, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Line x1="5" y1="12" x2="19" y2="12" />
      <Path d="M12 5l7 7-7 7" />
    </Svg>
  );
}

function IconBell({ size = 20, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <Path d="M13.73 21a2 2 0 01-3.46 0" />
    </Svg>
  );
}

// ─── Animated Mascot - friendly sleeping character ───
function SleepingMascot() {
  const breathe = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.timing(breathe, { toValue: 1, duration: 2000, useNativeDriver: true }),
      Animated.timing(breathe, { toValue: 0, duration: 2000, useNativeDriver: true }),
    ])).start();
  }, []);
  const scale = breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  return (
    <Animated.View style={{ transform: [{ scale }], alignItems: 'center' }}>
      <IconMoon size={100} />
      <Text style={{ fontSize: 28, marginTop: -10 }}>{'Zzz...'}</Text>
    </Animated.View>
  );
}

// Curtain twinkles — small SVG dots packed behind the curtain area at the
// top of the screen. They fade in/out independently with random delays so
// the curtain feels alive (not a flat panel) without being noisy. Sits
// inside the top 220px region so they read as "starlight behind the curtain"
// rather than scattered across the whole layout.
function CurtainTwinkles() {
  const dots = useRef(
    Array.from({ length: 18 }, (_, i) => ({
      id: i,
      // Position twinkles within the curtain band (top 220px, 0-100% wide).
      x: 4 + Math.random() * 92,
      y: 8 + Math.random() * 180,
      size: 3 + Math.random() * 4,
      opacity: new Animated.Value(0),
    }))
  ).current;
  useEffect(() => {
    const anims = dots.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 90),
          Animated.timing(dot.opacity, { toValue: 0.85, duration: 1100 + Math.random() * 800, useNativeDriver: true }),
          Animated.timing(dot.opacity, { toValue: 0, duration: 1100 + Math.random() * 800, useNativeDriver: true }),
        ])
      )
    );
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, []);
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 220 }}
    >
      {dots.map(dot => (
        <Animated.View
          key={dot.id}
          style={{
            position: 'absolute',
            left: dot.x + '%',
            top: dot.y,
            width: dot.size,
            height: dot.size,
            borderRadius: dot.size / 2,
            backgroundColor: '#fde68a',
            opacity: dot.opacity,
          }}
        />
      ))}
    </View>
  );
}

// Animated stars background for bedtime - with clouds
function StarsField() {
  const stars = useRef(
    Array.from({ length: 25 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 60,
      size: 6 + Math.random() * 12,
      opacity: new Animated.Value(0.2 + Math.random() * 0.5),
    }))
  ).current;

  useEffect(() => {
    const anims = stars.map(star =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(star.opacity, { toValue: 0.1, duration: 2000 + Math.random() * 3000, useNativeDriver: true }),
          Animated.timing(star.opacity, { toValue: 0.8, duration: 2000 + Math.random() * 3000, useNativeDriver: true }),
        ])
      )
    );
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, []);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {stars.map(star => (
        <Animated.View key={star.id} style={{
          position: 'absolute',
          left: `${star.x}%`,
          top: `${star.y}%`,
          opacity: star.opacity,
        }}>
          <IconStar size={star.size} color="#fbbf24" />
        </Animated.View>
      ))}
    </View>
  );
}

// Confetti-like animated dots for graduation
function ConfettiDots() {
  const dots = useRef(
    Array.from({ length: 35 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: 6 + Math.random() * 10,
      color: ['#8b5cf6', '#ec4899', '#fbbf24', '#10b981', '#A78BFA', '#f43f5e', '#06b6d4'][i % 7],
      anim: new Animated.Value(0),
    }))
  ).current;

  useEffect(() => {
    const anims = dots.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 80),
          Animated.timing(dot.anim, { toValue: 1, duration: 1200, useNativeDriver: true }),
          Animated.timing(dot.anim, { toValue: 0, duration: 1200, useNativeDriver: true }),
        ])
      )
    );
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, []);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {dots.map(dot => (
        <Animated.View key={dot.id} style={{
          position: 'absolute',
          left: `${dot.x}%`,
          top: `${dot.y}%`,
          width: dot.size,
          height: dot.size,
          borderRadius: dot.size / 2,
          backgroundColor: dot.color,
          opacity: dot.anim.interpolate({ inputRange: [0, 1], outputRange: [0.15, 0.7] }),
          transform: [{ scale: dot.anim.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1.4] }) }],
        }} />
      ))}
    </View>
  );
}

function isInBedtime(restrictions) {
  if (!restrictions?.bedtime_start || !restrictions?.bedtime_end) return false;
  try {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const current = h * 60 + m;
    const [sh, sm] = restrictions.bedtime_start.split(':').map(Number);
    const [eh, em] = restrictions.bedtime_end.split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (start > end) return current >= start || current < end;
    return current >= start && current < end;
  } catch { return false; }
}

// Calculate minutes remaining until bedtime ends
function minutesUntilEnd(restrictions) {
  if (!restrictions?.bedtime_end) return null;
  try {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const [eh, em] = restrictions.bedtime_end.split(':').map(Number);
    let end = eh * 60 + em;
    let current = h * 60 + m;
    if (end <= current) end += 24 * 60;
    return end - current;
  } catch { return null; }
}

function formatMinsLeft(mins) {
  if (!mins) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

export default function ChildRestrictionGuard({ children }) {
  const [blocked, setBlocked] = useState(null);
  const [graduated, setGraduated] = useState(false);
  const [gradName, setGradName] = useState('');
  const [askParentSent, setAskParentSent] = useState(false);
  const [minsLeft, setMinsLeft] = useState(null);
  const [parentEmail, setParentEmail] = useState(null);
  const router = useRouter();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const bounceAnim = useRef(new Animated.Value(0.8)).current;
  // Curtain pulls down when bedtime activates so the transition feels
  // intentional (not a glitch). Drives Y-translation + opacity together.
  const curtainAnim = useRef(new Animated.Value(0)).current;
  const lastBlockedRef = useRef(null);

  let tFunc;
  try { tFunc = useLanguage().t; } catch { tFunc = (k) => k; }
  const t = tFunc;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
      Animated.spring(bounceAnim, { toValue: 1, tension: 50, friction: 6, useNativeDriver: true }),
    ]).start();
  }, []);

  // Curtain pull-down: only animates on the bedtime ENTER transition. Once
  // we're already in bedtime, the curtain is fully down so a 60s recheck
  // doesn't replay the animation. Reset when blocker clears.
  useEffect(() => {
    if (blocked === 'bedtime' && lastBlockedRef.current !== 'bedtime') {
      curtainAnim.setValue(0);
      Animated.timing(curtainAnim, {
        toValue: 1,
        duration: 700,
        useNativeDriver: true,
      }).start();
    } else if (blocked !== 'bedtime' && lastBlockedRef.current === 'bedtime') {
      curtainAnim.setValue(0);
    }
    lastBlockedRef.current = blocked;
  }, [blocked, curtainAnim]);

  const checkRestrictions = useCallback(async () => {
    if (!isChildAccount()) { setBlocked(null); return; }
    // Refresh restrictions silently — covers the case where parent flipped a
    // toggle while this guard had stale module state.
    try { await refreshChildRestrictions(); } catch {}
    const r = getChildRestrictions();
    if (!r) { setBlocked(null); return; }
    // Track the parent contact (used by the emergency "minha mãe/pai" CTA).
    if (r.parent_email && r.parent_email !== parentEmail) setParentEmail(r.parent_email);
    if (isInBedtime(r)) {
      setBlocked('bedtime');
      // Honor a granted bonus_minutes from parental_screen_time_bonus —
      // backend exposes it on the restrictions blob (`bonus_minutes`). If
      // the bonus is still active we delay the block and shrink the visible
      // remaining time accordingly.
      const bonus = parseInt(r.bonus_minutes || 0, 10) || 0;
      const baseLeft = minutesUntilEnd(r) || 0;
      // Bonus REDUCES the time left until bedtime ends because the parent
      // already granted extra screen time before bedtime should kick in.
      // Negative result means bedtime should not block at all yet.
      const adjusted = baseLeft - bonus;
      if (adjusted <= 0 && bonus > 0) {
        // Bonus still covers the user — let them through.
        setBlocked(null);
        setMinsLeft(null);
        return;
      }
      setMinsLeft(adjusted > 0 ? adjusted : baseLeft);
      return;
    }
    // Screen time limit enforcement
    if (r.daily_limit_minutes && r.daily_limit_minutes > 0) {
      try {
        const api = require('../services/api');
        const res = await api.apiCall('parental_my_status');
        if (res?.success && res?.data?.today_minutes >= r.daily_limit_minutes) {
          setBlocked('screentime');
          setMinsLeft(0);
          return;
        }
      } catch {}
    }
    // Locked switch (parent locked all child screens)
    if (r.locked === true || r.locked === 1 || r.locked === '1') {
      setBlocked('locked');
      return;
    }
    setBlocked(null);
  }, []);

  useEffect(() => {
    checkRestrictions();
    const interval = setInterval(checkRestrictions, 60000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkRestrictions();
    });

    // Listen for graduation event via WebSocket
    let offGrad = null;
    if (mailWs && isChildAccount()) {
      offGrad = mailWs.on('account_graduated', (data) => {
        setGradName(data?.name || '');
        setGraduated(true);
      });
    }

    return () => { clearInterval(interval); sub?.remove(); if (offGrad) offGrad(); };
  }, [checkRestrictions]);

  const handleAskParent = useCallback(async () => {
    // Map current block reason → backend reason. blocked is one of:
    // 'bedtime' | 'screentime' | 'chat_disabled' | 'feed_disabled' | 'calls_disabled' | null
    // Backend (parental.php kids_ask_parent) whitelist é apenas:
    // extra_time | new_contact | new_app | help | other
    // Mapeia todos os blocks pra 'extra_time' (bedtime/screentime = literally more time)
    // ou 'help' (chat/feed/calls disabled — pedido genérico de unlock).
    // Antes mandava bedtime_unlock/chat_unlock/etc → backend retornava 400 e o
    // catch{} engolia silenciosamente — child clicava "Pedir desbloqueio" e
    // parente nunca recebia notificação. Round 57 fix.
    const TYPE_MAP = {
      bedtime:         'extra_time',
      screentime:      'extra_time',
      chat_disabled:   'help',
      feed_disabled:   'help',
      calls_disabled:  'help',
    };
    const askType = TYPE_MAP[blocked] || 'help';
    const reasonNote = blocked ? `unlock:${blocked}` : '';
    try {
      const apiModule = require('../services/api');
      if (apiModule.kidsAskParent) {
        const r = await apiModule.kidsAskParent(askType, reasonNote, { surface: 'app' });
        if (!r?.success) {
          console.warn('[Kids] askParent failed:', r?.message);
        }
      }
    } catch (e) {
      console.warn('[Kids] askParent error:', e?.message || e);
    }
    setAskParentSent(true);
    setTimeout(() => setAskParentSent(false), 5000);
  }, [blocked]);

  // Graduation celebration
  if (graduated) {
    const FEATURES = [
      { label: 'Email completo', Icon: IconMail, color: '#A78BFA' },
      { label: 'Chat sem restricoes', Icon: IconMessageCircle, color: '#10b981' },
      { label: 'Feed e Status', Icon: IconLayout, color: '#ec4899' },
      { label: 'Drive e Documentos', Icon: IconFolder, color: '#f59e0b' },
      { label: 'Lives e Stories', Icon: IconVideo, color: '#8b5cf6' },
    ];

    return (
      <Animated.View style={[sty.graduation, { opacity: fadeAnim }]}>
        <ConfettiDots />
        <Animated.View style={{ alignItems: 'center', zIndex: 1, transform: [{ scale: bounceAnim }] }}>
          <Text style={{ fontSize: 48 }}>{'\uD83C\uDF89'}</Text>
          <IconTrophy size={90} />
          <Text style={sty.gradTitle}>{t('kids.graduated.congrats')}{gradName ? ` ${gradName}` : ''}!</Text>
          <Text style={sty.gradSub}>{t('kids.graduated.turned13')}</Text>
          <View style={sty.gradCard}>
            <Text style={sty.gradText}>{t('kids.graduated.converted')}</Text>
            <View style={{ marginTop: 20, gap: 12 }}>
              {FEATURES.map((item, idx) => (
                <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                  <View style={{ width: 40, height: 40, borderRadius: 14, backgroundColor: item.color + '25', alignItems: 'center', justifyContent: 'center' }}>
                    <item.Icon size={18} color={item.color} />
                  </View>
                  <Text style={sty.gradItem}>{item.label}</Text>
                </View>
              ))}
            </View>
          </View>
          <TouchableOpacity
            style={sty.gradBtn}
            onPress={() => { setGraduated(false); router.replace('/inbox'); }}
            activeOpacity={0.8}
            accessibilityLabel={t('kids.graduated.startUsing')}
            accessibilityRole="button"
          >
            <Text style={sty.gradBtnText}>{t('kids.graduated.startUsing')}</Text>
            <IconArrowRight size={20} color="#fff" />
          </TouchableOpacity>
          <Text style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)', marginTop: 20, textAlign: 'center' }}>
            {t('kids.graduated.useResponsibly')}
          </Text>
        </Animated.View>
      </Animated.View>
    );
  }

  // Screen time limit blocker
  if (blocked === 'screentime') {
    return (
      <Animated.View style={[sty.bedtime, { opacity: fadeAnim, backgroundColor: '#0f172a' }]}>
        <Animated.View style={{ alignItems: 'center', zIndex: 1, transform: [{ scale: bounceAnim }] }}>
          <Text style={{ fontSize: 72, marginBottom: 16 }}>{'\u23F0'}</Text>
          <Text style={[sty.bedTitle, { color: '#f59e0b' }]}>{t('parental.limitReached') || 'Limite de tempo atingido'}</Text>
          <Text style={[sty.bedSub, { color: '#94a3b8' }]}>
            {t('parental.limitReachedDesc') || 'Você usou todo o tempo permitido por hoje. Volte amanha!'}
          </Text>
          <View style={{ marginTop: 24, backgroundColor: '#f59e0b20', borderRadius: 12, paddingHorizontal: 20, paddingVertical: 10 }}>
            <Text style={{ color: '#f59e0b', fontSize: 14, fontWeight: '600', textAlign: 'center' }}>
              {t('parental.limitReachedHint') || 'Faca uma pausa, leia um livro ou brinque ao ar livre!'}
            </Text>
          </View>
          <TouchableOpacity
            style={[sty.askParentBtn, askParentSent && { backgroundColor: '#22c55e' }, { marginTop: 32 }]}
            onPress={handleAskParent}
            disabled={askParentSent}
            activeOpacity={0.8}
          >
            {askParentSent ? (
              <Text style={sty.askParentText}>{t('kids.restriction.askParentSent')}</Text>
            ) : (
              <>
                <Text style={sty.askParentText}>{t('kids.restriction.askParent')}</Text>
              </>
            )}
          </TouchableOpacity>
        </Animated.View>
      </Animated.View>
    );
  }

  // Locked by parent — friendly mascot + ask CTA
  if (blocked === 'locked') {
    return (
      <Animated.View style={[sty.bedtime, { opacity: fadeAnim, backgroundColor: '#1e1b4b' }]}>
        <Animated.View style={{ alignItems: 'center', zIndex: 1, transform: [{ scale: bounceAnim }] }}>
          <View style={{ width: 110, height: 110, borderRadius: 55, backgroundColor: 'rgba(167,139,250,0.18)', alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
            <IconLock size={64} color="#7C3AED" />
          </View>
          <Text style={[sty.bedTitle, { color: '#fff' }]}>
            {t('kids.restriction.locked') || 'App pausado pelos pais'}
          </Text>
          <Text style={[sty.bedSub, { color: '#c4b5fd' }]}>
            {t('kids.restriction.lockedDesc') || 'Volta mais tarde — peça pro seu responsável liberar.'}
          </Text>
          <TouchableOpacity
            style={[sty.askParentBtn, askParentSent && { backgroundColor: '#22c55e' }, { marginTop: 28 }]}
            onPress={handleAskParent}
            disabled={askParentSent}
            activeOpacity={0.8}
          >
            {askParentSent ? (
              <Text style={sty.askParentText}>{t('kids.restriction.askParentSent')}</Text>
            ) : (
              <>
                <IconBell size={18} color="#fff" />
                <Text style={sty.askParentText}>{t('kids.restriction.askParent')}</Text>
              </>
            )}
          </TouchableOpacity>
        </Animated.View>
      </Animated.View>
    );
  }

  // Bedtime blocker - friendly, not scary
  if (blocked === 'bedtime') {
    const r = getChildRestrictions();
    // Curtain top-strip \u2014 translates DOWN from above the screen on enter.
    // 220px is enough to feel like a real "curtain" without dominating the
    // whole layout. Honors `useNativeDriver` for 60fps on low-end Android.
    const curtainY = curtainAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [-220, 0],
    });
    return (
      <Animated.View style={[sty.bedtime, { opacity: fadeAnim }]}>
        <StarsField />
        {/* Twinkles behind the curtain \u2014 small dots fading in/out at random
            offsets, packed into the top 220px so they read as starlight
            beyond the pulled-down curtain. */}
        <CurtainTwinkles />
        {/* Decorative top curtain \u2014 purely visual, sits behind content. */}
        <Animated.View pointerEvents="none" style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, height: 220,
          backgroundColor: 'rgba(15,23,42,0.85)',
          borderBottomLeftRadius: 36, borderBottomRightRadius: 36,
          transform: [{ translateY: curtainY }],
          ...(Platform.OS === 'web' ? { backdropFilter: 'blur(18px)' } : {}),
        }} />
        <Animated.View style={{ alignItems: 'center', zIndex: 1, transform: [{ scale: bounceAnim }] }}>
          <SleepingMascot />
          <Text style={sty.bedTitle}>{t('kids.restriction.bedtime')}</Text>
          {/* "Boa noite!" greet \u2014 appears once curtain settles. */}
          <Animated.Text
            style={[
              { fontSize: 22, fontWeight: '800', color: '#fbbf24', marginTop: 4 },
              { opacity: curtainAnim },
            ]}
          >
            {t('kids.restriction.goodnight') || 'Boa noite!'}
          </Animated.Text>
          <Text style={sty.bedSub}>
            {(t('kids.restriction.blockedUntil') || 'Bloqueado das {start} as {end}')
              .replace('{start}', r?.bedtime_start || '22:00')
              .replace('{end}', r?.bedtime_end || '07:00')
            }
          </Text>

          {/* Time remaining */}
          {minsLeft && (
            <View style={sty.timeLeftBadge}>
              <Text style={sty.timeLeftText}>{t('kids.restriction.timeLeft')}: {formatMinsLeft(minsLeft)}</Text>
            </View>
          )}

          {/* Sweet dreams message */}
          <View style={{ marginTop: 28, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={{ fontSize: 24 }}>{'\u2728'}</Text>
            <Text style={{ fontSize: 20, color: '#fbbf24', fontWeight: '700' }}>
              {t('kids.restriction.sweetDreams')}
            </Text>
            <Text style={{ fontSize: 24 }}>{'\u2728'}</Text>
          </View>

          {/* Bonus 30min CTA \u2014 distinct from the generic "ask parent" so the
              backend can route this as a screen-time bonus request specifically
              (rather than a bedtime unlock). Falls through to the same endpoint. */}
          <TouchableOpacity
            style={[sty.askParentBtn, { backgroundColor: '#fbbf24', marginTop: 14 }]}
            onPress={async () => {
              try {
                const apiModule = require('../services/api');
                if (apiModule.kidsAskParent) {
                  await apiModule.kidsAskParent('bonus_30min', '', { surface: 'app', minutes: 30 });
                }
              } catch {}
              setAskParentSent(true);
              setTimeout(() => setAskParentSent(false), 5000);
            }}
            disabled={askParentSent}
            activeOpacity={0.8}
          >
            <Text style={[sty.askParentText, { color: '#0f172a' }]}>
              {t('kids.restriction.bonus30') || 'Pedir mais 30min'}
            </Text>
          </TouchableOpacity>

          {/* Ask a parent button */}
          <TouchableOpacity
            style={[sty.askParentBtn, askParentSent && { backgroundColor: '#22c55e' }]}
            onPress={handleAskParent}
            disabled={askParentSent}
            activeOpacity={0.8}
            accessibilityLabel={t('kids.restriction.askParent')}
            accessibilityRole="button"
          >
            {askParentSent ? (
              <Text style={sty.askParentText}>{t('kids.restriction.askParentSent')}</Text>
            ) : (
              <>
                <IconBell size={18} color="#fff" />
                <Text style={sty.askParentText}>{t('kids.restriction.askParent')}</Text>
              </>
            )}
          </TouchableOpacity>

          {/* Emergency direct-chat link \u2014 opens a 1:1 with the registered
              parent. We do NOT reveal a phone number; we route via the
              existing chat-conversation deep link with parent_email. */}
          {parentEmail ? (
            <TouchableOpacity
              onPress={() => {
                try {
                  router.push(`/chat-new?email=${encodeURIComponent(parentEmail)}&urgent=1`);
                } catch {}
              }}
              hitSlop={6}
              style={{ marginTop: 14 }}
              accessibilityRole="link"
            >
              <Text style={{ color: '#a5b4fc', fontSize: 14, textDecorationLine: 'underline' }}>
                {t('kids.restriction.contactParent') || 'Falar com minha m\u00e3e/pai'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </Animated.View>
      </Animated.View>
    );
  }

  return children;
}

const sty = StyleSheet.create({
  bedtime: {
    flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40,
    backgroundColor: '#0f172a',
    ...(Platform.OS === 'web' ? { background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 40%, #312e81 70%, #1e1b4b 100%)' } : {}),
  },
  bedTitle: { fontSize: 34, fontWeight: '800', color: '#fff', marginTop: 16, marginBottom: 12 },
  bedSub: { fontSize: 18, color: '#94a3b8', textAlign: 'center', fontWeight: '600', lineHeight: 26 },
  timeLeftBadge: {
    marginTop: 20, backgroundColor: 'rgba(99,102,241,0.2)',
    paddingHorizontal: 20, paddingVertical: 10, borderRadius: 16,
    borderWidth: 1, borderColor: 'rgba(99,102,241,0.3)',
  },
  timeLeftText: { fontSize: 16, color: '#a5b4fc', fontWeight: '700' },
  askParentBtn: {
    marginTop: 28, backgroundColor: '#6366f1',
    paddingHorizontal: 28, paddingVertical: 16, borderRadius: 20,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    minHeight: 56, minWidth: 200, justifyContent: 'center',
    ...(Platform.OS === 'web' ? { boxShadow: '0 6px 24px rgba(99,102,241,0.4)' } : {}),
  },
  askParentText: { color: '#fff', fontSize: 17, fontWeight: '700' },

  graduation: {
    flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32,
    backgroundColor: '#0f0720',
    ...(Platform.OS === 'web' ? { background: 'linear-gradient(135deg, #0f0720 0%, #1e1145 40%, #3b1d6e 70%, #4c1d95 100%)' } : {}),
  },
  gradTitle: { fontSize: 34, fontWeight: '800', color: '#fff', marginTop: 12, marginBottom: 4 },
  gradSub: { fontSize: 22, color: '#a78bfa', marginBottom: 24, fontWeight: '700' },
  gradCard: {
    backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 24, padding: 28, width: '100%', maxWidth: 360,
    borderWidth: 1, borderColor: 'rgba(139,92,246,0.25)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(10px)' } : {}),
  },
  gradText: { fontSize: 16, color: '#e9d5ff', lineHeight: 24, textAlign: 'center' },
  gradItem: { fontSize: 17, color: '#fff', fontWeight: '600' },
  gradBtn: {
    marginTop: 28, backgroundColor: '#8b5cf6', paddingHorizontal: 36, paddingVertical: 16, borderRadius: 20,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    minHeight: 56,
    ...(Platform.OS === 'web' ? { boxShadow: '0 6px 24px rgba(139,92,246,0.5)' } : {}),
  },
  gradBtnText: { color: '#fff', fontSize: 19, fontWeight: '800' },
});
