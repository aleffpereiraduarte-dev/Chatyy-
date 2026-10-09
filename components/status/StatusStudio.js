// [2026-10-09 status-composer] Estúdio de status — compositor nível Instagram.
//
// Entra depois da câmera (StatusCamera) ou da galeria, ou direto em modo
// texto. Tudo preto & branco premium, ícones SVG (components/Icons), nada de
// emoji na UI, chrome claro/escuro via useTheme (o palco é sempre escuro, como
// no Instagram).
//
//   • Filtros DE VERDADE (14) com prévia ao vivo: deslizar o dedo na foto troca
//     de filtro com a divisória acompanhando o dedo; faixa de miniaturas
//     filtradas; tocar de novo no filtro ativo abre a intensidade.
//     Nativo = Skia (GPU, já no binário 2.6.0); web = canvas. Mesma matriz na
//     prévia e no arquivo final (statusFilters.js).
//   • Ajustes: brilho, contraste, saturação, calor, desbotar (sliders).
//   • Recortar (Original/9:16/4:5/1:1/16:9) e girar 90°.
//   • Texto com 5 estilos, cores, fundo (nenhum/sólido/suave), alinhamento;
//     arrastar, pinça p/ escalar, soltar na lixeira p/ apagar.
//   • Desenhar (cores, 3 espessuras, desfazer), figurinhas (pacotes da loja via
//     StickerPicker), @menção, localização, link.
//   • Inteligente: filtro sugerido pela luz/cor média da foto, "Auto" (1 toque),
//     legendas sugeridas (locais, sem IA nova), público escolhível.
//   • Publicar: achata (view-shot / html2canvas) o que é visual, manda menção e
//     link como figurinhas interativas (meta) e entrega à fila durável
//     (services/statusPublishQueue) → o anel do "Seu status" mostra o progresso.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Dimensions, Platform, TextInput,
  ScrollView, PanResponder, ActivityIndicator, Image, KeyboardAvoidingView, Alert, Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  IconX, IconType, IconSmile, IconBrush, IconCrop, IconSliders, IconSparkles,
  IconRotateCw, IconUndo, IconTrash, IconAtSign, IconMapPin, IconLink, IconGlobe, IconUsers,
  IconStar, IconEyeOff, IconChevronDown, IconImage, IconCamera, IconSend, IconFilter,
} from '../Icons';
import { useTheme } from '../../context/ThemeContext';
import * as api from '../../services/api';
import {
  STATUS_FILTERS, filterById, filterIndex, finalMatrix, compose, adjustMatrix, IDENTITY,
  DEFAULT_ADJUST, ADJUST_KEYS, suggestFilter, autoEnhance, suggestCaptionKeys, stageBackground,
} from './statusFilters';
import {
  filtersAvailable, prepareBase, makeThumb, sampleStats, exportFiltered, captureStage,
  toUploadFile, FilteredStage, FilterThumbs,
} from './studioEngine';
import { TEXT_BG_GRADIENTS } from './textGradients';
import { enqueueStatusPublish } from '../../services/statusPublishQueue';

let StickerPicker = null;
try { StickerPicker = require('../StickerPicker').default; } catch { StickerPicker = null; }

let _Haptics = null;
try { _Haptics = require('expo-haptics'); } catch {}
const tick = () => { try { _Haptics?.selectionAsync?.(); } catch {} };

const WIN = Dimensions.get('window');
const AUDIENCE_KEY = 'status_audience_v1';
const PALETTE = ['#FFFFFF', '#000000', '#9CA3AF', '#EF4444', '#F97316', '#FACC15', '#22C55E', '#14B8A6', '#3B82F6', '#8B5CF6', '#EC4899'];
const FONTS = [
  { id: 'classic', labelKey: 'status.studio.fontClassic' },
  { id: 'modern', labelKey: 'status.studio.fontModern' },
  { id: 'serif', labelKey: 'status.studio.fontSerif' },
  { id: 'mono', labelKey: 'status.studio.fontMono' },
  { id: 'strong', labelKey: 'status.studio.fontStrong' },
];
const ASPECTS = [
  { id: 'orig', labelKey: 'status.studio.aspectOriginal', v: null },
  { id: '9:16', label: '9:16', v: 9 / 16 },
  { id: '4:5', label: '4:5', v: 4 / 5 },
  { id: '1:1', label: '1:1', v: 1 },
  { id: '16:9', label: '16:9', v: 16 / 9 },
];
const BRUSH = [4, 8, 14];

function fontStyleFor(font) {
  switch (font) {
    case 'modern': return { fontWeight: '300', letterSpacing: 0.6 };
    case 'serif': return { fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', fontStyle: 'italic', fontWeight: '600' };
    case 'mono': return { fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', fontWeight: '600' };
    case 'strong': return { fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.4 };
    default: return { fontWeight: '800' };
  }
}
function contrastOn(hex) {
  const h = String(hex || '#000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#000000' : '#FFFFFF';
}

// ─── Slider (PanResponder, funciona no web e no nativo) ─────────────────────
function Slider({ value, min = -1, max = 1, onChange, accent = '#fff', track = 'rgba(255,255,255,0.25)', center = true }) {
  const wRef = useRef(1);
  const startRef = useRef(0);
  const cbRef = useRef(onChange);
  cbRef.current = onChange; // PanResponder estável: recriar no meio do gesto zera o dx
  const clampV = (v) => Math.max(min, Math.min(max, v));
  const pr = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      const x = e.nativeEvent.locationX;
      const v = clampV(min + (x / Math.max(1, wRef.current)) * (max - min));
      startRef.current = v;
      cbRef.current?.(Math.round(v * 100) / 100);
    },
    onPanResponderMove: (_e, g) => {
      const v = clampV(startRef.current + (g.dx / Math.max(1, wRef.current)) * (max - min));
      cbRef.current?.(Math.round(v * 100) / 100);
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [min, max]);
  const pct = (value - min) / (max - min);
  const zeroPct = center ? (0 - min) / (max - min) : 0;
  const fillL = Math.min(pct, zeroPct), fillW = Math.abs(pct - zeroPct);
  return (
    <View
      {...pr.panHandlers}
      onLayout={(e) => { wRef.current = e.nativeEvent.layout.width; }}
      style={{ height: 36, justifyContent: 'center' }}
      hitSlop={{ top: 8, bottom: 8 }}
    >
      <View pointerEvents="none" style={{ height: 3, borderRadius: 2, backgroundColor: track }}>
        <View style={{ position: 'absolute', left: `${fillL * 100}%`, width: `${fillW * 100}%`, height: 3, backgroundColor: accent, borderRadius: 2 }} />
      </View>
      <View pointerEvents="none" style={{
        position: 'absolute', left: `${pct * 100}%`, marginLeft: -11, width: 22, height: 22, borderRadius: 11,
        backgroundColor: accent, borderWidth: 2, borderColor: 'rgba(0,0,0,0.25)',
      }} />
    </View>
  );
}

// ─── Item arrastável (texto/figurinha/menção/local/link) ────────────────────
function Draggable({ item, onChange, onDelete, onTap, onDragState, stageW, stageH, children, disabled }) {
  const [pos, setPos] = useState({ x: item.x, y: item.y, s: item.s || 1 });
  const st = useRef({ x: item.x, y: item.y, s: item.s || 1, d0: 0, s0: 1, moved: false, trash: false, t0: 0 });
  const sizeRef = useRef({ w: 0, h: 0 });
  // Callbacks em ref: o pai re-renderiza durante o arrasto (lixeira) e um
  // PanResponder novo no meio do gesto perderia o dx acumulado.
  const cb = useRef({});
  cb.current = { onChange, onDelete, onTap, onDragState };
  useEffect(() => { setPos({ x: item.x, y: item.y, s: item.s || 1 }); st.current.x = item.x; st.current.y = item.y; st.current.s = item.s || 1; }, [item.x, item.y, item.s]);
  const dist = (touches) => {
    if (!touches || touches.length < 2) return 0;
    const dx = touches[0].pageX - touches[1].pageX, dy = touches[0].pageY - touches[1].pageY;
    return Math.sqrt(dx * dx + dy * dy);
  };
  const pr = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !disabled,
    onMoveShouldSetPanResponder: () => !disabled,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      const s = st.current;
      s.moved = false; s.trash = false; s.t0 = Date.now();
      s.d0 = dist(e.nativeEvent.touches); s.s0 = s.s;
    },
    onPanResponderMove: (e, g) => {
      const s = st.current;
      const touches = e.nativeEvent.touches;
      if (touches && touches.length >= 2) {
        const d = dist(touches);
        if (!s.d0) { s.d0 = d; s.s0 = s.s; }
        const ns = Math.max(0.4, Math.min(4, s.s0 * (d / Math.max(1, s.d0))));
        s.moved = true;
        setPos(p => ({ ...p, s: ns }));
        s.cur = { x: s.x, y: s.y, s: ns };
        return;
      }
      if (Math.abs(g.dx) + Math.abs(g.dy) > 4) s.moved = true;
      if (!s.moved) return;
      const nx = s.x + g.dx, ny = s.y + g.dy;
      const cx = nx + (sizeRef.current.w * (s.cur?.s || s.s)) / 2;
      const overTrash = ny + sizeRef.current.h / 2 > stageH - 90 && Math.abs(cx - stageW / 2) < 70;
      if (overTrash !== s.trash) { s.trash = overTrash; if (overTrash) tick(); }
      cb.current.onDragState?.(true, overTrash);
      s.cur = { x: nx, y: ny, s: s.cur?.s || s.s };
      setPos({ x: nx, y: ny, s: s.cur.s });
    },
    onPanResponderRelease: () => {
      const s = st.current;
      cb.current.onDragState?.(false, false);
      if (!s.moved) { if (Date.now() - s.t0 < 400) cb.current.onTap?.(); return; }
      if (s.trash) { cb.current.onDelete?.(); return; }
      const c = s.cur || { x: s.x, y: s.y, s: s.s };
      s.x = c.x; s.y = c.y; s.s = c.s; s.cur = null;
      cb.current.onChange?.({ x: c.x, y: c.y, s: c.s });
    },
    onPanResponderTerminate: () => { cb.current.onDragState?.(false, false); },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [disabled, stageW, stageH]);
  return (
    <View
      {...pr.panHandlers}
      onLayout={(e) => { sizeRef.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height }; }}
      style={{ position: 'absolute', left: pos.x, top: pos.y, transform: [{ scale: pos.s }] }}
    >
      {children}
    </View>
  );
}

function TextOverlayView({ it }) {
  const bg = it.bg === 'solid' ? it.color : it.bg === 'soft' ? 'rgba(0,0,0,0.45)' : 'transparent';
  const fg = it.bg === 'solid' ? contrastOn(it.color) : it.color;
  return (
    <View style={{ backgroundColor: bg, borderRadius: 8, paddingHorizontal: it.bg === 'none' ? 0 : 10, paddingVertical: it.bg === 'none' ? 0 : 5, maxWidth: WIN.width * 0.85 }}>
      <Text style={[{
        color: fg, fontSize: 28, textAlign: it.align || 'center',
        ...(it.bg === 'none' ? { textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 } : {}),
      }, fontStyleFor(it.font)]}>{it.text}</Text>
    </View>
  );
}
function PillOverlayView({ it }) {
  const Icon = it.kind === 'mention' ? IconAtSign : it.kind === 'link' ? IconLink : IconMapPin;
  const label = it.kind === 'mention' ? (it.username || '') : it.kind === 'link' ? (it.label || it.url) : it.label;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, maxWidth: WIN.width * 0.8 }}>
      <Icon size={16} color="#000" />
      <Text numberOfLines={1} style={{ marginLeft: 6, color: '#000', fontWeight: '800', fontSize: 15, textTransform: it.kind === 'location' ? 'uppercase' : 'none' }}>{label}</Text>
    </View>
  );
}
function StickerOverlayView({ it }) {
  if (it.url) return <Image source={{ uri: it.url }} style={{ width: 120, height: 120 }} resizeMode="contain" />;
  return <Text style={{ fontSize: 84 }}>{it.text}</Text>;
}

function pathD(points) {
  if (!points?.length) return '';
  let d = `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1], p1 = points[i];
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    d += ` Q${p0.x.toFixed(1)} ${p0.y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  return d;
}

function GradientFill({ colors: cs, id }) {
  // pointerEvents none + wrapper: no web um <svg> absoluto fica por cima de
  // irmãos estáticos e roubava o toque do TextInput do status de texto.
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    <Svg width="100%" height="100%" style={StyleSheet.absoluteFill} preserveAspectRatio="none" viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          {cs.map((c, i) => <Stop key={i} offset={cs.length === 1 ? 0 : i / (cs.length - 1)} stopColor={c} />)}
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100" height="100" fill={`url(#${id})`} />
    </Svg>
    </View>
  );
}

let _VideoMod;
function getVideoMod() {
  if (_VideoMod !== undefined) return _VideoMod;
  try { _VideoMod = require('expo-video'); } catch { _VideoMod = null; }
  return _VideoMod;
}
function VideoStage({ uri, width, height }) {
  const V = getVideoMod();
  const player = V.useVideoPlayer(uri, (p) => { try { p.loop = true; p.muted = false; p.play(); } catch {} });
  return <V.VideoView player={player} style={{ width, height }} contentFit="contain" nativeControls={false} />;
}

const blankEdit = () => ({ base: null, src: null, rotate: 0, aspect: null, filterId: 'original', intensity: 1, adjust: { ...DEFAULT_ADJUST }, thumbUri: null, stats: null, suggestion: null, loading: true });
const blankOverlays = () => ({ items: [], paths: [] });

export default function StatusStudio({ visible, seed, onClose, onOpenCamera, user, t, router }) {
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const filtersOn = filtersAvailable();

  const [mode, setMode] = useState('media'); // media | text
  const [items, setItems] = useState([]);    // [{uri,type,width,height}]
  const [idx, setIdx] = useState(0);
  const [edits, setEdits] = useState([]);
  const [ovs, setOvs] = useState([]);
  const [tool, setTool] = useState(null);    // filters|adjust|crop|draw|stickers|audience|textEdit|mention|location|link
  const [caption, setCaption] = useState('');
  const [captionFocus, setCaptionFocus] = useState(false);
  const [audience, setAudience] = useState('all');
  const [exceptList, setExceptList] = useState([]);
  const [publishing, setPublishing] = useState(false);
  const [capturing, setCapturing] = useState(null); // { uri } durante o achatamento
  const [dragInfo, setDragInfo] = useState({ dragging: false, trash: false });
  const [flashName, setFlashName] = useState(null);
  const [swipe, setSwipe] = useState(null); // { dx }
  // texto
  const [textDraft, setTextDraft] = useState(null); // { id?, text, font, color, bg, align }
  // status de texto
  const [txt, setTxt] = useState({ text: '', grad: 0, font: 'classic' });
  // desenho
  const [brush, setBrush] = useState({ color: '#FFFFFF', w: 8 });
  const [liveStroke, setLiveStroke] = useState(null);
  // menção / local / link
  const [contacts, setContacts] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [mentionQ, setMentionQ] = useState('');
  const [locDraft, setLocDraft] = useState('');
  const [locBusy, setLocBusy] = useState(false);
  const [linkDraft, setLinkDraft] = useState({ url: '', label: '' });

  const stageRef = useRef(null);
  const stageOrigin = useRef({ x: 0, y: 0 });
  const captureLoadRef = useRef(null);
  const flashTimer = useRef(null);

  // ── geometria do palco (9:16) ──
  const topBarH = 56;
  const bottomH = 236; // painel de ferramenta + legenda + barra de publicar
  const availH = WIN.height - insets.top - insets.bottom - topBarH - bottomH;
  const stageW = Math.min(WIN.width, Math.max(200, availH) * 9 / 16);
  const stageH = stageW * 16 / 9;

  const cur = items[idx];
  const ed = edits[idx] || null;
  const ov = ovs[idx] || blankOverlays();
  const isVideo = cur?.type === 'video';

  // ── reset ao abrir ──
  useEffect(() => {
    if (!visible) return;
    const its = (seed?.items || []).filter(i => i?.uri);
    setItems(its);
    setIdx(0);
    setEdits(its.map(() => blankEdit()));
    setOvs(its.map(() => blankOverlays()));
    setMode(seed?.mode === 'text' || !its.length ? 'text' : 'media');
    setTool(its.length && its[0].type !== 'video' && filtersAvailable() ? 'filters' : null);
    setCaption('');
    setTextDraft(null);
    setTxt({ text: '', grad: Math.floor(Math.random() * TEXT_BG_GRADIENTS.length), font: 'classic' });
    setPublishing(false);
    setCapturing(null);
    // Público lembrado
    (async () => {
      try { const a = await AsyncStorage.getItem(AUDIENCE_KEY); if (a) setAudience(a); } catch {}
      try {
        const pv = await api.chatPrivacyGet?.();
        if (pv?.success && Array.isArray(pv.data?.status_except)) setExceptList(pv.data.status_except.map(e => String(e || '').toLowerCase()).filter(Boolean));
      } catch {}
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, seed]);

  // ── preparar cada foto: base normalizada, miniatura, análise inteligente ──
  const prepItem = useCallback(async (i, it, opts = {}) => {
    if (!it || it.type === 'video') {
      setEdits(prev => { const n = [...prev]; n[i] = { ...(n[i] || blankEdit()), loading: false }; return n; });
      return;
    }
    try {
      const base = await prepareBase(it.uri, { rotate: opts.rotate || 0, aspect: opts.aspect || null, srcWidth: opts.rotate || opts.aspect ? undefined : it.width, srcHeight: opts.rotate || opts.aspect ? undefined : it.height });
      const thumbUri = await makeThumb(base.uri, 160);
      let stats = null, suggestion = null;
      if (!opts.keepSmart) {
        stats = await sampleStats(thumbUri);
        suggestion = suggestFilter(stats);
      }
      setEdits(prev => {
        const n = [...prev];
        const o = n[i] || blankEdit();
        const initFilter = opts.keepSmart ? o.filterId : (it.filter ? filterById(it.filter).id : o.filterId);
        n[i] = {
          ...o, base, thumbUri, loading: false, rotate: opts.rotate || 0, aspect: opts.aspect || null,
          filterId: initFilter,
          ...(opts.keepSmart ? {} : { stats, suggestion }),
        };
        return n;
      });
    } catch (e) {
      setEdits(prev => { const n = [...prev]; n[i] = { ...(n[i] || blankEdit()), base: { uri: it.uri, width: it.width || 1080, height: it.height || 1920 }, thumbUri: it.uri, loading: false }; return n; });
    }
  }, []);
  useEffect(() => {
    if (!visible) return;
    (seed?.items || []).filter(i => i?.uri).forEach((it, i) => { prepItem(i, it); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, seed]);

  const setEd = useCallback((patch) => {
    setEdits(prev => { const n = [...prev]; n[idx] = { ...(n[idx] || blankEdit()), ...(typeof patch === 'function' ? patch(n[idx] || blankEdit()) : patch) }; return n; });
  }, [idx]);
  const setOv = useCallback((fn) => {
    setOvs(prev => { const n = [...prev]; n[idx] = fn(n[idx] || blankOverlays()); return n; });
  }, [idx]);

  const matrix = useMemo(() => (ed ? finalMatrix(ed.filterId, ed.intensity, ed.adjust) : IDENTITY), [ed]);

  const showFlash = useCallback((id) => {
    setFlashName(id);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashName(null), 900);
  }, []);
  const pickFilter = useCallback((id) => {
    if (!ed) return;
    if (ed.filterId === id && id !== 'original') { setTool(tl => (tl === 'intensity' ? 'filters' : 'intensity')); return; }
    tick();
    setEd({ filterId: id, intensity: 1 });
    showFlash(id);
  }, [ed, setEd, showFlash]);

  // ── deslizar no palco troca de filtro (divisória segue o dedo) ──
  const swipeRef = useRef({ active: false });
  const stagePR = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => filtersOn && mode === 'media' && !isVideo && tool !== 'draw' && !!ed?.base
      && Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.4,
    onPanResponderGrant: () => { swipeRef.current.active = true; },
    onPanResponderMove: (_e, g) => { setSwipe({ dx: g.dx }); },
    onPanResponderRelease: (_e, g) => {
      swipeRef.current.active = false;
      setSwipe(null);
      const i = filterIndex(ed?.filterId);
      const commit = Math.abs(g.dx) > stageW * 0.22 || Math.abs(g.vx) > 0.6;
      if (!commit) return;
      const ni = g.dx < 0 ? Math.min(STATUS_FILTERS.length - 1, i + 1) : Math.max(0, i - 1);
      if (ni !== i) { tick(); setEd({ filterId: STATUS_FILTERS[ni].id, intensity: 1 }); showFlash(STATUS_FILTERS[ni].id); }
    },
    onPanResponderTerminate: () => { swipeRef.current.active = false; setSwipe(null); },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [filtersOn, mode, isVideo, tool, ed, stageW]);

  const swipeView = useMemo(() => {
    if (!swipe || !ed) return null;
    const i = filterIndex(ed.filterId);
    const adj = adjustMatrix(ed.adjust);
    if (swipe.dx < 0 && i < STATUS_FILTERS.length - 1) {
      return { left: matrix, right: compose(STATUS_FILTERS[i + 1].m, adj), split: stageW + swipe.dx };
    }
    if (swipe.dx > 0 && i > 0) {
      return { left: compose(STATUS_FILTERS[i - 1].m, adj), right: matrix, split: swipe.dx };
    }
    return null;
  }, [swipe, ed, matrix, stageW]);

  // ── desenho ──
  const drawPR = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => tool === 'draw',
    onMoveShouldSetPanResponder: () => tool === 'draw',
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      const { pageX, pageY } = e.nativeEvent;
      setLiveStroke({ color: brush.color, w: brush.w, points: [{ x: pageX - stageOrigin.current.x, y: pageY - stageOrigin.current.y }] });
    },
    onPanResponderMove: (e) => {
      const { pageX, pageY } = e.nativeEvent;
      setLiveStroke(s => (s ? { ...s, points: [...s.points, { x: pageX - stageOrigin.current.x, y: pageY - stageOrigin.current.y }] } : s));
    },
    onPanResponderRelease: () => {
      setLiveStroke(s => {
        if (s && s.points.length > 1) setOv(o => ({ ...o, paths: [...o.paths, s] }));
        return null;
      });
    },
  }), [tool, brush, setOv]);

  const measureStage = useCallback(() => {
    try { stageRef.current?.measureInWindow?.((x, y) => { stageOrigin.current = { x, y }; }); } catch {}
  }, []);

  // ── overlays ──
  const addItem = useCallback((it) => {
    // Escalona a posição inicial: itens novos não nascem um em cima do outro.
    setOv(o => {
      const k = o.items.length % 5;
      return { ...o, items: [...o.items, { id: `${Date.now()}${Math.random().toString(36).slice(2, 5)}`, x: stageW * (0.12 + 0.04 * k), y: stageH * (0.22 + 0.13 * k), s: 1, ...it }] };
    });
  }, [setOv, stageW, stageH]);
  const updItem = useCallback((id, patch) => setOv(o => ({ ...o, items: o.items.map(x => (x.id === id ? { ...x, ...patch } : x)) })), [setOv]);
  const delItem = useCallback((id) => setOv(o => ({ ...o, items: o.items.filter(x => x.id !== id) })), [setOv]);

  const openText = useCallback((existing) => {
    setTool('textEdit');
    setTextDraft(existing ? { ...existing } : { text: '', font: 'classic', color: '#FFFFFF', bg: 'none', align: 'center' });
  }, []);
  const commitText = useCallback(() => {
    const d = textDraft;
    setTool(null);
    setTextDraft(null);
    if (!d) return;
    const text = String(d.text || '').trim();
    if (d.id) {
      if (!text) delItem(d.id); else updItem(d.id, { text, font: d.font, color: d.color, bg: d.bg, align: d.align });
    } else if (text) {
      addItem({ kind: 'text', text, font: d.font, color: d.color, bg: d.bg, align: d.align });
    }
  }, [textDraft, addItem, updItem, delItem]);

  const loadContacts = useCallback(async () => {
    if (contacts.length || contactsLoading) return;
    setContactsLoading(true);
    try {
      const r = await api.chatConversations?.();
      const convs = (r?.success && r.data?.conversations) ? r.data.conversations : [];
      const seen = new Set();
      const people = [];
      for (const c of convs) {
        if (c.is_group || c.type === 'group') continue;
        const email = c.other_email || c.email;
        if (!email || seen.has(email)) continue;
        seen.add(email);
        people.push({ email, name: c.name || c.other_name || String(email).split('@')[0] });
      }
      setContacts(people);
    } catch {}
    setContactsLoading(false);
  }, [contacts.length, contactsLoading]);

  const detectLocation = useCallback(async () => {
    setLocBusy(true);
    try {
      const Loc = require('expo-location');
      const perm = await Loc.requestForegroundPermissionsAsync();
      if (perm?.status === 'granted') {
        const pos = await Loc.getCurrentPositionAsync({ accuracy: Loc.Accuracy?.Balanced ?? 3 });
        const geo = await Loc.reverseGeocodeAsync({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        const g = geo?.[0];
        const label = g ? (g.district || g.city || g.subregion || g.region || '') : '';
        if (label) setLocDraft(g.city && g.district && g.city !== g.district ? `${g.district}, ${g.city}` : label);
      }
    } catch {}
    setLocBusy(false);
  }, []);

  // ── inteligente ──
  const applyAuto = useCallback(() => {
    if (!ed) return;
    tick();
    const sug = ed.suggestion || suggestFilter(ed.stats);
    setEd({ adjust: autoEnhance(ed.stats), filterId: sug.id, intensity: 0.85 });
    showFlash(sug.id);
  }, [ed, setEd, showFlash]);
  const captionIdeas = useMemo(() => suggestCaptionKeys(ed?.stats), [ed?.stats]);

  // ── recorte/giro ──
  const reCrop = useCallback(async (patch) => {
    if (!cur || !ed) return;
    const rotate = patch.rotate != null ? patch.rotate : ed.rotate;
    const aspect = patch.aspect !== undefined ? patch.aspect : ed.aspect;
    setEd({ loading: true });
    await prepItem(idx, cur, { rotate, aspect, keepSmart: true });
  }, [cur, ed, idx, prepItem, setEd]);

  // ── público ──
  const chooseAudience = useCallback((a) => {
    setAudience(a);
    try { AsyncStorage.setItem(AUDIENCE_KEY, a); } catch {}
  }, []);
  const audienceMeta = useCallback(() => {
    const m = {};
    if (audience !== 'all') m.privacy = audience;
    if (audience === 'except' && exceptList.length) m.except_emails = exceptList;
    return m;
  }, [audience, exceptList]);

  // ── publicar ──
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const publish = useCallback(async () => {
    if (publishing) return;
    const email = user?.email || '';
    const base = audienceMeta();
    if (mode === 'text') {
      const text = txt.text.trim();
      if (!text) return;
      const g = TEXT_BG_GRADIENTS[txt.grad] || TEXT_BG_GRADIENTS[0];
      const font_style = txt.font === 'serif' ? 'serif' : txt.font === 'mono' ? 'mono' : undefined;
      await enqueueStatusPublish({ email, kind: 'text', content: text, background: `gradient:${g.id}`, meta: { ...base, ...(font_style ? { font_style } : {}) } });
      try { _Haptics?.notificationAsync?.(_Haptics.NotificationFeedbackType?.Success); } catch {}
      onClose?.({ published: true });
      return;
    }
    if (!items.length) return;
    setPublishing(true);
    setTool(null);
    const sx = WIN.width / stageW, sy = WIN.height / stageH; // espaço do viewer (tela cheia)
    try {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const e = edits[i] || blankEdit();
        const o = ovs[i] || blankOverlays();
        const interactive = o.items.filter(x => x.kind === 'mention' || x.kind === 'link');
        const burn = o.items.filter(x => x.kind !== 'mention' && x.kind !== 'link');
        const metaStickers = interactive.map(x => (x.kind === 'mention'
          ? { type: 'mention', id: x.id, username: x.username, email: x.email, x: Math.round(x.x * sx), y: Math.round(x.y * sy) }
          : { type: 'link', id: x.id, url: x.url, label: x.label || undefined, x: Math.round(x.x * sx), y: Math.round(x.y * sy) }));
        const mentions = Array.from(new Set(interactive.filter(x => x.kind === 'mention' && x.email).map(x => x.email)));
        const meta = {
          ...base,
          ...(i === 0 && caption.trim() ? { caption: caption.trim() } : {}),
          ...(e.filterId && e.filterId !== 'original' ? { filter: e.filterId } : {}),
          ...(metaStickers.length ? { stickers: metaStickers.map(({ email: _e, ...rest }) => rest) } : {}),
          ...(mentions.length ? { mentions } : {}),
        };
        if (it.type === 'video') {
          // Vídeo: sem reencode no 2.6.0 (filtro de vídeo = próximo build).
          // Texto/desenho vão como overlays do viewer (meta).
          const texts = burn.filter(x => x.kind === 'text').map(x => ({ text: x.text, x: Math.round(x.x * sx), y: Math.round(x.y * sy), color: x.bg === 'solid' ? contrastOn(x.color) : x.color }));
          const gifs = burn.filter(x => x.kind === 'sticker' && x.url).map(x => ({ type: 'gif', url: x.url, x: Math.round(x.x * sx), y: Math.round(x.y * sy), width: Math.round(120 * (x.s || 1)), height: Math.round(120 * (x.s || 1)) }));
          const paths = o.paths.map(p => ({ color: p.color, points: p.points.map(pt => ({ x: Math.round(pt.x * sx), y: Math.round(pt.y * sy) })) }));
          const vMeta = { ...meta };
          if (texts.length) vMeta.text_overlays = texts;
          if (paths.length) vMeta.draw_paths = paths;
          if (gifs.length) vMeta.stickers = [...(vMeta.stickers || []), ...gifs];
          delete vMeta.filter;
          if (i === 0 && seed?.isBoomerang) vMeta.is_boomerang = true;
          await enqueueStatusPublish({ email, kind: 'video', file: { uri: it.uri, name: 'status.mp4', type: 'video/mp4' }, meta: vMeta, music: i === 0 ? (seed?.music || null) : null });
          continue;
        }
        let eb = e.base;
        if (!eb) { const pb = await prepareBase(it.uri, {}); eb = pb; }
        const m = finalMatrix(e.filterId, e.intensity, e.adjust);
        let out = await exportFiltered(eb, filtersOn ? m : IDENTITY);
        if (burn.length || o.paths.length) {
          // Achata: mostra a imagem final (sem Skia) + overlays visuais no palco.
          // Arma o "carregou" ANTES de trocar o palco (onLoad pode vir rápido).
          const loaded = new Promise((resolve) => { captureLoadRef.current = resolve; setTimeout(resolve, 2500); });
          setIdx(i);
          setCapturing({ uri: out.uri, w: out.width, h: out.height });
          await loaded;
          await new Promise(r => setTimeout(r, Platform.OS === 'web' ? 120 : 80));
          try { out = await captureStage(stageRef, { width: stageW, height: stageH }); } catch (err) { console.warn('[StatusStudio] capture failed', err?.message); }
          setCapturing(null);
        }
        await enqueueStatusPublish({ email, kind: 'image', file: toUploadFile(out, 'status.jpg'), thumbUri: e.thumbUri, meta, music: i === 0 ? (seed?.music || null) : null });
      }
      try { _Haptics?.notificationAsync?.(_Haptics.NotificationFeedbackType?.Success); } catch {}
      onClose?.({ published: true });
    } catch (err) {
      console.warn('[StatusStudio] publish failed', err?.message || err);
      try { Alert.alert(t('common.error'), t('status.publishFailed')); } catch {}
    } finally {
      setPublishing(false);
      setCapturing(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishing, user, audienceMeta, mode, txt, items, edits, ovs, caption, stageW, stageH, filtersOn, onClose, t, seed]);

  // ── adicionar mídia a partir do modo texto / mais fotos ──
  const pickFromGallery = useCallback(async () => {
    try {
      const IP = await import('expo-image-picker');
      if (Platform.OS !== 'web') {
        const perm = await IP.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) return;
      }
      const r = await IP.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, selectionLimit: 10, quality: 1 });
      if (r.canceled || !r.assets?.length) return;
      const add = r.assets.map(a => ({
        uri: a.uri,
        type: (a.type === 'video' || /\.(mp4|mov|m4v|webm)$/i.test(a.uri || '') || String(a.mimeType || '').startsWith('video')) ? 'video' : 'photo',
        width: a.width, height: a.height,
      }));
      const start = itemsRef.current.length;
      const room = Math.max(0, 10 - start);
      const accepted = add.slice(0, room);
      if (!accepted.length) return;
      setItems(prev => [...prev, ...accepted]);
      setEdits(pe => [...pe, ...accepted.map(() => blankEdit())]);
      setOvs(po => [...po, ...accepted.map(() => blankOverlays())]);
      setIdx(start);
      accepted.forEach((it, k) => prepItem(start + k, it));
      setMode('media');
      setTool(accepted[0].type !== 'video' && filtersOn ? 'filters' : null);
    } catch (e) { console.warn('[StatusStudio] gallery', e?.message); }
  }, [prepItem, filtersOn]);

  if (!visible) return null;

  // ─── UI ───────────────────────────────────────────────────────────────────
  const chrome = '#FFFFFF';
  const sheetBg = colors.card || (isDark ? '#141414' : '#FFFFFF');
  const sheetText = colors.text;
  const sheetSub = colors.textSecondary;
  const sheetBorder = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const fName = (id) => t(filterById(id).labelKey);
  const audienceLabel = {
    all: t('status.audience.all'), contacts: t('status.audience.contacts'),
    close_friends: t('status.audience.closeFriends'), except: t('status.audience.except'),
  }[audience] || t('status.audience.all');
  const AudIcon = audience === 'close_friends' ? IconStar : audience === 'contacts' ? IconUsers : audience === 'except' ? IconEyeOff : IconGlobe;

  const GlassBtn = ({ onPress, children, active, label }) => (
    <TouchableOpacity onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}
      style={[st.glass, active && { backgroundColor: '#FFFFFF' }]}>
      {children}
    </TouchableOpacity>
  );

  const renderStageMedia = () => {
    if (mode === 'text') {
      const g = TEXT_BG_GRADIENTS[txt.grad] || TEXT_BG_GRADIENTS[0];
      return (
        <View style={{ width: stageW, height: stageH, alignItems: 'center', justifyContent: 'center' }}>
          <GradientFill colors={g.colors} id={`stg_${g.id}`} />
          <TextInput
            value={txt.text}
            onChangeText={(v) => setTxt(s => ({ ...s, text: v.slice(0, 700) }))}
            placeholder={t('status.studio.textPlaceholder')}
            placeholderTextColor="rgba(255,255,255,0.6)"
            multiline
            autoFocus={Platform.OS !== 'web'}
            style={[{ color: '#FFFFFF', fontSize: txt.text.length > 120 ? 22 : txt.text.length > 50 ? 28 : 34, textAlign: 'center', paddingHorizontal: 24, width: '100%', maxHeight: stageH * 0.8, zIndex: 1 },
              Platform.OS === 'web' ? { outlineStyle: 'none' } : null, fontStyleFor(txt.font)]}
          />
        </View>
      );
    }
    if (!cur) return null;
    if (isVideo) {
      return getVideoMod() ? <VideoStage uri={cur.uri} width={stageW} height={stageH} /> : <Image source={{ uri: cur.uri }} style={{ width: stageW, height: stageH }} resizeMode="contain" />;
    }
    if (capturing) {
      const s = Math.min(stageW / capturing.w, stageH / capturing.h);
      return (
        <Image source={{ uri: capturing.uri }} onLoad={() => captureLoadRef.current?.()}
          style={{ position: 'absolute', width: capturing.w * s, height: capturing.h * s, left: (stageW - capturing.w * s) / 2, top: (stageH - capturing.h * s) / 2 }} />
      );
    }
    if (!ed?.base) return <ActivityIndicator color="#fff" style={{ marginTop: stageH / 2 - 10 }} />;
    return (
      <FilteredStage
        uri={ed.base.uri} imgW={ed.base.width} imgH={ed.base.height} width={stageW} height={stageH}
        matrix={swipeView ? swipeView.left : (filtersOn ? matrix : null)}
        matrixRight={swipeView?.right} split={swipeView?.split}
      />
    );
  };

  const renderOverlays = () => {
    if (mode !== 'media') return null;
    return (
      <>
        {(ov.paths.length > 0 || liveStroke) && (
          <Svg width={stageW} height={stageH} style={StyleSheet.absoluteFill} pointerEvents="none">
            {ov.paths.map((p, i) => <Path key={i} d={pathD(p.points)} stroke={p.color} strokeWidth={p.w} fill="none" strokeLinecap="round" strokeLinejoin="round" />)}
            {liveStroke && <Path d={pathD(liveStroke.points)} stroke={liveStroke.color} strokeWidth={liveStroke.w} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
          </Svg>
        )}
        {ov.items.map((it) => {
          if (capturing && (it.kind === 'mention' || it.kind === 'link')) return null;
          return (
            <Draggable
              key={it.id} item={it} stageW={stageW} stageH={stageH} disabled={tool === 'draw' || !!capturing}
              onChange={(p) => updItem(it.id, p)}
              onDelete={() => delItem(it.id)}
              onDragState={(dragging, trash) => setDragInfo(d => (d.dragging === dragging && d.trash === trash ? d : { dragging, trash }))}
              onTap={() => { if (it.kind === 'text') openText(it); }}
            >
              {it.kind === 'text' ? <TextOverlayView it={it} />
                : it.kind === 'sticker' ? <StickerOverlayView it={it} />
                : <PillOverlayView it={it} />}
            </Draggable>
          );
        })}
      </>
    );
  };

  const filterItems = STATUS_FILTERS.map(f => ({ key: f.id, matrix: compose(f.m, adjustMatrix(ed?.adjust)) }));

  const renderToolPanel = () => {
    if (mode === 'text') {
      return (
        <View style={st.panel}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 14, gap: 10, alignItems: 'center' }}>
            {TEXT_BG_GRADIENTS.map((g, i) => (
              <TouchableOpacity key={g.id} onPress={() => { tick(); setTxt(s => ({ ...s, grad: i })); }} accessibilityLabel={g.id}
                style={[st.gradDot, txt.grad === i && { borderColor: '#FFFFFF', borderWidth: 2.5 }]}>
                <View style={{ flex: 1, borderRadius: 16, overflow: 'hidden' }}><GradientFill colors={g.colors} id={`dot_${g.id}`} /></View>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 10 }}>
            {FONTS.filter(f => f.id === 'classic' || f.id === 'serif' || f.id === 'mono').map(f => (
              <TouchableOpacity key={f.id} onPress={() => setTxt(s => ({ ...s, font: f.id }))}
                style={[st.chip, txt.font === f.id && st.chipOn]}>
                <Text style={[st.chipTxt, txt.font === f.id && st.chipTxtOn, fontStyleFor(f.id), { textTransform: 'none' }]}>{t(f.labelKey)}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      );
    }
    if (tool === 'filters' && ed?.thumbUri && filtersOn) {
      return (
        <View style={st.panel}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 10 }}>
            <FilterThumbs
              uri={ed.thumbUri} size={58} items={filterItems}
              renderItem={(it, i, node) => {
                const on = ed.filterId === it.key;
                const sug = ed.suggestion?.id === it.key;
                return (
                  <TouchableOpacity key={it.key} onPress={() => pickFilter(it.key)} activeOpacity={0.8} style={{ alignItems: 'center', width: 64 }}
                    accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={fName(it.key)}>
                    <View style={[st.thumbFrame, on && { borderColor: '#FFFFFF' }]}>{node}</View>
                    <Text numberOfLines={1} style={[st.thumbLbl, on && { color: '#FFFFFF', fontWeight: '800' }]}>{fName(it.key)}</Text>
                    {sug ? <View style={st.sugDot} /> : null}
                  </TouchableOpacity>
                );
              }}
            />
          </ScrollView>
        </View>
      );
    }
    if (tool === 'intensity' && ed) {
      return (
        <View style={[st.panel, { paddingHorizontal: 22 }]}>
          <Text style={st.panelTitle}>{fName(ed.filterId)} · {Math.round(ed.intensity * 100)}</Text>
          <Slider value={ed.intensity} min={0} max={1} center={false} onChange={(v) => setEd({ intensity: v })} />
        </View>
      );
    }
    if (tool === 'adjust' && ed) {
      return (
        <View style={[st.panel, { paddingHorizontal: 18 }]}>
          {ADJUST_KEYS.map(a => (
            <View key={a.key} style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[st.adjLbl]} numberOfLines={1}>{t(a.labelKey)}</Text>
              <View style={{ flex: 1 }}>
                <Slider value={ed.adjust[a.key] || 0} min={a.min} max={a.max} center={a.min < 0}
                  onChange={(v) => setEd(o => ({ adjust: { ...o.adjust, [a.key]: v } }))} />
              </View>
              <Text style={st.adjVal}>{Math.round((ed.adjust[a.key] || 0) * 100)}</Text>
            </View>
          ))}
          <TouchableOpacity onPress={() => setEd({ adjust: { ...DEFAULT_ADJUST } })} style={{ alignSelf: 'center', marginTop: 2 }}>
            <Text style={{ color: 'rgba(255,255,255,0.75)', fontWeight: '700', fontSize: 13 }}>{t('status.studio.reset')}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (tool === 'crop' && ed) {
      return (
        <View style={st.panel}>
          <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingHorizontal: 10 }}>
            {ASPECTS.map(a => {
              const on = (ed.aspect || null) === a.v;
              return (
                <TouchableOpacity key={a.id} onPress={() => reCrop({ aspect: a.v })} style={[st.chip, on && st.chipOn]}>
                  <Text style={[st.chipTxt, on && st.chipTxtOn]}>{a.labelKey ? t(a.labelKey) : a.label}</Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity onPress={() => reCrop({ rotate: (ed.rotate + 90) % 360 })} style={[st.chip, { flexDirection: 'row', alignItems: 'center' }]}
              accessibilityLabel={t('status.studio.rotate')}>
              <IconRotateCw size={16} color="#fff" />
              <Text style={[st.chipTxt, { marginLeft: 6 }]}>{t('status.studio.rotate')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }
    if (tool === 'draw') {
      return (
        <View style={st.panel}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 10 }}>
            {BRUSH.map(w => (
              <TouchableOpacity key={w} onPress={() => setBrush(b => ({ ...b, w }))} style={[st.brushBtn, brush.w === w && { borderColor: '#fff' }]}>
                <View style={{ width: w + 4, height: w + 4, borderRadius: (w + 4) / 2, backgroundColor: '#fff' }} />
              </TouchableOpacity>
            ))}
            <TouchableOpacity onPress={() => setOv(o => ({ ...o, paths: o.paths.slice(0, -1) }))} style={st.brushBtn} accessibilityLabel={t('status.studio.undo')}>
              <IconUndo size={18} color="#fff" />
            </TouchableOpacity>
          </View>
          <ColorRow value={brush.color} onPick={(c) => setBrush(b => ({ ...b, color: c }))} />
        </View>
      );
    }
    return null;
  };

  const showFilterHint = mode === 'media' && !isVideo && filtersOn && (!tool || tool === 'filters') && !captionFocus
    && ed?.suggestion && ed.filterId !== ed.suggestion.id;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => (tool ? setTool(null) : onClose?.())} statusBarTranslucent>
      <View style={[st.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        {/* Topo */}
        <View style={[st.topBar, { height: topBarH }]}>
          <GlassBtn onPress={() => (tool && tool !== 'filters' ? setTool(null) : onClose?.())} label={t('common.close')}>
            <IconX size={20} color={chrome} />
          </GlassBtn>
          <View style={{ flex: 1 }} />
          {mode === 'media' ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {!isVideo && filtersOn && (
                <GlassBtn onPress={applyAuto} label={t('status.studio.auto')}><IconSparkles size={19} color={chrome} /></GlassBtn>
              )}
              <GlassBtn onPress={() => openText(null)} label={t('status.studio.text')}><IconType size={19} color={chrome} /></GlassBtn>
              <GlassBtn onPress={() => setTool(tl => (tl === 'stickers' ? null : 'stickers'))} active={tool === 'stickers'} label={t('status.studio.stickers')}>
                <IconSmile size={19} color={tool === 'stickers' ? '#000' : chrome} />
              </GlassBtn>
              <GlassBtn onPress={() => { measureStage(); setTool(tl => (tl === 'draw' ? null : 'draw')); }} active={tool === 'draw'} label={t('status.studio.draw')}>
                <IconBrush size={19} color={tool === 'draw' ? '#000' : chrome} />
              </GlassBtn>
              {!isVideo && (
                <GlassBtn onPress={() => setTool(tl => (tl === 'crop' ? null : 'crop'))} active={tool === 'crop'} label={t('status.studio.crop')}>
                  <IconCrop size={19} color={tool === 'crop' ? '#000' : chrome} />
                </GlassBtn>
              )}
              {!isVideo && filtersOn && (
                <GlassBtn onPress={() => setTool(tl => (tl === 'adjust' ? null : 'adjust'))} active={tool === 'adjust'} label={t('status.studio.adjust')}>
                  <IconSliders size={19} color={tool === 'adjust' ? '#000' : chrome} />
                </GlassBtn>
              )}
            </View>
          ) : (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <GlassBtn onPress={pickFromGallery} label={t('status.gallery')}><IconImage size={19} color={chrome} /></GlassBtn>
              {Platform.OS !== 'web' && onOpenCamera ? (
                <GlassBtn onPress={() => { onClose?.(); setTimeout(() => onOpenCamera?.(), Platform.OS === 'ios' ? 500 : 200); }} label={t('status.camera')}><IconCamera size={19} color={chrome} /></GlassBtn>
              ) : null}
            </View>
          )}
        </View>

        {/* Palco */}
        <View style={{ alignItems: 'center' }}>
          <View
            ref={stageRef}
            collapsable={false}
            onLayout={measureStage}
            {...(tool === 'draw' ? drawPR.panHandlers : stagePR.panHandlers)}
            style={[st.stage, { width: stageW, height: stageH, backgroundColor: mode === 'media' ? stageBackground(ed?.stats) : '#000', borderRadius: capturing ? 0 : 16 }]}
          >
            {renderStageMedia()}
            {renderOverlays()}
            {/* nome do filtro (ao trocar) */}
            {flashName && !capturing && mode === 'media' ? (
              <View pointerEvents="none" style={st.flash}>
                <Text style={st.flashTxt}>{fName(flashName)}</Text>
                {ed?.suggestion?.id === flashName ? <Text style={st.flashSub}>{t('status.smart.suggested')}</Text> : null}
              </View>
            ) : null}
            {/* lixeira ao arrastar */}
            {dragInfo.dragging && !capturing ? (
              <View pointerEvents="none" style={[st.trash, dragInfo.trash && { backgroundColor: '#EF4444', transform: [{ scale: 1.15 }] }]}>
                <IconTrash size={22} color="#fff" />
              </View>
            ) : null}
            {showFilterHint && ed?.suggestion && !flashName && !capturing ? (
              <TouchableOpacity onPress={() => pickFilter(ed.suggestion.id)} style={st.sugPill} activeOpacity={0.85}>
                <IconSparkles size={14} color="#000" />
                <Text style={st.sugPillTxt} numberOfLines={1}>{t('status.smart.tryFilter')} {fName(ed.suggestion.id)} · {t(ed.suggestion.reasonKey)}</Text>
              </TouchableOpacity>
            ) : null}
            {ed?.loading && mode === 'media' && !isVideo ? (
              <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}><ActivityIndicator color="#fff" /></View>
            ) : null}
          </View>
        </View>

        {/* Painel da ferramenta + rodapé */}
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          {renderToolPanel()}
          {mode === 'media' && items.length > 1 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }} style={{ maxHeight: 54, marginBottom: 6 }}>
              {items.map((it, i) => (
                <TouchableOpacity key={`${it.uri}-${i}`} onPress={() => { setIdx(i); setTool(it.type !== 'video' && filtersOn ? 'filters' : null); }}
                  style={[st.itemThumb, i === idx && { borderColor: '#fff' }]}>
                  <Image source={{ uri: edits[i]?.thumbUri || it.uri }} style={{ width: '100%', height: '100%' }} />
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : null}
          {/* Legenda + sugestões */}
          {mode === 'media' ? (
            <View style={{ paddingHorizontal: 12 }}>
              {captionFocus && !caption ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 8, paddingBottom: 8 }}>
                  {captionIdeas.map(k => (
                    <TouchableOpacity key={k} onPress={() => setCaption(t(k))} style={st.ideaChip}>
                      <IconSparkles size={12} color="#fff" />
                      <Text style={st.ideaTxt} numberOfLines={1}>{t(k)}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              ) : null}
              <View style={st.captionBox}>
                <TextInput
                  value={caption}
                  onChangeText={(v) => setCaption(v.slice(0, 500))}
                  onFocus={() => setCaptionFocus(true)}
                  onBlur={() => setCaptionFocus(false)}
                  placeholder={t('status.studio.captionPlaceholder')}
                  placeholderTextColor="rgba(255,255,255,0.55)"
                  style={[st.captionInput, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
                />
                {!isVideo && filtersOn ? (
                  <TouchableOpacity onPress={() => setTool(tl => (tl === 'filters' || tl === 'intensity' ? null : 'filters'))} hitSlop={8} accessibilityLabel={t('status.studio.filters')}>
                    <IconFilter size={18} color={tool === 'filters' ? '#fff' : 'rgba(255,255,255,0.6)'} />
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          ) : null}
          <View style={st.bottomRow}>
            <TouchableOpacity onPress={() => setTool('audience')} style={st.audPill} accessibilityRole="button" accessibilityLabel={t('status.audience.title')}>
              <AudIcon size={15} color="#fff" />
              <Text style={st.audTxt} numberOfLines={1}>{audienceLabel}</Text>
              <IconChevronDown size={14} color="rgba(255,255,255,0.7)" />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={publish}
              disabled={publishing || (mode === 'text' ? !txt.text.trim() : !items.length)}
              style={[st.shareBtn, (publishing || (mode === 'text' && !txt.text.trim())) && { opacity: 0.5 }]}
              accessibilityRole="button" accessibilityLabel={t('status.studio.share')}
            >
              {publishing ? <ActivityIndicator color="#000" /> : (
                <>
                  <Text style={st.shareTxt}>{t('status.studio.share')}</Text>
                  <IconSend size={16} color="#000" />
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Editor de texto (sobre tudo) ── */}
        {tool === 'textEdit' && textDraft ? (
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[StyleSheet.absoluteFill, st.textEditRoot, { paddingTop: insets.top + 8 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 }}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} keyboardShouldPersistTaps="always">
                {FONTS.map(f => (
                  <TouchableOpacity key={f.id} onPress={() => setTextDraft(d => ({ ...d, font: f.id }))} style={[st.chip, textDraft.font === f.id && st.chipOn]}>
                    <Text style={[st.chipTxt, textDraft.font === f.id && st.chipTxtOn, fontStyleFor(f.id)]}>{t(f.labelKey)}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TouchableOpacity onPress={commitText} style={st.doneBtn} accessibilityLabel={t('common.done')}>
                <Text style={st.doneTxt}>{t('common.done')}</Text>
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 10 }}>
              {['none', 'solid', 'soft'].map(b => (
                <TouchableOpacity key={b} onPress={() => setTextDraft(d => ({ ...d, bg: b }))} style={[st.chip, textDraft.bg === b && st.chipOn]}>
                  <Text style={[st.chipTxt, textDraft.bg === b && st.chipTxtOn]}>{t(`status.studio.bg_${b}`)}</Text>
                </TouchableOpacity>
              ))}
              {['left', 'center', 'right'].map(a => (
                <TouchableOpacity key={a} onPress={() => setTextDraft(d => ({ ...d, align: a }))} style={[st.alignBtn, textDraft.align === a && st.chipOn]}
                  accessibilityLabel={t(`status.studio.align_${a}`)}>
                  <AlignGlyph align={a} color={textDraft.align === a ? '#000' : '#fff'} />
                </TouchableOpacity>
              ))}
            </View>
            <Pressable style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 20 }} onPress={commitText}>
              <TextOverlayPreviewInput draft={textDraft} onChange={(v) => setTextDraft(d => ({ ...d, text: v }))} placeholder={t('status.studio.textPlaceholder')} />
            </Pressable>
            <View style={{ paddingBottom: 12 }}>
              <ColorRow value={textDraft.color} onPick={(c) => setTextDraft(d => ({ ...d, color: c }))} />
            </View>
          </KeyboardAvoidingView>
        ) : null}

        {/* ── Folhas (figurinhas / menção / local / link / público) ── */}
        {tool === 'stickers' ? (
          <Sheet onClose={() => setTool(null)} bg={sheetBg} border={sheetBorder} height={WIN.height * 0.62}>
            <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingBottom: 10 }}>
              <SheetTile Icon={IconAtSign} label={t('status.stickerMention')} color={sheetText} bg={isDark ? '#1f1f1f' : '#F2F2F2'} onPress={() => { setMentionQ(''); loadContacts(); setTool('mention'); }} />
              <SheetTile Icon={IconMapPin} label={t('status.stickerLocation')} color={sheetText} bg={isDark ? '#1f1f1f' : '#F2F2F2'} onPress={() => { setLocDraft(''); setTool('location'); detectLocation(); }} />
              <SheetTile Icon={IconLink} label={t('status.studio.link')} color={sheetText} bg={isDark ? '#1f1f1f' : '#F2F2F2'} onPress={() => { setLinkDraft({ url: '', label: '' }); setTool('link'); }} />
            </View>
            {StickerPicker ? (
              <View style={{ flex: 1 }}>
                <StickerPicker
                  colors={colors} t={t} userEmail={user?.email}
                  onClose={() => setTool(null)}
                  onSelect={(s) => {
                    const v = typeof s === 'string' ? s : (s?.url || s?.uri || '');
                    if (!v) return;
                    const isUrl = /^(https?:|\/data\/|file:|blob:|data:)/.test(v);
                    addItem(isUrl ? { kind: 'sticker', url: v.startsWith('/data/') ? api.getMediaUrl(v) : v } : { kind: 'sticker', text: v });
                    setTool(null);
                  }}
                />
              </View>
            ) : null}
          </Sheet>
        ) : null}

        {tool === 'mention' ? (
          <Sheet onClose={() => setTool(null)} bg={sheetBg} border={sheetBorder} height={WIN.height * 0.6}>
            <Text style={[st.sheetTitle, { color: sheetText }]}>{t('status.mentionPick')}</Text>
            <TextInput value={mentionQ} onChangeText={setMentionQ} placeholder={t('search.placeholder')} placeholderTextColor={sheetSub}
              style={[st.sheetInput, { color: sheetText, borderColor: sheetBorder }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]} />
            {contactsLoading ? <ActivityIndicator color={sheetText} style={{ marginTop: 20 }} /> : (
              <ScrollView keyboardShouldPersistTaps="handled">
                {contacts.filter(c => !mentionQ.trim() || (c.name || '').toLowerCase().includes(mentionQ.trim().toLowerCase()) || (c.email || '').toLowerCase().includes(mentionQ.trim().toLowerCase())).slice(0, 80).map(c => (
                  <TouchableOpacity key={c.email} style={[st.row, { borderColor: sheetBorder }]} onPress={() => {
                    const uname = `@${String(c.name || c.email.split('@')[0]).replace(/\s+/g, '').toLowerCase()}`;
                    addItem({ kind: 'mention', username: uname, email: c.email });
                    setTool(null);
                  }}>
                    <IconAtSign size={16} color={sheetSub} />
                    <View style={{ marginLeft: 10, flex: 1 }}>
                      <Text style={{ color: sheetText, fontWeight: '700' }} numberOfLines={1}>{c.name}</Text>
                      <Text style={{ color: sheetSub, fontSize: 12 }} numberOfLines={1}>{c.email}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </Sheet>
        ) : null}

        {tool === 'location' ? (
          <Sheet onClose={() => setTool(null)} bg={sheetBg} border={sheetBorder} height={260}>
            <Text style={[st.sheetTitle, { color: sheetText }]}>{t('status.stickerLocation')}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 8 }}>
              <TextInput value={locDraft} onChangeText={setLocDraft} placeholder={t('status.studio.locationPlaceholder')} placeholderTextColor={sheetSub}
                style={[st.sheetInput, { flex: 1, marginHorizontal: 0, color: sheetText, borderColor: sheetBorder }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]} />
              <TouchableOpacity onPress={detectLocation} style={[st.iconSq, { borderColor: sheetBorder }]} accessibilityLabel={t('status.studio.useMyLocation')}>
                {locBusy ? <ActivityIndicator color={sheetText} /> : <IconMapPin size={18} color={sheetText} />}
              </TouchableOpacity>
            </View>
            <PrimaryBtn label={t('status.studio.add')} colors={colors} disabled={!locDraft.trim()} onPress={() => { addItem({ kind: 'location', label: locDraft.trim() }); setTool(null); }} />
          </Sheet>
        ) : null}

        {tool === 'link' ? (
          <Sheet onClose={() => setTool(null)} bg={sheetBg} border={sheetBorder} height={300}>
            <Text style={[st.sheetTitle, { color: sheetText }]}>{t('status.studio.link')}</Text>
            <TextInput value={linkDraft.url} onChangeText={(v) => setLinkDraft(d => ({ ...d, url: v }))} autoCapitalize="none" keyboardType={Platform.OS === 'web' ? 'default' : 'url'}
              placeholder="https://" placeholderTextColor={sheetSub}
              style={[st.sheetInput, { color: sheetText, borderColor: sheetBorder }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]} />
            <TextInput value={linkDraft.label} onChangeText={(v) => setLinkDraft(d => ({ ...d, label: v.slice(0, 40) }))}
              placeholder={t('status.studio.linkLabel')} placeholderTextColor={sheetSub}
              style={[st.sheetInput, { color: sheetText, borderColor: sheetBorder }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]} />
            <PrimaryBtn label={t('status.studio.add')} colors={colors}
              disabled={!/^(https?:\/\/)?[^\s.]+\.[^\s]{2,}/i.test(linkDraft.url.trim())}
              onPress={() => {
                let url = linkDraft.url.trim();
                if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
                addItem({ kind: 'link', url, label: linkDraft.label.trim() || url.replace(/^https?:\/\//i, '').slice(0, 32) });
                setTool(null);
              }} />
          </Sheet>
        ) : null}

        {tool === 'audience' ? (
          <Sheet onClose={() => setTool(null)} bg={sheetBg} border={sheetBorder} height={380}>
            <Text style={[st.sheetTitle, { color: sheetText }]}>{t('status.audience.title')}</Text>
            {[
              { id: 'all', Icon: IconGlobe, label: t('status.audience.all'), sub: t('status.audience.allSub') },
              { id: 'contacts', Icon: IconUsers, label: t('status.audience.contacts'), sub: t('status.audience.contactsSub') },
              { id: 'close_friends', Icon: IconStar, label: t('status.audience.closeFriends'), sub: t('status.audience.closeFriendsSub'), edit: '/close-friends' },
              { id: 'except', Icon: IconEyeOff, label: t('status.audience.except'), sub: exceptList.length ? `${exceptList.length} · ${t('status.audience.exceptSub')}` : t('status.audience.exceptSub'), edit: '/status-except' },
            ].map(o => {
              const on = audience === o.id;
              return (
                <TouchableOpacity key={o.id} onPress={() => { tick(); chooseAudience(o.id); }} style={[st.audRow, { borderColor: sheetBorder }]}
                  accessibilityRole="radio" accessibilityState={{ selected: on }}>
                  <View style={[st.audIcon, { backgroundColor: on ? colors.primary : (isDark ? '#1f1f1f' : '#F2F2F2') }]}>
                    <o.Icon size={18} color={on ? colors.onPrimary : sheetText} />
                  </View>
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={{ color: sheetText, fontWeight: '700', fontSize: 15 }}>{o.label}</Text>
                    <Text style={{ color: sheetSub, fontSize: 12.5, marginTop: 1 }} numberOfLines={2}>{o.sub}</Text>
                  </View>
                  {o.edit && router ? (
                    <TouchableOpacity onPress={() => { chooseAudience(o.id); setTool(null); onClose?.(); setTimeout(() => { try { router.push(o.edit); } catch {} }, 200); }} hitSlop={8} style={{ paddingHorizontal: 6 }}>
                      <Text style={{ color: sheetText, fontWeight: '700', fontSize: 13 }}>{t('status.audience.edit')}</Text>
                    </TouchableOpacity>
                  ) : null}
                  <View style={[st.radio, { borderColor: on ? sheetText : sheetSub }]}>{on ? <View style={[st.radioDot, { backgroundColor: sheetText }]} /> : null}</View>
                </TouchableOpacity>
              );
            })}
          </Sheet>
        ) : null}
      </View>
    </Modal>
  );
}

function AlignGlyph({ align, color }) {
  const widths = [14, 9, 12];
  return (
    <Svg width={18} height={18} viewBox="0 0 18 18">
      {widths.map((w, i) => {
        const x = align === 'left' ? 2 : align === 'right' ? 16 - w : (18 - w) / 2;
        return <Rect key={i} x={x} y={3 + i * 5} width={w} height={2} rx={1} fill={color} />;
      })}
    </Svg>
  );
}

function TextOverlayPreviewInput({ draft, onChange, placeholder }) {
  const bg = draft.bg === 'solid' ? draft.color : draft.bg === 'soft' ? 'rgba(0,0,0,0.45)' : 'transparent';
  const fg = draft.bg === 'solid' ? contrastOn(draft.color) : draft.color;
  return (
    <View style={{ alignSelf: draft.align === 'left' ? 'flex-start' : draft.align === 'right' ? 'flex-end' : 'center', backgroundColor: bg, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, maxWidth: '100%' }}>
      <TextInput
        value={draft.text}
        onChangeText={(v) => onChange(v.slice(0, 300))}
        autoFocus
        multiline
        placeholder={placeholder}
        placeholderTextColor="rgba(255,255,255,0.5)"
        style={[{ color: fg, fontSize: 30, textAlign: draft.align, minWidth: 40 }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null, fontStyleFor(draft.font)]}
      />
    </View>
  );
}

function ColorRow({ value, onPick }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ paddingHorizontal: 14, gap: 10, alignItems: 'center' }}>
      {PALETTE.map(c => (
        <TouchableOpacity key={c} onPress={() => onPick(c)} accessibilityLabel={c}
          style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c, borderWidth: value === c ? 3 : 1.5, borderColor: value === c ? '#FFFFFF' : 'rgba(255,255,255,0.5)' }} />
      ))}
    </ScrollView>
  );
}

function Sheet({ onClose, children, bg, border, height }) {
  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.45)' }]} onPress={onClose} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
        <View style={{ height, backgroundColor: bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: StyleSheet.hairlineWidth, borderColor: border, paddingTop: 8 }}>
          <View style={{ alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(127,127,127,0.4)', marginBottom: 10 }} />
          {children}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
function SheetTile({ Icon, label, onPress, color, bg }) {
  return (
    <TouchableOpacity onPress={onPress} style={{ flex: 1, height: 64, borderRadius: 14, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }} accessibilityRole="button" accessibilityLabel={label}>
      <Icon size={20} color={color} />
      <Text style={{ color, fontSize: 12, fontWeight: '700', marginTop: 5 }} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}
function PrimaryBtn({ label, onPress, disabled, colors }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled}
      style={{ marginHorizontal: 14, marginTop: 14, height: 48, borderRadius: 24, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.45 : 1 }}>
      <Text style={{ color: colors.onPrimary, fontWeight: '800', fontSize: 15 }}>{label}</Text>
    </TouchableOpacity>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  glass: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  stage: { overflow: 'hidden' },
  flash: { position: 'absolute', top: '42%', left: 0, right: 0, alignItems: 'center' },
  flashTxt: { color: '#fff', fontSize: 30, fontWeight: '800', letterSpacing: -0.5, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 8, textShadowOffset: { width: 0, height: 1 } },
  flashSub: { color: 'rgba(255,255,255,0.9)', fontSize: 13, fontWeight: '700', marginTop: 4, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 6 },
  trash: { position: 'absolute', bottom: 22, alignSelf: 'center', left: '50%', marginLeft: -26, width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(0,0,0,0.55)', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.8)', alignItems: 'center', justifyContent: 'center' },
  sugPill: { position: 'absolute', top: 12, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, gap: 6, maxWidth: '86%' },
  sugPillTxt: { color: '#000', fontWeight: '700', fontSize: 12.5 },
  panel: { paddingTop: 10, paddingBottom: 8 },
  panelTitle: { color: '#fff', fontWeight: '800', fontSize: 13, textAlign: 'center', marginBottom: 2 },
  thumbFrame: { width: 62, height: 62, borderRadius: 12, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  thumbLbl: { color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '600', marginTop: 4 },
  sugDot: { position: 'absolute', top: 2, right: 4, width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#000' },
  adjLbl: { color: '#fff', width: 92, fontSize: 12.5, fontWeight: '700' },
  adjVal: { color: 'rgba(255,255,255,0.7)', width: 38, textAlign: 'right', fontSize: 12, fontVariant: ['tabular-nums'] },
  chip: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.12)' },
  chipOn: { backgroundColor: '#FFFFFF' },
  chipTxt: { color: '#fff', fontWeight: '700', fontSize: 13 },
  chipTxtOn: { color: '#000' },
  alignBtn: { width: 34, height: 32, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  brushBtn: { width: 38, height: 38, borderRadius: 19, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.3)', alignItems: 'center', justifyContent: 'center' },
  gradDot: { width: 34, height: 34, borderRadius: 17, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.4)', padding: 1.5 },
  itemThumb: { width: 40, height: 52, borderRadius: 8, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  captionBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 22, paddingHorizontal: 14, height: 44 },
  captionInput: { flex: 1, color: '#fff', fontSize: 15, paddingVertical: 0 },
  ideaChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6, maxWidth: 260 },
  ideaTxt: { color: '#fff', fontSize: 12.5, fontWeight: '600' },
  bottomRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, gap: 10 },
  audPill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 20, paddingHorizontal: 12, height: 40, flexShrink: 1 },
  audTxt: { color: '#fff', fontWeight: '700', fontSize: 13.5, flexShrink: 1 },
  shareBtn: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FFFFFF', borderRadius: 22, paddingHorizontal: 18, height: 44 },
  shareTxt: { color: '#000', fontWeight: '800', fontSize: 15 },
  textEditRoot: { backgroundColor: 'rgba(0,0,0,0.72)' },
  doneBtn: { backgroundColor: '#fff', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 7 },
  doneTxt: { color: '#000', fontWeight: '800', fontSize: 14 },
  sheetTitle: { fontWeight: '800', fontSize: 16, paddingHorizontal: 16, marginBottom: 10 },
  sheetInput: { marginHorizontal: 14, marginBottom: 8, height: 44, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  iconSq: { width: 44, height: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  audRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  audIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  radioDot: { width: 11, height: 11, borderRadius: 6 },
});
