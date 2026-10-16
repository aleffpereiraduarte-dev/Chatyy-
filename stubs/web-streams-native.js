// [2026-10-16 wave13a bundle-diet] NATIVE stand-in for 'web-streams-polyfill'.
//
// Expo's Metro prelude (node_modules/expo/virtual/streams.js — web-streams-polyfill
// v4 itself) already installs ReadableStream/WritableStream/TransformStream & co.
// on globalThis before any module runs. @livekit/react-native imported a SECOND
// copy (~63 KB) only to assign them in registerGlobals() "if undefined" — which
// never happens on Expo. metro.config.js points 'web-streams-polyfill' here on
// ios/android so both sides share the prelude's classes.
const g = typeof globalThis !== 'undefined' ? globalThis : global;
const NAMES = [
  'ReadableStream', 'ReadableStreamDefaultController', 'ReadableByteStreamController',
  'ReadableStreamBYOBRequest', 'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader',
  'WritableStream', 'WritableStreamDefaultController', 'WritableStreamDefaultWriter',
  'ByteLengthQueuingStrategy', 'CountQueuingStrategy', 'TransformStream',
  'TransformStreamDefaultController',
];
const out = { __esModule: true };
for (const n of NAMES) {
  Object.defineProperty(out, n, { enumerable: true, get: () => g[n] });
}
module.exports = out;
