/**
 * giftCatalog — catálogo de presentes (TikTok-like) compartilhado por live,
 * reels/posts e chat 1:1. O SERVIDOR é a autoridade (live_gift_catalog /
 * diamond_gift_catalog); este arquivo é o fallback offline + o mapeamento de
 * ícone/rótulo/tier para eventos WS (live_gift / feed_post_tip / bolha 'gift').
 *
 * Tiers:
 *   small / medium     → banner lateral com combo ("x5")
 *   large / legendary  → animação de tela cheia (large ~2.5s, legendary ~4s)
 */

export const GIFT_CATALOG = [
  { sku: 'g_rose',    icon: 'rose',    label: 'Rose',    diamonds_cost: 1,    tier: 'small' },
  { sku: 'g_heart',   icon: 'heart',   label: 'Heart',   diamonds_cost: 5,    tier: 'small' },
  { sku: 'g_star',    icon: 'star',    label: 'Star',    diamonds_cost: 10,   tier: 'small' },
  { sku: 'g_fire',    icon: 'fire',    label: 'Fire',    diamonds_cost: 30,   tier: 'medium' },
  { sku: 'g_sparkle', icon: 'sparkle', label: 'Sparkle', diamonds_cost: 99,   tier: 'medium' },
  { sku: 'g_crown',   icon: 'crown',   label: 'Crown',   diamonds_cost: 199,  tier: 'medium' },
  { sku: 'g_diamond', icon: 'diamond', label: 'Diamond', diamonds_cost: 499,  tier: 'large' },
  { sku: 'g_rocket',  icon: 'rocket',  label: 'Rocket',  diamonds_cost: 999,  tier: 'large' },
  { sku: 'g_castle',  icon: 'castle',  label: 'Castle',  diamonds_cost: 2999, tier: 'legendary' },
  { sku: 'g_galaxy',  icon: 'galaxy',  label: 'Galaxy',  diamonds_cost: 4999, tier: 'legendary' },
  { sku: 'g_legend',  icon: 'legend',  label: 'Legend',  diamonds_cost: 9999, tier: 'legendary' },
];

// SKUs antigos (gift_*) e tipos do chat_live_send_gift — só p/ exibir eventos.
const LEGACY = {
  gift_rose: { icon: 'rose', diamonds: 100 }, gift_star: { icon: 'star', diamonds: 300 },
  gift_crown: { icon: 'crown', diamonds: 1000 }, gift_rocket: { icon: 'rocket', diamonds: 2000 },
  gift_galaxy: { icon: 'galaxy', diamonds: 5000 }, gift_legend: { icon: 'legend', diamonds: 10000 },
  rose: { icon: 'rose', diamonds: 1 }, heart: { icon: 'heart', diamonds: 5 }, star: { icon: 'star', diamonds: 10 },
  crown: { icon: 'crown', diamonds: 25 }, fire: { icon: 'fire', diamonds: 50 }, rocket: { icon: 'rocket', diamonds: 100 },
};

const KNOWN_ICONS = new Set(GIFT_CATALOG.map(g => g.icon));
export const QUANTITIES = [1, 5, 10, 99];
export const COMBO_WINDOW_MS = 3000;

export function tierFor(diamonds) {
  const d = Number(diamonds) || 0;
  if (d >= 2999) return 'legendary';
  if (d >= 499) return 'large';
  if (d >= 30) return 'medium';
  return 'small';
}
export const isBigTier = (tier) => tier === 'large' || tier === 'legendary';

/** Normaliza a lista do servidor; vazia/ruim → catálogo local. */
export function normalizeGifts(list) {
  if (!Array.isArray(list) || !list.length) return GIFT_CATALOG;
  const out = [];
  for (const g of list) {
    if (!g || !g.sku) continue;
    const sku = String(g.sku);
    const local = GIFT_CATALOG.find(x => x.sku === sku);
    const rawIcon = String(g.icon || (local && local.icon) || sku.replace(/^(g|gift)_/, ''));
    const cost = Number(g.diamonds_cost ?? g.cost ?? (local && local.diamonds_cost)) || 0;
    if (cost <= 0) continue;
    out.push({
      sku,
      icon: KNOWN_ICONS.has(rawIcon) ? rawIcon : 'gift',
      label: g.label || (local && local.label) || rawIcon,
      label_key: g.label_key || ('gifts.' + sku),
      diamonds_cost: cost,
      tier: g.tier || (local && local.tier) || tierFor(cost),
    });
  }
  return out.length ? out : GIFT_CATALOG;
}

/** Meta de um presente a partir de sku/tipo (eventos WS, bolha do chat). */
export function giftMeta(type) {
  const t = String(type || '').toLowerCase();
  const hit = GIFT_CATALOG.find(g => g.sku === t || g.icon === t);
  if (hit) return { sku: hit.sku, icon: hit.icon, label: hit.label, diamonds: hit.diamonds_cost, tier: hit.tier };
  const leg = LEGACY[t];
  if (leg) return { sku: t, icon: leg.icon, label: leg.icon, diamonds: leg.diamonds, tier: tierFor(leg.diamonds) };
  const icon = t.replace(/^(g|gift)_/, '');
  return { sku: t, icon: KNOWN_ICONS.has(icon) ? icon : 'gift', label: icon || 'gift', diamonds: 1, tier: 'small' };
}

/** Rótulo traduzido: gifts.g_<icon> → liveEng.gift_<icon> → fallback. */
export function giftLabel(t, icon, fallback) {
  if (t) {
    const k1 = 'gifts.g_' + icon;
    const v1 = t(k1);
    if (v1 && v1 !== k1) return v1;
    const k2 = 'liveEng.gift_' + icon;
    const v2 = t(k2);
    if (v2 && v2 !== k2) return v2;
  }
  return fallback || icon;
}

export function humanizeCount(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a < 1000) return sign + String(a);
  if (a < 10000) return sign + (Math.floor(a / 100) / 10).toString() + 'K';
  if (a < 1000000) return sign + Math.floor(a / 1000) + 'K';
  return sign + (Math.floor(a / 100000) / 10).toString() + 'M';
}

/** Conteúdo JSON da mensagem type 'gift' do chat → objeto (ou null). */
export function parseGiftContent(content) {
  if (!content) return null;
  if (typeof content === 'object') return content.gift_sku ? content : null;
  const s = String(content).trim();
  if (!s.startsWith('{')) return null;
  try { const j = JSON.parse(s); return j && j.gift_sku ? j : null; } catch { return null; }
}

/** "Presente: Rosa ×3" — prévia na lista de conversas / resposta. */
export function giftPreviewText(t, content, lang) {
  const j = parseGiftContent(content);
  const word = (t && t('gifts.previewPrefix') !== 'gifts.previewPrefix') ? t('gifts.previewPrefix') : 'Presente';
  if (!j) return word;
  const meta = giftMeta(j.gift_sku);
  const label = giftLabel(t, j.icon || meta.icon, j.label || meta.label);
  const q = Number(j.quantity) || 1;
  return `${word}: ${label}${q > 1 ? ' ×' + q : ''}`;
}
