import { useEffect, useRef, useState } from 'react';
import { View, Animated, StyleSheet, Platform, Easing } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { AnimTiming, Spacing } from '../constants/theme';
import { isReduceMotionEnabled } from './reducedMotion'; // [2026-10-16 motion-telegram]

// ── Shared shimmer clock ──
// One native-driven value drives EVERY Shimmer on screen, so the highlight
// sweeps across the whole list in sync (WhatsApp/Telegram look) instead of
// each bar pulsing on its own. Ref-counted: the loop only runs while at
// least one skeleton is mounted.
let _shClock = null;
let _shLoop = null;
let _shUsers = 0;
function acquireShimmerClock() {
  if (!_shClock) _shClock = new Animated.Value(0);
  if (_shUsers++ === 0) {
    _shClock.setValue(0);
    // [2026-10-16 motion-telegram] Reduzir Movimento: placeholder estático (sem varredura).
    if (isReduceMotionEnabled()) { _shLoop = null; return _shClock; }
    _shLoop = Animated.loop(
      Animated.timing(_shClock, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.quad), useNativeDriver: true })
    );
    _shLoop.start();
  }
  return _shClock;
}
function releaseShimmerClock() {
  if (--_shUsers <= 0) {
    _shUsers = 0;
    try { _shLoop && _shLoop.stop(); } catch {}
    _shLoop = null;
  }
}

/** Shared placeholder fill (light / dark). */
export function skeletonBase(isDark) {
  return isDark ? 'rgba(255,255,255,0.08)' : 'rgba(17,17,17,0.06)';
}

// [2026-10-12 skeleton system] Deterministic 0..1 "random" per row/slot —
// Math.random() in render re-rolled every bar width on each re-render (the
// list visibly jittered while data streamed in).
function _jit(i, salt) {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// Soft bell of slices that fakes a gradient highlight (no linear-gradient dep,
// so this stays OTA-safe). Opacities are multiplied by the highlight color.
const SHIMMER_BELL = [0.1, 0.35, 0.7, 1, 0.7, 0.35, 0.1];

export function Shimmer({ style, delay = 0 }) {
  const { colors, isDark } = useTheme();
  const clock = useRef(null);
  if (!clock.current) clock.current = acquireShimmerClock();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [w, setW] = useState(0);

  const _still = isReduceMotionEnabled(); // [2026-10-16 motion-telegram]
  useEffect(() => {
    if (_still) { fadeAnim.setValue(1); return () => { releaseShimmerClock(); }; }
    // Staggered entrance fade
    const fade = Animated.timing(fadeAnim, {
      toValue: 1,
      duration: AnimTiming.normal,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    fade.start();
    return () => { fade.stop(); releaseShimmerClock(); };
  }, []);

  // [2026-10-12 skeleton system] ONE placeholder tone app-wide (shared with
  // Skeleton.js): a translucent ink wash, so bars read on ANY surface — page,
  // card, or a chat bubble (an opaque gray vanished inside dark #1C1C1E
  // bubbles; the old borderLight #F4F5F6 nearly vanished on white).
  const base = skeletonBase(isDark);
  const hi = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.7)';
  const band = Math.max(60, w * 0.7);
  const translateX = clock.current.interpolate({ inputRange: [0, 1], outputRange: [-band, w] });

  return (
    <Animated.View
      onLayout={(e) => { const nw = Math.round(e.nativeEvent.layout.width); if (nw && nw !== w) setW(nw); }}
      style={[
        // Default radius FIRST so a caller's borderRadius (round avatars,
        // pills) wins — it used to be forced to 8 after `style`.
        { borderRadius: 8 },
        style,
        {
          backgroundColor: base,
          overflow: 'hidden',
          opacity: fadeAnim,
          ...(Platform.OS === 'web' ? {
            background: `linear-gradient(90deg, ${base} 25%, ${isDark ? 'rgba(255,255,255,0.13)' : 'rgba(17,17,17,0.025)'} 50%, ${base} 75%)`,
            backgroundSize: '200% 100%',
            animation: _still ? 'none' : 'shimmerSlide 1.4s infinite ease-in-out',
          } : {}),
        },
      ]}
    >
      {w > 0 && Platform.OS !== 'web' && !_still ? (
        <Animated.View
          pointerEvents="none"
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: band, flexDirection: 'row', transform: [{ translateX }] }}
        >
          {SHIMMER_BELL.map((o, i) => (
            <View key={i} style={{ flex: 1, backgroundColor: hi, opacity: o }} />
          ))}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

export function EmailSkeleton({ count = 6 }) {
  // [2026-10-16 polish] Mesma geometria do EmailRow (densidade confortável:
  // avatar 38, margem lateral Spacing.lg+2, gap Spacing.md+2) — antes 44/20/12
  // e a lista "pulava" para a esquerda quando os e-mails chegavam.
  return (
    <View>
      {Array.from({ length: count }).map((_, i) => (
        <Animated.View key={i} style={[s.row, s.emailRow]}>
          <Shimmer style={s.emailAvatar} delay={i * AnimTiming.staggerFast} />
          <View style={s.lines}>
            <Shimmer style={[s.line1, { width: `${60 + _jit(i, 1) * 20}%` }]} delay={i * AnimTiming.staggerFast + 30} />
            <Shimmer style={[s.line2, { width: `${75 + _jit(i, 2) * 15}%` }]} delay={i * AnimTiming.staggerFast + 60} />
            <Shimmer style={[s.line3, { width: `${40 + _jit(i, 3) * 30}%` }]} delay={i * AnimTiming.staggerFast + 90} />
          </View>
          <Shimmer style={s.date} delay={i * AnimTiming.staggerFast + 50} />
        </Animated.View>
      ))}
    </View>
  );
}

export function MessageSkeleton() {
  return (
    <View style={s.msgContainer}>
      <Shimmer style={s.msgSubject} delay={0} />
      <View style={s.msgRow}>
        <Shimmer style={s.avatar} delay={50} />
        <View style={s.lines}>
          <Shimmer style={[s.line1, { width: '40%' }]} delay={80} />
          <Shimmer style={[s.line2, { width: '25%' }]} delay={110} />
        </View>
      </View>
      <View style={s.msgBodyBlock}>
        <Shimmer style={s.msgBody1} delay={150} />
        <Shimmer style={s.msgBody2} delay={180} />
        <Shimmer style={s.msgBody3} delay={210} />
        <Shimmer style={[s.msgBody1, { width: '85%' }]} delay={240} />
        <Shimmer style={[s.msgBody2, { width: '70%' }]} delay={270} />
      </View>
    </View>
  );
}

// Profile screen skeleton
export function ProfileSkeleton() {
  return (
    <View style={s.profileContainer}>
      {/* Avatar */}
      <View style={{ alignItems: 'center', paddingVertical: 24 }}>
        <Shimmer style={{ width: 108, height: 108, borderRadius: 54 }} delay={0} />
        <Shimmer style={{ width: 140, height: 18, borderRadius: 9, marginTop: 14 }} delay={50} />
        <Shimmer style={{ width: 180, height: 13, borderRadius: 7, marginTop: 8 }} delay={80} />
      </View>
      {/* Info rows */}
      {[0, 1, 2, 3].map(i => (
        <View key={i} style={s.profileRow}>
          <Shimmer style={{ width: 36, height: 36, borderRadius: 10 }} delay={120 + i * 40} />
          <View style={{ flex: 1, gap: 6, marginLeft: 12 }}>
            <Shimmer style={{ width: 60, height: 10, borderRadius: 5 }} delay={140 + i * 40} />
            <Shimmer style={{ width: `${50 + _jit(i, 4) * 30}%`, height: 14, borderRadius: 7 }} delay={160 + i * 40} />
          </View>
        </View>
      ))}
    </View>
  );
}

// [2026-10-20 ux] Post de feed (Mural): cabeçalho avatar+nome, mídia quadrada e barra de ações.
// Substitui o spinner solto no 1º carregamento (Telegram/Instagram mostram a FORMA que vem).
export function PostSkeleton({ count = 2 }) {
  return (
    <View>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={{ paddingVertical: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 10 }}>
            <Shimmer style={{ width: 36, height: 36, borderRadius: 18 }} delay={i * 80} />
            <View style={{ flex: 1, gap: 6 }}>
              <Shimmer style={{ width: `${32 + _jit(i, 9) * 20}%`, height: 12, borderRadius: 6 }} delay={i * 80 + 20} />
              <Shimmer style={{ width: 64, height: 10, borderRadius: 5 }} delay={i * 80 + 40} />
            </View>
          </View>
          <Shimmer style={{ width: '100%', aspectRatio: 1, borderRadius: 0, marginTop: 10 }} delay={i * 80 + 60} />
          <View style={{ flexDirection: 'row', paddingHorizontal: 16, marginTop: 10, gap: 14 }}>
            {[0, 1, 2].map((k) => <Shimmer key={k} style={{ width: 24, height: 24, borderRadius: 12 }} delay={i * 80 + 80 + k * 20} />)}
          </View>
          <Shimmer style={{ width: `${55 + _jit(i, 10) * 30}%`, height: 11, borderRadius: 6, marginTop: 10, marginLeft: 16 }} delay={i * 80 + 140} />
        </View>
      ))}
    </View>
  );
}

// [2026-10-20 ux] Comentários: avatar pequeno + 2 linhas (substitui spinner no 1º carregamento).
export function CommentSkeleton({ count = 4 }) {
  return (
    <View style={{ paddingVertical: 6 }}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={{ flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 8, gap: 10 }}>
          <Shimmer style={{ width: 32, height: 32, borderRadius: 16 }} delay={i * 50} />
          <View style={{ flex: 1, gap: 6, paddingTop: 2 }}>
            <Shimmer style={{ width: 90, height: 10, borderRadius: 5 }} delay={i * 50 + 20} />
            <Shimmer style={{ width: `${45 + _jit(i, 11) * 45}%`, height: 12, borderRadius: 6 }} delay={i * 50 + 40} />
          </View>
        </View>
      ))}
    </View>
  );
}

// Generic list skeleton (files, notes, contacts, etc.)
export function ListSkeleton({ count = 6, showIcon = true }) {
  return (
    <View style={s.container}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={s.row}>
          {showIcon && <Shimmer style={{ width: 40, height: 40, borderRadius: 10 }} delay={i * 40} />}
          <View style={[s.lines, { marginLeft: showIcon ? 12 : 0 }]}>
            <Shimmer style={[s.line1, { width: `${50 + _jit(i, 5) * 30}%` }]} delay={i * 40 + 20} />
            <Shimmer style={[s.line2, { width: `${30 + _jit(i, 6) * 30}%` }]} delay={i * 40 + 40} />
          </View>
        </View>
      ))}
    </View>
  );
}

// Calendar skeleton
export function CalendarSkeleton() {
  return (
    <View style={s.container}>
      {/* Calendar grid placeholder */}
      <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
        <Shimmer style={{ width: 150, height: 20, borderRadius: 10, marginBottom: 16 }} delay={0} />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
          {[0, 1, 2, 3, 4, 5, 6].map(i => (
            <Shimmer key={i} style={{ width: 32, height: 12, borderRadius: 6 }} delay={i * 20} />
          ))}
        </View>
        {[0, 1, 2, 3, 4].map(row => (
          <View key={row} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
            {[0, 1, 2, 3, 4, 5, 6].map(col => (
              <Shimmer key={col} style={{ width: 32, height: 32, borderRadius: 16 }} delay={row * 30 + col * 10} />
            ))}
          </View>
        ))}
      </View>
      {/* Event list */}
      {[0, 1, 2].map(i => (
        <View key={i} style={[s.row, { paddingHorizontal: 16 }]}>
          <Shimmer style={{ width: 4, height: 40, borderRadius: 2 }} delay={200 + i * 40} />
          <View style={[s.lines, { marginLeft: 12 }]}>
            <Shimmer style={[s.line1, { width: `${40 + _jit(i, 7) * 30}%` }]} delay={220 + i * 40} />
            <Shimmer style={[s.line2, { width: `${30 + _jit(i, 8) * 20}%` }]} delay={240 + i * 40} />
          </View>
        </View>
      ))}
    </View>
  );
}

// Chat conversations list skeleton (WhatsApp-like)
export function ChatListSkeleton({ count = 8 }) {
  return (
    <View style={s.container}>
      {Array.from({ length: count }).map((_, i) => (
        // [2026-10-08 chat-beauty-list] Matches the real row: 54 avatar, 74pt
        // rhythm, text column at x=84 (container 4 + 12 + 54 + 14).
        // [2026-10-10 polish-list] widths fixed per index (were Math.random → jitter on re-render).
        <View key={i} style={[s.row, { paddingVertical: 10, minHeight: 74, paddingHorizontal: 12 }]}>
          <Shimmer style={{ width: 54, height: 54, borderRadius: 27 }} delay={i * 35} />
          <View style={[s.lines, { marginLeft: 2 }]}>
            <Shimmer style={[s.line1, { width: `${40 + ((i * 37) % 25)}%` }]} delay={i * 35 + 15} />
            <Shimmer style={[s.line2, { width: `${55 + ((i * 53) % 30)}%` }]} delay={i * 35 + 30} />
          </View>
          <View style={{ alignItems: 'flex-end', gap: 8 }}>
            <Shimmer style={{ width: 36, height: 10, borderRadius: 5 }} delay={i * 35 + 20} />
            {i % 3 === 0 && <Shimmer style={{ width: 20, height: 20, borderRadius: 10 }} delay={i * 35 + 40} />}
          </View>
        </View>
      ))}
    </View>
  );
}

// Call history skeleton
export function CallListSkeleton({ count = 6 }) {
  return (
    <View style={s.container}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={s.row}>
          <Shimmer style={{ width: 44, height: 44, borderRadius: 22 }} delay={i * 40} />
          <View style={[s.lines, { marginLeft: 12 }]}>
            <Shimmer style={[s.line1, { width: `${35 + _jit(i, 9) * 30}%` }]} delay={i * 40 + 15} />
            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
              <Shimmer style={{ width: 12, height: 12, borderRadius: 6 }} delay={i * 40 + 30} />
              <Shimmer style={{ width: 80, height: 10, borderRadius: 5 }} delay={i * 40 + 35} />
            </View>
          </View>
          <Shimmer style={{ width: 28, height: 28, borderRadius: 14 }} delay={i * 40 + 25} />
        </View>
      ))}
    </View>
  );
}

// Settings/Profile tab skeleton (sections with icons)
export function SettingsSkeleton({ sections = 4, rows = 3 }) {
  return (
    <View style={s.container}>
      {/* Profile card */}
      <View style={{ alignItems: 'center', paddingVertical: 20 }}>
        <Shimmer style={{ width: 80, height: 80, borderRadius: 40 }} delay={0} />
        <Shimmer style={{ width: 120, height: 16, borderRadius: 8, marginTop: 12 }} delay={40} />
        <Shimmer style={{ width: 160, height: 12, borderRadius: 6, marginTop: 6 }} delay={60} />
      </View>
      {/* Section rows */}
      {Array.from({ length: sections }).map((_, s_idx) => (
        <View key={s_idx}>
          <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 }}>
            <Shimmer style={{ width: 80, height: 10, borderRadius: 5 }} delay={100 + s_idx * 60} />
          </View>
          {Array.from({ length: rows }).map((_, i) => (
            <View key={i} style={[s.row, { paddingVertical: 10 }]}>
              <Shimmer style={{ width: 36, height: 36, borderRadius: 10 }} delay={120 + s_idx * 60 + i * 25} />
              <View style={[s.lines, { marginLeft: 12 }]}>
                <Shimmer style={[s.line1, { width: `${40 + _jit(i, 10) * 30}%` }]} delay={140 + s_idx * 60 + i * 25} />
              </View>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

// Grid skeleton (photos)
export function GridSkeleton({ count = 12, columns = 3 }) {
  const rows = Math.ceil(count / columns);
  return (
    <View style={s.container}>
      {Array.from({ length: rows }).map((_, row) => (
        <View key={row} style={{ flexDirection: 'row', gap: 2 }}>
          {Array.from({ length: columns }).map((_, col) => (
            <View key={col} style={{ flex: 1, aspectRatio: 1 }}>
              <Shimmer style={{ flex: 1, borderRadius: 0 }} delay={(row * columns + col) * 30} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

// Note card grid skeleton (Google Keep style)
export function NoteGridSkeleton({ count = 6, columns = 2 }) {
  return (
    <View style={{ padding: 16 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {Array.from({ length: count }).map((_, i) => {
          const heights = [100, 140, 80, 120, 90, 130];
          const h = heights[i % heights.length];
          return (
            <View key={i} style={{ width: `${100 / columns - 2}%`, marginBottom: 10, borderRadius: 12, overflow: 'hidden' }}>
              <Shimmer style={{ height: 18, width: `${50 + _jit(i, 11) * 30}%`, borderRadius: 9, marginBottom: 8 }} delay={i * 50} />
              <Shimmer style={{ height: h, width: '100%', borderRadius: 10 }} delay={i * 50 + 20} />
              <View style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}>
                <Shimmer style={{ width: 50, height: 10, borderRadius: 5 }} delay={i * 50 + 40} />
                <Shimmer style={{ width: 30, height: 10, borderRadius: 5 }} delay={i * 50 + 50} />
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// Chat bubble skeleton (WhatsApp style — alternating left/right bubbles with shimmer)
export function ChatBubbleSkeleton({ count = 8 }) {
  const { colors } = useTheme();
  const widths = [0.65, 0.45, 0.7, 0.35, 0.55, 0.4, 0.6, 0.5];
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8, gap: 12 }}>
      {Array.from({ length: count }).map((_, i) => {
        const isRight = i % 2 === 1;
        const w = widths[i % widths.length];
        // Tint the wrapper with the same own/other bubble colors the real
        // chat uses, so the skeleton reads as bubbles instead of floating
        // lines on a blank canvas.
        const bubbleBg = isRight
          ? (colors.chatBubbleOwn || '#F1F3F5')
          : (colors.chatBubbleOther || '#FFFFFF');
        const bubbleBorder = isRight
          ? (colors.chatBubbleOwnBorder || 'rgba(17, 17, 17,0.08)')
          : (colors.chatBubbleOtherBorder || 'rgba(0,0,0,0.04)');
        return (
          <View key={i} style={{ alignSelf: isRight ? 'flex-end' : 'flex-start', width: `${w * 70}%`, maxWidth: 280 }}>
            <View style={{ borderRadius: 16, padding: 14, overflow: 'hidden', backgroundColor: bubbleBg, borderWidth: 1, borderColor: bubbleBorder }}>
              <Shimmer style={{ height: 12, borderRadius: 6, width: '100%', marginBottom: 6 }} delay={i * 60} />
              <Shimmer style={{ height: 12, borderRadius: 6, width: `${50 + _jit(i, 12) * 30}%` }} delay={i * 60 + 25} />
              {w > 0.5 && <Shimmer style={{ height: 12, borderRadius: 6, width: '40%', marginTop: 6 }} delay={i * 60 + 50} />}
            </View>
          </View>
        );
      })}
    </View>
  );
}

// Drive/Files skeleton (grid of file cards)
export function DriveGridSkeleton({ count = 8, columns = 4 }) {
  return (
    <View style={{ padding: 16 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {Array.from({ length: count }).map((_, i) => (
          <View key={i} style={{ width: `${100 / columns - 2}%`, minWidth: 140, marginBottom: 12 }}>
            <Shimmer style={{ height: 100, width: '100%', borderRadius: 10, marginBottom: 8 }} delay={i * 40} />
            <Shimmer style={{ height: 12, width: `${50 + _jit(i, 13) * 30}%`, borderRadius: 6, marginBottom: 4 }} delay={i * 40 + 20} />
            <Shimmer style={{ height: 10, width: `${30 + _jit(i, 14) * 20}%`, borderRadius: 5 }} delay={i * 40 + 35} />
          </View>
        ))}
      </View>
    </View>
  );
}

// Drive list skeleton
export function DriveListSkeleton({ count = 8 }) {
  return (
    <View style={s.container}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={s.row}>
          <Shimmer style={{ width: 40, height: 40, borderRadius: 8 }} delay={i * 35} />
          <View style={[s.lines, { marginLeft: 12 }]}>
            <Shimmer style={[s.line1, { width: `${45 + _jit(i, 15) * 35}%` }]} delay={i * 35 + 15} />
            <Shimmer style={[s.line2, { width: `${25 + _jit(i, 16) * 20}%` }]} delay={i * 35 + 30} />
          </View>
          <Shimmer style={{ width: 28, height: 10, borderRadius: 5 }} delay={i * 35 + 20} />
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  container: { paddingHorizontal: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  emailRow: { paddingHorizontal: Spacing.lg + 2, gap: Spacing.md + 2, paddingVertical: 13 },
  emailAvatar: { width: 38, height: 38, borderRadius: 19 },
  lines: { flex: 1, gap: 8 },
  line1: { height: 13, width: '70%', borderRadius: 6 },
  line2: { height: 11, width: '90%', borderRadius: 5 },
  line3: { height: 10, width: '50%', borderRadius: 5, marginTop: 2 },
  date: { width: 44, height: 10, borderRadius: 6 },
  profileContainer: { padding: 16 },
  profileRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16 },
  msgContainer: { padding: 20, gap: 16 },
  msgSubject: { height: 24, width: '80%', borderRadius: 8 },
  msgRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  msgBodyBlock: { gap: 10, marginTop: 8 },
  msgBody1: { height: 12, width: '100%', borderRadius: 6 },
  msgBody2: { height: 12, width: '95%', borderRadius: 6 },
  msgBody3: { height: 12, width: '60%', borderRadius: 6 },
});
