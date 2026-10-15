// [2026-10-15 boot-i18n] Tabelas core na WEB: pt-BR (padrão, ~95% dos acessos)
// fica no bundle de entrada; en vira chunk próprio (import() faz code-split na
// web) → ~0.5 MB de JS / ~110 KB gz a menos no 1º load de quem usa pt-BR.
// Quem usa en (ou um idioma remoto, que cai no en como fallback) baixa o chunk
// já na avaliação de i18n/index.js e o gate do 1º frame (_layout) espera por
// ele junto com o JSON remoto — sem chave crua na tela.
import ptBR from './pt-BR';

export const CORE_SYNC = {
  'pt-BR': () => ptBR,
};
export const CORE_ASYNC = {
  'en': () => import('./en').then((m) => (m && m.default && typeof m.default === 'object' ? m.default : m)),
};
