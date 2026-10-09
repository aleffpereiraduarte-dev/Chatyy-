// [2026-10-09 status-composer] Motor de imagem do compositor de status — WEB.
// Mesma API do studioEngine.js (nativo/Skia), implementada com canvas 2D:
// a matriz de cor de statusFilters.js é aplicada pixel a pixel, então a prévia
// e o arquivo final batem exatamente com o nativo. Overlays (texto, figurinha,
// desenho) são achatados com html2canvas (já vem com react-native-view-shot).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image as RNImage, View } from 'react-native';
import { analyzeStats, applyMatrixToRGBA, isIdentity } from './statusFilters';

export function getSkia() { return null; }
export const ENGINE_KIND = 'web';
export function filtersAvailable() { return typeof document !== 'undefined'; }

const _imgCache = new Map();
function loadImg(uri) {
  if (_imgCache.has(uri)) return _imgCache.get(uri);
  const p = new Promise((resolve, reject) => {
    const img = new window.Image();
    if (!/^(blob:|data:)/.test(uri)) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => { _imgCache.delete(uri); reject(new Error('image load failed')); };
    img.src = uri;
  });
  _imgCache.set(uri, p);
  return p;
}

function canvasToBlob(canvas, type = 'image/jpeg', q = 0.92) {
  return new Promise((resolve, reject) => {
    try { canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, q); }
    catch (e) { reject(e); }
  });
}

export async function getImageSize(uri) {
  try { const img = await loadImg(uri); return { width: img.naturalWidth, height: img.naturalHeight }; }
  catch { return null; }
}

export async function prepareBase(uri, { rotate = 0, aspect = null, maxSide = 2160 } = {}) {
  const img = await loadImg(uri);
  const rot = ((rotate % 360) + 360) % 360;
  let w = img.naturalWidth, h = img.naturalHeight;
  const swap = rot === 90 || rot === 270;
  let rw = swap ? h : w, rh = swap ? w : h;
  const scale = Math.min(1, maxSide / Math.max(rw, rh));
  rw = Math.round(rw * scale); rh = Math.round(rh * scale);
  let cw = rw, ch = rh;
  if (aspect && aspect > 0) {
    ch = Math.round(rw / aspect);
    if (ch > rh) { ch = rh; cw = Math.round(rh * aspect); }
  }
  if (!rot && scale === 1 && cw === rw && ch === rh) return { uri, width: w, height: h };
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate((rot * Math.PI) / 180);
  const dw = (swap ? rh : rw), dh = (swap ? rw : rh);
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.95);
  return { uri: URL.createObjectURL(blob), width: cw, height: ch };
}

export async function makeThumb(uri, size = 160) {
  try {
    const img = await loadImg(uri);
    const s = size / Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch { return uri; }
}

export async function sampleStats(uri) {
  try {
    const img = await loadImg(uri);
    const N = 32;
    const canvas = document.createElement('canvas');
    canvas.width = N; canvas.height = N;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, N, N);
    return analyzeStats(ctx.getImageData(0, 0, N, N).data);
  } catch { return null; }
}

async function renderFiltered(uri, matrix, maxW) {
  const img = await loadImg(uri);
  const s = Math.min(1, maxW / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * s));
  const h = Math.max(1, Math.round(img.naturalHeight * s));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  if (matrix && !isIdentity(matrix)) {
    const d = ctx.getImageData(0, 0, w, h);
    applyMatrixToRGBA(d.data, matrix);
    ctx.putImageData(d, 0, 0);
  }
  return canvas;
}

const _previewCache = new Map(); // `${uri}|${maxW}|${matrix}` → dataURL
async function previewURL(uri, matrix, maxW) {
  const key = `${uri}|${maxW}|${matrix ? matrix.map(v => v.toFixed(3)).join(',') : 'id'}`;
  if (_previewCache.has(key)) return _previewCache.get(key);
  const canvas = await renderFiltered(uri, matrix, maxW);
  const url = canvas.toDataURL('image/jpeg', 0.9);
  if (_previewCache.size > 60) _previewCache.delete(_previewCache.keys().next().value);
  _previewCache.set(key, url);
  return url;
}

export async function exportFiltered(base, matrix) {
  if (!matrix || isIdentity(matrix)) {
    return { uri: base.uri, width: base.width, height: base.height };
  }
  const canvas = await renderFiltered(base.uri, matrix, 4096);
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
  return { uri: URL.createObjectURL(blob), width: canvas.width, height: canvas.height, blob };
}

export async function captureStage(viewRef, { width, height }) {
  // eslint-disable-next-line global-require
  const mod = require('html2canvas');
  const html2canvas = mod?.default || mod;
  const node = viewRef?.current || viewRef;
  const scale = Math.min(3, Math.max(1, 1080 / Math.max(1, width)));
  const canvas = await html2canvas(node, { useCORS: true, backgroundColor: '#000000', scale, logging: false });
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
  return { uri: URL.createObjectURL(blob), width: canvas.width, height: canvas.height, blob };
}

export function toUploadFile(res, name = 'status.jpg') {
  if (res?.blob) {
    try { return new File([res.blob], name, { type: 'image/jpeg' }); } catch {}
    return { uri: res.uri, name, type: 'image/jpeg', blob: res.blob };
  }
  return { uri: res.uri, name, type: 'image/jpeg' };
}

// ─── Componentes ────────────────────────────────────────────────────────────
function fitRect(iw, ih, W, H) {
  const s = Math.min(W / iw, H / ih);
  const w = iw * s, h = ih * s;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

function useFilteredURL(uri, matrix, maxW) {
  const [url, setUrl] = useState(null);
  const seq = useRef(0);
  const mKey = matrix ? matrix.map(v => v.toFixed(3)).join(',') : 'id';
  useEffect(() => {
    if (!uri) return undefined;
    const my = ++seq.current;
    // rAF: coalesce slider ticks into one render per frame.
    const id = requestAnimationFrame(() => {
      previewURL(uri, matrix, maxW).then((u) => { if (my === seq.current) setUrl(u); }).catch(() => {});
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, mKey, maxW]);
  return url;
}

export function FilteredStage({ uri, imgW, imgH, width, height, matrix, matrixRight, split }) {
  const r = useMemo(() => fitRect(imgW || 1, imgH || 1, width || 1, height || 1), [imgW, imgH, width, height]);
  const maxW = Math.min(1200, Math.round(r.w * Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)));
  const left = useFilteredURL(uri, matrix, maxW);
  const hasSplit = !!matrixRight && typeof split === 'number' && split > 0 && split < width;
  const right = useFilteredURL(hasSplit ? uri : null, matrixRight, maxW);
  if (!uri || !width || !height) return null;
  const img = (src) => <RNImage source={{ uri: src || uri }} style={{ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h }} />;
  if (!hasSplit) return <View style={{ width, height }} pointerEvents="none">{img(left)}</View>;
  return (
    <View style={{ width, height }} pointerEvents="none">
      <View style={{ position: 'absolute', left: 0, top: 0, width: split, height, overflow: 'hidden' }}>{img(left)}</View>
      <View style={{ position: 'absolute', left: split, top: 0, width: width - split, height, overflow: 'hidden' }}>
        <View style={{ position: 'absolute', left: -split, top: 0, width, height }}>{img(right || left)}</View>
      </View>
    </View>
  );
}

function WebThumb({ uri, matrix, size }) {
  const url = useFilteredURL(uri, matrix, size * 2);
  return <RNImage source={{ uri: url || uri }} style={{ width: size, height: size }} />;
}

export function FilterThumbs({ uri, size = 58, items, renderItem }) {
  if (!uri) return null;
  return items.map((it, i) => renderItem(it, i, <WebThumb uri={uri} matrix={it.matrix} size={size} />));
}
