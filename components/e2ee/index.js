// [e2ee5 WP-15 2026-10-21] UX de segurança do E2EE v5 — tudo atrás de isE2eeUiEnabled() (desligado).
// Onde plugar cada peça: components/e2ee/PLUGAR.md.
export { isE2eeUiEnabled, E2EE_LEARN_URL, LockGlyph, LockOffGlyph, safetyDigitGroups, safetyDigitsText } from './e2eeUi';
export { default as E2eeTopNotice } from './E2eeTopNotice';
export { default as E2eeDivider, e2eeSysKind } from './E2eeDivider';
export { default as SafetyCodeChangedRow } from './SafetyCodeChangedRow';
export { default as SafetyNumberScreen } from './SafetyNumberScreen';
export { default as E2eeMessageState, e2eeMessageStateFor, e2eePreviewText } from './E2eeMessageState';
export { default as NotEncryptedBadge, notEncryptedExplanation } from './NotEncryptedBadge';
export { default as NeedsUpdateBanner } from './NeedsUpdateBanner';
export { default as E2eeInfoSheet } from './E2eeInfoSheet';
export { E2eeHeaderLock, E2eeContactInfoRow } from './E2eeInfoRow';
export { confirmExitEncryption, exitEncryptionText } from './exitEncryption';
