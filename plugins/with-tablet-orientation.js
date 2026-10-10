/**
 * [2026-10-10 tablet-split] Rotação livre em iPad / tablet Android, celular
 * continua só retrato. app.json mantém "orientation": "portrait" (vale para
 * iPhone e para o Android por padrão); este plugin abre a exceção de tablet:
 *
 *  iOS: UISupportedInterfaceOrientations~ipad = as 4 orientações (o iPhone
 *       segue só retrato pela chave sem sufixo). Com UIRequiresFullScreen=false
 *       (já no app.json) o iPad também ganha Split View / Slide Over; o layout
 *       JS (lista + conversa) ativa pela largura da janela.
 *
 *  Android: MainActivity sem screenOrientation fixo no manifest ("unspecified")
 *       e trava em retrato NO CÓDIGO só quando smallestScreenWidthDp < 600
 *       (celular). Tablet / dobrável aberto gira livre. MainActivity já declara
 *       configChanges orientation|screenSize|smallestScreenSize → girar não
 *       recria a Activity (o RN só recebe as novas dimensões).
 *
 * Exige build nativo (prebuild). Sem este build o JS de duas colunas continua
 * funcionando: ativa sempre que a janela for larga o bastante.
 */
const {
  withInfoPlist,
  withAndroidManifest,
  withMainActivity,
  AndroidConfig,
} = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

const IPAD_ORIENTATIONS = [
  'UIInterfaceOrientationPortrait',
  'UIInterfaceOrientationPortraitUpsideDown',
  'UIInterfaceOrientationLandscapeLeft',
  'UIInterfaceOrientationLandscapeRight',
];

function withIpadOrientations(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults['UISupportedInterfaceOrientations~ipad'] = IPAD_ORIENTATIONS.slice();
    return cfg;
  });
}

function withUnlockedManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    const main = (app.activity || []).find((a) => a.$?.['android:name'] === '.MainActivity');
    if (main) main.$['android:screenOrientation'] = 'unspecified';
    return cfg;
  });
}

const KOTLIN_LOCK = [
  '    // [chatyy tablet-orientation] celular = só retrato; tablet gira livre',
  '    try {',
  '      if (resources.configuration.smallestScreenWidthDp < 600) {',
  '        requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT',
  '      }',
  '    } catch (_: Throwable) {}',
].join('\n');

function withPhonePortraitLock(config) {
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') return cfg; // template SDK 55 = Kotlin
    const src = cfg.modResults.contents;
    const anchor = /override fun onCreate\(savedInstanceState: Bundle\?\) \{/;
    if (!anchor.test(src)) return cfg;
    cfg.modResults.contents = mergeContents({
      tag: 'chatyy-tablet-orientation',
      src,
      newSrc: KOTLIN_LOCK,
      anchor,
      offset: 1,
      comment: '//',
    }).contents;
    return cfg;
  });
}

module.exports = function withTabletOrientation(config) {
  config = withIpadOrientations(config);
  config = withUnlockedManifest(config);
  config = withPhonePortraitLock(config);
  return config;
};
