// [dominios-novos 2026-10-24] Domínio que o USUÁRIO VÊ (chatyy.app) sem mexer no e-mail real.
//
// displayEmail(real): SÓ para exibição (perfil, "meu e-mail", QR, menus). Nunca use em
// login, envio, chaves de conversa, comparação de identidade, push, E2EE ou cache.
//   - fulano@chatyy.com.br + globalThis.__chatyy_app_alias === true → fulano@chatyy.app
//     (o alias fulano@chatyy.app entrega na mesma caixa; o servidor liga a flag)
//   - qualquer outro caso → devolve igual.
//
// signupDomainLabel(): domínio do cadastro novo (sufixo mostrado E o `domain` enviado).
//   'chatyy.app' quando globalThis.__chatyy_signup_domain === 'chatyy.app'; senão 'chatyy.com.br'.
//   Quem decide de verdade é o servidor (api/signup-domain.php); hoje o PHP normaliza
//   qualquer domain fora da lista para chatyy.com.br e aplica a flag dele.

const OLD_SUFFIX = '@chatyy.com.br';
const APP_SUFFIX = '@chatyy.app';

export function appAliasActive() {
  try { return globalThis.__chatyy_app_alias === true; } catch { return false; }
}

export function displayEmail(real) {
  if (typeof real !== 'string' || !real) return real;
  if (!appAliasActive()) return real;
  const s = real.trim();
  if (!s.toLowerCase().endsWith(OLD_SUFFIX)) return real;
  const local = s.slice(0, -OLD_SUFFIX.length);
  if (!local || local.includes('@')) return real;
  return local + APP_SUFFIX;
}

export function signupDomainLabel() {
  try { return globalThis.__chatyy_signup_domain === 'chatyy.app' ? 'chatyy.app' : 'chatyy.com.br'; } catch { return 'chatyy.com.br'; }
}

export default displayEmail;
