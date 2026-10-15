# [2026-10-15 screen-protect-all] Os outros módulos nativos (media viewer,
# story, editor, attach, callkit, screen-share) chamam o hub por REFLEXÃO
# (Class.forName + getMethod("bridge")) para não criar dependência gradle
# entre módulos. Sem isto o R8 renomeia/remove a classe em release.
-keep class expo.modules.chatyyprivacy.ScreenProtectHub { *; }
