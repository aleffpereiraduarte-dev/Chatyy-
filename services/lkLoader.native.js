// [2026-10-11 boot-split] NATIVE LiveKit loader — synchronous, identical to the
// previous direct require('livekit-client') / require('@livekit/react-native')
// calls. See services/lkLoader.js (web) for why this indirection exists.
export function lkSync() { return require('livekit-client'); }

export function loadLiveKit() {
  try { return Promise.resolve(require('livekit-client')); } catch (e) { return Promise.reject(e); }
}

export function lkRn() { return require('@livekit/react-native'); }

export function withLiveKit(Component) { return Component; }
