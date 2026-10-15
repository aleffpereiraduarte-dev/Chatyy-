// [2026-10-15 native-email] Política de imagens remotas do leitor de e-mail.
//
// Regra vigente (2026-05-17, pedido do founder): imagens CARREGAM por padrão
// (pixel de rastreio 1×1 já é removido no leitor). Quem quiser privacidade liga
// "Bloquear imagens remotas" em Configurações › E-mail: aí o corpo abre com
// TUDO remoto barrado (no nativo: WKContentRuleList / shouldInterceptRequest +
// CSP; imagens, CSS e fontes externas) e aparece "Carregar imagens" /
// "Sempre deste remetente".
//
// Armazenado no MMKV (leitura síncrona na abertura do e-mail).
import { getString, setString } from './mmkv';

const PREF_KEY = 'email_block_remote_images';
const ALLOW_KEY = 'email_img_allow_v1';
const MAX_ALLOW = 500;

export function getBlockRemoteDefault() {
  try { return getString(PREF_KEY) === '1'; } catch { return false; }
}

export function setBlockRemoteDefault(on) {
  try { setString(PREF_KEY, on ? '1' : '0'); } catch {}
}

function _list() {
  try {
    const raw = getString(ALLOW_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function _norm(email) {
  return String(email || '').trim().toLowerCase();
}

export function isSenderImagesAllowed(email) {
  const e = _norm(email);
  if (!e) return false;
  return _list().includes(e);
}

export function allowSenderImages(email) {
  const e = _norm(email);
  if (!e) return;
  const arr = _list().filter((x) => x !== e);
  arr.push(e);
  while (arr.length > MAX_ALLOW) arr.shift();
  try { setString(ALLOW_KEY, JSON.stringify(arr)); } catch {}
}

/** true = abrir este e-mail com conteúdo remoto bloqueado. */
export function shouldBlockRemoteImages(senderEmail) {
  if (!getBlockRemoteDefault()) return false;
  return !isSenderImagesAllowed(senderEmail);
}
