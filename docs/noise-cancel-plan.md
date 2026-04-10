# Noise Cancellation Plan

## Current State

- WebRTC already enables basic noise suppression via constraints:
  ```js
  { audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true } }
  ```
- This uses the browser/OS built-in noise suppression (decent but not great)
- iOS 16.4+ has system-level Voice Isolation in Control Center (excellent quality, free)
- No custom noise cancellation is currently implemented

## Options Comparison

| Option | Quality | Cost | Effort | Platform |
|--------|---------|------|--------|----------|
| WebRTC built-in `noiseSuppression` | Basic | Free | Already done | All |
| iOS Voice Isolation (system) | Excellent | Free | Documentation only | iOS 16.4+ |
| RNNoise (open source) | Good | Free | Medium (native module) | All |
| Web Audio API + RNNoise WASM | Good | Free | Medium (web only) | Web |
| Krisp SDK | Excellent | $$$ (per-minute) | Low (SDK) | All |
| Apple `AVAudioEngine` Voice Processing | Very Good | Free | Medium (native) | iOS only |

## Recommended Approach: Tiered Strategy

### Tier 1: Already Done (no work needed)
- WebRTC `noiseSuppression: true` is already in the getUserMedia constraints
- This provides basic background noise reduction on all platforms

### Tier 2: iOS Voice Isolation Documentation (0.5 day)
iOS 16.4+ has **Voice Isolation** mode that provides Apple-grade noise cancellation at the system level. Users can enable it from Control Center during a call.

**Implementation**: Add a tooltip/info button in the call screen that explains how to enable it:
1. During a call, swipe down from top-right to open Control Center
2. Long-press the Mic Mode tile
3. Select "Voice Isolation"

This gives users access to Apple's ML-powered noise cancellation with zero development effort.

**Code change**: Add an info button in the call UI that shows this tip on iOS:
```js
{Platform.OS === 'ios' && (
  <TouchableOpacity onPress={() => Alert.alert(
    t('call.noiseTip'),
    t('call.noiseTipBody')
  )}>
    <Text>Noise tips</Text>
  </TouchableOpacity>
)}
```

### Tier 3: RNNoise Integration (3-5 days)
[RNNoise](https://github.com/xiph/rnnoise) is a recurrent neural network trained for real-time noise suppression. It runs entirely on CPU, adds ~5ms latency, and handles:
- Keyboard typing
- Background conversations
- Fan/AC noise
- Street noise

#### Web Implementation (via WASM)
1. Use `@nickkjolsing/rnnoise-wasm` or compile RNNoise to WASM
2. Create an AudioWorklet that processes audio frames through RNNoise
3. Insert the worklet between getUserMedia and the WebRTC peer connection:
   ```
   Mic -> RNNoise AudioWorklet -> RTCPeerConnection
   ```
4. File: `services/noiseCancel.js`

```js
// Conceptual implementation
class NoiseCanceller {
  async init() {
    this.audioCtx = new AudioContext({ sampleRate: 48000 });
    await this.audioCtx.audioWorklet.addModule('/rnnoise-worklet.js');
    this.rnnoiseNode = new AudioWorkletNode(this.audioCtx, 'rnnoise-processor');
  }

  processStream(mediaStream) {
    const source = this.audioCtx.createMediaStreamSource(mediaStream);
    const dest = this.audioCtx.createMediaStreamDestination();
    source.connect(this.rnnoiseNode);
    this.rnnoiseNode.connect(dest);
    return dest.stream;
  }
}
```

#### Native Implementation (iOS/Android)
1. Create an Expo native module: `modules/expo-rnnoise/`
2. iOS: Compile RNNoise as a static library, process audio via `AVAudioEngine` tap
3. Android: Compile RNNoise via NDK, process audio via `AudioRecord` / `AudioTrack`
4. The native module intercepts the audio before it reaches WebRTC

**Alternative for native**: Use `react-native-audio-api` (Web Audio API for React Native) and the same WASM approach as web. This would unify the implementation.

### Tier 4: Apple AVAudioEngine Voice Processing (2 days, iOS only)
iOS provides `AVAudioEngine` with `.voiceProcessing` IO node that includes:
- Echo cancellation
- Noise suppression
- Automatic gain control

This is better than WebRTC's built-in processing because it uses Apple's hardware-accelerated ML models.

**Implementation**:
1. In the existing `modules/expo-audio-session/` native module:
   ```swift
   let engine = AVAudioEngine()
   let inputNode = engine.inputNode
   // Enable voice processing
   try inputNode.setVoiceProcessingEnabled(true)
   ```
2. Route the processed audio to WebRTC
3. This requires the `expo-audio-session` native module to be updated

## User-Facing UI

### Settings Toggle
In the call settings or the "More" sheet during a call:
- "Noise Cancellation" toggle (on/off)
- When RNNoise is integrated: shows "AI Noise Cancellation" with a badge
- On iOS: additional tip about Voice Isolation

### Visual Indicator
When noise cancellation is active:
- Small icon in the top bar next to the E2E encryption badge
- Tooltip: "Noise cancellation is active"

## Estimated Timeline

| Phase | Effort | Impact |
|-------|--------|--------|
| iOS Voice Isolation docs/tip | 0.5 day | High (iOS users get Apple-grade NC for free) |
| RNNoise WASM (web) | 2-3 days | Medium (web users get good NC) |
| RNNoise native (iOS+Android) | 3-5 days | High (all users get good NC) |
| AVAudioEngine (iOS) | 2 days | High (iOS users get great NC) |

### Recommended order:
1. **Tier 2** first (0.5 day) - immediate value for iOS users
2. **Tier 4** next (2 days) - excellent iOS NC with no external dependencies
3. **Tier 3 web** (2-3 days) - bring web up to parity
4. **Tier 3 native Android** (2-3 days) - complete coverage

Total for full implementation: ~7-10 days

## Performance Considerations
- RNNoise processes 10ms frames at 48kHz = 480 samples per frame
- CPU usage: ~2-5% on modern devices (negligible)
- Latency: ~5ms added (imperceptible)
- Memory: ~2MB for the model weights
- Battery impact: minimal (less than camera usage)

## Risks
- WASM AudioWorklet may not work in all browsers (Safari support varies)
- Native RNNoise compilation may have issues on older Android NDK versions
- Voice Isolation on iOS is user-controlled (can't enable programmatically)
- Some users may prefer no NC (e.g., musicians) - always provide a toggle
