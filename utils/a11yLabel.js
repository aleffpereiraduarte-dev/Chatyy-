// [2026-10-20 a11y] Rótulo de acessibilidade traduzido fora de componente (sem `t` à mão):
// mesmo caminho do t() (cadeia de fallback do idioma ativo). Usado nos botões só-ícone
// (X, voltar, lixeira…) que o VoiceOver/TalkBack liam como "botão" sem nome.
//   <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.close', 'Fechar')}>
export function a11yLabel(key, fallback) {
  try {
    const v = require('../i18n').lookupKey(globalThis.__chatyyLang || 'pt-BR', key);
    return typeof v === 'string' && v && v !== key ? v : fallback;
  } catch {
    return fallback;
  }
}
export default a11yLabel;
