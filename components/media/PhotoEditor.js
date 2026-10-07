// [2026-10-08 photo-editor] Editor de foto antes de enviar — nível WhatsApp.
//
// Ferramentas: recorte (livre + proporções, girar 90°), desenho (cores,
// 3 espessuras, desfazer) e texto (arrastar / pinça p/ escalar / girar,
// arrastar até a lixeira p/ apagar). UI preto-e-branco, ícones só SVG.
//
// Motor — SÓ libs que já estão no binário runtime 2.6.0 (zero dep nova):
//   • expo-image-manipulator: normaliza (EXIF + teto 3072px), recorta e gira.
//     As operações geométricas são guardadas como lista e re-aplicadas SEMPRE
//     a partir do original normalizado (1 encode por operação, sem perda
//     acumulada de JPEG).
//   • react-native-gesture-handler + reanimated 4: todos os gestos rodam na
//     UI thread (traço do pincel via useAnimatedProps no `d` do Path SVG,
//     moldura de recorte, arrastar/escalar/girar texto). JS só recebe o
//     resultado no fim do gesto.
//   • react-native-view-shot: achata imagem + traços + textos num JPEG
//     (resolução = tamanho na tela × pixelRatio, ~1100-1300px de largura).
//     Sem overlays (só recorte/giro) a saída é o JPEG do manipulator em
//     resolução cheia (até 3072px).
//
// Saída: onDone(uri) — file:// JPEG (ou null = sem alterações). O
// MediaPreview grava em `edits[idx]` e o envio segue o caminho normal
// (handleSendPress → onSend → mediaSendQueue.enqueueMedia).
//
// OTA SAFETY: igual ao SwipeReplyRow — só liga quando utils/threadKeyboard
// já carregou Reanimated/Worklets neste binário (KEYBOARD_CONTROLLER_ACTIVE).
// Fora disso (web / binário antigo) PHOTO_EDITOR_AVAILABLE=false e o botão
// "Editar" nem aparece.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, Image, StyleSheet, Platform, Modal, TextInput,
  ActivityIndicator, KeyboardAvoidingView, ScrollView, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { IconX, IconCheck, IconCrop, IconPencil, IconType, IconUndo, IconRotateCcw, IconTrash } from '../Icons';
import { useLanguage } from '../../context/LanguageContext';
import { KEYBOARD_CONTROLLER_ACTIVE } from '../../utils/threadKeyboard';

let Rea = null;
let GH = null;
let captureRefFn = null;
let IM = null;
if (Platform.OS !== 'web' && KEYBOARD_CONTROLLER_ACTIVE) {
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
if (Platform.OS !== 'web') {
  try {
    // eslint-disable-next-line global-require
    const vs = require('react-native-view-shot');
    captureRefFn = vs.captureRef || (typeof vs.default === 'function' ? vs.default : null);
  } catch { captureRefFn = null; }
  try {
    // eslint-disable-next-line global-require
    IM = require('expo-image-manipulator');
  } catch { IM = null; }
}

export const PHOTO_EDITOR_AVAILABLE = !!(
  Rea && Rea.default && Rea.useSharedValue && Rea.useAnimatedStyle && Rea.useAnimatedProps
  && Rea.withSpring && Rea.withTiming && Rea.runOnJS
  && GH && GH.Gesture && GH.GestureDetector && GH.GestureHandlerRootView
  && IM && IM.manipulateAsync && IM.SaveFormat
);
// Desenho/texto precisam do view-shot para achatar; sem ele só recorte/giro.
export const PHOTO_EDITOR_CAN_OVERLAY = PHOTO_EDITOR_AVAILABLE && typeof captureRefFn === 'function';

// Worklet helpers: capture FUNCTIONS, never the module object.
const runOnJS = Rea ? Rea.runOnJS : null;
const withSpring = Rea ? Rea.withSpring : null;
const withTiming = Rea ? Rea.withTiming : null;
const RAnimated = Rea ? Rea.default : null;
const AnimatedPath = (RAnimated && RAnimated.createAnimatedComponent) ? RAnimated.createAnimatedComponent(Path) : null;

const MAX_SIDE = 3072;
const PAD = 22;            // folga em volta da imagem (alças do recorte)
const MIN_CROP = 64;       // lado mínimo da moldura (px de tela)
const HANDLE_HIT = 30;
const SPRING = { damping: 22, stiffness: 240, mass: 0.8 };
const PALETTE = ['#FFFFFF', '#000000', '#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#0A84FF', '#AF52DE'];
const PEN_SIZES = [4, 8, 14];
const TEXT_BASE_DP = 30;
const RATIOS = [
  { key: 'free', label: null, r: 0 },
  { key: 'orig', label: null, r: -1 },
  { key: '1:1', label: '1:1', r: 1 },
  { key: '4:3', label: '4:3', r: 4 / 3 },
  { key: '3:4', label: '3:4', r: 3 / 4 },
  { key: '16:9', label: '16:9', r: 16 / 9 },
  { key: '9:16', label: '9:16', r: 9 / 16 },
];

function clampW(v, lo, hi) {
  'worklet';
  return v < lo ? lo : (v > hi ? hi : v);
}

function ptsToD(pts) {
  if (!pts || pts.length < 2) return '';
  let d = `M${pts[0]} ${pts[1]}`;
  if (pts.length === 2) return `${d} L${pts[0] + 0.1} ${pts[1]}`;
  for (let i = 2; i < pts.length; i += 2) d += ` L${pts[i]} ${pts[i + 1]}`;
  return d;
}

function mapPts(pts, fn) {
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    const p = fn(pts[i], pts[i + 1]);
    out[i] = p[0];
    out[i + 1] = p[1];
  }
  return out;
}

function fitRatio(imgRect, r) {
  const { x, y, w, h } = imgRect;
  if (!r || r <= 0) return { x, y, w, h };
  let nw = w;
  let nh = w / r;
  if (nh > h) { nh = h; nw = h * r; }
  return { x: x + (w - nw) / 2, y: y + (h - nh) / 2, w: nw, h: nh };
}

// Contraste do texto sobre fundo colorido (modo "caixa").
function onColor(hex) {
  const c = (hex || '#000000').replace('#', '');
  const r = parseInt(c.substring(0, 2), 16) || 0;
  const g = parseInt(c.substring(2, 4), 16) || 0;
  const b = parseInt(c.substring(4, 6), 16) || 0;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#000000' : '#FFFFFF';
}

// ─────────────────────────────────────────────────────────────────────────
// Desenho (UI thread): o traço vivo é um Path animado; no fim do gesto os
// pontos (px da imagem) vão para o JS uma única vez.
// ─────────────────────────────────────────────────────────────────────────
function DrawLayer({ k, imgW, imgH, dispW, dispH, color, sizeDp, resetKey, onStroke }) {
  const d = Rea.useSharedValue('M-10 -10');
  const pts = Rea.useSharedValue([]);
  const lx = Rea.useSharedValue(0);
  const ly = Rea.useSharedValue(0);

  // Commit (ou desfazer) → o traço oficial já está no SVG de baixo; limpa o vivo.
  useEffect(() => { d.set('M-10 -10'); }, [resetKey, d]);

  const gesture = useMemo(() => GH.Gesture.Pan()
    .minDistance(0)
    .maxPointers(1)
    .onBegin((e) => {
      'worklet';
      const x = e.x / k;
      const y = e.y / k;
      lx.set(e.x);
      ly.set(e.y);
      pts.set([x, y]);
      d.set(`M${x} ${y} L${x + 0.1} ${y}`);
    })
    .onUpdate((e) => {
      'worklet';
      const ddx = e.x - lx.get();
      const ddy = e.y - ly.get();
      if (ddx * ddx + ddy * ddy < 2.25) return; // < 1.5px de tela: ignora
      lx.set(e.x);
      ly.set(e.y);
      const x = e.x / k;
      const y = e.y / k;
      pts.modify((arr) => { 'worklet'; arr.push(x, y); return arr; });
      d.set(`${d.get()} L${x} ${y}`);
    })
    .onFinalize(() => {
      'worklet';
      const arr = pts.get();
      if (arr && arr.length >= 2) runOnJS(onStroke)(arr.slice());
      pts.set([]);
    }), [k, onStroke, d, pts, lx, ly]);

  const animatedProps = Rea.useAnimatedProps(() => ({ d: d.get() }));
  const widthPx = sizeDp / (k || 1);

  return (
    <GH.GestureDetector gesture={gesture}>
      <View style={[StyleSheet.absoluteFill, { width: dispW, height: dispH }]} collapsable={false}>
        <Svg width={dispW} height={dispH} viewBox={`0 0 ${imgW} ${imgH}`} pointerEvents="none">
          <AnimatedPath
            animatedProps={animatedProps}
            stroke={color}
            strokeWidth={widthPx}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </Svg>
      </View>
    </GH.GestureDetector>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Texto: arrastar + pinça + rotação simultâneos (UI thread). Toque = editar.
// Os shared values são a fonte da verdade durante a vida do item; o JS só
// recebe a geometria final (px da imagem). Mudanças geométricas da imagem
// (recorte/giro/desfazer) remontam os itens via `key`.
// ─────────────────────────────────────────────────────────────────────────
function TextItem({ item, k, interactive, trashC, onCommit, onTap, onDrag, onDrop }) {
  const tx = Rea.useSharedValue(item.x * k);
  const ty = Rea.useSharedValue(item.y * k);
  const sc = Rea.useSharedValue(item.scale || 1);
  const rot = Rea.useSharedValue(item.rot || 0);
  const w = Rea.useSharedValue(0);
  const h = Rea.useSharedValue(0);
  const sx = Rea.useSharedValue(0);
  const sy = Rea.useSharedValue(0);
  const ss = Rea.useSharedValue(1);
  const sr = Rea.useSharedValue(0);
  const hot = Rea.useSharedValue(0);
  const id = item.id;

  const gesture = useMemo(() => {
    const G = GH.Gesture;
    const commit = () => {
      'worklet';
      runOnJS(onCommit)(id, tx.get() / k, ty.get() / k, sc.get(), rot.get());
    };
    const HS = 16;
    const pan = G.Pan()
      .hitSlop(HS)
      .averageTouches(true)
      .onStart(() => {
        'worklet';
        sx.set(tx.get());
        sy.set(ty.get());
        hot.set(0);
        runOnJS(onDrag)(true, false);
      })
      .onUpdate((e) => {
        'worklet';
        tx.set(sx.get() + e.translationX);
        ty.set(sy.get() + e.translationY);
        const c = trashC.get();
        let isHot = 0;
        if (c && c.r > 0) {
          const ddx = e.absoluteX - c.x;
          const ddy = e.absoluteY - c.y;
          isHot = (ddx * ddx + ddy * ddy) < c.r * c.r ? 1 : 0;
        }
        if (isHot !== hot.get()) {
          hot.set(isHot);
          runOnJS(onDrag)(true, isHot === 1);
        }
      })
      .onEnd(() => {
        'worklet';
        commit();
      })
      .onFinalize(() => {
        'worklet';
        const del = hot.get() === 1;
        hot.set(0);
        runOnJS(onDrop)(id, del);
      });
    const pinch = G.Pinch()
      .hitSlop(HS)
      .onStart(() => { 'worklet'; ss.set(sc.get()); })
      .onUpdate((e) => { 'worklet'; sc.set(clampW(ss.get() * e.scale, 0.3, 8)); })
      .onEnd(() => { 'worklet'; commit(); });
    const rotation = G.Rotation()
      .hitSlop(HS)
      .onStart(() => { 'worklet'; sr.set(rot.get()); })
      .onUpdate((e) => { 'worklet'; rot.set(sr.get() + e.rotation); })
      .onEnd(() => { 'worklet'; commit(); });
    const tap = G.Tap()
      .hitSlop(HS)
      .maxDuration(400)
      .onEnd((_e, ok) => { 'worklet'; if (ok) runOnJS(onTap)(id); });
    return G.Simultaneous(pan, pinch, rotation, tap);
  }, [id, k, onCommit, onTap, onDrag, onDrop, trashC, tx, ty, sc, rot, sx, sy, ss, sr, hot]);

  const aStyle = Rea.useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.get() - w.get() / 2 },
      { translateY: ty.get() - h.get() / 2 },
      { rotate: `${rot.get()}rad` },
      { scale: sc.get() * (hot.get() ? 0.6 : 1) },
    ],
    opacity: hot.get() ? 0.55 : 1,
  }));

  const fontSize = Math.max(8, (item.fontPx || TEXT_BASE_DP) * k);
  const boxed = !!item.boxed;
  const body = (
    <RAnimated.View
      style={[styles.textItem, aStyle]}
      onLayout={(e) => { w.set(e.nativeEvent.layout.width); h.set(e.nativeEvent.layout.height); }}
      pointerEvents={interactive ? 'auto' : 'none'}
    >
      <Text
        style={[
          styles.textItemText,
          { fontSize, lineHeight: fontSize * 1.18, color: boxed ? onColor(item.color) : item.color },
          boxed ? { backgroundColor: item.color, paddingHorizontal: fontSize * 0.35, paddingVertical: fontSize * 0.12, borderRadius: fontSize * 0.25 } : styles.textShadow,
        ]}
      >
        {item.text}
      </Text>
    </RAnimated.View>
  );
  if (!interactive) return body;
  return <GH.GestureDetector gesture={gesture}>{body}</GH.GestureDetector>;
}

// ─────────────────────────────────────────────────────────────────────────
// Moldura de recorte (UI thread). Coordenadas = px do palco.
// m: 0 nada, 1 mover, 2 TL, 3 TR, 4 BR, 5 BL, 6 T, 7 R, 8 B, 9 L
// ─────────────────────────────────────────────────────────────────────────
function CropLayer({ stageW, stageH, imgRect, ratio, cx, cy, cw, ch }) {
  const m = Rea.useSharedValue(0);
  const s0x = Rea.useSharedValue(0);
  const s0y = Rea.useSharedValue(0);
  const s0w = Rea.useSharedValue(0);
  const s0h = Rea.useSharedValue(0);
  const BL = imgRect.x;
  const BT = imgRect.y;
  const BR = imgRect.x + imgRect.w;
  const BB = imgRect.y + imgRect.h;
  const R = ratio > 0 ? ratio : 0;

  const gesture = useMemo(() => GH.Gesture.Pan()
    .minDistance(0)
    .maxPointers(1)
    .onBegin((e) => {
      'worklet';
      const x = cx.get(); const y = cy.get(); const w = cw.get(); const h = ch.get();
      s0x.set(x); s0y.set(y); s0w.set(w); s0h.set(h);
      const near = (px, py) => Math.abs(e.x - px) < HANDLE_HIT && Math.abs(e.y - py) < HANDLE_HIT;
      let mode = 0;
      if (near(x, y)) mode = 2;
      else if (near(x + w, y)) mode = 3;
      else if (near(x + w, y + h)) mode = 4;
      else if (near(x, y + h)) mode = 5;
      else if (R === 0 && Math.abs(e.y - y) < HANDLE_HIT * 0.7 && e.x > x && e.x < x + w) mode = 6;
      else if (R === 0 && Math.abs(e.x - (x + w)) < HANDLE_HIT * 0.7 && e.y > y && e.y < y + h) mode = 7;
      else if (R === 0 && Math.abs(e.y - (y + h)) < HANDLE_HIT * 0.7 && e.x > x && e.x < x + w) mode = 8;
      else if (R === 0 && Math.abs(e.x - x) < HANDLE_HIT * 0.7 && e.y > y && e.y < y + h) mode = 9;
      else if (e.x > x && e.x < x + w && e.y > y && e.y < y + h) mode = 1;
      m.set(mode);
    })
    .onUpdate((e) => {
      'worklet';
      const mode = m.get();
      if (mode === 0) return;
      const x = s0x.get(); const y = s0y.get(); const w = s0w.get(); const h = s0h.get();
      const dx = e.translationX; const dy = e.translationY;
      if (mode === 1) {
        cx.set(clampW(x + dx, BL, BR - w));
        cy.set(clampW(y + dy, BT, BB - h));
        return;
      }
      const mL = mode === 2 || mode === 5 || mode === 9;
      const mR = mode === 3 || mode === 4 || mode === 7;
      const mT = mode === 2 || mode === 3 || mode === 6;
      const mB = mode === 4 || mode === 5 || mode === 8;
      let l = x; let t = y; let r = x + w; let b = y + h;
      if (R > 0) {
        // Canto com proporção travada: âncora = canto oposto.
        const propW = mL ? (r - (x + dx)) : ((x + w + dx) - l);
        const propH = mT ? (b - (y + dy)) : ((y + h + dy) - t);
        let nw = Math.max(propW, propH * R);
        const maxW = mL ? (r - BL) : (BR - l);
        const maxH = mT ? (b - BT) : (BB - t);
        nw = Math.min(nw, maxW, maxH * R);
        nw = Math.max(nw, Math.min(MIN_CROP, maxW));
        const nh = nw / R;
        if (mL) l = r - nw; else r = l + nw;
        if (mT) t = b - nh; else b = t + nh;
      } else {
        if (mL) l = clampW(x + dx, BL, r - MIN_CROP);
        if (mR) r = clampW(x + w + dx, l + MIN_CROP, BR);
        if (mT) t = clampW(y + dy, BT, b - MIN_CROP);
        if (mB) b = clampW(y + h + dy, t + MIN_CROP, BB);
      }
      cx.set(l); cy.set(t); cw.set(r - l); ch.set(b - t);
    })
    .onFinalize(() => { 'worklet'; m.set(0); }), [BL, BT, BR, BB, R, cx, cy, cw, ch, m, s0x, s0y, s0w, s0h]);

  const dimTop = Rea.useAnimatedStyle(() => ({ height: Math.max(0, cy.get()) }));
  const dimBottom = Rea.useAnimatedStyle(() => ({ top: cy.get() + ch.get() }));
  const dimLeft = Rea.useAnimatedStyle(() => ({ top: cy.get(), height: ch.get(), width: Math.max(0, cx.get()) }));
  const dimRight = Rea.useAnimatedStyle(() => ({ top: cy.get(), height: ch.get(), left: cx.get() + cw.get() }));
  const frame = Rea.useAnimatedStyle(() => ({ left: cx.get(), top: cy.get(), width: cw.get(), height: ch.get() }));

  return (
    <GH.GestureDetector gesture={gesture}>
      <View style={[StyleSheet.absoluteFill, { width: stageW, height: stageH }]}>
        <RAnimated.View pointerEvents="none" style={[styles.dim, { left: 0, right: 0, top: 0 }, dimTop]} />
        <RAnimated.View pointerEvents="none" style={[styles.dim, { left: 0, right: 0, bottom: 0 }, dimBottom]} />
        <RAnimated.View pointerEvents="none" style={[styles.dim, { left: 0 }, dimLeft]} />
        <RAnimated.View pointerEvents="none" style={[styles.dim, { right: 0 }, dimRight]} />
        <RAnimated.View pointerEvents="none" style={[styles.cropFrame, frame]}>
          <View style={[styles.gridV, { left: '33.33%' }]} />
          <View style={[styles.gridV, { left: '66.66%' }]} />
          <View style={[styles.gridH, { top: '33.33%' }]} />
          <View style={[styles.gridH, { top: '66.66%' }]} />
          <View style={[styles.corner, { left: -3, top: -3, borderLeftWidth: 4, borderTopWidth: 4 }]} />
          <View style={[styles.corner, { right: -3, top: -3, borderRightWidth: 4, borderTopWidth: 4 }]} />
          <View style={[styles.corner, { right: -3, bottom: -3, borderRightWidth: 4, borderBottomWidth: 4 }]} />
          <View style={[styles.corner, { left: -3, bottom: -3, borderLeftWidth: 4, borderBottomWidth: 4 }]} />
        </RAnimated.View>
      </View>
    </GH.GestureDetector>
  );
}

function ToolBtn({ onPress, label, active, disabled, children }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[styles.toolBtn, active && styles.toolBtnActive, disabled && { opacity: 0.35 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
    >
      {children}
    </TouchableOpacity>
  );
}

function Swatches({ value, onChange }) {
  return (
    <View style={styles.swatchRow}>
      {PALETTE.map((c) => (
        <TouchableOpacity
          key={c}
          onPress={() => onChange(c)}
          style={[styles.swatch, { backgroundColor: c }, value === c && styles.swatchActive]}
          accessibilityRole="button"
          accessibilityLabel={c}
          hitSlop={4}
        />
      ))}
    </View>
  );
}

export default function PhotoEditor(props) {
  if (!props?.visible || !props?.imageUri || !PHOTO_EDITOR_AVAILABLE) return null;
  return <PhotoEditorInner {...props} />;
}

function PhotoEditorInner({ imageUri, onCancel, onDone, initialTool }) {
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const tx = useCallback((key, fallback) => {
    try {
      const v = t ? t(key) : null;
      return (!v || v === key) ? fallback : v;
    } catch { return fallback; }
  }, [t]);

  const [src, setSrc] = useState(null);           // original normalizado {uri,w,h}
  const [base, setBase] = useState(null);         // atual (com ops) {uri,w,h}
  const [ops, setOps] = useState([]);
  const [strokes, setStrokes] = useState([]);
  const [texts, setTexts] = useState([]);
  const [histLen, setHistLen] = useState(0);
  const [geomVer, setGeomVer] = useState(0);
  const [mode, setMode] = useState('main');       // main | crop | draw
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [penColor, setPenColor] = useState('#FF3B30');
  const [penSize, setPenSize] = useState(PEN_SIZES[1]);
  const [ratioKey, setRatioKey] = useState('free');
  const [textEdit, setTextEdit] = useState(null); // { id|null, text, color, boxed }
  const [dragging, setDragging] = useState(false);
  const [trashHot, setTrashHot] = useState(false);
  const [capturing, setCapturing] = useState(false);

  const canvasRef = useRef(null);
  const trashRef = useRef(null);
  const historyRef = useRef([]);
  const stateRef = useRef({});
  stateRef.current = { ops, base, strokes, texts, src };

  const cropX = Rea.useSharedValue(0);
  const cropY = Rea.useSharedValue(0);
  const cropW = Rea.useSharedValue(0);
  const cropH = Rea.useSharedValue(0);
  const trashC = Rea.useSharedValue({ x: 0, y: 0, r: 0 });

  // ── Carrega + normaliza (EXIF, teto MAX_SIDE) ──
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const fmt = { compress: 0.95, format: IM.SaveFormat.JPEG };
        let r = await IM.manipulateAsync(imageUri, [], fmt);
        if (Math.max(r.width, r.height) > MAX_SIDE) {
          r = await IM.manipulateAsync(r.uri, [{ resize: r.width >= r.height ? { width: MAX_SIDE } : { height: MAX_SIDE } }], fmt);
        }
        if (!alive) return;
        const s = { uri: r.uri, w: r.width, h: r.height };
        setSrc(s);
        setBase(s);
        if (initialTool === 'crop') setMode('crop');
        else if (initialTool === 'draw' && PHOTO_EDITOR_CAN_OVERLAY) setMode('draw');
      } catch (e) {
        console.warn('[PhotoEditor] load failed:', e?.message);
        if (alive) setLoadErr(true);
      }
    })();
    return () => { alive = false; };
  }, [imageUri, initialTool]);

  // ── Geometria de exibição ──
  const k = (base && stage.w > 0 && stage.h > 0)
    ? Math.min((stage.w - PAD * 2) / base.w, (stage.h - PAD * 2) / base.h)
    : 0;
  const dispW = base ? base.w * k : 0;
  const dispH = base ? base.h * k : 0;
  const imgX = (stage.w - dispW) / 2;
  const imgY = (stage.h - dispH) / 2;
  const imgRect = useMemo(() => ({ x: imgX, y: imgY, w: dispW, h: dispH }), [imgX, imgY, dispW, dispH]);

  const ratioValue = useMemo(() => {
    const rr = RATIOS.find((x) => x.key === ratioKey);
    if (!rr) return 0;
    if (rr.r === -1) return base ? base.w / base.h : 0;
    return rr.r;
  }, [ratioKey, base]);

  // Ao entrar no recorte / mudar proporção / mudar a imagem → moldura encaixada.
  const cropShownRef = useRef(false);
  useEffect(() => {
    if (mode !== 'crop' || !(dispW > 0)) { cropShownRef.current = false; return; }
    const f = fitRatio(imgRect, ratioValue);
    if (!cropShownRef.current) {
      // Primeira exibição: posiciona direto (sem "crescer" do canto).
      cropShownRef.current = true;
      cropX.set(f.x); cropY.set(f.y); cropW.set(f.w); cropH.set(f.h);
      return;
    }
    const cfg = { duration: 180 };
    cropX.set(withTiming(f.x, cfg));
    cropY.set(withTiming(f.y, cfg));
    cropW.set(withTiming(f.w, cfg));
    cropH.set(withTiming(f.h, cfg));
  }, [mode, imgRect, ratioValue, dispW, cropX, cropY, cropW, cropH]);

  // ── Histórico (snapshot) ──
  const pushHistory = useCallback(() => {
    const cur = stateRef.current;
    historyRef.current = [...historyRef.current.slice(-29), { ops: cur.ops, base: cur.base, strokes: cur.strokes, texts: cur.texts }];
    setHistLen(historyRef.current.length);
  }, []);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.length || busy) return;
    const last = h[h.length - 1];
    historyRef.current = h.slice(0, -1);
    setHistLen(historyRef.current.length);
    setOps(last.ops);
    setBase(last.base);
    setStrokes(last.strokes);
    setTexts(last.texts);
    setGeomVer((v) => v + 1);
  }, [busy]);

  // Re-aplica TODAS as operações a partir do original (1 encode).
  const runGeom = useCallback(async (nextOps, mapPt, rotDelta) => {
    const cur = stateRef.current;
    if (!cur.src) return;
    setBusy(true);
    try {
      const r = await IM.manipulateAsync(cur.src.uri, nextOps, { compress: 0.92, format: IM.SaveFormat.JPEG });
      pushHistory();
      setOps(nextOps);
      setBase({ uri: r.uri, w: r.width, h: r.height });
      setStrokes(cur.strokes.map((s) => ({ ...s, pts: mapPts(s.pts, mapPt) })));
      setTexts(cur.texts.map((it) => {
        const p = mapPt(it.x, it.y);
        return { ...it, x: p[0], y: p[1], rot: (it.rot || 0) + rotDelta };
      }));
      setGeomVer((v) => v + 1);
    } catch (e) {
      console.warn('[PhotoEditor] manipulate failed:', e?.message);
    } finally {
      setBusy(false);
    }
  }, [pushHistory]);

  const rotateLeft = useCallback(() => {
    const cur = stateRef.current;
    if (busy || !cur.base) return;
    const W = cur.base.w;
    // 90° anti-horário: (x, y) → (y, W − x)
    runGeom([...cur.ops, { rotate: -90 }], (x, y) => [y, W - x], -Math.PI / 2);
  }, [busy, runGeom]);

  const applyCrop = useCallback(async () => {
    const cur = stateRef.current;
    if (busy || !cur.base || !(k > 0)) { setMode('main'); return; }
    const ox = Math.max(0, Math.round((cropX.get() - imgX) / k));
    const oy = Math.max(0, Math.round((cropY.get() - imgY) / k));
    const w = Math.min(cur.base.w - ox, Math.round(cropW.get() / k));
    const h = Math.min(cur.base.h - oy, Math.round(cropH.get() / k));
    const full = ox <= 1 && oy <= 1 && w >= cur.base.w - 2 && h >= cur.base.h - 2;
    if (full || w < 8 || h < 8) { setMode('main'); return; }
    await runGeom([...cur.ops, { crop: { originX: ox, originY: oy, width: w, height: h } }], (x, y) => [x - ox, y - oy], 0);
    setMode('main');
  }, [busy, k, imgX, imgY, cropX, cropY, cropW, cropH, runGeom]);

  // ── Desenho ──
  const onStroke = useCallback((pts) => {
    if (!pts || pts.length < 2 || !(k > 0)) return;
    pushHistory();
    setStrokes((prev) => [...prev, { color: penColor, width: penSize / k, pts }]);
  }, [k, penColor, penSize, pushHistory]);

  // ── Texto ──
  const openNewText = useCallback(() => {
    setMode('main');
    setTextEdit({ id: null, text: '', color: '#FFFFFF', boxed: false });
  }, []);
  const onTextTap = useCallback((id) => {
    const it = stateRef.current.texts.find((x) => x.id === id);
    if (it) setTextEdit({ id, text: it.text, color: it.color, boxed: !!it.boxed });
  }, []);
  const onTextCommit = useCallback((id, x, y, scale, rot) => {
    setTexts((prev) => prev.map((it) => (it.id === id ? { ...it, x, y, scale, rot } : it)));
  }, []);
  // Callbacks ESTÁVEIS: mudar a identidade recria o gesto no meio do arrasto.
  const draggingRef = useRef(false);
  const onTextDrag = useCallback((isDragging, hot) => {
    if (isDragging && !draggingRef.current) {
      draggingRef.current = true;
      setDragging(true);
      // Mede a lixeira depois de renderizar.
      requestAnimationFrame(() => {
        try {
          trashRef.current?.measureInWindow?.((x, y, w, h) => {
            if (w > 0) trashC.set({ x: x + w / 2, y: y + h / 2, r: Math.max(w, h) * 0.9 });
          });
        } catch {}
      });
    }
    setTrashHot(!!hot);
  }, [trashC]);
  const onTextDrop = useCallback((id, del) => {
    draggingRef.current = false;
    setDragging(false);
    setTrashHot(false);
    if (del) {
      pushHistory();
      setTexts((prev) => prev.filter((it) => it.id !== id));
      setGeomVer((v) => v + 1);
    }
  }, [pushHistory]);
  const finishTextEdit = useCallback(() => {
    const te = textEdit;
    setTextEdit(null);
    if (!te || !base || !(k > 0)) return;
    const txt = (te.text || '').trim();
    if (te.id) {
      pushHistory();
      if (!txt) setTexts((prev) => prev.filter((it) => it.id !== te.id));
      else setTexts((prev) => prev.map((it) => (it.id === te.id ? { ...it, text: txt, color: te.color, boxed: te.boxed } : it)));
      setGeomVer((v) => v + 1);
      return;
    }
    if (!txt) return;
    pushHistory();
    setTexts((prev) => [...prev, {
      id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      text: txt, color: te.color, boxed: te.boxed,
      x: base.w / 2, y: base.h / 2, fontPx: TEXT_BASE_DP / k, scale: 1, rot: 0,
    }]);
  }, [textEdit, base, k, pushHistory]);

  // ── Concluir / cancelar ──
  const finish = useCallback(async () => {
    if (busy) return;
    const cur = stateRef.current;
    const hasOverlay = cur.strokes.length > 0 || cur.texts.length > 0;
    if (!hasOverlay) {
      onDone?.(cur.ops.length ? cur.base.uri : null);
      return;
    }
    if (!captureRefFn || !canvasRef.current) {
      onDone?.(cur.ops.length ? cur.base.uri : null);
      return;
    }
    setBusy(true);
    setCapturing(true);
    // Dois frames: some o chrome de seleção antes do snapshot.
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    try {
      const uri = await captureRefFn(canvasRef.current, { format: 'jpg', quality: 0.92, result: 'tmpfile' });
      const u = uri ? String(uri) : '';
      onDone?.(u ? (u.startsWith('/') ? `file://${u}` : u) : null);
    } catch (e) {
      console.warn('[PhotoEditor] capture failed:', e?.message);
      setCapturing(false);
      setBusy(false);
      Alert.alert(tx('photoEditor.saveFailTitle', 'Não foi possível salvar'), tx('photoEditor.saveFailBody', 'Tente de novo.'));
    }
  }, [busy, onDone, tx]);

  const cancel = useCallback(() => {
    if (textEdit) { setTextEdit(null); return; }
    if (mode === 'crop' || mode === 'draw') { setMode('main'); return; }
    if (historyRef.current.length === 0) { onCancel?.(); return; }
    Alert.alert(
      tx('photoEditor.discardTitle', 'Descartar alterações?'),
      '',
      [
        { text: tx('common.cancel', 'Cancelar'), style: 'cancel' },
        { text: tx('photoEditor.discard', 'Descartar'), style: 'destructive', onPress: () => onCancel?.() },
      ],
    );
  }, [mode, textEdit, onCancel, tx]);

  const ready = !!base && k > 0;
  const overlayOk = PHOTO_EDITOR_CAN_OVERLAY;

  return (
    <Modal visible transparent={false} animationType="fade" onRequestClose={cancel} statusBarTranslucent>
      <GH.GestureHandlerRootView style={styles.root}>
        {/* ── Barra superior ── */}
        {mode !== 'crop' && (
          <View style={[styles.topBar, { paddingTop: Math.max(insets.top, 12) + 4 }]}>
            <ToolBtn onPress={cancel} label={tx('common.close', 'Fechar')}>
              <IconX size={24} color="#fff" />
            </ToolBtn>
            <View style={{ flex: 1 }} />
            {histLen > 0 && (
              <ToolBtn onPress={undo} label={tx('photoEditor.undo', 'Desfazer')} disabled={busy}>
                <IconUndo size={21} color="#fff" />
              </ToolBtn>
            )}
            {mode === 'main' && (
              <>
                <ToolBtn onPress={() => setMode('crop')} label={tx('photoEditor.crop', 'Recortar')} disabled={!ready || busy}>
                  <IconCrop size={21} color="#fff" />
                </ToolBtn>
                {overlayOk && (
                  <ToolBtn onPress={openNewText} label={tx('photoEditor.text', 'Texto')} disabled={!ready || busy}>
                    <IconType size={21} color="#fff" />
                  </ToolBtn>
                )}
                {overlayOk && (
                  <ToolBtn onPress={() => setMode('draw')} label={tx('photoEditor.draw', 'Desenhar')} disabled={!ready || busy}>
                    <IconPencil size={21} color="#fff" />
                  </ToolBtn>
                )}
              </>
            )}
            {mode === 'draw' && (
              <ToolBtn onPress={() => setMode('main')} label={tx('photoEditor.done', 'Concluir')} active>
                <IconCheck size={21} color="#000" />
              </ToolBtn>
            )}
          </View>
        )}
        {mode === 'crop' && <View style={{ height: Math.max(insets.top, 12) + 4 }} />}

        {/* ── Palco ── */}
        <View
          style={styles.stage}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            if (Math.abs(width - stage.w) > 0.5 || Math.abs(height - stage.h) > 0.5) setStage({ w: width, h: height });
          }}
        >
          {!ready && !loadErr && <ActivityIndicator size="large" color="#fff" />}
          {loadErr && (
            <Text style={styles.errText}>{tx('photoEditor.loadFail', 'Não foi possível abrir a imagem.')}</Text>
          )}
          {ready && (
            <View
              ref={canvasRef}
              collapsable={false}
              style={[styles.canvas, { left: imgX, top: imgY, width: dispW, height: dispH }]}
            >
              <Image source={{ uri: base.uri }} style={{ width: dispW, height: dispH }} resizeMode="stretch" fadeDuration={0} />
              {strokes.length > 0 && (
                <Svg
                  width={dispW}
                  height={dispH}
                  viewBox={`0 0 ${base.w} ${base.h}`}
                  style={StyleSheet.absoluteFill}
                  pointerEvents="none"
                >
                  {strokes.map((s, i) => (
                    <Path
                      // eslint-disable-next-line react/no-array-index-key
                      key={`s${i}`}
                      d={ptsToD(s.pts)}
                      stroke={s.color}
                      strokeWidth={s.width}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill="none"
                    />
                  ))}
                </Svg>
              )}
              {mode === 'draw' && (
                <DrawLayer
                  k={k}
                  imgW={base.w}
                  imgH={base.h}
                  dispW={dispW}
                  dispH={dispH}
                  color={penColor}
                  sizeDp={penSize}
                  resetKey={`${strokes.length}_${histLen}`}
                  onStroke={onStroke}
                />
              )}
              {texts.map((it) => (
                <TextItem
                  key={`${it.id}_${geomVer}_${Math.round(k * 1000)}`}
                  item={it}
                  k={k}
                  interactive={mode === 'main' && !capturing && !textEdit}
                  trashC={trashC}
                  onCommit={onTextCommit}
                  onTap={onTextTap}
                  onDrag={onTextDrag}
                  onDrop={onTextDrop}
                />
              ))}
            </View>
          )}
          {ready && mode === 'crop' && (
            <CropLayer
              stageW={stage.w}
              stageH={stage.h}
              imgRect={imgRect}
              ratio={ratioValue}
              cx={cropX}
              cy={cropY}
              cw={cropW}
              ch={cropH}
            />
          )}
          {dragging && (
            <View pointerEvents="none" style={styles.trashWrap}>
              <View ref={trashRef} collapsable={false} style={[styles.trash, trashHot && styles.trashHot]}>
                <IconTrash size={24} color={trashHot ? '#000' : '#fff'} />
              </View>
            </View>
          )}
          {busy && ready && (
            <View pointerEvents="none" style={styles.busy}>
              <ActivityIndicator size="small" color="#fff" />
            </View>
          )}
        </View>

        {/* ── Barra inferior ── */}
        <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 12) + 4 }]}>
          {mode === 'main' && (
            <View style={styles.bottomRow}>
              <Text style={styles.hint} numberOfLines={1}>
                {texts.length > 0 ? tx('photoEditor.textHint', 'Arraste o texto até a lixeira para apagar') : ''}
              </Text>
              <TouchableOpacity
                onPress={finish}
                disabled={!ready || busy}
                style={[styles.doneBtn, (!ready || busy) && { opacity: 0.5 }]}
                accessibilityRole="button"
                accessibilityLabel={tx('photoEditor.done', 'Concluir')}
              >
                {busy ? <ActivityIndicator size="small" color="#000" /> : <IconCheck size={24} color="#000" />}
              </TouchableOpacity>
            </View>
          )}
          {mode === 'draw' && (
            <View>
              <Swatches value={penColor} onChange={setPenColor} />
              <View style={styles.sizeRow}>
                {PEN_SIZES.map((sz) => (
                  <TouchableOpacity
                    key={sz}
                    onPress={() => setPenSize(sz)}
                    style={[styles.sizeBtn, penSize === sz && styles.sizeBtnActive]}
                    accessibilityRole="button"
                    accessibilityLabel={`${sz}`}
                  >
                    <View style={{ width: sz + 2, height: sz + 2, borderRadius: (sz + 2) / 2, backgroundColor: penSize === sz ? '#000' : '#fff' }} />
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}
          {mode === 'crop' && (
            <View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.ratioRow}>
                {RATIOS.map((r) => {
                  const label = r.key === 'free' ? tx('photoEditor.ratioFree', 'Livre')
                    : r.key === 'orig' ? tx('photoEditor.ratioOriginal', 'Original') : r.label;
                  const on = ratioKey === r.key;
                  return (
                    <TouchableOpacity
                      key={r.key}
                      onPress={() => setRatioKey(r.key)}
                      style={[styles.chip, on && styles.chipActive]}
                      accessibilityRole="button"
                      accessibilityLabel={label}
                    >
                      <Text style={[styles.chipText, on && styles.chipTextActive]}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              <View style={styles.cropActions}>
                <TouchableOpacity onPress={() => setMode('main')} style={styles.textBtn} accessibilityRole="button">
                  <Text style={styles.textBtnLabel}>{tx('common.cancel', 'Cancelar')}</Text>
                </TouchableOpacity>
                <ToolBtn onPress={rotateLeft} label={tx('photoEditor.rotate', 'Girar')} disabled={busy}>
                  <IconRotateCcw size={22} color="#fff" />
                </ToolBtn>
                <TouchableOpacity onPress={applyCrop} disabled={busy} style={styles.textBtn} accessibilityRole="button">
                  <Text style={[styles.textBtnLabel, { fontWeight: '700' }]}>{tx('photoEditor.done', 'Concluir')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {/* ── Edição de texto ── */}
        {textEdit && (
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.textEditor}
          >
            <View style={[styles.textEditorTop, { paddingTop: Math.max(insets.top, 12) + 4 }]}>
              <TouchableOpacity
                onPress={() => setTextEdit((te) => (te ? { ...te, boxed: !te.boxed } : te))}
                style={[styles.toolBtn, textEdit.boxed && styles.toolBtnActive]}
                accessibilityRole="button"
                accessibilityLabel={tx('photoEditor.textStyle', 'Estilo do texto')}
              >
                <IconType size={20} color={textEdit.boxed ? '#000' : '#fff'} />
              </TouchableOpacity>
              <View style={{ flex: 1 }} />
              <TouchableOpacity onPress={finishTextEdit} style={styles.textBtn} accessibilityRole="button">
                <Text style={[styles.textBtnLabel, { fontWeight: '700' }]}>{tx('photoEditor.done', 'Concluir')}</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.textEditorBody}>
              <TextInput
                value={textEdit.text}
                onChangeText={(v) => setTextEdit((te) => (te ? { ...te, text: v } : te))}
                autoFocus
                multiline
                maxLength={300}
                placeholder={tx('photoEditor.textPlaceholder', 'Digite um texto')}
                placeholderTextColor="rgba(255,255,255,0.45)"
                style={[
                  styles.textInput,
                  textEdit.boxed
                    ? { backgroundColor: textEdit.color, color: onColor(textEdit.color), borderRadius: 8, paddingHorizontal: 10 }
                    : { color: textEdit.color },
                ]}
                textAlign="center"
                selectionColor="#fff"
              />
            </View>
            <View style={{ paddingBottom: 12 }}>
              <Swatches value={textEdit.color} onChange={(c) => setTextEdit((te) => (te ? { ...te, color: c } : te))} />
            </View>
          </KeyboardAvoidingView>
        )}
      </GH.GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 6, gap: 4 },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  canvas: { position: 'absolute', overflow: 'hidden', backgroundColor: '#000' },
  errText: { color: 'rgba(255,255,255,0.75)', fontSize: 14, textAlign: 'center', paddingHorizontal: 32 },
  toolBtn: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  toolBtnActive: { backgroundColor: '#fff' },
  bottomBar: { paddingHorizontal: 14, paddingTop: 10 },
  bottomRow: { flexDirection: 'row', alignItems: 'center' },
  hint: { flex: 1, color: 'rgba(255,255,255,0.55)', fontSize: 12, marginRight: 12 },
  doneBtn: { width: 54, height: 54, borderRadius: 27, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  swatchRow: { flexDirection: 'row', justifyContent: 'center', gap: 12, paddingVertical: 8 },
  swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)' },
  swatchActive: { borderColor: '#fff', transform: [{ scale: 1.2 }] },
  sizeRow: { flexDirection: 'row', justifyContent: 'center', gap: 18, paddingTop: 6 },
  sizeBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },
  sizeBtnActive: { backgroundColor: '#fff', borderColor: '#fff' },
  ratioRow: { gap: 8, paddingHorizontal: 2, paddingBottom: 10 },
  chip: { paddingHorizontal: 14, height: 32, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)', alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: '#fff', borderColor: '#fff' },
  chipText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: '#000' },
  cropActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  textBtn: { paddingHorizontal: 10, paddingVertical: 10 },
  textBtnLabel: { color: '#fff', fontSize: 16 },
  dim: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.6)' },
  cropFrame: { position: 'absolute', borderWidth: 1, borderColor: 'rgba(255,255,255,0.9)' },
  gridV: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.45)' },
  gridH: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.45)' },
  corner: { position: 'absolute', width: 22, height: 22, borderColor: '#fff' },
  textItem: { position: 'absolute', left: 0, top: 0 },
  textItemText: { fontWeight: '700', textAlign: 'center' },
  textShadow: { textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  trashWrap: { position: 'absolute', left: 0, right: 0, bottom: 14, alignItems: 'center' },
  trash: { width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.6)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)' },
  trashHot: { backgroundColor: '#fff', transform: [{ scale: 1.2 }] },
  busy: { position: 'absolute', top: 12, right: 12, width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  textEditor: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.72)' },
  textEditorTop: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10 },
  textEditorBody: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  textInput: { fontSize: 30, fontWeight: '700', minHeight: 50, alignSelf: 'center', maxWidth: '100%', textAlign: 'center' },
});
