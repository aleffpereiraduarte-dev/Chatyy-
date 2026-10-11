// [2026-10-11 async-routes] Web safety net for lazy chunks that fail to load.
//
// With expo-router `asyncRoutes` (web, production) every route is its own
// chunk (/_expo/static/js/web/<route>-<hash>.js). A tab opened on build A
// that navigates after build B was deployed asks for A's chunk; deploy-web.sh
// keeps old chunks for 7 days, but if one is gone anyway (cleanup, CDN miss,
// flaky network) the import rejects with AsyncRequireError
// ("Loading module …/x-<hash>.js failed."). A reload fetches the fresh
// index.html → new entry → new chunk names, which fixes it.
//
// Loop guard: at most ONE automatic reload per RELOAD_WINDOW_MS per tab
// (sessionStorage). If the fresh page fails the same way, we stop and let the
// ErrorBoundary show its normal "Algo deu errado" screen.
//
// Native: no-op (chunks are bundled; asyncRoutes is web-only).
import { Platform } from 'react-native';

const KEY = '@chatyy/chunk_reload_once';
const RELOAD_WINDOW_MS = 5 * 60 * 1000;

const CHUNK_RE = /Loading module .* failed|AsyncRequireError|ChunkLoadError|Loading chunk [\w-]+ failed|Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module/i;

export function isChunkLoadError(err) {
  if (!err) return false;
  try {
    const name = String(err.name || '');
    if (name === 'AsyncRequireError' || name === 'ChunkLoadError') return true;
    return CHUNK_RE.test(String(err.message || err));
  } catch {
    return false;
  }
}

/**
 * If `err` is a chunk-load failure on web, schedule a single page reload
 * (guarded per tab). Returns true when a reload was scheduled.
 */
export function reloadOnceForChunkError(err) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  if (!isChunkLoadError(err)) return false;
  try {
    const last = Number(window.sessionStorage.getItem(KEY) || 0);
    if (last && Date.now() - last < RELOAD_WINDOW_MS) return false; // already tried → no loop
    window.sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false; // no sessionStorage → can't guard against loops → don't auto-reload
  }
  setTimeout(() => {
    try { window.location.reload(); } catch {}
  }, 150);
  return true;
}

let _installed = false;
/** Global listeners for chunk failures that never reach a React error boundary. */
export function installChunkErrorReload() {
  if (_installed || Platform.OS !== 'web' || typeof window === 'undefined' || !window.addEventListener) return;
  _installed = true;
  window.addEventListener('unhandledrejection', (ev) => {
    try { if (reloadOnceForChunkError(ev && ev.reason)) ev.preventDefault?.(); } catch {}
  });
  window.addEventListener('error', (ev) => {
    try { reloadOnceForChunkError(ev && (ev.error || { message: ev.message })); } catch {}
  });
}
