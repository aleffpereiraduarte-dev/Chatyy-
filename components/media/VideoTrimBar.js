// [2026-10-10 video-trim] Barra de corte de vídeo na prévia de envio (WhatsApp):
// tira de miniaturas + duas alças (início/fim). Não corta nada sozinha — só
// informa o intervalo escolhido via onChange({ startMs, endMs }) (ou null quando
// volta ao vídeo inteiro). O corte de verdade roda no envio, no módulo nativo
// ExpoNativeVideo.trimVideo (sem re-encode). Se o binário não tem trimVideo, a
// MediaPreview nem monta este componente (isTrimAvailable()).
//
// Gestos com PanResponder do próprio RN: funciona em qualquer binário, sem
// depender de reanimated/RNGH. Preto & branco, sem emoji.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Image, PanResponder, StyleSheet } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';

const HANDLE_W = 16;
const BAR_H = 48;
const MIN_MS = 1000;
const THUMB_COUNT = 8;

function fmt(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function IconScissors({ size = 14, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="6" cy="6" r="3" />
      <Circle cx="6" cy="18" r="3" />
      <Line x1="20" y1="4" x2="8.12" y2="15.88" />
      <Line x1="14.47" y1="14.48" x2="20" y2="20" />
      <Line x1="8.12" y1="8.12" x2="12" y2="12" />
    </Svg>
  );
}

function getVideoMod() {
  try { return require('../../modules/expo-native-video').default; } catch { return null; }
}

export default function VideoTrimBar({ uri, value, onChange, t }) {
  const [durationMs, setDurationMs] = useState(0);
  const [thumbs, setThumbs] = useState([]);
  const [trackW, setTrackW] = useState(0);
  const [range, setRange] = useState(null); // { startMs, endMs } enquanto arrasta
  const rangeRef = useRef(null);
  const dragStartRef = useRef(null);

  // Duração + miniaturas (sequencial, leve: 8 frames de 96px).
  useEffect(() => {
    let alive = true;
    setThumbs([]);
    setDurationMs(0);
    const mod = getVideoMod();
    if (!uri || !mod?.getInfo) return undefined;
    (async () => {
      try {
        const info = await mod.getInfo(uri);
        const dur = Number(info?.durationMs) || 0;
        if (!alive || dur <= 0) return;
        setDurationMs(dur);
        const out = [];
        for (let i = 0; i < THUMB_COUNT; i++) {
          if (!alive) return;
          try {
            const at = Math.round((dur * (i + 0.5)) / THUMB_COUNT);
            const th = await mod.generateThumbnail(uri, at, 96);
            if (th?.uri) out.push(th.uri);
          } catch {}
          if (alive) setThumbs(out.slice());
        }
      } catch {}
    })();
    return () => { alive = false; };
  }, [uri]);

  // Intervalo efetivo (prop controlada → estado local durante o arrasto).
  const cur = useMemo(() => {
    const base = range || value || null;
    const start = Math.max(0, Math.min(base?.startMs ?? 0, durationMs));
    const end = Math.max(start, Math.min(base?.endMs ?? durationMs, durationMs));
    return { startMs: start, endMs: end || durationMs };
  }, [range, value, durationMs]);
  useEffect(() => { if (!dragStartRef.current) rangeRef.current = cur; }, [cur]);

  const innerW = Math.max(1, trackW - HANDLE_W * 2);
  const msToX = (ms) => (durationMs > 0 ? (ms / durationMs) * innerW : 0);

  const commit = (r) => {
    if (!r || durationMs <= 0) return;
    const full = r.startMs <= 50 && r.endMs >= durationMs - 50;
    onChange?.(full ? null : { startMs: Math.round(r.startMs), endMs: Math.round(r.endMs) });
  };

  const makeResponder = (which) => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { dragStartRef.current = { ...rangeRef.current }; },
    onPanResponderMove: (_e, g) => {
      const s0 = dragStartRef.current;
      if (!s0 || durationMs <= 0) return;
      const dMs = (g.dx / innerW) * durationMs;
      let { startMs, endMs } = s0;
      if (which === 'start') startMs = Math.max(0, Math.min(s0.startMs + dMs, endMs - MIN_MS));
      else endMs = Math.min(durationMs, Math.max(s0.endMs + dMs, startMs + MIN_MS));
      rangeRef.current = { startMs, endMs };
      setRange({ startMs, endMs });
    },
    onPanResponderRelease: () => { commit(rangeRef.current); setRange(null); dragStartRef.current = null; },
    onPanResponderTerminate: () => { commit(rangeRef.current); setRange(null); dragStartRef.current = null; },
  });
  // Recria quando a geometria muda (closures leem durationMs/innerW).
  const startResponder = useMemo(() => makeResponder('start'), [durationMs, innerW]); // eslint-disable-line react-hooks/exhaustive-deps
  const endResponder = useMemo(() => makeResponder('end'), [durationMs, innerW]); // eslint-disable-line react-hooks/exhaustive-deps

  if (durationMs <= 0 || durationMs < MIN_MS + 500) return null;

  const leftX = msToX(cur.startMs);
  const rightX = msToX(cur.endMs);
  const selMs = cur.endMs - cur.startMs;
  const trimmed = cur.startMs > 50 || cur.endMs < durationMs - 50;

  return (
    <View style={styles.wrap}>
      <View style={styles.infoRow}>
        <IconScissors size={14} color="#fff" />
        <Text style={styles.infoText} numberOfLines={1}>
          {trimmed
            ? `${fmt(cur.startMs)} – ${fmt(cur.endMs)}  ·  ${fmt(selMs)}`
            : (t?.('chatConv.trimHint') || 'chatConv.trimHint')}
        </Text>
      </View>
      <View
        style={styles.track}
        onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
        accessibilityRole="adjustable"
        accessibilityLabel={t?.('chatConv.trimVideo') || 'chatConv.trimVideo'}
        accessibilityValue={{ text: `${fmt(cur.startMs)} – ${fmt(cur.endMs)}` }}
      >
        <View style={[styles.thumbRow, { left: HANDLE_W, right: HANDLE_W }]}>
          {thumbs.map((u, i) => (
            <Image key={i} source={{ uri: u }} style={styles.thumb} resizeMode="cover" />
          ))}
        </View>
        {trackW > 0 && (
          <>
            {/* Escurece o que fica de fora */}
            <View pointerEvents="none" style={[styles.dim, { left: HANDLE_W, width: Math.max(0, leftX) }]} />
            <View pointerEvents="none" style={[styles.dim, { left: HANDLE_W + rightX, width: Math.max(0, innerW - rightX) }]} />
            {/* Moldura do trecho escolhido */}
            <View pointerEvents="none" style={[styles.frame, { left: HANDLE_W + leftX, width: Math.max(0, rightX - leftX) }]} />
            <View {...startResponder.panHandlers} hitSlop={{ top: 12, bottom: 12, left: 14, right: 8 }} style={[styles.handle, styles.handleL, { left: leftX }]}>
              <View style={styles.grip} />
            </View>
            <View {...endResponder.panHandlers} hitSlop={{ top: 12, bottom: 12, left: 8, right: 14 }} style={[styles.handle, styles.handleR, { left: HANDLE_W + rightX }]}>
              <View style={styles.grip} />
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4, backgroundColor: 'rgba(0,0,0,0.6)' },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  infoText: { color: '#fff', fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1 },
  track: { height: BAR_H, borderRadius: 8, overflow: 'visible', position: 'relative' },
  thumbRow: { position: 'absolute', top: 0, bottom: 0, flexDirection: 'row', backgroundColor: '#1c1c1e', borderRadius: 4, overflow: 'hidden' },
  thumb: { flex: 1, height: '100%' },
  dim: { position: 'absolute', top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.62)' },
  frame: { position: 'absolute', top: 0, bottom: 0, borderTopWidth: 3, borderBottomWidth: 3, borderColor: '#fff' },
  handle: { position: 'absolute', top: 0, bottom: 0, width: HANDLE_W, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  handleL: { borderTopLeftRadius: 8, borderBottomLeftRadius: 8 },
  handleR: { borderTopRightRadius: 8, borderBottomRightRadius: 8 },
  grip: { width: 3, height: 18, borderRadius: 2, backgroundColor: '#111' },
});
