// services/mailDraftLocal.js — [2026-10-18 email-draft-local]
//
// Rascunho do e-mail salvo LOCALMENTE a cada mudança (MMKV shim, síncrono em
// memória + disco em segundo plano). O servidor (draft_save = ~5 idas ao IMAP,
// p95 ~1 s) só recebe depois de ~30 s parado, ao ir pro 2º plano ou ao sair da
// tela — antes era a cada 5 s e duplicava rascunhos.
//
// Um "slot" por sessão do compose: { sid, acct, draftUid, subject, to, cc, bcc,
// body, ts, dirty }. dirty=false depois que o servidor confirmou; o slot some no
// envio/descartar/saída limpa. Se o app morrer com um slot dirty, a próxima
// abertura do compose (nativo) empurra esse conteúdo pro servidor como rascunho
// (recoverOrphanDrafts) — nada digitado se perde.
//
// Kill switch (OTA): globalThis.__chatyy_mail_draft_local = false → compose volta
// ao autosave antigo de 5 s.
import { Platform } from 'react-native';
import { getJSON, setJSON, remove } from './mmkv';

const IDX_KEY = 'mail_draft_local_idx_v1';
const SLOT_PFX = 'mail_draft_local_v1_';
const MAX_SLOTS = 8;
const MAX_BYTES = 900 * 1024; // corpo gigante (imagem colada em base64) → só servidor
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export const DRAFT_IDLE_SYNC_MS = 30000;   // parado 30 s → servidor
export const DRAFT_MAX_WAIT_MS = 120000;   // digitando sem parar → no máx. a cada 2 min

export function isDraftLocalOn() {
  try { return globalThis.__chatyy_mail_draft_local !== false; } catch { return true; }
}

export function newDraftSid() {
  return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function _acct() {
  try {
    const { getActiveAccountEmail } = require('./api');
    const e = getActiveAccountEmail && getActiveAccountEmail();
    return e ? String(e).toLowerCase() : '';
  } catch { return ''; }
}

function _idx() {
  const v = getJSON(IDX_KEY);
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

function _setIdx(list) {
  try { setJSON(IDX_KEY, list.slice(0, MAX_SLOTS)); } catch {}
}

/** Grava o slot (síncrono na memória). Retorna false se não coube. */
export function saveLocalDraft(sid, data) {
  if (!sid || !data) return false;
  try {
    const slot = {
      sid,
      acct: _acct(),
      draftUid: data.draftUid || null,
      subject: data.subject || '',
      to: data.to || '',
      cc: data.cc || '',
      bcc: data.bcc || '',
      body: data.body || '',
      ts: Date.now(),
      dirty: data.dirty !== false,
    };
    const s = JSON.stringify(slot);
    if (s.length > MAX_BYTES) return false;
    setJSON(SLOT_PFX + sid, slot);
    const idx = _idx();
    if (idx[0] !== sid) {
      const next = [sid, ...idx.filter((x) => x !== sid)];
      // slots além do teto: os mais velhos saem
      for (const old of next.slice(MAX_SLOTS)) { try { remove(SLOT_PFX + old); } catch {} }
      _setIdx(next);
    }
    return true;
  } catch { return false; }
}

/** Servidor confirmou: marca limpo (mantém o uid p/ a próxima troca). */
export function markLocalDraftSynced(sid, draftUid) {
  if (!sid) return;
  try {
    const slot = getJSON(SLOT_PFX + sid);
    if (!slot) return;
    slot.dirty = false;
    if (draftUid) slot.draftUid = draftUid;
    setJSON(SLOT_PFX + sid, slot);
  } catch {}
}

export function clearLocalDraft(sid) {
  if (!sid) return;
  try { remove(SLOT_PFX + sid); } catch {}
  try { _setIdx(_idx().filter((x) => x !== sid)); } catch {}
}

/**
 * Slots dirty de sessões anteriores (app morto antes de sincronizar) da conta
 * ativa → draft_save. Só nativo: no web pode haver outra aba viva com o slot.
 * Fire-and-forget; nunca joga.
 */
let _recovering = false;
export async function recoverOrphanDrafts(currentSid, draftSaveFn) {
  if (_recovering || Platform.OS === 'web' || typeof draftSaveFn !== 'function') return 0;
  _recovering = true;
  let n = 0;
  try {
    const acct = _acct();
    const now = Date.now();
    for (const sid of _idx()) {
      if (sid === currentSid) continue;
      const slot = getJSON(SLOT_PFX + sid);
      if (!slot || now - (slot.ts || 0) > MAX_AGE_MS) { clearLocalDraft(sid); continue; }
      if (!slot.dirty) { clearLocalDraft(sid); continue; }
      if (acct && slot.acct && slot.acct !== acct) continue; // outra conta: espera ela
      if (now - (slot.ts || 0) < 10000) continue; // mexido agora há pouco → não é órfão
      try {
        const r = await draftSaveFn({
          subject: slot.subject, to: slot.to, cc: slot.cc, bcc: slot.bcc, body: slot.body,
          draft_uid: slot.draftUid || undefined,
        });
        if (r?.success) { clearLocalDraft(sid); n++; }
      } catch {}
    }
  } catch {}
  _recovering = false;
  return n;
}
