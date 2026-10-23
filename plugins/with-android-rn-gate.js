// [2026-10-23 push-rapido item 4] Processo que nasce por um push (FCM com o app morto) não espera o
// React Native subir: o MainApplication passa a chamar expo.modules.callkit.ChatyyRnGate.install()
// NO LUGAR de `loadReactNative(this)` + `ApplicationLifecycleDispatcher.onApplicationCreate(this)`.
//   - Aberto para uma Activity (launcher/notificação) → carrega na hora, igual antes (só mede).
//   - Nascido em 2º plano (push/receiver/job) → adia; carrega sob demanda antes de qualquer uso do RN
//     (este plugin põe ChatyyRnGate.ensure() no `reactHost` lazy e no
//     MainActivity.createReactActivityDelegate, que roda no construtor da Activity) ou em 2º plano logo
//     depois do push tratado. Detalhes e kill switches: modules/expo-callkit/.../ChatyyRnGate.kt.
//
// Se o template mudar e os pontos de patch não forem achados, o plugin NÃO aplica nada (aviso no
// prebuild) → app idêntico ao de antes. Nada a fazer no JS.
const { withMainApplication, withMainActivity } = require('@expo/config-plugins');

const MARK = '[chatyy rn-gate]';
const RE_LOAD = /^([ \t]*)loadReactNative\(this\)[ \t]*\r?\n[ \t]*ApplicationLifecycleDispatcher\.onApplicationCreate\(this\)[ \t]*$/m;
const RE_HOST = /(override val reactHost: ReactHost by lazy \{[ \t]*\r?\n)/;
const RE_DELEGATE = /(override fun createReactActivityDelegate\(\): ReactActivityDelegate \{[ \t]*\r?\n)/;

function patchApplication(src) {
  if (src.includes(MARK)) return { src, ok: true };
  if (!RE_LOAD.test(src) || !RE_HOST.test(src)) return { src, ok: false };
  let out = src.replace(RE_LOAD, (m, ind) =>
    `${ind}// ${MARK} push a frio não espera o RN: carrega já (Activity) ou adia (push/receiver/job).\n` +
    `${ind}expo.modules.callkit.ChatyyRnGate.install(\n` +
    `${ind}  this,\n` +
    `${ind}  Runnable { loadReactNative(this) },\n` +
    `${ind}  Runnable { ApplicationLifecycleDispatcher.onApplicationCreate(this) }\n` +
    `${ind})`);
  out = out.replace(RE_HOST, (m) =>
    m + `    // ${MARK} qualquer uso do ReactHost (Activity, HeadlessJS, expo-task-manager) carrega o RN antes.\n` +
        `    expo.modules.callkit.ChatyyRnGate.ensure("react_host")\n`);
  return { src: out, ok: true };
}

function patchActivity(src) {
  if (src.includes(MARK)) return { src, ok: true };
  if (!RE_DELEGATE.test(src)) return { src, ok: false };
  return {
    src: src.replace(RE_DELEGATE, (m) =>
      m + `    // ${MARK} roda no construtor da ReactActivity: RN pronto antes do delegate.\n` +
          `    expo.modules.callkit.ChatyyRnGate.ensure("main_activity")\n`),
    ok: true,
  };
}

module.exports = function withAndroidRnGate(config) {
  config = withMainApplication(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      console.warn('[with-android-rn-gate] MainApplication não é Kotlin — gate do RN NÃO aplicado');
      return cfg;
    }
    const r = patchApplication(cfg.modResults.contents);
    if (!r.ok) {
      console.warn('[with-android-rn-gate] pontos de patch não achados no MainApplication — gate do RN NÃO aplicado');
      return cfg;
    }
    cfg.modResults.contents = r.src;
    return cfg;
  });
  // Independente do MainApplication (a ordem dos mods não é garantida): sem install() o ensure()
  // é inócuo. Sem este gancho o gate continua seguro (onActivityPreCreated carrega o RN antes do
  // onCreate; o construtor do ReactActivity/delegate não usa libs nativas) — só avisa.
  config = withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') return cfg;
    const r = patchActivity(cfg.modResults.contents);
    if (!r.ok) {
      console.warn('[with-android-rn-gate] createReactActivityDelegate não encontrado no MainActivity — sem gancho no construtor');
      return cfg;
    }
    cfg.modResults.contents = r.src;
    return cfg;
  });
  return config;
};
module.exports._patchApplication = patchApplication;
module.exports._patchActivity = patchActivity;
