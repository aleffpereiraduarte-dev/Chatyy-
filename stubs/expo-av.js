// Stub for `expo-av`, which was REMOVED in Expo SDK 54+.
// The app is on SDK 55 and uses expo-video / expo-audio. Several files still
// carry defensive `require('expo-av')` fallbacks (StoryViewer, spotlight, one,
// audioManager, ChatStatusTab) wrapped in try/catch or "prefer expo-video"
// branches that never execute on SDK 55. Metro must still RESOLVE the module
// at bundle time, so this stub exists purely to satisfy resolution.
//
// It exports an empty object: `require('expo-av').Video` === undefined,
// `const { Audio } = require('expo-av')` → Audio === undefined. Every caller
// guards for that (if (Video) / try-catch), so behavior is identical to the
// require throwing — the primary expo-video/expo-audio path always wins.
//
// Needed so React Compiler (babel-preset-expo experiments.reactCompiler) can be
// enabled without the export failing on "Unable to resolve module expo-av".
module.exports = {};
