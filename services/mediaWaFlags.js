// [2026-10-24 midia-wa2] Flags POR CONTA do envio de mídia nível WhatsApp (leva 2).
//
// Tudo que é novo nesta leva só liga para a allowlist (duarte/suporte/apitest/qa2) até o
// founder abrir para todos. Lido na hora de usar (nunca capturado no import) → um OTA
// muda sem recarregar.
//
//   mediaWaOn('voice_wave_name')  áudio de voz leva a onda no NOME do arquivo (_w1-<40>)
//   mediaWaOn('audio_r2')         áudio de voz sobe DIRETO ao R2 (URL pré-assinada, edge local)
//   mediaWaOn('gif_light')        GIF do Giphy: bolha baixa a versão WebP (3–11x menor)
//
// Precedência: globalThis.__chatyy_mwa2_<nome> === false/true (kill/forçar) >
//              globalThis.__chatyy_mwa2 === false (kill geral) > globalThis.__chatyy_mwa2_all === true
//              (todos) > allowlist por e-mail da conta ativa.
// Ler a onda do nome (decodificar) NÃO depende da allowlist: é passivo e vale p/ qualquer
// destinatário (kill: __chatyy_mwa2_wave_read === false).

const ALLOW = new Set([
  'duarte@chatyy.com.br',
  'suporte@chatyy.com.br',
  'apitest@chatyy.com.br', // apitest@onemundo.com.br canonizado
  'qa2@chatyy.com.br',
]);

function _g() { return typeof globalThis !== 'undefined' ? globalThis : {}; }
function _canon(e) {
  const s = String(e || '').trim().toLowerCase();
  return s.endsWith('@onemundo.com.br') ? s.slice(0, -16) + '@chatyy.com.br' : s;
}

let _emailOverride = '';
/** Teste/QA: força o e-mail da conta (node). */
export function _setEmailForTest(e) { _emailOverride = String(e || ''); }

function _activeEmail() {
  if (_emailOverride) return _emailOverride;
  try {
    const a = require('./api');
    return String((a.getAvatarViewerEmail && a.getAvatarViewerEmail()) || (a.getSavedEmail && a.getSavedEmail()) || '');
  } catch { return ''; }
}

export function accountAllowed(email) {
  return ALLOW.has(_canon(email == null ? _activeEmail() : email));
}

export function mediaWaOn(name) {
  const g = _g();
  try {
    const own = g['__chatyy_mwa2_' + name];
    if (own === false) return false;
    if (own === true) return true;
    if (g.__chatyy_mwa2 === false) return false;
    if (g.__chatyy_mwa2_all === true) return true;
  } catch { return false; }
  return accountAllowed();
}

export default { mediaWaOn, accountAllowed };
