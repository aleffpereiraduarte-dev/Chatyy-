// [2026-10-06 thread-tech] Per-message "overlay" store for the chat thread.
//
// Problem it solves: chat-conversation.js kept volatile per-bubble UI state
// (download %, image painted, media error, delete-fade, translation) in
// SCREEN useState maps. Every progress tick re-rendered the whole 33k-line
// screen, and — worse — the memoized row never repainted because its
// comparator only sees `item`, not those maps (download ring froze, blur
// backdrop lingered, MessageDeleteAnim never ran).
//
// Now each field lives in a keyed external store. Setters keep the exact
// `setState(prev => next)` map-updater API so the call sites didn't change,
// but they DON'T touch screen state: only the rows whose key changed are
// notified (useSyncExternalStore on a per-key version number), and those
// rows re-render themselves with a fresh overlay object.
import { useCallback, useRef, useSyncExternalStore } from 'react';

const EMPTY = Object.freeze({});

export const OVERLAY_FIELDS = ['dl', 'loaded', 'err', 'del', 'tr'];

export function createRowOverlayStore() {
  const maps = { dl: EMPTY, loaded: EMPTY, err: EMPTY, del: EMPTY, tr: EMPTY };
  const subs = new Map(); // key -> Set<fn>
  const vers = new Map(); // key -> number
  const bump = (k) => {
    vers.set(k, (vers.get(k) || 0) + 1);
    const s = subs.get(k);
    if (s) s.forEach((fn) => { try { fn(); } catch {} });
  };
  const store = {
    getMap(field) { return maps[field]; },
    get(field, key) { return key == null ? undefined : maps[field][key]; },
    // Same contract as React's setState for a `{[id]: value}` map.
    setField(field, updater) {
      const prev = maps[field];
      const next = typeof updater === 'function' ? updater(prev) : updater;
      if (next === prev || next == null) return;
      maps[field] = next;
      // Only keys with a mounted subscriber matter for repaint; others read
      // the current value when they mount. Bump those whose value changed.
      if (subs.size) {
        subs.forEach((_set, k) => { if (prev[k] !== next[k]) bump(k); });
      }
    },
    subscribe(key, fn) {
      if (key == null) return () => {};
      const k = String(key);
      let s = subs.get(k);
      if (!s) { s = new Set(); subs.set(k, s); }
      s.add(fn);
      return () => {
        s.delete(fn);
        if (!s.size) subs.delete(k);
      };
    },
    version(key) { return key == null ? 0 : (vers.get(String(key)) || 0); },
    // Overlay object passed to renderMessage(item, ov).
    snapshot(key) {
      if (key == null) return { dl: undefined, loaded: false, err: false, deleting: false, tr: undefined };
      return {
        dl: maps.dl[key],
        loaded: !!maps.loaded[key],
        err: !!maps.err[key],
        deleting: !!maps.del[key],
        tr: maps.tr[key],
      };
    },
    reset() {
      OVERLAY_FIELDS.forEach((f) => store.setField(f, EMPTY));
    },
  };
  return store;
}

// Stable setState-compatible setter bound to one field.
export function useOverlaySetter(store, field) {
  return useCallback((updater) => store.setField(field, updater), [store, field]);
}

// Row-side hook: re-renders the calling row ONLY when its own key changed.
export function useRowOverlayVersion(store, key) {
  const subscribe = useCallback((fn) => (store ? store.subscribe(key, fn) : () => {}), [store, key]);
  const getSnap = useCallback(() => (store ? store.version(key) : 0), [store, key]);
  return useSyncExternalStore(subscribe, getSnap, getSnap);
}

// Lazily create one store per screen instance.
export function useRowOverlayStore() {
  const ref = useRef(null);
  if (!ref.current) ref.current = createRowOverlayStore();
  return ref.current;
}

// ─────────────────────────────────────────────────────────────────────────
// [2026-10-06 thread-tech] Composer text store.
// `inputText` used to be screen useState → EVERY keystroke re-rendered the
// whole 33k-line chat screen (list props, header, modals…). Now the live
// text lives here; only <ThreadComposerHost> (the input bar subtree)
// re-renders per keystroke. `set` keeps the setState(prev => next) contract
// so every existing setInputText(...) call site works unchanged; handlers
// read the live value with `get()` at call time.
export function createComposerTextStore(initial = '') {
  let text = initial;
  const subs = new Set();
  const store = {
    get: () => text,
    set: (updater) => {
      const next = typeof updater === 'function' ? updater(text) : updater;
      const v = next == null ? '' : String(next);
      if (v === text) return;
      text = v;
      subs.forEach((fn) => { try { fn(v); } catch {} });
    },
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
  };
  return store;
}

export function useComposerTextStore() {
  const ref = useRef(null);
  if (!ref.current) ref.current = createComposerTextStore('');
  return ref.current;
}

// Not memoized on purpose: it re-renders with the screen (so `render` always
// closes over the latest screen state) AND on its own when the text changes
// (the keystroke fast-path, which no longer touches the screen).
export function ThreadComposerHost({ store, render }) {
  const text = useSyncExternalStore(store.subscribe, store.get, store.get);
  return render(text);
}
