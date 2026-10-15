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
import { emailFromSystemPath } from '../utils/emailPath';

// [2026-10-14 mailto-unmatched] "mailto:x@y" (o Chatyy é cliente de e-mail) e
// "onemundomail://x@y" chegavam aqui como caminho "x@y" → tela "Unmatched Route".
// mailto: real → o _layout (useDeepLinking) já abre o compose; aqui só não roteia.
// Qualquer outro "scheme://local@dominio" vira compose direto.
export function redirectSystemPath({ path, initial }) {
  try {
    if (typeof path === 'string' && /^mailto:/i.test(path)) {
      return initial ? '/' : null;
    }
    const _addr = emailFromSystemPath(path);
    if (_addr) return '/compose?mailto=' + encodeURIComponent('mailto:' + _addr);
    // [2026-10-13] Compartilhar de outro app (Share Extension iOS / expo-share-intent):
    // chega como onemundomail:///dataUrl=onemundomailShareKey (às vezes sem o '?').
    // O expo-router tentava rotear isso como caminho → "Unmatched Route". Quem trata
    // é o _layout (useShareIntent → /share-receive); aqui só não navega.
    if (typeof path === 'string' && (path.includes('dataUrl=') || /sharekey/i.test(path))) {
      return initial ? '/' : null;
    }
    // [2026-10-12 nav-dedup] Warm-start chat deep links (Android native
    // notification tap, widgets, Siri/shortcuts: onemundomail://chat-conversation?id=…)
    // used to be routed by expo-router as a blind NAVIGATE → a chat already in
    // the stack got a 2nd copy. Route through the shared guard instead (no-op
    // when it is already on top, pop back to it when it is below).
    // Cold start keeps the default routing (navigator not mounted yet).
    if (!initial && typeof path === 'string') {
      const ci = path.indexOf('chat-conversation');
      if (ci >= 0 && /[?&](id|email)=/.test(path)) {
        const href = '/' + path.slice(ci);
        setTimeout(() => {
          try { require('../services/openConversation').openConversation(href, { source: 'link' }); } catch {}
        }, 0);
        return null;
      }
    }
    // [2026-10-15 system-integration] Android launcher shortcut "Câmera do
    // status" (onemundomail://chat?new=1) with the app warm: pop back to the
    // existing home instead of stacking a 2nd /chat (chat.js reacts to ?new=1).
    if (!initial && typeof path === 'string') {
      let sc = null;
      try { sc = require('../services/appShortcuts'); } catch {}
      if (sc && sc.isStatusCameraHref(path)) {
        setTimeout(() => {
          try { sc.openStatusCamera(require('expo-router').router); } catch {}
        }, 0);
        return null;
      }
    }
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
