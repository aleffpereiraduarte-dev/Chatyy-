// [viewers 2026-10-20] blurhash → data:image/bmp;base64 (32×32), em JS puro.
// O visualizador NATIVO de status aceita `thumb` como data: URI (iOS
// MVImageLoader / Android Glide) e pinta a miniatura por baixo da mídia
// enquanto o arquivo baixa — sem build novo. BMP 24-bit: sem compressão, o
// encoder é trivial e ~3 KB de base64 para 32×32. Cache por hash.
const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
const _cache = new Map();

function _d83(s) {
  let v = 0;
  for (let i = 0; i < s.length; i++) {
    const d = B83.indexOf(s[i]);
    if (d < 0) throw new Error('bad blurhash');
    v = v * 83 + d;
  }
  return v;
}
function _s2l(v) { const x = v / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
function _l2s(v) {
  const x = Math.max(0, Math.min(1, v));
  return x <= 0.0031308 ? Math.round(x * 12.92 * 255 + 0.5) : Math.round((1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255 + 0.5);
}
function _sp(v, e) { return Math.sign(v) * Math.pow(Math.abs(v), e); }

export function isValidBlurhash(h) {
  if (typeof h !== 'string' || h.length < 6 || h.length > 100) return false;
  try {
    const sf = _d83(h[0]);
    const nx = (sf % 9) + 1, ny = Math.floor(sf / 9) + 1;
    return h.length === 4 + 2 * nx * ny;
  } catch { return false; }
}

function _decode(h, w, hgt) {
  const sf = _d83(h[0]);
  const nx = (sf % 9) + 1, ny = Math.floor(sf / 9) + 1;
  const maxV = (_d83(h[1]) + 1) / 166;
  const colors = new Array(nx * ny);
  const dc = _d83(h.substring(2, 6));
  colors[0] = [_s2l(dc >> 16), _s2l((dc >> 8) & 255), _s2l(dc & 255)];
  for (let i = 1; i < nx * ny; i++) {
    const v = _d83(h.substring(4 + i * 2, 6 + i * 2));
    const q = (x) => _sp((x - 9) / 9, 2) * maxV;
    colors[i] = [q(Math.floor(v / 361)), q(Math.floor(v / 19) % 19), q(v % 19)];
  }
  const px = new Uint8Array(w * hgt * 3);
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < ny; j++) {
        const cy = Math.cos((Math.PI * y * j) / hgt);
        for (let i = 0; i < nx; i++) {
          const basis = Math.cos((Math.PI * x * i) / w) * cy;
          const c = colors[i + j * nx];
          r += c[0] * basis; g += c[1] * basis; b += c[2] * basis;
        }
      }
      const o = (y * w + x) * 3;
      px[o] = _l2s(r); px[o + 1] = _l2s(g); px[o + 2] = _l2s(b);
    }
  }
  return px;
}

const _B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function _b64(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += _B64[(n >> 18) & 63] + _B64[(n >> 12) & 63] + _B64[(n >> 6) & 63] + _B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += _B64[(n >> 18) & 63] + _B64[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += _B64[(n >> 18) & 63] + _B64[(n >> 12) & 63] + _B64[(n >> 6) & 63] + '=';
  }
  return out;
}

function _bmp(px, w, h) {
  const row = w * 3; // 32*3 = 96, múltiplo de 4 → sem padding
  const pad = (4 - (row % 4)) % 4;
  const dataSize = (row + pad) * h;
  const size = 54 + dataSize;
  const b = new Uint8Array(size);
  const u32 = (o, v) => { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; b[o + 2] = (v >> 16) & 255; b[o + 3] = (v >>> 24) & 255; };
  b[0] = 0x42; b[1] = 0x4d; u32(2, size); u32(10, 54);
  u32(14, 40); u32(18, w); u32(22, h); b[26] = 1; b[28] = 24; u32(34, dataSize);
  let o = 54;
  for (let y = h - 1; y >= 0; y--) { // BMP = de baixo p/ cima, BGR
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 3;
      b[o++] = px[p + 2]; b[o++] = px[p + 1]; b[o++] = px[p];
    }
    o += pad;
  }
  return b;
}

/** data:image/bmp;base64,… ou '' se o hash for inválido. */
export function blurhashToDataUri(hash, size = 32) {
  if (!isValidBlurhash(hash)) return '';
  const k = hash + '|' + size;
  const hit = _cache.get(k);
  if (hit) return hit;
  let uri = '';
  try { uri = 'data:image/bmp;base64,' + _b64(_bmp(_decode(hash, size, size), size, size)); } catch { uri = ''; }
  if (_cache.size > 80) _cache.clear();
  _cache.set(k, uri);
  return uri;
}
