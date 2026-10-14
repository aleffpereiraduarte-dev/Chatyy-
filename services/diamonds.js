/**
 * services/diamonds.js — camada única da economia de diamantes no app
 * (saldo/estado da carteira, catálogo de presentes, envio de presente,
 * códigos de erro do servidor). Fica fora de services/api.js para não
 * colidir com outras levas; reaproveita apiCall (bearer/retry).
 *
 * Contrato (chat.php/diamonds.php, 2026-10-13):
 *   wallet_balance      → { diamond_balance, pending_payout_cents, available_cents,
 *                           on_hold_cents, enabled, purchase_enabled, gifting_enabled,
 *                           cashout_enabled, is_minor, blocked_reason }
 *   live_gift_catalog   → { gifts:[{sku,label,label_key,icon,diamonds_cost,tier}] }
 *   diamond_gift_send   → { context, target_id, gift_sku, quantity, combo_id,
 *                           combo_count, client_id } → { diamond_balance, ... }
 *   410 {feature_disabled} = servidor desligou diamantes (kill-switch).
 */
import { useSyncExternalStore } from 'react';
import { apiCall } from './api';
import { normalizeGifts, GIFT_CATALOG } from '../components/gifts/giftCatalog';

let _isChild = () => false;
try {
  // eslint-disable-next-line global-require
  const auth = require('../context/AuthContext');
  if (auth && typeof auth.isChildAccount === 'function') _isChild = auth.isChildAccount;
} catch {}

export function newClientId() {
  const h = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += h[Math.floor(Math.random() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20)}`;
}

/** Código de erro estável a partir da resposta (data.code > feature_disabled > message). */
export function errorCode(r) {
  if (!r) return 'network';
  const d = r.data || {};
  if (d.code) return String(d.code);
  if (d.feature_disabled) return 'feature_disabled';
  const st = Number(r.__httpStatus) || 0;
  const m = typeof r.message === 'string' ? r.message : '';
  if (/^[a-z][a-z0-9_]*$/.test(m)) return m;
  if (/insufficient/i.test(m)) return 'insufficient_diamonds';
  if (st === 410) return 'feature_disabled';
  if (st === 402) return 'insufficient_diamonds';
  if (st === 429) return 'rate_limited';
  if (st === 0) return 'network';
  return 'failed';
}

// ── Estado da carteira (store externo; qualquer tela lê/atualiza) ──────────
const INITIAL = {
  loaded: false,
  diamonds: null,          // pode ser NEGATIVO (estorno de compra)
  pendingCents: 0,
  availableCents: 0,
  onHoldCents: 0,
  enabled: true,           // false = servidor desligou (410) ou enabled:false
  purchaseEnabled: true,
  giftingEnabled: true,
  cashoutEnabled: true,
  isMinor: false,
  blockedReason: null,     // 'minor' | 'disabled' | 'negative_balance' | null
};
let _state = { ...INITIAL };
const _listeners = new Set();
function _set(patch) {
  _state = { ..._state, ...patch };
  _listeners.forEach((l) => { try { l(); } catch {} });
}
export function getWallet() { return _state; }
export function subscribeWallet(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
export function useWallet() { return useSyncExternalStore(subscribeWallet, getWallet, getWallet); }

/** Conta de menor (parental) → não compra nem envia presente. */
export function isMinorAccount() {
  let child = false;
  try { child = !!_isChild(); } catch {}
  return child || !!_state.isMinor;
}

export function setDiamondBalance(n) {
  if (typeof n === 'number' && isFinite(n)) _set({ diamonds: n, loaded: true });
}

function _bool(v, dflt) { return v === undefined || v === null ? dflt : !!v; }

let _inflight = null;
export function refreshWallet() {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const r = await apiCall('wallet_balance', {}, 'POST');
      if (r && r.success && r.data) {
        const d = r.data;
        const enabled = _bool(d.enabled, true);
        _set({
          loaded: true,
          diamonds: Number(d.diamond_balance) || 0,
          pendingCents: Number(d.pending_payout_cents) || 0,
          availableCents: d.available_cents != null ? Number(d.available_cents) || 0 : Number(d.pending_payout_cents) || 0,
          onHoldCents: Number(d.on_hold_cents) || 0,
          enabled,
          purchaseEnabled: enabled && _bool(d.purchase_enabled, true),
          giftingEnabled: enabled && _bool(d.gifting_enabled, true),
          cashoutEnabled: enabled && _bool(d.cashout_enabled, true),
          isMinor: !!d.is_minor,
          blockedReason: d.blocked_reason || null,
        });
      } else if (errorCode(r) === 'feature_disabled') {
        _set({ loaded: true, enabled: false, purchaseEnabled: false, giftingEnabled: false, cashoutEnabled: false, blockedReason: 'disabled' });
      } else {
        _set({ loaded: true });
      }
    } catch {
      _set({ loaded: true });
    } finally {
      setTimeout(() => { _inflight = null; }, 0);
    }
    return _state;
  })();
  return _inflight;
}

// ── Catálogo de presentes (cache 10 min) ───────────────────────────────────
let _catalog = GIFT_CATALOG;
let _catalogAt = 0;
export function getCachedGiftCatalog() { return _catalog; }
export async function loadGiftCatalog(force = false) {
  if (!force && _catalogAt && Date.now() - _catalogAt < 10 * 60 * 1000) return _catalog;
  try {
    const r = await apiCall('live_gift_catalog', {}, 'POST');
    const list = r?.data?.gifts || r?.gifts;
    if (Array.isArray(list) && list.length) {
      _catalog = normalizeGifts(list);
      _catalogAt = Date.now();
    }
  } catch {}
  return _catalog;
}

/**
 * Envia presente. Sempre com client_id (idempotência no servidor).
 * @returns {Promise<{ok:boolean, code?:string, data?:object, status?:number}>}
 */
export async function sendGift({ context, targetId, sku, quantity = 1, comboId = '', comboCount = 0, clientId }) {
  if (isMinorAccount()) return { ok: false, code: 'minor_blocked' };
  const q = Math.max(1, Math.min(99, Number(quantity) || 1));
  try {
    const r = await apiCall('diamond_gift_send', {
      context,
      target_id: String(targetId ?? ''),
      gift_sku: sku,
      quantity: q,
      combo_id: comboId || undefined,
      combo_count: comboCount || undefined,
      client_id: clientId || newClientId(),
    }, 'POST');
    if (r && r.success) {
      const d = r.data || {};
      if (typeof d.diamond_balance === 'number') setDiamondBalance(d.diamond_balance);
      return { ok: true, data: d };
    }
    const code = errorCode(r);
    const d = (r && r.data) || {};
    if (code === 'insufficient_diamonds' && typeof d.diamond_balance === 'number') setDiamondBalance(d.diamond_balance);
    if (code === 'feature_disabled') _set({ enabled: false, giftingEnabled: false, purchaseEnabled: false, blockedReason: 'disabled' });
    if (code === 'minor_blocked') _set({ isMinor: true, blockedReason: 'minor' });
    return { ok: false, code, data: d, status: Number(r && r.__httpStatus) || 0 };
  } catch (e) {
    return { ok: false, code: e && e.offline ? 'network' : 'failed' };
  }
}

// ── Creator / saque ─────────────────────────────────────────────────────────
export const MIN_CASHOUT_CENTS = 5000;
