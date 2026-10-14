/**
 * liveEngageConfig — chaves e catálogo visual do engajamento da live.
 *
 * Presentes seguem o kill-switch de monetização: DIAMONDS_ENABLED
 * (constants/featureFlags.js) no app e DIAMONDS_ENABLED no env do servidor
 * (410 feature_disabled). Catálogo/ícones/tiers vivem em
 * components/gifts/giftCatalog.js (compartilhado com reels/posts/chat).
 */
import { DIAMONDS_ENABLED } from '../../constants/featureFlags';
import {
  GIFT_CATALOG, giftMeta as _giftMeta, giftLabel as _giftLabel, humanizeCount as _humanize,
} from '../gifts/giftCatalog';

export const LIVE_GIFTS_ENABLED = !!DIAMONDS_ENABLED;

// Fallback quando o evento não traz `tier`: presente >= este custo ganha tela cheia.
export const BIG_GIFT_DIAMONDS = 499;

export const LOCAL_GIFT_CATALOG = GIFT_CATALOG;
export const giftMeta = _giftMeta;
export const giftLabel = _giftLabel;
export const humanizeCount = _humanize;
