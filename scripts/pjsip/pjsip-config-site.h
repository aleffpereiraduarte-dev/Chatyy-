/* ===========================================================================
 * pjsip-config-site.h — Chatyy PJSIP configuration
 *
 * Copied by scripts/pjsip/build-ios.sh into
 *   vendor/pjsip-src/pjlib/include/pj/config_site.h
 * before each configure-iphone run.
 *
 * Goals:
 *  - Opus 16 kHz mono, 20 kbps, FEC + DTX, 20 ms ptime (WhatsApp profile)
 *  - SILK 16 kHz mono fallback
 *  - PCMU mono last-resort
 *  - SRTP/SDES mandatory (no DTLS-SRTP at runtime — kept compiled in for fallback)
 *  - Video: H.264 Constrained Baseline 3.1, VideoToolbox path
 *  - ICE via pjnath, STUN + TURN (TURN_TP_TLS in prod)
 *  - CallKit owns AVAudioSession activation (no auto-open audio)
 *
 * See: docs/whatsapp-migration/01-pjsip-ios.md §5 (codec), §6 (SRTP), §9 (NAT)
 * =========================================================================== */
#ifndef CHATYY_PJSIP_CONFIG_SITE_H
#define CHATYY_PJSIP_CONFIG_SITE_H 1

/* ---------------- Platform shim ---------------- */
#define PJ_CONFIG_IPHONE 1
#include <pj/config_site_sample.h>

/* ---------------- Crypto / SSL ---------------- */
/* OpenSSL is mandatory — SDES requires AES_CM, sips: requires TLS transport. */
#define PJ_HAS_SSL_SOCK         1
#define PJSIP_HAS_TLS_TRANSPORT 1

/* Use OpenSSL (not Apple Network.framework / SecureTransport). */
#define PJ_SSL_SOCK_IMP         PJ_SSL_SOCK_IMP_OPENSSL
#define PJ_HAS_OPENSSL          1

/* ---------------- SRTP ---------------- */
#define PJMEDIA_HAS_SRTP                  1
/* Mandatory at the account level (set via pjsua_acc_config). Compiled in for
 * fallback paths if we ever need to interop with DTLS-SRTP peers. */
#define PJMEDIA_SRTP_HAS_DTLS             1
/* Use SHA1_80 / SHA1_32 only — matches WhatsApp + Telnyx + Kamailio profile. */
#define PJMEDIA_SRTP_HAS_AES_CM_256       0
#define PJMEDIA_SRTP_HAS_AES_GCM_128      0
#define PJMEDIA_SRTP_HAS_AES_GCM_256      0

/* ---------------- Codecs ---------------- */
/* Disable everything we don't ship to shrink the binary and avoid GPL-tainted
 * codecs creeping in via patch sets later. */
#define PJMEDIA_HAS_L16_CODEC             0
#define PJMEDIA_HAS_GSM_CODEC             0
#define PJMEDIA_HAS_SPEEX_CODEC           0
#define PJMEDIA_HAS_ILBC_CODEC            0
#define PJMEDIA_HAS_G7221_CODEC           0
#define PJMEDIA_HAS_G722_CODEC            0
#define PJMEDIA_HAS_G729_CODEC            0
#define PJMEDIA_HAS_BCG729                0
#define PJMEDIA_HAS_OPENCORE_AMRNB_CODEC  0
#define PJMEDIA_HAS_OPENCORE_AMRWB_CODEC  0

#define PJMEDIA_HAS_G711_CODEC            1   /* PCMU/PCMA last-resort */
#define PJMEDIA_HAS_OPUS_CODEC            1
#define PJMEDIA_HAS_SILK_CODEC            1

/* Opus defaults — overridden at runtime by codec-priorities.swift but we set
 * sane defaults in case PJSUA is bootstrapped before our shim runs. */
#define PJMEDIA_CODEC_OPUS_DEFAULT_SAMPLE_RATE      16000
#define PJMEDIA_CODEC_OPUS_DEFAULT_BIT_RATE         20000
#define PJMEDIA_CODEC_OPUS_DEFAULT_CHANNELS         1
#define PJMEDIA_CODEC_OPUS_DEFAULT_PTIME            20
#define PJMEDIA_CODEC_OPUS_DEFAULT_CBR              0
#define PJMEDIA_CODEC_OPUS_DEFAULT_PACKET_LOSS      10  /* % — feeds FEC */

/* SILK fallback config. */
#define PJMEDIA_CODEC_SILK_DEFAULT_QUALITY          10
#define PJMEDIA_CODEC_SILK_DEFAULT_COMPLEXITY       2

/* ---------------- Video ---------------- */
#define PJMEDIA_HAS_VIDEO                 1
#define PJMEDIA_HAS_FFMPEG                0   /* no LGPL/GPL contamination */
#define PJMEDIA_HAS_OPENH264_CODEC        0   /* swap-in custom VideoToolbox codec at runtime */
#define PJMEDIA_HAS_VID_TOOLBOX_CODEC     1   /* Apple HW codec — added in pjsip 2.13 */
#define PJMEDIA_HAS_VPX_CODEC             1   /* VP8 fallback */
#define PJMEDIA_VIDEO_DEV_HAS_DARWIN      1   /* AVFoundation capture */
#define PJMEDIA_VIDEO_DEV_HAS_IOS_OPENGL  1

/* ---------------- ICE / NAT ---------------- */
#define PJ_HAS_TCP                        1
#define PJ_NAT_TRAVERSAL                  1
#define PJMEDIA_ADVERTISE_RTCP            1
#define PJMEDIA_HAS_RTCP_XR               1

/* ---------------- AVAudioSession ownership ---------------- */
/* CRITICAL: CallKit MUST own AVAudioSession activation. PJSIP must NOT open
 * the audio unit on init — only when CXProvider didActivate fires. See plan §4.
 * Without this, you'll race CallKit and end up with silent calls.
 */
#define PJMEDIA_SND_DEV_NO_AUTO_OPEN_AUDIO 1
#define PJMEDIA_AUDIO_DEV_HAS_COREAUDIO    1
#define PJMEDIA_AUDIO_DEV_HAS_PORTAUDIO    0
#define PJMEDIA_AUDIO_DEV_HAS_OPENSL       0
#define PJMEDIA_AUDIO_DEV_HAS_WMME         0

/* Sample rates / clock — Opus prefers 48k internal even when wire is 16k. */
#define PJMEDIA_AUDIO_DEV_DEFAULT_CLOCK_RATE   48000
#define PJMEDIA_AUDIO_DEV_DEFAULT_PTIME         20
#define PJMEDIA_AUDIO_DEV_DEFAULT_CHANNEL_COUNT  1

/* AEC: use built-in webrtc AEC3 (we DO ship third_party/webrtc/AEC subset; it's
 * BSD-licensed, NOT the same as the full @livekit/react-native-webrtc binary). */
#define PJMEDIA_HAS_WEBRTC_AEC            1
#define PJMEDIA_HAS_SPEEX_AEC             0

/* ---------------- Threading / footprint ---------------- */
#define PJ_HAS_THREADS                    1
#define PJSIP_MAX_TSX_COUNT               1024
#define PJSIP_MAX_DIALOG_COUNT            512
#define PJSUA_MAX_CALLS                   4    /* mobile: max 1 active + 3 held */
#define PJSUA_MAX_ACC                     2    /* multi-account support */
#define PJSUA_MAX_BUDDIES                 0    /* presence not used */
#define PJSUA_MAX_PLAYERS                 4
#define PJSUA_MAX_RECORDERS               4
#define PJSUA_MAX_CONF_PORTS              16

/* ---------------- Logging ---------------- */
/* 3 in dev, 0 in release. PJSIP defines this at configure time; we override at
 * runtime via pj_log_set_level(0) in release. */
#define PJ_LOG_MAX_LEVEL                  3

/* ---------------- iOS-specific ---------------- */
/* Allow background audio (VoIP entitlement gates this). */
#define PJSIP_DONT_SWITCH_TO_TCP          0
#define PJ_IOS_HAS_MULTITASKING_SUPPORT   1

#endif /* CHATYY_PJSIP_CONFIG_SITE_H */
