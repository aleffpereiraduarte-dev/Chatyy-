// [reels-v1 2026-10-13] Sinais do Reels → backend (reels_events), em lote.
//
// SÓ comportamento dentro do Reels: tempo assistido / pulo rápido / rever / curtir / salvar /
// compartilhar / comentar / seguir / "não tenho interesse". Nada de conversas ou e-mails.
//
// Fila em memória (máx. 200), flush a cada 8 s, ao juntar 20 eventos ou quando o app vai
// para o fundo. Falha de rede → devolve à fila (até 3 tentativas). Servidor sem o endpoint
// ("Unknown action") → desliga o envio nesta sessão (sem spam de requisições).
import { AppState } from 'react-native';
import * as api from './api';

const MAX_QUEUE = 200;
const BATCH = 40;
const FLUSH_MS = 8000;
let queue = [];
let timer = null;
let flushing = false;
let disabled = false;
let appStateSub = null;
// [guest-reels 2026-10-22] Modo convidado (sem conta): só view/share/not_interested vão, para a
// sessão ANÔNIMA (reels_public_events). Curtir/salvar/seguir/comentar exigem conta → nunca chegam.
let guestMode = false;
const GUEST_TYPES = { view: 1, share: 1, not_interested: 1 };
export function setReelSignalsGuest(on) {
  const next = !!on;
  if (next === guestMode) return;
  queue = []; // não mistura sinais de convidado com os da conta (e vice-versa)
  guestMode = next;
}

function ensureListeners() {
  if (appStateSub) return;
  try {
    appStateSub = AppState.addEventListener('change', (s) => { if (s !== 'active') flushReelSignals(); });
  } catch {}
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flushReelSignals(); }, FLUSH_MS);
}

export function trackReelEvent(postId, type, extra = {}) {
  if (disabled && !guestMode) return;
  const id = Number(postId);
  if (!id || id <= 0 || !type) return;
  if (guestMode && !GUEST_TYPES[type]) return;
  ensureListeners();
  queue.push({ post_id: id, type, ...extra, _try: 0 });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  if (queue.length >= 20) flushReelSignals(); else schedule();
}

// Impressão: chamada quando o reel deixa de ser o ativo (swipe / sair da aba).
// watchMs = tempo efetivamente tocando; durationMs = duração do vídeo (se conhecida).
export function trackReelView(postId, watchMs, durationMs) {
  const w = Math.max(0, Math.round(watchMs || 0));
  if (w < 250) return; // nem chegou a aparecer
  const d = Math.max(0, Math.round(durationMs || 0));
  const replays = d > 0 ? Math.min(20, Math.floor(w / d)) : 0;
  trackReelEvent(postId, 'view', { watch_ms: Math.min(w, 600000), duration_ms: d || undefined, replays });
}

export async function flushReelSignals() {
  if (flushing || (disabled && !guestMode) || queue.length === 0) return;
  flushing = true;
  if (timer) { clearTimeout(timer); timer = null; }
  const batch = queue.splice(0, BATCH);
  const asGuest = guestMode;
  try {
    const r = asGuest
      ? await require('./guestReels').guestReelsEvents(batch.map(({ _try, ...e }) => e))
      : await api.reelsEvents(batch.map(({ _try, ...e }) => e));
    if (asGuest) { if (!r || r.success === false) throw new Error(String(r?.error || 'guest_events_failed')); return; }
    const msg = String(r?.message || r?.error || '');
    if (r && r.success === false && /unknown/i.test(msg)) { disabled = true; queue = []; return; }
    if (!r || r.success === false) throw new Error(msg || 'reels_events_failed');
  } catch {
    if (asGuest !== guestMode) return; // trocou convidado↔conta no meio: descarta (não mistura)
    const retry = batch.filter((e) => (e._try = (e._try || 0) + 1) <= 3);
    queue = retry.concat(queue).slice(-MAX_QUEUE);
  } finally {
    flushing = false;
    if (queue.length && (!disabled || guestMode)) schedule();
  }
}
