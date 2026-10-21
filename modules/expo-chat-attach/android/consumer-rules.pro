# [2026-10-21 attach-android-armed] O composer nativo (modules/expo-chat-composer)
# chama AttachPlusHub.bridge("plus", …) por REFLEXÃO (Class.forName +
# getMethod("bridge")) para não criar dependência gradle entre módulos.
# Sem isto o R8 renomeia/remove a classe em release.
-keep class expo.modules.chatyyattach.AttachPlusHub { *; }
