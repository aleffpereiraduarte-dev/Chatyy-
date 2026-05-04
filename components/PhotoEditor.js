import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Image,
  useWindowDimensions, Animated, PanResponder, Platform, ActivityIndicator,
  ScrollView,
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

const TABS = ['crop', 'rotate', 'filters', 'adjust'];

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

  // Refs for pan tracking
  const dragStartRef = useRef(null);
  const cropStartRef = useRef(null);

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
  }, []);

  // ── Save ──

  const handleSave = useCallback(async () => {
    if (!imageUri) return;
    setSaving(true);
    try {
      let ImageManipulator = null;
      try { ImageManipulator = require('expo-image-manipulator'); } catch {}

      if (!ImageManipulator?.manipulateAsync) {
        // On web without ImageManipulator, try canvas approach
        if (Platform.OS === 'web') {
          const result = await saveWithCanvas();
          if (result) { onSave?.(result); return; }
        }
        onSave?.(imageUri);
        return;
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
  }, [imageUri, rotation, flipH, flipV, cropRect, imageSize, selectedFilter, onSave]);

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

      return canvas.toDataURL('image/jpeg', 0.92);
    } catch (err) {
      console.warn('Canvas save error:', err);
      return null;
    }
  }, [imageUri, rotation, flipH, flipV, cropRect, brightness, selectedFilter]);

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
  };

  const tabLabels = {
    crop: t('photos.crop'),
    rotate: t('photos.rotate'),
    filters: t('photos.filters'),
    adjust: t('photos.adjust'),
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

          {/* Tab bar */}
          <View style={s.tabBar}>
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
          </View>
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
  tabBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 10,
    paddingBottom: 20,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
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
});
