// [2026-10-11 boot-split] NATIVE LiveKit loader — synchronous, identical to the
// previous direct require('livekit-client') / require('@livekit/react-native')
// calls. See services/lkLoader.js (web) for why this indirection exists.
//
// [2026-10-17 pre-release] livekit-client 2.19 evaluates
// `class DeferrableMapAbortError extends DOMException` at MODULE TOP LEVEL.
// Hermes has no DOMException; only @livekit/react-native's index installs the
// polyfill. A first require('livekit-client') from a hook effect (useLiveStage /
// useOpponentRoom on a cold start straight into /live-viewer, before
// _layout's afterFirstPaint registerGlobals) threw "Property 'DOMException'
// doesn't exist" — and Metro's guardedLoadModule reports it as a FATAL even
// inside try/catch (prod: iOS 654 ota 01a141b8, Android 674 ota 01a1488e, up=1).
// Install the same minimal polyfill as @livekit/react-native (it skips its own
// when one already exists) before every livekit-client require.
export function ensureDomException() {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : global;
    if (typeof g.DOMException === 'undefined') {
      class PolyfillDOMException extends Error {
        constructor(message = '', name) {
          super(message);
          this.message = message;
          this.name = name ?? 'Error';
          this.code = 0;
          Object.setPrototypeOf(this, PolyfillDOMException.prototype);
        }
      }
      g.DOMException = PolyfillDOMException;
    }
  } catch {}
}

export function lkSync() { ensureDomException(); return require('livekit-client'); }

export function loadLiveKit() {
  try { ensureDomException(); return Promise.resolve(require('livekit-client')); } catch (e) { return Promise.reject(e); }
}

export function lkRn() { ensureDomException(); return require('@livekit/react-native'); }

export function withLiveKit(Component) { return Component; }
