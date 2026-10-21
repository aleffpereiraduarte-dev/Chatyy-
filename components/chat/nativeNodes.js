// components/chat/nativeNodes.js — [2026-10-15 native-list fase 2]
//
// Mini "árvore de blocos" que a lista NATIVA (modules/expo-chat-message-list,
// apiVersion >= 2) sabe medir (fila de fundo) e desenhar. Os cartões ricos
// (enquete, localização, contato, prévia de link, chamada, presente, código,
// markdown de bloco…) são montados AQUI no JS, com os MESMOS valores de estilo
// do render JS de chat-conversation.js — o nativo só faz layout + desenho.
// Ajustar visual = OTA (sem build).
//
// Contrato completo: ver o cabeçalho de nativeThreadList.js ("Blocos").
// Unidades em dp; cores viram ARGB (número) aqui (toArgb).
//
// Ícones: `icon(IconX, {s, c})` converte o componente do components/Icons.js
// (react-native-svg) em paths SVG em tempo de execução → o nativo desenha o
// MESMO ícone P&B do JS (parser de path SVG no Swift/Kotlin).
import React from 'react';
import { toArgb } from './argb';

// [2026-10-21 view-once ícone] RAIZ do "círculo vazio" em TODO cartão nativo:
// com o React Compiler (app.json experiments.reactCompiler) cada IconX do
// components/Icons.js vira `const $ = c(n)` (useMemoCache). Chamado FORA do
// render (aqui, p/ extrair os paths) o dispatcher do React é null → LANÇA →
// o try/catch engolia → ps vazio → icon() null → só o círculo de fundo.
// Solução: durante a extração troca o dispatcher por um falso que só
// responde useMemoCache (cache "vazio" = sentinela → o componente recalcula
// tudo) e RESTAURA o original (mesmo se chamado dentro de um render).
const _MEMO_SENTINEL = Symbol.for('react.memo_cache_sentinel');
const _FAKE_DISPATCHER = {
  useMemoCache(n) { const a = new Array(Math.max(0, n | 0)); for (let i = 0; i < a.length; i++) a[i] = _MEMO_SENTINEL; return a; },
  useMemo(fn) { return fn(); },
  useCallback(fn) { return fn; },
  useContext(ctx) { return ctx ? ctx._currentValue : undefined; },
  readContext(ctx) { return ctx ? ctx._currentValue : undefined; },
};
function _withFakeDispatcher(fn) {
  let I = null;
  try { I = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE || null; } catch { I = null; }
  if (!I || typeof I !== 'object' || !('H' in I)) return fn();
  const prev = I.H;
  I.H = _FAKE_DISPATCHER;
  try { return fn(); } finally { I.H = prev; }
}

// ─── construtores ───────────────────────────────────────────────────────────
// Todos aceitam `o` com as props comuns: m, p, w, h, bg, r, bc, bw, a, op, fl,
// al, jc, pos, id. Cores podem ser string CSS (convertidas aqui).
const COLOR_KEYS = ['bg', 'bc', 'c', 'tint', 'ring'];
function _norm(n) {
  for (const k of COLOR_KEYS) {
    // `c` = cor no tx/ic, mas FILHOS (array) em v/h/z — não converter.
    if (n[k] != null && typeof n[k] !== 'number' && !Array.isArray(n[k])) n[k] = toArgb(n[k]);
  }
  if (n.c === undefined) delete n.c;
  return n;
}
function _clean(o) {
  const n = {};
  if (o) for (const k of Object.keys(o)) { const v = o[k]; if (v !== undefined && v !== null && v !== false) n[k] = v; }
  return n;
}

/** Pilha vertical. */
export function vstack(children, o) { const n = _clean(o); n.t = 'v'; n.c = (children || []).filter(Boolean); return _norm(n); }
/** Pilha horizontal (filho com fl:1 ocupa o resto). */
export function hstack(children, o) { const n = _clean(o); n.t = 'h'; n.c = (children || []).filter(Boolean); return _norm(n); }
/** Sobreposição: 1º filho define o tamanho; os outros usam `pos` ('tl','tr','bl','br','c','t','b','l','r') + m. */
export function zstack(children, o) { const n = _clean(o); n.t = 'z'; n.c = (children || []).filter(Boolean); return _norm(n); }
/** Texto. o: fs, fw (100..900), it, c, lh, ml, ta ('l'|'c'|'r'), ff ('mono'), body (fonte do usuário), mi (hora inline), sp, u, ls */
export function text(s, o) { const n = _clean(o); n.t = 'tx'; n.s = String(s == null ? '' : s); return _norm(n); }
/** Imagem. o: u, th, w, h, ar (w/h quando w = -1), fit ('cover'|'contain'), r (-1 = círculo), bg */
export function image(u, o) { const n = _clean(o); n.t = 'im'; n.u = String(u || ''); return _norm(n); }
/** Barra de progresso. o: v (0..1), h, c, bg, r, w */
export function progress(v, o) { const n = _clean(o); n.t = 'pb'; n.v = Math.max(0, Math.min(1, Number(v) || 0)); return _norm(n); }
/** Linha divisória. o: c, h (espessura), m */
export function divider(o) { const n = _clean(o); n.t = 'dv'; return _norm(n); }
/** Espaço. o: w, h, fl */
export function spacer(o) { const n = _clean(o); n.t = 'sp'; return _norm(n); }
/** Avatar circular: imagem ou iniciais. o: u, s, tx, bg, c, fs */
export function avatar(o) { const n = _clean(o); n.t = 'av'; return _norm(n); }
/** Indicador girando. o: s, c */
export function loader(o) { const n = _clean(o); n.t = 'ld'; return _norm(n); }
/** Nota de vídeo redonda (player nativo). o: u (vídeo), po (pôster), s (diâmetro), d (seg), ring, bg */
export function videoNote(o) { const n = _clean(o); n.t = 'vn'; return _norm(n); }

// ─── ícones (components/Icons.js → paths SVG) ──────────────────────────────
const _iconMemo = new Map();

function _num(v, d = 0) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function _pts(points) {
  const a = String(points || '').trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
  const out = [];
  for (let i = 0; i + 1 < a.length; i += 2) out.push([a[i], a[i + 1]]);
  return out;
}
function _shapeToD(type, p) {
  switch (type) {
    case 'Path': return String(p.d || '');
    case 'Line': return `M${_num(p.x1)} ${_num(p.y1)}L${_num(p.x2)} ${_num(p.y2)}`;
    case 'Polyline':
    case 'Polygon': {
      const pts = _pts(p.points);
      if (!pts.length) return '';
      let d = `M${pts[0][0]} ${pts[0][1]}`;
      for (let i = 1; i < pts.length; i++) d += `L${pts[i][0]} ${pts[i][1]}`;
      return type === 'Polygon' ? d + 'Z' : d;
    }
    case 'Circle':
    case 'Ellipse': {
      const cx = _num(p.cx); const cy = _num(p.cy);
      const rx = type === 'Circle' ? _num(p.r) : _num(p.rx); const ry = type === 'Circle' ? _num(p.r) : _num(p.ry);
      if (!(rx > 0 && ry > 0)) return '';
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case 'Rect': {
      const x = _num(p.x); const y = _num(p.y); const w = _num(p.width); const h = _num(p.height);
      let rx = _num(p.rx, NaN); let ry = _num(p.ry, NaN);
      if (!Number.isFinite(rx)) rx = Number.isFinite(ry) ? ry : 0;
      if (!Number.isFinite(ry)) ry = rx;
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      if (!(rx > 0)) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    default: return '';
  }
}
function _typeName(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  return t.displayName || t.name || '';
}
function _resolvePaint(v, color) {
  if (v === undefined || v === null) return undefined;
  if (v === 'none' || v === 'transparent') return 0;
  if (v === 'currentColor') return toArgb(color);
  return toArgb(v);
}
// Percorre a árvore de elementos devolvida pelo componente do ícone.
function _walk(el, inh, out, color, depth) {
  if (!el || depth > 12) return;
  if (Array.isArray(el)) { for (const c of el) _walk(c, inh, out, color, depth + 1); return; }
  if (typeof el !== 'object' || !el.props) return;
  let type = el.type;
  // memo / forwardRef / componentes função (o wrapper `I`): expande.
  if (type && typeof type === 'object' && type.type) type = type.type;
  const name = _typeName(type);
  const p = el.props || {};
  const SHAPES = ['Path', 'Line', 'Polyline', 'Polygon', 'Circle', 'Ellipse', 'Rect'];
  if (SHAPES.includes(name)) {
    const d = _shapeToD(name, p);
    if (!d) return;
    const fill = _resolvePaint(p.fill, color);
    const stroke = _resolvePaint(p.stroke, color);
    const sw = p.strokeWidth != null ? _num(p.strokeWidth, inh.sw) : inh.sw;
    const f = fill !== undefined ? fill : inh.fill;
    const k = stroke !== undefined ? stroke : inh.stroke;
    const op = p.opacity != null ? _num(p.opacity, 1) : 1;
    const e = { d };
    if (f) e.f = f;
    if (k && sw > 0) { e.k = k; e.w = sw; }
    if (op < 1) e.o = op;
    if (e.f || e.k) out.push(e);
    return;
  }
  if (name === 'Svg' || name === 'G' || name === 'Fragment' || name === '') {
    const next = { ...inh };
    if (p.fill !== undefined) next.fill = _resolvePaint(p.fill, color);
    if (p.stroke !== undefined) next.stroke = _resolvePaint(p.stroke, color);
    if (p.strokeWidth !== undefined) next.sw = _num(p.strokeWidth, inh.sw);
    if (name === 'Svg' && p.viewBox) { const vb = String(p.viewBox).split(/[\s,]+/).map(Number); if (vb.length === 4 && vb[2] > 0) out.vb = vb[2]; }
    _walk(p.children, next, out, color, depth + 1);
    return;
  }
  if (typeof type === 'function' && depth < 6) {
    let r = null;
    try { r = type(p); } catch { r = null; }
    _walk(r, inh, out, color, depth + 1);
  }
}

/**
 * Ícone do components/Icons.js como nó nativo.
 *   icon(IconPhone, { s: 18, c: '#111' })  → { t:'ic', s, vb, ps:[{d,f?,k?,w?,o?}] }
 * Cache por (componente, cor, sw). Falha → null (o chamador ignora o nó).
 */
export function icon(Comp, o = {}) {
  if (!Comp) return null;
  const color = o.c || '#000000';
  const key = Comp;
  let byColor = _iconMemo.get(key);
  if (!byColor) { byColor = new Map(); _iconMemo.set(key, byColor); }
  const ck = String(color) + '|' + (o.sw || '') + '|' + (o.fill || '');
  let ent = byColor.get(ck);
  if (!ent) {
    const out = [];
    try {
      const props = { size: 24, color };
      if (o.fill) props.fill = o.fill;
      if (o.sw) props.strokeWidth = o.sw;
      let el = null;
      const C = (Comp && typeof Comp === 'object' && Comp.type) ? Comp.type : Comp;
      _withFakeDispatcher(() => {
        if (typeof C === 'function') el = C(props);
        _walk(el, { fill: 0, stroke: toArgb(color), sw: o.sw || 1.9 }, out, color, 0);
      });
    } catch {}
    ent = { ps: out.slice(), vb: out.vb || 24 };
    if (byColor.size > 16) byColor.clear();
    byColor.set(ck, ent);
  }
  if (!ent.ps.length) return null;
  const n = _clean(o);
  delete n.c; delete n.sw; delete n.fill;
  n.t = 'ic';
  n.s = Number(o.s) || 18;
  n.vb = ent.vb;
  n.ps = ent.ps;
  return _norm(n);
}

/** Ícone a partir de paths crus (viewBox 24): [{d, f?, k?, w?}] com cores CSS. */
export function iconPaths(paths, o = {}) {
  const ps = [];
  for (const p of paths || []) {
    if (!p || !p.d) continue;
    const e = { d: String(p.d) };
    if (p.f) e.f = toArgb(p.f);
    if (p.k) { e.k = toArgb(p.k); e.w = Number(p.w) || 1.9; }
    if (e.f || e.k) ps.push(e);
  }
  if (!ps.length) return null;
  const n = _clean(o);
  n.t = 'ic'; n.s = Number(o.s) || 18; n.vb = Number(o.vb) || 24; n.ps = ps;
  return _norm(n);
}

export { toArgb };
