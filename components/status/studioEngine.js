// [2026-10-09 status-composer] Motor de imagem do compositor de status — NATIVO.
// (O web usa studioEngine.web.js: canvas 2D + html2canvas.)
//
// GPU/Skia: @shopify/react-native-skia 2.6.3 JÁ está no binário runtime 2.6.0
// (autolinked desde maio) — então filtro de verdade sai por OTA. Mesmo assim o
// módulo só é carregado depois de confirmar que a ligação nativa existe
// (global.SkiaApi ou TurboModule RNSkiaModule): o NativeSetup do Skia LANÇA no
// require se o nativo faltar, e erro de avaliação de módulo é fatal no Metro.
// Sem Skia → SKIA_AVAILABLE=false: o estúdio esconde filtros/ajustes e o resto
// (texto, figurinhas, desenho, recorte, publicar) segue funcionando.
//
// Pipeline (1 encode por etapa, sem perda acumulada):
//   prepareBase  → expo-image-manipulator: EXIF assado, giro, recorte, teto 2160px
//   FilteredStage → prévia ao vivo: <Canvas><Image><ColorMatrix/></Image></Canvas>,
//                   duas metades recortadas durante o deslizar (troca de filtro)
//   exportFiltered → Skia raster: drawImageRect + ColorFilter.MakeMatrix → JPEG 92
//   captureStage  → react-native-view-shot: achata texto/figurinha/desenho
import React, { useMemo } from 'react';
import { Platform, TurboModuleRegistry, Image as RNImage, View } from 'react-native';
import { analyzeStats, isIdentity } from './statusFilters';

let _sk; // undefined = não sondado; null = indisponível
export function getSkia() {
  if (_sk !== undefined) return _sk;
  _sk = null;
  if (Platform.OS === 'web') return null;
  try {
    let present = global.SkiaApi != null;
    if (!present) {
      try { present = !!(TurboModuleRegistry?.get && TurboModuleRegistry.get('RNSkiaModule')); } catch { present = false; }
    }
    if (!present) return null;
    // eslint-disable-next-line global-require
    const mod = require('@shopify/react-native-skia');
    if (mod?.Skia && mod?.Canvas) _sk = mod;
  } catch { _sk = null; }
  return _sk;
}
export const ENGINE_KIND = 'native';
export function filtersAvailable() { return !!getSkia(); }

function _IM() { try { return require('expo-image-manipulator'); } catch { return null; } }
function _FS() { try { return require('expo-file-system/legacy'); } catch { return null; } }

export function getImageSize(uri) {
  return new Promise((resolve) => {
    try { RNImage.getSize(uri, (w, h) => resolve({ width: w, height: h }), () => resolve(null)); }
    catch { resolve(null); }
  });
}

// aspect: null (original) | número (largura/altura, ex. 9/16, 1, 4/5)
export async function prepareBase(uri, { rotate = 0, aspect = null, maxSide = 2160, srcWidth, srcHeight } = {}) {
  const IM = _IM();
  if (!IM?.manipulateAsync) {
    const sz = (srcWidth && srcHeight) ? { width: srcWidth, height: srcHeight } : await getImageSize(uri);
    return { uri, width: sz?.width || 1080, height: sz?.height || 1920 };
  }
  let sz = (srcWidth && srcHeight) ? { width: srcWidth, height: srcHeight } : await getImageSize(uri);
  if (!sz) {
    // Sem dimensão: 1º passe só normaliza e devolve o tamanho real.
    const n = await IM.manipulateAsync(uri, [], { compress: 0.95, format: IM.SaveFormat.JPEG });
    sz = { width: n.width, height: n.height };
    uri = n.uri;
  }
  const rot = ((rotate % 360) + 360) % 360;
  let w = sz.width, h = sz.height;
  if (rot === 90 || rot === 270) { const t = w; w = h; h = t; }
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const rw = Math.max(1, Math.round(w * scale));
  const rh = Math.max(1, Math.round(h * scale));
  const actions = [];
  if (rot) actions.push({ rotate: rot });
  if (scale < 1) actions.push({ resize: { width: rw, height: rh } });
  if (aspect && aspect > 0) {
    let cw = rw, ch = Math.round(rw / aspect);
    if (ch > rh) { ch = rh; cw = Math.round(rh * aspect); }
    actions.push({ crop: { originX: Math.floor((rw - cw) / 2), originY: Math.floor((rh - ch) / 2), width: cw, height: ch } });
  }
  const out = await IM.manipulateAsync(uri, actions, { compress: 0.95, format: IM.SaveFormat.JPEG });
  return { uri: out.uri, width: out.width, height: out.height };
}

export async function makeThumb(uri, size = 160) {
  const IM = _IM();
  if (!IM?.manipulateAsync) return uri;
  try {
    const out = await IM.manipulateAsync(uri, [{ resize: { width: size } }], { compress: 0.8, format: IM.SaveFormat.JPEG });
    return out.uri;
  } catch { return uri; }
}

async function _loadSkImage(uri) {
  const Sk = getSkia();
  if (!Sk) return null;
  const data = await Sk.Skia.Data.fromURI(uri);
  return Sk.Skia.Image.MakeImageFromEncoded(data);
}

export async function sampleStats(uri) {
  try {
    const Sk = getSkia();
    if (!Sk) return null;
    const img = await _loadSkImage(uri);
    if (!img) return null;
    const N = 32;
    const surf = Sk.Skia.Surface.Make(N, N);
    if (!surf) return null;
    const c = surf.getCanvas();
    const paint = Sk.Skia.Paint();
    c.drawImageRect(img, Sk.Skia.XYWHRect(0, 0, img.width(), img.height()), Sk.Skia.XYWHRect(0, 0, N, N), paint);
    surf.flush();
    const snap = surf.makeImageSnapshot();
    const px = snap.readPixels(0, 0, {
      width: N, height: N,
      colorType: Sk.ColorType?.RGBA_8888 ?? 4,
      alphaType: Sk.AlphaType?.Unpremul ?? 3,
    });
    return px ? analyzeStats(px) : null;
  } catch { return null; }
}

// Exporta a base com a matriz aplicada (resolução cheia). Matriz identidade =
// devolve a própria base (zero reencode).
export async function exportFiltered(base, matrix) {
  if (!matrix || isIdentity(matrix)) return { uri: base.uri, width: base.width, height: base.height };
  const Sk = getSkia();
  if (!Sk) return { uri: base.uri, width: base.width, height: base.height };
  const img = await _loadSkImage(base.uri);
  if (!img) throw new Error('decode failed');
  const w = img.width(), h = img.height();
  const surf = Sk.Skia.Surface.Make(w, h);
  if (!surf) throw new Error('surface failed');
  const canvas = surf.getCanvas();
  const paint = Sk.Skia.Paint();
  paint.setColorFilter(Sk.Skia.ColorFilter.MakeMatrix(matrix));
  canvas.drawImageRect(img, Sk.Skia.XYWHRect(0, 0, w, h), Sk.Skia.XYWHRect(0, 0, w, h), paint);
  surf.flush();
  const b64 = surf.makeImageSnapshot().encodeToBase64(Sk.ImageFormat?.JPEG ?? 3, 92);
  const FS = _FS();
  if (!FS?.cacheDirectory) throw new Error('fs unavailable');
  const path = `${FS.cacheDirectory}status-studio-${Date.now().toString(36)}.jpg`;
  await FS.writeAsStringAsync(path, b64, { encoding: 'base64' });
  return { uri: path, width: w, height: h };
}

// Achata o palco (imagem + overlays) num JPEG 1080 de largura.
export async function captureStage(viewRef, { width, height }) {
  // eslint-disable-next-line global-require
  const vs = require('react-native-view-shot');
  const cap = vs.captureRef || vs.default?.captureRef;
  const outW = 1080;
  const outH = Math.round(outW * (height / Math.max(1, width)));
  const uri = await cap(viewRef, { format: 'jpg', quality: 0.92, result: 'tmpfile', width: outW, height: outH });
  return { uri: String(uri).startsWith('/') ? `file://${uri}` : uri, width: outW, height: outH };
}

export function toUploadFile(res, name = 'status.jpg') {
  return { uri: res.uri, name, type: 'image/jpeg' };
}

// ─── Componentes de prévia ──────────────────────────────────────────────────
// Desenha a imagem em "contain" dentro de width×height. `split` (px) divide o
// palco: esquerda usa `matrix`, direita usa `matrixRight` (troca deslizando).
function fitRect(iw, ih, W, H) {
  const s = Math.min(W / iw, H / ih);
  const w = iw * s, h = ih * s;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

function SkiaStage({ Sk, uri, imgW, imgH, width, height, matrix, matrixRight, split }) {
  const image = Sk.useImage(uri);
  const r = useMemo(() => fitRect(imgW || 1, imgH || 1, width, height), [imgW, imgH, width, height]);
  if (!image) {
    return <RNImage source={{ uri }} style={{ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h }} />;
  }
  const { Canvas, Group, ColorMatrix } = Sk;
  const SkImg = Sk.Image;
  const hasSplit = matrixRight && typeof split === 'number' && split > 0 && split < width;
  const layer = (m) => (
    <SkImg image={image} x={r.x} y={r.y} width={r.w} height={r.h} fit="fill">
      {m ? <ColorMatrix matrix={m} /> : null}
    </SkImg>
  );
  return (
    <Canvas style={{ width, height }} pointerEvents="none">
      {hasSplit ? (
        <>
          <Group clip={Sk.rect(0, 0, split, height)}>{layer(matrix)}</Group>
          <Group clip={Sk.rect(split, 0, width - split, height)}>{layer(matrixRight)}</Group>
        </>
      ) : layer(matrix)}
    </Canvas>
  );
}

export function FilteredStage(props) {
  const Sk = getSkia();
  const { uri, imgW, imgH, width, height } = props;
  if (!uri || !width || !height) return null;
  if (!Sk) {
    const r = fitRect(imgW || 1, imgH || 1, width, height);
    return (
      <View style={{ width, height }} pointerEvents="none">
        <RNImage source={{ uri }} style={{ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h }} />
      </View>
    );
  }
  return <SkiaStage Sk={Sk} {...props} />;
}

function SkiaThumbs({ Sk, uri, size, items, renderItem }) {
  const image = Sk.useImage(uri);
  const { Canvas, ColorMatrix } = Sk;
  const SkImg = Sk.Image;
  return items.map((it, i) => renderItem(it, i, (
    image ? (
      <Canvas style={{ width: size, height: size }} pointerEvents="none">
        <SkImg image={image} x={0} y={0} width={size} height={size} fit="cover">
          <ColorMatrix matrix={it.matrix} />
        </SkImg>
      </Canvas>
    ) : <RNImage source={{ uri }} style={{ width: size, height: size }} />
  )));
}

// items: [{ key, matrix }]; renderItem(item, index, thumbNode) → elemento.
export function FilterThumbs({ uri, size = 58, items, renderItem }) {
  const Sk = getSkia();
  if (!uri) return null;
  if (!Sk) return items.map((it, i) => renderItem(it, i, <RNImage source={{ uri }} style={{ width: size, height: size }} />));
  return <SkiaThumbs Sk={Sk} uri={uri} size={size} items={items} renderItem={renderItem} />;
}
