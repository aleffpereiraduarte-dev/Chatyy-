// services/mediaAutoSync.js
//
// WhatsApp-grade BACKGROUND auto-sync for missing media. Sister service to
// fullHistorySync — that one walks message history pages, this one fills the
// gap between "SQLite has the row, local_path is NULL" and "file is on disk".
//
// Why a separate service?
//   - fullHistorySync runs ONCE per device (bootstrap gate). After it flips
//     to 'done', any media that landed via WS push BUT got blocked by the
//     per-bucket cellular gate (e.g. videos on mobile) stayed pending forever
//     unless the user opened Settings → Storage and pressed "Baixar mídias
//     faltantes". The user explicitly asked: "deveria sincronizar
//     automaticamente pra nunca faltar nada" — same UX as WhatsApp where you
//     never see "missing media" because wifi auto-fills it.
//   - This loop is FOREVER. It wakes on:
//        a) app boot (~5s after first paint, deferred to not compete with UI)
//        b) AppState → 'active' (foreground)
//        c) network state change (any → wifi)
//        d) WS event 'chat_message' for the user (in case it slipped through)
//        e) a 5-minute idle tick (safety net)
//   - Honors the per-bucket policy (photos/audio always, videos/docs wifi
//     only by default — same matrix as mediaCache). User can override in
//     Storage settings via the existing pref UI.
//
// Concurrency: 4 parallel downloads (vs WhatsApp's ~3-6 on cellular, ~8 on
// wifi). cacheMedia has its own inflight dedup so we can't double-download.
//
// Battery / data discipline:
//   - SKIP entirely if battery < 15% AND not charging (vs bootstrap's 20% —
//     this is the steady-state loop so we can be slightly more conservative).
//   - On cellular, ONLY photo/audio buckets auto-fill (cheap). Videos/docs
//     wait for wifi. The per-bucket policy in mediaCache.shouldAutoDownload
//     already enforces this — we just call cacheMedia without force:true and
//     let the gate block heavy buckets.
//   - On wifi, EVERYTHING fills regardless of size.
//
// Progress emission: 'media_auto_sync_progress' WS event with
//   { phase: 'idle'|'syncing'|'done', loaded, total, lastUrl }
// Settings → Storage subscribes and renders the live counter so users see
// "Sincronizando 12/47" instead of the alarming "Mídias faltantes: 47".
//
// Idempotency: a single in-flight loop per process. Triggers while running
// schedule a "re-check after current pass" instead of stacking loops.

import { Platform, AppState } from 'react-native';

// Lazy refs — avoid pulling SQLite / NetInfo into web bundle.
let _dbMod = null;
let _mediaCacheMod = null;
let _netInfoMod = null;
let _wsMod = null;
function _lazyMods() {
  if (Platform.OS === 'web') return null;
  try { if (!_dbMod) _dbMod = require('./db'); } catch {}
  try { if (!_mediaCacheMod) _mediaCacheMod = require('./mediaCache'); } catch {}
  try { if (!_netInfoMod) _netInfoMod = require('./networkInfo'); } catch {}
  try { if (!_wsMod) _wsMod = require('./websocket').default; } catch {}
  return { db: _dbMod, mc: _mediaCacheMod, ni: _netInfoMod, ws: _wsMod };
}

// ─── Tunables ──────────────────────────────────────────────────────────────
const CONCURRENCY = 4;             // parallel downloads
const IDLE_TICK_MS = 5 * 60 * 1000; // re-check missing every 5min while idle
const BOOT_DELAY_MS = 5000;        // wait 5s past first paint
const PER_PASS_CAP = 500;          // max msgs processed in a single pass
const BATTERY_FLOOR = 0.15;        // skip pass if battery < 15% (not charging)
const DEFERRED_RETRY_GAP_MS = 1500;// gap after wifi flip to let stack settle

// ─── State ─────────────────────────────────────────────────────────────────
let _started = false;              // initStarted has run for this process
let _running = false;              // true while a pass is in flight
let _scheduledReRun = false;       // a request landed while running
let _appStateSub = null;
let _netUnsub = null;
let _idleTimer = null;
let _wsSubscribed = false;
let _lastProgress = {
  phase: 'idle',                   // 'idle' | 'syncing' | 'done'
  loaded: 0,
  total: 0,
  startedAt: 0,
  finishedAt: 0,
  lastNetType: null,
};

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Boot the auto-sync loop. Idempotent — safe to call from _layout.js mount
 * + AppState transitions. No-op on web (no SQLite).
 *
 * `email` is informational only — used for log tagging. The loop reads
 * directly from SQLite so it works for the active account.
 */
export function initMediaAutoSync(email) {
  if (Platform.OS === 'web') return;
  if (_started) {
    // Re-arm a pass on every login/resume so a fresh session catches anything
    // pending. The flag below dedupes so we don't stack passes.
    _kick('init-reentry');
    return;
  }
  _started = true;

  // AppState → 'active' triggers a fresh sweep. WhatsApp does the same — open
  // the app and any missing thumbs fill within a couple seconds.
  try {
    _appStateSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') _kick('appstate-active');
    });
  } catch {}

  // Network state listener — fire a sweep on transition to wifi. This is the
  // killer feature: user walks into their house, phone joins wifi, all
  // pending videos download silently without them ever opening Settings.
  try {
    const mods = _lazyMods();
    if (mods?.ni?.onNetworkChange) {
      let prevType = mods.ni.getNetworkType?.();
      _netUnsub = mods.ni.onNetworkChange((state) => {
        const type = mods.ni.getNetworkType?.();
        _lastProgress.lastNetType = type;
        if (type === 'wifi' && prevType !== 'wifi') {
          // Tiny gap so DNS/SNI handshake settles after the radio flip.
          setTimeout(() => _kick('network-wifi'), DEFERRED_RETRY_GAP_MS);
        }
        prevType = type;
      });
    }
  } catch {}

  // WS event listener — every incoming chat_message is a candidate for
  // auto-fill (in case the cellular gate blocked it on landing).
  try {
    const mods = _lazyMods();
    if (mods?.ws?.on && !_wsSubscribed) {
      mods.ws.on('chat_message', _onWsMessage);
      _wsSubscribed = true;
    }
  } catch {}

  // Idle tick — safety net. If the user just sits in a chat for 6 hours and
  // the wifi flip never fires (already on wifi the whole time), we still
  // re-check every 5min to catch any stragglers that WS missed.
  _idleTimer = setInterval(() => _kick('idle-tick'), IDLE_TICK_MS);

  // Initial pass after first paint.
  setTimeout(() => _kick('boot'), BOOT_DELAY_MS);
}

/**
 * Stop the auto-sync loop. Called on logout / clearAllPerAccountCaches.
 */
export function stopMediaAutoSync() {
  _started = false;
  _running = false;
  _scheduledReRun = false;
  try { _appStateSub?.remove?.(); } catch {}
  _appStateSub = null;
  try { _netUnsub?.(); } catch {}
  _netUnsub = null;
  if (_idleTimer) { try { clearInterval(_idleTimer); } catch {} _idleTimer = null; }
  if (_wsSubscribed) {
    try { _wsMod?.off?.('chat_message', _onWsMessage); } catch {}
    _wsSubscribed = false;
  }
  _lastProgress = {
    phase: 'idle', loaded: 0, total: 0,
    startedAt: 0, finishedAt: 0, lastNetType: null,
  };
}

/**
 * Snapshot of the current auto-sync state. Settings → Storage uses this to
 * render "Sincronizado" vs "Sincronizando X/Y".
 */
export function getAutoSyncProgress() {
  return { ..._lastProgress, running: _running };
}

/**
 * Manual kick — exposed for the "Sincronizar agora" button in Settings.
 * Bypasses the AppState/network gates (user explicit intent).
 */
export function nudgeMediaAutoSync(reason = 'manual') {
  _kick(reason, { force: true });
}

// ─── Internal ──────────────────────────────────────────────────────────────

function _onWsMessage(payload) {
  // Don't spam — debounce 2s so a burst of WS messages results in ONE sweep.
  if (_wsDebounce) clearTimeout(_wsDebounce);
  _wsDebounce = setTimeout(() => _kick('ws-msg'), 2000);
}
let _wsDebounce = null;

async function _kick(reason, opts = {}) {
  if (Platform.OS === 'web') return;
  if (_running) {
    // Mark that we got asked again — re-run after current pass settles so a
    // fresh batch doesn't have to wait until the next idle tick.
    _scheduledReRun = true;
    return;
  }
  _running = true;
  try {
    await _runPass(reason, opts);
  } catch (e) {
    if (__DEV__) console.warn('[mediaAutoSync] pass failed:', e?.message);
  } finally {
    _running = false;
    if (_scheduledReRun) {
      _scheduledReRun = false;
      // Defer the rerun so the event loop drains and we don't stack-overflow
      // if WS keeps firing while we work.
      setTimeout(() => _kick('rerun'), 500);
    }
  }
}

async function _runPass(reason, opts) {
  const mods = _lazyMods();
  if (!mods?.db || !mods?.mc) return;

  // Battery floor — skip pass if low + not charging. cacheMedia is throttled
  // anyway but bursting 50 downloads at 10% battery is not great UX.
  if (!opts.force) {
    const ok = await _batteryOk();
    if (!ok) {
      _emit({ phase: 'idle' });
      return;
    }
  }

  // Pull the missing list. Order by id DESC inside getMissingMediaMessages
  // ensures we prioritize RECENT messages — the ones the user is most
  // likely to open soon. WhatsApp does the same: newest unsync'd first.
  let rows = [];
  try {
    rows = (await mods.db.getMissingMediaMessages?.(PER_PASS_CAP)) || [];
  } catch (e) {
    if (__DEV__) console.warn('[mediaAutoSync] db read failed:', e?.message);
    return;
  }
  const total = rows.length;
  if (total === 0) {
    _emit({ phase: 'done', loaded: 0, total: 0 });
    return;
  }

  const netType = mods.ni?.getNetworkType?.() || 'unknown';
  _emit({
    phase: 'syncing',
    loaded: 0,
    total,
    startedAt: Date.now(),
    lastNetType: netType,
  });

  let loaded = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const i = cursor++;
      const m = rows[i];
      const url = m.file_url
        || ((m.type === 'gif' || m.type === 'sticker') ? m.content : null);
      if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        loaded++;
        _emit({ phase: 'syncing', loaded, total });
        continue;
      }
      try {
        // NO force:true — we want the per-bucket policy to apply. On
        // cellular, videos/docs return remote URL unchanged (skipped); on
        // wifi everything saves. cacheMedia's own inflight dedup makes this
        // safe even if the same URL is in flight from a chat scroll.
        // For 'audio'/'voice' types we DO force (always wanted, tiny size).
        const forceTiny = (m.type === 'audio' || m.type === 'voice');
        await mods.mc.cacheMedia(url, {
          force: forceTiny || !!opts.force,
          messageId: m.id,
          conversationId: m.conversation_id,
          messageType: m.type,
        });
      } catch (e) {
        // Per-URL error — keep going. Next pass will re-pick it up since
        // local_path stays NULL until cacheMedia succeeds.
      }
      loaded++;
      _emit({ phase: 'syncing', loaded, total, lastUrl: url });
    }
  };
  // Spin CONCURRENCY workers. Promise.all so we know when the pass is done.
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  _emit({ phase: 'done', loaded, total, finishedAt: Date.now() });
}

async function _batteryOk() {
  try {
    const Battery = require('expo-battery');
    if (!Battery?.getBatteryLevelAsync) return true;
    const lvl = await Battery.getBatteryLevelAsync();
    const charging = (await Battery.getBatteryStateAsync()) === Battery.BatteryState?.CHARGING;
    if (charging) return true;
    if (lvl != null && lvl < BATTERY_FLOOR) return false;
    return true;
  } catch {
    return true;
  }
}

function _emit(patch) {
  _lastProgress = { ..._lastProgress, ...patch };
  try {
    _wsMod?._emit?.('media_auto_sync_progress', { ..._lastProgress });
  } catch {}
}
