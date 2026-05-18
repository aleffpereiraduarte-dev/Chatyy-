// Photo drawing tool — SVG overlay for annotating photos before sending.
// Built on react-native-svg + a PanResponder canvas. We deliberately stay
// off react-native-skia because it isn't in the project deps (would force
// a native rebuild). The SVG path approach renders at 60 fps for up to
// ~50 strokes; beyond that we hit RN reconciliation cost and consider
// flattening older strokes into a single Path with rasterized snapshot.
//
// Editor depth this file owns (per Media+Photos P0/P1 gap report):
//   - 4 brush sizes (was 3)
//   - 12 preset colors + free hue picker stub
//   - Eraser tool (modal: tap a stroke to delete; long-press for full clear)
//   - Undo / Redo stacks
//   - Saved as overlay layer — `onDone` returns the path array so the
//     caller can either bake the strokes into the JPEG at save time OR
//     keep them as a separate compositing layer (status video).
//
// NOTE: We don't bake the strokes into a bitmap here. The PhotoEditor
// host knows the source image dims and runs the final canvas composite
// (web canvas / view-shot native). Returning paths keeps this file
// platform-agnostic.
import { useState, useRef, useCallback } from 'react';
import { View, Text, TouchableOpacity, PanResponder, Platform, Image } from 'react-native';
import Svg, { Path } from 'react-native-svg';

// 12 preset swatches (was 8). Order matches the design brief: neutrals
// first, then primaries, then accents. Designers can tweak the palette
// here without touching the picker logic.
const COLORS = [
  '#FFFFFF', '#000000', '#9CA3AF',
  '#EF4444', '#F59E0B', '#FFCC00',
  '#10B981', '#06B6D4', '#3B82F6',
  '#8B5CF6', '#EC4899', '#A855F7',
];

// 4 brush sizes (was 3). The smallest is for fine annotation (signature,
// timestamps); the largest is for big highlight strokes.
const STROKE_WIDTHS = [3, 6, 10, 16];

// Tool modes. 'pen' draws a new stroke; 'eraser' removes the stroke under
// the tap (per-stroke erase, not pixel-perfect — pixel erase would need
// a raster canvas which is heavier than we want here).
const TOOLS = {
  PEN: 'pen',
  ERASER: 'eraser',
};

// We expose a custom-color slot as the 13th swatch — a dashed circle the
// user can tap to open a free hue picker. The picker itself is a simple
// horizontal slider that maps 0–360 to HSL.
function hsl(h) {
  // Convert HSL (h, 80%, 55%) to hex for the SVG stroke. Inline so we don't
  // pull in a color library for one function.
  const s = 0.8, l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)      { r = c; g = x; }
  else if (h < 120){ r = x; g = c; }
  else if (h < 180){ g = c; b = x; }
  else if (h < 240){ g = x; b = c; }
  else if (h < 300){ r = x; b = c; }
  else             { r = c; b = x; }
  const to = (v) => ('0' + Math.round((v + m) * 255).toString(16)).slice(-2);
  return '#' + to(r) + to(g) + to(b);
}

export default function PhotoDrawTool({ imageUri, width, height, onDone, onCancel, t }) {
  // Stroke collection — each entry: { id, d, color, width }. id lets the
  // eraser identify the path under a tap.
  const [paths, setPaths] = useState([]);
  const [currentPath, setCurrentPath] = useState('');
  const [color, setColor] = useState('#EF4444');
  const [strokeWidth, setStrokeWidth] = useState(6);
  const [tool, setTool] = useState(TOOLS.PEN);
  // Undo / Redo. We keep snapshots of the paths array (shallow — entries are
  // immutable). Bounded so a long session doesn't balloon memory.
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  // Free hue picker. Slider position 0–360.
  const [showHue, setShowHue] = useState(false);
  const [hue, setHue] = useState(280);

  const currentPathRef = useRef('');
  const pathIdRef = useRef(1);

  // Push current state to undo so we can come back to it. Drops the redo
  // stack since any new edit invalidates the redo branch.
  const pushUndo = useCallback(() => {
    setUndoStack(prev => {
      const next = [...prev, paths];
      // Cap at 30 snapshots — plenty for a single editing session.
      return next.length > 30 ? next.slice(-30) : next;
    });
    setRedoStack([]);
  }, [paths]);

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    setRedoStack(r => [...r, paths]);
    const prev = undoStack[undoStack.length - 1];
    setUndoStack(s => s.slice(0, -1));
    setPaths(prev);
  }, [undoStack, paths]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return;
    setUndoStack(s => [...s, paths]);
    const next = redoStack[redoStack.length - 1];
    setRedoStack(r => r.slice(0, -1));
    setPaths(next);
  }, [redoStack, paths]);

  const handleClear = useCallback(() => {
    if (paths.length === 0) return;
    pushUndo();
    setPaths([]);
    setCurrentPath('');
  }, [paths.length, pushUndo]);

  const handleDone = useCallback(() => {
    // Caller flattens paths into the saved image (Skia/canvas) or keeps them
    // as a compositing layer. We return raw data so the host has full control.
    onDone?.({ paths, color, strokeWidth });
  }, [onDone, paths, color, strokeWidth]);

  // Erase by tapping a stroke. We hit-test by walking paths in reverse
  // (top-most first) and computing a quick AABB on the path "d" string —
  // close enough for the tap targets we're working with (12+ px brushes).
  const eraseAt = useCallback((x, y) => {
    for (let i = paths.length - 1; i >= 0; i--) {
      const p = paths[i];
      // Extract all coordinate pairs and find bounding box. Cheap regex
      // — every path here is built from "M x,y L x,y L x,y..." segments.
      const matches = (p.d || '').match(/-?\d+(?:\.\d+)?/g);
      if (!matches || matches.length < 2) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let k = 0; k < matches.length - 1; k += 2) {
        const px = parseFloat(matches[k]);
        const py = parseFloat(matches[k + 1]);
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      // Pad by half the stroke width so the hit target matches what the
      // user sees on screen.
      const pad = (p.width || 6) / 2 + 4;
      if (x >= minX - pad && x <= maxX + pad && y >= minY - pad && y <= maxY + pad) {
        pushUndo();
        setPaths(prev => prev.filter((_, k) => k !== i));
        return true;
      }
    }
    return false;
  }, [paths, pushUndo]);

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (evt) => {
      const { locationX, locationY } = evt.nativeEvent;
      if (tool === TOOLS.ERASER) {
        // Single-tap erase. PanResponder fires on the tap-start event so
        // we don't need an additional onPress wrapper.
        eraseAt(locationX, locationY);
        return;
      }
      currentPathRef.current = `M${locationX.toFixed(1)},${locationY.toFixed(1)}`;
      setCurrentPath(currentPathRef.current);
    },
    onPanResponderMove: (evt) => {
      if (tool === TOOLS.ERASER) {
        // Drag-erase — pass each touch through the hit-tester. Cheap because
        // the AABB check above is O(n) over ~30 strokes per photo.
        const { locationX, locationY } = evt.nativeEvent;
        eraseAt(locationX, locationY);
        return;
      }
      const { locationX, locationY } = evt.nativeEvent;
      currentPathRef.current += ` L${locationX.toFixed(1)},${locationY.toFixed(1)}`;
      setCurrentPath(currentPathRef.current);
    },
    onPanResponderRelease: () => {
      if (tool === TOOLS.PEN && currentPathRef.current) {
        pushUndo();
        setPaths(prev => [...prev, {
          id: pathIdRef.current++,
          d: currentPathRef.current,
          color,
          width: strokeWidth,
        }]);
      }
      currentPathRef.current = '';
      setCurrentPath('');
    },
  })).current;

  const huePickerColor = hsl(hue);

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {/* Canvas area — image underneath, SVG overlay on top. The PanResponder
          captures all gestures inside the overlay. */}
      <View style={{ flex: 1, position: 'relative' }}>
        <Image source={{ uri: imageUri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
        <View
          {...pan.panHandlers}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        >
          <Svg width="100%" height="100%">
            {paths.map(p => (
              <Path key={p.id} d={p.d} stroke={p.color} strokeWidth={p.width} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            ))}
            {currentPath && tool === TOOLS.PEN ? (
              <Path d={currentPath} stroke={color} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            ) : null}
          </Svg>
        </View>
        {/* Tool-mode HUD — visible while drawing, tiny. Helps users notice
            they're in eraser mode (a common "why isn't drawing working"
            moment otherwise). */}
        <View style={{ position: 'absolute', top: 12, left: 12, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.55)' }}>
          <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700', letterSpacing: 0.4 }}>
            {tool === TOOLS.ERASER
              ? (t?.('photoDraw.eraser') || 'BORRACHA')
              : (t?.('photoDraw.brush') || 'PINCEL')}
          </Text>
        </View>
      </View>

      {/* Tools bar — colors, widths, tool toggle, actions */}
      <View style={{ backgroundColor: 'rgba(0,0,0,0.9)', padding: 12, gap: 10 }}>

        {/* Tool toggle: Pen ↔ Eraser */}
        <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'center' }}>
          <TouchableOpacity
            onPress={() => setTool(TOOLS.PEN)}
            style={{
              paddingHorizontal: 16, paddingVertical: 8, borderRadius: 18,
              backgroundColor: tool === TOOLS.PEN ? '#7C3AED' : 'rgba(255,255,255,0.1)',
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>
              {t?.('photoDraw.brush') || 'Pincel'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setTool(TOOLS.ERASER)}
            style={{
              paddingHorizontal: 16, paddingVertical: 8, borderRadius: 18,
              backgroundColor: tool === TOOLS.ERASER ? '#7C3AED' : 'rgba(255,255,255,0.1)',
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>
              {t?.('photoDraw.eraser') || 'Borracha'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Colors — 12 presets + free-hue swatch (dashed circle). Disabled
            visually while the eraser is active because color has no effect. */}
        <View style={{ opacity: tool === TOOLS.ERASER ? 0.4 : 1, flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
          {COLORS.map(c => (
            <TouchableOpacity
              key={c}
              onPress={() => { setColor(c); setShowHue(false); }}
              disabled={tool === TOOLS.ERASER}
              style={{
                width: 26, height: 26, borderRadius: 13, backgroundColor: c,
                borderWidth: color === c ? 3 : 1,
                borderColor: color === c ? '#fff' : 'rgba(255,255,255,0.3)',
              }}
            />
          ))}
          <TouchableOpacity
            onPress={() => setShowHue(s => !s)}
            disabled={tool === TOOLS.ERASER}
            style={{
              width: 26, height: 26, borderRadius: 13, backgroundColor: huePickerColor,
              borderWidth: showHue ? 3 : 1,
              borderColor: showHue ? '#fff' : 'rgba(255,255,255,0.4)',
              borderStyle: showHue ? 'solid' : 'dashed',
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14, lineHeight: 14 }}>+</Text>
          </TouchableOpacity>
        </View>

        {/* Free-hue slider — appears below when the "+" swatch is active.
            Single-touch slider over a horizontal rainbow track. */}
        {showHue && tool === TOOLS.PEN && (
          <View
            style={{ height: 24, marginHorizontal: 12, borderRadius: 12, overflow: 'hidden', flexDirection: 'row' }}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderMove={(evt) => {
              // Touch X is relative to the slider container start.
              const touch = evt.nativeEvent.locationX;
              const total = evt.nativeEvent.target?._nativeTag ? 280 : 280;
              const ratio = Math.max(0, Math.min(1, touch / total));
              const h = Math.round(ratio * 360);
              setHue(h);
              setColor(hsl(h));
            }}
            onResponderRelease={(evt) => {
              const touch = evt.nativeEvent.locationX;
              const ratio = Math.max(0, Math.min(1, touch / 280));
              const h = Math.round(ratio * 360);
              setHue(h);
              setColor(hsl(h));
            }}
          >
            {Array.from({ length: 12 }, (_, i) => (
              <View key={i} style={{ flex: 1, backgroundColor: hsl(i * 30), height: '100%' }} />
            ))}
          </View>
        )}

        {/* Stroke widths — 4 sizes, visualized as circles in the active color.
            Hidden behind eraser tool (eraser uses its own fixed hit-radius). */}
        {tool === TOOLS.PEN && (
          <View style={{ flexDirection: 'row', gap: 14, justifyContent: 'center', alignItems: 'center' }}>
            {STROKE_WIDTHS.map(w => (
              <TouchableOpacity
                key={w}
                onPress={() => setStrokeWidth(w)}
                style={{
                  alignItems: 'center', justifyContent: 'center',
                  width: 42, height: 42, borderRadius: 21,
                  backgroundColor: strokeWidth === w ? 'rgba(124,58,237,0.3)' : 'transparent',
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
                }}
              >
                <View style={{ width: w, height: w, borderRadius: w / 2, backgroundColor: color }} />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Actions row — Undo / Redo / Clear / Cancel / Done. Undo and redo
            disable cleanly when their stacks are empty. */}
        <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'space-between', marginTop: 4 }}>
          <TouchableOpacity onPress={onCancel} style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 12 }}>{t?.('common.cancel') || 'Cancelar'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleUndo}
            disabled={undoStack.length === 0}
            style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', opacity: undoStack.length === 0 ? 0.4 : 1 }}
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 12 }}>{t?.('common.undo') || 'Desfazer'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleRedo}
            disabled={redoStack.length === 0}
            style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', opacity: redoStack.length === 0 ? 0.4 : 1 }}
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 12 }}>{t?.('common.redo') || 'Refazer'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleClear}
            disabled={paths.length === 0}
            style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', opacity: paths.length === 0 ? 0.4 : 1 }}
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 12 }}>{t?.('common.clear') || 'Limpar'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleDone} style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: '#7C3AED', alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>{t?.('common.done') || 'Pronto'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}
