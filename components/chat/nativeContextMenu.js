// components/chat/nativeContextMenu.js — [2026-10-15 native-ctxmenu]
//
// Menu de contexto da MENSAGEM 100% nativo (lista nativa, apiVersion ≥ 3).
//   Nativo (modules/expo-chat-message-list): long-press → snapshot real da
//   célula sobe com spring, fundo borrado/escurecido, barra de reações
//   (stagger) + "+" (grade de emojis nativa com busca/recentes), menu de ações
//   com blur; tocar fora → animação reversa; reação "voa" até a bolha e o chip
//   aparece com pop.
//   JS (aqui): monta a LISTA de ações com as MESMAS condições do menu JS
//   (chat-conversation.js, Modal do selectedMsg) e executa os MESMOS handlers
//   quando o nativo devolve onMenuAction / onReact.
//
// Kill switch (OTA): globalThis.__chatyy_native_ctxmenu = false → volta ao
// overlay JS (MessageLiftOverlay) com o snapshot `anchor` de sempre.
import { icon } from './nativeNodes';
import { toArgb } from './argb';
import { nativeEmojiPayload } from './nativeEmojiData';
import {
  IconReply, IconCopy, IconStar, IconStarFilled, IconDownload, IconForward, IconMessageSquare,
  IconMail, IconCheck, IconTrash, IconPin, IconStickyNote, IconGlobe, IconSparkles, IconInfo,
  IconEdit, IconAlertTriangle, IconBookmark, IconFileText, IconEyeOff,
} from '../Icons';

export function nativeCtxMenuEnabled() {
  try { return globalThis.__chatyy_native_ctxmenu !== false; } catch { return true; }
}

const _icCache = new Map();
function _ic(Comp) {
  let v = _icCache.get(Comp);
  if (v === undefined) {
    let n = null;
    try { n = icon(Comp, { s: 22, c: '#000000' }); } catch { n = null; }
    v = n && n.ps && n.ps.length ? { vb: n.vb || 24, ps: n.ps } : null;
    _icCache.set(Comp, v);
  }
  return v;
}

function _tf(t, k, fb) {
  try { const v = t ? t(k) : ''; return v && v !== k ? v : fb; } catch { return fb; }
}

function _createdMs(msg) {
  try {
    if (!msg?.created_at) return 0;
    const raw = typeof msg.created_at === 'number'
      ? msg.created_at
      : Date.parse(String(msg.created_at).endsWith('Z') ? msg.created_at : msg.created_at + 'Z');
    return Number.isFinite(raw) ? raw : 0;
  } catch { return 0; }
}

let _emojiSent = false;

/**
 * Monta o payload de showContextMenu. `env` = estado da tela:
 *   t, currentEmail, conversationType, forwardingDisabled, isGroupAdmin,
 *   advPrivOn, pinned, translated, disappearingTimer, e2eEnabled,
 *   isImported(msg), editKind(msg), deleteWindowMs, fmtLeft(ms),
 *   quick [emoji×6], mine (emoji meu nesta msg), isDark, accent
 */
export function buildNativeCtxMenu(key, msg, env) {
  const t = env.t;
  const me = String(env.currentEmail || '').toLowerCase();
  const own = String(msg.sender_email || '').toLowerCase() === me && !!me;
  const ownStrict = msg.sender_email === env.currentEmail; // = condição do JS (comparação exata)
  const deleted = !!msg.deleted_at;
  const A = [];
  const add = (id, title, sf, Comp, o) => { A.push({ id, title: String(title || ''), sf, ic: Comp ? _ic(Comp) : null, ...(o || null) }); };

  // Responder — sempre. Apagada = SÓ "Responder" (= menu JS: "por que você apagou?").
  add('reply', _tf(t, 'chatConv.reply', 'Responder'), 'arrowshape.turn.up.left', IconReply);
  if (!deleted) {
    const content = typeof msg.content === 'string' ? msg.content : '';
    // [2026-10-18 citar-texto] Citar/Copiar só p/ texto de verdade: presente, enquete, contato,
    // figurinha etc. guardam JSON no content (aparecia {"v":1,"gift_id"…} no seletor).
    const _mtype = String(msg.message_type || msg.type || 'text').toLowerCase();
    const _isText = (_mtype === 'text' || _mtype === '') && !/^\s*[{[]/.test(content);
    if (_isText && content.trim().length > 12) add('quote', _tf(t, 'chatConv.quote', 'Citar'), 'text.quote', IconReply);
    if (msg.content && (_isText || ['image', 'video', 'file'].includes(_mtype) && !/^\s*[{[]/.test(content))) add('copy', _tf(t, 'chatConv.copy', 'Copiar'), 'doc.on.doc', IconCopy);
    // Editar (própria, texto/legenda, até 15 min)
    if (ownStrict && typeof msg.id === 'number') {
      let ek = null;
      try { ek = env.editKind ? env.editKind(msg) : null; } catch {}
      if (ek === 'text' || (ek === 'caption' && !env.e2eEnabled)) {
        const ca = msg.created_at;
        const canEdit = ca ? (Date.now() - new Date(String(ca).endsWith('Z') ? ca : ca + 'Z').getTime()) < 15 * 60 * 1000 : true;
        if (canEdit) add('edit', _tf(t, 'chatConv.edit', 'Editar'), 'pencil', IconEdit);
      }
    }
    add(env.pinned ? 'unpin' : 'pin', env.pinned ? _tf(t, 'chatConv.unpinMessage', 'Desafixar') : _tf(t, 'chatConv.pinMessage', 'Fixar'), env.pinned ? 'pin.slash' : 'pin', IconPin);
    if (!(env.forwardingDisabled && !env.isGroupAdmin) && !(env.advPrivOn && !!msg.file_url)) {
      add('forward', _tf(t, 'chatConv.forward', 'Encaminhar'), 'arrowshape.turn.up.right', IconForward);
    }
    if (env.conversationType === 'group' && msg.sender_email && msg.sender_email !== env.currentEmail) {
      add('replyPrivately', _tf(t, 'chatConv.replyPrivately', 'Responder em privado'), 'bubble.left', IconMessageSquare);
    }
    const isVoice = msg.type === 'voice' || msg.type === 'audio';
    if ((msg.content && (msg.type === 'text' || (msg.type === 'image' && msg.content !== msg.file_name))) || (isVoice && msg.file_url)) {
      add('translate', env.translated ? _tf(t, 'chatConv.hideTranslation', 'Ocultar tradução') : _tf(t, 'chatConv.translate', 'Traduzir'), 'globe', IconGlobe);
    }
    // [2026-10-17 voz-wa] transcrição simples (Whisper do servidor, cache por mensagem) = WhatsApp
    if (isVoice && msg.file_url && typeof msg.id === 'number' && !msg._uploading) {
      const hasTx = !!String(msg.transcript || msg.transcription || '').trim();
      if (!hasTx) add('voiceTx', _tf(t, 'chatConv.voiceTranscribe', 'Transcrever'), 'text.quote', IconFileText);
      else if (msg._txHidden) add('voiceTx', _tf(t, 'chatConv.voiceShowTranscript', 'Ver transcrição'), 'text.quote', IconFileText);
      else add('voiceTx', _tf(t, 'chatConv.voiceHideTranscript', 'Ocultar transcrição'), 'eye.slash', IconEyeOff);
    }
    if (isVoice && msg.file_url) add('transcribe', _tf(t, 'chatConv.transcribeSummarize', 'Transcrever + resumir'), 'sparkles', IconSparkles);
    if (ownStrict && typeof msg.id === 'number') add('info', _tf(t, 'chatConv.messageInfo', 'Informações'), 'info.circle', IconInfo);
    add('star', msg.starred ? _tf(t, 'chat.unstar', 'Desfavoritar') : _tf(t, 'chat.star', 'Favoritar'), msg.starred ? 'star.slash' : 'star', msg.starred ? IconStarFilled : IconStar);
  }
  if (!deleted && env.disappearingTimer > 0 && msg.id && typeof msg.id === 'number') {
    add('keep', msg.kept ? _tf(t, 'chatConv.unkeep', 'Remover marcação') : _tf(t, 'chatConv.keep', 'Manter na conversa'), msg.kept ? 'bookmark.slash' : 'bookmark', IconBookmark);
  }
  if (!deleted) {
    add('select', _tf(t, 'chatConv.select', 'Selecionar'), 'checkmark.circle', IconCheck);
    if (!env.advPrivOn && ['sticker', 'gif', 'image', 'video'].includes(msg.type)) {
      add('saveMedia', _tf(t, 'chatConv.saveToGallery', 'Galeria'), 'square.and.arrow.down', IconDownload);
    }
    if (msg.type === 'sticker' && (msg.file_url || String(msg.content || '').startsWith('http'))) {
      add('sticker', _tf(t, 'chat.sticker', 'Figurinha'), 'face.smiling', IconStar);
    }
    if (msg.type === 'image' && msg.file_url && !(msg.is_view_once || msg.view_once || msg.isViewOnce)) {
      add('stickerMaker', _tf(t, 'stickerMaker.createFromImage', 'Criar figurinha'), 'scissors', IconStickyNote);
    }
    const em = String(msg.content || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (em) add('sendEmail', _tf(t, 'chatConv.sendEmail', 'Enviar e-mail'), 'envelope', IconMail);
  }
  if (!deleted && msg.sender_email && msg.sender_email !== env.currentEmail) {
    add('report', _tf(t, 'chat.reportUser', 'Denunciar'), 'exclamationmark.triangle', IconAlertTriangle, { destructive: 1 });
  }
  if (!deleted) {
    add('delete', _tf(t, 'chatConv.delete', 'Apagar'), 'trash', IconTrash, { destructive: 1 });
    let imported = false;
    try { imported = env.isImported ? !!env.isImported(msg) : false; } catch {}
    if (ownStrict && !imported) {
      const cAt = _createdMs(msg);
      if (cAt) {
        const remaining = Math.max(0, (env.deleteWindowMs || 0) - (Date.now() - cAt));
        const del4all = _tf(t, 'chatConv.deleteForEveryone', 'Apagar para todos');
        if (remaining > 0) {
          let ttl = '';
          try { ttl = env.fmtLeft ? env.fmtLeft(remaining) : ''; } catch {}
          add('deleteForAll', del4all, 'trash', IconTrash, { destructive: 1, sub: String(_tf(t, 'chatConv.deleteForAllRemaining', 'Disponível por mais {time}')).replace('{time}', ttl) });
        } else {
          add('deleteForAllExpired', `${del4all} (${_tf(t, 'chatConv.deleteWindowExpiredShort', 'expirado')})`, 'trash', IconTrash, { disabled: 1 });
        }
      }
    }
  }

  // [2026-10-18 wa-parity] lápide: "Apagar para mim" (handleDelete já não oferece "para todos").
  if (deleted) add('delete', _tf(t, 'chatConv.deleteForMe', 'Apagar para mim'), 'trash', IconTrash, { destructive: 1 });

  const dark = !!env.isDark;
  const payload = {
    key: String(key),
    messageId: String(msg.id == null ? '' : msg.id),
    own: own ? 1 : 0,
    showReactions: deleted ? 0 : 1,
    reactions: (env.quick || []).slice(0, 6).map(String),
    mine: String(env.mine || ''),
    actions: A,
    dark: dark ? 1 : 0,
    theme: {
      accent: toArgb(env.accent || '#0A84FF'),
      text: toArgb(dark ? '#FFFFFF' : '#000000'),
      sub: toArgb(dark ? 'rgba(235,235,245,0.6)' : 'rgba(60,60,67,0.6)'),
      destructive: toArgb('#FF3B30'),
      menuBg: toArgb(dark ? 'rgba(30,30,30,0.80)' : 'rgba(255,255,255,0.82)'),
      menuSolid: toArgb(dark ? '#252527' : '#FFFFFF'),
      sep: toArgb(dark ? 'rgba(84,84,88,0.55)' : 'rgba(60,60,67,0.18)'),
      press: toArgb(dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)'),
      reactBg: toArgb(dark ? '#252527' : '#FFFFFF'),
      mineBg: toArgb(dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.08)'),
      dim: toArgb(dark ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.22)'),
      field: toArgb(dark ? 'rgba(118,118,128,0.24)' : 'rgba(118,118,128,0.12)'),
    },
    labels: {
      search: _tf(t, 'chatConv.emojiSearch', 'Buscar emoji'),
      recents: _tf(t, 'chatConv.recents', 'Recentes'),
      noResults: _tf(t, 'chatConv.emojiNoResults', 'Nenhum emoji encontrado'),
      more: _tf(t, 'chatConv.moreReactions', 'Mais reações'),
    },
    recents: (env.recents || []).slice(0, 32).map(String),
  };
  if (!_emojiSent) {
    try { payload.emoji = nativeEmojiPayload(t); _emojiSent = true; } catch {}
  }
  return payload;
}

/** O nativo perdeu o cache (view nova sem emoji) → manda de novo no próximo. */
export function resetNativeEmojiSent() { _emojiSent = false; }

/** Emojis mais usados (MMKV emoji_usage, o mesmo do getQuickReactions). */
export function recentEmojis() {
  try {
    const usage = require('../../services/mmkv').getJSON('emoji_usage');
    if (usage && typeof usage === 'object') {
      return Object.entries(usage).sort((a, b) => b[1] - a[1]).map(([em]) => em).filter(Boolean).slice(0, 32);
    }
  } catch {}
  return [];
}

/**
 * Executa a ação escolhida no menu nativo com os MESMOS handlers do menu JS.
 * H = handlers/estado da tela (montado no bloco _nl do chat-conversation).
 */
export function runNativeCtxAction(action, msg, H) {
  if (!msg) return;
  switch (action) {
    case 'reply': H.handleReply(msg); return;
    case 'quote': {
      // [reply-v2] seletor nativo de trecho; sem suporte/desligado → modal JS
      try { if (H.nativeQuote && H.nativeQuote(msg)) return; } catch {}
      H.setQuoteSelectModal({ msg, draft: '' });
      return;
    }
    case 'copy': H.handleCopyMessage(msg); return;
    case 'edit': H.handleEdit(msg); return;
    case 'pin': case 'unpin': H.handlePinMessage(msg); return;
    case 'forward': H.handleForward(msg); return;
    case 'replyPrivately': _replyPrivately(msg, H); return;
    case 'translate': H.handleTranslate(msg); return;
    case 'transcribe': _transcribe(msg, H); return;
    case 'voiceTx': if (H.transcribeVoice) H.transcribeVoice(msg); return; // [voz-wa]
    case 'info': H.handleMessageInfo(msg); return;
    case 'star': H.handleStarMessage(msg); return;
    case 'keep': {
      const msgId = msg.id;
      const isKept = msg.kept;
      (async () => {
        try {
          await H.api.chatKeepMessage(msgId, !isKept);
          H.setMessages(prev => H.mapKeep(prev, m => m.id === msgId ? { ...m, kept: !isKept } : m));
        } catch {}
      })();
      return;
    }
    case 'select': {
      try { H.Haptics.impactAsync(H.Haptics.ImpactFeedbackStyle.Medium); } catch {}
      H.setSelectionMode(true);
      if (msg.id) H.toggleSelection(msg.id);
      return;
    }
    case 'saveMedia': H.handleSaveMedia(msg); return;
    case 'sticker': {
      const sid = Number(msg.id);
      H.setStickerSheet({ messageId: Number.isFinite(sid) && sid > 0 ? sid : null, url: msg.file_url || msg.content || '' });
      return;
    }
    case 'stickerMaker': {
      const fu = msg.file_url;
      let src = fu;
      try { src = H.api.getMediaUrl ? H.api.getMediaUrl(fu) : fu; } catch {}
      if (src) setTimeout(() => H.setStickerMakerSrc(src), 300);
      return;
    }
    case 'sendEmail': {
      const m = String(msg.content || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      if (m) { try { H.router.push({ pathname: '/compose', params: { to: m[0] } }); } catch {} }
      return;
    }
    case 'report': H.handleReportUser(msg.sender_email, msg.id); return;
    case 'delete': H.handleDelete(msg.id); return;
    case 'deleteForAll': H.handleDelete(msg.id, { forAll: true }); return;
    default:
  }
}

// = onPress inline "Responder em privado" do menu JS (chat-conversation.js).
async function _replyPrivately(srcMsg, H) {
  const { t, api, safeAlert } = H;
  try {
    const previewSource = (() => {
      const c = String(srcMsg.content || '').trim();
      if (c) return c.slice(0, 240);
      if (srcMsg.type === 'image') return t('chatConv.photo') || 'Foto';
      if (srcMsg.type === 'video') return t('chatConv.video') || 'Vídeo';
      if (srcMsg.type === 'audio') return t('chatConv.audio') || 'Áudio';
      if (srcMsg.type === 'voice') return t('chatConv.audio') || 'Áudio';
      if (srcMsg.type === 'file') return srcMsg.file_name || (t('chatConv.file') || 'Arquivo');
      if (srcMsg.type === 'gif') return t('chatConv.gif') || 'GIF';
      if (srcMsg.type === 'sticker') return t('chatConv.sticker') || 'Figurinha';
      if (srcMsg.type === 'location') return t('chatConv.location') || 'Localização';
      if (srcMsg.type === 'contact') return t('chatConv.contact') || 'Contato';
      return '';
    })();
    const payload = {
      sender_email: srcMsg.sender_email,
      sender_name: srcMsg.sender_name || H.emailToDisplayName(srcMsg.sender_email),
      content: previewSource,
      quoteText: previewSource,
      type: srcMsg.type || 'text',
      // [responder-privado 2026-10-15] origem → servidor monta a citação cruzada (membro + visível)
      ...(require('../../utils/privateReplyQuote').extSourceOf(srcMsg, H.conversationId)),
    };
    let newId = null;
    try {
      const se = String(srcMsg.sender_email || '').toLowerCase();
      const cl = await api.chatConversations();
      const convs = Array.isArray(cl?.data) ? cl.data : (cl?.data?.conversations || []);
      const hit = se && convs.find(c => c && c.type === 'direct'
        && [c.other_email, c.contact_email].some(e => String(e || '').toLowerCase() === se));
      if (hit?.id) newId = hit.id;
    } catch {}
    if (!newId) {
      const r = await api.chatCreate([srcMsg.sender_email], '', 'direct');
      newId = r?.data?.id || r?.data?.conversation_id;
    }
    if (!newId) {
      safeAlert(t('common.error') || 'Erro', t('chatConv.replyPrivatelyFailed') || 'Não foi possível abrir a conversa.');
      return;
    }
    require('../../services/openConversation').openConversation({
      pathname: '/chat-conversation',
      params: {
        id: newId,
        email: srcMsg.sender_email,
        name: payload.sender_name,
        replyTo: encodeURIComponent(JSON.stringify(payload)),
      },
    }, { replace: true });
  } catch (e) {
    safeAlert(t('common.error') || 'Erro', String(e?.message || e));
  }
}

// = onPress inline "Transcrever + resumir" do menu JS.
async function _transcribe(targetMsg, H) {
  const { t, api, safeAlert, mt } = H;
  try {
    const { canUseFeature, trackFeatureUsage, getUpsellMessage } = require('../../services/premium');
    const check = await canUseFeature('ai_transcribe');
    if (!check.allowed) { safeAlert(require('../../services/brandPlan').PLAN_NAME, getUpsellMessage('ai_transcribe', t)); return; }
    trackFeatureUsage('ai_transcribe');
  } catch {}
  if (!targetMsg?.file_url) return;
  const FS = require('expo-file-system/legacy');
  const localFile = FS.cacheDirectory + 'ai_transcribe_' + Date.now() + '.m4a';
  let dlUri = null;
  const setTx = (v) => { if (H.mountedRef.current) H.setAudioTranscription(v); };
  try {
    const fileUrl = api.getMediaUrl ? api.getMediaUrl(targetMsg.file_url) : targetMsg.file_url;
    const dl = await FS.downloadAsync(fileUrl, localFile);
    if (!H.mountedRef.current) return;
    if (dl.status !== 200) { setTx({ error: 'Falha no download' }); return; }
    dlUri = dl.uri;
    setTx({ loading: true });
    const r = await api.aiTranscribeAudio(dl.uri);
    if (!H.mountedRef.current) return;
    if (r?.success && r.data?.text) {
      const sumRes = await api.aiSummarizeAudio(r.data.text);
      if (!H.mountedRef.current) return;
      setTx({
        text: r.data.text,
        summary: sumRes?.data?.summary || '',
        keyPoints: sumRes?.data?.key_points || [],
        sentiment: sumRes?.data?.sentiment || '',
      });
    } else {
      setTx({ error: r?.message || mt('chatConv.transcribeFailed', 'Falha na transcrição') });
    }
  } catch (e) {
    setTx({ error: e?.message || 'Erro' });
  } finally {
    if (dlUri) { try { await FS.deleteAsync(dlUri, { idempotent: true }); } catch {} }
  }
}
