/*
 * pjsua-android-config.h
 *
 * Dropped in as pjlib/include/pj/config_site.h by scripts/pjsip/build-android.sh
 * before configure-android. Tunes PJSIP for the Chatyy call engine. Mirrors
 * scripts/pjsip/pjsua-ios-config.h (Agent 6) so iOS and Android ship with the
 * same codec set and the same MOS targets.
 *
 * Sources:
 *  - docs/whatsapp-migration/02-pjsip-android.md  §3 (audio) and §4 (video)
 *  - PJSIP 2.14 release notes: AAudio backend in pjmedia-aud-android
 *
 * Re-generated automatically — DO NOT hand-edit the copy under
 * vendor/pjsip-android/build/src/pjproject-*. Edit THIS file and re-run
 * scripts/pjsip/build-android.sh.
 */

#ifndef __PJ_CONFIG_SITE_ANDROID_H__
#define __PJ_CONFIG_SITE_ANDROID_H__

/* -----------------------------------------------------------------------
 * Platform marker
 * --------------------------------------------------------------------- */
#define PJ_CONFIG_ANDROID                   1
#define PJ_ANDROID                          1

/* -----------------------------------------------------------------------
 * Audio framework selection
 *
 * Strategy: AAudio is the high-performance Android 8+ audio API and is the
 * only one that hits the <20 ms RTT WhatsApp parity bar referenced in the
 * iOS plan §4. OpenSL ES is the fallback for API < 26 (we still permit
 * minSdk=24 per build-android.config to cover legacy testers).
 *
 * Runtime selection happens in PjsipAudioRoute.kt by reading
 * Build.VERSION.SDK_INT — but the C build must compile BOTH backends, hence
 * we enable both and let the AudDevManager enumerate them.
 * --------------------------------------------------------------------- */
#define PJMEDIA_AUDIO_DEV_HAS_AAUDIO         1   /* AAudio (API 26+) */
#define PJMEDIA_AUDIO_DEV_HAS_OPENSL         1   /* OpenSL ES fallback */
#define PJMEDIA_AUDIO_DEV_HAS_PORTAUDIO      0
#define PJMEDIA_AUDIO_DEV_HAS_ALSA           0

/* AAudio shared-mode + LowLatency perf hint. EXCLUSIVE mode caused glitches
 * on Pixel 6/7 in WhatsApp engineering blog post — stay shared. */
#define PJMEDIA_AAUDIO_PREFER_SHARED         1
#define PJMEDIA_AAUDIO_PERF_LOW_LATENCY      1

/* 20 ms frame ptime — matches Opus FEC default packing. Lower (10 ms) ups
 * CPU 1.6× for marginal MOS gain; higher (40 ms) hurts jitter recovery. */
#define PJSUA_DEFAULT_AUDIO_FRAME_PTIME      20

/* -----------------------------------------------------------------------
 * Codec configuration  (priority is 0–255; higher wins)
 *
 * Opus 16 kHz mono @ 32 kbps + FEC ON + DTX OFF is the WhatsApp/Signal
 * canonical voice config (see iOS plan §4). SILK 16 kHz is fallback for
 * peers that don't negotiate Opus (rare but happens with legacy SIP edges).
 * PCMU stays for absolute lowest-common-denominator interop only.
 *
 * G.711a/G.722/G.7221/GSM/iLBC/Speex disabled at configure time
 * (--disable-*-codec in build-android.config) so they aren't even linked.
 * --------------------------------------------------------------------- */
#define PJMEDIA_CODEC_PRIO_OPUS              255
#define PJMEDIA_CODEC_PRIO_SILK_WB           128   /* 16 kHz */
#define PJMEDIA_CODEC_PRIO_SILK_NB           0
#define PJMEDIA_CODEC_PRIO_PCMU              64
#define PJMEDIA_CODEC_PRIO_PCMA              0     /* explicitly disabled */
#define PJMEDIA_CODEC_PRIO_G722              0
#define PJMEDIA_CODEC_PRIO_GSM               0
#define PJMEDIA_CODEC_PRIO_ILBC              0

/* Opus tunables — must match iOS to avoid asymmetric MOS reports. */
#define PJMEDIA_CODEC_OPUS_DEFAULT_SAMPLE_RATE       16000
#define PJMEDIA_CODEC_OPUS_DEFAULT_CHANNEL_COUNT     1
#define PJMEDIA_CODEC_OPUS_DEFAULT_BIT_RATE          32000
#define PJMEDIA_CODEC_OPUS_DEFAULT_PACKET_LOSS       10    /* % FEC */
#define PJMEDIA_CODEC_OPUS_DEFAULT_CBR               0
#define PJMEDIA_CODEC_OPUS_DEFAULT_DTX               0     /* OFF — avoids
                                                              comfort-noise
                                                              robot artefacts */

/* -----------------------------------------------------------------------
 * Echo cancellation / noise suppression
 *
 * Per docs §3: prefer hardware AEC (AcousticEchoCanceler) at runtime; fall
 * back to WebRTC AEC3 (statically linked). Speex AEC explicitly off — it
 * smears 16 kHz speech and is the cause of the legacy chipmunk effect.
 * --------------------------------------------------------------------- */
#define PJMEDIA_HAS_SPEEX_AEC                0
#define PJMEDIA_HAS_WEBRTC_AEC               1
#define PJMEDIA_HAS_WEBRTC_AEC3              1
#define PJMEDIA_ECHO_DEFAULT_AEC_FLAG        PJMEDIA_ECHO_WEBRTC_AEC3
#define PJMEDIA_ECHO_DEFAULT_TAIL_MS         200

/* -----------------------------------------------------------------------
 * Video — keep PJSIP video stack compiled but CameraX path is wired in
 * Kotlin (PjsipVideoCapturer.kt). VP8 software default; H.264 picked when
 * MediaCodec exposes hw encoder (see §4).
 * --------------------------------------------------------------------- */
#define PJMEDIA_HAS_VIDEO                    1
#define PJMEDIA_HAS_VID_TOOLBOX_CODEC        0   /* iOS-only */
#define PJMEDIA_HAS_ANDROID_MEDIACODEC       1
#define PJMEDIA_HAS_VPX_CODEC                1

#define PJMEDIA_VIDEO_DEV_HAS_ANDROID        1   /* default Camera1 */
#define PJMEDIA_VIDEO_DEV_HAS_ANDROID_CAMERA2 1  /* prefer Camera2/CameraX */

/* -----------------------------------------------------------------------
 * SIP transport
 * --------------------------------------------------------------------- */
#define PJSIP_HAS_TLS_TRANSPORT              1
#define PJSIP_TLS_KEEP_ALIVE_INTERVAL        30
#define PJSIP_TCP_KEEP_ALIVE_INTERVAL        30

/* IP address change handling — needed for WiFi↔LTE mid-call (§7). */
#define PJSUA_HAS_IP_CHANGE                  1

/* -----------------------------------------------------------------------
 * Footprint trimming — drop features we don't use, save ~600 KB per .so.
 * --------------------------------------------------------------------- */
#define PJSIP_MAX_DIALOG_COUNT               16
#define PJSIP_MAX_TSX_COUNT                  32
#define PJSUA_MAX_ACC                        4
#define PJSUA_MAX_CALLS                      8
#define PJSUA_MAX_CONF_PORTS                 16

/* Disable presence / IM / file xfer — out of scope for call engine. */
#define PJSUA_HAS_PRESENCE                   0
#define PJSUA_HAS_IM                         0

/* -----------------------------------------------------------------------
 * Pull PJSIP's stock defaults AFTER our overrides.
 * --------------------------------------------------------------------- */
#include <pj/config_site_sample.h>

#endif /* __PJ_CONFIG_SITE_ANDROID_H__ */
