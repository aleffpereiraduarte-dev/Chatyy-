// [2026-10-11 qa-sweep2] Humanize server-written group system rows.
//
// chat.php stores group events as ready-made pt-BR sentences prefixed with the
// actor's chatDisplayName() — e.g. `apitest criou o grupo "X"`. Shown raw, the
// author saw their own handle ("apitest criou o grupo") where WhatsApp says
// "Você criou o grupo", and non-Portuguese users saw Portuguese. This parses the
// known templates and re-renders them through i18n, swapping the actor/target
// for "Você"/"você" when it is the current user. Unknown text is returned as-is.
//
// opts: { t, myNames: string[] (display names/handles that mean "me"),
//         senderEmail, myEmail, formatName?: (name) => string }

const Q = '["“”]';
// Order matters: more specific templates first.
const PATTERNS = [
  ['createdGroup', new RegExp(`^(.+?) criou o grupo ${Q}([\\s\\S]*)${Q}$`), ['actor', 'name']],
  ['createdChannel', new RegExp(`^(.+?) criou o canal ${Q}([\\s\\S]*)${Q}$`), ['actor', 'name']],
  ['renamedGroup', new RegExp(`^(.+?) mudou o nome do grupo para ${Q}([\\s\\S]*)${Q}$`), ['actor', 'name']],
  ['changedDescription', /^(.+?) alterou a descrição do grupo$/, ['actor']],
  ['changedPhoto', /^(.+?) alterou a foto do grupo$/, ['actor']],
  ['onlyAdminsSend', /^(.+?) alterou as configurações: só admins podem enviar mensagens$/, ['actor']],
  ['allMembersSend', /^(.+?) alterou as configurações: todos os membros podem enviar mensagens$/, ['actor']],
  ['approvalOn', /^(.+?) ativou a aprovação de novos membros\.?$/, ['actor']],
  ['approvalOff', /^(.+?) desativou a aprovação de novos membros\.?$/, ['actor']],
  ['slowModeOff', /^(.+?) desativou o modo lento\.?$/, ['actor']],
  ['disappearingOn', /^(.+?) ativou as mensagens temporárias\. Novas mensagens desaparecem após (.+?)\.?$/, ['actor', 'duration']],
  ['disappearingOff', /^(.+?) desativou as mensagens temporárias\.?$/, ['actor']],
  ['removedAdmin', /^(.+?) removeu (.+?) como admin$/, ['actor', 'target']],
  ['madeAdmin', /^(.+?) tornou (.+?) admin$/, ['actor', 'target']],
  ['transferredOwner', /^(.+?) transferiu a posse do grupo para (.+)$/, ['actor', 'target']],
  ['added', /^(.+?) adicionou (.+)$/, ['actor', 'target']],
  ['removed', /^(.+?) removeu (.+)$/, ['actor', 'target']],
  ['joinedViaLink', /^(.+?) entrou pelo link de convite$/, ['actor']],
  ['joined', /^(.+?) entrou no grupo$/, ['actor']],
  ['left', /^(.+?) saiu do grupo$/, ['actor']],
  ['screenshot', /^(.+?) fez uma captura de tela$/, ['actor']],
  ['pinnedMessage', new RegExp(`^(.+?) fixou uma mensagem: ${Q}([\\s\\S]*)${Q}$`), ['actor', 'preview']],
  ['unpinnedMessage', new RegExp(`^(.+?) desafixou uma mensagem: ${Q}([\\s\\S]*)${Q}$`), ['actor', 'preview']],
];

const DURATIONS = {
  '5 minutos': 'chat.sys.dur5m', '1 hora': 'chat.sys.dur1h', '24 horas': 'chat.sys.dur24h',
  '7 dias': 'chat.sys.dur7d', '30 dias': 'chat.sys.dur30d', '90 dias': 'chat.sys.dur90d',
};

function norm(s) { return String(s || '').trim().toLowerCase(); }

export function humanizeSystemText(content, opts = {}) {
  if (typeof content !== 'string' || !content) return content;
  const { t, senderEmail, myEmail } = opts;
  if (typeof t !== 'function') return content;
  const text = content.trim();
  const mine = new Set((opts.myNames || []).map(norm).filter(Boolean));
  const meEmail = norm(myEmail);
  if (meEmail) { mine.add(meEmail); mine.add(meEmail.split('@')[0]); }
  const isMe = (name) => mine.has(norm(name));

  // Legacy client token written by chat_leave.
  if (text.startsWith('__sys.user_left__|')) {
    const who = text.split('|').slice(1).join('|');
    if (isMe(who)) return tr(t, 'chat.sys.left.you', 'Você saiu do grupo', {});
    return (t('chatConv.userLeft') || '{name} saiu do grupo').replace('{name}', who);
  }

  for (const [kind, re, fields] of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const v = {};
    fields.forEach((f, i) => { v[f] = m[i + 1]; });
    // The sender is the actor for every template except "X entrou no grupo",
    // which approve/re-add flows write with the approving admin as sender —
    // there only the name in the sentence can say it was me.
    const actorIsMe = isMe(v.actor) || (kind !== 'joined' && !!senderEmail && !!meEmail && norm(senderEmail) === meEmail);
    const targetIsMe = v.target != null && isMe(v.target);
    if (v.duration && DURATIONS[v.duration]) {
      const d = t(DURATIONS[v.duration]);
      if (d && d !== DURATIONS[v.duration]) v.duration = d;
    }
    const key = `chat.sys.${kind}${actorIsMe ? '.you' : ''}`;
    const fmt = typeof opts.formatName === 'function' ? opts.formatName : (x) => x;
    const out = { name: v.name, actor: fmt(v.actor), target: targetIsMe ? youLower(t) : (v.target != null ? fmt(v.target) : v.target), duration: v.duration, preview: v.preview };
    const s = tr(t, key, null, out);
    return s == null ? content : s;
  }
  return content;
}

function youLower(t) {
  const y = t('chat.sys.youObject');
  return y && y !== 'chat.sys.youObject' ? y : 'você';
}

function tr(t, key, fallback, vars) {
  let s = t(key);
  if (!s || s === key) {
    if (fallback == null) return null;
    s = fallback;
  }
  return s.replace(/\{(\w+)\}/g, (all, k) => (vars[k] != null ? String(vars[k]) : all));
}

export default humanizeSystemText;
