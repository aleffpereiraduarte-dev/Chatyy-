// CallParticipantPicker.swift
// [add-participant 2026-05-26] WhatsApp-style "add participant to active call".
// [2026-10-13 add-to-call redesign] Print do founder (build 678): folha branca com
// TODO o diretório do domínio (contas de teste inclusas), usernames crus + e-mail,
// avatares coloridos, ícone azul, sem busca, e "Não foi possível chamar <email>"
// (o servidor recusava qualquer pessoa fora da conversa 1:1 — corrigido no
// servidor por /root/ligacao-adicionar-servidor.sh). Agora, nível WhatsApp:
//   • folha ESCURA (a tela de chamada é escura), só P&B;
//   • busca no topo (nome, @usuário, e-mail ou telefone completo) com debounce;
//   • seções "Conversas recentes" e "Contatos" — SÓ conversas direct + agenda do
//     usuário (chat_call_add_candidates); contas de teste/sistema escondidas;
//   • nome de exibição + foto real; @usuário embaixo quando existe;
//   • "Na chamada" / "Chamando…" desabilitados; seleção múltipla com check +
//     "Adicionar (N)"; skeleton, vazio, erro com "Tentar de novo";
//   • erro traduzido com o motivo (GroupCallStrings "pk.*", 11 idiomas).
//
// Auth: mesma App Group (group.com.onemundo.mail → auth_token + api_base).
//
// Backend:
//   GET  <base>/api/email.php?action=chat_call_add_candidates&query=&call_id=&limit=
//        → { success, data: { recent:[], contacts:[], results:[], total } }
//          linha { email, name, username, avatar, call_state, recent, in_contacts }
//        Servidor antigo (sem a action) → cai no chat_contacts (filtrado aqui).
//   POST <base>/api/email.php?action=chat_call_add
//        body { action, call_id, conversation_id, video, emails:[...] }
//        erro → data.code (not_allowed|blocked|not_in_call|parental|no_invitees|rate_limited)
//        ok   → data.invited[{email,name,reachable}], data.skipped[{email,reason}]

import SwiftUI
import Foundation
import UIKit

// MARK: - Networking

enum CallParticipantsAPI {
    struct Candidate: Identifiable, Hashable {
        let email: String
        let name: String
        let username: String
        let avatar: String
        let callState: String // "in_call" | "ringing" | ""
        var id: String { email }
    }

    struct Lists {
        var ok: Bool
        var recent: [Candidate]
        var contacts: [Candidate]
        var results: [Candidate]
    }

    struct Invited { let email: String; let reachable: Bool }
    struct Skipped { let email: String; let reason: String }
    struct AddResult {
        let ok: Bool
        let code: String
        let invited: [Invited]
        let skipped: [Skipped]
    }

    private static let appGroup = "group.com.onemundo.mail"

    private static func resolveAuth() -> (token: String, base: String)? {
        guard let ud = UserDefaults(suiteName: appGroup),
              let token = ud.string(forKey: "auth_token"), !token.isEmpty,
              let base = ud.string(forKey: "api_base"), !base.isEmpty else {
            return nil
        }
        let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
        return (token, trimmed)
    }

    /// Contas de teste/sistema nunca aparecem no seletor (mesma regra do servidor/JS).
    static func isHidden(_ email: String) -> Bool {
        let e = email.lowercased()
        guard let at = e.firstIndex(of: "@"), at != e.startIndex else { return true }
        let local = String(e[e.startIndex..<at])
        let pattern = "^(apitest|appletest|smoketest|testkid|reels|noreply|no-reply|donotreply|do-not-reply|postmaster|mailer-daemon|abuse|root|system|bot|qa|qa[0-9]+|qa-?bot|qa-?robot|test[0-9]*|teste[0-9]*|demo[0-9]*)$"
        return local.range(of: pattern, options: .regularExpression) != nil
    }

    static func fold(_ s: String) -> String {
        return s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func candidate(from o: [String: Any]) -> Candidate? {
        guard let raw = (o["email"] as? String)?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
        let email = raw.lowercased()
        if isHidden(email) { return nil }
        var name = (o["name"] as? String) ?? ""
        if name.isEmpty { name = String(email.prefix(while: { $0 != "@" })) }
        return Candidate(
            email: email,
            name: name,
            username: (o["username"] as? String) ?? "",
            avatar: (o["avatar"] as? String) ?? "",
            callState: (o["call_state"] as? String) ?? ""
        )
    }

    private static func getJSON(_ url: URL, token: String) async -> (status: Int, root: [String: Any]?) {
        var req = URLRequest(url: url, timeoutInterval: 12.0)
        req.httpMethod = "GET"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            return (status, root)
        } catch {
            return (0, nil)
        }
    }

    /// Lista do seletor. Sem query: recent + contacts; com query: results.
    static func fetchCandidates(query: String, callId: String) async -> Lists {
        let empty = Lists(ok: false, recent: [], contacts: [], results: [])
        guard let auth = resolveAuth(),
              var comps = URLComponents(string: "\(auth.base)/api/email.php") else { return empty }
        comps.queryItems = [
            URLQueryItem(name: "action", value: "chat_call_add_candidates"),
            URLQueryItem(name: "query", value: String(query.prefix(64))),
            URLQueryItem(name: "call_id", value: callId),
            URLQueryItem(name: "limit", value: "80"),
        ]
        guard let url = comps.url else { return empty }
        let (status, root) = await getJSON(url, token: auth.token)
        if let root = root, (root["success"] as? Bool) == true, let d = root["data"] as? [String: Any] {
            func list(_ k: String) -> [Candidate] {
                return ((d[k] as? [[String: Any]]) ?? []).compactMap { candidate(from: $0) }
            }
            return Lists(ok: true, recent: list("recent"), contacts: list("contacts"), results: list("results"))
        }
        // Servidor antigo (action desconhecida) → chat_contacts, filtrado aqui.
        if status == 0 { return empty }
        guard let legacyURL = URL(string: "\(auth.base)/api/email.php?action=chat_contacts") else { return empty }
        let (_, lroot) = await getJSON(legacyURL, token: auth.token)
        guard let lr = lroot, (lr["success"] as? Bool) == true else { return empty }
        var arr: [[String: Any]] = []
        if let a = lr["data"] as? [[String: Any]] { arr = a }
        else if let obj = lr["data"] as? [String: Any], let a = obj["contacts"] as? [[String: Any]] { arr = a }
        let all = arr.compactMap { candidate(from: $0) }
        let q = fold(query.hasPrefix("@") ? String(query.dropFirst()) : query)
        if q.isEmpty {
            let sorted = all.sorted { fold($0.name) < fold($1.name) }
            return Lists(ok: true, recent: [], contacts: sorted, results: [])
        }
        let hits = all.filter { fold($0.name).contains(q) || $0.email.contains(q) }
        return Lists(ok: true, recent: [], contacts: [], results: hits)
    }

    /// Toca [emails] na chamada em andamento (sala == callId).
    static func ringIntoCall(callId: String, conversationId: String, emails: [String], isVideo: Bool) async -> AddResult {
        let fail = { (code: String) in AddResult(ok: false, code: code, invited: [], skipped: []) }
        guard !callId.isEmpty, !emails.isEmpty else { return fail("no_invitees") }
        guard let auth = resolveAuth(),
              let url = URL(string: "\(auth.base)/api/email.php?action=chat_call_add") else {
            return fail("generic")
        }
        var body: [String: Any] = [
            "action": "chat_call_add",
            "call_id": callId,
            "video": isVideo ? 1 : 0,
            "emails": Array(emails.prefix(16)),
        ]
        if let cid = Int(conversationId) { body["conversation_id"] = cid }

        var req = URLRequest(url: url, timeoutInterval: 15.0)
        req.httpMethod = "POST"
        req.setValue("Bearer \(auth.token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        let data: Data
        let status: Int
        do {
            let (d, resp) = try await URLSession.shared.data(for: req)
            data = d
            status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        } catch {
            return fail("network")
        }
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return fail(status == 429 ? "rate_limited" : "generic")
        }
        let d = (root["data"] as? [String: Any]) ?? [:]
        let skipped: [Skipped] = ((d["skipped"] as? [[String: Any]]) ?? []).compactMap { s in
            guard let e = s["email"] as? String else { return nil }
            return Skipped(email: e.lowercased(), reason: (s["reason"] as? String) ?? "generic")
        }
        if (root["success"] as? Bool) != true {
            var code = (d["code"] as? String) ?? ""
            if code.isEmpty {
                let m = ((root["message"] as? String) ?? "").lowercased()
                if status == 429 || m.contains("rate") { code = "rate_limited" }
                else if m.contains("blocked") { code = "blocked" }
                else if m.contains("no valid invitees") { code = "not_allowed" }
                else if m.contains("not a member") { code = "not_in_call" }
                else { code = "generic" }
            }
            return AddResult(ok: false, code: code, invited: [], skipped: skipped)
        }
        let invited: [Invited] = ((d["invited"] as? [[String: Any]]) ?? []).compactMap { i in
            guard let e = i["email"] as? String else { return nil }
            let reachable = (i["reachable"] as? Bool) ?? true
            return Invited(email: e.lowercased(), reachable: reachable)
        }
        return AddResult(ok: true, code: "", invited: invited.isEmpty ? emails.map { Invited(email: $0, reachable: true) } : invited, skipped: skipped)
    }

    /// Texto claro e traduzido para um código de erro.
    static func errorText(_ code: String, name: String) -> String {
        let key: String
        switch code {
        case "not_allowed": key = "pk.errNotAllowed"
        case "blocked": key = "pk.errBlocked"
        case "not_in_call": key = "pk.errNotInCall"
        case "parental": key = "pk.errParental"
        case "rate_limited": key = "pk.errRateLimited"
        case "offline": key = "pk.errOffline"
        case "limit": key = "pk.errLimit"
        case "network": key = "pk.errNetwork"
        default: key = "pk.errGeneric"
        }
        return GroupCallStrings.s(key, ["name": name])
    }
}

// MARK: - Avatar (foto real; iniciais P&B enquanto carrega / sem foto)

private struct PickerAvatar: View {
    let name: String
    let urlString: String
    let size: CGFloat

    private var initials: String {
        let parts = name.split(whereSeparator: { $0 == " " || $0 == "." || $0 == "_" }).prefix(2)
        let s = parts.compactMap { $0.first.map { String($0) } }.joined()
        return s.isEmpty ? "?" : s.uppercased()
    }

    var body: some View {
        ZStack {
            Circle().fill(Color(white: 0.2))
            Text(initials)
                .font(.system(size: size * 0.36, weight: .semibold))
                .foregroundColor(.white)
            if !urlString.isEmpty, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    if let img = phase.image {
                        img.resizable().scaledToFill()
                    } else {
                        Color.clear
                    }
                }
                .frame(width: size, height: size)
                .clipShape(Circle())
            }
        }
        .frame(width: size, height: size)
    }
}

// MARK: - SwiftUI sheet

struct CallParticipantPickerView: View {
    typealias Candidate = CallParticipantsAPI.Candidate

    let callId: String
    let conversationId: String
    let isVideo: Bool
    /// Identities already in the call (lowercased emails) — pill "Na chamada".
    let alreadyInCall: Set<String>
    let onDismiss: () -> Void

    private struct PickerSection: Identifiable {
        let id: String
        let title: String
        let items: [Candidate]
    }

    @State private var query = ""
    @State private var recent: [Candidate] = []
    @State private var contacts: [Candidate] = []
    @State private var results: [Candidate]? = nil
    @State private var loading = true
    @State private var loadFailed = false
    @State private var searching = false
    @State private var searchTask: Task<Void, Never>? = nil
    @State private var selected: [String: Candidate] = [:]
    @State private var selectionOrder: [String] = []
    @State private var ringing: Set<String> = []
    @State private var adding = false
    @State private var banner: String? = nil

    private let bg = Color(white: 0.07)
    private let surface = Color(white: 0.12)
    private let surface2 = Color(white: 0.165)
    private let text2 = Color(white: 0.64)
    private let text3 = Color(white: 0.45)
    private let maxFanout = 16

    var body: some View {
        VStack(spacing: 0) {
            header
            searchField
            if let b = banner {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.circle")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(.white)
                    Text(b)
                        .font(.system(size: 14))
                        .foregroundColor(.white)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 12).fill(surface2))
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }
            if !selectionOrder.isEmpty { selectedStrip }
            content
            footer
        }
        .background(bg.edgesIgnoringSafeArea(.all))
        .preferredColorScheme(.dark)
        .task { await loadBase() }
        .onChange(of: query) { q in scheduleSearch(q) }
    }

    // MARK: header / search

    private var header: some View {
        HStack {
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(.white)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(surface))
            }
            .accessibilityLabel(Text(GroupCallStrings.s("pk.close")))
            Spacer()
            Text(GroupCallStrings.s("pk.title"))
                .font(.system(size: 17, weight: .semibold))
                .foregroundColor(.white)
                .lineLimit(1)
            Spacer()
            Color.clear.frame(width: 36, height: 36)
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 8)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(text2)
            ZStack(alignment: .leading) {
                if query.isEmpty {
                    Text(GroupCallStrings.s("pk.search"))
                        .font(.system(size: 16))
                        .foregroundColor(text3)
                        .lineLimit(1)
                }
                TextField("", text: $query)
                    .font(.system(size: 16))
                    .foregroundColor(.white)
                    .accentColor(.white)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
            }
            if searching {
                ProgressView().scaleEffect(0.8)
            } else if !query.isEmpty {
                Button(action: { query = "" }) {
                    Image(systemName: "xmark.circle.fill").foregroundColor(text3)
                }
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .background(RoundedRectangle(cornerRadius: 12).fill(surface))
        .padding(.horizontal, 16)
    }

    private var selectedStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 14) {
                ForEach(selectionOrder, id: \.self) { email in
                    if let c = selected[email] {
                        Button(action: { toggle(c) }) {
                            VStack(spacing: 4) {
                                ZStack(alignment: .topTrailing) {
                                    PickerAvatar(name: c.name, urlString: c.avatar, size: 48)
                                    Image(systemName: "xmark")
                                        .font(.system(size: 8, weight: .bold))
                                        .foregroundColor(.white)
                                        .frame(width: 18, height: 18)
                                        .background(Circle().fill(surface2))
                                        .overlay(Circle().stroke(bg, lineWidth: 1.5))
                                }
                                Text(c.name)
                                    .font(.system(size: 11))
                                    .foregroundColor(text2)
                                    .lineLimit(1)
                                    .frame(width: 58)
                            }
                        }
                        .buttonStyle(PlainButtonStyle())
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
        }
        .frame(height: 84)
    }

    // MARK: lista

    private func sections() -> [PickerSection] {
        let raw = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let q = CallParticipantsAPI.fold(raw.hasPrefix("@") ? String(raw.dropFirst()) : raw)
        if !q.isEmpty {
            let list: [Candidate]
            if let r = results {
                list = r
            } else {
                list = (recent + contacts).filter {
                    CallParticipantsAPI.fold($0.name).contains(q)
                        || CallParticipantsAPI.fold($0.username).contains(q)
                        || $0.email.hasPrefix(q)
                }
            }
            return list.isEmpty ? [] : [PickerSection(id: "results", title: GroupCallStrings.s("pk.results"), items: list)]
        }
        var out: [PickerSection] = []
        if !recent.isEmpty { out.append(PickerSection(id: "recent", title: GroupCallStrings.s("pk.recent"), items: recent)) }
        if !contacts.isEmpty { out.append(PickerSection(id: "contacts", title: GroupCallStrings.s("pk.contacts"), items: contacts)) }
        return out
    }

    @ViewBuilder private var content: some View {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let noBase = recent.isEmpty && contacts.isEmpty
        if loading && noBase && q.isEmpty {
            skeleton
        } else if loadFailed && noBase && q.isEmpty {
            VStack(spacing: 12) {
                Spacer()
                Image(systemName: "exclamationmark.circle").font(.system(size: 30)).foregroundColor(text3)
                Text(GroupCallStrings.s("pk.loadError"))
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(.white)
                    .multilineTextAlignment(.center)
                Button(action: { Task { await loadBase() } }) {
                    Text(GroupCallStrings.s("pk.retry"))
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 9)
                        .overlay(Capsule().stroke(Color.white.opacity(0.3), lineWidth: 1))
                }
                Spacer()
            }
            .padding(.horizontal, 32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let secs = sections()
            if secs.isEmpty {
                VStack(spacing: 10) {
                    Spacer()
                    if !q.isEmpty && searching {
                        ProgressView()
                    } else {
                        Image(systemName: "person.2").font(.system(size: 30)).foregroundColor(text3)
                        Text(q.isEmpty ? GroupCallStrings.s("pk.emptyTitle") : GroupCallStrings.s("pk.noResults", ["q": q]))
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(.white)
                            .multilineTextAlignment(.center)
                        if q.isEmpty {
                            Text(GroupCallStrings.s("pk.emptyBody"))
                                .font(.system(size: 14))
                                .foregroundColor(text2)
                                .multilineTextAlignment(.center)
                        }
                    }
                    Spacer()
                }
                .padding(.horizontal, 32)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(secs) { sec in
                            Text(sec.title)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(text2)
                                .padding(.horizontal, 20)
                                .padding(.top, 14)
                                .padding(.bottom, 6)
                            ForEach(sec.items) { c in row(c) }
                        }
                    }
                    .padding(.bottom, 12)
                }
            }
        }
    }

    private var skeleton: some View {
        VStack(spacing: 0) {
            ForEach(0..<6, id: \.self) { i in
                HStack(spacing: 14) {
                    Circle().fill(surface2).frame(width: 46, height: 46)
                    VStack(alignment: .leading, spacing: 8) {
                        RoundedRectangle(cornerRadius: 6).fill(surface2).frame(width: CGFloat(170 - i * 12), height: 13)
                        RoundedRectangle(cornerRadius: 5).fill(surface2).frame(width: 80, height: 10)
                    }
                    Spacer()
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
            }
            Spacer()
        }
        .padding(.top, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func state(of c: Candidate) -> String {
        if alreadyInCall.contains(c.email) || c.callState == "in_call" { return "in_call" }
        if ringing.contains(c.email) || c.callState == "ringing" { return "ringing" }
        return ""
    }

    private func row(_ c: Candidate) -> some View {
        let st = state(of: c)
        let isSel = selected[c.email] != nil
        let sub = (!c.username.isEmpty && CallParticipantsAPI.fold(c.username) != CallParticipantsAPI.fold(c.name)) ? "@\(c.username)" : ""
        return Button(action: { toggle(c) }) {
            HStack(spacing: 14) {
                PickerAvatar(name: c.name, urlString: c.avatar, size: 46)
                VStack(alignment: .leading, spacing: 2) {
                    Text(c.name)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundColor(st.isEmpty ? .white : text2)
                        .lineLimit(1)
                    if !sub.isEmpty {
                        Text(sub)
                            .font(.system(size: 13))
                            .foregroundColor(text2)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if !st.isEmpty {
                    Text(st == "in_call" ? GroupCallStrings.s("pk.inCall") : GroupCallStrings.s("pk.ringing"))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(text2)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Capsule().fill(surface2))
                } else {
                    ZStack {
                        Circle()
                            .stroke(Color.white.opacity(isSel ? 1.0 : 0.35), lineWidth: 2)
                            .frame(width: 24, height: 24)
                        if isSel {
                            Circle().fill(Color.white).frame(width: 24, height: 24)
                            Image(systemName: "checkmark")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundColor(.black)
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(PlainButtonStyle())
        .disabled(!st.isEmpty || adding)
    }

    private var footer: some View {
        let n = selectionOrder.count
        let label = n > 0 ? GroupCallStrings.s("pk.addN", ["n": String(n)]) : GroupCallStrings.s("pk.add")
        return Button(action: addSelected) {
            ZStack {
                if adding {
                    ProgressView().progressViewStyle(CircularProgressViewStyle(tint: .black))
                } else {
                    Text(label)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(n == 0 ? text3 : .black)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .background(Capsule().fill(n == 0 ? surface2 : Color.white))
        }
        .disabled(n == 0 || adding)
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
    }

    // MARK: ações

    private func toggle(_ c: Candidate) {
        guard state(of: c).isEmpty, !adding else { return }
        banner = nil
        if selected[c.email] != nil {
            selected[c.email] = nil
            selectionOrder.removeAll { $0 == c.email }
        } else {
            guard selectionOrder.count < maxFanout else { return }
            selected[c.email] = c
            selectionOrder.append(c.email)
        }
        UISelectionFeedbackGenerator().selectionChanged()
    }

    private func loadBase() async {
        await MainActor.run {
            loading = true
            loadFailed = false
        }
        let r = await CallParticipantsAPI.fetchCandidates(query: "", callId: callId)
        await MainActor.run {
            if r.ok {
                recent = r.recent
                contacts = r.contacts
            } else {
                loadFailed = true
            }
            loading = false
        }
    }

    private func scheduleSearch(_ raw: String) {
        searchTask?.cancel()
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if q.isEmpty {
            results = nil
            searching = false
            return
        }
        searching = true
        let cid = callId
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 280_000_000)
            if Task.isCancelled { return }
            let r = await CallParticipantsAPI.fetchCandidates(query: q, callId: cid)
            if Task.isCancelled { return }
            await MainActor.run {
                results = r.ok ? r.results : nil
                searching = false
            }
        }
    }

    private func displayName(_ email: String) -> String {
        if let c = selected[email] { return c.name }
        if let c = (recent + contacts + (results ?? [])).first(where: { $0.email == email }) { return c.name }
        return String(email.prefix(while: { $0 != "@" }))
    }

    private func addSelected() {
        guard !adding, !selectionOrder.isEmpty else { return }
        let emails = Array(selectionOrder.prefix(maxFanout))
        let names = emails.map { displayName($0) }
        adding = true
        banner = nil
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        Task {
            let res = await CallParticipantsAPI.ringIntoCall(
                callId: callId,
                conversationId: conversationId,
                emails: emails,
                isVideo: isVideo
            )
            await MainActor.run {
                adding = false
                if !res.ok {
                    let who = res.skipped.isEmpty
                        ? names.joined(separator: ", ")
                        : res.skipped.map { displayName($0.email) }.joined(separator: ", ")
                    banner = CallParticipantsAPI.errorText(res.code, name: who)
                    UINotificationFeedbackGenerator().notificationOccurred(.error)
                    return
                }
                var problems: [String] = []
                for s in res.skipped { problems.append(CallParticipantsAPI.errorText(s.reason, name: displayName(s.email))) }
                for i in res.invited where !i.reachable { problems.append(CallParticipantsAPI.errorText("offline", name: displayName(i.email))) }
                for i in res.invited { ringing.insert(i.email) }
                selected = [:]
                selectionOrder = []
                if problems.isEmpty {
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    onDismiss()
                } else {
                    banner = problems.prefix(2).joined(separator: "\n")
                }
            }
        }
    }
}
