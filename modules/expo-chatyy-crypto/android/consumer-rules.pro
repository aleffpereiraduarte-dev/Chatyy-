# [e2ee5 WP-03] UniFFI chama libchatyy_crypto.so por JNA (reflexão sobre Structure/Callback).
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.** { public *; }
-dontwarn java.awt.**
# Bindings geradas (Structure com campos lidos por reflexão, callbacks do HttpTransport).
-keep class com.chatyy.crypto.core.** { *; }
-keep class expo.modules.chatyycrypto.** { *; }
