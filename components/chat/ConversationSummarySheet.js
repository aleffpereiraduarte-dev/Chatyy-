// ConversationSummarySheet — "Resumir com a Bia" (2026-10-13 bia-summary).
//
// Substitui a folha inline "Resumo da conversa" de app/chat-conversation.js
// (e o pill de não lidas, que abria components/chat/AISummarizeModal).
//
// Bug antigo (print do founder, iPhone): o texto do resumo aparecia POR CIMA
// do título/subtítulo. A folha antiga era um Fragment solto (cabeçalho +
// ScrollView irmãos, sem flex:1/minHeight:0 no ScrollView) entregue ao sheet
// nativo do sistema; o cabeçalho tinha fundo rgba(17,17,17,0.08–0.12) — no
// escuro é praticamente transparente — e não fica por cima de nada (sem
// zIndex/fundo sólido). Quando o formSheet troca de detent (0.6 → 1) o Yoga
// recalcula o ScrollView sem limite e a rolagem/conteúdo passa por trás do
// cabeçalho transparente. Aqui: coluna explícita
//   [cabeçalho fixo, fundo SÓLIDO, zIndex] / [ScrollView flex:1 minHeight:0,
//   contentInsetAdjustmentBehavior="never"] / [rodapé fixo]
// e o mesmo corpo é usado no sheet nativo (iOS/Android) e no Modal (web).
//
// Servidor:
//   NOVO  chat_ai_digest → JSON estruturado (format 'v2'): summary, topics[],
//         decisions[], todos[{text,who,when,refs}], dates[], open_questions[],
//         mentions_me, tone, refs = ids de mensagens; + modo pergunta (question).
//   VELHO (sem chat_ai_digest → "Unknown chat action") → cai no ai_summarize
//         (texto livre) com as mensagens locais e faz parse best-effort dos
//         rótulos ("Resumo curto:", "Principais tópicos", "Decisões…") em seções,
//         descartando "Nenhuma decisão…". Perguntar fica indisponível.
// Privacidade: nada de conteúdo de mensagem em log (nem console).
//
// v2 (2026-10-13 bia-summary-v2): modos no topo — "Resumo" (padrão: RESUMO DE
// VERDADE em texto corrido, Curto/Detalhado, "Ouvir" com expo-speech) e
// "Tópicos" (o estruturado acima; em grupos, "Por pessoa"). Com não lidas o
// alcance padrão é Não lidas ("Enquanto você estava fora…"). Servidor v2
// (/root/resumo-ia-v2-servidor.sh) devolve `prose`/`by_person`; servidor v1
// (sem prose) → texto corrido montado de summary + decisões + pendências.
// Feedback (polegares SVG): servidor v2 grava só o voto; senão log local.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, Easing, Modal, Platform, Pressable, ScrollView, Share, StyleSheet,
  Text, TextInput, TouchableOpacity, View, useWindowDimensions,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  IconX, IconCopy, IconShare, IconRefresh, IconArrowRight, IconCheck, IconAlertCircle,
  IconCalendar, IconAtSign, IconHelpCircle, IconMessageSquare, IconCheckCircle, IconSend,
  IconPlay, IconPause, IconUsers,
} from '../Icons';
import SegmentedControl from '../ui/SegmentedControl';
import { USE_NATIVE_SHEETS, NativeSheet, runAfterNativeSheet } from '../NativeSheet';
import { Shimmer } from '../SkeletonLoader';
import FadeSlideIn from '../FadeSlideIn';
import PressableScale from '../PressableScale';
import SheetKeyboardAvoider from './SheetKeyboardAvoider';
import { useLanguageOptional } from '../../context/LanguageContext';
import { isReduceMotionEnabled } from '../reducedMotion';

export const BIA_NAME = 'Bia';
export const SUMMARY_UNREAD_CHIP_MIN = 30;

// Cache de sessão (reabrir = instantâneo). Chave: conversa|alcance|última msg.
const _memo = new Map();
const MEMO_MAX = 30;
function memoSet(k, v) {
  if (_memo.size >= MEMO_MAX) { try { _memo.delete(_memo.keys().next().value); } catch {} }
  _memo.set(k, v);
}

// ───────────────────────────── helpers ─────────────────────────────

function tr(t, key, fallback, vars) {
  let s = '';
  try { s = t ? t(key) : ''; } catch {}
  if (!s || s === key) s = fallback;
  if (vars) Object.keys(vars).forEach((k) => { s = s.split('{' + k + '}').join(String(vars[k])); });
  return s;
}

export function parseMsgTime(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) { const n = Number(s); return n < 1e12 ? n * 1000 : n; }
  let ms = NaN;
  if (/(Z|[+-]\d\d(:?\d\d)?)$/i.test(s)) ms = Date.parse(s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
  else ms = Date.parse(s.replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? ms : 0;
}

function hhmm(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function dayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayLabel(ms, t) {
  const today = dayStart(Date.now());
  const ds = dayStart(ms);
  if (ds === today) return tr(t, 'chatSum.todayLower', 'hoje');
  if (ds === today - 86400000) return tr(t, 'chatSum.yesterday', 'ontem');
  const d = new Date(ms);
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
}
export function formatPeriod(fromMs, toMs, t) {
  if (!fromMs || !toMs) return '';
  if (dayStart(fromMs) === dayStart(toMs)) {
    const a = hhmm(fromMs); const b = hhmm(toMs);
    return dayLabel(fromMs, t) + ' ' + (a === b ? a : a + '–' + b);
  }
  return dayLabel(fromMs, t) + ' ' + hhmm(fromMs) + ' – ' + dayLabel(toMs, t) + ' ' + hhmm(toMs);
}

const MEDIA_LABEL = {
  image: '[foto]', photo: '[foto]', video: '[vídeo]', audio: '[áudio]', voice: '[áudio]',
  file: '[arquivo]', document: '[arquivo]', location: '[localização]', contact: '[contato]', poll: '[enquete]',
};
const SKIP_TYPES = new Set(['system', 'sticker', 'gif', 'call', 'call_log', 'reaction', 'e2ee', 'deleted']);
const LAUGH_RE = /^\s*(k{3,}|(ha|he|hi|hu|ah|eh){2,}h?|(rs)+|(ja|je){2,}|lol|lmao|xd|[\s!?.]*)\s*$/i;

// Itens locais (já decifrados) p/ o servidor velho e p/ conversas E2EE.
export function buildLocalItems(messages, { range, currentEmail, meLabel, firstUnreadId, unreadCount }) {
  let list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  list = list.filter((m) => !m._pending && !m.deleted_at && !m.is_deleted);
  if (range === 'unread') {
    const fu = Number(firstUnreadId) || 0;
    if (fu > 0) list = list.filter((m) => Number(m.id) >= fu);
    else if (unreadCount > 0) list = list.slice(-Math.min(300, unreadCount));
  } else if (range === 'today') {
    const t0 = dayStart(Date.now());
    list = list.filter((m) => parseMsgTime(m.created_at) >= t0);
  }
  const cap = range === 'last300' ? 300 : (range === 'last100' || range === 'recent') ? 100 : 300;
  list = list.slice(-cap);
  const out = [];
  for (const m of list) {
    const type = String(m.type || 'text');
    if (SKIP_TYPES.has(type)) continue;
    let content = typeof m.content === 'string' ? m.content : '';
    if (content.startsWith('🔒') || content.startsWith('{"e2e"')) continue;
    if (type !== 'text') {
      const label = MEDIA_LABEL[type] || '[' + type + ']';
      const tx = typeof m.transcript === 'string' ? m.transcript : (typeof m.transcription === 'string' ? m.transcription : '');
      const caption = (type === 'image' || type === 'video') && content && !/^https?:\/\//i.test(content) && !content.startsWith('{') ? content : '';
      content = (label + ' ' + (tx || caption)).trim();
    } else if (!content.trim() || LAUGH_RE.test(content)) {
      continue;
    }
    const mine = !!currentEmail && String(m.sender_email || '').toLowerCase() === String(currentEmail).toLowerCase();
    out.push({
      id: m.id,
      sender: mine ? meLabel : (m.sender_name || String(m.sender_email || '').split('@')[0] || '?'),
      me: mine,
      content: content.slice(0, 500),
      type,
      at: parseMsgTime(m.created_at) || undefined,
    });
  }
  return out;
}

// "Nenhuma decisão…" / "None" e afins = ruído.
const NOISE_RE = /^(nenhum[a]?\b|n[ãa]o (houve|h[áa]|foi|foram)\b|sem (decis|a[çc][õo]|pend|pergunt|datas)|n\/?a\.?$|none\b|no (decision|action|question|date|task)s?\b|nothing\b|-+$)/i;

function cleanText(s) {
  return String(s || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normItem(it) {
  if (it == null) return null;
  if (typeof it === 'string' || typeof it === 'number') {
    const text = cleanText(it);
    return text && !NOISE_RE.test(text) ? { text, who: '', when: '', refs: [] } : null;
  }
  if (typeof it !== 'object') return null;
  const text = cleanText(it.text || it.title || it.item || it.question || it.task || it.what || '');
  if (!text || NOISE_RE.test(text)) return null;
  const rawRefs = it.refs || it.message_ids || it.ids || (it.ref != null ? [it.ref] : (it.message_id != null ? [it.message_id] : []));
  const refs = (Array.isArray(rawRefs) ? rawRefs : [rawRefs]).map((x) => Number(String(x).replace(/^#/, ''))).filter((x) => Number.isFinite(x) && x > 0).slice(0, 3);
  return {
    text,
    who: cleanText(it.who || it.owner || it.assignee || ''),
    when: cleanText(it.when || it.due || it.date || ''),
    refs,
  };
}
function normList(arr, max = 8) {
  if (!Array.isArray(arr)) return [];
  const out = []; const seen = new Set();
  for (const a of arr) {
    const n = normItem(a);
    if (!n) continue;
    const k = n.text.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

function cleanProse(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .split(/\r?\n\s*\r?\n|\r?\n/)
    .map((p) => p.replace(/^\s*(#{1,6}|[-•*])\s+/, '').replace(/\s+/g, ' ').trim())
    .filter((p) => p && !NOISE_RE.test(p))
    .slice(0, 4)
    .join('\n\n');
}
function normPeople(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    const name = cleanText(x.name || x.who || '');
    const n = normItem(x);
    if (!name || !n) continue;
    out.push({ name, text: n.text, refs: n.refs });
    if (out.length >= 10) break;
  }
  return out;
}

// [2026-10-13] Servidor antigo/IA cortada devolvia o JSON CRU como texto do resumo
// ('{"summary": …, "topics": [ …' cortado). Nunca mostrar isso: tenta ler o JSON,
// senão resgata os campos de texto; se nada servir, vira vazio (tela de erro/tentar).
const _JSONISH_RE = /^\s*[{[]|"(summary|prose|topics|decisions)"\s*:/;
function _salvageJsonText(s) {
  try { const o = JSON.parse(s); if (o && typeof o === 'object') return { obj: o }; } catch {}
  for (const k of ['prose', 'summary']) {
    const m = s.match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)'));
    if (m) {
      let v = m[1];
      try { v = JSON.parse('"' + v + '"'); } catch { v = v.replace(/\\"/g, '"').replace(/\\n/g, '\n'); }
      if (v && v.trim().length >= 20) return { text: v.trim() };
    }
  }
  return {};
}

export function normalizeDigest(d) {
  if (!d || typeof d !== 'object') return null;
  for (const key of ['prose', 'summary']) {
    const raw = d[key];
    if (typeof raw === 'string' && _JSONISH_RE.test(raw)) {
      const sv = _salvageJsonText(raw);
      if (sv.obj && !sv.obj.__nested) return normalizeDigest({ ...d, ...sv.obj, __nested: true, prose: sv.obj.prose ?? (key === 'prose' ? '' : d.prose), summary: sv.obj.summary ?? (key === 'summary' ? '' : d.summary) });
      d = { ...d, [key]: sv.text || '' };
    }
  }
  const summary = cleanText(d.summary || d.tldr || '');
  const out = {
    summary: summary && !NOISE_RE.test(summary) ? summary : '',
    topics: normList(d.topics),
    decisions: normList(d.decisions),
    todos: normList(d.todos || d.action_items || d.tasks),
    dates: normList(d.dates || d.dates_places || d.events),
    questions: normList(d.open_questions || d.questions),
    prose: cleanProse(d.prose),
    byPerson: normPeople(d.by_person),
    hasProse: typeof d.prose === 'string' && !!cleanProse(d.prose),
    serverV2: d.mode !== undefined || d.prose !== undefined,
    mentionsMe: !!d.mentions_me,
    tone: cleanText(d.tone || ''),
    count: parseInt(d.message_count || d.count || 0, 10) || 0,
    participants: Array.isArray(d.participants) ? d.participants.length : 0,
    fromMs: parseMsgTime(d.first_at),
    toMs: parseMsgTime(d.last_at),
    legacy: false,
  };
  return out;
}

// Servidor velho: texto livre com rótulos → seções.
const LABELS = [
  ['summary', /^(resumo( curto| geral)?|em resumo|tl;?\s*dr|dr|summary|short summary|in short|resumen|r[ée]sum[ée])\b/i],
  ['topics', /^((principais )?t[óo]picos( principais)?|assuntos|temas|topics|main topics|key points|pontos principais)\b/i],
  ['decisions', /^(decis[õo]es( ou a[çc][õo]es( acordadas)?)?|a[çc][õo]es acordadas|acordos|decisions|agreements)\b/i],
  ['todos', /^(pend[êe]ncias|pr[óo]ximos passos|para fazer|a fazer|tarefas|a[çc][õo]es|to-?dos?|action items|next steps|tasks)\b/i],
  ['dates', /^(datas( e lugares)?|datas e locais|lugares|dates|events|eventos)\b/i],
  ['questions', /^(perguntas( sem resposta| em aberto| abertas)?|d[úu]vidas|open questions|questions)\b/i],
];
export function parseLegacySummary(text) {
  const sec = { summary: [], topics: [], decisions: [], todos: [], dates: [], questions: [] };
  let cur = null;
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    let ln = raw.trim();
    if (!ln) continue;
    const isBullet = /^([-•*·]|\d+[.)])\s+/.test(ln);
    ln = ln.replace(/^([-•*·]|\d+[.)])\s+/, '').replace(/^#{1,6}\s*/, '');
    const plain = cleanText(ln);
    let matched = null;
    for (const [key, re] of LABELS) {
      const m = plain.match(re);
      if (m) {
        const rest = plain.slice(m[0].length).replace(/^[\s:–—-]+/, '').trim();
        // Rótulo só vale se for cabeçalho ("Tópicos:") ou "Rótulo: conteúdo".
        if (!rest || /^[^:]{0,40}:/.test(plain)) { matched = { key, rest }; }
        break;
      }
    }
    if (matched) {
      cur = matched.key;
      if (matched.rest) sec[cur].push(matched.rest);
      continue;
    }
    if (!cur) cur = isBullet ? 'topics' : 'summary';
    sec[cur].push(plain);
  }
  const summary = sec.summary.filter((s) => !NOISE_RE.test(s)).join(' ').trim();
  const d = normalizeDigest({
    summary,
    topics: sec.topics, decisions: sec.decisions, todos: sec.todos, dates: sec.dates, open_questions: sec.questions,
  });
  if (d && !d.summary && d.topics.length) { d.summary = d.topics[0].text; d.topics = d.topics.slice(1); }
  if (d) d.legacy = true;
  return d;
}

function isUnknownAction(r, e) {
  const msg = String((r && (r.message || r.error)) || (e && e.message) || '');
  return /unknown (chat )?action|a[çc][ãa]o desconhecida|not implemented|404/i.test(msg);
}

export function digestToText(d, t, title) {
  if (!d) return '';
  const parts = [];
  if (title) parts.push(title);
  if (d.summary) parts.push(d.summary);
  const sec = (label, list, fmt) => {
    if (!list || !list.length) return;
    parts.push('\n' + label + '\n' + list.map((x) => '• ' + fmt(x)).join('\n'));
  };
  const plain = (x) => x.text;
  sec(tr(t, 'chatSum.topics', 'Tópicos'), d.topics, plain);
  sec(tr(t, 'chatSum.decisions', 'Decisões'), d.decisions, plain);
  sec(tr(t, 'chatSum.todos', 'Para fazer'), d.todos, (x) => x.text + ((x.who || x.when) ? ' (' + [x.who, x.when].filter(Boolean).join(' · ') + ')' : ''));
  sec(tr(t, 'chatSum.dates', 'Datas e lugares'), d.dates, (x) => x.text + (x.when ? ' (' + x.when + ')' : ''));
  sec(tr(t, 'chatSum.questions', 'Perguntas sem resposta'), d.questions, (x) => x.text + (x.who ? ' (' + x.who + ')' : ''));
  return parts.join('\n').trim();
}

// Pendência pedida AO usuário ("você", "eu", primeiro nome dele).
function isMeWho(who, myName) {
  const w = String(who || '').trim().toLowerCase();
  if (!w) return false;
  if (/^(voc[êe]|vc|eu|me|you|t[úu]|vous|du|sie)$/.test(w)) return true;
  const first = String(myName || '').trim().split(/\s+/)[0].toLowerCase();
  return !!first && first.length > 1 && w.split(/[\s,]+/)[0] === first;
}

function endDot(s) { const x = String(s || '').trim(); return !x ? '' : (/[.!?…]$/.test(x) ? x : x + '.'); }
function joinItems(list, fmt) { return list.map(fmt).join('; '); }

// Servidor sem `prose` (v1/legado): texto corrido montado das seções.
export function composeProse(d, t, { unread = false, length = 'short' } = {}) {
  if (!d) return '';
  const long = length === 'long';
  const who = (x) => x.text + (x.who ? ' (' + x.who + (x.when ? ', ' + x.when : '') + ')' : (x.when ? ' (' + x.when + ')' : ''));
  const p1 = []; const p2 = []; const p3 = [];
  if (d.summary) p1.push(endDot(d.summary));
  else if (d.topics.length) p1.push(endDot(d.topics[0].text));
  const dec = d.decisions.slice(0, long ? 4 : 2);
  const todo = d.todos.slice(0, long ? 4 : 2);
  if (dec.length) p2.push(endDot(tr(t, 'chatSum.proseDecided', 'Ficou combinado: {x}', { x: joinItems(dec, (x) => x.text) })));
  if (todo.length) p2.push(endDot(tr(t, 'chatSum.proseTodo', 'Ficou pendente: {x}', { x: joinItems(todo, who) })));
  if (long) {
    if (d.dates.length) p3.push(endDot(tr(t, 'chatSum.proseDates', 'Marcado: {x}', { x: joinItems(d.dates.slice(0, 3), (x) => x.text + (x.when ? ' (' + x.when + ')' : '')) })));
    if (d.questions.length) p3.push(endDot(tr(t, 'chatSum.proseQuestions', 'Ainda sem resposta: {x}', { x: joinItems(d.questions.slice(0, 3), who) })));
  }
  let paras;
  if (long) paras = [p1.join(' '), p2.join(' '), p3.join(' ')].filter(Boolean);
  else paras = [[...p1, ...p2].join(' ')].filter(Boolean);
  if (!paras.length) return '';
  if (unread) paras[0] = tr(t, 'chatSum.whileAway', 'Enquanto você estava fora…') + ' ' + paras[0];
  return paras.join('\n\n');
}

// Servidor sem `by_person`: 1 linha por participante a partir das mensagens locais.
export function localByPerson(items, meLabel, youLabel) {
  const map = new Map();
  for (const it of items || []) {
    const k = it.me ? '\u0000me' : it.sender;
    const e = map.get(k) || { name: it.me ? youLabel : String(it.sender || '?').split(/\s+/)[0], n: 0, last: null };
    e.n += 1;
    if (it.type === 'text' && it.content && it.content.length >= 8) e.last = it;
    map.set(k, e);
  }
  return [...map.values()].sort((a, b) => b.n - a.n).slice(0, 8).map((e) => ({
    name: e.name,
    text: e.last ? '“' + (e.last.content.length > 110 ? e.last.content.slice(0, 107).trim() + '…' : e.last.content) + '”' : '',
    count: e.n,
    refs: e.last && e.last.id ? [Number(e.last.id)] : [],
  }));
}

// expo-speech só se o módulo nativo existe no binário (requireNativeModule lança
// no Android quando falta) — web usa speechSynthesis.
let _speech;
function getSpeech() {
  if (_speech !== undefined) return _speech;
  _speech = null;
  try {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined' || !window.speechSynthesis) return _speech;
    } else {
      const core = require('expo');
      if (!core || typeof core.requireOptionalNativeModule !== 'function' || !core.requireOptionalNativeModule('ExpoSpeech')) return _speech;
    }
    const m = require('expo-speech');
    if (m && typeof m.speak === 'function') _speech = m;
  } catch { _speech = null; }
  return _speech;
}
// Pedaços curtos (frases agrupadas até ~220 chars): pausar = parar e lembrar o
// pedaço (Speech.pause não existe no Android); continuar = falar dali.
function speechChunks(text) {
  const out = [];
  String(text || '').split(/\n+/).forEach((para) => {
    const sents = para.match(/[^.!?…]+[.!?…]+["”’)]*\s*|[^.!?…]+$/g) || [para];
    let cur = '';
    sents.forEach((x) => {
      if ((cur + x).length > 220 && cur) { out.push(cur.trim()); cur = ''; }
      cur += x;
    });
    if (cur.trim()) out.push(cur.trim());
  });
  return out.filter(Boolean);
}

async function logFeedbackLocal(entry) {
  try {
    const AS = require('@react-native-async-storage/async-storage').default;
    const k = 'bia_summary_feedback_v1';
    let arr = [];
    try { arr = JSON.parse((await AS.getItem(k)) || '[]'); } catch {}
    if (!Array.isArray(arr)) arr = [];
    arr.push(entry);
    await AS.setItem(k, JSON.stringify(arr.slice(-50)));
  } catch {}
}

// ───────────────────────────── visuais ─────────────────────────────

function ThumbGlyph({ size = 18, color, down = false, filled = false }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={down ? { transform: [{ rotate: '180deg' }] } : null}>
      <Path d="M7 10v11H4.5A1.5 1.5 0 0 1 3 19.5v-8A1.5 1.5 0 0 1 4.5 10H7Z" fill={filled ? color : 'none'} stroke={color} strokeWidth={1.7} strokeLinejoin="round" />
      <Path d="M7 10l4.2-7.2a1.9 1.9 0 0 1 3.4 1.5L13.8 9h5.3a2 2 0 0 1 2 2.4l-1.5 7.8a2.2 2.2 0 0 1-2.2 1.8H7" fill={filled ? color : 'none'} stroke={color} strokeWidth={1.7} strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}

// Brilho da Bia: estrela de 4 pontas + estrela menor (SVG, sem emoji).
export function BiaGlyph({ size = 18, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M10 2.5c.5 4.3 2.7 6.5 7 7-4.3.5-6.5 2.7-7 7-.5-4.3-2.7-6.5-7-7 4.3-.5 6.5-2.7 7-7Z" fill={color} />
      <Path d="M18.5 13.5c.25 2.1 1.35 3.2 3.5 3.5-2.15.3-3.25 1.4-3.5 3.5-.3-2.1-1.4-3.2-3.5-3.5 2.1-.3 3.2-1.4 3.5-3.5Z" fill={color} opacity={0.75} />
    </Svg>
  );
}

function PulsingGlyph({ size, color }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (isReduceMotionEnabled()) return undefined;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [v]);
  const scale = v.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.08] });
  const opacity = v.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1] });
  return (
    <Animated.View style={{ transform: [{ scale }], opacity }}>
      <BiaGlyph size={size} color={color} />
    </Animated.View>
  );
}

// "Bia está escrevendo" — três pontos pulsando.
function TypingDots({ color }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (isReduceMotionEnabled()) { v.setValue(1); return undefined; }
    const loop = Animated.loop(Animated.timing(v, { toValue: 3, duration: 1200, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 2 }}>
      {[0, 1, 2].map((i) => (
        <Animated.View key={i} style={{
          width: 4, height: 4, borderRadius: 2, backgroundColor: color,
          opacity: v.interpolate({ inputRange: [0, i, i + 0.5, i + 1, 3], outputRange: [0.25, 0.25, 1, 0.25, 0.25], extrapolate: 'clamp' }),
        }} />
      ))}
    </View>
  );
}

const RANGES = ['unread', 'today', 'last100', 'last300'];
// Preferências da sessão (modo/tamanho lembrados entre aberturas).
const _prefs = { view: 'prose', length: 'short' };

// ───────────────────────────── componente ─────────────────────────────

function ConversationSummarySheetInner({
  visible,
  onClose,
  conversationId,
  messages,
  currentEmail,
  myName,
  unreadCount = 0,
  firstUnreadId = null,
  initialRange = 'auto',
  isGroup = false,
  onJumpToMessage,
  onMarkRead,
  colors: c = {},
  isDark = false,
  t,
}) {
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const lang = useLanguageOptional();
  const locale = (lang && lang.language) || 'pt-BR';

  const C = {
    bg: c.background || (isDark ? '#000' : '#fff'),
    card: c.surface || (isDark ? '#141414' : '#F5F5F7'),
    soft: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.045)',
    softer: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
    text: c.text || (isDark ? '#F5F5F7' : '#111'),
    text2: c.textSecondary || (isDark ? '#A1A1A6' : '#6B6B6F'),
    text3: c.textTertiary || (isDark ? '#6E6E73' : '#9A9AA0'),
    border: c.border || (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'),
    ink: isDark ? '#F5F5F7' : '#111111',
    onInk: isDark ? '#000000' : '#FFFFFF',
  };

  const hasUnread = (Number(unreadCount) || 0) > 0 || !!firstUnreadId;
  const ranges = useMemo(() => RANGES.filter((r) => r !== 'unread' || hasUnread), [hasUnread]);
  // "O que eu perdi": sem alcance explícito ('auto') e com não lidas → Não lidas.
  const wantRange = (!initialRange || initialRange === 'auto') ? (hasUnread ? 'unread' : 'last100') : (initialRange === 'recent' ? 'last100' : initialRange);
  const startRange = ranges.includes(wantRange) ? wantRange : (ranges.includes('last100') ? 'last100' : ranges[0]);

  const [range, setRange] = useState(startRange);
  const [status, setStatus] = useState('loading'); // loading | ready | error | empty
  const [data, setData] = useState(null);
  const [errMsg, setErrMsg] = useState('');
  const [legacy, setLegacy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [question, setQuestion] = useState('');
  const [ask, setAsk] = useState(null); // { q, loading, answer, refs, error }
  const [scrolled, setScrolled] = useState(false);
  const [version, setVersion] = useState(0);
  const [view, setViewState] = useState(_prefs.view); // 'prose' | 'topics'
  const [length, setLengthState] = useState(_prefs.length); // 'short' | 'long'
  const [perPerson, setPerPerson] = useState(false);
  const [speak, setSpeak] = useState('idle'); // idle | playing | paused
  const [vote, setVote] = useState(null); // null | 'up' | 'down'
  const speakRef = useRef({ idx: 0, token: 0, chunks: [] });
  const setView = (v) => { _prefs.view = v; setViewState(v); };
  const setLength = (v) => { _prefs.length = v; setLengthState(v); };
  const reqRef = useRef(0);
  const askReqRef = useRef(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => { if (visible) { setRange(startRange); setAsk(null); setQuestion(''); setPerPerson(false); } }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const meLabel = tr(t, 'chatConv.me', 'Eu');
  const lastId = useMemo(() => {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i--) { const n = Number(list[i] && list[i].id); if (Number.isFinite(n) && n > 0) return n; }
    return 0;
  }, [messages]);

  const localItems = useCallback((r) => buildLocalItems(messagesRef.current, {
    range: r, currentEmail, meLabel, firstUnreadId, unreadCount: Number(unreadCount) || 0,
  }), [currentEmail, meLabel, firstUnreadId, unreadCount]);

  const baseParams = useCallback((r, extra) => {
    const p = {
      conversation_id: conversationId,
      range: r,
      locale,
      me_name: myName || '',
      tz_offset_min: -new Date().getTimezoneOffset(),
      ...extra,
    };
    if (r === 'unread' && firstUnreadId) p.since_message_id = Math.max(0, Number(firstUnreadId) - 1);
    if (r === 'today') p.since_ts = Math.floor(dayStart(Date.now()) / 1000);
    return p;
  }, [conversationId, locale, myName, firstUnreadId]);

  const withLocalPeriod = (d, items) => {
    if (!d) return d;
    if ((!d.fromMs || !d.toMs) && items && items.length) {
      const ts = items.map((x) => x.at).filter(Boolean);
      if (ts.length) { d.fromMs = Math.min(...ts); d.toMs = Math.max(...ts); }
    }
    if (!d.count && items) d.count = items.length;
    return d;
  };

  const load = useCallback(async (r, refresh = false) => {
    const my = ++reqRef.current;
    const pp = perPerson ? 1 : 0;
    const key = conversationId + '|' + r + '|' + lastId + '|' + locale + '|' + length + '|' + pp;
    const v2 = { mode: view === 'prose' ? 'prose' : 'structured', length, per_person: pp };
    if (!refresh && _memo.has(key)) {
      const m = _memo.get(key);
      setData(m.data); setLegacy(m.legacy); setStatus(m.data ? 'ready' : 'empty'); setErrMsg('');
      return;
    }
    setStatus('loading'); setErrMsg(''); setCopied(false);
    const api = require('../../services/api');
    const done = (d, isLegacy) => {
      if (my !== reqRef.current) return;
      const empty = !d || (!d.summary && !d.prose && !d.topics.length && !d.decisions.length && !d.todos.length && !d.dates.length && !d.questions.length);
      setLegacy(!!isLegacy);
      setData(empty ? null : d);
      setStatus(empty ? 'empty' : 'ready');
      setVersion((v) => v + 1);
      memoSet(key, { data: empty ? null : d, legacy: !!isLegacy });
    };
    const fail = (msg) => {
      if (my !== reqRef.current) return;
      setErrMsg(msg || '');
      setStatus('error');
    };

    // 1) Servidor novo
    let res = null; let thrown = null;
    if (typeof api.chatAiDigest === 'function') {
      try {
        res = await api.chatAiDigest(baseParams(r, { ...v2, ...(refresh ? { refresh: 1 } : {}) }));
        if (res && res.success && res.data && res.data.need_messages) {
          // Conversa cifrada (E2EE): o servidor só vê ciphertext → manda o que o app já decifrou.
          const items = localItems(r);
          if (!items.length) { done(null, false); return; }
          res = await api.chatAiDigest(baseParams(r, { ...v2, messages: items, ...(refresh ? { refresh: 1 } : {}) }));
        }
      } catch (e) { thrown = e; }
    }
    if (my !== reqRef.current) return;
    if (res && res.success && res.data && res.data.format === 'v2') {
      if (res.data.empty) { done(null, false); return; }
      done(normalizeDigest(res.data), false);
      return;
    }
    if (res && res.success && res.data && typeof res.data.summary === 'string' && !res.data.format) {
      done(withLocalPeriod(parseLegacySummary(res.data.summary), localItems(r)), true);
      return;
    }
    const unknown = !res || isUnknownAction(res, thrown) || typeof api.chatAiDigest !== 'function';
    if (!unknown) { fail((res && res.message) || (thrown && thrown.message) || ''); return; }

    // 2) Servidor velho: ai_summarize (texto livre) com itens locais.
    const items = localItems(r === 'last300' ? 'last100' : r);
    if (items.length < 2) { done(null, true); return; }
    try {
      const r2 = await api.aiSummarize(items.map((x) => ({ sender: x.sender, content: x.content, type: 'text' })));
      if (my !== reqRef.current) return;
      const txt = r2 && r2.data && r2.data.summary;
      if (r2 && r2.success && txt) done(withLocalPeriod(parseLegacySummary(txt), items), true);
      else if (r2 && r2.success) done(null, true);
      else fail(r2 && r2.message);
    } catch (e) { fail(e && e.message); }
  }, [conversationId, lastId, locale, baseParams, localItems, length, perPerson, view]);

  // Trocar Resumo/Tópicos NÃO refaz (a resposta traz os dois); tamanho e "Por pessoa" sim.
  useEffect(() => {
    if (!visible || !conversationId) return;
    load(range, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, range, conversationId, length, perPerson]);

  const sendQuestion = useCallback(async () => {
    const q = question.trim();
    if (!q || legacy) return;
    const my = ++askReqRef.current;
    setAsk({ q, loading: true, answer: '', refs: [], error: '' });
    setQuestion('');
    try {
      const api = require('../../services/api');
      let r = await api.chatAiDigest(baseParams(range, { question: q.slice(0, 300) }));
      if (r && r.success && r.data && r.data.need_messages) {
        r = await api.chatAiDigest(baseParams(range, { question: q.slice(0, 300), messages: localItems(range) }));
      }
      if (my !== askReqRef.current) return;
      if (r && r.success && r.data && (r.data.answer || r.data.answer === '')) {
        const refs = (Array.isArray(r.data.refs) ? r.data.refs : []).map(Number).filter((x, i, arr) => Number.isFinite(x) && x > 0 && arr.indexOf(x) === i).slice(0, 4); // [2026-10-21 polish-conv] sem ids repetidos (chave duplicada)
        setAsk({ q, loading: false, answer: cleanText(r.data.answer) || '—', refs, error: '' });
      } else {
        setAsk({ q, loading: false, answer: '', refs: [], error: (r && r.message) || tr(t, 'chatSum.errorTitle', 'Não foi possível resumir') });
      }
    } catch (e) {
      if (my !== askReqRef.current) return;
      setAsk({ q, loading: false, answer: '', refs: [], error: (e && e.message) || tr(t, 'chatSum.errorTitle', 'Não foi possível resumir') });
    }
  }, [question, legacy, baseParams, range, localItems, t]);

  // ── ações ──
  const title = tr(t, 'chatSum.title', 'Resumo da Bia');
  const youLabel = tr(t, 'chatSum.you', 'Você');
  const proseText = useMemo(() => {
    if (!data) return '';
    return data.prose || composeProse(data, t, { unread: range === 'unread', length });
  }, [data, t, range, length]);
  const showPerPerson = !!isGroup || (!!data && data.participants >= 2);
  const people = useMemo(() => {
    if (!perPerson || !data) return [];
    if (data.byPerson && data.byPerson.length) return data.byPerson;
    return localByPerson(localItems(range), meLabel, youLabel);
  }, [perPerson, data, localItems, range, meLabel, youLabel]);
  const askedOfMe = useMemo(() => (data ? data.todos.filter((x) => isMeWho(x.who, myName)) : []), [data, myName]);
  const topicsText = useMemo(() => {
    let s0 = digestToText(data, t, '');
    if (people.length) s0 += '\n\n' + tr(t, 'chatSum.byPerson', 'Por pessoa') + '\n' + people.map((x) => '• ' + x.name + (x.text ? ': ' + x.text : '')).join('\n');
    return s0.trim();
  }, [data, t, people]);
  const shareText = useMemo(() => {
    if (!data) return '';
    const body0 = view === 'prose' ? proseText : topicsText;
    return body0 ? tr(t, 'chatSum.shareTitle', 'Resumo da conversa') + '\n\n' + body0 : '';
  }, [data, view, proseText, topicsText, t]);
  const speechText = view === 'prose' ? proseText : topicsText.replace(/^• /gm, '');

  // ── Ouvir (expo-speech; voz do idioma do app) ──
  const speechAvail = useMemo(() => !!getSpeech(), []);
  const stopSpeech = useCallback(() => {
    speakRef.current.token += 1;
    try { const S = getSpeech(); if (S) S.stop(); } catch {}
  }, []);
  const speakFrom = (i) => {
    const S = getSpeech();
    const ref = speakRef.current;
    if (!S) { setSpeak('idle'); return; }
    if (i >= ref.chunks.length) { ref.idx = 0; setSpeak('idle'); return; }
    ref.idx = i;
    const my = ++ref.token;
    try {
      // [2026-10-20 call-audio-guard] com ligação ativa a fala usa a sessão PRÓPRIA do sintetizador
      // (useApplicationAudioSession=false) → não mexe na AVAudioSession do CallKit/LiveKit.
      let _ownSession = false;
      try { _ownSession = require('../../services/callAudioGuard').callAudioGuardActive(); } catch {}
      S.speak(ref.chunks[i], {
        ...(_ownSession ? { useApplicationAudioSession: false } : null),
        language: locale,
        onDone: () => { if (my === ref.token) speakFrom(i + 1); },
        onError: () => { if (my === ref.token) { ref.idx = 0; setSpeak('idle'); } },
      });
    } catch { setSpeak('idle'); }
  };
  const toggleSpeak = () => {
    const ref = speakRef.current;
    if (speak === 'playing') { stopSpeech(); setSpeak('paused'); return; }
    if (speak === 'idle') { ref.chunks = speechChunks(speechText); ref.idx = 0; }
    if (!ref.chunks.length) return;
    setSpeak('playing');
    speakFrom(ref.idx);
  };
  useEffect(() => {
    stopSpeech(); speakRef.current.idx = 0; setSpeak('idle');
  }, [speechText, visible, stopSpeech]);
  useEffect(() => () => stopSpeech(), [stopSpeech]);

  // ── Útil? (polegares) ──
  useEffect(() => { setVote(null); }, [version, view]);
  const sendVote = (v) => {
    if (vote === v || !data) return;
    setVote(v);
    const entry = { ts: Date.now(), conversation_id: conversationId, vote: v, range, mode: view === 'prose' ? 'prose' : 'structured', length, last_id: lastId };
    logFeedbackLocal(entry);
    if (data.serverV2) {
      try {
        const api = require('../../services/api');
        const pr = api.chatAiDigest && api.chatAiDigest({ conversation_id: conversationId, feedback: v, range, mode: entry.mode, length, last_id: lastId });
        if (pr && pr.catch) pr.catch(() => {});
      } catch {}
    }
  };

  const doCopy = async () => {
    if (!shareText) return;
    try {
      if (Platform.OS === 'web') await navigator.clipboard?.writeText?.(shareText);
      else { const Clipboard = require('expo-clipboard'); await Clipboard.setStringAsync(shareText); }
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  };
  const doShare = async () => {
    if (!shareText) return;
    try {
      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && navigator.share) { await navigator.share({ text: shareText }); return; }
        await doCopy(); return;
      }
      await Share.share({ message: shareText });
    } catch {}
  };
  const jump = (id) => {
    if (!id || typeof onJumpToMessage !== 'function') return;
    onClose && onClose();
    const go = () => { try { onJumpToMessage(id); } catch {} };
    if (USE_NATIVE_SHEETS && Platform.OS !== 'ios') runAfterNativeSheet(go); else setTimeout(go, 250);
  };

  const msgIndex = useMemo(() => {
    const m = new Map();
    (Array.isArray(messages) ? messages : []).forEach((x) => { if (x && x.id != null) m.set(Number(x.id), x); });
    return m;
  }, [messages]);

  // ── meta ──
  const period = data ? formatPeriod(data.fromMs, data.toMs, t) : '';
  const metaLine = data
    ? [data.count ? tr(t, 'chatSum.metaMessages', '{n} mensagens', { n: data.count }) : '', period].filter(Boolean).join(' · ')
    : tr(t, 'chatSum.menuLabel', 'Resumir com a Bia');

  const rangeLabel = (r) => {
    if (r === 'unread') return tr(t, 'chatSum.rangeUnread', 'Não lidas') + (unreadCount > 0 ? ' · ' + (unreadCount > 999 ? '999+' : unreadCount) : '');
    if (r === 'today') return tr(t, 'chatSum.rangeToday', 'Hoje');
    return tr(t, 'chatSum.rangeLast', 'Últimas {n}', { n: r === 'last300' ? 300 : 100 });
  };

  // ── peças ──
  const renderRefs = (refs) => {
    if (!refs || !refs.length || typeof onJumpToMessage !== 'function') return null;
    return (
      <View style={st.refRow}>
        {refs.map((id) => {
          const m = msgIndex.get(Number(id));
          const ts = m ? parseMsgTime(m.created_at) : 0;
          return (
            <PressableScale key={id} onPress={() => jump(id)} haptic="select" scaleTo={0.95}
              style={[st.refChip, { backgroundColor: C.soft }]}
              accessibilityRole="button" accessibilityLabel={tr(t, 'chatSum.jumpTo', 'Ir para a mensagem')}>
              <IconMessageSquare size={11} color={C.text2} />
              <Text style={[st.refChipText, { color: C.text2 }]}>{ts ? hhmm(ts) : tr(t, 'chatSum.jumpTo', 'Ir para a mensagem')}</Text>
              <IconArrowRight size={11} color={C.text2} />
            </PressableScale>
          );
        })}
      </View>
    );
  };

  const renderSection = (Icon, label, items, kind, delay) => {
    if (!items || !items.length) return null;
    return (
      <FadeSlideIn delay={delay} distance={8}>
        <View style={[st.section, { backgroundColor: C.softer, borderColor: C.border }]}>
          <View style={st.sectionHead}>
            <Icon size={14} color={C.text2} />
            <Text style={[st.sectionLabel, { color: C.text2 }]}>{label}</Text>
          </View>
          {items.map((it, i) => (
            <View key={i} style={[st.itemRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border }]}>
              {kind === 'todo'
                ? <View style={[st.todoBox, { borderColor: C.text3 }]} />
                : <View style={[st.dot, { backgroundColor: C.ink }]} />}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[st.itemText, { color: C.text }]}>{it.text}</Text>
                {(it.who || it.when) ? (
                  <Text style={[st.itemMeta, { color: C.text2 }]}>{[it.who, it.when].filter(Boolean).join(' · ')}</Text>
                ) : null}
                {renderRefs(it.refs)}
              </View>
            </View>
          ))}
        </View>
      </FadeSlideIn>
    );
  };

  const header = (
    <View style={[st.header, { backgroundColor: C.bg, borderBottomColor: scrolled ? C.border : 'transparent' }]}>
      <View style={st.headerRow}>
        <View style={[st.glyphCircle, { backgroundColor: C.ink }]}>
          {status === 'loading' ? <PulsingGlyph size={18} color={C.onInk} /> : <BiaGlyph size={18} color={C.onInk} />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[st.title, { color: C.text }]} numberOfLines={1}>{title}</Text>
          <Text style={[st.meta, { color: C.text2 }]} numberOfLines={1}>
            {status === 'loading' ? tr(t, 'chatSum.loading', 'Bia está lendo a conversa…') : metaLine}
          </Text>
        </View>
        <TouchableOpacity onPress={onClose} hitSlop={10} style={[st.closeBtn, { backgroundColor: C.soft }]}
          accessibilityRole="button" accessibilityLabel={tr(t, 'chatSum.close', 'Fechar')}>
          <IconX size={16} color={C.text} />
        </TouchableOpacity>
      </View>
      <View style={st.modeRow}>
        <SegmentedControl
          size="sm"
          options={[
            { value: 'prose', label: tr(t, 'chatSum.modeProse', 'Resumo') },
            { value: 'topics', label: tr(t, 'chatSum.topics', 'Tópicos') },
          ]}
          value={view}
          onChange={setView}
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.rangeRow} keyboardShouldPersistTaps="handled">
        {ranges.map((r) => {
          const on = r === range;
          return (
            <PressableScale key={r} onPress={() => { if (!on) { setAsk(null); setRange(r); } }} haptic="select" scaleTo={0.95}
              style={[st.rangeChip, on ? { backgroundColor: C.ink, borderColor: C.ink } : { backgroundColor: 'transparent', borderColor: C.border }]}
              accessibilityRole="button" accessibilityState={{ selected: on }}>
              <Text style={[st.rangeText, { color: on ? C.onInk : C.text }]}>{rangeLabel(r)}</Text>
            </PressableScale>
          );
        })}
      </ScrollView>
    </View>
  );

  const proseSkeleton = (
    <View style={{ paddingTop: 2 }}>
      <View style={st.writingRow}>
        <PulsingGlyph size={13} color={C.text2} />
        <Text style={[st.writingText, { color: C.text2 }]}>{tr(t, 'chatSum.writing', 'Bia está escrevendo')}</Text>
        <TypingDots color={C.text2} />
      </View>
      {(length === 'long' ? ['98%', '94%', '97%', '88%', '95%', '60%', '', '96%', '91%', '72%'] : ['98%', '94%', '97%', '90%', '58%']).map((w, i) => (
        w ? <Shimmer key={i} style={{ height: 15, width: w, borderRadius: 7, marginBottom: 11 }} delay={i * 45} />
          : <View key={i} style={{ height: 14 }} />
      ))}
    </View>
  );

  const skeleton = (
    <View style={{ paddingTop: 6 }}>
      <Shimmer style={{ height: 12, width: 90, borderRadius: 6, marginBottom: 14 }} />
      <Shimmer style={{ height: 18, width: '96%', borderRadius: 7, marginBottom: 9 }} delay={40} />
      <Shimmer style={{ height: 18, width: '88%', borderRadius: 7, marginBottom: 9 }} delay={80} />
      <Shimmer style={{ height: 18, width: '62%', borderRadius: 7, marginBottom: 26 }} delay={120} />
      {[0, 1].map((k) => (
        <View key={k} style={[st.section, { backgroundColor: C.softer, borderColor: C.border }]}>
          <Shimmer style={{ height: 11, width: 80, borderRadius: 5, marginBottom: 14 }} delay={160 + k * 60} />
          <Shimmer style={{ height: 14, width: '90%', borderRadius: 6, marginBottom: 10 }} delay={200 + k * 60} />
          <Shimmer style={{ height: 14, width: '74%', borderRadius: 6 }} delay={240 + k * 60} />
        </View>
      ))}
    </View>
  );

  let content;
  if (status === 'loading') content = view === 'prose' ? proseSkeleton : skeleton;
  else if (status === 'error') {
    content = (
      <FadeSlideIn>
        <View style={st.center}>
          <IconAlertCircle size={34} color={C.text3} />
          <Text style={[st.centerTitle, { color: C.text }]}>{tr(t, 'chatSum.errorTitle', 'Não foi possível resumir')}</Text>
          {errMsg ? <Text style={[st.centerSub, { color: C.text2 }]}>{errMsg}</Text> : null}
          <PressableScale onPress={() => load(range, true)} style={[st.pillBtn, { backgroundColor: C.ink }]}>
            <IconRefresh size={14} color={C.onInk} />
            <Text style={[st.pillBtnText, { color: C.onInk }]}>{tr(t, 'chatSum.retry', 'Tentar de novo')}</Text>
          </PressableScale>
        </View>
      </FadeSlideIn>
    );
  } else if (status === 'empty' || !data) {
    content = (
      <FadeSlideIn>
        <View style={st.center}>
          <BiaGlyph size={30} color={C.text3} />
          <Text style={[st.centerSub, { color: C.text2, marginTop: 12 }]}>{tr(t, 'chatSum.empty', 'Nada para resumir aqui ainda.')}</Text>
        </View>
      </FadeSlideIn>
    );
  } else {
    const paragraphs = proseText ? proseText.split(/\n\n+/) : [];
    const lengthToggle = (
      <View style={[st.lenToggle, { backgroundColor: C.soft }]}>
        {['short', 'long'].map((l) => {
          const on = l === length;
          return (
            <PressableScale key={l} onPress={() => { if (!on) setLength(l); }} haptic="select" scaleTo={0.95}
              style={[st.lenOpt, on && { backgroundColor: C.ink }]}
              accessibilityRole="button" accessibilityState={{ selected: on }}>
              <Text style={[st.lenText, { color: on ? C.onInk : C.text2 }]}>
                {l === 'short' ? tr(t, 'chatSum.lenShort', 'Curto') : tr(t, 'chatSum.lenLong', 'Detalhado')}
              </Text>
            </PressableScale>
          );
        })}
      </View>
    );
    const proseBody = (
      <>
        <View style={st.kickerRow}>
          <Text style={[st.kicker, { color: C.text3, marginBottom: 0, flexShrink: 1 }]} numberOfLines={1}>
            {range === 'unread' ? tr(t, 'chatSum.whatYouMissed', 'O que você perdeu') : tr(t, 'chatSum.inShort', 'Em resumo')}
          </Text>
          {lengthToggle}
        </View>
        <FadeSlideIn distance={4} duration={420}>
          {paragraphs.map((para, i) => (
            <Text key={i} style={[st.prose, { color: C.text }, i > 0 && { marginTop: 14 }]} selectable>{para}</Text>
          ))}
        </FadeSlideIn>
        {renderSection(IconAtSign, tr(t, 'chatSum.askedYou', 'Pediram a você'), askedOfMe, 'todo', 120)}
      </>
    );
    const peopleSection = showPerPerson ? (
      <>
        <PressableScale onPress={() => setPerPerson((x) => !x)} haptic="select" scaleTo={0.96}
          style={[st.ppChip, perPerson ? { backgroundColor: C.ink, borderColor: C.ink } : { borderColor: C.border }]}
          accessibilityRole="button" accessibilityState={{ selected: perPerson }}>
          <IconUsers size={13} color={perPerson ? C.onInk : C.text} />
          <Text style={[st.rangeText, { color: perPerson ? C.onInk : C.text }]}>{tr(t, 'chatSum.byPerson', 'Por pessoa')}</Text>
        </PressableScale>
        {perPerson && people.length ? (
          <FadeSlideIn distance={8}>
            <View style={[st.section, { backgroundColor: C.softer, borderColor: C.border }]}>
              <View style={st.sectionHead}>
                <IconUsers size={14} color={C.text2} />
                <Text style={[st.sectionLabel, { color: C.text2 }]}>{tr(t, 'chatSum.byPerson', 'Por pessoa')}</Text>
              </View>
              {people.map((pp, i) => (
                <View key={i} style={[st.itemRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border }]}>
                  <View style={[st.avatar, { backgroundColor: C.soft }]}>
                    <Text style={[st.avatarText, { color: C.text }]}>{(pp.name || '?').slice(0, 1).toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[st.itemText, { color: C.text }]}>
                      <Text style={{ fontWeight: '700' }}>{pp.name}</Text>
                      {pp.text ? '  ' + pp.text : (pp.count ? '  ' + tr(t, 'chatSum.metaMessages', '{n} mensagens', { n: pp.count }) : '')}
                    </Text>
                    {renderRefs(pp.refs)}
                  </View>
                </View>
              ))}
            </View>
          </FadeSlideIn>
        ) : null}
      </>
    ) : null;
    const listenFeedback = (
      <View style={st.lfRow}>
        {speechAvail && speechText ? (
          <PressableScale onPress={toggleSpeak} haptic="light" scaleTo={0.95}
            style={[st.listenBtn, { backgroundColor: speak === 'playing' ? C.ink : C.soft }]}
            accessibilityRole="button"
            accessibilityLabel={speak === 'playing' ? tr(t, 'chatSum.pause', 'Pausar') : tr(t, 'chatSum.listen', 'Ouvir')}>
            {speak === 'playing' ? <IconPause size={13} color={C.onInk} /> : <IconPlay size={13} color={C.text} />}
            <Text style={[st.listenText, { color: speak === 'playing' ? C.onInk : C.text }]}>
              {speak === 'playing' ? tr(t, 'chatSum.pause', 'Pausar') : speak === 'paused' ? tr(t, 'chatSum.resume', 'Continuar') : tr(t, 'chatSum.listen', 'Ouvir')}
            </Text>
          </PressableScale>
        ) : <View />}
        <View style={st.voteWrap}>
          <Text style={[st.voteLabel, { color: C.text3 }]}>
            {vote ? tr(t, 'chatSum.thanks', 'Obrigado') : tr(t, 'chatSum.helpful', 'Útil?')}
          </Text>
          {['up', 'down'].map((v) => (
            <PressableScale key={v} onPress={() => sendVote(v)} haptic="select" scaleTo={0.88}
              style={[st.voteBtn, { backgroundColor: vote === v ? C.soft : 'transparent' }]}
              accessibilityRole="button" accessibilityState={{ selected: vote === v }}
              accessibilityLabel={v === 'up' ? tr(t, 'chatSum.voteUp', 'Foi útil') : tr(t, 'chatSum.voteDown', 'Não foi útil')}>
              <ThumbGlyph size={17} down={v === 'down'} filled={vote === v} color={vote === v ? C.text : C.text2} />
            </PressableScale>
          ))}
        </View>
      </View>
    );
    content = (
      <View key={'v' + version + view}>
        {data.mentionsMe ? (
          <FadeSlideIn distance={6}>
            <View style={[st.mentionPill, { backgroundColor: C.ink }]}>
              <IconAtSign size={12} color={C.onInk} />
              <Text style={[st.mentionText, { color: C.onInk }]}>{tr(t, 'chatSum.mentionsMe', 'Mencionaram você')}</Text>
            </View>
          </FadeSlideIn>
        ) : null}
        {view === 'prose' ? proseBody : null}
        {view !== 'prose' && data.summary ? (
          <FadeSlideIn distance={10}>
            <Text style={[st.kicker, { color: C.text3 }]}>{tr(t, 'chatSum.inShort', 'Em resumo')}</Text>
            <Text style={[st.summary, { color: C.text }]} selectable>{data.summary}</Text>
            {data.tone ? <Text style={[st.tone, { color: C.text2 }]}>{data.tone}</Text> : null}
          </FadeSlideIn>
        ) : null}
        {view !== 'prose' ? (
          <>
            {renderSection(IconCheckCircle, tr(t, 'chatSum.decisions', 'Decisões'), data.decisions, null, 50)}
            {renderSection(IconCheck, tr(t, 'chatSum.todos', 'Para fazer'), data.todos, 'todo', 90)}
            {renderSection(IconMessageSquare, tr(t, 'chatSum.topics', 'Tópicos'), data.topics, null, 130)}
            {renderSection(IconCalendar, tr(t, 'chatSum.dates', 'Datas e lugares'), data.dates, null, 170)}
            {renderSection(IconHelpCircle, tr(t, 'chatSum.questions', 'Perguntas sem resposta'), data.questions, null, 210)}
            {peopleSection}
          </>
        ) : null}
        {ask ? (
          <FadeSlideIn distance={8}>
            <View style={[st.section, { backgroundColor: C.softer, borderColor: C.border }]}>
              <View style={st.sectionHead}>
                <BiaGlyph size={13} color={C.text2} />
                <Text style={[st.sectionLabel, { color: C.text2 }]}>{tr(t, 'chatSum.askLabel', 'Pergunte à Bia')}</Text>
              </View>
              <Text style={[st.askQ, { color: C.text2 }]}>{ask.q}</Text>
              {ask.loading ? (
                <View style={{ marginTop: 8 }}>
                  <Shimmer style={{ height: 14, width: '86%', borderRadius: 6, marginBottom: 8 }} />
                  <Shimmer style={{ height: 14, width: '58%', borderRadius: 6 }} delay={60} />
                </View>
              ) : ask.error ? (
                <Text style={[st.itemText, { color: C.text2, marginTop: 6 }]}>{ask.error}</Text>
              ) : (
                <>
                  <Text style={[st.askA, { color: C.text }]} selectable>{ask.answer}</Text>
                  {renderRefs(ask.refs)}
                </>
              )}
            </View>
          </FadeSlideIn>
        ) : null}
        {listenFeedback}
        <Text style={[st.disclaimer, { color: C.text3 }]}>{tr(t, 'chatSum.disclaimer', 'Feito pela Bia · pode conter erros')}</Text>
      </View>
    );
  }

  const ready = status === 'ready' && !!data;
  const showMarkRead = ready && range === 'unread' && typeof onMarkRead === 'function';
  const bottomPad = Math.max(14, (insets.bottom || 0) + 8);

  const footer = (
    <View style={[st.footer, { backgroundColor: C.bg, borderTopColor: C.border, paddingBottom: bottomPad }]}>
      {ready ? (
        <View style={[st.askRow, { backgroundColor: C.soft }]}>
          <BiaGlyph size={14} color={C.text2} />
          <TextInput
            value={question}
            onChangeText={setQuestion}
            editable={!legacy}
            placeholder={legacy ? tr(t, 'chatSum.askUnavailable', 'Perguntas à Bia chegam em breve.') : tr(t, 'chatSum.askPlaceholder', 'Pergunte algo sobre a conversa')}
            placeholderTextColor={C.text3}
            style={[st.askInput, { color: C.text }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
            returnKeyType="send"
            onSubmitEditing={sendQuestion}
            maxLength={300}
            accessibilityLabel={tr(t, 'chatSum.askLabel', 'Pergunte à Bia')}
          />
          {question.trim() && !legacy ? (
            <PressableScale onPress={sendQuestion} haptic="light" scaleTo={0.9} style={[st.askSend, { backgroundColor: C.ink }]}
              accessibilityRole="button" accessibilityLabel={tr(t, 'chatSum.askLabel', 'Pergunte à Bia')}>
              <IconSend size={14} color={C.onInk} />
            </PressableScale>
          ) : null}
        </View>
      ) : null}
      <View style={st.actions}>
        {ready ? (
          <>
            <IconAction label={copied ? tr(t, 'chatSum.copied', 'Copiado') : tr(t, 'chatSum.copy', 'Copiar')} onPress={doCopy} C={C}>
              {copied ? <IconCheck size={17} color={C.text} /> : <IconCopy size={17} color={C.text} />}
            </IconAction>
            <IconAction label={tr(t, 'chatSum.share', 'Compartilhar')} onPress={doShare} C={C}>
              <IconShare size={17} color={C.text} />
            </IconAction>
            <IconAction label={tr(t, 'chatSum.regenerate', 'Gerar de novo')} onPress={() => { setAsk(null); load(range, true); }} C={C}>
              <IconRefresh size={17} color={C.text} />
            </IconAction>
          </>
        ) : <View style={{ flex: 1 }} />}
        <PressableScale
          onPress={() => { if (showMarkRead) { try { onMarkRead(); } catch {} } onClose && onClose(); }}
          style={[st.primary, { backgroundColor: C.ink }]}
          accessibilityRole="button"
        >
          <Text style={[st.primaryText, { color: C.onInk }]} numberOfLines={1}>
            {showMarkRead ? tr(t, 'chatSum.markRead', 'Marcar como lidas') : tr(t, 'chatSum.done', 'Pronto')}
          </Text>
        </PressableScale>
      </View>
    </View>
  );

  const body = (
    <SheetKeyboardAvoider ios style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={{ zIndex: 2, backgroundColor: C.bg }}>{header}</View>
        <ScrollView
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: 18 }}
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustContentInsets={false}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={32}
          onScroll={(e) => { const y = e.nativeEvent.contentOffset.y; const s = y > 2; if (s !== scrolled) setScrolled(s); }}
        >
          {content}
        </ScrollView>
        {footer}
      </View>
    </SheetKeyboardAvoider>
  );

  if (!visible) return null;

  // [2026-10-13] iOS: o formSheet nativo deslocava o ScrollView (texto começava
  // cortado por baixo dos chips). No iOS usa o painel próprio (Modal), como no web.
  if (USE_NATIVE_SHEETS && Platform.OS !== 'ios') {
    return (
      <NativeSheet visible={!!visible} onClose={onClose} detents={[0.72, 1]} backgroundColor={C.bg}>
        <View style={{ flex: 1, paddingTop: 10, backgroundColor: C.bg }}>{body}</View>
      </NativeSheet>
    );
  }

  const wide = Platform.OS === 'web' && winW >= 768;
  const panelH = Math.round(Math.min(winH * (wide ? 0.82 : 0.86), 780));
  return (
    <Modal visible transparent animationType={wide ? 'fade' : 'slide'} onRequestClose={onClose} statusBarTranslucent>
      <View style={[st.backdrop, wide && { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel={tr(t, 'chatSum.close', 'Fechar')} />
        <View style={[
          st.panel,
          { backgroundColor: C.bg, height: panelH },
          wide ? { width: '100%', maxWidth: 560, borderRadius: 20 } : { borderTopLeftRadius: 22, borderTopRightRadius: 22 },
        ]}>
          {!wide ? <View style={[st.handle, { backgroundColor: C.border }]} /> : <View style={{ height: 12 }} />}
          {body}
        </View>
      </View>
    </Modal>
  );
}

function IconAction({ label, onPress, children, C }) {
  return (
    <PressableScale onPress={onPress} haptic="light" scaleTo={0.92} style={[st.iconAction, { backgroundColor: C.soft }]}
      accessibilityRole="button" accessibilityLabel={label}>
      {children}
      <Text style={[st.iconActionText, { color: C.text2 }]} numberOfLines={1}>{label}</Text>
    </PressableScale>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  panel: {
    overflow: 'hidden',
    ...Platform.select({
      web: { boxShadow: '0 24px 60px rgba(0,0,0,0.3)' },
      default: { shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20, shadowOffset: { width: 0, height: -4 }, elevation: 16 },
    }),
  },
  handle: { width: 36, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 8, marginBottom: 6 },
  header: { paddingTop: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, gap: 12 },
  glyphCircle: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  meta: { fontSize: 12.5, marginTop: 2, fontWeight: '500' },
  closeBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  modeRow: { paddingHorizontal: 20, paddingTop: 12 },
  rangeRow: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 12, gap: 8 },
  kickerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 },
  lenToggle: { flexDirection: 'row', borderRadius: 13, padding: 2 },
  lenOpt: { height: 24, paddingHorizontal: 10, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  lenText: { fontSize: 12, fontWeight: '600' },
  prose: { fontSize: 17, lineHeight: 26, fontWeight: '400', letterSpacing: -0.1 },
  writingRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 16 },
  writingText: { fontSize: 13, fontWeight: '600' },
  ppChip: { flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 12, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, marginTop: 16 },
  avatar: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginTop: -2 },
  avatarText: { fontSize: 12, fontWeight: '700' },
  lfRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20 },
  listenBtn: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 34, paddingHorizontal: 14, borderRadius: 17 },
  listenText: { fontSize: 13.5, fontWeight: '600' },
  voteWrap: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  voteLabel: { fontSize: 12.5, fontWeight: '500', marginRight: 4 },
  voteBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  rangeChip: { height: 30, paddingHorizontal: 13, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  rangeText: { fontSize: 13, fontWeight: '600' },
  kicker: { fontSize: 11.5, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 8 },
  summary: { fontSize: 18, lineHeight: 26, fontWeight: '500', letterSpacing: -0.2 },
  tone: { fontSize: 13, marginTop: 8, fontStyle: 'italic' },
  section: { marginTop: 16, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 4 },
  sectionLabel: { fontSize: 11.5, fontWeight: '700', letterSpacing: 0.7, textTransform: 'uppercase' },
  itemRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 9, gap: 11 },
  dot: { width: 5, height: 5, borderRadius: 2.5, marginTop: 8 },
  todoBox: { width: 14, height: 14, borderRadius: 4, borderWidth: 1.5, marginTop: 3 },
  itemText: { fontSize: 15, lineHeight: 21 },
  itemMeta: { fontSize: 12.5, marginTop: 3, fontWeight: '500' },
  refRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 7 },
  refChip: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 24, paddingHorizontal: 9, borderRadius: 12 },
  refChipText: { fontSize: 12, fontWeight: '600' },
  mentionPill: { flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', gap: 5, height: 24, paddingHorizontal: 10, borderRadius: 12, marginBottom: 14 },
  mentionText: { fontSize: 12, fontWeight: '700' },
  askQ: { fontSize: 13.5, marginTop: 4, fontWeight: '600' },
  askA: { fontSize: 15, lineHeight: 21, marginTop: 6, marginBottom: 6 },
  disclaimer: { fontSize: 11.5, textAlign: 'center', marginTop: 18 },
  center: { alignItems: 'center', paddingVertical: 44, paddingHorizontal: 12 },
  centerTitle: { fontSize: 16, fontWeight: '700', marginTop: 12, textAlign: 'center' },
  centerSub: { fontSize: 13.5, marginTop: 6, textAlign: 'center', lineHeight: 19 },
  pillBtn: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 40, paddingHorizontal: 18, borderRadius: 20, marginTop: 18 },
  pillBtnText: { fontSize: 14, fontWeight: '700' },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 10 },
  askRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 22, paddingLeft: 14, paddingRight: 5, minHeight: 44, marginBottom: 10 },
  askInput: { flex: 1, fontSize: 15, paddingVertical: Platform.OS === 'ios' ? 11 : 8 },
  askSend: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconAction: { width: 64, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: 3 },
  iconActionText: { fontSize: 10.5, fontWeight: '600' },
  primary: { flex: 1, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  primaryText: { fontSize: 15, fontWeight: '700' },
});

// [2026-10-14 adv-privacy] Conversa com privacidade avançada → não abre (o
// servidor também recusa). Avisa e fecha.
export default function ConversationSummarySheet(props) {
  const _ap = require('../../services/chatPrivacy').useAdvancedPrivacy(props && props.conversationId);
  const _blocked = !!(props && props.visible && _ap.enabled);
  useEffect(() => {
    if (!_blocked) return;
    let msg = 'A Bia não pode ler esta conversa (privacidade avançada).';
    try { const v = typeof props.t === 'function' ? props.t('advPriv.aiBlocked') : ''; if (v && v !== 'advPriv.aiBlocked') msg = v; } catch {}
    try {
      if (Platform.OS === 'web') window.alert?.(msg);
      else require('react-native').Alert.alert('', msg);
    } catch {}
    try { props.onClose && props.onClose(); } catch {}
  }, [_blocked]);
  return <ConversationSummarySheetInner {...props} visible={!!(props && props.visible) && !_ap.enabled} />;
}
