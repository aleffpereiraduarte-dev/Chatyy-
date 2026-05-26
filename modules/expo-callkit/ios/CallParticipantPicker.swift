// CallParticipantPicker.swift
// [add-participant 2026-05-26] WhatsApp-style "add participant to active call".
// Native SwiftUI contact picker presented from CallViewController's in-call
// controls. Lists the user's Chatyy contacts and rings a selected contact
// INTO the running call's LiveKit room (same call_id) via the backend
// `chat_call_add` endpoint.
//
// Auth: reuses the SAME App Group UserDefaults the call-token path relies on
// (group.com.onemundo.mail → auth_token + api_base) — no new auth plumbing.
//
// Backend contracts:
//   GET  <base>/api/chat.php?action=chat_contacts
//        → { success, data: [ { email, name, status, last_seen }, ... ] }
//   POST <base>/api/chat.php?action=chat_call_add
//        body { action, call_id, conversation_id, video, emails:[email] }
//        → rings the invitee into the EXISTING room (room == call_id).

import SwiftUI
import Foundation

// MARK: - Networking

enum CallParticipantsAPI {
    struct Contact: Identifiable, Hashable {
        let email: String
        let name: String
        let online: Bool
        var id: String { email }
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

    /// Fetch the caller's Chatyy contacts. Returns [] on any failure.
    static func fetchContacts() async -> [Contact] {
        guard let auth = resolveAuth(),
              let url = URL(string: "\(auth.base)/api/chat.php?action=chat_contacts") else {
            return []
        }
        var req = URLRequest(url: url, timeoutInterval: 10.0)
        req.httpMethod = "GET"
        req.setValue("Bearer \(auth.token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return []
            }
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (root["success"] as? Bool) == true else {
                return []
            }
            // `data` is a bare array for chat_contacts; tolerate an object wrapper too.
            let arr: [[String: Any]]
            if let a = root["data"] as? [[String: Any]] {
                arr = a
            } else if let obj = root["data"] as? [String: Any],
                      let a = obj["contacts"] as? [[String: Any]] {
                arr = a
            } else {
                arr = []
            }
            return arr.compactMap { o in
                guard let email = (o["email"] as? String)?.trimmingCharacters(in: .whitespaces),
                      !email.isEmpty else { return nil }
                var name = (o["name"] as? String) ?? ""
                if name.isEmpty { name = String(email.prefix(while: { $0 != "@" })) }
                let online = ((o["status"] as? String) ?? "offline").lowercased() == "online"
                return Contact(email: email, name: name, online: online)
            }
        } catch {
            return []
        }
    }

    /// Ring [email] into the running call (room == callId). Returns true on success.
    static func ringIntoCall(callId: String, conversationId: String, email: String, isVideo: Bool) async -> Bool {
        guard !callId.isEmpty, !email.isEmpty,
              let auth = resolveAuth(),
              let url = URL(string: "\(auth.base)/api/chat.php?action=chat_call_add") else {
            return false
        }
        var body: [String: Any] = [
            "action": "chat_call_add",
            "call_id": callId,
            "video": isVideo ? 1 : 0,
            "emails": [email],
        ]
        if let cid = Int(conversationId) { body["conversation_id"] = cid }

        var req = URLRequest(url: url, timeoutInterval: 10.0)
        req.httpMethod = "POST"
        req.setValue("Bearer \(auth.token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return false
            }
            if let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return (root["success"] as? Bool) == true
            }
            return false
        } catch {
            return false
        }
    }
}

// MARK: - SwiftUI sheet

struct CallParticipantPickerView: View {
    let callId: String
    let conversationId: String
    let isVideo: Bool
    /// Identities already in the call (lowercased emails) — filtered out.
    let alreadyInCall: Set<String>
    let onDismiss: () -> Void

    @State private var contacts: [CallParticipantsAPI.Contact] = []
    @State private var loading = true
    @State private var busyEmail: String? = nil
    @State private var invited: Set<String> = []
    @State private var errorText: String? = nil

    var body: some View {
        NavigationView {
            Group {
                if loading {
                    ProgressView("Carregando contatos…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if contacts.isEmpty {
                    Text("Nenhum contato disponível")
                        .foregroundColor(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(contacts) { c in
                        Button(action: { ring(c.email) }) {
                            HStack(spacing: 12) {
                                ZStack {
                                    Circle()
                                        .fill(Color(hue: hue(for: c.email), saturation: 0.55, brightness: 0.8))
                                        .frame(width: 40, height: 40)
                                    Text(String(c.name.prefix(1)).uppercased())
                                        .foregroundColor(.white)
                                        .font(.system(size: 16, weight: .semibold))
                                }
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(c.name).font(.system(size: 16, weight: .medium))
                                    Text(c.online ? "online" : c.email)
                                        .font(.system(size: 12))
                                        .foregroundColor(c.online ? .green : .secondary)
                                        .lineLimit(1)
                                }
                                Spacer()
                                if invited.contains(c.email) {
                                    Image(systemName: "checkmark.circle.fill").foregroundColor(.green)
                                } else if busyEmail == c.email {
                                    ProgressView()
                                } else {
                                    Image(systemName: "person.crop.circle.badge.plus")
                                        .foregroundColor(.accentColor)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .disabled(busyEmail != nil || invited.contains(c.email))
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Adicionar à chamada")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fechar", action: onDismiss)
                }
            }
            .safeAreaInset(edge: .top) {
                if let err = errorText {
                    Text(err)
                        .font(.footnote)
                        .foregroundColor(.red)
                        .padding(.vertical, 6)
                        .frame(maxWidth: .infinity)
                        .background(Color(.systemBackground))
                }
            }
        }
        .task { await load() }
    }

    private func hue(for key: String) -> Double {
        Double(abs(key.hashValue) % 360) / 360.0
    }

    private func load() async {
        loading = true
        let list = await CallParticipantsAPI.fetchContacts()
        let filtered = list.filter { !alreadyInCall.contains($0.email.lowercased()) }
        await MainActor.run {
            contacts = filtered
            loading = false
        }
    }

    private func ring(_ email: String) {
        guard busyEmail == nil else { return }
        busyEmail = email
        errorText = nil
        Task {
            let ok = await CallParticipantsAPI.ringIntoCall(
                callId: callId,
                conversationId: conversationId,
                email: email,
                isVideo: isVideo
            )
            await MainActor.run {
                if ok {
                    invited.insert(email)
                } else {
                    errorText = "Não foi possível chamar \(email)"
                }
                busyEmail = nil
            }
        }
    }
}
