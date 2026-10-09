// [2026-10-09 plans-consistency] Fonte ÚNICA de plano/cota no app.
//
// O backend é a fonte da verdade: plan_info (plans.php getUserPlan) devolve
// plan_id canônico (free|plus|pro), a cota EFETIVA e o catálogo dos planos;
// chat_storage_usage devolve uso + a MESMA cota. Todas as telas (/plans,
// /storage, /backup, Configurações > Chatyy One) leem daqui, com cache por
// conta (chave = e-mail ativo) — nunca vaza plano de uma conta pra outra.
//
// Os números abaixo (FALLBACK_CATALOG) só aparecem antes da 1ª resposta do
// servidor e espelham /var/www/mail/api/plans.php (PLAN_FREE/PLUS/PRO).
import { useCallback, useEffect, useState } from 'react';
import * as api from './api';

export const GB = 1024 * 1024 * 1024;
const TTL_MS = 60 * 1000;

export const FALLBACK_CATALOG = {
  free: { id: 'free', name_key: 'planName.free', storage_gb: 20,   max_file_gb: 2, backup_retention_days: 30, max_members: 1, price_cents: 0,    price_annual_cents: 0 },
  plus: { id: 'plus', name_key: 'planName.plus', storage_gb: 200,  max_file_gb: 2, backup_retention_days: 30, max_members: 1, price_cents: 1499, price_annual_cents: 14990 },
  pro:  { id: 'pro',  name_key: 'planName.pro',  storage_gb: 1024, max_file_gb: 5, backup_retention_days: 90, max_members: 6, price_cents: 2999, price_annual_cents: 27990 },
};

/** Nome gravado no banco é legado ('one' = Plus, 'family' = Pro). */
export function canonicalPlanId(raw) {
  const v = String(raw || '').toLowerCase();
  if (v === 'plus' || v === 'one') return 'plus';
  if (v === 'pro' || v === 'family') return 'pro';
  return 'free';
}

/** "20 GB", "200 GB", "1 TB", "1,5 TB" a partir de GB. */
export function formatGb(gb) {
  const n = Number(gb) || 0;
  if (n >= 1024) {
    const tb = n / 1024;
    return `${Number.isInteger(tb) ? tb : tb.toFixed(1)} TB`;
  }
  return `${Math.round(n)} GB`;
}

export function formatQuotaBytes(bytes) {
  return formatGb((Number(bytes) || 0) / GB);
}

/** Nome localizado do plano (t devolve a chave quando falta — chaves existem nos 4 core). */
export function planDisplayName(planId, t) {
  const id = canonicalPlanId(planId);
  return typeof t === 'function' ? t(`planName.${id}`) : FALLBACK_CATALOG[id].id;
}

export function catalogEntry(state, planId) {
  const id = canonicalPlanId(planId);
  return (state && state.catalog && state.catalog[id]) || FALLBACK_CATALOG[id];
}

/**
 * [2026-10-09 plan-expiry] Aviso de vencimento a partir do plan_info.
 * Backend: in_grace=true (venceu, ainda na carência de 3 dias) ou
 * plan_expired=true (passou da carência → tratado como Grátis; nada apagado).
 * Retorna { kind: 'grace'|'expired', date: 'DD/MM' } ou null.
 */
export function planExpiryNotice(info) {
  if (!info || (!info.in_grace && !info.plan_expired)) return null;
  let date = '';
  const d = info.grace_until ? new Date(info.grace_until) : null;
  if (d && !isNaN(d.getTime())) {
    date = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  return { kind: info.in_grace ? 'grace' : 'expired', date };
}

/** Junta plan_info + chat_storage_usage num formato único. */
export function normalizePlanState(info, usage) {
  const planId = info?.plan_id || canonicalPlanId(info?.plan || usage?.plan_id || usage?.plan);
  const fb = FALLBACK_CATALOG[planId];
  const limitBytes = Number(info?.storage_limit) || Number(usage?.limit_bytes) || fb.storage_gb * GB;
  const usedRaw = usage?.used_bytes ?? info?.storage_used;
  const usedBytes = Number.isFinite(Number(usedRaw)) ? Number(usedRaw) : null;
  const catalog = (info?.catalog && typeof info.catalog === 'object') ? info.catalog : FALLBACK_CATALOG;
  return {
    planId,
    rawPlan: info?.plan || 'free',
    planNameKey: `planName.${planId}`,
    isPaid: planId !== 'free' || !!usage?.storage_addon,
    limitBytes,
    limitGb: Math.round(limitBytes / GB),
    usedBytes,
    percent: usedBytes != null && limitBytes > 0 ? Math.min(100, Math.max(0, (usedBytes / limitBytes) * 100)) : 0,
    maxFileBytes: Number(info?.max_file_size) || fb.max_file_gb * GB,
    backupRetentionDays: Number(info?.backup_retention_days) || fb.backup_retention_days,
    maxMembers: Number(info?.max_members) || fb.max_members,
    familyAdmin: info?.family_admin || null,
    billingPeriod: info?.billing_period || usage?.billing_period || 'monthly',
    expiresAt: info?.expires_at || null,
    expiryNotice: planExpiryNotice(info),
    storageTier: usage?.tier || null,
    storageAddon: !!usage?.storage_addon,
    activeUntil: Number(usage?.active_until) || 0,
    graceActive: !!usage?.grace_active,
    breakdown: usage?.breakdown || null,
    catalog,
    storageTiers: Array.isArray(info?.storage_tiers) ? info.storage_tiers : null,
    info: info || null,
    usage: usage || null,
  };
}

// ── cache por conta ──────────────────────────────────────────────
const _cache = new Map();    // email -> { at, state }
const _inflight = new Map(); // email -> Promise
const _subs = new Set();

function _acct() {
  try { return String(api.getSavedEmail?.() || '').toLowerCase(); } catch { return ''; }
}

export function getCachedPlanState() {
  const hit = _cache.get(_acct());
  return hit ? hit.state : null;
}

export function invalidatePlanState() {
  _cache.delete(_acct());
}

export async function loadPlanState({ force = false } = {}) {
  const acct = _acct();
  const hit = _cache.get(acct);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.state;
  if (_inflight.has(acct)) return _inflight.get(acct);
  const p = (async () => {
    const [infoRes, usageRes] = await Promise.all([
      api.planInfo().catch(() => null),
      api.storageUsage().catch(() => null),
    ]);
    const info = infoRes?.success !== false ? infoRes?.data : null;
    const usage = usageRes?.success !== false ? usageRes?.data : null;
    if (!info && !usage) return hit ? hit.state : null;
    const state = normalizePlanState(info, usage);
    // Conta pode ter trocado durante o fetch: só grava se ainda é a mesma.
    if (_acct() === acct) {
      _cache.set(acct, { at: Date.now(), state });
      _subs.forEach((fn) => { try { fn(state); } catch {} });
    }
    return state;
  })().finally(() => { _inflight.delete(acct); });
  _inflight.set(acct, p);
  return p;
}

/** Hook único: { plan, loading, refresh }. */
export function usePlanState() {
  const [plan, setPlan] = useState(() => getCachedPlanState());
  const [loading, setLoading] = useState(!plan);
  const refresh = useCallback(async (force = true) => {
    try {
      const s = await loadPlanState({ force });
      if (s) setPlan(s);
      return s;
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    let alive = true;
    const sub = (s) => { if (alive) setPlan(s); };
    _subs.add(sub);
    loadPlanState({ force: false })
      .then((s) => { if (alive && s) setPlan(s); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; _subs.delete(sub); };
  }, []);
  return { plan, loading, refresh };
}

export default {
  canonicalPlanId, formatGb, formatQuotaBytes, planDisplayName, catalogEntry,
  normalizePlanState, loadPlanState, getCachedPlanState, invalidatePlanState, usePlanState,
};
