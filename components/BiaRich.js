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

import { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Linking, Platform, StyleSheet, Animated, Easing } from 'react-native';
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

// ─── cursor piscando (texto aninhado: opacidade via estado, não Animated) ─────
export function BlinkCaret({ color }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setOn(v => !v), 520);
    return () => clearInterval(id);
  }, []);
  return <Text style={{ color, opacity: on ? 0.9 : 0.15, fontWeight: '400' }}>{' ▍'}</Text>;
}

// ─── "Pensando..." / ferramenta em andamento ────────────────────────────────
export function BiaThinking({ isDark, t, toolName }) {
  const pulse = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0.45, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    a.start();
    return () => a.stop();
  }, [pulse]);
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
      <Animated.Text style={[rs.thinkText, { color: fg, opacity: pulse }]}>{label}</Animated.Text>
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

/**
 * Markdown da Bia. `streaming` → cursor piscando no fim do último bloco de texto.
 */
export function BiaMarkdown({ text, color, isDark, streaming, t }) {
  if (!text && !streaming) return null;
  const src = cleanMath(String(text || '')).replace(/\r/g, '');
  const lines = src.split('\n');
  let lastText = -1;
  for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim()) { lastText = i; break; } }
  const caret = (li) => (streaming && li === lastText ? <BlinkCaret key="caret" color={color} /> : null);
  const out = [];
  let i = 0;
  let endedOnBlock = false;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    endedOnBlock = false;
    // código
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(<BiaCodeBlock key={`code-${i}`} code={buf.join('\n')} lang={lang} isDark={isDark} t={t} />);
      endedOnBlock = true;
      continue;
    }
    if (!trimmed) { out.push(<View key={`br-${i}`} style={{ height: 6 }} />); i++; continue; }
    // tabela: linha com | seguida de separador
    if (trimmed.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      out.push(<BiaTable key={`tb-${i}`} rows={rows} color={color} isDark={isDark} keyBase={`tb${i}`} />);
      endedOnBlock = true;
      continue;
    }
    // divisória
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(<View key={`hr-${i}`} style={[rs.hr, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' }]} />);
      i++; continue;
    }
    // títulos
    const h = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (h) {
      const d = h[1].length;
      out.push(
        <Text key={`h-${i}`} style={[rs.h, { color, fontSize: d === 1 ? 20 : d === 2 ? 18 : d === 3 ? 16 : 15, marginTop: d <= 2 ? 8 : 4 }]} selectable accessibilityRole="header">
          {biaInline(h[2].replace(/\s*#+\s*$/, ''), color, isDark, `h${i}`)}{caret(i)}
        </Text>
      );
      i++; continue;
    }
    // citação
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      const start = i;
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(
        <View key={`q-${start}`} style={[rs.quote, { borderLeftColor: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)' }]}>
          <Text style={[rs.p, { color: isDark ? '#C7C7CC' : '#3A3A3C' }]} selectable>{biaInline(buf.join('\n'), color, isDark, `q${start}`)}{caret(i - 1)}</Text>
        </View>
      );
      continue;
    }
    // tarefa
    const task = /^(\s*)[-*]\s+\[( |x|X)\]\s+(.+)$/.exec(line);
    if (task) {
      const done = task[2] !== ' ';
      out.push(
        <View key={`tk-${i}`} style={[rs.li, { marginLeft: Math.min(Math.floor(task[1].length / 2), 3) * 16 }]}>
          <View style={[rs.checkbox, { borderColor: color }, done && { backgroundColor: color }]}>
            {done ? <IconCheck size={10} color={isDark ? '#000' : '#fff'} /> : null}
          </View>
          <Text style={[rs.liText, { color }, done && { textDecorationLine: 'line-through', opacity: 0.6 }]} selectable>{biaInline(task[3], color, isDark, `tk${i}`)}{caret(i)}</Text>
        </View>
      );
      i++; continue;
    }
    // lista com marcador
    const b = /^(\s*)[-*•]\s+(.+)$/.exec(line);
    if (b) {
      out.push(
        <View key={`li-${i}`} style={[rs.li, { marginLeft: Math.min(Math.floor(b[1].length / 2), 3) * 16 }]}>
          <View style={[rs.dot, { backgroundColor: color }]} />
          <Text style={[rs.liText, { color }]} selectable>{biaInline(b[2], color, isDark, `li${i}`)}{caret(i)}</Text>
        </View>
      );
      i++; continue;
    }
    // lista numerada
    const n = /^(\s*)(\d+)[.)]\s+(.+)$/.exec(line);
    if (n) {
      out.push(
        <View key={`ol-${i}`} style={[rs.li, { marginLeft: Math.min(Math.floor(n[1].length / 2), 3) * 16 }]}>
          <Text style={[rs.num, { color }]}>{n[2]}.</Text>
          <Text style={[rs.liText, { color }]} selectable>{biaInline(n[3], color, isDark, `ol${i}`)}{caret(i)}</Text>
        </View>
      );
      i++; continue;
    }
    out.push(<Text key={`p-${i}`} style={[rs.p, { color }]} selectable>{biaInline(line, color, isDark, `p${i}`)}{caret(i)}</Text>);
    i++;
  }
  if (streaming && (lastText === -1 || endedOnBlock)) out.push(<Text key="caret-end" style={rs.p}><BlinkCaret color={color} /></Text>);
  return <View style={rs.mdWrap}>{out}</View>;
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
  const fg = isDark ? '#ECECEC' : '#0D0D0D';
  const muted = isDark ? '#A1A1A6' : '#6B7280';
  const border = isDark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)';
  const bg = isDark ? '#0E0E0F' : '#FFFFFF';
  return (
    <View style={{ gap: 10, marginTop: 10, alignSelf: 'stretch' }}>
      {cards.map(card => {
        const Icon = kindIcon(card.kind);
        return (
          <View key={card.key} style={[rs.card, { borderColor: border, backgroundColor: bg }]}>
            <View style={rs.cardHead}>
              <View style={[rs.cardIcon, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}>
                <Icon size={13} color={fg} />
              </View>
              <Text style={[rs.cardTitle, { color: fg }]} numberOfLines={1}>{card.title}</Text>
            </View>
            {card.rows.map((row, idx) => {
              const Row = row.open ? TouchableOpacity : View;
              return (
                <Row
                  key={row.key}
                  {...(row.open ? { onPress: () => onOpen && onOpen(row.open), activeOpacity: 0.7, accessibilityRole: 'button' } : {})}
                  style={[rs.cardRow, idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: border }]}
                >
                  {card.kind === 'email' ? (
                    <View style={[rs.unread, { backgroundColor: row.dot ? fg : 'transparent' }]} />
                  ) : null}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[rs.rowTitle, { color: fg }, row.dot && { fontWeight: '700' }]} numberOfLines={card.kind === 'reminder' || card.kind === 'eventCreate' ? 3 : 1}>{row.title}</Text>
                    {row.sub ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 }}>
                        {card.kind === 'calendar' ? <IconMapPin size={10} color={muted} /> : null}
                        <Text style={[rs.rowSub, { color: muted }]} numberOfLines={1}>{row.sub}</Text>
                      </View>
                    ) : null}
                  </View>
                  {row.when ? <Text style={[rs.rowWhen, { color: muted }]} numberOfLines={1}>{fmtWhen(row.when, locale)}</Text> : null}
                  {row.open ? <IconChevronRight size={14} color={muted} /> : null}
                </Row>
              );
            })}
            {card.footer ? (
              <TouchableOpacity onPress={() => onOpen && onOpen(card.footer.open)} activeOpacity={0.7} style={[rs.cardFoot, { borderTopColor: border }]} accessibilityRole="button">
                {card.kind === 'email' ? <IconInbox size={12} color={muted} /> : <IconCalendar size={12} color={muted} />}
                <Text style={[rs.cardFootText, { color: muted }]}>{card.footer.label}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const rs = StyleSheet.create({
  mdWrap: { gap: 3, alignSelf: 'stretch', maxWidth: '100%' },
  p: { fontSize: 15.5, lineHeight: 23 },
  h: { fontWeight: '700', lineHeight: 26, letterSpacing: -0.2 },
  li: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, marginVertical: 1 },
  dot: { width: 5, height: 5, borderRadius: 3, marginTop: 9, opacity: 0.85 },
  num: { fontSize: 15, lineHeight: 23, fontWeight: '600', minWidth: 18 },
  liText: { flex: 1, fontSize: 15.5, lineHeight: 23 },
  checkbox: { width: 15, height: 15, borderRadius: 4, borderWidth: 1.5, marginTop: 4, alignItems: 'center', justifyContent: 'center' },
  quote: { borderLeftWidth: 3, paddingLeft: 10, paddingVertical: 2, marginVertical: 3 },
  hr: { height: StyleSheet.hairlineWidth, marginVertical: 10, alignSelf: 'stretch' },
  link: { textDecorationLine: 'underline', fontWeight: '600' },
  inlineCode: { fontFamily: MONO, fontSize: 13.5, paddingHorizontal: 4, borderRadius: 4 },
  codeWrap: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden', marginVertical: 6, alignSelf: 'stretch' },
  codeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 7 },
  codeLang: { fontSize: 11.5, fontWeight: '600', letterSpacing: 0.3, textTransform: 'lowercase' },
  codeCopy: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  codeCopyText: { fontSize: 11.5, fontWeight: '600' },
  codeText: { fontFamily: MONO, fontSize: 12.5, lineHeight: 19, paddingHorizontal: 14, paddingVertical: 12 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: 'hidden' },
  tr: { flexDirection: 'row' },
  td: { paddingHorizontal: 10, paddingVertical: 8 },
  tdText: { fontSize: 14, lineHeight: 20 },
  thinkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  thinkIcon: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  thinkText: { fontSize: 14, fontWeight: '500', letterSpacing: 0.1 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: 'hidden' },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 },
  cardIcon: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 13, fontWeight: '700', letterSpacing: 0.1, flex: 1 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  unread: { width: 7, height: 7, borderRadius: 4 },
  rowTitle: { fontSize: 14.5, fontWeight: '600' },
  rowSub: { fontSize: 13, flexShrink: 1 },
  rowWhen: { fontSize: 12, fontWeight: '500', maxWidth: 120 },
  cardFoot: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth },
  cardFootText: { fontSize: 12.5, fontWeight: '600' },
});
