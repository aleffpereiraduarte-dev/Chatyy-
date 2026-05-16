/**
 * Expo Config Plugin: Add Android packaging pickFirsts for duplicated META-INF
 *
 * The Apache httpcomponents jars (httpclient + httpcore) — brought in
 * transitively by some module — both pack `META-INF/DEPENDENCIES`. Without a
 * pickFirsts rule, `mergeReleaseJavaResource` errors out with:
 *
 *   2 files found with path 'META-INF/DEPENDENCIES'
 *
 * This plugin injects a `packaging { resources { pickFirsts += [...] } }`
 * block into `android/app/build.gradle` so the merge step picks one and moves
 * on. We pickFirst (instead of exclude) because httpclient + httpcore ship
 * different DEPENDENCIES manifests and skipping both would lose license info.
 *
 * Also covers LICENSE / NOTICE / INDEX.LIST / proguard / kotlin_module which
 * frequently duplicate across deps.
 *
 * Idempotent: re-running `expo prebuild` is safe — we no-op if the block is
 * already present.
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// [packaging-pickfirst v1]';

const PACKAGING_BLOCK = `
    ${MARKER}
    packaging {
        resources {
            pickFirsts += [
                'META-INF/DEPENDENCIES',
                'META-INF/LICENSE',
                'META-INF/LICENSE.txt',
                'META-INF/license.txt',
                'META-INF/NOTICE',
                'META-INF/NOTICE.txt',
                'META-INF/notice.txt',
                'META-INF/INDEX.LIST',
                'META-INF/io.netty.versions.properties',
                'META-INF/*.kotlin_module',
            ]
        }
    }
`;

function withAndroidPackagingPickFirst(config) {
  return withAppBuildGradle(config, (config) => {
    let contents = config.modResults.contents;

    if (contents.includes(MARKER)) {
      return config;
    }

    // Inject right after `android {` (the top-level block, not nested ones).
    // Use first match — that's reliably the app module's android {} block.
    contents = contents.replace(/^android\s*\{/m, (match) => `${match}\n${PACKAGING_BLOCK}`);

    config.modResults.contents = contents;
    return config;
  });
}

module.exports = withAndroidPackagingPickFirst;
