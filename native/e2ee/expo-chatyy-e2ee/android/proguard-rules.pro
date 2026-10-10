# [E2EE v4 nativo] UniFFI chama a .so via JNA (reflexão sobre Structure/Callback).
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.** { public *; }
-dontwarn java.awt.**
-keep class expo.modules.chatyye2ee.core.** { *; }
-keep class expo.modules.chatyye2ee.ChatyyE2EEModule { *; }
