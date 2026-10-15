// components/chat/nativeThreadList.js — [2026-10-14 native-list]
//
// Lista de MENSAGENS da conversa 100% NATIVA (Telegram-style):
//   iOS     = UICollectionView invertida + células desenhadas à mão; texto com
//             layout CoreText calculado em fila de fundo (altura cacheada por
//             linha/largura), hora/✓✓ inline na última linha, citação,
//             imagem/figurinha/vídeo (pôster) com cache próprio, áudio simples,
//             arrastar-p/-responder e inserção animada.
//   Android = RecyclerView invertida (reverseLayout) + StaticLayout
//             pré-calculado em background, mesmas células.
// Módulo nativo: modules/expo-chat-message-list (view `ChatyyMessageList`).
//
// O JS só NORMALIZA as linhas (o que já está em `threadListData`, já
// enriquecido com recibos/agrupamento) para um modelo compacto e manda ao
// nativo um DIFF por chave (ordem só quando muda + linhas cujo JSON mudou),
// nunca a lista inteira a cada render.
//
// Decisão POR CONVERSA (useNativeThreadList): só liga se TODAS as linhas
// carregadas forem de tipos suportados; uma linha não suportada → caminho JS
// completo (FlashList) até sair da conversa (sem pular de motor).
//   apiVersion 1 (fase 1): texto simples/formatado, resposta, imagem, álbum,
//     vídeo, gif, figurinha, áudio/voz, arquivo, sistema, data, não-lidas,
//     apagada.
//   apiVersion 2 (fase 2, 2026-10-15): + links/menções reais/# tocáveis (rich
//     LIGADO por padrão), código ``` (bloco mono), citação/lista (markdown de
//     bloco), spoiler, code inline, emoji customizado, smart actions (chips),
//     tradução por linha (+ "(original)"), pílula "Você foi mencionado",
//     E2E pendente, falhou (mesmo reenvio do JS), fixada/temporária na meta, e
//     os CARTÕES de nativeRowCards (enquete, localização, contato, evento,
//     chamada, presente, nota de vídeo, visualização única, resposta a status,
//     prévia de link…). Fica no JS: busca/Salvas, texto > 6000, JSON
//     desconhecido, conteúdo filtrado (parental), voicemail, borrado.
//
// Contrato fase 2 (detalhe: modules/expo-chat-message-list + SPEC da fase 2):
//   linha  bl (conteúdo em blocos) · pre/post (blocos antes/depois do conteúdo
//          padrão) · cw · bare · pad · mp ('in'|'below'|'over'|'none') · fail ·
//          pin · tmr · op · bbg (fundo do balão recebido quando me mencionam)
//   spans  [start, end, flags, url?, color?] — 1 negrito 2 itálico 4 tachado
//          8 mono 16 link 32 menção (url 'handle|destino') 64 hashtag
//          128 emoji customizado (U+FFFC, url = imagem) 256 spoiler
//          512 code inline (color = fundo)
//   nós    v/h/z (pilhas) · tx · im · ic (paths SVG do components/Icons.js) ·
//          pb · dv · sp · av · ld · vn — construtores em nativeNodes.js; `a` =
//          ação → onRowPress part 'action' (smart:<i>, tr:toggle, retry, e as
//          dos cartões); part 'retry' = ícone de falha.
//   lift   onRowLongPress traz `anchor` {uri,x,y,w,h} (snapshot do balão) →
//          o MESMO overlay JS de lift (MessageLiftOverlay); ref.setLiftedKey(k)
//          esconde o balão enquanto o menu está aberto ('' restaura).
//   prop   stickyDate {on, top, bg, fg, shadow} = pílula de data nativa.
//   menu   [apiVersion 3, native-ctxmenu] prop ctxMenu → o long-press abre o
//          menu de contexto NATIVO (balão sai da lista, blur, reações, ações);
//          onRowLongPress traz native:1 e o JS responde com
//          ref.showContextMenu(payload de nativeContextMenu.buildNativeCtxMenu);
//          escolhas voltam por onMenuAction {key, messageId, action} /
//          onReact {key, messageId, emoji}; onMenuDismiss {key, reason}.
//          Kill switch: globalThis.__chatyy_native_ctxmenu = false.
//
// Desligar (OTA):      globalThis.__chatyy_native_list = false
// Links/menções/#:     globalThis.__chatyy_native_list_rich = false desliga
//                      (fase 1 = opt-in com true)
// Fallback automático: erro nativo (onNativeError), view que não ficou pronta
// em 2,5 s, ou crash do processo com a lista montada (2× → desliga até a
// próxima versão do bundle).
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet } from 'react-native';

// Padrão LIGADO quando o binário tem o módulo. Kill switch acima.
const NATIVE_LIST_DEFAULT_ON = true;
const READY_TIMEOUT_MS = 2500;
const CRASH_KEY = 'native_list_guard_v1';

// ─── disponibilidade ────────────────────────────────────────────────────────
let _viewChecked = false;
let _NativeView = null;
let _sessionDisabled = false; // erro nativo nesta sessão → JS até reiniciar
let _sessionReason = '';
let _api = 0; // apiVersion do binário (1 = fase 1; 2 = blocos/lift/seleção/fixa)
/** [native-ctxmenu] kill switch OTA do menu de contexto nativo. */
function _ctxMenuSwitchOn() { try { return globalThis.__chatyy_native_ctxmenu !== false; } catch { return true; } }
/** Menu de contexto nativo disponível (binário apiVersion ≥ 3 + kill switch). */
export function nativeCtxMenuAvailable() { _getNativeView(); return _api >= 3 && _ctxMenuSwitchOn(); }
/** apiVersion do módulo nativo (0 = ausente). */
export function nativeListApi() { _getNativeView(); return _api; }

function _getNativeView() {
  if (_viewChecked) return _NativeView;
  _viewChecked = true;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    const expo = require('expo');
    const mod = typeof expo.requireOptionalNativeModule === 'function'
      ? expo.requireOptionalNativeModule('ChatyyMessageList')
      : null;
    if (!mod || typeof mod.apiVersion !== 'function') return null;
    let api = 0;
    try { api = Number(mod.apiVersion()) || 0; } catch { api = 0; }
    if (api < 1) return null;
    _api = api;
    // requireNativeView não lança quando a view não existe — confirma pela
    // config registrada no binário (mesma técnica de viewCaps.ts).
    const g = globalThis;
    const cfg = g && g.expo && typeof g.expo.getViewConfig === 'function' ? g.expo.getViewConfig('ChatyyMessageList') : null;
    if (!cfg) return null;
    _NativeView = expo.requireNativeView('ChatyyMessageList');
  } catch {
    _NativeView = null;
  }
  return _NativeView;
}

// Guarda de crash: marca "montada" num storage síncrono; desmontagem limpa ou
// app indo p/ 2º plano limpa. Se no boot seguinte a marca ainda existe, o
// processo morreu com a lista montada → conta; 2 seguidas = desliga.
let _guardChecked = false;
let _guardTripped = false;
function _storage() {
  try { return require('../../services/mmkv'); } catch { return null; }
}
function _bundleTag() {
  try {
    const U = require('expo-updates');
    return String((U && (U.updateId || U.runtimeVersion)) || 'embedded');
  } catch { return 'embedded'; }
}
function _readGuard() {
  const s = _storage();
  if (!s || typeof s.getJSON !== 'function') return null;
  try { return s.getJSON(CRASH_KEY); } catch { return null; }
}
function _writeGuard(v) {
  const s = _storage();
  if (!s || typeof s.setJSON !== 'function') return;
  try { s.setJSON(CRASH_KEY, v); } catch {}
}
function _checkGuardOnce() {
  if (_guardChecked) return _guardTripped;
  _guardChecked = true;
  const tag = _bundleTag();
  const g = _readGuard();
  if (!g || typeof g !== 'object') return false;
  if (g.tag !== tag) { _writeGuard({ tag, crashes: 0, mounted: 0 }); return false; }
  let crashes = Number(g.crashes) || 0;
  if (g.mounted) crashes += 1;
  _writeGuard({ tag, crashes, mounted: 0 });
  _guardTripped = crashes >= 2;
  if (_guardTripped) _beacon('crash_guard', 'crashes=' + crashes);
  return _guardTripped;
}
function _markMounted(on) {
  const tag = _bundleTag();
  const g = _readGuard() || {};
  const crashes = g.tag === tag ? (Number(g.crashes) || 0) : 0;
  // Uma sessão que desmontou limpo zera a contagem (crash não-relacionado).
  _writeGuard({ tag, crashes: on ? crashes : 0, mounted: on ? 1 : 0 });
}

function _beacon(step, info) {
  try {
    const api = require('../../services/api').default || require('../../services/api');
    api?.apiCall?.('callkit_diag', { info: `native_list ${step} ${info || ''}`.slice(0, 400), platform: Platform.OS }, 'POST')?.catch?.(() => {});
  } catch {}
}

export function isNativeThreadListAvailable() {
  if (_sessionDisabled) return false;
  try {
    const o = globalThis.__chatyy_native_list;
    if (o === false) return false;
    if (o !== true && !NATIVE_LIST_DEFAULT_ON) return false;
  } catch {}
  if (!_getNativeView()) return false;
  if (_checkGuardOnce()) return false;
  return true;
}

export function disableNativeThreadListForSession(reason) {
  if (_sessionDisabled) return;
  _sessionDisabled = true;
  _sessionReason = String(reason || '');
  _beacon('disabled', _sessionReason);
}

function _richAllowed() {
  // [fase 2] links/menções/# LIGADOS por padrão (api >= 2); kill switch OTA:
  // globalThis.__chatyy_native_list_rich = false. Fase 1 (api 1) = opt-in.
  try {
    const o = globalThis.__chatyy_native_list_rich;
    if (o === false) return false;
    if (o === true) return true;
  } catch {}
  return _api >= 2;
}

// ─── cores ──────────────────────────────────────────────────────────────────
// ARGB 32-bit (número) — o nativo não precisa interpretar strings CSS.
import { toArgb } from './argb';
export { toArgb };

// ─── formatação inline (WhatsApp) ───────────────────────────────────────────
// *negrito* _itálico_ ~tachado~ `mono` (+ ** __ ~~). Spans em índices UTF-16
// (NSString e java.lang.String usam o mesmo). flags: 1 bold 2 italic 4 strike
// 8 mono 16 link 32 mention 64 hashtag.
const F_BOLD = 1, F_ITAL = 2, F_STRIKE = 4, F_MONO = 8, F_LINK = 16, F_MENTION = 32, F_HASH = 64;
const _INLINE_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|`[^`\n]+`)/g;
export function parseInline(text) {
  const src = String(text || '');
  const spans = [];
  if (src.indexOf('*') < 0 && src.indexOf('_') < 0 && src.indexOf('~') < 0 && src.indexOf('`') < 0) {
    return { text: src, spans };
  }
  let out = '';
  let last = 0;
  _INLINE_RE.lastIndex = 0;
  let m;
  while ((m = _INLINE_RE.exec(src)) !== null) {
    const raw = m[0];
    // Delimitador colado em letra/número (ex.: snake_case, 2*3*4) não formata.
    const before = m.index > 0 ? src[m.index - 1] : '';
    const after = src[m.index + raw.length] || '';
    if ((before && /[\w]/.test(before)) || (after && /[\w]/.test(after))) continue;
    out += src.slice(last, m.index);
    let inner; let f;
    if (raw.startsWith('**')) { inner = raw.slice(2, -2); f = F_BOLD; }
    else if (raw.startsWith('__')) { inner = raw.slice(2, -2); f = F_ITAL; }
    else if (raw.startsWith('~~')) { inner = raw.slice(2, -2); f = F_STRIKE; }
    else if (raw[0] === '*') { inner = raw.slice(1, -1); f = F_BOLD; }
    else if (raw[0] === '_') { inner = raw.slice(1, -1); f = F_ITAL; }
    else if (raw[0] === '~') { inner = raw.slice(1, -1); f = F_STRIKE; }
    else { inner = raw.slice(1, -1); f = F_MONO; }
    if (!inner.trim()) { out += raw; last = m.index + raw.length; continue; }
    spans.push([out.length, out.length + inner.length, f]);
    out += inner;
    last = m.index + raw.length;
  }
  out += src.slice(last);
  return { text: out, spans };
}

const _URL_RE = /(https?:\/\/[^\s<]+)/g;
const _MENTION_RE = /@([\w.\-]+(?:@[\w.\-]+\.\w+)?)/g;
const _HASH_RE = /(?:^|\s)(#[\wÀ-ſ]{2,30})/g;
function _addRichSpans(text, spans) {
  let m;
  _URL_RE.lastIndex = 0;
  while ((m = _URL_RE.exec(text)) !== null) {
    let u = m[0].replace(/[),.;:!?]+$/, '');
    spans.push([m.index, m.index + u.length, F_LINK, u]);
  }
  _MENTION_RE.lastIndex = 0;
  while ((m = _MENTION_RE.exec(text)) !== null) {
    const prev = m.index > 0 ? text[m.index - 1] : '';
    if (prev && /[\w.]/.test(prev)) continue;
    spans.push([m.index, m.index + m[0].length, F_MENTION, m[0]]);
  }
  _HASH_RE.lastIndex = 0;
  while ((m = _HASH_RE.exec(text)) !== null) {
    const start = m.index + (m[0].length - m[1].length);
    spans.push([start, start + m[1].length, F_HASH, m[1]]);
  }
}
function _hasRich(text) {
  if (!text) return false;
  _URL_RE.lastIndex = 0; _MENTION_RE.lastIndex = 0; _HASH_RE.lastIndex = 0;
  const r = _URL_RE.test(text) || _MENTION_RE.test(text) || _HASH_RE.test(text);
  _URL_RE.lastIndex = 0; _MENTION_RE.lastIndex = 0; _HASH_RE.lastIndex = 0;
  return r;
}

// ─── [fase 2] texto rico (apiVersion >= 2) ─────────────────────────────────
// Espelha FormattedText/TextWithLinks/_renderBlocks/SmartActions/tradução do
// chat-conversation.js (mesmas regexes, cores e medidas). ctx.p2 = helpers
// vindos da tela (ver _nlCtx.p2).
const F_EMOJI = 128, F_SPOILER = 256, F_CODE = 512;
// = _FORMAT_REGEX do JS sem ``` (blocos de código são tratados por bloco).
const _P2_FMT_RE = /(\|\|[^|\n]+\|\||\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|`[^`\n]+`)/g;
const _P2_URL_RE = /(https?:\/\/[^\s<]+)/g;
const _P2_MENTION_RE = /@([\w.\-]+(?:@[\w.\-]+\.\w+)?)/g;
const _P2_HASH_RE = /(?:^|\s)(#[\wÀ-ſ]{2,30})/g;
const _P2_QUOTE = /^\s*>\s(.*)$/;
const _P2_BULLET = /^(\s*)[-*]\s+(.*)$/;
const _P2_NUM = /^(\s*)(\d+)\.\s+(.*)$/;
const _CODE_INLINE_BG = toArgb('rgba(0,0,0,0.08)');

let _iconsMod = null;
function _icons() {
  if (_iconsMod) return _iconsMod;
  try { _iconsMod = require('../Icons'); } catch { _iconsMod = {}; }
  return _iconsMod;
}
let _nodesMod = null;
function _N() {
  if (_nodesMod) return _nodesMod;
  try { _nodesMod = require('./nativeNodes'); } catch { _nodesMod = null; }
  return _nodesMod;
}

// Trecho sem marcação → texto + emoji customizado (só onde o JS desenha: partes sem formatação).
function _p2Plain(str, out, spans, ctx) {
  const p2 = ctx.p2;
  if (p2 && p2.splitCustomEmoji && str && str.indexOf(':') >= 0) {
    let segs = null;
    try { segs = p2.splitCustomEmoji(str); } catch { segs = null; }
    if (Array.isArray(segs) && (segs.length > 1 || (segs[0] && segs[0].ce))) {
      for (const sg of segs) {
        if (sg && sg.ce) { spans.push([out.s.length, out.s.length + 1, F_EMOJI, String(sg.ce)]); out.s += '￼'; }
        else if (sg && sg.text) out.s += sg.text;
      }
      return;
    }
  }
  out.s += str;
}

function _p2Format(seg, out, spans, ctx) {
  const re = new RegExp(_P2_FMT_RE.source, 'g');
  let last = 0; let m;
  while ((m = re.exec(seg)) !== null) {
    if (m.index > last) _p2Plain(seg.slice(last, m.index), out, spans, ctx);
    const raw = m[0];
    let inner; let f; let col;
    if (raw.startsWith('||')) { inner = raw.slice(2, -2); f = F_SPOILER; }
    else if (raw.startsWith('**')) { inner = raw.slice(2, -2); f = F_BOLD; }
    else if (raw.startsWith('__')) { inner = raw.slice(2, -2); f = F_ITAL; }
    else if (raw.startsWith('~~')) { inner = raw.slice(2, -2); f = F_STRIKE; }
    else if (raw[0] === '*') { inner = raw.slice(1, -1); f = F_BOLD; }
    else if (raw[0] === '_') { inner = raw.slice(1, -1); f = F_ITAL; }
    else if (raw[0] === '~') { inner = raw.slice(1, -1); f = F_STRIKE; }
    else { inner = raw.slice(1, -1); f = F_MONO | F_CODE; col = _CODE_INLINE_BG; }
    const a = out.s.length;
    out.s += inner;
    if (inner.length) spans.push(col != null ? [a, out.s.length, f, null, col] : [a, out.s.length, f]);
    last = m.index + raw.length;
  }
  if (last < seg.length) _p2Plain(seg.slice(last), out, spans, ctx);
}

/** Texto (uma "Text" do JS) → { text, spans } com links/menções reais/#. */
export function richText(src, ctx, item) {
  const s = String(src || '');
  const out = { s: '' };
  const spans = [];
  const links = [];
  _P2_URL_RE.lastIndex = 0;
  let last = 0; let m;
  while ((m = _P2_URL_RE.exec(s)) !== null) {
    if (m.index > last) _p2Format(s.slice(last, m.index), out, spans, ctx);
    const a = out.s.length;
    out.s += m[0];
    spans.push([a, out.s.length, F_LINK, m[0]]);
    links.push([a, out.s.length]);
    last = m.index + m[0].length;
  }
  if (last < s.length) _p2Format(s.slice(last), out, spans, ctx);
  const text = out.s;
  if (_richAllowed()) {
    const inLink = (i) => links.some(([a, b]) => i >= a && i < b);
    const p2 = ctx.p2 || {};
    let mArr = null;
    try { mArr = p2.parseMentions ? p2.parseMentions(item && item.mentions) : null; } catch { mArr = null; }
    _P2_MENTION_RE.lastIndex = 0;
    while ((m = _P2_MENTION_RE.exec(text)) !== null) {
      if (inLink(m.index)) continue;
      const prev = m.index > 0 ? text[m.index - 1] : '';
      if (prev && /[\w.]/.test(prev)) continue;
      // [mention-real] só @ do seletor (msg.mentions) ou usuário conhecido.
      let to = null;
      try { to = p2.resolveMention ? p2.resolveMention(m[1], mArr) : null; } catch { to = null; }
      if (!to) continue;
      spans.push([m.index, m.index + m[0].length, F_MENTION, m[0] + '|' + to]);
    }
    _P2_HASH_RE.lastIndex = 0;
    while ((m = _P2_HASH_RE.exec(text)) !== null) {
      const start = m.index + (m[0].length - m[1].length);
      if (inLink(start)) continue;
      spans.push([start, start + m[1].length, F_HASH, m[1]]);
    }
  }
  return { text, spans };
}

function _bodyNode(src, ctx, item, o) {
  const N = _N();
  const r = richText(src, ctx, item);
  const n = N.text(r.text, { body: 1, ...(o || {}) });
  if (r.spans.length) n.sp = r.spans;
  return n;
}

// Altura estimada de um parágrafo (barra lateral de citação/tradução: o
// motor nativo não estica filhos na altura do irmão).
function _estLines(str, fs, avail) {
  const w = Math.max(40, avail);
  let n = 0;
  for (const ln of String(str || '').split('\n')) n += Math.max(1, Math.ceil((ln.length * fs * 0.52) / w));
  return n;
}

function _contentMax(ctx) {
  const p2 = ctx.p2 || {};
  return Number(p2.contentMax) || 300;
}

/** ``` / citação / lista → nós (null = texto simples). */
function _blocksFor(c, ctx, item, own) {
  const N = _N();
  const p2 = ctx.p2 || {};
  const fs = Number(p2.fontSize) || 16;
  const lh = Number(p2.lineHeight) || 21;
  const textColor = own ? p2.ownText : p2.otherText;
  if (c.indexOf('```') >= 0) {
    const re = /```[\s\S]+?```/g;
    const nodes = [];
    let last = 0; let m;
    const pushText = (t) => { if (t && t.replace(/\n/g, '').length) nodes.push(_bodyNode(t.replace(/^\n+|\n+$/g, ''), ctx, item)); };
    while ((m = re.exec(c)) !== null) {
      pushText(c.slice(last, m.index));
      const inner = m[0].slice(3, -3).replace(/^\n/, '').replace(/\n$/, '');
      nodes.push(N.vstack([
        N.text(inner, { ff: 'mono', fs: 13, lh, c: textColor }),
      ], { bg: p2.codeBlockBg || 'rgba(0,0,0,0.06)', r: 8, p: [6, 10, 6, 10], m: [4, 0, 4, 0], w: -1 }));
      last = m.index + m[0].length;
    }
    pushText(c.slice(last));
    if (nodes.length && nodes[nodes.length - 1].t === 'tx') nodes[nodes.length - 1].mi = 1;
    return nodes;
  }
  if (!(ctx.hasBlockMarkdown && ctx.hasBlockMarkdown(c))) return null;
  const accent = p2.accent || '#25D366';
  const muted = p2.muted || 'rgba(120,120,120,0.9)';
  const avail = _contentMax(ctx);
  const lines = c.split('\n');
  const nodes = lines.map((line) => {
    const q = line.match(_P2_QUOTE);
    if (q) {
      const t = _bodyNode(q[1], ctx, item, { c: muted, fl: 1 });
      const bh = _estLines(q[1], fs, avail - 11) * lh;
      return N.hstack([
        N.spacer({ w: 3, h: bh, r: 2, bg: accent, op: 0.85, m: [0, 8, 0, 0] }),
        t,
      ], { al: 's', m: [1, 0, 1, 0] });
    }
    const b = line.match(_P2_BULLET);
    if (b) {
      return N.hstack([N.text('•', { body: 1, m: [0, 6, 0, 0] }), _bodyNode(b[2], ctx, item, { fl: 1 })], { al: 's', m: [0.5, 0, 0.5, b[1] ? 12 : 0] });
    }
    const n = line.match(_P2_NUM);
    if (n) {
      return N.hstack([N.text(`${n[2]}.`, { body: 1, m: [0, 6, 0, 0] }), _bodyNode(n[3], ctx, item, { fl: 1 })], { al: 's', m: [0.5, 0, 0.5, n[1] ? 12 : 0] });
    }
    if (line === '') return N.text(' ', { body: 1 });
    return _bodyNode(line, ctx, item);
  });
  return nodes;
}

function _smartNodes(c, ctx) {
  const N = _N();
  const p2 = ctx.p2 || {};
  let acts = [];
  try { acts = p2.smartActions ? (p2.smartActions(c) || []) : []; } catch { acts = []; }
  if (!acts.length) return null;
  const prim = p2.primary || '#111111';
  const avail = _contentMax(ctx);
  const rows = [];
  let cur = []; let curW = 0;
  acts.forEach((a, i) => {
    const label = String((a.labelKey && p2.label ? p2.label(a.labelKey, a.label || '') : '') || a.label || '');
    const ic = a.Icon ? N.icon(a.Icon, { s: 12, c: prim }) : null;
    const chip = N.hstack([ic, N.text(label, { fs: 11.5, fw: 600, c: prim, m: [0, 0, 0, ic ? 5 : 0], ml: 1 })], {
      al: 'c', p: [5, 10, 5, 10], r: 14, bg: toArgb(prim + '1a'), bc: toArgb(prim + '40'), bw: 1, a: 'smart:' + i,
    });
    const w = 22 + (ic ? 17 : 0) + label.length * 6.4;
    if (cur.length && curW + 6 + w > avail) { rows.push(cur); cur = []; curW = 0; }
    cur.push(chip); curW += (cur.length > 1 ? 6 : 0) + w;
  });
  if (cur.length) rows.push(cur);
  return N.vstack(rows.map(r => N.hstack(r, { g: 6 })), { g: 6, m: [6, 0, 0, 0] });
}

function _translationNodes(tr, ctx, item, own) {
  const N = _N(); const I = _icons();
  const p2 = ctx.p2 || {};
  const metaC = own ? p2.ownMeta : p2.otherMeta;
  const inkC = own ? p2.ownMeta : p2.otherInk;
  const fs = Number(p2.fontSize) || 16;
  const lh = Number(p2.lineHeight) || 21;
  const inner = [];
  if (tr.loading) {
    inner.push(N.hstack([N.icon(I.IconGlobe, { s: 12, c: metaC }), N.text(p2.label('chatConv.translating', 'Traduzindo...'), { fs: 12, it: 1, c: metaC })], { g: 6, al: 'c' }));
  } else {
    if (!tr._auto) {
      let lab = p2.label('chatConv.translated', 'Traduzido');
      if (tr.sourceLang && tr.targetLang) lab += `  ${String(tr.sourceLang).toUpperCase()} → ${String(tr.targetLang).toUpperCase()}`;
      else if (tr.targetLang) lab += `  → ${String(tr.targetLang).toUpperCase()}`;
      inner.push(N.hstack([N.icon(I.IconGlobe, { s: 11, c: inkC }), N.text(lab.toUpperCase(), { fs: 10, fw: 700, c: inkC, ls: 0.5 })], { g: 5, al: 'c', m: [0, 0, 3, 0] }));
    }
    inner.push(N.text(String(tr.text || ''), { body: 1 }));
    if (tr._auto) {
      const lab = tr._showOriginal ? `(${String(p2.label('chatConv.translated', 'translated')).toLowerCase()})` : '(original)';
      inner.push(N.text(lab, { fs: 11, c: inkC, u: 1, m: [4, 0, 0, 0], a: 'tr:toggle' }));
    }
  }
  if (tr._auto) return N.vstack(inner, { m: [item && item._filtered && item._hidden ? 4 : 0, 0, 0, 0] });
  const avail = _contentMax(ctx) - 18;
  const bh = tr.loading ? 16 : (_estLines(tr.text, fs, avail) * lh + (tr._auto ? 0 : 16));
  return N.hstack([
    N.spacer({ w: 2, h: bh + 16, bg: own ? 'rgba(255,255,255,0.4)' : p2.otherInk }),
    N.vstack(inner, { p: 8, fl: 1 }),
  ], {
    al: 's', m: [6, 0, 0, 0], r: 10, w: -1,
    bg: own ? 'rgba(255,255,255,0.13)' : (p2.isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)'),
  });
}

// Linha de meta do JS p/ mensagem que FALHOU (hora + ⚠ "Tocar para tentar de novo").
function _failMetaNode(item, row, ctx) {
  const N = _N(); const I = _icons();
  const p2 = ctx.p2 || {};
  const metaC = p2.ownMeta;
  const err = p2.errorColor || '#EF4444';
  const kids = [];
  if (row.ed) kids.push(N.text(row.ed, { fs: 11, c: metaC, m: [0, 4, 0, 0], ml: 1 }));
  kids.push(N.text(row.time || '', { fs: 11, c: metaC }));
  kids.push(N.vstack([
    N.icon(I.IconAlertTriangle, { s: 12, c: '#EF4444' }),
    N.text(p2.label('chatConv.tapToRetry', 'Tocar para tentar de novo'), { fs: 11, c: err, m: [2, 0, 0, 0] }),
  ], { al: 'c', m: [0, 0, 0, 2], a: 'retry' }));
  return N.hstack(kids, { al: 'c', jc: 'e', w: -1, m: [2, 0, 0, 0] });
}

function _mentionPillNode(ctx) {
  const N = _N();
  const p2 = ctx.p2 || {};
  const ink = p2.isDark ? '#F5F5F7' : '#111111';
  return N.hstack([
    N.text('@', { fs: 11, fw: 700, c: ink }),
    N.text(p2.label('chat.youWereMentioned', 'Você foi mencionado'), { fs: 11, fw: 700, c: ink }),
  ], { g: 4, al: 'c', p: [3, 8, 3, 8], r: -1, m: [0, 0, 4, 0], bg: p2.isDark ? 'rgba(255,255,255,0.10)' : '#F1F3F5' });
}

function _lockLineNode(label, tint) {
  const N = _N(); const I = _icons();
  return N.hstack([N.icon(I.IconLock, { s: 13, c: tint }), N.text(label, { fs: 14, it: 1, c: tint, fl: 1 })], { g: 6, al: 'c' });
}

/** Extras comuns (fase 2) de qualquer mensagem: fixada/temporária/menção/falha. */
function _p2Common(item, row, ctx, own) {
  const p2 = ctx.p2;
  if (!p2) return;
  try { if (p2.pinnedShown && p2.pinnedShown(item)) row.pin = 1; } catch {}
  try { if (p2.vanishes && p2.vanishes(item)) row.tmr = 1; } catch {}
  try { if (!own && p2.mentionedBg && p2.mentionedBg(item)) row.bbg = toArgb(p2.mentionedBg(item)); } catch {}
  if (own && item._failed) row.op = 0.5;
}

/**
 * Texto (type 'text') na fase 2. Preenche row e devolve true; false = deixa o
 * caminho da fase 1 (não deveria acontecer com api >= 2).
 */
function _p2BuildText(item, row, ctx, own) {
  const N = _N();
  if (!N) return false;
  const p2 = ctx.p2 || {};
  const c = typeof item.content === 'string' ? item.content : '';
  const tr = p2.translation ? p2.translation(item) : null;
  const pre = [];
  const post = [];
  if (!own && p2.mentionsMe && p2.mentionsMe(item)) pre.push(_mentionPillNode(ctx));
  const autoHide = !!(tr && tr._auto && !tr._showOriginal && tr.text);
  let blocks = null;
  let simple = null;
  if (!autoHide) {
    if (c.startsWith('🔒')) {
      blocks = [_lockLineNode(p2.label('chatConv.waitingForMessage', 'Aguardando esta mensagem'), own ? p2.ownMeta : p2.otherMeta)];
    } else {
      const jumbo = !item.reply_to_id && !tr && !row.rp && !row.fwd && ctx.jumbo ? ctx.jumbo(c) : 0;
      if (jumbo && !pre.length) { row.jumbo = jumbo; row.text = c.trim(); return true; }
      blocks = _blocksFor(c, ctx, item, own);
      if (!blocks) simple = richText(c.replace(/\s+$/, ''), ctx, item);
    }
  }
  if (tr) post.push(_translationNodes(tr, ctx, item, own));
  // Cartão de prévia de link: o nativeRowCards.buildCard já pôs em row.post
  // (nó id 'lp'); mesma ordem do JS: tradução → prévia → smart actions.
  if (Array.isArray(row.post) && row.post.length) post.push(...row.post);
  delete row.post;
  const sm = _smartNodes(c, ctx);
  if (sm) post.push(sm);
  const failed = own && !!item._failed;
  if (failed) { post.push(_failMetaNode(item, row, ctx)); delete row.st; }
  if (simple && !pre.length && !post.length) {
    row.text = simple.text;
    if (simple.spans.length) row.sp = simple.spans;
    return true;
  }
  if (simple) {
    row.text = simple.text;
    if (simple.spans.length) row.sp = simple.spans;
    if (pre.length) row.pre = pre;
    if (post.length) { row.post = post; row.mp = failed ? 'none' : 'below'; }
    return true;
  }
  const bl = [...pre, ...(blocks || []), ...post];
  row.bl = bl;
  const lastIsTx = bl.length && bl[bl.length - 1].t === 'tx';
  row.mp = failed ? 'none' : (lastIsTx && !post.length && bl[bl.length - 1].mi ? 'in' : 'below');
  return true;
}

/** Legenda de mídia/arquivo com marcação/links (fase 2). */
function _p2Caption(cap, row, ctx, item) {
  const r = richText(cap, ctx, item);
  row.text = r.text;
  if (r.spans.length) row.sp = r.spans; else delete row.sp;
}

/** Motivo p/ texto ficar no JS na fase 2 ('' = nativo). */
function _p2TextReason(item, ctx) {
  const c = typeof item.content === 'string' ? item.content : '';
  if (!c) return 'text-empty';
  if (c.length > 6000) return 'text-long';
  if (c.trim().startsWith('{')) return 'json';
  if (/^(Chamada de Voz|Videochamada|Voice Call|Video Call)\n/i.test(c)) return 'call-text';
  if (/^[a-z0-9]+\/[a-z0-9\-]+\.gif$/i.test(c.trim()) || /tenor\.com|giphy\.com|\.gif(\?.*)?$/i.test(c.trim())) return 'gif-text';
  if (ctx.isSavedMode && /^##\s+/.test(c)) return 'saved-heading';
  if (item._filtered && item._hidden) return 'filtered';
  return '';
}

let _cardsMod = null;
function _cards() {
  if (_cardsMod) return _cardsMod;
  try { _cardsMod = require('./nativeRowCards'); } catch { _cardsMod = null; }
  if (!_cardsMod || typeof _cardsMod.cardReason !== 'function') _cardsMod = { cardReason: () => null, buildCard: () => false };
  return _cardsMod;
}

// ─── normalização ───────────────────────────────────────────────────────────
const MEDIA_TYPES = new Set(['image', 'video', 'gif']);
const TEXTISH = new Set(['text', '', undefined, null]);
const SUPPORTED_TYPES = new Set(['text', 'image', 'video', 'gif', 'sticker', 'audio', 'voice', 'file', 'system']);

function _isViewOnce(m) { return !!(m && (m.is_view_once || m.isViewOnce || m.view_once)); }
function _fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const mm = Math.floor(s / 60); const ss = s % 60;
  return `${mm}:${ss < 10 ? '0' : ''}${ss}`;
}
function _fmtSize(b) {
  const n = Number(b) || 0;
  if (n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',')} MB`;
}
function _isTmpId(id) { return typeof id === 'string' && id.startsWith('tmp'); }

/**
 * Motivo (string) pelo qual a linha NÃO pode ir pro nativo, ou '' se pode.
 * ctx: ver buildCtx no chat-conversation.js.
 */
export function unsupportedReason(item, ctx) {
  if (!item) return '';
  const tt = item._type;
  // [fase 2] Cartões ricos (enquete, localização, contato, chamada, …) —
  // nativeRowCards decide: null = não é cartão (segue as regras abaixo),
  // '' = suportado, string = motivo p/ ficar no JS.
  if (_api >= 2) {
    const cr = _cards().cardReason(item, ctx);
    if (cr !== null && cr !== undefined) return cr;
  }
  if (tt === 'separator' || tt === 'unread_separator') return '';
  if (tt === 'album') {
    const its = Array.isArray(item._items) ? item._items : [];
    if (!its.length) return 'album-empty';
    for (const c of its) {
      if (!c || _isViewOnce(c) || c._blurred) return 'album-cell';
      if (!MEDIA_TYPES.has(c.type)) return 'album-type';
      if (ctx.isVideoNote && ctx.isVideoNote(c)) return 'album-vnote';
    }
    if (_api < 2 && item.content && typeof item.content === 'string' && _hasRich(item.content) && !_richAllowed()) return 'album-rich';
    return '';
  }
  if (tt) return 'meta:' + tt;
  const type = item.type || 'text';
  if (!SUPPORTED_TYPES.has(type)) return 'type:' + type;
  if (item.deleted_at && !_isViewOnce(item)) return '';
  if (_isViewOnce(item)) return 'view-once';
  if (item._blurred) return 'blurred';
  if (item._filtered && item._hidden) return 'filtered';
  if (item._searchTerm) return 'search';
  // Falhou: o JS tem o fluxo de "tocar p/ reenviar" (fila offline/outbox).
  // Fase 2: nativo chama o MESMO reenvio (_tapRetryFailed/_promptFailedMsg).
  if (item._failed && _api < 2) return 'failed';
  if (item.voicemail) return 'voicemail';
  if (type === 'system') {
    return ctx.systemText && ctx.systemText(item) != null ? '' : 'system-empty';
  }
  if (ctx.isVideoNote && ctx.isVideoNote(item)) return 'video-note';
  const c = typeof item.content === 'string' ? item.content : '';
  if ((TEXTISH.has(item.type) || type === 'text') && _api >= 2) return _p2TextReason(item, ctx);
  if (TEXTISH.has(item.type) || type === 'text') {
    if (!c) return 'text-empty';
    if (c.length > 6000) return 'text-long';
    if (c.startsWith('🔒')) return 'e2e-pending';
    if (c.trim().startsWith('{')) return 'json';
    if (c.indexOf('```') >= 0 || c.indexOf('||') >= 0) return 'code-spoiler';
    if (ctx.hasBlockMarkdown && ctx.hasBlockMarkdown(c)) return 'block-md';
    if (ctx.hasSmartActions && ctx.hasSmartActions(c)) return 'smart-actions';
    if (ctx.hasCustomEmoji && ctx.hasCustomEmoji(c)) return 'custom-emoji';
    if (/^(Chamada de Voz|Videochamada|Voice Call|Video Call)\n/i.test(c)) return 'call-text';
    if (/^[a-z0-9]+\/[a-z0-9\-]+\.gif$/i.test(c.trim()) || /tenor\.com|giphy\.com|\.gif(\?.*)?$/i.test(c.trim())) return 'gif-text';
    if (_hasRich(c) && !_richAllowed()) return 'rich';
    if (ctx.isSavedMode && /^##\s+/.test(c)) return 'saved-heading';
    return '';
  }
  if (MEDIA_TYPES.has(type)) {
    if (!item.file_url && !item._localUri && !item.local_path) return 'media-nourl';
    if (_api < 2 && c && _hasRich(c) && !_richAllowed() && !/^(https?:\/\/|\/?data\/)/i.test(c.trim())) return 'caption-rich';
    return '';
  }
  if (type === 'sticker') return '';
  if (type === 'audio' || type === 'voice') return item.file_url || item._localUri ? '' : 'audio-nourl';
  if (type === 'file') return item.file_url || item._localUri ? '' : 'file-nourl';
  return 'type:' + type;
}

function _caption(m) {
  const c = typeof m.content === 'string' ? m.content.trim() : '';
  if (!c) return '';
  if (c === (m.file_name || '')) return '';
  if (/^https?:\/\//i.test(c) || /^\/?data\//i.test(c) || c.startsWith('{')) return '';
  return c;
}

function _reacts(m, myEmail) {
  if (!Array.isArray(m.reactions) || !m.reactions.length) return undefined;
  const me = String(myEmail || '').toLowerCase();
  const groups = new Map();
  for (const r of m.reactions) {
    const e = r && (r.emoji || r.reaction);
    if (!e) continue;
    const users = typeof r.users === 'string' ? r.users.split(',') : (Array.isArray(r.users) ? r.users : []);
    let g = groups.get(e);
    if (!g) { g = { set: new Set(), count: 0 }; groups.set(e, g); }
    for (const u of users) { const k = String(u || '').toLowerCase(); if (k) g.set.add(k); }
    if (!users.length && Number(r.count) > 0) g.count = Math.max(g.count, Number(r.count));
  }
  const out = [];
  for (const [e, g] of groups) {
    const n = Math.max(g.set.size, g.count);
    if (n <= 0) continue;
    out.push({ e, n, me: g.set.has(me) ? 1 : 0 });
  }
  if (!out.length) return undefined;
  out.sort((a, b) => b.n - a.n);
  return out.slice(0, 4);
}

function _status(m, own) {
  if (!own) return undefined;
  if (m._failed) return -1;
  if (m._pending || m._queued || m.pending_state === 'queued' || _isTmpId(m.id)) return 0;
  const s = m._readStatus;
  return typeof s === 'number' ? s : 1;
}

function _mediaFor(m, ctx) {
  const r = (ctx.resolveMedia && ctx.resolveMedia(m)) || {};
  let w = Number(m.width) || 0; let h = Number(m.height) || 0;
  if (!(w > 0 && h > 0) && r.w > 0 && r.h > 0) { w = r.w; h = r.h; }
  const out = { t: m.type === 'gif' ? 'gif' : m.type, uri: r.uri || '', w: w || 0, h: h || 0 };
  if (r.thumb) out.th = r.thumb;
  if (m.type === 'video') {
    const d = Number(m.duration) || 0;
    if (d > 0) out.dur = _fmtDur(d);
  }
  if (m._uploading || m._compressing) out.up = typeof m._uploadPct === 'number' ? Math.max(0, Math.min(100, Math.round(m._uploadPct))) : -1;
  else if (m._queued && _isTmpId(m.id) && !m._failed) out.up = -1;
  return out;
}

/** Linha → modelo nativo (objeto simples, serializável). null = não suportada. */
export function buildRow(item, key, ctx) {
  const tt = item && item._type;
  if (tt === 'separator') {
    return { k: key, kind: 'date', text: item._label || (ctx.dateLabel ? ctx.dateLabel(item.date) : '') };
  }
  if (tt === 'unread_separator') {
    return { k: key, kind: 'unread', text: ctx.unreadLabel ? ctx.unreadLabel(item._count) : '' };
  }
  const own = String(item.sender_email || '').toLowerCase() === String(ctx.myEmail || '').toLowerCase();
  if (!tt && item.type === 'system') {
    const s = ctx.systemText ? ctx.systemText(item) : null;
    return { k: key, kind: 'system', id: String(item.id ?? ''), text: s || '' };
  }
  const row = {
    k: key,
    kind: 'msg',
    id: String(item.id ?? ''),
    own: own ? 1 : 0,
    first: item._isFirstInGroup === false ? 0 : 1,
    last: item._isLastInGroup === false ? 0 : 1,
    time: ctx.formatTime ? ctx.formatTime(item.created_at) : '',
  };
  const st = _status(item, own);
  if (st !== undefined) row.st = st;
  if (item.starred) row.star = 1;
  if (ctx.selection && ctx.selection.on) row.sel = ctx.selection.has(item) ? 2 : 1;
  if (ctx.isGroup && !own && row.first && item.sender_email) {
    row.name = ctx.senderName ? ctx.senderName(item) : (item.sender_name || String(item.sender_email).split('@')[0]);
    row.nc = toArgb(ctx.senderColor ? ctx.senderColor(item.sender_email) : '#888888');
  }
  if (tt === 'album') {
    const its = item._items || [];
    row.album = its.slice(0, 4).map((c) => {
      const md = _mediaFor(c, ctx);
      md.id = String(c.id ?? '');
      return md;
    });
    if (its.length > 4) { row.more = its.length - 4; row.aids = its.map(c => String(c?.id ?? '')); } // [hero] volta ao último tile
    const cap = _caption(item);
    if (cap && _api >= 2) _p2Caption(cap, row, ctx, item);
    else if (cap) { const p = parseInline(cap); row.text = p.text; if (p.spans.length) row.sp = p.spans; }
    return row;
  }
  const deleted = !!item.deleted_at;
  if (deleted) {
    row.del = 1;
    row.text = ctx.deletedLabel ? ctx.deletedLabel(own) : '';
    return row;
  }
  if (item.forwarded_from && String(item.forwarded_from).toLowerCase() !== String(ctx.myEmail || '').toLowerCase()) {
    row.fwd = ctx.forwardedLabel ? ctx.forwardedLabel(item) : '';
  }
  if (item.reply_to && ctx.describeReply) {
    const rp = ctx.describeReply(item);
    if (rp) {
      row.rp = { id: String((item.reply_to && item.reply_to.id) ?? ''), name: rp.name || '', text: rp.text || '', c: toArgb(rp.color || '#888888') };
      if (rp.thumb) row.rp.th = rp.thumb;
      if (rp.italic) row.rp.it = 1;
    }
  }
  if (item.edited_at) row.ed = ctx.editedLabel ? ctx.editedLabel(item) : '';
  const rx = _reacts(item, ctx.myEmail);
  if (rx) row.rx = rx;
  // [fase 2] cartão rico → row.bl (+ cw/bare/pad/mp); true = pronto.
  if (_api >= 2) _p2Common(item, row, ctx, own);
  if (_api >= 2 && _cards().buildCard(item, row, ctx)) return row;
  const type = item.type || 'text';
  const c = typeof item.content === 'string' ? item.content : '';
  if (type === 'text' && _api >= 2 && _p2BuildText(item, row, ctx, own)) return row;
  if (type === 'text') {
    const jumbo = !row.rp && !row.fwd && ctx.jumbo ? ctx.jumbo(c) : 0;
    if (jumbo) { row.jumbo = jumbo; row.text = c.trim(); return row; }
    const p = parseInline(c.replace(/\s+$/, ''));
    row.text = p.text;
    if (_richAllowed()) _addRichSpans(p.text, p.spans);
    if (p.spans.length) row.sp = p.spans;
    return row;
  }
  if (MEDIA_TYPES.has(type)) {
    row.media = _mediaFor(item, ctx);
    const cap = _caption(item);
    if (cap && _api >= 2) _p2Caption(cap, row, ctx, item);
    else if (cap) {
      const p = parseInline(cap);
      row.text = p.text;
      if (_richAllowed()) _addRichSpans(p.text, p.spans);
      if (p.spans.length) row.sp = p.spans;
    }
    return row;
  }
  if (type === 'sticker') {
    if (item.file_url || /^(https?:\/\/|\/?data\/)/i.test(c)) {
      const r = (ctx.resolveSticker && ctx.resolveSticker(item)) || {};
      row.media = { t: 'sticker', uri: r.uri || '', w: 120, h: 120 };
    } else {
      row.jumbo = 64; row.text = c;
    }
    return row;
  }
  if (type === 'audio' || type === 'voice') {
    const wf = Array.isArray(item.waveform) ? item.waveform : null;
    row.au = {
      d: Math.max(0, Math.round(Number(item.duration) || 0)),
      v: type === 'voice' || /voice|ptt|\.(m4a|aac|ogg|opus)$/i.test(String(item.file_name || item.file_url || '')) ? 1 : 0,
    };
    if (wf && wf.length >= 8) {
      // 40 barras quantizadas 0..100 (JSON pequeno).
      const n = 40; const out = new Array(n);
      for (let i = 0; i < n; i++) {
        const v = Number(wf[Math.floor(i * wf.length / n)]);
        out[i] = Math.round(Math.max(0.08, Math.min(1, Number.isFinite(v) ? v : 0)) * 100);
      }
      row.au.w = out;
    }
    if (!own && ctx.isAudioPlayed && ctx.isAudioPlayed(item)) row.au.p = 1;
    return row;
  }
  if (type === 'file') {
    const name = String(item.file_name || '').trim() || (ctx.fileLabel || 'Arquivo');
    const ext = (name.match(/\.([a-z0-9]{1,5})$/i) || [])[1] || '';
    row.file = { n: name, s: _fmtSize(item.file_size), x: ext.toUpperCase() };
    const cap = _caption(item);
    if (cap && cap !== name && _api >= 2) _p2Caption(cap, row, ctx, item);
    else if (cap && cap !== name) { const p = parseInline(cap); row.text = p.text; if (p.spans.length) row.sp = p.spans; }
    return row;
  }
  return null;
}

// ─── decisão por conversa ───────────────────────────────────────────────────
/**
 * true = usar a lista nativa nesta conversa. Uma vez falso (linha não
 * suportada / erro), fica falso até trocar de conversa — nunca troca de motor
 * de JS → nativo no meio da sessão (só nativo → JS, que é o fallback seguro).
 */
export function useNativeThreadList(conversationId, data, ctx, blockers) {
  const stickyRef = useRef({ cid: null, off: false, reason: '' });
  const [, force] = useState(0);
  const st = stickyRef.current;
  if (st.cid !== conversationId) { st.cid = conversationId; st.off = false; st.reason = ''; }
  const available = isNativeThreadListAvailable();
  let on = available && !st.off && !!conversationId && !blockers;
  // Cache por objeto de linha (as linhas são referencialmente estáveis entre
  // renders) — a tela re-renderiza muito; só linhas novas são checadas.
  const memoRef = useRef({ ctx: null, map: new WeakMap() });
  if (memoRef.current.ctx !== ctx) memoRef.current = { ctx, map: new WeakMap() };
  const memo = memoRef.current.map;
  if (on && Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const it = data[i];
      let why = it && typeof it === 'object' ? memo.get(it) : undefined;
      if (why === undefined) {
        why = unsupportedReason(it, ctx);
        if (it && typeof it === 'object') memo.set(it, why);
      }
      if (why) {
        st.off = true; st.reason = why; on = false;
        if (__DEV__) console.log('[native-list] JS path:', why);
        break;
      }
    }
  }
  const fallback = useCallback((reason) => {
    const s = stickyRef.current;
    if (s.off) return;
    s.off = true; s.reason = String(reason || 'error');
    force(x => x + 1);
  }, []);
  return { on, reason: st.reason, fallback };
}

// ─── componente ─────────────────────────────────────────────────────────────
/**
 * <ChatyyMessageList> — props:
 *   data            linhas em ordem de RENDER (mais antiga → mais nova), as
 *                   mesmas de threadListData
 *   keyOf(item)     chave estável (msgKeyExtractor)
 *   ctx             helpers de normalização (memoizado no chamador)
 *   theme           { ownBubble, otherBubble, ownText, otherText, ownMeta,
 *                     otherMeta, link, read, wall, pillBg, pillText,
 *                     systemText, accent, quoteBg }
 *   fontSize, lineHeight, bubbleRadius, isDark
 *   keyboardDismissMode ('interactive' | 'on-drag' | 'none')
 *   bottomInset     espaço abaixo da última bolha (px)
 *   onRowPress({ item, key, part, url, index }), onRowLongPress({ item, key }),
 *   onSwipeReply({ item, key }), onLoadOlder(), onScroll(syntheticEvent),
 *   onScrollBeginDrag(), onScrollEndDrag(), onViewableItemsChanged({ viewableItems }),
 *   onFallback(reason)
 * ref (subconjunto do FlashList usado pelo threadScroll do chat-conversation):
 *   scrollToEnd({animated}), scrollToIndex({index, viewPosition, animated}),
 *   scrollToOffset({offset, animated}) (só offset 0 = mais nova),
 *   getNativeScrollRef() → { scrollToEnd }, flashKey(key), setAudioState(s)
 */
export const ChatyyMessageList = React.memo(forwardRef(function ChatyyMessageList(props, ref) {
  const {
    data, keyOf, ctx, theme, fontSize = 16, lineHeight = 21, bubbleRadius = 18, isDark = false,
    keyboardDismissMode = 'interactive', bottomInset = 8, topInset = 0,
    onRowPress, onRowLongPress, onSwipeReply, onLoadOlder, onScroll,
    onScrollBeginDrag, onScrollEndDrag, onViewableItemsChanged, onFallback, style,
    stickyDate, ctxMenu, onMenuAction, onReact, onMenuDismiss,
  } = props;
  const Native = _getNativeView();
  const nativeRef = useRef(null);
  const sentRef = useRef({ keys: [], json: new Map(), ctxRev: -1, pending: null });
  const rowCacheRef = useRef(new WeakMap()); // item → { rev, key, row, json }
  const dataRef = useRef(data);
  dataRef.current = data;
  const keyIndexRef = useRef(new Map());
  const readyRef = useRef(false);
  const cbRef = useRef({});
  cbRef.current = { onRowPress, onRowLongPress, onSwipeReply, onLoadOlder, onScroll, onScrollBeginDrag, onScrollEndDrag, onViewableItemsChanged, onFallback, onMenuAction, onReact, onMenuDismiss };
  const failRef = useRef(false);

  const fail = useCallback((reason) => {
    if (failRef.current) return;
    failRef.current = true;
    disableNativeThreadListForSession(reason);
    try { cbRef.current.onFallback && cbRef.current.onFallback(reason); } catch {}
  }, []);

  // ctxRev: qualquer troca de ctx (tema, seleção, idioma) renormaliza tudo.
  const ctxRevRef = useRef({ ctx: null, rev: 0 });
  if (ctxRevRef.current.ctx !== ctx) { ctxRevRef.current = { ctx, rev: ctxRevRef.current.rev + 1 }; }
  const ctxRev = ctxRevRef.current.rev;

  // Diff → nativo. Roda no commit (useEffect) para não bloquear o render.
  useEffect(() => {
    if (!Native || failRef.current) return;
    const view = nativeRef.current;
    if (!view || typeof view.applyRows !== 'function') return;
    const sent = sentRef.current;
    const list = Array.isArray(data) ? data : [];
    const keys = new Array(list.length);
    const upserts = [];
    const nextJson = new Map();
    const idx = new Map();
    const cache = rowCacheRef.current;
    let unsupported = '';
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (!it) { keys[i] = 'null-' + i; continue; }
      let k;
      try { k = keyOf ? keyOf(it) : String(it._key || it.id); } catch { k = 'err-' + i; }
      keys[i] = k;
      idx.set(k, i);
      let ent = cache.get(it);
      if (!ent || ent.rev !== ctxRev || ent.key !== k) {
        let row = null;
        try { row = buildRow(it, k, ctx); } catch (e) { row = null; if (__DEV__) console.warn('[native-list] buildRow', e?.message); }
        if (!row) { unsupported = unsupported || ('build:' + (it.type || it._type || '?')); row = { k, kind: 'system', text: '' }; }
        let json = '';
        try { json = JSON.stringify(row); } catch { json = String(Math.random()); }
        ent = { rev: ctxRev, key: k, row, json };
        cache.set(it, ent);
      }
      nextJson.set(k, ent.json);
      if (sent.json.get(k) !== ent.json) upserts.push(ent.row);
    }
    keyIndexRef.current = idx;
    if (unsupported) { fail(unsupported); return; }
    let orderChanged = keys.length !== sent.keys.length;
    if (!orderChanged) {
      for (let i = 0; i < keys.length; i++) { if (keys[i] !== sent.keys[i]) { orderChanged = true; break; } }
    }
    if (!orderChanged && upserts.length === 0) return;
    const payload = { rows: upserts };
    if (orderChanged) payload.keys = keys;
    // Primeira carga sem animação; depois o nativo anima inserção no fim.
    payload.anim = sent.keys.length > 0 ? 1 : 0;
    sent.keys = keys;
    sent.json = nextJson;
    try {
      const p = view.applyRows(payload);
      if (p && typeof p.catch === 'function') p.catch((e) => fail('apply:' + (e?.message || e)));
    } catch (e) {
      fail('apply-throw:' + (e?.message || e));
    }
  }, [data, ctx, ctxRev, keyOf, Native, fail]);

  // Pronto em até READY_TIMEOUT_MS ou volta pro JS.
  useEffect(() => {
    if (!Native) return undefined;
    _markMounted(true);
    const tm = setTimeout(() => {
      if (!readyRef.current && (dataRef.current || []).length > 0) fail('ready-timeout');
    }, READY_TIMEOUT_MS);
    let sub = null;
    try {
      const { AppState } = require('react-native');
      sub = AppState.addEventListener('change', (s) => { if (s !== 'active') _markMounted(false); else if (nativeRef.current) _markMounted(true); });
    } catch {}
    return () => { clearTimeout(tm); try { sub && sub.remove && sub.remove(); } catch {} _markMounted(false); };
  }, [Native, fail]);

  const itemOf = (key) => {
    const i = keyIndexRef.current.get(key);
    const d = dataRef.current || [];
    return i != null ? d[i] : null;
  };

  const handlers = useMemo(() => ({
    onReady: () => { readyRef.current = true; },
    onNativeError: (e) => { fail('native:' + (e?.nativeEvent?.message || '')); },
    onRowPress: (e) => {
      const ne = e?.nativeEvent || {};
      const item = itemOf(ne.key);
      if (!item) return;
      // [hero] part 'media' traz frame {x,y,w,h,radius} (janela) da miniatura tocada
      const fr = ne.frame && Number(ne.frame.w) > 1 && Number(ne.frame.h) > 1
        ? { x: Number(ne.frame.x) || 0, y: Number(ne.frame.y) || 0, width: Number(ne.frame.w), height: Number(ne.frame.h), radius: Number(ne.frame.radius) || 0 }
        : null;
      try { cbRef.current.onRowPress && cbRef.current.onRowPress({ item, key: ne.key, part: ne.part || 'bubble', url: ne.url || '', index: Number(ne.index) || 0, flags: Number(ne.flags) || 0, frame: fr }); } catch {}
    },
    onRowLongPress: (e) => {
      const ne = e?.nativeEvent || {};
      const item = itemOf(ne.key);
      if (!item) {
        // [native-ctxmenu] o nativo já levantou o balão → devolve
        if (ne.native) { try { const v = nativeRef.current; v && v.dismissContextMenu && v.dismissContextMenu().catch(() => {}); } catch {} }
        return;
      }
      // [fase 2] anchor = snapshot PNG do balão + retângulo na janela (dp) → o
      // MESMO lift overlay JS (MessageLiftOverlay) do caminho FlashList.
      let anchor = null;
      const a = ne.anchor;
      if (a && typeof a === 'object' && a.uri && Number(a.w) > 0 && Number(a.h) > 0) {
        anchor = { uri: String(a.uri), x: Number(a.x) || 0, y: Number(a.y) || 0, w: Number(a.w), h: Number(a.h) };
      }
      try { cbRef.current.onRowLongPress && cbRef.current.onRowLongPress({ item, key: ne.key, index: Number(ne.index) || 0, anchor, native: !!ne.native }); } catch {}
    },
    // [native-ctxmenu] escolhas do menu nativo → handlers do JS
    onMenuAction: (e) => {
      const ne = e?.nativeEvent || {};
      try { cbRef.current.onMenuAction && cbRef.current.onMenuAction({ item: itemOf(ne.key), key: ne.key, messageId: String(ne.messageId || ''), action: String(ne.action || '') }); } catch {}
    },
    onReact: (e) => {
      const ne = e?.nativeEvent || {};
      try { cbRef.current.onReact && cbRef.current.onReact({ item: itemOf(ne.key), key: ne.key, messageId: String(ne.messageId || ''), emoji: String(ne.emoji || '') }); } catch {}
    },
    onMenuDismiss: (e) => {
      const ne = e?.nativeEvent || {};
      try { cbRef.current.onMenuDismiss && cbRef.current.onMenuDismiss({ key: ne.key, reason: String(ne.reason || '') }); } catch {}
    },
    onSwipeReply: (e) => {
      const ne = e?.nativeEvent || {};
      const item = itemOf(ne.key);
      if (!item) return;
      try { cbRef.current.onSwipeReply && cbRef.current.onSwipeReply({ item, key: ne.key }); } catch {}
    },
    onLoadOlder: () => { try { cbRef.current.onLoadOlder && cbRef.current.onLoadOlder(); } catch {} },
    onScrollState: (e) => {
      // Evento sintético no formato que threadScroll.distanceFromLatest e
      // handleFlatListScroll já entendem (layout oldest-first).
      const ne = e?.nativeEvent || {};
      const dist = Math.max(0, Number(ne.dist) || 0);
      const ch = Math.max(0, Number(ne.ch) || 0);
      const vh = Math.max(0, Number(ne.vh) || 0);
      const synthetic = { nativeEvent: { contentOffset: { x: 0, y: Math.max(0, ch - vh - dist) }, contentSize: { width: 0, height: ch }, layoutMeasurement: { width: 0, height: vh } } };
      try { cbRef.current.onScroll && cbRef.current.onScroll(synthetic); } catch {}
    },
    onDragState: (e) => {
      const d = !!(e?.nativeEvent?.dragging);
      try {
        if (d) cbRef.current.onScrollBeginDrag && cbRef.current.onScrollBeginDrag();
        else cbRef.current.onScrollEndDrag && cbRef.current.onScrollEndDrag();
      } catch {}
    },
    onVisible: (e) => {
      const keys = (e?.nativeEvent?.keys) || [];
      if (!keys.length || !cbRef.current.onViewableItemsChanged) return;
      const viewableItems = [];
      for (const k of keys) {
        const i = keyIndexRef.current.get(k);
        if (i == null) continue;
        const item = (dataRef.current || [])[i];
        if (item) viewableItems.push({ item, index: i, key: k, isViewable: true });
      }
      if (!viewableItems.length) return;
      try { cbRef.current.onViewableItemsChanged({ viewableItems, changed: [] }); } catch {}
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [fail]);

  useImperativeHandle(ref, () => {
    const call = (fn, ...args) => {
      const v = nativeRef.current;
      if (!v || typeof v[fn] !== 'function') return null;
      try {
        const p = v[fn](...args);
        if (p && typeof p.catch === 'function') p.catch(() => {});
        return p;
      } catch { return null; }
    };
    const api = {
      __nativeThreadList: true,
      scrollToEnd: ({ animated = true } = {}) => { call('scrollToLatest', !!animated); },
      scrollToOffset: ({ offset = 0, animated = true } = {}) => { if (!offset) call('scrollToLatest', !!animated); },
      scrollToIndex: ({ index, viewPosition = 0.5, animated = true } = {}) => {
        const d = dataRef.current || [];
        const it = d[index];
        if (!it) return Promise.resolve();
        let k; try { k = keyOf ? keyOf(it) : String(it._key || it.id); } catch { return Promise.resolve(); }
        call('scrollToKey', k, Number(viewPosition) || 0, !!animated);
        return Promise.resolve();
      },
      getNativeScrollRef: () => ({
        scrollToEnd: ({ animated = true } = {}) => { call('scrollToLatest', !!animated); },
      }),
      flashKey: (k) => { if (k) call('flashKey', String(k)); },
      // [fase 2] esconde o balão enquanto o overlay do lift mostra o snapshot ('' restaura).
      setLiftedKey: (k) => { if (_api >= 2) call('setLiftedKey', String(k || '')); },
      // [native-ctxmenu] Promise<boolean> (false = não abriu → caminho JS)
      showContextMenu: (payload) => {
        if (_api < 3) return Promise.resolve(false);
        const p = call('showContextMenu', payload || {});
        return p && typeof p.then === 'function' ? p.then(v => !!v, () => false) : Promise.resolve(false);
      },
      dismissContextMenu: () => { if (_api >= 3) call('dismissContextMenu'); },
      // [hero] Promise<{x,y,width,height,radius}|null> da miniatura da mensagem (janela)
      mediaFrame: (mid) => {
        if (_api < 3 || mid == null) return Promise.resolve(null);
        const p = call('mediaFrame', String(mid));
        if (!p || typeof p.then !== 'function') return Promise.resolve(null);
        return p.then((f) => (f && Number(f.w) > 1 && Number(f.h) > 1
          ? { x: Number(f.x) || 0, y: Number(f.y) || 0, width: Number(f.w), height: Number(f.h), radius: Number(f.radius) || 0 }
          : null), () => null);
      },
      setAudioState: (s) => { call('setAudioState', s || {}); },
      computeVisibleIndices: () => null,
    };
    return api;
  }, [keyOf]);

  const nativeTheme = useMemo(() => {
    const th = theme || {};
    const o = {};
    for (const k of Object.keys(th)) o[k] = toArgb(th[k]);
    return o;
  }, [theme]);

  // [fase 2] pílula de data fixa NATIVA (cores → ARGB).
  const nativeSticky = useMemo(() => {
    if (!stickyDate || _api < 2) return undefined;
    const o = { on: stickyDate.on ? 1 : 0, top: Number(stickyDate.top) || 0 };
    if (stickyDate.bg != null) o.bg = toArgb(stickyDate.bg);
    if (stickyDate.fg != null) o.fg = toArgb(stickyDate.fg);
    if (stickyDate.shadow != null) o.shadow = stickyDate.shadow ? 1 : 0;
    return o;
  }, [stickyDate]);

  if (!Native) return null;
  return (
    <Native
      ref={nativeRef}
      style={style || styles.fill}
      theme={nativeTheme}
      fontSize={fontSize}
      lineHeight={lineHeight}
      bubbleRadius={bubbleRadius}
      dark={!!isDark}
      keyboardDismissMode={keyboardDismissMode}
      bottomInset={bottomInset}
      topInset={topInset}
      {...(nativeSticky ? { stickyDate: nativeSticky } : null)}
      {...(_api >= 3 ? { ctxMenu: !!ctxMenu && _ctxMenuSwitchOn() } : null)}
      {...handlers}
    />
  );
}));

const styles = StyleSheet.create({ fill: { flex: 1 } });

export default ChatyyMessageList;
