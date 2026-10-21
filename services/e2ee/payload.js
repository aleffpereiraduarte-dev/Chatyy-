// [e2ee5 WP-09 2026-10-21] Payload interno v1 (CONTRATO §2.3/§2.4) para TODOS os tipos de mensagem
// sob E2EE e a tradução payload decifrado → linha "legada" que os cartões JS e nativos já sabem
// desenhar (content JSON de local/contato/enquete/encontro, _localUri da mídia decifrada, etc.).
//
// Módulo PURO (sem rede, sem núcleo, sem armazenamento): monta e lê objetos. Quem cifra é o
// services/e2ee/e2ee5.js (núcleo chatyy-crypto); quem cifra/decifra arquivos é o e2ee5Media.js.
// Regra do contrato §0.1: campos novos são aditivos; o leitor ignora o que não conhece.
//
// Aditivos desta versão (registrados no CONTRATO 1.4): `batch` (álbum: várias mensagens de 1 envio),
// `M.lqip` (JPEG 40 px em base64 — o LQIP que a bolha pinta antes de baixar; o blurhash continua),
// `contacts[].avatar`, `t:"location_request"`, e os estados por pessoa que viajam como reação
// cifrada de tipo "estado" (`t:"poll_vote"`, `t:"meetup_rsvp"`, `t:"live_loc"`).

export const V = 1;

/** `t` fino → `type` grosso em claro (§2.5). */
export function coarseOf(t) {
  switch (t) {
    case 'image': case 'gif': case 'sticker': return 'image';
    case 'video': return 'video';
    case 'voice': case 'audio': return 'audio';
    case 'file': return 'file';
    default: return 'text';
  }
}

/** Tipo do app (chatSend / fila) → `t` do payload. */
export function fineOfAppType(type) {
  switch (type) {
    case 'image': return 'image';
    case 'gif': return 'gif';
    case 'sticker': case 'lottie_sticker': return 'sticker';
    case 'video': case 'video_note': case 'short_video': return 'video';
    case 'voice': return 'voice';
    case 'audio': return 'audio';
    case 'file': case 'document': return 'file';
    case 'location': case 'live_location': return 'location';
    case 'contact': return 'contact';
    case 'location_request': return 'location_request';
    case 'text': case '': case null: case undefined: return 'text';
    default: return null;
  }
}

const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const _str = (v, max) => (typeof v === 'string' && v ? (max ? v.slice(0, max) : v) : undefined);
function _json(s) {
  if (s && typeof s === 'object') return s;
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  try { const o = JSON.parse(t); return o && typeof o === 'object' ? o : null; } catch (_) { return null; }
}
function _clean(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === '') delete o[k];
  return o;
}

// ───────────────────────────────────────────────────────────── montar (envio)

/**
 * Campos específicos do payload a partir do que o app manda hoje no chat_send (content JSON de
 * local/contato, URL de GIF/figurinha). → {t, ...campos} | null (tipo que não sabemos cifrar).
 * Mídia enviada pelo aparelho NÃO passa aqui (o e2ee5Media monta `media:[M]`).
 */
export function fieldsFromLegacy(type, content, fileUrl) {
  const t = fineOfAppType(type);
  if (!t) return null;
  if (t === 'text') return { t: 'text', body: String(content == null ? '' : content) };
  if (t === 'location') {
    const j = _json(content);
    if (!j) return null;
    const lat = _num(j.latitude != null ? j.latitude : j.lat);
    const lng = _num(j.longitude != null ? j.longitude : j.lng);
    if (lat == null || lng == null) return null;
    const out = { t: 'location', lat, lng };
    const acc = _num(j.accuracy != null ? j.accuracy : j.acc);
    if (acc != null) out.acc = acc;
    const addr = typeof j.address === 'string' ? j.address : (j.address && typeof j.address === 'object' ? [j.address.road, j.address.house_number, j.address.city].filter(Boolean).join(', ') : '');
    if (addr) out.address = addr.slice(0, 300);
    const nm = _str(j.name || j.place_name || (j.label && j.label !== addr ? j.label : ''), 200);
    if (nm && !/^-?\d+\.\d+\s*,\s*-?\d+\.\d+$/.test(nm)) out.name = nm;
    if (j.live) out.live = _clean({ until: _num(j.live_until) || 0, unlimited: j.is_unlimited ? true : undefined });
    return out;
  }
  if (t === 'contact') {
    const j = _json(content);
    if (!j) return null;
    const list = Array.isArray(j.contacts) && j.contacts.length ? j.contacts : [j];
    const contacts = list.slice(0, 5).map((c) => _clean({
      name: _str(c && c.name, 200) || '',
      phones: Array.from(new Set([c && c.phone].concat(Array.isArray(c && c.phones) ? c.phones : []).filter((x) => typeof x === 'string' && x))).slice(0, 6),
      emails: Array.from(new Set([c && c.email].concat(Array.isArray(c && c.emails) ? c.emails : []).filter((x) => typeof x === 'string' && x))).slice(0, 6),
      chatyy: c && c.chatyy ? true : undefined,
      avatar: _str(c && c.avatar, 500),
    })).filter((c) => c.name || (c.phones && c.phones.length) || (c.emails && c.emails.length));
    if (!contacts.length) return null;
    return { t: 'contact', contacts };
  }
  if (t === 'gif' || t === 'sticker') {
    // GIF do seletor (Giphy/Tenor) e figurinha de pacote: referência pública (§2.4 `ref`).
    const url = String(fileUrl || content || '').trim();
    if (!/^https?:\/\//i.test(url) && !/^\/?(data|stickers|public)\//i.test(url)) return null;
    const out = { t, ref: { url } };
    if (type === 'lottie_sticker' || /\.json(\?|#|$)/i.test(url)) out.lottie = true;
    return out;
  }
  if (t === 'location_request') return { t: 'location_request', body: String(content == null ? '' : content).slice(0, 200) };
  return null; // mídia (image/video/voice/audio/file) só pelo e2ee5Media
}

/** Enquete (§2.4 `poll`). options = [string] (2–12). */
export function pollFields(question, options, multi) {
  const opts = (Array.isArray(options) ? options : []).map((o) => String(o == null ? '' : o).trim()).filter(Boolean).slice(0, 12);
  return { t: 'poll', question: String(question || '').slice(0, 300), options: opts.map((text, i) => ({ id: String(i), text: text.slice(0, 100) })), multi: !!multi, anon: false };
}

/** Encontro (§2.4 `meetup`). */
export function meetupFields(title, datetime, location, description, extra) {
  const start = Date.parse(datetime || '') || _num(datetime) || 0;
  const out = { t: 'meetup', title: String(title || '').slice(0, 200), start };
  if (location) out.place = String(location).slice(0, 300);
  if (description) out.desc = String(description).slice(0, 2000);
  if (extra && _num(extra.lat) != null && _num(extra.lng) != null) { out.lat = _num(extra.lat); out.lng = _num(extra.lng); }
  if (extra && _num(extra.end)) out.end = _num(extra.end);
  return out;
}

// ───────────────────────────────────────────────────────────── estados por pessoa (reação "estado")

/** Voto (§2.4 `poll_vote`): option_ids vazio = retirar. */
export function voteFields(pollMid, pollCmid, optionIds) {
  return { t: 'poll_vote', poll_mid: String(pollMid), poll_cmid: String(pollCmid || ''), option_ids: (optionIds || []).map(String) };
}
export function rsvpFields(meetupMid, meetupCmid, status) {
  return { t: 'meetup_rsvp', target_mid: String(meetupMid), target_cmid: String(meetupCmid || ''), status: String(status || '') };
}
export function liveLocFields(targetMid, targetCmid, lat, lng, acc, stopped) {
  const o = { t: 'live_loc', target_mid: String(targetMid), target_cmid: String(targetCmid || ''), lat: _num(lat), lng: _num(lng) };
  if (_num(acc) != null) o.acc = _num(acc);
  if (stopped) o.stopped = true;
  return o;
}
export function reactionFields(targetMid, targetCmid, emoji) {
  return { t: 'reaction', target_mid: String(targetMid), target_cmid: String(targetCmid || ''), emoji: String(emoji || '').slice(0, 16) };
}

// ───────────────────────────────────────────────────────────── waveform (§2.4 voice)

/** [0..1] (gravador do app) → base64 de ≤100 amostras 0–255. */
export function waveformToB64(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return undefined;
  const n = Math.min(100, arr.length);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = Number(arr[Math.floor(i * arr.length / n)]);
    out[i] = Math.max(0, Math.min(255, Math.round((Number.isFinite(v) ? (v > 1 ? v / 255 : v) : 0) * 255)));
  }
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(out[i]);
  try { return (typeof btoa === 'function' ? btoa(s) : global.Buffer.from(s, 'binary').toString('base64')); } catch (_) { return undefined; }
}
/** base64 0–255 → [0..1]. */
export function waveformFromB64(b64) {
  if (typeof b64 !== 'string' || !b64) return undefined;
  let s = '';
  try { s = typeof atob === 'function' ? atob(b64) : global.Buffer.from(b64, 'base64').toString('binary'); } catch (_) { return undefined; }
  const out = [];
  for (let i = 0; i < s.length && i < 100; i++) out.push(Math.round((s.charCodeAt(i) / 255) * 100) / 100);
  return out.length >= 2 ? out : undefined;
}

// ───────────────────────────────────────────────────────────── ler (payload → linha da UI)

export const MEDIA_T = new Set(['image', 'video', 'voice', 'audio', 'file', 'gif', 'sticker']);

/** Objeto de mídia principal (o 1º de `media[]`). */
export function mainMedia(p) { return p && Array.isArray(p.media) && p.media.length ? p.media[0] : null; }
export function thumbOf(M, kind) { return M && Array.isArray(M.thumbs) ? (M.thumbs.find((x) => x && x.kind === kind) || null) : null; }

// Campos que a tradução abaixo pode pôr na linha (o cache de persistência os remove: §WP-08c "caches
// guardam o envelope"). Lista única, usada também por services/e2eeShape.js.
export const DERIVED_KEYS = [
  'latitude', 'longitude', 'address', 'live', 'live_until', 'is_unlimited', 'contact', 'poll', 'meetup',
  'file_name', 'file_size', 'mime_type', 'thumb_b64', 'image_width', 'image_height', 'width', 'height',
  'duration', 'waveform', 'batch_id', 'forward_count', 'effect', 'is_view_once', 'blurhash',
  '_localUri', '_e5LocalUri', '_posterUri', '_e5Media', '_e5Fwd', '_e5MentionAll', '_e5Hidden', '_e5V', '_e5T', '_e5Rx',
];

/**
 * Payload decifrado → campos para sobrepor na linha do servidor (`{...msg, ...campos}`).
 * ctx: { mid, myEmail, media(M) → {uri, poster, thumb, state} (síncrono, cache local),
 *        states: [{email, payload}] (estados decifrados desta mensagem: votos/presença/posição),
 *        emailOfUid(uid) }
 */
export function toRowFields(p, ctx) {
  const c = ctx || {};
  const t = String((p && p.t) || 'text');
  const out = { _e5T: t };
  const me = String(c.myEmail || '').toLowerCase();
  const states = Array.isArray(c.states) ? c.states : [];
  if (typeof p.batch === 'string' && p.batch) out.batch_id = p.batch.slice(0, 64);
  if (p.effect) out.effect = String(p.effect).slice(0, 32);
  if (t === 'text' || t === 'edit') { out.content = typeof p.body === 'string' ? p.body : ''; out.type = 'text'; return out; }
  if (t === 'location_request') { out.type = 'location_request'; out.content = typeof p.body === 'string' ? p.body : ''; return out; }
  if (t === 'location') {
    let lat = _num(p.lat); let lng = _num(p.lng); let upd = null; let stopped = false;
    // posição ao vivo: o último estado `live_loc` do REMETENTE da mensagem
    const own = states.filter((s) => s && s.payload && s.payload.t === 'live_loc' && (!c.senderEmail || String(s.email || '').toLowerCase() === String(c.senderEmail).toLowerCase()));
    if (own.length) {
      const last = own[own.length - 1].payload;
      if (_num(last.lat) != null && _num(last.lng) != null) { lat = _num(last.lat); lng = _num(last.lng); }
      upd = own[own.length - 1].ts || null;
      stopped = !!last.stopped;
    }
    const live = p.live && typeof p.live === 'object';
    const until = live ? (stopped ? Math.floor(Date.now() / 1000) - 1 : (_num(p.live.until) || 0)) : null;
    const legacy = _clean({ latitude: lat, longitude: lng, address: p.address || '', label: p.name || p.address || '', live: live ? true : undefined, live_until: live ? until : undefined, is_unlimited: live && p.live.unlimited && !stopped ? true : undefined, updated_at: upd ? new Date(upd).toISOString() : undefined });
    out.type = 'location';
    out.content = JSON.stringify(legacy);
    out.latitude = lat; out.longitude = lng; out.address = p.address || p.name || '';
    out.live = !!live && !stopped; out.live_until = live ? until : null; out.is_unlimited = !!(live && p.live.unlimited && !stopped);
    return out;
  }
  if (t === 'contact') {
    const list = (Array.isArray(p.contacts) ? p.contacts : []).map((x) => _clean({
      name: x.name || '', phone: (x.phones && x.phones[0]) || '', email: (x.emails && x.emails[0]) || '',
      phones: x.phones && x.phones.length > 1 ? x.phones.slice(0, 6) : undefined, chatyy: x.chatyy ? true : undefined, avatar: x.avatar,
    }));
    if (!list.length) { out.type = 'text'; out.content = ''; return out; }
    const top = { v: 2, ...list[0] };
    if (list.length > 1) top.contacts = list;
    out.type = 'contact';
    out.content = JSON.stringify(top);
    out.contact = top;
    return out;
  }
  if (t === 'poll') {
    const options = (Array.isArray(p.options) ? p.options : []).map((o) => String((o && o.text) != null ? o.text : o));
    const ids = (Array.isArray(p.options) ? p.options : []).map((o, i) => String(o && o.id != null ? o.id : i));
    const counts = options.map(() => 0);
    const mine = [];
    const voters = {};
    // último voto de cada pessoa (o servidor guarda 1 estado por pessoa)
    for (const s of states) {
      if (!s || !s.payload || s.payload.t !== 'poll_vote') continue;
      voters[String(s.email || '').toLowerCase()] = (s.payload.option_ids || []).map(String);
    }
    for (const [em, sel] of Object.entries(voters)) {
      const idxs = [];
      for (const id of sel) { const i = ids.indexOf(id); if (i >= 0 && !idxs.includes(i)) idxs.push(i); }
      const use = p.multi ? idxs : idxs.slice(0, 1);
      for (const i of use) counts[i] += 1;
      if (em && em === me) mine.push(...use);
    }
    const poll = { id: 'e5:' + (c.mid || ''), question: String(p.question || ''), options, multiple_choice: !!p.multi, vote_counts: counts, total_votes: counts.reduce((a, b) => a + b, 0), my_votes: mine, e2e: true };
    out.type = 'poll';
    out.content = JSON.stringify({ question: poll.question, options, multiple_choice: poll.multiple_choice });
    out.poll = poll;
    return out;
  }
  if (t === 'meetup') {
    const rsvp = {};
    for (const s of states) if (s && s.payload && s.payload.t === 'meetup_rsvp' && s.email) rsvp[String(s.email).toLowerCase()] = String(s.payload.status || '');
    for (const k of Object.keys(rsvp)) if (!rsvp[k]) delete rsvp[k];
    const m = _clean({ title: p.title || '', datetime: p.start ? new Date(Number(p.start)).toISOString() : '', location: p.place || ' ', description: p.desc || '', lat: _num(p.lat), lng: _num(p.lng), end: p.end ? new Date(Number(p.end)).toISOString() : undefined });
    m.rsvp = rsvp;
    m.e2e = true;
    // o app procura a minha resposta por e-mail exato → copia também na forma "como está"
    if (me && rsvp[me] != null && c.myEmailRaw && String(c.myEmailRaw) !== me) rsvp[String(c.myEmailRaw)] = rsvp[me];
    out.type = 'meetup';
    out.content = JSON.stringify(m);
    out.meetup = m;
    return out;
  }
  if (MEDIA_T.has(t)) {
    const caption = typeof p.caption === 'string' ? p.caption : '';
    if ((t === 'gif' || t === 'sticker') && p.ref && p.ref.url && !mainMedia(p)) {
      // referência pública (pacote / Giphy / Tenor): o app de hoje já desenha pela URL
      out.type = t === 'gif' ? 'gif' : (p.lottie ? 'lottie_sticker' : 'sticker');
      if (t === 'gif') { out.content = String(p.ref.url); out.file_url = ''; }
      else { out.content = String(p.ref.url); out.file_url = String(p.ref.url); }
      return out;
    }
    const M = mainMedia(p);
    out.content = caption;
    out.file_url = '';
    out._e5Media = { t, url: M ? M.url : '' };
    if (!M) { out.type = t === 'voice' ? 'audio' : t; return out; }
    const loc = typeof c.media === 'function' ? (c.media(M) || {}) : {};
    out.file_name = M.name || (t === 'voice' ? 'voice.m4a' : undefined);
    out.file_size = _num(M.size) || undefined;
    out.mime_type = M.mime || undefined;
    if (M.lqip && typeof M.lqip === 'string' && M.lqip.length < 6000) out.thumb_b64 = M.lqip;
    if (M.blurhash) out.blurhash = String(M.blurhash).slice(0, 100);
    const w = _num(M.w); const h = _num(M.h);
    if (w > 0 && h > 0) { out.image_width = w; out.image_height = h; out.width = w; out.height = h; }
    const dur = _num(M.dur != null ? M.dur : p.dur);
    if (dur > 0) out.duration = Math.round(dur);
    if (t === 'image' || t === 'gif' || t === 'sticker') {
      out.type = t;
      if (loc.uri || loc.thumb) out._localUri = loc.uri || loc.thumb;
    } else if (t === 'video') {
      out.type = p.round ? 'video_note' : 'video';
      if (loc.uri) out._localUri = loc.uri;
      if (loc.poster) out._posterUri = loc.poster;
    } else if (t === 'voice') {
      out.type = 'audio';
      if (!out.file_name || !/voice|ptt|\.(m4a|aac|ogg|opus)$/i.test(out.file_name)) out.file_name = 'voice.m4a';
      const wf = waveformFromB64(M.waveform || p.waveform);
      if (wf) out.waveform = wf;
      if (loc.uri) out._localUri = loc.uri;
    } else {
      out.type = t; // audio | file
      if (loc.uri) out._localUri = loc.uri;
    }
    out._e5Media.state = loc.state || (loc.uri ? 'ready' : 'loading');
    // [WP-17] arquivo decifrado LOCAL (cópia de exibição descartável) p/ transcrição por pedido explícito
    if (loc.uri && (t === 'voice' || t === 'audio' || t === 'video')) out._e5LocalUri = loc.uri;
    return out;
  }
  out.type = 'text';
  out.content = '';
  return out;
}

/** Texto curto da prévia (lista de conversas / citação) por tipo. */
export function previewOf(p, tr) {
  const T = (k, fb) => { try { const v = tr ? tr(k) : null; return typeof v === 'string' && v && v !== k ? v : fb; } catch (_) { return fb; } };
  const t = String((p && p.t) || 'text');
  const cap = p && typeof p.caption === 'string' && p.caption ? ': ' + p.caption.slice(0, 80) : '';
  switch (t) {
    case 'text': case 'edit': return typeof p.body === 'string' ? p.body : '';
    case 'image': return T('chat.photo', 'Foto') + cap;
    case 'gif': return 'GIF';
    case 'sticker': return T('chat.sticker', 'Figurinha');
    case 'video': return (p.round ? T('chat.videoNote', 'Vídeo-recado') : T('chat.video', 'Vídeo')) + cap;
    case 'voice': return T('chat.voiceMessage', 'Mensagem de voz');
    case 'audio': return T('chat.audio', 'Áudio');
    case 'file': { const M = mainMedia(p); return (M && M.name) ? M.name : T('chat.file', 'Arquivo'); }
    case 'location': return p.live ? T('chat.liveLocation', 'Localização em tempo real') : T('chat.location', 'Localização');
    case 'location_request': return T('chat.locationRequest', 'Pediu sua localização');
    case 'contact': { const c = Array.isArray(p.contacts) ? p.contacts : []; return T('chat.contact', 'Contato') + (c[0] && c[0].name ? ': ' + c[0].name : ''); }
    case 'poll': return T('chat.poll', 'Enquete') + (p.question ? ': ' + String(p.question).slice(0, 80) : '');
    case 'meetup': return T('chat.meetup', 'Encontro') + (p.title ? ': ' + String(p.title).slice(0, 80) : '');
    default: return T('e2ee5.msg.generic', 'Mensagem');
  }
}

/** Texto da citação (§2.3 reply.quote ≤ 300) a partir do payload do pai. */
export function quoteOf(p) {
  if (!p) return '';
  if (p.t === 'text' || p.t === 'edit') return typeof p.body === 'string' ? p.body.slice(0, 300) : '';
  if (typeof p.caption === 'string' && p.caption) return p.caption.slice(0, 300);
  return previewOf(p, null).slice(0, 300);
}

// ───────────────────────────────────────────────────────────── D7: cartões de sistema (fora do E2EE, com selo)

/**
 * Jogos, assistir junto e presentes ficam FORA da criptografia (D7) como mensagem `type='system'` gravada
 * pelo SERVIDOR com `content` JSON fixo `{"sys":"<código>", …}` — só ids, números e enums, NUNCA texto
 * livre (a palavra da forca vai como hash). Esta tabela é a lista fechada de campos por código; o cliente
 * descarta o resto e desenha o cartão com o selo "não criptografado" (e2ee5.badge.not_encrypted).
 */
export const SYS_CARDS = {
  call_card: ['call_id', 'call_type', 'call_status', 'call_duration', 'started_at', 'caller_uid'],
  game: ['game_id', 'kind', 'state', 'turn_uid', 'winner_uid', 'score', 'round', 'word_hash', 'word_len', 'started_at'],
  watch_session: ['session_id', 'kind', 'state', 'item_id', 'started_at', 'ended_at', 'host_uid'],
  gift: ['gift_id', 'sku', 'amount', 'currency', 'state', 'to_uid', 'from_uid'],
};
const _SYS_ENUM = /^[a-z0-9_:-]{1,40}$/i;
/** `{"sys":…}` → objeto só com os campos permitidos (números ou enums curtos) | null (não é cartão D7). */
export function sysCardFields(content) {
  const o = _json(content);
  if (!o || typeof o.sys !== 'string' || !SYS_CARDS[o.sys]) return null;
  const out = { sys: o.sys };
  for (const k of SYS_CARDS[o.sys]) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && (_SYS_ENUM.test(v) || (k === 'word_hash' && /^[a-f0-9]{16,64}$/.test(v)) || (/_at$/.test(k) && !isNaN(Date.parse(v))))) out[k] = v;
  }
  out.not_encrypted = true;
  return out;
}
