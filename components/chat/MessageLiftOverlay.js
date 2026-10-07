// [2026-10-08 chat-native] Web/default: no lifted-bubble menu (no view-shot,
// no measureInWindow parity). chat-conversation keeps the classic centered
// frosted menu. Native implementation: MessageLiftOverlay.native.js.
export const LIFT_AVAILABLE = false;
export const LIFT_REACT_H = 56;
export const LIFT_GAP = 8;
export const LIFT_LIST_STYLES = {};
export function captureBubbleAnchor() { return Promise.resolve(null); }
export function releaseBubbleAnchor() {}
export function computeLiftLayout() { return null; }
export function LiftedBubble() { return null; }
export function LiftReactionBar({ children }) { return children || null; }
