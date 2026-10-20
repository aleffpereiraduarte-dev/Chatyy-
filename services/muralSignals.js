// [mural-cerebro 2026-10-20] Sinais do Mural → servidor (mural_events), em lote e barato.
//
// Impressão = post ≥50% na tela por ≥1 s (dwell = tempo visível). Rolou rápido (<0,5 s) = 'skip';
// entre 0,5 e 1 s = 'glance'. Ações da UI (abrir, curtir, comentar, compartilhar, salvar) vão
// junto com o id da sessão do feed (fs) só para o painel A/B — o servidor aprende curtir/comentar/
// salvar pelos próprios endpoints. "Não tenho interesse" / ocultar autor = mural_feedback (na hora).
//
// Fila em memória (máx. 300), flush a cada 10 s, ao juntar 25 eventos ou quando o app vai para o
// fundo. Falha de rede → volta à fila (até 3 tentativas). Servidor sem a ação → desliga na sessão.
// Os dados ficam só no servidor do Chatyy (sem terceiros).
import { AppState } from 'react-native';

const MAX_QUEUE = 300;
const BATCH = 50;
const FLUSH_MS = 10000;
let queue = [];
let timer = null;
let flushing = false;
let disabled = false;
let appSub = null;
const visible = new Map(); // id → { t0, ctx }

function _api() { return require('./api'); }
function _tz() { try { return -new Date().getTimezoneOffset(); } catch { return -180; } }

function ensureListeners() {
  if (appSub) return;
  try {
    appSub = AppState.addEventListener('change', (s) => { if (s !== 'active') { endAllViews(); flushMuralSignals(); } });
  } catch {}
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flushMuralSignals(); }, FLUSH_MS);
}

function push(ev) {
  if (disabled) return;
  ensureListeners();
  queue.push({ ...ev, _try: 0 });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  if (queue.length >= 25) flushMuralSignals(); else schedule();
}

function _ctx(ctx) {
  const o = {};
  if (ctx && ctx.fs && /^[a-z0-9]{6,16}$/.test(String(ctx.fs))) o.fs = String(ctx.fs);
  if (ctx && ctx.tab) o.tab = String(ctx.tab);
  return o;
}

/** Ação da UI sobre um post: open | like | unlike | comment | share | save | unsave | profile_visit */
export function trackMural(postId, type, ctx) {
  const id = Number(postId);
  if (!id || id <= 0 || !type) return;
  push({ p: id, t: type, ..._ctx(ctx) });
}

/** O post ficou ≥50% visível. */
export function muralViewStart(postId, ctx) {
  const id = Number(postId);
  if (!id || id <= 0 || visible.has(id)) return;
  visible.set(id, { t0: Date.now(), ctx: _ctx(ctx) });
}

/** O post saiu (ou a aba/app deixou de estar ativa). */
export function muralViewEnd(postId) {
  const id = Number(postId);
  const v = visible.get(id);
  if (!v) return;
  visible.delete(id);
  const d = Math.max(0, Math.min(600000, Date.now() - v.t0));
  const t = d < 500 ? 'skip' : (d < 1000 ? 'glance' : 'impression');
  push({ p: id, t, d, v: 50, ...v.ctx });
}

export function endAllViews() {
  for (const id of Array.from(visible.keys())) muralViewEnd(id);
}

export async function flushMuralSignals() {
  if (flushing || disabled || queue.length === 0) return;
  flushing = true;
  if (timer) { clearTimeout(timer); timer = null; }
  const batch = queue.splice(0, BATCH);
  try {
    const r = await _api().apiCall('mural_events', { tz: _tz(), events: batch.map(({ _try, ...e }) => e) }, 'POST');
    const msg = String((r && (r.message || r.error)) || '');
    if (r && r.success === false && /unknown/i.test(msg)) { disabled = true; queue = []; return; }
    if (!r || r.success === false) throw new Error(msg || 'mural_events_failed');
  } catch {
    const retry = batch.filter((e) => (e._try = (e._try || 0) + 1) <= 3);
    queue = retry.concat(queue).slice(-MAX_QUEUE);
  } finally {
    flushing = false;
    if (queue.length && !disabled) schedule();
  }
}

// ─── controle do usuário ─────────────────────────────────────────────────────
/** kind: not_interested | hide_author | undo_not_interested | undo_hide_author */
export async function muralFeedback(postId, kind, ctx) {
  try {
    const r = await _api().apiCall('mural_feedback', { id: Number(postId) || 0, kind, ...(ctx && ctx.author ? { author: ctx.author } : null), ..._ctx(ctx) }, 'POST');
    return !!(r && r.success);
  } catch { return false; }
}

export async function muralWhy(postId, ctx) {
  try {
    const r = await _api().apiCall('mural_why', { id: Number(postId) || 0, ..._ctx(ctx) }, 'POST');
    return r && r.success ? r.data : null;
  } catch { return null; }
}

export async function muralPrefsGet() {
  try { const r = await _api().apiCall('mural_prefs', {}, 'POST'); return r && r.success ? r.data : null; } catch { return null; }
}

export async function muralPrefsSet(personalize) {
  try { const r = await _api().apiCall('mural_prefs', { personalize: personalize ? 1 : 0 }, 'POST'); return r && r.success ? r.data : null; } catch { return null; }
}

export async function muralInterestClear() {
  try { const r = await _api().apiCall('mural_interest_clear', {}, 'POST'); return !!(r && r.success); } catch { return false; }
}

/**
 * Texto do "Por que estou vendo isto?" a partir do motivo do servidor (post.rec ou mural_why).
 * rec: { r: author|following|dm|contact|friend_liked|friend_commented|friend_comments|topic|popular|popular_near|explore|new|mine, name?, cat?, n? }
 */
export function whyText(rec, t) {
  const r = (rec && rec.r) || 'new';
  const name = (rec && rec.name) || '';
  const cat = rec && rec.cat ? t(`reels.cat.${rec.cat}`, rec.cat) : '';
  const fill = (s) => String(s).replace('{name}', name).replace('{topic}', cat).replace('{n}', String((rec && rec.n) || ''));
  const map = {
    author: ['mural.why.author', 'Porque você interage com {name}'],
    following: ['mural.why.following', 'Porque você segue {name}'],
    dm: ['mural.why.dm', 'Porque você conversa com {name}'],
    contact: ['mural.why.contact', '{name} está nos seus contatos'],
    friend_liked: ['mural.why.friendLiked', '{name} curtiu esta publicação'],
    friend_commented: ['mural.why.friendCommented', '{name} comentou esta publicação'],
    friend_comments: ['mural.why.friendComments', 'Seus amigos comentaram desde que você viu'],
    topic: ['mural.why.topic', 'Porque você se interessa por {topic}'],
    popular: ['mural.why.popular', 'Popular no Chatyy'],
    popular_near: ['mural.why.popularNear', 'Popular perto de você'],
    explore: ['mural.why.explore', 'Algo novo para você descobrir'],
    new: ['mural.why.new', 'Publicação recente'],
    mine: ['mural.why.mine', 'Sua publicação'],
  };
  const [k, fb] = map[r] || map.new;
  if (!name && ['author', 'following', 'dm', 'contact', 'friend_liked', 'friend_commented'].includes(r)) return fill(t('mural.why.network', 'De alguém da sua rede'));
  if (r === 'topic' && !cat) return t('mural.why.topicGeneric', 'Parecido com o que você curte');
  return fill(t(k, fb));
}
