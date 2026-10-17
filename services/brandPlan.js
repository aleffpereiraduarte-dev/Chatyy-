// [2026-10-17 brand-plan] Nome comercial do plano pago (armazenamento +
// premium) num lugar SÓ. Renomear o produto = trocar PLAN_NAME aqui.
//
// i18n: os textos usam o marcador {plan} (ex.: 'Upgrade para {plan}').
// context/LanguageContext t() preenche {plan} com PLAN_NAME automaticamente
// quando o chamador não passa `plan` — nenhuma tela precisa lembrar disso.
//
// NÃO mexer aqui em ids de produto (IAP/SKU), ids de plano do servidor
// ('one'/'family'/'plus'/'pro') nem rotas (/settings-one, /one): só texto.
export const PLAN_NAME = 'Chatyy Plus';

/** Preenche {plan} numa string já traduzida (texto que não passa pelo t()). */
export function withPlanName(str) {
  if (typeof str !== 'string' || str.indexOf('{plan}') === -1) return str;
  return str.replace(/\{plan\}/g, () => PLAN_NAME);
}

/** t() com {plan} garantido (útil fora do LanguageContext). */
export function planT(t, key, params) {
  const p = { plan: PLAN_NAME, ...(params || {}) };
  const s = typeof t === 'function' ? t(key, p) : key;
  return withPlanName(s);
}

export default { PLAN_NAME, withPlanName, planT };
