// components/chat/useVanishMode.js — [vanish 2026-10-19] Modo temporário estilo
// Instagram Vanish Mode, na MESMA conversa (não abre outro tipo de chat).
//   const vm = useVanishMode({ conversationId, conversationType, vanishMode, setVanishMode, t, getLastReadId, onPurged, hasVanishMsgs, isFocused });
//   vm.eligible → conversa 1:1 + kill switch globalThis.__chatyy_vanish !== false
//   <VanishSwipeArea …> envolve a lista: arrastar p/ cima no fim da conversa liga/desliga.
// Enquanto ligado: tema escuro (VanishThemeScope, fora da tela), Android FLAG_SECURE,
// iOS escudo na gravação + aviso de print na conversa. Ao sair da conversa (ou o app
// ir para o fundo) o servidor apaga p/ os dois as mensagens temporárias já vistas.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Animated, Platform, StyleSheet, AppState } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import Svg, { Circle } from 'react-native-svg';
import { ForceDarkTheme } from '../../context/ThemeContext';
import {
  vanishGateOn, setVanishActive, useVanishActive, purgeVanishLocal, vanishSeenClose, rememberVanish,
} from '../../services/vanishMode';
import { acquireCaptureProtection, addScreenshotListener, sendScreenshotNotice, canDetectBlockedCapture, showCaptureBlockedNotice } from '../../services/chatPrivacy';
import { secureViewAvailable } from '../../services/captureBlock'; // [2026-10-19 secure-view]

function _tt(t, key, fb) {
  try {
    const v = typeof t === 'function' ? t(key) : '';
    return typeof v === 'string' && v && v !== key ? v : fb;
  } catch { return fb; }
}

function _realCid(cid) {
  const n = Number(cid);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Ícone do modo temporário (círculo tracejado) — SVG, sem emoji. */
export function IconVanish({ size = 18, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="9" stroke={color} strokeWidth="2" strokeDasharray="3 3" strokeLinecap="round" />
      <Circle cx="12" cy="12" r="3" fill={color} />
    </Svg>
  );
}

/**
 * Envolve a tela da conversa (FORA do componente que chama useTheme) e força
 * o tema escuro enquanto o modo temporário dessa conversa está ligado.
 */
export function VanishThemeScope({ children }) {
  let cid = '';
  try { const p = useLocalSearchParams(); cid = String((p && p.id) || ''); } catch {}
  const on = useVanishActive(cid);
  return <ForceDarkTheme active={on && vanishGateOn()}>{children}</ForceDarkTheme>;
}

export default function useVanishMode({
  conversationId, conversationType, vanishMode, setVanishMode, t,
  getLastReadId, onPurged, isFocused, hasVanishMsgs,
}) {
  const cid = _realCid(conversationId);
  const gate = vanishGateOn();
  const eligible = gate && !!cid && conversationType === 'direct';
  const active = eligible && !!vanishMode;
  // Por conversa (Set de cids): a tela pode trocar de id no lugar (setParams) e o
  // flush da conversa anterior roda na limpeza do efeito, depois do novo render.
  const visitedOnRef = useRef(null);
  if (!visitedOnRef.current) visitedOnRef.current = new Set();
  if (active && cid) visitedOnRef.current.add(cid);
  const cbRef = useRef({ getLastReadId, onPurged, hasVanishMsgs });
  cbRef.current = { getLastReadId, onPurged, hasVanishMsgs };

  // Tema escuro (escopo fora da tela) segue o estado.
  useEffect(() => {
    if (!cid) return undefined;
    setVanishActive(cid, active);
    // [2026-10-22 vanish-lembra] guarda no aparelho → próxima abertura já nasce escura.
    if (eligible) rememberVanish(cid, active);
    return undefined;
  }, [cid, active, eligible]);
  useEffect(() => () => { if (cid) setVanishActive(cid, false); }, [cid]);

  // Ao vivo: o outro lado ligou/desligou.
  useEffect(() => {
    if (!cid || !gate) return undefined;
    let off = null;
    try {
      const ws = require('../../services/websocket').default;
      off = ws && ws.on && ws.on('conversation_vanish', (d) => {
        if (!d || String(d.conversation_id) !== String(cid)) return;
        const v = d.enabled ?? d.vanish_mode;
        if (typeof v === 'boolean') { try { setVanishMode(v); } catch {} }
        if (Array.isArray(d.purged) && d.purged.length) {
          try { purgeVanishLocal(cid, d.purged); } catch {} // caches locais também (não só a tela)
          try { cbRef.current.onPurged && cbRef.current.onPurged(d.purged); } catch {}
        }
      });
    } catch {}
    return () => { try { off && off(); } catch {} };
  }, [cid, gate, setVanishMode]);

  // Proteção de captura enquanto ligado e com a conversa em foco.
  const focused = isFocused !== false;
  useEffect(() => {
    if (!active || !focused || Platform.OS === 'web') return undefined;
    const release = acquireCaptureProtection(`chatyy-vanish-conv-${cid}`, {
      labels: {
        title: _tt(t, 'vanish.protectedTitle', 'Modo temporário'),
        subtitle: _tt(t, 'advPriv.protectedRecording', 'A gravação ou o espelhamento de tela está ativo.'),
      },
      secureView: true, // [2026-10-19 secure-view] iOS: <ChatyySecureView> na conversa
    });
    let sub = null;
    if (Platform.OS === 'ios') sub = addScreenshotListener(() => sendScreenshotNotice(cid, { kind: 'screenshot', blocked: secureViewAvailable(), scope: 'vanish' }));
    else if (canDetectBlockedCapture()) {
      // [2026-10-22 print-local] Android 14+: tentativa detectada (print preto).
      sub = addScreenshotListener(() => {
        showCaptureBlockedNotice(t, { notified: true });
        sendScreenshotNotice(cid, { kind: 'screenshot', blocked: true, scope: 'vanish' });
      });
    }
    return () => {
      try { release && release(); } catch {}
      try { sub && sub.remove(); } catch {}
    };
  }, [active, focused, cid, t]);

  // Saiu da conversa / app foi para o fundo → somem as já vistas.
  const flush = useCallback(async () => {
    if (!cid || !gate) return;
    let pending = !!(visitedOnRef.current && visitedOnRef.current.has(cid));
    if (!pending) { try { pending = !!(cbRef.current.hasVanishMsgs && cbRef.current.hasVanishMsgs()); } catch {} }
    if (!pending) return;
    let lr = 0;
    try { lr = Number(cbRef.current.getLastReadId && cbRef.current.getLastReadId()) || 0; } catch {}
    const ids = await vanishSeenClose(cid, lr);
    if (ids.length) {
      purgeVanishLocal(cid, ids);
      try { cbRef.current.onPurged && cbRef.current.onPurged(ids); } catch {}
    }
  }, [cid, gate]);
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    if (!cid || !gate) return undefined;
    let sub = null;
    // flush DESTA conversa (flushRef.current na limpeza já seria o do id novo).
    const flushThis = flush;
    try {
      sub = AppState.addEventListener('change', (s) => { if (s === 'background') flushRef.current(); });
    } catch {}
    return () => {
      try { sub && sub.remove && sub.remove(); } catch {}
      flushThis();
    };
  }, [cid, gate]);

  const rowTitle = _tt(t, 'vanish.rowTitle', 'Modo temporário');
  const rowValue = active ? _tt(t, 'vanish.stateOn', 'Ativado') : _tt(t, 'vanish.stateOff', 'Desativado');
  return { eligible, active, rowTitle, rowValue };
}

// [2026-10-19 vanish-forte] founder: entrava sem querer → zona morta 40 px, curso
// 190 px e o gesto precisa durar ≥ 350 ms (rolagem rápida não arma).
const DEAD = 40;
const THRESH = 190;
const MIN_MS = 350;

/**
 * Área da lista com o gesto "arrastar para cima no fim da conversa".
 * Usa só eventos de toque crus (onTouch*) — não disputa o responder nem a
 * rolagem nativa. Só arma quando a lista está no fim (isAtBottom()).
 */
export function VanishSwipeArea({ enabled, active, onActivate, isAtBottom, t, isDark, style, children }) {
  const startRef = useRef(null);
  const phaseRef = useRef(0);
  const [phase, setPhase] = useState(0); // 0 escondido · 1 arrastando · 2 solte
  const prog = useRef(new Animated.Value(0)).current;

  const setPh = (p) => {
    if (phaseRef.current === p) return;
    phaseRef.current = p;
    setPhase(p);
    if (p === 2) { try { require('../../services/haptics').selection(); /* [2026-10-20 ux] shim respeita a preferência de vibração */ } catch {} }
  };
  const reset = () => {
    startRef.current = null;
    try { prog.setValue(0); } catch {}
    setPh(0);
  };

  const onTouchStart = (e) => {
    if (!enabled) return;
    const n = e && e.nativeEvent;
    if (!n || (n.touches && n.touches.length > 1)) { startRef.current = null; return; }
    let ok = false;
    try { ok = !!(isAtBottom && isAtBottom()); } catch {}
    startRef.current = ok ? { x: n.pageX, y: n.pageY, t: Date.now() } : null;
  };
  const onTouchMove = (e) => {
    const s = startRef.current;
    if (!s) return;
    const n = e && e.nativeEvent;
    if (!n || (n.touches && n.touches.length > 1)) { reset(); return; }
    const dy = s.y - n.pageY;
    const dx = Math.abs(n.pageX - s.x);
    if (dx > 36 && dx > Math.abs(dy)) { reset(); return; } // arrasto lateral = responder
    if (dy <= DEAD) { if (phaseRef.current) { prog.setValue(0); setPh(0); } return; }
    const p = Math.min(1, (dy - DEAD) / THRESH);
    prog.setValue(p);
    setPh(p >= 1 && Date.now() - s.t >= MIN_MS ? 2 : 1);
  };
  const onTouchEnd = () => {
    const armed = phaseRef.current === 2;
    reset();
    if (armed) { try { onActivate && onActivate(); } catch {} }
  };

  const label = phase === 2
    ? (active ? _tt(t, 'vanish.releaseOff', 'Solte para desativar o modo temporário') : _tt(t, 'vanish.release', 'Solte para ativar o modo temporário'))
    : (active ? _tt(t, 'vanish.pullHintOff', 'Deslize para cima para desativar o modo temporário') : _tt(t, 'vanish.pullHint', 'Deslize para cima para ativar o modo temporário'));
  const fg = isDark || active ? '#F1F3F5' : '#111111';
  const bg = isDark || active ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)';

  return (
    <View
      style={style || { flex: 1 }}
      onTouchStart={enabled ? onTouchStart : undefined}
      onTouchMove={enabled ? onTouchMove : undefined}
      onTouchEnd={enabled ? onTouchEnd : undefined}
      onTouchCancel={enabled ? reset : undefined}
    >
      {children}
      {enabled && phase > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.pill, { backgroundColor: bg, opacity: prog.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0, 1, 1] }),
            transform: [{ translateY: prog.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }]}
          accessibilityLiveRegion="polite"
        >
          <IconVanish size={18} color={fg} />
          <Text style={[styles.pillText, { color: fg }]} numberOfLines={1}>{label}</Text>
          <View style={[styles.track, { backgroundColor: isDark || active ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.10)' }]}>
            <Animated.View style={[styles.fill, { backgroundColor: fg, transform: [{ scaleX: prog }] }]} />
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: 'absolute', left: 16, right: 16, bottom: 12, alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 14, borderRadius: 16, gap: 6,
  },
  pillText: { fontSize: 13.5, fontWeight: '600' },
  track: { alignSelf: 'stretch', height: 3, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 3, width: '100%', transformOrigin: 'left' },
});
