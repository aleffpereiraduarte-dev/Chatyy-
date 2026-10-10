package expo.modules.callkit

// [2026-10-09 p2p-calls] Ligação 1:1 PEER-TO-PEER no Android nativo, usando o
// libwebrtc que o SDK LiveKit JÁ embute (livekit.org.webrtc) → zero aumento de
// binário. Mesmo protocolo do web (services/p2pCall.js) e do hub Go
// (/opt/chatyy-ws-go/p2p_signal.go):
//   call_p2p_ready (callee→caller) · call_p2p_offer (caller→callee)
//   call_p2p_answer (callee→caller) · call_p2p_candidate (ambos, lote)
//   call_p2p_restart (callee pede ICE restart) · call_p2p_fallback (→ LiveKit)
// Só o CALLER oferece (sem glare). Transceivers áudio+vídeo sempre presentes
// (ligar câmera = replaceTrack). Opus FEC+DTX; vídeo H264 hw > VP8; sem
// simulcast; GCC + teto por qualidade.
//
// AUTOCONTIDO e atrás da flag do servidor (`p2p.enabled` no
// chat_livekit_token / chat_call_invite_v2). Quem integra (CallActivity /
// NativeCallRoom) fornece `send` (frame WS via CallSignalWs) e chama
// `onSignal(frame)` para frames call_p2p_* recebidos; ver o plano no relatório.

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import android.util.Log
import livekit.org.webrtc.AudioTrack
import livekit.org.webrtc.Camera2Enumerator
import livekit.org.webrtc.CameraVideoCapturer
import livekit.org.webrtc.DataChannel
import livekit.org.webrtc.DefaultVideoDecoderFactory
import livekit.org.webrtc.DefaultVideoEncoderFactory
import livekit.org.webrtc.EglBase
import livekit.org.webrtc.IceCandidate
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.MediaStream
import livekit.org.webrtc.MediaStreamTrack
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.PeerConnectionFactory
import livekit.org.webrtc.RTCStatsReport
import livekit.org.webrtc.RtpParameters
import livekit.org.webrtc.RtpReceiver
import livekit.org.webrtc.RtpTransceiver
import livekit.org.webrtc.SdpObserver
import livekit.org.webrtc.SessionDescription
import livekit.org.webrtc.SurfaceTextureHelper
import livekit.org.webrtc.VideoSource
import livekit.org.webrtc.VideoTrack
import livekit.org.webrtc.audio.JavaAudioDeviceModule
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer

class P2PCallSession(
    private val appCtx: Context,
    val callId: String,
    val isCaller: Boolean,
    private val startWithVideo: Boolean,
    private val iceServers: List<PeerConnection.IceServer>,
    private val cfg: Config,
    private val send: (JSONObject) -> Unit,
    private val listener: Listener,
) {
    data class Config(
        val connectTimeoutMs: Long = 4000,
        val readyWaitMs: Long = 2500,
        val reconnectGraceMs: Long = 8000,
        val maxVideoKbps: Int = 1500,
        val maxAudioKbps: Int = 40,
        val allowTurn: Boolean = false,
    )

    interface Listener {
        fun onConnected(ms: Long) {}
        /** afterConnected=false → ainda no setup: quem chamou segue p/ o LiveKit. */
        fun onFallback(reason: String, afterConnected: Boolean) {}
        fun onReconnecting(on: Boolean) {}
        fun onRemoteVideo(track: VideoTrack?) {}
        fun onLocalVideo(track: VideoTrack?) {}
        fun onData(obj: JSONObject) {}
    }

    companion object {
        private const val TAG = "P2PCall"
        val TYPES = setOf(
            "call_p2p_ready", "call_p2p_offer", "call_p2p_answer",
            "call_p2p_candidate", "call_p2p_restart", "call_p2p_fallback",
        )

        @Volatile private var factory: PeerConnectionFactory? = null
        @Volatile private var egl: EglBase? = null
        private val sessions = HashMap<String, P2PCallSession>()

        fun isP2PType(t: String?): Boolean = t != null && TYPES.contains(t)

        fun get(callId: String?): P2PCallSession? = synchronized(sessions) { if (callId == null) null else sessions[callId] }

        /** null = P2P desligado p/ esta ligação. */
        fun parseConfig(p2p: JSONObject?): Config? {
            if (p2p == null || !p2p.optBoolean("enabled", false)) return null
            return Config(
                connectTimeoutMs = p2p.optLong("connect_timeout_ms", 4000).coerceIn(1500, 15000),
                readyWaitMs = p2p.optLong("ready_wait_ms", 2500).coerceIn(800, 8000),
                reconnectGraceMs = p2p.optLong("reconnect_grace_ms", 8000).coerceIn(3000, 30000),
                maxVideoKbps = p2p.optInt("max_video_kbps", 1500).coerceIn(150, 4000),
                maxAudioKbps = p2p.optInt("max_audio_kbps", 40).coerceIn(12, 96),
                allowTurn = p2p.optBoolean("turn", false),
            )
        }

        /**
         * iceServers do chat_livekit_token. Os coturns de produção só relayam p/ o
         * SFU (allowed-peer-ip) → sem `turn:true` usamos SÓ STUN (host/srflx).
         */
        fun iceServersFrom(arr: JSONArray?, allowTurn: Boolean): List<PeerConnection.IceServer> {
            val out = ArrayList<PeerConnection.IceServer>()
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    val urls = ArrayList<String>()
                    val u = o.opt("urls")
                    if (u is JSONArray) for (j in 0 until u.length()) urls.add(u.optString(j)) else if (u is String) urls.add(u)
                    val keep = urls.filter { it.isNotBlank() && (allowTurn || it.startsWith("stun:", ignoreCase = true)) }
                    if (keep.isEmpty()) continue
                    val b = PeerConnection.IceServer.builder(keep)
                    val user = o.optString("username", "")
                    val cred = o.optString("credential", "")
                    if (allowTurn && user.isNotEmpty()) b.setUsername(user).setPassword(cred)
                    out.add(b.createIceServer())
                }
            }
            if (out.isEmpty()) {
                out.add(PeerConnection.IceServer.builder(listOf("stun:147.93.12.236:3478", "stun:turn.chatyy.com.br:3478")).createIceServer())
            }
            return out
        }

        /** Entrada dos frames call_p2p_* (CallSignalWs). Antes da sessão existir → buffer. */
        private val buffer = HashMap<String, MutableList<Pair<Long, JSONObject>>>()

        fun dispatchSignal(frame: JSONObject) {
            val id = frame.optString("call_id", "")
            if (id.isEmpty()) return
            val s = get(id)
            if (s != null) { s.onSignal(frame); return }
            synchronized(buffer) {
                val now = System.currentTimeMillis()
                val list = buffer.getOrPut(id) { ArrayList() }
                list.removeAll { now - it.first > 45_000 }
                if (list.size < 80) list.add(now to frame)
                if (buffer.size > 20) buffer.entries.removeAll { e -> e.value.isEmpty() || now - e.value.last().first > 45_000 }
            }
        }

        fun eglBase(): EglBase? = egl

        /** [2026-10-10 p2p-android] Garante a factory e devolve o EglBase com
         *  que os SurfaceViewRenderer precisam ser inicializados (texturas do
         *  decoder P2P vivem neste contexto). null = libwebrtc indisponível. */
        fun eglFor(ctx: Context): EglBase? = try { ensureFactory(ctx); egl } catch (t: Throwable) {
            Log.w(TAG, "eglFor: ${t.message}"); null
        }

        /** Qualquer sessão viva (Telecom mute/hold não sabe o callId). */
        fun active(): P2PCallSession? = synchronized(sessions) { sessions.values.firstOrNull { !it.done } }

        /** O callee já mandou call_p2p_ready (= atendeu) antes da sessão do caller existir. */
        fun peerReadyBuffered(callId: String?): Boolean {
            if (callId.isNullOrEmpty()) return false
            return synchronized(buffer) { buffer[callId]?.any { it.second.optString("type") == "call_p2p_ready" } == true }
        }

        private fun ensureFactory(ctx: Context): PeerConnectionFactory {
            factory?.let { return it }
            synchronized(this) {
                factory?.let { return it }
                // [2026-10-10 p2p-android] O .so do libwebrtc do LiveKit chama-se
                // "lkjingle_peerconnection_so" (RTCModule.libWebrtcInitialization).
                // Com o nome padrão ("jingle_peerconnection_so") o load falha quando
                // o P2P inicializa ANTES de qualquer Room (caller) → UnsatisfiedLinkError.
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(ctx.applicationContext)
                        .setNativeLibraryName("lkjingle_peerconnection_so")
                        .createInitializationOptions()
                )
                val e = EglBase.create()
                egl = e
                val adm = JavaAudioDeviceModule.builder(ctx.applicationContext)
                    .setUseHardwareAcousticEchoCanceler(true)
                    .setUseHardwareNoiseSuppressor(true)
                    .createAudioDeviceModule()
                val f = PeerConnectionFactory.builder()
                    .setAudioDeviceModule(adm)
                    .setVideoEncoderFactory(DefaultVideoEncoderFactory(e.eglBaseContext, true, true))
                    .setVideoDecoderFactory(DefaultVideoDecoderFactory(e.eglBaseContext))
                    .createPeerConnectionFactory()
                factory = f
                return f
            }
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private var pc: PeerConnection? = null
    private var audioTx: RtpTransceiver? = null
    private var videoTx: RtpTransceiver? = null
    private var dc: DataChannel? = null
    private var localAudio: AudioTrack? = null
    private var localVideo: VideoTrack? = null
    private var videoSource: VideoSource? = null
    private var capturer: CameraVideoCapturer? = null
    private var texHelper: SurfaceTextureHelper? = null
    private var frontCamera = true

    @Volatile var state: String = "new"; private set
    @Volatile private var done = false
    private var gen = 0
    private var remoteGen = -1
    private val t0 = System.currentTimeMillis()
    var connectedAt = 0L; private set
    private var gotReady = false
    private var haveRemote = false
    private val pendingCands = ArrayList<JSONObject>()
    private val outCands = ArrayList<JSONObject>()
    private var outScheduled = false
    private var discRunnable: Runnable? = null
    private var graceRunnable: Runnable? = null
    private var netCb: ConnectivityManager.NetworkCallback? = null
    private var lastNet: Network? = null
    private var lastQ = "good"
    private val timers = ArrayList<Runnable>()

    private fun later(ms: Long, r: () -> Unit): Runnable {
        val run = Runnable { if (!done) r() }
        timers.add(run)
        main.postDelayed(run, ms)
        return run
    }

    private fun log(evt: String, info: String = "") {
        Log.i(TAG, "[$callId] $evt $info")
        // [2026-10-09] NativeCallRoom.postDiag não é acessível daqui (quebrou o build) — só Log.
    }

    private fun sendFrame(type: String, extra: JSONObject.() -> Unit = {}) {
        val o = JSONObject()
        o.put("type", type)
        o.put("call_id", callId)
        o.put("gen", gen)
        o.extra()
        try { send(o) } catch (t: Throwable) { Log.w(TAG, "send $type failed: ${t.message}") }
    }

    // ── ciclo de vida ──
    fun start() {
        synchronized(sessions) {
            sessions[callId]?.let { if (it !== this) it.close("replaced") }
            sessions[callId] = this
        }
        val buffered: List<JSONObject> = synchronized(buffer) {
            val now = System.currentTimeMillis()
            (buffer.remove(callId) ?: emptyList<Pair<Long, JSONObject>>()).filter { now - it.first < 45_000 }.map { it.second }
        }
        main.post {
            try {
                createMediaAndPc()
                log("start", "video=$startWithVideo ice=${iceServers.size}")
                buffered.forEach { onSignalMain(it) }
                if (isCaller) {
                    if (!gotReady) {
                        later(cfg.readyWaitMs) { if (!gotReady && state == "new") fallback("peer_not_ready") }
                    } else {
                        beginOffer()
                    }
                } else {
                    later(cfg.connectTimeoutMs + 500) { if (state != "connected") fallback("connect_timeout") }
                    sendReady(0)
                }
                watchNetwork()
            } catch (t: Throwable) {
                log("start_err", t.message ?: "")
                fallback("start_error")
            }
        }
    }

    private fun sendReady(n: Int) {
        if (done || haveRemote || n > 6) return
        sendFrame("call_p2p_ready")
        later(600) { sendReady(n + 1) }
    }

    private fun beginOffer() {
        if (state != "new") return
        state = "negotiating"
        later(cfg.connectTimeoutMs) { if (state != "connected") fallback("connect_timeout") }
        makeOffer(false)
    }

    private fun createMediaAndPc() {
        val f = ensureFactory(appCtx)
        val ac = MediaConstraints()
        ac.optional.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
        ac.optional.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
        ac.optional.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
        localAudio = f.createAudioTrack("p2pa0", f.createAudioSource(ac))
        if (startWithVideo) startCamera(f)

        val rtc = PeerConnection.RTCConfiguration(iceServers)
        rtc.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        rtc.bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
        rtc.rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
        rtc.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        rtc.iceTransportsType = PeerConnection.IceTransportsType.ALL
        val p = f.createPeerConnection(rtc, observer) ?: throw IllegalStateException("createPeerConnection null")
        pc = p
        if (isCaller) {
            val streams = listOf("p2p0")
            audioTx = p.addTransceiver(localAudio, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV, streams))
            videoTx = if (localVideo != null) {
                p.addTransceiver(localVideo, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV, streams))
            } else {
                p.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV, streams))
            }
            preferVideoCodecs(f, videoTx)
            dc = p.createDataChannel("chatyy", DataChannel.Init().apply { ordered = true })
            dc?.registerObserver(dcObserver)
        }
    }

    private fun preferVideoCodecs(f: PeerConnectionFactory, tx: RtpTransceiver?) {
        if (tx == null) return
        try {
            val caps = f.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO) ?: return
            val order = listOf("H264", "VP8", "VP9")
            val sorted = caps.codecs.sortedBy { c -> order.indexOf(c.name.uppercase()).let { if (it < 0) order.size else it } }
            tx.setCodecPreferences(sorted)
        } catch (t: Throwable) { Log.w(TAG, "codec prefs: ${t.message}") }
    }

    private fun startCamera(f: PeerConnectionFactory): VideoTrack? {
        val en = Camera2Enumerator(appCtx)
        val name = en.deviceNames.firstOrNull { if (frontCamera) en.isFrontFacing(it) else en.isBackFacing(it) }
            ?: en.deviceNames.firstOrNull() ?: return null
        val cap = en.createCapturer(name, null) ?: return null
        val helper = SurfaceTextureHelper.create("p2pcap", egl!!.eglBaseContext)
        val src = f.createVideoSource(false)
        cap.initialize(helper, appCtx, src.capturerObserver)
        cap.startCapture(1280, 720, 30)
        capturer = cap; texHelper = helper; videoSource = src
        val vt = f.createVideoTrack("p2pv0", src)
        localVideo = vt
        listener.onLocalVideo(vt)
        return vt
    }

    private fun stopCamera() {
        try { capturer?.stopCapture() } catch (_: Throwable) {}
        try { capturer?.dispose() } catch (_: Throwable) {}
        try { localVideo?.dispose() } catch (_: Throwable) {}
        try { videoSource?.dispose() } catch (_: Throwable) {}
        try { texHelper?.dispose() } catch (_: Throwable) {}
        capturer = null; localVideo = null; videoSource = null; texHelper = null
    }

    // ── SDP ──
    private fun mungeOpus(sdp: String): String {
        val m = Regex("a=rtpmap:(\\d+) opus/48000", RegexOption.IGNORE_CASE).find(sdp) ?: return sdp
        val pt = m.groupValues[1]
        val want = linkedMapOf("useinbandfec" to "1", "usedtx" to "1", "maxaveragebitrate" to (cfg.maxAudioKbps * 1000).toString(), "stereo" to "0")
        val re = Regex("a=fmtp:$pt ([^\\r\\n]*)")
        val f = re.find(sdp)
        return if (f != null) {
            val kv = LinkedHashMap<String, String>()
            f.groupValues[1].split(';').forEach { p -> val i = p.indexOf('='); if (i > 0) kv[p.substring(0, i).trim()] = p.substring(i + 1).trim() }
            want.forEach { (k, v) -> if (!kv.containsKey(k)) kv[k] = v }
            sdp.replace(f.value, "a=fmtp:$pt " + kv.entries.joinToString(";") { "${it.key}=${it.value}" })
        } else {
            sdp.replace(m.value, m.value + "\r\na=fmtp:$pt " + want.entries.joinToString(";") { "${it.key}=${it.value}" })
        }
    }

    private open inner class SdpAdapter(val tag: String) : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription?) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(err: String?) { main.post { log("sdp_create_fail", "$tag $err") } }
        override fun onSetFailure(err: String?) { main.post { log("sdp_set_fail", "$tag $err") } }
    }

    private fun makeOffer(iceRestart: Boolean) {
        val p = pc ?: return
        gen += 1
        val myGen = gen
        val mc = MediaConstraints()
        if (iceRestart) mc.mandatory.add(MediaConstraints.KeyValuePair("IceRestart", "true"))
        p.createOffer(object : SdpAdapter("offer") {
            override fun onCreateSuccess(desc: SessionDescription?) {
                if (desc == null) return
                val sdp = mungeOpus(desc.description)
                main.post {
                    val pp = pc ?: return@post
                    pp.setLocalDescription(object : SdpAdapter("setLocalOffer") {
                        override fun onSetSuccess() {
                            main.post {
                                if (done || myGen != gen) return@post
                                sendFrame("call_p2p_offer") { put("sdp", sdp); put("video", startWithVideo) }
                                log("offer_sent", "gen=$myGen restart=$iceRestart")
                            }
                        }
                    }, SessionDescription(SessionDescription.Type.OFFER, sdp))
                }
            }
        }, mc)
    }

    /** Frame call_p2p_* recebido (qualquer thread). */
    fun onSignal(frame: JSONObject) { main.post { onSignalMain(frame) } }

    private fun onSignalMain(msg: JSONObject) {
        if (done) return
        when (msg.optString("type")) {
            "call_p2p_ready" -> {
                if (!isCaller) return
                if (connectedAt > 0 && state != "connected") { restartIce("peer_ready_again"); return }
                if (!gotReady) { gotReady = true; if (pc != null) beginOffer() }
            }
            "call_p2p_fallback" -> fallback("peer_" + msg.optString("reason", "fallback"), fromPeer = true)
            "call_p2p_restart" -> if (isCaller) restartIce("peer_request")
            "call_p2p_offer" -> if (!isCaller) handleOffer(msg)
            "call_p2p_answer" -> if (isCaller) handleAnswer(msg)
            "call_p2p_candidate" -> {
                val arr = msg.optJSONArray("candidates") ?: return
                for (i in 0 until arr.length()) {
                    val c = arr.optJSONObject(i) ?: continue
                    if (!haveRemote) pendingCands.add(c) else addCand(c)
                }
            }
        }
    }

    private fun handleOffer(msg: JSONObject) {
        val p = pc ?: return
        val g = msg.optInt("gen", remoteGen + 1)
        if (g <= remoteGen) return
        remoteGen = g
        val sdp = msg.optString("sdp", "")
        if (sdp.isEmpty()) return
        p.setRemoteDescription(object : SdpAdapter("setRemoteOffer") {
            override fun onSetSuccess() {
                main.post {
                    if (done) return@post
                    haveRemote = true
                    if (audioTx == null) {
                        for (tx in p.transceivers) {
                            when (tx.mediaType) {
                                MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO -> if (audioTx == null) audioTx = tx
                                MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO -> if (videoTx == null) videoTx = tx
                                else -> {}
                            }
                        }
                        try {
                            audioTx?.direction = RtpTransceiver.RtpTransceiverDirection.SEND_RECV
                            audioTx?.sender?.setTrack(localAudio, false)
                            audioTx?.sender?.setStreams(listOf("p2p0"))
                            videoTx?.direction = RtpTransceiver.RtpTransceiverDirection.SEND_RECV
                            localVideo?.let { videoTx?.sender?.setTrack(it, false) }
                        } catch (t: Throwable) { log("attach_err", t.message ?: "") }
                        factory?.let { preferVideoCodecs(it, videoTx) }
                    }
                    p.createAnswer(object : SdpAdapter("answer") {
                        override fun onCreateSuccess(desc: SessionDescription?) {
                            if (desc == null) return
                            val ans = mungeOpus(desc.description)
                            main.post {
                                p.setLocalDescription(object : SdpAdapter("setLocalAnswer") {
                                    override fun onSetSuccess() {
                                        main.post {
                                            if (done) return@post
                                            gen = remoteGen
                                            sendFrame("call_p2p_answer") { put("sdp", ans) }
                                            flushCands()
                                        }
                                    }
                                }, SessionDescription(SessionDescription.Type.ANSWER, ans))
                            }
                        }
                    }, MediaConstraints())
                }
            }
        }, SessionDescription(SessionDescription.Type.OFFER, sdp))
    }

    private fun handleAnswer(msg: JSONObject) {
        val p = pc ?: return
        if (msg.has("gen") && msg.optInt("gen") != gen) return
        if (p.signalingState() != PeerConnection.SignalingState.HAVE_LOCAL_OFFER) return
        val sdp = msg.optString("sdp", "")
        if (sdp.isEmpty()) return
        p.setRemoteDescription(object : SdpAdapter("setRemoteAnswer") {
            override fun onSetSuccess() { main.post { haveRemote = true; flushCands() } }
        }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
    }

    private fun addCand(c: JSONObject) {
        val s = c.optString("candidate", "")
        if (s.isEmpty()) return
        try { pc?.addIceCandidate(IceCandidate(c.optString("sdpMid", "0"), c.optInt("sdpMLineIndex", 0), s)) } catch (_: Throwable) {}
    }

    private fun flushCands() {
        val l = ArrayList(pendingCands); pendingCands.clear()
        l.forEach { addCand(it) }
    }

    // ── observadores ──
    private val observer = object : PeerConnection.Observer {
        override fun onSignalingChange(s: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(s: PeerConnection.IceConnectionState?) { main.post { onConnState() } }
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) { main.post { onConnState() } }
        override fun onIceConnectionReceivingChange(b: Boolean) {}
        override fun onIceGatheringChange(s: PeerConnection.IceGatheringState?) {}
        override fun onIceCandidate(c: IceCandidate?) {
            if (c == null) return
            main.post {
                outCands.add(JSONObject().put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex))
                if (!outScheduled) {
                    outScheduled = true
                    main.postDelayed({
                        outScheduled = false
                        while (outCands.isNotEmpty() && !done) {
                            val batch = JSONArray()
                            val n = minOf(24, outCands.size)
                            repeat(n) { batch.put(outCands.removeAt(0)) }
                            sendFrame("call_p2p_candidate") { put("candidates", batch) }
                        }
                    }, 40)
                }
            }
        }
        override fun onIceCandidatesRemoved(c: Array<out IceCandidate>?) {}
        override fun onAddStream(s: MediaStream?) {}
        override fun onRemoveStream(s: MediaStream?) {}
        override fun onDataChannel(d: DataChannel?) {
            if (d == null) return
            main.post { if (dc == null) { dc = d; d.registerObserver(dcObserver) } }
        }
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(r: RtpReceiver?, s: Array<out MediaStream>?) {}
        override fun onTrack(t: RtpTransceiver?) {
            val tr = t?.receiver?.track() ?: return
            if (tr is VideoTrack) main.post { if (!done) listener.onRemoteVideo(tr) }
        }
    }

    private val dcObserver = object : DataChannel.Observer {
        override fun onBufferedAmountChange(p: Long) {}
        override fun onStateChange() {}
        override fun onMessage(buf: DataChannel.Buffer?) {
            if (buf == null || buf.binary) return
            try {
                val bytes = ByteArray(buf.data.remaining()); buf.data.get(bytes)
                val o = JSONObject(String(bytes, Charsets.UTF_8))
                main.post { if (!done) listener.onData(o) }
            } catch (_: Throwable) {}
        }
    }

    fun sendData(obj: JSONObject): Boolean {
        val d = dc ?: return false
        if (d.state() != DataChannel.State.OPEN) return false
        return try { d.send(DataChannel.Buffer(ByteBuffer.wrap(obj.toString().toByteArray(Charsets.UTF_8)), false)) } catch (_: Throwable) { false }
    }

    private fun isUp(): Boolean {
        val p = pc ?: return false
        return p.connectionState() == PeerConnection.PeerConnectionState.CONNECTED
    }

    private fun onConnState() {
        val p = pc ?: return
        if (done) return
        val cs = p.connectionState()
        if (isUp()) {
            discRunnable?.let { main.removeCallbacks(it) }; discRunnable = null
            graceRunnable?.let { main.removeCallbacks(it) }; graceRunnable = null
            if (state != "connected") {
                val wasRe = state == "reconnecting"
                state = "connected"
                if (connectedAt == 0L) {
                    connectedAt = System.currentTimeMillis()
                    applySenderParams()
                    startQualityLoop()
                    log("connected", "ms=${connectedAt - t0}")
                    listener.onConnected(connectedAt - t0)
                } else if (wasRe) {
                    log("reconnected")
                    listener.onReconnecting(false)
                }
            }
            return
        }
        if (state != "connected" && state != "reconnecting") return
        if (cs == PeerConnection.PeerConnectionState.FAILED) beginRecovery(0)
        else if (cs == PeerConnection.PeerConnectionState.DISCONNECTED) beginRecovery(1500)
    }

    private fun beginRecovery(delayMs: Long) {
        if (state == "connected") { state = "reconnecting"; listener.onReconnecting(true) }
        if (graceRunnable == null) graceRunnable = later(cfg.reconnectGraceMs) { if (!isUp()) fallback("ice_lost") }
        if (discRunnable != null) return
        discRunnable = later(delayMs) { discRunnable = null; if (!isUp()) restartIce("ice_${pc?.iceConnectionState()}") }
    }

    fun restartIce(reason: String) {
        if (done || pc == null) return
        log("ice_restart", reason)
        if (isCaller) makeOffer(true) else sendFrame("call_p2p_restart") { put("reason", reason.take(40)) }
    }

    private fun watchNetwork() {
        try {
            val cm = appCtx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            lastNet = cm.activeNetwork
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    main.post {
                        val prev = lastNet
                        lastNet = network
                        if (prev != null && prev != network && connectedAt > 0 && !done) restartIce("network_change")
                    }
                }
            }
            cm.registerDefaultNetworkCallback(cb)
            netCb = cb
        } catch (_: Throwable) {}
    }

    private fun applySenderParams() {
        fun set(tx: RtpTransceiver?, bps: Int, video: Boolean) {
            try {
                val s = tx?.sender ?: return
                val p = s.parameters
                if (p.encodings.isEmpty()) return
                p.encodings[0].maxBitrateBps = bps
                if (video) p.degradationPreference = RtpParameters.DegradationPreference.BALANCED
                s.parameters = p
            } catch (t: Throwable) { Log.w(TAG, "sender params: ${t.message}") }
        }
        set(audioTx, cfg.maxAudioKbps * 1000, false)
        set(videoTx, cfg.maxVideoKbps * 1000, true)
    }

    private fun startQualityLoop() {
        later(2000) {
            stats { rtt, loss ->
                val q = when { loss >= 10.0 || rtt >= 600 -> "poor"; loss >= 4.0 || rtt >= 300 -> "medium"; else -> "good" }
                if (q != lastQ) {
                    lastQ = q
                    try {
                        val s = videoTx?.sender
                        if (s != null) {
                            val p = s.parameters
                            if (p.encodings.isNotEmpty()) {
                                val f = when (q) { "poor" -> 0.25; "medium" -> 0.55; else -> 1.0 }
                                p.encodings[0].maxBitrateBps = (cfg.maxVideoKbps * 1000 * f).toInt()
                                p.encodings[0].scaleResolutionDownBy = if (q == "poor") 2.0 else 1.0
                                s.parameters = p
                            }
                        }
                    } catch (_: Throwable) {}
                }
                startQualityLoop()
            }
        }
    }

    /** RTT (ms) e perda de áudio (%) do par selecionado. */
    fun stats(cb: (rttMs: Int, lossPct: Double) -> Unit) {
        val p = pc ?: return
        p.getStats { report: RTCStatsReport ->
            var rtt = -1
            var lost = 0L
            var rec = 0L
            val map = report.statsMap
            for (s in map.values) {
                val m = s.members
                if (s.type == "candidate-pair" && (m["nominated"] == true) && m["state"] == "succeeded") {
                    val r = m["currentRoundTripTime"]
                    if (r is Double) rtt = (r * 1000).toInt()
                }
                if (s.type == "inbound-rtp" && m["kind"] == "audio") {
                    lost += (m["packetsLost"] as? Number)?.toLong() ?: 0L
                    rec += (m["packetsReceived"] as? Number)?.toLong() ?: 0L
                }
            }
            val loss = if (rec + lost > 0) lost * 100.0 / (rec + lost) else 0.0
            main.post { if (!done) cb(rtt, loss) }
        }
    }

    // ── controles ──
    fun setMicEnabled(on: Boolean) { try { localAudio?.setEnabled(on) } catch (_: Throwable) {} }

    fun setCameraEnabled(on: Boolean) {
        main.post {
            if (done) return@post
            if (!on) {
                try { videoTx?.sender?.setTrack(null, false) } catch (_: Throwable) {}
                stopCamera()
                listener.onLocalVideo(null)
                return@post
            }
            val f = factory ?: return@post
            val vt = startCamera(f) ?: return@post
            try { videoTx?.sender?.setTrack(vt, false) } catch (_: Throwable) {}
            applySenderParams()
        }
    }

    fun switchCamera() {
        try { capturer?.switchCamera(null); frontCamera = !frontCamera } catch (_: Throwable) {}
    }

    fun fallback(reason: String, fromPeer: Boolean = false) {
        if (done) return
        val after = connectedAt > 0
        log("fallback", "reason=$reason peer=$fromPeer after=$after ms=${System.currentTimeMillis() - t0}")
        if (!fromPeer) sendFrame("call_p2p_fallback") { put("reason", reason.take(40)) }
        teardown()
        state = "fallback"
        listener.onFallback(reason, after)
    }

    fun close(reason: String) {
        if (done) return
        log("close", reason)
        teardown()
        state = "closed"
    }

    private fun teardown() {
        done = true
        synchronized(sessions) { if (sessions[callId] === this) sessions.remove(callId) }
        timers.forEach { main.removeCallbacks(it) }; timers.clear()
        try { netCb?.let { (appCtx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)?.unregisterNetworkCallback(it) } } catch (_: Throwable) {}
        netCb = null
        try { dc?.unregisterObserver(); dc?.close() } catch (_: Throwable) {}
        dc = null
        try { pc?.close() } catch (_: Throwable) {}
        try { pc?.dispose() } catch (_: Throwable) {}
        pc = null
        stopCamera()
        try { localAudio?.dispose() } catch (_: Throwable) {}
        localAudio = null
        listener.onRemoteVideo(null)
    }
}
