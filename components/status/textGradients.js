// textGradients — single source of truth for text-status gradient presets.
//
// The composer (ChatStatusTab) persists a gradient choice as a `gradient:<id>`
// token in `bg_color`/`background`. Three surfaces need to reconstruct the same
// SVG <LinearGradient> from that token: the composer preview (ChatStatusTab),
// the full-screen viewer (StoryViewer), and the text-status card
// (AnimatedStatusText). Each one used to carry its OWN private copy of this map
// + resolver, so adding/tweaking a preset meant editing three files and risking
// drift (a preset present in one surface but missing in another → white screen).
// Extracted here so all three import the exact same data + logic.
//
// Order inside `colors` is top-left → bottom-right (SVG x1/y1=0, x2/y2=1).
// expo-linear-gradient isn't in the dep tree on SDK 55, so callers render via
// react-native-svg's <LinearGradient>.

// Canonical ARRAY form — preserves preset order for the composer's picker row.
export const TEXT_BG_GRADIENTS = [
  { id: 'purple_pink', colors: ['#8B5CF6', '#EC4899'] },
  { id: 'blue_cyan',   colors: ['#2563EB', '#06B6D4'] },
  { id: 'orange_red',  colors: ['#F97316', '#EF4444'] },
  { id: 'green_teal',  colors: ['#10B981', '#14B8A6'] },
  { id: 'sunset',      colors: ['#FACC15', '#F97316', '#EF4444'] },
  { id: 'aurora',      colors: ['#06B6D4', '#8B5CF6', '#EC4899'] },
];

// Resolve a published `bg_color` (solid hex OR `gradient:<id>` token) back to a
// gradient descriptor `{ id, colors }`. Returns null for plain colors / unknown
// tokens so callers fall through to a solid backgroundColor.
export function resolveTextGradient(bgColor) {
  if (!bgColor || typeof bgColor !== 'string') return null;
  if (!bgColor.startsWith('gradient:')) return null;
  const id = bgColor.slice('gradient:'.length);
  return TEXT_BG_GRADIENTS.find(g => g.id === id) || null;
}
