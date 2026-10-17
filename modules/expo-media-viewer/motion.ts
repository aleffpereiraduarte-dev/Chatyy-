// modules/expo-media-viewer/motion.ts — [2026-10-16 motion]
//
// Kill switches do movimento "nível Telegram" do pacote de mídia (viewer,
// stories, grades). O nativo lê flags estáticas (MVMotion) mandadas por
// ChatyyMediaViewer.setMotion; binário antigo sem setMotion → no-op.
//   globalThis.__chatyy_motion = false               → tudo (chave global do app)
//   globalThis.__chatyy_motion_media = false         → viewer (parallax+barras+mola do arrasto)
//   globalThis.__chatyy_motion_media_parallax = false
//   globalThis.__chatyy_motion_media_chrome = false  → barras só com fade
//   globalThis.__chatyy_motion_media_fling = false   → volta do arrasto sem herdar velocidade
//   globalThis.__chatyy_motion_story = false         → origem do anel + recuo ao segurar
//   globalThis.__chatyy_motion_story_origin = false
//   globalThis.__chatyy_motion_story_hold = false
//   globalThis.__chatyy_motion_grid = false          → check em mola nas grades
// "Reduzir movimento" (SO ou ajuste do app) desliga tudo também.
// Vale no próximo open()/montagem de grade (syncMotion é barato e idempotente).

import { requireOptionalNativeModule } from 'expo-modules-core';

export type MotionFlags = {
  parallax: boolean;
  chromeSlide: boolean;
  flingSpring: boolean;
  storyOrigin: boolean;
  holdScale: boolean;
  gridSpring: boolean;
};

function off(k: string): boolean {
  try { return (globalThis as any)[k] === false; } catch { return false; }
}

function appReduce(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rm = require('../../components/reducedMotion');
    return !!(rm && typeof rm.isReduceMotionEnabled === 'function' && rm.isReduceMotionEnabled());
  } catch {
    return false;
  }
}

export function motionFlags(): MotionFlags {
  const all = off('__chatyy_motion') || appReduce();
  const media = all || off('__chatyy_motion_media');
  const story = all || off('__chatyy_motion_story');
  return {
    parallax: !(media || off('__chatyy_motion_media_parallax')),
    chromeSlide: !(media || off('__chatyy_motion_media_chrome')),
    flingSpring: !(media || off('__chatyy_motion_media_fling')),
    storyOrigin: !(story || off('__chatyy_motion_story_origin')),
    holdScale: !(story || off('__chatyy_motion_story_hold')),
    gridSpring: !(all || off('__chatyy_motion_grid')),
  };
}

let _last = '';
let _mod: any;

export function syncMotion(): void {
  try {
    if (_mod === undefined) _mod = requireOptionalNativeModule('ChatyyMediaViewer') || null;
    if (!_mod || typeof _mod.setMotion !== 'function') return;
    const f = motionFlags();
    const k = JSON.stringify(f);
    if (k === _last) return;
    _mod.setMotion(f);
    _last = k;
  } catch {}
}
