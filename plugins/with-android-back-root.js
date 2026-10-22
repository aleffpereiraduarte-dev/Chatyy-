// [2026-10-22 voltar-android] Founder: "quando arrasta da esquerda pra direita no Android
// fecha o app — deixa igual ao iOS".
//
// No Android o gesto de voltar (arrastar da borda) chega no MainActivity.invokeDefaultOnBackPressed
// SÓ quando nenhuma tela JS tratou o voltar e não há mais tela para voltar — ou seja, na tela
// inicial. O template do Expo manda o app para o fundo (moveTaskToBack / padrão do Android 12+),
// o que parece "fechar". Igual ao iOS: na tela inicial o gesto de voltar NÃO faz nada.
// As outras telas continuam voltando normalmente (expo-router / BackHandler tratam antes).
//
// Kill switch (sem build): chave "chatyy_android_back_home_off" = true nas SharedPreferences
// "chatyy_flags" volta ao comportamento padrão (mandar para o fundo).
const { withMainActivity } = require('@expo/config-plugins');

const MARK = '[chatyy back-root]';

function patch(src) {
  if (src.includes(MARK)) return src;
  const re = /override fun invokeDefaultOnBackPressed\(\)\s*\{/;
  if (!re.test(src)) {
    throw new Error('[with-android-back-root] invokeDefaultOnBackPressed não encontrado no MainActivity');
  }
  return src.replace(re, (m) => m + `
      // ${MARK} tela inicial: igual ao iOS, o gesto de voltar não fecha nem minimiza o app.
      try {
        val off = getSharedPreferences("chatyy_flags", android.content.Context.MODE_PRIVATE)
          .getBoolean("chatyy_android_back_home_off", false)
        if (!off) return
      } catch (e: Throwable) { return }
`);
}

module.exports = function withAndroidBackRoot(config) {
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      throw new Error('[with-android-back-root] MainActivity não é Kotlin');
    }
    cfg.modResults.contents = patch(cfg.modResults.contents);
    return cfg;
  });
};
module.exports._patch = patch;
