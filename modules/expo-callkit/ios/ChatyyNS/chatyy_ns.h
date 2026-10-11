// [2026-10-11 noise] Chatyy noise suppressor — tiny C API over RNNoise
// (Xiph/Mozilla, BSD-3, vendored v0.1.1 in ./rnnoise, see rnnoise/COPYING).
//
// Shared by iOS (Swift → LiveKit AudioManager.capturePostProcessingDelegate)
// and Android (JNI → LiveKit AudioProcessorInterface). This is the ONLY public
// header of the ExpoCallKit pod — keep it plain C, no macros, no includes, so
// it is safe inside the pod's umbrella header / Swift underlying module.
//
// Audio contract (both platforms hand us WebRTC APM's capture AudioBuffer,
// channel 0, AFTER WebRTC's own AEC/NS/AGC):
//   * mono float samples in int16 scale ("FloatS16", ±32768) — exactly what
//     RNNoise expects, no rescaling;
//   * one call = 10 ms. RNNoise is fixed at 48 kHz / 480-sample frames, so
//     frames == 480 is denoised in place; ANY other size (16/32 kHz APM rate,
//     e.g. Bluetooth HFP) is passed through untouched (WebRTC NS still runs).
//
// Failure-safe: every entry point tolerates NULL; a non-finite output restores
// the input frame and resets the model; concurrent callers on the same
// instance never block — the loser passes through.

#ifndef CHATYY_NS_H
#define CHATYY_NS_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ChatyyNS ChatyyNS;

/// Allocates a suppressor (call off the audio thread). NULL on failure.
ChatyyNS *chatyy_ns_create(void);

/// Frees a suppressor. Caller guarantees no concurrent process() on it.
void chatyy_ns_destroy(ChatyyNS *ns);

/// Clears the model state (sample-rate change / new stream). Serialized with
/// process() by WebRTC's APM on both platforms.
void chatyy_ns_reset(ChatyyNS *ns);

/// In-place on `frames` mono FloatS16 samples (10 ms). Returns 1 if the frame
/// was denoised, 0 if it was passed through (disabled / not 48 kHz / busy).
int chatyy_ns_process(ChatyyNS *ns, float *samples, int frames);

/// Process-wide on/off switch (atomic, any thread). Default ON.
void chatyy_ns_set_enabled(int enabled);
int chatyy_ns_is_enabled(void);

#ifdef __cplusplus
}
#endif

#endif /* CHATYY_NS_H */
