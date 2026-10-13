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
} from '../Icons';
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

export function normalizeDigest(d) {
  if (!d || typeof d !== 'object') return null;
  const summary = cleanText(d.summary || d.tldr || '');
  const out = {
    summary: summary && !NOISE_RE.test(summary) ? summary : '',
    topics: normList(d.topics),
    decisions: normList(d.decisions),
    todos: normList(d.todos || d.action_items || d.tasks),
    dates: normList(d.dates || d.dates_places || d.events),
    questions: normList(d.open_questions || d.questions),
    mentionsMe: !!d.mentions_me,
    tone: cleanText(d.tone || ''),
    count: parseInt(d.message_count || d.count || 0, 10) || 0,
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

// ───────────────────────────── visuais ─────────────────────────────

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

const RANGES = ['unread', 'today', 'last100', 'last300'];

// ───────────────────────────── componente ─────────────────────────────

export default function ConversationSummarySheet({
  visible,
  onClose,
  conversationId,
  messages,
  currentEmail,
  myName,
  unreadCount = 0,
  firstUnreadId = null,
  initialRange = 'last100',
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
  const startRange = ranges.includes(initialRange) ? initialRange : (initialRange === 'recent' ? 'last100' : ranges[0]);

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
  const reqRef = useRef(0);
  const askReqRef = useRef(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => { if (visible) { setRange(startRange); setAsk(null); setQuestion(''); } }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const key = conversationId + '|' + r + '|' + lastId + '|' + locale;
    if (!refresh && _memo.has(key)) {
      const m = _memo.get(key);
      setData(m.data); setLegacy(m.legacy); setStatus(m.data ? 'ready' : 'empty'); setErrMsg('');
      return;
    }
    setStatus('loading'); setErrMsg(''); setCopied(false);
    const api = require('../../services/api');
    const done = (d, isLegacy) => {
      if (my !== reqRef.current) return;
      const empty = !d || (!d.summary && !d.topics.length && !d.decisions.length && !d.todos.length && !d.dates.length && !d.questions.length);
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
        res = await api.chatAiDigest(baseParams(r, refresh ? { refresh: 1 } : {}));
        if (res && res.success && res.data && res.data.need_messages) {
          // Conversa cifrada (E2EE): o servidor só vê ciphertext → manda o que o app já decifrou.
          const items = localItems(r);
          if (!items.length) { done(null, false); return; }
          res = await api.chatAiDigest(baseParams(r, { messages: items, ...(refresh ? { refresh: 1 } : {}) }));
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
  }, [conversationId, lastId, locale, baseParams, localItems]);

  useEffect(() => {
    if (!visible || !conversationId) return;
    load(range, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, range, conversationId]);

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
        const refs = (Array.isArray(r.data.refs) ? r.data.refs : []).map(Number).filter((x) => Number.isFinite(x) && x > 0).slice(0, 4);
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
  const shareText = useMemo(() => digestToText(data, t, tr(t, 'chatSum.shareTitle', 'Resumo da conversa')), [data, t]);

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
    if (USE_NATIVE_SHEETS) runAfterNativeSheet(go); else setTimeout(go, 250);
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
  if (status === 'loading') content = skeleton;
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
    content = (
      <View key={'v' + version}>
        {data.mentionsMe ? (
          <FadeSlideIn distance={6}>
            <View style={[st.mentionPill, { backgroundColor: C.ink }]}>
              <IconAtSign size={12} color={C.onInk} />
              <Text style={[st.mentionText, { color: C.onInk }]}>{tr(t, 'chatSum.mentionsMe', 'Mencionaram você')}</Text>
            </View>
          </FadeSlideIn>
        ) : null}
        {data.summary ? (
          <FadeSlideIn distance={10}>
            <Text style={[st.kicker, { color: C.text3 }]}>{tr(t, 'chatSum.inShort', 'Em resumo')}</Text>
            <Text style={[st.summary, { color: C.text }]} selectable>{data.summary}</Text>
            {data.tone ? <Text style={[st.tone, { color: C.text2 }]}>{data.tone}</Text> : null}
          </FadeSlideIn>
        ) : null}
        {renderSection(IconCheckCircle, tr(t, 'chatSum.decisions', 'Decisões'), data.decisions, null, 50)}
        {renderSection(IconCheck, tr(t, 'chatSum.todos', 'Para fazer'), data.todos, 'todo', 90)}
        {renderSection(IconMessageSquare, tr(t, 'chatSum.topics', 'Tópicos'), data.topics, null, 130)}
        {renderSection(IconCalendar, tr(t, 'chatSum.dates', 'Datas e lugares'), data.dates, null, 170)}
        {renderSection(IconHelpCircle, tr(t, 'chatSum.questions', 'Perguntas sem resposta'), data.questions, null, 210)}
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
        <Text style={[st.disclaimer, { color: C.text3 }]}>{tr(t, 'chatSum.disclaimer', 'Feito pela Bia · pode conter erros')}</Text>
      </View>
    );
  }

  const ready = status === 'ready' && !!data;
  const showMarkRead = ready && range === 'unread' && typeof onMarkRead === 'function';
  const bottomPad = Platform.OS === 'ios' && USE_NATIVE_SHEETS ? 14 : Math.max(14, (insets.bottom || 0) + 8);

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

  if (USE_NATIVE_SHEETS) {
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
  rangeRow: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, gap: 8 },
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
