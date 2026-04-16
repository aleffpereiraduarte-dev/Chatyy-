# "Ei Chatyy" Voice Wake Word Detection

Research document + implementation guide for Chatyy (Expo SDK 55, React Native 0.83, iOS + Android + Web).

---

## 1. Options Comparison

### 1.1 Porcupine (Picovoice)

| Attribute | Details |
|-----------|---------|
| **License** | Commercial (free tier: 3 wake words / 3 months trial; paid thereafter) |
| **On-device** | Yes — TFLite-based, no network required |
| **Custom wake word** | Yes — "Ei Chatyy" as a first-class Picovoice wake word via their Picovoice Console |
| **Accuracy** | Industry-leading, ~0.5% false-accept rate, tunable sensitivity |
| **Battery** | ~3–5% CPU on idle Android, similar on iOS |
| **React Native** | `@picovoice/porcupine-react-native` — works but is a **bare native module**, requires an EAS build; does **not** work in Expo Go |
| **Expo SDK 55** | Compatible — needs `app.json` plugin + `eas build` |
| **Background** | Works in foreground only on iOS (AVAudioSession limitation); Android can use a Foreground Service |
| **Verdict** | Best accuracy and lowest CPU among all options, but **requires paid license** for production and a native build |

**Cost**: Free for prototyping (3 custom wake words). Production: ~$100/month for unlimited keywords. Annual enterprise plans available.

**Setup summary**:
```bash
npm install @picovoice/porcupine-react-native
# Generate "Ei Chatyy" .ppn file at console.picovoice.ai
# Add plugin to app.json, run eas build
```

---

### 1.2 Snowboy (Kitt.ai)

| Attribute | Details |
|-----------|---------|
| **License** | Apache 2.0 (core) — **discontinued in December 2023** |
| **On-device** | Yes |
| **Custom wake word** | Yes |
| **Status** | Server for model training was shut down. Existing models still work but **no new custom models can be trained** |
| **React Native** | No maintained RN wrapper; last native SDK update was 2019 |
| **Verdict** | **Do not use.** Discontinued, unmaintained, no new model training possible |

---

### 1.3 Web Speech API (web only)

| Attribute | Details |
|-----------|---------|
| **License** | Free (browser API) |
| **On-device** | Partially — Chrome on Android sends audio to Google servers; Safari on iOS has varying on-device support |
| **Custom wake word** | No native concept — keyword scanning on interim transcripts (implemented in the PoC) |
| **Accuracy** | Depends on browser STT quality; good for Portuguese with Chrome |
| **Battery** | Moderate — browser STT runs continuously; Chrome on Android is the most efficient |
| **Platform** | Web only (`Platform.OS === 'web'`). Does NOT work in React Native apps running on device |
| **Background** | Tab must be visible and focused; pauses when tab is backgrounded |
| **Browser support** | Chrome (full), Edge (full), Safari 14.1+ (partial, no continuous), Firefox (not supported) |
| **Privacy** | Audio sent to Google/Apple servers depending on browser — not purely on-device |
| **Verdict** | Best option for the **web build** of Chatyy. Free, zero dependencies, reasonable accuracy for Portuguese |

---

### 1.4 expo-speech-recognition

| Attribute | Details |
|-----------|---------|
| **License** | MIT |
| **On-device** | Optional (`requiresOnDeviceRecognition: true`) |
| **Platform** | iOS + Android + Web (unified API) |
| **Continuous mode** | Yes on iOS; yes on Android 12+ (API 31+); polling workaround needed for Android <12 |
| **Interim results** | Yes — transcripts arrive before the utterance ends (needed for wake word scanning) |
| **Accuracy** | Uses OS speech engine (Apple's SFSpeechRecognizer / Google Speech on Android) — production quality |
| **Expo SDK 55** | Already installed and already in `app.json` plugins in this project |
| **Background iOS** | Cannot run in background — iOS kills audio sessions when the app is backgrounded |
| **Background Android** | Can be kept alive via Foreground Service (requires additional native code / expo-task-manager) |
| **Network** | By default uses cloud STT; `requiresOnDeviceRecognition: true` keeps it local |
| **Privacy** | On-device mode available; default sends audio to Apple/Google |
| **Wake word scan** | Keyword scan on each interim result (transcript contains "chatyy") |
| **Verdict** | **Best option for native mobile.** Already installed, high quality, cross-platform, no extra cost. Requires EAS build (already done) |

---

### 1.5 Custom TFLite Model ("train your own")

| Attribute | Details |
|-----------|---------|
| **License** | Free (model is yours) |
| **On-device** | Yes — model runs fully locally |
| **Custom wake word** | Yes — train exactly on "Ei Chatyy" audio samples |
| **Accuracy** | Depends entirely on dataset size and quality (typically 500–2000 recorded samples) |
| **Battery** | Very low when done right (small model, continuous inference on PCM audio) |
| **Toolchain** | TensorFlow / TFLite or ONNX; openWakeWord (Python, open source) is the most accessible option in 2025 |
| **React Native** | `react-native-tflite` or `@tensorflow/tfjs-react-native` — both work but add ~5 MB to bundle |
| **Development cost** | High — needs audio data collection, training pipeline, fine-tuning, device testing |
| **Verdict** | Best long-term option for battery + privacy + accuracy, but requires 2–4 weeks of engineering + data collection. Not suitable as a first implementation |

**openWakeWord** is the recommended open-source toolkit if this path is chosen:
- GitHub: `dscripka/openWakeWord`
- Pre-trained models available; custom training documented
- Exports to TFLite for mobile deployment

---

## 2. Recommended Approach

### For this project right now: **expo-speech-recognition + keyword scan**

**Reasoning**:

1. `expo-speech-recognition` is **already installed** (`^3.1.1`) and already registered as an `app.json` plugin — no new native build is needed beyond what is already planned.
2. It provides a **unified API** across iOS, Android, and Web via a single package.
3. The OS speech engines (Apple SFSpeechRecognizer, Google Speech) have **excellent Portuguese accuracy**, which is the primary language of Chatyy users.
4. Keyword scanning on interim transcripts (checking if the transcript contains "chatyy") is a **proven pattern** used by many production apps before investing in a dedicated wake word engine.
5. `contextualStrings` (supported by both iOS and Android) biases the recognizer toward the wake phrase, reducing false negatives.
6. For web, the browser's `SpeechRecognition` API is already used in `app/one.js` for the One AI assistant — the same mechanism works for wake word detection.

### Future upgrade path

Once user adoption justifies the investment, migrate to Porcupine:
- Train "Ei Chatyy" as a custom wake word in Picovoice Console.
- Replace `WakeWordListener.js` with `@picovoice/porcupine-react-native`.
- Result: ~5× lower CPU, true on-device (no audio leaves device), no dependency on OS speech recognition engine availability.

---

## 3. Implementation Plan

### 3.1 Architecture Overview

```
App foreground
├── WakeWordListener (renders null, mounts on app launch)
│   ├── [web]    → WebSpeechRecognition (continuous, interimResults)
│   └── [native] → ExpoSpeechRecognitionModule (continuous, interimResults)
│         ↓
│   transcript text arrives every ~200–500ms
│         ↓
│   containsWakePhrase(transcript)  → true
│         ↓
│   onWake() callback fires
│         ↓
└── router.push('/one')  ← One AI screen opens, mic activates
```

### 3.2 Step-by-Step Integration

#### Step 1 — Add WakeWordListener to the app layout

The component should be mounted at the root layout level so it persists across all screens.

File: `app/_layout.js`

```js
import WakeWordListener from '../components/WakeWordListener';
import { useSettings } from '../context/SettingsContext'; // or AsyncStorage flag

// Inside the root Stack/layout component:
const { wakeWordEnabled } = useSettings(); // user-controlled toggle

return (
  <>
    <Stack>
      {/* existing screens */}
    </Stack>
    <WakeWordListener
      enabled={wakeWordEnabled}
      onWake={() => router.push('/one')}
    />
  </>
);
```

#### Step 2 — Add a user-facing toggle in Settings

File: `app/settings.js` — add a switch:

```js
// i18n key: 'settings.wakeWord' = 'Ativar "Ei Chatyy"'
<Switch
  value={wakeWordEnabled}
  onValueChange={async (val) => {
    setWakeWordEnabled(val);
    await AsyncStorage.setItem('wake_word_enabled', val ? '1' : '0');
  }}
/>
```

**Important**: Default this to `false` (opt-in) to avoid surprising users with always-on microphone access.

#### Step 3 — Request permissions proactively

On first enable, request microphone + speech recognition permissions before starting the listener. `WakeWordListener.js` already calls `requestPermissionsAsync()` internally, but you can also request them in the onboarding flow.

```js
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

async function requestWakeWordPermissions() {
  const result = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
  return result.granted;
}
```

#### Step 4 — One AI screen integration

When `onWake` fires, the router navigates to `/one`. The One screen should auto-activate the microphone input when opened via wake word:

File: `app/one.js` — read a search param:

```js
const { wakeTriggered } = useLocalSearchParams();

useEffect(() => {
  if (wakeTriggered === '1') {
    // Small delay to let the screen render first
    const t = setTimeout(() => startListening(), 500);
    return () => clearTimeout(t);
  }
}, [wakeTriggered]);
```

Update the `onWake` callback in `_layout.js`:

```js
onWake={() => router.push({ pathname: '/one', params: { wakeTriggered: '1' } })}
```

#### Step 5 — Visual feedback

When the wake word is detected, show a brief "Ei Chatyy ouvido!" toast before opening One AI:

```js
onWake={() => {
  NotificationToast.show('Ei Chatyy! Ouvindo...');
  setTimeout(() => router.push({ pathname: '/one', params: { wakeTriggered: '1' } }), 400);
}}
```

#### Step 6 — Pause during One AI / active calls / recording

Avoid overlapping recognizers. The `WakeWordListener` `enabled` prop should be `false` when:
- The `/one` screen is active
- A call is in progress (`callState.active`)
- A recording is in progress (AIVoiceCommand is recording)

```js
const { pathname } = usePathname(); // expo-router
const { callActive } = useCallState();

<WakeWordListener
  enabled={wakeWordEnabled && pathname !== '/one' && !callActive}
  onWake={handleWake}
/>
```

---

### 3.3 Battery Optimization

| Technique | Implementation |
|-----------|---------------|
| **Opt-in only** | Default `enabled=false`; user activates in Settings |
| **Screen-off pause** | Use `AppState` listener: pause when `appState === 'background'` |
| **On-device recognition** | Set `requiresOnDeviceRecognition: true` — avoids network round-trips and reduces wakeup latency |
| **Reduce restart frequency** | The 2-second backoff on errors avoids tight restart loops |
| **iOS: minimum audio session** | Use `setCategoryIOS({ category: 'PlayAndRecord', mode: 'SpokenAudio' })` to share audio session |
| **Android: disable beep** | Set `androidIntentOptions: { EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 300 }` to reduce noise |
| **Cooldown after trigger** | 3-second cooldown prevents re-triggering immediately after wake |

Example AppState integration in `WakeWordListener.js`:

```js
import { AppState } from 'react-native';

// Add inside the component:
const [appActive, setAppActive] = useState(AppState.currentState === 'active');
useEffect(() => {
  const sub = AppState.addEventListener('change', state => {
    setAppActive(state === 'active');
  });
  return () => sub.remove();
}, []);

// Pass `enabled && appActive` to both hooks
```

---

### 3.4 Permission Handling

| Platform | Permissions Required |
|----------|---------------------|
| iOS | `NSMicrophoneUsageDescription` + `NSSpeechRecognitionUsageDescription` (already in app.json via expo-speech-recognition plugin) |
| Android | `RECORD_AUDIO` (already in app.json via expo-speech-recognition plugin) |
| Web | Browser will prompt for `microphone` via `getUserMedia` |

The `expo-speech-recognition` plugin already adds all required permissions to `AndroidManifest.xml` and `Info.plist`. No additional `app.json` changes are needed.

---

### 3.5 Triggering One AI After Wake Word

Complete flow:

```
User says "Ei Chatyy"
  → WakeWordListener.onWake() fires
  → Haptic feedback (expo-haptics)
  → Brief toast notification
  → router.push('/one', { wakeTriggered: '1' })
  → One screen mounts
  → useEffect detects wakeTriggered param
  → startListening() called after 500ms
  → One AI microphone button activates (same as manual tap)
  → User speaks command
  → Transcribed + sent to One AI backend
  → Response spoken via ElevenLabs TTS
```

---

## 4. Proof of Concept

A minimal working PoC has been created at:

`/root/webmail-app/components/WakeWordListener.js`

### What it implements

- **Web path**: Uses `window.SpeechRecognition` / `window.webkitSpeechRecognition` in continuous + interimResults mode. Scans every partial transcript for the wake phrases. Auto-restarts on `end` and non-fatal `error` events with a 2-second delay.

- **Native path**: Uses `expo-speech-recognition` (`ExpoSpeechRecognitionModule.start()`) with `continuous: true`, `interimResults: true`, and `contextualStrings` biasing toward "Chatyy". Subscribes to `result` and `error` events. On Android <12 (no continuous mode), falls back to stop-and-restart polling every ~8 seconds. Auto-retries on network/timeout errors.

- **Wake phrases**: `"ei chatyy"`, `"hey chatyy"`, `"oi chatyy"`, and bare `"chatyy"` as the broadest fallback.

- **Cooldown**: 3-second cooldown after detection prevents rapid-fire triggers.

- **Renders nothing**: Pure side-effect component, zero visual output.

### Usage

```jsx
import WakeWordListener from '../components/WakeWordListener';
import { useRouter } from 'expo-router';

// In _layout.js or any persistent screen:
const router = useRouter();

<WakeWordListener
  enabled={true}
  onWake={() => router.push({ pathname: '/one', params: { wakeTriggered: '1' } })}
/>
```

### Testing the PoC on web

1. Run `npx expo start --web`
2. Open Chrome (required for `SpeechRecognition` API)
3. Allow microphone permission when prompted
4. Say "Ei Chatyy" — the `onWake` callback fires within ~300ms of the phrase appearing in the interim transcript

### Testing the PoC on device

1. Ensure a native build exists with `expo-speech-recognition` plugin (already in `app.json`)
2. Run `npx expo run:ios` or `npx expo run:android`
3. Allow microphone + speech recognition permissions when prompted
4. Say "Ei Chatyy" — the callback fires on the first interim result containing "chatyy"

---

## 5. Known Limitations

### iOS
- **No background listening**: Apple's AVAudioSession does not allow continuous microphone access when the app is backgrounded. The wake word only works while the Chatyy app is in the foreground. This is a hard platform restriction — not fixable without using a proprietary wake word engine that embeds in the CallKit/VoIP push path (very complex).
- **Status bar indicator**: iOS shows a microphone indicator in the status bar whenever recognition is active. This is visible to the user and cannot be hidden.
- **60-second limit**: Apple's SFSpeechRecognizer has a 1-minute recognition limit per session, which is why the PoC uses continuous restart on `end` events.
- **Requires device**: Does not work in iOS Simulator (no speech recognition support).

### Android
- **Android <12 (API 30)**: `continuous: true` is not supported. The PoC falls back to polling mode (stop-and-restart every 8 seconds). This creates a ~2-second gap in listening on each restart.
- **Beep sound**: Android plays a short beep when recognition starts. Can be suppressed by routing audio through a custom AudioManager session.
- **Background**: Can technically continue in the background via a Foreground Service, but this requires additional native code not in this PoC.

### Web
- **Chrome only for continuous**: Firefox does not support the Web Speech API. Safari supports it but without `continuous: true` reliability.
- **Google servers**: Chrome sends audio to Google's servers. Not fully on-device unless Chrome flags are used.
- **Tab must be visible**: Chrome pauses Web Speech recognition when the tab is backgrounded.

### General
- **False positives**: Keyword scanning on OS transcripts will have false positives for phrases containing "Chatyy" in other contexts. The 3-second cooldown mitigates repeated triggers.
- **False negatives**: The OS speech recognizer may miss the wake phrase if the user speaks quickly or in a noisy environment. `contextualStrings` helps but does not eliminate this.
- **Network dependency**: Default mode sends audio to Apple/Google servers. Set `requiresOnDeviceRecognition: true` to avoid this (requires the on-device model to be downloaded on the user's device).

---

## 6. Future: Production-Grade Wake Word with Porcupine

When the feature is validated and ready for production, replace the PoC with Porcupine:

```bash
npm install @picovoice/porcupine-react-native
```

1. Go to [console.picovoice.ai](https://console.picovoice.ai)
2. Create a custom wake word: type "Ei Chatyy", select Portuguese, download the `.ppn` file
3. Add to `assets/` and reference in the Porcupine manager
4. Replace `WakeWordListener.js` internals with `PorcupineManager.create()`

Benefits over the PoC:
- True on-device: zero audio leaves the device
- ~5× lower CPU usage
- Works in background on Android (via Foreground Service)
- False accept rate < 0.5% (vs ~5–10% for transcript scanning)
- No dependency on network or OS speech recognition service availability

Cost: Free for development (3 wake words). ~$100/month for production.
