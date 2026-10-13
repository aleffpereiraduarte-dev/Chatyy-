// [2026-10-13 video-studio] Textos e figurinhas por cima da prévia.
//
// Visibilidade por tempo (start ≤ t < end) vem do relógio em baixa frequência.
// Arrastar + pinçar + girar rodam na UI thread (Reanimated + Gesture Handler);
// o JS só recebe a geometria final (x/y normalizados, scale, rotation em graus).
// Soltar sobre a lixeira (centro-baixo da tela) apaga.
//
// Convenção de tamanho (o render do servidor deve seguir a mesma):
//   texto   : fonte = TEXT_BASE · canvas.w · scale   (TEXT_BASE = 0.065)
//   figurinha: largura = STICKER_BASE · canvas.w · scale (STICKER_BASE = 0.32)
import React, { memo, useMemo, useRef, useState, useEffect } from 'react';
import { View, Text, StyleSheet, Platform, PanResponder } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Path } from 'react-native-svg';
import { REA_OK, Rea, GH, RAnimated, runOnJS } from './rea';
import { useClockValue } from './EdlPreview';

export const TEXT_BASE = 0.065;
export const STICKER_BASE = 0.32;
const TRASH = 56;

export function fontStyleFor(font) {
  switch (font) {
    case 'modern': return { fontWeight: '300', letterSpacing: 0.6 };
    case 'serif': return { fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', fontStyle: 'italic', fontWeight: '600' };
    case 'mono': return { fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', fontWeight: '600' };
    case 'strong': return { fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.4 };
    default: return { fontWeight: '800' };
  }
}
export function contrastOn(hex) {
  const h = String(hex || '#000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16) || 0;
  const r = (n >> 16) & 255; const g = (n >> 8) & 255; const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#000000' : '#FFFFFF';
}

/** Texto estilizado (também usado no editor de texto). */
export function StyledText({ text, style = {}, fontSize }) {
  const color = style.color || '#FFFFFF';
  const align = style.align || 'center';
  const base = [fontStyleFor(style.font), { fontSize, lineHeight: fontSize * 1.2, textAlign: align }];
  if (style.bg === 'box') {
    return (
      <Text style={[...base, { color: contrastOn(color), backgroundColor: color, paddingHorizontal: fontSize * 0.35, paddingVertical: fontSize * 0.1, borderRadius: fontSize * 0.25, overflow: 'hidden' }]}>
        {text}
      </Text>
    );
  }
  if (style.bg === 'outline') {
    const oc = contrastOn(color);
    const d = Math.max(1, fontSize * 0.06);
    const offs = [[-d, 0], [d, 0], [0, -d], [0, d], [-d, -d], [d, d], [-d, d], [d, -d]];
    return (
      <View>
        {offs.map(([x, y], i) => (
          <Text key={i} style={[...base, StyleSheet.absoluteFill, { color: oc, transform: [{ translateX: x }, { translateY: y }] }]}>{text}</Text>
        ))}
        <Text style={[...base, { color }]}>{text}</Text>
      </View>
    );
  }
  return <Text style={[...base, { color, textShadowColor: 'rgba(0,0,0,0.45)', textShadowRadius: fontSize * 0.12, textShadowOffset: { width: 0, height: 1 } }]}>{text}</Text>;
}

function OverlayBody({ o, W }) {
  if (o.type === 'sticker' && o.sticker_url) {
    const w = STICKER_BASE * W;
    return <Image source={{ uri: o.sticker_url }} style={{ width: w, height: w }} contentFit="contain" autoplay />;
  }
  return <StyledText text={o.text || ' '} style={o.style || {}} fontSize={Math.max(8, TEXT_BASE * W)} />;
}

const clampW = (v, a, b) => { 'worklet'; return Math.max(a, Math.min(b, v)); };

// ─── Item com Reanimated ────────────────────────────────────────────────────
function ReaItem({ o, W, H, editable, selected, onCommit, onTap, onDrag, onDrop }) {
  const tx = Rea.useSharedValue(o.x * W);
  const ty = Rea.useSharedValue(o.y * H);
  const sc = Rea.useSharedValue(o.scale || 1);
  const rot = Rea.useSharedValue(((o.rotation || 0) * Math.PI) / 180);
  const w = Rea.useSharedValue(0);
  const h = Rea.useSharedValue(0);
  const sx = Rea.useSharedValue(0);
  const sy = Rea.useSharedValue(0);
  const ss = Rea.useSharedValue(1);
  const sr = Rea.useSharedValue(0);
  const hot = Rea.useSharedValue(0);
  const id = o.id;

  // Valores externos (undo, edição) → shared values.
  useEffect(() => {
    tx.value = o.x * W; ty.value = o.y * H; sc.value = o.scale || 1; rot.value = ((o.rotation || 0) * Math.PI) / 180;
  }, [o.x, o.y, o.scale, o.rotation, W, H]); // eslint-disable-line react-hooks/exhaustive-deps

  const gesture = useMemo(() => {
    const G = GH.Gesture;
    const commit = () => {
      'worklet';
      runOnJS(onCommit)(id, tx.value / W, ty.value / H, sc.value, (rot.value * 180) / Math.PI);
    };
    const pan = G.Pan().enabled(editable).averageTouches(true)
      .onStart(() => { 'worklet'; sx.value = tx.value; sy.value = ty.value; hot.value = 0; runOnJS(onDrag)(true, false); })
      .onUpdate((e) => {
        'worklet';
        tx.value = sx.value + e.translationX;
        ty.value = sy.value + e.translationY;
        const isHot = (ty.value > H - TRASH * 1.6 && Math.abs(tx.value - W / 2) < TRASH) ? 1 : 0;
        if (isHot !== hot.value) { hot.value = isHot; runOnJS(onDrag)(true, isHot === 1); }
      })
      .onEnd(() => { 'worklet'; if (!hot.value) commit(); })
      .onFinalize(() => { 'worklet'; const del = hot.value === 1; hot.value = 0; runOnJS(onDrop)(id, del); });
    const pinch = G.Pinch().enabled(editable)
      .onStart(() => { 'worklet'; ss.value = sc.value; })
      .onUpdate((e) => { 'worklet'; sc.value = clampW(ss.value * e.scale, 0.25, 6); })
      .onEnd(() => { 'worklet'; commit(); });
    const rotation = G.Rotation().enabled(editable)
      .onStart(() => { 'worklet'; sr.value = rot.value; })
      .onUpdate((e) => { 'worklet'; rot.value = sr.value + e.rotation; })
      .onEnd(() => { 'worklet'; commit(); });
    const tap = G.Tap().maxDuration(350).onEnd((_e, ok) => { 'worklet'; if (ok) runOnJS(onTap)(id); });
    return G.Simultaneous(pan, pinch, rotation, tap);
  }, [id, W, H, editable, onCommit, onTap, onDrag, onDrop, tx, ty, sc, rot, sx, sy, ss, sr, hot]);

  const aStyle = Rea.useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value - w.value / 2 },
      { translateY: ty.value - h.value / 2 },
      { rotate: `${rot.value}rad` },
      { scale: sc.value * (hot.value ? 0.55 : 1) },
    ],
    opacity: hot.value ? 0.6 : 1,
  }));

  return (
    <GH.GestureDetector gesture={gesture}>
      <RAnimated.View
        style={[styles.item, { maxWidth: W * 0.94 }, aStyle, selected && editable ? styles.itemSel : null]}
        onLayout={(e) => { w.value = e.nativeEvent.layout.width; h.value = e.nativeEvent.layout.height; }}
      >
        <OverlayBody o={o} W={W} />
      </RAnimated.View>
    </GH.GestureDetector>
  );
}

// ─── Fallback (web / binário sem Reanimated): arrastar com PanResponder ─────
function PlainItem({ o, W, H, editable, selected, onCommit, onTap, onDrag, onDrop }) {
  const [pos, setPos] = useState({ x: o.x * W, y: o.y * H });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const start = useRef({ x: 0, y: 0 });
  const hotRef = useRef(false);
  useEffect(() => { setPos({ x: o.x * W, y: o.y * H }); }, [o.x, o.y, W, H]);
  const pr = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => editable,
    onMoveShouldSetPanResponder: (_e, g) => editable && (Math.abs(g.dx) + Math.abs(g.dy) > 4),
    onPanResponderGrant: () => { start.current = { ...pos }; hotRef.current = false; onDrag(true, false); },
    onPanResponderMove: (_e, g) => {
      const nx = start.current.x + g.dx; const ny = start.current.y + g.dy;
      setPos({ x: nx, y: ny });
      const hot = ny > H - TRASH * 1.6 && Math.abs(nx - W / 2) < TRASH;
      if (hot !== hotRef.current) { hotRef.current = hot; onDrag(true, hot); }
    },
    onPanResponderRelease: (_e, g) => {
      const moved = Math.abs(g.dx) + Math.abs(g.dy) > 4;
      const nx = start.current.x + g.dx; const ny = start.current.y + g.dy;
      if (!moved) { onDrop(o.id, false); onTap(o.id); return; }
      if (!hotRef.current) onCommit(o.id, nx / W, ny / H, o.scale || 1, o.rotation || 0);
      onDrop(o.id, hotRef.current);
    },
    onPanResponderTerminate: () => onDrop(o.id, false),
  }), [editable, pos, W, H, o.id, o.scale, o.rotation, onCommit, onTap, onDrag, onDrop]);
  return (
    <View
      {...pr.panHandlers}
      onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      style={[styles.item, { maxWidth: W * 0.94 }, selected && editable ? styles.itemSel : null, {
        transform: [{ translateX: pos.x - size.w / 2 }, { translateY: pos.y - size.h / 2 }, { rotate: `${o.rotation || 0}deg` }, { scale: o.scale || 1 }],
      }]}
    >
      <OverlayBody o={o} W={W} />
    </View>
  );
}

const Item = memo(REA_OK ? ReaItem : PlainItem);

function TrashTarget({ hot, W, H }) {
  return (
    <View pointerEvents="none" style={[styles.trash, { left: W / 2 - TRASH / 2, top: H - TRASH - 18 }, hot && styles.trashHot]}>
      <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={hot ? '#000' : '#fff'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
      </Svg>
    </View>
  );
}

/**
 * props: edl, clock, W, H, editable, selectedId, onSelect(id|null), onEdit(id),
 *        onCommit(id, {x,y,scale,rotation}), onDelete(id), onDraggingChange(bool)
 */
export default function OverlayLayer({ edl, clock, W, H, editable, selectedId, onSelect, onEdit, onCommit, onDelete, onDraggingChange }) {
  const overlays = edl?.overlays || [];
  const key = useClockValue(clock, (t) => overlays.filter((o) => t >= o.start && t < o.end).map((o) => o.id).join('|'), 8);
  const [drag, setDrag] = useState({ on: false, hot: false });
  const visibleIds = useMemo(() => new Set(key ? key.split('|') : []), [key]);
  const list = overlays.filter((o) => visibleIds.has(o.id) || (editable && o.id === selectedId));

  const cbs = useRef({});
  cbs.current = { onSelect, onEdit, onCommit, onDelete, onDraggingChange, selectedId };
  const handlers = useMemo(() => ({
    onCommit: (id, x, y, scale, rotation) => cbs.current.onCommit?.(id, {
      x: Math.round(Math.max(0, Math.min(1, x)) * 1000) / 1000,
      y: Math.round(Math.max(0, Math.min(1, y)) * 1000) / 1000,
      scale: Math.round(scale * 1000) / 1000,
      rotation: Math.round(rotation * 10) / 10,
    }),
    onTap: (id) => { if (cbs.current.selectedId === id) cbs.current.onEdit?.(id); else cbs.current.onSelect?.(id); },
    onDrag: (on, hot) => { setDrag({ on, hot }); cbs.current.onDraggingChange?.(on); },
    onDrop: (id, del) => { setDrag({ on: false, hot: false }); cbs.current.onDraggingChange?.(false); if (del) cbs.current.onDelete?.(id); },
  }), []);

  if (!W || !H) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {list.map((o) => (
        <Item key={o.id} o={o} W={W} H={H} editable={!!editable} selected={o.id === selectedId} {...handlers} />
      ))}
      {drag.on && <TrashTarget hot={drag.hot} W={W} H={H} />}
    </View>
  );
}

/** Legendas automáticas na prévia (segmento atual). */
export function CaptionsLayer({ edl, clock, W, H }) {
  const cap = edl?.captions;
  const segs = cap?.enabled ? (cap.segments || []) : [];
  const idx = useClockValue(clock, (t) => segs.findIndex((s) => t >= s.start && t < s.end), 8);
  if (!segs.length || idx < 0 || !segs[idx]) return null;
  const fs = Math.max(10, W * 0.048);
  const st = cap.style === 'box' ? { bg: 'box', color: '#FFFFFF' } : cap.style === 'outline' ? { bg: 'outline', color: '#FFFFFF' } : { bg: 'none', color: '#FFFFFF' };
  return (
    <View pointerEvents="none" style={[styles.captions, { top: H * 0.74, paddingHorizontal: W * 0.08 }]}>
      <StyledText text={segs[idx].text} style={{ ...st, font: 'classic', align: 'center' }} fontSize={fs} />
    </View>
  );
}

const styles = StyleSheet.create({
  item: { position: 'absolute', left: 0, top: 0, padding: 6 },
  itemSel: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)', borderStyle: 'dashed', borderRadius: 6 },
  trash: { position: 'absolute', width: TRASH, height: TRASH, borderRadius: TRASH / 2, backgroundColor: 'rgba(0,0,0,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)', alignItems: 'center', justifyContent: 'center' },
  trashHot: { backgroundColor: '#fff', transform: [{ scale: 1.15 }] },
  captions: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
});
