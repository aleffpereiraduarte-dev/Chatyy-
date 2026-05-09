import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Image,
  useWindowDimensions, Animated, PanResponder, Platform, ActivityIndicator,
  ScrollView, TextInput,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconX, IconCheck, IconRefresh } from '../components/Icons';
import Svg, { Rect, Line, Path, Circle, G } from 'react-native-svg';

// ── Icon helpers (small inline SVGs for editor tools) ──

function IconCrop({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M6.13 1L6 16a2 2 0 0 0 2 2h15" />
      <Path d="M1 6.13L16 6a2 2 0 0 1 2 2v15" />
    </Svg>
  );
}

function IconRotateCw({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M23 4v6h-6" />
      <Path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </Svg>
  );
}

function IconRotateCcw({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M1 4v6h6" />
      <Path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </Svg>
  );
}

function IconFlipH({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 3v18" />
      <Path d="M16 7l4 5-4 5" />
      <Path d="M8 7L4 12l4 5" />
    </Svg>
  );
}

function IconFlipV({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M3 12h18" />
      <Path d="M7 8L12 4l5 4" />
      <Path d="M7 16l5 4 5-4" />
    </Svg>
  );
}

function IconSliders({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Line x1="4" y1="21" x2="4" y2="14" />
      <Line x1="4" y1="10" x2="4" y2="3" />
      <Line x1="12" y1="21" x2="12" y2="12" />
      <Line x1="12" y1="8" x2="12" y2="3" />
      <Line x1="20" y1="21" x2="20" y2="16" />
      <Line x1="20" y1="12" x2="20" y2="3" />
      <Line x1="1" y1="14" x2="7" y2="14" />
      <Line x1="9" y1="8" x2="15" y2="8" />
      <Line x1="17" y1="16" x2="23" y2="16" />
    </Svg>
  );
}

function IconFilters({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="12" cy="12" r="10" />
      <Path d="M12 2a10 10 0 0 1 0 20" fill={color} fillOpacity={0.3} stroke="none" />
      <Circle cx="12" cy="12" r="4" />
    </Svg>
  );
}

function IconSun({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="12" cy="12" r="5" />
      <Line x1="12" y1="1" x2="12" y2="3" />
      <Line x1="12" y1="21" x2="12" y2="23" />
      <Line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <Line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <Line x1="1" y1="12" x2="3" y2="12" />
      <Line x1="21" y1="12" x2="23" y2="12" />
      <Line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <Line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </Svg>
  );
}

// ── Constants ──

// Brand color (Chatyy purple). Sourced once so we can use it inline as a
// gradient stop / pill background without pulling theme on every paint.
const BRAND = '#7C3AED';
const BRAND_DARK = '#5B21B6';

// Tab order matches the design brief: Filtros first (most-used color path),
// then Texto, Adesivos, Desenho, Cortar, Brilho, Música, Tag pessoas. The
// adjust/rotate/blur paths still exist under the hood and are reachable from
// the redesigned toolbar — `draw` / `music` / `tag` are placeholders that
// surface UI but no-op for now (per task spec).
const TABS = ['filters', 'text', 'sticker', 'draw', 'crop', 'adjust', 'music', 'tag'];

// Pen/text colors — expanded to 10 swatches per the design brief, plus a
// trailing "+" custom slot. The "+" entry is a sentinel; tapping it just
// keeps the current color (real picker is TODO).
const PEN_COLORS = [
  '#ffffff', '#000000', '#FF3B30', '#FF9500', '#FFCC00',
  '#34C759', '#0A84FF', '#5856D6', '#AF52DE', '#FF2D92',
];

// Stickers panel — grouped into packs (Emoji / GIPHY / Avatares / Branded)
// per the design brief. The non-Emoji packs are placeholders — tapping the
// header switches the visible grid; their tiles use the same insert handler
// so picking still works for Emoji without breaking the API.
const STICKER_PACKS = [
  {
    key: 'emoji',
    label: 'Emoji',
    items: ['😀', '😂', '😍', '🥳', '🔥', '✨', '❤️', '👍', '👏', '🎉', '💯', '⭐', '😎', '🤩', '🙌', '💜'],
  },
  { key: 'giphy', label: 'GIPHY', items: ['🎬', '🎞️', '📺', '🎥', '🎭', '🎪'] },
  { key: 'avatars', label: 'Avatares', items: ['🧑', '👩', '👨', '🧒', '👶', '🧓'] },
  { key: 'branded', label: 'Chatyy', items: ['💬', '✉️', '🔔', '🚀', '⚡', '💎'] },
];

// Crop aspect chips — Original (free) plus the social-media presets the
// design brief calls out (Quadrado / Stories / Post). Labels are inline
// strings since these aren't in i18n yet (placeholder OK per task rules).
const CROP_RATIOS = [
  { label: 'Original', value: null },
  { label: '1:1', sub: 'Quadrado', value: 1 },
  { label: '9:16', sub: 'Stories', value: 9 / 16 },
  { label: '4:5', sub: 'Post', value: 4 / 5 },
  { label: '4:3', value: 4 / 3 },
  { label: '16:9', value: 16 / 9 },
];

const FILTERS = [
  { key: 'original', overlay: null },
  { key: 'vivid', overlay: 'rgba(255, 100, 50, 0.08)' },
  { key: 'warm', overlay: 'rgba(255, 165, 50, 0.15)' },
  { key: 'cool', overlay: 'rgba(50, 130, 255, 0.15)' },
  { key: 'bw', overlay: null, grayscale: true },
  { key: 'sepia', overlay: 'rgba(160, 120, 60, 0.25)' },
  { key: 'fade', overlay: 'rgba(255, 255, 255, 0.3)' },
  { key: 'dramatic', overlay: 'rgba(0, 0, 0, 0.25)' },
];

const HANDLE_SIZE = 28;
const MIN_CROP = 40;

// ── DraggableOverlay ──
// Wraps a positioned absolute element with a PanResponder so the user can
// drag text/sticker/blur items around the photo. When `active`, renders a
// thin selection outline + a small × delete button. Children are typed
// freely so this works for any overlay variant.
function DraggableOverlay({ responder, active, onDelete, style, children }) {
  return (
    <View
      {...(responder?.panHandlers || {})}
      style={[
        {
          position: 'absolute',
          padding: 4,
          borderWidth: active ? 1 : 0,
          borderColor: 'rgba(255,255,255,0.7)',
          borderStyle: 'dashed',
          borderRadius: 4,
        },
        style,
      ]}
    >
      {children}
      {active && (
        <TouchableOpacity
          onPress={onDelete}
          style={{
            position: 'absolute',
            top: -10, right: -10,
            width: 20, height: 20, borderRadius: 10,
            backgroundColor: 'rgba(0,0,0,0.85)',
            alignItems: 'center', justifyContent: 'center',
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)',
            zIndex: 30,
          }}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700', lineHeight: 13 }}>×</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ── Main Component ──

export default function PhotoEditor({ visible, imageUri, onSave, onClose }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { width: screenW, height: screenH } = useWindowDimensions();
  // Bug print z2 (2026-05-08): "Próximo" pill was being clipped by Dynamic
  // Island / status bar. topBar height=56 starting at y=0 left no room for
  // the system UI. Use the runtime safe-area inset so the bar pushes down.
  const insets = useSafeAreaInsets();

  // State
  const [activeTab, setActiveTab] = useState('crop');
  const [rotation, setRotation] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [selectedFilter, setSelectedFilter] = useState('original');
  // Filter intensity 0-100 — controls opacity of the filter overlay so
  // non-Original filters can be dialed in. 100 = full strength (matches
  // the FILTERS overlay rgba alpha as authored).
  const [filterIntensity, setFilterIntensity] = useState(100);
  const [brightness, setBrightness] = useState(0); // -100 to 100
  // Sticker pack selection — index into STICKER_PACKS. Defaults to Emoji.
  const [stickerPack, setStickerPack] = useState('emoji');
  // Undo/redo history snapshots. Each entry captures the editable state
  // (rotation, flips, filter, crop, overlays). Cheap shallow snapshots —
  // not a true command stack, but good enough for the editor scale.
  const historyRef = useRef({ past: [], future: [] });
  const [saving, setSaving] = useState(false);
  const [imageSize, setImageSize] = useState({ w: 0, h: 0 });
  const [imageLoaded, setImageLoaded] = useState(false);

  // Crop state (percentages 0-1 relative to displayed image)
  const [cropRect, setCropRect] = useState({ x: 0, y: 0, w: 1, h: 1 });
  const [selectedRatio, setSelectedRatio] = useState(null); // null = free
  const [dragging, setDragging] = useState(null); // 'tl','tr','bl','br','move' or null

  // Overlay state — text, stickers, blur regions. Each item carries
  // a position in display-pixel coordinates; the save path scales them
  // to source pixels using the same dispW/dispH math as crop. New items
  // get a unique id so they can be selected/dragged/deleted independently.
  // text: { id, x, y, value, color, size }
  const [textItems, setTextItems] = useState([]);
  // sticker: { id, x, y, emoji, size }
  const [stickerItems, setStickerItems] = useState([]);
  // blur: { id, x, y, w, h, intensity } (intensity 0-1 → CSS blur radius)
  const [blurRegions, setBlurRegions] = useState([]);
  const [activeOverlayId, setActiveOverlayId] = useState(null);
  const [textInputValue, setTextInputValue] = useState('');
  const [textColor, setTextColor] = useState(PEN_COLORS[0]);

  // Refs for pan tracking
  const dragStartRef = useRef(null);
  const cropStartRef = useRef(null);
  const overlayDragStartRef = useRef(null);

  // Image display area
  const toolbarH = 120;
  const topBarH = 56;
  const availH = screenH - topBarH - toolbarH - 80;
  const availW = screenW - 32;

  // Calculate displayed image dimensions
  const displayDims = useMemo(() => {
    if (!imageSize.w || !imageSize.h) return { w: availW, h: availH, x: 16, y: topBarH + 8 };
    const isRotated = rotation === 90 || rotation === 270;
    const srcW = isRotated ? imageSize.h : imageSize.w;
    const srcH = isRotated ? imageSize.w : imageSize.h;
    const scale = Math.min(availW / srcW, availH / srcH, 1);
    const w = srcW * scale;
    const h = srcH * scale;
    const x = (screenW - w) / 2;
    const y = topBarH + 8 + (availH - h) / 2;
    return { w, h, x, y };
  }, [imageSize, availW, availH, rotation, screenW]);

  // Load image dimensions
  useEffect(() => {
    if (!visible || !imageUri) return;
    Image.getSize(
      imageUri,
      (w, h) => { setImageSize({ w, h }); setImageLoaded(true); },
      () => { setImageSize({ w: availW, h: availH }); setImageLoaded(true); }
    );
  }, [visible, imageUri]);

  // Reset state when opening
  useEffect(() => {
    if (visible) {
      setActiveTab('filters');
      setRotation(0);
      setFlipH(false);
      setFlipV(false);
      setSelectedFilter('original');
      setFilterIntensity(100);
      setBrightness(0);
      setCropRect({ x: 0, y: 0, w: 1, h: 1 });
      setSelectedRatio(null);
      setImageLoaded(false);
      setSaving(false);
      setTextItems([]);
      setStickerItems([]);
      setBlurRegions([]);
      setActiveOverlayId(null);
      setTextInputValue('');
      setTextColor(PEN_COLORS[0]);
      setStickerPack('emoji');
      historyRef.current = { past: [], future: [] };
    }
  }, [visible]);

  // Snapshot current state — used by undo/redo. Tap into the relevant
  // primitives so we can restore them as a unit. We keep the history
  // small (last 20 entries) to bound memory.
  const snapshotState = useCallback(() => ({
    rotation, flipH, flipV,
    selectedFilter, filterIntensity, brightness,
    cropRect, selectedRatio,
    textItems, stickerItems, blurRegions,
  }), [rotation, flipH, flipV, selectedFilter, filterIntensity, brightness, cropRect, selectedRatio, textItems, stickerItems, blurRegions]);

  const restoreSnapshot = useCallback((snap) => {
    if (!snap) return;
    setRotation(snap.rotation);
    setFlipH(snap.flipH);
    setFlipV(snap.flipV);
    setSelectedFilter(snap.selectedFilter);
    setFilterIntensity(snap.filterIntensity);
    setBrightness(snap.brightness);
    setCropRect(snap.cropRect);
    setSelectedRatio(snap.selectedRatio);
    setTextItems(snap.textItems);
    setStickerItems(snap.stickerItems);
    setBlurRegions(snap.blurRegions);
  }, []);

  // Push the CURRENT state to the past stack and drop the future stack
  // (any redo branch is invalidated once the user makes a fresh edit).
  // Bound to 20 entries to keep memory in check on long sessions.
  const pushHistory = useCallback(() => {
    const h = historyRef.current;
    h.past.push(snapshotState());
    if (h.past.length > 20) h.past.shift();
    h.future = [];
  }, [snapshotState]);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.past.length) return;
    const prev = h.past.pop();
    h.future.push(snapshotState());
    if (h.future.length > 20) h.future.shift();
    restoreSnapshot(prev);
  }, [snapshotState, restoreSnapshot]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (!h.future.length) return;
    const next = h.future.pop();
    h.past.push(snapshotState());
    if (h.past.length > 20) h.past.shift();
    restoreSnapshot(next);
  }, [snapshotState, restoreSnapshot]);

  // ── Crop handlers ──

  const applyCropRatio = useCallback((ratio) => {
    pushHistory();
    setSelectedRatio(ratio);
    if (ratio === null) {
      setCropRect({ x: 0, y: 0, w: 1, h: 1 });
      return;
    }
    // Fit ratio inside current display area
    const imgAspect = displayDims.w / displayDims.h;
    let cw, ch;
    if (ratio > imgAspect) {
      cw = 1;
      ch = (displayDims.w / ratio) / displayDims.h;
    } else {
      ch = 1;
      cw = (displayDims.h * ratio) / displayDims.w;
    }
    cw = Math.min(cw, 1);
    ch = Math.min(ch, 1);
    setCropRect({
      x: (1 - cw) / 2,
      y: (1 - ch) / 2,
      w: cw,
      h: ch,
    });
  }, [displayDims, pushHistory]);

  // Convert crop rect to pixel coordinates on displayed image
  const cropPixels = useMemo(() => ({
    x: cropRect.x * displayDims.w,
    y: cropRect.y * displayDims.h,
    w: cropRect.w * displayDims.w,
    h: cropRect.h * displayDims.h,
  }), [cropRect, displayDims]);

  // Handle drag for crop handles and move
  const handleCropDrag = useCallback((type, gestureX, gestureY) => {
    if (!dragStartRef.current || !cropStartRef.current) return;
    const dx = (gestureX - dragStartRef.current.x) / displayDims.w;
    const dy = (gestureY - dragStartRef.current.y) / displayDims.h;
    const c = cropStartRef.current;

    let newCrop = { ...c };

    if (type === 'move') {
      newCrop.x = Math.max(0, Math.min(1 - c.w, c.x + dx));
      newCrop.y = Math.max(0, Math.min(1 - c.h, c.y + dy));
    } else {
      // Handle corners
      if (type === 'tl' || type === 'bl') {
        const newX = Math.max(0, Math.min(c.x + c.w - MIN_CROP / displayDims.w, c.x + dx));
        newCrop.w = c.w + (c.x - newX);
        newCrop.x = newX;
      }
      if (type === 'tr' || type === 'br') {
        newCrop.w = Math.max(MIN_CROP / displayDims.w, Math.min(1 - c.x, c.w + dx));
      }
      if (type === 'tl' || type === 'tr') {
        const newY = Math.max(0, Math.min(c.y + c.h - MIN_CROP / displayDims.h, c.y + dy));
        newCrop.h = c.h + (c.y - newY);
        newCrop.y = newY;
      }
      if (type === 'bl' || type === 'br') {
        newCrop.h = Math.max(MIN_CROP / displayDims.h, Math.min(1 - c.y, c.h + dy));
      }

      // Enforce ratio
      if (selectedRatio !== null) {
        const targetAspect = selectedRatio;
        const currentAspect = (newCrop.w * displayDims.w) / (newCrop.h * displayDims.h);
        if (currentAspect > targetAspect) {
          newCrop.w = (newCrop.h * displayDims.h * targetAspect) / displayDims.w;
        } else {
          newCrop.h = (newCrop.w * displayDims.w) / (targetAspect * displayDims.h);
        }
      }
    }

    setCropRect(newCrop);
  }, [displayDims, selectedRatio]);

  // Create pan responders for crop handles
  const createHandleResponder = useCallback((type) => {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => activeTab === 'crop',
      onMoveShouldSetPanResponder: () => activeTab === 'crop',
      onPanResponderGrant: (e) => {
        dragStartRef.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
        cropStartRef.current = { ...cropRect };
        setDragging(type);
      },
      onPanResponderMove: (e) => {
        handleCropDrag(type, e.nativeEvent.pageX, e.nativeEvent.pageY);
      },
      onPanResponderRelease: () => {
        setDragging(null);
        dragStartRef.current = null;
        cropStartRef.current = null;
      },
    });
  }, [activeTab, cropRect, handleCropDrag]);

  // Memoize pan responders
  const tlPan = useMemo(() => createHandleResponder('tl'), [createHandleResponder]);
  const trPan = useMemo(() => createHandleResponder('tr'), [createHandleResponder]);
  const blPan = useMemo(() => createHandleResponder('bl'), [createHandleResponder]);
  const brPan = useMemo(() => createHandleResponder('br'), [createHandleResponder]);
  const movePan = useMemo(() => createHandleResponder('move'), [createHandleResponder]);

  // ── Overlay helpers (text / sticker / blur) ──

  const genId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const addTextItem = useCallback(() => {
    const value = (textInputValue || '').trim();
    if (!value) return;
    pushHistory();
    const id = genId();
    setTextItems(prev => [...prev, {
      id,
      // Drop new text at center of crop area (display coords)
      x: cropPixels.x + cropPixels.w / 2 - 60,
      y: cropPixels.y + cropPixels.h / 2 - 16,
      value,
      color: textColor,
      size: 28,
    }]);
    setActiveOverlayId(id);
    setTextInputValue('');
  }, [textInputValue, textColor, cropPixels, pushHistory]);

  const addStickerItem = useCallback((emoji) => {
    pushHistory();
    const id = genId();
    setStickerItems(prev => [...prev, {
      id,
      x: cropPixels.x + cropPixels.w / 2 - 28,
      y: cropPixels.y + cropPixels.h / 2 - 28,
      emoji,
      size: 56,
    }]);
    setActiveOverlayId(id);
  }, [cropPixels, pushHistory]);

  const addBlurRegion = useCallback(() => {
    pushHistory();
    const id = genId();
    const w = Math.min(160, cropPixels.w * 0.5);
    const h = Math.min(160, cropPixels.h * 0.5);
    setBlurRegions(prev => [...prev, {
      id,
      x: cropPixels.x + cropPixels.w / 2 - w / 2,
      y: cropPixels.y + cropPixels.h / 2 - h / 2,
      w, h,
      intensity: 0.7,
    }]);
    setActiveOverlayId(id);
  }, [cropPixels, pushHistory]);

  const removeOverlay = useCallback((id) => {
    pushHistory();
    setTextItems(prev => prev.filter(t => t.id !== id));
    setStickerItems(prev => prev.filter(s => s.id !== id));
    setBlurRegions(prev => prev.filter(b => b.id !== id));
    if (activeOverlayId === id) setActiveOverlayId(null);
  }, [activeOverlayId, pushHistory]);

  // PanResponder factory for moving an overlay item by id+kind.
  // Mirrors the crop-handle pattern: capture starting pos on grant, then
  // translate by gesture delta on each move event.
  const createOverlayResponder = useCallback((id, kind) => {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        setActiveOverlayId(id);
        const list = kind === 'text' ? textItems : kind === 'sticker' ? stickerItems : blurRegions;
        const item = list.find(i => i.id === id);
        if (item) overlayDragStartRef.current = { x: item.x, y: item.y };
      },
      onPanResponderMove: (_, gs) => {
        const start = overlayDragStartRef.current;
        if (!start) return;
        const nx = start.x + gs.dx;
        const ny = start.y + gs.dy;
        if (kind === 'text') {
          setTextItems(prev => prev.map(t => t.id === id ? { ...t, x: nx, y: ny } : t));
        } else if (kind === 'sticker') {
          setStickerItems(prev => prev.map(s => s.id === id ? { ...s, x: nx, y: ny } : s));
        } else {
          setBlurRegions(prev => prev.map(b => b.id === id ? { ...b, x: nx, y: ny } : b));
        }
      },
      onPanResponderRelease: () => { overlayDragStartRef.current = null; },
    });
  }, [textItems, stickerItems, blurRegions]);

  // ── Rotate / Flip ──

  const rotateLeft = useCallback(() => { pushHistory(); setRotation(r => (r + 270) % 360); }, [pushHistory]);
  const rotateRight = useCallback(() => { pushHistory(); setRotation(r => (r + 90) % 360); }, [pushHistory]);
  const toggleFlipH = useCallback(() => { pushHistory(); setFlipH(v => !v); }, [pushHistory]);
  const toggleFlipV = useCallback(() => { pushHistory(); setFlipV(v => !v); }, [pushHistory]);

  // ── Reset ──

  const resetAll = useCallback(() => {
    setRotation(0);
    setFlipH(false);
    setFlipV(false);
    setSelectedFilter('original');
    setFilterIntensity(100);
    setBrightness(0);
    setCropRect({ x: 0, y: 0, w: 1, h: 1 });
    setSelectedRatio(null);
    setTextItems([]);
    setStickerItems([]);
    setBlurRegions([]);
    setActiveOverlayId(null);
  }, []);

  // ── Save ──

  const handleSave = useCallback(async () => {
    if (!imageUri) return;
    setSaving(true);
    try {
      // Web: canvas path bakes EVERYTHING in one pass (transforms + filter
      // + overlays). It's cheaper than ImageManipulator → re-load → overlay.
      if (Platform.OS === 'web') {
        const result = await saveWithCanvas();
        if (result) { onSave?.(result); return; }
      }

      let ImageManipulator = null;
      try { ImageManipulator = require('expo-image-manipulator'); } catch {}

      if (!ImageManipulator?.manipulateAsync) {
        onSave?.(imageUri);
        return;
      }

      const hasOverlays = textItems.length + stickerItems.length + blurRegions.length > 0;
      // TODO(native overlay flatten): use react-native-view-shot to capture
      // the rendered overlay layer and composite onto ImageManipulator output.
      // For now native saves transforms+filter only — overlays are visible
      // in-editor but skipped on save. Web canvas path is fully functional.
      if (hasOverlays && __DEV__) {
        console.warn('[PhotoEditor] overlays only baked on web for now; native flatten TODO.');
      }

      const actions = [];

      // Apply rotation
      if (rotation !== 0) {
        actions.push({ rotate: -rotation });
      }

      // Apply flips
      if (flipH) actions.push({ flip: ImageManipulator.FlipType.Horizontal });
      if (flipV) actions.push({ flip: ImageManipulator.FlipType.Vertical });

      // Apply crop (convert from percentage to actual pixel coordinates)
      if (cropRect.x > 0.001 || cropRect.y > 0.001 || cropRect.w < 0.999 || cropRect.h < 0.999) {
        const isRotated = rotation === 90 || rotation === 270;
        const srcW = isRotated ? imageSize.h : imageSize.w;
        const srcH = isRotated ? imageSize.w : imageSize.h;
        actions.push({
          crop: {
            originX: Math.round(cropRect.x * srcW),
            originY: Math.round(cropRect.y * srcH),
            width: Math.round(cropRect.w * srcW),
            height: Math.round(cropRect.h * srcH),
          },
        });
      }

      // Grayscale filter needs special handling — use resize with grayscale isn't available
      // We'll handle it via options if possible
      const opts = { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG };

      let result;
      if (actions.length > 0) {
        result = await ImageManipulator.manipulateAsync(imageUri, actions, opts);
      } else {
        result = await ImageManipulator.manipulateAsync(imageUri, [], opts);
      }

      onSave?.(result.uri);
    } catch (err) {
      console.warn('PhotoEditor save error:', err);
      onSave?.(imageUri);
    } finally {
      setSaving(false);
    }
  }, [imageUri, rotation, flipH, flipV, cropRect, imageSize, selectedFilter, onSave, textItems, stickerItems, blurRegions]);

  // Canvas-based save for web
  const saveWithCanvas = useCallback(async () => {
    if (Platform.OS !== 'web') return null;
    try {
      const img = new window.Image();
      img.crossOrigin = 'anonymous';
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = imageUri;
      });

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      const isRotated = rotation === 90 || rotation === 270;
      const srcW = isRotated ? img.height : img.width;
      const srcH = isRotated ? img.width : img.height;

      // Apply crop to source dimensions
      const cx = Math.round(cropRect.x * srcW);
      const cy = Math.round(cropRect.y * srcH);
      const cw = Math.round(cropRect.w * srcW);
      const ch = Math.round(cropRect.h * srcH);

      canvas.width = cw;
      canvas.height = ch;

      ctx.save();

      // Transform for rotation and flip
      ctx.translate(cw / 2, ch / 2);
      ctx.rotate((-rotation * Math.PI) / 180);
      const sx = flipH ? -1 : 1;
      const sy = flipV ? -1 : 1;
      ctx.scale(sx, sy);

      // Calculate source region in original image coordinates
      // For rotated images, we need to transform crop coordinates back
      let drawX, drawY, drawW, drawH;
      if (rotation === 0) {
        drawX = cx; drawY = cy; drawW = cw; drawH = ch;
        ctx.drawImage(img, drawX, drawY, drawW, drawH, -cw / 2, -ch / 2, cw, ch);
      } else {
        // For rotated: draw full image rotated, then the canvas crop handles it
        const fullW = isRotated ? img.height : img.width;
        const fullH = isRotated ? img.width : img.height;
        ctx.drawImage(img, -fullW / 2 + cx, -fullH / 2 + cy, cw, ch, -cw / 2, -ch / 2, cw, ch);
      }

      ctx.restore();

      // Apply brightness overlay
      if (brightness !== 0) {
        ctx.globalAlpha = Math.abs(brightness) / 100;
        ctx.fillStyle = brightness > 0 ? '#ffffff' : '#000000';
        ctx.fillRect(0, 0, cw, ch);
      }

      // Apply filter overlay (scaled by user-selected intensity 0-100).
      const filter = FILTERS.find(f => f.key === selectedFilter);
      if (filter?.overlay) {
        ctx.globalAlpha = Math.max(0, Math.min(1, filterIntensity / 100));
        ctx.fillStyle = filter.overlay;
        ctx.fillRect(0, 0, cw, ch);
        ctx.globalAlpha = 1;
      }
      if (filter?.grayscale) {
        const imgData = ctx.getImageData(0, 0, cw, ch);
        const data = imgData.data;
        for (let i = 0; i < data.length; i += 4) {
          const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          data[i] = gray;
          data[i + 1] = gray;
          data[i + 2] = gray;
        }
        ctx.putImageData(imgData, 0, 0);
      }

      // ── Bake overlays (text + stickers + blur regions) ──
      // Overlays are stored in display-pixel coords (relative to displayDims).
      // Convert them to canvas coords by:
      //   1. subtracting the crop origin (in display px)
      //   2. multiplying by srcW/displayDims.w (display→source scale)
      // Both ops use the SAME math the crop already used, so positions match
      // exactly what the user saw in the editor preview.
      if (textItems.length || stickerItems.length || blurRegions.length) {
        const dispScaleX = displayDims.w > 0 ? srcW / displayDims.w : 1;
        const dispScaleY = displayDims.h > 0 ? srcH / displayDims.h : 1;
        const cropOriginX = cropRect.x * displayDims.w;
        const cropOriginY = cropRect.y * displayDims.h;

        // Blur first (under text/stickers). Implement via re-sampling: copy
        // a region, scale-down then scale-up, draw back. Cheap pixelate
        // effect — visually similar to a Gaussian blur for moderate areas.
        for (const b of blurRegions) {
          const bx = (b.x - cropOriginX) * dispScaleX;
          const by = (b.y - cropOriginY) * dispScaleY;
          const bw = b.w * dispScaleX;
          const bh = b.h * dispScaleY;
          if (bw <= 0 || bh <= 0) continue;
          // Pixelate: shrink to ~1/16 then grow back with imageSmoothingEnabled=false
          const tmp = document.createElement('canvas');
          const pixSize = Math.max(4, Math.round(Math.min(bw, bh) / 16));
          tmp.width = Math.max(1, Math.round(bw / pixSize));
          tmp.height = Math.max(1, Math.round(bh / pixSize));
          const tctx = tmp.getContext('2d');
          tctx.imageSmoothingEnabled = false;
          tctx.drawImage(canvas, bx, by, bw, bh, 0, 0, tmp.width, tmp.height);
          ctx.save();
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, bx, by, bw, bh);
          ctx.restore();
        }

        // Text — draw with shadow for legibility on busy photos
        for (const t of textItems) {
          const tx = (t.x - cropOriginX) * dispScaleX;
          const ty = (t.y - cropOriginY) * dispScaleY;
          const fontPx = (t.size || 28) * Math.min(dispScaleX, dispScaleY);
          ctx.save();
          ctx.font = `700 ${fontPx}px sans-serif`;
          ctx.textBaseline = 'top';
          ctx.shadowColor = 'rgba(0,0,0,0.6)';
          ctx.shadowBlur = fontPx * 0.15;
          ctx.fillStyle = t.color || '#fff';
          ctx.fillText(t.value, tx, ty);
          ctx.restore();
        }

        // Stickers (emoji glyphs)
        for (const st of stickerItems) {
          const sx2 = (st.x - cropOriginX) * dispScaleX;
          const sy2 = (st.y - cropOriginY) * dispScaleY;
          const stSize = (st.size || 56) * Math.min(dispScaleX, dispScaleY);
          ctx.save();
          ctx.font = `${stSize}px sans-serif`;
          ctx.textBaseline = 'top';
          ctx.fillText(st.emoji, sx2, sy2);
          ctx.restore();
        }
      }

      return canvas.toDataURL('image/jpeg', 0.92);
    } catch (err) {
      console.warn('Canvas save error:', err);
      return null;
    }
  }, [imageUri, rotation, flipH, flipV, cropRect, brightness, selectedFilter, filterIntensity, textItems, stickerItems, blurRegions, displayDims]);

  // ── Filter overlay for current filter ──
  const currentFilter = useMemo(() => FILTERS.find(f => f.key === selectedFilter), [selectedFilter]);

  // ── Brightness slider ──
  const brightnessSliderPan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {},
    onPanResponderMove: (e, gs) => {
      const sliderW = screenW - 80;
      const pct = Math.max(-100, Math.min(100, brightness + (gs.dx / sliderW) * 200));
      setBrightness(Math.round(pct));
    },
  }), [brightness, screenW]);

  // ── Filter intensity slider (0-100) ──
  // Same gesture math as brightness but mapped to a 0-100 range. Touch
  // anywhere on the track jumps the knob; drag adjusts incrementally.
  const filterIntensityPan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderMove: (e, gs) => {
      const sliderW = screenW - 80;
      const pct = Math.max(0, Math.min(100, filterIntensity + (gs.dx / sliderW) * 100));
      setFilterIntensity(Math.round(pct));
    },
  }), [filterIntensity, screenW]);

  // ── Render ──

  if (!visible) return null;

  const filterI18n = {
    original: t('photos.original'),
    vivid: t('photos.vivid'),
    warm: t('photos.warm'),
    cool: t('photos.cool'),
    bw: t('photos.bw'),
    sepia: t('photos.sepia'),
    fade: t('photos.fade'),
    dramatic: t('photos.dramatic'),
  };

  // Each tab icon is rendered at 24px so the 44pt hit target reads as a
  // proper toolbar item (vs the cramped 20px we had before). Active tabs
  // paint white; inactive go to textTertiary-ish #888 so contrast still
  // pops on the black tray. Music + Tag are placeholders (no panel yet).
  const tabIconColor = (key) => activeTab === key ? '#fff' : '#888';
  const tabIcons = {
    filters: <IconFilters size={24} color={tabIconColor('filters')} />,
    text: (
      <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={tabIconColor('text')} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" />
        <Path d="M9 20h6" />
        <Path d="M12 4v16" />
      </Svg>
    ),
    sticker: (
      <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={tabIconColor('sticker')} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M15.5 3H7a4 4 0 0 0-4 4v10a4 4 0 0 0 4 4h7l7-7V8.5z" />
        <Path d="M15 21v-5a2 2 0 0 1 2-2h4" />
        <Circle cx="9" cy="10" r="1" />
        <Circle cx="14" cy="10" r="1" />
        <Path d="M9 14c.5 1 1.5 1.5 2.5 1.5S13.5 15 14 14" />
      </Svg>
    ),
    draw: (
      <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={tabIconColor('draw')} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M12 19l7-7 3 3-7 7-3-3z" />
        <Path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18z" />
        <Path d="M2 2l7.5 7.5" />
        <Circle cx="11" cy="11" r="2" />
      </Svg>
    ),
    crop: <IconCrop size={24} color={tabIconColor('crop')} />,
    adjust: <IconSun size={24} color={tabIconColor('adjust')} />,
    music: (
      <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={tabIconColor('music')} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M9 18V5l12-2v13" />
        <Circle cx="6" cy="18" r="3" />
        <Circle cx="18" cy="16" r="3" />
      </Svg>
    ),
    tag: (
      <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={tabIconColor('tag')} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <Circle cx="12" cy="7" r="4" />
      </Svg>
    ),
  };

  // Reuse photos.* keys when present, fall back to PT-BR label inline (no
  // new i18n keys per task constraints — placeholder labels are okay).
  const tabLabels = {
    filters: t('photos.filters') || 'Filtros',
    text: t('photos.text') || 'Texto',
    sticker: 'Adesivos',
    draw: 'Desenho',
    crop: t('photos.crop') || 'Cortar',
    adjust: 'Brilho',
    music: 'Música',
    tag: 'Marcar',
  };

  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;

  return (
    <Modal visible={visible} animationType="fade" transparent={false} onRequestClose={onClose}>
      <View style={s.container}>
        {/* Top bar — X on the left, "Próximo" pill on the right (primary
            purple). Reset is folded into a small icon pill in the middle so
            users still have the safety hatch without crowding the header. */}
        <View style={[s.topBar, { paddingTop: insets.top + 6, height: 56 + insets.top }]}>
          <TouchableOpacity onPress={onClose} style={s.topIconBtn} accessibilityLabel={t('common.cancel')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <IconX size={26} color="#fff" />
          </TouchableOpacity>

          <TouchableOpacity onPress={resetAll} style={s.resetPill} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
            <IconRefresh size={14} color="#fff" />
            <Text style={s.resetPillText}>{t('photos.reset')}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleSave}
            style={[s.nextPill, saving && { opacity: 0.6 }]}
            disabled={saving}
            accessibilityLabel={t('photos.save')}
            activeOpacity={0.85}
          >
            {saving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={s.nextPillText}>{t('photos.next') || t('common.next') || 'Próximo'}</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Undo/redo — vertical stack pinned top-right under the header.
            Sits above the image area with a translucent black tray so the
            icons stay legible on bright photos. Disabled state dims to 0.3. */}
        <View style={s.undoRedoStack} pointerEvents="box-none">
          <TouchableOpacity
            onPress={undo}
            disabled={!canUndo}
            style={[s.undoRedoBtn, !canUndo && { opacity: 0.3 }]}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            accessibilityLabel="Undo"
          >
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M9 14L4 9l5-5" />
              <Path d="M4 9h11a5 5 0 0 1 0 10h-4" />
            </Svg>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={redo}
            disabled={!canRedo}
            style={[s.undoRedoBtn, !canRedo && { opacity: 0.3 }]}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            accessibilityLabel="Redo"
          >
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M15 14l5-5-5-5" />
              <Path d="M20 9H9a5 5 0 0 0 0 10h4" />
            </Svg>
          </TouchableOpacity>
        </View>

        {/* Image area */}
        <View style={s.imageArea}>
          {imageUri && imageLoaded ? (
            <View style={{
              position: 'absolute',
              left: displayDims.x,
              top: displayDims.y - topBarH - 8,
              width: displayDims.w,
              height: displayDims.h,
            }}>
              {/* Main image */}
              <Image
                source={{ uri: imageUri }}
                style={[
                  { width: displayDims.w, height: displayDims.h },
                  {
                    transform: [
                      { rotate: `${rotation}deg` },
                      { scaleX: flipH ? -1 : 1 },
                      { scaleY: flipV ? -1 : 1 },
                    ],
                  },
                ]}
                resizeMode="contain"
              />

              {/* Filter overlay — opacity reflects intensity slider */}
              {currentFilter?.overlay && (
                <View
                  style={[s.filterOverlay, {
                    width: displayDims.w,
                    height: displayDims.h,
                    backgroundColor: currentFilter.overlay,
                    opacity: Math.max(0, Math.min(1, filterIntensity / 100)),
                  }]}
                  pointerEvents="none"
                />
              )}

              {/* Grayscale overlay (simulated with blend) */}
              {currentFilter?.grayscale && Platform.OS === 'web' && (
                <View
                  style={[s.filterOverlay, {
                    width: displayDims.w,
                    height: displayDims.h,
                    backgroundColor: 'transparent',
                    // @ts-ignore web-only
                    backdropFilter: 'grayscale(1)',
                    WebkitBackdropFilter: 'grayscale(1)',
                  }]}
                  pointerEvents="none"
                />
              )}

              {/* Brightness overlay */}
              {brightness !== 0 && (
                <View
                  style={[s.filterOverlay, {
                    width: displayDims.w,
                    height: displayDims.h,
                    backgroundColor: brightness > 0 ? '#ffffff' : '#000000',
                    opacity: Math.abs(brightness) / 200,
                  }]}
                  pointerEvents="none"
                />
              )}

              {/* Crop overlay (darken outside crop area) */}
              {activeTab === 'crop' && (
                <>
                  {/* Top dark area */}
                  <View style={[s.cropDark, {
                    left: 0, top: 0,
                    width: displayDims.w,
                    height: cropPixels.y,
                  }]} pointerEvents="none" />
                  {/* Bottom dark area */}
                  <View style={[s.cropDark, {
                    left: 0,
                    top: cropPixels.y + cropPixels.h,
                    width: displayDims.w,
                    height: displayDims.h - cropPixels.y - cropPixels.h,
                  }]} pointerEvents="none" />
                  {/* Left dark area */}
                  <View style={[s.cropDark, {
                    left: 0,
                    top: cropPixels.y,
                    width: cropPixels.x,
                    height: cropPixels.h,
                  }]} pointerEvents="none" />
                  {/* Right dark area */}
                  <View style={[s.cropDark, {
                    left: cropPixels.x + cropPixels.w,
                    top: cropPixels.y,
                    width: displayDims.w - cropPixels.x - cropPixels.w,
                    height: cropPixels.h,
                  }]} pointerEvents="none" />

                  {/* Crop border */}
                  <View style={[s.cropBorder, {
                    left: cropPixels.x,
                    top: cropPixels.y,
                    width: cropPixels.w,
                    height: cropPixels.h,
                  }]} pointerEvents="none">
                    {/* Grid lines (rule of thirds) */}
                    <View style={[s.gridLineH, { top: '33.33%' }]} />
                    <View style={[s.gridLineH, { top: '66.66%' }]} />
                    <View style={[s.gridLineV, { left: '33.33%' }]} />
                    <View style={[s.gridLineV, { left: '66.66%' }]} />
                  </View>

                  {/* Move area (center of crop) */}
                  <View
                    {...movePan.panHandlers}
                    style={[s.cropMoveArea, {
                      left: cropPixels.x + HANDLE_SIZE / 2,
                      top: cropPixels.y + HANDLE_SIZE / 2,
                      width: Math.max(0, cropPixels.w - HANDLE_SIZE),
                      height: Math.max(0, cropPixels.h - HANDLE_SIZE),
                    }]}
                  />

                  {/* Corner handles */}
                  <View {...tlPan.panHandlers} style={[s.cropHandle, {
                    left: cropPixels.x - HANDLE_SIZE / 2,
                    top: cropPixels.y - HANDLE_SIZE / 2,
                  }]}>
                    <View style={[s.handleCorner, s.handleTL]} />
                  </View>
                  <View {...trPan.panHandlers} style={[s.cropHandle, {
                    left: cropPixels.x + cropPixels.w - HANDLE_SIZE / 2,
                    top: cropPixels.y - HANDLE_SIZE / 2,
                  }]}>
                    <View style={[s.handleCorner, s.handleTR]} />
                  </View>
                  <View {...blPan.panHandlers} style={[s.cropHandle, {
                    left: cropPixels.x - HANDLE_SIZE / 2,
                    top: cropPixels.y + cropPixels.h - HANDLE_SIZE / 2,
                  }]}>
                    <View style={[s.handleCorner, s.handleBL]} />
                  </View>
                  <View {...brPan.panHandlers} style={[s.cropHandle, {
                    left: cropPixels.x + cropPixels.w - HANDLE_SIZE / 2,
                    top: cropPixels.y + cropPixels.h - HANDLE_SIZE / 2,
                  }]}>
                    <View style={[s.handleCorner, s.handleBR]} />
                  </View>
                </>
              )}

              {/* Overlay layer — text, stickers, blur regions. Always
                  rendered (independent of active tab) so the user can see
                  prior work while continuing on a different tab. Each
                  child gets its own PanResponder via DraggableOverlay. */}
              {blurRegions.map(b => (
                <DraggableOverlay
                  key={b.id}
                  responder={createOverlayResponder(b.id, 'blur')}
                  active={activeOverlayId === b.id}
                  onDelete={() => removeOverlay(b.id)}
                  style={{
                    left: b.x, top: b.y, width: b.w, height: b.h,
                    // CSS blur on web preview; native shows a translucent
                    // box (real pixelate happens at save time on web only).
                    ...(Platform.OS === 'web'
                      ? { backdropFilter: `blur(${(b.intensity || 0.7) * 12}px)`, WebkitBackdropFilter: `blur(${(b.intensity || 0.7) * 12}px)` }
                      : { backgroundColor: 'rgba(255,255,255,0.45)' }
                    ),
                  }}
                />
              ))}
              {textItems.map(it => (
                <DraggableOverlay
                  key={it.id}
                  responder={createOverlayResponder(it.id, 'text')}
                  active={activeOverlayId === it.id}
                  onDelete={() => removeOverlay(it.id)}
                  style={{ left: it.x, top: it.y }}
                >
                  <Text style={{
                    color: it.color || '#fff',
                    fontSize: it.size || 28,
                    fontWeight: '800',
                    textShadowColor: 'rgba(0,0,0,0.6)',
                    textShadowOffset: { width: 0, height: 1 },
                    textShadowRadius: 4,
                  }}>{it.value}</Text>
                </DraggableOverlay>
              ))}
              {stickerItems.map(it => (
                <DraggableOverlay
                  key={it.id}
                  responder={createOverlayResponder(it.id, 'sticker')}
                  active={activeOverlayId === it.id}
                  onDelete={() => removeOverlay(it.id)}
                  style={{ left: it.x, top: it.y }}
                >
                  <Text style={{ fontSize: it.size || 56 }}>{it.emoji}</Text>
                </DraggableOverlay>
              ))}
            </View>
          ) : (
            <ActivityIndicator size="large" color="#fff" />
          )}
        </View>

        {/* Bottom controls area */}
        <View style={s.controlsArea}>
          {/* Tab-specific controls */}
          <View style={s.controlContent}>
            {activeTab === 'crop' && (
              <View>
                {/* Rotate / flip helpers stay reachable from crop tab — they
                    were previously gated behind a "rotate" tab but the new
                    8-slot toolbar drops that tab to make room for music/tag.
                    Compact 36pt icon row above the aspect chips. */}
                <View style={s.cropTransformRow}>
                  <TouchableOpacity style={s.transformBtn} onPress={rotateLeft}>
                    <IconRotateCcw size={20} color="#fff" />
                  </TouchableOpacity>
                  <TouchableOpacity style={s.transformBtn} onPress={rotateRight}>
                    <IconRotateCw size={20} color="#fff" />
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.transformBtn, flipH && s.transformBtnActive]} onPress={toggleFlipH}>
                    <IconFlipH size={20} color="#fff" />
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.transformBtn, flipV && s.transformBtnActive]} onPress={toggleFlipV}>
                    <IconFlipV size={20} color="#fff" />
                  </TouchableOpacity>
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.ratioRow}>
                  {CROP_RATIOS.map((r) => {
                    const isActive = selectedRatio === r.value;
                    return (
                      <TouchableOpacity
                        key={r.label}
                        style={[s.ratioBtn, isActive && s.ratioBtnActive]}
                        onPress={() => applyCropRatio(r.value)}
                        activeOpacity={0.85}
                      >
                        <Text style={[s.ratioBtnText, isActive && s.ratioBtnTextActive]}>{r.label}</Text>
                        {r.sub && (
                          <Text style={[s.ratioBtnSub, isActive && s.ratioBtnSubActive]}>{r.sub}</Text>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            )}

            {/* rotate tab folded into crop — see s.cropTransformRow above */}

            {activeTab === 'filters' && (
              <View>
                {/* Intensity slider — only meaningful for non-Original
                    filters. Hides for Original to avoid no-op UI. The
                    track uses a purple→darker-purple gradient via two
                    layered fills (web also gets the real CSS gradient). */}
                {selectedFilter !== 'original' && (
                  <View style={s.intensityRow}>
                    <Text style={s.intensityLabel}>{Math.round(filterIntensity)}</Text>
                    <View style={s.intensitySliderContainer}>
                      <View style={s.intensityTrackBg} />
                      <View
                        style={[
                          s.intensityTrackFill,
                          {
                            width: `${filterIntensity}%`,
                            ...(Platform.OS === 'web'
                              ? { backgroundImage: `linear-gradient(90deg, ${BRAND_DARK}, ${BRAND})` }
                              : { backgroundColor: BRAND }
                            ),
                          },
                        ]}
                      />
                      <View
                        style={[s.intensityKnob, { left: `${filterIntensity}%` }]}
                        {...filterIntensityPan.panHandlers}
                      />
                      <TouchableOpacity
                        style={s.sliderTapArea}
                        activeOpacity={1}
                        onPress={(e) => {
                          const sliderW = screenW - 100;
                          const tapX = e.nativeEvent.locationX;
                          const pct = Math.round((tapX / sliderW) * 100);
                          setFilterIntensity(Math.max(0, Math.min(100, pct)));
                        }}
                      />
                    </View>
                  </View>
                )}
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filterRow}>
                  {FILTERS.map((f) => {
                    const isActive = selectedFilter === f.key;
                    return (
                      <TouchableOpacity
                        key={f.key}
                        style={s.filterItem}
                        onPress={() => {
                          if (selectedFilter !== f.key) pushHistory();
                          setSelectedFilter(f.key);
                          // Reset to full strength when picking a new filter
                          // so the user immediately sees the effect.
                          setFilterIntensity(100);
                        }}
                        activeOpacity={0.85}
                      >
                        <View style={[s.filterThumb, isActive && s.filterThumbActive]}>
                          {imageUri && (
                            <Image
                              source={{ uri: imageUri }}
                              style={[
                                s.filterThumbImg,
                                f.grayscale && Platform.OS === 'web' && {
                                  filter: 'grayscale(1)',
                                },
                              ]}
                              resizeMode="cover"
                            />
                          )}
                          {f.overlay && (
                            <View style={[s.filterThumbOverlay, { backgroundColor: f.overlay }]} />
                          )}
                        </View>
                        <Text style={[s.filterLabel, isActive && s.filterLabelActive]} numberOfLines={1}>
                          {filterI18n[f.key] || f.key}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            )}

            {activeTab === 'text' && (
              <View style={s.textPanel}>
                <View style={s.textInputRow}>
                  <TextInput
                    value={textInputValue}
                    onChangeText={setTextInputValue}
                    placeholder={t('photos.text') || 'Toque na foto e digite…'}
                    placeholderTextColor="#888"
                    style={s.textInput}
                    onSubmitEditing={addTextItem}
                    returnKeyType="done"
                    maxLength={140}
                  />
                  <TouchableOpacity
                    onPress={addTextItem}
                    disabled={!textInputValue.trim()}
                    style={[s.textAddBtn, !textInputValue.trim() && { opacity: 0.4 }]}
                  >
                    <Text style={s.textAddBtnLabel}>+</Text>
                  </TouchableOpacity>
                </View>
                {/* 10 colors in a single row + a "+" custom slot. The custom
                    slot is a placeholder (real picker is TODO); pressing it
                    just resets to white so users see immediate feedback. */}
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.colorRow}>
                  {PEN_COLORS.map(c => (
                    <TouchableOpacity
                      key={c}
                      onPress={() => setTextColor(c)}
                      style={[
                        s.colorSwatch,
                        {
                          backgroundColor: c,
                          borderColor: textColor === c ? '#fff' : 'rgba(255,255,255,0.4)',
                          borderWidth: textColor === c ? 2.5 : 1,
                        },
                      ]}
                      activeOpacity={0.8}
                    />
                  ))}
                  <TouchableOpacity
                    onPress={() => setTextColor('#ffffff')}
                    style={s.colorCustomBtn}
                    activeOpacity={0.8}
                  >
                    <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                      <Path d="M12 5v14" />
                      <Path d="M5 12h14" />
                    </Svg>
                  </TouchableOpacity>
                </ScrollView>
              </View>
            )}

            {activeTab === 'sticker' && (
              <View>
                {/* Pack tabs as pills — only the active pack's grid renders.
                    Non-emoji packs are placeholders per task spec. */}
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.stickerPackRow}>
                  {STICKER_PACKS.map(pack => {
                    const active = pack.key === stickerPack;
                    return (
                      <TouchableOpacity
                        key={pack.key}
                        onPress={() => setStickerPack(pack.key)}
                        style={[s.stickerPackPill, active && s.stickerPackPillActive]}
                      >
                        <Text style={[s.stickerPackLabel, active && s.stickerPackLabelActive]}>{pack.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.stickerRow}>
                  {(STICKER_PACKS.find(p => p.key === stickerPack)?.items || []).map((em, idx) => (
                    <TouchableOpacity
                      key={`${em}-${idx}`}
                      onPress={() => addStickerItem(em)}
                      style={s.stickerBtn}
                      activeOpacity={0.7}
                    >
                      <Text style={{ fontSize: 28 }}>{em}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}

            {activeTab === 'draw' && (
              <View style={s.placeholderPanel}>
                <TouchableOpacity onPress={addBlurRegion} style={s.blurAddBtn}>
                  <Text style={s.blurAddBtnLabel}>+ Pincel (em breve)</Text>
                </TouchableOpacity>
                <Text style={s.placeholderHint}>
                  Desenhe livre na foto. Cores e espessura em breve.
                </Text>
              </View>
            )}

            {activeTab === 'music' && (
              <View style={s.placeholderPanel}>
                <Text style={s.placeholderTitle}>Música</Text>
                <Text style={s.placeholderHint}>Adicione uma trilha. Em breve.</Text>
              </View>
            )}

            {activeTab === 'tag' && (
              <View style={s.placeholderPanel}>
                <Text style={s.placeholderTitle}>Marcar pessoas</Text>
                <Text style={s.placeholderHint}>Toque na foto para marcar amigos. Em breve.</Text>
              </View>
            )}

            {activeTab === 'adjust' && (
              <View style={s.adjustPanel}>
                <View style={s.adjustRow}>
                  <IconSun size={18} color="#aaa" />
                  <Text style={s.adjustLabel}>{t('photos.brightness')}</Text>
                  <Text style={s.adjustValue}>{brightness > 0 ? `+${brightness}` : brightness}</Text>
                </View>
                <View style={s.sliderContainer}>
                  <View style={s.sliderTrack}>
                    <View style={[s.sliderFill, {
                      left: '50%',
                      width: `${Math.abs(brightness) / 2}%`,
                      marginLeft: brightness < 0 ? `-${Math.abs(brightness) / 2}%` : 0,
                    }]} />
                  </View>
                  <View
                    style={[s.sliderKnob, {
                      left: `${50 + brightness / 2}%`,
                    }]}
                    {...brightnessSliderPan.panHandlers}
                  />
                  {/* Tappable track for direct position */}
                  <TouchableOpacity
                    style={s.sliderTapArea}
                    activeOpacity={1}
                    onPress={(e) => {
                      const sliderW = screenW - 80;
                      const tapX = e.nativeEvent.locationX;
                      const pct = Math.round(((tapX / sliderW) * 200) - 100);
                      setBrightness(Math.max(-100, Math.min(100, pct)));
                    }}
                  />
                </View>
              </View>
            )}
          </View>

          {/* Tab bar — horizontal scroll fits 7 tabs without cramping the
              labels on phones. justifyContent on the contentContainer keeps
              tabs centered when the row IS narrow enough to fit. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={s.tabBarScroll}
            contentContainerStyle={s.tabBar}
          >
            {TABS.map((tab) => (
              <TouchableOpacity
                key={tab}
                style={[s.tabItem, activeTab === tab && s.tabItemActive]}
                onPress={() => setActiveTab(tab)}
              >
                {tabIcons[tab]}
                <Text style={[s.tabText, activeTab === tab && [s.tabTextActive, { color: colors.primary }]]}>
                  {tabLabels[tab]}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ── Styles ──

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    height: 56,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(0,0,0,0.8)',
    zIndex: 10,
  },
  // Bare X / refresh icon — no pill background. 44pt hit target.
  topIconBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resetPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  resetPillText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
  },
  // Próximo pill — primary purple, white text, generous radius. Becomes
  // the visual anchor on the right of the header.
  nextPill: {
    backgroundColor: BRAND,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 22,
    minWidth: 92,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: BRAND,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
  },
  nextPillText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  // Undo/redo vertical stack pinned just under the header on the right.
  // Sits above the image area as a floating tray so it doesn't push the
  // photo down. Top must clear topBar (56) + a small 8 gap.
  undoRedoStack: {
    position: 'absolute',
    top: 64,
    right: 10,
    zIndex: 9,
    flexDirection: 'column',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 22,
    padding: 4,
  },
  undoRedoBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  filterOverlay: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  // Crop overlay
  cropDark: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  cropBorder: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#fff',
  },
  gridLineH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  gridLineV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  cropHandle: {
    position: 'absolute',
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 20,
  },
  handleCorner: {
    position: 'absolute',
    width: 20,
    height: 20,
  },
  handleTL: {
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderColor: '#fff',
    top: HANDLE_SIZE / 2 - 2,
    left: HANDLE_SIZE / 2 - 2,
  },
  handleTR: {
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderColor: '#fff',
    top: HANDLE_SIZE / 2 - 2,
    right: HANDLE_SIZE / 2 - 2,
  },
  handleBL: {
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderColor: '#fff',
    bottom: HANDLE_SIZE / 2 - 2,
    left: HANDLE_SIZE / 2 - 2,
  },
  handleBR: {
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderColor: '#fff',
    bottom: HANDLE_SIZE / 2 - 2,
    right: HANDLE_SIZE / 2 - 2,
  },
  cropMoveArea: {
    position: 'absolute',
    zIndex: 15,
    cursor: 'move',
  },
  // Controls
  controlsArea: {
    backgroundColor: 'rgba(0,0,0,0.85)',
    paddingTop: 8,
  },
  controlContent: {
    minHeight: 70,
    justifyContent: 'center',
  },
  tabBarScroll: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  // Toolbar — horizontal scroll, big 44pt hit target per item, 10/600
  // textTertiary label below each icon. Active item gets a subtle white
  // background pill + white label so it pops on a busy photo.
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: 6,
    paddingVertical: 10,
    paddingBottom: 22,
    gap: 2,
  },
  tabItem: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    minWidth: 64,
    height: 60,
    paddingTop: 6,
    paddingHorizontal: 6,
    borderRadius: 14,
  },
  tabItemActive: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  tabText: {
    color: '#888',
    fontSize: 10,
    fontWeight: '600',
    marginTop: 6,
    letterSpacing: 0.1,
  },
  tabTextActive: {
    color: '#fff',
    fontWeight: '700',
  },
  // Crop ratios — chips with optional sub-label (Quadrado/Stories/Post).
  // Stacked label/sub uses a tighter line-height so the chip height stays
  // close to single-line variants.
  cropTransformRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 14,
    paddingBottom: 10,
  },
  transformBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  transformBtnActive: {
    backgroundColor: 'rgba(124,58,237,0.4)',
  },
  ratioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 8,
  },
  ratioBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    minWidth: 64,
  },
  ratioBtnActive: {
    backgroundColor: BRAND,
    borderColor: BRAND,
  },
  ratioBtnText: {
    color: '#ccc',
    fontSize: 13,
    fontWeight: '600',
  },
  ratioBtnTextActive: {
    color: '#fff',
    fontWeight: '700',
  },
  ratioBtnSub: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 9,
    fontWeight: '500',
    marginTop: 1,
    letterSpacing: 0.2,
  },
  ratioBtnSubActive: {
    color: 'rgba(255,255,255,0.85)',
  },
  // Rotate
  rotateRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  rotateBtn: {
    alignItems: 'center',
    padding: 10,
    borderRadius: 12,
  },
  rotateBtnText: {
    color: '#ccc',
    fontSize: 11,
    marginTop: 4,
  },
  activeTool: {
    backgroundColor: 'rgba(124, 58, 237, 0.3)',
  },
  // Filters — filmstrip with 60×80 thumbnails. Active gets a 2px white
  // border per the design spec (vs the brand color we used to use). The
  // intensity slider sits above the strip and only renders when a
  // non-Original filter is selected.
  intensityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingBottom: 6,
    gap: 10,
  },
  intensityLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    minWidth: 28,
    textAlign: 'center',
  },
  intensitySliderContainer: {
    flex: 1,
    height: 28,
    justifyContent: 'center',
    position: 'relative',
  },
  intensityTrackBg: {
    position: 'absolute',
    left: 0, right: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    top: 12,
  },
  intensityTrackFill: {
    position: 'absolute',
    height: 4,
    borderRadius: 2,
    backgroundColor: BRAND,
    top: 12,
    left: 0,
  },
  intensityKnob: {
    position: 'absolute',
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: BRAND,
    marginLeft: -9,
    top: 5,
    borderWidth: 2,
    borderColor: '#fff',
    shadowColor: BRAND,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 4,
    elevation: 4,
    ...Platform.select({ web: { cursor: 'grab' }, default: {} }),
  },
  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingTop: 4,
    gap: 8,
  },
  filterItem: {
    alignItems: 'center',
    width: 64,
  },
  filterThumb: {
    width: 60,
    height: 80,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  filterThumbActive: {
    borderColor: '#fff',
  },
  filterThumbImg: {
    width: '100%',
    height: '100%',
  },
  filterThumbOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  filterLabel: {
    color: '#aaa',
    fontSize: 10,
    fontWeight: '600',
    marginTop: 5,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  filterLabelActive: {
    color: '#fff',
    fontWeight: '700',
  },
  // Adjust
  adjustPanel: {
    paddingHorizontal: 24,
    paddingVertical: 4,
  },
  adjustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  adjustLabel: {
    color: '#ccc',
    fontSize: 13,
    flex: 1,
  },
  adjustValue: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    width: 40,
    textAlign: 'right',
  },
  sliderContainer: {
    height: 30,
    justifyContent: 'center',
    position: 'relative',
  },
  sliderTrack: {
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  sliderFill: {
    position: 'absolute',
    height: '100%',
    backgroundColor: '#7C3AED',
    borderRadius: 2,
  },
  sliderKnob: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#fff',
    marginLeft: -10,
    top: 5,
    ...Platform.select({
      web: { cursor: 'grab' },
      default: {},
    }),
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 4,
  },
  sliderTapArea: {
    ...StyleSheet.absoluteFillObject,
    zIndex: -1,
  },
  // Text overlay panel
  textPanel: {
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  textInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  textInput: {
    flex: 1,
    color: '#fff',
    fontSize: 14,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  textAddBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#7C3AED',
    alignItems: 'center',
    justifyContent: 'center',
  },
  textAddBtnLabel: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 22,
  },
  colorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
    paddingHorizontal: 4,
  },
  colorSwatch: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  colorCustomBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
    borderStyle: 'dashed',
  },
  // Sticker pack pills + grid
  stickerPackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 8,
  },
  stickerPackPill: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  stickerPackPillActive: {
    backgroundColor: BRAND,
  },
  stickerPackLabel: {
    color: '#aaa',
    fontSize: 11,
    fontWeight: '600',
  },
  stickerPackLabelActive: {
    color: '#fff',
    fontWeight: '700',
  },
  stickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 6,
  },
  stickerBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Generic placeholder (draw / music / tag — features TODO)
  placeholderPanel: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    alignItems: 'center',
    gap: 4,
  },
  placeholderTitle: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  placeholderHint: {
    color: '#888',
    fontSize: 11,
    textAlign: 'center',
  },
  // Blur panel
  blurPanel: {
    paddingHorizontal: 16,
    paddingVertical: 4,
    alignItems: 'center',
    gap: 6,
  },
  blurAddBtn: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: '#7C3AED',
  },
  blurAddBtnLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  blurHint: {
    color: '#aaa',
    fontSize: 11,
    textAlign: 'center',
  },
});
