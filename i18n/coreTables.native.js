// [2026-10-15 boot-i18n] Tabelas core (pt-BR/en) no NATIVO: continuam no bundle
// (Hermes não faz code-split), mas o módulo só é AVALIADO quando alguém lê
// translations[code] (getter em i18n/index.js). Antes os dois objetos (~11k
// chaves cada, ~0.5 MB de JS cada = 26% do JS avaliado antes do 1º frame) eram
// avaliados em todo boot; quem usa pt-BR nunca precisa do en (e vice-versa):
// os dois têm o MESMO conjunto de chaves.
const _def = (m) => (m && m.default && typeof m.default === 'object' ? m.default : m);
export const CORE_SYNC = {
  'pt-BR': () => _def(require('./pt-BR')),
  'en': () => _def(require('./en')),
};
// Nada assíncrono no nativo.
export const CORE_ASYNC = {};
