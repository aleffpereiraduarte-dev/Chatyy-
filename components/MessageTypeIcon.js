// MessageTypeIcon — SVG glyph for a chat message type.  [2026-10-07 app-feel-ui]
// Founder rule: NO emoji in UI chrome. Previews used '📷 Foto' / '🎤 Áudio' /
// '📞 Chamada' prefixes; this renders the matching line icon instead and
// `stripLeadingGlyph` removes the emoji prefix from the label text.
import React from 'react';
import {
  IconImage, IconMic, IconMusic, IconVideo, IconMapPin, IconUser, IconBarChart,
  IconPaperclip, IconPhone, IconFilm, IconTag, IconReply, IconCalendar,
} from './Icons';

const MAP = {
  image: IconImage,
  voice: IconMic,
  audio: IconMusic,
  video: IconVideo,
  location: IconMapPin,
  contact: IconUser,
  poll: IconBarChart,
  file: IconPaperclip,
  call_card: IconPhone,
  gif: IconFilm,
  sticker: IconTag,
  status_reply: IconReply,
  meetup: IconCalendar,
  playlist: IconMusic,
};

export default function MessageTypeIcon({ type, size = 14, color }) {
  const Ic = MAP[type];
  if (!Ic) return null;
  return <Ic size={size} color={color} />;
}

// Removes a leading emoji/pictograph (+ variation selectors / ZWJ) and the
// space after it: '📷 Foto' -> 'Foto', '↩ Oi' -> 'Oi'. Plain text untouched.
export function stripLeadingGlyph(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/^(?:[←-⇿⌀-➿⬀-⯿]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDD00-\uDFFF])[️‍]*\s?/, '');
}

export function hasLeadingGlyph(str) {
  return typeof str === 'string' && stripLeadingGlyph(str) !== str;
}
