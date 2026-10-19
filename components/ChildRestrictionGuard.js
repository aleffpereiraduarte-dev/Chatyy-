/**
 * ChildRestrictionGuard -- aplica o controle parental no aparelho da CRIANÇA.
 *
 * [parental-tempo 2026-10-19]
 *  - Tempo real: escuta os eventos WS `parental_lock_changed` (Pausar/Retomar do painel) e
 *    `parental_extra_time` (+15 min) e reage NA HORA; re-checa ao voltar p/ 1º plano
 *    (parental_my_status + heartbeat 0).
 *  - Tempo de tela REAL: soma o tempo em 1º plano (sem contar tela de bloqueio) e manda
 *    `parental_screen_heartbeat {minutes}` em lotes de ~60 s; a resposta traz minutos de hoje,
 *    bônus, janela de graça e pausa → o limite diário é aplicado AQUI (tela de bloqueio até
 *    o bônus ou o dia seguinte).
 *  - Modo noturno (bedtime_start/end) bloqueia igual; o +15 min abre uma janela de graça que
 *    libera também o modo noturno por aqueles minutos.
 *  - Tela de bloqueio única em preto e branco (pausado / limite / noturno) c/ "Pedir mais tempo"
 *    (parental_unlock_request → caixa de Pedidos do responsável + push).
 * Mantém a comemoração de "graduação" (13 anos) como estava.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, Platform, AppState, TouchableOpacity, Animated, Easing, ActivityIndicator } from 'react-native';
import Svg, { Path, Circle as SvgCircle, Line, Rect, G, Polygon, Defs, LinearGradient, Stop } from 'react-native-svg';
import { isChildAccount, getChildRestrictions, refreshChildRestrictions, getChildScreenStatus } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useRouter } from 'expo-router';
import { IconParty } from './Icons';

let mailWs = null;
try { mailWs = require('../services/websocket').default; } catch {}

const TICK_MS = 20000;          // avalia limite/noturno/graça e acumula tempo em 1º plano
const BATCH_MS = 60000;         // heartbeat em lotes de 1 min
const MAX_PENDING_MS = 10 * 60000; // offline: guarda no máx. 10 min p/ mandar depois
const WS_LOCK_TRUST_MS = 8000;  // depois de um evento WS, ignora estado de pausa vindo de leitura atrasada (réplica)

// ─── SVG Icons (graduação) ───

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


// Confetti-like animated dots for graduation
function ConfettiDots() {
  const dots = useRef(
    Array.from({ length: 35 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: 6 + Math.random() * 10,
      color: ['#111111', '#111111', '#fbbf24', '#10b981', '#111111', '#f43f5e', '#06b6d4'][i % 7],
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

function truthy(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

function formatMins(mins) {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h > 0) return r > 0 ? `${h} h ${r} min` : `${h} h`;
  return `${r} min`;
}

// ─── Glifos P&B da tela de bloqueio (traço, sem cor) ───
function GlyphPause({ size = 40, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="6.5" y="5" width="3.6" height="14" rx="1.6" fill={color} />
      <Rect x="13.9" y="5" width="3.6" height="14" rx="1.6" fill={color} />
    </Svg>
  );
}
function GlyphHourglass({ size = 40, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M6 3h12M6 21h12" />
      <Path d="M7 3c0 4.2 3.2 6 5 9-1.8 3-5 4.8-5 9M17 3c0 4.2-3.2 6-5 9 1.8 3 5 4.8 5 9" />
      <Path d="M9.2 18.6h5.6L12 15.6z" fill={color} stroke="none" />
    </Svg>
  );
}
function GlyphMoon({ size = 40, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20.5 14.2A8.5 8.5 0 119.8 3.5a6.8 6.8 0 0010.7 10.7z" />
      <Path d="M17 4.2v2.6M15.7 5.5h2.6" />
    </Svg>
  );
}
function GlyphClockPlus({ size = 18, color = '#000' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20.8 12.9A8.8 8.8 0 1111.1 3.2" />
      <Path d="M12 7.5V12l3 1.8" />
      <Path d="M19 3v5M16.5 5.5h5" />
    </Svg>
  );
}
function GlyphCheck({ size = 18, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M5 12.5l4.2 4.2L19 7" />
    </Svg>
  );
}

// Halo de anéis concêntricos que "respiram" — dá vida à tela sem cor nenhuma.
function BreathingHalo({ children }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(a, { toValue: 1, duration: 2600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(a, { toValue: 0, duration: 2600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [a]);
  const ring = (k) => ({
    transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [1, 1 + 0.06 * k] }) }],
    opacity: a.interpolate({ inputRange: [0, 1], outputRange: [0.22 / k, 0.1 / k] }),
  });
  return (
    <View style={lk.haloWrap} pointerEvents="none">
      <Animated.View style={[lk.ring, lk.ring3, ring(3)]} />
      <Animated.View style={[lk.ring, lk.ring2, ring(2)]} />
      <Animated.View style={[lk.ring, lk.ring1, ring(1)]} />
      <View style={lk.core}>{children}</View>
    </View>
  );
}

/**
 * Tela cheia preto e branco. variant: 'locked' | 'screentime' | 'bedtime'.
 * askState: 'idle' | 'sending' | 'sent' | 'wait' | 'fail'.
 */
function KidLockScreen({ variant, tr, info, askState, onAsk }) {
  const fade = useRef(new Animated.Value(0)).current;
  const rise = useRef(new Animated.Value(14)).current;
  useEffect(() => {
    fade.setValue(0); rise.setValue(14);
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(rise, { toValue: 0, duration: 520, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [variant, fade, rise]);

  const copy = {
    locked: {
      eyebrow: tr('kidsLock.eyebrowPaused', 'Pausado'),
      title: tr('kidsLock.pausedTitle', 'App pausado pelo responsável'),
      desc: tr('kidsLock.pausedDesc', 'Seu responsável pausou o Chatyy por enquanto. Quando ele retomar, tudo volta sozinho.'),
      Glyph: GlyphPause,
    },
    screentime: {
      eyebrow: tr('kidsLock.eyebrowLimit', 'Limite diário'),
      title: tr('kidsLock.limitTitle', 'O tempo de hoje acabou'),
      desc: tr('kidsLock.limitDesc', 'Você usou todo o tempo combinado para hoje. Amanhã tem mais, ou peça mais tempo ao seu responsável.'),
      Glyph: GlyphHourglass,
    },
    bedtime: {
      eyebrow: tr('kidsLock.eyebrowBedtime', 'Modo noturno'),
      title: tr('kidsLock.bedtimeTitle', 'Hora de descansar'),
      desc: tr('kidsLock.bedtimeDesc', 'O Chatyy fica em modo noturno das {start} às {end}.')
        .replace('{start}', info?.bedtimeStart || '--:--').replace('{end}', info?.bedtimeEnd || '--:--'),
      Glyph: GlyphMoon,
    },
  }[variant] || null;
  if (!copy) return null;
  const { Glyph } = copy;

  let meta = '';
  if (variant === 'screentime' && info?.limit > 0) {
    meta = tr('kidsLock.usedOfLimit', 'Hoje: {used} de {limit}')
      .replace('{used}', formatMins(info.used)).replace('{limit}', formatMins(info.limit + (info.bonus || 0)));
  } else if (variant === 'bedtime' && info?.bedtimeEnd) {
    meta = tr('kidsLock.backAt', 'Volta às {time}').replace('{time}', info.bedtimeEnd);
  } else if (variant === 'locked') {
    meta = tr('kidsLock.resumeHint', 'Libera sozinho assim que seu responsável retomar');
  }

  const sent = askState === 'sent' || askState === 'wait';
  const btnLabel = askState === 'sending' ? ''
    : sent ? (askState === 'wait' ? tr('kidsLock.askWait', 'Pedido já enviado') : tr('kidsLock.askSent', 'Pedido enviado'))
    : tr('kidsLock.askMore', 'Pedir mais tempo');

  return (
    <View style={lk.root} accessibilityViewIsModal>
      <Animated.View style={[lk.content, { opacity: fade, transform: [{ translateY: rise }] }]}>
        <View style={lk.eyebrow}>
          <View style={lk.eyebrowDot} />
          <Text style={lk.eyebrowText}>{copy.eyebrow}</Text>
        </View>
        <BreathingHalo><Glyph size={44} color="#fff" /></BreathingHalo>
        <Text style={lk.title} accessibilityRole="header">{copy.title}</Text>
        <Text style={lk.desc}>{copy.desc}</Text>
        {meta ? (
          <View style={lk.metaPill}><Text style={lk.metaText}>{meta}</Text></View>
        ) : null}
        <TouchableOpacity
          style={[lk.btn, sent && lk.btnSent]}
          onPress={onAsk}
          disabled={askState === 'sending' || sent}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={btnLabel || tr('kidsLock.askMore', 'Pedir mais tempo')}
          accessibilityState={{ disabled: askState === 'sending' || sent, busy: askState === 'sending' }}
        >
          {askState === 'sending' ? <ActivityIndicator color="#000" />
            : sent ? <GlyphCheck size={18} color="#fff" />
            : <GlyphClockPlus size={18} color="#000" />}
          {btnLabel ? <Text style={[lk.btnText, sent && lk.btnTextSent]}>{btnLabel}</Text> : null}
        </TouchableOpacity>
        <Text style={lk.caption}>
          {sent ? tr('kidsLock.askSentDesc', 'Avisamos seu responsável. Se ele liberar, o app volta na hora.')
            : askState === 'fail' ? tr('kidsLock.askFail', 'Não deu para enviar agora. Tente de novo.')
            : ' '}
        </Text>
      </Animated.View>
    </View>
  );
}

export default function ChildRestrictionGuard({ children }) {
  const [blocked, setBlocked] = useState(null); // null | 'locked' | 'screentime' | 'bedtime'
  const [graduated, setGraduated] = useState(false);
  const [gradName, setGradName] = useState('');
  const [askState, setAskState] = useState('idle');
  const [info, setInfo] = useState(null);
  const router = useRouter();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const bounceAnim = useRef(new Animated.Value(0.8)).current;

  // Estado vivo em refs (lido pelo tick / handlers WS sem re-render)
  const screenRef = useRef(null);           // { minutes, bonus, limit } do servidor
  const lockedRef = useRef(null);           // true/false conhecido (null = usa restrições)
  const wsLockAtRef = useRef(0);            // quando chegou o último parental_lock_changed
  const graceUntilRef = useRef(0);          // ms (relógio do aparelho) até quando o bônus libera o noturno
  const accMsRef = useRef(0);               // tempo em 1º plano ainda não enviado
  const activeSinceRef = useRef(null);      // início do trecho atual em 1º plano (desbloqueado)
  const sendingRef = useRef(false);
  const notChildRef = useRef(false);        // servidor disse "não é filho" → para heartbeats
  const blockedRef = useRef(null);
  const askSentAtRef = useRef(0);
  const lastFlushAtRef = useRef(0);         // último heartbeat enviado (bloqueado → sonda a cada ~60 s)

  let tFunc;
  try { tFunc = useLanguage().t; } catch { tFunc = (k) => k; }
  const t = tFunc;
  const tr = useCallback((key, fallback) => {
    try { const v = t(key); return (v && v !== key) ? v : fallback; } catch { return fallback; }
  }, [t]);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
      Animated.spring(bounceAnim, { toValue: 1, tension: 50, friction: 6, useNativeDriver: true }),
    ]).start();
  }, []);

  const applyServer = useCallback((s) => {
    if (!s || typeof s !== 'object') return;
    screenRef.current = {
      minutes: Math.max(0, Number(s.minutes_today ?? s.today_minutes) || 0),
      bonus: Math.max(0, Number(s.bonus_today) || 0),
      limit: Math.max(0, Number(s.daily_limit_minutes) || 0),
    };
    const g = Number(s.grace_left_s) || 0;
    if (g > 0) graceUntilRef.current = Math.max(graceUntilRef.current, Date.now() + g * 1000);
    if (s.locked !== undefined && Date.now() - wsLockAtRef.current > WS_LOCK_TRUST_MS) {
      lockedRef.current = truthy(s.locked);
    }
  }, []);

  // Decide a tela. Prioridade: pausa > modo noturno (sem graça) > limite diário.
  const evaluate = useCallback(() => {
    if (!isChildAccount()) {
      if (blockedRef.current !== null) { blockedRef.current = null; setBlocked(null); }
      return;
    }
    const r = getChildRestrictions() || {};
    const now = Date.now();
    const locked = lockedRef.current !== null ? lockedRef.current : truthy(r.locked);
    const graceActive = graceUntilRef.current > now;
    const sc = screenRef.current;
    const limit = sc ? sc.limit : (Number(r.daily_limit_minutes) || 0);
    const pendingMs = accMsRef.current + (activeSinceRef.current && !blockedRef.current ? now - activeSinceRef.current : 0);
    const used = (sc ? sc.minutes : 0) + Math.floor(pendingMs / 60000);
    const bonus = sc ? sc.bonus : 0;
    let next = null;
    if (locked) next = 'locked';
    else if (isInBedtime(r) && !graceActive) next = 'bedtime';
    else if (sc && limit > 0 && used >= limit + bonus) next = 'screentime';
    // Só re-renderiza com info nova quando há tela de bloqueio (o app normal não precisa).
    if (next) setInfo({ used, limit, bonus, bedtimeStart: r.bedtime_start || '', bedtimeEnd: r.bedtime_end || '' });
    if (next !== blockedRef.current) {
      // Ao bloquear, fecha o trecho em 1º plano (tela de bloqueio não conta como uso).
      if (next && activeSinceRef.current && !blockedRef.current) {
        accMsRef.current = Math.min(MAX_PENDING_MS, accMsRef.current + (now - activeSinceRef.current));
      }
      if (activeSinceRef.current) activeSinceRef.current = now;
      blockedRef.current = next;
      setBlocked(next);
      if (!next || Date.now() - askSentAtRef.current > 5 * 60000) setAskState('idle');
    }
  }, []);

  // Fecha o trecho atual em 1º plano dentro do acumulador.
  const settle = useCallback(() => {
    const now = Date.now();
    if (activeSinceRef.current && !blockedRef.current) {
      accMsRef.current = Math.min(MAX_PENDING_MS, accMsRef.current + (now - activeSinceRef.current));
    }
    if (activeSinceRef.current) activeSinceRef.current = now;
  }, []);

  // Manda os minutos inteiros acumulados (force = manda mesmo com 0 → só consulta o estado).
  const flush = useCallback(async (force = false) => {
    if (!isChildAccount() || notChildRef.current || sendingRef.current) return;
    const minutes = Math.min(10, Math.floor(accMsRef.current / 60000));
    if (minutes <= 0 && !force) return;
    sendingRef.current = true;
    lastFlushAtRef.current = Date.now();
    accMsRef.current -= minutes * 60000;
    let ok = false;
    try {
      const api = require('../services/api');
      if (typeof api.parentalScreenHeartbeat === 'function') {
        const res = await api.parentalScreenHeartbeat(minutes);
        if (res?.success && res?.data) { applyServer(res.data); ok = true; }
        else if (res?.data?.reason === 'not_a_child' || res?.message === 'not_a_child') { notChildRef.current = true; ok = true; }
      }
    } catch {}
    if (!ok) accMsRef.current = Math.min(MAX_PENDING_MS, accMsRef.current + minutes * 60000);
    sendingRef.current = false;
    evaluate();
  }, [applyServer, evaluate]);

  // Re-checagem completa (montagem / volta p/ 1º plano): restrições + estado de tempo.
  const recheck = useCallback(async () => {
    try { await refreshChildRestrictions(); } catch {}
    if (!isChildAccount()) { evaluate(); return; }
    notChildRef.current = false;
    if (Date.now() - wsLockAtRef.current > WS_LOCK_TRUST_MS) lockedRef.current = null;
    try { applyServer(getChildScreenStatus()); } catch {}
    evaluate();
    settle();
    flush(true);
  }, [applyServer, evaluate, settle, flush]);

  useEffect(() => {
    if (AppState.currentState === 'active') activeSinceRef.current = Date.now();
    recheck();
    const interval = setInterval(() => {
      if (!isChildAccount()) return;
      if (AppState.currentState !== 'active') return;
      settle();
      evaluate();
      if (accMsRef.current >= BATCH_MS) flush(false);
      // Bloqueado: sonda o estado a cada ~60 s (caso o evento WS de Retomar/+15 min se perca).
      else if (blockedRef.current && Date.now() - lastFlushAtRef.current >= BATCH_MS) flush(true);
    }, TICK_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        activeSinceRef.current = Date.now();
        recheck();
      } else {
        settle();
        activeSinceRef.current = null;
        if (accMsRef.current >= BATCH_MS) flush(false);
      }
    });

    const offs = [];
    if (mailWs && typeof mailWs.on === 'function') {
      offs.push(mailWs.on('account_graduated', (data) => {
        if (!isChildAccount()) return;
        setGradName(data?.name || '');
        setGraduated(true);
      }));
      // Pausar / Retomar do painel → reage na hora.
      offs.push(mailWs.on('parental_lock_changed', (data) => {
        if (!isChildAccount()) return;
        settle();
        wsLockAtRef.current = Date.now();
        lockedRef.current = truthy(data?.locked);
        evaluate();
        refreshChildRestrictions().catch(() => {}).finally(() => evaluate());
      }));
      // +15 min → soma no orçamento de hoje e abre a janela de graça (libera também o noturno).
      offs.push(mailWs.on('parental_extra_time', (data) => {
        if (!isChildAccount()) return;
        settle();
        const added = Math.max(0, Number(data?.minutes_added) || 0);
        const totalRaw = data?.bonus_today ?? data?.minutes_today_total;
        const sc = screenRef.current || { minutes: 0, bonus: 0, limit: Number(getChildRestrictions()?.daily_limit_minutes) || 0 };
        const total = Number(totalRaw);
        sc.bonus = Number.isFinite(total) && total > 0 ? Math.max(sc.bonus, total) : sc.bonus + added;
        screenRef.current = sc;
        const g = Number(data?.grace_left_s) || added * 60;
        if (g > 0) graceUntilRef.current = Math.max(graceUntilRef.current, Date.now() + g * 1000);
        evaluate();
        flush(true);
      }));
    }
    return () => { clearInterval(interval); sub?.remove(); offs.forEach(off => { try { off && off(); } catch {} }); };
  }, [recheck, settle, evaluate, flush]);

  // Fim da janela de graça / início do noturno sem esperar o próximo tick.
  useEffect(() => {
    const left = graceUntilRef.current - Date.now();
    if (left <= 0 || left > 6 * 3600000) return undefined;
    const id = setTimeout(() => evaluate(), left + 500);
    return () => clearTimeout(id);
  }, [blocked, info?.bonus, evaluate]);

  const handleAsk = useCallback(async () => {
    const variant = blockedRef.current;
    setAskState('sending');
    let next = 'fail';
    try {
      const apiModule = require('../services/api');
      if (apiModule.kidsAskParent) {
        // parental_unlock_request: 'bedtime' = usar fora do horário; demais = mais tempo de tela.
        const type = variant === 'bedtime' ? 'bedtime_unlock' : 'extra_time';
        const r = await apiModule.kidsAskParent(type, '', { surface: '', extra_minutes: 15 });
        if (r?.success) next = r?.data?.rate_limited ? 'wait' : 'sent';
      }
    } catch {}
    if (next !== 'fail') askSentAtRef.current = Date.now();
    setAskState(next);
  }, []);

  // Graduation celebration
  if (graduated) {
    const FEATURES = [
      { label: 'kidsGuard.featEmail', Icon: IconMail, color: '#111111' },
      { label: 'kidsGuard.featChat', Icon: IconMessageCircle, color: '#10b981' },
      { label: 'kidsGuard.featFeed', Icon: IconLayout, color: '#111111' },
      { label: 'kidsGuard.featDrive', Icon: IconFolder, color: '#f59e0b' },
      { label: 'kidsGuard.featLives', Icon: IconVideo, color: '#111111' },
    ];

    return (
      <Animated.View style={[sty.graduation, { opacity: fadeAnim }]}>
        <ConfettiDots />
        <Animated.View style={{ alignItems: 'center', zIndex: 1, transform: [{ scale: bounceAnim }] }}>
          <IconParty size={44} color="#fbbf24" />
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
                  <Text style={sty.gradItem}>{t(item.label)}</Text>
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

  if (blocked) {
    return <KidLockScreen variant={blocked} tr={tr} info={info} askState={askState} onAsk={handleAsk} />;
  }

  return children;
}

const lk = StyleSheet.create({
  root: {
    flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 28, paddingVertical: 48,
  },
  content: { width: '100%', maxWidth: 380, alignItems: 'center' },
  eyebrow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth * 2, borderColor: 'rgba(255,255,255,0.28)',
    marginBottom: 40,
  },
  eyebrowDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  eyebrowText: { color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 1.6, textTransform: 'uppercase' },
  haloWrap: { width: 200, height: 200, alignItems: 'center', justifyContent: 'center', marginBottom: 36 },
  ring: { position: 'absolute', borderRadius: 999, borderWidth: 1, borderColor: '#fff' },
  ring1: { width: 132, height: 132 },
  ring2: { width: 166, height: 166 },
  ring3: { width: 200, height: 200 },
  core: {
    width: 100, height: 100, borderRadius: 50, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#111', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
  },
  title: {
    color: '#fff', fontSize: 30, lineHeight: 36, fontWeight: '800', textAlign: 'center',
    letterSpacing: -0.6, marginBottom: 12,
  },
  desc: { color: 'rgba(255,255,255,0.64)', fontSize: 16, lineHeight: 23, textAlign: 'center', maxWidth: 330 },
  metaPill: {
    marginTop: 22, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  metaText: { color: 'rgba(255,255,255,0.86)', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  btn: {
    marginTop: 40, minHeight: 56, minWidth: 240, paddingHorizontal: 28, borderRadius: 999,
    backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
  },
  btnSent: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.5)' },
  btnText: { color: '#000', fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
  btnTextSent: { color: '#fff' },
  caption: { marginTop: 14, minHeight: 40, color: 'rgba(255,255,255,0.5)', fontSize: 13, lineHeight: 19, textAlign: 'center', maxWidth: 300 },
});

const sty = StyleSheet.create({
  graduation: {
    flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32,
    backgroundColor: '#0f0720',
    ...(Platform.OS === 'web' ? { background: 'linear-gradient(135deg, #0f0720 0%, #161618 40%, #161618 70%, #111111 100%)' } : {}),
  },
  gradTitle: { fontSize: 34, fontWeight: '800', color: '#fff', marginTop: 12, marginBottom: 4 },
  gradSub: { fontSize: 22, color: '#E5E5EA', marginBottom: 24, fontWeight: '700' },
  gradCard: {
    backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 24, padding: 28, width: '100%', maxWidth: 360,
    borderWidth: 1, borderColor: 'rgba(17, 17, 17,0.25)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(10px)' } : {}),
  },
  gradText: { fontSize: 16, color: '#F1F3F5', lineHeight: 24, textAlign: 'center' },
  gradItem: { fontSize: 17, color: '#fff', fontWeight: '600' },
  gradBtn: {
    marginTop: 28, backgroundColor: '#111111', paddingHorizontal: 36, paddingVertical: 16, borderRadius: 20,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    minHeight: 56,
    ...(Platform.OS === 'web' ? { boxShadow: '0 6px 24px rgba(17, 17, 17,0.5)' } : {}),
  },
  gradBtnText: { color: '#fff', fontSize: 19, fontWeight: '800' },
});
