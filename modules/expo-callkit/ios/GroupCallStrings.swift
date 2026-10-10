// GroupCallStrings.swift — [2026-10-10 group-call-i18n] Textos da tela NATIVA
// de ligação em grupo (GroupCallViewController / GroupCallView) nos 11 idiomas
// do app (pt-BR, pt-PT, en, es, fr, de, it, ja, ar, id, hi). Idioma = o do APP
// quando o JS o espelha (ExpoCallKit.setNativeAppLanguage → App Group
// "chatyy_app_lang"), senão o do sistema; fora da lista → inglês. Mesmo
// conteúdo do GroupCallStrings.kt (Android). Só Foundation.

import Foundation

enum GroupCallStrings {
    static let kAppGroup = "group.com.onemundo.mail"
    static let kLangKey = "chatyy_app_lang"

    /// JS → nativo (idioma escolhido no app). Vazio/nil = seguir o sistema.
    static func setAppLanguage(_ code: String?) {
        let c = (code ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let ud = UserDefaults(suiteName: kAppGroup)
        if c.isEmpty { ud?.removeObject(forKey: kLangKey) } else { ud?.set(c, forKey: kLangKey) }
    }

    static func normalize(_ code: String?) -> String {
        let c = (code ?? "").replacingOccurrences(of: "_", with: "-").lowercased()
        if c.isEmpty { return "en" }
        if c.hasPrefix("pt-pt") || c == "pt-ao" || c == "pt-mz" { return "pt-PT" }
        if c.hasPrefix("pt") { return "pt-BR" }
        if c.hasPrefix("en") { return "en" }
        if c.hasPrefix("es") { return "es" }
        if c.hasPrefix("fr") { return "fr" }
        if c.hasPrefix("de") { return "de" }
        if c.hasPrefix("it") { return "it" }
        if c.hasPrefix("ja") { return "ja" }
        if c.hasPrefix("ar") { return "ar" }
        if c.hasPrefix("id") { return "id" }
        if c.hasPrefix("hi") { return "hi" }
        if c.hasPrefix("in") { return "id" }
        return "en"
    }

    static var lang: String {
        if let a = UserDefaults(suiteName: kAppGroup)?.string(forKey: kLangKey), !a.isEmpty {
            return normalize(a)
        }
        return normalize(Locale.preferredLanguages.first)
    }

    private static let table: [String: [String: String]] = [
        "pt-BR": ["connecting": "Conectando…", "reconnecting": "Reconectando…", "connected": "Conectado", "noAnswer": "Ninguém atendeu", "noConnection": "Sem conexão", "connectionFailed": "Falha na conexão", "waitingOthers": "Aguardando outros participantes…", "participants": "{n} participantes", "participantsOne": "1 participante", "groupCall": "Chamada em grupo", "you": "Você", "meeting": "Reunião", "share": "Compartilhar", "add": "Adicionar", "more": "Mais", "react": "Reagir", "moreOptions": "Mais opções", "participantsList": "Lista de participantes ({n})", "audioOutput": "Saída de áudio", "speaker": "Alto-falante", "phone": "Telefone", "bluetooth": "Bluetooth", "minimize": "Minimizar", "microphone": "Microfone", "camera": "Câmera", "flipCamera": "Virar câmera", "addPerson": "Adicionar pessoa", "leaveCall": "Sair da chamada", "loadingContacts": "Carregando contatos…", "noContacts": "Nenhum contato disponível", "addToCall": "Adicionar à chamada", "calling": "Chamando {name}…", "couldNotCall": "Não foi possível chamar", "cancel": "Cancelar"],
        "pt-PT": ["connecting": "A ligar…", "reconnecting": "A restabelecer a ligação…", "connected": "Ligado", "noAnswer": "Ninguém atendeu", "noConnection": "Sem ligação", "connectionFailed": "Falha na ligação", "waitingOthers": "A aguardar outros participantes…", "participants": "{n} participantes", "participantsOne": "1 participante", "groupCall": "Chamada de grupo", "you": "Você", "meeting": "Reunião", "share": "Partilhar", "add": "Adicionar", "more": "Mais", "react": "Reagir", "moreOptions": "Mais opções", "participantsList": "Lista de participantes ({n})", "audioOutput": "Saída de áudio", "speaker": "Altifalante", "phone": "Telefone", "bluetooth": "Bluetooth", "minimize": "Minimizar", "microphone": "Microfone", "camera": "Câmara", "flipCamera": "Trocar câmara", "addPerson": "Adicionar pessoa", "leaveCall": "Sair da chamada", "loadingContacts": "A carregar contactos…", "noContacts": "Nenhum contacto disponível", "addToCall": "Adicionar à chamada", "calling": "A ligar a {name}…", "couldNotCall": "Não foi possível ligar", "cancel": "Cancelar"],
        "en": ["connecting": "Connecting…", "reconnecting": "Reconnecting…", "connected": "Connected", "noAnswer": "No answer", "noConnection": "No connection", "connectionFailed": "Connection failed", "waitingOthers": "Waiting for others to join…", "participants": "{n} participants", "participantsOne": "1 participant", "groupCall": "Group call", "you": "You", "meeting": "Meeting", "share": "Share", "add": "Add", "more": "More", "react": "React", "moreOptions": "More options", "participantsList": "Participants ({n})", "audioOutput": "Audio output", "speaker": "Speaker", "phone": "Phone", "bluetooth": "Bluetooth", "minimize": "Minimize", "microphone": "Microphone", "camera": "Camera", "flipCamera": "Flip camera", "addPerson": "Add person", "leaveCall": "Leave call", "loadingContacts": "Loading contacts…", "noContacts": "No contacts available", "addToCall": "Add to call", "calling": "Calling {name}…", "couldNotCall": "Couldn’t place the call", "cancel": "Cancel"],
        "es": ["connecting": "Conectando…", "reconnecting": "Reconectando…", "connected": "Conectado", "noAnswer": "Nadie contestó", "noConnection": "Sin conexión", "connectionFailed": "Error de conexión", "waitingOthers": "Esperando a otros participantes…", "participants": "{n} participantes", "participantsOne": "1 participante", "groupCall": "Llamada grupal", "you": "Tú", "meeting": "Reunión", "share": "Compartir", "add": "Añadir", "more": "Más", "react": "Reaccionar", "moreOptions": "Más opciones", "participantsList": "Lista de participantes ({n})", "audioOutput": "Salida de audio", "speaker": "Altavoz", "phone": "Teléfono", "bluetooth": "Bluetooth", "minimize": "Minimizar", "microphone": "Micrófono", "camera": "Cámara", "flipCamera": "Girar cámara", "addPerson": "Añadir persona", "leaveCall": "Salir de la llamada", "loadingContacts": "Cargando contactos…", "noContacts": "No hay contactos disponibles", "addToCall": "Añadir a la llamada", "calling": "Llamando a {name}…", "couldNotCall": "No se pudo llamar", "cancel": "Cancelar"],
        "fr": ["connecting": "Connexion…", "reconnecting": "Reconnexion…", "connected": "Connecté", "noAnswer": "Pas de réponse", "noConnection": "Pas de connexion", "connectionFailed": "Échec de la connexion", "waitingOthers": "En attente des autres participants…", "participants": "{n} participants", "participantsOne": "1 participant", "groupCall": "Appel de groupe", "you": "Vous", "meeting": "Réunion", "share": "Partager", "add": "Ajouter", "more": "Plus", "react": "Réagir", "moreOptions": "Plus d’options", "participantsList": "Liste des participants ({n})", "audioOutput": "Sortie audio", "speaker": "Haut-parleur", "phone": "Téléphone", "bluetooth": "Bluetooth", "minimize": "Réduire", "microphone": "Micro", "camera": "Caméra", "flipCamera": "Retourner la caméra", "addPerson": "Ajouter une personne", "leaveCall": "Quitter l’appel", "loadingContacts": "Chargement des contacts…", "noContacts": "Aucun contact disponible", "addToCall": "Ajouter à l’appel", "calling": "Appel de {name}…", "couldNotCall": "Impossible d’appeler", "cancel": "Annuler"],
        "de": ["connecting": "Verbinden…", "reconnecting": "Verbindung wird wiederhergestellt…", "connected": "Verbunden", "noAnswer": "Niemand hat geantwortet", "noConnection": "Keine Verbindung", "connectionFailed": "Verbindung fehlgeschlagen", "waitingOthers": "Warten auf weitere Teilnehmer…", "participants": "{n} Teilnehmer", "participantsOne": "1 Teilnehmer", "groupCall": "Gruppenanruf", "you": "Du", "meeting": "Besprechung", "share": "Teilen", "add": "Hinzufügen", "more": "Mehr", "react": "Reagieren", "moreOptions": "Weitere Optionen", "participantsList": "Teilnehmerliste ({n})", "audioOutput": "Audioausgabe", "speaker": "Lautsprecher", "phone": "Telefon", "bluetooth": "Bluetooth", "minimize": "Minimieren", "microphone": "Mikrofon", "camera": "Kamera", "flipCamera": "Kamera wechseln", "addPerson": "Person hinzufügen", "leaveCall": "Anruf verlassen", "loadingContacts": "Kontakte werden geladen…", "noContacts": "Keine Kontakte verfügbar", "addToCall": "Zum Anruf hinzufügen", "calling": "{name} wird angerufen…", "couldNotCall": "Anruf nicht möglich", "cancel": "Abbrechen"],
        "it": ["connecting": "Connessione…", "reconnecting": "Riconnessione…", "connected": "Connesso", "noAnswer": "Nessuna risposta", "noConnection": "Nessuna connessione", "connectionFailed": "Connessione non riuscita", "waitingOthers": "In attesa degli altri partecipanti…", "participants": "{n} partecipanti", "participantsOne": "1 partecipante", "groupCall": "Chiamata di gruppo", "you": "Tu", "meeting": "Riunione", "share": "Condividi", "add": "Aggiungi", "more": "Altro", "react": "Reagisci", "moreOptions": "Altre opzioni", "participantsList": "Elenco partecipanti ({n})", "audioOutput": "Uscita audio", "speaker": "Altoparlante", "phone": "Telefono", "bluetooth": "Bluetooth", "minimize": "Riduci", "microphone": "Microfono", "camera": "Fotocamera", "flipCamera": "Cambia fotocamera", "addPerson": "Aggiungi persona", "leaveCall": "Esci dalla chiamata", "loadingContacts": "Caricamento contatti…", "noContacts": "Nessun contatto disponibile", "addToCall": "Aggiungi alla chiamata", "calling": "Chiamata a {name}…", "couldNotCall": "Impossibile chiamare", "cancel": "Annulla"],
        "ja": ["connecting": "接続中…", "reconnecting": "再接続中…", "connected": "接続済み", "noAnswer": "応答がありません", "noConnection": "接続できません", "connectionFailed": "接続に失敗しました", "waitingOthers": "他の参加者を待っています…", "participants": "参加者{n}人", "participantsOne": "参加者1人", "groupCall": "グループ通話", "you": "あなた", "meeting": "ミーティング", "share": "共有", "add": "追加", "more": "その他", "react": "リアクション", "moreOptions": "その他のオプション", "participantsList": "参加者リスト（{n}）", "audioOutput": "オーディオ出力", "speaker": "スピーカー", "phone": "電話", "bluetooth": "Bluetooth", "minimize": "最小化", "microphone": "マイク", "camera": "カメラ", "flipCamera": "カメラを切り替え", "addPerson": "ユーザーを追加", "leaveCall": "通話から退出", "loadingContacts": "連絡先を読み込み中…", "noContacts": "利用できる連絡先がありません", "addToCall": "通話に追加", "calling": "{name}に発信中…", "couldNotCall": "発信できませんでした", "cancel": "キャンセル"],
        "ar": ["connecting": "جارٍ الاتصال…", "reconnecting": "جارٍ إعادة الاتصال…", "connected": "متصل", "noAnswer": "لم يرد أحد", "noConnection": "لا يوجد اتصال", "connectionFailed": "فشل الاتصال", "waitingOthers": "في انتظار المشاركين الآخرين…", "participants": "{n} مشاركين", "participantsOne": "مشارك واحد", "groupCall": "مكالمة جماعية", "you": "أنت", "meeting": "اجتماع", "share": "مشاركة", "add": "إضافة", "more": "المزيد", "react": "تفاعل", "moreOptions": "خيارات أخرى", "participantsList": "قائمة المشاركين ({n})", "audioOutput": "مخرج الصوت", "speaker": "مكبر الصوت", "phone": "الهاتف", "bluetooth": "بلوتوث", "minimize": "تصغير", "microphone": "الميكروفون", "camera": "الكاميرا", "flipCamera": "تبديل الكاميرا", "addPerson": "إضافة شخص", "leaveCall": "مغادرة المكالمة", "loadingContacts": "جارٍ تحميل جهات الاتصال…", "noContacts": "لا توجد جهات اتصال متاحة", "addToCall": "إضافة إلى المكالمة", "calling": "جارٍ الاتصال بـ {name}…", "couldNotCall": "تعذّر الاتصال", "cancel": "إلغاء"],
        "id": ["connecting": "Menghubungkan…", "reconnecting": "Menghubungkan ulang…", "connected": "Terhubung", "noAnswer": "Tidak ada yang menjawab", "noConnection": "Tidak ada koneksi", "connectionFailed": "Koneksi gagal", "waitingOthers": "Menunggu peserta lain…", "participants": "{n} peserta", "participantsOne": "1 peserta", "groupCall": "Panggilan grup", "you": "Anda", "meeting": "Rapat", "share": "Bagikan", "add": "Tambah", "more": "Lainnya", "react": "Reaksi", "moreOptions": "Opsi lainnya", "participantsList": "Daftar peserta ({n})", "audioOutput": "Output audio", "speaker": "Speaker", "phone": "Telepon", "bluetooth": "Bluetooth", "minimize": "Perkecil", "microphone": "Mikrofon", "camera": "Kamera", "flipCamera": "Balik kamera", "addPerson": "Tambah orang", "leaveCall": "Keluar dari panggilan", "loadingContacts": "Memuat kontak…", "noContacts": "Tidak ada kontak tersedia", "addToCall": "Tambahkan ke panggilan", "calling": "Memanggil {name}…", "couldNotCall": "Tidak dapat memanggil", "cancel": "Batal"],
        "hi": ["connecting": "कनेक्ट हो रहा है…", "reconnecting": "फिर से कनेक्ट हो रहा है…", "connected": "कनेक्ट हो गया", "noAnswer": "किसी ने जवाब नहीं दिया", "noConnection": "कोई कनेक्शन नहीं", "connectionFailed": "कनेक्शन विफल", "waitingOthers": "अन्य प्रतिभागियों की प्रतीक्षा…", "participants": "{n} प्रतिभागी", "participantsOne": "1 प्रतिभागी", "groupCall": "ग्रुप कॉल", "you": "आप", "meeting": "मीटिंग", "share": "शेयर करें", "add": "जोड़ें", "more": "और", "react": "प्रतिक्रिया", "moreOptions": "और विकल्प", "participantsList": "प्रतिभागियों की सूची ({n})", "audioOutput": "ऑडियो आउटपुट", "speaker": "स्पीकर", "phone": "फ़ोन", "bluetooth": "ब्लूटूथ", "minimize": "छोटा करें", "microphone": "माइक्रोफ़ोन", "camera": "कैमरा", "flipCamera": "कैमरा बदलें", "addPerson": "व्यक्ति जोड़ें", "leaveCall": "कॉल छोड़ें", "loadingContacts": "संपर्क लोड हो रहे हैं…", "noContacts": "कोई संपर्क उपलब्ध नहीं", "addToCall": "कॉल में जोड़ें", "calling": "{name} को कॉल किया जा रहा है…", "couldNotCall": "कॉल नहीं हो सका", "cancel": "रद्द करें"],
    ]

    /// Texto da chave no idioma atual; {n}/{name} substituídos por `args`.
    static func s(_ key: String, _ args: [String: String] = [:]) -> String {
        let l = lang
        var out = table[l]?[key] ?? table["en"]?[key] ?? key
        for (k, v) in args { out = out.replacingOccurrences(of: "{" + k + "}", with: v) }
        return out
    }

    static func participants(_ n: Int) -> String {
        return n == 1 ? s("participantsOne") : s("participants", ["n": String(n)])
    }

    static var connecting: String { s("connecting") }
    static var reconnecting: String { s("reconnecting") }
    /// Também é o "estado conectado" comparado pela GroupCallView.
    static var connected: String { s("connected") }
    static var noAnswer: String { s("noAnswer") }
    static var noConnection: String { s("noConnection") }
    static var connectionFailed: String { s("connectionFailed") }
    static var waitingOthers: String { s("waitingOthers") }
    static var groupCall: String { s("groupCall") }
    static var you: String { s("you") }
    static var meeting: String { s("meeting") }
    static var share: String { s("share") }
    static var add: String { s("add") }
    static var more: String { s("more") }
    static var react: String { s("react") }
    static var moreOptions: String { s("moreOptions") }
    static var audioOutput: String { s("audioOutput") }
    static var speaker: String { s("speaker") }
    static var phone: String { s("phone") }
    static var bluetooth: String { s("bluetooth") }
    static func participantsList(_ n: Int) -> String { s("participantsList", ["n": String(n)]) }
}
