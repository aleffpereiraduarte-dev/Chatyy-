# [e2ee5 WP-03] Módulo Expo do núcleo E2EE v5 (chatyy-crypto, Rust/UniFFI).
#
# Dois modos, decididos no `pod install`:
#   NÚCLEO  — ChatyyCryptoCore.xcframework + Generated/ChatyyCryptoCore.swift presentes
#             (instalados por native/chatyy-crypto/ci/fetch-prebuilt.sh ios modules/expo-chatyy-crypto,
#             passo do input `chatyy_crypto=true` do ios-build-local.yml — WP-02).
#             Compila com CHATYY_CRYPTO_CORE e linka o xcframework (staticlib).
#   STUB    — sem os artefatos (todo build normal): só o módulo Expo vazio (info().coreLinked=false,
#             toda chamada rejeita 'unsupported'). Zero bytes de Rust no binário.
# Forçar: CHATYY_CRYPTO_CORE=0 (stub mesmo com artefatos) / =1 (falha se faltarem).
require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

xcf = File.join(__dir__, 'ChatyyCryptoCore.xcframework')
gen = File.join(__dir__, 'Generated', 'ChatyyCryptoCore.swift')
have_core = File.directory?(xcf) && File.size?(gen)
force = (ENV['CHATYY_CRYPTO_CORE'] || '').strip
if force == '1' && !have_core
  raise '[expo-chatyy-crypto] CHATYY_CRYPTO_CORE=1 mas faltam ios/ChatyyCryptoCore.xcframework / ios/Generated/ChatyyCryptoCore.swift — rode native/chatyy-crypto/ci/fetch-prebuilt.sh ios modules/expo-chatyy-crypto'
end
use_core = have_core && force != '0'
Pod::UI.puts "[expo-chatyy-crypto] núcleo #{use_core ? 'LIGADO (xcframework)' : 'ausente → stub'}"

Pod::Spec.new do |s|
  s.name           = 'ExpoChatyyCrypto'
  s.version        = package['version']
  s.summary        = 'Chatyy E2EE v5 native host (chatyy-crypto core)'
  s.description    = 'Expo module + public Swift API (ChatyyCrypto.shared) over the chatyy-crypto Rust core (matrix-sdk-crypto/vodozemac via UniFFI): HTTP transport, App Group store, Keychain secrets.'
  s.author         = 'Chatyy'
  s.homepage       = 'https://chatyy.com.br'
  s.license        = { :type => 'Apache-2.0' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Foundation', 'Security'

  if use_core
    s.vendored_frameworks = 'ChatyyCryptoCore.xcframework'
    # Explícito: NÃO pegar os .h de dentro do xcframework como fonte (o módulo FFI
    # ChatyyCryptoCoreFFI vem do module.modulemap em Headers/ do xcframework).
    s.source_files = 'ChatyyCryptoModule.swift', 'ChatyyCryptoSupport.swift', 'ChatyyCryptoHost.swift',
                     'Generated/ChatyyCryptoCore.swift'
    s.preserve_paths = 'ChatyyCryptoCore.xcframework/**/*'
    s.pod_target_xcconfig = {
      'DEFINES_MODULE' => 'YES',
      'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => '$(inherited) CHATYY_CRYPTO_CORE',
      # Cópia dos Headers do slice certo feita pelo "[CP] Copy XCFrameworks" do CocoaPods.
      'SWIFT_INCLUDE_PATHS' => '$(inherited) "${PODS_XCFRAMEWORKS_BUILD_DIR}/ExpoChatyyCrypto/Headers"',
      'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_XCFRAMEWORKS_BUILD_DIR}/ExpoChatyyCrypto/Headers"',
    }
  else
    s.source_files = 'ChatyyCryptoModule.swift', 'ChatyyCryptoSupport.swift'
    s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  end
end
