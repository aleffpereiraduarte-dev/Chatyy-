// components/chatlist/nativeAdapter.js — [2026-10-14 native-home]
//
// Adaptador de dados da lista de conversas NATIVA (modules/expo-chat-conversation-list).
// Converte cada conversa do ChatListTab numa linha PLANA já pronta para desenhar
// (título, prévia sem o emoji-glifo, recibo, hora formatada, avatar/colagem,
// anel de status, digitando, rascunho, rótulo de acessibilidade…) e calcula
// PATCHES incrementais por id — a lista inteira só atravessa a ponte no reset
// (montagem, troca de conta ou pedido de resync do nativo).
//
// Regras de exibição = ConversationRow do ChatListTab.js. A prévia vem da MESMA
// função (_computeRowPreview, injetada via ctx.computePreview) para não divergir.
//
// Patch: { seq, base, reset?: Row[], upsert?: Row[], remove?: id[], order?: id[] }
//   - base = seq do último patch COMMITADO; o nativo confere e pede onResync se
//     perdeu algum (nunca aplica fora de ordem).
//   - order só vai quando a sequência de ids mudou.

// ── avatar (mesmas regras do AvatarCircle.js) ────────────────────────────────

// Mesmo hashInt + 8 gradientes do AvatarCircle (o nativo tem a mesma tabela).
function _hashInt(s) {
  let h = 0;
  const str = s || '';
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
}
const GRADIENT_COUNT = 8;
export function gradientIndex(seed) {
  return _hashInt(String(seed || '').toLowerCase()) % GRADIENT_COUNT;
}

// Cópia do getInitials do AvatarCircle (iniciais seguem o NOME visível).
export function initialsOf(name, email) {
  const _looksLikeEmail = (s) => typeof s === 'string' && /@/.test(s);
  let src = '';
  if (name && typeof name === 'string' && name.trim() && !_looksLikeEmail(name)) src = name.trim();
  else if (typeof email === 'string' && email.includes('@')) src = email.split('@')[0];
  else if (name && typeof name === 'string' && name.trim()) src = name.trim();
  if (!src) return '';
  const parts = src.split(/[\s._\-]+/).filter(Boolean);
  if (parts.length >= 2) return ((parts[0][0] || '') + (parts[1][0] || '')).toUpperCase();
  return ((parts[0] || '').slice(0, 2) || '').toUpperCase();
}

const _EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function _tile(ctx, url, name, email) {
  let u = '';
  let a = false;
  if (url) {
    u = url;
    try {
      const local = ctx.getCachedAvatarUriOrNull ? ctx.getCachedAvatarUriOrNull(url) : null;
      if (local) u = local;
    } catch {}
    if (u === url) {
      try { a = !!(ctx.avatarAuthHeaders && ctx.avatarAuthHeaders(url)); } catch { a = false; }
    }
  }
  const tile = { u, i: initialsOf(name, email), g: gradientIndex(name || email || '') };
  if (a) tile.a = 1;
  return tile;
}

function _directAvatarUrl(ctx, email, name, nofallback) {
  if (!email || !_EMAIL_RE.test(email)) return '';
  if (String(email).toLowerCase() === 'ai@chatyy.com.br') return ''; // Bia: sem get_avatar
  try { return (ctx.buildAvatarUrl && ctx.buildAvatarUrl(email, nofallback ? { name, nofallback: true } : { name })) || ''; } catch { return ''; }
}

function _canonical(ctx, url) {
  if (!url) return '';
  try { return (ctx.canonicalAvatarUrl && ctx.canonicalAvatarUrl(url)) || url; } catch { return url; }
}

// ── glifo da prévia ──────────────────────────────────────────────────────────
// A prévia do JS começa com um emoji (📷 Foto). Regra da casa: nada de emoji
// na UI — o nativo desenha um ícone (SF Symbol / vetor) no lugar.
const PREVIEW_ICONS = {
  '📎': 'paperclip', '📞': 'phone', '📹': 'video',
  '📷': 'camera', '🎬': 'film', '🎥': 'video',
  '🎵': 'music', '🎙': 'mic', '📍': 'pin',
  '👤': 'user', '📊': 'chart', '📅': 'calendar',
  '💫': 'sticker', '📄': 'file', '🎁': 'gift',
};
export function splitPreviewIcon(str) {
  if (typeof str !== 'string' || str.length < 2) return { icon: '', text: typeof str === 'string' ? str : '' };
  const icon = PREVIEW_ICONS[str.slice(0, 2)];
  if (!icon) return { icon: '', text: str };
  return { icon, text: str.slice(2).replace(/^[️\s]+/, '') };
}

// ── textos ───────────────────────────────────────────────────────────────────

function _tx(t, key, fb, params) {
  let r = null;
  try { r = t ? t(key, params) : null; } catch {}
  if (!r || r === key) {
    r = fb;
    if (params && typeof r === 'string') Object.keys(params).forEach(k => { r = r.split(`{${k}}`).join(String(params[k])); });
  }
  return r;
}

/** Rótulos fixos (swipe, menu, acessibilidade) — todos chaves já existentes. */
export function buildLabels(t) {
  return {
    markRead: _tx(t, 'chat.markRead', 'Marcar como lida'),
    markUnread: _tx(t, 'chat.markUnread', 'Marcar como não lida'),
    mute: _tx(t, 'chat.mute', 'Silenciar'),
    unmute: _tx(t, 'chat.unmute', 'Reativar'),
    pin: _tx(t, 'chat.pin', 'Fixar'),
    unpin: _tx(t, 'chat.unpin', 'Desafixar'),
    archive: _tx(t, 'chat.archive', 'Arquivar'),
    unarchive: _tx(t, 'chat.unarchive', 'Desarquivar'),
    delete: _tx(t, 'chat.delete', 'Excluir'),
    email: _tx(t, 'chat.email', 'E-mail'),
    select: _tx(t, 'chat.selectMore', 'Selecionar várias'),
    moreMenu: _tx(t, 'common.more', 'Mais'),
    lockChat: _tx(t, 'chat.lockChat', 'Trancar conversa'),
    unlockChat: _tx(t, 'chat.unlockChat', 'Destrancar conversa'),
    addToList: _tx(t, 'chat.addToList', 'Adicionar à lista'),
    createNewList: _tx(t, 'chat.createNewList', 'Criar nova lista'),
    clearChat: _tx(t, 'chat.clearChat', 'Limpar conversa'),
    report: _tx(t, 'chat.report', 'Denunciar'),
    muteFor8h: _tx(t, 'chatConv.muteFor8h', 'Silenciar por 8 horas'),
    muteFor1w: _tx(t, 'chatConv.muteFor1w', 'Silenciar por 1 semana'),
    muteForever: _tx(t, 'chatConv.muteForever', 'Silenciar sempre'),
    more: _tx(t, 'a11y.moreOptions', 'Mais opções'),
    viewStatus: _tx(t, 'status.ring.viewStatus', 'Ver status'),
    viewPhoto: _tx(t, 'a11y.viewPhoto', 'Ver foto do perfil'),
    a11yOpenHint: _tx(t, 'a11y.openChatHint', 'Toque duas vezes para abrir. Há mais ações disponíveis.'),
    draft: _tx(t, 'chat.draft', 'Rascunho'),
  };
}

function _draftAge(t, editedAt) {
  const ageMs = editedAt ? (Date.now() - editedAt) : null;
  const fresh = ageMs !== null && ageMs < 3600000;
  if (ageMs === null || ageMs < 3600000) return { fresh, label: '' };
  const hours = Math.floor(ageMs / 3600000);
  const pre = (t && t('time.hAgo')) || '';
  const suf = (t && t('time.ago')) || '';
  const _p = pre && pre !== 'time.hAgo' ? pre : '';
  const _s = suf && suf !== 'time.ago' ? suf : '';
  const unit = hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
  return { fresh, label: [_p, unit, _p ? '' : _s].filter(Boolean).join(' ').trim() };
}

function _isOnlineLabel(isOnline, lastSeen) {
  if (isOnline) return true;
  if (lastSeen && typeof lastSeen === 'string') {
    const seen = new Date(lastSeen.endsWith('Z') || lastSeen.includes('+') ? lastSeen : lastSeen + 'Z').getTime();
    if (!isNaN(seen) && (Date.now() - seen) < 60000) return true;
  }
  return false;
}

// ── linha ────────────────────────────────────────────────────────────────────

/**
 * ctx: { me, t, language, computePreview, formatTime, convTitle, normalizeTypers,
 *        emailToDisplayName, getNickname, getRing, buildAvatarUrl, canonicalAvatarUrl,
 *        getCachedAvatarUriOrNull, avatarAuthHeaders, typingUsers, drafts, draftTimes,
 *        presences (Map), socketUp, lockedIds, unlockedIds, selectedIds, selectionMode,
 *        notesMap }
 * Devolve { row, meta } — meta fica só no JS (abrir status/foto pelo avatar).
 */
export function buildRow(conv, ctx) {
  const t = ctx.t;
  const me = ctx.me || '';
  const id = String(conv.id);
  const isGroup = conv.type === 'group';
  const isChannel = conv.type === 'channel';
  const peerRaw = (!isGroup && !isChannel) ? (conv.other_email || conv.contact_email || conv.email || '') : '';
  let nickname = '';
  if (peerRaw && ctx.getNickname) { try { nickname = ctx.getNickname(peerRaw) || ''; } catch {} }
  const isSaved = conv.type === 'saved' || (!!peerRaw && !!me && String(peerRaw).toLowerCase() === me);
  const dn = ctx.emailToDisplayName || ((x) => x);
  const title = isSaved
    ? _tx(t, 'chat.savedMessages', 'Mensagens Salvas')
    : (nickname || ((isGroup || isChannel)
      ? ((ctx.convTitle && ctx.convTitle(conv)) || _tx(t, 'chat.unknown', 'Desconhecido'))
      : dn(conv.display_name || conv.name || _tx(t, 'chat.unknown', 'Desconhecido'))));

  // E-mail do peer para o AVATAR (mesma regra do ConversationRow: confia no servidor).
  let avatarEmail = null;
  if (!isGroup) {
    const serverPeer = conv.other_email || conv.contact_email || conv.peer_email || null;
    if (serverPeer && String(serverPeer).toLowerCase() !== me) avatarEmail = serverPeer;
    else if (me) {
      const m = (conv.members || []).find(x => {
        const e = typeof x === 'string' ? x : (x?.email || '');
        return e && e.toLowerCase() !== me;
      });
      avatarEmail = m ? (typeof m === 'string' ? m : m?.email) : null;
    }
  }
  // E-mail do peer para PRESENÇA/NOTA (mesma regra do renderItem: membros primeiro).
  let presenceEmail = null;
  if (!isGroup) {
    const members = conv.members;
    if (members && members.length) {
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        const e = typeof m === 'string' ? m : (m?.email || '');
        if (e && e.toLowerCase() !== me) { presenceEmail = e; break; }
      }
    }
    presenceEmail = presenceEmail || conv.other_email || conv.contact_email || null;
  }
  let presenceVal = null;
  if (presenceEmail && ctx.presences instanceof Map) presenceVal = ctx.presences.get(presenceEmail);
  const online = !!ctx.socketUp && !!(presenceVal && (presenceVal.status === 'online' || presenceVal === 'online'));
  const lastSeen = (presenceVal && presenceVal.last_seen) || null;

  const unread = Number(conv.unread_count) > 0 ? Number(conv.unread_count) : 0;
  const muted = !!conv.muted;
  const pinned = !!conv.pinned;
  const archived = !!conv.archived;
  // [2026-10-19 core-chat] ids string (linha inserida pelo WS) também batem no Set numérico.
  const _hasId = (set) => !!(set && (set.has(conv.id) || set.has(Number(conv.id)) || set.has(String(conv.id))));
  const locked = _hasId(ctx.lockedIds) && !_hasId(ctx.unlockedIds);
  const lastMsg = conv.last_message;

  // Prévia (mesma função do ConversationRow)
  let preview = '';
  let previewSender = null;
  let statusType = null;
  let previewDeleted = false;
  if (lastMsg && ctx.computePreview) {
    try {
      const r = ctx.computePreview(lastMsg, isGroup, isChannel, me, conv.members) || {};
      preview = r.preview || '';
      previewSender = r.previewSender || null;
      statusType = r.statusType || null;
      previewDeleted = !!r.deleted;
    } catch {}
  }
  const _sp = splitPreviewIcon(preview);
  const text = _sp.text;
  // [wave13-C] apagada → glifo ⊘ "ban" + itálico (binário sem o glifo: só o texto, como antes)
  const icon = previewDeleted ? 'ban' : _sp.icon;

  // Digitando
  const typers = ctx.normalizeTypers ? ctx.normalizeTypers(ctx.typingUsers?.[conv.id]) : [];
  const names = typers.map(e => e.name).filter(Boolean);
  const typingName = names.length
    ? (names.length <= 2
      ? names.join(` ${_tx(t, 'chatConv.typingAnd', 'e')} `)
      : `${names.slice(0, 2).join(', ')} +${names.length - 2}`)
    : null;
  const recording = typers.length > 0 && typers.every(e => e.recording);
  const typing = typingName
    ? `${isGroup ? typingName + ' ' : ''}${recording
      ? _tx(t, 'chat.recordingAudio', 'gravando áudio...')
      : ((isGroup && names.length > 1) ? _tx(t, 'chat.typingMultiple', 'estão digitando...') : _tx(t, 'chat.typing', 'digitando...'))}`
    : '';

  const draftText = (!typingName && ctx.drafts && ctx.drafts[id]) || '';
  const draftInfo = draftText ? _draftAge(t, ctx.draftTimes ? ctx.draftTimes[id] : null) : { fresh: false, label: '' };

  const scheduled = !!(conv.scheduled_at || conv.has_scheduled || conv.scheduled_message
    || (lastMsg && (lastMsg.scheduled_at || lastMsg.is_scheduled)));

  // Anel de status (direct)
  let ring = '';
  const ringEmail = (!isGroup && !isChannel) ? peerRaw : '';
  if (ringEmail && ctx.getRing) {
    let rv = null;
    try { rv = ctx.getRing(ringEmail); } catch {}
    if (rv && rv.count > 0) {
      const n = Math.max(1, Math.min(rv.count, 30));
      let s = '';
      for (let i = 0; i < n; i++) s += (rv.viewed ? !!rv.viewed[i] : !!rv.allViewed) ? '1' : '0';
      ring = s;
    }
  }

  // Avatar
  let tiles = [];
  if (isChannel) {
    tiles = [];
  } else if (isGroup) {
    const photo = conv.avatar_url || conv.avatar || '';
    if (photo) {
      tiles = [_tile(ctx, _canonical(ctx, photo), title, null)];
    } else {
      const mem = (conv.members || []).filter(m => m && (m.email || m.display_name || m.name)).slice(0, 4);
      if (mem.length >= 2) {
        tiles = mem.map((m, idx) => {
          const em = typeof m === 'string' ? m : (m.email || '');
          const nm = typeof m === 'string' ? '' : (m.display_name || m.name || '');
          // [2026-10-16 polish3] meia-fatia (2 membros, ou a 1ª de 3): sem foto o
          // PNG de iniciais do servidor (círculo inteiro) espremia "APQA" → nofallback.
          const _half = mem.length === 2 || (mem.length === 3 && idx === 0);
          const url = (m && m.avatar_url) ? _canonical(ctx, m.avatar_url) : _directAvatarUrl(ctx, em, nm, _half);
          const tl = _tile(ctx, url, nm, em);
          tl.g = gradientIndex(nm || em);
          return tl;
        });
      } else {
        tiles = [_tile(ctx, '', title, null)];
      }
    }
  } else {
    tiles = [_tile(ctx, _directAvatarUrl(ctx, avatarEmail, title), title, avatarEmail)];
    tiles[0].g = gradientIndex(title || avatarEmail || '');
  }

  const noteText = (conv.type === 'direct' && presenceEmail && ctx.notesMap) ? (ctx.notesMap[presenceEmail] || '') : '';
  const activity = (!isGroup && !isChannel && _isOnlineLabel(online, lastSeen)) ? _tx(t, 'chat.online', 'online') : '';

  let time = '';
  if (lastMsg && ctx.formatTime) { try { time = ctx.formatTime(lastMsg.created_at) || ''; } catch {} }

  const receipt = statusType === 'read' ? 3 : statusType === 'delivered' ? 2 : statusType === 'sent' ? 1 : 0;

  // Acessibilidade (= _a11yRowLabel do ConversationRow)
  const parts = [title];
  if (isGroup) parts.push(_tx(t, 'a11y.group', 'Grupo'));
  else if (isChannel) parts.push(_tx(t, 'a11y.channel', 'Canal'));
  else if (online) parts.push(_tx(t, 'a11y.online', 'Online'));
  if (unread === 1) parts.push(_tx(t, 'a11y.unreadOne', '1 mensagem não lida'));
  else if (unread > 1) parts.push(_tx(t, 'a11y.unreadCount', '{n} mensagens não lidas', { n: unread }));
  if (conv.unread_mentions > 0) parts.push(_tx(t, 'a11y.mentioned', 'Você foi mencionado'));
  if (locked) parts.push(_tx(t, 'chat.lockedChat', 'Chat bloqueado'));
  else if (typing) parts.push(typing);
  else if (draftText) parts.push(`${_tx(t, 'chat.draft', 'Rascunho')}: ${draftText}`);
  else if (lastMsg) {
    if (statusType) {
      const st = statusType === 'read' ? _tx(t, 'a11y.msgRead', 'Lida')
        : statusType === 'delivered' ? _tx(t, 'a11y.msgDelivered', 'Entregue')
        : statusType === 'pending' ? _tx(t, 'chat.sending', 'Enviando...')
        : statusType === 'failed' ? _tx(t, 'chat.notSent', 'Não enviada')
        : _tx(t, 'a11y.msgSent', 'Enviada');
      parts.push(`${_tx(t, 'common.you', 'Você')}: ${text}`, st);
    } else if (previewSender) parts.push(`${previewSender}: ${text}`);
    else if (text) parts.push(text);
  }
  if (time) parts.push(time);
  if (scheduled) parts.push(_tx(t, 'a11y.scheduled', 'Mensagem agendada'));
  if (pinned) parts.push(_tx(t, 'a11y.pinned', 'Fixada'));
  if (muted) parts.push(_tx(t, 'a11y.muted', 'Silenciada'));

  const row = {
    id,
    kind: isChannel ? 'channel' : isGroup ? 'group' : isSaved ? 'saved' : 'direct',
    title,
    unread,
    mention: conv.unread_mentions > 0,
    pinned,
    muted,
    archived,
    locked,
    online,
    activity,
    time,
    timeBold: unread > 0 && !muted,
    sender: locked ? '' : (previewSender || ''),
    text: locked ? _tx(t, 'chat.lockedChat', 'Chat bloqueado') : text,
    icon: locked ? '' : icon,
    receipt: locked ? 0 : receipt,
    // [2026-10-17 offline-wa] na fila sem rede: receipt 0 (nunca ✓ falso); o binário
    // novo desenha o relógio por esta chave (binários atuais ignoram chave extra).
    pending: !locked && statusType === 'pending',
    // [2026-10-18 relogio-lista] falha definitiva (bolha "não enviada"): receipt 0 +
    // failed:true — nunca ✓; o glifo ! vermelho nativo depende de build (chave extra
    // é ignorada pelos binários atuais, que mostram sem tique).
    failed: !locked && statusType === 'failed',
    scheduled,
    typing,
    draft: draftText,
    draftLabel: draftText ? _tx(t, 'chat.draft', 'Rascunho') : '',
    draftFresh: draftInfo.fresh,
    draftAge: draftInfo.label,
    note: noteText,
    ring,
    tiles,
    selected: !!(ctx.selectionMode && ctx.selectedIds && ctx.selectedIds.has(conv.id)),
    a11y: parts.filter(Boolean).join(', '),
    empty: _tx(t, 'chat.noMessages', 'Nenhuma mensagem'),
  };
  // Menu do toque longo: trancar (flag do servidor OU id-set local) e bloquear (só direct c/ peer).
  row.lockOn = !!(conv.locked || (ctx.lockedIds && (ctx.lockedIds.has(conv.id) || ctx.lockedIds.has(Number(conv.id)))));
  const blockPeer = (!isGroup && !isChannel && !isSaved) ? peerRaw : '';
  row.blockLabel = blockPeer
    ? `${_tx(t, 'chat.block', 'Bloquear')} ${String(title || blockPeer.split('@')[0]).split(' ')[0]}`.trim()
    : '';
  const meta = { conv, title, avatarEmail, ringEmail, hasRing: !!ring };
  return { row, meta };
}

// ── diff ─────────────────────────────────────────────────────────────────────

function _tilesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i];
    if (x.u !== y.u || x.i !== y.i || x.g !== y.g || !!x.a !== !!y.a) return false;
  }
  return true;
}

export function rowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  for (const k in a) {
    if (k === 'tiles') { if (!_tilesEqual(a.tiles, b.tiles)) return false; continue; }
    if (a[k] !== b[k]) return false;
  }
  for (const k in b) if (!(k in a)) return false;
  return true;
}

/**
 * Patcher com estado: `diff(rows)` devolve { patch, snapshot } SEM mutar nada;
 * `commit(snapshot)` (no useLayoutEffect) marca o que o nativo recebeu. Um render
 * descartado pelo React nunca avança o estado committed.
 */
export function createPatcher() {
  let committed = { seq: 0, byId: new Map(), order: [] };
  let counter = 0;
  let forceReset = true;
  let lastPatch = null;
  let lastSnapshot = null;

  return {
    requestReset() { forceReset = true; },
    get committedSeq() { return committed.seq; },
    diff(rows) {
      const byId = new Map();
      const order = [];
      for (const r of rows) {
        if (!r || !r.id || byId.has(r.id)) continue; // id duplicado → 1ª ocorrência
        byId.set(r.id, r);
        order.push(r.id);
      }
      if (forceReset || committed.seq === 0) {
        counter += 1;
        const patch = { seq: counter, base: committed.seq, reset: order.map(id => byId.get(id)) };
        lastPatch = patch;
        lastSnapshot = { seq: counter, byId, order, reset: true };
        return { patch, snapshot: lastSnapshot };
      }
      const upsert = [];
      for (const id of order) {
        const prev = committed.byId.get(id);
        const next = byId.get(id);
        if (!prev || !rowEqual(prev, next)) upsert.push(next);
      }
      const remove = [];
      for (const id of committed.order) if (!byId.has(id)) remove.push(id);
      let orderChanged = order.length !== committed.order.length;
      if (!orderChanged) {
        for (let i = 0; i < order.length; i++) if (order[i] !== committed.order[i]) { orderChanged = true; break; }
      }
      if (!upsert.length && !remove.length && !orderChanged) {
        // Nada mudou: mesmo objeto → o prop não muda → nada cruza a ponte.
        if (lastPatch && lastSnapshot && lastSnapshot.seq === committed.seq) {
          return { patch: lastPatch, snapshot: lastSnapshot };
        }
      }
      counter += 1;
      const patch = { seq: counter, base: committed.seq };
      if (upsert.length) patch.upsert = upsert;
      if (remove.length) patch.remove = remove;
      if (orderChanged) patch.order = order;
      lastPatch = patch;
      lastSnapshot = { seq: counter, byId, order, reset: false };
      return { patch, snapshot: lastSnapshot };
    },
    commit(snapshot) {
      if (!snapshot || snapshot.seq <= committed.seq) return;
      committed = { seq: snapshot.seq, byId: snapshot.byId, order: snapshot.order };
      if (snapshot.reset) forceReset = false;
    },
  };
}
