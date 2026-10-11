// [2026-10-11 noise] Chatyy noise suppressor — RNNoise amalgamation + safe
// frame wrapper. See chatyy_ns.h for the audio contract.
//
// Build: this is the ONLY translation unit that compiles RNNoise. The vendored
// sources in ./rnnoise (xiph/rnnoise tag v0.1.1, commit 6cbfd53, BSD-3 —
// rnnoise/COPYING; rnnoise.h copied next to them so every quote-include
// resolves relative to the including file) are #included below and are NOT
// listed as separate sources (podspec preserve_paths / Android CMake). The
// default model (rnn_data.c) is compiled in — no model file at runtime.
//
// Symbol hygiene: RNNoise's globals (`common`, `compute_rnn`, `rnn_*`,
// `rnnoise_*`) are renamed to `chatyy_ns__*` so they can never collide with a
// libopus/rnnoise statically linked by another pod (iOS links everything into
// one binary).

#include <math.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#define common                    chatyy_ns__common
#define compute_rnn               chatyy_ns__compute_rnn
#define rnn_autocorr              chatyy_ns__rnn_autocorr
#define rnn_fft_alloc             chatyy_ns__rnn_fft_alloc
#define rnn_fft_alloc_arch_c      chatyy_ns__rnn_fft_alloc_arch_c
#define rnn_fft_alloc_twiddles    chatyy_ns__rnn_fft_alloc_twiddles
#define rnn_fft_c                 chatyy_ns__rnn_fft_c
#define rnn_fft_free              chatyy_ns__rnn_fft_free
#define rnn_fft_free_arch_c       chatyy_ns__rnn_fft_free_arch_c
#define rnn_fft_impl              chatyy_ns__rnn_fft_impl
#define rnn_ifft_c                chatyy_ns__rnn_ifft_c
#define rnn_lpc                   chatyy_ns__rnn_lpc
#define rnn_pitch_downsample      chatyy_ns__rnn_pitch_downsample
#define rnn_pitch_search          chatyy_ns__rnn_pitch_search
#define rnn_pitch_xcorr           chatyy_ns__rnn_pitch_xcorr
#define rnn_remove_doubling       chatyy_ns__rnn_remove_doubling
#define rnnoise_create            chatyy_ns__rnnoise_create
#define rnnoise_destroy           chatyy_ns__rnnoise_destroy
#define rnnoise_get_frame_size    chatyy_ns__rnnoise_get_frame_size
#define rnnoise_get_size          chatyy_ns__rnnoise_get_size
#define rnnoise_init              chatyy_ns__rnnoise_init
#define rnnoise_model_orig        chatyy_ns__rnnoise_model_orig
#define rnnoise_process_frame     chatyy_ns__rnnoise_process_frame
#define rnnoise_model_from_file   chatyy_ns__rnnoise_model_from_file
#define rnnoise_model_free        chatyy_ns__rnnoise_model_free

#include "rnnoise/denoise.c"
#include "rnnoise/rnn.c"
#include "rnnoise/rnn_data.c"
#include "rnnoise/pitch.c"
#include "rnnoise/kiss_fft.c"
#include "rnnoise/celt_lpc.c"

#include "chatyy_ns.h"

#define CHATYY_NS_FRAME 480 /* 10 ms @ 48 kHz — RNNoise's fixed frame */

struct ChatyyNS {
  DenoiseState *st;
  atomic_int busy;               /* try-lock: never block the audio thread */
  float in[CHATYY_NS_FRAME];     /* copy of the raw frame (RNNoise reads in, writes out) */
};

static atomic_int g_enabled = 1;

/* RNNoise lazily builds global tables (`common`: FFT twiddles, DCT, window)
 * on the first processed frame, without any locking. Do it ONCE here, off the
 * audio thread (create() is called from UI/module setup), so the realtime path
 * never mallocs and two instances can't race the init. */
static atomic_int g_warm = 0;
static void chatyy_ns_warm_up(void) {
  if (atomic_load(&g_warm)) return;
  DenoiseState *tmp = rnnoise_create(NULL);
  if (!tmp) return;
  float buf[CHATYY_NS_FRAME];
  memset(buf, 0, sizeof(buf));
  rnnoise_process_frame(tmp, buf, buf);
  rnnoise_destroy(tmp);
  atomic_store(&g_warm, 1);
}

ChatyyNS *chatyy_ns_create(void) {
  chatyy_ns_warm_up();
  ChatyyNS *ns = (ChatyyNS *)calloc(1, sizeof(ChatyyNS));
  if (!ns) return NULL;
  ns->st = rnnoise_create(NULL);
  if (!ns->st || !ns->st->rnn.vad_gru_state || !ns->st->rnn.noise_gru_state ||
      !ns->st->rnn.denoise_gru_state) {
    if (ns->st) rnnoise_destroy(ns->st);
    free(ns);
    return NULL;
  }
  atomic_init(&ns->busy, 0);
  return ns;
}

void chatyy_ns_destroy(ChatyyNS *ns) {
  if (!ns) return;
  if (ns->st) rnnoise_destroy(ns->st);
  free(ns);
}

/* Zero the recurrent + analysis state in place (no malloc → audio-thread safe). */
static void chatyy_ns_clear_state(DenoiseState *st) {
  const RNNModel *model = st->rnn.model;
  float *vad = st->rnn.vad_gru_state;
  float *noise = st->rnn.noise_gru_state;
  float *den = st->rnn.denoise_gru_state;
  memset(st, 0, sizeof(*st));
  st->rnn.model = model;
  st->rnn.vad_gru_state = vad;
  st->rnn.noise_gru_state = noise;
  st->rnn.denoise_gru_state = den;
  if (vad) memset(vad, 0, sizeof(float) * (size_t)model->vad_gru_size);
  if (noise) memset(noise, 0, sizeof(float) * (size_t)model->noise_gru_size);
  if (den) memset(den, 0, sizeof(float) * (size_t)model->denoise_gru_size);
}

void chatyy_ns_reset(ChatyyNS *ns) {
  if (!ns || !ns->st) return;
  int expected = 0;
  if (!atomic_compare_exchange_strong(&ns->busy, &expected, 1)) return;
  chatyy_ns_clear_state(ns->st);
  atomic_store(&ns->busy, 0);
}

int chatyy_ns_process(ChatyyNS *ns, float *samples, int frames) {
  if (!ns || !ns->st || !samples) return 0;
  if (frames != CHATYY_NS_FRAME) return 0;        /* not 48 kHz → pass-through */
  if (!atomic_load_explicit(&g_enabled, memory_order_relaxed)) return 0;
  if (!atomic_load(&g_warm)) return 0;            /* tables not ready → never init on audio thread */
  int expected = 0;
  if (!atomic_compare_exchange_strong(&ns->busy, &expected, 1)) return 0;

  memcpy(ns->in, samples, sizeof(ns->in));
  rnnoise_process_frame(ns->st, samples, ns->in);

  /* Fail-safe: a NaN/Inf (corrupt state, pathological input) must never reach
   * the encoder — restore the raw frame and start the model fresh. */
  int ok = 1;
  for (int i = 0; i < CHATYY_NS_FRAME; i++) {
    if (!isfinite(samples[i])) { ok = 0; break; }
  }
  if (!ok) {
    memcpy(samples, ns->in, sizeof(ns->in));
    chatyy_ns_clear_state(ns->st);
  }
  atomic_store(&ns->busy, 0);
  return ok;
}

void chatyy_ns_set_enabled(int enabled) {
  atomic_store(&g_enabled, enabled ? 1 : 0);
}

int chatyy_ns_is_enabled(void) {
  return atomic_load(&g_enabled);
}
