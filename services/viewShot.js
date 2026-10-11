// [2026-10-11 boot-split] WEB stub. react-native-view-shot's web build pulls
// html2canvas (~200 KB) and, being statically required by editors shared across
// several async chunks, landed in the boot `__common` chunk. Every call site
// only uses it on native (web flattens with <canvas> / studioEngine.web.js,
// which loads html2canvas via dynamic import()). Native twin: viewShot.native.js.
export function viewShotModule() { return null; }
