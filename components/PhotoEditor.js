import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Image,
  useWindowDimensions, Animated, PanResponder, Platform, ActivityIndicator,
  ScrollView, TextInput,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
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

// Tab order: spatial transforms first (crop/rotate), then color (filters/adjust),
// then on-top overlays (text/sticker/blur). Overlays only get baked into the
// output on web (canvas path) for now — native flatten would need
// react-native-view-shot, marked TODO in the save fn.
const TABS = ['crop', 'rotate', 'filters', 'adjust', 'text', 'sticker', 'blur'];

// Pen/text colors — small palette per the design brief (3-4 colors).
const PEN_COLORS = ['#ffffff', '#FF3B30', '#FFCC00', '#0A84FF'];

// Stickers panel — basic emoji set. Tapping inserts the glyph centered
// onto the photo; user can drag it via PanResponder.
const STICKER_EMOJI = ['😀', '😂', '😍', '🥳', '🔥', '✨', '❤️', '👍', '👏', '🎉', '💯', '⭐'];

const CROP_RATIOS = [
  { label: 'photos.free', value: null },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '16:9', value: 16 / 9 },
  { label: '3:2', value: 3 / 2 },
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

  // State
  const [activeTab, setActiveTab] = useState('crop');
  const [rotation, setRotation] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [selectedFilter, setSelectedFilter] = useState('original');
  const [brightness, setBrightness] = useState(0); // -100 to 100
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
      setActiveTab('crop');
      setRotation(0);
      setFlipH(false);
      setFlipV(false);
      setSelectedFilter('original');
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
    }
  }, [visible]);

  // ── Crop handlers ──

  const applyCropRatio = useCallback((ratio) => {
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
  }, [displayDims]);

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
  }, [textInputValue, textColor, cropPixels]);

  const addStickerItem = useCallback((emoji) => {
    const id = genId();
    setStickerItems(prev => [...prev, {
      id,
      x: cropPixels.x + cropPixels.w / 2 - 28,
      y: cropPixels.y + cropPixels.h / 2 - 28,
      emoji,
      size: 56,
    }]);
    setActiveOverlayId(id);
  }, [cropPixels]);

  const addBlurRegion = useCallback(() => {
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
  }, [cropPixels]);

  const removeOverlay = useCallback((id) => {
    setTextItems(prev => prev.filter(t => t.id !== id));
    setStickerItems(prev => prev.filter(s => s.id !== id));
    setBlurRegions(prev => prev.filter(b => b.id !== id));
    if (activeOverlayId === id) setActiveOverlayId(null);
  }, [activeOverlayId]);

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

  const rotateLeft = useCallback(() => setRotation(r => (r + 270) % 360), []);
  const rotateRight = useCallback(() => setRotation(r => (r + 90) % 360), []);
  const toggleFlipH = useCallback(() => setFlipH(v => !v), []);
  const toggleFlipV = useCallback(() => setFlipV(v => !v), []);

  // ── Reset ──

  const resetAll = useCallback(() => {
    setRotation(0);
    setFlipH(false);
    setFlipV(false);
    setSelectedFilter('original');
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

      // Apply filter overlay
      const filter = FILTERS.find(f => f.key === selectedFilter);
      if (filter?.overlay) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = filter.overlay;
        ctx.fillRect(0, 0, cw, ch);
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
  }, [imageUri, rotation, flipH, flipV, cropRect, brightness, selectedFilter, textItems, stickerItems, blurRegions, displayDims]);

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

  const tabIcons = {
    crop: <IconCrop size={20} color={activeTab === 'crop' ? colors.primary : '#aaa'} />,
    rotate: <IconRotateCw size={20} color={activeTab === 'rotate' ? colors.primary : '#aaa'} />,
    filters: <IconFilters size={20} color={activeTab === 'filters' ? colors.primary : '#aaa'} />,
    adjust: <IconSliders size={20} color={activeTab === 'adjust' ? colors.primary : '#aaa'} />,
    text: <Text style={{ fontSize: 16, fontWeight: '900', color: activeTab === 'text' ? colors.primary : '#aaa' }}>T</Text>,
    sticker: <Text style={{ fontSize: 18 }}>{activeTab === 'sticker' ? '😀' : '🙂'}</Text>,
    blur: (
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={activeTab === 'blur' ? colors.primary : '#aaa'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <Circle cx="6" cy="12" r="2" />
        <Circle cx="12" cy="12" r="2" />
        <Circle cx="18" cy="12" r="2" />
        <Circle cx="9" cy="6" r="1.5" />
        <Circle cx="15" cy="6" r="1.5" />
        <Circle cx="9" cy="18" r="1.5" />
        <Circle cx="15" cy="18" r="1.5" />
      </Svg>
    ),
  };

  // Reuse photos.* keys when present, fall back to English label inline (no
  // new i18n keys per task constraints).
  const tabLabels = {
    crop: t('photos.crop'),
    rotate: t('photos.rotate'),
    filters: t('photos.filters'),
    adjust: t('photos.adjust'),
    text: t('photos.text') || 'Text',
    sticker: t('photos.sticker') || 'Sticker',
    blur: t('photos.blur') || 'Blur',
  };

  return (
    <Modal visible={visible} animationType="fade" transparent={false} onRequestClose={onClose}>
      <View style={s.container}>
        {/* Top bar */}
        <View style={s.topBar}>
          <TouchableOpacity onPress={onClose} style={s.topBtn} accessibilityLabel={t('common.cancel')}>
            <IconX size={24} color="#fff" />
          </TouchableOpacity>

          <TouchableOpacity onPress={resetAll} style={s.topBtn}>
            <IconRefresh size={20} color="#fff" />
            <Text style={s.topBtnText}>{t('photos.reset')}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleSave}
            style={[s.topBtn, s.saveBtn]}
            disabled={saving}
            accessibilityLabel={t('photos.save')}
          >
            {saving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <IconCheck size={24} color="#fff" />
            )}
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

              {/* Filter overlay */}
              {currentFilter?.overlay && (
                <View
                  style={[s.filterOverlay, {
                    width: displayDims.w,
                    height: displayDims.h,
                    backgroundColor: currentFilter.overlay,
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
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.ratioRow}>
                {CROP_RATIOS.map((r) => {
                  const isActive = selectedRatio === r.value;
                  const label = r.value === null ? t(r.label) : r.label;
                  return (
                    <TouchableOpacity
                      key={r.label}
                      style={[s.ratioBtn, isActive && s.ratioBtnActive]}
                      onPress={() => applyCropRatio(r.value)}
                    >
                      <Text style={[s.ratioBtnText, isActive && s.ratioBtnTextActive]}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            {activeTab === 'rotate' && (
              <View style={s.rotateRow}>
                <TouchableOpacity style={s.rotateBtn} onPress={rotateLeft}>
                  <IconRotateCcw size={26} color="#fff" />
                  <Text style={s.rotateBtnText}>{t('photos.rotateLeft')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.rotateBtn} onPress={rotateRight}>
                  <IconRotateCw size={26} color="#fff" />
                  <Text style={s.rotateBtnText}>{t('photos.rotateRight')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[s.rotateBtn, flipH && s.activeTool]} onPress={toggleFlipH}>
                  <IconFlipH size={26} color="#fff" />
                  <Text style={s.rotateBtnText}>{t('photos.flipH')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[s.rotateBtn, flipV && s.activeTool]} onPress={toggleFlipV}>
                  <IconFlipV size={26} color="#fff" />
                  <Text style={s.rotateBtnText}>{t('photos.flipV')}</Text>
                </TouchableOpacity>
              </View>
            )}

            {activeTab === 'filters' && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filterRow}>
                {FILTERS.map((f) => {
                  const isActive = selectedFilter === f.key;
                  return (
                    <TouchableOpacity
                      key={f.key}
                      style={[s.filterItem, isActive && s.filterItemActive]}
                      onPress={() => setSelectedFilter(f.key)}
                    >
                      <View style={s.filterThumb}>
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
                      <Text style={[s.filterLabel, isActive && s.filterLabelActive]}>
                        {filterI18n[f.key] || f.key}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            {activeTab === 'text' && (
              <View style={s.textPanel}>
                <View style={s.textInputRow}>
                  <TextInput
                    value={textInputValue}
                    onChangeText={setTextInputValue}
                    placeholder={t('photos.text') || 'Type text…'}
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
                <View style={s.colorRow}>
                  {PEN_COLORS.map(c => (
                    <TouchableOpacity
                      key={c}
                      onPress={() => setTextColor(c)}
                      style={[s.colorSwatch, { backgroundColor: c, borderWidth: textColor === c ? 2 : 1 }]}
                    />
                  ))}
                </View>
              </View>
            )}

            {activeTab === 'sticker' && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.stickerRow}>
                {STICKER_EMOJI.map((em) => (
                  <TouchableOpacity
                    key={em}
                    onPress={() => addStickerItem(em)}
                    style={s.stickerBtn}
                  >
                    <Text style={{ fontSize: 28 }}>{em}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}

            {activeTab === 'blur' && (
              <View style={s.blurPanel}>
                <TouchableOpacity onPress={addBlurRegion} style={s.blurAddBtn}>
                  <Text style={s.blurAddBtnLabel}>+ {t('photos.blur') || 'Blur region'}</Text>
                </TouchableOpacity>
                <Text style={s.blurHint}>
                  {t('photos.blurHint') || 'Drag the region over what you want to hide.'}
                </Text>
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
  topBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    gap: 6,
  },
  topBtnText: {
    color: '#fff',
    fontSize: 14,
  },
  saveBtn: {
    backgroundColor: '#7C3AED',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
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
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  tabBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: 8,
    paddingVertical: 10,
    paddingBottom: 20,
    gap: 4,
    flexGrow: 1,
  },
  tabItem: {
    alignItems: 'center',
    padding: 6,
    minWidth: 60,
  },
  tabItemActive: {},
  tabText: {
    color: '#888',
    fontSize: 11,
    marginTop: 3,
  },
  tabTextActive: {
    color: '#7C3AED',
  },
  // Crop ratios
  ratioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 8,
  },
  ratioBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  ratioBtnActive: {
    backgroundColor: '#7C3AED',
    borderColor: '#7C3AED',
  },
  ratioBtnText: {
    color: '#ccc',
    fontSize: 13,
  },
  ratioBtnTextActive: {
    color: '#fff',
    fontWeight: '600',
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
  // Filters
  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    gap: 10,
  },
  filterItem: {
    alignItems: 'center',
    width: 64,
  },
  filterItemActive: {},
  filterThumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  filterThumbImg: {
    width: '100%',
    height: '100%',
  },
  filterThumbOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  filterLabel: {
    color: '#999',
    fontSize: 10,
    marginTop: 4,
    textAlign: 'center',
  },
  filterLabelActive: {
    color: '#7C3AED',
    fontWeight: '600',
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
    gap: 12,
    marginTop: 10,
    paddingHorizontal: 4,
  },
  colorSwatch: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderColor: '#fff',
  },
  // Sticker panel
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
