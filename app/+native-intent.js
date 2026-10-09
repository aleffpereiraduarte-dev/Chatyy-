// [2026-10-09 universal-links] expo-router native intent hook.
//
// iOS Universal Links / Android App Links deliver the full
// https://chatyy.com.br/... URL. expo-router would route it by path only, so
// /g/<token>, /@handle and /meet/room.html?id=X would land on "Unmatched Route".
// We rewrite the claimed paths (utils/universalLinks.js) to real app routes and
// leave EVERYTHING ELSE untouched (custom scheme, share intents, notification
// links keep their current behavior). Pure JS: works on the current binary too
// (it simply never receives https links until the build with the entitlements).
import { resolveUniversalLink } from '../utils/universalLinks';

export function redirectSystemPath({ path, initial }) {
  try {
    const hit = resolveUniversalLink(path);
    if (!hit) return path;
    if (hit.owner === 'router') return hit.href;
    // owner 'layout' (chat): app/_layout.js handleUrl opens it via
    // openConversation(). Cold start → boot normally at the root; warm → no
    // router navigation here (avoids a duplicate screen).
    return initial ? '/' : null;
  } catch {
    return path;
  }
}
