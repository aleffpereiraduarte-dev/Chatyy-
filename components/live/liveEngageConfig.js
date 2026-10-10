/**
 * liveEngageConfig — chaves e catálogo visual do engajamento da live.
 *
 * Presentes seguem o kill-switch de monetização: DIAMONDS_ENABLED=false
 * (constants/featureFlags.js) e o backend responde 410 em live_gift_send.
 * Quando o founder religar diamantes, a UI nova (sheet P&B, banners com
 * combo, animação de tela cheia) acende sozinha.
 */
import { DIAMONDS_ENABLED } from '../../constants/featureFlags';

export const LIVE_GIFTS_ENABLED = !!DIAMONDS_ENABLED;

// Presente >= este custo (diamantes) ganha animação de tela cheia.
export const BIG_GIFT_DIAMONDS = 1000;

// Catálogo local (espelha _liveGiftCatalog() do chat.php) — usado como
// fallback offline e para mapear ícone/label de eventos live_gift (inclui os
// tipos antigos do chat_live_send_gift: rose/heart/star/crown/fire/rocket).
export const LOCAL_GIFT_CATALOG = [
  { sku: 'gift_rose', icon: 'rose', label: 'Rose', diamonds_cost: 100 },
  { sku: 'gift_star', icon: 'star', label: 'Star', diamonds_cost: 300 },
  { sku: 'gift_crown', icon: 'crown', label: 'Crown', diamonds_cost: 1000 },
  { sku: 'gift_rocket', icon: 'rocket', label: 'Rocket', diamonds_cost: 2000 },
  { sku: 'gift_galaxy', icon: 'galaxy', label: 'Galaxy', diamonds_cost: 5000 },
  { sku: 'gift_legend', icon: 'legend', label: 'Legend', diamonds_cost: 10000 },
];

const LEGACY = { rose: 1, heart: 5, star: 10, crown: 25, fire: 50, rocket: 100 };

export function giftMeta(type) {
  const t = String(type || '').toLowerCase();
  const icon = t.startsWith('gift_') ? t.slice(5) : t;
  const hit = LOCAL_GIFT_CATALOG.find(g => g.sku === t || g.icon === icon);
  if (hit) return { icon: hit.icon, label: hit.label, diamonds: hit.diamonds_cost };
  return { icon: icon || 'heart', label: icon || 'gift', diamonds: LEGACY[icon] || 1 };
}

// Rótulo i18n de um presente (chaves liveEng.gift_<icon>).
export function giftLabel(t, icon, fallback) {
  const k = 'liveEng.gift_' + icon;
  const v = t ? t(k) : k;
  return v && v !== k ? v : (fallback || icon);
}

export function humanizeCount(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 10000) return (Math.floor(v / 100) / 10).toString() + 'K';
  if (v < 1000000) return Math.floor(v / 1000) + 'K';
  return (Math.floor(v / 100000) / 10).toString() + 'M';
}
