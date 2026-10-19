// [2026-10-17 smart-storage] Ofertas inteligentes de armazenamento (estilo
// Google One / WhatsApp): quando mostrar, qual plano recomendar e quanto custa.
//
//  - Preço/tamanho NUNCA fixos aqui: vêm do servidor (plan_info.storage_tiers,
//    derivado de STORAGE_TIERS_WAVE75 em plans.php) e, no celular, do preço
//    localizado da loja (IAP) quando o catálogo já carregou.
//  - Recomendação = menor tier que cabe uso atual + necessidade extra (ex.:
//    backup pendente) + folga de crescimento (amostras locais de uso).
//  - Cada aviso tem teto de frequência por conta (mmkv, chave por e-mail):
//      near80 → 14 dias · near95 → 3 dias · quota (envio bloqueado) → 1 dia
//      backup (biblioteca > espaço livre) → 14 dias
//  - Eventos globais (envio bloqueado / backup não cabe) → StorageOfferHost
//    (montado no _layout) mostra o sheet. Sem host → quem chamou decide.
import { Platform } from 'react-native';
import * as kv from './mmkv';
import * as api from './api';
import { GB, getCachedPlanState, loadPlanState } from './planState';

const DAY = 86400000;
export const OFFER_CAP_DAYS = { near80: 14, near95: 3, quota: 1, backup: 14 };
const GROWTH_MONTHS = 6;      // folga = crescimento estimado de 6 meses
const MIN_HEADROOM = 0.15;    // ou, no mínimo, 15% acima do necessário
const MAX_SAMPLES = 16;

function _acct() {
  try { return String(api.getSavedEmail?.() || '').toLowerCase(); } catch { return ''; }
}
function _key() { return 'storage_offers_v1:' + (_acct() || '_'); }
function _read() {
  try { const v = kv.getJSON(_key()); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
function _write(v) { try { kv.setJSON(_key(), v); } catch {} }

// ── teto de frequência ──────────────────────────────────────────────────
const _sessionShown = new Set(); // mostrado nesta sessão → continua visível até dispensar

export function canShowOffer(kind) {
  const days = OFFER_CAP_DAYS[kind] || 7;
  const st = _read();
  const at = Number(st.shown?.[kind]) || 0;
  if (_sessionShown.has(_acct() + ':' + kind)) return true;
  return Date.now() - at >= days * DAY;
}
/** Marca como exibido (inicia o teto). Continua visível no resto da sessão. */
export function markOfferShown(kind) {
  const k = _acct() + ':' + kind;
  if (_sessionShown.has(k)) return;
  _sessionShown.add(k);
  const st = _read();
  st.shown = { ...(st.shown || {}), [kind]: Date.now() };
  _write(st);
}
/** Dispensado pelo usuário → some agora e só volta depois do teto. */
export function dismissOffer(kind) {
  _sessionShown.delete(_acct() + ':' + kind);
  const st = _read();
  st.shown = { ...(st.shown || {}), [kind]: Date.now() };
  _write(st);
}

// ── crescimento (amostras locais de uso, 1/dia) ─────────────────────────
export function recordUsageSample(usedBytes) {
  const u = Number(usedBytes);
  if (!Number.isFinite(u) || u < 0) return;
  const st = _read();
  const s = Array.isArray(st.samples) ? st.samples : [];
  const last = s[s.length - 1];
  if (last && Date.now() - last[0] < DAY) return;
  s.push([Date.now(), u]);
  st.samples = s.slice(-MAX_SAMPLES);
  _write(st);
}
/** Bytes/mês (>= 0). Precisa de >= 7 dias de histórico. */
export function monthlyGrowthBytes() {
  const s = _read().samples;
  if (!Array.isArray(s) || s.length < 2) return 0;
  const a = s[0]; const b = s[s.length - 1];
  const days = (b[0] - a[0]) / DAY;
  if (days < 7) return 0;
  return Math.max(0, ((b[1] - a[1]) / days) * 30);
}

// ── catálogo + preço ────────────────────────────────────────────────────
function _iap() { try { return require('./iap'); } catch { return null; } }

function _fmtCents(cents) {
  const v = (Number(cents) || 0) / 100;
  try { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v); } catch {}
  return 'R$ ' + v.toFixed(2).replace('.', ',');
}

/**
 * Tiers vendáveis (asc por GB) a partir do servidor. Cada item:
 * { id, gb, bytes, priceLabel, priceCents, store } — priceLabel = preço
 * localizado da loja (iOS/Android) ou o do servidor em BRL; '' se nenhum.
 */
export function getOfferTiers(plan) {
  const src = Array.isArray(plan?.storageTiers) ? plan.storageTiers : [];
  if (!src.length) return [];
  const iap = Platform.OS === 'web' ? null : _iap();
  const skuMap = {};
  try { (iap?.STORAGE_TIERS || []).forEach((x) => { skuMap[x.id] = x; }); } catch {}
  const skuOf = (id) => {
    const x = skuMap[id];
    if (!x) return '';
    return Platform.OS === 'ios' ? x.skuMonthlyApple : x.skuMonthlyGoogle;
  };
  const loc = (id) => { try { return iap?.getStorageLocalizedPrice?.(skuOf(id)) || ''; } catch { return ''; } };
  // iOS: com o catálogo da App Store carregado, só o que a loja vende.
  const iosCatalog = Platform.OS === 'ios' && src.some((x) => !!loc(x.id));
  const out = [];
  for (const x of src) {
    const gb = Number(x?.gb) || 0;
    if (!x?.id || gb <= 0) continue;
    const store = loc(x.id);
    if (iosCatalog && !store) continue;
    const cents = Number(x.price_cents_monthly) || 0;
    out.push({ id: String(x.id), gb, bytes: gb * GB, priceCents: cents, store: !!store, priceLabel: store || (cents > 0 ? _fmtCents(cents) : '') });
  }
  return out.sort((a, b) => a.gb - b.gb);
}

/**
 * Menor tier que cabe uso + extra + folga de crescimento e é maior que a cota
 * atual. Sem tier que caiba → o maior acima da cota. null = nada a oferecer.
 * Retorna { tier, needBytes, fits }.
 */
export function recommendTier(plan, { extraBytes = 0 } = {}) {
  if (!plan) return null;
  const used = Number(plan.usedBytes) || 0;
  const limit = Number(plan.limitBytes) || 0;
  const base = used + Math.max(0, Number(extraBytes) || 0);
  const reserve = Math.max(base * MIN_HEADROOM, monthlyGrowthBytes() * GROWTH_MONTHS);
  const need = base + reserve;
  const tiers = getOfferTiers(plan).filter((x) => x.bytes > limit * 1.01);
  if (!tiers.length) return null;
  const fit = tiers.find((x) => x.bytes >= need);
  return fit ? { tier: fit, needBytes: need, fits: true } : { tier: tiers[tiers.length - 1], needBytes: need, fits: false };
}

/** 'near95' | 'near80' | null para o uso atual. */
export function nudgeLevel(plan) {
  if (!plan || plan.usedBytes == null || !(plan.limitBytes > 0)) return null;
  const pct = (plan.usedBytes / plan.limitBytes) * 100;
  if (pct >= 95) return 'near95';
  if (pct >= 80) return 'near80';
  return null;
}

export function formatGbShort(bytes) {
  // [2026-10-19 plano-consistente] mesmo formato do medidor/plano ("2 TB", "200 GB").
  if ((Number(bytes) || 0) >= 1024 * 1024 * 1024) { try { return require('./format').formatStorage(bytes); } catch {} }
  const gb = (Number(bytes) || 0) / GB;
  if (gb >= 1024) { const tb = gb / 1024; return (tb >= 10 ? Math.round(tb) : tb.toFixed(1).replace('.0', '')) + ' TB'; }
  if (gb >= 10) return Math.round(gb) + ' GB';
  if (gb >= 1) return gb.toFixed(1).replace('.0', '') + ' GB';
  return Math.max(1, Math.round(gb * 1024)) + ' MB';
}

/** Rota que abre a tela do plano já com a loja no tier recomendado. */
export function offerHref(tierId) {
  return tierId ? { pathname: '/settings-one', params: { offer: String(tierId) } } : '/settings-one';
}

// ── eventos globais → StorageOfferHost ──────────────────────────────────
const _subs = new Set();
export function subscribeOffers(fn) { _subs.add(fn); return () => _subs.delete(fn); }
function _emit(ev) {
  if (!_subs.size) return false;
  _subs.forEach((fn) => { try { fn(ev); } catch {} });
  return true;
}

/**
 * Envio/backup bloqueado por falta de espaço. Mostra o sheet (no máximo 1×/dia).
 * Retorna true se o sheet vai aparecer; false → o chamador mostra o aviso dele.
 * opts: { source: 'drive'|'backup'|'chat_backup'|'vault', onCancelUploads? }
 */
export function reportQuotaBlocked(opts = {}) {
  if (!canShowOffer('quota')) return false;
  const shown = _emit({ kind: 'quota', ...opts });
  if (shown) markOfferShown('quota');
  return shown;
}

// Estimativa conservadora de tamanho: foto ~3 MB (mesma base do "Liberar
// espaço" de Fotos); vídeo ~1,5 MB por segundo (1080p) — quando a duração não
// vem, 40 MB por vídeo.
const PHOTO_BYTES = 3 * 1024 * 1024;
const VIDEO_BPS = 1.5 * 1024 * 1024;
const VIDEO_FALLBACK = 40 * 1024 * 1024;

async function _estimateLibraryBytes() {
  let ML; try { ML = require('expo-media-library'); } catch { return null; }
  try {
    const perm = await ML.getPermissionsAsync();
    if (!perm?.granted) return null;
    const photos = await ML.getAssetsAsync({ first: 1, mediaType: ML.MediaType.photo });
    const nPhotos = Number(photos?.totalCount) || 0;
    let nVideos = 0; let videoBytes = 0;
    let after; let seen = 0; let dur = 0;
    for (let page = 0; page < 4; page++) { // amostra até 2000 vídeos
      const r = await ML.getAssetsAsync({ first: 500, after, mediaType: ML.MediaType.video });
      if (page === 0) nVideos = Number(r?.totalCount) || 0;
      for (const a of (r?.assets || [])) { seen++; dur += Math.max(0, Number(a?.duration) || 0); }
      if (!r?.hasNextPage) break;
      after = r.endCursor;
    }
    if (nVideos > 0) {
      videoBytes = seen > 0 && dur > 0 ? (dur / seen) * VIDEO_BPS * nVideos : VIDEO_FALLBACK * nVideos;
    }
    return { count: nPhotos + nVideos, bytes: nPhotos * PHOTO_BYTES + videoBytes };
  } catch { return null; }
}

/**
 * Backup de fotos acabou de ser ligado: se a parte ainda não salva da
 * biblioteca não cabe no espaço livre, sugere o plano que cabe (1× a cada 14 dias).
 * opts: { backedUpCount } — itens já salvos (desconta proporcionalmente).
 */
export async function maybeOfferForBackup(opts = {}) {
  if (Platform.OS === 'web') return false;
  if (!canShowOffer('backup')) return false;
  const lib = await _estimateLibraryBytes();
  if (!lib || lib.count <= 0 || lib.bytes <= 0) return false;
  const done = Math.min(lib.count, Math.max(0, Number(opts.backedUpCount) || 0));
  const pendingBytes = lib.bytes * (1 - done / lib.count);
  let plan = getCachedPlanState();
  try { plan = (await loadPlanState({ force: false })) || plan; } catch {}
  if (!plan || plan.usedBytes == null) return false;
  const free = Math.max(0, plan.limitBytes - plan.usedBytes);
  if (pendingBytes <= free) return false;
  const rec = recommendTier(plan, { extraBytes: pendingBytes });
  const shown = _emit({ kind: 'backup', needBytes: pendingBytes, freeBytes: free, rec });
  if (shown) markOfferShown('backup');
  return shown;
}

export default {
  OFFER_CAP_DAYS, canShowOffer, markOfferShown, dismissOffer, recordUsageSample, monthlyGrowthBytes,
  getOfferTiers, recommendTier, nudgeLevel, formatGbShort, offerHref, subscribeOffers,
  reportQuotaBlocked, maybeOfferForBackup,
};
