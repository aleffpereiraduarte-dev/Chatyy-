# expo-rtmp-publisher

Native RTMP/RTMPS publisher for Expo. Pushes the device camera + microphone
straight into an RTMP ingest endpoint — designed for Cloudflare Stream Live
(`rtmps://live.cloudflare.com:443/live/{streamKey}`), but works with any RTMP
ingest (Twitch, YouTube Live, NGINX-RTMP, etc.).

> **Status: SKELETON.** API surface and native module wiring are in place, but
> the actual RTMP send path is not implemented yet. The native methods resolve
> immediately without doing real work. See the [TODO checklist](#todo--finish-the-implementation)
> at the bottom.

## Why

Chatyy Live (Round 54+) needs higher concurrency than mesh WebRTC can give us.
The flow is:

```
 host device  ──RTMPS──▶  Cloudflare Stream Live  ──HLS──▶  N viewers
```

The host runs this module to push 1× video stream up. Viewers consume the
public HLS playback URL — no SFU on our side, no peer scaling concerns.

## Integration

### 1. Add to `app.json`

The module is autolinked because it lives under `/modules/`. No `app.json` edit
is required for autolink, but you must rebuild natively:

```bash
# native rebuild required — this is a new native module
scripts/ship.sh ios "add expo-rtmp-publisher native"
```

### 2. Permissions

Already covered by the app's existing camera + mic permissions (we use them for
calls). If you ever strip those, re-add:

- **iOS** `Info.plist`: `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`
- **Android** `AndroidManifest.xml`: `android.permission.CAMERA`, `android.permission.RECORD_AUDIO`, `android.permission.INTERNET`

### 3. Usage

```ts
import { RtmpPublisher, cfStreamUrl } from 'expo-rtmp-publisher';

// fetch from your backend (must NEVER ship the streamKey in client code)
const { streamKey } = await api.liveBroadcastStart();

const offStatus = RtmpPublisher.onStatusChange(({ status, reason }) => {
  console.log('[rtmp]', status, reason ?? '');
});
const offStats = RtmpPublisher.onStats((s) => {
  console.log('[rtmp] bitrate=', s.bitrateBps, 'fps=', s.fps);
});

await RtmpPublisher.start({
  url: cfStreamUrl(), // rtmps://live.cloudflare.com:443/live
  streamKey,
  width: 1280,
  height: 720,
  fps: 30,
  videoBitrate: 2_500_000,
  audioBitrate: 128_000,
  camera: 'back',
});

// ...later...
await RtmpPublisher.switchCamera();
await RtmpPublisher.setMuted(true);
await RtmpPublisher.stop();

offStatus();
offStats();
```

## Native dependencies

These need to be added when finishing the implementation — they're commented
out in the build files today:

### iOS — HaishinKit

[HaishinKit.swift](https://github.com/HaishinKit/HaishinKit.swift) is the
Swift RTMP/HLS/RTSP framework. Two integration paths:

#### Option A (recommended): CocoaPods

In `modules/expo-rtmp-publisher/ios/ExpoRtmpPublisher.podspec`, uncomment:

```ruby
s.dependency 'HaishinKit', '~> 1.9'
```

#### Option B: Swift Package Manager

Add to host app's Xcode project (`File → Add Package Dependency`):

```
https://github.com/HaishinKit/HaishinKit.swift
```

iOS deployment target: **15.0+**.

### Android — RootEncoder (pedroSG94)

[RootEncoder](https://github.com/pedroSG94/RootEncoder) (formerly
`rtmp-rtsp-stream-client-java`) handles Camera2 + MediaCodec + RTMP/RTMPS.

#### Step 1: ensure JitPack is in the project repos

In the host app's root `android/build.gradle` (or `settings.gradle`):

```gradle
allprojects {
  repositories {
    google()
    mavenCentral()
    maven { url 'https://jitpack.io' }   // ← required for RootEncoder
  }
}
```

#### Step 2: uncomment the dep

In `modules/expo-rtmp-publisher/android/build.gradle`:

```gradle
dependencies {
  implementation 'com.github.pedroSG94.RootEncoder:library:2.4.4'
}
```

Min SDK: **21**.

## File layout

```
modules/expo-rtmp-publisher/
├── package.json
├── expo-module.config.json
├── README.md                                ← you are here
├── src/
│   └── index.ts                             ← TS API surface
├── ios/
│   ├── ExpoRtmpPublisher.podspec
│   └── ExpoRtmpPublisherModule.swift        ← Swift bridge (stub)
└── android/
    ├── build.gradle
    └── src/main/java/expo/modules/rtmp/
        └── ExpoRtmpPublisherModule.kt       ← Kotlin bridge (stub)
```

## API surface

```ts
interface RtmpStartOptions {
  url: string;                    // e.g. 'rtmps://live.cloudflare.com:443/live'
  streamKey: string;              // from Cloudflare Stream / your provider
  videoBitrate?: number;          // default 2_500_000 bps
  audioBitrate?: number;          // default 128_000 bps
  width?: number;                 // default 1280
  height?: number;                // default 720
  fps?: number;                   // default 30
  camera?: 'front' | 'back';      // default 'back'
  sampleRate?: number;            // default 44100
}

type RtmpStatus =
  | 'idle' | 'connecting' | 'publishing'
  | 'reconnecting' | 'stopped' | 'error';

interface RtmpStats {
  bitrateBps: number;
  fps: number;
  droppedFrames: number;
  bytesSent: number;
  rttMs?: number;
}

const RtmpPublisher = {
  start(opts: RtmpStartOptions): Promise<void>;
  stop(): Promise<void>;
  switchCamera(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setVideoEnabled(enabled: boolean): Promise<void>;
  getStatus(): RtmpStatus;
  getStats(): RtmpStats | null;

  onStatusChange(cb: (data: { status: RtmpStatus; reason?: string }) => void): () => void;
  onStats(cb: (data: RtmpStats) => void): () => void;
  onError(cb: (data: { code: string; message: string }) => void): () => void;
  onConnected(cb: (data: { url: string }) => void): () => void;
  onDisconnected(cb: (data: { reason?: string }) => void): () => void;
};

function cfStreamUrl(): string; // 'rtmps://live.cloudflare.com:443/live'
```

## TODO — finish the implementation

Estimate: **4–6 hours** for a working v1 (no preview, no adaptive bitrate),
**~1 day** to ship with preview view + adaptive bitrate + reconnect.

### Phase 1 — wire native deps (30 min)

- [ ] iOS: uncomment `s.dependency 'HaishinKit'` in the podspec
- [ ] iOS: `cd ios && pod install` (or rely on `expo prebuild`)
- [ ] Android: ensure JitPack repo is in the root `build.gradle`
- [ ] Android: uncomment `implementation 'com.github.pedroSG94.RootEncoder:library:...'`
- [ ] Test that the module still autolinks + builds (`expo run:ios` / `expo run:android`)

### Phase 2 — iOS implementation (1.5–2 h)

- [ ] `ExpoRtmpPublisherModule.swift`: replace TODO blocks with HaishinKit
  - `RTMPConnection` + `RTMPStream` setup
  - `attachCamera` (front/back) + `attachAudio`
  - `videoSettings` (size, bitRate, profileLevel `H264_High_AutoLevel`, keyFrame=2s)
  - `audioSettings` (bitRate, sampleRate=44100, channels=2)
  - subscribe to `.rtmpStatusEvent` notification → translate to `onStatusChange` / `onConnected` / `onError`
- [ ] Handle `AVCaptureSession` interruption (phone call, app background) — pause encode
- [ ] `switchCamera`: rebind `AVCaptureDevice` mid-stream without dropping connection
- [ ] `setMuted` / `setVideoEnabled`: toggle `rtmpStream.hasAudio` / `.hasVideo`

### Phase 3 — Android implementation (1.5–2 h)

- [ ] `ExpoRtmpPublisherModule.kt`: replace TODO blocks with RootEncoder
  - Needs an `Activity` context — get via `appContext.currentActivity` or use a hidden `OpenGlView` mounted on a singleton service
  - `RtmpCamera2(context, ConnectCheckerRtmp)` + `prepareVideo` + `prepareAudio`
  - `startStream("$url/$streamKey")` and translate `ConnectCheckerRtmp` callbacks to JS events
- [ ] Handle Android camera lifecycle (foreground service for backgrounded broadcasts)
- [ ] `switchCamera` via `rtmpCamera.switchCamera()`
- [ ] `setMuted` via `disableAudio()` / `enableAudio()`

### Phase 4 — polish (1–2 h)

- [ ] Adaptive bitrate (drop quality on packet loss)
- [ ] Reconnect logic on transient network drop (`onConnectionFailedRtmp`)
- [ ] Periodic `onStats` emit every 1s (bitrate, fps, dropped frames, bytes sent)
- [ ] Foreground notification on Android while publishing (required for camera access in background on API 28+)
- [ ] iOS: keep screen awake during publish (`UIApplication.shared.isIdleTimerDisabled`)

### Phase 5 (optional) — preview view

- [ ] Expose an `<RtmpPreviewView />` component (Expo View Manager) that renders
      the local camera preview. HaishinKit has `MTHKView` (Metal) and RootEncoder
      has `OpenGlView`. Skipping in v1 since most broadcast UIs use a separate
      `expo-camera` preview anyway and switch over.

## Caveats

- **Stream key handling.** Do NOT ship the stream key in the bundle. Fetch it
  from your backend per-broadcast (Cloudflare Stream's API issues a new key per
  live input). The backend should also rotate keys on broadcast end.
- **Background publish.** iOS: works while screen is on; full background needs
  `audio` background mode + ReplayKit (out of scope). Android: needs a
  `MEDIA_PROJECTION` foreground service if you want camera in background.
- **Audio routing.** While publishing, our existing `expo-audio-session` module
  should NOT activate `.playAndRecord` — RTMP capture wants exclusive mic
  access. Coordinate at the JS layer (don't start a call while live, and vice
  versa).
- **Cloudflare ingest URL.** Cloudflare currently accepts both `rtmps://`
  (TLS, port 443) and `rtmp://` (plain, port 1935). Use RTMPS in production —
  it's the only one that works behind corporate firewalls and the only one
  Apple is happy with for App Store reviews.
