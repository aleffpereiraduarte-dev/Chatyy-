package expo.modules.livenative

import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.Icon
import androidx.compose.material.IconButton
import androidx.compose.material.Text
import androidx.compose.material.TextField
import androidx.compose.material.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * Subscribe-only viewer Activity. Mounted by [ExpoLiveNativeModule.openViewer].
 * Renders the first remote video track full-screen and a heart column on the
 * right edge; comment input + share button on the bottom strip.
 *
 * Comments + reactions still go through the JS chat for v1 — this Activity
 * only shows a placeholder strip so layout stays correct. The "Send heart"
 * button publishes a `like` data payload to the room as a smoke test.
 */
class LiveViewerActivity : ComponentActivity() {

    companion object {
        private const val TAG = "LiveViewerActivity"

        const val EXTRA_TOKEN = "token"
        const val EXTRA_URL = "url"
        const val EXTRA_ROOM_NAME = "roomName"
        const val EXTRA_HOST_NAME = "hostName"
        const val EXTRA_HOST_AVATAR = "hostAvatarUrl"
        const val EXTRA_VIEWER_COUNT = "viewerCount"
    }

    private var token: String = ""
    private var url: String = ""
    private var roomName: String = ""
    private var hostName: String = ""
    private var hostAvatarUrl: String = ""
    private var initialViewerCount: Int = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        token = intent.getStringExtra(EXTRA_TOKEN).orEmpty()
        url = intent.getStringExtra(EXTRA_URL).orEmpty()
        roomName = intent.getStringExtra(EXTRA_ROOM_NAME).orEmpty()
        hostName = intent.getStringExtra(EXTRA_HOST_NAME).orEmpty()
        hostAvatarUrl = intent.getStringExtra(EXTRA_HOST_AVATAR).orEmpty()
        initialViewerCount = intent.getIntExtra(EXTRA_VIEWER_COUNT, 0)

        if (token.isEmpty() || url.isEmpty()) {
            Log.e(TAG, "missing token/url — aborting")
            LiveRoomConnection.onError?.invoke("Missing LiveKit credentials")
            finish()
            return
        }

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        setContent { ViewerScreen() }

        lifecycleScope.launch {
            LiveRoomConnection.connectAsViewer(
                appContext = applicationContext,
                url = url,
                token = token
            )
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (LiveRoomConnection.currentMode() == LiveRoomConnection.Mode.VIEWER) {
            LiveRoomConnection.disconnect()
        }
    }

    private fun sendHeart() {
        try {
            val room = LiveRoomConnection.room() ?: return
            lifecycleScope.launch {
                try {
                    val bytes = "like".toByteArray(Charsets.UTF_8)
                    // Reflect to publishData(...) so we tolerate the signature
                    // drift between LiveKit Android 2.x minor versions
                    // (some require DataPublishOptions, some take reliability
                    // enum + topic). Best-effort send.
                    val lp = room.localParticipant
                    val method = lp.javaClass.methods.firstOrNull {
                        it.name == "publishData" &&
                        it.parameterTypes.isNotEmpty() &&
                        it.parameterTypes[0] == ByteArray::class.java
                    }
                    if (method != null) {
                        val args = arrayOfNulls<Any?>(method.parameterTypes.size)
                        args[0] = bytes
                        method.invoke(lp, *args)
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "sendHeart publishData failed", t)
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "sendHeart failed", t)
        }
    }

    // ---------------- Compose UI ----------------

    @Composable
    private fun ViewerScreen() {
        val state by LiveRoomConnection.state.collectAsState()
        val remote by LiveRoomConnection.remoteVideo.collectAsState()
        val participants by LiveRoomConnection.participantCount.collectAsState()

        val hearts = remember { HeartsState() }
        var commentInput by remember { mutableStateOf("") }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black)
        ) {
            // --- Remote video ---
            val rv = remote
            if (rv != null) {
                LiveVideoTrackView(
                    track = rv.track,
                    mirror = false,
                    modifier = Modifier.fillMaxSize()
                )
            } else {
                Box(
                    modifier = Modifier.fillMaxSize().background(Color(0xFF000000)),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = when (state) {
                            LiveRoomConnection.ConnectionState.CONNECTING -> "Conectando..."
                            LiveRoomConnection.ConnectionState.RECONNECTING -> "Reconectando..."
                            LiveRoomConnection.ConnectionState.FAILED -> "Falha na conexão"
                            else -> "Aguardando vídeo do host..."
                        },
                        color = Color.White,
                        fontSize = 16.sp
                    )
                }
            }

            // --- Hearts overlay ---
            HeartsOverlay(state = hearts, modifier = Modifier.fillMaxSize())

            // --- Top bar ---
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .statusBarsPadding()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Avatar circle (placeholder — no image loader to keep scaffold lean)
                Box(
                    modifier = Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(Color(0xFF424242))
                        .border(1.dp, Color.White, CircleShape),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = hostName.firstOrNull()?.uppercase() ?: "?",
                        color = Color.White,
                        fontWeight = FontWeight.Bold
                    )
                }
                Spacer(modifier = Modifier.width(10.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = hostName.ifEmpty { "Live" },
                        color = Color.White,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(
                        text = "${participants.coerceAtLeast(initialViewerCount)} assistindo",
                        color = Color.White.copy(alpha = 0.8f),
                        fontSize = 12.sp
                    )
                }
                IconButton(onClick = { closeViewer() }) {
                    Icon(
                        imageVector = Icons.Filled.Close,
                        contentDescription = "Sair",
                        tint = Color.White
                    )
                }
            }

            // --- Right side hearts column (placeholder column — actual hearts
            //     ascend through the HeartsOverlay layer above) ---
            Column(
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .padding(end = 8.dp),
                verticalArrangement = Arrangement.Center
            ) {
                Spacer(modifier = Modifier.height(20.dp))
            }

            // --- Chat placeholder strip ---
            Box(
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(start = 16.dp, bottom = 92.dp)
                    .background(Color.Black.copy(alpha = 0.45f), RoundedCornerShape(8.dp))
                    .padding(horizontal = 10.dp, vertical = 6.dp)
            ) {
                Text(
                    text = "Chat carregado em JS",
                    color = Color.White.copy(alpha = 0.85f),
                    fontSize = 12.sp
                )
            }

            // --- Bottom action row: comment field + heart + share ---
            Row(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(44.dp)
                        .background(Color.White.copy(alpha = 0.15f), RoundedCornerShape(22.dp))
                        .padding(horizontal = 6.dp),
                    contentAlignment = Alignment.CenterStart
                ) {
                    TextField(
                        value = commentInput,
                        onValueChange = { commentInput = it },
                        placeholder = {
                            Text(
                                "Comentar...",
                                color = Color.White.copy(alpha = 0.7f),
                                fontSize = 14.sp
                            )
                        },
                        textStyle = TextStyle(color = Color.White, fontSize = 14.sp),
                        singleLine = true,
                        colors = TextFieldDefaults.textFieldColors(
                            backgroundColor = Color.Transparent,
                            focusedIndicatorColor = Color.Transparent,
                            unfocusedIndicatorColor = Color.Transparent,
                            disabledIndicatorColor = Color.Transparent,
                            cursorColor = Color.White
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )
                }
                Spacer(modifier = Modifier.width(8.dp))
                IconButton(onClick = {
                    // submit comment is a JS path for v1
                    commentInput = ""
                }) {
                    Icon(Icons.Filled.Send, contentDescription = "Enviar", tint = Color.White)
                }
                IconButton(onClick = {
                    hearts.spawn()
                    sendHeart()
                }) {
                    Icon(
                        Icons.Filled.Favorite,
                        contentDescription = "Curtir",
                        tint = Color(0xFFE91E63)
                    )
                }
                IconButton(onClick = { /* TODO share intent */ }) {
                    Icon(Icons.Filled.Share, contentDescription = "Compartilhar", tint = Color.White)
                }
            }
        }
    }

    private fun closeViewer() {
        LiveRoomConnection.disconnect()
        finish()
    }
}
