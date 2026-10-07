// [2026-10-07 send-media] Root entry so `require('../modules/expo-native-video')`
// resolves for tools that don't read package.json "main" (import checker,
// jest, plain node resolution). Metro already resolved via main → src/index.ts;
// this is the same module, re-exported.
export * from './src/index';
export { default } from './src/index';
