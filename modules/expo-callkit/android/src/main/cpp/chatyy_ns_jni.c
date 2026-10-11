// [2026-10-11 noise] JNI bridge for expo.modules.callkit.audio.RNNoiseProcessor.
// The LiveKit Android capture post-processor hands us a DIRECT ByteBuffer that
// wraps WebRTC APM's channel-0 float memory (webrtc-sdk m144
// external_audio_processor.cc: Process(num_bands, num_frames, 160*num_bands,
// audio->channels()[0]) → NewDirectByteBuffer(ptr, n*sizeof(float))). We
// denoise that memory in place: no copies, no allocation, no Java arrays.
#include <jni.h>
#include <stdint.h>
#include "chatyy_ns.h"

JNIEXPORT jlong JNICALL
Java_expo_modules_callkit_audio_RNNoiseProcessor_nativeCreate(JNIEnv *env, jclass clazz) {
  (void)env; (void)clazz;
  return (jlong)(intptr_t)chatyy_ns_create();
}

JNIEXPORT void JNICALL
Java_expo_modules_callkit_audio_RNNoiseProcessor_nativeReset(JNIEnv *env, jclass clazz, jlong handle) {
  (void)env; (void)clazz;
  chatyy_ns_reset((ChatyyNS *)(intptr_t)handle);
}

JNIEXPORT jint JNICALL
Java_expo_modules_callkit_audio_RNNoiseProcessor_nativeProcess(JNIEnv *env, jclass clazz, jlong handle,
                                                               jobject buffer, jint numFrames) {
  (void)clazz;
  if (!handle || !buffer || numFrames <= 0) return 0;
  float *data = (float *)(*env)->GetDirectBufferAddress(env, buffer);
  jlong cap = (*env)->GetDirectBufferCapacity(env, buffer);
  if (!data || cap < (jlong)numFrames * (jlong)sizeof(float)) return 0; /* not direct / too small → pass-through */
  return chatyy_ns_process((ChatyyNS *)(intptr_t)handle, data, numFrames);
}

JNIEXPORT void JNICALL
Java_expo_modules_callkit_audio_RNNoiseProcessor_nativeSetEnabled(JNIEnv *env, jclass clazz, jboolean enabled) {
  (void)env; (void)clazz;
  chatyy_ns_set_enabled(enabled ? 1 : 0);
}
