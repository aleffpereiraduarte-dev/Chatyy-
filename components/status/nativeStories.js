// [2026-10-15 native-story] Ponte do visualizador de STATUS nativo
// (modules/expo-media-viewer/story.ts → iOS StoryViewerController /
// Android StoryViewerDialog).
//
// Ponto de troca ISOLADO: StoryViewer.js e ChatStatusTab.js chamam
// `tryOpenNativeStories(...)`. Ele só abre o nativo quando:
//   • o binário tem o módulo (build antigo / Expo Go / web → false);
//   • globalThis.__chatyy_native_story !== false (kill switch OTA/console);
//   • TODOS os itens são suportados. Binário apiVersion 1: foto/vídeo/texto
//     simples + legenda, música e link. apiVersion >= 2 (build 2026-10-15b):
//     também enquete (status e figurinha), quiz, pergunta, menção, contagem,
//     slider, GIF, emoji, desenho, texto sobreposto, animação de texto,
//     boomerang e voz — como camada de blocos nativa; toques → onSticker.
//     Placeholders do manifest → visualizador JS atual.
// Se open() falhar, `onFallback()` abre o JS — nada se perde.
//
// Os eventos nativos são ligados às MESMAS APIs do viewer JS: status_view
// (+completed), status_react, status_reply_dm (fila offline), status_viewers,
// status_delete — e aos callbacks do chamador (cache do hook, fechar, etc.).
import { Platform } from 'react-native';
import * as api from '../../services/api';
import { firstLink, itemBg, itemFontStyle, normalizeTextFont, textStatusDurationMs, textStatusSolid, itemTextAlign } from './textStatus';
import { resolveTextGradient } from './textGradients';
import { takeStoryOrigin } from '../../services/storyOrigin'; // [2026-10-16 motion]
import { storyReactionDefs, storyReactionKind, storyReactionsEnabled, isStoryReactionEmoji } from './storyReactions'; // [2026-10-17 status-reacoes]
import { nativeEmojiPayload } from '../chat/nativeEmojiData';

let _NS; // undefined = não resolvido; null = indisponível
function _mod() {
  if (_NS !== undefined) return _NS;
  _NS = null;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    const m = require('../../modules/expo-media-viewer/story');
    const mm = m?.default || m;
    if (mm && typeof mm.isAvailable === 'function' && mm.isAvailable()) _NS = mm;
  } catch { _NS = null; }
  return _NS;
}

export function nativeStoriesAvailable() {
  try { if (globalThis.__chatyy_native_story === false) return false; } catch {}
  return !!_mod();
}

let _apiV; // versão da API do binário (1 = só foto/vídeo/texto simples)
function _api() {
  if (_apiV !== undefined) return _apiV;
  const m = _mod();
  let v = 0;
  try { v = m ? (typeof m.apiVersion === 'function' ? Number(m.apiVersion()) || 1 : 1) : 0; } catch { v = 1; }
  _apiV = v;
  return v;
}

// ─── Normalização ──────────────────────────────────────────────────────────

// [2026-10-17 status-reacoes] fileira rápida/kinds vêm de ./storyReactions
// (kill switch globalThis.__chatyy_story_reactions). Getter: vale no próximo open().
export function nativeStoryReactions() { return storyReactionDefs(); }
const _reactionKind = storyReactionKind;

function _resolveUrl(raw) {
  if (!raw) return '';
  const s = String(raw).split('\n')[0];
  if (/^(https?:|file:|content:|data:)/i.test(s)) return s;
  try { return api.getMediaUrl(s) || ''; } catch { return ''; }
}

let _localUri = null;
try { _localUri = require('../../services/mediaCache').getLocalUriSyncJs; } catch {}
function _local(url) {
  if (!url || !_localUri) return '';
  try { return _localUri(url) || ''; } catch { return ''; }
}

function _avatarFor(email, explicit) {
  if (explicit) return _resolveUrl(explicit);
  if (!email) return '';
  try { return api.getAvatarUrlForEmail?.(email) || ''; } catch { return ''; }
}

function _parseTs(v) {
  if (!v) return NaN;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  let iso = String(v).trim().replace(' ', 'T');
  iso = iso.replace(/([+-]\d{2})$/, '$1:00');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += 'Z';
  return new Date(iso).getTime();
}

function _relTime(createdAt, t) {
  const ms = _parseTs(createdAt);
  if (!Number.isFinite(ms)) return '';
  const h = Math.round((Date.now() - ms) / 3600000);
  if (h < 1) return t?.('time.now') || 'agora';
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function _viewedAt(v) {
  const ms = _parseTs(v);
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function _stickerLists(it) {
  const out = [];
  if (Array.isArray(it?.stickers)) out.push(it.stickers);
  if (Array.isArray(it?.meta?.stickers)) out.push(it.meta.stickers);
  return out;
}

function _linkSticker(it) {
  for (const list of _stickerLists(it)) {
    for (const s of list) {
      if (s && s.type === 'link' && s.url) {
        let url = String(s.url).trim();
        if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
        return { url, label: (s.label && String(s.label).trim()) || '' };
      }
    }
  }
  return null;
}

function _rawMedia(it) {
  const raw = it?.content || '';
  const media = it?.type === 'image' || it?.type === 'video';
  const legacy = media && /^(\/|https?:\/\/)/.test(raw);
  return {
    legacy,
    url: it?.media_url || (legacy ? raw.split('\n')[0] : ''),
    caption: legacy ? (raw.includes('\n') ? raw.split('\n').slice(1).join('\n').trim() : '') : (media ? raw.trim() : ''),
  };
}

const _NONEMPTY = (a) => Array.isArray(a) && a.length > 0;

const _AUDIO_RE = /\.(m4a|mp3|aac|wav|ogg|opus|webm)(\?|$)/i;

function _voiceUrl(it) {
  const t = it?.type;
  if (t === 'image' || t === 'video') return '';
  const raw = String(it?.content || '');
  const url = it?.media_url || (/^(\/|https?:\/\/)/.test(raw) ? raw.split('\n')[0] : '');
  if (!url) return '';
  if (t === 'voice' || t === 'audio' || _AUDIO_RE.test(String(url))) return url;
  return '';
}

function _pollOf(it) {
  const p = it?.poll || it?.meta?.poll;
  return p && Array.isArray(p.options) && p.options.length >= 2 ? p : null;
}

/** Item suportado pelo visualizador nativo? (senão → viewer JS). */
export function isNativeStoryItem(it) {
  if (!it || typeof it !== 'object') return false;
  if (it._placeholder || String(it.id || '').startsWith('__manifest_') || it.id == null || it.id === '') return false;
  const v2 = _api() >= 2;
  const type = it.type;
  if (v2 && (type === 'voice' || type === 'audio' || (type === 'text' && _voiceUrl(it)))) return !!_voiceUrl(it);
  if (v2 && type === 'poll') return !!_pollOf(it);
  if (type !== 'image' && type !== 'video' && type !== 'text') return false;
  const { url } = _rawMedia(it);
  if (type === 'text') {
    if (url) return false; // texto com mídia não-áudio = legado
    if (!v2) {
      const anim = it.text_animation || it.meta?.text_animation;
      if (anim && anim !== 'none') return false;
    }
    if (!String(it.content || '').trim()) return false;
  } else if (!url) {
    return false;
  }
  // apiVersion >= 2: blocos (figurinhas, desenho, texto, GIF, boomerang) são nativos.
  if (v2) return true;
  if (it.is_boomerang || it.meta?.is_boomerang) return false;
  for (const list of _stickerLists(it)) {
    for (const s of list) {
      if (s && s.type && s.type !== 'link') return false; // gif, enquete, pergunta, menção, contagem…
    }
  }
  if (_NONEMPTY(it.draw_paths) || _NONEMPTY(it.meta?.draw_paths)) return false;
  if (_NONEMPTY(it.text_overlays) || _NONEMPTY(it.meta?.text_overlays)) return false;
  return true;
}

export function isNativeStoryGroup(items) {
  return Array.isArray(items) && items.length > 0 && items.every(isNativeStoryItem);
}

let _gifOk = () => true;
try { _gifOk = require('../../hooks/useStatuses').isAllowedGifUrl || _gifOk; } catch {}

function _tt(t, k, fb, p) {
  try { const v = t?.(k, p); return v && v !== k ? v : fb; } catch { return fb; }
}

function _userLocale() {
  try { if (typeof navigator !== 'undefined' && navigator.language) return String(navigator.language); } catch {}
  try {
    const L = require('expo-localization');
    const loc = (L.getLocales?.() || [])[0];
    if (loc?.languageTag) return String(loc.languageTag);
  } catch {}
  return 'pt-BR';
}

function _num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/** Figurinhas/texto/desenho → camada de blocos nativa (apiVersion >= 2). */
function _overlaysFor(it, isSelf, t) {
  const out = [];
  const seen = new Set();
  const hint = _tt(t, 'statusTab.tapToReply', 'Toque para responder');
  for (const list of _stickerLists(it)) {
    for (const s of list) {
      if (!s || typeof s !== 'object') continue;
      const type = s.type || (s.emoji ? 'emoji' : '');
      if (!type || type === 'link') continue;
      const key = `${type}:${s.id || ''}:${s.url || ''}:${s.x || 0}:${s.y || 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const x = _num(s.x);
      const y = _num(s.y);
      const id = String(s.id != null ? s.id : `${type}-${out.length}`);
      if (type === 'gif') {
        if (!s.url || !_gifOk(s.url)) continue;
        const gw = Math.max(1, _num(s.width, 200));
        const gh = Math.max(1, _num(s.height, 200));
        const cap = 220;
        const ratio = gw / gh;
        const w = ratio >= 1 ? Math.min(cap, gw) : Math.min(cap, gw * (cap / gh));
        const h = ratio >= 1 ? Math.min(cap, gh * (cap / gw)) : Math.min(cap, gh);
        out.push({ kind: 'gif', id, x, y, url: String(s.url), w, h });
      } else if (type === 'emoji') {
        if (s.emoji) out.push({ kind: 'emoji', id, x, y, text: String(s.emoji) });
      } else if (type === 'mention') {
        const username = String(s.username || '').replace(/^@/, '');
        if (!username) continue;
        const email = s.email || (username.includes('@') ? username : '');
        out.push({ kind: 'mention', id, x, y, text: `@${username}`, email: String(email || '') });
      } else if (type === 'poll') {
        const opts = [s.optionA, s.optionB].filter(o => o != null && String(o).trim()).map(String);
        if (opts.length < 2) continue;
        out.push({ kind: 'poll', id, x, y, question: String(s.question || ''), options: opts, counts: [], myVote: isSelf ? -2 : -1, correct: -1, votable: !isSelf });
      } else if (type === 'quiz') {
        const opts = (Array.isArray(s.options) ? s.options : []).filter(o => o != null && String(o).trim()).map(String);
        if (opts.length < 2) continue;
        const correct = Math.max(-1, Math.min(opts.length - 1, Math.round(_num(s.correct, -1))));
        out.push({ kind: 'poll', id, x, y, question: String(s.question || ''), options: opts, counts: [], myVote: isSelf ? correct : -1, correct, votable: !isSelf });
      } else if (type === 'question') {
        out.push({ kind: 'question', id, x, y, text: String(s.prompt || s.question || ''), hint, votable: !isSelf });
      } else if (type === 'countdown') {
        const ms = Date.parse(s.targetDate || s.target_date || s.target || '');
        out.push({ kind: 'countdown', id, x, y, text: String(s.label || ''), targetMs: Number.isFinite(ms) ? ms : 0, ended: _tt(t, 'istickers.ended', 'Encerrado') });
      } else if (type === 'slider') {
        out.push({
          kind: 'slider', id, x, y,
          text: String(s.question || _tt(t, 'status.sliderDefaultQuestion', 'Quão concorda?')),
          emoji: String(s.emoji || '\u{1F525}'),
          value: -1,
          avg: typeof s.avg_value === 'number' ? s.avg_value : -1,
          votable: !isSelf,
        });
      }
      // location/outros: já vêm achatados na imagem (estúdio) — ignorados.
    }
  }
  const tl = [];
  if (Array.isArray(it.text_overlays)) tl.push(it.text_overlays);
  if (Array.isArray(it.meta?.text_overlays)) tl.push(it.meta.text_overlays);
  const seenT = new Set();
  for (const list of tl) {
    for (const to of list) {
      if (!to || !to.text) continue;
      const key = `${to.text}:${to.x || 0}:${to.y || 0}`;
      if (seenT.has(key)) continue;
      seenT.add(key);
      out.push({ kind: 'text', x: _num(to.x), y: _num(to.y), text: String(to.text), color: typeof to.color === 'string' ? to.color : '#ffffff' });
    }
  }
  return out;
}

function _pathsFor(it) {
  const lists = [];
  if (Array.isArray(it.draw_paths)) lists.push(it.draw_paths);
  if (Array.isArray(it.meta?.draw_paths)) lists.push(it.meta.draw_paths);
  for (const list of lists) {
    const out = [];
    for (const p of list) {
      if (!p || !Array.isArray(p.points)) continue;
      const pts = [];
      for (const pt of p.points) {
        if (pt && typeof pt.x === 'number' && typeof pt.y === 'number') pts.push(pt.x, pt.y);
      }
      if (pts.length >= 4) out.push({ color: typeof p.color === 'string' ? p.color : '#ffffff', width: 3, points: pts });
    }
    if (out.length) return out; // 1ª fonte não vazia (top-level ou meta)
  }
  return [];
}

function _toNativeItem(it, t, isSelf) {
  const v2 = _api() >= 2;
  const voiceUrl = v2 ? _voiceUrl(it) : '';
  const poll = v2 && it.type === 'poll' ? _pollOf(it) : null;
  const type = voiceUrl ? 'voice' : (it.type === 'video' ? 'video' : (it.type === 'text' || poll) ? 'text' : 'image');
  const { url, caption: mediaCaption } = _rawMedia(it);
  const uri = (type === 'image' || type === 'video') ? _resolveUrl(url) : '';
  const text = type === 'text' && !poll ? String(it.content || '') : '';
  const bgRaw = itemBg(it);
  const grad = type === 'text' ? resolveTextGradient(bgRaw) : null;
  const viewsCount = Math.max(Number(it.views) || 0, Number(it.view_count) || 0, Number(it.views_count) || 0);
  let link = _linkSticker(it);
  if (!link && type === 'text' && text) {
    const u = firstLink(text);
    if (u) link = { url: u, label: '' };
  }
  let caption = voiceUrl ? String(it.content || '').trim() : (mediaCaption || '');
  if (voiceUrl && /^(\/|https?:\/\/)/.test(caption)) caption = caption.split('\n').slice(1).join('\n').trim();
  const musicUrl = voiceUrl ? _resolveUrl(voiceUrl) : (it.music_preview_url ? _resolveUrl(it.music_preview_url) : '');
  const boomerang = v2 && type === 'video' && !!(it.is_boomerang || it.meta?.is_boomerang);
  const out = {
    id: String(it.id),
    type,
    uri,
    localUri: uri ? _local(uri) : '',
    thumb: it.thumbnail_url ? _resolveUrl(it.thumbnail_url) : '',
    text,
    caption,
    bg: (type === 'text' || type === 'voice') ? textStatusSolid(bgRaw) : '#000000',
    bgColors: grad && Array.isArray(grad.colors) ? grad.colors : [],
    font: normalizeTextFont(itemFontStyle(it)),
    align: type === 'text' ? itemTextAlign(it) : 'center', // [status-texto 2026-10-16] binário antigo ignora
    duration: poll ? 10000 : voiceUrl ? 30000 : boomerang ? 7000 : type === 'text' ? textStatusDurationMs(text) : 5000,
    timeLabel: _relTime(it.created_at || it.createdAt, t),
    viewed: !!it.viewed,
    viewsCount,
    myReaction: String(it.my_reaction || it.myReaction || ''),
    music: voiceUrl
      ? { title: '', artist: '', url: musicUrl, startMs: 0 }
      : ((it.music_title || musicUrl) ? {
        title: String(it.music_title || ''),
        artist: String(it.music_artist || ''),
        url: musicUrl,
        startMs: Number(it.music_start_ms) || 0,
      } : null),
    link,
  };
  if (!v2) return out;
  if (type === 'text' && !poll) {
    const anim = String(it.text_animation || it.meta?.text_animation || 'none');
    if (anim === 'fade' || anim === 'bounce' || anim === 'typewriter') out.textAnim = anim;
  }
  if (boomerang) out.loop = true;
  // Tradução da legenda (mesma regra do viewer JS: caption_locale ≠ idioma do aparelho).
  if (caption && type !== 'text') {
    const meta = it.meta || {};
    const capLoc = String(meta.caption_locale || 'pt-BR');
    const userLoc = _userLocale();
    if (capLoc.split('-')[0].toLowerCase() !== userLoc.split('-')[0].toLowerCase()) {
      out.translatable = true;
      const cached = (meta.caption_translations || {})[userLoc];
      if (typeof cached === 'string' && cached.trim()) {
        out.caption = cached;
        out.translated = true;
      }
    }
  }
  const overlays = (type === 'voice') ? [] : _overlaysFor(it, isSelf, t);
  if (poll) {
    const counts = Array.isArray(poll.counts) ? poll.counts.map(n => Number(n) || 0) : [];
    const mv = poll.my_vote;
    overlays.unshift({
      kind: 'poll', id: '__poll', x: -1, y: -1,
      question: String(poll.question || it.content || ''),
      options: poll.options.map(o => String((o && typeof o === 'object') ? (o.text || o.label || '') : o)),
      counts,
      myVote: typeof mv === 'number' ? mv : (isSelf ? -2 : -1),
      correct: -1,
      votable: !isSelf,
    });
  }
  if (overlays.length) out.overlays = overlays;
  if (type === 'image' || type === 'video') {
    const paths = _pathsFor(it);
    if (paths.length) out.paths = paths;
  }
  return out;
}

function _menuFor(group, cb, t) {
  const out = [];
  const v2 = _api() >= 2;
  const translate = v2 ? {
    id: 'translate',
    label: t?.('status.translate') || 'Traduzir',
    labelAlt: t?.('status.original') || 'Ver original',
    itemFlag: 'translatable',
  } : null;
  if (group.isSelf) {
    if (cb.onAddMore) out.push({ id: 'addMore', label: t?.('status.addMore') || 'Adicionar novo' });
    if (cb.onForward) out.push({ id: 'forward', label: t?.('status.forwardStatus') || 'Encaminhar' });
    if (cb.onHighlight) out.push({ id: 'highlight', label: t?.('status.saveToHighlight') || 'Salvar em destaques' });
    if (cb.onStats) out.push({ id: 'stats', label: t?.('status.analytics') || 'Estatísticas' });
    if (cb.onRepost) out.push({ id: 'repost', label: t?.('status.repostAction') || 'Repostar' });
    out.push({ id: 'save', label: t?.('status.saveToGallery') || 'Salvar na galeria' });
    if (translate) out.push(translate);
    out.push({
      id: 'delete',
      label: t?.('common.delete') || 'Excluir',
      destructive: true,
      confirm: t?.('status.deleteConfirm') || 'Apagar este status?',
    });
  } else {
    if (cb.onForward) out.push({ id: 'forward', label: t?.('status.forwardStatus') || 'Encaminhar' });
    if (translate) out.push(translate);
    if (cb.onMute) out.push({ id: 'mute', label: t?.('status.muteAction') || 'Silenciar' });
  }
  return out;
}

/**
 * group (entrada) = { email, name, avatar?, isSelf, items:[item cru do status_list] }
 */
function _toNativeGroup(g, cb, t) {
  const email = String(g.email || g.ownerEmail || '');
  const isSelf = !!g.isSelf;
  const name = String(g.name || g.ownerName || (email.split('@')[0] || ''));
  const out = {
    key: email.toLowerCase() || name,
    owner: { email, name, avatar: _avatarFor(email, g.avatar || g.avatar_url || g.ownerAvatar) },
    isSelf,
    items: (g.items || []).map(it => _toNativeItem(it, t, isSelf)),
  };
  out.menu = _menuFor(out, cb, t);
  return out;
}

function _labels(t) {
  const tt = (k, fb, p) => { try { const v = t?.(k, p); return v && v !== k ? v : fb; } catch { return fb; } };
  return {
    close: tt('common.close', 'Fechar'),
    more: tt('common.more', 'Mais'),
    cancel: tt('common.cancel', 'Cancelar'),
    send: tt('common.send', 'Enviar'),
    like: tt('status.like', 'Curtir'),
    replyTo: tt('nativeStory.replyTo', 'Responder para {name}', { name: '{name}' }),
    // [2026-10-17 status-reacoes] "+" / grade de emojis (apiVersion >= 4)
    moreReactions: tt('chatConv.moreReactions', 'Mais reações'),
    emojiSearch: tt('chatConv.emojiSearch', 'Buscar emoji'),
    emojiNoResults: tt('chatConv.emojiNoResults', 'Nenhum emoji encontrado'),
    replySent: tt('status.replySent', 'Resposta enviada'),
    seenBy: tt('status.seenBy', 'Visualizações'),
    noViews: tt('status.noViewsYet', 'Ninguém viu ainda'),
    viewsOne: tt('status.viewCountOne', '{count} visualização', { count: '{count}' }),
    viewsOther: tt('status.viewCountOther', '{count} visualizações', { count: '{count}' }),
    unavailable: tt('status.unavailable', 'Mídia indisponível'),
    videoUnavailable: tt('status.videoUnavailable', 'Vídeo indisponível'),
    soundOn: tt('nativeStory.soundOn', 'Ativar som'),
    soundOff: tt('nativeStory.soundOff', 'Desativar som'),
    voice: tt('status.voiceStatus', 'Mensagem de voz'),
    answerSent: tt('status.replySent', 'Resposta enviada'),
  };
}

// ─── Ações (mesmas APIs do viewer JS) ─────────────────────────────────────

const _HARD = /not_found|already|duplicate|invalid|permission|forbidden|expired/i;
function _queue(type, params) {
  try {
    const { queueOfflineAction } = require('../../services/offlineCache');
    queueOfflineAction({ type, params });
  } catch {}
}

function _recordView(id, completed) {
  if (!id) return;
  const params = completed ? { status_id: id, completed: true } : { status_id: id };
  try {
    api.statusView(id, !!completed).then((r) => {
      if (r && r.success === false && !_HARD.test(String(r.message || r.error || ''))) _queue('status_view', params);
    }).catch(() => _queue('status_view', params));
  } catch { _queue('status_view', params); }
}

async function _reply(id, text) {
  try {
    const r = await api.statusReplyDM(id, text);
    if (r?.success) return true;
    if (r && r.success === false && /Connection error|Tempo limite excedido|Servidor indisponivel/i.test(String(r.message || ''))) {
      _queue('status_reply_dm', { status_id: id, content: text });
      return true;
    }
    return false;
  } catch {
    _queue('status_reply_dm', { status_id: id, content: text });
    return true;
  }
}

async function _saveToGallery(raw) {
  if (!raw) return false;
  try {
    const ML = (() => { try { return require('expo-media-library'); } catch { return null; } })();
    if (!ML) return false;
    const perm = await ML.requestPermissionsAsync(true);
    if (perm?.status !== 'granted' && perm?.accessPrivileges !== 'all') return false;
    const remote = _resolveUrl(_rawMedia(raw).url);
    if (!remote) return false;
    let src = _local(remote) || remote;
    if (src.startsWith('/')) src = `file://${src}`;
    if (/^https?:/i.test(src)) {
      let FS;
      try { FS = require('expo-file-system/legacy'); } catch { try { FS = require('expo-file-system'); } catch { FS = null; } }
      if (!FS?.downloadAsync) return false;
      const ext = ((src.split('/').pop() || 'file').split('?')[0].split('.').pop() || 'jpg').slice(0, 5);
      const dl = await FS.downloadAsync(src, `${FS.cacheDirectory || ''}chatyy_status_save_${Date.now()}.${ext}`);
      if (!dl?.uri) return false;
      src = dl.uri;
    }
    try { await ML.createAssetAsync(src); return true; } catch {}
    try { await ML.saveToLibraryAsync(src); return true; } catch {}
  } catch {}
  return false;
}

// ─── Sessão ────────────────────────────────────────────────────────────────

let _session = null; // { sid, minSid, subs, raw: Map(id → item cru), cb, t }
let _lastSid = 0; // maior session id nativo já visto (ids crescem por processo)

function _endSession() {
  const s = _session;
  _session = null;
  if (s) { for (const sub of s.subs) { try { sub.remove(); } catch {} } }
}

export function nativeStoriesActive() { return !!_session; }

/** Acrescenta uma pessoa (resposta a onNeedMore ou pré-carga). */
export function appendNativeStoryGroup(group, direction = 'next') {
  const s = _session; const m = _mod();
  if (!s || !m || !group) return;
  if (!isNativeStoryGroup(group.items)) { try { m.setHasMore(direction === 'prev' ? s.hasMoreNext : false, direction === 'prev' ? false : s.hasMorePrev); } catch {} return; }
  for (const it of group.items) s.raw.set(String(it.id), it);
  m.appendGroup(_toNativeGroup(group, s.cb, s.t), direction);
}

export function setNativeStoryHasMore(next, prev) {
  const s = _session; const m = _mod();
  if (!s || !m) return;
  s.hasMoreNext = !!next; s.hasMorePrev = !!prev;
  m.setHasMore(!!next, !!prev);
}

export function closeNativeStories() {
  const m = _mod();
  if (m && _session) m.close();
}

/**
 * Tenta abrir o visualizador nativo. Retorna true se ASSUMIU (o chamador NÃO
 * deve abrir o JS); false → siga com o viewer JS. Se o open nativo falhar
 * depois, `callbacks.onFallback()` é chamado (abra o JS ali).
 *
 * groups: [{ email, name, avatar?, isSelf, items:[itens crus] }]
 * callbacks: { onFallback, onClose(info), onMarkViewed(id), onDelete(id)→Promise,
 *   onReply(rawItem, text)→Promise, onReact(rawItem, emoji)→Promise (opcionais —
 *   sem eles usa status_reply_dm / status_react direto),
 *   onNeedMore(direction)→group|null|Promise, onGroupChange(info), onRepost(rawItem),
 *   onAddMore(), onMute(email), onViewerPress(email),
 *   onForward(rawItem, ownerName), onHighlight(rawItem), onStats(rawItem),
 *   onMentionPress({ email, username }) } — os 4 últimos abrem UI do JS: o
 *   nativo fecha antes (closeThen).
 */
export function tryOpenNativeStories({ groups, startGroup = 0, startItem, t, hasMoreNext = false, hasMorePrev = false, callbacks = {} }) {
  if (!nativeStoriesAvailable()) return false;
  const list = Array.isArray(groups) ? groups.filter(g => g && Array.isArray(g.items) && g.items.length > 0) : [];
  if (!list.length) return false;
  if (!list.every(g => isNativeStoryGroup(g.items))) return false;
  const m = _mod();
  if (!m) return false;
  const cb = callbacks || {};
  const sg = Math.max(0, Math.min(list.length - 1, Number(startGroup) || 0));
  let payload;
  try {
    payload = {
      groups: list.map(g => _toNativeGroup(g, cb, t)),
      startGroup: sg,
      labels: _labels(t),
      reactions: storyReactionDefs(),
      transition: 'cube',
      hasMoreNext: !!hasMoreNext,
      hasMorePrev: !!hasMorePrev,
    };
    if (typeof startItem === 'number' && startItem >= 0) payload.startItem = startItem;
    // [2026-10-17 status-reacoes] apiVersion >= 4: "+" com a grade completa de
    // emojis do app + segurar o coração abre a bolha de reações.
    if (_api() >= 4 && storyReactionsEnabled()) {
      payload.reactionHold = true;
      try { payload.reactionPicker = nativeEmojiPayload(t); } catch {}
    }
  } catch {
    return false;
  }

  _endSession();
  const raw = new Map();
  for (const g of list) for (const it of g.items) raw.set(String(it.id), it);
  const sess = { sid: 0, minSid: _lastSid, subs: [], raw, cb, t, hasMoreNext: !!hasMoreNext, hasMorePrev: !!hasMorePrev, afterClose: null };
  // Ação que abre UI do JS (Modal) por cima: fecha o nativo e roda DEPOIS do
  // onClose (dismiss concluído — no iOS um Modal não apresenta sobre outro
  // controller ainda saindo). Rede de segurança: 900 ms.
  const closeThen = (fn) => {
    let done = false;
    const run = () => { if (done) return; done = true; try { fn(); } catch {} };
    sess.afterClose = run;
    m.close();
    setTimeout(run, 900);
  };
  _session = sess;
  // Antes do open() resolver o id ainda é 0: aceita só ids MAIORES que os já
  // vistos (o onClose "replaced" da sessão anterior não derruba esta).
  const same = (e) => {
    if (_session !== sess || !e) return false;
    const sid = Number(e.session) || 0;
    if (sid > _lastSid) _lastSid = sid;
    return sess.sid ? sid === sess.sid : sid > sess.minSid;
  };
  const on = (name, fn) => sess.subs.push(m.addListener(name, (e) => { if (same(e)) { try { fn(e); } catch {} } }));

  // Lista "Visualizações" (+ contagem real: pelo perfil os itens vêm sem views).
  const viewersLoaded = new Set();
  const loadViewers = async (id, showLoading) => {
    if (showLoading) m.setViewers(id, [], true);
    try {
      const r = await api.statusViewers(id);
      if (_session !== sess) return;
      const d = r?.data || {};
      const viewers = Array.isArray(d.viewers) ? d.viewers : (Array.isArray(d) ? d : []);
      const rows = viewers.map(v => {
        const email = String(v.email || '');
        return {
          email,
          name: String(v.name || email.split('@')[0] || ''),
          avatar: _avatarFor(email, v.avatar_url || v.avatar),
          time: _viewedAt(v.viewed_at),
          reaction: _reactionKind(v.reaction_emoji),
          emoji: String(v.reaction_emoji || ''), // [2026-10-17 status-reacoes] apiVersion >= 4 desenha o emoji real
        };
      });
      viewersLoaded.add(id);
      m.setViewers(id, rows, false);
      const n = Number(d.count ?? d.total ?? rows.length);
      if (Number.isFinite(n) && n > 0) m.updateItem(id, { viewsCount: n });
    } catch {
      if (showLoading && _session === sess) m.setViewers(id, [], false);
    }
  };

  on('onItemShown', (e) => {
    const it = raw.get(String(e.id));
    if (it) it.viewed = true;
    if (e.isSelf) {
      if (!viewersLoaded.has(String(e.id))) loadViewers(String(e.id), false);
      return;
    }
    _recordView(e.id, false);
    try { cb.onMarkViewed?.(e.id); } catch {}
  });
  on('onItemCompleted', (e) => {
    const it = raw.get(String(e.id));
    if (!it || it._native_completed) return;
    it._native_completed = true;
    _recordView(e.id, true);
  });
  on('onGroupChange', (e) => { try { cb.onGroupChange?.(e); } catch {} });
  on('onReply', async (e) => {
    if (cb.onReply) {
      // Chamador (ex.: ChatListTab) já faz API + fila offline.
      try { await cb.onReply(raw.get(String(e.id)) || { id: e.id }, e.text); } catch {}
      return;
    }
    const ok = await _reply(e.id, e.text);
    if (!ok) m.showToast(t?.('status.replyFailed') || 'Não foi possível enviar. Tente de novo.');
  });
  on('onReact', async (e) => {
    if (!isStoryReactionEmoji(e && e.emoji)) return;
    const it = raw.get(String(e.id));
    const prev = it ? String(it.my_reaction || '') : '';
    if (it) it.my_reaction = e.active ? e.emoji : '';
    if (cb.onReact) {
      try { await cb.onReact(it || { id: e.id }, e.emoji); } catch {}
      return;
    }
    try {
      const r = await api.apiCall('status_react', { status_id: e.id, emoji: e.emoji }, 'POST');
      if (!r?.success) {
        // offline/timeout → fila (replay idempotente); erro duro → desfaz
        if (r && r.success === false && /Connection error|Tempo limite excedido|Servidor indisponivel/i.test(String(r.message || ''))) {
          _queue('status_react', { status_id: e.id, emoji: e.emoji });
          return;
        }
        throw new Error(r?.message || 'react_failed');
      }
    } catch {
      if (it) it.my_reaction = prev;
      m.updateItem(String(e.id), { myReaction: prev });
      m.showToast(t?.('status.reactFailed') || 'Reação falhou. Tente de novo.');
    }
  });
  on('onOpenViewers', (e) => {
    const id = String(e.id);
    // Já carregada ao exibir o item → o nativo mostra do cache; recarrega quieto.
    loadViewers(id, !viewersLoaded.has(id));
  });
  on('onViewerPress', (e) => {
    if (!cb.onViewerPress) return;
    m.close();
    setTimeout(() => { try { cb.onViewerPress(e.email); } catch {} }, 250);
  });
  on('onMenu', async (e) => {
    const id = String(e.id);
    const it = raw.get(id);
    switch (e.action) {
      case 'delete': {
        try {
          if (cb.onDelete) await cb.onDelete(id);
          else await api.statusDelete(id);
        } catch {}
        m.removeItem(id);
        break;
      }
      case 'save': {
        const ok = await _saveToGallery(it);
        if (ok) m.showToast(t?.('status.savedToGallery') || 'Salvo na galeria');
        break;
      }
      case 'repost': {
        m.close();
        setTimeout(() => { try { cb.onRepost?.(it); } catch {} }, 250);
        break;
      }
      case 'addMore': {
        m.close();
        setTimeout(() => { try { cb.onAddMore?.(); } catch {} }, 250);
        break;
      }
      case 'mute': {
        try { await cb.onMute?.(e.ownerEmail); } catch {}
        m.showToast(t?.('status.muteSuccess') || 'Silenciado');
        break;
      }
      case 'forward': {
        const owner = (Array.isArray(groups) ? groups : []).find(g => String(g?.email || g?.ownerEmail || '').toLowerCase() === String(e.ownerEmail || '').toLowerCase());
        const ownerName = String(owner?.name || owner?.ownerName || String(e.ownerEmail || '').split('@')[0] || '');
        closeThen(() => cb.onForward?.(it || { id }, ownerName));
        break;
      }
      case 'highlight': {
        closeThen(() => cb.onHighlight?.(it || { id }));
        break;
      }
      case 'stats': {
        closeThen(() => cb.onStats?.(it || { id }));
        break;
      }
      case 'translate': {
        if (!it) break;
        if (it._nt_translated) {
          it._nt_translated = false;
          m.updateItem(id, { caption: String(it._nt_caption_orig || _rawMedia(it).caption || ''), translated: false });
          break;
        }
        if (it._nt_translating) break;
        it._nt_translating = true;
        try {
          const r = await api.apiCall('status_translate_caption', { status_id: id, target_locale: _userLocale() }, 'POST');
          const tr = r?.success && typeof r?.data?.translation === 'string' ? r.data.translation.trim() : '';
          if (_session !== sess) break;
          if (tr) {
            it._nt_caption_orig = _rawMedia(it).caption || '';
            it._nt_translated = true;
            m.updateItem(id, { caption: tr, translated: true });
          } else {
            m.showToast(_tt(t, 'nativeStory.translateFailed', 'Não foi possível traduzir'));
          }
        } catch {
          if (_session === sess) m.showToast(_tt(t, 'nativeStory.translateFailed', 'Não foi possível traduzir'));
        } finally {
          it._nt_translating = false;
        }
        break;
      }
      default: break;
    }
  });
  // Blocos interativos (apiVersion >= 2): enquete/quiz, pergunta, slider, menção.
  on('onSticker', async (e) => {
    const id = String(e.id || '');
    const kind = String(e.kind || '');
    const sid = String(e.stickerId || '');
    if (kind === 'mention') {
      const email = String(e.email || '');
      const username = String(e.text || '').replace(/^@/, '');
      if (!email && !username.includes('@')) return;
      closeThen(() => {
        const target = email || username;
        if (cb.onMentionPress) { cb.onMentionPress({ email: target, username }); return; }
        try { require('expo-router').router.push(`/u/${encodeURIComponent(target)}`); } catch {}
      });
      return;
    }
    if (!id) return;
    try {
      if (kind === 'poll' || kind === 'quiz') {
        // Só a enquete do STATUS (type 'poll') tem votação no servidor;
        // figurinha de enquete/quiz fica local (o nativo já marcou a escolha).
        if (sid !== '__poll') return;
        const r = await api.statusPollVote(id, Number(e.index) || 0);
        const d = r?.data || {};
        if (_session !== sess) return;
        if (r?.success && Array.isArray(d.counts)) {
          m.updateItem(id, { overlay: { id: sid, counts: d.counts.map(n => Number(n) || 0), myVote: Number(d.option_index ?? e.index) } });
          const it = raw.get(id);
          const p = it && (it.poll || it.meta?.poll);
          if (p) { p.counts = d.counts; p.my_vote = Number(d.option_index ?? e.index); }
        }
      } else if (kind === 'slider') {
        const r = await api.statusSliderVote(id, Number(e.value) || 0, sid);
        const avg = Number(r?.data?.avg_value ?? r?.data?.avg);
        if (_session === sess && r?.success && Number.isFinite(avg)) m.updateItem(id, { overlay: { id: sid, avg } });
      } else if (kind === 'question') {
        const text = String(e.text || '').trim();
        if (!text) return;
        const r = await api.statusQuestionAnswer(id, text, sid);
        if (_session === sess && r && r.success === false) m.showToast(t?.('status.replyFailed') || 'Não foi possível enviar. Tente de novo.');
      }
    } catch {
      if (kind === 'question' && _session === sess) m.showToast(t?.('status.replyFailed') || 'Não foi possível enviar. Tente de novo.');
    }
  });
  on('onNeedMore', async (e) => {
    const dir = e.direction === 'prev' ? 'prev' : 'next';
    let g = null;
    try { g = cb.onNeedMore ? await cb.onNeedMore(dir) : null; } catch { g = null; }
    if (_session !== sess) return;
    if (g && isNativeStoryGroup(g.items)) {
      appendNativeStoryGroup(g, dir);
    } else if (dir === 'next') {
      setNativeStoryHasMore(false, sess.hasMorePrev);
    } else {
      setNativeStoryHasMore(sess.hasMoreNext, false);
    }
  });
  on('onClose', (e) => {
    const after = sess.afterClose;
    sess.afterClose = null;
    _endSession();
    try { cb.onClose?.(e); } catch {}
    if (after) setTimeout(after, 60);
  });

  const doOpen = (rect) => {
    if (_session !== sess) return;
    // [2026-10-16 motion] cresce do anel tocado (nativo apiVersion >= 3)
    if (rect) payload.originRect = rect;
    m.open(payload).then((sid) => {
      if (_session !== sess) return;
      if (!sid) {
        _endSession();
        try { cb.onFallback?.(); } catch {}
        return;
      }
      sess.sid = sid;
      if (sid > _lastSid) _lastSid = sid;
    }).catch(() => {
      if (_session !== sess) return;
      _endSession();
      try { cb.onFallback?.(); } catch {}
    });
  };
  let origin = null;
  try { const g0 = list[sg]; origin = takeStoryOrigin(g0 && (g0.email || g0.ownerEmail)); } catch { origin = null; }
  if (origin && typeof origin.then === 'function') origin.then((r) => doOpen(r || null), () => doOpen(null));
  else doOpen(null);
  return true;
}
