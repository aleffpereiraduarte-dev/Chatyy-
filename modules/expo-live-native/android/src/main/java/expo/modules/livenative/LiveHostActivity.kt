package expo.modules.livenative

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.Icon
import androidx.compose.material.IconButton
import androidx.compose.material.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * Full-screen Activity that hosts a Live broadcast. Mounted by
 * [ExpoLiveNativeModule.openHost]. All UI is Compose.
 *
 * Lifecycle:
 *   - onCreate → check CAMERA+MIC perms → if granted: connect; else: ask.
 *   - onDestroy → LiveRoomConnection.disconnect()
 */
class LiveHostActivity : ComponentActivity() {

    companion object {
        private const val TAG = "LiveHostActivity"

        const val EXTRA_TOKEN = "token"
        const val EXTRA_URL = "url"
        const val EXTRA_ROOM_NAME = "roomName"
        const val EXTRA_HOST_NAME = "hostName"
    }

    private var token: String = ""
    private var url: String = ""
    private var roomName: String = ""
    private var hostName: String = ""

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { granted ->
        val ok = granted[Manifest.permission.CAMERA] == true &&
                 granted[Manifest.permission.RECORD_AUDIO] == true
        if (ok) {
            startSession()
        } else {
            Log.w(TAG, "permissions denied — ending live")
            LiveRoomConnection.onError?.invoke("Camera or microphone permission denied")
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        token = intent.getStringExtra(EXTRA_TOKEN).orEmpty()
        url = intent.getStringExtra(EXTRA_URL).orEmpty()
        roomName = intent.getStringExtra(EXTRA_ROOM_NAME).orEmpty()
        hostName = intent.getStringExtra(EXTRA_HOST_NAME).orEmpty()

        if (token.isEmpty() || url.isEmpty()) {
            Log.e(TAG, "missing token/url — aborting")
            LiveRoomConnection.onError?.invoke("Missing LiveKit credentials")
            finish()
            return
        }

        // Full-screen edge-to-edge; keep screen on while broadcasting.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        setContent { HostScreen() }

        if (hasMediaPermissions()) {
            startSession()
        } else {
            permissionLauncher.launch(arrayOf(
                Manifest.permission.CAMERA,
                Manifest.permission.RECORD_AUDIO
            ))
        }
    }

    private fun hasMediaPermissions(): Boolean {
        val cam = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
        val mic = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
        return cam == PackageManager.PERMISSION_GRANTED &&
               mic == PackageManager.PERMISSION_GRANTED
    }

    private fun startSession() {
        lifecycleScope.launch {
            LiveRoomConnection.connectAsHost(
                appContext = applicationContext,
                url = url,
                token = token
            )
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        // Tear down — module's onEnded callback will fire and JS will pop the screen.
        if (LiveRoomConnection.currentMode() == LiveRoomConnection.Mode.HOST) {
            LiveRoomConnection.disconnect()
        }
    }

    // ---------------- Compose UI ----------------

    @Composable
    private fun HostScreen() {
        val state by LiveRoomConnection.state.collectAsState()
        val localVideo by LiveRoomConnection.localVideo.collectAsState()
        val participants by LiveRoomConnection.participantCount.collectAsState()
        val micOn by LiveRoomConnection.isMicEnabled.collectAsState()
        val cameraOn by LiveRoomConnection.isCameraEnabled.collectAsState()

        val hearts = remember { HeartsState() }

        // Fake heart trigger so the placeholder Canvas overlay is wired up.
        // The real path is RoomEvent.DataReceived → onLikeReceived → JS event.
        LaunchedEffect(Unit) {
            // no-op for scaffold
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black)
        ) {
            // --- Camera preview (background) ---
            if (localVideo != null) {
                LiveVideoTrackView(
                    track = localVideo!!,
                    mirror = true,
                    modifier = Modifier.fillMaxSize()
                )
            } else {
                Box(
                    modifier = Modifier.fillMaxSize().background(Color(0xFF111111)),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = when (state) {
                            LiveRoomConnection.ConnectionState.CONNECTING -> "Conectando..."
                            LiveRoomConnection.ConnectionState.RECONNECTING -> "Reconectando..."
                            LiveRoomConnection.ConnectionState.FAILED -> "Falha na conexão"
                            else -> "Iniciando câmera..."
                        },
                        color = Color.White,
                        fontSize = 16.sp
                    )
                }
            }

            // --- Hearts overlay placeholder ---
            HeartsOverlay(state = hearts, modifier = Modifier.fillMaxSize())

            // --- Top bar ---
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .statusBarsPadding()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    modifier = Modifier
                        .background(Color(0xFFE53935), RoundedCornerShape(4.dp))
                        .padding(horizontal = 8.dp, vertical = 4.dp)
                ) {
                    Text("AO VIVO", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                }
                Spacer(modifier = Modifier.width(10.dp))
                Column {
                    Text(
                        text = hostName.ifEmpty { "Live" },
                        color = Color.White,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(
                        text = "$participants espectadores",
                        color = Color.White.copy(alpha = 0.8f),
                        fontSize = 12.sp
                    )
                }
                Spacer(modifier = Modifier.weight(1f))
                IconButton(onClick = { endLive() }) {
                    Icon(
                        imageVector = Icons.Filled.Close,
                        contentDescription = "Encerrar",
                        tint = Color.White
                    )
                }
            }

            // --- Chat placeholder ---
            Box(
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(start = 16.dp, bottom = 110.dp)
                    .background(Color.Black.copy(alpha = 0.45f), RoundedCornerShape(8.dp))
                    .padding(horizontal = 10.dp, vertical = 6.dp)
            ) {
                Text(
                    text = "Chat carregado em JS",
                    color = Color.White.copy(alpha = 0.85f),
                    fontSize = 12.sp
                )
            }

            // --- Bottom controls ---
            Row(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp, vertical = 28.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                CircleControlButton(
                    icon = Icons.Filled.Cameraswitch,
                    contentDescription = "Trocar câmera",
                    onClick = { LiveRoomConnection.switchCamera() }
                )
                CircleControlButton(
                    icon = if (micOn) Icons.Filled.Mic else Icons.Filled.MicOff,
                    contentDescription = if (micOn) "Silenciar" else "Reativar microfone",
                    onClick = { LiveRoomConnection.toggleMic() },
                    background = if (micOn) Color.White.copy(alpha = 0.15f) else Color(0xFFE53935)
                )
                CircleControlButton(
                    icon = Icons.Filled.Stop,
                    contentDescription = "Encerrar live",
                    onClick = { endLive() },
                    background = Color(0xFFE53935),
                    big = true
                )
            }
        }
    }

    private fun endLive() {
        LiveRoomConnection.disconnect()
        finish()
    }

    @Composable
    private fun CircleControlButton(
        icon: androidx.compose.ui.graphics.vector.ImageVector,
        contentDescription: String,
        onClick: () -> Unit,
        background: Color = Color.White.copy(alpha = 0.15f),
        big: Boolean = false
    ) {
        val sizeDp = if (big) 66.dp else 54.dp
        Box(
            modifier = Modifier
                .size(sizeDp)
                .background(background, CircleShape),
            contentAlignment = Alignment.Center
        ) {
            IconButton(onClick = onClick) {
                Icon(icon, contentDescription = contentDescription, tint = Color.White)
            }
        }
    }
}
