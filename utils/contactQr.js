// [2026-10-07 discovery] One contact-QR format + one tolerant parser for every
// scanner in the app. Before this, /chat-new rendered JSON
// ({type:'chatyy_contact',…}) through a THIRD-PARTY image API
// (api.qrserver.com — leaked e-mail+name and failed offline) while
// /profile-qr rendered `chatyy://add-contact?…`, and each scanner only
// understood its own format → scanning a QR from the other screen said
// "QR inválido".

// Canonical payload (what /profile-qr already emits).
export function buildContactQrPayload(email, name) {
  const e = encodeURIComponent(String(email || '').trim().toLowerCase());
  const n = String(name || '').trim();
  return `chatyy://add-contact?email=${e}${n ? `&name=${encodeURIComponent(n)}` : ''}`;
}

// Public https link for a profile (works outside the app; /u/[username]).
export function buildProfileLink(user) {
  const handle = String(user?.handle || user?.username || '').replace(/^@/, '').trim();
  const email = String(user?.email || '').trim();
  const slug = handle || (email.includes('@') ? email.split('@')[0] : email);
  return `https://chatyy.com.br/u/${encodeURIComponent(slug || 'me')}`;
}

function _qs(str) {
  const out = {};
  String(str || '').replace(/^\?/, '').split('&').forEach((kv) => {
    if (!kv) return;
    const i = kv.indexOf('=');
    const k = i >= 0 ? kv.slice(0, i) : kv;
    const v = i >= 0 ? kv.slice(i + 1) : '';
    try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { out[k] = v; }
  });
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Parse anything a Chatyy user might scan. Returns one of:
 *   { kind: 'email', email, name }    — open/start a DM
 *   { kind: 'profile', slug }         — @handle / local-part → /u/<slug>
 *   { kind: 'group', token }          — group invite → /j/<token>
 *   null                              — not a Chatyy QR
 */
export function parseContactQr(data) {
  const raw = String(data || '').trim();
  if (!raw) return null;
  // 1) chatyy://add-contact?email=…&name=…
  if (/^chatyy:\/\/add-contact/i.test(raw)) {
    const p = _qs(raw.split('?')[1] || '');
    const email = String(p.email || '').trim().toLowerCase();
    if (EMAIL_RE.test(email)) return { kind: 'email', email, name: p.name || email.split('@')[0] };
    return null;
  }
  // 2) legacy JSON {type:'chatyy_contact', email, name}
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      const email = String(j?.email || '').trim().toLowerCase();
      if (j?.type === 'chatyy_contact' && EMAIL_RE.test(email)) return { kind: 'email', email, name: j.name || email.split('@')[0] };
    } catch {}
    return null;
  }
  // 3) group invite https://chatyy.com.br/j/<32hex>
  const g = /chatyy\.com\.br\/j\/([a-f0-9]{32})/i.exec(raw);
  if (g) return { kind: 'group', token: g[1] };
  // 4) profile links: https://chatyy.com.br/u/<slug> or /@<handle>
  const u = /^(?:https?:\/\/)?(?:www\.)?chatyy\.com\.br\/(?:u\/|@)([A-Za-z0-9._%@+-]{2,64})\/?(?:[?#].*)?$/i.exec(raw);
  if (u) {
    let slug = u[1];
    try { slug = decodeURIComponent(slug); } catch {}
    if (EMAIL_RE.test(slug)) return { kind: 'email', email: slug.toLowerCase(), name: slug.split('@')[0] };
    return { kind: 'profile', slug: slug.replace(/^@/, '').toLowerCase() };
  }
  // 5) mailto: / bare e-mail
  const m = raw.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
  if (EMAIL_RE.test(m)) return { kind: 'email', email: m, name: m.split('@')[0] };
  return null;
}
