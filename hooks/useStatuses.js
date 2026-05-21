// useStatuses — single source of truth for the 24h status feed.
//
// Was duplicated across 3 surfaces (ChatListTab home row, ChatStatusTab full
// page, Profile.js stories row). Each had its own fetch+cache+WS plumbing
// with subtle drift: ChatListTab polled but had no fingerprint diff (so the
// row flickered on every poll), ChatStatusTab had MMKV preload + WS deltas
// but didn't share its cache with the home row, Profile.js piggy-backed on
// the profile_get response and never refreshed mid-session.
//
// This hook unifies the contract. Both shapes are returned so the existing
// renderers can adopt without rewiring their state model:
//
//   - `groups`  → flat list `[{ email, name, items, ... }, ...]` (ChatListTab)
//   - `mine` + `others` → normalized split where `others[i].ownerEmail` is
//                         already lifted out (ChatStatusTab)
//
// Features merged from the three call-sites:
//   - MMKV synchronous preload (native) so the first paint already has data
//   - Disk cache via services/cache (30d TTL) as the cross-launch fallback
//   - WebSocket listeners for `status_new` + `status_update` (debounced 600ms
//     so multi-item carousel publishes don't N×reload the row)
//   - 120s polling as belt-and-suspenders against missed WS frames
//   - Fingerprint diff (id + viewed_at + created_at) so unchanged poll/WS
//     responses don't cause a setState → re-render → flicker
//   - Optional video warm-cache for the first 2 video items per group
//     (status viewer expects instant playback; cellular gate bypassed)
//   - `markViewed(statusId)` helper that updates BOTH shapes optimistically
//   - `removeStatus(statusId)` for delete flows (own status)
//
// Usage:
//   const { groups, mine, others, loading, refetch, markViewed, removeStatus }
//     = useStatuses(user?.email, { warmCacheVideos: true });

import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as api from '../services/api';
import { BASE_URL } from '../services/api';
import { setCache, getCached, getCachedSync } from '../services/cache';

let _mailWs = null;
try { _mailWs = require('../services/websocket').default; } catch {}

let _cacheMedia = null;
try { _cacheMedia = require('../services/mediaCache').cacheMedia; } catch {}

// Allowed CDN hosts for GIF stickers. We deliberately keep the list narrow:
// Tenor + Giphy are the two providers GifPicker.js queries (chatSearchGifs →
// Tenor by default), and chatyy R2 covers any GIF the user uploaded directly.
// Anything else is rejected at composer time and at viewer-render time so a
// malicious payload can't smuggle a tracking pixel via the gif sticker path.
//
// We compare against the URL's hostname (lowercased) and accept exact matches
// or any subdomain of an allowed root. e.g. "media1.tenor.com" matches "tenor.com".
export const ALLOWED_GIF_HOSTS = [
  'tenor.com',
  'giphy.com',
  'media.tenor.com',
  'media.giphy.com',
  'chatyy.com.br',
  'media.chatyy.com.br',
  'r2.chatyy.com.br',
];

export function isAllowedGifUrl(raw) {
  try {
    const s = String(raw || '').trim();
    if (!s) return false;
    if (!/^https?:\/\//i.test(s)) return false;
    // URL parser is reliable enough cross-platform; falls through on invalid.
    const u = new URL(s);
    const host = (u.hostname || '').toLowerCase();
    if (!host) return false;
    for (const allowed of ALLOWED_GIF_HOSTS) {
      if (host === allowed) return true;
      if (host.endsWith('.' + allowed)) return true;
    }
    return false;
  } catch { return false; }
}

// MMKV preload runs ONCE per JS bundle. Subsequent hook mounts get the
// already-parsed object. Keeps cold start instant on native.
let _mmkvPreloaded = null;
let _mmkvAttempted = false;
function _readMMKVOnce() {
  if (_mmkvAttempted) return _mmkvPreloaded;
  _mmkvAttempted = true;
  if (Platform.OS === 'web') return null;
  try {
    const { getString } = require('../services/mmkv');
    const raw = getString('chat_statuses');
    if (raw) _mmkvPreloaded = JSON.parse(raw);
  } catch {}
  return _mmkvPreloaded;
}
function _writeMMKV(payload) {
  if (Platform.OS === 'web') return;
  try {
    const { setString } = require('../services/mmkv');
    setString('chat_statuses', JSON.stringify(payload));
  } catch {}
}

// Fingerprint a status response. Two responses are "equal" iff every item
// has the same id + viewed_at + created_at — that's the only state the UI
// actually cares about.
function _fingerprint(mine, others) {
  try {
    const parts = [];
    for (const it of (mine || [])) {
      parts.push(`m:${it.id}:${it.viewed_at || ''}:${it.created_at || ''}`);
    }
    for (const g of (others || [])) {
      const owner = g.ownerEmail || g.email || '';
      for (const it of (g.items || [])) {
        parts.push(`o:${owner}:${it.id}:${it.viewed_at || ''}:${it.created_at || ''}`);
      }
    }
    return parts.join('|');
  } catch { return ''; }
}

// Normalize the raw `status_list` response into the dual shape. Backend
// returns `{ statuses: [{ email, name, items|statuses, ... }] }` (varies by
// version — the `items|statuses` fallback handles older builds). We:
//   1. coerce items to a stable key ("items")
//   2. split current user's groups into `mine` (flat) so the renderers can
//      treat self differently (compose entry, no view tracking, etc.)
//   3. lift owner email/name onto `others[i]` for quick lookup
function _normalize(raw, currentEmail) {
  const groupsArr = Array.isArray(raw) ? raw : (raw?.statuses || []);
  const groups = [];
  const mine = [];
  const others = [];
  const me = String(currentEmail || '').toLowerCase();
  // Status TTL is 24h server-side. Stale rows occasionally slip through cached
  // responses (poll fired before the cleanup cron) and the home strip leaves
  // a "ghost" expired ring visible. Hard filter at normalize time.
  const _expiredCutoff = Date.now() - 24 * 3600 * 1000;
  const _isFresh = (it) => {
    try {
      let iso = String(it.created_at || '').replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
      const ms = new Date(iso).getTime();
      return Number.isFinite(ms) ? ms >= _expiredCutoff : true;
    } catch { return true; }
  };
  for (const _g of groupsArr) {
    const items = (_g.items || _g.statuses || [])
      .filter(_isFresh)
      .map(it => ({
        ...it,
        // The full UI uses `bgColor` (camel); home reads `bg_color`. Provide both.
        bgColor: it.bg_color || it.bgColor || '#6D28D9',
        timestamp: it.created_at,
      }));
    if (items.length === 0) continue; // group with all items expired → drop
    const group = { ..._g, items };
    groups.push(group);
    if (String(_g.email || '').toLowerCase() === me) {
      mine.push(...items);
    } else {
      others.push({
        ownerEmail: _g.email,
        ownerName: _g.name || (_g.email || '').split('@')[0],
        items,
      });
    }
  }
  return { groups, mine, others };
}

// Warm-cache the first 2 video items of MY status + first 2 of every contact
// so the viewer plays from file:// instantly with no buffering frame. Cheap
// — cacheMedia dedupes by URL via syncIndex.
function _warmCacheVideos(mine, others) {
  if (Platform.OS === 'web' || !_cacheMedia) return;
  try {
    const candidates = [];
    for (const it of (mine || []).slice(0, 2)) {
      if (it.type === 'video' && (it.media_url || it.content)) candidates.push(it);
    }
    for (const g of (others || [])) {
      for (const it of (g.items || []).slice(0, 2)) {
        if (it && it.type === 'video' && (it.media_url || it.content)) candidates.push(it);
      }
    }
    for (const it of candidates) {
      const raw = (it.media_url || it.content || '').split('\n')[0];
      const fullUrl = raw.startsWith('/') ? BASE_URL + raw : raw;
      if (fullUrl) _cacheMedia(fullUrl, { force: true }).catch(() => {});
    }
  } catch {}
}

// Web SW pre-cache for status thumbnails + first hero of every group.
// The service worker accepts a PREFETCH_MEDIA message and HEAD+GETs each URL
// against media.chatyy.com.br, stashing it in MEDIA_CACHE. By the time the
// user taps a story bubble, the thumbnail/poster is already on disk and
// the viewer paints in <50ms instead of 200-800ms first-byte from CDN.
function _swPrefetch(mine, others) {
  try {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    const ctrl = navigator.serviceWorker.controller;
    if (!ctrl) return;
    const urls = [];
    const push = (u) => {
      if (!u || typeof u !== 'string') return;
      if (u.startsWith('http')) urls.push(u);
      // resolveMedia/getMediaUrl already converts /data/ → CDN URL on the
      // caller side, but be defensive in case a status row still has a
      // relative path. We hard-code the CDN host here (cheaper than
      // importing api.js into the hook).
      else if (u.startsWith('/data/')) urls.push('https://media.chatyy.com.br' + u);
    };
    for (const it of (mine || []).slice(0, 4)) {
      push(it?.thumbnail_url); push(it?.media_url);
    }
    for (const g of (others || []).slice(0, 12)) {
      const first = (g?.items || [])[0];
      if (first) { push(first.thumbnail_url); push(first.media_url); }
    }
    if (urls.length) {
      ctrl.postMessage({ type: 'PREFETCH_MEDIA', urls });
    }
  } catch {}
}

export default function useStatuses(currentEmail, opts = {}) {
  const {
    warmCacheVideos = true,
    pollMs = 120000,
    enabled = true,
  } = opts;

  // Synchronous MMKV preload so the first paint already shows yesterday's
  // groups — no spinner flash on cold start. Web and the first-ever launch
  // fall through to the fetch.
  //
  // [WAVE 43B 2026-05-20] SWR cache layer: além de MMKV (native-only,
  // synchronous), tentamos a disk cache (services/cache.js) que cobre web
  // E persiste por 30d. getCachedSync é não-bloqueante e retorna null se
  // ainda não foi warmed; chamamos ele primeiro como hot path. Combinado
  // ao MMKV, o status strip pinta IMEDIATAMENTE em 99% dos casos pós-uso
  // inicial. O fetch real continua acontecendo no background.
  const _preload = enabled ? (_readMMKVOnce() || getCachedSync('statuses')) : null;
  const _hadPreload = !!(_preload && (
    (Array.isArray(_preload.mine) && _preload.mine.length) ||
    (Array.isArray(_preload.others) && _preload.others.length) ||
    (Array.isArray(_preload.groups) && _preload.groups.length)
  ));
  const _initialNorm = _preload
    ? (_preload.groups
        ? { groups: _preload.groups, mine: _preload.mine || [], others: _preload.others || [] }
        // Older preload format only had mine/others. Reconstruct groups from
        // others + a synthetic group for mine if email matches.
        : { groups: [
            ...(_preload.mine?.length ? [{ email: currentEmail, name: '', items: _preload.mine }] : []),
            ...(_preload.others || []).map(o => ({ email: o.ownerEmail, name: o.ownerName, items: o.items })),
          ], mine: _preload.mine || [], others: _preload.others || [] })
    : { groups: [], mine: [], others: [] };

  const [groups, setGroups] = useState(_initialNorm.groups);
  const [mine, setMine] = useState(_initialNorm.mine);
  const [others, setOthers] = useState(_initialNorm.others);
  // [WAVE 43B 2026-05-20] loading=false quando temos preload (MMKV ou disk).
  // Antes era só MMKV → web e cold-start sem MMKV mostrava skeleton blank.
  const [loading, setLoading] = useState(!_hadPreload);
  const fpRef = useRef(_hadPreload ? _fingerprint(_initialNorm.mine, _initialNorm.others) : null);

  // [WAVE 43B 2026-05-20] Async fallback — se MMKV sync E getCachedSync
  // não tiveram cache (primeira vez nesta sessão JS, hot reload, etc.),
  // ainda tentamos getCached async pra recuperar dados anteriores antes
  // do fetch real completar. Mata a maioria dos "status demora carregar"
  // em cold start.
  const asyncCacheHydratedRef = useRef(false);
  useEffect(() => {
    if (!enabled || _hadPreload || asyncCacheHydratedRef.current) return;
    asyncCacheHydratedRef.current = true;
    let alive = true;
    (async () => {
      try {
        const cached = await getCached('statuses');
        if (!alive || !cached) return;
        // Only paint if the live fetch hasn't already won the race.
        if (fpRef.current) return;
        const cachedGroups = cached.groups || [];
        const cachedMine = cached.mine || [];
        const cachedOthers = cached.others || [];
        if (cachedGroups.length === 0 && cachedMine.length === 0 && cachedOthers.length === 0) return;
        fpRef.current = _fingerprint(cachedMine, cachedOthers);
        setGroups(cachedGroups);
        setMine(cachedMine);
        setOthers(cachedOthers);
        setLoading(false);
        // Warm the SW / native media cache for the cached items so when
        // user taps a story the video plays from file:// immediately
        // (and not waiting for the fresh fetch to complete first).
        if (warmCacheVideos) _warmCacheVideos(cachedMine, cachedOthers);
        if (Platform.OS === 'web') _swPrefetch(cachedMine, cachedOthers);
      } catch {}
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, warmCacheVideos]);

  // [WAVE 54 2026-05-21] Manifest-first paint. When MMKV + disk + async cache
  // ALL miss (truly cold install, post-reset, fresh device, web first visit),
  // we still want to avoid a blank strip waiting on the heavy status_list.
  // The manifest endpoint returns <5KB of per-owner aggregates — we paint
  // SKELETON groups from it (1 placeholder item per owner so the bubble +
  // count + ring color render) while the full status_list call resolves in
  // the background and replaces them with real items.
  //
  // Skipped when we already have data (any preload or async cache hit) so
  // we never thrash the UI by re-painting placeholders on top of real items.
  const manifestPaintedRef = useRef(false);
  useEffect(() => {
    if (!enabled || _hadPreload || manifestPaintedRef.current) return;
    manifestPaintedRef.current = true;
    let alive = true;
    (async () => {
      try {
        const r = await api.statusManifest?.();
        if (!alive || !r?.success || !r.data?.users) return;
        // If the real fetch already won the race, do nothing.
        if (fpRef.current) return;
        const users = r.data.users || [];
        if (users.length === 0) { setLoading(false); return; }
        const me = String(currentEmail || '').toLowerCase();
        const placeholderGroups = [];
        const placeholderMine = [];
        const placeholderOthers = [];
        for (const u of users) {
          const isMine = String(u.email || '').toLowerCase() === me;
          // Build N skeleton items so the dotted ring renders with the
          // right count + viewed/unviewed mix. We don't know which exact
          // items are viewed — only that `count - unviewed` are. Fill
          // viewed ones first to keep the leading bubble unviewed (matches
          // status_list's "freshest unviewed first" sort within a group).
          const total = Math.max(0, Number(u.count) || 0);
          const unviewed = Math.max(0, Math.min(total, Number(u.unviewed) || 0));
          const items = [];
          for (let i = 0; i < total; i++) {
            const viewed = i < (total - unviewed);
            items.push({
              id: `__manifest_${u.email}_${i}`,
              type: u.has_video ? 'video' : 'image',
              media_url: '',
              thumbnail_url: '',
              hls_url: '',
              bgColor: '#6D28D9',
              bg_color: '#6D28D9',
              created_at: u.latest_at,
              timestamp: u.latest_at,
              viewed,
              view_count: 0,
              views: 0,
              meta: null,
              _placeholder: true,
            });
          }
          if (items.length === 0) continue;
          const g = {
            email: u.email,
            name: u.name || (u.email || '').split('@')[0],
            is_own: !!u.is_own,
            items,
          };
          placeholderGroups.push(g);
          if (isMine) placeholderMine.push(...items);
          else placeholderOthers.push({
            ownerEmail: u.email,
            ownerName: g.name,
            items,
          });
        }
        if (placeholderGroups.length === 0) return;
        // DON'T set fpRef — placeholders have no real ids/created_at, so
        // when the real fetch completes the fingerprint diff WILL see a
        // change and replace them seamlessly.
        setGroups(placeholderGroups);
        setMine(placeholderMine);
        setOthers(placeholderOthers);
        setLoading(false);
      } catch {}
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, currentEmail]);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // [silent-fail-w3] Schedule a single short retry on transient failure so the
  // ring strip doesn't sit empty forever when a status_list call dies on flaky
  // network. Belt-and-suspenders with the regular pollMs timer (which is 30s+);
  // the 5s retry covers the gap where the user opens the app on a half-dead
  // connection and the next poll is half a minute away.
  const retryTimerRef = useRef(null);
  const scheduleRetry = useCallback(() => {
    if (retryTimerRef.current || !mountedRef.current) return;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      if (mountedRef.current) refetchRef.current?.();
    }, 5000);
  }, []);
  const refetchRef = useRef(null);

  const refetch = useCallback(async () => {
    if (!enabled) return;
    try {
      const r = await api.statusList?.();
      if (!mountedRef.current) return;
      if (!r?.success || !r.data) {
        // [silent-fail-w3] Non-success response with no data: arrange a single
        // 5s retry. Previously this just stopped — if it failed during cold
        // start the strip stayed empty until the next 30s poll tick.
        console.warn('[silent-fail-w3] useStatuses non-success', r?.message);
        scheduleRetry();
        setLoading(false);
        return;
      }
      const norm = _normalize(r.data, currentEmail);
      const fp = _fingerprint(norm.mine, norm.others);
      if (fp !== fpRef.current) {
        fpRef.current = fp;
        setGroups(norm.groups);
        setMine(norm.mine);
        setOthers(norm.others);
        if (warmCacheVideos) _warmCacheVideos(norm.mine, norm.others);
        // Web/PWA: ask the SW to pre-cache visible covers + first hero so
        // tap-to-open paints from disk instead of a fresh CDN round trip.
        if (Platform.OS === 'web') _swPrefetch(norm.mine, norm.others);
        // Persist to disk + MMKV. Fire-and-forget; failures are silent.
        setCache('statuses', { groups: norm.groups, mine: norm.mine, others: norm.others }, 2592000000).catch(() => {});
        _writeMMKV({ groups: norm.groups, mine: norm.mine, others: norm.others });
      }
    } catch (e) {
      // [silent-fail-w3] Network/throw: keep current UI state but arm a 5s
      // retry. Was completely silent before, contributing to "status strip
      // looks broken" reports after spotty connection drops.
      console.warn('[silent-fail-w3] useStatuses threw', e?.message);
      scheduleRetry();
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [currentEmail, enabled, warmCacheVideos, scheduleRetry]);

  // Keep ref in sync so scheduleRetry can call the latest refetch without
  // depending on it (would cause a re-create loop).
  useEffect(() => { refetchRef.current = refetch; }, [refetch]);
  useEffect(() => () => {
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    refetch();

    // WebSocket: instant deltas. Debounced 600ms because a multi-item
    // carousel publish fires N status_new events <50ms apart and we don't
    // want N reloads.
    let wsTimer = null;
    const scheduleReload = () => {
      if (wsTimer) clearTimeout(wsTimer);
      wsTimer = setTimeout(() => { wsTimer = null; refetch(); }, 600);
    };
    const subs = [];
    if (_mailWs?.on) {
      subs.push(_mailWs.on('status_new', scheduleReload));
      subs.push(_mailWs.on('status_update', scheduleReload));
    }

    // Belt-and-suspenders polling against a missed WS frame.
    const poll = setInterval(refetch, pollMs);
    return () => {
      clearInterval(poll);
      if (wsTimer) clearTimeout(wsTimer);
      for (const u of subs) { try { u?.(); } catch {} }
    };
  }, [refetch, pollMs, enabled]);

  // Optimistic mark-viewed. Mutates both shapes so renderers stay consistent
  // even if they only listen to one. Backend status_view is fire-and-forget;
  // the next refetch will reconcile if the call failed.
  const markViewed = useCallback((statusId) => {
    const stamp = new Date().toISOString();
    setMine(prev => prev.map(it => it.id === statusId ? { ...it, viewed: true, viewed_at: stamp } : it));
    setOthers(prev => prev.map(g => ({
      ...g,
      items: (g.items || []).map(it => it.id === statusId ? { ...it, viewed: true, viewed_at: stamp } : it),
    })));
    setGroups(prev => prev.map(g => ({
      ...g,
      items: (g.items || []).map(it => it.id === statusId ? { ...it, viewed: true, viewed_at: stamp } : it),
    })));
    // Invalidate fingerprint so the next poll/WS doesn't see "no change"
    // and skip persisting the viewed flag to MMKV.
    fpRef.current = null;
  }, []);

  // Optimistic remove (own delete flow). Removes the item from `mine` and
  // also from the corresponding `groups` entry so the row collapses cleanly.
  const removeStatus = useCallback((statusId) => {
    setMine(prev => prev.filter(it => it.id !== statusId));
    setGroups(prev => prev.map(g => ({
      ...g,
      items: (g.items || []).filter(it => it.id !== statusId),
    })).filter(g => (g.items || []).length > 0));
    setOthers(prev => prev.map(g => ({
      ...g,
      items: (g.items || []).filter(it => it.id !== statusId),
    })).filter(g => (g.items || []).length > 0));
    fpRef.current = null;
  }, []);

  // Optimistic remove of an entire group by owner email (mute flow).
  // Drops the row from `groups` + `others` so the home strip collapses
  // immediately; the next refetch from the server (which already filters
  // muted users in chat_status_mutes) keeps it gone.
  const removeGroup = useCallback((email) => {
    const lc = String(email || '').toLowerCase();
    if (!lc) return;
    setGroups(prev => prev.filter(g => String(g.email || '').toLowerCase() !== lc));
    setOthers(prev => prev.filter(g => String(g.email || '').toLowerCase() !== lc));
    fpRef.current = null;
  }, []);

  // Archive a single status locally. Mirrors `removeStatus` but the
  // intent is "hide from the strip, keep recoverable" — once the backend
  // ships `status_archive`, the caller can fire-and-forget the API at the
  // same time. For now, this is purely client-side optimistic feedback.
  // TODO: consumers should also call api.statusArchive when available so
  // the hidden flag survives across devices + restarts.
  const archiveStatus = useCallback((statusId) => {
    if (!statusId) return;
    setMine(prev => prev.filter(it => it.id !== statusId));
    setGroups(prev => prev.map(g => ({
      ...g,
      items: (g.items || []).filter(it => it.id !== statusId),
    })).filter(g => (g.items || []).length > 0));
    setOthers(prev => prev.map(g => ({
      ...g,
      items: (g.items || []).filter(it => it.id !== statusId),
    })).filter(g => (g.items || []).length > 0));
    fpRef.current = null;
  }, []);

  return { groups, mine, others, loading, refetch, markViewed, removeStatus, removeGroup, archiveStatus };
}
