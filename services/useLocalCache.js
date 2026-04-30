// Hook: useLocalCache — drop-in cache-first pattern for any screen
// Usage: const { data, loading, refresh } = useLocalCache('feed_posts', () => api.feedList());
//
// 1. Shows cached data INSTANTLY (0ms)
// 2. Fetches fresh in background
// 3. Updates UI when fresh data arrives
// 4. Never crashes — if SQLite fails, works like normal (just no cache)

import { useState, useEffect, useCallback, useRef } from 'react';

let _safeDb = null;
try { _safeDb = require('./safeDb'); } catch {}

export default function useLocalCache(key, apiFn, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    // 1. Try cache first (instant). Use != null check so empty arrays/strings/0
    // are treated as valid cached values (e.g. an empty inbox is real data).
    if (_safeDb?.getCache) {
      try {
        const cached = await _safeDb.getCache(key);
        if (cached != null && mountedRef.current) {
          setData(cached);
          setLoading(false);
        }
      } catch {}
    }

    // 2. Fetch fresh from API
    try {
      const result = await apiFn();
      if (!mountedRef.current) return;

      const freshData = result?.data ?? result;
      if (freshData != null && result?.success !== false) {
        setData(freshData);
        if (_safeDb?.setCache) {
          _safeDb.setCache(key, freshData).catch(() => {});
        }
      }
    } catch {} finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [key, apiFn, ...deps]);

  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async () => {
    setLoading(true);
    await load();
  }, [load]);

  return { data, loading, refresh, setData };
}
