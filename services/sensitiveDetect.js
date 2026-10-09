// [2026-10-09 on-device-privacy] Detecção de dado sensível NO APARELHO.
//
// Antes: cada mensagem de chat com >10 caracteres (e cada e-mail enviado) ia
// para o servidor em `ai_detect_leak` (177/dia, ~0,56 s) só para rodar estas
// mesmas regex. Agora roda local, síncrono (<1 ms), e o texto nunca sai do
// aparelho para essa checagem. Mesma saída do endpoint antigo:
//   { has_secret: bool, types: ['card'|'cpf'|'api_key'|'password'] }
//
// Puro JS (sem módulo nativo) → funciona em qualquer binário e na web.

const MAX_SCAN = 4000;

function luhnOk(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Dígitos verificadores do CPF (evita alarme com qualquer 000.000.000-00).
function cpfOk(d) {
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (let len = 9; len <= 10; len++) {
    let s = 0;
    for (let i = 0; i < len; i++) s += (d.charCodeAt(i) - 48) * (len + 1 - i);
    let r = (s * 10) % 11;
    if (r === 10) r = 0;
    if (r !== d.charCodeAt(len) - 48) return false;
  }
  return true;
}

const CARD_RE = /(?:^|[^\d])((?:\d[ -]?){12,18}\d)(?!\d)/g;
// Formatado (000.000.000-00) ou 11 dígitos colados perto da palavra "cpf".
const CPF_FMT_RE = /(?:^|[^\d])(\d{3}\.\d{3}\.\d{3}-\d{2})(?!\d)/g;
const CPF_WORD_RE = /\bcpf\b\D{0,12}(\d{11})(?!\d)/gi;
const API_KEY_RE = /(?:^|[^A-Za-z0-9_-])(?:sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|rk_(?:live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----)/;
const PASSWORD_RE = /(?:^|[^A-Za-z\u00C0-\u024F])(?:senha|password|passwd|pwd|contraseña|mot de passe|passwort|parola d'ordine|pin)\s*[:=]\s*\S{4,}/i;

export function detectSensitive(input) {
  const text = typeof input === 'string' ? input.slice(0, MAX_SCAN) : '';
  const types = [];
  if (!text || text.length < 6) return { has_secret: false, types };

  CARD_RE.lastIndex = 0;
  let m;
  while ((m = CARD_RE.exec(text)) !== null) {
    const d = m[1].replace(/\D/g, '');
    // 13–19 dígitos, não todos iguais, Luhn válido.
    if (d.length >= 13 && d.length <= 19 && !/^(\d)\1+$/.test(d) && luhnOk(d)) { types.push('card'); break; }
  }

  let cpf = false;
  CPF_FMT_RE.lastIndex = 0;
  while (!cpf && (m = CPF_FMT_RE.exec(text)) !== null) {
    if (cpfOk(m[1].replace(/\D/g, ''))) cpf = true;
  }
  CPF_WORD_RE.lastIndex = 0;
  while (!cpf && (m = CPF_WORD_RE.exec(text)) !== null) {
    if (cpfOk(m[1])) cpf = true;
  }
  if (cpf) types.push('cpf');

  if (API_KEY_RE.test(text)) types.push('api_key');
  if (PASSWORD_RE.test(text)) types.push('password');

  return { has_secret: types.length > 0, types };
}

// Rótulos traduzidos para os chips do aviso. `t` = função do LanguageContext.
export function sensitiveTypeLabel(type, t) {
  const key = {
    card: 'sensitive.typeCard',
    cpf: 'sensitive.typeCpf',
    api_key: 'sensitive.typeApiKey',
    password: 'sensitive.typePassword',
  }[type];
  if (!key || typeof t !== 'function') return String(type || '');
  const v = t(key);
  return v && v !== key ? v : String(type);
}

export default detectSensitive;
