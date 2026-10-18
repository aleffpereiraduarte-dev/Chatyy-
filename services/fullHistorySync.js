// services/fullHistorySync.js
//
// WhatsApp-grade "tudo fica no celular" bootstrap.
//
// Goal: once per (user, device) after first login, walk EVERY conversation
// the user belongs to and download EVERY message into local SQLite. After
// the bootstrap completes for a given conversation, opening that chat is
// pure SQLite — no network call, works offline, scrolling up never blocks.
//
// Subsequent runs are incremental: WS push, deltaSync via `chat_sync` (pts),
// and the per-conv `since_id` watermark inside chat_messages handle steady
// state. The bootstrap NEVER runs again for a conversation once its
// `fully_synced` flag flips in sync_state.
//
// Storage of progress flags piggybacks on the existing `sync_state` key/value
// table — no schema migration required, OTA-shippable.
//
//   sync_state key                          | value
//   ────────────────────────────────────────┼──────────────────────────────
//   chat_full_bootstrap:<email>             | 'started' | 'done' | iso
//   chat_full_bar_shown:<email>             | '1' once the user saw the bar
//                                           |  (any cold start). Prevents the
//                                           |  "Sincronizando histórico" pill
//                                           |  from reappearing every launch
//                                           |  when the loop got interrupted
//                                           |  (background, kill, timeout).
//                                           |  Bootstrap still runs silently
//                                           |  to fill missing convs.
//   chat_full_synced:<convId>               | '1' when conv reached its tail
//   chat_full_oldest:<convId>               | smallest msg id we've stored
//
// Per-conv loop:
//   1. Read `oldest` watermark for this conv (or pick min(id) from messages
//      table). If unset, start from "newest first" (before_id = null).
//   2. Call chat_messages(convId, limit=200, before_id=oldest). Save rows
//      to SQLite via existing chatCache.cacheMessages.
//   3. If response has < 200 rows OR no rows → this conv has reached its
//      tail. Flip `chat_full_synced:<convId>` to '1', emit per-conv done.
//   4. Otherwise update `chat_full_oldest:<convId>` to the new minimum id
//      and loop with a 100ms throttle.
//
// Concurrency / pacing:
//   - 1 conv at a time (serialized via internal queue).
//   - 200 msgs/page (backend cap is 100 — we send 100 and let server clamp).
//   - 100ms gap between pages so the UI thread breathes.
//   - Pauses while AppState is 'background'; resumes on 'active'.
//   - Pauses if battery <20% (best-effort via expo-battery; silent skip if
//     module not installed). Resumes on charging or battery >25%.
//   - Single-flight: only one bootstrap loop per process.
//
// Progress emission:
//   `EventBus.emit('chat:bootstrap:progress', {
//       phase: 'start' | 'conv' | 'done',
//       convDone, convTotal, currentConvId, currentConvName
//   })`
//   SyncBar mirrors via the `mailWs` event bus so the chat list paints a
//   thin progress strip while it runs.

// ─── [2026-10-18 bg-sync] Nível WhatsApp: 2 passadas, sempre em 2º plano ───
// Antes: 1 passada que drenava o histórico INTEIRO de cada conversa (1000
// páginas × 100) uma conversa por vez, na ordem do servidor, com o título da
// home virando "Baixando conversas 37%" e, no login, um modal "Baixar
// histórico completo" com cartão de progresso em tela cheia. A conversa nº 30
// só recebia alguma coisa depois das 29 anteriores terem baixado TUDO.
// Agora:
//   Passada A "recentes" — conversas na ordem da lista (mais recente 1º,
//     arquivadas por último), as últimas RECENT_PER_CONV mensagens de cada uma,
//     2 em paralelo (1 em enlace lento), pausa enquanto o usuário rola/digita,
//     sem rede ou em 2º plano. Progresso por conversa em sync_state
//     (`chat_recent_synced:<id>`) → app morto retoma de onde parou. É a única
//     fase com indicador (pílula discreta "Sincronizando mensagens…" no topo da
//     lista — components/BackgroundSyncPill), nunca bloqueante.
//   Passada B "profunda" — o drain antigo (até o início do histórico), em
//     silêncio, SÓ em Wi-Fi não tarifado (ou force do Ajustes), também pausando
//     com interação/bateria baixa. Fora do Wi-Fi para e volta quando o Wi-Fi
//     voltar (listener de rede). Histórico antigo de uma conversa aberta já vem
//     sob demanda (chat-conversation: before_id ao rolar p/ cima).
//   Gravação SÓ do que falta (dbExistingMessageIds): página de fundo nunca
//   substitui linha mais nova vinda do WS / recibo / local_path / envio
//   confirmado → sem duplicata e sem regressão quando página e WS se cruzam.
// Kill switch: globalThis.__chatyy_bg_history = false → comportamento antigo
// (só a passada profunda, sem gate de Wi-Fi).
import { Platform, AppState } from 'react-native';
import * as localDb from './localDb';
import { cacheMessages } from './chatCache';

let mailWs = null;
try { mailWs = require('./websocket').default; } catch {}

// ─── Tunables ──────────────────────────────────────────────────────────────
const PAGE_SIZE = 100;            // server clamps to min(100, limit)
const PAGE_DELAY_MS = 100;        // gap between pages of the same conv
const CONV_DELAY_MS = 200;        // gap between conversations
const MAX_PAGES_PER_CONV = 1000;  // 1000 × 100 = 100k msg ceiling per conv
const MAX_RUNTIME_MS = 30 * 60 * 1000; // 30min cap per bootstrap session
const RESUME_POLL_MS = 5000;      // re-check battery/AppState every 5s while paused
// [2026-10-18 bg-sync] passada A
const RECENT_PER_CONV = 50;       // últimas N msgs por conversa na 1ª passada
const RECENT_CONCURRENCY = 2;     // conversas em paralelo (1 em enlace lento)
const RECENT_GAP_MS = 120;        // folga entre conversas de um mesmo worker
const RECENT_MEDIA_TOP = 15;      // só as N conversas do topo pré-baixam mídia (política auto-DL)
const ACTIVE_WINDOW_MS = 2500;    // interação mais recente que isso → pausa
const ACTIVE_POLL_MS = 700;
const OFFLINE_POLL_MS = 4000;

function _bgOn() { return globalThis.__chatyy_bg_history !== false; }

// ─── State ─────────────────────────────────────────────────────────────────
let _running = false;             // true while loop is in flight
let _abort = false;               // set on logout / clear to stop loop
let _pausedReason = null;         // 'background' | 'battery' | null
let _startedAt = 0;
let _resumeWaiters = [];          // promises waiting for unpause
let _silent = false;              // true once the bar has been shown once
                                  // (set per-process, seeded from sync_state)
let _forceAllMedia = false;       // when true, media prefetch bypasses the
                                  // per-bucket auto-DL gate (user explicitly
                                  // pressed "Baixar tudo agora")
// [2026-10-18 bg-sync] progresso da passada A (pílula discreta da home).
let _recent = { running: false, done: 0, total: 0, at: 0 };
const _recentListeners = new Set();
function _setRecent(p) {
  _recent = { ..._recent, ...p, at: Date.now() };
  _recentListeners.forEach((fn) => { try { fn(_recent); } catch {} });
}
/** Assina o progresso da 1ª passada ({running, done, total}). Retorna unsubscribe. */
export function subscribeRecentSync(fn) {
  if (typeof fn !== 'function') return () => {};
  _recentListeners.add(fn);
  return () => { _recentListeners.delete(fn); };
}
export function getRecentSyncProgress() { return _recent; }
let _deferredFor = '';           // conta cuja passada profunda ficou esperando Wi-Fi
let _deferredAt = 0;
const DEFERRED_RECHECK_MS = 10 * 60 * 1000;
let _lastArgs = null;             // { apiCall, email } p/ re-armar no Wi-Fi / volta
let _netSub = null;
let _netWasUnmetered = false;
let _lastProgress = {             // mirror of the last progress payload —
  phase: 'idle',                  // exposed via getBootstrapProgress() so
  convDone: 0,                    // late mounters (Settings → Storage)
  convTotal: 0,                   // can render the current state without
  msgsLoaded: 0,                  // waiting for the next emit.
  mediaLoaded: 0,
};

// ─── Public ────────────────────────────────────────────────────────────────

/**
 * Top-level entry. Idempotent — safe to call from chat.js mount + AppState
 * → 'active' resume. No-op if:
 *   - web (no SQLite)
 *   - already running in this process
 *   - bootstrap key `chat_full_bootstrap:<email>` says 'done'
 *
 * `opts.force` (boolean) bypasses the gate so the user can re-trigger from
 * Settings → Storage → "Baixar histórico completo". Also flips the
 * media-policy override so EVERY media gets pulled to disk regardless of
 * cellular gate, photos-on-wifi-only etc. — WhatsApp-grade restore.
 */
export async function bootstrapFullHistoryOnce(apiCall, email, opts = {}) {
  if (Platform.OS === 'web') return { skipped: 'web' };
  if (!apiCall || !email) return { skipped: 'no_api_or_email' };
  if (_running) return { skipped: 'already_running' };

  const emailLc = email.toLowerCase();
  const gateKey = `chat_full_bootstrap:${emailLc}`;
  const force = !!opts.force;
  // [2026-10-18 bg-sync] Recentes já completas e só falta a passada profunda,
  // que espera Wi-Fi: não refaz o chat_conversations a cada volta do 2º plano
  // em dados móveis (o listener de rede re-arma quando o Wi-Fi chegar).
  if (!force && _bgOn() && _deferredFor === emailLc && !_isUnmetered()
      && Date.now() - _deferredAt < DEFERRED_RECHECK_MS) {
    return { skipped: 'deferred_until_wifi' };
  }
  // Persist a "force-include media on cellular" flag for the duration of the
  // loop so prefetchIncomingMessageMedia bypasses the per-bucket auto-DL
  // gate. Cleared when the loop finishes (or aborts).
  _forceAllMedia = force || !!opts.includeAllMedia;
  // Separate sentinel that flips the FIRST time we surface the bar on this
  // device. It survives even when the loop is interrupted (background, kill,
  // 30min timeout) so subsequent cold starts can finish the work silently.
  // The user only ever sees "Sincronizando histórico" pill ONCE — exactly
  // like WhatsApp's first-time restore. Cleared only by clearLocalDb()
  // (logout / wipe history).
  const barShownKey = `chat_full_bar_shown:${emailLc}`;
  try {
    if (!force) {
      const v = await localDb.getSyncState(gateKey);
      if (v === 'done') return { skipped: 'already_done' };
    } else {
      // Force path — wipe per-conv watermarks so we re-walk everything that
      // hasn't synced yet AND every conv whose `chat_full_synced` was set
      // when only newest-N were actually pulled. The per-page loop is still
      // idempotent on cacheMessages (PG-side dedup), so re-pulling pages is
      // cheap on re-runs.
      try { await localDb.setSyncState(gateKey, 'started'); } catch {}
    }
  } catch {}

  // Seed _silent for this run. If the bar was ever shown before on this
  // device for this account, every progress event in this process is
  // suppressed — bootstrap continues invisibly in the background.
  let seenBarBefore = false;
  try {
    const v = await localDb.getSyncState(barShownKey);
    seenBarBefore = v === '1';
  } catch {}
  _silent = seenBarBefore;

  _running = true;
  _abort = false;
  _startedAt = Date.now();
  _setupLifecycleHooks();
  // NOTE (#1200 follow-up, 2026-05-20): we used to flip `chat_full_bar_shown`
  // here, BEFORE any work happened. That meant users with thousands of
  // pending messages NEVER saw the progress bar — the silent flag was
  // already set before the first emit was sent. Now we defer the sentinel
  // until AFTER the first conversation successfully drains (see
  // _runBootstrap). The user sees real progress on first run; once any
  // chunk of work lands, subsequent cold starts go silent as designed.
  _lastArgs = { apiCall, email };
  _ensureNetWatch();

  try {
    await localDb.setSyncState(gateKey, 'started');
    // [2026-10-18 bg-sync] lista uma vez só (inclui arquivadas), ordenada como
    // a home: as conversas que o usuário vê primeiro recebem mensagens primeiro.
    const convs = await _fetchAllConversations(apiCall);
    let recentRes = null;
    if (_bgOn()) recentRes = await _runRecentPass(apiCall, convs);
    emit('start', { convDone: 0, convTotal: convs.length });
    const result = (_abort || recentRes?.stopped)
      ? { convDone: 0, convTotal: convs.length, timedOut: false, deferred: true, failedConvs: [] }
      : await _runBootstrap(apiCall, convs, { barShownKey, seenBarBefore });
    // Only flip gate to 'done' if the loop finished cleanly with NO per-conv
    // failures. If any conv errored (network blip, 403, etc.) the gate stays
    // 'pending'/'started' so the next mount / AppState resume retries the
    // failed convs. Idempotent — convs that already flipped
    // `chat_full_synced:<id>` are skipped on the retry pass.
    // [bg-sync] passada profunda adiada (fora do Wi-Fi / bateria) também não sela.
    if (!_abort && !result.timedOut && !result.deferred && (result.failedConvs?.length || 0) === 0
        && !(recentRes && recentRes.failed > 0) && convs.length > 0) {
      await localDb.setSyncState(gateKey, 'done');
    }
    const recentClean = !recentRes || (!recentRes.failed && !recentRes.stopped);
    if (result.deferred && recentClean && !_abort) { _deferredFor = emailLc; _deferredAt = Date.now(); }
    else { _deferredFor = ''; _deferredAt = 0; }
    emit('done', { convDone: result.convDone, convTotal: result.convTotal });
    return { success: true, ...result };
  } catch (e) {
    console.warn('[fullHistorySync] bootstrap error:', e?.message);
    emit('done', { convDone: 0, convTotal: 0, error: e?.message });
    return { error: e?.message };
  } finally {
    _running = false;
    _forceAllMedia = false;
    _teardownLifecycleHooks();
  }
}

/**
 * Force-resume if anything is waiting. Called on AppState → active.
 *
 * Two roles:
 *  1. If a bootstrap loop is currently running but parked in
 *     `_waitWhilePaused()` (background, battery), unpause it.
 *  2. If NO loop is running and a (apiCall, email) was passed, fire a fresh
 *     `bootstrapFullHistoryOnce` so resuming the app from background actually
 *     retries any failed/pending conversations. Without this any 403/network
 *     blip during the first session leaves the gate 'pending' but nothing
 *     ever re-kicks it.
 *
 * Both args optional. Calling `nudgeFullHistorySync()` with no args keeps the
 * legacy unpause-only behavior for existing callsites.
 */
export function nudgeFullHistorySync(apiCall, email) {
  // Always wake any internal waiters first.
  _pausedReason = null;
  const waiters = _resumeWaiters.splice(0);
  for (const w of waiters) { try { w(); } catch {} }
  if (_running) return;
  // No loop running and caller provided creds → re-arm bootstrap. The gate
  // check inside `bootstrapFullHistoryOnce` returns `skipped: 'already_done'`
  // if everything completed previously, so this is cheap.
  if (apiCall && email) {
    try {
      bootstrapFullHistoryOnce(apiCall, email).catch(() => {});
    } catch {}
  }
}

/** Abort the in-flight loop (logout / cache clear). */
export function abortFullHistorySync() {
  _abort = true;
  // [2026-10-18 bg-sync] logout/troca de conta: o listener de rede não re-arma a conta anterior.
  _lastArgs = null;
  _deferredFor = ''; _deferredAt = 0;
  _setRecent({ running: false, done: 0, total: 0 });
  nudgeFullHistorySync();
}

/** Is a given conversation fully downloaded? UI uses this to decide whether
 *  it can skip the initial network fetch.  Synchronous-friendly wrapper. */
export async function isConvFullySynced(convId) {
  if (Platform.OS === 'web' || !convId) return false;
  try {
    const v = await localDb.getSyncState(`chat_full_synced:${convId}`);
    return v === '1';
  } catch {
    return false;
  }
}

// ─── Core loop ─────────────────────────────────────────────────────────────

async function _runBootstrap(apiCall, convs, opts = {}) {
  const { barShownKey, seenBarBefore } = opts;
  // 1. Conversation list já buscada pelo chamador (server caps at 500/page; paginated).
  const convTotal = convs.length;
  emit('start', { convDone: 0, convTotal });

  let convDone = 0;
  // Track per-conv failures (network blip, 403, drain throw). If non-empty,
  // the caller keeps the bootstrap gate 'pending' so the next mount /
  // AppState resume retries automatically. Without this the gate flipped
  // to 'done' on first iteration that didn't time-out — sealing the user
  // permanently in a half-synced state.
  const failedConvs = [];
  // Defer the "user has seen the progress bar" sentinel until we've actually
  // emitted progress. Previously it was set BEFORE the first emit so users
  // with thousands of pending messages saw zero UI feedback — bar was set
  // silently on launch #1 and every cold start after was emitted-silent.
  let barShownPersisted = !!seenBarBefore;
  const persistBarShown = async () => {
    if (barShownPersisted || !barShownKey) return;
    barShownPersisted = true;
    try { await localDb.setSyncState(barShownKey, '1'); } catch {}
  };

  for (const conv of convs) {
    if (_abort) break;
    if (Date.now() - _startedAt > MAX_RUNTIME_MS) {
      return { convDone, convTotal, timedOut: true, failedConvs };
    }
    // [2026-10-18 bg-sync] passada profunda só em Wi-Fi não tarifado (ou
    // force), parada enquanto o usuário interage. Saiu do Wi-Fi → adia; o
    // listener de rede re-arma quando voltar.
    if (_bgOn() && !(await _waitWhilePaused({ deep: true }))) {
      return { convDone, convTotal, timedOut: false, deferred: true, failedConvs };
    }

    const convId = Number(conv?.id);
    if (!convId) { convDone++; continue; }

    // Force mode (Settings "Baixar histórico completo" or first-launch prompt
    // "Baixar agora") deliberately re-walks already-synced convs because the
    // whole point is to fill missing media that earlier auto-DL skipped on
    // cellular. Without this branch the loop would skip every conv on the
    // 2nd run and the user's "Baixar tudo agora" tap would feel like a no-op.
    const alreadyDone = await localDb.getSyncState(`chat_full_synced:${convId}`);
    if (alreadyDone === '1' && !_forceAllMedia) { convDone++; emit('conv', { convDone, convTotal, currentConvId: convId, currentConvName: conv?.name }); continue; }

    emit('conv', {
      convDone, convTotal,
      currentConvId: convId,
      currentConvName: conv?.name || null,
    });

    try {
      const drained = await _drainConv(apiCall, convId);
      if (drained === 'deferred') {
        return { convDone, convTotal, timedOut: false, deferred: true, failedConvs };
      }
      await localDb.setSyncState(`chat_full_synced:${convId}`, '1');
      // First successful drain → seal the bar-shown sentinel. Subsequent
      // cold starts will be silent even if the loop never reaches 'done'
      // for the remaining convs.
      await persistBarShown();
    } catch (e) {
      // Per-conv error doesn't abort the whole bootstrap. The next launch
      // re-tries from the same oldest watermark — idempotent.
      console.warn(`[fullHistorySync] conv ${convId} drain failed:`, e?.message);
      failedConvs.push({ convId, error: e?.message });
    }

    convDone++;
    await _sleep(CONV_DELAY_MS);
    await _waitWhilePaused();
  }

  return { convDone, convTotal, timedOut: false, failedConvs };
}

// Walk one conversation's history pagewise from its current oldest watermark
// back to the very first message. Saves to SQLite via cacheMessages.
async function _drainConv(apiCall, convId) {
  const oldestKey = `chat_full_oldest:${convId}`;
  let beforeId = null;
  try {
    const raw = await localDb.getSyncState(oldestKey);
    const n = raw ? parseInt(raw, 10) : 0;
    if (Number.isFinite(n) && n > 0) beforeId = n;
  } catch {}

  for (let page = 0; page < MAX_PAGES_PER_CONV; page++) {
    if (_abort) return 'deferred';
    if (_bgOn()) { if (!(await _waitWhilePaused({ deep: true }))) return 'deferred'; }
    else await _waitWhilePaused();
    if (Date.now() - _startedAt > MAX_RUNTIME_MS) return 'deferred';

    // Use the api wrapper so the request goes through the same auth/retry
    // path the rest of the app uses. apiCall name: 'chat_messages'.
    let r;
    try {
      r = await apiCall('chat_messages', {
        conversation_id: convId,
        limit: PAGE_SIZE,
        before_id: beforeId || 0,
      });
    } catch (e) {
      // Network blip — back off and retry the same page once. If it still
      // fails, throw to bail this conv.
      await _sleep(2000);
      r = await apiCall('chat_messages', {
        conversation_id: convId,
        limit: PAGE_SIZE,
        before_id: beforeId || 0,
      });
    }

    if (!r || !r.success) {
      // Backend returned an error (403 not-a-member, etc.) — bail this conv.
      // The flip-to-fully_synced at the call site is skipped so we'll retry
      // next launch.
      throw new Error(r?.message || 'chat_messages_failed');
    }

    const msgs = Array.isArray(r.data?.messages)
      ? r.data.messages
      : (Array.isArray(r.messages) ? r.messages : []);

    if (!msgs.length) return; // reached the start of history

    // Save into SQLite + MMKV mirror via the canonical cacheMessages path so
    // dedup/upsert semantics match WS-driven inserts.
    // [2026-10-18 bg-sync] só as que faltam (nunca rebaixa linha mais nova).
    try { await _saveMissing(convId, msgs); } catch (e) {
      console.warn(`[fullHistorySync] cacheMessages conv ${convId}:`, e?.message);
    }

    // WhatsApp-parity: bootstrap also pulls media to disk so offline opens
    // work after a fresh restore. Without this hook the user has all the
    // *text* in SQLite but every image/audio/voice still 404s offline (the
    // viewer + media bubbles fall back to the remote URL, which fails with
    // no network). Routes through prefetchIncomingMessageMedia so the
    // per-bucket WhatsApp policy (photos/audio on wifi, videos/docs off on
    // cellular by default) is honored — heavy types still need a tap on
    // cellular, lighter ones land automatically. Voice goes through
    // prefetchAudioMessage internally which bypasses the cellular gate
    // (tiny + always wanted). Idempotent + throttled to 3 concurrent
    // downloads inside cacheMedia, so a 200-msg page can't saturate the
    // radio. Fire-and-forget — we don't await; the bootstrap loop moves
    // on while the downloads happen in the background pool.
    try {
      const mc = require('./mediaCache');
      const { prefetchIncomingMessageMedia, cacheMedia } = mc;
      for (const m of msgs) {
        if (!m) continue;
        const enriched = (m.conversation_id == null && convId != null)
          ? { ...m, conversation_id: convId }
          : m;
        // [2026-10-15 media-visibility] histórico em massa nunca vai p/ a galeria.
        try { prefetchIncomingMessageMedia?.(enriched, { noGallery: true }); } catch {}
        // Force path (#1238 follow-up): user pressed "Baixar tudo agora", so
        // bypass the per-bucket auto-DL gate and ALSO push the file_url
        // directly through cacheMedia({ force: true }). This catches buckets
        // (video/document) that prefetchIncomingMessageMedia would otherwise
        // skip on cellular under default policy. Idempotent — cacheMedia's
        // inflight dedup ignores duplicates within the same conv page.
        if (_forceAllMedia && cacheMedia) {
          const url = m.file_url
            || (m.type === 'gif' || m.type === 'sticker' ? m.content : null);
          if (url && typeof url === 'string' && /^https?:\/\//.test(url)) {
            try {
              cacheMedia(url, {
                force: true,
                messageId: m.id,
                conversationId: convId,
                messageType: m.type,
              }).catch(() => {});
              _lastProgress.mediaLoaded += 1;
            } catch {}
          }
        }
      }
    } catch {}
    // Voice-specific side hook (waveform peaks + audio-saved/ permanent cache
    // + played-ack tracking). prefetchAudioMessage inside
    // prefetchIncomingMessageMedia covers the audio bytes; this additionally
    // persists server-side wave_peaks so the bubble paints the real envelope
    // on next mount even before audio decode lands.
    try {
      const { prefetchVoiceMessages } = require('./voicePrefetch');
      prefetchVoiceMessages?.(msgs);
    } catch {}

    // Advance the watermark to the smallest id we just received.
    let minId = beforeId || Number.MAX_SAFE_INTEGER;
    for (const m of msgs) {
      const id = Number(m?.id);
      if (Number.isFinite(id) && id > 0 && id < minId) minId = id;
    }
    if (minId > 0 && minId !== Number.MAX_SAFE_INTEGER) {
      beforeId = minId;
      try { await localDb.setSyncState(oldestKey, String(minId)); } catch {}
    }

    // Less than a full page = we hit the start.
    if (msgs.length < PAGE_SIZE) return;

    await _sleep(PAGE_DELAY_MS);
  }
}

// ─── Conversation list (paginated) ─────────────────────────────────────────

async function _fetchAllConversations(apiCall) {
  const PAGE = 500;
  const out = [];
  const seen = new Set();
  let offset = 0;
  while (true) {
    if (_abort) break;
    let r;
    try {
      // [2026-10-18 bg-sync] include_archived=1: arquivadas vêm na 1ª página
      // (limite próprio no servidor) → também ganham histórico local.
      r = await apiCall('chat_conversations', { limit: PAGE, offset, include_archived: 1 });
    } catch (e) {
      console.warn('[fullHistorySync] chat_conversations:', e?.message);
      break;
    }
    if (!r?.success) break;
    // chat_conversations historically returns `data: [...]` (top-level array)
    // while newer endpoints sometimes nest it under `data.conversations`. Handle
    // both shapes so this module survives backend evolution.
    let list = [];
    if (Array.isArray(r.data)) list = r.data;
    else if (Array.isArray(r.data?.conversations)) list = r.data.conversations;
    else if (Array.isArray(r.conversations)) list = r.conversations;
    if (!list.length) break;
    let active = 0;
    for (const c of list) {
      const id = c && c.id != null ? String(c.id) : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(c);
      if (!c.archived && !c.is_archived) active++;
    }
    // Paginação conta só as ativas (as arquivadas extras não entram no LIMIT).
    if (active < PAGE) break;
    offset += active;
    await _sleep(100);
  }
  return _sortLikeHome(out);
}

// [2026-10-18 bg-sync] Mesma ordem que o usuário vê: fixadas, depois a mais
// recente primeiro; arquivadas no fim. Estável p/ empate.
function _lastTs(c) {
  const v = c?.last_message_at || c?.last_message?.created_at || c?.last_message_time || c?.updated_at || c?.created_at;
  if (!v) return 0;
  const t = Date.parse(typeof v === 'string' && !/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v.replace(' ', 'T') + 'Z' : v);
  return Number.isFinite(t) ? t : 0;
}
function _sortLikeHome(list) {
  return list
    .map((c, i) => ({ c, i, a: (c?.archived || c?.is_archived) ? 1 : 0, p: c?.pinned ? 1 : 0, t: _lastTs(c) }))
    .sort((x, y) => (x.a - y.a) || (y.p - x.p) || (y.t - x.t) || (x.i - y.i))
    .map((x) => x.c);
}

// ─── [2026-10-18 bg-sync] Passada A: recentes de cada conversa ─────────────

function _isUnmetered() {
  try {
    const ni = require('./networkInfo');
    return ni.getNetworkType?.() === 'wifi';
  } catch { return false; }
}
function _isOnline() {
  try { return require('./networkInfo').isConnected?.() !== false; } catch { return true; }
}
function _slowLink() {
  try { return !!require('./networkInfo').isSlowLink?.(); } catch { return false; }
}
function _userActive() {
  try { return require('./userActivity').isUserActive(ACTIVE_WINDOW_MS); } catch { return false; }
}

// Grava só as mensagens que ainda não estão no aparelho (dedupe por id; o
// envio otimista tmp_* nunca entra no SQLite). Linha já existente — vinda do
// WS ao vivo, de um recibo, do envio confirmado ou de mídia baixada — fica
// intacta. Erro na consulta → grava tudo (caminho antigo, INSERT OR REPLACE).
async function _saveMissing(convId, msgs) {
  if (!Array.isArray(msgs) || !msgs.length) return 0;
  let existing = null;
  try { existing = await require('./db').dbExistingMessageIds(msgs.map((m) => m && m.id)); } catch {}
  const fresh = [];
  for (const m of msgs) {
    if (!m || m.id == null) continue;
    if (existing && existing.has(Number(m.id))) continue;
    fresh.push(m.conversation_id == null ? { ...m, conversation_id: convId } : m);
  }
  if (fresh.length) await cacheMessages(convId, fresh);
  return fresh.length;
}

async function _fetchRecent(apiCall, conv, idx) {
  const convId = Number(conv?.id);
  if (!convId) return 'skip';
  // Já tem o suficiente localmente (conversa aberta durante a sync, WS) → sem rede.
  try {
    const n = await require('./db').dbCountMessages(convId);
    if (n >= RECENT_PER_CONV) {
      await localDb.setSyncState(`chat_recent_synced:${convId}`, '1');
      return 'local';
    }
  } catch {}
  const args = { conversation_id: convId, limit: RECENT_PER_CONV, before_id: 0 };
  let r;
  try { r = await apiCall('chat_messages', args); }
  catch {
    await _sleep(2000);
    if (_abort) return 'abort';
    r = await apiCall('chat_messages', args); // 2ª falha → lança (conta como falha, refaz depois)
  }
  if (!r) throw new Error('chat_messages_empty');
  if (!r.success) {
    // Servidor respondeu "não" (403 não-membro etc.): não insiste a cada
    // abertura — a conversa, se aberta, busca sob demanda.
    await localDb.setSyncState(`chat_recent_synced:${convId}`, '1');
    return 'denied';
  }
  const msgs = Array.isArray(r.data?.messages) ? r.data.messages : (Array.isArray(r.messages) ? r.messages : []);
  if (msgs.length) {
    await _saveMissing(convId, msgs);
    // Marca d'água p/ a passada profunda continuar DAQUI (só se ainda não existe).
    try {
      const prev = parseInt((await localDb.getSyncState(`chat_full_oldest:${convId}`)) || '0', 10);
      if (!(prev > 0)) {
        let minId = 0;
        for (const m of msgs) { const id = Number(m?.id); if (id > 0 && (!minId || id < minId)) minId = id; }
        if (minId > 0) await localDb.setSyncState(`chat_full_oldest:${convId}`, String(minId));
      }
    } catch {}
    // Mídia: só as conversas do topo, pela política auto-DL (Wi-Fi/dados) e
    // nunca p/ a galeria. Voz (pequena) segue o prefetch próprio.
    if (idx < RECENT_MEDIA_TOP) {
      try {
        const { prefetchIncomingMessageMedia } = require('./mediaCache');
        for (const m of msgs) {
          if (!m) continue;
          try { prefetchIncomingMessageMedia?.(m.conversation_id == null ? { ...m, conversation_id: convId } : m, { noGallery: true }); } catch {}
        }
      } catch {}
    }
    try { require('./voicePrefetch').prefetchVoiceMessages?.(msgs); } catch {}
  }
  // Menos que uma página = a conversa inteira já está no aparelho.
  if (msgs.length < RECENT_PER_CONV) {
    try { await localDb.setSyncState(`chat_full_synced:${convId}`, '1'); } catch {}
  }
  await localDb.setSyncState(`chat_recent_synced:${convId}`, '1');
  return 'ok';
}

async function _runRecentPass(apiCall, convs) {
  const todo = [];
  for (let i = 0; i < convs.length; i++) {
    const id = Number(convs[i]?.id);
    if (!id) continue;
    try {
      if ((await localDb.getSyncState(`chat_recent_synced:${id}`)) === '1') continue;
      if ((await localDb.getSyncState(`chat_full_synced:${id}`)) === '1') continue;
    } catch {}
    todo.push({ conv: convs[i], idx: i });
  }
  const total = todo.length;
  let done = 0;
  let failed = 0;
  let stopped = false;
  if (!total) { _setRecent({ running: false, done: 0, total: 0 }); return { done, total, failed, stopped }; }
  _setRecent({ running: true, done: 0, total });
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      if (_abort) { stopped = true; return; }
      if (!(await _waitWhilePaused())) { stopped = true; return; }
      const job = todo[cursor++];
      try { await _fetchRecent(apiCall, job.conv, job.idx); }
      catch (e) { failed++; if (__DEV__) console.warn('[fullHistorySync] recent', job.conv?.id, e?.message); }
      done++;
      _setRecent({ running: true, done, total });
      await _sleep(RECENT_GAP_MS);
    }
  };
  const n = _slowLink() ? 1 : RECENT_CONCURRENCY;
  try { await Promise.all(Array.from({ length: n }, () => worker())); }
  finally { _setRecent({ running: false, done, total }); }
  return { done, total, failed, stopped };
}

// Re-arma o loop quando a rede volta / entra no Wi-Fi (a passada profunda
// adiada fora do Wi-Fi recomeça sozinha). Uma assinatura por processo.
function _ensureNetWatch() {
  if (_netSub || Platform.OS === 'web') return;
  try {
    const ni = require('./networkInfo');
    _netWasUnmetered = _isUnmetered();
    _netSub = ni.onNetworkChange?.(() => {
      const now = _isUnmetered();
      const became = now && !_netWasUnmetered;
      _netWasUnmetered = now;
      if (!became || _running || !_lastArgs) return;
      setTimeout(() => {
        try { if (!_running && _lastArgs) nudgeFullHistorySync(_lastArgs.apiCall, _lastArgs.email); } catch {}
      }, 3000);
    }) || null;
  } catch {}
}

// ─── Lifecycle: pause/resume on AppState + battery ─────────────────────────

let _appStateSub = null;
function _setupLifecycleHooks() {
  if (_appStateSub) return;
  try {
    _appStateSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        _pausedReason = null;
        nudgeFullHistorySync();
      } else if (s === 'background') {
        _pausedReason = 'background';
      }
    });
  } catch {}
}
function _teardownLifecycleHooks() {
  try { _appStateSub?.remove?.(); } catch {}
  _appStateSub = null;
}

async function _checkBattery() {
  // Best-effort, optional dep. If expo-battery isn't installed, we skip the
  // gate (assume battery OK).
  try {
    const Battery = require('expo-battery');
    if (!Battery?.getBatteryLevelAsync) return true;
    const lvl = await Battery.getBatteryLevelAsync();
    const charging = (await Battery.getBatteryStateAsync()) === Battery.BatteryState?.CHARGING;
    if (charging) return true;
    // Pause below 20%, resume only after 25% (hysteresis).
    if (lvl != null && lvl < 0.20) return false;
    return true;
  } catch {
    return true;
  }
}

// Retorna true = pode seguir; false = parar esta passada (abort; ou, na
// passada profunda, saiu do Wi-Fi / bateria baixa → adiada).
async function _waitWhilePaused(opts = {}) {
  const deep = !!opts.deep && _bgOn();
  for (;;) {
    if (_abort) return false;
    // Background pause
    if (_pausedReason === 'background' || (Platform.OS !== 'web' && AppState.currentState === 'background')) {
      _pausedReason = 'background';
      await new Promise(res => {
        _resumeWaiters.push(res);
        // Also poll periodically in case the AppState listener missed it.
        setTimeout(() => {
          if (AppState.currentState === 'active') {
            _pausedReason = null;
            res();
          }
        }, RESUME_POLL_MS);
      });
      continue;
    }
    if (!_bgOn()) break; // caminho antigo: só 2º plano + bateria
    // [2026-10-18 bg-sync] sem rede → espera (não queima tentativas).
    if (!_isOnline()) { await _sleep(OFFLINE_POLL_MS); continue; }
    // Passada profunda: só Wi-Fi não tarifado, a menos que o usuário tenha pedido.
    if (deep && !_forceAllMedia && !_isUnmetered()) return false;
    // Usuário rolando/digitando/tocando → cede a vez.
    if (_userActive()) { await _sleep(ACTIVE_POLL_MS); continue; }
    break;
  }
  if (_bgOn() && !deep) return true; // passada A é leve: não para por bateria
  // Battery pause (re-check on every page boundary)
  const batteryOk = await _checkBattery();
  if (!batteryOk) {
    if (deep && !_forceAllMedia) { _pausedReason = null; return false; }
    _pausedReason = 'battery';
    await _sleep(RESUME_POLL_MS);
    return _waitWhilePaused(opts);
  }
  if (_pausedReason === 'battery') _pausedReason = null;
  return true;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function emit(phase, payload) {
  // Mirror EVERY progress event into a module-level cache so screens that
  // mount after the loop started (Settings → Storage opens while a bootstrap
  // is mid-flight) can paint the current state synchronously via
  // getBootstrapProgress() instead of waiting for the next event.
  try {
    _lastProgress = { ..._lastProgress, phase, ...(payload || {}) };
  } catch {}
  // #1200: once the user has seen the histórico bar once on this device, all
  // subsequent runs are silent. The bootstrap still chips away at remaining
  // conversations on each launch — we just don't surface it. This matches
  // WhatsApp's behavior: the first-time restore pill never reappears.
  if (_silent) return;
  try {
    mailWs?._emit?.('chat_bootstrap_progress', { phase, ...payload });
  } catch {}
}

// ─── Public introspection / manual triggers ───────────────────────────────

/**
 * Returns the current bootstrap state without starting one.
 *   { gate: 'done'|'started'|'pending'|null, running, lastProgress }
 * Cheap — single sync_state lookup. Used by Settings → Storage to render
 * "Histórico completo no celular" / "Faltam X mensagens" labels.
 */
export async function getBootstrapStatus(email) {
  if (Platform.OS === 'web' || !email) {
    return { gate: null, running: _running, lastProgress: _lastProgress };
  }
  let gate = null;
  try {
    gate = await localDb.getSyncState(`chat_full_bootstrap:${email.toLowerCase()}`);
  } catch {}
  return { gate: gate || null, running: _running, lastProgress: _lastProgress };
}

/**
 * Snapshot of the most-recent progress payload (sync). Used by Settings to
 * paint the progress card without subscribing to the WS bus.
 */
export function getBootstrapProgress() {
  return { ..._lastProgress, running: _running };
}

/**
 * Heuristic — would a fresh bootstrap actually do work? Compares local SQLite
 * counts against a cheap server-side `chat_inventory` call. Returns true if
 * server has more conv-or-msg than the device. Used by login.js to decide
 * whether to surface the "Baixar histórico" modal on a fresh install.
 */
export async function isBootstrapNeeded(apiCall, email) {
  if (Platform.OS === 'web' || !apiCall || !email) return false;
  try {
    const status = await getBootstrapStatus(email);
    // Done already and device has data — skip.
    if (status.gate === 'done') {
      try {
        const dbMod = require('./db');
        const stats = await dbMod.getSyncStats?.();
        if (stats && stats.msgsTotal > 0) return false;
      } catch {}
    }
    // First-run / pending / started / empty DB — ask backend so we only
    // surface the "Baixar histórico" prompt when there's actually content
    // to restore. Brand-new signups (zero server msgs) were getting pestered
    // with an empty download prompt — gate by real server-side count.
    const r = await apiCall('chat_inventory', {});
    const convs = r?.data?.conversations || r?.conversations || [];
    let serverMsgs = 0;
    for (const c of convs) serverMsgs += Number(c?.count || 0);
    let localMsgs = 0;
    try {
      const dbMod = require('./db');
      const stats = await dbMod.getSyncStats?.();
      localMsgs = Number(stats?.msgsTotal || 0);
    } catch {}
    // Gap threshold: 50+ msg delta means the user is clearly missing
    // history. <50 is noise (a few WS msgs in flight, etc.) — don't pester.
    // Also no-op when server has zero — a fresh account has nothing to download.
    if (serverMsgs <= 0) return false;
    return Math.max(0, serverMsgs - localMsgs) >= 50;
  } catch {
    return false;
  }
}

/**
 * Convenience wrapper for manual UI triggers (Settings, restore prompt).
 * Always runs with force=true so the gate is bypassed AND media policy is
 * overridden (every photo/video/audio/doc gets pulled).
 */
export function forceFullHistoryDownload(apiCall, email, opts = {}) {
  return bootstrapFullHistoryOnce(apiCall, email, { ...opts, force: true });
}

/**
 * "Baixar só mídias faltantes" — secondary action in Settings → Storage.
 * Walks the local SQLite messages table looking for rows with file_url but
 * no local_path, and re-queues them through cacheMedia({ force: true }).
 * Doesn't touch the message bootstrap (that's already done).
 */
export async function downloadMissingMediaOnly({ onProgress } = {}) {
  if (Platform.OS === 'web') return { skipped: 'web', loaded: 0, total: 0 };
  try {
    const dbMod = require('./db');
    const mc = require('./mediaCache');
    const rows = (await dbMod.getMissingMediaMessages?.(2000)) || [];
    const total = rows.length;
    if (total === 0) {
      try { onProgress?.({ loaded: 0, total: 0, percent: 100 }); } catch {}
      return { loaded: 0, total: 0 };
    }
    let loaded = 0;
    // 3-wide pool so we don't saturate the radio. cacheMedia has its own
    // inflight dedup so re-running this is safe.
    const CONCURRENCY = 3;
    let cursor = 0;
    async function worker() {
      while (cursor < rows.length) {
        const i = cursor++;
        const m = rows[i];
        const url = m.file_url
          || ((m.type === 'gif' || m.type === 'sticker') ? m.content : null);
        if (!url || !/^https?:\/\//.test(url)) {
          loaded++;
          try { onProgress?.({ loaded, total, percent: Math.floor((loaded / total) * 100) }); } catch {}
          continue;
        }
        try {
          await mc.cacheMedia(url, {
            force: true,
            messageId: m.id,
            conversationId: m.conversation_id,
            messageType: m.type,
          });
        } catch {}
        loaded++;
        try { onProgress?.({ loaded, total, percent: Math.floor((loaded / total) * 100) }); } catch {}
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    return { loaded, total };
  } catch (e) {
    return { error: e?.message };
  }
}
