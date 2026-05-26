// ─────────────────────────────────────────────────────────────────────────
// Globally neutralize legacy LayoutAnimation on iOS (definitive crash fix)
// ─────────────────────────────────────────────────────────────────────────
//
// Crash (build 3.0 / 256, persisted after the per-file keyboard guard):
//   React Native New Architecture (Fabric) + legacy LayoutAnimation segfault.
//   Stack: LayoutAnimationDelegateProxy::activityDidChange
//          → UIManager::animationTick()
//          → RCTMountingManager performTransaction
//          → EXC_BAD_ACCESS at 0x18
//
// Root cause: legacy `LayoutAnimation.configureNext(...)` is fundamentally
// crash-prone under Fabric on iOS 26. The animation driver (animationTick)
// dereferences a stale/null mounting coordinator during the transaction,
// which manifests as the bad-access. Any component (anywhere in the tree,
// not just the keyboard handlers we already guarded) that schedules a
// LayoutAnimation can trip it.
//
// Fix: monkey-patch LayoutAnimation at app startup so that on iOS it becomes
// a safe no-op — layout still updates, just *instantly* (no animation),
// which is completely safe. Android is LEFT UNTOUCHED (LayoutAnimation works
// fine there and provides the expected animated layout transitions).
//
// This module MUST be imported as the FIRST import in app/_layout.js so the
// patch is installed before any screen/component mounts and schedules an
// animation.

import { Platform, LayoutAnimation } from 'react-native';

if (Platform.OS === 'ios' && LayoutAnimation) {
  // Safe no-op: ignore the config, but honor the optional completion callback
  // synchronously so callers that rely on it (e.g. to flip a flag after the
  // "animation") still proceed. Signature mirrors RN's:
  //   configureNext(config, onAnimationDidEnd?, onAnimationDidFail?)
  const noop = (_config, onAnimationDidEnd /*, onAnimationDidFail */) => {
    try {
      if (typeof onAnimationDidEnd === 'function') onAnimationDidEnd();
    } catch {}
  };

  try {
    LayoutAnimation.configureNext = noop;
  } catch {}

  // Convenience helpers all funnel through configureNext under the hood, but
  // some are pre-bound at module load — replace them so nothing schedules a
  // legacy animation on iOS.
  try {
    LayoutAnimation.easeInEaseOut = noop;
  } catch {}
  try {
    LayoutAnimation.spring = noop;
  } catch {}
  try {
    LayoutAnimation.linear = noop;
  } catch {}

  // `setLayoutAnimationEnabledExperimental` only affects Android in practice,
  // but guard it as a no-op on iOS too so nothing re-enables a code path.
  try {
    if (typeof LayoutAnimation.setLayoutAnimationEnabledExperimental === 'function') {
      LayoutAnimation.setLayoutAnimationEnabledExperimental = () => {};
    }
  } catch {}
}

// Export a marker so the import is never tree-shaken away (it has side effects,
// but this keeps bundlers/linters from flagging it as unused).
export const LAYOUT_ANIMATION_DISABLED_ON_IOS = Platform.OS === 'ios';
