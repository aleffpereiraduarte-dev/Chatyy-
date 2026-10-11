// [2026-10-11 boot-split] WEB LiveKit loader.
//
// livekit-client (~1 MB) used to be statically reachable from 6+ async chunks
// (call, group-call, live-*, pstnCall, livePrewarm...) and, through
// `@livekit/react-native` (whose web entry is lib/commonjs → livekit-client UMD),
// from app/_layout. Metro's web serializer puts every module shared by 2+ async
// chunks into `__common`, which the browser downloads + parses before first
// paint. So BOTH copies (ESM + UMD, ~1.07 MB) shipped at boot and were never run.
//
// Rule now: nobody imports 'livekit-client' / '@livekit/react-native' directly.
//   • loadLiveKit()  → Promise<module>  (the ONE dynamic import → own chunk)
//   • lkSync()       → module | null    (sync accessor, after load)
//   • lkRn()         → null on web      (@livekit/react-native is native-only)
//   • withLiveKit(C) → route wrapper: renders C once livekit-client is loaded,
//                      so the existing synchronous lkSync() call sites inside
//                      the call/live screens keep working unchanged.
// The native twin (lkLoader.native.js) is plain synchronous require — native
// behavior is identical to before.
import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';

let _lk = null;
let _p = null;

export function lkSync() { return _lk; }

export function loadLiveKit() {
  if (_lk) return Promise.resolve(_lk);
  if (!_p) {
    _p = import('livekit-client').then((m) => { _lk = m; return m; }, (e) => { _p = null; throw e; });
  }
  return _p;
}

export function lkRn() { return null; }

function LiveKitFallback() {
  return (
    <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color="#fff" />
    </View>
  );
}

export function withLiveKit(Component) {
  function LiveKitGate(props) {
    const [ready, setReady] = useState(!!_lk);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      if (ready) return undefined;
      let alive = true;
      loadLiveKit().then(() => { if (alive) setReady(true); }, () => { if (alive) setFailed(true); });
      return () => { alive = false; };
    }, [ready]);
    // On load failure render the screen anyway: every lkSync() site already
    // handles a missing SDK (same path as a failed require before).
    if (!ready && !failed) return <LiveKitFallback />;
    return <Component {...props} />;
  }
  LiveKitGate.displayName = 'withLiveKit(' + (Component.displayName || Component.name || 'Screen') + ')';
  return LiveKitGate;
}
