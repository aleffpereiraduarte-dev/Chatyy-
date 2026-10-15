// BiaRich — peças visuais da tela da Bia (2026-10-15 "Bia mais bonita e rápida").
//
//   BiaMarkdown   markdown completo p/ chat: títulos, listas (inclui tarefas), citações,
//                 tabelas (rolagem horizontal), código com linguagem + copiar, links
//                 nomeados [texto](url), negrito/itálico/riscado/código inline, divisória,
//                 limpeza de LaTeX simples. Cursor piscando no fim enquanto a resposta chega.
//   BiaThinking   "Pensando..." / rótulo humano da ferramenta (sem nome técnico) com pulso.
//   BiaToolCards  cartões p/ resultados de ferramentas (e-mails, agenda, evento criado,
//                 lembrete, contatos) — toque abre a tela certa do app.
//   biaToolLabel  nome da ferramenta → frase amigável (i18n).
//
// Estética P&B do app: só tons de cinza, ícones SVG (components/Icons), sem emoji.

import React, { useState, useEffect, useCallback, memo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Linking, Platform, StyleSheet } from 'react-native';
// [2026-10-15 bia-design] shimmer no passo atual, cascata nos cartões, sombra suave
import { BiaShimmerText, BiaFadeIn, softShadow } from './bia/BiaUI';
import {
  IconCopy, IconCheck, IconCalendar, IconMail, IconUsers, IconClock, IconChevronRight,
  IconGlobe, IconSearch, IconFolder, IconMessageSquare, IconSparkles, IconInbox, IconMapPin,
} from './Icons';

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

// ─── nomes de ferramenta → tipo/rotulo ───────────────────────────────────────
const TOOL_KIND = {
  email: ['list_recent_emails', 'search_emails', 'read_email', 'summarize_emails', 'analyze_email', 'mark_email_read', 'move_email', 'delete_email', 'draft_email', 'suggest_email_replies', 'smart_compose_email', 'email_template'],
  emailSend: ['send_email', 'send_email_html', 'forward_email'],
  calendar: ['list_calendar_events', 'daily_digest', 'get_daily_briefing', 'generate_daily_briefing'],
  eventCreate: ['create_calendar_event', 'create_meeting', 'schedule_smart', 'start_video_call'],
  message: ['send_chat_message', 'send_whatsapp', 'send_sms', 'chat_reply', 'send_whatsapp_image', 'send_whatsapp_audio', 'make_call', 'schedule_message', 'schedule_whatsapp', 'compose_message'],
  chat: ['read_chat_history', 'list_chat_conversations', 'chat_unread_messages', 'chat_search', 'find_message_globally', 'summarize_chat_conversation'],
  contacts: ['list_contacts', 'search_users', 'find_related_info', 'contact_deep_lookup'],
  files: ['list_files', 'search_files', 'read_drive_file', 'list_documents', 'read_document', 'read_spreadsheet', 'list_recent_files', 'create_document', 'create_spreadsheet', 'create_spreadsheet_from_data', 'analyze_data'],
  web: ['web_search', 'news', 'weather', 'define_word'],
  reminder: ['create_reminder', 'set_alarm', 'create_task', 'list_tasks', 'complete_task', 'create_routine', 'water_reminder', 'medication_reminder', 'list_scheduled', 'cancel_scheduled'],
  memory: ['get_memories', 'remember_preference', 'update_brain', 'read_user_profile', 'forget_memory'],
};
const KIND_OF = {};
Object.keys(TOOL_KIND).forEach(k => TOOL_KIND[k].forEach(n => { KIND_OF[n] = k; }));

export function biaToolKind(name) { return KIND_OF[name] || 'other'; }

export function biaToolLabel(name, t) {
  const k = biaToolKind(name);
  const tr = (key, fb) => { const v = t ? t(key) : null; return v && v !== key ? v : fb; };
  switch (k) {
    case 'email': return tr('one.toolSearchingEmails', 'Buscando emails...');
    case 'emailSend': return tr('one.toolSendingEmail', 'Enviando email...');
    case 'calendar': return tr('one.toolReadingCalendar', 'Lendo calendário...');
    case 'eventCreate': return tr('one.toolCreatingEvent', 'Criando evento...');
    case 'message': return tr('one.toolSendingMessage', 'Enviando mensagem...');
    case 'chat': return tr('one.toolReadingChat', 'Lendo chat...');
    case 'contacts': return tr('one.toolSearchingContacts', 'Buscando contatos...');
    case 'files': return tr('one.toolSearchingFiles', 'Buscando arquivos...');
    case 'web': return tr('one.toolSearchingWeb', 'Pesquisando na web...');
    case 'reminder': return tr('one.toolCreatingReminder', 'Criando lembrete...');
    case 'memory': return tr('one.toolRemembering', 'Lembrando...');
    default: return tr('one.toolWorking', 'Processando...');
  }
}

function kindIcon(kind) {
  switch (kind) {
    case 'email': case 'emailSend': return IconMail;
    case 'calendar': case 'eventCreate': return IconCalendar;
    case 'message': case 'chat': return IconMessageSquare;
    case 'contacts': return IconUsers;
    case 'files': return IconFolder;
    case 'web': return IconGlobe;
    case 'reminder': return IconClock;
    case 'memory': return IconSparkles;
    default: return IconSearch;
  }
}

// ─── cursor (bolinha que pulsa — estilo ChatGPT; texto aninhado: opacidade via estado) ─
export function BlinkCaret({ color }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setOn(v => !v), 560);
    return () => clearInterval(id);
  }, []);
  return <Text style={{ color, opacity: on ? 0.95 : 0.3, fontSize: 13, fontWeight: '400' }}>{' \u25CF'}</Text>;
}

// ─── "Pensando..." / ferramenta em andamento (texto com shimmer) ─────────────
export function BiaThinking({ isDark, t, toolName }) {
  const kind = toolName ? biaToolKind(toolName) : null;
  const Icon = kind ? kindIcon(kind) : null;
  const label = toolName ? biaToolLabel(toolName, t) : ((t && t('one.thinking') !== 'one.thinking' && t('one.thinking')) || 'Pensando...');
  const fg = isDark ? '#A1A1A6' : '#6B7280';
  return (
    <View style={rs.thinkRow} accessibilityLiveRegion="polite" accessibilityLabel={label}>
      {Icon ? (
        <View style={[rs.thinkIcon, { backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)' }]}>
          <Icon size={12} color={fg} />
        </View>
      ) : null}
      <BiaShimmerText text={label} isDark={isDark} style={rs.thinkText} />
    </View>
  );
}

// ─── markdown ───────────────────────────────────────────────────────────────
function cleanMath(s) {
  return s
    .replace(/\\\(|\\\)|\\\[|\\\]/g, '')
    .replace(/\\times/g, '×').replace(/\\cdot/g, '·').replace(/\\div/g, '÷')
    .replace(/\\approx/g, '≈').replace(/\\leq?/g, '≤').replace(/\\geq?/g, '≥').replace(/\\neq/g, '≠')
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2')
    .replace(/\\text\{([^{}]*)\}/g, '$1');
}

function openLink(url) {
  try {
    if (Platform.OS === 'web' && typeof window !== 'undefined') { window.open(url, '_blank'); return; }
    Linking.openURL(url).catch(() => {});
  } catch {}
}

const INLINE_RE = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\[[^\]\n]+\]\((?:https?:\/\/|mailto:|tel:)[^)\s]+\)|https?:\/\/[^\s)<>]+|\*[^*\s][^*\n]*\*)/g;

export function biaInline(text, color, isDark, keyBase = 'i') {
  if (!text) return text;
  const parts = String(text).split(INLINE_RE);
  return parts.map((part, i) => {
    if (!part) return null;
    const k = `${keyBase}-${i}`;
    if (part.startsWith('***') && part.endsWith('***') && part.length > 6) return <Text key={k} style={{ fontWeight: '700', fontStyle: 'italic' }}>{part.slice(3, -3)}</Text>;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <Text key={k} style={{ fontWeight: '700' }}>{part.slice(2, -2)}</Text>;
    if (part.startsWith('~~') && part.endsWith('~~') && part.length > 4) return <Text key={k} style={{ textDecorationLine: 'line-through' }}>{part.slice(2, -2)}</Text>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <Text key={k} style={[rs.inlineCode, { backgroundColor: isDark ? '#1C1C1E' : '#F2F2F4', color }]}>{part.slice(1, -1)}</Text>;
    const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (m) return <Text key={k} style={[rs.link, { color }]} onPress={() => openLink(m[2])} accessibilityRole="link">{m[1]}</Text>;
    if (/^https?:\/\//.test(part)) {
      const shown = part.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
      return <Text key={k} style={[rs.link, { color }]} onPress={() => openLink(part)} accessibilityRole="link">{shown.length > 48 ? shown.slice(0, 46) + '…' : shown}</Text>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <Text key={k} style={{ fontStyle: 'italic' }}>{part.slice(1, -1)}</Text>;
    return part;
  });
}

function BiaCodeBlock({ code, lang, isDark, t }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(code);
      else { const Clipboard = require('expo-clipboard'); await Clipboard.setStringAsync(code); }
      setCopied(true);
      try { const H = require('expo-haptics'); H.impactAsync(H.ImpactFeedbackStyle.Light); } catch {}
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  }, [code]);
  const copyLbl = (t && t('common.copy')) || 'Copiar';
  const copiedLbl = (t && t('common.copied')) || 'Copiado';
  return (
    <View style={[rs.codeWrap, { borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }]}>
      <View style={[rs.codeHead, { backgroundColor: isDark ? '#141414' : '#F2F2F4' }]}>
        <Text style={[rs.codeLang, { color: isDark ? '#A1A1A6' : '#6B7280' }]}>{lang || 'code'}</Text>
        <TouchableOpacity onPress={copy} hitSlop={8} style={rs.codeCopy} accessibilityLabel={copyLbl}>
          {copied ? <IconCheck size={12} color={isDark ? '#ECECEC' : '#0D0D0D'} /> : <IconCopy size={12} color={isDark ? '#A1A1A6' : '#6B7280'} />}
          <Text style={[rs.codeCopyText, { color: isDark ? '#A1A1A6' : '#6B7280' }]}>{copied ? copiedLbl : copyLbl}</Text>
        </TouchableOpacity>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ backgroundColor: isDark ? '#0B0B0C' : '#FAFAFB', maxWidth: '100%' }}>
        <Text style={[rs.codeText, { color: isDark ? '#E5E5E7' : '#1F2328' }]} selectable>{code}</Text>
      </ScrollView>
    </View>
  );
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

function BiaTable({ rows, color, isDark, keyBase }) {
  const [head, ...body] = rows;
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.09)';
  const cols = Math.max(...rows.map(r => r.length));
  // largura fixa por coluna (todas as linhas alinhadas): pelo texto mais longo, 92–220px
  const widths = Array.from({ length: cols }).map((_, ci) => {
    const longest = Math.max(...rows.map(r => String(r[ci] || '').replace(/\*\*|`/g, '').length));
    return Math.max(92, Math.min(220, Math.round(longest * 7.6) + 22));
  });
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 6, alignSelf: 'stretch', maxWidth: '100%' }}>
      <View style={[rs.table, { borderColor: border }]}>
        {[head, ...body].map((r, ri) => (
          <View key={`${keyBase}-r${ri}`} style={[rs.tr, ri > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: border }, ri === 0 && { backgroundColor: isDark ? '#141414' : '#F5F5F7' }]}>
            {Array.from({ length: cols }).map((_, ci) => (
              <View key={ci} style={[rs.td, { width: widths[ci] }, ci > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: border }]}>
                <Text style={[rs.tdText, { color }, ri === 0 && { fontWeight: '700' }]} selectable>{biaInline(r[ci] || '', color, isDark, `${keyBase}-${ri}-${ci}`)}</Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// texto "chegando": as últimas palavras ficam mais claras (borda suave que avança
// a cada token = fade por palavra) + cursor. Só quando não há marcação aberta no fim.
function withAlpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(color || ''));
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
const TAIL_ALPHA = [0.22, 0.42, 0.62, 0.82];
function inlineLive(text, color, isDark, keyBase, live) {
  const caret = live ? <BlinkCaret key="caret" color={color} /> : null;
  if (!live) return biaInline(text, color, isDark, keyBase);
  // anda de trás p/ frente até 4 palavras (linear; sem regex com backtracking)
  const str = String(text || '');
  let i = str.length;
  for (let n = 0; n < TAIL_ALPHA.length && i > 0; n++) {
    while (i > 0 && /\s/.test(str[i - 1])) i--;
    while (i > 0 && !/\s/.test(str[i - 1])) i--;
  }
  const tail = str.slice(i);
  if (!tail.trim() || tail.length > 140 || /[*`[\]~()]/.test(tail)) return [biaInline(str, color, isDark, keyBase), caret];
  const words = tail.match(/\S+\s*/g) || [];
  const off = Math.max(0, TAIL_ALPHA.length - words.length);
  return [
    biaInline(str.slice(0, i), color, isDark, keyBase),
    ...words.map((w, i) => <Text key={`${keyBase}-t${i}`} style={{ color: withAlpha(color, TAIL_ALPHA[off + i]) }}>{w}</Text>),
    caret,
  ];
}

function parseBlocks(src) {
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const start = i; const buf = []; i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      const code = buf.join('\n');
      out.push({ type: 'code', key: `code-${start}`, lang: fence[1], code, sig: fence[1] + '\u0001' + code });
      continue;
    }
    if (!trimmed) { out.push({ type: 'br', key: `br-${i}`, sig: '' }); i++; continue; }
    if (trimmed.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const start = i; const rows = [splitRow(line)]; const raw = [line];
      i += 2;
      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); raw.push(lines[i]); i++; }
      out.push({ type: 'table', key: `tb-${start}`, rows, sig: raw.join('\n') });
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push({ type: 'hr', key: `hr-${i}`, sig: '' }); i++; continue; }
    const h = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (h) { out.push({ type: 'h', key: `h-${i}`, depth: h[1].length, text: h[2].replace(/\s*#+\s*$/, ''), sig: trimmed }); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const start = i; const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      const text = buf.join('\n');
      out.push({ type: 'quote', key: `q-${start}`, text, sig: text });
      continue;
    }
    const task = /^(\s*)[-*]\s+\[( |x|X)\]\s+(.+)$/.exec(line);
    if (task) { out.push({ type: 'task', key: `tk-${i}`, indent: Math.min(Math.floor(task[1].length / 2), 3), done: task[2] !== ' ', text: task[3], sig: line }); i++; continue; }
    const b = /^(\s*)[-*•]\s+(.+)$/.exec(line);
    if (b) { out.push({ type: 'li', key: `li-${i}`, indent: Math.min(Math.floor(b[1].length / 2), 3), text: b[2], sig: line }); i++; continue; }
    const n = /^(\s*)(\d+)[.)]\s+(.+)$/.exec(line);
    if (n) { out.push({ type: 'ol', key: `ol-${i}`, indent: Math.min(Math.floor(n[1].length / 2), 3), num: n[2], text: n[3], sig: line }); i++; continue; }
    out.push({ type: 'p', key: `p-${i}`, text: line, sig: line });
    i++;
  }
  return out;
}

// Um bloco = um componente memo: durante o stream só o ÚLTIMO bloco re-renderiza
// (os anteriores têm a mesma assinatura → pulam o render).
const MdBlock = memo(function MdBlock({ b, color, isDark, t, live }) {
  const k = b.key;
  switch (b.type) {
    case 'code': return <BiaCodeBlock code={b.code} lang={b.lang} isDark={isDark} t={t} />;
    case 'br': return <View style={{ height: 6 }} />;
    case 'table': return <BiaTable rows={b.rows} color={color} isDark={isDark} keyBase={k} />;
    case 'hr': return <View style={[rs.hr, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' }]} />;
    case 'h': return (
      <Text style={[rs.h, { color, fontSize: b.depth === 1 ? 21 : b.depth === 2 ? 19 : b.depth === 3 ? 17 : 16, marginTop: b.depth <= 2 ? 10 : 6 }]} selectable accessibilityRole="header">
        {inlineLive(b.text, color, isDark, k, live)}
      </Text>
    );
    case 'quote': return (
      <View style={[rs.quote, { borderLeftColor: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)' }]}>
        <Text style={[rs.p, { color: isDark ? '#C7C7CC' : '#3A3A3C' }]} selectable>{inlineLive(b.text, color, isDark, k, live)}</Text>
      </View>
    );
    case 'task': return (
      <View style={[rs.li, { marginLeft: b.indent * 16 }]}>
        <View style={[rs.checkbox, { borderColor: color }, b.done && { backgroundColor: color }]}>
          {b.done ? <IconCheck size={10} color={isDark ? '#000' : '#fff'} /> : null}
        </View>
        <Text style={[rs.liText, { color }, b.done && { textDecorationLine: 'line-through', opacity: 0.6 }]} selectable>{inlineLive(b.text, color, isDark, k, live)}</Text>
      </View>
    );
    case 'li': return (
      <View style={[rs.li, { marginLeft: b.indent * 16 }]}>
        <View style={[rs.dot, { backgroundColor: color }]} />
        <Text style={[rs.liText, { color }]} selectable>{inlineLive(b.text, color, isDark, k, live)}</Text>
      </View>
    );
    case 'ol': return (
      <View style={[rs.li, { marginLeft: b.indent * 16 }]}>
        <Text style={[rs.num, { color }]}>{b.num}.</Text>
        <Text style={[rs.liText, { color }]} selectable>{inlineLive(b.text, color, isDark, k, live)}</Text>
      </View>
    );
    default: return <Text style={[rs.p, { color }]} selectable>{inlineLive(b.text, color, isDark, k, live)}</Text>;
  }
}, (a, b) => a.b.sig === b.b.sig && a.b.type === b.b.type && a.color === b.color && a.isDark === b.isDark && a.live === b.live);

const TEXT_TYPES = { h: 1, quote: 1, task: 1, li: 1, ol: 1, p: 1 };

/**
 * Markdown da Bia. `streaming` → últimas palavras com fade + cursor no fim.
 */
export function BiaMarkdown({ text, color, isDark, streaming, t }) {
  if (!text && !streaming) return null;
  const src = cleanMath(String(text || '')).replace(/\r/g, '');
  const blocks = parseBlocks(src);
  // durante o stream, uma linha "| a | b" ainda sem o separador é o começo de uma
  // tabela — não mostra o texto cru com pipes (a tabela entra pronta logo depois)
  if (streaming && blocks.length && blocks[blocks.length - 1].type === 'p' && /^\s*\|/.test(blocks[blocks.length - 1].text)) blocks.pop();
  let lastText = -1;
  for (let j = blocks.length - 1; j >= 0; j--) { if (blocks[j].type !== 'br') { lastText = j; break; } }
  const liveIdx = streaming && lastText >= 0 && TEXT_TYPES[blocks[lastText].type] ? lastText : -1;
  return (
    <View style={rs.mdWrap}>
      {blocks.map((b, j) => <MdBlock key={b.key} b={b} color={color} isDark={isDark} t={t} live={j === liveIdx} />)}
      {streaming && liveIdx === -1 ? <Text style={rs.p}><BlinkCaret color={color} /></Text> : null}
    </View>
  );
}

// ─── cartões de resultado de ferramenta ─────────────────────────────────────
function fmtWhen(raw, locale) {
  if (!raw) return '';
  const s = String(raw).replace(' ', 'T');
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(raw);
  const pad = (x) => String(x).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return hm;
  let day;
  try { day = d.toLocaleDateString(locale || undefined, { weekday: 'short', day: '2-digit', month: 'short' }); } catch { day = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; }
  return `${day} · ${hm}`;
}

function cleanName(from) {
  const s = String(from || '').replace(/^"|"$/g, '').trim();
  if (!s) return '';
  return s.includes('@') && !s.includes(' ') ? s.split('@')[0] : s;
}

function plain(s) { return String(s || '').replace(EMOJI_RE, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(); }
function placeText(s) { const v = plain(s); return /^https?:\/\//.test(v) ? v.replace(/^https?:\/\/(www\.)?/, '') : v; }

export function buildBiaCards(actions, t) {
  if (!Array.isArray(actions) || !actions.length) return [];
  const tr = (key, fb) => { const v = t ? t(key) : null; return v && v !== key ? v : fb; };
  const cards = [];
  const seen = new Set();
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    const tool = a.tool || a.name || '';
    const r = a.result;
    if (!tool || !r || typeof r !== 'object' || r.error) continue;
    if (seen.has(tool)) continue;
    if ((tool === 'list_recent_emails' || tool === 'search_emails') && (Array.isArray(r.emails) || Array.isArray(r.results))) {
      const list = (Array.isArray(r.emails) ? r.emails : r.results).slice(0, 4);
      if (!list.length) continue;
      seen.add(tool);
      cards.push({
        key: tool, kind: 'email', title: tr('one.cardEmails', 'E-mails'),
        rows: list.map((e, i) => ({ key: `${e.uid || i}`, title: cleanName(e.from) || plain(e.subject), sub: plain(e.subject), when: e.date, dot: e.read === false, open: { type: 'email', uid: e.uid, folder: r.folder || 'INBOX' } })),
        footer: { label: tr('one.cardOpenInbox', 'Abrir caixa de entrada'), open: { type: 'inbox' } },
      });
    } else if (tool === 'list_calendar_events' && Array.isArray(r.events)) {
      if (!r.events.length) continue;
      seen.add(tool);
      cards.push({
        key: tool, kind: 'calendar', title: tr('one.cardEvents', 'Agenda'),
        rows: r.events.slice(0, 4).map((e, i) => ({ key: `${e.id || i}`, title: plain(e.title) || '—', sub: placeText(e.location || e.calendar_name || ''), when: e.start_at, open: e.id ? { type: 'event', id: e.id } : { type: 'calendar' } })),
        footer: { label: tr('one.cardOpenCalendar', 'Abrir agenda'), open: { type: 'calendar' } },
      });
    } else if ((tool === 'create_calendar_event' || tool === 'create_meeting' || tool === 'schedule_smart') && r.success) {
      seen.add(tool);
      cards.push({
        key: tool, kind: 'eventCreate', title: tr('one.cardEventCreated', 'Evento criado'),
        rows: [{ key: 'ev', title: plain(r.message || ''), sub: r.link ? String(r.link).replace(/^https?:\/\//, '') : '', open: r.event_id ? { type: 'event', id: r.event_id } : (r.link ? { type: 'url', url: r.link } : { type: 'calendar' }) }],
      });
    } else if ((tool === 'create_reminder' || tool === 'set_alarm' || tool === 'create_task') && r.success) {
      seen.add(tool);
      cards.push({ key: tool, kind: 'reminder', title: tr('one.cardReminderSet', 'Lembrete criado'), rows: [{ key: 'rm', title: plain(r.message || ''), open: null }] });
    } else if (tool === 'list_contacts' && Array.isArray(r.contacts) && r.contacts.length) {
      seen.add(tool);
      cards.push({
        key: tool, kind: 'contacts', title: tr('one.cardContacts', 'Contatos'),
        rows: r.contacts.slice(0, 4).map((c, i) => ({ key: `${c.email || c.id || i}`, title: plain(c.name || c.display_name || c.email), sub: plain(c.email || c.phone || ''), open: { type: 'contact', q: c.name || c.email || '' } })),
      });
    }
    if (cards.length >= 2) break;
  }
  return cards;
}

export function BiaToolCards({ actions, isDark, t, locale, onOpen }) {
  const cards = buildBiaCards(actions, t);
  if (!cards.length) return null;
  const fg = isDark ? '#F2F2F4' : '#0D0D0D';
  const muted = isDark ? '#A1A1A6' : '#6B7280';
  const border = isDark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.06)';
  const bg = isDark ? '#111113' : '#FFFFFF';
  return (
    <View style={{ gap: 12, marginTop: 14, alignSelf: 'stretch' }}>
      {cards.map((card, ci) => {
        const Icon = kindIcon(card.kind);
        return (
          <BiaFadeIn key={card.key} delay={80 + ci * 90} dy={12}>
            <View style={[rs.card, { borderColor: border, backgroundColor: bg }, softShadow(isDark, 1)]}>
              <View style={rs.cardHead}>
                <View style={[rs.cardIcon, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#F2F2F4' }]}>
                  <Icon size={15} color={fg} />
                </View>
                <Text style={[rs.cardTitle, { color: fg }]} numberOfLines={1} accessibilityRole="header">{card.title}</Text>
                {card.rows.length > 1 ? (
                  <View style={[rs.cardCount, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}>
                    <Text style={[rs.cardCountText, { color: muted }]}>{card.rows.length}</Text>
                  </View>
                ) : null}
              </View>
              <View style={{ paddingHorizontal: 6, paddingBottom: card.footer ? 0 : 6 }}>
                {card.rows.map((row, idx) => {
                  const Row = row.open ? TouchableOpacity : View;
                  return (
                    <Row
                      key={row.key}
                      {...(row.open ? { onPress: () => onOpen && onOpen(row.open), activeOpacity: 0.6, accessibilityRole: 'button' } : {})}
                      style={[rs.cardRow, idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: border }]}
                    >
                      {card.kind === 'email' ? (
                        <View style={[rs.unread, { backgroundColor: row.dot ? fg : 'transparent', borderColor: row.dot ? fg : border }]} />
                      ) : card.kind === 'calendar' ? (
                        <View style={[rs.calBar, { backgroundColor: fg }]} />
                      ) : null}
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[rs.rowTitle, { color: fg }, row.dot && { fontWeight: '700' }]} numberOfLines={card.kind === 'reminder' || card.kind === 'eventCreate' ? 3 : 1}>{row.title}</Text>
                        {row.sub ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                            {card.kind === 'calendar' ? <IconMapPin size={11} color={muted} /> : null}
                            <Text style={[rs.rowSub, { color: muted }]} numberOfLines={1}>{row.sub}</Text>
                          </View>
                        ) : null}
                      </View>
                      {row.when ? <Text style={[rs.rowWhen, { color: muted }]} numberOfLines={1}>{fmtWhen(row.when, locale)}</Text> : null}
                      {row.open ? <IconChevronRight size={14} color={muted} /> : null}
                    </Row>
                  );
                })}
              </View>
              {card.footer ? (
                <TouchableOpacity onPress={() => onOpen && onOpen(card.footer.open)} activeOpacity={0.7} style={[rs.cardFoot, { borderTopColor: border }]} accessibilityRole="button">
                  {card.kind === 'email' ? <IconInbox size={13} color={fg} /> : <IconCalendar size={13} color={fg} />}
                  <Text style={[rs.cardFootText, { color: fg }]}>{card.footer.label}</Text>
                  <View style={{ flex: 1 }} />
                  <IconChevronRight size={13} color={muted} />
                </TouchableOpacity>
              ) : null}
            </View>
          </BiaFadeIn>
        );
      })}
    </View>
  );
}

const rs = StyleSheet.create({
  mdWrap: { gap: 4, alignSelf: 'stretch', maxWidth: '100%' },
  p: { fontSize: 16.5, lineHeight: 26, letterSpacing: -0.1 },
  h: { fontWeight: '700', lineHeight: 28, letterSpacing: -0.35 },
  li: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, marginVertical: 1 },
  dot: { width: 5, height: 5, borderRadius: 3, marginTop: 11, opacity: 0.85 },
  num: { fontSize: 16, lineHeight: 26, fontWeight: '600', minWidth: 20 },
  liText: { flex: 1, fontSize: 16.5, lineHeight: 26, letterSpacing: -0.1 },
  checkbox: { width: 16, height: 16, borderRadius: 5, borderWidth: 1.5, marginTop: 5, alignItems: 'center', justifyContent: 'center' },
  quote: { borderLeftWidth: 3, paddingLeft: 10, paddingVertical: 2, marginVertical: 3 },
  hr: { height: StyleSheet.hairlineWidth, marginVertical: 10, alignSelf: 'stretch' },
  link: { textDecorationLine: 'underline', fontWeight: '600' },
  inlineCode: { fontFamily: MONO, fontSize: 13.5, paddingHorizontal: 4, borderRadius: 4 },
  codeWrap: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, overflow: 'hidden', marginVertical: 8, alignSelf: 'stretch' },
  codeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 9 },
  codeLang: { fontSize: 11.5, fontWeight: '600', letterSpacing: 0.3, textTransform: 'lowercase' },
  codeCopy: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  codeCopyText: { fontSize: 11.5, fontWeight: '600' },
  codeText: { fontFamily: MONO, fontSize: 13, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 14 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: 'hidden' },
  tr: { flexDirection: 'row' },
  td: { paddingHorizontal: 12, paddingVertical: 10 },
  tdText: { fontSize: 14, lineHeight: 20 },
  thinkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  thinkIcon: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  thinkText: { fontSize: 15.5, fontWeight: '500', letterSpacing: -0.1 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 20 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 13, paddingBottom: 6 },
  cardIcon: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  cardCount: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 7, alignItems: 'center', justifyContent: 'center' },
  cardCountText: { fontSize: 12, fontWeight: '700' },
  calBar: { width: 3, alignSelf: 'stretch', borderRadius: 2, opacity: 0.85 },
  cardTitle: { fontSize: 15, fontWeight: '700', letterSpacing: -0.2, flex: 1 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 11 },
  unread: { width: 8, height: 8, borderRadius: 4, borderWidth: 1 },
  rowTitle: { fontSize: 14.5, fontWeight: '600' },
  rowSub: { fontSize: 13, flexShrink: 1 },
  rowWhen: { fontSize: 12, fontWeight: '500', maxWidth: 120 },
  cardFoot: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
  cardFootText: { fontSize: 13.5, fontWeight: '600' },
});
