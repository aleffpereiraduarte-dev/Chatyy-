// [2026-10-08 sticker-maker] Criador de figurinhas — nível WhatsApp.
//
// Fluxo: foto → recorte automático do objeto (services/stickerCutout: no
// aparelho via ExpoStickerCutout quando o binário tem; senão servidor/edge BR)
// → contorno branco, texto (fontes/cores/contorno/fundo), desenho, emoji,
// mover/girar/ampliar com gestos → prévia sobre xadrez → exporta 512×512 com
// transparência → chat_sticker_create(normalize=1) converte p/ WebP ≤ 100 KB →
// entra em "Minhas figurinhas" e (opcional) é enviada na hora.
//
// OTA-SAFE: só RN core + react-native-svg + libs já no binário 2.6.0
// (react-native-view-shot, expo-image-manipulator, expo-file-system). Gestos
// com PanResponder (thread JS) — funciona igual em iOS/Android/web e não
// depende do Reanimated/Worklets estar carregado. Exportação:
//   • nativo: react-native-view-shot (PNG com alfa, 512×512 direto);
//   • web: <canvas> 2D desenhando o MESMO modelo de camadas (sem html2canvas).
//
// UI preto-e-branco, ícones só SVG (sem emoji na interface — emoji só como
// conteúdo da figurinha, escolhido pelo usuário).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, Image, StyleSheet, Platform, Modal, TextInput,
  ActivityIndicator, ScrollView, PanResponder, KeyboardAvoidingView, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Circle, Rect, Defs, Pattern, Line } from 'react-native-svg';
import {
  IconX, IconType, IconPencil, IconUndo, IconTrash, IconRotateCcw, IconRotateCw,
  IconSmile, IconPlus, IconSend, IconCheck,
} from '../Icons';
import { useLanguage } from '../../context/LanguageContext';
import * as api from '../../services/api';
import { cutoutSubject, prepareOnDeviceCutout, ensureLocalFile } from '../../services/stickerCutout';

let captureRefFn = null;
if (Platform.OS !== 'web') {
  try {
    // eslint-disable-next-line global-require
    const vs = require('react-native-view-shot');
    captureRefFn = vs.captureRef || (typeof vs.default === 'function' ? vs.default : null);
  } catch { captureRefFn = null; }
}

const OUT = 512;
const PALETTE = ['#FFFFFF', '#000000', '#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#0A84FF', '#AF52DE', '#FF2D55'];
const BRUSH = [4, 8, 14];
const FONTS = [
  { id: 'bold', ios: 'System', android: 'sans-serif', web: 'Inter, "Helvetica Neue", Arial, sans-serif', weight: '900' },
  { id: 'serif', ios: 'Georgia', android: 'serif', web: 'Georgia, "Times New Roman", serif', weight: '700' },
  { id: 'mono', ios: 'Courier New', android: 'monospace', web: '"Courier New", Courier, monospace', weight: '700' },
  { id: 'hand', ios: 'Chalkboard SE', android: 'casual', web: '"Comic Sans MS", "Chalkboard SE", "Marker Felt", cursive', weight: '700' },
  { id: 'impact', ios: 'AvenirNextCondensed-Heavy', android: 'sans-serif-condensed', web: 'Impact, "Arial Black", sans-serif', weight: Platform.OS === 'ios' ? undefined : '900' },
];
const TEXT_STYLES = ['plain', 'outline', 'bg'];
const EMOJIS = [
  '😂', '🤣', '😍', '🥰', '😘', '😎', '🤩', '🥳', '😭', '😢', '😡', '🤯', '😱', '🤔', '🙄', '😴',
  '🤡', '👻', '💀', '🙈', '👍', '👎', '👏', '🙏', '💪', '🤝', '✌️', '🫶', '❤️', '💔', '🔥', '✨',
  '💯', '⭐', '🎉', '🎂', '🍕', '☕', '🍺', '⚽', '🏆', '🎮', '🎵', '💤', '💬', '❓', '❗', '✅',
  '🐶', '🐱', '🦄', '🌈', '☀️', '🌙', '⚡', '💥', '👑', '💎', '😈', '🤖', '👀', '🫠',
];

function tr(t, key, fb) {
  try { const v = t ? t(key) : ''; return v && v !== key ? v : fb; } catch { return fb; }
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function isLight(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length < 6) return true;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 160;
}
function contrastOf(hex) { return isLight(hex) ? '#000000' : '#FFFFFF'; }
function fontStyle(fontId) {
  const f = FONTS.find((x) => x.id === fontId) || FONTS[0];
  const fam = Platform.OS === 'ios' ? f.ios : Platform.OS === 'android' ? f.android : f.web;
  return f.weight ? { fontFamily: fam, fontWeight: f.weight } : { fontFamily: fam };
}
function ringOffsets(r, n = 16) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2;
    out.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return out;
}
function strokeD(pts) {
  if (!pts || !pts.length) return '';
  if (pts.length === 1) return `M${pts[0][0]} ${pts[0][1]} L${pts[0][0] + 0.1} ${pts[0][1] + 0.1}`;
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i += 1) d += ` L${pts[i][0]} ${pts[i][1]}`;
  return d;
}
let _seq = 0;
function newId() { _seq += 1; return `l${Date.now().toString(36)}${_seq}`; }

// ── gesto genérico: 1 dedo arrasta; 2 dedos = pinça (escala) + giro ─────────
function createTransformResponder(cb) {
  let start = null;
  let last = null;
  let t0 = 0;
  let moved = 0;
  const read = (e, gs) => {
    const ts = (e && e.nativeEvent && e.nativeEvent.touches) || [];
    if (ts.length >= 2) {
      const a = ts[0]; const b = ts[1];
      return {
        n: 2,
        cx: (a.pageX + b.pageX) / 2,
        cy: (a.pageY + b.pageY) / 2,
        dist: Math.hypot(b.pageX - a.pageX, b.pageY - a.pageY),
        ang: Math.atan2(b.pageY - a.pageY, b.pageX - a.pageX),
      };
    }
    const p = ts[0] || (e && e.nativeEvent) || {};
    const px = Number.isFinite(p.pageX) ? p.pageX : (gs ? gs.moveX : 0);
    const py = Number.isFinite(p.pageY) ? p.pageY : (gs ? gs.moveY : 0);
    return { n: 1, cx: px, cy: py, dist: 0, ang: 0 };
  };
  const rebase = (e, gs) => { start = { t: { ...cb.get() }, ...read(e, gs) }; };
  return PanResponder.create({
    onStartShouldSetPanResponder: () => cb.enabled(),
    onMoveShouldSetPanResponder: () => cb.enabled(),
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onPanResponderGrant: (e, gs) => {
      rebase(e, gs);
      last = { cx: start.cx, cy: start.cy, n: start.n };
      t0 = Date.now();
      moved = 0;
      if (cb.begin) cb.begin();
    },
    onPanResponderMove: (e, gs) => {
      if (!start) rebase(e, gs);
      const cur = read(e, gs);
      if (cur.n !== start.n) { rebase(e, gs); last = cur; return; }
      const st = start.t;
      const next = { ...st, x: st.x + (cur.cx - start.cx), y: st.y + (cur.cy - start.cy) };
      if (cur.n === 2 && start.dist > 4) {
        next.s = clamp(st.s * (cur.dist / start.dist), 0.15, 8);
        next.r = st.r + (cur.ang - start.ang);
      }
      moved = Math.max(moved, Math.hypot(cur.cx - start.cx, cur.cy - start.cy));
      last = cur;
      cb.set(next);
      if (cb.move) cb.move(cur);
    },
    onPanResponderRelease: () => {
      const tap = moved < 6 && (Date.now() - t0) < 350;
      const info = last;
      start = null;
      if (cb.end) cb.end(info, tap);
    },
    onPanResponderTerminate: () => { start = null; if (cb.end) cb.end(null, false); },
  });
}

// ── conteúdo de uma camada (texto / emoji) ──────────────────────────────────
function layerMetrics(layer) {
  const size = layer.size;
  if (layer.kind === 'text' && layer.style === 'outline') return { padH: size * 0.12, padV: size * 0.08 };
  if (layer.kind === 'text' && layer.style === 'bg') return { padH: size * 0.35, padV: size * 0.12 };
  return { padH: size * 0.04, padV: 0 };
}

function LayerContent({ layer }) {
  const size = layer.size;
  const lh = Math.round(size * 1.2);
  const { padH, padV } = layerMetrics(layer);
  if (layer.kind === 'emoji') {
    return (
      <View style={{ paddingHorizontal: padH }}>
        <Text style={{ fontSize: size, lineHeight: lh, textAlign: 'center' }} allowFontScaling={false}>{layer.text}</Text>
      </View>
    );
  }
  const fs = fontStyle(layer.font);
  if (layer.style === 'bg') {
    return (
      <View style={{ backgroundColor: layer.color, borderRadius: size * 0.3, paddingHorizontal: padH, paddingVertical: padV }}>
        <Text style={[fs, { color: contrastOf(layer.color), fontSize: size, lineHeight: lh, textAlign: 'center' }]} allowFontScaling={false}>{layer.text}</Text>
      </View>
    );
  }
  if (layer.style === 'outline') {
    const sc = contrastOf(layer.color);
    const r = size * 0.075;
    return (
      <View style={{ paddingHorizontal: padH, paddingVertical: padV }}>
        {ringOffsets(r, 12).map(([dx, dy], i) => (
          <Text
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            style={[fs, { position: 'absolute', left: padH + dx, right: padH - dx, top: padV + dy, color: sc, fontSize: size, lineHeight: lh, textAlign: 'center' }]}
            allowFontScaling={false}
          >
            {layer.text}
          </Text>
        ))}
        <Text style={[fs, { color: layer.color, fontSize: size, lineHeight: lh, textAlign: 'center' }]} allowFontScaling={false}>{layer.text}</Text>
      </View>
    );
  }
  return (
    <View style={{ paddingHorizontal: padH }}>
      <Text
        style={[fs, { color: layer.color, fontSize: size, lineHeight: lh, textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.35)', textShadowRadius: 3, textShadowOffset: { width: 0, height: 1 } }]}
        allowFontScaling={false}
      >
        {layer.text}
      </Text>
    </View>
  );
}

function LayerView({ layer, S, selected, interactive, exporting, onChange, onBegin, onMove, onEnd, onSize, size }) {
  const ref = useRef(null);
  ref.current = { layer, interactive, onChange, onBegin, onMove, onEnd };
  const responder = useMemo(() => createTransformResponder({
    enabled: () => !!ref.current.interactive,
    get: () => { const l = ref.current.layer; return { x: l.x, y: l.y, s: l.s, r: l.r }; },
    set: (tt) => ref.current.onChange(ref.current.layer.id, tt),
    begin: () => ref.current.onBegin(ref.current.layer.id),
    move: (info) => ref.current.onMove(ref.current.layer.id, info),
    end: (info, tap) => ref.current.onEnd(ref.current.layer.id, info, tap),
  }), []);
  const w = size ? size.w : 0;
  const h = size ? size.h : 0;
  return (
    <>
      {/* medidor invisível: largura natural do conteúdo, sem quebra de linha */}
      <View pointerEvents="none" style={styles.measurer}>
        <View
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            onSize(layer.id, Math.ceil(width) + 2, Math.ceil(height));
          }}
        >
          <LayerContent layer={layer} />
        </View>
      </View>
      <View
        {...responder.panHandlers}
        style={{
          position: 'absolute',
          left: S / 2 + layer.x - w / 2,
          top: S / 2 + layer.y - h / 2,
          width: w || undefined,
          height: h || undefined,
          opacity: size ? 1 : 0,
          transform: [{ rotate: `${layer.r}rad` }, { scale: layer.s }],
        }}
      >
        <LayerContent layer={layer} />
        {selected && !exporting ? <View pointerEvents="none" style={styles.selBox} /> : null}
      </View>
    </>
  );
}

// ── exportação web (canvas) ─────────────────────────────────────────────────
function loadHtmlImage(src) {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    if (/^https?:/i.test(src)) {
      try { if (new URL(src).origin !== window.location.origin) img.crossOrigin = 'anonymous'; } catch {}
    }
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function composeOnCanvas({ S, baseUri, base, bw, bh, outline, outlinePx, strokes, layers }) {
  const K = OUT / S;
  const canvas = document.createElement('canvas');
  canvas.width = OUT; canvas.height = OUT;
  const ctx = canvas.getContext('2d');
  if (baseUri && bw > 0 && bh > 0) {
    const img = await loadHtmlImage(baseUri);
    ctx.save();
    ctx.translate(K * (S / 2 + base.x), K * (S / 2 + base.y));
    ctx.rotate(base.r);
    ctx.scale(base.s, base.s);
    const w = bw * K; const h = bh * K;
    if (outline) {
      const tint = document.createElement('canvas');
      tint.width = Math.max(1, Math.ceil(w)); tint.height = Math.max(1, Math.ceil(h));
      const tc = tint.getContext('2d');
      tc.drawImage(img, 0, 0, w, h);
      tc.globalCompositeOperation = 'source-in';
      tc.fillStyle = '#FFFFFF';
      tc.fillRect(0, 0, tint.width, tint.height);
      for (const [dx, dy] of ringOffsets(outlinePx * K)) ctx.drawImage(tint, -w / 2 + dx, -h / 2 + dy, w, h);
    }
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const st of strokes) {
    if (!st.points.length) continue;
    ctx.strokeStyle = st.color;
    ctx.lineWidth = st.width * K;
    ctx.beginPath();
    ctx.moveTo(st.points[0][0] * K, st.points[0][1] * K);
    if (st.points.length === 1) ctx.lineTo(st.points[0][0] * K + 0.1, st.points[0][1] * K + 0.1);
    for (let i = 1; i < st.points.length; i += 1) ctx.lineTo(st.points[i][0] * K, st.points[i][1] * K);
    ctx.stroke();
  }
  for (const l of layers) {
    const size = l.size * K;
    const lh = Math.round(l.size * 1.2) * K;
    const lines = String(l.text || '').split('\n');
    const f = FONTS.find((x) => x.id === l.font) || FONTS[0];
    ctx.save();
    ctx.translate(K * (S / 2 + l.x), K * (S / 2 + l.y));
    ctx.rotate(l.r);
    ctx.scale(l.s, l.s);
    ctx.font = l.kind === 'emoji'
      ? `${size}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`
      : `${f.weight || '700'} ${size}px ${f.web}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const m = layerMetrics(l);
    const tw = Math.max(...lines.map((ln) => ctx.measureText(ln).width), 1);
    const th = lh * lines.length;
    if (l.kind === 'text' && l.style === 'bg') {
      const bwid = tw + m.padH * 2 * K; const bhei = th + m.padV * 2 * K; const rad = l.size * 0.3 * K;
      ctx.fillStyle = l.color;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(-bwid / 2, -bhei / 2, bwid, bhei, rad);
      else ctx.rect(-bwid / 2, -bhei / 2, bwid, bhei);
      ctx.fill();
    }
    lines.forEach((ln, i) => {
      const y = -th / 2 + lh * i + lh / 2;
      if (l.kind === 'text' && l.style === 'outline') {
        ctx.lineJoin = 'round';
        ctx.lineWidth = l.size * 0.15 * K;
        ctx.strokeStyle = contrastOf(l.color);
        ctx.strokeText(ln, 0, y);
      }
      if (l.kind === 'text' && l.style === 'plain') {
        ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 3 * K; ctx.shadowOffsetY = 1 * K;
      }
      ctx.fillStyle = l.kind === 'emoji' ? '#000000' : (l.style === 'bg' ? contrastOf(l.color) : l.color);
      ctx.fillText(ln, 0, y);
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    });
    ctx.restore();
  }
  let blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', 0.9));
  let type = 'image/webp';
  if (!blob || blob.type !== 'image/webp') {
    blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    type = 'image/png';
  }
  return { blob, type };
}

// ── ícones locais (SVG) ─────────────────────────────────────────────────────
function IconScissors({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="6" cy="6" r="3" /><Circle cx="6" cy="18" r="3" />
      <Line x1="20" y1="4" x2="8.12" y2="15.88" /><Line x1="14.47" y1="14.48" x2="20" y2="20" /><Line x1="8.12" y1="8.12" x2="12" y2="12" />
    </Svg>
  );
}
function IconOutline({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 3c4 0 7 3 7 7 0 5-4 11-7 11S5 15 5 10c0-4 3-7 7-7z" />
      <Path d="M12 7c2 0 3.5 1.5 3.5 3.5 0 2.6-2 5.5-3.5 5.5s-3.5-2.9-3.5-5.5C8.5 8.5 10 7 12 7z" strokeDasharray="2 2" />
    </Svg>
  );
}
function IconMinus({ size = 20, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round">
      <Line x1="5" y1="12" x2="19" y2="12" />
    </Svg>
  );
}
function IconReset({ size = 20, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="4" y="4" width="16" height="16" rx="3" /><Path d="M9 12h6M12 9v6" />
    </Svg>
  );
}

function Checker({ S }) {
  const c = Math.max(10, Math.round(S / 24));
  return (
    <Svg width={S} height={S} style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <Pattern id="stkChecker" x="0" y="0" width={c * 2} height={c * 2} patternUnits="userSpaceOnUse">
          <Rect x="0" y="0" width={c * 2} height={c * 2} fill="#2B2B2E" />
          <Rect x="0" y="0" width={c} height={c} fill="#3A3A3E" />
          <Rect x={c} y={c} width={c} height={c} fill="#3A3A3E" />
        </Pattern>
      </Defs>
      <Rect x="0" y="0" width={S} height={S} fill="url(#stkChecker)" />
    </Svg>
  );
}

// ── componente principal ────────────────────────────────────────────────────
export default function StickerMaker(props) {
  if (!props?.visible || !props?.sourceUri) return null;
  return <StickerMakerInner {...props} />;
}

function StickerMakerInner({ sourceUri, onClose, onSaved, onSend, autoCutout = true }) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const S = Math.floor(Math.max(220, Math.min(win.width - 32, win.height * 0.48, 400)));
  const outlinePx = Math.max(3, S * 0.018);

  const [srcUri, setSrcUri] = useState(null);
  const [srcSize, setSrcSize] = useState(null);
  const [cut, setCut] = useState(null); // { uri, w, h }
  const [cutState, setCutState] = useState('idle'); // idle|working|done|none|failed
  const [useCut, setUseCut] = useState(true);
  const [outline, setOutline] = useState(true);
  const [base, setBase] = useState({ x: 0, y: 0, s: 1, r: 0 });
  const [layers, setLayers] = useState([]);
  const [sizes, setSizes] = useState({});
  const [strokes, setStrokes] = useState([]);
  const [tool, setTool] = useState(null); // null|'draw'|'emoji'
  const [penColor, setPenColor] = useState('#FFFFFF');
  const [penSize, setPenSize] = useState(BRUSH[1]);
  const [selectedId, setSelectedId] = useState(null);
  const [textEdit, setTextEdit] = useState(null); // { id|null, text, color, font, style }
  const [dragging, setDragging] = useState(null);
  const [trashHot, setTrashHot] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState(null); // null|'save'|'send'
  const [toast, setToast] = useState(null);
  const [loadErr, setLoadErr] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const captureRef = useRef(null);
  const stageRef = useRef(null);
  const stageWin = useRef({ x: 0, y: 0 });
  const stateRef = useRef({});
  stateRef.current = { base, layers, tool, textEdit, selectedId, strokes, penColor, penSize };
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => { if (aliveRef.current) setToast((cur) => (cur === msg ? null : cur)); }, 3200);
  }, []);

  // ── carga + recorte automático ──
  useEffect(() => {
    let dead = false;
    (async () => {
      prepareOnDeviceCutout();
      const local = await ensureLocalFile(sourceUri);
      if (dead) return;
      if (!local) { setLoadErr(true); return; }
      setSrcUri(local);
      Image.getSize(local, (w, h) => { if (!dead) setSrcSize({ w, h }); }, () => { if (!dead) setLoadErr(true); });
      if (!autoCutout) { setUseCut(false); setOutline(false); return; }
      setCutState('working');
      const r = await cutoutSubject(local);
      if (dead) return;
      if (r.ok) {
        const fin = (w, h) => { if (!dead) { setCut({ uri: r.uri, w, h }); setCutState('done'); setUseCut(true); } };
        if (r.width && r.height) fin(r.width, r.height);
        else Image.getSize(r.uri, fin, () => { if (!dead) { setCutState('failed'); setUseCut(false); setOutline(false); } });
      } else {
        setCutState(r.reason === 'no_subject' ? 'none' : 'failed');
        setUseCut(false);
        setOutline(false);
        showToast(r.reason === 'no_subject'
          ? tr(t, 'stickerMaker.noSubject', 'Não encontramos um objeto nesta foto. Você pode usar a foto inteira.')
          : tr(t, 'stickerMaker.cutFailed', 'Não deu para recortar agora. Usando a foto inteira.'));
      }
    })();
    return () => { dead = true; };
  }, [sourceUri, autoCutout, showToast, t]);

  const baseImg = (useCut && cut) ? { uri: cut.uri, w: cut.w, h: cut.h } : (srcUri && srcSize ? { uri: srcUri, w: srcSize.w, h: srcSize.h } : null);
  const fitBox = useMemo(() => {
    if (!baseImg || !baseImg.w || !baseImg.h) return { bw: 0, bh: 0 };
    const k = (useCut && cut) ? 0.84 : 1;
    const box = S * k;
    if (baseImg.w >= baseImg.h) return { bw: box, bh: box * (baseImg.h / baseImg.w) };
    return { bw: box * (baseImg.w / baseImg.h), bh: box };
  }, [baseImg && baseImg.uri, baseImg && baseImg.w, baseImg && baseImg.h, S, useCut, cut]); // eslint-disable-line react-hooks/exhaustive-deps

  const measureStage = useCallback(() => {
    try {
      stageRef.current?.measureInWindow?.((x, y) => { stageWin.current = { x: x || 0, y: y || 0 }; });
    } catch {}
  }, []);

  // ── gestos da imagem base (quando o toque não cai numa camada) ──
  const baseResponder = useMemo(() => createTransformResponder({
    enabled: () => !stateRef.current.tool && !stateRef.current.textEdit,
    get: () => ({ ...stateRef.current.base }),
    set: (nb) => setBase(nb),
    begin: () => {},
    end: (_info, tap) => { if (tap) setSelectedId(null); },
  }), []);

  // ── desenho ──
  const drawResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => stateRef.current.tool === 'draw',
    onMoveShouldSetPanResponder: () => stateRef.current.tool === 'draw',
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      const { locationX, locationY } = e.nativeEvent;
      const st = stateRef.current;
      setStrokes((prev) => [...prev, { color: st.penColor, width: st.penSize, points: [[locationX, locationY]] }]);
    },
    onPanResponderMove: (e) => {
      const { locationX, locationY } = e.nativeEvent;
      if (!Number.isFinite(locationX) || !Number.isFinite(locationY)) return;
      setStrokes((prev) => {
        if (!prev.length) return prev;
        const lastS = prev[prev.length - 1];
        const lp = lastS.points[lastS.points.length - 1];
        if (lp && Math.hypot(lp[0] - locationX, lp[1] - locationY) < 1.5) return prev;
        const next = prev.slice(0, -1);
        next.push({ ...lastS, points: [...lastS.points, [locationX, locationY]] });
        return next;
      });
    },
  }), []);

  // ── camadas ──
  const onLayerChange = useCallback((id, tt) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, ...tt } : l)));
  }, []);
  const onLayerBegin = useCallback((id) => {
    measureStage();
    setSelectedId(id);
    setDragging(id);
  }, [measureStage]);
  // realce da lixeira durante o arraste (1 dedo sobre a lixeira)
  const isOverTrash = useCallback((info) => {
    if (!info || info.n !== 1) return false;
    const sx = stageWin.current.x; const sy = stageWin.current.y;
    return Math.abs(info.cx - (sx + S / 2)) < 56 && info.cy > sy + S - 70 && info.cy < sy + S + 30;
  }, [S]);
  const onLayerMove = useCallback((_id, info) => {
    const hot = isOverTrash(info);
    setTrashHot((cur) => (cur === hot ? cur : hot));
  }, [isOverTrash]);
  const onLayerEnd = useCallback((id, info, tap) => {
    setDragging(null);
    setTrashHot(false);
    if (tap) {
      const l = stateRef.current.layers.find((x) => x.id === id);
      if (l && l.kind === 'text' && stateRef.current.selectedId === id) {
        setTextEdit({ id: l.id, text: l.text, color: l.color, font: l.font, style: l.style });
      }
      return;
    }
    if (isOverTrash(info)) {
      setLayers((prev) => prev.filter((l) => l.id !== id));
      setSelectedId(null);
    }
  }, [isOverTrash]);
  const onLayerSize = useCallback((id, w, h) => {
    setSizes((prev) => {
      const cur = prev[id];
      if (cur && Math.abs(cur.w - w) < 1 && Math.abs(cur.h - h) < 1) return prev;
      return { ...prev, [id]: { w, h } };
    });
  }, []);

  const addEmoji = useCallback((em) => {
    const id = newId();
    const n = stateRef.current.layers.length;
    setLayers((prev) => [...prev, { id, kind: 'emoji', text: em, size: 72, x: ((n % 3) - 1) * 24, y: -S * 0.22 + (n % 2) * 18, s: 1, r: 0 }]);
    setSelectedId(id);
    setTool(null);
  }, [S]);

  const commitText = useCallback(() => {
    const te = stateRef.current.textEdit;
    if (!te) return;
    const text = String(te.text || '').replace(/\s+$/g, '');
    if (te.id) {
      if (!text.trim()) setLayers((prev) => prev.filter((l) => l.id !== te.id));
      else setLayers((prev) => prev.map((l) => (l.id === te.id ? { ...l, text, color: te.color, font: te.font, style: te.style } : l)));
    } else if (text.trim()) {
      const id = newId();
      setLayers((prev) => [...prev, { id, kind: 'text', text, color: te.color, font: te.font, style: te.style, size: 36, x: 0, y: S * 0.3, s: 1, r: 0 }]);
      setSelectedId(id);
    }
    setTextEdit(null);
  }, [S]);

  // controles de ajuste (camada selecionada ou imagem base) — úteis no desktop
  const nudge = useCallback((fn) => {
    const sid = stateRef.current.selectedId;
    if (sid) setLayers((prev) => prev.map((l) => (l.id === sid ? { ...l, ...fn(l) } : l)));
    else setBase((b) => ({ ...b, ...fn(b) }));
  }, []);
  const deleteSelected = useCallback(() => {
    const sid = stateRef.current.selectedId;
    if (!sid) return;
    setLayers((prev) => prev.filter((l) => l.id !== sid));
    setSelectedId(null);
  }, []);

  const trashVisible = !!dragging && !exporting;

  // ── exportar + salvar ──
  const doExport = useCallback(async () => {
    const st = stateRef.current;
    if (Platform.OS === 'web') {
      const { blob, type } = await composeOnCanvas({
        S, baseUri: baseImg ? baseImg.uri : null, base: st.base, bw: fitBox.bw, bh: fitBox.bh,
        outline: outline && !!baseImg, outlinePx, strokes: st.strokes, layers: st.layers,
      });
      if (!blob) throw new Error('export_failed');
      const name = type === 'image/webp' ? 'sticker.webp' : 'sticker.png';
      let file = blob;
      try { file = new File([blob], name, { type }); } catch { file = { blob, name, type }; }
      return file;
    }
    if (!captureRefFn || !captureRef.current) throw new Error('capture_unavailable');
    setExporting(true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const uri = await captureRefFn(captureRef.current, { format: 'png', quality: 1, result: 'tmpfile', width: OUT, height: OUT });
      return { uri, name: 'sticker.png', type: 'image/png' };
    } finally {
      if (aliveRef.current) setExporting(false);
    }
  }, [S, baseImg, fitBox.bw, fitBox.bh, outline, outlinePx]);

  const finish = useCallback(async (send) => {
    if (busy) return;
    setSelectedId(null);
    setTool(null);
    setBusy(send ? 'send' : 'save');
    try {
      const file = await doExport();
      const firstEmoji = (stateRef.current.layers.find((l) => l.kind === 'emoji') || {}).text || '';
      const r = await api.chatStickerCreate(file, { normalize: true, emoji: firstEmoji });
      const d = (r && (r.data || r)) || {};
      if (!r || r.success === false || !d.url) throw new Error((r && (r.message || r.error)) || 'upload_failed');
      const absUrl = d.abs_url || (/^https?:/i.test(d.url) ? d.url : `https://chatyy.com.br${d.url}`);
      const row = { id: d.id, pack_id: d.pack_id, url: d.url, abs_url: absUrl, emoji: d.emoji || firstEmoji, emoji_tags: d.emoji_tags || '', is_animated: false };
      try { onSaved && onSaved(row); } catch {}
      if (send && onSend) { try { onSend(absUrl, row); } catch {} }
      onClose && onClose({ saved: true, sent: !!send, row });
    } catch (e) {
      if (aliveRef.current) {
        setBusy(null);
        showToast(tr(t, 'stickerMaker.saveFailed', 'Não foi possível salvar a figurinha. Tente de novo.'));
      }
    }
  }, [busy, doExport, onSaved, onSend, onClose, showToast, t]);

  const hasEdits = layers.length > 0 || strokes.length > 0;
  const requestClose = useCallback(() => {
    if (busy) return;
    if (!hasEdits) { onClose && onClose({ saved: false }); return; }
    setTextEdit(null);
    setTool(null);
    setConfirmDiscard(true);
  }, [busy, hasEdits, onClose]);

  const interactive = !tool && !textEdit && !busy;
  const selLayer = layers.find((l) => l.id === selectedId) || null;

  const cutLabel = tr(t, 'stickerMaker.cutout', 'Recortar');
  const cutDisabled = cutState === 'working' || !cut;

  return (
    <Modal visible animationType="slide" onRequestClose={requestClose} statusBarTranslucent transparent={false}>
      <View style={[styles.root, { paddingTop: insets.top + 6, paddingBottom: Math.max(insets.bottom, 10) }]}>
        {/* topo */}
        <View style={styles.topBar}>
          <TouchableOpacity onPress={requestClose} style={styles.roundBtn} accessibilityRole="button" accessibilityLabel={tr(t, 'stickerMaker.close', 'Fechar')} hitSlop={8}>
            <IconX size={22} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1}>{tr(t, 'stickerMaker.title', 'Nova figurinha')}</Text>
          {tool === 'draw' ? (
            <TouchableOpacity onPress={() => setStrokes((p) => p.slice(0, -1))} disabled={!strokes.length} style={[styles.roundBtn, !strokes.length && { opacity: 0.35 }]} accessibilityRole="button" accessibilityLabel={tr(t, 'stickerMaker.undo', 'Desfazer')} hitSlop={8}>
              <IconUndo size={20} color="#fff" />
            </TouchableOpacity>
          ) : <View style={styles.roundBtnGhost} />}
        </View>

        <Text style={styles.hint} numberOfLines={1}>
          {tool === 'draw'
            ? tr(t, 'stickerMaker.drawHint', 'Desenhe com o dedo')
            : tr(t, 'stickerMaker.hint', 'Arraste para mover · pinça para girar e ampliar')}
        </Text>

        {/* palco */}
        <View style={styles.stageWrap}>
          <View
            ref={stageRef}
            onLayout={measureStage}
            style={[styles.stage, { width: S, height: S }]}
          >
            <Checker S={S} />
            <View
              ref={captureRef}
              collapsable={false}
              style={[StyleSheet.absoluteFill, { backgroundColor: 'transparent', overflow: 'hidden' }]}
              {...baseResponder.panHandlers}
            >
              {baseImg && fitBox.bw > 0 ? (
                <View
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    left: S / 2 + base.x - fitBox.bw / 2,
                    top: S / 2 + base.y - fitBox.bh / 2,
                    width: fitBox.bw,
                    height: fitBox.bh,
                    transform: [{ rotate: `${base.r}rad` }, { scale: base.s }],
                  }}
                >
                  {outline ? ringOffsets(outlinePx).map(([dx, dy], i) => (
                    <Image
                      // eslint-disable-next-line react/no-array-index-key
                      key={i}
                      source={{ uri: baseImg.uri }}
                      resizeMode="stretch"
                      style={{ position: 'absolute', left: dx, top: dy, width: fitBox.bw, height: fitBox.bh, tintColor: '#FFFFFF' }}
                    />
                  )) : null}
                  <Image source={{ uri: baseImg.uri }} resizeMode="stretch" style={{ width: fitBox.bw, height: fitBox.bh }} />
                </View>
              ) : null}

              <Svg width={S} height={S} style={StyleSheet.absoluteFill} pointerEvents="none">
                {strokes.map((st, i) => (
                  <Path
                    // eslint-disable-next-line react/no-array-index-key
                    key={i}
                    d={strokeD(st.points)}
                    stroke={st.color}
                    strokeWidth={st.width}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                ))}
              </Svg>

              {layers.map((l) => (
                <LayerView
                  key={l.id}
                  layer={l}
                  S={S}
                  size={sizes[l.id]}
                  selected={l.id === selectedId}
                  interactive={interactive}
                  exporting={exporting}
                  onChange={onLayerChange}
                  onBegin={onLayerBegin}
                  onMove={onLayerMove}
                  onEnd={onLayerEnd}
                  onSize={onLayerSize}
                />
              ))}
            </View>

            {tool === 'draw' ? <View style={StyleSheet.absoluteFill} {...drawResponder.panHandlers} /> : null}

            {trashVisible ? (
              <View pointerEvents="none" style={[styles.trash, trashHot && styles.trashHot]}>
                <IconTrash size={20} color="#fff" />
              </View>
            ) : null}

            {(cutState === 'working' || (!baseImg && !loadErr)) ? (
              <View style={styles.veil} pointerEvents="none">
                <ActivityIndicator color="#fff" />
                <Text style={styles.veilText}>{tr(t, 'stickerMaker.working', 'Recortando o objeto…')}</Text>
              </View>
            ) : null}
            {loadErr ? (
              <View style={styles.veil} pointerEvents="none">
                <Text style={styles.veilText}>{tr(t, 'stickerMaker.loadFailed', 'Não foi possível abrir esta imagem.')}</Text>
              </View>
            ) : null}
          </View>
        </View>

        {/* ajuste fino (camada selecionada ou imagem) */}
        {!tool && !textEdit ? (
          <View style={styles.adjustRow}>
            <TouchableOpacity style={styles.adjBtn} onPress={() => nudge((o) => ({ s: clamp(o.s / 1.12, 0.15, 8) }))} accessibilityLabel={tr(t, 'stickerMaker.smaller', 'Diminuir')} accessibilityRole="button"><IconMinus size={18} /></TouchableOpacity>
            <TouchableOpacity style={styles.adjBtn} onPress={() => nudge((o) => ({ s: clamp(o.s * 1.12, 0.15, 8) }))} accessibilityLabel={tr(t, 'stickerMaker.bigger', 'Aumentar')} accessibilityRole="button"><IconPlus size={18} color="#fff" /></TouchableOpacity>
            <TouchableOpacity style={styles.adjBtn} onPress={() => nudge((o) => ({ r: o.r - Math.PI / 12 }))} accessibilityLabel={tr(t, 'stickerMaker.rotateLeft', 'Girar à esquerda')} accessibilityRole="button"><IconRotateCcw size={18} color="#fff" /></TouchableOpacity>
            <TouchableOpacity style={styles.adjBtn} onPress={() => nudge((o) => ({ r: o.r + Math.PI / 12 }))} accessibilityLabel={tr(t, 'stickerMaker.rotateRight', 'Girar à direita')} accessibilityRole="button"><IconRotateCw size={18} color="#fff" /></TouchableOpacity>
            {selLayer ? (
              <TouchableOpacity style={styles.adjBtn} onPress={deleteSelected} accessibilityLabel={tr(t, 'stickerMaker.delete', 'Apagar')} accessibilityRole="button"><IconTrash size={18} color="#fff" /></TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.adjBtn} onPress={() => setBase({ x: 0, y: 0, s: 1, r: 0 })} accessibilityLabel={tr(t, 'stickerMaker.reset', 'Ajustar')} accessibilityRole="button"><IconReset size={18} /></TouchableOpacity>
            )}
          </View>
        ) : null}

        {/* painel do desenho */}
        {tool === 'draw' ? (
          <View style={styles.panel}>
            <View style={styles.swatchRow}>
              {PALETTE.map((c) => (
                <TouchableOpacity key={c} onPress={() => setPenColor(c)} style={[styles.swatch, { backgroundColor: c }, penColor === c && styles.swatchActive]} accessibilityRole="button" accessibilityLabel={c} hitSlop={4} />
              ))}
            </View>
            <View style={styles.brushRow}>
              {BRUSH.map((b) => (
                <TouchableOpacity key={b} onPress={() => setPenSize(b)} style={[styles.brushBtn, penSize === b && styles.brushBtnActive]} accessibilityRole="button" accessibilityLabel={`${tr(t, 'stickerMaker.brush', 'Pincel')} ${b}`}>
                  <View style={{ width: b + 4, height: b + 4, borderRadius: (b + 4) / 2, backgroundColor: penSize === b ? '#000' : '#fff' }} />
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : null}

        {/* bandeja de emoji */}
        {tool === 'emoji' ? (
          <View style={[styles.panel, { maxHeight: 190 }]}>
            <ScrollView contentContainerStyle={styles.emojiGrid} keyboardShouldPersistTaps="handled">
              {EMOJIS.map((em) => (
                <TouchableOpacity key={em} onPress={() => addEmoji(em)} style={styles.emojiCell} accessibilityRole="button" accessibilityLabel={em}>
                  <Text style={styles.emojiGlyph} allowFontScaling={false}>{em}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        ) : null}

        <View style={{ flex: 1 }} />

        {/* ferramentas */}
        <View style={styles.toolRow}>
          <ToolBtn label={cutLabel} active={useCut && !!cut} disabled={cutDisabled} onPress={() => { setUseCut((v) => !v); setBase({ x: 0, y: 0, s: 1, r: 0 }); }}>
            {cutState === 'working' ? <ActivityIndicator size="small" color="#fff" /> : <IconScissors color={useCut && cut ? '#000' : '#fff'} />}
          </ToolBtn>
          <ToolBtn label={tr(t, 'stickerMaker.outline', 'Contorno')} active={outline} disabled={!baseImg} onPress={() => setOutline((v) => !v)}>
            <IconOutline color={outline ? '#000' : '#fff'} />
          </ToolBtn>
          <ToolBtn label={tr(t, 'stickerMaker.text', 'Texto')} active={!!textEdit} onPress={() => { setTool(null); setTextEdit({ id: null, text: '', color: '#FFFFFF', font: 'bold', style: 'outline' }); }}>
            <IconType size={22} color={textEdit ? '#000' : '#fff'} />
          </ToolBtn>
          <ToolBtn label={tr(t, 'stickerMaker.draw', 'Desenhar')} active={tool === 'draw'} onPress={() => { setSelectedId(null); setTool((v) => (v === 'draw' ? null : 'draw')); }}>
            <IconPencil size={22} color={tool === 'draw' ? '#000' : '#fff'} />
          </ToolBtn>
          <ToolBtn label={tr(t, 'stickerMaker.emoji', 'Emoji')} active={tool === 'emoji'} onPress={() => { setSelectedId(null); setTool((v) => (v === 'emoji' ? null : 'emoji')); }}>
            <IconSmile size={22} color={tool === 'emoji' ? '#000' : '#fff'} />
          </ToolBtn>
        </View>

        {/* ações */}
        <View style={styles.actionRow}>
          {onSend ? (
            <>
              <TouchableOpacity onPress={() => finish(false)} disabled={!!busy || !baseImg} style={[styles.secondaryBtn, (!!busy || !baseImg) && { opacity: 0.5 }]} accessibilityRole="button">
                {busy === 'save' ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.secondaryText}>{tr(t, 'stickerMaker.save', 'Salvar')}</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => finish(true)} disabled={!!busy || !baseImg} style={[styles.primaryBtn, (!!busy || !baseImg) && { opacity: 0.5 }]} accessibilityRole="button">
                {busy === 'send' ? <ActivityIndicator size="small" color="#000" /> : (
                  <>
                    <Text style={styles.primaryText}>{tr(t, 'stickerMaker.send', 'Enviar')}</Text>
                    <IconSend size={16} color="#000" />
                  </>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity onPress={() => finish(false)} disabled={!!busy || !baseImg} style={[styles.primaryBtn, { flex: 1 }, (!!busy || !baseImg) && { opacity: 0.5 }]} accessibilityRole="button">
              {busy ? <ActivityIndicator size="small" color="#000" /> : (
                <>
                  <IconCheck size={16} color="#000" />
                  <Text style={styles.primaryText}>{tr(t, 'stickerMaker.saveSticker', 'Salvar figurinha')}</Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>

        {toast ? (
          <View pointerEvents="none" style={[styles.toast, { bottom: Math.max(insets.bottom, 10) + 150 }]}>
            <Text style={styles.toastText}>{toast}</Text>
          </View>
        ) : null}

        {/* editor de texto */}
        {textEdit ? (
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.textOverlay}>
            <View style={[styles.textTop, { paddingTop: insets.top + 6 }]}>
              <TouchableOpacity
                onPress={() => setTextEdit((te) => (te ? { ...te, style: TEXT_STYLES[(TEXT_STYLES.indexOf(te.style) + 1) % TEXT_STYLES.length] } : te))}
                style={styles.styleBtn}
                accessibilityRole="button"
                accessibilityLabel={tr(t, 'stickerMaker.styleLabel', 'Estilo')}
              >
                <Text style={styles.styleBtnText}>{tr(t, `stickerMaker.style.${textEdit.style}`, textEdit.style === 'bg' ? 'Fundo' : textEdit.style === 'outline' ? 'Contorno' : 'Simples')}</Text>
              </TouchableOpacity>
              <View style={{ flex: 1 }} />
              <TouchableOpacity onPress={commitText} style={styles.doneBtn} accessibilityRole="button">
                <Text style={styles.doneText}>{tr(t, 'stickerMaker.done', 'Concluir')}</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.textCenter}>
              <TextInput
                value={textEdit.text}
                onChangeText={(v) => setTextEdit((te) => (te ? { ...te, text: v.slice(0, 120) } : te))}
                autoFocus
                multiline
                placeholder={tr(t, 'stickerMaker.textPlaceholder', 'Digite aqui')}
                placeholderTextColor="rgba(255,255,255,0.45)"
                style={[
                  fontStyle(textEdit.font),
                  styles.textInput,
                  textEdit.style === 'bg'
                    ? { backgroundColor: textEdit.color, color: contrastOf(textEdit.color), borderRadius: 12, paddingHorizontal: 14 }
                    : { color: textEdit.color },
                ]}
                selectionColor="#fff"
                allowFontScaling={false}
              />
            </View>
            <View style={styles.fontRow}>
              {FONTS.map((f) => (
                <TouchableOpacity
                  key={f.id}
                  onPress={() => setTextEdit((te) => (te ? { ...te, font: f.id } : te))}
                  style={[styles.fontChip, textEdit.font === f.id && styles.fontChipActive]}
                  accessibilityRole="button"
                  accessibilityLabel={`${tr(t, 'stickerMaker.fontLabel', 'Fonte')} ${f.id}`}
                >
                  <Text style={[fontStyle(f.id), { color: textEdit.font === f.id ? '#000' : '#fff', fontSize: 16 }]} allowFontScaling={false}>Aa</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={[styles.swatchRow, { marginBottom: Math.max(insets.bottom, 12) }]}>
              {PALETTE.map((c) => (
                <TouchableOpacity key={c} onPress={() => setTextEdit((te) => (te ? { ...te, color: c } : te))} style={[styles.swatch, { backgroundColor: c }, textEdit.color === c && styles.swatchActive]} accessibilityRole="button" accessibilityLabel={c} hitSlop={4} />
              ))}
            </View>
          </KeyboardAvoidingView>
        ) : null}

        {/* confirmar descarte */}
        {confirmDiscard ? (
          <View style={styles.confirmVeil}>
            <View style={styles.confirmCard}>
              <Text style={styles.confirmTitle}>{tr(t, 'stickerMaker.discardTitle', 'Descartar figurinha?')}</Text>
              <TouchableOpacity onPress={() => { setConfirmDiscard(false); onClose && onClose({ saved: false }); }} style={styles.confirmDanger} accessibilityRole="button">
                <Text style={styles.confirmDangerText}>{tr(t, 'stickerMaker.discard', 'Descartar')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setConfirmDiscard(false)} style={styles.confirmKeep} accessibilityRole="button">
                <Text style={styles.confirmKeepText}>{tr(t, 'stickerMaker.keepEditing', 'Continuar editando')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

function ToolBtn({ onPress, label, active, disabled, children }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} style={[styles.toolBtn, disabled && { opacity: 0.35 }]} accessibilityRole="button" accessibilityLabel={label} hitSlop={4}>
      <View style={[styles.toolIcon, active && styles.toolIconActive]}>{children}</View>
      <Text style={styles.toolLabel} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── escolher a foto de origem (galeria/câmera) ──────────────────────────────
export async function pickStickerSourceImage(source = 'gallery') {
  if (Platform.OS === 'web') {
    if (typeof document === 'undefined') return null;
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/webp,image/gif';
      input.onchange = (e) => {
        const f = e.target.files && e.target.files[0];
        resolve(f ? URL.createObjectURL(f) : null);
      };
      input.click();
    });
  }
  // eslint-disable-next-line global-require
  const ImagePicker = require('expo-image-picker');
  const perm = source === 'camera'
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm || !perm.granted) return null;
  const launch = source === 'camera' ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
  const res = await launch({ mediaTypes: ['images'], quality: 0.9, allowsEditing: false });
  if (!res || res.canceled || !res.assets || !res.assets[0]) return null;
  return res.assets[0].uri;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 48 },
  title: { flex: 1, textAlign: 'center', color: '#fff', fontSize: 17, fontWeight: '700', letterSpacing: 0.2 },
  roundBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.12)' },
  roundBtnGhost: { width: 40, height: 40 },
  hint: { color: 'rgba(255,255,255,0.55)', fontSize: 12, textAlign: 'center', marginTop: 2, marginBottom: 10 },
  stageWrap: { alignItems: 'center' },
  stage: { borderRadius: 18, overflow: 'hidden', backgroundColor: '#2B2B2E' },
  measurer: { position: 'absolute', left: 0, top: 0, width: 4000, opacity: 0, flexDirection: 'row', alignItems: 'flex-start' },
  selBox: { ...StyleSheet.absoluteFillObject, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.9)', borderStyle: 'dashed', borderRadius: 6 },
  trash: { position: 'absolute', bottom: 12, alignSelf: 'center', left: '50%', marginLeft: -24, width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.6)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)' },
  trashHot: { backgroundColor: '#FF3B30', borderColor: '#FF3B30' },
  veil: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)', gap: 10 },
  veilText: { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center', paddingHorizontal: 24 },
  adjustRow: { flexDirection: 'row', justifyContent: 'center', gap: 10, marginTop: 12 },
  adjBtn: { width: 40, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.1)' },
  panel: { marginTop: 12, marginHorizontal: 16, paddingVertical: 10, paddingHorizontal: 8, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.08)' },
  swatchRow: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 10 },
  swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)' },
  swatchActive: { borderColor: '#fff', transform: [{ scale: 1.18 }] },
  brushRow: { flexDirection: 'row', justifyContent: 'center', gap: 14, marginTop: 10 },
  brushBtn: { width: 40, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.1)' },
  brushBtnActive: { backgroundColor: '#fff' },
  emojiGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  emojiCell: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  emojiGlyph: { fontSize: 28 },
  toolRow: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 8, marginBottom: 12 },
  toolBtn: { alignItems: 'center', minWidth: 60 },
  toolIcon: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.12)' },
  toolIconActive: { backgroundColor: '#fff' },
  toolLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 11, marginTop: 5, fontWeight: '600' },
  actionRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 16 },
  secondaryBtn: { flex: 1, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
  secondaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  primaryBtn: { flex: 1.4, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', flexDirection: 'row', gap: 8 },
  primaryText: { color: '#000', fontSize: 16, fontWeight: '800' },
  toast: { position: 'absolute', left: 24, right: 24, alignItems: 'center' },
  toastText: { color: '#000', backgroundColor: '#fff', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, fontSize: 13, fontWeight: '600', overflow: 'hidden', textAlign: 'center' },
  textOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.9)' },
  textTop: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingBottom: 8 },
  styleBtn: { paddingHorizontal: 14, height: 36, borderRadius: 18, borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)', alignItems: 'center', justifyContent: 'center' },
  styleBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  doneBtn: { paddingHorizontal: 18, height: 36, borderRadius: 18, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  doneText: { color: '#000', fontSize: 14, fontWeight: '800' },
  textCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  textInput: { fontSize: 34, textAlign: 'center', minWidth: 120, maxWidth: '100%', paddingVertical: 6, borderWidth: 0, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null) },
  fontRow: { flexDirection: 'row', justifyContent: 'center', gap: 10, marginBottom: 12 },
  fontChip: { width: 48, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
  fontChipActive: { backgroundColor: '#fff', borderColor: '#fff' },
  confirmVeil: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 32 },
  confirmCard: { width: '100%', maxWidth: 340, backgroundColor: '#1C1C1E', borderRadius: 18, padding: 18, gap: 10 },
  confirmTitle: { color: '#fff', fontSize: 17, fontWeight: '700', textAlign: 'center', marginBottom: 6 },
  confirmDanger: { height: 46, borderRadius: 23, backgroundColor: '#FF3B30', alignItems: 'center', justifyContent: 'center' },
  confirmDangerText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  confirmKeep: { height: 46, borderRadius: 23, borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)', alignItems: 'center', justifyContent: 'center' },
  confirmKeepText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
