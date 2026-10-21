# [e2ee5 WP-08b] expo-callkit (CallkitE2ee.kt) chama a ponte E2EE nativa por reflexão
# (o expo-callkit não depende deste módulo no Gradle). Sem isto o R8 renomeia/remove os
# métodos *Json e a resposta pela notificação/bolha cairia no caminho "abrir o app".
-keep class expo.modules.chatyychatstore.E2eeNative { public *; }
-keep class expo.modules.chatyychatstore.E2eeNative$* { *; }
