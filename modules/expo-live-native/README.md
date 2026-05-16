# expo-live-native

Native Live broadcast (host + viewer) for Chatyy. Replaces the JS `@livekit/
react-native VideoView` path which caused black flashes / flicker on the
host preview screen.

## Status

**Scaffold only (2026-05-15).** Android Compose UI + LiveKit Android SDK
bindings are in place but not yet wired into the JS app screens
(`app/live-broadcast.js`, `app/live-viewer.js`). iOS half is reserved in
`expo-module.config.json` but the implementation lives in a follow-up.

## Architecture

```
JS (services/liveNative.js)
        │
        ▼  requireNativeModule('ExpoLiveNative')
ExpoLiveNativeModule.kt   ──── async funcs: openHost, openViewer, closeLive
        │                      events: onLiveEnded, onLiveError,
        │                              onViewerJoined, onLikeReceived
        ▼
Intent → LiveHostActivity / LiveViewerActivity (Compose)
        │
        ▼
LiveRoomConnection (singleton)  ── wraps io.livekit.android.room.Room
        │
        ▼  org.webrtc.SurfaceViewRenderer (via LiveVideoTrackView)
        Render local/remote VideoTrack
```

## Why two activities + a singleton?

The Live screen MUST be full-screen and survive Compose-tree rebuilds during
network blips. Running it inside the host RN Activity would force us to
solve fragment lifecycle + back-stack semantics on top of LiveKit's
reconnect logic. Two dedicated `ComponentActivity`s keep that surface tiny
and let the OS handle window-level concerns.

`LiveRoomConnection` is a singleton because:
- Only one Live session can be alive at a time.
- The module needs to forward LiveKit events to JS even if the Activity is
  briefly off-screen (e.g. config change).
- The state flows are observed from both the Activity and the Module.

## Limits + TODOs (scaffold)

1. `LiveVideoTrackView` relies on LiveKit lazy-initing the EglBase on the
   `SurfaceViewRenderer`. If that ever stops working, init manually with
   `LiveKit.getDefaultsManager().eglBase`.
2. `switchCamera()` is a stub — needs `CameraCapturer.switchCamera()`.
3. Chat is "loaded in JS" — the in-stream overlay is a placeholder.
4. Hearts are visual-only; the data path (`like` payload via
   `room.publishData`) is wired but not deduped server-side.
5. No reconnect loop yet — we surface `RoomEvent.Reconnecting` to state
   flows but don't retry on `FailedToConnect`.
6. iOS implementation pending.

## Wiring later

To swap in the native UI for an existing screen:

```js
import * as liveNative from '../services/liveNative';

useEffect(() => {
  if (Platform.OS !== 'android' || !liveNative.isSupported()) return;

  const sub = liveNative.addListener('onLiveEnded', () => router.back());
  const errSub = liveNative.addListener('onLiveError', (p) => {
    Alert.alert('Live', p?.message || 'Falha');
  });

  liveNative.openLiveHost({ token, url, roomName, hostName });

  return () => { sub.remove(); errSub.remove(); liveNative.closeLive(); };
}, []);
```

Until that lands, the JS `@livekit/react-native` path remains the default.
