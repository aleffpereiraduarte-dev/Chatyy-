# pjsip.pro — ProGuard / R8 consumer rules for the vendored PJSIP .aar
#
# Packaged into vendor/pjsip-android/pjsip-2.14.1.aar as proguard.txt and
# automatically applied to any app that depends on the .aar (Gradle picks up
# AAR-bundled consumer rules without further config).
#
# CRITICAL: every rule here is mandatory. R8 in full-mode (the default for
# AGP 8.x with `android.enableR8.fullMode=true`) will silently strip the
# SWIG-generated JNI entrypoints because they look like reflectively-named
# dead code (long swigCPtr fields, native methods reached only through
# System.loadLibrary). Without `-keep`, the first call to
# `Endpoint.libCreate()` throws `UnsatisfiedLinkError` in release builds.
#
# Background: docs/whatsapp-migration/02-pjsip-android.md §10.
# Pattern verified against the same R8 stripping behaviour we caught in the
# chatyy-ws-cpp SWIG experiments.

# ---- 1. SWIG-generated org.pjsip.pjsua2.* binding ----------------------------
# Keep EVERYTHING under org.pjsip.* — class names, fields (including the
# package-private `swigCPtr` longs that SWIG uses as native handles), methods,
# constructors. R8 cannot follow the JNI lookup, so we cannot let it shrink.
-keep class org.pjsip.** { *; }
-keepclassmembers class org.pjsip.** { *; }

# ---- 2. Native-method classes anywhere in the app ----------------------------
# Generic rule that protects any class declaring a `native` method from
# rename/remove (R8 will still rename the *class* even if it keeps the method,
# which breaks the JNI symbol lookup via Java_<class>_<method>).
-keepclasseswithmembernames class * { native <methods>; }
-keepclasseswithmembers,allowoptimization class * { native <methods>; }

# ---- 3. Our Kotlin bridge classes that JNI calls back into -------------------
# PJSIP's C code calls back into Java via JNIEnv->FindClass on these FQCNs.
# If R8 renames any of them the .so will look them up and crash at runtime.
-keep class expo.modules.pjsip.PjsipBridge { *; }
-keep class expo.modules.pjsip.PjsipBridge$Companion { *; }
-keep class expo.modules.pjsip.PjsipCallObserver { *; }
-keep class expo.modules.pjsip.PjsipAccountManager { *; }
-keep class expo.modules.pjsip.PjsipAudioRoute { *; }
-keep class expo.modules.pjsip.PjsipVideoCapturer { *; }
-keep class expo.modules.pjsip.events.** { *; }

# ---- 4. PJSUA2 callback subclasses (anonymous + inner) ----------------------
# When client code does `new Account() { @Override onRegState(...) }`, R8 may
# inline/erase the override. Keep the class hierarchy intact so PJSUA2's C++
# dispatcher can find the JNI vtable.
-keep class * extends org.pjsip.pjsua2.Account { *; }
-keep class * extends org.pjsip.pjsua2.Call { *; }
-keep class * extends org.pjsip.pjsua2.AudioMediaPlayer { *; }
-keep class * extends org.pjsip.pjsua2.AudioMediaRecorder { *; }
-keep class * extends org.pjsip.pjsua2.LogWriter { *; }
-keep class * extends org.pjsip.pjsua2.Endpoint { *; }

# ---- 5. SWIG director glue --------------------------------------------------
# Methods named `swig_*` are SWIG's director-callback plumbing.
-keepclassmembers class * {
    *** swig_*(...);
}

# ---- 6. Annotations & signatures --------------------------------------------
# Reflection-via-Signature is used by PJSUA2 for parameterised types and by
# our Kotlin coroutines bridging in PjsipBridge.kt.
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod
-keepattributes SourceFile, LineNumberTable
-renamesourcefileattribute SourceFile

# ---- 7. Don't warn about missing optional deps inside PJSIP -----------------
# PJSIP references some symbols only when video / OpenH264 / libwebrtc are
# linked; we strip those at C build time. Suppress the noise.
-dontwarn org.pjsip.**
-dontwarn org.webrtc.**

# ---- 8. JNI helper utility classes (PjsipBridge native side) ----------------
# These appear unused to R8 because their only callers are in C, but the .so
# does `FindClass("expo/modules/pjsip/jni/<X>")` at endpoint init.
-keep class expo.modules.pjsip.jni.** { *; }

# ---- 9. Keep enum values (PJSUA2 returns lots of enums by ordinal) ----------
-keepclassmembers enum org.pjsip.pjsua2.** {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}
