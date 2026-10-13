package expo.modules.callkit

// [2026-10-13 add-to-call redesign] Seletor "Adicionar à chamada" do Android,
// igual ao iOS (CallParticipantPicker.swift) e ao JS (AddToCallSheet.js):
//   • folha ESCURA, só P&B; busca no topo (nome, @usuário, e-mail, telefone)
//     com debounce 280 ms;
//   • seções "Conversas recentes" / "Contatos" — SÓ conversas direct + agenda
//     do usuário (chat_call_add_candidates); contas de teste escondidas;
//   • nome de exibição + foto real (carregada aqui, cache em memória);
//   • "Na chamada" / "Chamando…" desabilitados; seleção múltipla com check +
//     "Adicionar (N)"; skeleton, vazio, erro com "Tentar de novo";
//   • erro traduzido com o motivo (GroupCallStrings "pk.*").
// Usado pelo CallActivity (Compose, 1:1) e pelo GroupCallActivity (Views →
// CallAddParticipantOverlay põe um ComposeView por cima do conteúdo).

import android.graphics.BitmapFactory
import android.os.Bundle
import android.util.Log
import android.util.LruCache
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.People
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.Image
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

private val PkBg = Color(0xFF121212)
private val PkSurface = Color(0xFF1E1E1E)
private val PkSurface2 = Color(0xFF2A2A2A)
private val PkText2 = Color(0xFFA3A3A3)
private val PkText3 = Color(0xFF737373)
private const val PK_MAX_FANOUT = 16

/** Fotos dos contatos (memória do processo; ~40 fotos pequenas). */
private object PickerAvatarCache {
  private val cache = LruCache<String, ImageBitmap>(40)
  fun get(url: String): ImageBitmap? = cache.get(url)
  fun load(url: String): ImageBitmap? {
    cache.get(url)?.let { return it }
    var conn: HttpURLConnection? = null
    return try {
      conn = (URL(url).openConnection() as HttpURLConnection).apply {
        connectTimeout = 5_000
        readTimeout = 8_000
        instanceFollowRedirects = true
      }
      if (conn.responseCode !in 200..299) return null
      val opts = BitmapFactory.Options().apply { inPreferredConfig = android.graphics.Bitmap.Config.RGB_565 }
      val bmp = conn.inputStream.use { BitmapFactory.decodeStream(it, null, opts) } ?: return null
      val scaled = if (bmp.width > 160) android.graphics.Bitmap.createScaledBitmap(bmp, 160, 160 * bmp.height / bmp.width.coerceAtLeast(1), true) else bmp
      val img = scaled.asImageBitmap()
      cache.put(url, img)
      img
    } catch (t: Throwable) {
      null
    } finally {
      try { conn?.disconnect() } catch (_: Throwable) {}
    }
  }
}

@Composable
private fun PickerAvatar(name: String, url: String, size: Int) {
  var img by remember(url) { mutableStateOf(if (url.isNotEmpty()) PickerAvatarCache.get(url) else null) }
  LaunchedEffect(url) {
    if (url.isNotEmpty() && img == null) {
      img = withContext(Dispatchers.IO) { PickerAvatarCache.load(url) }
    }
  }
  val initials = remember(name) {
    name.split(' ', '.', '_').filter { it.isNotEmpty() }.take(2)
      .mapNotNull { it.firstOrNull()?.uppercaseChar()?.toString() }.joinToString("").ifEmpty { "?" }
  }
  Box(
    modifier = Modifier.size(size.dp).clip(CircleShape).background(Color(0xFF333333)),
    contentAlignment = Alignment.Center,
  ) {
    val bmp = img
    if (bmp != null) {
      Image(bitmap = bmp, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    } else {
      Text(initials, color = Color.White, fontSize = (size * 0.36f).sp, fontWeight = FontWeight.SemiBold)
    }
  }
}

/**
 * Folha inteira (scrim + cartão). [alreadyInCall] = e-mails já na sala.
 * [onInvited] recebe (email, nome) de quem foi chamado com sucesso.
 */
@Composable
fun CallAddParticipantSheet(
  callId: String,
  conversationId: String,
  isVideo: Boolean,
  alreadyInCall: Set<String>,
  intentExtras: Bundle? = null,
  onInvited: (List<Pair<String, String>>) -> Unit = {},
  onDismiss: () -> Unit,
) {
  val ctx = LocalContext.current.applicationContext
  val scope = rememberCoroutineScope()
  var query by remember { mutableStateOf("") }
  var recent by remember { mutableStateOf(emptyList<CallContacts.Candidate>()) }
  var contacts by remember { mutableStateOf(emptyList<CallContacts.Candidate>()) }
  var results by remember { mutableStateOf<List<CallContacts.Candidate>?>(null) }
  var loading by remember { mutableStateOf(true) }
  var loadFailed by remember { mutableStateOf(false) }
  var searching by remember { mutableStateOf(false) }
  var reloadTick by remember { mutableStateOf(0) }
  val selected = remember { mutableStateMapOf<String, CallContacts.Candidate>() }
  val order = remember { mutableStateListOf<String>() }
  val ringing = remember { mutableStateMapOf<String, Boolean>() }
  var adding by remember { mutableStateOf(false) }
  var banner by remember { mutableStateOf<String?>(null) }

  BackHandler { onDismiss() }

  LaunchedEffect(reloadTick) {
    loading = true
    loadFailed = false
    val r = withContext(Dispatchers.IO) { CallContacts.fetchCandidates(ctx, "", callId, intentExtras) }
    if (r.ok) { recent = r.recent; contacts = r.contacts } else loadFailed = true
    loading = false
  }

  LaunchedEffect(query) {
    val q = query.trim()
    if (q.isEmpty()) { results = null; searching = false; return@LaunchedEffect }
    searching = true
    delay(280) // debounce: nova tecla cancela este efeito
    val r = withContext(Dispatchers.IO) { CallContacts.fetchCandidates(ctx, q, callId, intentExtras) }
    results = if (r.ok) r.results else null
    searching = false
  }

  fun stateOf(c: CallContacts.Candidate): String = when {
    c.email in alreadyInCall || c.callState == "in_call" -> "in_call"
    ringing[c.email] == true || c.callState == "ringing" -> "ringing"
    else -> ""
  }

  fun nameOf(email: String): String =
    selected[email]?.name
      ?: (recent + contacts + (results ?: emptyList())).firstOrNull { it.email == email }?.name
      ?: email.substringBefore('@')

  fun toggle(c: CallContacts.Candidate) {
    if (stateOf(c).isNotEmpty() || adding) return
    banner = null
    if (selected.containsKey(c.email)) {
      selected.remove(c.email); order.remove(c.email)
    } else if (order.size < PK_MAX_FANOUT) {
      selected[c.email] = c; order.add(c.email)
    }
  }

  fun addSelected() {
    if (adding || order.isEmpty()) return
    val emails = order.toList().take(PK_MAX_FANOUT)
    val names = emails.map { nameOf(it) }
    adding = true
    banner = null
    scope.launch {
      val res = withContext(Dispatchers.IO) {
        CallContacts.ringIntoCallMany(ctx, callId, conversationId, emails, isVideo, intentExtras)
      }
      adding = false
      if (!res.ok) {
        val who = if (res.skipped.isEmpty()) names.joinToString(", ") else res.skipped.joinToString(", ") { nameOf(it.first) }
        banner = CallContacts.errorText(res.code, who)
        return@launch
      }
      val problems = ArrayList<String>()
      res.skipped.forEach { problems.add(CallContacts.errorText(it.second, nameOf(it.first))) }
      res.invited.filter { !it.second }.forEach { problems.add(CallContacts.errorText("offline", nameOf(it.first))) }
      val invitedPairs = res.invited.map { it.first to nameOf(it.first) }
      res.invited.forEach { ringing[it.first] = true }
      selected.clear(); order.clear()
      try { onInvited(invitedPairs) } catch (_: Throwable) {}
      if (problems.isEmpty()) onDismiss() else banner = problems.take(2).joinToString("\n")
    }
  }

  val qTrim = query.trim()
  val qFold = CallContacts.fold(qTrim.removePrefix("@"))
  val sections: List<Pair<String, List<CallContacts.Candidate>>> = if (qFold.isNotEmpty()) {
    val list = results ?: (recent + contacts).filter {
      CallContacts.fold(it.name).contains(qFold) || CallContacts.fold(it.username).contains(qFold) || it.email.startsWith(qFold)
    }
    if (list.isEmpty()) emptyList() else listOf(GroupCallStrings.s("pk.results") to list)
  } else {
    buildList {
      if (recent.isNotEmpty()) add(GroupCallStrings.s("pk.recent") to recent)
      if (contacts.isNotEmpty()) add(GroupCallStrings.s("pk.contacts") to contacts)
    }
  }

  Box(
    modifier = Modifier
      .fillMaxSize()
      .background(Color.Black.copy(alpha = 0.6f))
      .clickable(indication = null, interactionSource = remember { MutableInteractionSource() }) { onDismiss() },
    contentAlignment = Alignment.BottomCenter,
  ) {
    Column(
      modifier = Modifier
        .fillMaxWidth()
        .fillMaxHeight(0.92f)
        .statusBarsPadding()
        .clip(RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp))
        .background(PkBg)
        .clickable(indication = null, interactionSource = remember { MutableInteractionSource() }) { /* engole */ }
        .navigationBarsPadding()
        .imePadding(),
    ) {
      // alça + cabeçalho
      Box(Modifier.fillMaxWidth().padding(top = 8.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.width(40.dp).height(4.dp).clip(RoundedCornerShape(2.dp)).background(Color.White.copy(alpha = 0.22f)))
      }
      Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Box(
          modifier = Modifier.size(36.dp).clip(CircleShape).background(PkSurface).clickable { onDismiss() },
          contentAlignment = Alignment.Center,
        ) {
          Icon(Icons.Filled.Close, contentDescription = GroupCallStrings.s("pk.close"), tint = Color.White, modifier = Modifier.size(18.dp))
        }
        Text(
          GroupCallStrings.s("pk.title"),
          color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.SemiBold,
          textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis,
          modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.size(36.dp))
      }

      // busca
      Row(
        modifier = Modifier
          .fillMaxWidth()
          .padding(horizontal = 16.dp)
          .height(42.dp)
          .clip(RoundedCornerShape(12.dp))
          .background(PkSurface)
          .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Icon(Icons.Filled.Search, contentDescription = null, tint = PkText2, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
          if (query.isEmpty()) {
            Text(GroupCallStrings.s("pk.search"), color = PkText3, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
          }
          BasicTextField(
            value = query,
            onValueChange = { query = it.take(64) },
            singleLine = true,
            textStyle = TextStyle(color = Color.White, fontSize = 16.sp),
            cursorBrush = SolidColor(Color.White),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            modifier = Modifier.fillMaxWidth(),
          )
        }
        if (searching) {
          CircularProgressIndicator(color = PkText2, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
        } else if (query.isNotEmpty()) {
          Icon(
            Icons.Filled.Close, contentDescription = null, tint = PkText3,
            modifier = Modifier.size(18.dp).clickable { query = "" },
          )
        }
      }

      banner?.let { b ->
        Row(
          modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp, top = 8.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(PkSurface2)
            .padding(12.dp),
          verticalAlignment = Alignment.Top,
        ) {
          Icon(Icons.Outlined.Info, contentDescription = null, tint = Color.White, modifier = Modifier.size(18.dp))
          Spacer(Modifier.width(8.dp))
          Text(b, color = Color.White, fontSize = 14.sp, lineHeight = 19.sp)
        }
      }

      if (order.isNotEmpty()) {
        Row(
          modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(start = 16.dp, end = 16.dp, top = 10.dp),
          horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
          order.forEach { email ->
            val c = selected[email] ?: return@forEach
            Column(
              modifier = Modifier.width(58.dp).clickable { toggle(c) },
              horizontalAlignment = Alignment.CenterHorizontally,
            ) {
              Box {
                PickerAvatar(c.name, c.avatar, 48)
                Box(
                  modifier = Modifier.align(Alignment.TopEnd).size(18.dp).clip(CircleShape).background(PkSurface2)
                    .border(1.5.dp, PkBg, CircleShape),
                  contentAlignment = Alignment.Center,
                ) {
                  Icon(Icons.Filled.Close, contentDescription = null, tint = Color.White, modifier = Modifier.size(10.dp))
                }
              }
              Spacer(Modifier.height(4.dp))
              Text(c.name, color = PkText2, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
          }
        }
      }

      // conteúdo
      Box(Modifier.weight(1f).fillMaxWidth()) {
        val noBase = recent.isEmpty() && contacts.isEmpty()
        when {
          loading && noBase && qTrim.isEmpty() -> {
            Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
              repeat(6) { i ->
                Row(
                  modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
                  verticalAlignment = Alignment.CenterVertically,
                ) {
                  Box(Modifier.size(46.dp).clip(CircleShape).background(PkSurface2))
                  Spacer(Modifier.width(14.dp))
                  Column {
                    Box(Modifier.width((170 - i * 12).dp).height(13.dp).clip(RoundedCornerShape(6.dp)).background(PkSurface2))
                    Spacer(Modifier.height(8.dp))
                    Box(Modifier.width(80.dp).height(10.dp).clip(RoundedCornerShape(5.dp)).background(PkSurface2))
                  }
                }
              }
            }
          }
          loadFailed && noBase && qTrim.isEmpty() -> {
            Column(
              modifier = Modifier.fillMaxSize().padding(horizontal = 32.dp),
              horizontalAlignment = Alignment.CenterHorizontally,
              verticalArrangement = Arrangement.Center,
            ) {
              Icon(Icons.Outlined.Info, contentDescription = null, tint = PkText3, modifier = Modifier.size(30.dp))
              Spacer(Modifier.height(10.dp))
              Text(GroupCallStrings.s("pk.loadError"), color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
              Spacer(Modifier.height(12.dp))
              Box(
                modifier = Modifier
                  .clip(RoundedCornerShape(20.dp))
                  .border(1.dp, Color.White.copy(alpha = 0.3f), RoundedCornerShape(20.dp))
                  .clickable { reloadTick += 1 }
                  .padding(horizontal = 18.dp, vertical = 9.dp),
              ) {
                Text(GroupCallStrings.s("pk.retry"), color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
              }
            }
          }
          sections.isEmpty() -> {
            Column(
              modifier = Modifier.fillMaxSize().padding(horizontal = 32.dp),
              horizontalAlignment = Alignment.CenterHorizontally,
              verticalArrangement = Arrangement.Center,
            ) {
              if (qTrim.isNotEmpty() && searching) {
                CircularProgressIndicator(color = PkText2, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
              } else {
                Icon(Icons.Outlined.People, contentDescription = null, tint = PkText3, modifier = Modifier.size(34.dp))
                Spacer(Modifier.height(10.dp))
                Text(
                  if (qTrim.isEmpty()) GroupCallStrings.s("pk.emptyTitle") else GroupCallStrings.s("pk.noResults", "q" to qTrim),
                  color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                )
                if (qTrim.isEmpty()) {
                  Spacer(Modifier.height(6.dp))
                  Text(GroupCallStrings.s("pk.emptyBody"), color = PkText2, fontSize = 14.sp, textAlign = TextAlign.Center, lineHeight = 20.sp)
                }
              }
            }
          }
          else -> {
            LazyColumn(Modifier.fillMaxSize()) {
              sections.forEach { (title, rows) ->
                item(key = "h_$title") {
                  Text(
                    title, color = PkText2, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 14.dp, bottom = 6.dp),
                  )
                }
                items(rows, key = { "${title}_${it.email}" }) { c ->
                  val st = stateOf(c)
                  val isSel = selected.containsKey(c.email)
                  val sub = if (c.username.isNotEmpty() && CallContacts.fold(c.username) != CallContacts.fold(c.name)) "@${c.username}" else ""
                  Row(
                    modifier = Modifier
                      .fillMaxWidth()
                      .clickable(enabled = st.isEmpty() && !adding) { toggle(c) }
                      .padding(horizontal = 20.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                  ) {
                    PickerAvatar(c.name, c.avatar, 46)
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                      Text(
                        c.name, color = if (st.isEmpty()) Color.White else PkText2,
                        fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                      )
                      if (sub.isNotEmpty()) {
                        Text(sub, color = PkText2, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                      }
                    }
                    Spacer(Modifier.width(8.dp))
                    if (st.isNotEmpty()) {
                      Box(
                        modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(PkSurface2)
                          .padding(horizontal = 10.dp, vertical = 5.dp),
                      ) {
                        Text(
                          if (st == "in_call") GroupCallStrings.s("pk.inCall") else GroupCallStrings.s("pk.ringing"),
                          color = PkText2, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                        )
                      }
                    } else {
                      Box(
                        modifier = Modifier
                          .size(24.dp)
                          .clip(CircleShape)
                          .background(if (isSel) Color.White else Color.Transparent)
                          .border(2.dp, if (isSel) Color.White else Color.White.copy(alpha = 0.35f), CircleShape),
                        contentAlignment = Alignment.Center,
                      ) {
                        if (isSel) Icon(Icons.Filled.Check, contentDescription = null, tint = Color.Black, modifier = Modifier.size(14.dp))
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      // rodapé
      val n = order.size
      Box(
        modifier = Modifier
          .fillMaxWidth()
          .padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 10.dp)
          .height(50.dp)
          .clip(RoundedCornerShape(25.dp))
          .background(if (n == 0) PkSurface2 else Color.White)
          .clickable(enabled = n > 0 && !adding) { addSelected() },
        contentAlignment = Alignment.Center,
      ) {
        if (adding) {
          CircularProgressIndicator(color = Color.Black, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
        } else {
          Text(
            if (n > 0) GroupCallStrings.s("pk.addN", "n" to n.toString()) else GroupCallStrings.s("pk.add"),
            color = if (n == 0) PkText3 else Color.Black, fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
          )
        }
      }
    }
  }
}

/**
 * Para telas feitas com Views (GroupCallActivity): põe a folha num ComposeView
 * por cima do conteúdo da Activity e tira ao fechar.
 */
object CallAddParticipantOverlay {
  private const val TAG = "CallAddPartOverlay"

  fun show(
    activity: ComponentActivity,
    callId: String,
    conversationId: String,
    isVideo: Boolean,
    alreadyInCall: Set<String>,
    intentExtras: Bundle?,
    onInvited: (List<Pair<String, String>>) -> Unit,
  ) {
    try {
      val root = activity.findViewById<ViewGroup>(android.R.id.content) ?: return
      if (root.findViewWithTag<android.view.View>(TAG) != null) return
      val cv = ComposeView(activity)
      cv.tag = TAG
      cv.setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
      val close = { try { root.removeView(cv) } catch (_: Throwable) {} }
      cv.setContent {
        CallAddParticipantSheet(
          callId = callId,
          conversationId = conversationId,
          isVideo = isVideo,
          alreadyInCall = alreadyInCall,
          intentExtras = intentExtras,
          onInvited = onInvited,
          onDismiss = { close() },
        )
      }
      root.addView(cv, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    } catch (t: Throwable) {
      Log.w(TAG, "show failed: ${t.message}")
    }
  }
}
