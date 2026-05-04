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
import { setCache } from '../services/cache';

let _mailWs = null;
try { _mailWs = require('../services/websocket').default; } catch {}

let _cacheMedia = null;
try { _cacheMedia = require('../services/mediaCache').cacheMedia; } catch {}

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
  for (const _g of groupsArr) {
    const items = (_g.items || _g.statuses || []).map(it => ({
      ...it,
      // The full UI uses `bgColor` (camel); home reads `bg_color`. Provide both.
      bgColor: it.bg_color || it.bgColor || '#6D28D9',
      timestamp: it.created_at,
    }));
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

export default function useStatuses(currentEmail, opts = {}) {
  const {
    warmCacheVideos = true,
    pollMs = 120000,
    enabled = true,
  } = opts;

  // Synchronous MMKV preload so the first paint already shows yesterday's
  // groups — no spinner flash on cold start. Web and the first-ever launch
  // fall through to the fetch.
  const _preload = (enabled ? _readMMKVOnce() : null);
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
  const [loading, setLoading] = useState(!_hadPreload);
  const fpRef = useRef(_hadPreload ? _fingerprint(_initialNorm.mine, _initialNorm.others) : null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const refetch = useCallback(async () => {
    if (!enabled) return;
    try {
      const r = await api.statusList?.();
      if (!mountedRef.current) return;
      if (!r?.success || !r.data) { setLoading(false); return; }
      const norm = _normalize(r.data, currentEmail);
      const fp = _fingerprint(norm.mine, norm.others);
      if (fp !== fpRef.current) {
        fpRef.current = fp;
        setGroups(norm.groups);
        setMine(norm.mine);
        setOthers(norm.others);
        if (warmCacheVideos) _warmCacheVideos(norm.mine, norm.others);
        // Persist to disk + MMKV. Fire-and-forget; failures are silent.
        setCache('statuses', { groups: norm.groups, mine: norm.mine, others: norm.others }, 2592000000).catch(() => {});
        _writeMMKV({ groups: norm.groups, mine: norm.mine, others: norm.others });
      }
    } catch {
      // Network errors are silent — UI keeps showing whatever it had.
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [currentEmail, enabled, warmCacheVideos]);

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

  return { groups, mine, others, loading, refetch, markViewed, removeStatus, removeGroup };
}
