import UserNotifications
import Intents
import ImageIO
import CryptoKit

/// Chatyy Notification Service Extension (UNNotificationServiceExtension).
///
/// Runs on EVERY chat push (backend sets mutable-content=1) — app killed or not:
///   1. Delivered-on-receipt: POST the signed `d_ack` → sender sees ✓✓ gray.
///   2. [2026-10-07 recv-native] Communication Notification (WhatsApp/iMessage
///      look): INSendMessageIntent + INPerson with the sender's avatar (group
///      photo + group name for groups), donated, then content.updating(from:).
///      Needs the "Communication Notifications" capability on the APP
///      (com.apple.developer.usernotifications.communication) + Info.plist
///      NSUserActivityTypes=[INSendMessageIntent]. Without the entitlement
///      updating(from:) throws → we fall back to the classic banner with the
///      avatar as a thumbnail attachment (previous behavior).
///   3. thread-identifier = chat_<conversation> (one stack per conversation)
///      and category chat_message / chat_mention (Responder / Marcar como lida).
///   4. Rich media: photo/video poster attached (never the avatar when the
///      communication layout already shows it).
///   5. [2026-10-11] App-icon badge kept right with the app killed (server
///      aps.badge + App Group counter — see applyBadge) and the message is
///      journaled into the App Group (journalMessage) for instant open.
///   0. [push-minimo 2026-10-24] Push MÍNIMO (pmin=1): só o aviso chega pela Apple; a mensagem real vem
///      do chat_push_fetch (ChatyyNSEMini em NotificationServiceE2EE.swift) antes de tudo abaixo.
///   6. [e2ee5 WP-10 2026-10-21] E2EE push (e2e=5): decrypted on-device with the
///      chatyy-crypto core (role Push) → real sender + preview, ≤ ChatyyNSEE2EE.deadline,
///      else the server's generic "Nova mensagem". Code: NotificationServiceE2EE.swift
///      (appended to this file by with-notification-service.js; stub without the core).
///
/// Limits respected: ~30 s wall time (each download ≤ 8 s, everything in
/// parallel, serviceExtensionTimeWillExpire delivers the best attempt) and the
/// ~24 MB memory ceiling (media is streamed to disk; avatars are downsampled
/// with ImageIO to 256 px and never decoded at full size; 3 MB cap).
///
/// Payload shapes: FCM-direct puts our data at top level; Expo puts it in a
/// "body" DICTIONARY (sometimes a JSON string) — both are merged here.
///
/// Source of truth: plugins/notification-service/NotificationService.swift
/// (copied into ios/ChatyyNotificationService/ by with-notification-service.js).
class NotificationService: UNNotificationServiceExtension {

    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?
    private var tasks: [URLSessionTask] = []
    private var delivered = false
    private let lock = NSLock()

    private static let chatTypes: Set<String> = ["chat_message", "chat_mention", "chat_keyword", "chat_reaction"]
    private static let downloadTimeout: TimeInterval = 8
    // [push-preview 2026-10-21] banner: folga máx. p/ o POST do ✓✓ e prazo p/ avatar/mídia.
    private static let ackGrace: TimeInterval = 0.35
    private static let bannerDeadline: TimeInterval = 3.0
    private static let maxAvatarBytes = 3 * 1024 * 1024
    // [2026-10-23 push-rapido item 6] TEXTO PRIMEIRO: o banner sai assim que o texto está pronto
    // (claro = já no payload; E2EE = decifrado) e avatar/mídia só entram se chegarem até
    // mediaBudget (contado do didReceive); senão entrega sem eles (o download segue e o avatar
    // fica no cache p/ o próximo push). Antes o banner esperava avatar/mídia até bannerDeadline (3 s).
    // Kill: App Group "chatyy.nse.text_first" = "0" → comportamento antigo.
    // Orçamento: App Group "chatyy.nse.media_budget_ms" (Int, 100…3000; ausente/0 = padrão).
    private static let mediaBudgetDefaultMs = 700
    private var startedAt = DispatchTime.now()
    private var ptWantMedia = false
    private var ptWantAvatar = false
    private var ptSkipMedia = false
    private var ptSkipAvatar = false
    private var ptTextFirst = false
    private var ptE2E = false
    private var ptExpired = false
    private var ptMini = 0 // [push-minimo 2026-10-24] 0 = push de sempre, 1 = mínimo buscado, 2 = mínimo sem busca (genérico)

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        guard let best = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        self.bestAttemptContent = best
        let t0 = DispatchTime.now()
        self.startedAt = t0

        let p0 = Self.payload(request.content.userInfo)
        // [push-minimo 2026-10-24] Push MÍNIMO (pmin=1: o APNs trouxe só conversa+id+d_ack e o genérico):
        // busca a mensagem real (ChatyyNSEMini, ≤3 s) e só então segue o caminho de sempre com o payload
        // COMPLETO — journal → ✓✓ (persisted) → E2EE pelo e2e_c → Communication Notification. O userInfo
        // entregue ao app ganha o "body" completo (toque abre a conversa certa). Falhou → genérico.
        if ChatyyNSEMini.isMini(p0) {
            lock.lock(); ptMini = 2; lock.unlock()
            ChatyyNSEMini.fetch(p0) { [weak self] full in
                guard let self = self else { return }
                var p = p0
                if let f = full {
                    for (k, v) in f.data { p[k] = v }
                    p["pmin"] = nil
                    if !f.title.isEmpty { best.title = f.title }
                    if !f.body.isEmpty { best.body = f.body }
                    var ui = best.userInfo
                    ui["body"] = f.data
                    if !f.experienceId.isEmpty { ui["experienceId"] = f.experienceId }
                    if !f.scopeKey.isEmpty { ui["scopeKey"] = f.scopeKey }
                    best.userInfo = ui
                    self.lock.lock(); self.ptMini = 1; self.lock.unlock()
                }
                self.proceed(best, p: p, t0: t0)
            }
            return
        }
        proceed(best, p: p0, t0: t0)
    }

    private func proceed(_ best: UNMutableNotificationContent, p: [String: Any], t0: DispatchTime) {
        let fastUD = UserDefaults(suiteName: Self.appGroupId)
        let textFirst = (fastUD?.string(forKey: "chatyy.nse.text_first") ?? "1") != "0"
        let budgetRaw = fastUD?.integer(forKey: "chatyy.nse.media_budget_ms") ?? 0
        let mediaBudget: TimeInterval = Double(budgetRaw > 0 ? min(max(budgetRaw, 100), 3000) : Self.mediaBudgetDefaultMs) / 1000.0
        // [2026-10-13 dack-wait] O POST do ✓✓ entra no MESMO DispatchGroup das
        // mídias: antes era fire-and-forget e, em texto puro (avatar em cache →
        // finish em ms), o iOS podia congelar/matar a extensão logo após o
        // contentHandler, levando o POST junto (APNs 200, sem ✓✓). Limite curto
        // (ackTimeout) — não atrasa o banner de forma perceptível.
        let group = DispatchGroup()
        // [push-preview 2026-10-21] O ✓✓ NÃO segura mais o banner: com RTT alto
        // (4G/roaming ~0,7 s) o POST levava 1-3 s (até ackTimeout = 6 s) e o
        // aviso só aparecia depois → "treme e o push demora". Agora o token vai
        // p/ a fila pendente ANTES do POST (sai dela no 2xx/4xx) e o banner
        // espera no máximo ackGrace: se o iOS congelar a extensão, o próximo
        // push (ou o app) reenvia.
        let ackGroup = DispatchGroup()
        // [2026-10-07 bgsync] Store the message in the App Group journal so the
        // app shows it instantly on open (merged before first paint by
        // services/bgJournal.js). No-op without the App Group entitlement.
        // [2026-10-22 dlv-device] Journal ANTES do ack: o ack diz se a mensagem
        // COMPLETA ficou gravada aqui (persisted=1) e leva o device_id do núcleo.
        let persisted = Self.journalMessage(p)
        Self.stashRcpt(p) // [rcpt-bg 2026-10-24] carona dos recibos (o app aplica ao abrir, antes de pintar)
        Self.reportDelivered(p, persisted: persisted, group: ackGroup) { [weak self] t in self?.addTask(t) }

        let type = Self.str(p, "type") ?? ""
        let isChat = Self.chatTypes.contains(type)
        let conv = Self.str(p, "conversation_id") ?? ""
        let locked = Self.str(p, "locked") == "1"
        let isGroup = Self.isTrue(Self.str(p, "is_group")) || Self.str(p, "conversation_type") == "group"

        // [2026-10-11 badge] App-icon badge correct with the app KILLED: the
        // server's aps.badge (live unread) is trusted, corrected for its 15 s
        // memo / failure-returns-0 cases with an App Group counter the app
        // re-bases on every setBadgeCount (ExpoChatyySystem.setBadgeMirror).
        Self.applyBadge(best, p: p, type: type)

        if isChat && !conv.isEmpty {
            if best.threadIdentifier.isEmpty { best.threadIdentifier = "chat_" + conv }
            if best.categoryIdentifier.isEmpty {
                best.categoryIdentifier = (type == "chat_mention") ? "chat_mention" : "chat_message"
            }
        }

        // [2026-10-09 system-integration] Focus filter tag (ChatyyFocusFilter in
        // the app target, plugins/with-system-intents.js): iOS evaluates the
        // Focus' NSPredicate against this string. Pinned ids come from the App
        // Group (ExpoChatyySystem.setConversations) — absent without the NSE
        // App Group entitlement, then pinned chats fall back to direct/group.
        if #available(iOS 16.0, *) {
            best.filterCriteria = Self.focusCriteria(type: type, conv: conv, isGroup: isGroup)
        }

        let imageIsAvatar = Self.str(p, "image_is_avatar") == "1"
        let mediaURL: URL? = imageIsAvatar ? nil : Self.extractImageURL(from: p)
        let avatarURL: URL? = (isChat && !locked) ? Self.httpsURL(Self.str(p, "sender_avatar")
            ?? (imageIsAvatar ? Self.str(p, "image") : nil)) : nil
        let groupAvatarURL: URL? = (isChat && !locked && isGroup) ? Self.httpsURL(Self.str(p, "group_avatar")) : nil

        var mediaAttachment: UNNotificationAttachment?
        var avatarData: Data?
        var groupAvatarData: Data?
        let resultLock = NSLock()

        // [e2ee5 WP-10 2026-10-21] Conversa E2EE (push com e2e=5): decifra no aparelho (núcleo
        // chatyy-crypto, papel Push) em paralelo com avatar/mídia. Sem núcleo/flag/App Group/store,
        // conversa trancada ou prévia oculta → candidateUid = nil e nada muda (fica "Nova mensagem").
        // O texto decifrado só vai para o conteúdo da notificação (nunca journal/cache/Intent).
        var e2eText: String?
        var e2ePending = false
        // [push-rapido item 6] chamado quando o texto E2EE fica pronto (definido depois do finalize).
        var textReadyHook: (() -> Void)?
        let e2eUid: String? = isChat ? ChatyyNSEE2EE.candidateUid(p, type: type) : nil
        if let uid = e2eUid {
            e2ePending = true
            group.enter()
            ChatyyNSEE2EE.preview(p, uid: uid) { txt in
                resultLock.lock(); e2eText = txt; e2ePending = false; let hook = textReadyHook; resultLock.unlock()
                group.leave()
                hook?()
            }
        }
        lock.lock()
        ptWantMedia = mediaURL != nil
        ptWantAvatar = avatarURL != nil || groupAvatarURL != nil
        ptTextFirst = textFirst
        ptE2E = e2eUid != nil
        lock.unlock()

        if let u = mediaURL {
            group.enter()
            let t = Self.downloadAttachment(u) { att in
                resultLock.lock(); mediaAttachment = att; resultLock.unlock()
                group.leave()
            }
            addTask(t)
        }
        if let u = avatarURL {
            group.enter()
            let t = Self.loadAvatar(u, staleFirst: textFirst) { d in
                resultLock.lock(); avatarData = d; resultLock.unlock()
                group.leave()
            }
            if let t = t { addTask(t) }
        }
        if let u = groupAvatarURL {
            group.enter()
            let t = Self.loadAvatar(u, staleFirst: textFirst) { d in
                resultLock.lock(); groupAvatarData = d; resultLock.unlock()
                group.leave()
            }
            if let t = t { addTask(t) }
        }

        var finalized = false
        let finalize: () -> Void = { [weak self] in
            guard let self = self else { return }
            resultLock.lock()
            if finalized { resultLock.unlock(); return }
            finalized = true
            resultLock.unlock()
            // Dá ao ✓✓ uma folga curta (rede boa = já voltou) e entrega.
            _ = ackGroup.wait(timeout: .now() + Self.ackGrace)
            self.deliverBest(best, p: p, isChat: isChat, locked: locked, conv: conv, isGroup: isGroup,
                             resultLock: resultLock,
                             media: { mediaAttachment }, avatar: { avatarData }, groupAvatar: { groupAvatarData },
                             e2e: { e2eText })
        }
        // [push-rapido item 6] texto primeiro: passado o orçamento, entrega com o que tiver (sem
        // esperar avatar/mídia) assim que o texto estiver pronto. O ✓✓ continua com a folga ackGrace
        // DENTRO do finalize e o journal já foi gravado antes do ack (ordem da F0 intacta).
        if textFirst {
            resultLock.lock()
            textReadyHook = {
                DispatchQueue.global(qos: .userInitiated).async {
                    if DispatchTime.now() >= t0 + mediaBudget { finalize() }
                }
            }
            resultLock.unlock()
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: t0 + mediaBudget) {
                resultLock.lock(); let waitE2E = e2ePending; resultLock.unlock()
                if !waitE2E { finalize() }
            }
        }
        // Avatar/mídia lentos (cache frio, rede ruim) não seguram o banner além do prazo.
        // [e2ee5 WP-10] decifrando ainda → espera até o teto da E2EE (depois entrega o genérico).
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + Self.bannerDeadline) {
            resultLock.lock(); let waitE2E = e2ePending; resultLock.unlock()
            if !waitE2E { finalize() }
        }
        if e2eUid != nil {
            DispatchQueue.global(qos: .userInitiated).asyncAfter(
                deadline: .now() + max(Self.bannerDeadline, ChatyyNSEE2EE.deadline)) {
                resultLock.lock(); let late = e2ePending; resultLock.unlock()
                if late { ChatyyNSEE2EE.noteDeadline() } // [e2ee5 WP-10c] métrica skip_deadline
                finalize()
            }
        }
        group.notify(queue: DispatchQueue.global(qos: .userInitiated)) { finalize() }
    }

    private func deliverBest(_ best: UNMutableNotificationContent, p: [String: Any], isChat: Bool, locked: Bool,
                             conv: String, isGroup: Bool, resultLock: NSLock,
                             media mediaGet: () -> UNNotificationAttachment?,
                             avatar avatarGet: () -> Data?, groupAvatar groupAvatarGet: () -> Data?,
                             e2e e2eGet: () -> String?) {
        resultLock.lock()
        let media = mediaGet(), avatar = avatarGet(), groupAvatar = groupAvatarGet(), e2e = e2eGet()
        resultLock.unlock()
        lock.lock()
        ptSkipMedia = ptWantMedia && media == nil
        ptSkipAvatar = ptWantAvatar && avatar == nil && groupAvatar == nil
        lock.unlock()
        if let a = media { best.attachments = [a] }
        var p = p
        if let txt = e2e, !txt.isEmpty, !locked {
            // [e2ee5 WP-10] prévia decifrada (só em memória): mesmo formato do push em claro.
            let sn = Self.str(p, "sender_name") ?? ""
            best.body = (isGroup && !sn.isEmpty) ? sn + ": " + txt : txt
            p["msg_preview"] = txt
            p["__e2e_plain"] = "1"
        } else if Self.str(p, "e2e") == "5", !locked {
            // [e2ee5 WP-10b 2026-10-22] não decifrou (flag/chave/tempo): o servidor manda só
            // "Fulano: Nova mensagem" no grupo e NÃO manda msg_preview → o Communication
            // Notification repetia o nome ("Fulano" + "Fulano: Nova mensagem"). Genérico sem o
            // prefixo; corpo vazio/"..." nunca → "Nova mensagem" no idioma do push.
            let sn = Self.str(p, "sender_name") ?? ""
            var g = best.body.trimmingCharacters(in: .whitespacesAndNewlines)
            if isGroup, !sn.isEmpty, g.hasPrefix(sn + ": ") { g = String(g.dropFirst(sn.count + 2)) }
            if ChatyyNSEGeneric.isPlaceholder(g) {
                g = ChatyyNSEGeneric.newMessage(Self.str(p, "lang"))
                best.body = (isGroup && !sn.isEmpty) ? sn + ": " + g : g
            }
            if Self.str(p, "msg_preview") == nil { p["msg_preview"] = g }
        }

        guard isChat, !locked, !conv.isEmpty else {
            self.finish(best)
            return
        }
        if #available(iOS 15.0, *) {
            self.applyCommunication(best: best, p: p, conv: conv, isGroup: isGroup,
                                    avatar: avatar, groupAvatar: groupAvatar) { updated in
                if let updated = updated {
                    self.finish(updated)
                } else {
                    Self.attachAvatarFallback(best, avatar: avatar)
                    self.finish(best)
                }
            }
        } else {
            Self.attachAvatarFallback(best, avatar: avatar)
            self.finish(best)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        lock.lock()
        let pending = tasks
        lock.unlock()
        pending.forEach { $0.cancel() }
        lock.lock(); ptExpired = !delivered; lock.unlock()
        if let best = bestAttemptContent { finish(best) }
    }

    // MARK: - Delivery (exactly once)

    private func finish(_ content: UNNotificationContent) {
        lock.lock()
        if delivered { lock.unlock(); return }
        delivered = true
        let handler = contentHandler
        let ms = Int(clamping: (DispatchTime.now().uptimeNanoseconds &- startedAt.uptimeNanoseconds) / 1_000_000)
        var codes: [String] = ["pt_banner" + Self.ptBucket(ms, [300, 700, 1500, 3000])]
        if ptSkipAvatar { codes.append("pt_skip_avatar") }
        if ptSkipMedia { codes.append("pt_skip_media") }
        if ptExpired { codes.append("pt_expire") }
        if ptMini == 1 { codes.append("pt_pmin_ok" + Self.ptBucket(ms, [300, 700, 1500, 3000])) }
        if ptMini == 2 { codes.append("pt_pmin_generic") }
        let line = "[ChatyyPushT] banner_ms=\(ms) text_first=\(ptTextFirst ? 1 : 0) e2e=\(ptE2E ? 1 : 0)"
            + " skip_avatar=\(ptSkipAvatar ? 1 : 0) skip_media=\(ptSkipMedia ? 1 : 0) expire=\(ptExpired ? 1 : 0) pmin=\(ptMini)"
        lock.unlock()
        handler?(content)
        // Depois do contentHandler: nada disso atrasa o banner. Só tempos/códigos, nunca conteúdo.
        NSLog("%@", line)
        Self.ptCount(codes)
    }

    // MARK: - Tempos do push ([2026-10-23 push-rapido])
    // Contadores no App Group "chatyy.nse.pt.counts" ([String: Int], máx. 24 chaves) — lidos e
    // zerados junto com os do E2EE (ExpoCallKit.e2ee5PushMetricsTake → e2ee5_metrics nse_pt_*).
    // Kill: App Group "chatyy.nse.timing" = "0".
    private static let ptLock = NSLock()

    private static func ptBucket(_ v: Int, _ edges: [Int]) -> String {
        for e in edges where v <= e { return "_le\(e)" }
        return "_gt\(edges.last ?? 0)"
    }

    private static func ptCount(_ codes: [String]) {
        guard let ud = UserDefaults(suiteName: appGroupId) else { return }
        if (ud.string(forKey: "chatyy.nse.timing") ?? "1") == "0" { return }
        ptLock.lock(); defer { ptLock.unlock() }
        var counts = ud.dictionary(forKey: "chatyy.nse.pt.counts") as? [String: Int] ?? [:]
        for c in codes {
            let k = String(c.prefix(40))
            if counts[k] != nil || counts.count < 24 { counts[k] = (counts[k] ?? 0) + 1 }
        }
        ud.set(counts, forKey: "chatyy.nse.pt.counts")
    }

    private func addTask(_ t: URLSessionTask) {
        lock.lock(); tasks.append(t); lock.unlock()
    }

    // MARK: - Communication Notification (iOS 15+)

    @available(iOS 15.0, *)
    private func applyCommunication(best: UNMutableNotificationContent,
                                    p: [String: Any],
                                    conv: String,
                                    isGroup: Bool,
                                    avatar: Data?,
                                    groupAvatar: Data?,
                                    done: @escaping (UNNotificationContent?) -> Void) {
        let senderEmail = Self.str(p, "sender_email") ?? ""
        let senderName = Self.str(p, "sender_name") ?? best.title
        let groupName = Self.str(p, "group_name") ?? Self.str(p, "conversation_name") ?? best.title
        let preview = Self.str(p, "msg_preview")

        let senderImage: INImage? = avatar.map { INImage(imageData: $0) }
        let handle = INPersonHandle(value: senderEmail.isEmpty ? senderName : senderEmail,
                                    type: senderEmail.isEmpty ? .unknown : .emailAddress)
        let sender = INPerson(personHandle: handle,
                              nameComponents: nil,
                              displayName: senderName,
                              image: senderImage,
                              contactIdentifier: nil,
                              customIdentifier: senderEmail.isEmpty ? nil : senderEmail,
                              isMe: false,
                              suggestionType: .none)

        var recipients: [INPerson]? = nil
        var speakableGroup: INSpeakableString? = nil
        if isGroup {
            speakableGroup = INSpeakableString(spokenPhrase: groupName)
            // iOS only renders the group layout (group photo + "Sender — Group")
            // with 2+ recipients; the payload doesn't carry the member list, so
            // the user + a stable group placeholder stand in.
            let me = INPerson(personHandle: INPersonHandle(value: "me", type: .unknown),
                              nameComponents: nil, displayName: nil, image: nil,
                              contactIdentifier: nil, customIdentifier: "me",
                              isMe: true, suggestionType: .none)
            let groupPerson = INPerson(personHandle: INPersonHandle(value: "group_" + conv, type: .unknown),
                                       nameComponents: nil, displayName: groupName, image: nil,
                                       contactIdentifier: nil, customIdentifier: "group_" + conv,
                                       isMe: false, suggestionType: .none)
            recipients = [me, groupPerson]
        } else {
            // [2026-10-11] 1:1 → destinatário explícito = só EU. Com nil o iOS
            // juntava com a doação do app e mostrava "To you & 1 other" (layout
            // de grupo, ícone do app em vez da foto de quem mandou).
            let meDirect = INPerson(personHandle: INPersonHandle(value: "me", type: .unknown),
                                    nameComponents: nil, displayName: nil, image: nil,
                                    contactIdentifier: nil, customIdentifier: "me",
                                    isMe: true, suggestionType: .none)
            recipients = [meDirect]
        }

        // [e2ee5 WP-10] texto decifrado NUNCA vai na doação (o iOS guarda as interações fora do
        // App Group); o corpo da notificação vem do `base`, não do Intent.
        let e2ePlain = Self.str(p, "__e2e_plain") == "1"
        let intent = INSendMessageIntent(recipients: recipients,
                                         outgoingMessageType: .outgoingMessageText,
                                         content: e2ePlain ? nil : ((preview?.isEmpty == false) ? preview : best.body),
                                         speakableGroupName: speakableGroup,
                                         conversationIdentifier: "chat_" + conv,
                                         serviceName: nil,
                                         sender: sender,
                                         attachments: nil)
        if isGroup {
            if let g = groupAvatar {
                intent.setImage(INImage(imageData: g), forParameterNamed: \.speakableGroupName)
            }
        } else if let si = senderImage {
            intent.setImage(si, forParameterNamed: \.sender)
        }

        // [2026-10-09 notif-native] Donation metadata (iOS 15): lets an
        // @mention / a reply to me break through a Focus that allows
        // "mentions only" for groups, and tells the system the group size.
        let meta = INSendMessageIntentDonationMetadata()
        meta.mentionsCurrentUser = (Self.str(p, "type") == "chat_mention") || Self.isTrue(Self.str(p, "mentions_me"))
            || Self.isTrue(Self.str(p, "mentioned"))
        meta.isReplyToCurrentUser = Self.isTrue(Self.str(p, "reply_to_me"))
        meta.recipientCount = isGroup ? max(2, Int(Self.str(p, "member_count") ?? "") ?? 2) : 1
        intent.donationMetadata = meta

        // The system shows the sender name itself → drop the "Sender: " prefix
        // that the classic group banner needs.
        let base = (best.mutableCopy() as? UNMutableNotificationContent) ?? best
        if isGroup, let pv = preview, !pv.isEmpty { base.body = pv }

        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate { _ in
            // Donation failure must not block delivery; try the update anyway.
            do {
                let updated = try base.updating(from: intent)
                done(updated)
            } catch {
                done(nil)
            }
        }
    }

    private static func attachAvatarFallback(_ best: UNMutableNotificationContent, avatar: Data?) {
        guard best.attachments.isEmpty, let d = avatar else { return }
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString + ".png")
        do {
            try d.write(to: url)
            let att = try UNNotificationAttachment(identifier: "avatar", url: url, options: nil)
            best.attachments = [att]
        } catch {
            try? FileManager.default.removeItem(at: url)
        }
    }

    // MARK: - Payload helpers

    /// Top-level userInfo merged with the Expo "body" (dictionary or JSON string).
    // [rcpt-bg 2026-10-24] Push de chat VISÍVEL pode trazer `rcpt` = recibos ✓✓/azul pendentes DESTE aparelho
    // ("cid,d,r;…", só ids/estado; servidor rcpt-bg.php, flag por conta). A NSE não alcança o store do app →
    // guarda no App Group; ChatyyRcptBgAppDelegateSubscriber (expo-chat-store) drena ao abrir / voltar ao 1º plano.
    private static func stashRcpt(_ p: [String: Any]) {
        guard let r = str(p, "rcpt"), !r.isEmpty, r.utf8.count <= 4096,
              FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) != nil,
              let ud = UserDefaults(suiteName: appGroupId) else { return }
        if ud.bool(forKey: "chatyy.rcpt_bg_native_off") { return }
        var arr = (ud.array(forKey: "chatyy.rcpt.pending") as? [[String: Any]]) ?? []
        arr.append(["r": r, "ah": str(p, "rcpt_ah") ?? "", "t": Date().timeIntervalSince1970])
        if arr.count > 8 { arr = Array(arr.suffix(8)) } // cumulativo: o mais novo já cobre os antigos
        ud.set(arr, forKey: "chatyy.rcpt.pending")
    }

    private static func payload(_ userInfo: [AnyHashable: Any]) -> [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in userInfo { if let ks = k as? String { out[ks] = v } }
        var nested: [String: Any]? = userInfo["body"] as? [String: Any]
        if nested == nil, let s = userInfo["body"] as? String, s.hasPrefix("{"),
           let d = s.data(using: .utf8),
           let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
            nested = j
        }
        if let n = nested { for (k, v) in n { out[k] = v } }
        return out
    }

    private static func str(_ p: [String: Any], _ k: String) -> String? {
        if let s = p[k] as? String { return s.isEmpty ? nil : s }
        if let n = p[k] as? NSNumber { return n.stringValue }
        return nil
    }

    private static func isTrue(_ s: String?) -> Bool {
        guard let s = s?.lowercased() else { return false }
        return s == "1" || s == "true"
    }

    /// [2026-10-09 system-integration] chatyy.pinned | chatyy.direct |
    /// chatyy.group | chatyy.email | chatyy.other (see ChatyyFocusFilter).
    private static func focusCriteria(type: String, conv: String, isGroup: Bool) -> String {
        if type == "new_email" || type == "email" { return "chatyy.email" }
        guard chatTypes.contains(type), !conv.isEmpty else { return "chatyy.other" }
        if let ud = UserDefaults(suiteName: "group.com.onemundo.mail"),
           let pinned = ud.array(forKey: "chatyy.pinned_conversation_ids") as? [String],
           pinned.contains(conv) {
            return "chatyy.pinned"
        }
        return isGroup ? "chatyy.group" : "chatyy.direct"
    }

    private static func httpsURL(_ raw: String?) -> URL? {
        guard var s = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        if s.hasPrefix("/") { s = "https://chatyy.com.br" + s }
        guard let u = URL(string: s), u.scheme?.lowercased() == "https" else { return nil }
        return u
    }

    // [2026-10-05] Delivered-on-receipt. d_ack = HMAC token scoped to
    // (msg, conversation, recipient, exp) — no secret embedded here.
    // [2026-10-07] Reads the MERGED payload: on the Expo route (all iOS
    // devices) d_ack lives inside the "body" dictionary, which the previous
    // string-only parser never saw.
    // [2026-10-13 dack-wait] Agora: (1) entra no DispatchGroup do didReceive
    // (finish espera o POST, ≤ ackTimeout); (2) sessão EPHEMERAL (sem cookies —
    // o gate CSRF do email.php devolvia 403 quando ia cookie); (3) falha de rede
    // / 5xx / timeout → token vai p/ uma fila no App Group e é reenviado no
    // próximo push que acordar a NSE (token vale 24 h; servidor é idempotente).
    private static let ackURL = URL(string: "https://chatyy.com.br/api/email.php?action=chat_push_delivered")
    private static let ackTimeout: TimeInterval = 6
    private static let pendingAckKey = "chatyy.dack.pending"
    private static let pendingAckMax = 40
    private static let ackLock = NSLock()
    private static let ackSession: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = ackTimeout
        cfg.timeoutIntervalForResource = ackTimeout + 2
        cfg.httpShouldSetCookies = false
        cfg.httpCookieAcceptPolicy = .never
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()

    // [2026-10-22 dlv-device] Ack POR APARELHO (fila sombra chat_msg_device_dlv): o corpo leva
    // device_id = id E2EE v5 do núcleo p/ a conta do token (ChatyyNSEE2EE.deliveryDeviceId; o servidor
    // confere que é desta conta, senão '?') e persisted = 1 quando a mensagem COMPLETA ficou no journal
    // do App Group (journalMessage). Prévia/E2EE/trancada → 0: o envelope E2EE ainda não é gravado no
    // store pela NSE (o app grava ao sincronizar). Pendentes guardam o persisted ("<token>|1").
    private static func reportDelivered(_ p: [String: Any], persisted: Bool, group: DispatchGroup,
                                        track: (URLSessionTask) -> Void) {
        var toks: [String] = []
        var current: String?
        if let dAck = str(p, "d_ack"), dAck.contains(".") {
            let it = persisted ? dAck + "|1" : dAck
            toks.append(it); current = it
        }
        // Reenvia até 5 pendentes de pushes anteriores (rede caiu / NSE expirou).
        for t in takePendingAcks(max: 5) where !toks.contains(t) && !toks.contains(t + "|1") { toks.append(t) }
        // [2026-10-23 push-rapido 3-nativo] `ack_url` do servidor só p/ o ack DESTE push (pendentes = URL de sempre).
        let primary = ackPrimaryURL(p)
        for tok in toks {
            guard let t = postAck(tok, group: group, primary: tok == current ? primary : nil) else { continue }
            track(t)
        }
    }

    /// [2026-10-23 push-rapido 3-nativo] `ack_url` opcional do payload: só https em chatyy.com.br ou
    /// *.chatyy.com.br, sem usuário/senha, porta 443. Kill: App Group "chatyy.dack.ack_url" = "0".
    private static let ackPrimaryTimeout: TimeInterval = 2.5
    private static func ackPrimaryURL(_ p: [String: Any]) -> URL? {
        if (UserDefaults(suiteName: appGroupId)?.string(forKey: "chatyy.dack.ack_url") ?? "1") == "0" { return nil }
        guard let raw = str(p, "ack_url")?.trimmingCharacters(in: .whitespacesAndNewlines), raw.count <= 512,
              let u = URL(string: raw), u.scheme?.lowercased() == "https",
              let host = u.host?.lowercased(),
              host == "chatyy.com.br" || (host.hasSuffix(".chatyy.com.br") && host.count > 14),
              u.user == nil, u.password == nil, u.port == nil || u.port == 443 else { return nil }
        return u
    }

    /// Conta (campo `e`) do payload do token d_ack — só p/ escolher o aparelho (assinatura = servidor).
    private static func acctOfDack(_ tok: String) -> String {
        guard var b = tok.split(separator: ".").first.map(String.init), !b.isEmpty else { return "" }
        b = b.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        guard let d = Data(base64Encoded: b),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let e = o["e"] as? String else { return "" }
        return e.trimmingCharacters(in: .whitespaces).lowercased()
    }

    /// [item] = "<d_ack>" ou "<d_ack>|1" (persisted).
    private static func postAck(_ item: String, group: DispatchGroup, primary: URL? = nil) -> URLSessionTask? {
        let persisted = item.hasSuffix("|1")
        let dAck = persisted ? String(item.dropLast(2)) : item
        var obj: [String: Any] = ["d_ack": dAck, "persisted": persisted ? 1 : 0]
        let dev = ChatyyNSEE2EE.deliveryDeviceId(account: acctOfDack(dAck))
        if !dev.isEmpty { obj["device_id"] = dev }
        guard let url = ackURL,
              let body = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
        func makeReq(_ u: URL, _ timeout: TimeInterval) -> URLRequest {
            var req = URLRequest(url: u, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("application/json", forHTTPHeaderField: "Accept")
            req.httpBody = body
            return req
        }
        group.enter()
        // [push-preview 2026-10-21] pendente ANTES do POST: o banner não espera mais
        // o fim do POST, e se o iOS congelar/matar a extensão o próximo push reenvia.
        addPendingAck(item)
        let t0 = DispatchTime.now()
        let sendDefault: (String) -> URLSessionTask = { via in
            let task = ackSession.dataTask(with: makeReq(url, ackTimeout)) { _, response, error in
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                // 2xx = servidor gravou (ou já estava entregue). 4xx = definitivo
                // (token inválido/expirado) → não reenvia. Resto = tenta depois.
                if !(error != nil || code == 0 || code >= 500 || code == 429) {
                    removePendingAck(item)
                }
                NSLog("%@", "[ChatyyPushT] dack via=\(via) code=\(code) ms=\((DispatchTime.now().uptimeNanoseconds &- t0.uptimeNanoseconds) / 1_000_000)")
                group.leave()
            }
            task.resume()
            return task
        }
        guard let pu = primary else { return sendDefault("default") }
        // [push-rapido 3-nativo] ack_url primeiro; erro/não-2xx → URL de sempre (mesma entrada no group).
        let task = ackSession.dataTask(with: makeReq(pu, ackPrimaryTimeout)) { _, response, error in
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if error == nil && (200..<300).contains(code) {
                removePendingAck(item)
                NSLog("%@", "[ChatyyPushT] dack via=ack_url code=\(code) ms=\((DispatchTime.now().uptimeNanoseconds &- t0.uptimeNanoseconds) / 1_000_000)")
                group.leave()
            } else {
                _ = sendDefault("fallback")
            }
        }
        task.resume()
        return task
    }

    private static func takePendingAcks(max n: Int) -> [String] {
        guard FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) != nil,
              let ud = UserDefaults(suiteName: appGroupId) else { return [] }
        ackLock.lock(); defer { ackLock.unlock() }
        var arr = ud.stringArray(forKey: pendingAckKey) ?? []
        if arr.isEmpty { return [] }
        let take = Array(arr.suffix(n))
        arr.removeLast(take.count)
        ud.set(arr, forKey: pendingAckKey)
        return take
    }

    private static func removePendingAck(_ tok: String) {
        guard FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) != nil,
              let ud = UserDefaults(suiteName: appGroupId) else { return }
        ackLock.lock(); defer { ackLock.unlock() }
        var arr = ud.stringArray(forKey: pendingAckKey) ?? []
        guard let i = arr.firstIndex(of: tok) else { return }
        arr.remove(at: i)
        ud.set(arr, forKey: pendingAckKey)
    }

    private static func addPendingAck(_ tok: String) {
        guard FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) != nil,
              let ud = UserDefaults(suiteName: appGroupId) else { return }
        ackLock.lock(); defer { ackLock.unlock() }
        var arr = ud.stringArray(forKey: pendingAckKey) ?? []
        if arr.contains(tok) { return }
        arr.append(tok)
        if arr.count > pendingAckMax { arr.removeFirst(arr.count - pendingAckMax) }
        ud.set(arr, forKey: pendingAckKey)
    }

    // MARK: - App-icon badge ([2026-10-11])
    //
    // Server (firebase_push.php) sets aps.badge = live unread (chat + INBOX) for
    // chat_message/chat_mention/chat_reaction/new_email/email and 0 for every
    // other type. Gaps fixed here:
    //   • non-badge types (like/follow/live/chat_keyword…) sent badge 0 → the
    //     icon was CLEARED by a like → leave it untouched (badge = nil).
    //   • fcmGetBadgeCount returns 0 on failure → a new message zeroed the icon
    //     → fall back to the shared counter + 1.
    //   • the count is memoized 15 s server-side → a burst showed the same
    //     number → if the server repeats the value we last saw (< 20 s ago)
    //     and our counter is already there, count +1 per new message.
    // Shared keys (App Group group.com.onemundo.mail, also written by the app —
    // modules/expo-native-toolkit/ios/ExpoChatyySystemModule.swift):
    //   chatyy.badge.count (Int), chatyy.badge.at (epoch s),
    //   chatyy.badge.last_server (Int), chatyy.badge.seen ([type:mid], dedupe).
    // Without the NSE App Group entitlement the container is nil → only the
    // "never clear on non-badge types" rule applies.
    private static let appGroupId = "group.com.onemundo.mail"
    private static let badgeServerTypes: Set<String> = ["chat_message", "chat_mention", "chat_reaction", "new_email", "email"]
    private static let badgeNewUnreadTypes: Set<String> = ["chat_message", "chat_mention", "chat_keyword", "new_email", "email"]
    private static let badgeLock = NSLock()

    private static func applyBadge(_ best: UNMutableNotificationContent, p: [String: Any], type: String) {
        let server: Int? = best.badge?.intValue
        let newUnread = badgeNewUnreadTypes.contains(type)
        let serverCounts = badgeServerTypes.contains(type)
        if !newUnread && !serverCounts {
            best.badge = nil
            return
        }
        guard FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) != nil,
              let ud = UserDefaults(suiteName: appGroupId) else {
            if (server ?? 0) <= 0 { best.badge = nil }
            return
        }
        badgeLock.lock()
        defer { badgeLock.unlock() }
        let now = Date().timeIntervalSince1970
        let base = max(0, ud.integer(forKey: "chatyy.badge.count"))
        let at = ud.double(forKey: "chatyy.badge.at")
        let lastServer = ud.object(forKey: "chatyy.badge.last_server") as? Int
        let mid = str(p, "message_id") ?? str(p, "uid") ?? ""
        let seenKey = type + ":" + mid
        var seen = ud.stringArray(forKey: "chatyy.badge.seen") ?? []
        let dup = !mid.isEmpty && seen.contains(seenKey)

        var result: Int? = nil
        if let s = server, s > 0 {
            if newUnread, !dup, let ls = lastServer, ls == s, now - at < 20, base >= s {
                result = base + 1
            } else {
                result = s
            }
            ud.set(s, forKey: "chatyy.badge.last_server")
        } else if newUnread {
            let r = dup ? base : base + 1
            result = r > 0 ? r : nil
        }
        if let r = result {
            best.badge = NSNumber(value: r)
            ud.set(r, forKey: "chatyy.badge.count")
            ud.set(now, forKey: "chatyy.badge.at")
        } else {
            best.badge = nil
        }
        if !mid.isEmpty && !dup {
            seen.append(seenKey)
            if seen.count > 40 { seen.removeFirst(seen.count - 40) }
            ud.set(seen, forKey: "chatyy.badge.seen")
        }
    }

    // MARK: - Background message journal ([2026-10-07 bgsync])
    //
    // Same JSONL line format + flock protocol as the app side
    // (modules/expo-callkit/ios/ChatBgJournal.swift, Android ChatBgJournal.kt).
    // The NSE is a separate process: an exclusive flock on inbox.lock around the
    // append keeps it atomic w.r.t. the app's read/commit. Bounded (384 KB).
    private static let journalTypes: Set<String> = ["chat_message", "chat_mention", "chat_keyword"]

    /// [2026-10-22 dlv-device] true = a mensagem COMPLETA (texto/mídia, `full`) foi gravada no journal.
    @discardableResult
    private static func journalMessage(_ p: [String: Any]) -> Bool {
        guard let type = str(p, "type"), journalTypes.contains(type),
              let cid = str(p, "conversation_id") ?? str(p, "e2e_conv"), let mid = str(p, "message_id") ?? str(p, "e2e_mid"),
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.onemundo.mail")
        else { return false }
        let locked = str(p, "locked") == "1"
        let full = str(p, "bg_full") == "1" && !locked
        let isGroup = isTrue(str(p, "is_group")) || str(p, "conversation_type") == "group"
        var o: [String: Any] = [
            "v": 1, "src": "nse",
            "acct": (str(p, "recipient_email") ?? "").lowercased(),
            "at": Int64(Date().timeIntervalSince1970 * 1000),
            "cid": cid, "mid": mid,
            "full": full ? "1" : "0", "locked": locked ? "1" : "0",
            "sender": str(p, "sender_email") ?? "",
            "type": str(p, "bg_type") ?? "",
            "preview": String((str(p, "msg_preview") ?? "").prefix(300)),
            "ts": str(p, "bg_ts") ?? "",
            "grp": isGroup ? "1" : "0",
            "unread": str(p, "unread_count") ?? "",
        ]
        if !locked {
            o["sname"] = str(p, "sender_name") ?? ""
            o["cname"] = str(p, "conversation_name") ?? str(p, "group_name") ?? ""
        }
        if full {
            let map: [(String, String)] = [("bg_text", "text"), ("bg_cmid", "cmid"), ("bg_furl", "furl"),
                                           ("bg_fname", "fname"), ("bg_fsize", "fsize"), ("bg_w", "w"),
                                           ("bg_h", "h"), ("bg_dur", "dur"), ("bg_thumb", "thumb"),
                                           ("bg_reply", "reply"), ("bg_rquote", "rquote")]
            for (src, dst) in map { if let v = str(p, src) { o[dst] = v } }
        }
        // [sgu F0 2026-10-23] E2EE v5 com envelope inline (e2e_c, CIFRADO — nunca o texto decifrado): a
        // linha leva as mesmas chaves de services/bgJournal.js entryFromPush (e5/e5c/e5su/cmid) e o app
        // importa o envelope no SQLite. Gravação durável (1 write + fsync sob o flock) ANTES do ack →
        // persisted=1 só neste caso. e2e_fetch (sem envelope), linha > 8 KB, journal cheio, falha de IO
        // ou kill → 0. Kill: App Group UserDefaults "chatyy.dlv.e5journal" = "0" (padrão = ligado).
        var e5Body = false
        if str(p, "e2e") == "5" && !locked {
            o["e5"] = "1"
            if let su = str(p, "e2e_sender_uid") { o["e5su"] = su }
            if let cm = str(p, "e2e_cmid") { o["cmid"] = cm }
            let killed = (UserDefaults(suiteName: "group.com.onemundo.mail")?.string(forKey: "chatyy.dlv.e5journal") ?? "1") == "0"
            if !killed, let env = str(p, "e2e_c"), env.hasPrefix("{\"e2e\":5"), env.utf8.count < 8192 {
                o["e5c"] = env
                e5Body = true
            }
        }
        if e5Body {
            if let d = try? JSONSerialization.data(withJSONObject: o), d.count <= 8192,
               let l = String(data: d, encoding: .utf8), !l.contains("\n"),
               appendJournalLine(container, l + "\n", durable: true) {
                return true
            }
            o.removeValue(forKey: "e5c") // não coube/falhou → marcador de sempre, persisted=0
        }
        guard let d = try? JSONSerialization.data(withJSONObject: o),
              let line = String(data: d, encoding: .utf8), !line.contains("\n") else { return false }
        _ = appendJournalLine(container, line + "\n", durable: false)
        // E2EE (e2e=5) sem envelope gravado: o journal só leva a prévia/marcador → não conta como gravada.
        return full && str(p, "e2e") != "5" && (str(p, "bg_text") != nil || str(p, "bg_furl") != nil)
    }

    /// Append de UMA linha sob o flock de inbox.lock. durable = fsync antes de devolver (persisted).
    /// true só se a linha inteira foi escrita (e sincronizada, se durable).
    private static func appendJournalLine(_ container: URL, _ line: String, durable: Bool) -> Bool {
        let dir = container.appendingPathComponent("chatyy_bg_journal", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let fd = open(dir.appendingPathComponent("inbox.lock").path, O_RDWR | O_CREAT, 0o644)
        if fd < 0 { return false }
        defer { close(fd) }
        if flock(fd, LOCK_EX) != 0 { return false }
        defer { flock(fd, LOCK_UN) }
        let file = dir.appendingPathComponent("inbox.jsonl")
        let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
        if size > 384 * 1024 { return false }
        if !FileManager.default.fileExists(atPath: file.path) {
            FileManager.default.createFile(atPath: file.path, contents: nil)
        }
        guard let bytes = line.data(using: .utf8) else { return false }
        if !durable {
            guard let h = try? FileHandle(forWritingTo: file) else { return false }
            _ = h.seekToEndOfFile()
            h.write(bytes)
            try? h.close()
            return true
        }
        // Durável: write(2) único com O_APPEND (sem exceção ObjC do FileHandle.write) + fsync.
        let wfd = open(file.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        if wfd < 0 { return false }
        defer { close(wfd) }
        let n = bytes.withUnsafeBytes { raw -> Int in
            guard let base = raw.baseAddress else { return -1 }
            return write(wfd, base, raw.count)
        }
        if n != bytes.count { return false }
        return fsync(wfd) == 0
    }

    private static func extractImageURL(from p: [String: Any]) -> URL? {
        var candidates: [String] = []
        if let s = p["media_url"] as? String { candidates.append(s) }
        if let fcm = p["fcm_options"] as? [String: Any], let s = fcm["image"] as? String { candidates.append(s) }
        if let s = p["image"] as? String { candidates.append(s) }
        for raw in candidates {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
               scheme == "https" || scheme == "http" {
                return url
            }
        }
        return nil
    }

    // MARK: - Downloads

    /// Media → temp FILE (streamed, never decoded in memory) → attachment.
    private static func downloadAttachment(_ url: URL, completion: @escaping (UNNotificationAttachment?) -> Void) -> URLSessionTask {
        let req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: downloadTimeout)
        let task = URLSession.shared.downloadTask(with: req) { location, response, _ in
            guard let location = location else { completion(nil); return }
            // [notif-ios 2026-10-18] 404/403 (pôster ainda não gerado, R2) vinha com
            // o XML de erro e virava anexo .jpg quebrado → só 2xx com mídia real.
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let mime = response?.mimeType?.lowercased() ?? ""
            let mediaMime = mime.hasPrefix("image/") || mime.hasPrefix("video/") || mime == "application/octet-stream" || mime.isEmpty
            guard (200..<300).contains(code), mediaMime else { completion(nil); return }
            completion(makeAttachment(from: location, response: response, url: url))
        }
        task.resume()
        return task
    }

    /// Avatar → 256 px PNG data, cached 24 h in the extension's Caches dir.
    /// Returns nil task when served from cache.
    /// [2026-10-23 push-rapido] staleFirst: cache VENCIDO responde na hora e o download só renova o
    /// arquivo (o banner não espera a rede por um avatar que já temos).
    private static func loadAvatar(_ url: URL, staleFirst: Bool = false, completion: @escaping (Data?) -> Void) -> URLSessionTask? {
        let cacheFile = avatarCacheFile(for: url)
        if let f = cacheFile,
           let attrs = try? FileManager.default.attributesOfItem(atPath: f.path),
           let mod = attrs[.modificationDate] as? Date,
           Date().timeIntervalSince(mod) < 24 * 3600,
           let d = try? Data(contentsOf: f) {
            completion(d)
            return nil
        }
        let stale: Data? = staleFirst ? cacheFile.flatMap { try? Data(contentsOf: $0) } : nil
        if let s = stale { completion(s) }
        let answered = stale != nil
        let req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: downloadTimeout)
        let task = URLSession.shared.dataTask(with: req) { data, response, _ in
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard let data = data, (200..<300).contains(code), data.count <= maxAvatarBytes,
                  let png = downsampledPNG(data, maxPixel: 256) else {
                if answered { return }
                // Stale cache beats nothing.
                if let f = cacheFile, let d = try? Data(contentsOf: f) { completion(d) } else { completion(nil) }
                return
            }
            if let f = cacheFile { try? png.write(to: f, options: .atomic) }
            if !answered { completion(png) }
        }
        task.resume()
        return task
    }

    private static func avatarCacheFile(for url: URL) -> URL? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let dir = caches.appendingPathComponent("chat_avatars", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let digest = SHA256.hash(data: Data(url.absoluteString.utf8))
        let name = digest.map { String(format: "%02x", $0) }.joined()
        return dir.appendingPathComponent(name + ".png")
    }

    /// ImageIO thumbnail — decodes straight to the target size (no full-size
    /// bitmap in memory, keeps the NSE far below its memory ceiling).
    private static func downsampledPNG(_ data: Data, maxPixel: Int) -> Data? {
        let srcOpts = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let src = CGImageSourceCreateWithData(data as CFData, srcOpts) else { return nil }
        let thumbOpts = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ] as CFDictionary
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, thumbOpts) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out as CFMutableData, "public.png" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, cg, nil)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }

    private static func makeAttachment(from location: URL, response: URLResponse?, url: URL) -> UNNotificationAttachment? {
        let ext = fileExtension(url: url, response: response)
        let fileName = UUID().uuidString + (ext.isEmpty ? "" : "." + ext)
        let dest = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(fileName)
        do {
            if FileManager.default.fileExists(atPath: dest.path) {
                try FileManager.default.removeItem(at: dest)
            }
            try FileManager.default.moveItem(at: location, to: dest)
            return try UNNotificationAttachment(identifier: fileName, url: dest, options: nil)
        } catch {
            try? FileManager.default.removeItem(at: dest)
            return nil
        }
    }

    /// [notif-ios 2026-10-18] MIME first (".../email.php?action=wa_import_file"
    /// gave "php" → UNNotificationAttachment rejected it); the URL extension only
    /// when it is a known media type.
    private static let mediaExts: Set<String> = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif",
                                                 "mp4", "mov", "m4v"]

    private static func fileExtension(url: URL, response: URLResponse?) -> String {
        switch response?.mimeType?.lowercased() {
        case "image/jpeg", "image/jpg": return "jpg"
        case "image/png":  return "png"
        case "image/gif":  return "gif"
        case "image/webp": return "webp"
        case "image/heic": return "heic"
        case "image/heif": return "heif"
        case "video/mp4":  return "mp4"
        case "video/quicktime": return "mov"
        case "video/x-m4v": return "m4v"
        default: break
        }
        let pathExt = url.pathExtension.lowercased()
        if mediaExts.contains(pathExt) { return pathExt }
        return "jpg"
    }
}
