/**
 * formatLiveChatContent — single source of truth for cleaning Chatyy live
 * chat message bodies before they hit the screen.
 *
 * Why: users paste raw Chatyy invite / deep-link URLs into live chat
 * ("https://chatyy.com.br/g/<token>", "chatyy.com.br/j/<token>", or any long
 * hash). Rendered raw they show as 40-60+ char gibberish that breaks the
 * TikTok-grade overlay aesthetic AND the expanded comment sheet (#1346 /
 * 7184). Backend (chat.php) builds invites as `chatyy.com.br/g/<token>` and
 * `/j/<token>` — frequently WITHOUT an https:// scheme — so the cleaner must
 * match scheme-less links too.
 *
 * Used by:
 *   • components/live/LiveChatOverlay.js (floating overlay rows)
 *   • app/live-viewer.js (expanded comment sheet + pinned chip)
 *   • app/live-broadcast.js (host pinned-comment chip)
 *
 * App rule: NEVER emoji in UI. The friendly replacement is PLAIN TEXT
 * ("Link compartilhado"), not an emoji-prefixed chip.
 */

// Whole-string Chatyy deep link (invite/join). Scheme + www are optional so
// bare `chatyy.com.br/g/<token>` matches. `[gj]` is the invite path segment.
const CHATYY_DEEPLINK_FULL = /^(?:https?:\/\/)?(?:www\.)?chatyy\.com\.br\/[gj]\/\S+$/i;

// Inline matchers (used inside .replace, so global). Order matters: replace
// the specific Chatyy invite form first, then any remaining Chatyy URL, then
// generic schemed URLs.
const CHATYY_DEEPLINK_INLINE = /(?:https?:\/\/)?(?:www\.)?chatyy\.com\.br\/[gj]\/\S+/gi;
const CHATYY_ANY_INLINE = /(?:https?:\/\/)?(?:www\.)?chatyy\.com\.br\/\S+/gi;
// Scheme-LESS links (e.g. `bit.ly/scam`, `wa.me/x`, `google.com/promo`). The
// generic matcher below requires an https?:// scheme, so these were leaking
// through raw — a spam/scam vector in the live overlay. Match `domain.tld`
// (optionally with a path) guarded by a common-TLD allowlist so we don't
// linkify prose like "etc." or "e.g.". The leading `(^|[^\w@/.])` capture
// keeps us from mangling emails (`user@site.com`) or mid-path fragments; it's
// re-emitted verbatim. Runs BEFORE the generic scheme matcher.
const BARE_DOMAIN_INLINE = /(^|[^\w@/.])((?:https?:\/\/)?(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|co|br|me|ly|gg|app|xyz|info|biz|tv|link|live|to|be|us|uk|dev|ai|so|sh|online|store|site|club|shop|vip|win|top)(?:\/[^\s]*)?)/gi;
const GENERIC_URL_INLINE = /https?:\/\/\S+/gi;

const LINK_LABEL = 'Link compartilhado';
const INLINE_LINK_LABEL = 'link';

export default function formatLiveChatContent(raw) {
  if (!raw || typeof raw !== 'string') return raw || '';
  const trimmed = raw.trim();

  // Pure Chatyy invite/deep link (with or without scheme) → friendly label.
  if (CHATYY_DEEPLINK_FULL.test(trimmed)) {
    return LINK_LABEL;
  }

  // Inline links embedded in a longer message → swap each for a short label,
  // most-specific pattern first so a Chatyy invite never falls through to the
  // generic "link" replacement.
  return trimmed
    .replace(CHATYY_DEEPLINK_INLINE, LINK_LABEL)
    .replace(CHATYY_ANY_INLINE, LINK_LABEL)
    .replace(BARE_DOMAIN_INLINE, (_m, pre) => pre + INLINE_LINK_LABEL)
    .replace(GENERIC_URL_INLINE, INLINE_LINK_LABEL);
}
