// services/photosBackupSummary.js — [2026-10-19 fotos-backup]
//
// Números REAIS do card "Status do backup" (aba Backup da tela Fotos).
//
// Bug (founder, 19/10): o card mostrava "Backup feito 0 / Pendente 59.080" com
// 59 mil fotos já no R2. O card derivava tudo de um único escalar
// (backedUpTotal do PhotosContext, preenchido por vários polls com
// `if (n > 0)`) e o índice local "isto já subiu" (@chatyy_backup/backed_up_map)
// estava VAZIO neste aparelho (localMap=0 no heartbeat) — só é semeado pelo
// motor quando o backup automático está ligado. Com o backup desligado nada
// reconciliava, então "Feito" ficava 0 e "Pendente" = o rolo inteiro.
//
// Agora:
//   1. getCloudSummary(): drive_backup_status (fotos × vídeos na nuvem, sem
//      blobs perdidos, espaço, último backup) — aparece na hora, antes de
//      qualquer comparação com o aparelho.
//   2. reconcileDevice(): percorre os IDs do rolo (expo-media-library, só IDs)
//      e pergunta ao servidor quais já estão lá (drive_precheck_asset_ids, o
//      mesmo casamento md5(asset_id)[0:10] do nome que o motor usa). Grava os
//      confirmados no índice local (merge — nunca apaga o que não foi
//      verificado) e tira os que o servidor perdeu (missing) para que sejam
//      reenviados. Resultado fica em cache por conta.
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const RECON_KEY = '@chatyy_backup/reconcile_v1:';
const SUMMARY_KEY = '@chatyy_backup/cloud_summary_v1:';
const RECON_MIN_GAP_MS = 6 * 60 * 60 * 1000;
const PAGE = 1000;
const CHUNK = 5000; // limite do servidor por chamada

function api() { try { return require('./api'); } catch { return null; } }

function accountKey() {
  const a = api();
  let e = '';
  try { e = (a && a.getActiveAccountEmail && a.getActiveAccountEmail()) || ''; } catch {}
  if (!e) { try { e = (a && a.getSavedEmail && a.getSavedEmail()) || ''; } catch {} }
  return String(e || '').trim().toLowerCase();
}

async function readJSON(key) {
  try { const raw = await AsyncStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function writeJSON(key, v) {
  try { await AsyncStorage.setItem(key, JSON.stringify(v)); } catch {}
}

/** Último resumo da nuvem salvo para a conta ativa (instantâneo). */
export async function getCachedCloudSummary() {
  const acct = accountKey();
  if (!acct) return null;
  return readJSON(SUMMARY_KEY + acct);
}

/**
 * Resumo da nuvem. Servidor novo manda photos/videos/missing/last_backup_at;
 * servidor antigo (edge sem o patch) só backed_up/total_size → tudo vira
 * "itens" e photos/videos ficam null.
 */
export async function getCloudSummary() {
  const a = api();
  if (!a) return null;
  const acct = accountKey();
  let r = null;
  try { r = await a.apiCall('drive_backup_status'); } catch { r = null; }
  const d = r && r.success ? (r.data || {}) : null;
  if (!d) {
    // reserva: só a contagem
    try {
      const c = await a.apiCall('drive_backup_count');
      const n = Number(c?.data?.count || 0);
      if (c?.success) return { total: n, photos: null, videos: null, missing: 0, size: null, lastBackupAt: null, at: Date.now() };
    } catch {}
    return null;
  }
  const hasSplit = d.photos != null && d.videos != null;
  const out = {
    total: hasSplit ? Number(d.cloud_total || (Number(d.photos) + Number(d.videos))) : Number(d.backed_up || 0),
    photos: hasSplit ? Number(d.photos) : null,
    videos: hasSplit ? Number(d.videos) : null,
    missing: Number(d.missing || 0),
    size: d.total_size != null ? Number(d.total_size) : null, // mesmo número da cota/medidor
    lastBackupAt: d.last_backup_at || null,
    at: Date.now(),
  };
  if (acct && acct === accountKey()) writeJSON(SUMMARY_KEY + acct, out);
  return out;
}

/** Resultado da última comparação aparelho × nuvem (conta ativa). */
export async function getCachedReconcile() {
  const acct = accountKey();
  if (!acct) return null;
  return readJSON(RECON_KEY + acct);
}

let _running = null;

/**
 * Compara o rolo do aparelho com a nuvem.
 * @returns {Promise<{deviceTotal:number, matched:number, missing:number, pending:number, at:number}|null>}
 * onProgress({ phase: 'scan'|'match', done, total })
 */
export function reconcileDevice({ force = false, onProgress } = {}) {
  if (Platform.OS === 'web') return Promise.resolve(null);
  if (_running) return _running;
  _running = (async () => {
    const acct = accountKey();
    if (!acct) return null;
    if (!force) {
      const prev = await readJSON(RECON_KEY + acct);
      if (prev && prev.at && Date.now() - prev.at < RECON_MIN_GAP_MS) return prev;
    }
    let ML;
    try { ML = require('expo-media-library'); } catch { return null; }
    try {
      const p = await ML.getPermissionsAsync();
      if (!p || p.status !== 'granted') return null;
    } catch { return null; }

    // 1) IDs do rolo (fotos + vídeos), só o necessário
    const ids = [];
    let after;
    let total = 0;
    for (let guard = 0; guard < 400; guard++) {
      let page;
      try {
        page = await ML.getAssetsAsync({
          first: PAGE,
          after,
          mediaType: [ML.MediaType.photo, ML.MediaType.video],
          sortBy: [[ML.SortBy.creationTime, false]],
        });
      } catch { break; }
      total = page?.totalCount || total;
      for (const as of (page?.assets || [])) if (as && as.id) ids.push(as.id);
      try { onProgress && onProgress({ phase: 'scan', done: ids.length, total }); } catch {}
      if (!page?.hasNextPage || !page?.endCursor) break;
      after = page.endCursor;
    }
    if (ids.length === 0) return null;
    if (acct !== accountKey()) return null; // trocou de conta no meio

    // 2) servidor: quais já estão lá
    const a = api();
    const found = new Set();
    const gone = new Set();
    let checked = 0;
    let failedChunks = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      let r = null;
      try { r = await a.apiCall('drive_precheck_asset_ids', { asset_ids: slice }, 'POST'); } catch { r = null; }
      if (!r || !r.success) { failedChunks++; continue; }
      for (const id of (r.data?.backed_up || [])) found.add(id);
      for (const id of (r.data?.missing || [])) gone.add(id);
      checked += slice.length;
      try { onProgress && onProgress({ phase: 'match', done: checked, total: ids.length }); } catch {}
    }
    if (checked === 0) return null;
    if (acct !== accountKey()) return null;

    // 3) índice local: merge (só confirmados entram; perdidos saem)
    try {
      const bs = require('./backup/backupStorage');
      const map = { ...((await bs.getBackedUpMap()) || {}) };
      const now = Date.now();
      let changed = 0;
      for (const id of found) if (!map[id]) { map[id] = now; changed++; }
      for (const id of gone) if (map[id]) { delete map[id]; changed++; }
      if (changed > 0) await bs.saveBackedUpMap(map);
    } catch {}

    // Chunks que falharam: não dá para afirmar nada sobre eles → contam como
    // "não verificados" (fora de matched e de pending).
    const unverified = ids.length - checked;
    const res = {
      deviceTotal: Math.max(total, ids.length),
      matched: found.size,
      missing: gone.size,
      pending: Math.max(0, checked - found.size),
      unverified,
      partial: failedChunks > 0,
      at: Date.now(),
    };
    await writeJSON(RECON_KEY + acct, res);
    return res;
  })().finally(() => { _running = null; });
  return _running;
}

