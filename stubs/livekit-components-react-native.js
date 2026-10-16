// [2026-10-16 wave13a bundle-diet] NATIVE stand-in for @livekit/components-react.
//
// @livekit/react-native's index re-exports components-react's hooks
// (useRoomContext, useTracks, ...) and its <LiveKitRoom>/<BarVisualizer>, which
// statically pulled the whole components-react dist (~212 KB minified) into the
// Hermes bundle. The app never uses any of them: it only touches registerGlobals,
// AudioSession, VideoView/VideoRenderer, AndroidAudioTypePresets,
// getDefaultAppleAudioConfigurationForMode, setupIOSAudioManagement, RNE2EEManager
// and RNKeyProvider (see services/lkLoader.native.js callers). metro.config.js
// redirects '@livekit/components-react' here ONLY when the importer lives inside
// node_modules/@livekit/react-native and the platform is ios/android. Web never
// sees this file (@livekit/react-native is web-stubbed there).
//
// Every export is a function that throws a clear error if some future code path
// actually calls it — if you need a components-react hook on native, remove the
// redirect in metro.config.js instead of using these.
const React = require('react');

function unavailable(name) {
  const fn = function () {
    throw new Error('[chatyy] @livekit/components-react.' + name + ' is stubbed on native (metro.config.js bundle-diet). Remove the redirect to use it.');
  };
  fn.displayName = 'stub(' + name + ')';
  return fn;
}

const NAMES = [
  'useConnectionState', 'useDataChannel', 'useIsSpeaking', 'useLocalParticipant',
  'useLocalParticipantPermissions', 'useParticipantInfo', 'useParticipants',
  'useRemoteParticipants', 'useRemoteParticipant', 'useSpeakingParticipants',
  'useSortedParticipants', 'useChat', 'useIsEncrypted', 'useRoomInfo', 'useIsMuted',
  'useParticipantTracks', 'useLiveKitRoom', 'useRoomContext', 'useParticipantContext',
  'useTrackRefContext', 'useTracks', 'isTrackReference', 'useEnsureTrackRef',
  'useMaybeTrackRefContext', 'useTrackMutedIndicator', 'useVisualStableUpdate',
  'useVoiceAssistant', 'useTrackTranscription',
];

const out = { __esModule: true };
for (const n of NAMES) out[n] = unavailable(n);
// Contexts are referenced (not called) by <LiveKitRoom>; keep them real objects.
out.RoomContext = React.createContext(undefined);
out.ParticipantContext = React.createContext(undefined);
out.TrackRefContext = React.createContext(undefined);
out.LKFeatureContext = React.createContext(undefined);

module.exports = out;
