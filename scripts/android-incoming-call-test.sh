#!/usr/bin/env bash
# [2026-10-06 android-incoming] Teste em device das correções de ligação
# recebida no Android (expo-callkit). Roda no Mac/PC com o Android plugado
# (adb) — NÃO no servidor.
#
# Uso:
#   scripts/android-incoming-call-test.sh            # logcat filtrado + checklist
#   scripts/android-incoming-call-test.sh telecom    # dumpsys telecom (zumbi RINGING/ACTIVE?)
#   scripts/android-incoming-call-test.sh codec      # qual codec/simulcast o device vai usar
#
# Tags relevantes (todas em -s, o resto fica silencioso):
TAGS="CallTrace:I CallFCMService:D CallSignalWs:D IncomingCallRegistry:D CallRingingService:D \
IncomingCallActivity:D CallActivity:D ChatyyConnSvc:I ChatyyConn:I NativeCallRoom:D \
LkTokenFetcher:D ExpoCallKit:D CallActionReceiver:D ActivityTaskManager:W"

set -euo pipefail
ADB="${ADB:-adb}"
PKG="${PKG:-com.onemundo.mail}"

case "${1:-logcat}" in
  telecom)
    # Zumbi = linha "Connection" em estado RINGING/ACTIVE SEM chamada em curso.
    echo "== dumpsys telecom (procurar ChatyyConnectionService / self-managed) =="
    "$ADB" shell dumpsys telecom | grep -iE "chatyy|self.?managed|RINGING|ACTIVE|DISCONNECT" | head -60
    exit 0
    ;;
  codec)
    echo "== Encoders AVC (H264) de hardware no device =="
    "$ADB" shell "dumpsys media.codec 2>/dev/null | grep -iE 'avc|h264' | grep -i encoder" || true
    echo "(no logcat, procure: NativeCallRoom: [camera] preferredVideoCodec=h264|vp8)"
    exit 0
    ;;
esac

cat <<'EOF'
================= CHECKLIST (duarte iOS → suporte Android) =================
Preparação: `adb logcat -c` já foi rodado. Deixe este terminal aberto.

CENÁRIO A — app ABERTO no Android (tela ligada, destravada):
  iPhone liga. Esperado no logcat, nesta ordem:
    CallFCMService : Incoming call from ... callId=X
    IncomingCallRegistry: markInviteSeen X source=fcm: new
    CallRingingService: Starting ringing for callId=X ... alreadyRinging=false
    IncomingCallRegistry: launchRingingUi X src=fcm: IncomingCallActivity started directly
    CallTrace: [6b/12] foreground ring surface launched
    ExpoCallKit : addNewIncomingCall dispatched: callId=X
    ChatyyConnSvc: onCreateIncomingConnection: callId=X
    IncomingCallRegistry: registerConnection X (live=1)
  Se o 2º push/WS duplicado chegar:
    CallFCMService : incoming_call callId=X: duplicate FCM — skipping      (ou)
    CallSignalWs   : call_invite X: already ringing via FCM — skipping WS ring
    ExpoCallKit    : startTelecomIncomingCall: callId=X already handed to Telecom — skipping duplicate
  Tela de chamada NATIVA deve aparecer POR CIMA do app. Tocar "Atender":
    ChatyyConn     : answerFromUi: callId=X state=2 → setActive()      (2 = RINGING)
    CallTrace      : [7c/12] IncomingCallActivity accept: ...→ CallActivity ...
    CallTrace      : [8a/12] CallActivity.onCreate callId=X ...
    CallActivity   : closeReceiver: ignoring CLOSE aimed at the ringer ... (se o JS chamar notifyAppReady)
  FALHA se: "[8a/12]" não aparecer, ou aparecer e logo depois "finishCall reason=close_broadcast".

CENÁRIO B — Android TRAVADO/tela apagada (path antigo, não pode regredir):
  Esperado: FSI do sistema abre IncomingCallActivity; logcat mostra
    IncomingCallRegistry: launchRingingUi X src=fcm: app not foreground — FSI/notification owns the surface
  e o resto igual ao A.

CENÁRIO C — Recusar / deixar tocar 45s / iPhone cancela antes:
    ChatyyConn: endFromUi: callId=X cause=... reason=declined|ring_timeout|ws_call_end:...|fcm_call_cancel:...
    IncomingCallRegistry: unregisterConnection X (live=0)
  Depois: `scripts/android-incoming-call-test.sh telecom` NÃO pode listar Connection RINGING/ACTIVE.

CENÁRIO D — atender DEPOIS de ~35s tocando (token):
    LkTokenFetcher: fetchToken: cache hit for X   ← antes expirava em 30s e ia pro HTTP lento
  FALHA se aparecer "getCached: stale entry" com age < 60000ms.

CENÁRIO E — desligar da tela de chamada:
    CallActivity: finishCall reason=...
    ChatyyConn  : endFromUi: callId=X cause=... reason=call_activity:...
  dumpsys telecom limpo.

CENÁRIO F — CÂMERA (Android liga vídeo, iPhone tem que ver):
  1ª vez: diálogo de permissão CAMERA aparece ANTES de qualquer publish:
    CallActivity: [camera] toggle ON without CAMERA grant — requesting ...   (ou "LK connected but CAMERA not granted yet")
    CallActivity: onRequestPermissionsResult CAMERA: granted=true
    NativeCallRoom: [camera] preferredVideoCodec=h264 simulcast=false  (ou vp8 simulcast=true em device sem encoder HW)
    CallActivity: [camera] published OK origin=toggle|connect|late-grant|upgrade sid=TR_...
    CallTrace   : [10/12] local camera published ...
  FALHA se: "[camera] publish FAILED" (botão volta p/ OFF + "Câmera indisponível" na tela) → mandar esse log.
  iPhone ligando a câmera → Android deve mostrar:
    CallTrace: [11/12] remote video subscribed callId=X ... rendererReady=true

CENÁRIO G — atender pelo fone Bluetooth / relógio (Telecom):
    ChatyyConn    : onAnswer: callId=X — flipping to ACTIVE
    NativeCallRoom: [launch-decision] adoptForCall(warm|cold) → CallActivity
    CallTrace     : [8a/12] CallActivity.onCreate ...
=============================================================================
EOF

"$ADB" logcat -c || true
exec "$ADB" logcat -v time -s $TAGS
