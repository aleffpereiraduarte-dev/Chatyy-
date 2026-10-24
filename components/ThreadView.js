import { useState, useEffect, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import { getMessage, prefetchMessage } from '../services/api';
import { getMessageFromCache, getMessageFromCacheSync, saveMessageToCache } from '../services/offlineCache';

function _withTimeout(p, ms) {
  let tm;
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => { tm = setTimeout(() => rej(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(tm));
}
// DOMPurify is web-only — lazy load to avoid crash on native
let DOMPurify = null;
if (Platform.OS === 'web') {
  try { DOMPurify = require('dompurify'); } catch (e) {}
}
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { Colors } from '../constants/theme';
import { IconChevronDown, IconReply, IconReplyAll, IconForward, IconX } from './Icons';
import AvatarCircle from './AvatarCircle';
import { useAuth } from '../context/AuthContext';
// [2026-10-15 native-email] Corpo HTML de cada mensagem da thread em view nativa.
import NativeEmailBody, { isNativeEmailBodyOn, openEmailLink } from './email/NativeEmailBody';
import { sanitizeEmailHtml } from './EmailReader';
import { getAttachmentUrl } from '../services/api';
import { shouldBlockRemoteImages, allowSenderImages } from '../services/emailImagePolicy';

const _TRACKER_RE = /<img\b[^>]*\b(?:width|height)\s*=\s*["']?\s*1\s*["']?[^>]*\b(?:width|height)\s*=\s*["']?\s*1\s*["']?[^>]*>/gi;

function _threadHtml(m) {
  let html = sanitizeEmailHtml(String(m.body_html || '')) || '';
  html = html.replace(_TRACKER_RE, '');
  // cid: (anexo inline) → URL de download do próprio servidor
  const cidMap = {};
  try {
    (m.attachments || []).forEach((a, i) => {
      const cid = String(a?.content_id || '').replace(/^<|>$/g, '').trim().toLowerCase();
      if (cid) cidMap[cid] = a.part_id ?? a.part ?? (i + 1);
    });
  } catch {}
  if (Object.keys(cidMap).length && m.uid != null) {
    html = html.replace(/\bsrc\s*=\s*["']cid:([^"']+)["']/gi, (full, ref) => {
      const part = cidMap[String(ref).replace(/^<|>$/g, '').trim().toLowerCase()];
      if (part == null) return full;
      return 'src="' + String(getAttachmentUrl(m.uid, m.folder || 'INBOX', part)).replace(/"/g, '&quot;') + '"';
    });
  }
  return html;
}

function ThreadNativeBody({ m, colors, t }) {
  const { isDark } = useTheme();
  const sender = m.from_email || ((String(m.from || '').match(/<([^>]+)>/) || [])[1]) || String(m.from || '').trim();
  const [show, setShow] = useState(() => !shouldBlockRemoteImages(sender));
  const html = useMemo(() => _threadHtml(m), [m.body_html, m.uid]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasRemote = useMemo(() => /<img\b[^>]*\bsrc\s*=\s*["']?https?:/i.test(html), [html]);
  return (
    <View>
      {!show && hasRemote && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
          <TouchableOpacity onPress={() => setShow(true)} accessibilityRole="button" style={{ minHeight: 32, justifyContent: 'center' }}>
            <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '600' }}>{t('reader.loadImages') || 'Carregar imagens'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { allowSenderImages(sender); setShow(true); }} accessibilityRole="button" style={{ minHeight: 32, justifyContent: 'center' }}>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{t('reader.alwaysLoadFrom') || 'Sempre deste remetente'}</Text>
          </TouchableOpacity>
        </View>
      )}
      <NativeEmailBody
        html={html}
        rawHtml={m.body_html}
        isDark={isDark}
        colors={colors}
        blockRemote={!show}
        allowHosts={['chatyy.com.br', 'chatyy.app', 'onemundo.com.br']}
        contentKey={`t:${m.uid}:${m.folder || ''}`}
        labels={{ open: t('common.open') || 'Abrir', copyLink: t('common.copyLink') || 'Copiar link', share: t('common.share') || 'Compartilhar', cancel: t('common.cancel') || 'Cancelar' }}
        onLinkPress={(url) => openEmailLink(url, { colors, isDark })}
      />
    </View>
  );
}

// [2026-10-11 email-qa] Cabeçalhos crus ("apitest <apitest@…>", '"Fulano"
// <x@y>') apareciam como nome do remetente/destinatário. Agora: parse do
// RFC 5322 → nome limpo (sem aspas/colchetes), "Você" quando é a própria conta
// e avatar pelo endereço, igual ao EmailReader.
function parseAddress(raw) {
  const str = String(raw || '').trim();
  if (!str) return { name: '', email: '' };
  const m = str.match(/^(.*?)<([^<>]+@[^<>]+)>\s*$/);
  if (m) {
    return { name: cleanName(m[1]), email: m[2].trim() };
  }
  const bare = str.replace(/^[<"'\s]+|[>"'\s]+$/g, '');
  if (/^[^\s@]+@[^\s@]+$/.test(bare)) return { name: '', email: bare };
  return { name: cleanName(str), email: '' };
}

function cleanName(n) {
  let x = String(n || '').trim();
  // Nome que veio com o endereço junto ("apitest <apitest@x>") → só o nome.
  x = x.replace(/<[^>]*>/g, '').trim();
  x = x.replace(/^["'\s]+|["'\s]+$/g, '').replace(/\\"/g, '"').trim();
  return x;
}

// Divide "a <x@y>, "Sobrenome, Nome" <z@w>" respeitando aspas e <>.
function splitAddressList(raw) {
  const out = [];
  let cur = '';
  let inQ = false;
  let inA = false;
  for (const ch of String(raw || '')) {
    if (ch === '"') inQ = !inQ;
    else if (ch === '<' && !inQ) inA = true;
    else if (ch === '>' && !inQ) inA = false;
    if ((ch === ',' || ch === ';') && !inQ && !inA) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function extractEmail(fromField) {
  return parseAddress(fromField).email || String(fromField || '').trim();
}

// Nome amigável de um endereço: "Você" (própria conta) > nome do cabeçalho >
// parte local do e-mail.
function friendlyName(raw, explicitName, selfEmails, youLabel) {
  const a = parseAddress(raw);
  const email = (a.email || '').toLowerCase();
  if (email && selfEmails.has(email)) return youLabel;
  const n = cleanName(explicitName) || a.name;
  if (n && !/^[^\s@]+@[^\s@]+$/.test(n)) return n;
  const e = a.email || n || '';
  return e ? e.split('@')[0] : '';
}

// [2026-06-05] No mobile o ThreadView NÃO tinha caminho de HTML (só web via
// DOMPurify) → e-mails SÓ-HTML (ex.: marketing/Transfeera) caíam em
// `body_text || body` = vazio → "(sem conteúdo)" no app, mesmo funcionando no
// web. Este fallback converte o body_html em texto legível pra exibir no
// celular. Tira <style>/<script>, vira blocos em quebra de linha, decodifica
// entidades comuns e colapsa espaços.
function htmlToText(html) {
  if (!html) return '';
  let x = String(html);
  x = x.replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  x = x.replace(/<br\s*\/?>/gi, '\n');
  x = x.replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n');
  x = x.replace(/<[^>]+>/g, '');
  x = x.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
       .replace(/&[a-z#0-9]+;/gi, ' ');
  return x.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// [2026-07-03] Some servers return HTML markup INSIDE body_text/body (no real
// text/plain MIME part), which rendered raw <p>/<a>/<br> tags in the thread
// view on native — the founder's screenshot showed "<p>Hi Aleff,</p>..." as
// literal text. The web path sanitizes+renders HTML (DOMPurify); native falls
// to a <Text>. Prefer a GENUINE plaintext part, but if the text field actually
// contains HTML tags, convert it via htmlToText instead of dumping the markup.
function pickBodyText(m) {
  const looksHtml = (s) => typeof s === 'string' && /<\/?[a-z][\s\S]*?>/i.test(s);
  const txt = m.body_text || m.body || '';
  if (txt && !looksHtml(txt)) return txt;      // real plaintext → use as-is
  if (m.body_html) return htmlToText(m.body_html); // HTML source of truth
  if (looksHtml(txt)) return htmlToText(txt);  // text field carried HTML
  return txt;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    }
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'numeric' }) + ' ' +
      d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  } catch {
    return dateStr;
  }
}

function MessageItem({ message, initiallyExpanded, colors, t, onReply, onReplyAll, onForward, selfEmails, showActions }) {
  const [expanded, setExpanded] = useState(!!initiallyExpanded);
  // [2026-10-17 thread-carregando] Corpo do cache local no 1º frame (prefetch da
  // ThreadView / aberturas anteriores) → expandir é instantâneo.
  const [fetched, setFetched] = useState(() => {
    if (message.body_html || message.body_text || message.body || !message.uid) return null;
    return getMessageFromCacheSync(message.uid, message.folder || 'INBOX');
  });
  const [loadingBody, setLoadingBody] = useState(false);
  const [bodyFailed, setBodyFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // [2026-06-15] O backend `get_thread` monta cada mensagem da thread SÓ com
  // imap_fetch_overview (cabeçalhos: from/to/subject/date) — NUNCA traz o corpo.
  // Fix estilo Gmail: ao expandir a mensagem pela 1ª vez, busca o corpo
  // completo via getMessage(uid, folder) e mescla. Lazy = não pesa o servidor.
  // [2026-10-17 thread-carregando] BUG: `loadingBody` estava nas deps → o
  // setLoadingBody(true) re-rodava o efeito, o cleanup marcava cancelled=true e
  // a resposta (200 em ~50 ms) era DESCARTADA → "Carregando…" eterno em toda
  // mensagem que não fosse a aberta. Agora: deps sem loadingBody, cancelamento
  // só no unmount/troca de uid, cache-first, timeout + 1 retry + botão.
  const hasBody = !!(message.body_html || message.body_text || message.body);
  useEffect(() => {
    if (!expanded || hasBody || fetched || !message.uid) return;
    let cancelled = false;
    const uid = message.uid;
    const folder = message.folder || 'INBOX';
    setLoadingBody(true);
    setBodyFailed(false);
    (async () => {
      let data = null;
      try {
        const cached = await getMessageFromCache(uid, folder);
        if (cached) data = cached;
      } catch {}
      for (let i = 0; !data && i < 2 && !cancelled; i++) {
        try {
          const r = await _withTimeout(getMessage(uid, folder), 20000);
          const d = r && r.success && r.data;
          if (d && (d.body_html || d.body_text || d.body || (d.attachments && d.attachments.length))) {
            data = d;
            saveMessageToCache(uid, d, folder).catch(() => {});
          }
        } catch {}
      }
      if (cancelled || !mountedRef.current) return;
      if (data) setFetched(data); else setBodyFailed(true);
      setLoadingBody(false);
    })();
    return () => { cancelled = true; if (mountedRef.current) setLoadingBody(false); };
  }, [expanded, hasBody, fetched, message.uid, message.folder, attempt]);

  const m = fetched ? { ...message, ...fetched } : message;
  const mHasBody = !!(m.body_html || m.body_text || m.body);
  const senderEmail = m.from_email || extractEmail(m.from);
  const youLabel = t('common.you') || 'Você';
  const senderName = friendlyName(m.from, m.from_name, selfEmails, youLabel) || senderEmail;
  // Avatar usa o nome real (iniciais "AP", não "VO" de "Você").
  const avatarName = friendlyName(m.from, m.from_name, new Set(), '') || senderEmail;
  const toNames = useMemo(() => {
    const list = [...splitAddressList(m.to), ...splitAddressList(m.cc)];
    const names = list.map(a => friendlyName(a, '', selfEmails, youLabel)).filter(Boolean);
    return Array.from(new Set(names)).join(', ');
  }, [m.to, m.cc, selfEmails, youLabel]);
  const snippet = useMemo(() => {
    if (expanded) return '';
    const p = m.preview || m.snippet || '';
    return String(p || pickBodyText(m) || '').replace(/\s+/g, ' ').trim();
  }, [expanded, m.preview, m.snippet, m.body_text, m.body, m.body_html]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderBody = () => {
    if (m.body_html && Platform.OS === 'web' && DOMPurify?.sanitize) {
      return (
        <div
          style={{
            padding: 0, fontSize: 14, lineHeight: 1.7, color: colors.text,
            wordBreak: 'break-word', fontFamily: 'system-ui, -apple-system, sans-serif',
            overflowX: 'auto',
          }}
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(m.body_html) }}
        />
      );
    }
    if (m.body_html && Platform.OS !== 'web' && isNativeEmailBodyOn()) {
      return <ThreadNativeBody m={m} colors={colors} t={t} />;
    }
    // Sem corpo ainda + buscando → spinner em vez de "(sem conteúdo)".
    if (!mHasBody && loadingBody) {
      return (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6 }}>
          <ActivityIndicator size="small" color={colors.textTertiary} />
          <Text style={[s.bodyText, { color: colors.textTertiary, marginLeft: 8 }]}>
            {t('common.loading')}
          </Text>
        </View>
      );
    }
    if (!mHasBody && bodyFailed) {
      return (
        <TouchableOpacity
          onPress={() => { require('../utils/userRetry').noteUserRetry(); setAttempt((a) => a + 1); }}
          accessibilityRole="button"
          style={{ paddingVertical: 6, minHeight: 32, justifyContent: 'center' }}
        >
          <Text style={[s.bodyText, { color: colors.primary }]}>
            {t('common.tryAgain') || 'Tentar novamente'}
          </Text>
        </TouchableOpacity>
      );
    }
    return (
      <Text style={[s.bodyText, { color: colors.text }]} selectable>
        {pickBodyText(m) || t('reader.noContent')}
      </Text>
    );
  };

  return (
    <View style={[s.messageCard, { backgroundColor: colors.surface, borderColor: colors.borderLight }, expanded && Shadow.sm]}>
      <TouchableOpacity
        style={s.messageHeader}
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={senderName}
      >
        <AvatarCircle
          name={avatarName}
          email={senderEmail}
          size={36}
          style={s.avatar}
        />
        <View style={s.headerInfo}>
          <View style={s.headerTopRow}>
            <Text style={[s.senderName, { color: colors.text }]} numberOfLines={1}>
              {senderName}
            </Text>
            <Text style={[s.dateText, { color: colors.textTertiary }]}>
              {formatDate(m.date)}
            </Text>
          </View>
          {!expanded && !!snippet && (
            <Text style={[s.snippet, { color: colors.textTertiary }]} numberOfLines={1}>
              {snippet}
            </Text>
          )}
          {expanded && !!toNames && (
            <Text style={[s.toLine, { color: colors.textTertiary }]} numberOfLines={1}>
              {t('reader.to')} {toNames}
            </Text>
          )}
        </View>
        <View style={[s.chevronWrap, { transform: [{ rotate: expanded ? '180deg' : '0deg' }] }]}>
          <IconChevronDown size={18} color={colors.textTertiary} />
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={[s.messageBody, { borderTopColor: colors.borderLight }]}>
          {renderBody()}
          {/* Per-message reply actions — escondidas na última mensagem quando a
              tela já tem barra de ações (evita Responder/Encaminhar repetidos). */}
          {showActions && (
            <View style={[s.msgActions, { borderTopColor: colors.borderLight }]}>
              <TouchableOpacity style={[s.msgActionBtn, { backgroundColor: colors.surfaceVariant }]} onPress={() => onReply?.(m)} accessibilityRole="button" accessibilityLabel={t('reader.reply')}>
                <IconReply size={14} color={colors.primary} style={{ marginRight: 4 }} />
                <Text style={[s.msgActionText, { color: colors.primary }]}>{t('reader.reply')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.msgActionBtn, { backgroundColor: colors.surfaceVariant }]} onPress={() => onReplyAll?.(m)} accessibilityRole="button" accessibilityLabel={t('reader.replyAll')}>
                <IconReplyAll size={14} color={colors.textSecondary} style={{ marginRight: 4 }} />
                <Text style={[s.msgActionText, { color: colors.textSecondary }]}>{t('reader.replyAll')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.msgActionBtn, { backgroundColor: colors.surfaceVariant }]} onPress={() => onForward?.(m)} accessibilityRole="button" accessibilityLabel={t('reader.forward')}>
                <IconForward size={14} color={colors.textSecondary} style={{ marginRight: 4 }} />
                <Text style={[s.msgActionText, { color: colors.textSecondary }]}>{t('reader.forward')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

// Props:
//  - hasActionBar: a tela já tem barra/toolbar com Responder/Resp. todos/
//    Encaminhar (read.js no celular, toolbar do painel no desktop) → esconde os
//    botões grandes do rodapé e os da última mensagem (como no EmailReader).
//  - focusUid: mensagem aberta pelo usuário — começa expandida junto com a última.
//  - header: nó opcional renderizado acima do assunto (ex.: toolbar do desktop).
export default function ThreadView({ thread, onReply, onReplyAll, onForward, onClose, hasActionBar = false, focusUid, header }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const [showAll, setShowAll] = useState(false);
  const threadKey = (thread || []).map(m => m?.uid || m?.id || '').join(',');
  useEffect(() => { setShowAll(false); }, [threadKey]);
  // [2026-10-17 thread-carregando] Aquece em 2º plano (sem marcar lido, 1 por
  // vez) o corpo das mensagens recolhidas → tocar pra expandir abre do cache.
  useEffect(() => {
    let cancelled = false;
    const todo = (thread || []).filter((m) => m && m.uid && !(m.body_html || m.body_text || m.body)).slice(-6).reverse();
    if (!todo.length) return undefined;
    const tm = setTimeout(async () => {
      for (const m of todo) {
        if (cancelled) break;
        try { await prefetchMessage(m.uid, m.folder || 'INBOX'); } catch {}
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(tm); };
  }, [threadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const selfEmails = useMemo(() => {
    const set = new Set();
    const add = (e) => { if (e) set.add(String(e).trim().toLowerCase()); };
    add(user?.email);
    try { add(require('../services/api').getActiveAccountEmail?.()); } catch {}
    (user?.aliases || []).forEach(a => add(typeof a === 'string' ? a : a?.email));
    return set;
  }, [user?.email, user?.aliases]);

  if (!thread || thread.length === 0) return null;

  const subject = thread[0]?.subject || t('reader.noSubject');
  const messageCount = thread.length;
  const lastIdx = thread.length - 1;
  const focusIdx = focusUid != null ? thread.findIndex(m => String(m?.uid) === String(focusUid)) : -1;

  // Gmail: conversa longa mostra a 1ª, um divisor "N mensagens anteriores" e
  // as 2 últimas (mais a aberta, se estiver no meio). Clique expande tudo.
  const visible = [];
  const keep = new Set([0, lastIdx - 1, lastIdx]);
  if (focusIdx >= 0) keep.add(focusIdx);
  // Só recolhe quando esconde 2+ (divisor "1 mensagem anterior" não ajuda).
  if (!showAll && messageCount - keep.size >= 2) {
    let hidden = 0;
    thread.forEach((msg, i) => {
      if (keep.has(i)) {
        if (hidden > 0) { visible.push({ divider: hidden, key: 'div' + i }); hidden = 0; }
        visible.push({ msg, i });
      } else {
        hidden += 1;
      }
    });
  } else {
    thread.forEach((msg, i) => visible.push({ msg, i }));
  }

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      {header}
      {/* Thread header */}
      <View style={s.threadHeader}>
        <View style={s.subjectRow}>
          <Text style={[s.subject, { color: colors.text }]} numberOfLines={3}>
            {subject}
          </Text>
          {onClose && (
            <TouchableOpacity onPress={onClose} style={s.closeBtn} accessibilityRole="button" accessibilityLabel={t('common.close')}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
        <Text style={[s.messageCount, { color: colors.textTertiary }]}>
          {messageCount} {messageCount === 1 ? t('thread.message') : t('thread.messages')}
        </Text>
      </View>

      {/* Messages */}
      {visible.map((v) => (v.divider ? (
        <TouchableOpacity
          key={v.key}
          onPress={() => setShowAll(true)}
          style={s.olderWrap}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('thread.olderMessages', { count: v.divider })}
        >
          <View style={[s.olderLine, { backgroundColor: colors.borderLight }]} />
          <View style={[s.olderPill, { backgroundColor: colors.surfaceVariant, borderColor: colors.borderLight }]}>
            <Text style={[s.olderText, { color: colors.textSecondary }]}>
              {t('thread.olderMessages', { count: v.divider })}
            </Text>
          </View>
          <View style={[s.olderLine, { backgroundColor: colors.borderLight }]} />
        </TouchableOpacity>
      ) : (
        <MessageItem
          key={v.msg.uid || v.msg.id || v.i}
          message={v.msg}
          initiallyExpanded={v.i === lastIdx || v.i === focusIdx}
          colors={colors}
          t={t}
          selfEmails={selfEmails}
          showActions={!(hasActionBar && v.i === lastIdx)}
          onReply={onReply}
          onReplyAll={onReplyAll}
          onForward={onForward}
        />
      )))}

      {/* Action buttons — escondidos quando a tela tem barra própria. */}
      {!hasActionBar && (
        <View style={[s.actions, { borderTopColor: colors.borderLight }]}>
          <TouchableOpacity
            style={[s.actionBtn, Shadow.sm, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
            onPress={() => onReply?.(thread[lastIdx])}
            accessibilityRole="button"
            accessibilityLabel={t('reader.reply')}
          >
            <IconReply size={16} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.actionText, { color: colors.text }]}>{t('reader.reply')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.actionBtn, Shadow.sm, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
            onPress={() => onReplyAll?.(thread[lastIdx])}
            accessibilityRole="button"
            accessibilityLabel={t('reader.replyAll')}
          >
            <IconReplyAll size={16} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.actionText, { color: colors.text }]}>{t('reader.replyAll')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.actionBtn, Shadow.sm, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
            onPress={() => onForward?.(thread[lastIdx])}
            accessibilityRole="button"
            accessibilityLabel={t('reader.forward')}
          >
            <IconForward size={16} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.actionText, { color: colors.text }]}>{t('reader.forward')}</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.xxl, paddingBottom: 40 },
  // Thread header
  threadHeader: { marginBottom: Spacing.xl },
  subjectRow: { flexDirection: 'row', alignItems: 'flex-start' },
  subject: { flex: 1, fontSize: 22, fontWeight: '400', lineHeight: 30, letterSpacing: -0.2 },
  closeBtn: { padding: Spacing.sm, marginLeft: Spacing.sm },
  messageCount: { fontSize: FontSize.sm, marginTop: Spacing.xs },
  // Message card
  messageCard: {
    borderRadius: BorderRadius.lg, borderWidth: 1,
    marginBottom: Spacing.md, overflow: 'hidden',
  },
  messageHeader: {
    flexDirection: 'row', alignItems: 'center',
    padding: Spacing.lg,
  },
  avatar: {
    marginRight: Spacing.md,
  },
  headerInfo: { flex: 1, marginRight: Spacing.sm },
  headerTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  senderName: { fontSize: FontSize.base, fontWeight: '600', flex: 1, marginRight: Spacing.sm },
  dateText: { fontSize: FontSize.xs },
  snippet: { fontSize: FontSize.sm, marginTop: 2 },
  toLine: { fontSize: FontSize.xs, marginTop: 2 },
  chevronWrap: { padding: Spacing.xs },
  // Message body
  messageBody: {
    paddingHorizontal: Spacing.lg, paddingBottom: Spacing.lg, paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  bodyText: { fontSize: FontSize.base, lineHeight: 24 },
  // Per-message actions
  msgActions: {
    flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.md, paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  // "N mensagens anteriores" (Gmail)
  olderWrap: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  olderLine: { flex: 1, height: StyleSheet.hairlineWidth },
  olderPill: {
    paddingHorizontal: Spacing.md, paddingVertical: 6, borderRadius: BorderRadius.xxl,
    borderWidth: 1, marginHorizontal: Spacing.sm,
  },
  olderText: { fontSize: FontSize.sm, fontWeight: '600' },
  msgActionBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 6,
    borderRadius: BorderRadius.xxl,
  },
  msgActionText: { fontSize: FontSize.xs, fontWeight: '500' },
  // Actions
  actions: {
    flexDirection: 'row', flexWrap: 'wrap', marginTop: Spacing.xl, paddingTop: Spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth, gap: Spacing.md,
  },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', borderWidth: 1,
    borderRadius: BorderRadius.xxl, paddingVertical: 10, paddingHorizontal: Spacing.xl,
  },
  actionText: { fontSize: FontSize.base, fontWeight: '500' },
});
