// [e2ee5 WP-12 2026-10-21] Vínculo do Chatyy Web pelo QR do celular + aparelhos vinculados.
//
// Contrato: docs/e2ee/CONTRATO.md §1.3/§1.4 (aparelho principal, 1 + 4 vinculados), §3
// (`chatyy.link.revoked`), §4.2.9/§4.2.10 (device_delete / devices_list), §4.2.18 (rendezvous
// `e2ee5_link_*`), §6.7 (LinkWeb/LinkPhone, ECIES `CHATYY_LINK_V1`), §6.11.5 (nomes JS).
// Decisões do founder: D4 (web só vinculada pelo QR do celular; vinculado expira após 30 dias sem
// uso) e D5 (histórico completo por padrão, opção "últimos 3 meses").
//
// O QR NÃO leva bearer: leva só `chatyy-link:1:<link_id>:<chave pública efêmera da web>:<segredo>`.
// O celular abre o canal ECIES, o servidor só vê bytes cifrados; o bearer NOVO (vinculado ao
// aparelho web, sem senha de e-mail) é emitido pelo `e2ee5_link_finish` do celular principal e
// chega à web DENTRO do canal, junto com as chaves das conversas.
//
// FLAGS (nada liga sozinho):
//   - `globalThis.__chatyy_e2ee5 === true` (caminho E2EE v5, WP-08c) — sem ela tudo aqui é inerte;
//   - celular: `e2ee5_status.flags.e2ee5_link === true` (servidor, E2EE5_FLAGS=link) OU
//     `globalThis.__chatyy_e2ee5_link === true` (QA);
//   - web antes do login (sem bearer para perguntar ao servidor): só `__chatyy_e2ee5_link === true`.
//
// Logs: só ids, estados e contagens (nunca QR, segredo, bearer ou chave).
import { Platform, AppState } from 'react-native';

const ORIGIN = 'https://chatyy.com.br';
const QR_PREFIX = 'chatyy-link:1:';
const PHONE_POLL_MS = 800;
const WEB_POLL_MS = 1000;
const LINK_MAX_MS = 10 * 60 * 1000;      // servidor: rendezvous morre em 10 min no total
const QR_REFRESH_MS = 110 * 1000;        // servidor: 2 min sem post → expira; renova antes
const QR_AUTO_REFRESH_MAX = 4;           // link_create: 20/h por IP
const THREE_MONTHS_MS = 90 * 24 * 3600 * 1000;
export const LINKED_IDLE_DAYS = 30;      // D4

function _g() { return typeof globalThis !== 'undefined' ? globalThis : global; }
function _C() { return require('../crypto'); }
function _A() { return require('../api'); }
function _E() { return require('./e2ee5'); }
function _ws() { try { return require('../websocket').default; } catch (_) { return null; } }
function _log(what, kv) {
  try { if (_g().__chatyy_e2ee5_debug === true) console.warn('[e2ee5-link] ' + what + ' ' + (kv ? JSON.stringify(kv) : '')); } catch (_) {}
}
function _err(code, extra) { const e = new Error('e2ee5_link:' + code); e.code = code; if (extra) Object.assign(e, extra); return e; }
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isOn() { try { return _g().__chatyy_e2ee5 === true; } catch (_) { return false; } }
function _qaLink() { try { return _g().__chatyy_e2ee5_link === true; } catch (_) { return false; } }

/** Web ANTES do login: mostrar o QR do vínculo E2EE no lugar do QR antigo? */
export function webLinkUiOn() { return Platform.OS === 'web' && isOn() && _qaLink(); }

/** `true` se o texto lido pela câmera é um QR de vínculo E2EE (sem validar o resto). */
export function isLinkQr(raw) { return typeof raw === 'string' && raw.trim().startsWith(QR_PREFIX) && raw.trim().split(':').length === 5; }

/** Celular: o vínculo E2EE está liberado para esta conta? (status do servidor ou flag de QA) */
export function phoneLinkOnSync() {
  if (!isOn() || Platform.OS === 'web') return false;
  if (_qaLink()) return true;
  try { const s = _E().sessionSync(); return !!(s && s.status && s.status.flags && s.status.flags.e2ee5_link === true); } catch (_) { return false; }
}

// ───────────────────────────────────────────────────────────── HTTP direto (devices_list etc.)

function _bearer() {
  try { const a = _A(); return String((a.getAuthToken && a.getAuthToken()) || ''); } catch (_) { return ''; }
}
function _base() {
  if (Platform.OS === 'web') {
    try { if (typeof location !== 'undefined' && location.origin === ORIGIN) return location.origin; } catch (_) {}
  }
  return ORIGIN;
}
async function _http(action, body, deviceId) {
  const bearer = _bearer();
  if (!bearer) return { ok: false, status: 0, code: 'unauthorized' };
  let ctl = null; let timer = null;
  try { ctl = new AbortController(); timer = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, 15000); } catch (_) {}
  try {
    const headers = { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' };
    if (deviceId) headers['X-E2EE-Device'] = deviceId;
    const r = await fetch(_base() + '/api/email.php?action=' + encodeURIComponent(action), {
      method: 'POST', headers, body: JSON.stringify(body || {}), signal: ctl ? ctl.signal : undefined,
    });
    let j = null;
    try { j = await r.json(); } catch (_) {}
    if (r.ok && j && j.success) return { ok: true, status: r.status, data: j.data || {} };
    return { ok: false, status: r.status, code: (j && j.data && j.data.code) || ('http_' + r.status) };
  } catch (_) {
    return { ok: false, status: 0, code: 'network' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Código curto para a UI a partir de um erro do núcleo/servidor/host. */
export function errorCode(e) {
  if (!e) return 'failed';
  if (e.code === 'disabled' || e.code === 'unsupported' || e.code === 'not_primary' || e.code === 'timeout' ||
      e.code === 'expired' || e.code === 'cancelled' || e.code === 'bad_qr' || e.code === 'device_limit' ||
      e.code === 'network' || e.code === 'storage') return e.code;
  const d = (e && e.details) || {};
  const sc = String(d.server_code || d.code || '');
  if (e.code === 'server' || sc) {
    if (sc === 'e2ee5_link_expired') return 'expired';
    if (sc === 'e2ee5_device_limit') return 'device_limit';
    if (sc === 'e2ee5_link_forbidden') return 'forbidden';
    if (sc === 'e2ee5_disabled') return 'disabled';
    if (sc === 'e2ee5_rate_limited') return 'rate_limited';
    if (sc === 'unauthorized') return 'unauthorized';
    return 'failed';
  }
  if (e.code === 'identity') return /not_primary/.test(String(d.msg || '')) ? 'not_primary' : 'failed';
  if (e.code === 'transport') return 'network';
  if (e.code === 'link') {
    const m = String(d.msg || '');
    if (/QR|chave do QR|segredo do QR/i.test(m)) return 'bad_qr';
    return 'failed';
  }
  return 'failed';
}

// ───────────────────────────────────────────────────────────── CELULAR: ler o QR e mandar as chaves

let _phoneRun = null; // {cancelled}

/**
 * Celular principal: lê o QR da web, emite o bearer vinculado, assina o aparelho e transfere as
 * chaves. `history`: 'all' (padrão, D5) | '3m'. `onState({phase, checkCode?, chunks?, deviceId?})`:
 * phase = 'connecting' | 'waiting_device' | 'waiting_upload' | 'sending' | 'done'.
 * → `{deviceId, chunks}`; rejeita com `.code` de `errorCode()`.
 */
export async function acceptLinkQr(qr, { history = 'all', onState } = {}) {
  if (!isOn() || Platform.OS === 'web') throw _err('disabled');
  if (!isLinkQr(qr)) throw _err('bad_qr');
  const emit = (s) => { try { if (typeof onState === 'function') onState(s); } catch (_) {} };
  if (_phoneRun) { _phoneRun.cancelled = true; try { await _C().linkCancel(); } catch (_) {} }
  const run = { cancelled: false };
  _phoneRun = run;
  emit({ phase: 'connecting' });
  const t0 = Date.now();
  try {
    const s = await _E().ensureSession();
    if (!s) throw _err('disabled');
    if (!phoneLinkOnSync()) throw _err('disabled');
    if (!s.signed) throw _err('not_primary');
    const filter = history === '3m' ? { convIds: [], sinceMs: Date.now() - THREE_MONTHS_MS } : { convIds: [], sinceMs: 0 };
    const acc = await _C().linkAccept(String(qr).trim(), filter);
    const checkCode = acc && acc.checkCode != null ? String(acc.checkCode).padStart(2, '0') : '';
    _log('accept', { history });
    emit({ phase: 'waiting_device', checkCode });
    let last = '';
    while (!run.cancelled) {
      if (Date.now() - t0 > LINK_MAX_MS) throw _err('timeout');
      let st = null;
      try { st = await _C().linkPhonePoll(); } catch (e) {
        if (e && e.code === 'transport') { await _sleep(PHONE_POLL_MS * 2); continue; } // rede oscilou: tenta de novo
        throw e;
      }
      const state = (st && st.state) || 'waiting_device';
      if (state !== last) {
        last = state;
        _log('phone_state', { state, chunks: st && st.chunks });
        emit({ phase: state === 'sent' ? 'sending' : state, checkCode, deviceId: st && st.deviceId, chunks: st && st.chunks });
      }
      if (state === 'done') {
        // Meus outros aparelhos e os contatos atualizam a lista (o servidor já avisou por WS).
        try { _E().requestSync(200); } catch (_) {}
        return { deviceId: (st && st.deviceId) || '', chunks: (st && st.chunks) || 0 };
      }
      await _sleep(PHONE_POLL_MS);
    }
    throw _err('cancelled');
  } catch (e) {
    try { await _C().linkCancel(); } catch (_) {}
    const code = errorCode(e);
    _log('phone_fail', { code, raw: e && e.code });
    throw _err(code);
  } finally {
    if (_phoneRun === run) _phoneRun = null;
  }
}

/** Cancela o vínculo em andamento no celular. */
export function cancelPhoneLink() {
  if (_phoneRun) _phoneRun.cancelled = true;
  if (isOn() && Platform.OS !== 'web') { try { _C().linkCancel().catch(() => {}); } catch (_) {} }
}

// ───────────────────────────────────────────────────────────── CELULAR: aparelhos vinculados

/** Dias até o vinculado ser desconectado por inatividade (D4). null = sem data. */
export function daysUntilIdleExpiry(lastSeenMs) {
  const n = Number(lastSeenMs) || 0;
  if (n <= 0) return null;
  const left = LINKED_IDLE_DAYS - Math.floor((Date.now() - n) / 86400000);
  return Math.max(0, left);
}

/**
 * Lista os aparelhos E2EE desta conta (menos este). → `{ok, me, isPrimary, devices:[{deviceId, kind,
 * label, platform, createdAt, lastSeen, signed, idleDaysLeft}]}`; `ok:false` = indisponível (flag,
 * coorte, rede) e a tela segue só com as sessões de hoje.
 */
export async function listLinked() {
  if (!isOn()) return { ok: false, devices: [] };
  const s = await _E().ensureSession();
  if (!s) return { ok: false, devices: [] };
  const r = await _http('e2ee5_devices_list', {}, s.deviceId);
  if (!r.ok) return { ok: false, devices: [], code: r.code };
  let isPrimary = false;
  try { const id = await _C().identityStatus(s.uid); isPrimary = !!(id && id.isPrimary); } catch (_) {}
  const devices = (Array.isArray(r.data.devices) ? r.data.devices : [])
    .filter((d) => d && d.device_id && d.device_id !== s.deviceId)
    .map((d) => ({
      deviceId: String(d.device_id),
      kind: String(d.kind || String(d.device_id)[0] || ''),
      label: d.label ? String(d.label).slice(0, 80) : '',
      platform: d.platform ? String(d.platform).slice(0, 40) : '',
      createdAt: Number(d.created_at) || 0,
      lastSeen: Number(d.last_seen) || 0,
      signed: !!d.signed,
      idleDaysLeft: String(d.device_id)[0] === 'P' ? null : daysUntilIdleExpiry(d.last_seen),
    }));
  return { ok: true, me: s.deviceId, isPrimary, devices };
}

/**
 * "Desconectar" um aparelho vinculado (só o principal). O núcleo chama `e2ee5_device_delete`
 * (servidor revoga o bearer do aparelho na hora) e DESCARTA as sessões Megolm de saída de todas
 * as conversas: a próxima mensagem sai com chave nova que o aparelho revogado não recebe.
 * Depois avisa meus outros aparelhos (`chatyy.link.revoked`, §3). → `{rotated}`
 */
export async function revokeLinked(deviceId) {
  if (!isOn()) throw _err('disabled');
  const s = await _E().ensureSession();
  if (!s) throw _err('disabled');
  if (!/^[PWTX][A-Z2-7]{12}$/.test(String(deviceId || ''))) throw _err('failed');
  let rotated = 0;
  try {
    rotated = Number(await _C().forgetDevice(String(deviceId))) || 0;
  } catch (e) {
    const code = errorCode(e);
    _log('revoke_fail', { code });
    throw _err(code === 'forbidden' ? 'not_primary' : code);
  }
  try {
    await _C().sendToDevice('chatyy.link.revoked', [{ uid: s.uid, deviceId: '' }], { v: 1, device_id: String(deviceId) });
  } catch (_) {}
  try { _E().requestSync(200); } catch (_) {}
  _log('revoked', { dev: deviceId, rotated });
  return { rotated };
}

// ───────────────────────────────────────────────────────────── WEB: mostrar o QR e receber tudo

/**
 * Web: cria o rendezvous, mostra o QR e conduz o vínculo até o fim.
 * `onState({phase, qrPayload?, expiresAt?, checkCode?, received?, total?, imported?})`, phase =
 * 'preparing' | 'qr' | 'connecting' | 'importing' | 'done'. O `qrPayload` só serve para DESENHAR o
 * QR (tem o segredo): nunca logar, nunca mandar a serviço de terceiros.
 * → `{bearer, uid, imported}`; rejeita com `.code` ('unsupported' | 'expired' | 'cancelled' | 'failed' | …).
 * `controller.cancel()` interrompe.
 */
export function startWebLink({ onState } = {}) {
  const ctl = { cancelled: false, linkId: null, cancel() { this.cancelled = true; const id = this.linkId; if (id) { try { _C().linkCancel(id).catch(() => {}); } catch (_) {} } } };
  const emit = (s) => { try { if (!ctl.cancelled && typeof onState === 'function') onState(s); } catch (_) {} };
  ctl.promise = (async () => {
    if (Platform.OS !== 'web' || !isOn()) throw _err('disabled');
    emit({ phase: 'preparing' });
    const C = _C();
    const sup = await C.isSupported();
    if (!sup || !sup.ok) throw _err(sup && sup.indexedDB === false ? 'storage' : 'unsupported');
    // Rendezvous sem bearer (§4.1); o bearer vinculado chega pelo canal e o host do worker o instala.
    await C.setAuth({ base: _base(), bearer: '' });
    let refreshes = 0;
    for (;;) {
      if (ctl.cancelled) throw _err('cancelled');
      const { linkId, qrPayload } = await C.linkBegin();
      ctl.linkId = linkId;
      const shownAt = Date.now();
      emit({ phase: 'qr', qrPayload, expiresAt: shownAt + QR_REFRESH_MS });
      try { if (_g().__chatyy_e2ee5_qa === true) _g().__chatyy_e2ee5_qa_link_qr = qrPayload; } catch (_) {} // QA headless (o QR já está na tela)
      let uid = '';
      let sentDevice = false;
      let uploaded = false;
      let bearer = '';
      let rotate = false;
      while (!ctl.cancelled) {
        let st = null;
        try {
          st = await C.linkPoll(linkId);
        } catch (e) {
          const code = errorCode(e);
          if (code === 'network') { await _sleep(WEB_POLL_MS * 2); continue; }
          if (code === 'expired' && !uid) { rotate = true; break; } // ninguém leu: QR novo
          throw _err(code);
        }
        const state = (st && st.state) || 'waiting';
        if (state === 'waiting') {
          if (Date.now() - shownAt > QR_REFRESH_MS) { rotate = true; break; }
        } else if (state === 'hello') {
          if (!sentDevice) {
            uid = String(st.uid || '');
            emit({ phase: 'connecting', checkCode: st.checkCode != null ? String(st.checkCode).padStart(2, '0') : '' });
            // Vincular = aparelho NOVO neste navegador (um store antigo do mesmo uid foi revogado).
            try { await _E().endSession({ wipe: false }); } catch (_) {}
            try { await C.wipe(uid); } catch (_) {}
            await C.open(uid);
            await C.linkSendDevice(linkId);
            sentDevice = true;
            _log('web_hello', { uid });
          }
        } else if (state === 'granted') {
          if (!uploaded) {
            bearer = String(st.bearer || '');
            if (!bearer) throw _err('failed');
            await C.linkCompleteUpload(linkId); // publica as chaves do aparelho com o bearer novo
            uploaded = true;
            emit({ phase: 'importing', received: 0, total: 0 });
          }
        } else if (state === 'importing') {
          emit({ phase: 'importing', received: Number(st.receivedChunks) || 0, total: Number(st.totalChunks) || 0 });
        } else if (state === 'done') {
          ctl.linkId = null;
          try { C.linkCancel(linkId).catch(() => {}); } catch (_) {}
          try { delete _g().__chatyy_e2ee5_qa_link_qr; } catch (_) {}
          const imported = Number(st.imported) || 0;
          _log('web_done', { imported });
          emit({ phase: 'done', imported });
          return { bearer, uid, imported };
        }
        if (Date.now() - shownAt > LINK_MAX_MS) throw _err('timeout');
        await _sleep(WEB_POLL_MS);
      }
      if (ctl.cancelled) throw _err('cancelled');
      try { C.linkCancel(linkId).catch(() => {}); } catch (_) {}
      if (rotate) {
        refreshes += 1;
        if (refreshes > QR_AUTO_REFRESH_MAX) throw _err('expired');
        continue;
      }
    }
  })().catch((e) => {
    try { delete _g().__chatyy_e2ee5_qa_link_qr; } catch (_) {}
    throw e && e.code ? e : _err(errorCode(e));
  });
  return ctl;
}

// ───────────────────────────────────────────────────────────── ganchos da sessão (chamados pelo e2ee5.js)

let _webWired = false;
let _revCheckAt = 0;

/** Web vinculada: o celular desconectou este navegador → apaga o store e sai da conta (< 5 s). */
async function _webCheckRevoked(reason) {
  if (Date.now() - _revCheckAt < 1500) return;
  _revCheckAt = Date.now();
  const E = _E();
  const s = E.sessionSync();
  if (!s || !s.deviceId) return;
  const r = await _http('e2ee5_devices_list', {}, s.deviceId);
  const gone = (!r.ok && (r.status === 401 || r.code === 'unauthorized' || r.code === 'e2ee5_device_mismatch')) ||
    (r.ok && !(r.data.devices || []).some((d) => d && d.device_id === s.deviceId));
  if (!gone) return;
  _log('web_revoked', { reason });
  try { await E.endSession({ wipe: true }); } catch (_) {}
  // O próprio api.js trata o 401 (sai da conta e volta ao login) quando o bearer já foi revogado.
  try { await _A().checkAuth(); } catch (_) {}
}

/** Chamado pelo e2ee5.ensureSession() quando a sessão abre. */
export function onSession(sess) {
  if (!isOn() || !sess) return;
  if (Platform.OS === 'web' && !_webWired) {
    const ws = _ws();
    if (ws && typeof ws.on === 'function') {
      _webWired = true;
      ws.on('e2ee5_devices', () => { setTimeout(() => { _webCheckRevoked('ws').catch(() => {}); }, 300); });
      try { AppState.addEventListener('change', (st) => { if (st === 'active') _webCheckRevoked('fg').catch(() => {}); }); } catch (_) {}
    }
  }
}

/** Chamado pelo e2ee5 com cada evento `chatyy.*` do sync (só os que interessam ao vínculo). */
export function onChatyyEvent(ev) {
  if (!isOn() || !ev || ev.eventType !== 'chatyy.link.revoked') return;
  let c = null;
  try { c = JSON.parse(ev.contentJson || '{}'); } catch (_) {}
  const s = _E().sessionSync();
  if (s && c && c.device_id && c.device_id === s.deviceId) _webCheckRevoked('event').catch(() => {});
}

/** Web logada sem vínculo (senha antiga): precisa vincular pelo celular para ler as conversas cifradas. */
export function webNeedsLinkSync() {
  if (Platform.OS !== 'web' || !isOn()) return false;
  try { const s = _E().sessionSync(); return !!(s && !s.signed); } catch (_) { return false; }
}

const link = {
  isOn, webLinkUiOn, isLinkQr, phoneLinkOnSync, errorCode, acceptLinkQr, cancelPhoneLink, listLinked, revokeLinked,
  daysUntilIdleExpiry, startWebLink, onSession, onChatyyEvent, webNeedsLinkSync, LINKED_IDLE_DAYS,
};
export default link;
