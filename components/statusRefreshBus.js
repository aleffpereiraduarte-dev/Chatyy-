// statusRefreshBus — tiny EventEmitter shim so the parent ChatListTab's
// pull-to-refresh can poke the inner StatusStoriesRow into a refetch
// without restructuring the hook ownership (StatusStoriesRow owns the
// useStatuses instance; lifting it to the parent would re-mount the strip
// on every conversations change because parent re-renders constantly).
//
// One topic ('refresh'). Multiple subscribers are fine — every mounted
// strip refetches on emit. Idempotent thanks to useStatuses fingerprint
// diff (no-change responses don't re-render the row).
const listeners = new Set();

export default {
  on(_topic, fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  emit(_topic, ...args) {
    for (const fn of listeners) {
      try { fn(...args); } catch {}
    }
  },
};
