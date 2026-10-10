package expo.modules.callkit

// [2026-10-10 group-call-i18n] Textos da tela NATIVA de ligação em grupo
// (GroupCallActivity) nos 11 idiomas do app (pt-BR, pt-PT, en, es, fr, de, it,
// ja, ar, id, hi). Idioma = o do APP quando o JS o espelha
// (ExpoCallKit.setNativeAppLanguage → prefs "chatyy_app_lang"), senão o do
// sistema; idioma fora da lista → inglês. Gerado de uma tabela única (mesmo
// conteúdo do GroupCallStrings.swift do iOS).

import android.content.Context
import java.util.Locale

object GroupCallStrings {
  private const val PREFS = "expo_callkit_prefs"
  private const val KEY_LANG = "chatyy_app_lang"
  @Volatile private var appLang: String? = null
  @Volatile private var loaded = false

  /** JS → nativo (idioma escolhido no app). Vazio/nulo = seguir o sistema. */
  fun setAppLanguage(ctx: Context?, code: String?) {
    val c = code?.trim()?.takeIf { it.isNotEmpty() }
    appLang = c
    loaded = true
    try {
      ctx?.applicationContext?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()
        ?.apply { if (c == null) remove(KEY_LANG) else putString(KEY_LANG, c) }?.apply()
    } catch (_: Throwable) {}
  }

  /** Lê o idioma do app salvo (uma vez por processo). */
  fun load(ctx: Context?) {
    if (loaded || ctx == null) return
    try {
      appLang = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_LANG, null)
      loaded = true
    } catch (_: Throwable) {}
  }

  fun normalize(code: String?): String {
    val c = (code ?: "").replace('_', '-').lowercase(Locale.ROOT)
    return when {
      c.isEmpty() -> "en"
      c.startsWith("pt-pt") || c == "pt-ao" || c == "pt-mz" -> "pt-PT"
      c.startsWith("pt") -> "pt-BR"
      c.startsWith("en") -> "en"
      c.startsWith("es") -> "es"
      c.startsWith("fr") -> "fr"
      c.startsWith("de") -> "de"
      c.startsWith("it") -> "it"
      c.startsWith("ja") -> "ja"
      c.startsWith("ar") -> "ar"
      c.startsWith("id") -> "id"
      c.startsWith("hi") -> "hi"
      c.startsWith("in") -> "id"
      else -> "en"
    }
  }

  fun lang(): String {
    val a = appLang
    if (!a.isNullOrEmpty()) return normalize(a)
    val sys = try { Locale.getDefault().toLanguageTag() } catch (_: Throwable) { "en" }
    return normalize(sys)
  }

  private val T: Map<String, Map<String, String>> = mapOf(
    "pt-BR" to mapOf("connecting" to "Conectando…", "reconnecting" to "Reconectando…", "connected" to "Conectado", "noAnswer" to "Ninguém atendeu", "noConnection" to "Sem conexão", "connectionFailed" to "Falha na conexão", "waitingOthers" to "Aguardando outros participantes…", "participants" to "{n} participantes", "participantsOne" to "1 participante", "groupCall" to "Chamada em grupo", "you" to "Você", "meeting" to "Reunião", "share" to "Compartilhar", "add" to "Adicionar", "more" to "Mais", "react" to "Reagir", "moreOptions" to "Mais opções", "participantsList" to "Lista de participantes ({n})", "audioOutput" to "Saída de áudio", "speaker" to "Alto-falante", "phone" to "Telefone", "bluetooth" to "Bluetooth", "minimize" to "Minimizar", "microphone" to "Microfone", "camera" to "Câmera", "flipCamera" to "Virar câmera", "addPerson" to "Adicionar pessoa", "leaveCall" to "Sair da chamada", "loadingContacts" to "Carregando contatos…", "noContacts" to "Nenhum contato disponível", "addToCall" to "Adicionar à chamada", "calling" to "Chamando {name}…", "couldNotCall" to "Não foi possível chamar", "cancel" to "Cancelar"),
    "pt-PT" to mapOf("connecting" to "A ligar…", "reconnecting" to "A restabelecer a ligação…", "connected" to "Ligado", "noAnswer" to "Ninguém atendeu", "noConnection" to "Sem ligação", "connectionFailed" to "Falha na ligação", "waitingOthers" to "A aguardar outros participantes…", "participants" to "{n} participantes", "participantsOne" to "1 participante", "groupCall" to "Chamada de grupo", "you" to "Você", "meeting" to "Reunião", "share" to "Partilhar", "add" to "Adicionar", "more" to "Mais", "react" to "Reagir", "moreOptions" to "Mais opções", "participantsList" to "Lista de participantes ({n})", "audioOutput" to "Saída de áudio", "speaker" to "Altifalante", "phone" to "Telefone", "bluetooth" to "Bluetooth", "minimize" to "Minimizar", "microphone" to "Microfone", "camera" to "Câmara", "flipCamera" to "Trocar câmara", "addPerson" to "Adicionar pessoa", "leaveCall" to "Sair da chamada", "loadingContacts" to "A carregar contactos…", "noContacts" to "Nenhum contacto disponível", "addToCall" to "Adicionar à chamada", "calling" to "A ligar a {name}…", "couldNotCall" to "Não foi possível ligar", "cancel" to "Cancelar"),
    "en" to mapOf("connecting" to "Connecting…", "reconnecting" to "Reconnecting…", "connected" to "Connected", "noAnswer" to "No answer", "noConnection" to "No connection", "connectionFailed" to "Connection failed", "waitingOthers" to "Waiting for others to join…", "participants" to "{n} participants", "participantsOne" to "1 participant", "groupCall" to "Group call", "you" to "You", "meeting" to "Meeting", "share" to "Share", "add" to "Add", "more" to "More", "react" to "React", "moreOptions" to "More options", "participantsList" to "Participants ({n})", "audioOutput" to "Audio output", "speaker" to "Speaker", "phone" to "Phone", "bluetooth" to "Bluetooth", "minimize" to "Minimize", "microphone" to "Microphone", "camera" to "Camera", "flipCamera" to "Flip camera", "addPerson" to "Add person", "leaveCall" to "Leave call", "loadingContacts" to "Loading contacts…", "noContacts" to "No contacts available", "addToCall" to "Add to call", "calling" to "Calling {name}…", "couldNotCall" to "Couldn’t place the call", "cancel" to "Cancel"),
    "es" to mapOf("connecting" to "Conectando…", "reconnecting" to "Reconectando…", "connected" to "Conectado", "noAnswer" to "Nadie contestó", "noConnection" to "Sin conexión", "connectionFailed" to "Error de conexión", "waitingOthers" to "Esperando a otros participantes…", "participants" to "{n} participantes", "participantsOne" to "1 participante", "groupCall" to "Llamada grupal", "you" to "Tú", "meeting" to "Reunión", "share" to "Compartir", "add" to "Añadir", "more" to "Más", "react" to "Reaccionar", "moreOptions" to "Más opciones", "participantsList" to "Lista de participantes ({n})", "audioOutput" to "Salida de audio", "speaker" to "Altavoz", "phone" to "Teléfono", "bluetooth" to "Bluetooth", "minimize" to "Minimizar", "microphone" to "Micrófono", "camera" to "Cámara", "flipCamera" to "Girar cámara", "addPerson" to "Añadir persona", "leaveCall" to "Salir de la llamada", "loadingContacts" to "Cargando contactos…", "noContacts" to "No hay contactos disponibles", "addToCall" to "Añadir a la llamada", "calling" to "Llamando a {name}…", "couldNotCall" to "No se pudo llamar", "cancel" to "Cancelar"),
    "fr" to mapOf("connecting" to "Connexion…", "reconnecting" to "Reconnexion…", "connected" to "Connecté", "noAnswer" to "Pas de réponse", "noConnection" to "Pas de connexion", "connectionFailed" to "Échec de la connexion", "waitingOthers" to "En attente des autres participants…", "participants" to "{n} participants", "participantsOne" to "1 participant", "groupCall" to "Appel de groupe", "you" to "Vous", "meeting" to "Réunion", "share" to "Partager", "add" to "Ajouter", "more" to "Plus", "react" to "Réagir", "moreOptions" to "Plus d’options", "participantsList" to "Liste des participants ({n})", "audioOutput" to "Sortie audio", "speaker" to "Haut-parleur", "phone" to "Téléphone", "bluetooth" to "Bluetooth", "minimize" to "Réduire", "microphone" to "Micro", "camera" to "Caméra", "flipCamera" to "Retourner la caméra", "addPerson" to "Ajouter une personne", "leaveCall" to "Quitter l’appel", "loadingContacts" to "Chargement des contacts…", "noContacts" to "Aucun contact disponible", "addToCall" to "Ajouter à l’appel", "calling" to "Appel de {name}…", "couldNotCall" to "Impossible d’appeler", "cancel" to "Annuler"),
    "de" to mapOf("connecting" to "Verbinden…", "reconnecting" to "Verbindung wird wiederhergestellt…", "connected" to "Verbunden", "noAnswer" to "Niemand hat geantwortet", "noConnection" to "Keine Verbindung", "connectionFailed" to "Verbindung fehlgeschlagen", "waitingOthers" to "Warten auf weitere Teilnehmer…", "participants" to "{n} Teilnehmer", "participantsOne" to "1 Teilnehmer", "groupCall" to "Gruppenanruf", "you" to "Du", "meeting" to "Besprechung", "share" to "Teilen", "add" to "Hinzufügen", "more" to "Mehr", "react" to "Reagieren", "moreOptions" to "Weitere Optionen", "participantsList" to "Teilnehmerliste ({n})", "audioOutput" to "Audioausgabe", "speaker" to "Lautsprecher", "phone" to "Telefon", "bluetooth" to "Bluetooth", "minimize" to "Minimieren", "microphone" to "Mikrofon", "camera" to "Kamera", "flipCamera" to "Kamera wechseln", "addPerson" to "Person hinzufügen", "leaveCall" to "Anruf verlassen", "loadingContacts" to "Kontakte werden geladen…", "noContacts" to "Keine Kontakte verfügbar", "addToCall" to "Zum Anruf hinzufügen", "calling" to "{name} wird angerufen…", "couldNotCall" to "Anruf nicht möglich", "cancel" to "Abbrechen"),
    "it" to mapOf("connecting" to "Connessione…", "reconnecting" to "Riconnessione…", "connected" to "Connesso", "noAnswer" to "Nessuna risposta", "noConnection" to "Nessuna connessione", "connectionFailed" to "Connessione non riuscita", "waitingOthers" to "In attesa degli altri partecipanti…", "participants" to "{n} partecipanti", "participantsOne" to "1 partecipante", "groupCall" to "Chiamata di gruppo", "you" to "Tu", "meeting" to "Riunione", "share" to "Condividi", "add" to "Aggiungi", "more" to "Altro", "react" to "Reagisci", "moreOptions" to "Altre opzioni", "participantsList" to "Elenco partecipanti ({n})", "audioOutput" to "Uscita audio", "speaker" to "Altoparlante", "phone" to "Telefono", "bluetooth" to "Bluetooth", "minimize" to "Riduci", "microphone" to "Microfono", "camera" to "Fotocamera", "flipCamera" to "Cambia fotocamera", "addPerson" to "Aggiungi persona", "leaveCall" to "Esci dalla chiamata", "loadingContacts" to "Caricamento contatti…", "noContacts" to "Nessun contatto disponibile", "addToCall" to "Aggiungi alla chiamata", "calling" to "Chiamata a {name}…", "couldNotCall" to "Impossibile chiamare", "cancel" to "Annulla"),
    "ja" to mapOf("connecting" to "接続中…", "reconnecting" to "再接続中…", "connected" to "接続済み", "noAnswer" to "応答がありません", "noConnection" to "接続できません", "connectionFailed" to "接続に失敗しました", "waitingOthers" to "他の参加者を待っています…", "participants" to "参加者{n}人", "participantsOne" to "参加者1人", "groupCall" to "グループ通話", "you" to "あなた", "meeting" to "ミーティング", "share" to "共有", "add" to "追加", "more" to "その他", "react" to "リアクション", "moreOptions" to "その他のオプション", "participantsList" to "参加者リスト（{n}）", "audioOutput" to "オーディオ出力", "speaker" to "スピーカー", "phone" to "電話", "bluetooth" to "Bluetooth", "minimize" to "最小化", "microphone" to "マイク", "camera" to "カメラ", "flipCamera" to "カメラを切り替え", "addPerson" to "ユーザーを追加", "leaveCall" to "通話から退出", "loadingContacts" to "連絡先を読み込み中…", "noContacts" to "利用できる連絡先がありません", "addToCall" to "通話に追加", "calling" to "{name}に発信中…", "couldNotCall" to "発信できませんでした", "cancel" to "キャンセル"),
    "ar" to mapOf("connecting" to "جارٍ الاتصال…", "reconnecting" to "جارٍ إعادة الاتصال…", "connected" to "متصل", "noAnswer" to "لم يرد أحد", "noConnection" to "لا يوجد اتصال", "connectionFailed" to "فشل الاتصال", "waitingOthers" to "في انتظار المشاركين الآخرين…", "participants" to "{n} مشاركين", "participantsOne" to "مشارك واحد", "groupCall" to "مكالمة جماعية", "you" to "أنت", "meeting" to "اجتماع", "share" to "مشاركة", "add" to "إضافة", "more" to "المزيد", "react" to "تفاعل", "moreOptions" to "خيارات أخرى", "participantsList" to "قائمة المشاركين ({n})", "audioOutput" to "مخرج الصوت", "speaker" to "مكبر الصوت", "phone" to "الهاتف", "bluetooth" to "بلوتوث", "minimize" to "تصغير", "microphone" to "الميكروفون", "camera" to "الكاميرا", "flipCamera" to "تبديل الكاميرا", "addPerson" to "إضافة شخص", "leaveCall" to "مغادرة المكالمة", "loadingContacts" to "جارٍ تحميل جهات الاتصال…", "noContacts" to "لا توجد جهات اتصال متاحة", "addToCall" to "إضافة إلى المكالمة", "calling" to "جارٍ الاتصال بـ {name}…", "couldNotCall" to "تعذّر الاتصال", "cancel" to "إلغاء"),
    "id" to mapOf("connecting" to "Menghubungkan…", "reconnecting" to "Menghubungkan ulang…", "connected" to "Terhubung", "noAnswer" to "Tidak ada yang menjawab", "noConnection" to "Tidak ada koneksi", "connectionFailed" to "Koneksi gagal", "waitingOthers" to "Menunggu peserta lain…", "participants" to "{n} peserta", "participantsOne" to "1 peserta", "groupCall" to "Panggilan grup", "you" to "Anda", "meeting" to "Rapat", "share" to "Bagikan", "add" to "Tambah", "more" to "Lainnya", "react" to "Reaksi", "moreOptions" to "Opsi lainnya", "participantsList" to "Daftar peserta ({n})", "audioOutput" to "Output audio", "speaker" to "Speaker", "phone" to "Telepon", "bluetooth" to "Bluetooth", "minimize" to "Perkecil", "microphone" to "Mikrofon", "camera" to "Kamera", "flipCamera" to "Balik kamera", "addPerson" to "Tambah orang", "leaveCall" to "Keluar dari panggilan", "loadingContacts" to "Memuat kontak…", "noContacts" to "Tidak ada kontak tersedia", "addToCall" to "Tambahkan ke panggilan", "calling" to "Memanggil {name}…", "couldNotCall" to "Tidak dapat memanggil", "cancel" to "Batal"),
    "hi" to mapOf("connecting" to "कनेक्ट हो रहा है…", "reconnecting" to "फिर से कनेक्ट हो रहा है…", "connected" to "कनेक्ट हो गया", "noAnswer" to "किसी ने जवाब नहीं दिया", "noConnection" to "कोई कनेक्शन नहीं", "connectionFailed" to "कनेक्शन विफल", "waitingOthers" to "अन्य प्रतिभागियों की प्रतीक्षा…", "participants" to "{n} प्रतिभागी", "participantsOne" to "1 प्रतिभागी", "groupCall" to "ग्रुप कॉल", "you" to "आप", "meeting" to "मीटिंग", "share" to "शेयर करें", "add" to "जोड़ें", "more" to "और", "react" to "प्रतिक्रिया", "moreOptions" to "और विकल्प", "participantsList" to "प्रतिभागियों की सूची ({n})", "audioOutput" to "ऑडियो आउटपुट", "speaker" to "स्पीकर", "phone" to "फ़ोन", "bluetooth" to "ब्लूटूथ", "minimize" to "छोटा करें", "microphone" to "माइक्रोफ़ोन", "camera" to "कैमरा", "flipCamera" to "कैमरा बदलें", "addPerson" to "व्यक्ति जोड़ें", "leaveCall" to "कॉल छोड़ें", "loadingContacts" to "संपर्क लोड हो रहे हैं…", "noContacts" to "कोई संपर्क उपलब्ध नहीं", "addToCall" to "कॉल में जोड़ें", "calling" to "{name} को कॉल किया जा रहा है…", "couldNotCall" to "कॉल नहीं हो सका", "cancel" to "रद्द करें"),
  )

  /** Texto da chave no idioma atual; {n}/{name} substituídos por [args]. */
  fun s(key: String, vararg args: Pair<String, String>): String {
    val l = lang()
    var out = T[l]?.get(key) ?: T["en"]?.get(key) ?: key
    for ((k, v) in args) out = out.replace("{" + k + "}", v)
    return out
  }

  fun participants(n: Int): String = if (n == 1) s("participantsOne") else s("participants", "n" to n.toString())
}
