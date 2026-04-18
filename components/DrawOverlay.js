// DrawOverlay — minimal pen-drawing layer on top of a photo before sending.
// Opens from MediaPreview's "✏️ Desenhar" button. Capture via
// react-native-view-shot (native) or canvas (web) and returns a new URI.
//
// Keep it small and focused: pen with 7 colors × 3 widths, undo, and done.
import React, { useRef, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, Image, StyleSheet, Platform, Dimensions,
  PanResponder, ActivityIndicator,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
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

  // Web uses pointer events for accurate coords; PanResponder's locationX on
  // react-native-web can be 0/undefined in many browsers (especially Safari),
  // which is why strokes weren't drawing on top of the photo.
  const webDrawingRef = useRef(false);
  const webOnDown = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left).toFixed(1);
    const y = (e.clientY - rect.top).toFixed(1);
    webDrawingRef.current = true;
    setCurrent(`M${x},${y}`);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault?.();
  };
  const webOnMove = (e) => {
    if (!webDrawingRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left).toFixed(1);
    const y = (e.clientY - rect.top).toFixed(1);
    setCurrent(p => p ? `${p} L${x},${y}` : `M${x},${y}`);
    e.preventDefault?.();
  };
  const webOnUp = (e) => {
    if (!webDrawingRef.current) return;
    webDrawingRef.current = false;
    setCurrent(p => {
      if (p) setPaths(prev => [...prev, { d: p, color: colorRef.current, width: strokeRef.current }]);
      return '';
    });
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
  };

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
    if (current) { setCurrent(''); return; }
    setPaths(prev => prev.slice(0, -1));
  }, [current]);

  const clear = useCallback(() => { setPaths([]); setCurrent(''); }, []);

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    let outUri = imageUri;
    try {
      if (paths.length === 0) {
        // Nothing drawn — return original without paying capture cost
        onDone?.(imageUri);
        return;
      }
      if (Platform.OS === 'web') {
        // Capture via canvas — load image at native size, then stroke scaled
        const img = new window.Image();
        img.crossOrigin = 'anonymous';
        img.src = imageUri;
        await new Promise((r, j) => { img.onload = r; img.onerror = j; });
        const cnv = document.createElement('canvas');
        cnv.width = img.width; cnv.height = img.height;
        const ctx = cnv.getContext('2d');
        ctx.drawImage(img, 0, 0);
        // Scale strokes from the ACTUAL canvas viewport (measured at layout time)
        // instead of approximating from window size — the previous approx made
        // strokes land in the wrong spot on browser zoom / window-resize.
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
        for (const p of paths) {
          ctx.strokeStyle = p.color;
          ctx.lineWidth = p.width * Math.min(sx, sy);
          const pts = p.d.match(/[ML](-?[\d.]+),(-?[\d.]+)/g) || [];
          ctx.beginPath();
          for (let i = 0; i < pts.length; i++) {
            const m = pts[i].match(/^([ML])(-?[\d.]+),(-?[\d.]+)$/);
            if (!m) continue;
            const x = (parseFloat(m[2]) - offX) * sx;
            const y = (parseFloat(m[3]) - offY) * sy;
            if (m[1] === 'M') ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        outUri = await new Promise(r => cnv.toBlob(b => r(URL.createObjectURL(b)), 'image/jpeg', 0.92));
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
          ref={shotRef}
          style={{ flex: 1, marginTop: 90, marginBottom: 90, position: 'relative', touchAction: 'none' }}
          onPointerDown={webOnDown}
          onPointerMove={webOnMove}
          onPointerUp={webOnUp}
          onPointerCancel={webOnUp}
          onLayout={(e) => { canvasSizeRef.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height }; }}
        >
          <img
            src={imageUri}
            alt=""
            draggable={false}
            style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none', userSelect: 'none' }}
          />
          <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
            {paths.map((p, i) => (
              <Path key={i} d={p.d} stroke={p.color} strokeWidth={p.width} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            ))}
            {current ? <Path d={current} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeLinejoin="round" /> : null}
          </Svg>
        </div>
      ) : (
        <View ref={shotRef} collapsable={false} style={styles.canvas} {...responder.panHandlers}>
          <Image source={{ uri: imageUri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
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
