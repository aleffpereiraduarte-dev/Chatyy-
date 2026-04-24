// DrawOverlay — minimal pen-drawing layer on top of a photo before sending.
// Opens from MediaPreview's "✏️ Desenhar" button. Capture via
// react-native-view-shot (native) or canvas (web) and returns a new URI.
//
// Keep it small and focused: pen with 7 colors × 3 widths, undo, and done.
import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, Image, StyleSheet, Platform, Dimensions,
  PanResponder, ActivityIndicator,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import CachedImage from './CachedImage';
import { IconX, IconCheck, IconTrash } from './Icons';

const { width: SW, height: SH } = Dimensions.get('window');
const COLORS = ['#ffffff', '#000000', '#FF3B30', '#FF9500', '#FFCC00', '#30D158', '#0A84FF', '#BF5AF2'];
const WIDTHS = [3, 6, 10];

export default function DrawOverlay({ visible, imageUri, onCancel, onDone }) {
  const [color, setColor] = useState('#FF3B30');
  const [stroke, setStroke] = useState(6);
  const [paths, setPaths] = useState([]);
  const [current, setCurrent] = useState('');
  const [saving, setSaving] = useState(false);
  const shotRef = useRef(null);
  const canvasSizeRef = useRef({ w: 0, h: 0 });

  // Keep latest style in refs so PanResponder (created once) uses fresh values
  const colorRef = useRef(color); colorRef.current = color;
  const strokeRef = useRef(stroke); strokeRef.current = stroke;

  // ── Web drawing path (canvas-native, no SVG) ──
  // Direct 2D canvas is far more reliable than the react-native-svg overlay:
  // strokes land exactly where the pointer is, no sub-pixel drift on retina,
  // no "not drawing" bugs when react-native-web intercepts onLayout. The
  // canvas is sized to match its DOM rect with devicePixelRatio scaling for
  // crisp lines; a ResizeObserver keeps it in sync on window/zoom changes.
  const webDrawingRef = useRef(false);
  const webCanvasRef = useRef(null);
  const webContainerRef = useRef(null);
  const webImgRef = useRef(null);
  const webLastPtRef = useRef(null);
  // History of stroke points (viewport coords) so we can redraw on resize
  // and re-render on undo/clear without losing any brush work.
  const webStrokesRef = useRef([]);
  const webCurrentStrokeRef = useRef(null);

  const webRedrawAll = useCallback(() => {
    const cnv = webCanvasRef.current;
    if (!cnv) return;
    const ctx = cnv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cnv.width, cnv.height);
    const dpr = window.devicePixelRatio || 1;
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const drawStroke = (s) => {
      if (!s || !s.pts || s.pts.length < 1) return;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.moveTo(s.pts[0].x, s.pts[0].y);
      for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i].x, s.pts[i].y);
      ctx.stroke();
    };
    for (const s of webStrokesRef.current) drawStroke(s);
    if (webCurrentStrokeRef.current) drawStroke(webCurrentStrokeRef.current);
  }, []);

  const webSyncCanvasSize = useCallback(() => {
    const cnv = webCanvasRef.current;
    const ctn = webContainerRef.current;
    if (!cnv || !ctn) return;
    const rect = ctn.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    canvasSizeRef.current = { w: rect.width, h: rect.height };
    const dpr = window.devicePixelRatio || 1;
    cnv.width = Math.round(rect.width * dpr);
    cnv.height = Math.round(rect.height * dpr);
    cnv.style.width = rect.width + 'px';
    cnv.style.height = rect.height + 'px';
    webRedrawAll();
  }, [webRedrawAll]);

  const webOnDown = (e) => {
    const cnv = webCanvasRef.current;
    if (!cnv) return;
    const rect = cnv.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    webDrawingRef.current = true;
    webLastPtRef.current = { x, y };
    webCurrentStrokeRef.current = {
      color: colorRef.current, width: strokeRef.current,
      pts: [{ x, y }],
    };
    // Tap-to-dot: draw a single dot so a quick tap still leaves a mark.
    webRedrawAll();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault?.();
  };
  const webOnMove = (e) => {
    if (!webDrawingRef.current) return;
    const cnv = webCanvasRef.current;
    if (!cnv) return;
    const rect = cnv.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const last = webLastPtRef.current;
    // Skip sub-pixel moves (keeps the stroke array small on fast moves)
    if (last && Math.abs(x - last.x) < 0.5 && Math.abs(y - last.y) < 0.5) return;
    webLastPtRef.current = { x, y };
    const s = webCurrentStrokeRef.current;
    if (!s) return;
    s.pts.push({ x, y });
    // Incremental draw: only the latest segment, no full redraw (smoother)
    const ctx = cnv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const p = s.pts;
    ctx.moveTo(p[p.length - 2].x, p[p.length - 2].y);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();
    e.preventDefault?.();
  };
  const webOnUp = (e) => {
    if (!webDrawingRef.current) return;
    webDrawingRef.current = false;
    const s = webCurrentStrokeRef.current;
    if (s && s.pts.length > 0) {
      webStrokesRef.current.push(s);
      setPaths(prev => [...prev, {}]); // just to trigger re-render for undo/save
    }
    webCurrentStrokeRef.current = null;
    webLastPtRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
  };

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (!visible) return;
    const handler = () => webSyncCanvasSize();
    handler();
    let ro = null;
    if (typeof window !== 'undefined' && 'ResizeObserver' in window && webContainerRef.current) {
      try { ro = new ResizeObserver(handler); ro.observe(webContainerRef.current); } catch {}
    }
    window.addEventListener('resize', handler);
    return () => {
      window.removeEventListener('resize', handler);
      try { ro?.disconnect(); } catch {}
    };
  }, [visible, webSyncCanvasSize]);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => Platform.OS !== 'web',
      onMoveShouldSetPanResponder: () => Platform.OS !== 'web',
      onPanResponderGrant: (e) => {
        const { locationX, locationY } = e.nativeEvent;
        setCurrent(`M${locationX.toFixed(1)},${locationY.toFixed(1)}`);
      },
      onPanResponderMove: (e) => {
        const { locationX, locationY } = e.nativeEvent;
        setCurrent(p => p ? `${p} L${locationX.toFixed(1)},${locationY.toFixed(1)}` : '');
      },
      onPanResponderRelease: () => {
        setCurrent(p => {
          if (p) setPaths(prev => [...prev, { d: p, color: colorRef.current, width: strokeRef.current }]);
          return '';
        });
      },
    })
  ).current;

  const undo = useCallback(() => {
    if (Platform.OS === 'web') {
      if (webCurrentStrokeRef.current) { webCurrentStrokeRef.current = null; webRedrawAll(); return; }
      webStrokesRef.current.pop();
      webRedrawAll();
      setPaths(prev => prev.slice(0, -1));
      return;
    }
    if (current) { setCurrent(''); return; }
    setPaths(prev => prev.slice(0, -1));
  }, [current, webRedrawAll]);

  const clear = useCallback(() => {
    if (Platform.OS === 'web') {
      webStrokesRef.current = [];
      webCurrentStrokeRef.current = null;
      webRedrawAll();
      setPaths([]);
      setCurrent('');
      return;
    }
    setPaths([]);
    setCurrent('');
  }, [webRedrawAll]);

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    let outUri = imageUri;
    try {
      if (Platform.OS === 'web') {
        const hasStrokes = webStrokesRef.current.length > 0;
        if (!hasStrokes) { onDone?.(imageUri); return; }
        // Compose: redraw strokes on top of the full-resolution source image
        // (not the downscaled viewport), using the viewport→image scale factor
        // measured at layout time. No trig/padding guesswork.
        const img = new window.Image();
        img.crossOrigin = 'anonymous';
        img.src = imageUri;
        await new Promise((r, j) => { img.onload = r; img.onerror = j; });
        const cnv = document.createElement('canvas');
        cnv.width = img.width; cnv.height = img.height;
        const ctx = cnv.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const vw = canvasSizeRef.current.w || SW;
        const vh = canvasSizeRef.current.h || (SH - 180);
        const imgR = img.width / img.height;
        const vR = vw / vh;
        let dispW, dispH, offX = 0, offY = 0;
        if (imgR > vR) { dispW = vw; dispH = vw / imgR; offY = (vh - dispH) / 2; }
        else { dispH = vh; dispW = vh * imgR; offX = (vw - dispW) / 2; }
        const sx = img.width / dispW;
        const sy = img.height / dispH;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (const s of webStrokesRef.current) {
          if (!s.pts?.length) continue;
          ctx.strokeStyle = s.color;
          ctx.lineWidth = s.width * Math.min(sx, sy);
          ctx.beginPath();
          const p0 = s.pts[0];
          ctx.moveTo((p0.x - offX) * sx, (p0.y - offY) * sy);
          for (let i = 1; i < s.pts.length; i++) {
            ctx.lineTo((s.pts[i].x - offX) * sx, (s.pts[i].y - offY) * sy);
          }
          // Single-point tap: draw a filled dot so quick taps leave a mark
          if (s.pts.length === 1) {
            ctx.fillStyle = s.color;
            ctx.beginPath();
            ctx.arc((p0.x - offX) * sx, (p0.y - offY) * sy, s.width * Math.min(sx, sy) / 2, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.stroke();
          }
        }
        outUri = await new Promise(r => cnv.toBlob(b => r(URL.createObjectURL(b)), 'image/jpeg', 0.92));
      } else if (paths.length === 0) {
        // Native: no paths means nothing drawn; skip capture cost.
        onDone?.(imageUri);
        return;
      } else {
        const mod = require('react-native-view-shot');
        const captureRef = mod.captureRef || (typeof mod.default === 'function' ? mod.default : null);
        if (captureRef && shotRef.current) {
          outUri = await captureRef(shotRef.current, { format: 'jpg', quality: 0.92, result: 'tmpfile' });
        }
      }
    } catch (e) {
      console.warn('[DrawOverlay] save error:', e?.message);
    } finally {
      setSaving(false);
    }
    onDone?.(outUri);
  }, [saving, imageUri, paths, onDone]);

  if (!visible) return null;

  return (
    <View style={styles.wrap}>
      {/* Top bar */}
      <View style={[styles.top, { top: Platform.OS === 'ios' ? 48 : 18 }]}>
        <TouchableOpacity onPress={onCancel} style={styles.topBtn}>
          <IconX size={20} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={undo} disabled={paths.length === 0 && !current}
          style={[styles.topBtn, (paths.length === 0 && !current) && { opacity: 0.3 }]}>
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>↶</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={clear} disabled={paths.length === 0}
          style={[styles.topBtn, paths.length === 0 && { opacity: 0.3 }]}>
          <IconTrash size={17} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Image canvas */}
      {Platform.OS === 'web' ? (
        <div
          ref={webContainerRef}
          style={{
            position: 'absolute', top: 90, bottom: 90, left: 0, right: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            touchAction: 'none', userSelect: 'none',
          }}
        >
          <img
            ref={webImgRef}
            src={imageUri}
            alt=""
            draggable={false}
            onLoad={webSyncCanvasSize}
            style={{
              position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
              objectFit: 'contain', pointerEvents: 'none', userSelect: 'none',
            }}
          />
          <canvas
            ref={webCanvasRef}
            onPointerDown={webOnDown}
            onPointerMove={webOnMove}
            onPointerUp={webOnUp}
            onPointerCancel={webOnUp}
            onPointerLeave={webOnUp}
            style={{
              position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
              touchAction: 'none', cursor: 'crosshair',
            }}
          />
        </div>
      ) : (
        <View ref={shotRef} collapsable={false} style={styles.canvas} {...responder.panHandlers}>
          <CachedImage source={{ uri: imageUri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
          <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
            {paths.map((p, i) => (
              <Path key={i} d={p.d} stroke={p.color} strokeWidth={p.width} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            ))}
            {current ? <Path d={current} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeLinejoin="round" /> : null}
          </Svg>
        </View>
      )}

      {/* Color palette (right vertical) */}
      <View style={styles.colorStack}>
        {COLORS.map(c => (
          <TouchableOpacity key={c} onPress={() => setColor(c)}
            style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c, borderWidth: c === color ? 3 : 1, borderColor: c === color ? '#fff' : 'rgba(255,255,255,0.35)' }} />
        ))}
      </View>

      {/* Width picker (left vertical) */}
      <View style={styles.widthStack}>
        {WIDTHS.map(w => (
          <TouchableOpacity key={w} onPress={() => setStroke(w)}
            style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center', borderWidth: w === stroke ? 2 : 0, borderColor: '#fff' }}>
            <View style={{ width: w + 2, height: w + 2, borderRadius: (w + 2) / 2, backgroundColor: color }} />
          </TouchableOpacity>
        ))}
      </View>

      {/* Done */}
      <View style={[styles.bottom, { bottom: Platform.OS === 'ios' ? 34 : 18 }]}>
        <TouchableOpacity onPress={save} disabled={saving}
          style={{ paddingHorizontal: 22, height: 50, borderRadius: 25, backgroundColor: '#0A84FF', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }}>
          {saving ? <ActivityIndicator color="#fff" /> : (<>
            <IconCheck size={18} color="#fff" />
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>Concluir</Text>
          </>)}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000', zIndex: 9999 },
  top: { position: 'absolute', left: 0, right: 0, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', zIndex: 10 },
  topBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', marginHorizontal: 4 },
  canvas: { flex: 1, marginTop: 90, marginBottom: 90 },
  colorStack: { position: 'absolute', right: 14, top: SH * 0.22, gap: 8, zIndex: 5 },
  widthStack: { position: 'absolute', left: 14, top: SH * 0.22, gap: 8, zIndex: 5 },
  bottom: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 10 },
});
