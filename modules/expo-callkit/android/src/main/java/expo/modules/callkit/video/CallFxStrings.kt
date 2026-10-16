package expo.modules.callkit.video

// [2026-10-16 wave13-B efeitos] Textos da folha nativa "Efeitos" (1:1 + grupo)
// nos 63 idiomas do app — mesma tabela do CallFxStrings.swift (iOS). Idioma =
// o do APP (prefs "chatyy_app_lang", espelhado pelo JS) senão o do sistema;
// fora da lista → inglês. Gerado por script.

import android.content.Context
import java.util.Locale

object CallFxStrings {
  private val KEYS = listOf("title", "none", "background", "light", "blurLight", "blurStrong", "gallery", "retouch", "lowLight", "pausedHeat", "pausedBattery", "camOff", "bgN")

  private val T: Map<String, Array<String>> by lazy {
    mapOf(
      "pt-BR" to arrayOf("Efeitos", "Nenhum", "Fundo", "Luz", "Desfoque leve", "Desfoque forte", "Galeria", "Retoque", "Pouca luz", "Efeitos pausados: aparelho quente", "Efeitos pausados: bateria fraca", "Ligue a câmera para usar efeitos", "Fundo {n}"),
      "pt-PT" to arrayOf("Efeitos", "Nenhum", "Fundo", "Luz", "Desfocagem leve", "Desfocagem forte", "Galeria", "Retoque", "Pouca luz", "Efeitos em pausa: aparelho quente", "Efeitos em pausa: bateria fraca", "Ligue a câmara para usar efeitos", "Fundo {n}"),
      "en" to arrayOf("Effects", "None", "Background", "Light", "Light blur", "Strong blur", "Gallery", "Touch up", "Low light", "Effects paused: device is hot", "Effects paused: low battery", "Turn on your camera to use effects", "Background {n}"),
      "es" to arrayOf("Efectos", "Ninguno", "Fondo", "Luz", "Desenfoque leve", "Desenfoque fuerte", "Galería", "Retoque", "Poca luz", "Efectos en pausa: dispositivo caliente", "Efectos en pausa: batería baja", "Activa la cámara para usar efectos", "Fondo {n}"),
      "fr" to arrayOf("Effets", "Aucun", "Arrière-plan", "Lumière", "Flou léger", "Flou fort", "Galerie", "Retouche", "Faible luminosité", "Effets en pause : appareil chaud", "Effets en pause : batterie faible", "Activez la caméra pour utiliser les effets", "Arrière-plan {n}"),
      "de" to arrayOf("Effekte", "Keiner", "Hintergrund", "Licht", "Leichte Unschärfe", "Starke Unschärfe", "Galerie", "Retusche", "Wenig Licht", "Effekte pausiert: Gerät ist heiß", "Effekte pausiert: Akku schwach", "Schalte die Kamera ein, um Effekte zu nutzen", "Hintergrund {n}"),
      "it" to arrayOf("Effetti", "Nessuno", "Sfondo", "Luce", "Sfocatura leggera", "Sfocatura forte", "Galleria", "Ritocco", "Poca luce", "Effetti in pausa: dispositivo caldo", "Effetti in pausa: batteria scarica", "Attiva la fotocamera per usare gli effetti", "Sfondo {n}"),
      "ja" to arrayOf("エフェクト", "なし", "背景", "ライト", "ぼかし(弱)", "ぼかし(強)", "ギャラリー", "美肌", "暗い場所", "エフェクト一時停止:端末が高温です", "エフェクト一時停止:バッテリー残量低下", "エフェクトを使うにはカメラをオンにしてください", "背景 {n}"),
      "ar" to arrayOf("التأثيرات", "بلا", "الخلفية", "الإضاءة", "تمويه خفيف", "تمويه قوي", "المعرض", "تحسين", "إضاءة منخفضة", "تم إيقاف التأثيرات مؤقتًا: الجهاز ساخن", "تم إيقاف التأثيرات مؤقتًا: البطارية منخفضة", "شغّل الكاميرا لاستخدام التأثيرات", "الخلفية {n}"),
      "id" to arrayOf("Efek", "Tidak ada", "Latar", "Cahaya", "Blur ringan", "Blur kuat", "Galeri", "Perhalus", "Cahaya redup", "Efek dijeda: perangkat panas", "Efek dijeda: baterai lemah", "Nyalakan kamera untuk memakai efek", "Latar {n}"),
      "hi" to arrayOf("इफ़ेक्ट", "कोई नहीं", "बैकग्राउंड", "रोशनी", "हल्का ब्लर", "तेज़ ब्लर", "गैलरी", "टच-अप", "कम रोशनी", "इफ़ेक्ट रुके: डिवाइस गर्म है", "इफ़ेक्ट रुके: बैटरी कम है", "इफ़ेक्ट के लिए कैमरा चालू करें", "बैकग्राउंड {n}"),
      "am" to arrayOf("ውጤቶች", "ምንም", "ዳራ", "ብርሃን", "ቀላል ብዥታ", "ጠንካራ ብዥታ", "ማዕከለ-ስዕላት", "ማሳመር", "ዝቅተኛ ብርሃን", "ውጤቶች ቆመዋል፦ መሣሪያው ሞቋል", "ውጤቶች ቆመዋል፦ ባትሪ ዝቅተኛ ነው", "ውጤቶችን ለመጠቀም ካሜራውን ያብሩ", "ዳራ {n}"),
      "az" to arrayOf("Effektlər", "Heç biri", "Fon", "İşıq", "Yüngül bulanıqlıq", "Güclü bulanıqlıq", "Qalereya", "Rötuş", "Zəif işıq", "Effektlər dayandırıldı: cihaz qızıb", "Effektlər dayandırıldı: batareya azdır", "Effektlərdən istifadə üçün kameranı yandırın", "Fon {n}"),
      "bg" to arrayOf("Ефекти", "Без", "Фон", "Светлина", "Леко размазване", "Силно размазване", "Галерия", "Ретуш", "Слаба светлина", "Ефектите са на пауза: устройството е горещо", "Ефектите са на пауза: слаба батерия", "Включете камерата, за да използвате ефекти", "Фон {n}"),
      "bn" to arrayOf("ইফেক্ট", "কিছু না", "ব্যাকগ্রাউন্ড", "আলো", "হালকা ব্লার", "গাঢ় ব্লার", "গ্যালারি", "টাচ-আপ", "কম আলো", "ইফেক্ট থামানো: ডিভাইস গরম", "ইফেক্ট থামানো: ব্যাটারি কম", "ইফেক্ট ব্যবহার করতে ক্যামেরা চালু করুন", "ব্যাকগ্রাউন্ড {n}"),
      "ca" to arrayOf("Efectes", "Cap", "Fons", "Llum", "Desenfocament lleu", "Desenfocament fort", "Galeria", "Retoc", "Poca llum", "Efectes en pausa: dispositiu calent", "Efectes en pausa: bateria baixa", "Activa la càmera per fer servir efectes", "Fons {n}"),
      "cs" to arrayOf("Efekty", "Žádný", "Pozadí", "Světlo", "Mírné rozmazání", "Silné rozmazání", "Galerie", "Retuš", "Slabé světlo", "Efekty pozastaveny: zařízení je horké", "Efekty pozastaveny: slabá baterie", "Pro efekty zapněte kameru", "Pozadí {n}"),
      "da" to arrayOf("Effekter", "Ingen", "Baggrund", "Lys", "Let sløring", "Kraftig sløring", "Galleri", "Retouchering", "Svagt lys", "Effekter sat på pause: enheden er varm", "Effekter sat på pause: lavt batteri", "Slå kameraet til for at bruge effekter", "Baggrund {n}"),
      "el" to arrayOf("Εφέ", "Κανένα", "Φόντο", "Φως", "Ελαφρύ θόλωμα", "Έντονο θόλωμα", "Συλλογή", "Ρετούς", "Χαμηλός φωτισμός", "Τα εφέ σε παύση: η συσκευή ζεστάθηκε", "Τα εφέ σε παύση: χαμηλή μπαταρία", "Ενεργοποιήστε την κάμερα για να χρησιμοποιήσετε εφέ", "Φόντο {n}"),
      "et" to arrayOf("Efektid", "Puudub", "Taust", "Valgus", "Kerge hägustus", "Tugev hägustus", "Galerii", "Retušš", "Vähene valgus", "Efektid peatatud: seade on kuum", "Efektid peatatud: aku on tühjenemas", "Efektide kasutamiseks lülita kaamera sisse", "Taust {n}"),
      "fa" to arrayOf("جلوه‌ها", "هیچ", "پس‌زمینه", "نور", "محوی ملایم", "محوی شدید", "گالری", "روتوش", "نور کم", "جلوه‌ها متوقف شد: دستگاه داغ است", "جلوه‌ها متوقف شد: باتری ضعیف است", "برای استفاده از جلوه‌ها دوربین را روشن کنید", "پس‌زمینه {n}"),
      "fi" to arrayOf("Tehosteet", "Ei mitään", "Tausta", "Valo", "Kevyt sumennus", "Vahva sumennus", "Galleria", "Kaunistus", "Hämärä", "Tehosteet tauolla: laite on kuuma", "Tehosteet tauolla: akku vähissä", "Käytä tehosteita laittamalla kamera päälle", "Tausta {n}"),
      "fil" to arrayOf("Mga effect", "Wala", "Background", "Ilaw", "Bahagyang blur", "Malakas na blur", "Gallery", "Touch up", "Mahinang ilaw", "Naka-pause ang effects: mainit ang device", "Naka-pause ang effects: mahina ang baterya", "I-on ang camera para gumamit ng effects", "Background {n}"),
      "gu" to arrayOf("ઇફેક્ટ્સ", "કોઈ નહીં", "પૃષ્ઠભૂમિ", "પ્રકાશ", "હળવું બ્લર", "ઘાટું બ્લર", "ગેલેરી", "ટચ-અપ", "ઓછો પ્રકાશ", "ઇફેક્ટ્સ થોભાવી: ઉપકરણ ગરમ છે", "ઇફેક્ટ્સ થોભાવી: બેટરી ઓછી છે", "ઇફેક્ટ્સ માટે કૅમેરા ચાલુ કરો", "પૃષ્ઠભૂમિ {n}"),
      "he" to arrayOf("אפקטים", "ללא", "רקע", "תאורה", "טשטוש קל", "טשטוש חזק", "גלריה", "ריטוש", "תאורה חלשה", "האפקטים הושהו: המכשיר חם", "האפקטים הושהו: סוללה חלשה", "הפעילו את המצלמה כדי להשתמש באפקטים", "רקע {n}"),
      "hr" to arrayOf("Efekti", "Ništa", "Pozadina", "Svjetlo", "Blago zamućenje", "Jako zamućenje", "Galerija", "Retuš", "Slabo svjetlo", "Efekti pauzirani: uređaj je vruć", "Efekti pauzirani: slaba baterija", "Uključite kameru za efekte", "Pozadina {n}"),
      "hu" to arrayOf("Effektek", "Nincs", "Háttér", "Fény", "Enyhe elmosás", "Erős elmosás", "Galéria", "Retus", "Gyenge fény", "Effektek szüneteltetve: az eszköz forró", "Effektek szüneteltetve: alacsony akkumulátor", "Az effektekhez kapcsold be a kamerát", "Háttér {n}"),
      "hy" to arrayOf("Էֆեկտներ", "Ոչ մեկը", "Ֆոն", "Լույս", "Թեթև լղոզում", "Ուժեղ լղոզում", "Պատկերասրահ", "Ռետուշ", "Թույլ լույս", "Էֆեկտները դադարեցված են. սարքը տաք է", "Էֆեկտները դադարեցված են. մարտկոցը լիցքաթափվում է", "Միացրեք տեսախցիկը՝ էֆեկտներ օգտագործելու համար", "Ֆոն {n}"),
      "ka" to arrayOf("ეფექტები", "არცერთი", "ფონი", "სინათლე", "მსუბუქი გაბუნდოვნება", "ძლიერი გაბუნდოვნება", "გალერეა", "რეტუში", "სუსტი განათება", "ეფექტები შეჩერდა: მოწყობილობა გაცხელდა", "ეფექტები შეჩერდა: ბატარეა იწურება", "ეფექტებისთვის ჩართეთ კამერა", "ფონი {n}"),
      "kk" to arrayOf("Әсерлер", "Жоқ", "Фон", "Жарық", "Жеңіл бұлыңғырлық", "Күшті бұлыңғырлық", "Галерея", "Ретушь", "Әлсіз жарық", "Әсерлер кідіртілді: құрылғы қызып кетті", "Әсерлер кідіртілді: батарея аз", "Әсерлерді қолдану үшін камераны қосыңыз", "Фон {n}"),
      "km" to arrayOf("បែបផែន", "គ្មាន", "ផ្ទៃខាងក្រោយ", "ពន្លឺ", "ព្រិលស្រាល", "ព្រិលខ្លាំង", "វិចិត្រសាល", "កែលម្អ", "ពន្លឺតិច", "បែបផែនបានផ្អាក៖ ឧបករណ៍ក្តៅ", "បែបផែនបានផ្អាក៖ ថ្មខ្សោយ", "បើកកាមេរ៉ាដើម្បីប្រើបែបផែន", "ផ្ទៃខាងក្រោយ {n}"),
      "kn" to arrayOf("ಎಫೆಕ್ಟ್‌ಗಳು", "ಯಾವುದೂ ಇಲ್ಲ", "ಹಿನ್ನೆಲೆ", "ಬೆಳಕು", "ಸ್ವಲ್ಪ ಬ್ಲರ್", "ಹೆಚ್ಚು ಬ್ಲರ್", "ಗ್ಯಾಲರಿ", "ಟಚ್-ಅಪ್", "ಕಡಿಮೆ ಬೆಳಕು", "ಎಫೆಕ್ಟ್‌ಗಳು ವಿರಾಮ: ಸಾಧನ ಬಿಸಿಯಾಗಿದೆ", "ಎಫೆಕ್ಟ್‌ಗಳು ವಿರಾಮ: ಬ್ಯಾಟರಿ ಕಡಿಮೆ", "ಎಫೆಕ್ಟ್‌ಗಳಿಗಾಗಿ ಕ್ಯಾಮೆರಾ ಆನ್ ಮಾಡಿ", "ಹಿನ್ನೆಲೆ {n}"),
      "ko" to arrayOf("효과", "없음", "배경", "조명", "약한 흐림", "강한 흐림", "갤러리", "보정", "저조도", "효과 일시 중지됨: 기기 과열", "효과 일시 중지됨: 배터리 부족", "효과를 사용하려면 카메라를 켜세요", "배경 {n}"),
      "lo" to arrayOf("ເອັບເຟັກ", "ບໍ່ມີ", "ພື້ນຫຼັງ", "ແສງ", "ມົວເລັກນ້ອຍ", "ມົວຫຼາຍ", "ຄັງຮູບ", "ແຕ່ງໜ້າ", "ແສງໜ້ອຍ", "ຢຸດເອັບເຟັກຊົ່ວຄາວ: ອຸປະກອນຮ້ອນ", "ຢຸດເອັບເຟັກຊົ່ວຄາວ: ແບັດເຕີຣີຕ່ຳ", "ເປີດກ້ອງເພື່ອໃຊ້ເອັບເຟັກ", "ພື້ນຫຼັງ {n}"),
      "lt" to arrayOf("Efektai", "Nėra", "Fonas", "Šviesa", "Lengvas suliejimas", "Stiprus suliejimas", "Galerija", "Retušas", "Silpnas apšvietimas", "Efektai pristabdyti: įrenginys įkaito", "Efektai pristabdyti: senka baterija", "Įjunkite kamerą, kad naudotumėte efektus", "Fonas {n}"),
      "lv" to arrayOf("Efekti", "Nav", "Fons", "Gaisma", "Viegla izpludināšana", "Spēcīga izpludināšana", "Galerija", "Retušēšana", "Vājš apgaismojums", "Efekti apturēti: ierīce ir karsta", "Efekti apturēti: zems akumulatora līmenis", "Ieslēdziet kameru, lai izmantotu efektus", "Fons {n}"),
      "ml" to arrayOf("ഇഫക്റ്റുകൾ", "ഒന്നുമില്ല", "പശ്ചാത്തലം", "വെളിച്ചം", "ലഘു ബ്ലർ", "കൂടിയ ബ്ലർ", "ഗാലറി", "ടച്ച്-അപ്പ്", "കുറഞ്ഞ വെളിച്ചം", "ഇഫക്റ്റുകൾ നിർത്തി: ഉപകരണം ചൂടായി", "ഇഫക്റ്റുകൾ നിർത്തി: ബാറ്ററി കുറവ്", "ഇഫക്റ്റുകൾക്കായി ക്യാമറ ഓണാക്കുക", "പശ്ചാത്തലം {n}"),
      "mn" to arrayOf("Эффектүүд", "Байхгүй", "Дэвсгэр", "Гэрэл", "Бага бүдгэрүүлэх", "Хүчтэй бүдгэрүүлэх", "Галерей", "Засвар", "Бүдэг гэрэл", "Эффект түр зогссон: төхөөрөмж халсан", "Эффект түр зогссон: батарей сул", "Эффект ашиглахын тулд камераа асаана уу", "Дэвсгэр {n}"),
      "mr" to arrayOf("इफेक्ट्स", "काहीही नाही", "पार्श्वभूमी", "प्रकाश", "हलका ब्लर", "जास्त ब्लर", "गॅलरी", "टच-अप", "कमी प्रकाश", "इफेक्ट्स थांबवले: डिव्हाइस गरम आहे", "इफेक्ट्स थांबवले: बॅटरी कमी आहे", "इफेक्ट्ससाठी कॅमेरा चालू करा", "पार्श्वभूमी {n}"),
      "ms" to arrayOf("Kesan", "Tiada", "Latar", "Cahaya", "Kabur ringan", "Kabur kuat", "Galeri", "Solek", "Cahaya malap", "Kesan dijeda: peranti panas", "Kesan dijeda: bateri lemah", "Hidupkan kamera untuk menggunakan kesan", "Latar {n}"),
      "my" to arrayOf("အထူးပြုချက်များ", "မရှိ", "နောက်ခံ", "အလင်း", "အနည်းငယ်ဝါးခြင်း", "အပြင်းဝါးခြင်း", "ပြခန်း", "ပြင်ဆင်", "အလင်းနည်း", "အထူးပြုချက် ခဏရပ်: စက်ပူနေသည်", "အထူးပြုချက် ခဏရပ်: ဘက်ထရီနည်းနေသည်", "အထူးပြုချက်သုံးရန် ကင်မရာဖွင့်ပါ", "နောက်ခံ {n}"),
      "nb" to arrayOf("Effekter", "Ingen", "Bakgrunn", "Lys", "Lett uskarphet", "Kraftig uskarphet", "Galleri", "Retusjering", "Svakt lys", "Effekter satt på pause: enheten er varm", "Effekter satt på pause: lavt batteri", "Slå på kameraet for å bruke effekter", "Bakgrunn {n}"),
      "ne" to arrayOf("इफेक्टहरू", "कुनै पनि होइन", "पृष्ठभूमि", "प्रकाश", "हल्का ब्लर", "बढी ब्लर", "ग्यालेरी", "टच-अप", "कम प्रकाश", "इफेक्ट रोकियो: उपकरण तातेको छ", "इफेक्ट रोकियो: ब्याट्री कम छ", "इफेक्ट प्रयोग गर्न क्यामेरा खोल्नुहोस्", "पृष्ठभूमि {n}"),
      "nl" to arrayOf("Effecten", "Geen", "Achtergrond", "Licht", "Licht vervagen", "Sterk vervagen", "Galerij", "Retoucheren", "Weinig licht", "Effecten gepauzeerd: apparaat is warm", "Effecten gepauzeerd: batterij bijna leeg", "Zet je camera aan om effecten te gebruiken", "Achtergrond {n}"),
      "pa" to arrayOf("ਇਫੈਕਟ", "ਕੋਈ ਨਹੀਂ", "ਪਿਛੋਕੜ", "ਰੋਸ਼ਨੀ", "ਹਲਕਾ ਬਲਰ", "ਗੂੜ੍ਹਾ ਬਲਰ", "ਗੈਲਰੀ", "ਟੱਚ-ਅੱਪ", "ਘੱਟ ਰੋਸ਼ਨੀ", "ਇਫੈਕਟ ਰੋਕੇ: ਡਿਵਾਈਸ ਗਰਮ ਹੈ", "ਇਫੈਕਟ ਰੋਕੇ: ਬੈਟਰੀ ਘੱਟ ਹੈ", "ਇਫੈਕਟ ਲਈ ਕੈਮਰਾ ਚਾਲੂ ਕਰੋ", "ਪਿਛੋਕੜ {n}"),
      "pl" to arrayOf("Efekty", "Brak", "Tło", "Światło", "Lekkie rozmycie", "Mocne rozmycie", "Galeria", "Retusz", "Słabe światło", "Efekty wstrzymane: urządzenie jest gorące", "Efekty wstrzymane: słaba bateria", "Włącz kamerę, aby używać efektów", "Tło {n}"),
      "ro" to arrayOf("Efecte", "Niciunul", "Fundal", "Lumină", "Estompare ușoară", "Estompare puternică", "Galerie", "Retușare", "Lumină slabă", "Efecte întrerupte: dispozitivul e fierbinte", "Efecte întrerupte: baterie descărcată", "Pornește camera pentru a folosi efecte", "Fundal {n}"),
      "ru" to arrayOf("Эффекты", "Нет", "Фон", "Свет", "Лёгкое размытие", "Сильное размытие", "Галерея", "Ретушь", "Слабый свет", "Эффекты приостановлены: устройство нагрелось", "Эффекты приостановлены: низкий заряд", "Включите камеру, чтобы использовать эффекты", "Фон {n}"),
      "si" to arrayOf("ප්‍රයෝග", "කිසිවක් නැත", "පසුබිම", "ආලෝකය", "සැහැල්ලු බොඳ කිරීම", "තද බොඳ කිරීම", "ගැලරිය", "සැකසීම", "අඩු ආලෝකය", "ප්‍රයෝග විරාම කළා: උපාංගය උණුසුම්", "ප්‍රයෝග විරාම කළා: බැටරිය අඩුයි", "ප්‍රයෝග භාවිතයට කැමරාව සක්‍රිය කරන්න", "පසුබිම {n}"),
      "sk" to arrayOf("Efekty", "Žiadny", "Pozadie", "Svetlo", "Mierne rozmazanie", "Silné rozmazanie", "Galéria", "Retuš", "Slabé svetlo", "Efekty pozastavené: zariadenie je horúce", "Efekty pozastavené: slabá batéria", "Ak chcete použiť efekty, zapnite kameru", "Pozadie {n}"),
      "sl" to arrayOf("Učinki", "Brez", "Ozadje", "Svetloba", "Rahla zameglitev", "Močna zameglitev", "Galerija", "Retuširanje", "Šibka svetloba", "Učinki zaustavljeni: naprava je vroča", "Učinki zaustavljeni: baterija je skoraj prazna", "Za učinke vklopite kamero", "Ozadje {n}"),
      "sr" to arrayOf("Ефекти", "Без", "Позадина", "Светло", "Благо замућење", "Јако замућење", "Галерија", "Ретуш", "Слабо светло", "Ефекти паузирани: уређај је врућ", "Ефекти паузирани: батерија је слаба", "Укључите камеру да бисте користили ефекте", "Позадина {n}"),
      "sv" to arrayOf("Effekter", "Ingen", "Bakgrund", "Ljus", "Lätt oskärpa", "Kraftig oskärpa", "Galleri", "Retuschering", "Svagt ljus", "Effekter pausade: enheten är varm", "Effekter pausade: lågt batteri", "Slå på kameran för att använda effekter", "Bakgrund {n}"),
      "sw" to arrayOf("Madoido", "Hakuna", "Mandharinyuma", "Mwanga", "Ukungu kidogo", "Ukungu mkubwa", "Matunzio", "Kurembesha", "Mwanga hafifu", "Madoido yamesitishwa: kifaa kina joto", "Madoido yamesitishwa: betri iko chini", "Washa kamera ili kutumia madoido", "Mandharinyuma {n}"),
      "ta" to arrayOf("எஃபெக்ட்கள்", "ஏதுமில்லை", "பின்னணி", "ஒளி", "லேசான மங்கல்", "அதிக மங்கல்", "கேலரி", "டச்-அப்", "குறைந்த ஒளி", "எஃபெக்ட்கள் இடைநிறுத்தம்: சாதனம் சூடாக உள்ளது", "எஃபெக்ட்கள் இடைநிறுத்தம்: பேட்டரி குறைவு", "எஃபெக்ட்களுக்கு கேமராவை இயக்கவும்", "பின்னணி {n}"),
      "te" to arrayOf("ఎఫెక్ట్‌లు", "ఏదీ లేదు", "నేపథ్యం", "వెలుతురు", "తేలికపాటి బ్లర్", "ఎక్కువ బ్లర్", "గ్యాలరీ", "టచ్-అప్", "తక్కువ వెలుతురు", "ఎఫెక్ట్‌లు ఆపబడ్డాయి: పరికరం వేడిగా ఉంది", "ఎఫెక్ట్‌లు ఆపబడ్డాయి: బ్యాటరీ తక్కువ", "ఎఫెక్ట్‌ల కోసం కెమెరా ఆన్ చేయండి", "నేపథ్యం {n}"),
      "th" to arrayOf("เอฟเฟกต์", "ไม่มี", "พื้นหลัง", "แสง", "เบลอเล็กน้อย", "เบลอมาก", "แกลเลอรี", "ปรับผิว", "แสงน้อย", "หยุดเอฟเฟกต์ชั่วคราว: อุปกรณ์ร้อน", "หยุดเอฟเฟกต์ชั่วคราว: แบตเตอรี่ต่ำ", "เปิดกล้องเพื่อใช้เอฟเฟกต์", "พื้นหลัง {n}"),
      "tr" to arrayOf("Efektler", "Yok", "Arka plan", "Işık", "Hafif bulanıklık", "Güçlü bulanıklık", "Galeri", "Rötuş", "Düşük ışık", "Efektler duraklatıldı: cihaz ısındı", "Efektler duraklatıldı: pil zayıf", "Efektleri kullanmak için kamerayı açın", "Arka plan {n}"),
      "uk" to arrayOf("Ефекти", "Немає", "Фон", "Світло", "Легке розмиття", "Сильне розмиття", "Галерея", "Ретуш", "Слабке світло", "Ефекти призупинено: пристрій нагрівся", "Ефекти призупинено: низький заряд", "Увімкніть камеру, щоб використовувати ефекти", "Фон {n}"),
      "ur" to arrayOf("ایفیکٹس", "کوئی نہیں", "پس منظر", "روشنی", "ہلکا بلر", "گہرا بلر", "گیلری", "ٹچ اپ", "کم روشنی", "ایفیکٹس روک دیے گئے: ڈیوائس گرم ہے", "ایفیکٹس روک دیے گئے: بیٹری کم ہے", "ایفیکٹس کے لیے کیمرا آن کریں", "پس منظر {n}"),
      "uz" to arrayOf("Effektlar", "Yoʻq", "Fon", "Yorugʻlik", "Yengil xiralik", "Kuchli xiralik", "Galereya", "Retush", "Kam yorugʻlik", "Effektlar pauzada: qurilma qizib ketdi", "Effektlar pauzada: batareya kam", "Effektlardan foydalanish uchun kamerani yoqing", "Fon {n}"),
      "vi" to arrayOf("Hiệu ứng", "Không", "Nền", "Ánh sáng", "Làm mờ nhẹ", "Làm mờ mạnh", "Thư viện", "Làm đẹp", "Thiếu sáng", "Đã tạm dừng hiệu ứng: thiết bị nóng", "Đã tạm dừng hiệu ứng: pin yếu", "Bật camera để dùng hiệu ứng", "Nền {n}"),
      "zh-CN" to arrayOf("效果", "无", "背景", "光线", "轻度模糊", "重度模糊", "相册", "美颜", "弱光", "效果已暂停：设备过热", "效果已暂停：电量不足", "打开摄像头以使用效果", "背景 {n}"),
    )
  }

  fun resolve(raw: String?): String {
    val c = (raw ?: "").replace('_', '-').lowercase(Locale.ROOT)
    if (c.isEmpty()) return "en"
    if (c.startsWith("pt-pt") || c == "pt-ao" || c == "pt-mz") return "pt-PT"
    if (c.startsWith("pt")) return "pt-BR"
    if (c.startsWith("zh")) return "zh-CN"
    val base = c.substringBefore('-')
    return when (base) {
      "in" -> "id"
      "iw" -> "he"
      "tl" -> "fil"
      "no", "nn" -> "nb"
      else -> if (T.containsKey(base)) base else "en"
    }
  }

  @Volatile private var appCtx: Context? = null

  /** Keeps the app context; the language pref is re-read on every lookup
   *  (SharedPreferences are memory-cached) so a language switch applies. */
  fun load(ctx: Context?) {
    if (ctx != null && appCtx == null) appCtx = ctx.applicationContext
  }

  fun lang(): String {
    val a = try {
      appCtx?.getSharedPreferences("expo_callkit_prefs", Context.MODE_PRIVATE)?.getString("chatyy_app_lang", null)
    } catch (_: Throwable) { null }
    if (!a.isNullOrEmpty()) return resolve(a)
    val sys = try { Locale.getDefault().toLanguageTag() } catch (_: Throwable) { "en" }
    return resolve(sys)
  }

  fun s(key: String, vararg args: Pair<String, String>): String {
    val idx = KEYS.indexOf(key)
    if (idx < 0) return key
    val row = T[lang()] ?: T["en"]
    var out = if (row != null && idx < row.size) row[idx] else key
    for ((k, v) in args) out = out.replace("{" + k + "}", v)
    return out
  }
}
