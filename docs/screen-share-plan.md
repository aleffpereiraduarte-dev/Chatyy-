# Screen Sharing Plan

## Current State

- Video calls use WebRTC with `getUserMedia()` for camera
- `app/call.js` already has `screenSharing` state and `handleScreenShare` function
- Screen share button is currently only shown on web (`Platform.OS === 'web'`)
- `@stream-io/react-native-webrtc` is NOT installed; using `react-native-webrtc` instead

## Platform Capabilities

### Web (already partially working)
- Uses `navigator.mediaDevices.getDisplayMedia()`
- Browser handles all permissions natively
- Works on Chrome, Firefox, Edge, Safari 13+

### Android
- Uses `MediaProjection` API under the hood
- `react-native-webrtc` (v124+) supports `getDisplayMedia()` on Android
- Requires a foreground service notification while sharing
- User sees a system permission dialog: "Start recording or casting?"

### iOS
- Requires **Broadcast Upload Extension** (a separate app extension target)
- `react-native-webrtc` supports this via `RTCScreenShareHelper`
- Needs a new target in Xcode: `BroadcastUploadExtension`
- User starts sharing from Control Center or in-app via `RPSystemBroadcastPickerView`
- The extension runs in a separate process, communicates with the main app via `CFMessagePort` or App Groups

## Implementation Plan

### Phase 1: Web Enhancement (0.5 day)
The web screen share already exists but may need polish:
1. Verify `handleScreenShare` in `call.js` correctly replaces the video track
2. Add screen share track to the existing peer connection (replace or add alongside camera)
3. Handle the `ended` event on the screen share track (user clicks "Stop sharing" in browser)
4. Show a clear indicator to the remote peer that screen is being shared
5. Remote peer should see the screen share in a larger view, camera in PiP

### Phase 2: Android Screen Share (1 day)
1. Update `react-native-webrtc` to latest version (ensure `getDisplayMedia` support)
2. In `call.js`, remove the `Platform.OS === 'web'` restriction on the screen share button
3. Call `mediaDevices.getDisplayMedia({ video: true, audio: true })` on Android
4. Replace the camera track in the peer connection with the screen track:
   ```js
   const sender = pcRef.current.getSenders().find(s => s.track?.kind === 'video');
   if (sender) await sender.replaceTrack(screenTrack);
   ```
5. Add a foreground service notification (required by Android for MediaProjection):
   ```js
   // In android/app/src/main/AndroidManifest.xml:
   <service android:name="com.onemundo.mail.ScreenShareService"
            android:foregroundServiceType="mediaProjection" />
   ```
6. Handle screen share stop: restore camera track

### Phase 3: iOS Screen Share (2-3 days)
This is the most complex part due to Apple's Broadcast Extension requirement.

1. **Create Broadcast Upload Extension**:
   - In Xcode, add new target: `ChatyyBroadcast` (Broadcast Upload Extension)
   - App Group: `group.com.onemundo.mail` (shared between main app and extension)
   - The extension captures screen frames and sends them to the main app

2. **Add to `app.json` plugins**:
   ```json
   ["react-native-webrtc", {
     "cameraPermission": "...",
     "microphonePermission": "...",
     "broadcastExtensionName": "ChatyyBroadcast",
     "appGroupIdentifier": "group.com.onemundo.mail"
   }]
   ```

3. **Communication between extension and main app**:
   - Extension writes video frames to a shared memory location (via App Group container)
   - Main app reads frames and creates a `RTCVideoFrame` to push into the WebRTC track
   - `react-native-webrtc` provides `RTCScreenShareCapture` helper for this

4. **In-app trigger**:
   - Show `RPSystemBroadcastPickerView` (Apple's native "start broadcast" button)
   - User taps it, selects "Chatyy" from the broadcast picker
   - System starts the Broadcast Extension, which begins capturing
   - Main app detects the broadcast started and replaces the video track

5. **Note**: This requires a native build (`eas build`), not just an OTA update

### Phase 4: Receiver Side (0.5 day)
When the remote peer receives a screen share:
1. Detect that the incoming video track is a screen share (via signaling metadata)
2. Display the screen share in the main/large view
3. Move the camera video to a small PiP corner
4. Add a "Screen share" label overlay
5. Allow pinch-to-zoom on the screen share view

### Phase 5: Layout (0.5 day)
- **Sender view**: small preview of shared screen in the bottom corner, camera PiP on top
- **Receiver view**: full-screen shared content, sender's camera in small PiP
- **Both sharing**: split screen (rare edge case)

## Signaling Protocol

When screen share starts/stops, send via WebSocket:
```json
{
  "type": "call_screen_share",
  "call_id": "abc123",
  "target_email": "user@example.com",
  "sharing": true,
  "track_id": "screen-video-track-id"
}
```

The receiver uses this to:
- Switch layout to screen-share mode
- Show "X is sharing their screen" indicator

## Technical Details

### Track Replacement Strategy
- **Option A**: Replace camera track with screen track via `sender.replaceTrack()`
  - Pros: no renegotiation needed, seamless
  - Cons: can't show camera + screen simultaneously
- **Option B**: Add screen as a second video track (requires renegotiation)
  - Pros: camera stays active in PiP
  - Cons: more bandwidth, renegotiation may cause brief glitch

**Recommendation**: Option A for simplicity. Most apps (WhatsApp, Telegram) replace the camera track.

### Audio During Screen Share
- Android: `getDisplayMedia({ audio: true })` captures system audio
- iOS: Broadcast Extension can capture system audio
- Web: Chrome supports system audio capture via `getDisplayMedia`
- The captured audio is mixed with the microphone audio or sent as a separate track

## Estimated Timeline
- Web polish: 0.5 day
- Android: 1 day
- iOS: 2-3 days (Broadcast Extension is the bottleneck)
- Receiver layout: 0.5 day
- Total: 4-5 days

## Risks
- iOS Broadcast Extension requires a native build and App Store review
- Some Android devices restrict MediaProjection in the background
- High bandwidth usage when sharing high-res screens (mitigate: cap at 720p, lower framerate to 5-10fps)
- Older iOS versions (<12) do not support ReplayKit broadcast
