// components/email/ReaderSwipePager.native.js — [2026-10-18 email-reader-rea]
//
// Deslizar entre e-mails no leitor na THREAD DE UI (Reanimated 4 + RNGH): o
// conteúdo segue o dedo quadro a quadro sem passar pelo JS (antes:
// Gesture.Pan().runOnJS(true) + Animated.setValue a cada quadro), e durante o
// arrasto aparece a "espiada" do cabeçalho do próximo/anterior (remetente,
// assunto, prévia) entrando pela borda — estilo Apple Mail / Gmail.
// O JS só é chamado UMA vez, para navegar (runOnJS no fim da animação).
//
// Mesmo gate do SwipeReplyRow: só quando utils/threadKeyboard já carregou
// Reanimated/Worklets neste binário. Kill switch OTA:
// globalThis.__chatyy_mail_reader_rea = false → swipe antigo (read.js).
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, Text, useWindowDimensions } from 'react-native';
import { KEYBOARD_CONTROLLER_ACTIVE } from '../../utils/threadKeyboard';

let Rea = null;
let GH = null;
if (KEYBOARD_CONTROLLER_ACTIVE) {
  try {
    // eslint-disable-next-line global-require
    Rea = require('react-native-reanimated');
    // eslint-disable-next-line global-require
    GH = require('react-native-gesture-handler');
  } catch {
    Rea = null;
    GH = null;
  }
}

// Worklets capturam FUNÇÕES, nunca o módulo inteiro.
const runOnJS = Rea ? Rea.runOnJS : null;
const withSpring = Rea ? Rea.withSpring : null;
const withTiming = Rea ? Rea.withTiming : null;
const interpolate = Rea ? Rea.interpolate : null;

export const READER_SWIPE_REA = !!(
  Rea && Rea.default && Rea.useSharedValue && Rea.useAnimatedStyle && Rea.withSpring && Rea.withTiming
  && Rea.interpolate && Rea.runOnJS
  && GH && GH.Gesture && GH.Gesture.Pan && GH.GestureDetector
);

export function isReaderReaOn() {
  if (!READER_SWIPE_REA) return false;
  try { return globalThis.__chatyy_mail_reader_rea !== false; } catch { return true; }
}

const SPRING = { damping: 22, stiffness: 240, mass: 0.8 };
const COMMIT_FRACTION = 0.28;
const FLING_VX = 650;

let _haptics = null;
function _tick() {
  try {
    if (!_haptics) _haptics = require('../../services/haptics');
    _haptics.tap('light');
  } catch {}
}

function _initial(name) {
  const s = String(name || '').trim();
  return s ? s[0].toUpperCase() : '?';
}

function _fmtDate(d) {
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '';
    const now = new Date();
    if (dt.toDateString() === now.toDateString()) {
      return dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    return dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  } catch { return ''; }
}

function PeekCard({ item, colors, side }) {
  const c = colors || {};
  const from = item ? (item.from_name || item.from || '') : '';
  const subject = item ? (item.subject || '') : '';
  const preview = item ? String(item.preview || item.snippet || '').replace(/\s+/g, ' ').trim() : '';
  return (
    <View style={[st.peekInner, { backgroundColor: c.surface || '#fff' }]}>
      <Text style={[st.peekHint, { color: c.textTertiary || c.textSecondary }]}>
        {side === 'next' ? '›' : '‹'}
      </Text>
      {item ? (
        <>
          <View style={st.peekHead}>
            <View style={[st.avatar, { backgroundColor: (c.primary || '#111') + '1A' }]}>
              <Text style={[st.avatarTxt, { color: c.primary || '#111' }]}>{_initial(from)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[st.from, { color: c.text }]} numberOfLines={1}>{from}</Text>
              {!!item.date && <Text style={[st.date, { color: c.textSecondary }]} numberOfLines={1}>{_fmtDate(item.date)}</Text>}
            </View>
          </View>
          {!!subject && <Text style={[st.subject, { color: c.text }]} numberOfLines={2}>{subject}</Text>}
          {!!preview && <Text style={[st.preview, { color: c.textSecondary }]} numberOfLines={4}>{preview}</Text>}
        </>
      ) : (
        <View style={[st.skel, { backgroundColor: c.surfaceVariant || c.border || '#eee' }]} />
      )}
    </View>
  );
}

export default function ReaderSwipePager({
  enabled = true, canPrev, canNext, prevItem, nextItem, onNavigate, colors, children,
}) {
  const Animated = Rea.default;
  const { width } = useWindowDimensions();
  const tx = Rea.useSharedValue(0);
  const w = Rea.useSharedValue(width || 400);
  useEffect(() => { w.set(width || 400); }, [width, w]);

  const navRef = useRef(onNavigate);
  navRef.current = onNavigate;
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const go = useCallback((dir) => {
    try { navRef.current?.(dir); } catch {}
    // A tela é trocada (router.replace remonta). Se por algum motivo não for,
    // volta o conteúdo pro lugar.
    setTimeout(() => { if (mountedRef.current) tx.set(withSpring(0, SPRING)); }, 1200);
  }, [tx]);

  const gesture = useMemo(() => {
    const cp = !!canPrev;
    const cn = !!canNext;
    return GH.Gesture.Pan()
      .enabled(!!enabled && (cp || cn))
      .activeOffsetX([-24, 24])
      .failOffsetY([-12, 12])
      .onUpdate((e) => {
        'worklet';
        const x = e.translationX;
        const allowed = (x < 0 && cn) || (x > 0 && cp);
        tx.set(allowed ? x : x * 0.15);
      })
      .onEnd((e) => {
        'worklet';
        const x = e.translationX;
        const vx = e.velocityX;
        const ww = w.get();
        const goNext = cn && (x < -ww * COMMIT_FRACTION || (x < -40 && vx < -FLING_VX));
        const goPrev = cp && (x > ww * COMMIT_FRACTION || (x > 40 && vx > FLING_VX));
        if (goNext || goPrev) {
          runOnJS(_tick)();
          const dir = goNext ? 'next' : 'prev';
          tx.set(withTiming(goNext ? -ww : ww, { duration: 190 }, (finished) => {
            'worklet';
            if (finished) runOnJS(go)(dir);
          }));
        } else {
          tx.set(withSpring(0, SPRING));
        }
      });
  }, [enabled, canPrev, canNext, go, tx, w]);

  const contentStyle = Rea.useAnimatedStyle(() => ({
    transform: [{ translateX: tx.get() }],
  }));
  const prevStyle = Rea.useAnimatedStyle(() => {
    const t = tx.get();
    const ww = w.get();
    return {
      transform: [{ translateX: t - ww }],
      opacity: interpolate(t, [0, ww * 0.5], [0.35, 1], 'clamp'),
    };
  });
  const nextStyle = Rea.useAnimatedStyle(() => {
    const t = tx.get();
    const ww = w.get();
    return {
      transform: [{ translateX: t + ww }],
      opacity: interpolate(-t, [0, ww * 0.5], [0.35, 1], 'clamp'),
    };
  });

  return (
    <GH.GestureDetector gesture={gesture}>
      <Animated.View style={st.root} collapsable={false}>
        {canPrev ? (
          <Animated.View pointerEvents="none" style={[st.peek, { width }, prevStyle]}>
            <PeekCard item={prevItem} colors={colors} side="prev" />
          </Animated.View>
        ) : null}
        {canNext ? (
          <Animated.View pointerEvents="none" style={[st.peek, { width }, nextStyle]}>
            <PeekCard item={nextItem} colors={colors} side="next" />
          </Animated.View>
        ) : null}
        <Animated.View style={[st.fill, contentStyle]} collapsable={false}>
          {children}
        </Animated.View>
      </Animated.View>
    </GH.GestureDetector>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, overflow: 'hidden' },
  fill: { flex: 1 },
  peek: { position: 'absolute', top: 0, bottom: 0, left: 0 },
  peekInner: { flex: 1, paddingHorizontal: 20, paddingTop: 18 },
  peekHint: { fontSize: 22, marginBottom: 6, opacity: 0.6 },
  peekHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { fontSize: 16, fontWeight: '700' },
  from: { fontSize: 15, fontWeight: '700' },
  date: { fontSize: 12, marginTop: 2 },
  subject: { fontSize: 19, fontWeight: '700', lineHeight: 25, marginBottom: 10 },
  preview: { fontSize: 14, lineHeight: 20 },
  skel: { height: 14, borderRadius: 7, width: '60%', marginTop: 8 },
});
