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
import { cacheUserScope } from './cache';
import { peekCached, putCached } from '../hooks/useCachedAction';
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
  // [2026-10-16 carteira-clara] regras de saque vindas do SERVIDOR (null = ainda
  // não sabemos → a UI omite o número; nunca inventa). wallet_balance e/ou
  // creator_earnings_summary / payout_method_get (saque v2 pode mudar o mínimo).
  minCashoutCents: null,
  holdDays: null,
  payoutPerDiamondMillicents: null,
};
let _state = { ...INITIAL };
const _listeners = new Set();
function _set(patch) {
  _syncScope();
  _state = { ..._state, ...patch };
  _listeners.forEach((l) => { try { l(); } catch {} });
}
// [2026-10-14 offline-first] Saldo salvo no aparelho (por conta): a carteira
// abre com o último saldo conhecido; refreshWallet() revalida. O store em
// memória é reiniciado quando a conta ativa muda (nunca mostra o da outra).
const BAL_KEY = ['wallet', 'balance'];
const RULES_KEY = ['wallet', 'cashout-rules'];
let _stateScope = null;
function _syncScope() {
  let sc = '';
  try { sc = cacheUserScope(); } catch {}
  if (sc === _stateScope) return;
  _stateScope = sc;
  _state = { ...INITIAL };
  if (!sc) return;
  try { const d = peekCached(BAL_KEY); if (d && typeof d === 'object') _state = { ..._state, ..._balancePatch(d), loaded: true }; } catch {}
  try { const r = peekCached(RULES_KEY); if (r && typeof r === 'object') _state = { ..._state, ..._rulesPatch(r) }; } catch {}
}
export function getWallet() { _syncScope(); return _state; }
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
function _balancePatch(d) {
  const enabled = _bool(d.enabled, true);
  return {
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
    ..._rulesPatch(d),
  };
}
// Só copia o que o servidor mandou (ausente ≠ zero → não sobrescreve).
function _rulesPatch(d) {
  const out = {};
  if (!d || typeof d !== 'object' || d._fallback) return out;
  const min = Number(d.min_cashout_cents != null ? d.min_cashout_cents : d.min_cents);
  if (min > 0) out.minCashoutCents = min;
  const hd = Number(d.hold_days);
  if (hd > 0) out.holdDays = hd;
  const ppd = Number(d.payout_per_diamond_millicents);
  if (ppd > 0) out.payoutPerDiamondMillicents = ppd;
  return out;
}
/** Telas de ganhos/saque repassam as regras que receberam do servidor. */
export function noteCashoutRules(d) {
  const p = _rulesPatch(d);
  if (!Object.keys(p).length) return;
  _syncScope();
  const cur = { minCashoutCents: _state.minCashoutCents, holdDays: _state.holdDays, payoutPerDiamondMillicents: _state.payoutPerDiamondMillicents };
  const next = { ...cur, ...p };
  if (next.minCashoutCents === cur.minCashoutCents && next.holdDays === cur.holdDays && next.payoutPerDiamondMillicents === cur.payoutPerDiamondMillicents) return;
  _set(p);
  try {
    putCached(RULES_KEY, {
      min_cashout_cents: next.minCashoutCents, hold_days: next.holdDays, payout_per_diamond_millicents: next.payoutPerDiamondMillicents,
    });
  } catch {}
}

let _inflight = null;
export function refreshWallet() {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const r = await apiCall('wallet_balance', {}, 'POST');
      const _sc0 = cacheUserScope();
      if (r && r.success && r.data) {
        const d = r.data;
        _syncScope();
        if (cacheUserScope() !== _sc0) return _state; // trocou de conta em voo
        _set({ loaded: true, ..._balancePatch(d) });
        try { putCached(BAL_KEY, d); } catch {}
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
export async function sendGift({ context, targetId, sku, quantity = 1, comboId = '', comboCount = 0, clientId, note = '' }) {
  if (isMinorAccount()) return { ok: false, code: 'minor_blocked' };
  const q = Math.max(1, Math.min(99, Number(quantity) || 1));
  // [gift-premium 2026-10-16] client_id fixo por envio: retry/409 duplicate_in_flight
  // reenviam o MESMO id → o servidor devolve a resposta idempotente (nunca cobra 2x).
  const cid = clientId || newClientId();
  const nt = context === 'chat' ? String(note || '').trim().slice(0, 120) : '';
  const body = {
    context,
    target_id: String(targetId ?? ''),
    gift_sku: sku,
    quantity: q,
    combo_id: comboId || undefined,
    combo_count: comboCount || undefined,
    client_id: cid,
    note: nt || undefined,
  };
  try {
    let r = await apiCall('diamond_gift_send', body, 'POST');
    for (let i = 0; i < 2 && r && !r.success && errorCode(r) === 'duplicate_in_flight'; i++) {
      await new Promise((ok) => setTimeout(ok, 600 + i * 600));
      r = await apiCall('diamond_gift_send', body, 'POST');
    }
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
