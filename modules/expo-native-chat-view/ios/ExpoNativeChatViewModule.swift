import ExpoModulesCore
import UIKit
import AVFoundation
import AudioToolbox  // ★ For AudioServicesPlaySystemSoundID (chat send/receive sounds)
import SQLite3
import MapKit      // ★ For MKMapSnapshotter in LocationCell
import CoreLocation // ★ For CLLocationCoordinate2D in LocationCell
import CryptoKit    // ★ For stable SHA256 hash (image disk cache keys)

/// ExpoNativeChatViewModule
///
/// THE WhatsApp move: a real UICollectionView wrapped as an Expo View, reading
/// messages directly from the expo-chat-cache SQLite database on the same
/// thread that lays out the cells. Zero JS bridge in the scroll path, zero
/// flicker on first paint, native-grade prefetching via
/// UICollectionViewDataSourcePrefetching.
///
/// Cell features (all rendered natively):
///   • Text bubble with auto-link detection
///   • Image / video bubble with cached thumbnail
///   • Voice message with waveform + AVAudioPlayer playback
///   • System message (centered grey pill)
///   • Reactions row (emoji + count)
///   • Reply-to preview header
///   • Sent / delivered / read checkmarks
///   • Date separators (sticky between days)
///   • Long-press → onMessageLongPress event (JS shows context menu)
///   • Tap on bubble → onMessageTap
///   • Tap on reaction → onReactionTap
///
/// SQLite path: same as expo-chat-cache → <Caches>/chatyy_chat_cache.sqlite

private let DB_NAME = "chatyy_chat_cache.sqlite"
private let MESSAGE_LIMIT = 200

// MARK: - Dynamic colors for dark mode support
private let dmTP = UIColor { t in t.userInterfaceStyle == .dark ? UIColor(white: 0.93, alpha: 1) : UIColor(red: 0.07, green: 0.11, blue: 0.13, alpha: 1) }
private let dmTS = UIColor { t in t.userInterfaceStyle == .dark ? UIColor(white: 0.60, alpha: 1) : UIColor(red: 0.40, green: 0.47, blue: 0.51, alpha: 1) }
private let dmCB = UIColor { t in t.userInterfaceStyle == .dark ? UIColor(red: 0.15, green: 0.20, blue: 0.25, alpha: 1) : UIColor.white }
private let dmOCB = UIColor { t in t.userInterfaceStyle == .dark ? UIColor(red: 0.30, green: 0.11, blue: 0.58, alpha: 1) : UIColor(red: 0.93, green: 0.91, blue: 1.0, alpha: 1) } // Purple own bubble
private let dmRBg = UIColor { t in t.userInterfaceStyle == .dark ? UIColor.white.withAlphaComponent(0.08) : UIColor.black.withAlphaComponent(0.05) }
private let dmDiv = UIColor { t in t.userInterfaceStyle == .dark ? UIColor(white: 1, alpha: 0.10) : UIColor(white: 0, alpha: 0.08) }
private let dmBrd = UIColor { t in t.userInterfaceStyle == .dark ? UIColor(white: 0.30, alpha: 1) : UIColor(red: 0.92, green: 0.94, blue: 0.95, alpha: 1) }
private let dmTBg = UIColor { t in t.userInterfaceStyle == .dark ? UIColor(white: 0.20, alpha: 1) : UIColor(white: 0.94, alpha: 1) }
private let dmMPh = UIColor { t in t.userInterfaceStyle == .dark ? UIColor(white: 0.20, alpha: 1) : UIColor(red: 0.92, green: 0.93, blue: 0.92, alpha: 1) }
private let dmSFB = UIColor { t in t.userInterfaceStyle == .dark ? UIColor(white: 0.20, alpha: 0.95) : UIColor(white: 1, alpha: 0.95) }
private let dmSFT = UIColor { t in t.userInterfaceStyle == .dark ? UIColor(red: 0.65, green: 0.55, blue: 0.98, alpha: 1) : UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1) } // Purple FAB tint
private let dmSPB = UIColor { t in t.userInterfaceStyle == .dark ? UIColor(red: 0.20, green: 0.18, blue: 0.10, alpha: 0.95) : UIColor(red: 1.0, green: 0.96, blue: 0.78, alpha: 0.95) }
private let dmSPT = UIColor { t in t.userInterfaceStyle == .dark ? UIColor(white: 0.80, alpha: 1) : UIColor(red: 0.30, green: 0.36, blue: 0.40, alpha: 1) }
private let dmRPB = UIColor { t in t.userInterfaceStyle == .dark ? UIColor(red: 0.18, green: 0.23, blue: 0.28, alpha: 1) : UIColor.white }
private let dmMBB = UIColor { t in t.userInterfaceStyle == .dark ? UIColor(white: 0.35, alpha: 1) : UIColor(white: 0.85, alpha: 1) }
private let dmIT = UIColor { t in t.userInterfaceStyle == .dark ? UIColor(white: 0.70, alpha: 1) : UIColor(red: 0.30, green: 0.36, blue: 0.40, alpha: 1) }

public class ExpoNativeChatViewModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativeChatView")

        // ───────── iOS system sounds (no bundled files needed) ─────────
        // Used by chat-conversation.js when sending or receiving messages.
        // System sound IDs from /System/Library/Audio/UISounds:
        //   1004 = SMS sent (subtle "whoosh") — used for chat send
        //   1003 = Mail sent — used for chat receive (soft pop)
        AsyncFunction("playSendSound") {
            AudioServicesPlaySystemSound(1004)
        }
        AsyncFunction("playReceiveSound") {
            AudioServicesPlaySystemSound(1003)
        }

        View(NativeChatCollectionView.self) {
            Events(
                "onMessageTap",
                "onMessageLongPress",
                "onReactionTap",
                "onReachTop",
                "onScroll",
                "onLoaded",
                "onSwipeReply",     // emitted when user swipes a bubble right past the threshold
                "onContextAction",  // emitted from the native UIContextMenu (reply/forward/copy/delete/react)
                "onRefresh",        // emitted when user pull-to-refreshes
                "onSelectionChange",// emitted when selection mode changes (count: N)
                "onScrollToBottom", // emitted from the floating jump-to-bottom button
                // ★ WhatsApp multi-view type events
                "onPollVote",       // emitted when user votes on poll { messageId, optionIndex }
                "onMeetupRsvp",     // emitted when user RSVPs meetup { messageId, status: "going"|"maybe"|"not_going" }
                "onLocationTap"     // emitted when user taps location map { messageId, latitude, longitude, label }
            )

            Prop("conversationId") { (view: NativeChatCollectionView, value: Int) in
                view.setConversationId(value)
            }
            // ★ PRIMARY DATA SOURCE: JS passes messages directly via prop.
            // This replaces the old SQLite-only approach which had stale/empty
            // content because the cache was corrupted or NSNull wasn't handled.
            // The native view now uses JS data (same as FlatList) for rendering.
            Prop("messages") { (view: NativeChatCollectionView, value: [[String: Any]]?) in
                guard let msgs = value, !msgs.isEmpty else { return }
                view.setMessagesFromJS(msgs)
            }
            Prop("myEmail") { (view: NativeChatCollectionView, value: String) in
                view.myEmail = value
                view.collectionView.reloadData()
            }
            Prop("ownBubbleColor") { (view: NativeChatCollectionView, value: String?) in
                view.ownBubbleColor = NativeChatCollectionView.colorFromHex(value ?? "#EDE9FE")
                view.collectionView.reloadData()
            }
            Prop("otherBubbleColor") { (view: NativeChatCollectionView, value: String?) in
                view.otherBubbleColor = NativeChatCollectionView.colorFromHex(value ?? "#ffffff")
                view.collectionView.reloadData()
            }
            Prop("listBackgroundColor") { (view: NativeChatCollectionView, value: String?) in
                view.collectionView.backgroundColor =
                    NativeChatCollectionView.colorFromHex(value ?? "#0b141a")
            }
            Prop("textColor") { (view: NativeChatCollectionView, value: String?) in
                view.textColor = NativeChatCollectionView.colorFromHex(value ?? "#111b21")
                view.collectionView.reloadData()
            }
            Prop("metaColor") { (view: NativeChatCollectionView, value: String?) in
                view.metaColor = NativeChatCollectionView.colorFromHex(value ?? "#667781")
                view.collectionView.reloadData()
            }
            Prop("isGroupChat") { (view: NativeChatCollectionView, value: Bool?) in
                view.isGroupChat = value ?? false
                view.collectionView.reloadData()
            }
            Prop("selectedIds") { (view: NativeChatCollectionView, value: [Int]?) in
                view.selectedMessageIds = Set(value ?? [])
                view.collectionView.reloadData()
            }

            // JS calls this to force a refresh after adding a message locally.
            AsyncFunction("reload") { (view: NativeChatCollectionView) in
                view.reloadFromCache(preserveScroll: false)
            }

            // JS calls this after loading OLDER messages so the native view
            // refreshes from cache WITHOUT jumping to bottom.
            AsyncFunction("reloadPreservingScroll") { (view: NativeChatCollectionView) in
                view.reloadFromCache(preserveScroll: true)
            }

            // JS calls this to scroll to the bottom (after sending a message).
            AsyncFunction("scrollToBottom") { (view: NativeChatCollectionView, animated: Bool) in
                DispatchQueue.main.async { view.scrollToBottom(animated: animated) }
            }

            // JS calls this when its server fetch finishes after a pull-to-refresh.
            AsyncFunction("endRefreshing") { (view: NativeChatCollectionView) in
                DispatchQueue.main.async { view.endRefreshing() }
            }
        }
    }
}

// MARK: - Native chat collection view

public final class NativeChatCollectionView: ExpoView,
    UICollectionViewDataSource,
    UICollectionViewDelegateFlowLayout,
    UICollectionViewDataSourcePrefetching {

    // ─── Public-ish state set by props ───────────────────────────
    var myEmail: String = ""
    var ownBubbleColor: UIColor = UIColor(red: 0.93, green: 0.91, blue: 1.0, alpha: 1)
    var otherBubbleColor: UIColor = .white
    var textColor: UIColor = UIColor(red: 0.07, green: 0.11, blue: 0.13, alpha: 1)
    var metaColor: UIColor = UIColor(red: 0.40, green: 0.47, blue: 0.51, alpha: 1)
    /// True for group chats — enables sender name labels above each non-own bubble.
    var isGroupChat: Bool = false
    /// Set of selected message ids — when non-empty, cells render a selection
    /// highlight overlay. Updated via the `selectedIds` prop from JS.
    var selectedMessageIds: Set<Int> = []
    /// Cached location of the most recent context menu trigger (used by
    /// previewForHighlighting to find the right cell)
    fileprivate var lastContextMenuLocation: CGPoint?
    fileprivate var lastContextMenuIndexPath: IndexPath?

    // ─── Events sent back to JS ──────────────────────────────────
    let onMessageTap = EventDispatcher()
    let onMessageLongPress = EventDispatcher()
    let onReactionTap = EventDispatcher()
    let onReachTop = EventDispatcher()
    let onScroll = EventDispatcher()
    let onLoaded = EventDispatcher()
    let onSwipeReply = EventDispatcher()
    let onContextAction = EventDispatcher()
    let onRefresh = EventDispatcher()
    let onSelectionChange = EventDispatcher()
    let onScrollToBottom = EventDispatcher()
    // ★ WhatsApp multi-view type events
    let onPollVote = EventDispatcher()
    let onMeetupRsvp = EventDispatcher()
    let onLocationTap = EventDispatcher()
    private let refreshControl = UIRefreshControl()

    // ─── Scroll-to-bottom FAB ────────────────────────────────────
    private let scrollToBottomBtn = UIButton(type: .system)
    private let unreadBadge = UILabel()
    private var scrollFabHidden = true
    private var unreadNewCount = 0

    // ─── Keyboard handling ───────────────────────────────────────
    private var keyboardHeight: CGFloat = 0
    private var scrollToBottomBtnBottom: NSLayoutConstraint?

    // ─── Selection mode ──────────────────────────────────────────
    private var selectionMode = false
    private var selectedIds = Set<Int>()

    // ─── Data ────────────────────────────────────────────────────
    private var conversationId: Int = 0
    /// Mixed array of message dicts and date-separator markers.
    /// Date markers look like: ["__separator__": "March 8, 2026"]
    private var rows: [[String: Any]] = []
    var heightCache: [String: CGFloat] = [:] // by row.id or "sep_<title>" — internal for BubbleCell self-sizing

    // ─── UICollectionView ────────────────────────────────────────
    let collectionView: UICollectionView
    private let layout: UICollectionViewFlowLayout

    public required init(appContext: AppContext? = nil) {
        let layout = UICollectionViewFlowLayout()
        layout.minimumLineSpacing = 0  // Spacing handled per-item in sizeForItemAt
        layout.minimumInteritemSpacing = 0
        layout.scrollDirection = .vertical
        // CRITICAL: disable flow layout's self-sizing feedback loop. We compute
        // our own heights deterministically in sizeForItemAt — the extra layout
        // pass caused "flash/overlap" artifacts on first render (Telegram/Chatto
        // do the same).
        layout.estimatedItemSize = .zero
        self.layout = layout

        self.collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)

        super.init(appContext: appContext)

        collectionView.translatesAutoresizingMaskIntoConstraints = false
        collectionView.backgroundColor = UIColor(red: 0.04, green: 0.08, blue: 0.10, alpha: 1)
        collectionView.dataSource = self
        collectionView.delegate = self
        collectionView.prefetchDataSource = self
        collectionView.alwaysBounceVertical = true
        collectionView.keyboardDismissMode = .interactive
        collectionView.showsVerticalScrollIndicator = false
        collectionView.contentInsetAdjustmentBehavior = .never
        collectionView.contentInset.bottom = 0 // JS handles input bar spacing

        // Cell types
        collectionView.register(BubbleCell.self, forCellWithReuseIdentifier: "bubble")
        collectionView.register(SeparatorCell.self, forCellWithReuseIdentifier: "separator")
        collectionView.register(SystemCell.self, forCellWithReuseIdentifier: "system")

        // ★ WhatsApp multi-view type cells (7 new specialized cell types)
        collectionView.register(PollCell.self, forCellWithReuseIdentifier: "poll")
        collectionView.register(LocationCell.self, forCellWithReuseIdentifier: "location")
        collectionView.register(MeetupCell.self, forCellWithReuseIdentifier: "meetup")
        collectionView.register(ContactCell.self, forCellWithReuseIdentifier: "contact")
        collectionView.register(PlaylistCell.self, forCellWithReuseIdentifier: "playlist")
        collectionView.register(CallCardCell.self, forCellWithReuseIdentifier: "call_card")
        collectionView.register(GifStickerCell.self, forCellWithReuseIdentifier: "gif_sticker")

        addSubview(collectionView)
        NSLayoutConstraint.activate([
            collectionView.topAnchor.constraint(equalTo: topAnchor),
            collectionView.leadingAnchor.constraint(equalTo: leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: trailingAnchor),
            collectionView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        // When the wrapper view's bounds change (e.g. screen rotation,
        // keyboard shown, or initial layout pass moving from 0 to N), we
        // invalidate the collection view layout so cells recompute their
        // size with the correct width. This is the missing piece that was
        // leaving text bubbles with 0 width on first paint.
        observeBoundsChanges()

        // NOTE: long-press is handled exclusively by UIContextMenuInteraction
        // (added below). A second UILongPressGestureRecognizer was firing in
        // parallel and opening the JS modal at the same time as the native
        // blur menu — that's the "selecting weird" double-trigger.

        // Tap recognizer for reaction pills (separate from didSelectItemAt
        // because we want to identify which subview was tapped)
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        tap.cancelsTouchesInView = false
        collectionView.addGestureRecognizer(tap)

        // Swipe-to-reply: a horizontal pan that pulls a row right while
        // active and snaps back when released. If the swipe crosses the
        // threshold (60pt), we emit onSwipeReply for the row underneath.
        let swipe = UIPanGestureRecognizer(target: self, action: #selector(handleSwipe(_:)))
        swipe.delegate = self
        collectionView.addGestureRecognizer(swipe)

        // UIContextMenuInteraction on the collection view itself, so a
        // long-press on any bubble shows the iOS blur peek menu (like
        // iMessage) instead of the modal we used before.
        let interaction = UIContextMenuInteraction(delegate: self)
        collectionView.addInteraction(interaction)

        // ⭐ Pull-to-refresh DISABLED — WhatsApp doesn't have it.
        // Messages arrive in real-time via TCP/WebSocket. No need for manual refresh.
        // Keeping refreshControl reference but not attaching to collectionView.
        // event for JS to fetch newer messages from the server. JS calls
        // `endRefreshing()` when done. Includes haptic feedback.
        refreshControl.addTarget(self, action: #selector(handlePullRefresh), for: .valueChanged)
        refreshControl.tintColor = UIColor(white: 1, alpha: 0.7)
        // collectionView.refreshControl = refreshControl  // Disabled: WhatsApp-style real-time

        // ⭐ Floating "jump to bottom" button
        scrollToBottomBtn.translatesAutoresizingMaskIntoConstraints = false
        scrollToBottomBtn.backgroundColor = dmSFB
        scrollToBottomBtn.setImage(UIImage(systemName: "chevron.down"), for: .normal)
        scrollToBottomBtn.tintColor = dmSFT
        scrollToBottomBtn.layer.cornerRadius = 22
        scrollToBottomBtn.layer.shadowColor = UIColor.black.cgColor
        scrollToBottomBtn.layer.shadowOpacity = 0.2
        scrollToBottomBtn.layer.shadowRadius = 6
        scrollToBottomBtn.layer.shadowOffset = CGSize(width: 0, height: 2)
        scrollToBottomBtn.layer.shadowPath = UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: 44, height: 44), cornerRadius: 22).cgPath
        scrollToBottomBtn.addTarget(self, action: #selector(handleScrollToBottomTap), for: .touchUpInside)
        scrollToBottomBtn.alpha = 0
        scrollToBottomBtn.transform = CGAffineTransform(scaleX: 0.5, y: 0.5)
        addSubview(scrollToBottomBtn)
        let fabBottom = scrollToBottomBtn.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -20)
        scrollToBottomBtnBottom = fabBottom
        NSLayoutConstraint.activate([
            scrollToBottomBtn.widthAnchor.constraint(equalToConstant: 44),
            scrollToBottomBtn.heightAnchor.constraint(equalToConstant: 44),
            scrollToBottomBtn.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            fabBottom,
        ])

        // ★ Unread count badge on the scroll-to-bottom FAB (WhatsApp style)
        unreadBadge.translatesAutoresizingMaskIntoConstraints = false
        unreadBadge.backgroundColor = UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1)
        unreadBadge.textColor = .white
        unreadBadge.font = .systemFont(ofSize: 11, weight: .bold)
        unreadBadge.textAlignment = .center
        unreadBadge.layer.cornerRadius = 9
        unreadBadge.clipsToBounds = true
        unreadBadge.isHidden = true
        scrollToBottomBtn.addSubview(unreadBadge)
        NSLayoutConstraint.activate([
            unreadBadge.centerXAnchor.constraint(equalTo: scrollToBottomBtn.centerXAnchor),
            unreadBadge.bottomAnchor.constraint(equalTo: scrollToBottomBtn.topAnchor, constant: 6),
            unreadBadge.heightAnchor.constraint(equalToConstant: 18),
            unreadBadge.widthAnchor.constraint(greaterThanOrEqualToConstant: 18),
        ])

        // ★ Keyboard observation DISABLED — React Native's KeyboardAvoidingView
        // handles keyboard spacing. Native contentInset was conflicting (creating
        // extra blank space when keyboard opens).
        // NotificationCenter.default.addObserver(
        //     self, selector: #selector(keyboardWillShow(_:)),
        //     name: UIResponder.keyboardWillShowNotification, object: nil)
        // NotificationCenter.default.addObserver(
        //     self, selector: #selector(keyboardWillHide(_:)),
        //     name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Keyboard handling

    @objc private func keyboardWillShow(_ note: Notification) {
        guard let info = note.userInfo,
              let kbFrame = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue,
              let duration = info[UIResponder.keyboardAnimationDurationUserInfoKey] as? TimeInterval,
              let curveRaw = info[UIResponder.keyboardAnimationCurveUserInfoKey] as? UInt else { return }

        // Convert keyboard frame to our coordinate space
        let kbLocal = convert(kbFrame, from: nil)
        let overlap = max(0, bounds.maxY - kbLocal.minY)
        guard overlap > 0 else { return }

        let wasNearBottom = isNearBottom()
        keyboardHeight = overlap

        let curve = UIView.AnimationOptions(rawValue: curveRaw << 16)
        UIView.animate(withDuration: duration, delay: 0, options: [curve, .beginFromCurrentState], animations: {
            self.collectionView.contentInset.bottom = overlap
            self.collectionView.scrollIndicatorInsets.bottom = overlap
            // Move the FAB above the keyboard
            self.scrollToBottomBtnBottom?.constant = -(overlap + 12)
            self.layoutIfNeeded()
        })

        // If user was already near bottom, scroll to bottom so latest message stays visible
        if wasNearBottom {
            DispatchQueue.main.async { [weak self] in
                self?.scrollToBottom(animated: true)
            }
        }
    }

    @objc private func keyboardWillHide(_ note: Notification) {
        guard let info = note.userInfo,
              let duration = info[UIResponder.keyboardAnimationDurationUserInfoKey] as? TimeInterval,
              let curveRaw = info[UIResponder.keyboardAnimationCurveUserInfoKey] as? UInt else { return }

        keyboardHeight = 0
        let curve = UIView.AnimationOptions(rawValue: curveRaw << 16)
        UIView.animate(withDuration: duration, delay: 0, options: [curve, .beginFromCurrentState], animations: {
            self.collectionView.contentInset.bottom = 0 // JS handles input bar spacing
            self.collectionView.scrollIndicatorInsets.bottom = 60
            self.scrollToBottomBtnBottom?.constant = -20
            self.layoutIfNeeded()
        })
    }

    /// Returns true if the user is scrolled within 150pt of the bottom content edge.
    private func isNearBottom() -> Bool {
        let cv = collectionView
        let offset = cv.contentOffset.y
        let contentH = cv.contentSize.height
        let visibleH = cv.bounds.height - cv.adjustedContentInset.top - cv.adjustedContentInset.bottom
        return offset + visibleH >= contentH - 150
    }

    @objc private func handleScrollToBottomTap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        unreadNewCount = 0
        updateUnreadBadge()
        scrollToBottom(animated: true)
        onScrollToBottom([:])
    }

    private func updateUnreadBadge() {
        if unreadNewCount > 0 {
            unreadBadge.text = unreadNewCount > 99 ? "99+" : "\(unreadNewCount)"
            unreadBadge.isHidden = false
        } else {
            unreadBadge.isHidden = true
        }
    }

    private func updateScrollFab(visible: Bool) {
        if visible == !scrollFabHidden { return }
        scrollFabHidden = !visible
        UIView.animate(withDuration: 0.22, delay: 0,
                       usingSpringWithDamping: 0.7, initialSpringVelocity: 0.5,
                       options: [.curveEaseOut], animations: {
            self.scrollToBottomBtn.alpha = visible ? 1 : 0
            self.scrollToBottomBtn.transform = visible ? .identity : CGAffineTransform(scaleX: 0.5, y: 0.5)
        })
    }

    @objc private func handlePullRefresh() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        onRefresh([:])
        // Auto-end after 4s as a safety net in case JS forgets
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            self?.refreshControl.endRefreshing()
        }
    }

    func endRefreshing() {
        refreshControl.endRefreshing()
    }

    // MARK: - Public API

    func setConversationId(_ id: Int) {
        guard id != conversationId else { return }
        conversationId = id
        reloadFromCache()
    }

    /// ★ PRIMARY DATA PATH: JS passes messages directly via prop.
    /// This bypasses SQLite entirely — same data that FlatList renders.
    /// Fixes the "empty bubble" bug caused by corrupted/stale SQLite cache.
    func setMessagesFromJS(_ messages: [[String: Any]]) {
        let normalized = messages.map { Self.normalizeRow($0) }
        // Resolve reply_to_id → reply_to object for messages that only have the ID
        let byId: [String: [String: Any]] = {
            var dict: [String: [String: Any]] = [:]
            for m in normalized {
                if let id = m["id"] { dict["\(id)"] = m }
            }
            return dict
        }()
        let resolved = normalized.map { (msg: [String: Any]) -> [String: Any] in
            // If reply_to already exists as a dict, keep it
            if msg["reply_to"] is [String: Any] { return msg }
            // If reply_to_id exists, resolve it from the messages array
            guard let replyId = msg["reply_to_id"] else { return msg }
            let key = "\(replyId)"
            guard let ref = byId[key] else { return msg }
            var m = msg
            m["reply_to"] = [
                "id": ref["id"] ?? 0,
                "sender_email": ref["sender_email"] ?? "",
                "sender_name": ref["sender_name"] ?? (ref["sender_email"] as? String)?.components(separatedBy: "@").first ?? "",
                "content": ref["content"] ?? "",
                "type": ref["type"] ?? "text",
                "file_url": ref["file_url"] ?? "",
            ]
            return m
        }
        let previousIds = Set(rows.compactMap { $0["id"] as? Int })
        let newRows = insertDateSeparators(messages: resolved)
        let newIds = Set(newRows.compactMap { $0["id"] as? Int }).subtracting(previousIds)
        // iMessage-style incremental update: only insert new rows instead of
        // full reloadData(). This avoids recalculating ALL cell heights and
        // makes new messages appear instantly (< 16ms).
        let oldRows = self.rows
        let applyUpdate = { [weak self] in
            guard let self = self else { return }
            let isFirstLoad = oldRows.isEmpty
            self.animatedMessageIds = newIds

            if isFirstLoad || newRows.count < oldRows.count || newIds.count > 5 {
                // First load or major change: full reload
                self.rows = newRows
                self.heightCache.removeAll()
                self.collectionView.reloadData()
                self.collectionView.layoutIfNeeded()
            } else if !newIds.isEmpty {
                // Incremental: only invalidate heights for NEW messages, keep cached heights
                self.rows = newRows
                // Only clear heights for new items (not all)
                for i in oldRows.count..<newRows.count {
                    if let msgId = newRows[i]["id"] {
                        self.heightCache.removeValue(forKey: "\(msgId)")
                    }
                }
                // Insert new rows with animation
                self.collectionView.performBatchUpdates({
                    var indexPaths: [IndexPath] = []
                    for i in oldRows.count..<newRows.count {
                        indexPaths.append(IndexPath(item: i, section: 0))
                    }
                    if !indexPaths.isEmpty {
                        self.collectionView.insertItems(at: indexPaths)
                    }
                }, completion: nil)
            } else {
                // Same message count — find which rows actually changed and reload only those
                // This prevents the full-screen flicker that reloadData() causes
                var changedIndexPaths: [IndexPath] = []
                let oldCount = oldRows.count
                for i in 0..<min(oldCount, newRows.count) {
                    let oldRow = oldRows[i]
                    let newRow = newRows[i]
                    // Compare key fields that affect rendering
                    let oldStatus = (oldRow["status"] as? String) ?? ""
                    let newStatus = (newRow["status"] as? String) ?? ""
                    let oldReactions = (oldRow["reactions"] as? [[String: Any]])?.count ?? 0
                    let newReactions = (newRow["reactions"] as? [[String: Any]])?.count ?? 0
                    let oldEdited = (oldRow["edited_at"] as? String) ?? ""
                    let newEdited = (newRow["edited_at"] as? String) ?? ""
                    let oldDeleted = (oldRow["deleted_at"] as? String) ?? ""
                    let newDeleted = (newRow["deleted_at"] as? String) ?? ""
                    if oldStatus != newStatus || oldReactions != newReactions ||
                       oldEdited != newEdited || oldDeleted != newDeleted {
                        changedIndexPaths.append(IndexPath(item: i, section: 0))
                    }
                }
                self.rows = newRows
                if changedIndexPaths.isEmpty {
                    // Nothing actually changed — skip reload entirely (zero flicker)
                } else if changedIndexPaths.count <= 10 {
                    // Targeted reload — only changed cells (no flicker)
                    self.collectionView.reloadItems(at: changedIndexPaths)
                } else {
                    // Too many changes — full reload (rare edge case)
                    self.collectionView.reloadData()
                }
            }

            // ★ WhatsApp-style smart scroll:
            // - First load → always jump to bottom (no animation)
            // - New messages + user is near bottom → auto-scroll smoothly
            // - New messages + user scrolled UP → DON'T scroll, show unread badge
            if !self.rows.isEmpty {
                if isFirstLoad {
                    // Double-dispatch: first async lets reloadData() finish,
                    // second async after layoutIfNeeded ensures contentSize is valid
                    DispatchQueue.main.async { [weak self] in
                        self?.collectionView.layoutIfNeeded()
                        DispatchQueue.main.async { [weak self] in
                            self?.scrollToBottom(animated: false)
                        }
                    }
                } else if !newIds.isEmpty {
                    if self.isNearBottom() {
                        // User is at the bottom — scroll to show new message
                        self.unreadNewCount = 0
                        self.updateUnreadBadge()
                        DispatchQueue.main.async { [weak self] in
                            self?.scrollToBottom(animated: true)
                        }
                    } else {
                        // User is reading history — don't interrupt, show badge
                        self.unreadNewCount += newIds.count
                        self.updateUnreadBadge()
                    }
                }
            }
        }
        if Thread.isMainThread {
            applyUpdate()
        } else {
            DispatchQueue.main.async(execute: applyUpdate)
        }
    }

    /// Tracks the last bounds we computed cells against. When bounds
    /// change (initial layout, rotation, keyboard), invalidate the layout
    /// so cells re-measure with the correct width.
    private var lastLayoutWidth: CGFloat = 0
    private func observeBoundsChanges() {}

    public override func layoutSubviews() {
        super.layoutSubviews()
        let w = bounds.width
        if w > 0 && abs(w - lastLayoutWidth) > 0.5 {
            lastLayoutWidth = w
            // Drop cached heights since they were keyed to old width
            heightCache.removeAll()
            collectionView.collectionViewLayout.invalidateLayout()
            collectionView.reloadData()
            collectionView.layoutIfNeeded()
        }
    }

    // Track which message ids we've already painted, so newly-appearing
    // messages get the slide-in animation while existing ones don't.
    private var animatedMessageIds = Set<Int>()

    func reloadFromCache(preserveScroll: Bool = false) {
        let messagesRaw = querySqliteMessages(conversationId: conversationId, limit: MESSAGE_LIMIT)
        let messages = messagesRaw.map { Self.normalizeRow($0) }

        // ⭐ RACE GUARD: if SQLite returned EMPTY but we already have rows on
        // screen, DON'T wipe. This protects against the JS recovery flow
        // (clearConversation → fetch → save → reload) where the intermediate
        // empty state leaves the user staring at a blank chat for a moment.
        // The next reloadFromCache call (after the server fetch saves) will
        // bring the data back.
        if messages.isEmpty && !rows.isEmpty {
            print("[NativeChatView] Skip wipe — SQLite returned 0, keeping \(rows.count) cached rows")
            return
        }

        let previousIds = Set(rows.compactMap { $0["id"] as? Int })

        // Capture the topmost-visible message id and its on-screen offset
        // BEFORE reloading, so we can restore the user's scroll position
        // after older messages prepend.
        var anchorId: Int? = nil
        var anchorOffsetFromTop: CGFloat = 0
        if preserveScroll {
            let visibleTopY = collectionView.contentOffset.y + collectionView.adjustedContentInset.top
            for ip in collectionView.indexPathsForVisibleItems.sorted(by: { $0.item < $1.item }) {
                if let attrs = collectionView.layoutAttributesForItem(at: ip) {
                    if attrs.frame.maxY > visibleTopY {
                        if ip.item < rows.count, let id = rows[ip.item]["id"] as? Int {
                            anchorId = id
                            anchorOffsetFromTop = attrs.frame.minY - visibleTopY
                            break
                        }
                    }
                }
            }
        }

        rows = insertDateSeparators(messages: messages)
        heightCache.removeAll()
        let newIds = Set(rows.compactMap { $0["id"] as? Int }).subtracting(previousIds)
        animatedMessageIds = newIds
        collectionView.reloadData()
        collectionView.layoutIfNeeded()

        if preserveScroll, let anchor = anchorId,
           let newIdx = rows.firstIndex(where: { ($0["id"] as? Int) == anchor }),
           let attrs = collectionView.layoutAttributesForItem(at: IndexPath(item: newIdx, section: 0)) {
            // Restore: anchor message keeps the same on-screen offset
            let targetOffsetY = attrs.frame.minY - anchorOffsetFromTop - collectionView.adjustedContentInset.top
            collectionView.setContentOffset(CGPoint(x: 0, y: targetOffsetY), animated: false)
            wasAtTop = false // reset edge detector so a follow-up onReachTop can fire
            DispatchQueue.main.async { [weak self] in
                self?.onLoaded(["count": messages.count])
            }
            return
        }

        scrollToBottom(animated: false)
        DispatchQueue.main.async { [weak self] in
            self?.collectionView.layoutIfNeeded()
            self?.scrollToBottom(animated: false)
            // ── DEBUG: include the LAST 3 row contents the native view sees,
            // so JS can forward them to the server diag log. Helps figure out
            // where text content disappears between SQLite and the cell.
            var sample: [[String: Any]] = []
            if let self = self {
                let count = self.rows.count
                let start = max(0, count - 3)
                for i in start..<count {
                    let r = self.rows[i]
                    let content = (r["content"] as? String) ?? "<not-string>"
                    sample.append([
                        "id": (r["id"] as? Int) ?? 0,
                        "type": (r["type"] as? String) ?? "?",
                        "cl": content.count,
                        "cp": String(content.prefix(40)),
                    ])
                }
            }
            self?.onLoaded(["count": messages.count, "sample": sample])
        }
    }

    /// Clear the cached height for a specific cell (called by GifStickerCell
    /// after its image loads and the real aspect ratio changes the height).
    func clearHeightCache(forIndexPath ip: IndexPath) {
        guard ip.item < rows.count else { return }
        let row = rows[ip.item]
        let key = cacheKey(for: row, index: ip.item)
        heightCache.removeValue(forKey: key)
    }

    func scrollToBottom(animated: Bool) {
        guard !rows.isEmpty else { return }
        let cv = collectionView
        let contentH = cv.contentSize.height
        let visibleH = cv.bounds.height - cv.adjustedContentInset.top - cv.adjustedContentInset.bottom

        // If contentSize is 0, layout hasn't finished yet — retry after short delay
        if contentH <= 1 && !rows.isEmpty {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                self?.scrollToBottom(animated: animated)
            }
            return
        }

        // ⭐ WhatsApp-style "anchor to bottom": when there are few messages
        // (contentH < visibleH), add top padding so the messages "fall" to the
        // bottom of the view, touching the input bar. Without this, cells hug
        // the top with a huge empty space below, which looks broken.
        if contentH < visibleH {
            let topPad = max(0, visibleH - contentH)
            cv.contentInset.top = topPad
            cv.setContentOffset(CGPoint(x: 0, y: -topPad), animated: animated)
            return
        } else {
            // Reset inset if we added extra top padding before.
            if cv.contentInset.top > 4 { cv.contentInset.top = 4 }
        }
        let targetY = contentH - visibleH - cv.adjustedContentInset.top
        cv.setContentOffset(CGPoint(x: 0, y: targetY), animated: animated)
    }

    // MARK: UICollectionViewDataSource

    public func collectionView(_ collectionView: UICollectionView,
                                numberOfItemsInSection section: Int) -> Int {
        return rows.count
    }

    public func collectionView(_ collectionView: UICollectionView,
                                cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let row = rows[indexPath.item]

        if let sep = row["__separator__"] as? String {
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "separator", for: indexPath) as! SeparatorCell
            cell.label.text = sep
            return cell
        }

        if (row["type"] as? String) == "system" {
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "system", for: indexPath) as! SystemCell
            cell.label.text = (row["content"] as? String) ?? ""
            return cell
        }

        // ★ WhatsApp multi-view type routing
        let msgType = (row["type"] as? String) ?? "text"
        let isOwn = (row["sender_email"] as? String) == myEmail

        switch msgType {
        case "poll":
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "poll", for: indexPath) as! PollCell
            cell.onVote = { [weak self] optionIndex in
                self?.onPollVote(["messageId": row["id"] ?? 0, "optionIndex": optionIndex])
            }
            cell.configure(message: row, isOwn: isOwn, view: self)
            return cell

        case "location":
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "location", for: indexPath) as! LocationCell
            cell.onTap = { [weak self] lat, lng, label in
                self?.onLocationTap(["messageId": row["id"] ?? 0, "latitude": lat, "longitude": lng, "label": label])
            }
            cell.configure(message: row, isOwn: isOwn, view: self)
            return cell

        case "meetup":
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "meetup", for: indexPath) as! MeetupCell
            cell.onRsvp = { [weak self] status in
                self?.onMeetupRsvp(["messageId": row["id"] ?? 0, "status": status])
            }
            cell.configure(message: row, isOwn: isOwn, view: self)
            return cell

        case "contact":
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "contact", for: indexPath) as! ContactCell
            cell.configure(message: row, isOwn: isOwn)
            return cell

        case "playlist":
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "playlist", for: indexPath) as! PlaylistCell
            cell.configure(message: row, isOwn: isOwn)
            return cell

        case "call_card":
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "call_card", for: indexPath) as! CallCardCell
            cell.configure(message: row, isOwn: isOwn)
            return cell

        case "gif", "sticker":
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "gif_sticker", for: indexPath) as! GifStickerCell
            cell.configure(message: row)
            return cell

        default:
            break  // Fall through to BubbleCell for text, image, video, voice, audio
        }

        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "bubble", for: indexPath) as! BubbleCell
        // WhatsApp grouping: compute position using 60-second time window
        let pos = groupPosition(for: indexPath.item)
        cell.groupPosition = pos
        let groupedPrev = (pos == .middle || pos == .last)
        cell.groupedWithPrevious = groupedPrev
        cell.showSenderName = isGroupChat && !isOwn && !groupedPrev
        // Top spacing for grouping gaps (matches sizeForItemAt calculation)
        switch pos {
        case .middle, .last: cell.groupTopSpacing = 3
        case .first, .standalone: cell.groupTopSpacing = indexPath.item == 0 ? 6 : 12
        }
        // CRITICAL: collectionView.bounds.width can be 0 during the very first
        // layout cascade, which would compute maxBubbleW = -20 → bodyW = 0 →
        // text labels render INVISIBLE (matching the user's "fotos aparecem,
        // texto não" symptom). Fall back to UIScreen.main.bounds.width.
        let cvWidth = collectionView.bounds.width > 0
            ? collectionView.bounds.width
            : UIScreen.main.bounds.width
        cell.configure(
            message: row,
            isOwn: isOwn,
            ownBubbleColor: ownBubbleColor,
            otherBubbleColor: otherBubbleColor,
            textColor: textColor,
            metaColor: metaColor,
            maxWidth: cvWidth * 0.78
        )
        // Selection highlight overlay (when in selection mode)
        if let id = row["id"] as? Int {
            cell.setSelected(selectedMessageIds.contains(id), inSelectionMode: !selectedMessageIds.isEmpty)
        }

        // iMessage-style spring slide-in for newly-appended messages.
        // Own messages slide from the right (send swoosh) with a tiny scale pop;
        // incoming slide from the left.
        if let id = row["id"] as? Int, animatedMessageIds.contains(id) {
            animatedMessageIds.remove(id)
            let dx: CGFloat = isOwn ? 60 : -60
            cell.alpha = 0
            cell.transform = CGAffineTransform(translationX: dx, y: 8)
                .scaledBy(x: 0.92, y: 0.92)
            UIView.animate(withDuration: 0.42, delay: 0,
                           usingSpringWithDamping: 0.72, initialSpringVelocity: 0.8,
                           options: [.curveEaseOut], animations: {
                cell.alpha = 1
                cell.transform = .identity
            })
        }

        return cell
    }

    // MARK: UICollectionViewDelegateFlowLayout

    public func collectionView(_ collectionView: UICollectionView,
                                layout collectionViewLayout: UICollectionViewLayout,
                                sizeForItemAt indexPath: IndexPath) -> CGSize {
        // Same width fallback as cellForItemAt — bounds may be 0 during the
        // first layout pass, which would compute negative cell sizes.
        let width = collectionView.bounds.width > 0
            ? collectionView.bounds.width
            : UIScreen.main.bounds.width
        let row = rows[indexPath.item]
        let key = cacheKey(for: row, index: indexPath.item)
        if let cached = heightCache[key] {
            return CGSize(width: width, height: cached)
        }

        let height: CGFloat
        if row["__separator__"] != nil {
            height = 32
        } else if (row["type"] as? String) == "system" {
            height = 36
        } else {
            // ★ WhatsApp multi-view type heights
            let msgType = (row["type"] as? String) ?? "text"
            switch msgType {
            case "poll":
                // Header(badge+question ~60) + per-option (44pt = 36 bar + 8 spacing) + footer(30)
                let opts: [Any] = (row["poll"] as? [String: Any]).flatMap { p in
                    (p["options"] as? [Any]) ?? []
                } ?? []
                let optCount = max(2, opts.count)
                height = 60 + CGFloat(optCount * 44) + 30

            case "location":
                // Map (90) + footer (50) + cell margin (8) = 148
                height = 148

            case "meetup":
                // Header(40) + date(20) + location(20) + divider/buttons(50) + counts(16) + time(18) + padding
                height = 200

            case "contact":
                // Avatar+name+phone (80) + divider (1) + action (44) + padding
                height = 140

            case "playlist":
                // Cover+title+count (70) + songs (32 each) + add button (28) + padding
                let songCount: Int = {
                    if let pl = row["playlist"] as? [String: Any] {
                        if let arr = pl["songs"] as? [Any] { return min(3, arr.count) }
                        if let arr = pl["tracks"] as? [Any] { return min(3, arr.count) }
                    }
                    return 0
                }()
                height = 80 + CGFloat(songCount * 32) + 36 + 24

            case "call_card":
                // iMessage style: top 4 + 14 + icon 32 + 12 + divider 0.5 + 10 + info 14 + 14 + 4 = ~105
                height = 110

            case "gif", "sticker":
                let fileUrl = (row["file_url"] as? String) ?? ""
                let content = (row["content"] as? String) ?? ""
                let raw = !fileUrl.isEmpty ? fileUrl : content
                // Pure emoji sticker (not URL) — fixed small height
                let isEmojiSticker = !raw.isEmpty && !raw.hasPrefix("http") && !raw.hasPrefix("/") && GifStickerCell.isEmojiOnly(raw)
                if isEmojiSticker {
                    height = 88 // 80 emoji + 8 padding
                } else {
                    let urlString: String = {
                        if raw.hasPrefix("http") { return raw }
                        if raw.hasPrefix("/") { return "https://chatyy.com.br" + raw }
                        return raw
                    }()
                    let aspect = GifStickerCell.aspectCache[urlString] ?? 1.0
                    let imgH: CGFloat = aspect >= 1
                        ? GifStickerCell.maxSize / aspect
                        : GifStickerCell.maxSize
                    height = imgH + 8
                }

            default:
                // BubbleCell types (text, image, video, voice, audio)
                height = BubbleCell.estimateHeight(message: row, maxWidth: width * 0.78)
            }
        }
        // WhatsApp grouping spacing: tight within a group, more breathing
        // room between senders/time gaps so bubbles don't touch.
        let pos = groupPosition(for: indexPath.item)
        let topSpacing: CGFloat
        switch pos {
        case .middle, .last:
            topSpacing = 3    // Tight spacing within a group
        case .first, .standalone:
            topSpacing = indexPath.item == 0 ? 6 : 12  // Gap between groups
        }
        let totalHeight = height + topSpacing

        // LRU eviction: if heightCache grows beyond 500 entries, remove oldest half
        // to prevent unbounded memory growth in long conversations.
        if heightCache.count > 500 {
            let keysToRemove = Array(heightCache.keys.prefix(heightCache.count / 2))
            for k in keysToRemove { heightCache.removeValue(forKey: k) }
        }
        heightCache[key] = totalHeight
        return CGSize(width: width, height: totalHeight)
    }

    private func cacheKey(for row: [String: Any], index: Int) -> String {
        if let sep = row["__separator__"] as? String { return "sep_\(sep)" }
        if let id = row["id"] as? Int {
            let pos = groupPosition(for: index)
            let posKey: String
            switch pos {
            case .standalone: posKey = "s"
            case .first: posKey = "f"
            case .middle: posKey = "m"
            case .last: posKey = "l"
            }
            return "msg_\(id)_\(posKey)"
        }
        return "row_\(index)"
    }

    /// Static version of cacheKey for use by BubbleCell self-sizing correction
    static func cacheKeyStatic(for row: [String: Any], index: Int, groupPosition: GroupPosition) -> String {
        if let sep = row["__separator__"] as? String { return "sep_\(sep)" }
        if let id = row["id"] {
            let posKey: String
            switch groupPosition {
            case .standalone: posKey = "s"
            case .first: posKey = "f"
            case .middle: posKey = "m"
            case .last: posKey = "l"
            }
            return "msg_\(id)_\(posKey)"
        }
        return "row_\(index)"
    }

    // MARK: - WhatsApp Message Grouping

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoFormatterNoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let altDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f
    }()

    private func parseDate(_ iso: String?) -> Date? {
        guard let iso = iso else { return nil }
        if let d = Self.isoFormatter.date(from: iso) { return d }
        if let d = Self.isoFormatterNoFrac.date(from: iso) { return d }
        return Self.altDateFormatter.date(from: iso)
    }

    /// Returns true if two rows can be grouped: same sender, both are message
    /// rows (not separator/system), and within 60 seconds of each other.
    private func canGroup(_ a: [String: Any], _ b: [String: Any]) -> Bool {
        if a["__separator__"] != nil || b["__separator__"] != nil { return false }
        let aType = (a["type"] as? String) ?? "text"
        let bType = (b["type"] as? String) ?? "text"
        if aType == "system" || bType == "system" { return false }
        let aSender = (a["sender_email"] as? String) ?? ""
        let bSender = (b["sender_email"] as? String) ?? ""
        guard !aSender.isEmpty, aSender == bSender else { return false }
        guard let aDate = parseDate(a["created_at"] as? String),
              let bDate = parseDate(b["created_at"] as? String) else {
            return true  // If can't parse dates, group by sender only
        }
        return abs(aDate.timeIntervalSince(bDate)) <= 60
    }

    /// Compute the WhatsApp group position for the row at the given index.
    func groupPosition(for index: Int) -> GroupPosition {
        guard index >= 0, index < rows.count else { return .standalone }
        let row = rows[index]
        if row["__separator__"] != nil { return .standalone }
        if (row["type"] as? String) == "system" { return .standalone }

        let hasPrev = index > 0 && canGroup(rows[index - 1], row)
        let hasNext = index < rows.count - 1 && canGroup(row, rows[index + 1])

        switch (hasPrev, hasNext) {
        case (false, false): return .standalone
        case (false, true):  return .first
        case (true, true):   return .middle
        case (true, false):  return .last
        }
    }

    // MARK: UICollectionViewDataSourcePrefetching
    // ⭐ This is the iOS 10+ API WhatsApp uses. UIKit calls us BEFORE the cell
    // becomes visible — we use that gap to pre-decode images.

    public func collectionView(_ collectionView: UICollectionView,
                                prefetchItemsAt indexPaths: [IndexPath]) {
        for ip in indexPaths {
            guard ip.item < rows.count else { continue }
            let row = rows[ip.item]
            let type = (row["type"] as? String) ?? ""
            if type == "image" || type == "video" {
                if let url = row["file_url"] as? String {
                    BubbleCell.prefetchImage(remoteUrl: url)
                }
            }
        }
    }

    // MARK: - Tap & long-press

    @objc private func handleTap(_ gr: UITapGestureRecognizer) {
        let point = gr.location(in: collectionView)
        guard let ip = collectionView.indexPathForItem(at: point),
              ip.item < rows.count else { return }
        let row = rows[ip.item]
        if row["__separator__"] != nil { return }

        // Check if tap was on a reaction pill within the bubble
        if let cell = collectionView.cellForItem(at: ip) as? BubbleCell,
           let pill = cell.reactionAt(point: collectionView.convert(point, to: cell)) {
            onReactionTap([
                "messageId": row["id"] ?? 0,
                "emoji": pill,
            ])
            return
        }

        onMessageTap([
            "messageId": row["id"] ?? 0,
            "messageType": row["type"] ?? "text",
        ])
    }

    @objc private func handleLongPress(_ gr: UILongPressGestureRecognizer) {
        guard gr.state == .began else { return }
        let point = gr.location(in: collectionView)
        guard let ip = collectionView.indexPathForItem(at: point),
              ip.item < rows.count else { return }
        let row = rows[ip.item]
        if row["__separator__"] != nil { return }
        onMessageLongPress([
            "messageId": row["id"] ?? 0,
            "messageType": row["type"] ?? "text",
        ])
    }

    // ─── Swipe-to-reply gesture ─────────────────────────────────
    private var swipingCell: UICollectionViewCell?
    private var swipeStartX: CGFloat = 0
    private static let SWIPE_REPLY_THRESHOLD: CGFloat = 60

    @objc private func handleSwipe(_ gr: UIPanGestureRecognizer) {
        let point = gr.location(in: collectionView)
        switch gr.state {
        case .began:
            // Only react to right-swipes (positive x velocity, mostly horizontal)
            let v = gr.velocity(in: collectionView)
            if abs(v.x) < abs(v.y) || v.x < 0 {
                gr.state = .cancelled
                return
            }
            guard let ip = collectionView.indexPathForItem(at: point),
                  let cell = collectionView.cellForItem(at: ip) else { return }
            swipingCell = cell
            swipeStartX = cell.transform.tx

        case .changed:
            guard let cell = swipingCell else { return }
            let dx = max(0, gr.translation(in: collectionView).x)
            // Damped: pull half as far as the finger moves
            cell.transform = CGAffineTransform(translationX: min(80, dx * 0.5), y: 0)

        case .ended, .cancelled, .failed:
            guard let cell = swipingCell else { return }
            let dx = gr.translation(in: collectionView).x
            let triggered = dx >= Self.SWIPE_REPLY_THRESHOLD
            UIView.animate(withDuration: 0.25,
                           delay: 0,
                           usingSpringWithDamping: 0.7,
                           initialSpringVelocity: 0.5,
                           options: [.curveEaseOut],
                           animations: {
                cell.transform = .identity
            })
            if triggered, let ip = collectionView.indexPath(for: cell), ip.item < rows.count {
                let row = rows[ip.item]
                if row["__separator__"] == nil {
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    onSwipeReply([
                        "messageId": row["id"] ?? 0,
                        "messageType": row["type"] ?? "text",
                    ])
                }
            }
            swipingCell = nil

        default:
            break
        }
    }

    // MARK: - Scroll

    private var wasAtTop = false
    public func scrollViewDidScroll(_ scrollView: UIScrollView) {
        let offset = scrollView.contentOffset.y
        let atTop = offset <= 60
        let atBottom = offset + scrollView.bounds.height >= scrollView.contentSize.height - 4
        onScroll([
            "contentOffset": Double(offset),
            "atTop": atTop,
            "atBottom": atBottom,
        ])
        // Only fire onReachTop on the EDGE (transition from not-top → top),
        // not every frame while scrolling near the top. This prevents 30+
        // parallel handleLoadMore calls from spamming the API.
        if atTop && !wasAtTop {
            onReachTop([:])
        }
        wasAtTop = atTop

        // Show jump-to-bottom FAB when more than 1 screen above the bottom
        let distanceFromBottom = max(0, scrollView.contentSize.height - (offset + scrollView.bounds.height))
        updateScrollFab(visible: distanceFromBottom > scrollView.bounds.height * 0.5)

        // Clear unread badge when user scrolls back to bottom
        if atBottom && unreadNewCount > 0 {
            unreadNewCount = 0
            updateUnreadBadge()
        }
    }

    // MARK: - Date separators

    private func insertDateSeparators(messages: [[String: Any]]) -> [[String: Any]] {
        guard !messages.isEmpty else { return [] }
        var result: [[String: Any]] = []
        var lastDayKey: String?
        let dayFormatter = DateFormatter()
        dayFormatter.dateFormat = "yyyy-MM-dd"
        let displayFormatter = DateFormatter()
        displayFormatter.dateStyle = .medium
        displayFormatter.timeStyle = .none

        for msg in messages {
            let dateStr = (msg["created_at"] as? String) ?? ""
            let date = parseDate(dateStr) ?? Date()
            let dayKey = dayFormatter.string(from: date)
            if dayKey != lastDayKey {
                lastDayKey = dayKey
                result.append(["__separator__": friendlyDayLabel(date: date, displayFormatter: displayFormatter)])
            }
            result.append(msg)
        }
        return result
    }

    private func friendlyDayLabel(date: Date, displayFormatter: DateFormatter) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "Hoje" }
        if cal.isDateInYesterday(date) { return "Ontem" }
        if let weeksAgo = cal.dateComponents([.day], from: date, to: Date()).day, weeksAgo < 7 {
            let f = DateFormatter()
            f.locale = Locale(identifier: "pt_BR")
            f.dateFormat = "EEEE"
            return f.string(from: date).capitalized
        }
        return displayFormatter.string(from: date)
    }

    private func parseDate(_ s: String) -> Date? {
        if s.isEmpty { return nil }
        let f1 = ISO8601DateFormatter()
        if let d = f1.date(from: s) { return d }
        let f2 = DateFormatter()
        f2.dateFormat = "yyyy-MM-dd HH:mm:ss"
        f2.locale = Locale(identifier: "en_US_POSIX")
        return f2.date(from: s)
    }

    // MARK: - SQLite query (same DB the JS-facing module writes to)

    private func querySqliteMessages(conversationId: Int, limit: Int) -> [[String: Any]] {
        guard let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return []
        }
        let dbPath = cachesDir.appendingPathComponent(DB_NAME).path
        var db: OpaquePointer?
        if sqlite3_open(dbPath, &db) != SQLITE_OK {
            sqlite3_close(db)
            return []
        }
        defer { sqlite3_close(db) }
        // Prevent SQLITE_BUSY when expo-chat-cache is writing concurrently
        sqlite3_exec(db, "PRAGMA busy_timeout = 5000;", nil, nil, nil)

        // Read BOTH payload_json (preferred) AND the individual columns as
        // fallback, so a row whose payload_json field is missing/corrupt still
        // renders with its core content visible.
        let sql = """
            SELECT payload_json, id, conversation_id, sender_email, content, type,
                   file_url, file_name, file_size, created_at,
                   edited_at, deleted_at, reply_to_id
            FROM messages
            WHERE conversation_id = ?
            ORDER BY id DESC
            LIMIT ?;
        """
        var stmt: OpaquePointer?
        var results: [[String: Any]] = []
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_int64(stmt, 1, Int64(conversationId))
            sqlite3_bind_int(stmt, 2, Int32(limit))
            while sqlite3_step(stmt) == SQLITE_ROW {
                var row: [String: Any]? = nil
                if let cstr = sqlite3_column_text(stmt, 0) {
                    let json = String(cString: cstr)
                    if let data = json.data(using: .utf8),
                       let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        // ⭐ Strip NSNull values — they cause "as? String" to return nil
                        // which makes content/type/file_url appear empty in the cell.
                        // This was the ROOT CAUSE of the empty bubble bug.
                        var clean: [String: Any] = [:]
                        for (k, v) in parsed {
                            if v is NSNull { continue } // skip nulls entirely
                            clean[k] = v
                        }
                        row = clean
                    }
                }
                // ALWAYS merge with individual columns — they're the ground truth
                // when payload_json has missing/null fields.
                var merged: [String: Any] = row ?? [:]
                let rowId = Int(sqlite3_column_int64(stmt, 1))
                if merged["id"] == nil { merged["id"] = rowId }
                if merged["conversation_id"] == nil { merged["conversation_id"] = Int(sqlite3_column_int64(stmt, 2)) }
                if let s = sqlite3_column_text(stmt, 3), (merged["sender_email"] as? String)?.isEmpty != false {
                    merged["sender_email"] = String(cString: s)
                }
                if let s = sqlite3_column_text(stmt, 4) {
                    let col = String(cString: s)
                    // Column content wins over empty/missing payload_json content
                    if !col.isEmpty && ((merged["content"] as? String) ?? "").isEmpty {
                        merged["content"] = col
                    }
                }
                if let s = sqlite3_column_text(stmt, 5), (merged["type"] as? String)?.isEmpty != false {
                    merged["type"] = String(cString: s)
                }
                if let s = sqlite3_column_text(stmt, 6), (merged["file_url"] as? String)?.isEmpty != false {
                    merged["file_url"] = String(cString: s)
                }
                if let s = sqlite3_column_text(stmt, 7), (merged["file_name"] as? String)?.isEmpty != false {
                    merged["file_name"] = String(cString: s)
                }
                if sqlite3_column_type(stmt, 8) != SQLITE_NULL && merged["file_size"] == nil {
                    merged["file_size"] = Int(sqlite3_column_int64(stmt, 8))
                }
                if let s = sqlite3_column_text(stmt, 9), (merged["created_at"] as? String)?.isEmpty != false {
                    merged["created_at"] = String(cString: s)
                }
                if let s = sqlite3_column_text(stmt, 10) { merged["edited_at"] = String(cString: s) }
                if let s = sqlite3_column_text(stmt, 11) { merged["deleted_at"] = String(cString: s) }
                if sqlite3_column_type(stmt, 12) != SQLITE_NULL && merged["reply_to_id"] == nil {
                    merged["reply_to_id"] = Int(sqlite3_column_int64(stmt, 12))
                }
                results.append(merged)
            }
        }
        sqlite3_finalize(stmt)
        return results.reversed()
    }

    // MARK: - Helpers

    /// Normalize a message row by detecting special types embedded in content JSON.
    /// Mirrors the JS-side normalizeMessageTypes logic so the native chat view
    /// works even when the cache was written without normalization.
    /// IMPORTANT: JSONSerialization returns NSNull for `null` values, so
    /// `dict["key"] != nil` is true for null. Use `nonNull()` everywhere.
    static func nonNull(_ v: Any?) -> Any? {
        if v == nil { return nil }
        if v is NSNull { return nil }
        if let s = v as? String, s.isEmpty { return nil }
        return v
    }

    static func normalizeRow(_ row: [String: Any]) -> [String: Any] {
        // Clean NSNull from reply_to — Expo bridge converts JS null fields to NSNull
        if let replyRaw = row["reply_to"] {
            if replyRaw is NSNull {
                // reply_to is NSNull, will be resolved from reply_to_id later
            } else if var replyDict = replyRaw as? [String: Any] {
                // Strip NSNull from nested reply_to fields
                for (k, v) in replyDict {
                    if v is NSNull { replyDict[k] = nil }
                }
                var cleaned = row
                cleaned["reply_to"] = replyDict
                // Re-enter with cleaned reply_to
                var result = _normalizeRowInner(cleaned)
                result["reply_to"] = replyDict
                return result
            }
        }
        return _normalizeRowInner(row)
    }

    private static func _normalizeRowInner(_ row: [String: Any]) -> [String: Any] {
        let type = (row["type"] as? String) ?? "text"
        // Try to parse content JSON regardless of type — message might already
        // have type=location/poll/etc but the actual data is in content JSON.
        var json: [String: Any]? = nil
        if let content = row["content"] as? String {
            let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasPrefix("{") && trimmed.hasSuffix("}"),
               let data = trimmed.data(using: .utf8),
               let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                json = parsed
            }
        }

        var newRow = row

        // ─── If type is ALREADY set, just merge content JSON fields into top-level ───
        // This handles messages that arrive as type=location/call_card/poll/etc with
        // their data inside content JSON (the most common case from the backend).
        if let json = json, type != "text" && type != "system" {
            switch type {
            case "location":
                if newRow["latitude"] == nil || newRow["latitude"] is NSNull {
                    newRow["latitude"] = nonNull(json["latitude"]) ?? nonNull(json["lat"])
                }
                if newRow["longitude"] == nil || newRow["longitude"] is NSNull {
                    newRow["longitude"] = nonNull(json["longitude"]) ?? nonNull(json["lng"])
                }
                if newRow["address"] == nil || (newRow["address"] as? String)?.isEmpty == true {
                    newRow["address"] = nonNull(json["address"]) ?? nonNull(json["label"]) ?? nonNull(json["name"]) ?? ""
                }
                if newRow["live"] == nil { newRow["live"] = nonNull(json["live"]) }
            case "call_card":
                if newRow["call_type"] == nil || newRow["call_type"] is NSNull {
                    newRow["call_type"] = nonNull(json["call_type"])
                }
                if newRow["call_status"] == nil { newRow["call_status"] = nonNull(json["call_status"]) }
                if newRow["call_duration"] == nil { newRow["call_duration"] = nonNull(json["call_duration"]) }
            case "poll":
                if newRow["poll"] == nil || newRow["poll"] is NSNull { newRow["poll"] = json }
            case "meetup":
                if newRow["meetup"] == nil || newRow["meetup"] is NSNull { newRow["meetup"] = json }
            case "contact":
                if newRow["contact"] == nil || newRow["contact"] is NSNull { newRow["contact"] = json }
            case "playlist":
                if newRow["playlist"] == nil || newRow["playlist"] is NSNull {
                    var pl = json
                    if pl["title"] == nil || pl["title"] is NSNull {
                        pl["title"] = nonNull(json["playlist_name"]) ?? "Playlist"
                    }
                    newRow["playlist"] = pl
                }
            default: break
            }
            return newRow
        }

        // ─── Auto-detection from JSON content (type=text or type=system) ───
        guard let json = json else { return row }

        // Call card — also handle system-message form
        if let callType = nonNull(json["call_type"]) as? String, !callType.isEmpty {
            newRow["type"] = "call_card"
            newRow["call_type"] = callType
            if let s = nonNull(json["call_status"]) { newRow["call_status"] = s }
            if let d = nonNull(json["call_duration"]) { newRow["call_duration"] = d }
            return newRow
        }
        // Poll
        if let q = nonNull(json["question"]) as? String, !q.isEmpty,
           let _ = nonNull(json["options"]) as? [Any] {
            newRow["type"] = "poll"
            newRow["poll"] = json
            return newRow
        }
        // Location
        let latRaw = nonNull(json["latitude"]) ?? nonNull(json["lat"])
        let lngRaw = nonNull(json["longitude"]) ?? nonNull(json["lng"])
        if latRaw != nil && lngRaw != nil
           && nonNull(json["playlist_name"]) == nil && nonNull(json["songs"]) == nil {
            newRow["type"] = "location"
            newRow["latitude"] = latRaw
            newRow["longitude"] = lngRaw
            newRow["address"] = nonNull(json["address"]) ?? nonNull(json["label"]) ?? nonNull(json["name"]) ?? ""
            if let live = nonNull(json["live"]) { newRow["live"] = live }
            return newRow
        }
        // Playlist
        let plName = nonNull(json["playlist_name"]) as? String
        let plSongs = nonNull(json["songs"])
        if (plName != nil && !plName!.isEmpty) ||
           (plSongs != nil && nonNull(json["title"]) == nil && nonNull(json["question"]) == nil) {
            newRow["type"] = "playlist"
            var pl = json
            if pl["title"] == nil || pl["title"] is NSNull { pl["title"] = plName ?? "Playlist" }
            newRow["playlist"] = pl
            return newRow
        }
        // Contact
        let contactName = nonNull(json["name"]) as? String
        if let cn = contactName, !cn.isEmpty,
           (nonNull(json["phone"]) != nil || nonNull(json["email"]) != nil),
           nonNull(json["title"]) == nil {
            newRow["type"] = "contact"
            newRow["contact"] = json
            return newRow
        }
        // Meetup
        if let mt = nonNull(json["title"]) as? String, !mt.isEmpty,
           nonNull(json["datetime"]) != nil,
           nonNull(json["location"]) != nil {
            newRow["type"] = "meetup"
            newRow["meetup"] = json
            return newRow
        }
        return newRow
    }

    static func colorFromHex(_ hex: String) -> UIColor {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        var rgb: UInt64 = 0
        Scanner(string: s).scanHexInt64(&rgb)
        let r = CGFloat((rgb & 0xff0000) >> 16) / 255.0
        let g = CGFloat((rgb & 0x00ff00) >> 8) / 255.0
        let b = CGFloat(rgb & 0x0000ff) / 255.0
        return UIColor(red: r, green: g, blue: b, alpha: 1)
    }
}

// MARK: - Bubble cell (text / image / video / audio / voice)

/// WhatsApp message grouping position within a consecutive run from the same sender.
enum GroupPosition {
    case standalone  // only message in its group
    case first       // first message, has tail + sender name
    case middle      // middle message, small radius, no tail
    case last        // last message, has tail
}

final class BubbleCell: UICollectionViewCell {

    private let bubble = UIView()
    /// WhatsApp-style tail triangle on the bubble corner (CAShapeLayer)
    private let tailLayer = CAShapeLayer()
    /// Read-by indicator below own bubbles in groups ("Visto por X")
    private let readByLabel = UILabel()
    /// Selection overlay shown when this cell is selected (multi-select mode)
    private let selectionOverlay = UIView()
    private let selectionCheckmark = UIImageView()
    /// Small avatar shown to the left of non-own messages in group chats
    private let groupAvatarView = UIView()
    private let groupAvatarLabel = UILabel()
    /// Star icon shown when message is starred/favorited
    private let starIcon = UIImageView()
    /// Whether to show the sender name label (group chats, non-own messages)
    var showSenderName: Bool = false
    /// Whether this message should be visually grouped with the previous one
    /// (consecutive messages from same sender — hide avatar/name on subsequent)
    var groupedWithPrevious: Bool = false
    /// WhatsApp grouping position — controls corner radius and tail visibility
    var groupPosition: GroupPosition = .standalone
    /// Top spacing for this cell (baked into cell height for grouping gaps)
    var groupTopSpacing: CGFloat = 4
    private let senderNameLabel = UILabel()
    private let forwardedLabel = UILabel()
    private let replyContainer = UIView()
    private let replyLabel = UILabel()
    private let imageView = UIImageView()
    private let playButton = UIImageView()
    private let label = UILabel()
    private let timeLabel = UILabel()
    private let statusIcon = UIImageView()
    private let waveformView = WaveformView()
    private let voicePlayButton = UIButton(type: .system)
    private let voiceDuration = UILabel()
    private let reactionsRow = UIStackView()

    static let imageCache: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.totalCostLimit = 100 * 1024 * 1024 // 100MB limit to prevent OOM
        c.countLimit = 200
        return c
    }()
    private static var audioPlayer: AVAudioPlayer?
    private static var currentPlayingMessageId: Int = 0
    /// Audio file URL captured during configure so playback works on tap
    private var currentVoiceUrl: String = ""

    private var currentMessageId: Int = 0
    private var reactionPills: [(emoji: String, frame: CGRect)] = []

    override init(frame: CGRect) {
        super.init(frame: frame)

        // WhatsApp-style bubble: rounded corners, per-corner mask
        // Note: shadow removed because layer.mask clips it. WhatsApp iOS
        // doesn't use drop shadows on bubbles either.
        bubble.layer.cornerRadius = 16
        bubble.layer.masksToBounds = false
        contentView.addSubview(bubble)
        // Tail layer added to contentView (not bubble) so it's not clipped by bubble mask
        tailLayer.isHidden = true
        contentView.layer.addSublayer(tailLayer)

        // Read-by indicator (small text below own bubbles in groups)
        readByLabel.font = .systemFont(ofSize: 10, weight: .medium)
        readByLabel.textColor = dmTS
        readByLabel.textAlignment = .right
        readByLabel.isHidden = true
        contentView.addSubview(readByLabel)

        // Group chat avatar (small circle to the left of non-own messages)
        groupAvatarView.layer.cornerRadius = 14
        groupAvatarView.clipsToBounds = true
        groupAvatarView.isHidden = true
        contentView.addSubview(groupAvatarView)
        groupAvatarLabel.textColor = .white
        groupAvatarLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        groupAvatarLabel.textAlignment = .center
        groupAvatarView.addSubview(groupAvatarLabel)

        // Star icon (top-right of own bubbles when starred)
        starIcon.image = UIImage(systemName: "star.fill")
        starIcon.tintColor = UIColor(red: 0.95, green: 0.75, blue: 0.0, alpha: 1)
        starIcon.isHidden = true
        starIcon.contentMode = .scaleAspectFit
        bubble.addSubview(starIcon)

        // Sender name (group chats only — colored bold above body)
        senderNameLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        senderNameLabel.numberOfLines = 1
        senderNameLabel.isHidden = true
        bubble.addSubview(senderNameLabel)

        // Selection overlay (entire cell tinted when selected)
        selectionOverlay.backgroundColor = UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 0.18)
        selectionOverlay.isHidden = true
        selectionOverlay.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(selectionOverlay)
        NSLayoutConstraint.activate([
            selectionOverlay.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            selectionOverlay.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            selectionOverlay.topAnchor.constraint(equalTo: contentView.topAnchor),
            selectionOverlay.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
        ])
        // Checkmark inside selection overlay (right edge centered)
        selectionCheckmark.image = UIImage(systemName: "checkmark.circle.fill")
        selectionCheckmark.tintColor = UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1)
        selectionCheckmark.contentMode = .scaleAspectFit
        selectionCheckmark.isHidden = true
        selectionCheckmark.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(selectionCheckmark)
        NSLayoutConstraint.activate([
            selectionCheckmark.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -12),
            selectionCheckmark.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            selectionCheckmark.widthAnchor.constraint(equalToConstant: 22),
            selectionCheckmark.heightAnchor.constraint(equalToConstant: 22),
        ])

        // Forwarded label (small italic with arrow icon, above reply/body)
        forwardedLabel.font = .italicSystemFont(ofSize: 12)
        forwardedLabel.textColor = dmTS
        forwardedLabel.isHidden = true
        bubble.addSubview(forwardedLabel)

        // Reply preview header — colored left bar + sender name + body preview
        replyContainer.backgroundColor = dmRBg
        replyContainer.layer.cornerRadius = 8
        replyContainer.layer.masksToBounds = true
        replyContainer.isHidden = true
        bubble.addSubview(replyContainer)
        // Colored accent bar on the left of the reply
        let replyBar = UIView()
        replyBar.tag = 99
        replyBar.backgroundColor = UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1)
        replyContainer.addSubview(replyBar)

        replyLabel.font = .systemFont(ofSize: 13, weight: .regular)
        replyLabel.numberOfLines = 2
        replyLabel.lineBreakMode = .byTruncatingTail
        replyLabel.textColor = dmTS
        replyContainer.addSubview(replyLabel)

        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.layer.cornerRadius = 12
        imageView.isHidden = true
        bubble.addSubview(imageView)

        // Play button overlay for videos
        playButton.image = UIImage(systemName: "play.circle.fill")
        playButton.tintColor = UIColor.white
        playButton.layer.shadowColor = UIColor.black.cgColor
        playButton.layer.shadowOpacity = 0.4
        playButton.layer.shadowRadius = 4
        playButton.isHidden = true
        bubble.addSubview(playButton)

        label.numberOfLines = 0
        label.font = .systemFont(ofSize: 16.5)
        bubble.addSubview(label)

        timeLabel.font = .systemFont(ofSize: 11)
        timeLabel.textColor = dmTS
        bubble.addSubview(timeLabel)

        statusIcon.contentMode = .scaleAspectFit
        statusIcon.tintColor = UIColor(red: 0.30, green: 0.69, blue: 0.93, alpha: 1)
        statusIcon.isHidden = true
        bubble.addSubview(statusIcon)

        waveformView.isHidden = true
        waveformView.onSeek = { [weak self] frac in
            // Scrub the audio player to the new position when waveform is dragged
            guard let self = self else { return }
            if BubbleCell.currentPlayingMessageId == self.currentMessageId,
               let player = BubbleCell.audioPlayer {
                player.currentTime = player.duration * Double(frac)
            }
        }
        bubble.addSubview(waveformView)

        voicePlayButton.setImage(UIImage(systemName: "play.fill"), for: .normal)
        voicePlayButton.tintColor = dmTS
        voicePlayButton.isHidden = true
        voicePlayButton.addTarget(self, action: #selector(toggleVoice), for: .touchUpInside)
        bubble.addSubview(voicePlayButton)

        voiceDuration.font = .systemFont(ofSize: 11)
        voiceDuration.textColor = dmTS
        voiceDuration.isHidden = true
        bubble.addSubview(voiceDuration)

        reactionsRow.axis = .horizontal
        reactionsRow.spacing = 3
        reactionsRow.alignment = .center
        reactionsRow.isHidden = true
        contentView.addSubview(reactionsRow)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    /// Opt OUT of UICollectionView's self-sizing feedback loop. We compute
    /// heights deterministically in the flow layout delegate; letting UIKit
    /// re-measure via preferredLayoutAttributesFitting causes visible flashes
    /// and overlap artifacts (known Telegram/Chatto/Signal pattern).
    override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
        return layoutAttributes
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        imageView.image = nil
        // Hard reset label state — UILabel keeps stale text/attributedText
        // across cell reuses, which can cause "empty bubble" symptoms when
        // a previous cell rendered an attributed string and the new one only
        // sets plain text.
        label.text = nil
        label.attributedText = nil
        label.font = .systemFont(ofSize: 16.5)
        label.textColor = dmTP
        label.isHidden = false
        readByLabel.isHidden = true
        groupAvatarView.isHidden = true
        starIcon.isHidden = true
        senderNameLabel.isHidden = true
        forwardedLabel.isHidden = true
        replyContainer.isHidden = true
        statusIcon.isHidden = true
        waveformView.isHidden = true
        voicePlayButton.isHidden = true
        voiceDuration.isHidden = true
        playButton.isHidden = true
        reactionsRow.isHidden = true
        for sub in reactionsRow.arrangedSubviews { sub.removeFromSuperview() }
        reactionPills.removeAll()
        currentVoiceUrl = ""
        selectionOverlay.isHidden = true
        selectionCheckmark.isHidden = true
        contentView.transform = .identity
        groupedWithPrevious = false
        groupPosition = .standalone
        groupTopSpacing = 4
        tailLayer.isHidden = true
        tailLayer.path = nil
        bubble.layer.mask = nil
    }

    /// Build attributed text with @mentions, #hashtags, and URLs colored.
    /// Returns nil if no special tokens were found (so caller uses plain text).
    static func attributedText(for content: String, textColor: UIColor, linkColor: UIColor) -> NSAttributedString? {
        // Quick scan: any @, #, or http? If not, skip the regex pass.
        guard content.contains("@") || content.contains("#") || content.contains("http") else {
            return nil
        }
        let baseFont = UIFont.systemFont(ofSize: 16.5)
        let attr = NSMutableAttributedString(string: content, attributes: [
            .font: baseFont,
            .foregroundColor: textColor,
        ])
        let nsContent = content as NSString
        let range = NSRange(location: 0, length: nsContent.length)

        // Cached regex/detectors (expensive to create — reuse across cells)
        struct CachedRegex {
            static let mention = try? NSRegularExpression(pattern: "@[a-zA-Z0-9_.\\-]+")
            static let hashtag = try? NSRegularExpression(pattern: "#[a-zA-Z0-9_]+")
            static let urlDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        }
        // @mentions: @ followed by username chars
        if let mentionRegex = CachedRegex.mention {
            mentionRegex.enumerateMatches(in: content, options: [], range: range) { match, _, _ in
                if let r = match?.range {
                    attr.addAttributes([
                        .foregroundColor: linkColor,
                        .font: UIFont.systemFont(ofSize: 15.5, weight: .semibold),
                        .backgroundColor: UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 0.12),
                    ], range: r)
                }
            }
        }
        // #hashtags
        if let hashRegex = CachedRegex.hashtag {
            hashRegex.enumerateMatches(in: content, options: [], range: range) { match, _, _ in
                if let r = match?.range {
                    attr.addAttributes([
                        .foregroundColor: linkColor,
                        .font: UIFont.systemFont(ofSize: 15.5, weight: .semibold),
                    ], range: r)
                }
            }
        }
        // URLs (data detector)
        if let urlDetector = CachedRegex.urlDetector {
            urlDetector.enumerateMatches(in: content, options: [], range: range) { match, _, _ in
                if let r = match?.range {
                    attr.addAttributes([
                        .foregroundColor: linkColor,
                    ], range: r)
                }
            }
        }
        return attr
    }

    /// True if the entire content is emoji characters (no real text).
    /// Used to render emoji-only messages with a much larger font.
    private static func isEmojiOnly(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 8 else { return false }
        for scalar in trimmed.unicodeScalars {
            if scalar.properties.isEmoji && scalar.value > 0x238C { continue }
            if scalar.properties.isEmojiPresentation { continue }
            // Variation selectors / zero-width joiners are part of emoji sequences
            if scalar.value == 0xFE0F || scalar.value == 0x200D { continue }
            // Skin tone modifiers
            if scalar.value >= 0x1F3FB && scalar.value <= 0x1F3FF { continue }
            // Whitespace allowed
            if scalar.properties.isWhitespace { continue }
            return false
        }
        return true
    }

    /// Format created_at as a relative time for recent messages, absolute HH:mm otherwise.
    /// "agora", "5 min", "1 h", "ontem 14:23", "12/04 14:23"
    private static func relativeTime(_ iso: String?) -> String {
        guard let iso = iso else { return "" }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = f.date(from: iso)
        if date == nil {
            f.formatOptions = [.withInternetDateTime]
            date = f.date(from: iso)
        }
        if date == nil {
            let alt = DateFormatter()
            alt.dateFormat = "yyyy-MM-dd HH:mm:ss"
            date = alt.date(from: iso)
        }
        guard let d = date else { return "" }
        let now = Date()
        let diff = now.timeIntervalSince(d)
        // Recent messages get HH:mm (WhatsApp behavior — relative time would be confusing)
        let df = DateFormatter()
        let cal = Calendar.current
        if cal.isDateInToday(d) {
            df.dateFormat = "HH:mm"
            return df.string(from: d)
        }
        if cal.isDateInYesterday(d) {
            df.dateFormat = "HH:mm"
            return "ontem " + df.string(from: d)
        }
        if diff < 7 * 24 * 3600 {
            df.locale = Locale(identifier: "pt_BR")
            df.dateFormat = "EEE HH:mm"
            return df.string(from: d).capitalized
        }
        df.dateFormat = "dd/MM HH:mm"
        return df.string(from: d)
    }

    /// Returns the bubble view for use in UITargetedPreview (long-press blur).
    func bubbleViewForPreview() -> UIView? {
        return bubble
    }

    /// Apply selection visual state. ONLY the bubble gets a teal tint + checkmark;
    /// the rest of the screen does not shift (the global shift was making it feel
    /// like the entire profile was being selected).
    func setSelected(_ selected: Bool, inSelectionMode: Bool) {
        selectionOverlay.isHidden = !selected
        selectionCheckmark.isHidden = !selected
        // No transform — keep cells in place. Visual feedback comes purely from
        // the overlay + checkmark on the selected cell.
        contentView.transform = .identity
    }

    func configure(message: [String: Any], isOwn: Bool,
                   ownBubbleColor: UIColor, otherBubbleColor: UIColor,
                   textColor: UIColor, metaColor: UIColor, maxWidth: CGFloat) {
        currentMessageId = (message["id"] as? Int) ?? 0
        var type = (message["type"] as? String) ?? "text"
        // Robust content extraction — sometimes payload_json round-trip can
        // turn the content field into NSNumber/NSNull. Coerce defensively.
        let content: String = {
            if let s = message["content"] as? String { return s }
            if let n = message["content"] as? NSNumber { return n.stringValue }
            if message["content"] is NSNull { return "" }
            return ""
        }()
        let isDeleted = (message["deleted_at"] as? String) != nil

        // Defensive label reset — ensure the UILabel is in a known clean state
        // even if prepareForReuse didn't run (e.g., first-time configure on a
        // freshly-allocated cell).
        label.text = nil
        label.attributedText = nil
        label.isHidden = false
        label.font = .systemFont(ofSize: 16.5)

        // Auto-detect audio from file extension when type is "file"
        if type == "file", let fu = (message["file_url"] as? String)?.lowercased() {
            if fu.hasSuffix(".m4a") || fu.hasSuffix(".mp3") || fu.hasSuffix(".aac")
               || fu.hasSuffix(".wav") || fu.hasSuffix(".ogg") || fu.hasSuffix(".caf") {
                type = "audio"
            }
        }

        bubble.backgroundColor = isOwn ? ownBubbleColor : otherBubbleColor
        label.textColor = isDeleted ? metaColor : textColor
        label.font = isDeleted ? .italicSystemFont(ofSize: 14.5) : .systemFont(ofSize: 16.5)
        timeLabel.textColor = isOwn ? metaColor : metaColor.withAlphaComponent(0.7)

        // ─── WhatsApp-grade layout constants ─────────────────────────
        let bubblePadH: CGFloat = 9         // horizontal padding inside the bubble (WhatsApp)
        let bubblePadV: CGFloat = 5         // vertical padding inside the bubble (WhatsApp compact)
        let outerPad: CGFloat = 10          // gap between bubble edge and screen edge
        let minBubbleW: CGFloat = 56        // hug small messages but not too tight
        // ⭐ FIX 2 (bubble width bug): Trust `maxWidth` as the ONLY authoritative
        // source. contentView.bounds.width can be stale during cell reuse (the
        // cell still has the previous item's width until the next layout pass),
        // causing new cells to render with narrow bubbles and wrapped text.
        // maxWidth is computed by the caller as collectionView.bounds.width * 0.78
        // every time, so it always reflects the current layout.
        let maxBubbleW = maxWidth
        // cvW is used later for positioning (bubbleX). Prefer superview (the
        // UICollectionView) width because contentView bounds are unreliable
        // during reuse. Recover the full width from maxWidth as last resort.
        let cvW: CGFloat = {
            if let cvWidth = (superview as? UICollectionView)?.bounds.width, cvWidth > 0 {
                return cvWidth
            }
            if contentView.bounds.width > 0 { return contentView.bounds.width }
            // maxWidth is 78% of cvWidth; recover the full width
            return max(UIScreen.main.bounds.width, maxWidth / 0.78)
        }()
        var y: CGFloat = bubblePadV

        // ─── Sender name (group chats only, non-own) ─────────────────
        var senderH: CGFloat = 0
        if showSenderName && !isOwn && !isDeleted {
            let senderName = (message["sender_name"] as? String)
                ?? (message["sender_email"] as? String)?.components(separatedBy: "@").first
                ?? ""
            if !senderName.isEmpty {
                senderNameLabel.isHidden = false
                senderNameLabel.text = senderName
                // Color hash from sender email so each user has consistent color
                let senderEmail = (message["sender_email"] as? String) ?? senderName
                senderNameLabel.textColor = Self.colorForSender(senderEmail)
                senderH = 18
            }
        }

        // ─── Forwarded label ─────────────────────────────────────────
        // BUG FIX: dict["key"] returns NSNull (not nil) when JSON has null,
        // so `!= nil` was true for every message. Cast to String/Int and
        // check for non-empty value instead.
        var forwardedH: CGFloat = 0
        let forwardedFromStr = (message["forwarded_from"] as? String) ?? ""
        let forwardCount = (message["forward_count"] as? Int)
            ?? ((message["forward_count"] as? NSNumber)?.intValue) ?? 0
        let isForwarded = !forwardedFromStr.isEmpty || forwardCount > 0
        if isForwarded && !isDeleted {
            forwardedLabel.isHidden = false
            let attr = NSMutableAttributedString()
            // Arrow icon prefix
            if let img = UIImage(systemName: "arrowshape.turn.up.right.fill") {
                let attach = NSTextAttachment()
                attach.image = img.withTintColor(dmTS)
                attach.bounds = CGRect(x: 0, y: -2, width: 12, height: 12)
                attr.append(NSAttributedString(attachment: attach))
                attr.append(NSAttributedString(string: " "))
            }
            attr.append(NSAttributedString(
                string: "Encaminhada",
                attributes: [.font: UIFont.italicSystemFont(ofSize: 12),
                             .foregroundColor: dmTS]
            ))
            forwardedLabel.attributedText = attr
            forwardedH = 18
        } else {
            forwardedLabel.isHidden = true
        }

        // ─── Reply preview header (with colored accent bar on left) ──
        var replyH: CGFloat = 0
        if let reply = message["reply_to"] as? [String: Any], !isDeleted {
            replyContainer.isHidden = false
            let replyText = (reply["content"] as? String) ?? "Mensagem"
            let senderName = (reply["sender_name"] as? String) ?? (reply["sender_email"] as? String)?.components(separatedBy: "@").first ?? ""
            NSLog("[REPLY] id=\(message["id"] ?? "?") reply_to keys=\(Array(reply.keys)) sender='\(senderName)' text='\(replyText.prefix(50))'")
            let combined = NSMutableAttributedString(
                string: senderName + "\n",
                attributes: [
                    .font: UIFont.systemFont(ofSize: 12, weight: .semibold),
                    .foregroundColor: UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1),
                ]
            )
            combined.append(NSAttributedString(
                string: replyText,
                attributes: [
                    .font: UIFont.systemFont(ofSize: 13),
                    .foregroundColor: textColor.withAlphaComponent(0.65),
                ]
            ))
            replyLabel.attributedText = combined
            replyH = 48
            // Frame is set after we know bubbleW below
        } else {
            replyContainer.isHidden = true
        }

        // ─── Body width calculation: hug content for short messages ──
        var bodyW: CGFloat = 0
        var bodyH: CGFloat = 0
        var imgH: CGFloat = 0
        // Text measurement details used by timestamp placement below.
        // Only populated for text/default messages; 0 for image/video/voice.
        var measuredTextLines: Int = 0

        switch type {
        case "image", "video":
            imageView.isHidden = false
            // Hide the label if the "content" is just the filename of the
            // attached file (very common with image/video messages). Only
            // show it when there's a real human caption.
            let trimmedContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
            let fileName = (message["file_name"] as? String) ?? ""
            let looksLikeFilename = !trimmedContent.isEmpty && (
                trimmedContent == fileName ||
                trimmedContent.hasSuffix(".jpg") || trimmedContent.hasSuffix(".jpeg") ||
                trimmedContent.hasSuffix(".png") || trimmedContent.hasSuffix(".gif") ||
                trimmedContent.hasSuffix(".webp") || trimmedContent.hasSuffix(".heic") ||
                trimmedContent.hasSuffix(".mp4") || trimmedContent.hasSuffix(".mov") ||
                trimmedContent.hasSuffix(".webm")
            )
            label.isHidden = trimmedContent.isEmpty || looksLikeFilename || isDeleted
            if isDeleted {
                let iDelAttr = NSMutableAttributedString()
                if let lockImg = UIImage(systemName: "lock.fill")?.withTintColor(metaColor, renderingMode: .alwaysOriginal) {
                    let attach = NSTextAttachment()
                    attach.image = lockImg
                    attach.bounds = CGRect(x: 0, y: -2, width: 13, height: 13)
                    iDelAttr.append(NSAttributedString(attachment: attach))
                    iDelAttr.append(NSAttributedString(string: " "))
                }
                iDelAttr.append(NSAttributedString(string: "Mensagem apagada", attributes: [
                    .font: UIFont.italicSystemFont(ofSize: 14.5), .foregroundColor: metaColor
                ]))
                label.attributedText = iDelAttr
            } else {
                label.text = trimmedContent
            }
            imgH = BubbleCell.imageHeight(for: message, maxWidth: maxBubbleW)
            bodyW = maxBubbleW - bubblePadH * 2
            bodyH = imgH
            if !label.isHidden {
                let labelH = ceil((label.text ?? "").boundingRect(
                    with: CGSize(width: bodyW, height: .greatestFiniteMagnitude),
                    options: [.usesLineFragmentOrigin],
                    attributes: [.font: label.font ?? .systemFont(ofSize: 16.5)],
                    context: nil
                ).height)
                bodyH += labelH + 6
            }

        case "voice", "audio":
            voicePlayButton.isHidden = isDeleted
            waveformView.isHidden = isDeleted
            voiceDuration.isHidden = isDeleted
            label.isHidden = !isDeleted
            if isDeleted {
                let vDelAttr = NSMutableAttributedString()
                if let lockImg = UIImage(systemName: "lock.fill")?.withTintColor(metaColor, renderingMode: .alwaysOriginal) {
                    let attach = NSTextAttachment()
                    attach.image = lockImg
                    attach.bounds = CGRect(x: 0, y: -2, width: 13, height: 13)
                    vDelAttr.append(NSAttributedString(attachment: attach))
                    vDelAttr.append(NSAttributedString(string: " "))
                }
                vDelAttr.append(NSAttributedString(string: "Mensagem apagada", attributes: [
                    .font: UIFont.italicSystemFont(ofSize: 14.5), .foregroundColor: metaColor
                ]))
                label.attributedText = vDelAttr
            } else {
                label.text = ""
            }
            // Capture file url so toggleVoice can actually play it
            currentVoiceUrl = (message["file_url"] as? String) ?? ""
            if isDeleted {
                bodyW = 180
                bodyH = 22
            } else {
                bodyW = 220
                bodyH = 36
            }

        default:
            imageView.isHidden = true
            label.isHidden = false
            label.backgroundColor = .clear
            // Emoji-only messages get a much larger font (WhatsApp does this)
            let isJumbo = !isDeleted && Self.isEmojiOnly(content)
            // Empty content placeholder — bubbles with no text/file at all
            // (corrupted, decryption fail, etc) used to render with only the
            // timestamp visible. Show a subtle italic label instead.
            let isEmptyText = !isDeleted && content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            // ⭐ ROOT CAUSE FIX: NEVER set label.attributedText = nil after
            // label.text = something. On iOS, setting attributedText = nil
            // ALSO clears the plain text, leaving the label empty.
            if isJumbo {
                label.font = .systemFont(ofSize: 48)
                label.text = content
            } else if isDeleted {
                let delFont = UIFont.italicSystemFont(ofSize: 14.5)
                let delAttr = NSMutableAttributedString()
                if let lockImg = UIImage(systemName: "lock.fill")?.withTintColor(metaColor, renderingMode: .alwaysOriginal) {
                    let attach = NSTextAttachment()
                    attach.image = lockImg
                    attach.bounds = CGRect(x: 0, y: -2, width: 13, height: 13)
                    delAttr.append(NSAttributedString(attachment: attach))
                    delAttr.append(NSAttributedString(string: " "))
                }
                delAttr.append(NSAttributedString(string: "Mensagem apagada", attributes: [
                    .font: delFont, .foregroundColor: metaColor
                ]))
                label.attributedText = delAttr
            } else if isEmptyText {
                label.font = .italicSystemFont(ofSize: 14)
                label.text = "Mensagem vazia"
                label.textColor = metaColor
            } else {
                // Normal text — apply mention/hashtag highlighting
                label.font = .systemFont(ofSize: 16.5)
                let attr = Self.attributedText(for: content,
                                               textColor: textColor,
                                               linkColor: UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1))
                if attr != nil {
                    label.attributedText = attr
                } else {
                    label.text = content
                }
            }
            // ── WhatsApp-style "always show something" guard ────────
            let labelString = label.attributedText?.string ?? label.text ?? ""
            if !label.isHidden && labelString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                label.font = .italicSystemFont(ofSize: 14)
                label.textColor = metaColor
                label.text = "🔒 Aguardando esta mensagem…"
            }
            // Use a SAFE width for measurement — never negative or 0.
            // floor() guarantees measureWidth is an integer so that
            // measured.width (rounded up) never exceeds it by sub-pixel
            // rounding. Without floor(), a 286.5pt container rounds the
            // measured width up to 287, and the final label gets clamped
            // to 286.5 → text needs more lines than measured → ellipsis.
            let measureWidth = floor(max(40, maxBubbleW - bubblePadH * 2))
            // ⭐ ROOT-CAUSE FIX (WhatsApp/Telegram/MessageKit pattern):
            // All text measurement flows through ONE function that uses an
            // NSLayoutManager with lineFragmentPadding=0. This is the SAME
            // function estimateHeight() calls, so the two passes are bit-exact.
            // measureAttributedFull also returns `lines` and `lastLineWidth`,
            // which are the KEY inputs for the timestamp placement decision.
            let textMeasurement: TextMeasurement
            if let attr = label.attributedText, attr.length > 0 {
                textMeasurement = BubbleCell.measureAttributedFull(attr, maxWidth: measureWidth)
            } else {
                let labelText = label.text ?? " "
                textMeasurement = BubbleCell.measureTextFull(
                    labelText,
                    font: label.font ?? .systemFont(ofSize: 16.5),
                    maxWidth: measureWidth
                )
            }
            measuredTextLines = textMeasurement.lines
            let lineH = label.font.lineHeight
            bodyW = max(textMeasurement.size.width, 20)
            bodyH = max(textMeasurement.size.height, lineH.rounded(.up))
        }

        // ─── Time + status — they go INLINE at the bottom-right of the
        // bubble, on the same baseline as (or just below) the body text.
        // For text messages we measure the time strip and try to fit it on
        // the last line of the message; if not, we add a new line.
        let timeStr = Self.relativeTime(message["created_at"] as? String)
        let editedPrefix = (message["edited_at"] as? String) != nil ? "editado " : ""
        timeLabel.text = editedPrefix + timeStr
        timeLabel.sizeToFit()
        let timeStripWidth = timeLabel.frame.width + (isOwn ? 18 : 0) // +18 for status icon
        let trailingTimeReserve: CGFloat = timeStripWidth + 10

        // For text messages, see if the time fits on the last line
        var timeOnNewLine = false
        if type != "image" && type != "video" && type != "voice" && type != "audio" {
            // Bubble width = body width + padding, but at least minBubbleW + time strip
            bodyW = max(bodyW, trailingTimeReserve - bubblePadH)
        }

        // Compute final bubble width
        var bubbleW: CGFloat
        if type == "image" || type == "video" {
            bubbleW = maxBubbleW
        } else if type == "voice" || type == "audio" {
            bubbleW = bodyW + bubblePadH * 2
        } else {
            bubbleW = max(minBubbleW, min(maxBubbleW, bodyW + bubblePadH * 2))
            // ⭐ Simplified timestamp placement:
            //  · 1-line bubbles: try to fit inline, else push to new line
            //  · 2+ line bubbles: ALWAYS put timestamp on new line (WhatsApp
            //    behavior — and also guarantees no overlap regardless of
            //    last-line width since we can't know it from boundingRect).
            let lines = measuredTextLines > 0 ? measuredTextLines : 1
            if lines == 1 {
                let totalW = bodyW + trailingTimeReserve + bubblePadH * 2
                if totalW > maxBubbleW {
                    timeOnNewLine = true
                } else {
                    bubbleW = max(minBubbleW, min(maxBubbleW, totalW))
                }
            } else {
                timeOnNewLine = true
            }
        }

        // ─── Now we have bubbleW. Lay out everything inside ────────
        // ⭐ ROOT CAUSE FIX (GPT-5.4 audit): compute bubbleX and set
        // bubble.frame IMMEDIATELY with the final x/width so subview frames
        // land in a parent that has valid geometry. Height is adjusted at
        // the bottom of this method once totalH is known.
        let avatarOffset: CGFloat = (showSenderName && !isOwn) ? 40 : 0
        let bubbleX = isOwn
            ? cvW - bubbleW - outerPad
            : outerPad + avatarOffset
        bubble.frame = CGRect(x: bubbleX, y: groupTopSpacing, width: bubbleW, height: 1)
        bubble.layer.masksToBounds = false

        if !senderNameLabel.isHidden {
            senderNameLabel.frame = CGRect(x: bubblePadH, y: y,
                                           width: bubbleW - bubblePadH * 2,
                                           height: senderH)
            y += senderH
        }
        if !forwardedLabel.isHidden {
            forwardedLabel.frame = CGRect(x: bubblePadH, y: y,
                                          width: bubbleW - bubblePadH * 2,
                                          height: forwardedH)
            y += forwardedH
        }
        if !replyContainer.isHidden {
            replyContainer.frame = CGRect(x: bubblePadH, y: y,
                                          width: bubbleW - bubblePadH * 2,
                                          height: replyH - 4)
            // Position the colored bar
            if let bar = replyContainer.viewWithTag(99) {
                bar.frame = CGRect(x: 0, y: 0, width: 3, height: replyContainer.bounds.height)
            }
            replyLabel.frame = CGRect(x: 8, y: 4,
                                      width: replyContainer.bounds.width - 12,
                                      height: replyContainer.bounds.height - 8)
            y += replyH
        }

        // Body content
        switch type {
        case "image", "video":
            // Full-bleed when no caption: image fills the bubble edge to edge
            // (WhatsApp style). With caption: 4pt inset so the rounded corners
            // visually wrap the image.
            let hasCaption = !label.isHidden
            let imgInset: CGFloat = hasCaption ? 4 : 4
            let imgY: CGFloat = hasCaption ? 4 : 4
            imageView.frame = CGRect(x: imgInset, y: imgY,
                                     width: bubbleW - imgInset * 2, height: imgH)
            // Match image corner radius to bubble corner radius for clean look
            imageView.layer.cornerRadius = hasCaption ? 12 : 14
            playButton.isHidden = type != "video"
            playButton.frame = CGRect(x: imageView.frame.midX - 28, y: imageView.frame.midY - 28,
                                      width: 56, height: 56)
            y += imgH + imgY
            if hasCaption {
                label.frame = CGRect(x: bubblePadH, y: y + 4,
                                     width: bubbleW - bubblePadH * 2,
                                     height: bodyH - imgH - 6)
                y += bodyH - imgH
            }
            if let url = message["file_url"] as? String, !url.isEmpty {
                if type == "video" {
                    // For videos, generate a thumbnail from the first frame
                    BubbleCell.loadVideoThumbnail(remoteUrl: url, into: imageView)
                } else {
                    BubbleCell.loadImage(remoteUrl: url, into: imageView)
                }
            }

        case "voice", "audio":
            if !isDeleted {
                voicePlayButton.frame = CGRect(x: bubblePadH, y: y, width: 32, height: 32)
                let waveW = max(60, bubbleW - bubblePadH * 2 - 80)
                waveformView.frame = CGRect(x: bubblePadH + 38, y: y + 6,
                                            width: waveW, height: 22)
                waveformView.setNeedsDisplay()
                let dur = (message["duration"] as? Double) ?? 0
                voiceDuration.text = String(format: "%d:%02d", Int(dur)/60, Int(dur)%60)
                voiceDuration.frame = CGRect(x: bubbleW - bubblePadH - 38, y: y + 9,
                                             width: 32, height: 16)
                let isPlaying = BubbleCell.currentPlayingMessageId == currentMessageId
                voicePlayButton.setImage(
                    UIImage(systemName: isPlaying ? "pause.fill" : "play.fill"),
                    for: .normal
                )
            } else {
                label.frame = CGRect(x: bubblePadH, y: y,
                                     width: bubbleW - bubblePadH * 2, height: 22)
            }
            y += bodyH

        default:
            // ⭐ Guarantee the label never truncates. We explicitly set
            // numberOfLines=0 AND lineBreakMode=.byWordWrapping here (belt
            // and braces — the init already does this but prepareForReuse
            // paths might have mutated them). The frame width/height comes
            // straight from the measurement pass so UILabel doesn't need to
            // re-wrap.
            label.numberOfLines = 0
            label.lineBreakMode = .byWordWrapping
            // Round DOWN the bubble inner width so UILabel has the exact
            // same or wider container than our measurement used. If UILabel
            // got even 0.1pt less than we measured with, it would push a
            // trailing word to a new line, which then gets ellipsized because
            // the pre-allocated height doesn't cover the extra line.
            let labelW = floor(max(bubbleW - bubblePadH * 2, bodyW))
            label.preferredMaxLayoutWidth = labelW
            label.frame = CGRect(x: bubblePadH, y: y,
                                 width: labelW, height: bodyH)
            label.backgroundColor = .clear
            label.setNeedsDisplay()
            y += bodyH
        }

        // ─── Time strip ───────────────────────────────────────────
        let timeY: CGFloat
        if timeOnNewLine || type == "image" || type == "video" {
            timeY = y + 2
            y += 14
        } else {
            // Inline at the bottom-right of the existing body
            timeY = y - 14
        }
        var timeX = bubbleW - bubblePadH - timeLabel.frame.width
        if isOwn {
            statusIcon.isHidden = false
            statusIcon.image = statusImage(for: message)
            // WhatsApp tick colors: blue (#4FC3F7) for read, gray for delivered/sent
            let status = (message["status"] as? String) ?? ""
            statusIcon.tintColor = status == "read"
                ? UIColor(red: 0.31, green: 0.76, blue: 0.97, alpha: 1)
                : metaColor
            statusIcon.frame = CGRect(x: bubbleW - bubblePadH - 20, y: timeY + 1,
                                       width: 16, height: 11)
            timeX = statusIcon.frame.minX - timeLabel.frame.width - 4
        } else {
            statusIcon.isHidden = true
        }
        timeLabel.frame = CGRect(x: max(bubblePadH, timeX), y: timeY,
                                 width: timeLabel.frame.width, height: 14)

        let totalH = y + bubblePadV + (timeOnNewLine ? 0 : 0)

        // ─── Group avatar (small circle to left of non-own bubbles) ───
        // Only show in group chats for non-own messages, and only on the FIRST
        // message in a consecutive run from the same sender.
        if showSenderName && !isOwn && !groupedWithPrevious {
            groupAvatarView.isHidden = false
            let senderName = (message["sender_name"] as? String)
                ?? (message["sender_email"] as? String)?.components(separatedBy: "@").first
                ?? "?"
            let senderEmail = (message["sender_email"] as? String) ?? senderName
            groupAvatarView.backgroundColor = Self.colorForSender(senderEmail)
            groupAvatarLabel.text = String(senderName.prefix(1)).uppercased()
            groupAvatarView.frame = CGRect(x: outerPad, y: groupTopSpacing + 2, width: 28, height: 28)
            groupAvatarLabel.frame = groupAvatarView.bounds
        } else {
            groupAvatarView.isHidden = true
        }

        // ─── Bubble frame (final height) ─────
        // X/width were set at the top of the layout phase (bubble.frame was
        // assigned there so subviews get a valid parent). Here we just adjust
        // the final height now that totalH is known.
        bubble.frame.size.height = totalH + bubblePadV

        // ─── Self-sizing correction: if actual height differs from estimated,
        // invalidate this cell's height so sizeForItemAt returns the correct value next time.
        // Tight threshold (±0.5 pt) — even 1pt overlaps are visible when cells are stacked.
        let actualCellHeight = totalH + bubblePadV + groupTopSpacing + 2 // bubble + spacing + bottom margin
        if let cv = superview as? UICollectionView,
           let ip = cv.indexPath(for: self),
           let parent = cv.superview as? NativeChatCollectionView {
            let key = NativeChatCollectionView.cacheKeyStatic(for: message, index: ip.item, groupPosition: groupPosition)
            let cachedH = parent.heightCache[key] ?? 0
            if abs(cachedH - actualCellHeight) > 0.5 {
                parent.heightCache[key] = actualCellHeight
                // Targeted invalidation — only this item, so the rest of the
                // layout isn't recomputed from scratch (avoids scroll jumps).
                DispatchQueue.main.async {
                    let ctx = UICollectionViewFlowLayoutInvalidationContext()
                    ctx.invalidateItems(at: [ip])
                    cv.collectionViewLayout.invalidateLayout(with: ctx)
                }
            }
        }

        // ─── Star indicator (top-right corner of bubble for starred messages) ───
        let isStarred = (message["starred"] as? Bool) ?? ((message["starred"] as? Int) ?? 0 > 0)
        if isStarred && !isDeleted {
            starIcon.isHidden = false
            starIcon.frame = CGRect(x: bubbleW - 18, y: 4, width: 12, height: 12)
        } else {
            starIcon.isHidden = true
        }

        // ─── Read receipts row (own messages in groups) ───
        // Show "Lido" or "Visto por X" below own bubbles when read_by has entries.
        if isOwn && !isDeleted, let readBy = message["read_by"] as? [Any], !readBy.isEmpty {
            let count = readBy.count
            readByLabel.isHidden = false
            readByLabel.text = count == 1 ? "Lido" : "Lido por \(count)"
            // Position right below the bubble, aligned with the bubble's right edge
            let rbW: CGFloat = 100
            readByLabel.frame = CGRect(
                x: bubble.frame.maxX - rbW,
                y: bubble.frame.maxY + 1,
                width: rbW,
                height: 12
            )
        } else {
            readByLabel.isHidden = true
        }

        // ─── WhatsApp-style grouped corner radii & tail ────────────
        let bigR: CGFloat = 16
        let smallR: CGFloat = 4
        let showTail = (groupPosition == .standalone || groupPosition == .last)

        // Per-corner radii based on group position
        let cr: (tl: CGFloat, tr: CGFloat, bl: CGFloat, br: CGFloat)
        switch groupPosition {
        case .standalone:
            cr = isOwn
                ? (tl: bigR, tr: smallR, bl: bigR, br: bigR)
                : (tl: smallR, tr: bigR, bl: bigR, br: bigR)
        case .first:
            cr = isOwn
                ? (tl: bigR, tr: smallR, bl: bigR, br: smallR)
                : (tl: smallR, tr: bigR, bl: smallR, br: bigR)
        case .middle:
            cr = isOwn
                ? (tl: bigR, tr: smallR, bl: bigR, br: smallR)
                : (tl: smallR, tr: bigR, bl: smallR, br: bigR)
        case .last:
            cr = isOwn
                ? (tl: bigR, tr: smallR, bl: bigR, br: bigR)
                : (tl: smallR, tr: bigR, bl: bigR, br: bigR)
        }

        // Apply per-corner radius via bezier path mask
        let bRect = CGRect(x: 0, y: 0, width: bubbleW, height: bubble.frame.height)
        let mp = UIBezierPath()
        mp.move(to: CGPoint(x: bRect.minX, y: bRect.minY + cr.tl))
        mp.addArc(withCenter: CGPoint(x: bRect.minX + cr.tl, y: bRect.minY + cr.tl),
                  radius: cr.tl, startAngle: .pi, endAngle: .pi * 1.5, clockwise: true)
        mp.addLine(to: CGPoint(x: bRect.maxX - cr.tr, y: bRect.minY))
        mp.addArc(withCenter: CGPoint(x: bRect.maxX - cr.tr, y: bRect.minY + cr.tr),
                  radius: cr.tr, startAngle: .pi * 1.5, endAngle: 0, clockwise: true)
        mp.addLine(to: CGPoint(x: bRect.maxX, y: bRect.maxY - cr.br))
        mp.addArc(withCenter: CGPoint(x: bRect.maxX - cr.br, y: bRect.maxY - cr.br),
                  radius: cr.br, startAngle: 0, endAngle: .pi * 0.5, clockwise: true)
        mp.addLine(to: CGPoint(x: bRect.minX + cr.bl, y: bRect.maxY))
        mp.addArc(withCenter: CGPoint(x: bRect.minX + cr.bl, y: bRect.maxY - cr.bl),
                  radius: cr.bl, startAngle: .pi * 0.5, endAngle: .pi, clockwise: true)
        mp.close()
        let shapeMask = CAShapeLayer()
        shapeMask.path = mp.cgPath
        bubble.layer.mask = shapeMask
        bubble.layer.cornerRadius = bigR

        // Draw tail only on standalone or last message in group
        // Tail is on contentView.layer, so offset by bubble origin
        if showTail {
            let tailW: CGFloat = 8
            let tailH: CGFloat = 13
            let bx = bubble.frame.origin.x
            let by = bubble.frame.origin.y
            let tailPath = UIBezierPath()
            if isOwn {
                tailPath.move(to: CGPoint(x: bx + bubbleW - 0.5, y: by))
                tailPath.addLine(to: CGPoint(x: bx + bubbleW + tailW, y: by))
                tailPath.addQuadCurve(to: CGPoint(x: bx + bubbleW - 0.5, y: by + tailH),
                                      controlPoint: CGPoint(x: bx + bubbleW + tailW * 0.4, y: by + tailH * 0.6))
                tailPath.close()
            } else {
                tailPath.move(to: CGPoint(x: bx + 0.5, y: by))
                tailPath.addLine(to: CGPoint(x: bx - tailW, y: by))
                tailPath.addQuadCurve(to: CGPoint(x: bx + 0.5, y: by + tailH),
                                      controlPoint: CGPoint(x: bx - tailW * 0.4, y: by + tailH * 0.6))
                tailPath.close()
            }
            tailLayer.path = tailPath.cgPath
            tailLayer.fillColor = bubble.backgroundColor?.cgColor
            tailLayer.isHidden = false
        } else {
            tailLayer.path = nil
            tailLayer.isHidden = true
        }

        // ─── Reactions row (overlapping the bottom-right of the bubble) ──
        if let reactions = message["reactions"] as? [[String: Any]], !reactions.isEmpty {
            reactionsRow.isHidden = false
            for r in reactions {
                let emoji = (r["emoji"] as? String) ?? ""
                let count = (r["count"] as? Int) ?? 1
                let pill = makeReactionPill(emoji: emoji, count: count)
                reactionsRow.addArrangedSubview(pill)
            }
            let pillsW = min(CGFloat(reactions.count) * 45, contentView.bounds.width - 20)
            let reactX = isOwn
                ? max(10, bubble.frame.maxX - pillsW)
                : bubble.frame.minX
            reactionsRow.frame = CGRect(
                x: reactX,
                y: bubble.frame.maxY - 10,
                width: pillsW,
                height: 26
            )
            reactionPills = reactions.compactMap { r in
                guard let emoji = r["emoji"] as? String else { return nil }
                if let view = reactionsRow.arrangedSubviews.first(where: { ($0 as? UILabel)?.text?.hasPrefix(emoji) ?? false }) {
                    return (emoji, view.convert(view.bounds, to: contentView))
                }
                return nil
            }
        } else {
            reactionsRow.isHidden = true
        }
    }

    // Hit-test for reaction taps
    func reactionAt(point: CGPoint) -> String? {
        for pill in reactionPills {
            if pill.frame.contains(point) { return pill.emoji }
        }
        return nil
    }

    private func makeReactionPill(emoji: String, count: Int) -> UILabel {
        let pill = UILabel()
        let countText = count > 1 ? " \(count)" : ""
        pill.text = "\(emoji)\(countText)"
        pill.font = .systemFont(ofSize: 13)
        pill.textColor = dmTP
        pill.backgroundColor = dmRPB
        pill.layer.cornerRadius = 12
        pill.layer.borderWidth = 1.5
        pill.layer.borderColor = dmBrd.cgColor
        pill.textAlignment = .center
        pill.frame = CGRect(x: 0, y: 0, width: 42, height: 24)
        // Soft shadow for depth (WhatsApp pills have a subtle drop)
        pill.layer.shadowColor = UIColor.black.cgColor
        pill.layer.shadowOpacity = 0.08
        pill.layer.shadowRadius = 1.5
        pill.layer.shadowOffset = CGSize(width: 0, height: 1)
        pill.layer.masksToBounds = false
        // Spring scale-in animation when pill appears
        pill.transform = CGAffineTransform(scaleX: 0.3, y: 0.3)
        pill.alpha = 0
        UIView.animate(withDuration: 0.45, delay: 0,
                       usingSpringWithDamping: 0.55, initialSpringVelocity: 0.9,
                       options: [.allowUserInteraction], animations: {
            pill.transform = .identity
            pill.alpha = 1
        })
        return pill
    }

    private func statusImage(for message: [String: Any]) -> UIImage? {
        let status = (message["status"] as? String) ?? ""
        // WhatsApp-style: ✓ sent, ✓✓ delivered (grey), ✓✓ read (blue)
        switch status {
        case "read", "played":
            // Double checkmark — rendered as two overlapping checks
            return Self.doubleCheckImage(pointSize: 11, weight: .semibold)
        case "delivered":
            // Double checkmark (grey tint set by caller)
            return Self.doubleCheckImage(pointSize: 11, weight: .semibold)
        case "sent":
            // Single check
            let config = UIImage.SymbolConfiguration(pointSize: 11, weight: .regular)
            return UIImage(systemName: "checkmark", withConfiguration: config)?
                .withRenderingMode(.alwaysTemplate)
        case "failed":
            let config = UIImage.SymbolConfiguration(pointSize: 11, weight: .medium)
            return UIImage(systemName: "exclamationmark.circle", withConfiguration: config)?
                .withRenderingMode(.alwaysTemplate)
        default:
            // Pending — clock
            let config = UIImage.SymbolConfiguration(pointSize: 10, weight: .regular)
            return UIImage(systemName: "clock", withConfiguration: config)?
                .withRenderingMode(.alwaysTemplate)
        }
    }

    /// Renders a WhatsApp-style double checkmark (✓✓) by drawing two SF Symbol
    /// checkmarks slightly offset. Returns a template-mode image.
    private static func doubleCheckImage(pointSize: CGFloat, weight: UIImage.SymbolWeight) -> UIImage? {
        let config = UIImage.SymbolConfiguration(pointSize: pointSize, weight: weight)
        guard let single = UIImage(systemName: "checkmark", withConfiguration: config) else { return nil }
        let w = single.size.width * 1.55
        let h = single.size.height
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: w, height: h))
        let img = renderer.image { _ in
            single.draw(at: CGPoint(x: 0, y: 0))
            single.draw(at: CGPoint(x: single.size.width * 0.55, y: 0))
        }
        return img.withRenderingMode(.alwaysTemplate)
    }

    /// Hash-based color for sender names in groups (WhatsApp-style)
    static func colorForSender(_ email: String) -> UIColor {
        let palette: [UIColor] = [
            UIColor(red: 0.93, green: 0.30, blue: 0.45, alpha: 1), // pink
            UIColor(red: 0.18, green: 0.50, blue: 0.93, alpha: 1), // blue
            UIColor(red: 0.55, green: 0.30, blue: 0.85, alpha: 1), // purple
            UIColor(red: 0.20, green: 0.70, blue: 0.30, alpha: 1), // green
            UIColor(red: 0.95, green: 0.55, blue: 0.15, alpha: 1), // orange
            UIColor(red: 0.85, green: 0.20, blue: 0.20, alpha: 1), // red
            UIColor(red: 0.30, green: 0.55, blue: 0.65, alpha: 1), // steel
            UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1), // cosmic purple
        ]
        var hash: UInt32 = 5381
        for u in email.unicodeScalars { hash = (hash &* 33) &+ u.value }
        return palette[Int(hash % UInt32(palette.count))]
    }

    // Static formatters (created once, reused — DateFormatter is expensive)
    // Accessible by other cells (LocationCell, MeetupCell, etc.)
    static let isoFmt: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let isoFmtNoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    static let fallbackFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        f.timeZone = TimeZone(identifier: "UTC") // server times are UTC
        return f
    }()
    static let outputFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        f.timeZone = .current // display in user's timezone
        return f
    }()

    private func formatTime(_ s: String?) -> String {
        guard let s = s, !s.isEmpty else { return "" }
        // Normalize: add Z suffix if no timezone info (server sends UTC without Z)
        // Check if string already has timezone: ends with Z, contains +, or has - after position 10 (not date dash)
        let hasTZ = s.hasSuffix("Z") || s.contains("+") || (s.count > 19 && s.dropFirst(19).contains("-"))
        let normalized = hasTZ ? s : s + "Z"
        let date = Self.isoFmt.date(from: normalized)
            ?? Self.isoFmtNoFrac.date(from: normalized)
            ?? Self.fallbackFmt.date(from: s)
        guard let d = date else { return "" }
        return Self.outputFmt.string(from: d)
    }

    @objc private func toggleVoice() {
        guard currentMessageId != 0 else { return }
        // If this cell's message is currently playing → pause/stop
        if BubbleCell.currentPlayingMessageId == currentMessageId,
           let p = BubbleCell.audioPlayer, p.isPlaying {
            p.pause()
            BubbleCell.currentPlayingMessageId = 0
            voicePlayButton.setImage(UIImage(systemName: "play.fill"), for: .normal)
            waveformView.stopTracking()
            return
        }
        // Stop any other playback
        BubbleCell.audioPlayer?.stop()
        BubbleCell.audioPlayer = nil
        waveformView.stopTracking()

        guard !currentVoiceUrl.isEmpty else { return }
        let absUrl = Self.absoluteUrl(currentVoiceUrl)
        guard let url = URL(string: absUrl) else { return }
        let messageId = currentMessageId

        // Configure audio session for playback
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {}

        // Download (cached on disk) and play
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            let localPath = cacheDir.appendingPathComponent("voice_\(url.lastPathComponent)")
            var data: Data?
            if FileManager.default.fileExists(atPath: localPath.path) {
                data = try? Data(contentsOf: localPath)
            } else if let downloaded = try? Data(contentsOf: url) {
                try? downloaded.write(to: localPath)
                data = downloaded
            }
            guard let data = data else { return }
            DispatchQueue.main.async {
                guard self?.currentMessageId == messageId else { return }
                do {
                    let player = try AVAudioPlayer(data: data)
                    player.prepareToPlay()
                    player.play()
                    BubbleCell.audioPlayer = player
                    BubbleCell.currentPlayingMessageId = messageId
                    self?.voicePlayButton.setImage(UIImage(systemName: "pause.fill"), for: .normal)
                    // Animate waveform progress while playing
                    self?.waveformView.startTracking(player)
                } catch {}
            }
        }
    }

    /// Measurement result: full size + number of lines.
    struct TextMeasurement {
        let size: CGSize
        let lines: Int
    }

    /// Canonical text measurement via boundingRect (MessageKit pattern).
    /// Both `estimateHeight()` and `configure()` call through here so the
    /// two passes are always in sync. `.rounded(.up)` prevents sub-pixel
    /// line-break promotion (Telegram rule).
    static func measureText(_ text: String, font: UIFont, maxWidth: CGFloat) -> CGSize {
        return measureTextFull(text, font: font, maxWidth: maxWidth).size
    }

    static func measureAttributed(_ attr: NSAttributedString, maxWidth: CGFloat) -> CGSize {
        return measureAttributedFull(attr, maxWidth: maxWidth).size
    }

    static func measureTextFull(_ text: String, font: UIFont, maxWidth: CGFloat) -> TextMeasurement {
        guard !text.isEmpty, maxWidth > 0 else {
            return TextMeasurement(size: .zero, lines: 0)
        }
        let r = (text as NSString).boundingRect(
            with: CGSize(width: maxWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font],
            context: nil
        )
        let size = CGSize(width: r.width.rounded(.up), height: r.height.rounded(.up))
        let lineH = font.lineHeight
        let lines = lineH > 0 ? max(1, Int((size.height / lineH).rounded(.up))) : 1
        return TextMeasurement(size: size, lines: lines)
    }

    static func measureAttributedFull(_ attr: NSAttributedString, maxWidth: CGFloat) -> TextMeasurement {
        guard attr.length > 0, maxWidth > 0 else {
            return TextMeasurement(size: .zero, lines: 0)
        }
        let r = attr.boundingRect(
            with: CGSize(width: maxWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        )
        let size = CGSize(width: r.width.rounded(.up), height: r.height.rounded(.up))
        // Use the attributed font (fallback to system body).
        let font: UIFont
        if attr.length > 0, let f = attr.attribute(.font, at: 0, effectiveRange: nil) as? UIFont {
            font = f
        } else {
            font = .systemFont(ofSize: 16.5)
        }
        let lineH = font.lineHeight
        let lines = lineH > 0 ? max(1, Int((size.height / lineH).rounded(.up))) : 1
        return TextMeasurement(size: size, lines: lines)
    }

    /// Compute the on-screen height of an image/video bubble BEFORE the image
    /// downloads. Uses server-provided dimensions when available (populated at
    /// upload time by image-helper.php:processImage). Falls back to a 230pt
    /// square placeholder.
    ///
    /// The rendered image width is clamped to a WhatsApp-style target (240pt)
    /// and the height scales proportionally — portrait images get taller, landscape
    /// shorter. Extreme aspect ratios are clamped to 1:2 / 2:1 to avoid absurd
    /// stretched bubbles.
    static func imageHeight(for message: [String: Any], maxWidth: CGFloat) -> CGFloat {
        let w = (message["image_width"] as? Int) ?? ((message["image_width"] as? NSNumber)?.intValue ?? 0)
        let h = (message["image_height"] as? Int) ?? ((message["image_height"] as? NSNumber)?.intValue ?? 0)
        guard w > 0, h > 0 else { return 230 } // no dimensions → placeholder
        let targetW = min(maxWidth - 18, 240) // 18 = bubble h-padding * 2
        let aspect = CGFloat(h) / CGFloat(w)
        // Clamp extreme aspect ratios: 0.5 (super wide) to 1.6 (super tall)
        let clamped = max(0.5, min(1.6, aspect))
        return ceil(targetW * clamped)
    }

    static func estimateHeight(message: [String: Any], maxWidth: CGFloat) -> CGFloat {
        let type = (message["type"] as? String) ?? "text"
        let content = (message["content"] as? String) ?? ""
        let isDeleted = (message["deleted_at"] as? String) != nil
        let hasReply = (message["reply_to"] as? [String: Any]) != nil
            || (message["reply_to_id"] != nil && !(message["reply_to_id"] is NSNull))
        let hasReactions = (message["reactions"] as? [[String: Any]])?.isEmpty == false
        let forwardedFromStr = (message["forwarded_from"] as? String) ?? ""
        let forwardCount = (message["forward_count"] as? Int)
            ?? ((message["forward_count"] as? NSNumber)?.intValue) ?? 0
        let isForwarded = !forwardedFromStr.isEmpty || forwardCount > 0

        // Base: bubblePadV(5) top + bubblePadV(5) bottom + time row(16) = 26
        var h: CGFloat = 26
        // Sender name only matters in groups
        if let sn = message["sender_name"] as? String, !sn.isEmpty { h += 18 }
        if isForwarded { h += 18 }
        if hasReply { h += 48 }
        if hasReactions { h += 18 }

        switch type {
        case "image", "video":
            // Use server-provided image_width/image_height when available
            // (uploaded after upload handler computes dimensions). Fall back
            // to a square 230pt placeholder when unknown.
            let imgH = BubbleCell.imageHeight(for: message, maxWidth: maxWidth)
            h += imgH
            if !content.isEmpty && !isDeleted {
                let font = UIFont.systemFont(ofSize: 16.5) // matches actual label font
                let r = (content as NSString).boundingRect(
                    with: CGSize(width: maxWidth - 18, height: .greatestFiniteMagnitude),
                    // MUST match configure() options exactly, otherwise the estimated
                    // cell height differs from the rendered bubble height and cells
                    // overlap visually.
                    options: [.usesLineFragmentOrigin, .usesFontLeading],
                    attributes: [.font: font], context: nil
                )
                h += ceil(r.height) + 8
            }
        case "voice", "audio":
            h += isDeleted ? 22 : 50
        case "poll", "location", "meetup", "contact", "playlist", "call_card":
            // These are rendered by special cells with their own sizeForItemAt,
            // but if they somehow reach BubbleCell.estimateHeight, give generous height
            h += 180
        default:
            // Emoji-only messages use 48pt font (WhatsApp large emoji)
            let isEmojiOnly = !content.isEmpty && content.count <= 8 && GifStickerCell.isEmojiOnly(content)
            let font: UIFont
            if isDeleted {
                font = UIFont.italicSystemFont(ofSize: 14)
            } else if isEmojiOnly {
                font = UIFont.systemFont(ofSize: 48)
            } else {
                font = UIFont.systemFont(ofSize: 16.5)
            }
            // ⭐ SINGLE SOURCE OF TRUTH: identical measurement function that
            // configure() uses. Zero drift = zero overlap.
            let measureWidth = max(40, maxWidth - 18)
            let measured = BubbleCell.measureTextFull(content, font: font, maxWidth: measureWidth)
            let lineH = font.lineHeight.rounded(.up)
            let bodyH = max(measured.size.height, lineH)
            h += bodyH + 6

            // ── Timestamp-line adjustment ──
            // Mirror configure() EXACTLY:
            //  · 1-line bubbles: timestamp tries inline, promotes to new line
            //    if it doesn't fit.
            //  · 2+ line bubbles: timestamp ALWAYS on a new line.
            let trailingTimeReserve: CGFloat = 60
            if measured.lines == 1 {
                if measured.size.width + trailingTimeReserve > measureWidth {
                    h += lineH
                }
            } else {
                // Multi-line → always +1 line for the timestamp.
                h += lineH
            }
        }
        // Extra safety: add 2pt to ALL text estimates to account for sub-pixel
        // rounding differences between the two measurement passes. Without this
        // guard, a 1-2pt estimate shortfall causes the next cell to overlap.
        h += 2
        return h
    }

    /// Convert a relative file_url ("/api/files/...") to absolute by prepending
    /// the chatyy host. URLs that already start with http(s) are returned as-is.
    static func absoluteUrl(_ raw: String) -> String {
        if raw.hasPrefix("http://") || raw.hasPrefix("https://") { return raw }
        if raw.hasPrefix("/") { return "https://chatyy.com.br" + raw }
        return raw
    }

    /// Stable SHA256 hash of a string — same across app launches.
    /// String.hashValue is randomized per process, which broke our disk cache
    /// (every launch generated different paths → re-downloaded every time).
    static func stableHash(_ s: String) -> String {
        let data = Data(s.utf8)
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Disk path for a cached remote image (stable SHA256 of the URL)
    private static func diskPath(for remoteUrl: String) -> URL {
        let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        let imgsDir = cacheDir.appendingPathComponent("chat_imgs", isDirectory: true)
        try? FileManager.default.createDirectory(at: imgsDir, withIntermediateDirectories: true)
        let ext = (URL(string: remoteUrl)?.pathExtension ?? "img")
        let safe = stableHash(remoteUrl) + (ext.isEmpty ? ".img" : ".\(ext)")
        return imgsDir.appendingPathComponent(safe)
    }

    static func prefetchImage(remoteUrl raw: String) {
        let remoteUrl = absoluteUrl(raw)
        if imageCache.object(forKey: remoteUrl as NSString) != nil { return }
        let disk = diskPath(for: remoteUrl)
        if FileManager.default.fileExists(atPath: disk.path) {
            if let img = UIImage(contentsOfFile: disk.path) {
                imageCache.setObject(img, forKey: remoteUrl as NSString)
            }
            return
        }
        guard let url = URL(string: remoteUrl) else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data = data, let img = UIImage(data: data) else { return }
            try? data.write(to: disk)
            imageCache.setObject(img, forKey: remoteUrl as NSString)
        }.resume()
    }

    /// Generate a thumbnail from the first frame of a video URL.
    /// Uses AVAssetImageGenerator on a background queue, caches in disk + memory.
    static func loadVideoThumbnail(remoteUrl raw: String, into view: UIImageView) {
        let remoteUrl = absoluteUrl(raw)
        let cacheKey = "video_thumb_" + remoteUrl
        if let cached = imageCache.object(forKey: cacheKey as NSString) {
            view.image = cached
            return
        }
        let disk = diskPath(for: cacheKey)
        if FileManager.default.fileExists(atPath: disk.path) {
            DispatchQueue.global(qos: .userInitiated).async {
                if let img = UIImage(contentsOfFile: disk.path) {
                    imageCache.setObject(img, forKey: cacheKey as NSString)
                    DispatchQueue.main.async {
                        if view.window != nil { view.image = img }
                    }
                }
            }
            return
        }
        guard let url = URL(string: remoteUrl) else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            let asset = AVURLAsset(url: url)
            let gen = AVAssetImageGenerator(asset: asset)
            gen.appliesPreferredTrackTransform = true
            gen.maximumSize = CGSize(width: 600, height: 600)
            let time = CMTime(seconds: 0.5, preferredTimescale: 600)
            do {
                let cgImage = try gen.copyCGImage(at: time, actualTime: nil)
                let thumb = UIImage(cgImage: cgImage)
                if let data = thumb.jpegData(compressionQuality: 0.8) {
                    try? data.write(to: disk)
                }
                imageCache.setObject(thumb, forKey: cacheKey as NSString)
                DispatchQueue.main.async {
                    if view.window != nil { view.image = thumb }
                }
            } catch {
                // Fallback: try to load as regular image (sometimes a poster URL)
                if let data = try? Data(contentsOf: url), let img = UIImage(data: data) {
                    imageCache.setObject(img, forKey: cacheKey as NSString)
                    DispatchQueue.main.async {
                        if view.window != nil { view.image = img }
                    }
                }
            }
        }
    }

    static func loadImage(remoteUrl raw: String, into view: UIImageView) {
        let remoteUrl = absoluteUrl(raw)
        // 1) Memory cache
        if let cached = imageCache.object(forKey: remoteUrl as NSString) {
            view.image = cached
            return
        }
        // 2) Disk cache (persists across app launches → instant on second view)
        let disk = diskPath(for: remoteUrl)
        if FileManager.default.fileExists(atPath: disk.path) {
            DispatchQueue.global(qos: .userInitiated).async {
                if let img = UIImage(contentsOfFile: disk.path) {
                    imageCache.setObject(img, forKey: remoteUrl as NSString)
                    DispatchQueue.main.async {
                        if view.window != nil { view.image = img }
                    }
                }
            }
            return
        }
        // 3) Network — download then write to disk + memory.
        // [weak view] prevents retaining the UIImageView (and therefore the
        // whole cell) during the download — critical for long scroll sessions.
        guard let url = URL(string: remoteUrl) else { return }
        URLSession.shared.dataTask(with: url) { [weak view] data, _, _ in
            guard let data = data, let img = UIImage(data: data) else { return }
            try? data.write(to: disk)
            imageCache.setObject(img, forKey: remoteUrl as NSString)
            DispatchQueue.main.async {
                guard let view = view else { return }
                if view.window != nil { view.image = img }
            }
        }.resume()
    }
}

// MARK: - Date separator cell

final class SeparatorCell: UICollectionViewCell {
    let label = UILabel()
    private let pill = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        // WhatsApp date pill: adapts to light/dark mode
        pill.backgroundColor = UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? UIColor(red: 0.15, green: 0.22, blue: 0.27, alpha: 0.92)
                : UIColor(white: 1.0, alpha: 0.92)
        }
        pill.layer.cornerRadius = 11
        pill.layer.shadowColor = UIColor.black.cgColor
        pill.layer.shadowOpacity = 0.06
        pill.layer.shadowRadius = 1
        pill.layer.shadowOffset = CGSize(width: 0, height: 1)
        contentView.addSubview(pill)

        label.font = .systemFont(ofSize: 12, weight: .semibold)
        label.textColor = UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? UIColor(white: 0.85, alpha: 0.9)
                : UIColor(red: 0.07, green: 0.11, blue: 0.13, alpha: 0.78)
        }
        label.textAlignment = .center
        pill.addSubview(label)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Auto-width based on text content
        label.sizeToFit()
        let textW = max(60, ceil(label.frame.width) + 24)
        let w = min(textW, bounds.width - 40)
        pill.frame = CGRect(x: (bounds.width - w) / 2, y: 4, width: w, height: 22)
        label.frame = pill.bounds
    }
}

// MARK: - System message cell (centered grey pill)

final class SystemCell: UICollectionViewCell {
    let label = UILabel()
    private let icon = UIImageView()
    private let pill = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        // WhatsApp-style system pill: adapts to light/dark mode
        pill.backgroundColor = dmSPB
        pill.layer.cornerRadius = 11
        pill.layer.shadowColor = UIColor.black.cgColor
        pill.layer.shadowOpacity = 0.06
        pill.layer.shadowRadius = 1
        pill.layer.shadowOffset = CGSize(width: 0, height: 1)
        contentView.addSubview(pill)
        // Icon (small SF Symbol prefix — lock for E2E, phone for calls, etc.)
        icon.tintColor = dmSPT
        icon.contentMode = .scaleAspectFit
        pill.addSubview(icon)
        label.font = .systemFont(ofSize: 12)
        label.textColor = dmSPT
        label.textAlignment = .center
        label.numberOfLines = 2
        pill.addSubview(label)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    /// Pick an SF Symbol based on the text content (auto-detect call / E2E / etc).
    func updateIcon() {
        let lower = (label.text ?? "").lowercased()
        let cfg = UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
        if lower.contains("criptografad") || lower.contains("encrypt") || lower.contains("e2e") {
            icon.image = UIImage(systemName: "lock.fill", withConfiguration: cfg)
            icon.isHidden = false
        } else if lower.contains("chamada") || lower.contains("call") || lower.contains("ligaç") {
            icon.image = UIImage(systemName: "phone.fill", withConfiguration: cfg)
            icon.isHidden = false
        } else if lower.contains("vídeo") || lower.contains("video") {
            icon.image = UIImage(systemName: "video.fill", withConfiguration: cfg)
            icon.isHidden = false
        } else if lower.contains("desapareceu") || lower.contains("disappear") || lower.contains("temporár") {
            icon.image = UIImage(systemName: "timer", withConfiguration: cfg)
            icon.isHidden = false
        } else if lower.contains("entrou") || lower.contains("joined") || lower.contains("saiu") || lower.contains("left") {
            icon.image = UIImage(systemName: "person.fill", withConfiguration: cfg)
            icon.isHidden = false
        } else {
            icon.isHidden = true
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        updateIcon()
        // Auto-size pill width based on text + icon
        label.sizeToFit()
        let iconW: CGFloat = icon.isHidden ? 0 : 18
        let textW = ceil(label.frame.width) + 20 + iconW
        let w = min(textW, bounds.width - 60)
        pill.frame = CGRect(x: (bounds.width - w) / 2, y: 6, width: w, height: 24)
        if !icon.isHidden {
            icon.frame = CGRect(x: 10, y: (24 - 12) / 2, width: 14, height: 14)
            label.frame = CGRect(x: 28, y: 4, width: w - 38, height: 16)
        } else {
            icon.frame = .zero
            label.frame = pill.bounds.insetBy(dx: 10, dy: 4)
        }
    }
}

// MARK: - Gesture recognizer + context menu delegates

extension NativeChatCollectionView: UIGestureRecognizerDelegate, UIContextMenuInteractionDelegate {
    public func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                                   shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        // Allow our pan to coexist with the collection's vertical scroll
        return true
    }

    // Override of UIView.gestureRecognizerShouldBegin (the UIView default that
    // gets called BEFORE the delegate). UIView already declares this so we
    // need the `override` keyword.
    public override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        // Only steal the gesture if it's a clearly horizontal pan
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
        let v = pan.velocity(in: collectionView)
        return abs(v.x) > abs(v.y) && v.x > 0
    }

    public func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                                        configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
        guard let ip = collectionView.indexPathForItem(at: location),
              ip.item < rows.count else { return nil }
        let row = rows[ip.item]
        if row["__separator__"] != nil { return nil }
        let messageId = (row["id"] as? Int) ?? 0
        let isOwn = (row["sender_email"] as? String) == myEmail
        // Haptic feedback (medium impact) when user long-presses a bubble
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        // Cache location so previewForHighlighting can find the right cell
        lastContextMenuLocation = location
        lastContextMenuIndexPath = ip

        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
            guard let self = self else { return nil }

            // Top row: quick reactions (👍❤️😂😮😢🙏)
            let reactions = ["👍", "❤️", "😂", "😮", "😢", "🙏"]
            let reactionMenu = UIMenu(title: "", options: .displayInline,
                                       children: reactions.map { emoji in
                UIAction(title: emoji) { _ in
                    self.onContextAction([
                        "action": "react",
                        "emoji": emoji,
                        "messageId": messageId,
                    ])
                }
            })

            // Bottom row: actions
            let reply = UIAction(title: "Responder", image: UIImage(systemName: "arrowshape.turn.up.left")) { _ in
                self.onContextAction(["action": "reply", "messageId": messageId])
            }
            let forward = UIAction(title: "Encaminhar", image: UIImage(systemName: "arrowshape.turn.up.right")) { _ in
                self.onContextAction(["action": "forward", "messageId": messageId])
            }
            let copy = UIAction(title: "Copiar", image: UIImage(systemName: "doc.on.doc")) { _ in
                if let content = row["content"] as? String {
                    UIPasteboard.general.string = content
                }
                self.onContextAction(["action": "copy", "messageId": messageId])
            }
            let star = UIAction(title: "Favoritar", image: UIImage(systemName: "star")) { _ in
                self.onContextAction(["action": "star", "messageId": messageId])
            }
            let info = UIAction(title: "Info", image: UIImage(systemName: "info.circle")) { _ in
                self.onContextAction(["action": "info", "messageId": messageId])
            }
            let select = UIAction(title: "Selecionar", image: UIImage(systemName: "checkmark.circle")) { _ in
                self.onContextAction(["action": "select", "messageId": messageId])
            }
            var children: [UIMenuElement] = [reply, forward, copy, star, select, info]
            if isOwn {
                let delete = UIAction(title: "Apagar",
                                      image: UIImage(systemName: "trash"),
                                      attributes: .destructive) { _ in
                    self.onContextAction(["action": "delete", "messageId": messageId])
                }
                children.append(delete)
            }
            return UIMenu(title: "", children: [reactionMenu] + children)
        }
    }

    /// Custom highlight preview — show ONLY the bubble (not the whole row)
    /// with a clean rounded shape, like WhatsApp/iMessage long-press.
    public func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                                        previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
        guard let ip = lastContextMenuIndexPath,
              let cell = collectionView.cellForItem(at: ip) as? BubbleCell,
              let bubbleView = cell.bubbleViewForPreview() else {
            return nil
        }
        let parameters = UIPreviewParameters()
        parameters.backgroundColor = .clear
        let path = UIBezierPath(roundedRect: bubbleView.bounds, cornerRadius: 16)
        parameters.visiblePath = path
        return UITargetedPreview(view: bubbleView, parameters: parameters)
    }

    public func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                                        previewForDismissingMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
        return self.contextMenuInteraction(interaction, previewForHighlightingMenuWithConfiguration: configuration)
    }
}

// MARK: - Voice message waveform

final class WaveformView: UIView {
    var samples: [Float] = []
    var progress: CGFloat = 0 { didSet { setNeedsDisplay() } }
    var color = UIColor(red: 0.55, green: 0.62, blue: 0.65, alpha: 1)
    var progressColor = UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1)
    private var displayLink: CADisplayLink?
    private weak var player: AVAudioPlayer?
    /// Called when user drags / taps the waveform to seek
    var onSeek: ((CGFloat) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        // Generate stable pseudo-samples (deterministic so doesn't change on redraw)
        var seed: Float = 0.5
        samples = (0..<44).map { _ in
            seed = (seed * 1.6 + 0.3).truncatingRemainder(dividingBy: 1)
            return 0.25 + seed * 0.7
        }
        isUserInteractionEnabled = true
        // Tap-to-seek
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        addGestureRecognizer(tap)
        // Drag-to-scrub
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        addGestureRecognizer(pan)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    @objc private func handleTap(_ gr: UITapGestureRecognizer) {
        let x = gr.location(in: self).x
        let frac = max(0, min(1, x / max(1, bounds.width)))
        progress = frac
        onSeek?(frac)
    }
    @objc private func handlePan(_ gr: UIPanGestureRecognizer) {
        let x = gr.location(in: self).x
        let frac = max(0, min(1, x / max(1, bounds.width)))
        progress = frac
        if gr.state == .ended || gr.state == .cancelled {
            onSeek?(frac)
        }
    }

    // BUG 3 FIX: CADisplayLink retains its target strongly, creating a retain
    // cycle (WaveformView -> displayLink -> WaveformView). Use a weak proxy
    // target so the display link does not prevent deallocation.
    private class DisplayLinkProxy {
        weak var target: WaveformView?
        init(_ target: WaveformView) { self.target = target }
        @objc func tick() { target?.tickFromProxy() }
    }
    private var displayLinkProxy: DisplayLinkProxy?

    /// Bind to a playing AVAudioPlayer — waveform progress updates each frame.
    func startTracking(_ p: AVAudioPlayer) {
        player = p
        displayLink?.invalidate()
        let proxy = DisplayLinkProxy(self)
        displayLinkProxy = proxy
        let dl = CADisplayLink(target: proxy, selector: #selector(DisplayLinkProxy.tick))
        dl.add(to: .main, forMode: .common)
        displayLink = dl
    }
    func stopTracking() {
        displayLink?.invalidate()
        displayLink = nil
        displayLinkProxy = nil
        player = nil
        progress = 0
    }
    @objc fileprivate func tickFromProxy() {
        guard let p = player else { return }
        if !p.isPlaying { stopTracking(); return }
        let dur = p.duration
        progress = dur > 0 ? CGFloat(p.currentTime / dur) : 0
    }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext(), !samples.isEmpty else { return }
        let barWidth: CGFloat = 2.5
        let gap: CGFloat = 2
        let totalWidth = CGFloat(samples.count) * (barWidth + gap)
        let startX: CGFloat = 0
        let usableWidth = min(totalWidth, rect.width)
        let visibleCount = Int(usableWidth / (barWidth + gap))
        let midY = rect.height / 2
        for i in 0..<min(visibleCount, samples.count) {
            let s = samples[i]
            let h = max(3, CGFloat(s) * rect.height * 0.85)
            let x = startX + CGFloat(i) * (barWidth + gap)
            let frac = CGFloat(i) / CGFloat(visibleCount)
            ctx.setFillColor((frac < progress ? progressColor : color).cgColor)
            // Rounded bars
            let barRect = CGRect(x: x, y: midY - h/2, width: barWidth, height: h)
            ctx.addPath(UIBezierPath(roundedRect: barRect, cornerRadius: barWidth/2).cgPath)
            ctx.fillPath()
        }
    }
}

// MARK: - ★ WhatsApp Multi-View Type Cells

/// PollCell — renders poll with options, progress bars, voting
final class PollCell: UICollectionViewCell {
    private let bubble = UIView()
    private let iconCircle = UIView()
    private let iconView = UIImageView()
    private let badge = UILabel()
    private let questionLabel = UILabel()
    private let optionsStack = UIStackView()
    private let footer = UILabel()
    private let timeLabel = UILabel()
    var onVote: ((Int) -> Void)?
    private var messageId: Int = 0
    private weak var parentView: NativeChatCollectionView?
    private var bubbleLeading: NSLayoutConstraint!
    private var bubbleTrailing: NSLayoutConstraint!

    private static let accent = UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1) // Chatyy purple
    private static let accentLight = UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 0.18)

    override init(frame: CGRect) {
        super.init(frame: frame)
        setupUI()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    private func setupUI() {
        // Bubble container — WhatsApp own bubble look (75% width)
        contentView.addSubview(bubble)
        bubble.translatesAutoresizingMaskIntoConstraints = false
        bubble.layer.cornerRadius = 14
        bubble.layer.shadowColor = UIColor.black.cgColor
        bubble.layer.shadowOpacity = 0 // WhatsApp: no bubble shadow
        bubble.layer.shadowRadius = 2
        bubble.layer.shadowOffset = CGSize(width: 0, height: 1)
        bubbleLeading = bubble.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 10)
        bubbleTrailing = bubble.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -10)
        NSLayoutConstraint.activate([
            bubbleLeading,
            bubble.widthAnchor.constraint(lessThanOrEqualTo: contentView.widthAnchor, multiplier: 0.75),
            bubble.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 4),
            bubble.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -4),
        ])

        // Icon circle (WhatsApp accent bg)
        bubble.addSubview(iconCircle)
        iconCircle.translatesAutoresizingMaskIntoConstraints = false
        iconCircle.backgroundColor = Self.accentLight
        iconCircle.layer.cornerRadius = 18
        NSLayoutConstraint.activate([
            iconCircle.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 12),
            iconCircle.topAnchor.constraint(equalTo: bubble.topAnchor, constant: 14),
            iconCircle.widthAnchor.constraint(equalToConstant: 36),
            iconCircle.heightAnchor.constraint(equalToConstant: 36),
        ])

        iconCircle.addSubview(iconView)
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.image = UIImage(systemName: "chart.bar.fill")
        iconView.tintColor = Self.accent
        iconView.contentMode = .scaleAspectFit
        NSLayoutConstraint.activate([
            iconView.centerXAnchor.constraint(equalTo: iconCircle.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconCircle.centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 18),
            iconView.heightAnchor.constraint(equalToConstant: 18),
        ])

        // Badge
        bubble.addSubview(badge)
        badge.translatesAutoresizingMaskIntoConstraints = false
        badge.font = .systemFont(ofSize: 11, weight: .bold)
        badge.textColor = Self.accent
        badge.text = "ENQUETE"
        NSLayoutConstraint.activate([
            badge.leadingAnchor.constraint(equalTo: iconCircle.trailingAnchor, constant: 10),
            badge.topAnchor.constraint(equalTo: bubble.topAnchor, constant: 14),
            badge.trailingAnchor.constraint(lessThanOrEqualTo: bubble.trailingAnchor, constant: -12),
        ])

        // Question
        bubble.addSubview(questionLabel)
        questionLabel.translatesAutoresizingMaskIntoConstraints = false
        questionLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        questionLabel.textColor = dmTP
        questionLabel.numberOfLines = 0
        NSLayoutConstraint.activate([
            questionLabel.leadingAnchor.constraint(equalTo: iconCircle.trailingAnchor, constant: 10),
            questionLabel.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -12),
            questionLabel.topAnchor.constraint(equalTo: badge.bottomAnchor, constant: 2),
        ])

        // Options stack
        bubble.addSubview(optionsStack)
        optionsStack.translatesAutoresizingMaskIntoConstraints = false
        optionsStack.axis = .vertical
        optionsStack.spacing = 8
        NSLayoutConstraint.activate([
            optionsStack.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 12),
            optionsStack.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -12),
            optionsStack.topAnchor.constraint(equalTo: questionLabel.bottomAnchor, constant: 14),
        ])

        // Footer
        bubble.addSubview(footer)
        footer.translatesAutoresizingMaskIntoConstraints = false
        footer.font = .systemFont(ofSize: 12, weight: .medium)
        footer.textColor = dmTS
        NSLayoutConstraint.activate([
            footer.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 12),
            footer.topAnchor.constraint(equalTo: optionsStack.bottomAnchor, constant: 12),
            footer.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -10),
        ])

        // Time
        bubble.addSubview(timeLabel)
        timeLabel.translatesAutoresizingMaskIntoConstraints = false
        timeLabel.font = .systemFont(ofSize: 11)
        timeLabel.textColor = dmTS
        NSLayoutConstraint.activate([
            timeLabel.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -12),
            timeLabel.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -10),
        ])
    }

    func configure(message: [String: Any], isOwn: Bool, view: NativeChatCollectionView) {
        // Align bubble: own → right, other → left
        if isOwn {
            bubbleLeading.isActive = false
            bubbleTrailing.isActive = true
        } else {
            bubbleTrailing.isActive = false
            bubbleLeading.isActive = true
        }
        messageId = (message["id"] as? Int) ?? 0
        parentView = view
        bubble.backgroundColor = isOwn ? view.ownBubbleColor : view.otherBubbleColor

        // Clear previous options
        optionsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        guard let poll = message["poll"] as? [String: Any] else { return }
        let question = (poll["question"] as? String) ?? ""
        let options: [String] = (poll["options"] as? [String])
            ?? (poll["options"] as? [[String: Any]])?.compactMap { $0["text"] as? String }
            ?? []

        questionLabel.text = question
        let totalVotes = (poll["total_votes"] as? Int) ?? 0
        let voteCounts = (poll["vote_counts"] as? [Int]) ?? Array(repeating: 0, count: options.count)
        let myVotes = (poll["my_votes"] as? [Int]) ?? []
        let multipleChoice = (poll["multiple_choice"] as? Bool) ?? false

        badge.text = multipleChoice ? "📊 ENQUETE · MÚLTIPLA" : "📊 ENQUETE"
        let hasMyVote = !myVotes.isEmpty
        if totalVotes == 0 {
            footer.text = "Toque para votar"
        } else {
            let votesStr = totalVotes == 1 ? "1 voto" : "\(totalVotes) votos"
            footer.text = hasMyVote ? "\(votesStr) · Você votou" : "\(votesStr) · Toque para votar"
        }

        for (idx, optionText) in options.enumerated() {
            let count = idx < voteCounts.count ? voteCounts[idx] : 0
            let pct = totalVotes > 0 ? Int(round(Double(count) / Double(totalVotes) * 100)) : 0
            let hasVoted = myVotes.contains(idx)
            let row = PollOptionRow(text: optionText, voteCount: count, percentage: pct, hasVoted: hasVoted)
            row.onTap = { [weak self] in self?.onVote?(idx) }
            optionsStack.addArrangedSubview(row)
        }

        // Time
        if let created = message["created_at"] as? String {
            timeLabel.text = Self.formatTime(created)
        } else {
            timeLabel.text = ""
        }
    }

    private static func formatTime(_ iso: String) -> String {
        let s = iso
        let hasTZ = s.hasSuffix("Z") || s.contains("+") || (s.count > 19 && s.dropFirst(19).contains("-"))
        let normalized = hasTZ ? s : s + "Z"
        let date = BubbleCell.isoFmt.date(from: normalized)
            ?? BubbleCell.isoFmtNoFrac.date(from: normalized)
            ?? BubbleCell.fallbackFmt.date(from: s)
        guard let d = date else { return "" }
        return BubbleCell.outputFmt.string(from: d)
    }
}

// MARK: - PollOptionRow (Telegram-style: option label sits ON the filled bar)
final class PollOptionRow: UIView {
    private let track = UIView()
    private let fill = UIView()
    private let optionLabel = UILabel()
    private let percentLabel = UILabel()
    private let voteCountLabel = UILabel()
    private let checkmark = UIImageView()
    var onTap: (() -> Void)?

    private static let accent = UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1)
    private static let accentLight = UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 0.13)
    private static let track_bg = dmTBg

    init(text: String, voteCount: Int, percentage: Int, hasVoted: Bool) {
        super.init(frame: .zero)
        setupUI(text: text, voteCount: voteCount, percentage: percentage, hasVoted: hasVoted)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    private func setupUI(text: String, voteCount: Int, percentage: Int, hasVoted: Bool) {
        translatesAutoresizingMaskIntoConstraints = false
        let tap = UITapGestureRecognizer(target: self, action: #selector(didTap))
        addGestureRecognizer(tap)
        isUserInteractionEnabled = true

        // Background track (full width pill) — taller for better tap target
        addSubview(track)
        track.translatesAutoresizingMaskIntoConstraints = false
        track.backgroundColor = Self.track_bg
        track.layer.cornerRadius = 10
        track.layer.masksToBounds = true
        NSLayoutConstraint.activate([
            track.leadingAnchor.constraint(equalTo: leadingAnchor),
            track.trailingAnchor.constraint(equalTo: trailingAnchor),
            track.topAnchor.constraint(equalTo: topAnchor),
            track.heightAnchor.constraint(equalToConstant: 36),
            track.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        // Filled portion — proportional width
        track.addSubview(fill)
        fill.translatesAutoresizingMaskIntoConstraints = false
        fill.backgroundColor = hasVoted ? Self.accent : Self.accentLight
        fill.layer.cornerRadius = 10
        fill.layer.masksToBounds = true
        NSLayoutConstraint.activate([
            fill.leadingAnchor.constraint(equalTo: track.leadingAnchor),
            fill.topAnchor.constraint(equalTo: track.topAnchor),
            fill.bottomAnchor.constraint(equalTo: track.bottomAnchor),
            fill.widthAnchor.constraint(equalTo: track.widthAnchor,
                                        multiplier: max(0.06, CGFloat(percentage) / 100.0)),
        ])

        // Checkmark inside the bar (only if voted)
        track.addSubview(checkmark)
        checkmark.translatesAutoresizingMaskIntoConstraints = false
        let cfg = UIImage.SymbolConfiguration(pointSize: 12, weight: .bold)
        checkmark.image = UIImage(systemName: "checkmark", withConfiguration: cfg)
        checkmark.tintColor = .white
        checkmark.isHidden = !hasVoted
        NSLayoutConstraint.activate([
            checkmark.leadingAnchor.constraint(equalTo: track.leadingAnchor, constant: 12),
            checkmark.centerYAnchor.constraint(equalTo: track.centerYAnchor),
            checkmark.widthAnchor.constraint(equalToConstant: 14),
            checkmark.heightAnchor.constraint(equalToConstant: 14),
        ])

        // ⭐ Percentage label MUST be added BEFORE optionLabel because
        // optionLabel's trailing constraint references percentLabel.leadingAnchor.
        // Activating that constraint before percentLabel is in the hierarchy
        // crashes the app with "view has no common ancestor".
        track.addSubview(percentLabel)
        percentLabel.translatesAutoresizingMaskIntoConstraints = false
        percentLabel.font = .systemFont(ofSize: 13, weight: .bold)
        percentLabel.textColor = hasVoted ? .white : dmTP
        percentLabel.text = "\(percentage)%"
        percentLabel.textAlignment = .right
        NSLayoutConstraint.activate([
            percentLabel.trailingAnchor.constraint(equalTo: track.trailingAnchor, constant: -14),
            percentLabel.centerYAnchor.constraint(equalTo: track.centerYAnchor),
        ])

        // Option label (sits on top of the bar)
        track.addSubview(optionLabel)
        optionLabel.translatesAutoresizingMaskIntoConstraints = false
        optionLabel.font = .systemFont(ofSize: 14, weight: hasVoted ? .semibold : .medium)
        optionLabel.text = text
        optionLabel.textColor = hasVoted ? .white : dmTP
        optionLabel.numberOfLines = 1
        NSLayoutConstraint.activate([
            optionLabel.leadingAnchor.constraint(equalTo: hasVoted ? checkmark.trailingAnchor : track.leadingAnchor,
                                                 constant: hasVoted ? 8 : 16),
            optionLabel.centerYAnchor.constraint(equalTo: track.centerYAnchor),
            optionLabel.trailingAnchor.constraint(lessThanOrEqualTo: percentLabel.leadingAnchor, constant: -8),
        ])
    }

    @objc private func didTap() { onTap?() }
}

/// LocationCell — renders location like WhatsApp:
///   • Static map snapshot (MKMapSnapshotter, looks like Google Maps)
///   • Compact ~130pt map with pin overlay
///   • Time pill in the bottom-right corner of the map
///   • Footer with address (bold) + "Toque para abrir no mapa" hint
///   • "AO VIVO" red badge for live location
final class LocationCell: UICollectionViewCell {
    private let bubble = UIView()
    /// Static map image generated by MKMapSnapshotter — visually identical to
    /// Google Maps Static, no API key needed, free forever.
    private let mapImageView = UIImageView()
    private let pinOverlay = UIView()
    private let pinDot = UIView()
    private let pinTail = CAShapeLayer()
    private let footerView = UIView()
    private let pinIcon = UIImageView()
    private let addressLabel = UILabel()
    private let subLabel = UILabel()
    private let liveBadge = UILabel()
    /// Time pill displayed in the bottom-right of the map (WhatsApp style)
    private let mapTimePill = UILabel()
    private let timeLabel = UILabel()
    var onTap: ((Double, Double, String) -> Void)?
    private var locationLat: Double = 0
    private var locationLng: Double = 0
    private var locationLabel: String = ""
    /// Cache snapshots per coordinate so cells reuse the image instantly.
    static var snapshotCache: [String: UIImage] = [:]
    private var currentSnapshotKey: String = ""
    private var bubbleLeading: NSLayoutConstraint!
    private var bubbleTrailing: NSLayoutConstraint!

    private static let accent = UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1)

    override init(frame: CGRect) {
        super.init(frame: frame)
        setupUI()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    private func setupUI() {
        // Bubble
        contentView.addSubview(bubble)
        bubble.translatesAutoresizingMaskIntoConstraints = false
        bubble.layer.cornerRadius = 14
        bubble.layer.masksToBounds = true
        bubble.layer.shadowColor = UIColor.black.cgColor
        bubble.layer.shadowOpacity = 0 // WhatsApp: no bubble shadow
        bubble.layer.shadowRadius = 2
        bubble.layer.shadowOffset = CGSize(width: 0, height: 1)
        bubbleLeading = bubble.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 10)
        bubbleTrailing = bubble.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -10)
        NSLayoutConstraint.activate([
            bubbleLeading,
            bubble.widthAnchor.constraint(lessThanOrEqualToConstant: 250),
            bubble.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 4),
            bubble.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -4),
        ])

        // Static map image (filled by MKMapSnapshotter)
        bubble.addSubview(mapImageView)
        mapImageView.translatesAutoresizingMaskIntoConstraints = false
        mapImageView.contentMode = .scaleAspectFill
        mapImageView.clipsToBounds = true
        mapImageView.backgroundColor = dmMPh // adapts to dark mode
        NSLayoutConstraint.activate([
            mapImageView.leadingAnchor.constraint(equalTo: bubble.leadingAnchor),
            mapImageView.trailingAnchor.constraint(equalTo: bubble.trailingAnchor),
            mapImageView.topAnchor.constraint(equalTo: bubble.topAnchor),
            mapImageView.heightAnchor.constraint(equalToConstant: 90),
        ])

        // Pin overlay — red dot in the center of the map
        bubble.addSubview(pinOverlay)
        pinOverlay.translatesAutoresizingMaskIntoConstraints = false
        pinOverlay.isUserInteractionEnabled = false
        NSLayoutConstraint.activate([
            pinOverlay.centerXAnchor.constraint(equalTo: mapImageView.centerXAnchor),
            pinOverlay.centerYAnchor.constraint(equalTo: mapImageView.centerYAnchor, constant: -10),
            pinOverlay.widthAnchor.constraint(equalToConstant: 28),
            pinOverlay.heightAnchor.constraint(equalToConstant: 36),
        ])
        pinOverlay.addSubview(pinDot)
        pinDot.translatesAutoresizingMaskIntoConstraints = false
        pinDot.backgroundColor = UIColor(red: 0.93, green: 0.20, blue: 0.20, alpha: 1)
        pinDot.layer.cornerRadius = 14
        pinDot.layer.borderWidth = 3
        pinDot.layer.borderColor = UIColor.white.cgColor
        pinDot.layer.shadowColor = UIColor.black.cgColor
        pinDot.layer.shadowOpacity = 0.35
        pinDot.layer.shadowRadius = 3
        pinDot.layer.shadowOffset = CGSize(width: 0, height: 2)
        NSLayoutConstraint.activate([
            pinDot.topAnchor.constraint(equalTo: pinOverlay.topAnchor),
            pinDot.centerXAnchor.constraint(equalTo: pinOverlay.centerXAnchor),
            pinDot.widthAnchor.constraint(equalToConstant: 28),
            pinDot.heightAnchor.constraint(equalToConstant: 28),
        ])

        // Time pill in the bottom-right of the map (WhatsApp style)
        bubble.addSubview(mapTimePill)
        mapTimePill.translatesAutoresizingMaskIntoConstraints = false
        mapTimePill.font = .systemFont(ofSize: 11, weight: .semibold)
        mapTimePill.textColor = .white
        mapTimePill.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        mapTimePill.layer.cornerRadius = 9
        mapTimePill.layer.masksToBounds = true
        mapTimePill.textAlignment = .center
        NSLayoutConstraint.activate([
            mapTimePill.trailingAnchor.constraint(equalTo: mapImageView.trailingAnchor, constant: -8),
            mapTimePill.bottomAnchor.constraint(equalTo: mapImageView.bottomAnchor, constant: -8),
            mapTimePill.heightAnchor.constraint(equalToConstant: 18),
            mapTimePill.widthAnchor.constraint(greaterThanOrEqualToConstant: 38),
        ])

        // Live badge (top-left of map)
        bubble.addSubview(liveBadge)
        liveBadge.translatesAutoresizingMaskIntoConstraints = false
        liveBadge.font = .systemFont(ofSize: 11, weight: .heavy)
        liveBadge.textColor = .white
        liveBadge.backgroundColor = UIColor(red: 0.93, green: 0.20, blue: 0.20, alpha: 1)
        liveBadge.text = "  ● AO VIVO  "
        liveBadge.layer.cornerRadius = 10
        liveBadge.layer.masksToBounds = true
        liveBadge.textAlignment = .center
        liveBadge.isHidden = true
        NSLayoutConstraint.activate([
            liveBadge.topAnchor.constraint(equalTo: mapImageView.topAnchor, constant: 10),
            liveBadge.leadingAnchor.constraint(equalTo: mapImageView.leadingAnchor, constant: 10),
            liveBadge.heightAnchor.constraint(equalToConstant: 22),
        ])

        // Footer container
        bubble.addSubview(footerView)
        footerView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            footerView.leadingAnchor.constraint(equalTo: bubble.leadingAnchor),
            footerView.trailingAnchor.constraint(equalTo: bubble.trailingAnchor),
            footerView.topAnchor.constraint(equalTo: mapImageView.bottomAnchor),
            footerView.bottomAnchor.constraint(equalTo: bubble.bottomAnchor),
            footerView.heightAnchor.constraint(equalToConstant: 50),
        ])

        // Pin icon (small)
        footerView.addSubview(pinIcon)
        pinIcon.translatesAutoresizingMaskIntoConstraints = false
        pinIcon.image = UIImage(systemName: "location.fill")
        pinIcon.tintColor = Self.accent
        pinIcon.contentMode = .scaleAspectFit
        NSLayoutConstraint.activate([
            pinIcon.leadingAnchor.constraint(equalTo: footerView.leadingAnchor, constant: 12),
            pinIcon.centerYAnchor.constraint(equalTo: footerView.centerYAnchor),
            pinIcon.widthAnchor.constraint(equalToConstant: 16),
            pinIcon.heightAnchor.constraint(equalToConstant: 16),
        ])

        // ABRIR button (right side of footer) — WhatsApp-like CTA
        let openBtn = UILabel()
        footerView.addSubview(openBtn)
        openBtn.translatesAutoresizingMaskIntoConstraints = false
        openBtn.font = .systemFont(ofSize: 12, weight: .heavy)
        openBtn.textColor = .white
        openBtn.text = "  ABRIR  "
        openBtn.backgroundColor = Self.accent
        openBtn.layer.cornerRadius = 12
        openBtn.layer.masksToBounds = true
        openBtn.textAlignment = .center
        NSLayoutConstraint.activate([
            openBtn.trailingAnchor.constraint(equalTo: footerView.trailingAnchor, constant: -12),
            openBtn.centerYAnchor.constraint(equalTo: footerView.centerYAnchor),
            openBtn.heightAnchor.constraint(equalToConstant: 24),
        ])

        // Time (above the ABRIR button)
        footerView.addSubview(timeLabel)
        timeLabel.translatesAutoresizingMaskIntoConstraints = false
        timeLabel.font = .systemFont(ofSize: 10)
        timeLabel.textColor = dmTS
        NSLayoutConstraint.activate([
            timeLabel.trailingAnchor.constraint(equalTo: openBtn.trailingAnchor),
            timeLabel.bottomAnchor.constraint(equalTo: footerView.bottomAnchor, constant: -4),
        ])

        // Address label (bold)
        footerView.addSubview(addressLabel)
        addressLabel.translatesAutoresizingMaskIntoConstraints = false
        addressLabel.font = .systemFont(ofSize: 14, weight: .semibold)
        addressLabel.textColor = dmTP
        addressLabel.numberOfLines = 1

        footerView.addSubview(subLabel)
        subLabel.translatesAutoresizingMaskIntoConstraints = false
        subLabel.font = .systemFont(ofSize: 12)
        subLabel.textColor = dmTS
        subLabel.text = "Toque para abrir no mapa"
        subLabel.numberOfLines = 1

        NSLayoutConstraint.activate([
            addressLabel.leadingAnchor.constraint(equalTo: pinIcon.trailingAnchor, constant: 8),
            addressLabel.trailingAnchor.constraint(equalTo: openBtn.leadingAnchor, constant: -10),
            addressLabel.topAnchor.constraint(equalTo: footerView.topAnchor, constant: 10),
            subLabel.leadingAnchor.constraint(equalTo: pinIcon.trailingAnchor, constant: 8),
            subLabel.trailingAnchor.constraint(equalTo: openBtn.leadingAnchor, constant: -10),
            subLabel.topAnchor.constraint(equalTo: addressLabel.bottomAnchor, constant: 2),
        ])

        // Tap gesture on the whole bubble
        let tap = UITapGestureRecognizer(target: self, action: #selector(didTapMap))
        bubble.addGestureRecognizer(tap)
        bubble.isUserInteractionEnabled = true
    }

    func configure(message: [String: Any], isOwn: Bool, view: NativeChatCollectionView) {
        // Align bubble: own → right, other → left
        if isOwn {
            bubbleLeading.isActive = false
            bubbleTrailing.isActive = true
        } else {
            bubbleTrailing.isActive = false
            bubbleLeading.isActive = true
        }
        let latitude = Self.coerceDouble(message["latitude"])
        let longitude = Self.coerceDouble(message["longitude"])
        let rawAddress = (message["address"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? (message["label"] as? String)
            ?? (message["name"] as? String)
            ?? ""
        let isCoordsString = rawAddress.range(
            of: #"^-?\d+\.\d+\s*,\s*-?\d+\.\d+$"#,
            options: .regularExpression
        ) != nil
        let displayAddress: String = {
            if rawAddress.isEmpty || isCoordsString { return "Localização compartilhada" }
            return rawAddress
        }()
        let isLive = (message["live"] as? Bool) ?? false

        addressLabel.text = displayAddress
        if (rawAddress.isEmpty || isCoordsString) && (latitude != 0 || longitude != 0) {
            Self.reverseGeocode(latitude: latitude, longitude: longitude) { [weak self] resolved in
                guard let self = self,
                      self.locationLat == latitude,
                      self.locationLng == longitude,
                      let resolved = resolved else { return }
                self.addressLabel.text = resolved
                self.locationLabel = resolved
            }
        }
        liveBadge.isHidden = !isLive
        bubble.backgroundColor = isOwn ? view.ownBubbleColor : view.otherBubbleColor
        footerView.backgroundColor = bubble.backgroundColor

        self.locationLat = latitude
        self.locationLng = longitude
        self.locationLabel = displayAddress

        if let created = message["created_at"] as? String {
            timeLabel.text = Self.formatTime(created)
            mapTimePill.text = "  " + Self.formatTime(created) + "  "
        } else {
            timeLabel.text = ""
            mapTimePill.text = ""
        }

        guard latitude != 0 || longitude != 0 else {
            pinOverlay.isHidden = true
            mapImageView.image = nil
            return
        }
        pinOverlay.isHidden = false

        // Generate (or fetch from cache) a static map snapshot — looks like
        // Google Maps Static, no API key needed.
        let key = String(format: "%.5f,%.5f", latitude, longitude)
        currentSnapshotKey = key
        if let cached = Self.snapshotCache[key] {
            mapImageView.image = cached
            return
        }
        mapImageView.image = nil
        Self.generateSnapshot(latitude: latitude, longitude: longitude) { [weak self] image in
            guard let self = self, self.currentSnapshotKey == key else { return }
            if let image = image {
                Self.snapshotCache[key] = image
                self.mapImageView.image = image
            }
        }
    }

    /// Renders a static map snapshot via MKMapSnapshotter (background thread).
    /// Free, no API key, looks like Google Maps Static.
    private static func generateSnapshot(latitude: Double, longitude: Double, completion: @escaping (UIImage?) -> Void) {
        let options = MKMapSnapshotter.Options()
        options.region = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
            span: MKCoordinateSpan(latitudeDelta: 0.004, longitudeDelta: 0.004)
        )
        options.size = CGSize(width: 360, height: 95)
        options.scale = UIScreen.main.scale
        options.mapType = .standard
        options.pointOfInterestFilter = .includingAll
        let snapshotter = MKMapSnapshotter(options: options)
        snapshotter.start(with: DispatchQueue.global(qos: .userInitiated)) { snapshot, _ in
            DispatchQueue.main.async {
                completion(snapshot?.image)
            }
        }
    }

    private static func coerceDouble(_ v: Any?) -> Double {
        if let d = v as? Double { return d }
        if let n = v as? NSNumber { return n.doubleValue }
        if let s = v as? String, let d = Double(s) { return d }
        return 0
    }

    /// Per-coordinate cache so we don't re-geocode the same point.
    private static var geocodeCache: [String: String] = [:]
    private static let geocoder = CLGeocoder()
    private static func reverseGeocode(latitude: Double, longitude: Double, completion: @escaping (String?) -> Void) {
        let key = String(format: "%.5f,%.5f", latitude, longitude)
        if let cached = geocodeCache[key] {
            DispatchQueue.main.async { completion(cached) }
            return
        }
        let loc = CLLocation(latitude: latitude, longitude: longitude)
        let locale = Locale(identifier: "pt_BR")
        geocoder.reverseGeocodeLocation(loc, preferredLocale: locale) { placemarks, _ in
            guard let p = placemarks?.first else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            // Build a friendly one-liner: "Rua Foo, 123 · Bairro · Cidade"
            var parts: [String] = []
            if let street = p.thoroughfare { parts.append(street + (p.subThoroughfare.map { ", \($0)" } ?? "")) }
            if let neigh = p.subLocality { parts.append(neigh) }
            if let city = p.locality { parts.append(city) }
            let resolved = parts.joined(separator: " · ")
            if !resolved.isEmpty {
                geocodeCache[key] = resolved
            }
            DispatchQueue.main.async {
                completion(resolved.isEmpty ? nil : resolved)
            }
        }
    }

    @objc private func didTapMap() {
        onTap?(locationLat, locationLng, locationLabel)
    }

    private static func formatTime(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = f.date(from: iso)
        if date == nil { f.formatOptions = [.withInternetDateTime]; date = f.date(from: iso) }
        guard let d = date else { return "" }
        let df = DateFormatter()
        df.dateFormat = "HH:mm"
        return df.string(from: d)
    }
}

/// MeetupCell — renders meetup with RSVP buttons (WhatsApp event card style)
final class MeetupCell: UICollectionViewCell {
    private let bubble = UIView()
    private let header = UIView()
    private let calIcon = UIImageView()
    private let badge = UILabel()
    private let titleLabel = UILabel()
    private let dateRow = UIStackView()
    private let dateIcon = UIImageView()
    private let dateLabel = UILabel()
    private let locRow = UIStackView()
    private let locIcon = UIImageView()
    private let locationLabel = UILabel()
    private let goingBtn = UIButton(type: .custom)
    private let maybeBtn = UIButton(type: .custom)
    private let notGoingBtn = UIButton(type: .custom)
    private let goingCount = UILabel()
    private let maybeCount = UILabel()
    private let notGoingCount = UILabel()
    private let timeLabel = UILabel()
    var onRsvp: ((String) -> Void)?
    private var currentRsvp: String? = nil
    private var bubbleLeading: NSLayoutConstraint!
    private var bubbleTrailing: NSLayoutConstraint!

    private static let accent = UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1)   // #7C3AED purple
    private static let accentSoft = UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 0.12)
    // Chatyy purple palette (replaces old pink)
    private static let pink = UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1)   // #7C3AED purple
    private static let pinkDark = UIColor(red: 0.30, green: 0.11, blue: 0.58, alpha: 1) // #4C1D95 darker purple

    override init(frame: CGRect) {
        super.init(frame: frame)
        setupUI()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    private func setupUI() {
        contentView.addSubview(bubble)
        bubble.translatesAutoresizingMaskIntoConstraints = false
        bubble.layer.cornerRadius = 14
        bubble.clipsToBounds = true   // so the pink header doesn't bleed past corners
        bubble.layer.shadowColor = UIColor.black.cgColor
        bubble.layer.shadowOpacity = 0 // WhatsApp: no bubble shadow
        bubble.layer.shadowRadius = 2
        bubble.layer.shadowOffset = CGSize(width: 0, height: 1)
        bubbleLeading = bubble.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 10)
        bubbleTrailing = bubble.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -10)
        NSLayoutConstraint.activate([
            bubbleLeading,
            bubble.widthAnchor.constraint(lessThanOrEqualTo: contentView.widthAnchor, multiplier: 0.75),
            bubble.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 2),
            bubble.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -2),
        ])

        // ── HEADER: teal banner with badge + title (WhatsApp style) ──
        bubble.addSubview(header)
        header.translatesAutoresizingMaskIntoConstraints = false
        header.backgroundColor = Self.pink
        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: bubble.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: bubble.trailingAnchor),
            header.topAnchor.constraint(equalTo: bubble.topAnchor),
        ])

        // Add a gradient sublayer for the pink header (135° fade)
        let gradient = CAGradientLayer()
        gradient.colors = [Self.pink.cgColor, Self.pinkDark.cgColor]
        gradient.startPoint = CGPoint(x: 0, y: 0)
        gradient.endPoint = CGPoint(x: 1, y: 1)
        gradient.frame = CGRect(x: 0, y: 0, width: 1000, height: 200)
        header.layer.insertSublayer(gradient, at: 0)

        header.addSubview(badge)
        badge.translatesAutoresizingMaskIntoConstraints = false
        badge.font = .systemFont(ofSize: 10, weight: .heavy)
        badge.textColor = UIColor.white.withAlphaComponent(0.9)
        badge.text = "📅 EVENTO"
        NSLayoutConstraint.activate([
            badge.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 12),
            badge.topAnchor.constraint(equalTo: header.topAnchor, constant: 8),
        ])

        bubble.addSubview(titleLabel)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.font = .systemFont(ofSize: 15, weight: .heavy)
        titleLabel.textColor = .white
        titleLabel.numberOfLines = 2
        NSLayoutConstraint.activate([
            titleLabel.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 12),
            titleLabel.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -12),
            titleLabel.topAnchor.constraint(equalTo: badge.bottomAnchor, constant: 2),
            titleLabel.bottomAnchor.constraint(equalTo: header.bottomAnchor, constant: -8),
        ])

        // The legacy calCircle/calIcon are no longer needed — keep refs but
        // hide them to avoid breaking ABI.
        calIcon.isHidden = true

        // Date row
        bubble.addSubview(dateIcon)
        dateIcon.translatesAutoresizingMaskIntoConstraints = false
        dateIcon.image = UIImage(systemName: "clock.fill")
        dateIcon.tintColor = Self.pink
        dateIcon.contentMode = .scaleAspectFit
        NSLayoutConstraint.activate([
            dateIcon.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 12),
            dateIcon.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 8),
            dateIcon.widthAnchor.constraint(equalToConstant: 14),
            dateIcon.heightAnchor.constraint(equalToConstant: 14),
        ])
        bubble.addSubview(dateLabel)
        dateLabel.translatesAutoresizingMaskIntoConstraints = false
        dateLabel.font = .systemFont(ofSize: 13)
        dateLabel.textColor = dmTS
        dateLabel.numberOfLines = 1
        NSLayoutConstraint.activate([
            dateLabel.leadingAnchor.constraint(equalTo: dateIcon.trailingAnchor, constant: 8),
            dateLabel.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -12),
            dateLabel.centerYAnchor.constraint(equalTo: dateIcon.centerYAnchor),
        ])

        // Location row
        bubble.addSubview(locIcon)
        locIcon.translatesAutoresizingMaskIntoConstraints = false
        locIcon.image = UIImage(systemName: "mappin.and.ellipse")
        locIcon.tintColor = Self.pink
        locIcon.contentMode = .scaleAspectFit
        NSLayoutConstraint.activate([
            locIcon.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 12),
            locIcon.topAnchor.constraint(equalTo: dateIcon.bottomAnchor, constant: 6),
            locIcon.widthAnchor.constraint(equalToConstant: 14),
            locIcon.heightAnchor.constraint(equalToConstant: 14),
        ])
        bubble.addSubview(locationLabel)
        locationLabel.translatesAutoresizingMaskIntoConstraints = false
        locationLabel.font = .systemFont(ofSize: 13)
        locationLabel.textColor = dmTS
        locationLabel.numberOfLines = 1
        NSLayoutConstraint.activate([
            locationLabel.leadingAnchor.constraint(equalTo: locIcon.trailingAnchor, constant: 8),
            locationLabel.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -12),
            locationLabel.centerYAnchor.constraint(equalTo: locIcon.centerYAnchor),
        ])

        // Divider
        let divider = UIView()
        bubble.addSubview(divider)
        divider.translatesAutoresizingMaskIntoConstraints = false
        divider.backgroundColor = dmDiv
        NSLayoutConstraint.activate([
            divider.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 12),
            divider.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -12),
            divider.topAnchor.constraint(equalTo: locIcon.bottomAnchor, constant: 8),
            divider.heightAnchor.constraint(equalToConstant: 0.5),
        ])

        // RSVP buttons
        let btnStack = UIStackView(arrangedSubviews: [goingBtn, maybeBtn, notGoingBtn])
        bubble.addSubview(btnStack)
        btnStack.translatesAutoresizingMaskIntoConstraints = false
        btnStack.axis = .horizontal
        btnStack.spacing = 8
        btnStack.distribution = .fillEqually
        NSLayoutConstraint.activate([
            btnStack.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 12),
            btnStack.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -12),
            btnStack.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 8),
            btnStack.heightAnchor.constraint(equalToConstant: 34),
        ])

        for btn in [goingBtn, maybeBtn, notGoingBtn] {
            btn.layer.cornerRadius = 19
            btn.layer.borderWidth = 1.5
            btn.layer.borderColor = dmMBB.cgColor
            btn.titleLabel?.font = .systemFont(ofSize: 13, weight: .semibold)
            btn.setTitleColor(dmIT, for: .normal)
            btn.backgroundColor = .clear
        }
        goingBtn.setTitle("Vou", for: .normal)
        maybeBtn.setTitle("Talvez", for: .normal)
        notGoingBtn.setTitle("Não vou", for: .normal)

        goingBtn.addTarget(self, action: #selector(didTapGoing), for: .touchUpInside)
        maybeBtn.addTarget(self, action: #selector(didTapMaybe), for: .touchUpInside)
        notGoingBtn.addTarget(self, action: #selector(didTapNotGoing), for: .touchUpInside)

        // Counts under each RSVP button — WhatsApp Communities style
        let countStack = UIStackView(arrangedSubviews: [goingCount, maybeCount, notGoingCount])
        bubble.addSubview(countStack)
        countStack.translatesAutoresizingMaskIntoConstraints = false
        countStack.axis = .horizontal
        countStack.distribution = .fillEqually
        for c in [goingCount, maybeCount, notGoingCount] {
            c.font = .systemFont(ofSize: 10, weight: .medium)
            c.textColor = dmTS
            c.textAlignment = .center
            c.text = ""
        }
        NSLayoutConstraint.activate([
            countStack.leadingAnchor.constraint(equalTo: btnStack.leadingAnchor),
            countStack.trailingAnchor.constraint(equalTo: btnStack.trailingAnchor),
            countStack.topAnchor.constraint(equalTo: btnStack.bottomAnchor, constant: 4),
            countStack.heightAnchor.constraint(equalToConstant: 14),
        ])

        // Time
        bubble.addSubview(timeLabel)
        timeLabel.translatesAutoresizingMaskIntoConstraints = false
        timeLabel.font = .systemFont(ofSize: 11)
        timeLabel.textColor = dmTS
        NSLayoutConstraint.activate([
            timeLabel.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -12),
            timeLabel.topAnchor.constraint(equalTo: countStack.bottomAnchor, constant: 6),
            timeLabel.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -8),
        ])
    }

    func configure(message: [String: Any], isOwn: Bool, view: NativeChatCollectionView) {
        // Align bubble: own → right, other → left
        if isOwn {
            bubbleLeading.isActive = false
            bubbleTrailing.isActive = true
        } else {
            bubbleTrailing.isActive = false
            bubbleLeading.isActive = true
        }
        // Always white background — the teal header gives the cell its color
        bubble.backgroundColor = dmCB

        if let meetup = message["meetup"] as? [String: Any] {
            let title = (meetup["title"] as? String) ?? "Encontro"
            let datetime = (meetup["datetime"] as? String) ?? ""
            let location = (meetup["location"] as? String) ?? ""
            let myRsvp = (meetup["my_rsvp"] as? String)

            titleLabel.text = title
            dateLabel.text = Self.prettyDate(datetime)
            locationLabel.text = location.isEmpty ? "—" : location
            currentRsvp = myRsvp

            // Populate count labels under each button
            let going = (meetup["going_count"] as? Int) ?? ((meetup["going_count"] as? NSNumber)?.intValue ?? 0)
            let maybe = (meetup["maybe_count"] as? Int) ?? ((meetup["maybe_count"] as? NSNumber)?.intValue ?? 0)
            let no    = (meetup["not_going_count"] as? Int) ?? ((meetup["not_going_count"] as? NSNumber)?.intValue ?? 0)
            goingCount.text   = going > 0 ? "\(going) confirmado\(going == 1 ? "" : "s")" : ""
            maybeCount.text   = maybe > 0 ? "\(maybe) talvez" : ""
            notGoingCount.text = no    > 0 ? "\(no) recusado\(no == 1 ? "" : "s")"   : ""

            updateButtonStates()
        }
        if let created = message["created_at"] as? String {
            timeLabel.text = Self.formatTime(created)
        } else { timeLabel.text = "" }
    }

    private func updateButtonStates() {
        // Color-coded RSVP buttons (WhatsApp Communities style)
        // - Vou:       green
        // - Talvez:    amber
        // - Não vou:   red
        let inactiveBorder = dmMBB.cgColor
        let inactiveText = dmIT
        let goingColor = UIColor(red: 0.13, green: 0.69, blue: 0.30, alpha: 1)
        let maybeColor = UIColor(red: 0.95, green: 0.62, blue: 0.07, alpha: 1)
        let notColor   = UIColor(red: 0.86, green: 0.21, blue: 0.21, alpha: 1)

        let allBtns: [(UIButton, UIColor)] = [
            (goingBtn, goingColor),
            (maybeBtn, maybeColor),
            (notGoingBtn, notColor),
        ]
        for (btn, _) in allBtns {
            btn.layer.borderColor = inactiveBorder
            btn.setTitleColor(inactiveText, for: .normal)
            btn.backgroundColor = .clear
        }
        let activePair: (UIButton, UIColor)? = {
            switch currentRsvp {
            case "going":     return (goingBtn, goingColor)
            case "maybe":     return (maybeBtn, maybeColor)
            case "not_going": return (notGoingBtn, notColor)
            default: return nil
            }
        }()
        if let (b, color) = activePair {
            b.layer.borderColor = color.cgColor
            b.setTitleColor(.white, for: .normal)
            b.backgroundColor = color
        }
    }

    @objc private func didTapGoing() {
        currentRsvp = currentRsvp == "going" ? nil : "going"
        updateButtonStates()
        onRsvp?(currentRsvp ?? "none")
    }
    @objc private func didTapMaybe() {
        currentRsvp = currentRsvp == "maybe" ? nil : "maybe"
        updateButtonStates()
        onRsvp?(currentRsvp ?? "none")
    }
    @objc private func didTapNotGoing() {
        currentRsvp = currentRsvp == "not_going" ? nil : "not_going"
        updateButtonStates()
        onRsvp?(currentRsvp ?? "none")
    }

    private static func prettyDate(_ s: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var d = f.date(from: s)
        if d == nil { f.formatOptions = [.withInternetDateTime]; d = f.date(from: s) }
        if d == nil {
            let alt = DateFormatter()
            alt.dateFormat = "yyyy-MM-dd HH:mm:ss"
            d = alt.date(from: s)
        }
        guard let date = d else { return s }
        let df = DateFormatter()
        df.locale = Locale(identifier: "pt_BR")
        df.dateFormat = "EEE, d 'de' MMM 'às' HH:mm"
        return df.string(from: date).capitalized
    }

    private static func formatTime(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var d = f.date(from: iso)
        if d == nil { f.formatOptions = [.withInternetDateTime]; d = f.date(from: iso) }
        guard let date = d else { return "" }
        let df = DateFormatter()
        df.dateFormat = "HH:mm"
        return df.string(from: date)
    }
}

/// ContactCell — WhatsApp-style contact card
final class ContactCell: UICollectionViewCell {
    private let bubble = UIView()
    private let avatarCircle = UIView()
    private let initialsLabel = UILabel()
    private let nameLabel = UILabel()
    private let phoneLabel = UILabel()
    private let badge = UILabel()
    private let divider = UIView()
    private let actionLabel = UILabel()
    private var bubbleLeading: NSLayoutConstraint!
    private var bubbleTrailing: NSLayoutConstraint!

    private static let accent = UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1)

    override init(frame: CGRect) {
        super.init(frame: frame)
        setupUI()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    private func setupUI() {
        contentView.addSubview(bubble)
        bubble.translatesAutoresizingMaskIntoConstraints = false
        bubble.layer.cornerRadius = 14
        bubble.layer.shadowColor = UIColor.black.cgColor
        bubble.layer.shadowOpacity = 0 // WhatsApp: no bubble shadow
        bubble.layer.shadowRadius = 2
        bubble.layer.shadowOffset = CGSize(width: 0, height: 1)
        bubbleLeading = bubble.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 10)
        bubbleTrailing = bubble.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -10)
        NSLayoutConstraint.activate([
            bubbleLeading,
            bubble.widthAnchor.constraint(lessThanOrEqualTo: contentView.widthAnchor, multiplier: 0.75),
            bubble.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 4),
            bubble.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -4),
        ])

        bubble.addSubview(avatarCircle)
        avatarCircle.translatesAutoresizingMaskIntoConstraints = false
        avatarCircle.backgroundColor = Self.accent
        avatarCircle.layer.cornerRadius = 26
        NSLayoutConstraint.activate([
            avatarCircle.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 12),
            avatarCircle.topAnchor.constraint(equalTo: bubble.topAnchor, constant: 14),
            avatarCircle.widthAnchor.constraint(equalToConstant: 52),
            avatarCircle.heightAnchor.constraint(equalToConstant: 52),
        ])
        avatarCircle.addSubview(initialsLabel)
        initialsLabel.translatesAutoresizingMaskIntoConstraints = false
        initialsLabel.textColor = .white
        initialsLabel.font = .systemFont(ofSize: 20, weight: .semibold)
        initialsLabel.textAlignment = .center
        NSLayoutConstraint.activate([
            initialsLabel.centerXAnchor.constraint(equalTo: avatarCircle.centerXAnchor),
            initialsLabel.centerYAnchor.constraint(equalTo: avatarCircle.centerYAnchor),
        ])

        bubble.addSubview(badge)
        badge.translatesAutoresizingMaskIntoConstraints = false
        badge.font = .systemFont(ofSize: 10, weight: .bold)
        badge.textColor = dmTS
        badge.text = "CONTATO"
        NSLayoutConstraint.activate([
            badge.leadingAnchor.constraint(equalTo: avatarCircle.trailingAnchor, constant: 12),
            badge.topAnchor.constraint(equalTo: avatarCircle.topAnchor, constant: 2),
        ])

        bubble.addSubview(nameLabel)
        nameLabel.translatesAutoresizingMaskIntoConstraints = false
        nameLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        nameLabel.textColor = dmTP
        nameLabel.numberOfLines = 1
        NSLayoutConstraint.activate([
            nameLabel.leadingAnchor.constraint(equalTo: avatarCircle.trailingAnchor, constant: 12),
            nameLabel.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -12),
            nameLabel.topAnchor.constraint(equalTo: badge.bottomAnchor, constant: 0),
        ])

        bubble.addSubview(phoneLabel)
        phoneLabel.translatesAutoresizingMaskIntoConstraints = false
        phoneLabel.font = .systemFont(ofSize: 13)
        phoneLabel.textColor = dmTS
        phoneLabel.numberOfLines = 1
        NSLayoutConstraint.activate([
            phoneLabel.leadingAnchor.constraint(equalTo: avatarCircle.trailingAnchor, constant: 12),
            phoneLabel.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -12),
            phoneLabel.topAnchor.constraint(equalTo: nameLabel.bottomAnchor, constant: 2),
        ])

        bubble.addSubview(divider)
        divider.translatesAutoresizingMaskIntoConstraints = false
        divider.backgroundColor = dmDiv
        NSLayoutConstraint.activate([
            divider.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 12),
            divider.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -12),
            divider.topAnchor.constraint(equalTo: avatarCircle.bottomAnchor, constant: 12),
            divider.heightAnchor.constraint(equalToConstant: 0.5),
        ])

        // Two-action footer: Mensagem | Salvar (WhatsApp style)
        let leftAction = UILabel()
        let rightAction = UILabel()
        let actionDivider = UIView()
        bubble.addSubview(leftAction)
        bubble.addSubview(rightAction)
        bubble.addSubview(actionDivider)
        leftAction.translatesAutoresizingMaskIntoConstraints = false
        rightAction.translatesAutoresizingMaskIntoConstraints = false
        actionDivider.translatesAutoresizingMaskIntoConstraints = false
        leftAction.font = .systemFont(ofSize: 14, weight: .semibold)
        rightAction.font = .systemFont(ofSize: 14, weight: .semibold)
        leftAction.textColor = Self.accent
        rightAction.textColor = Self.accent
        leftAction.textAlignment = .center
        rightAction.textAlignment = .center
        leftAction.text = "Mensagem"
        rightAction.text = "Salvar"
        actionDivider.backgroundColor = dmDiv
        NSLayoutConstraint.activate([
            leftAction.leadingAnchor.constraint(equalTo: bubble.leadingAnchor),
            leftAction.trailingAnchor.constraint(equalTo: bubble.centerXAnchor),
            leftAction.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 12),
            leftAction.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -12),

            actionDivider.leadingAnchor.constraint(equalTo: bubble.centerXAnchor),
            actionDivider.widthAnchor.constraint(equalToConstant: 0.5),
            actionDivider.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 8),
            actionDivider.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -8),

            rightAction.leadingAnchor.constraint(equalTo: bubble.centerXAnchor),
            rightAction.trailingAnchor.constraint(equalTo: bubble.trailingAnchor),
            rightAction.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 12),
            rightAction.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -12),
        ])
        // Hide the legacy single-action label (kept for ABI but unused)
        actionLabel.isHidden = true
    }

    func configure(message: [String: Any], isOwn: Bool) {
        // Align bubble: own → right, other → left
        if isOwn {
            bubbleLeading.isActive = false
            bubbleTrailing.isActive = true
        } else {
            bubbleTrailing.isActive = false
            bubbleLeading.isActive = true
        }
        bubble.backgroundColor = dmCB
        guard let contact = message["contact"] as? [String: Any] else { return }
        let name = (contact["name"] as? String) ?? "Contato"
        let phone = (contact["phone"] as? String) ?? ""
        let email = (contact["email"] as? String) ?? ""

        nameLabel.text = name
        // Prefer phone, format if it looks like BR phone, fall back to email
        if !phone.isEmpty {
            phoneLabel.text = Self.formatPhone(phone)
        } else {
            phoneLabel.text = email
        }

        let parts = name.split(separator: " ").prefix(2).map { String($0.first ?? "?") }
        initialsLabel.text = parts.joined().uppercased()
        // Color avatar based on hash of name (consistent per contact)
        avatarCircle.backgroundColor = Self.avatarColor(for: name)
    }

    /// Format phone like "+55 11 99999-9999" if it's a BR number, otherwise raw.
    private static func formatPhone(_ raw: String) -> String {
        let digits = raw.filter { $0.isNumber }
        if digits.count == 13, digits.hasPrefix("55") {
            // +55 DD 9XXXX-XXXX
            let dd = digits.dropFirst(2).prefix(2)
            let rest = digits.dropFirst(4)
            let first = rest.prefix(5)
            let last = rest.dropFirst(5)
            return "+55 \(dd) \(first)-\(last)"
        }
        if digits.count == 11 {
            let dd = digits.prefix(2)
            let rest = digits.dropFirst(2)
            return "(\(dd)) \(rest.prefix(5))-\(rest.dropFirst(5))"
        }
        return raw
    }

    /// Deterministic color from name hash — like WhatsApp avatar colors.
    private static func avatarColor(for name: String) -> UIColor {
        let palette: [UIColor] = [
            UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1), // cosmic purple
            UIColor(red: 0.18, green: 0.50, blue: 0.93, alpha: 1), // blue
            UIColor(red: 0.93, green: 0.30, blue: 0.45, alpha: 1), // pink
            UIColor(red: 0.95, green: 0.55, blue: 0.15, alpha: 1), // orange
            UIColor(red: 0.55, green: 0.30, blue: 0.85, alpha: 1), // purple
            UIColor(red: 0.20, green: 0.70, blue: 0.30, alpha: 1), // green
            UIColor(red: 0.85, green: 0.20, blue: 0.20, alpha: 1), // red
            UIColor(red: 0.30, green: 0.55, blue: 0.65, alpha: 1), // steel
        ]
        var hash: UInt32 = 5381
        for u in name.unicodeScalars { hash = (hash &* 33) &+ u.value }
        return palette[Int(hash % UInt32(palette.count))]
    }
}

/// PlaylistCell — Spotify-style playlist card
final class PlaylistCell: UICollectionViewCell {
    private let bubble = UIView()
    private let coverArt = UIImageView()         // real album art (downloaded)
    private let coverGradient = CAGradientLayer() // fallback gradient
    private let coverIcon = UIImageView()
    private let badge = UILabel()
    private let titleLabel = UILabel()
    private let countLabel = UILabel()
    private let songsStack = UIStackView()
    private let timeLabel = UILabel()
    private var currentCoverUrl: String = ""
    private var bubbleLeading: NSLayoutConstraint!
    private var bubbleTrailing: NSLayoutConstraint!

    private static let accent = UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1)
    private static let purple = UIColor(red: 0.45, green: 0.30, blue: 0.85, alpha: 1)
    private static let pink = UIColor(red: 0.93, green: 0.30, blue: 0.65, alpha: 1)
    static let coverCache: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.totalCostLimit = 50 * 1024 * 1024  // 50MB bound — prevents OOM after ~50 playlists
        c.countLimit = 100
        return c
    }()

    override init(frame: CGRect) {
        super.init(frame: frame)
        setupUI()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    private func setupUI() {
        contentView.addSubview(bubble)
        bubble.translatesAutoresizingMaskIntoConstraints = false
        bubble.layer.cornerRadius = 14
        bubble.layer.shadowColor = UIColor.black.cgColor
        bubble.layer.shadowOpacity = 0 // WhatsApp: no bubble shadow
        bubble.layer.shadowRadius = 2
        bubble.layer.shadowOffset = CGSize(width: 0, height: 1)
        bubbleLeading = bubble.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 10)
        bubbleTrailing = bubble.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -10)
        NSLayoutConstraint.activate([
            bubbleLeading,
            bubble.widthAnchor.constraint(lessThanOrEqualTo: contentView.widthAnchor, multiplier: 0.75),
            bubble.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 4),
            bubble.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -4),
        ])

        // Cover art — UIImageView for real album art with gradient fallback
        bubble.addSubview(coverArt)
        coverArt.translatesAutoresizingMaskIntoConstraints = false
        coverArt.contentMode = .scaleAspectFill
        coverArt.layer.cornerRadius = 10
        coverArt.layer.masksToBounds = true
        coverArt.backgroundColor = Self.purple
        // Gradient layer (purple → pink) as visual fallback
        coverGradient.colors = [Self.purple.cgColor, Self.pink.cgColor]
        coverGradient.startPoint = CGPoint(x: 0, y: 0)
        coverGradient.endPoint = CGPoint(x: 1, y: 1)
        coverArt.layer.insertSublayer(coverGradient, at: 0)
        NSLayoutConstraint.activate([
            coverArt.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 10),
            coverArt.topAnchor.constraint(equalTo: bubble.topAnchor, constant: 10),
            coverArt.widthAnchor.constraint(equalToConstant: 52),
            coverArt.heightAnchor.constraint(equalToConstant: 52),
        ])
        coverArt.addSubview(coverIcon)
        coverIcon.translatesAutoresizingMaskIntoConstraints = false
        let cfg = UIImage.SymbolConfiguration(pointSize: 28, weight: .semibold)
        coverIcon.image = UIImage(systemName: "music.note", withConfiguration: cfg)
        coverIcon.tintColor = .white
        coverIcon.contentMode = .scaleAspectFit
        // Subtle drop shadow on the icon
        coverIcon.layer.shadowColor = UIColor.black.cgColor
        coverIcon.layer.shadowOpacity = 0.3
        coverIcon.layer.shadowRadius = 2
        coverIcon.layer.shadowOffset = CGSize(width: 0, height: 1)
        NSLayoutConstraint.activate([
            coverIcon.centerXAnchor.constraint(equalTo: coverArt.centerXAnchor),
            coverIcon.centerYAnchor.constraint(equalTo: coverArt.centerYAnchor),
        ])

        bubble.addSubview(badge)
        badge.translatesAutoresizingMaskIntoConstraints = false
        badge.font = .systemFont(ofSize: 10, weight: .bold)
        badge.textColor = Self.accent
        badge.text = "PLAYLIST"
        NSLayoutConstraint.activate([
            badge.leadingAnchor.constraint(equalTo: coverArt.trailingAnchor, constant: 12),
            badge.topAnchor.constraint(equalTo: coverArt.topAnchor, constant: 2),
        ])

        bubble.addSubview(titleLabel)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        titleLabel.textColor = dmTP
        titleLabel.numberOfLines = 1
        NSLayoutConstraint.activate([
            titleLabel.leadingAnchor.constraint(equalTo: coverArt.trailingAnchor, constant: 12),
            titleLabel.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -12),
            titleLabel.topAnchor.constraint(equalTo: badge.bottomAnchor, constant: 0),
        ])

        bubble.addSubview(countLabel)
        countLabel.translatesAutoresizingMaskIntoConstraints = false
        countLabel.font = .systemFont(ofSize: 13)
        countLabel.textColor = dmTS
        NSLayoutConstraint.activate([
            countLabel.leadingAnchor.constraint(equalTo: coverArt.trailingAnchor, constant: 12),
            countLabel.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -12),
            countLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 2),
        ])

        bubble.addSubview(songsStack)
        songsStack.translatesAutoresizingMaskIntoConstraints = false
        songsStack.axis = .vertical
        songsStack.spacing = 6
        NSLayoutConstraint.activate([
            songsStack.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 12),
            songsStack.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -12),
            songsStack.topAnchor.constraint(equalTo: coverArt.bottomAnchor, constant: 12),
        ])

        bubble.addSubview(timeLabel)
        timeLabel.translatesAutoresizingMaskIntoConstraints = false
        timeLabel.font = .systemFont(ofSize: 11)
        timeLabel.textColor = dmTS
        NSLayoutConstraint.activate([
            timeLabel.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -12),
            timeLabel.topAnchor.constraint(equalTo: songsStack.bottomAnchor, constant: 8),
            timeLabel.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -10),
        ])
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        coverGradient.frame = coverArt.bounds
    }

    func configure(message: [String: Any], isOwn: Bool) {
        // Align bubble: own → right, other → left
        if isOwn {
            bubbleLeading.isActive = false
            bubbleTrailing.isActive = true
        } else {
            bubbleTrailing.isActive = false
            bubbleLeading.isActive = true
        }
        bubble.backgroundColor = isOwn ? dmOCB : dmCB
        songsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        guard let playlist = message["playlist"] as? [String: Any] else { return }
        let title = (playlist["title"] as? String)
            ?? (playlist["playlist_name"] as? String)
            ?? (playlist["name"] as? String)
            ?? "Playlist"
        titleLabel.text = title

        // Songs: support [String], [[String:Any]] (with title/artist/cover) and tracks variant
        var songs: [(title: String, artist: String, cover: String)] = []
        if let arr = playlist["songs"] as? [String] {
            songs = arr.map { (title: $0, artist: "", cover: "") }
        } else if let arr = playlist["songs"] as? [[String: Any]] {
            songs = arr.map {
                let t = ($0["title"] as? String) ?? ($0["name"] as? String) ?? ""
                let a = ($0["artist"] as? String) ?? ""
                let c = ($0["cover"] as? String) ?? ($0["coverUrl"] as? String) ?? ($0["album_art"] as? String) ?? ""
                return (title: t, artist: a, cover: c)
            }
        } else if let arr = playlist["tracks"] as? [[String: Any]] {
            songs = arr.map {
                let t = ($0["title"] as? String) ?? ($0["name"] as? String) ?? ""
                let a = ($0["artist"] as? String) ?? ""
                let c = ($0["cover"] as? String) ?? ($0["coverUrl"] as? String) ?? ""
                return (title: t, artist: a, cover: c)
            }
        }

        countLabel.text = songs.count == 1 ? "1 música" : "\(songs.count) músicas"

        // Cover art: download first song's album art if available
        coverArt.image = nil
        let firstCover = songs.first?.cover ?? ""
        currentCoverUrl = firstCover
        if !firstCover.isEmpty, let url = URL(string: firstCover) {
            coverIcon.isHidden = false // show icon while loading
            if let cached = Self.coverCache.object(forKey: firstCover as NSString) {
                coverArt.image = cached
                coverIcon.isHidden = true
            } else {
                URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
                    guard let data = data, let img = UIImage(data: data) else { return }
                    Self.coverCache.setObject(img, forKey: firstCover as NSString)
                    DispatchQueue.main.async {
                        guard self?.currentCoverUrl == firstCover else { return }
                        self?.coverArt.image = img
                        self?.coverIcon.isHidden = true
                    }
                }.resume()
            }
        } else {
            coverIcon.isHidden = false
        }

        // ── Render songs as Spotify-style numbered list (PL1 mockup) ──
        // Each row: [N]  Title  •  Artist
        // Border-top thin between rows.
        let visible = Array(songs.prefix(3))
        for (idx, song) in visible.enumerated() {
            let row = UIView()
            row.translatesAutoresizingMaskIntoConstraints = false

            // Top border (skip for first row)
            if idx > 0 {
                let border = UIView()
                border.backgroundColor = dmDiv
                border.translatesAutoresizingMaskIntoConstraints = false
                row.addSubview(border)
                NSLayoutConstraint.activate([
                    border.leadingAnchor.constraint(equalTo: row.leadingAnchor),
                    border.trailingAnchor.constraint(equalTo: row.trailingAnchor),
                    border.topAnchor.constraint(equalTo: row.topAnchor),
                    border.heightAnchor.constraint(equalToConstant: 0.5),
                ])
            }

            let numLabel = UILabel()
            numLabel.text = "\(idx + 1)"
            numLabel.font = .systemFont(ofSize: 12, weight: .semibold)
            numLabel.textColor = dmTS
            numLabel.textAlignment = .center
            numLabel.translatesAutoresizingMaskIntoConstraints = false
            row.addSubview(numLabel)
            NSLayoutConstraint.activate([
                numLabel.leadingAnchor.constraint(equalTo: row.leadingAnchor),
                numLabel.centerYAnchor.constraint(equalTo: row.centerYAnchor),
                numLabel.widthAnchor.constraint(equalToConstant: 16),
            ])

            let titleL = UILabel()
            titleL.text = song.title.isEmpty ? "(sem título)" : song.title
            titleL.font = .systemFont(ofSize: 13)
            titleL.textColor = dmTP
            titleL.numberOfLines = 1
            titleL.lineBreakMode = .byTruncatingTail
            titleL.translatesAutoresizingMaskIntoConstraints = false
            row.addSubview(titleL)

            let artistL = UILabel()
            artistL.text = song.artist
            artistL.font = .systemFont(ofSize: 11)
            artistL.textColor = dmTS
            artistL.numberOfLines = 1
            artistL.textAlignment = .right
            artistL.translatesAutoresizingMaskIntoConstraints = false
            artistL.setContentHuggingPriority(.required, for: .horizontal)
            artistL.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            row.addSubview(artistL)

            NSLayoutConstraint.activate([
                titleL.leadingAnchor.constraint(equalTo: numLabel.trailingAnchor, constant: 10),
                titleL.centerYAnchor.constraint(equalTo: row.centerYAnchor),
                artistL.leadingAnchor.constraint(greaterThanOrEqualTo: titleL.trailingAnchor, constant: 8),
                artistL.trailingAnchor.constraint(equalTo: row.trailingAnchor),
                artistL.centerYAnchor.constraint(equalTo: row.centerYAnchor),
                row.heightAnchor.constraint(equalToConstant: 32),
            ])
            songsStack.addArrangedSubview(row)
        }

        // Show "+ N mais" if there are more songs
        if songs.count > 3 {
            let more = UILabel()
            more.font = .systemFont(ofSize: 12, weight: .semibold)
            more.textColor = Self.accent
            more.text = "+ \(songs.count - 3) mais"
            more.textAlignment = .center
            songsStack.addArrangedSubview(more)
        }

        // ── ADD/REMOVE button — opens the JS PlaylistEditorModal on tap.
        // The chat-conversation onMessageTap handler routes 'playlist' type
        // to the editor (see chat-conversation.js).
        let addBtn = UILabel()
        addBtn.text = songs.isEmpty ? "+ ADICIONAR MÚSICAS" : "+ ADICIONAR / REMOVER"
        addBtn.font = .systemFont(ofSize: 11, weight: .heavy)
        addBtn.textColor = Self.accent
        addBtn.textAlignment = .center
        let addRow = UIView()
        addRow.translatesAutoresizingMaskIntoConstraints = false
        addRow.addSubview(addBtn)
        addBtn.translatesAutoresizingMaskIntoConstraints = false
        let topBorder = UIView()
        topBorder.backgroundColor = dmDiv
        topBorder.translatesAutoresizingMaskIntoConstraints = false
        addRow.addSubview(topBorder)
        NSLayoutConstraint.activate([
            topBorder.leadingAnchor.constraint(equalTo: addRow.leadingAnchor),
            topBorder.trailingAnchor.constraint(equalTo: addRow.trailingAnchor),
            topBorder.topAnchor.constraint(equalTo: addRow.topAnchor, constant: 4),
            topBorder.heightAnchor.constraint(equalToConstant: 0.5),
            addBtn.leadingAnchor.constraint(equalTo: addRow.leadingAnchor),
            addBtn.trailingAnchor.constraint(equalTo: addRow.trailingAnchor),
            addBtn.topAnchor.constraint(equalTo: topBorder.bottomAnchor, constant: 8),
            addBtn.bottomAnchor.constraint(equalTo: addRow.bottomAnchor, constant: -2),
            addRow.heightAnchor.constraint(equalToConstant: 28),
        ])
        songsStack.addArrangedSubview(addRow)

        if let created = message["created_at"] as? String {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            var d = f.date(from: created)
            if d == nil { f.formatOptions = [.withInternetDateTime]; d = f.date(from: created) }
            if let date = d {
                let df = DateFormatter()
                df.dateFormat = "HH:mm"
                timeLabel.text = df.string(from: date)
            } else { timeLabel.text = "" }
        }
    }
}

/// CallCardCell — WhatsApp call card (icon + title + duration + time)
/// CallCardCell — iMessage style (Variação 5)
/// Layout:
///   ┌──────────────────────────────────────┐
///   │  ⬤  Chamada de voz                   │   header: icon 32 + title
///   │  📞                                  │
///   │ ──────────────────────────────────── │   divider 0.5pt
///   │  14:34 · 2 min 14 s         LIGAR    │   footer: info + accent CTA
///   └──────────────────────────────────────┘
final class CallCardCell: UICollectionViewCell {
    private let bubble = UIView()
    private let iconCircle = UIView()
    private let iconView = UIImageView()
    private let titleLabel = UILabel()
    private let divider = UIView()
    private let infoLabel = UILabel()
    private let actionLabel = UILabel()

    private static let green = UIColor(red: 0.00, green: 0.66, blue: 0.52, alpha: 1)
    private static let red   = UIColor(red: 0.95, green: 0.36, blue: 0.43, alpha: 1)
    private static let textPrimary   = dmTP
    private static let textSecondary = dmTS

    private var bubbleLeadingOwn: NSLayoutConstraint!
    private var bubbleLeadingOther: NSLayoutConstraint!

    override init(frame: CGRect) {
        super.init(frame: frame)
        setupUI()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    private func setupUI() {
        // ── Bubble container ──
        contentView.addSubview(bubble)
        bubble.translatesAutoresizingMaskIntoConstraints = false
        bubble.layer.cornerRadius = 18
        bubble.layer.shadowColor = UIColor.black.cgColor
        bubble.layer.shadowOpacity = 0 // WhatsApp: no bubble shadow
        bubble.layer.shadowRadius = 2
        bubble.layer.shadowOffset = CGSize(width: 0, height: 1)

        bubbleLeadingOwn = bubble.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -10)
        bubbleLeadingOther = bubble.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 10)

        NSLayoutConstraint.activate([
            bubble.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 4),
            bubble.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -4),
            bubble.widthAnchor.constraint(greaterThanOrEqualToConstant: 220),
            bubble.widthAnchor.constraint(lessThanOrEqualToConstant: 280),
        ])

        // ── HEADER: Icon (32×32) + Title ──
        bubble.addSubview(iconCircle)
        iconCircle.translatesAutoresizingMaskIntoConstraints = false
        iconCircle.layer.cornerRadius = 16
        NSLayoutConstraint.activate([
            iconCircle.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 16),
            iconCircle.topAnchor.constraint(equalTo: bubble.topAnchor, constant: 14),
            iconCircle.widthAnchor.constraint(equalToConstant: 32),
            iconCircle.heightAnchor.constraint(equalToConstant: 32),
        ])
        iconCircle.addSubview(iconView)
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.contentMode = .scaleAspectFit
        iconView.tintColor = .white
        NSLayoutConstraint.activate([
            iconView.centerXAnchor.constraint(equalTo: iconCircle.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconCircle.centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 16),
            iconView.heightAnchor.constraint(equalToConstant: 16),
        ])

        bubble.addSubview(titleLabel)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        titleLabel.textColor = Self.textPrimary
        titleLabel.numberOfLines = 1
        titleLabel.lineBreakMode = .byTruncatingTail
        NSLayoutConstraint.activate([
            titleLabel.leadingAnchor.constraint(equalTo: iconCircle.trailingAnchor, constant: 10),
            titleLabel.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -16),
            titleLabel.centerYAnchor.constraint(equalTo: iconCircle.centerYAnchor),
        ])

        // ── DIVIDER (0.5pt subtle) ──
        bubble.addSubview(divider)
        divider.translatesAutoresizingMaskIntoConstraints = false
        divider.backgroundColor = dmDiv
        NSLayoutConstraint.activate([
            divider.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 16),
            divider.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -16),
            divider.topAnchor.constraint(equalTo: iconCircle.bottomAnchor, constant: 12),
            divider.heightAnchor.constraint(equalToConstant: 0.5),
        ])

        // ── FOOTER: info text on the left + LIGAR on the right ──
        bubble.addSubview(infoLabel)
        infoLabel.translatesAutoresizingMaskIntoConstraints = false
        infoLabel.font = .systemFont(ofSize: 12, weight: .regular)
        infoLabel.textColor = Self.textSecondary
        infoLabel.numberOfLines = 1
        infoLabel.lineBreakMode = .byTruncatingTail

        bubble.addSubview(actionLabel)
        actionLabel.translatesAutoresizingMaskIntoConstraints = false
        actionLabel.font = .systemFont(ofSize: 12, weight: .heavy)
        actionLabel.textColor = Self.green
        actionLabel.text = "LIGAR"
        actionLabel.textAlignment = .right
        actionLabel.setContentHuggingPriority(.required, for: .horizontal)
        actionLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        NSLayoutConstraint.activate([
            infoLabel.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 16),
            infoLabel.trailingAnchor.constraint(lessThanOrEqualTo: actionLabel.leadingAnchor, constant: -8),
            infoLabel.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 10),
            infoLabel.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -14),

            actionLabel.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -16),
            actionLabel.centerYAnchor.constraint(equalTo: infoLabel.centerYAnchor),
        ])
    }

    func configure(message: [String: Any], isOwn: Bool) {
        // Bubble color: own = WhatsApp green-tinted, other = white
        bubble.backgroundColor = isOwn
            ? dmOCB
            : dmCB

        bubbleLeadingOwn.isActive = isOwn
        bubbleLeadingOther.isActive = !isOwn

        let callType = (message["call_type"] as? String) ?? "audio"
        let status = (message["call_status"] as? String) ?? "answered"
        let duration = (message["call_duration"] as? Int)
            ?? ((message["call_duration"] as? NSNumber)?.intValue) ?? 0

        let isVideo = callType == "video"
        let isMissed = status == "missed" || status == "no_answer" || status == "rejected"

        iconCircle.backgroundColor = isMissed ? Self.red : Self.green
        iconView.image = UIImage(systemName: isVideo ? "video.fill" : "phone.fill")

        if isMissed {
            titleLabel.text = isVideo ? "Chamada de vídeo perdida" : "Chamada de voz perdida"
            titleLabel.textColor = Self.red
            actionLabel.textColor = Self.red
        } else {
            titleLabel.text = isVideo ? "Chamada de vídeo" : "Chamada de voz"
            titleLabel.textColor = Self.textPrimary
            actionLabel.textColor = Self.green
        }

        // Footer info: "14:34" or "14:34 · 2 min 14 s"
        var time = ""
        if let created = message["created_at"] as? String {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            var d = f.date(from: created)
            if d == nil { f.formatOptions = [.withInternetDateTime]; d = f.date(from: created) }
            if let date = d {
                let df = DateFormatter()
                df.locale = Locale(identifier: "pt_BR")
                df.dateFormat = "HH:mm"
                time = df.string(from: date)
            }
        }
        var dur = ""
        if duration > 0 && !isMissed {
            let mins = duration / 60
            let secs = duration % 60
            dur = mins > 0 ? "\(mins) min \(secs) s" : "\(secs) s"
        }
        var parts: [String] = []
        if !time.isEmpty { parts.append(time) }
        if !dur.isEmpty { parts.append(dur) }
        infoLabel.text = parts.joined(separator: " · ")
    }
}

/// GifStickerCell — renders GIF or sticker without bubble
final class GifStickerCell: UICollectionViewCell {
    private let imageView = UIImageView()
    private var currentURL: String = ""
    static let imageCache: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.totalCostLimit = 100 * 1024 * 1024 // 100MB limit to prevent OOM
        c.countLimit = 200
        return c
    }()
    /// Cached aspect ratios (width/height) per URL — used by sizeForItemAt
    /// so the cell allocates the right vertical space for landscape vs portrait
    /// GIFs/stickers (no more empty white space above and below).
    static var aspectCache: [String: CGFloat] = [:]
    private var widthConstraint: NSLayoutConstraint?
    private var heightConstraint: NSLayoutConstraint?

    /// Maximum visible size for any GIF/sticker in the chat list.
    static let maxSize: CGFloat = 220

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.addSubview(imageView)
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.contentMode = .scaleAspectFit
        imageView.backgroundColor = .clear
        imageView.clipsToBounds = true
        // Center the image inside the cell. width/height get set in configure()
        // based on the cached aspect ratio so the cell wraps tightly.
        widthConstraint = imageView.widthAnchor.constraint(equalToConstant: Self.maxSize)
        heightConstraint = imageView.heightAnchor.constraint(equalToConstant: Self.maxSize)
        NSLayoutConstraint.activate([
            imageView.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
            imageView.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 4),
            imageView.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor, constant: -4),
            widthConstraint!,
            heightConstraint!,
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    private func applyAspect(for urlString: String) {
        let aspect = Self.aspectCache[urlString] ?? 1.0
        // Fit inside maxSize × maxSize keeping aspect ratio
        let w: CGFloat
        let h: CGFloat
        if aspect >= 1 {
            w = Self.maxSize
            h = Self.maxSize / aspect
        } else {
            h = Self.maxSize
            w = Self.maxSize * aspect
        }
        widthConstraint?.constant = w
        heightConstraint?.constant = h
    }

    // Emoji label for text-based stickers (not image URLs)
    private lazy var emojiLabel: UILabel = {
        let l = UILabel()
        l.font = .systemFont(ofSize: 72)
        l.textAlignment = .center
        l.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(l)
        NSLayoutConstraint.activate([
            l.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
            l.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
        ])
        return l
    }()

    override func prepareForReuse() {
        super.prepareForReuse()
        imageView.image = nil
        imageView.isHidden = false
        emojiLabel.isHidden = true
        emojiLabel.text = nil
        currentURL = ""
    }

    /// Returns true if the string contains only emoji (no URL, no path).
    static func isEmojiOnly(_ s: String) -> Bool {
        guard !s.isEmpty else { return false }
        for scalar in s.unicodeScalars {
            // Allow emoji, variation selectors, ZWJ, skin tone modifiers, spaces
            if scalar.properties.isEmoji && scalar.value > 0x23 { continue }
            if scalar.value == 0xFE0F || scalar.value == 0xFE0E { continue } // variation selectors
            if scalar.value == 0x200D { continue } // ZWJ
            if (0x1F3FB...0x1F3FF).contains(scalar.value) { continue } // skin tones
            if scalar == " " || scalar == "\n" { continue }
            return false
        }
        return true
    }

    func configure(message: [String: Any]) {
        let fileUrl = (message["file_url"] as? String) ?? ""
        let content = (message["content"] as? String) ?? ""
        let raw = !fileUrl.isEmpty ? fileUrl : content

        // Check if this is a pure emoji sticker (not a URL)
        let isEmojiSticker = !raw.isEmpty && !raw.hasPrefix("http") && !raw.hasPrefix("/") && Self.isEmojiOnly(raw)
        NSLog("[GifStickerCell] raw='\(raw)' isEmoji=\(isEmojiSticker) fileUrl='\(fileUrl)' content='\(content)'")
        if isEmojiSticker {
            imageView.isHidden = true
            emojiLabel.isHidden = false
            emojiLabel.text = raw
            widthConstraint?.constant = 80
            heightConstraint?.constant = 80
            return
        }
        emojiLabel.isHidden = true
        imageView.isHidden = false

        let urlString: String = {
            if raw.hasPrefix("http") { return raw }
            if raw.hasPrefix("/") { return "https://chatyy.com.br" + raw }
            return raw
        }()

        currentURL = urlString
        guard !urlString.isEmpty, let url = URL(string: urlString) else {
            imageView.image = nil
            return
        }

        // Apply cached aspect ratio if we have it (otherwise default square)
        applyAspect(for: urlString)

        // 1) Memory cache
        if let cached = Self.imageCache.object(forKey: urlString as NSString) {
            imageView.image = cached
            // Update aspect cache from the loaded image and re-apply
            if cached.size.height > 0 {
                Self.aspectCache[urlString] = cached.size.width / cached.size.height
                applyAspect(for: urlString)
            }
            return
        }
        // 2) Disk cache — STABLE hash so the cache persists across launches
        let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        let dir = cacheDir.appendingPathComponent("chat_gifs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let ext = (URL(string: urlString)?.pathExtension ?? "gif")
        let fileSafe = BubbleCell.stableHash(urlString) + (ext.isEmpty ? ".gif" : ".\(ext)")
        let diskPath = dir.appendingPathComponent(fileSafe)

        if FileManager.default.fileExists(atPath: diskPath.path) {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let data = try? Data(contentsOf: diskPath) else { return }
                let image = Self.animatedImage(from: data) ?? UIImage(data: data)
                guard let image = image else { return }
                Self.imageCache.setObject(image, forKey: urlString as NSString)
                if image.size.height > 0 {
                    Self.aspectCache[urlString] = image.size.width / image.size.height
                }
                DispatchQueue.main.async {
                    guard self?.currentURL == urlString else { return }
                    self?.imageView.image = image
                    self?.applyAspect(for: urlString)
                    // Targeted invalidation: only this cell's height
                    self?.invalidateSelfLayout()
                }
            }
            return
        }

        // 3) Network — download then write to disk + memory
        imageView.image = nil
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let data = try? Data(contentsOf: url) else { return }
            try? data.write(to: diskPath)
            let image = Self.animatedImage(from: data) ?? UIImage(data: data)
            guard let image = image else { return }
            Self.imageCache.setObject(image, forKey: urlString as NSString)
            if image.size.height > 0 {
                Self.aspectCache[urlString] = image.size.width / image.size.height
            }
            DispatchQueue.main.async {
                guard self?.currentURL == urlString else { return }
                self?.imageView.image = image
                self?.applyAspect(for: urlString)
                // Targeted invalidation: only this cell's height
                self?.invalidateSelfLayout()
            }
        }
    }

    private func findCollectionView() -> UICollectionView? {
        var v: UIView? = superview
        while v != nil {
            if let cv = v as? UICollectionView { return cv }
            v = v?.superview
        }
        return nil
    }

    /// Invalidate layout for this specific cell, clearing the cached height
    /// so sizeForItemAt recomputes with the real aspect ratio.
    private func invalidateSelfLayout() {
        guard let cv = findCollectionView(),
              let ip = cv.indexPath(for: self) else {
            // Fallback: invalidate entire layout
            findCollectionView()?.collectionViewLayout.invalidateLayout()
            return
        }
        // Clear the height cache entry in NativeChatCollectionView
        if let chatView = cv.superview as? NativeChatCollectionView {
            chatView.clearHeightCache(forIndexPath: ip)
        }
        // Targeted invalidation: only this cell
        let ctx = UICollectionViewFlowLayoutInvalidationContext()
        ctx.invalidateItems(at: [ip])
        cv.collectionViewLayout.invalidateLayout(with: ctx)
    }

    /// Decode animated GIF (or any multi-frame image) using ImageIO and
    /// build a UIImage.animatedImage that UIImageView plays automatically.
    private static func animatedImage(from data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let count = CGImageSourceGetCount(source)
        guard count > 1 else { return nil } // not animated
        var frames: [UIImage] = []
        var totalDuration: TimeInterval = 0
        for i in 0..<count {
            guard let cg = CGImageSourceCreateImageAtIndex(source, i, nil) else { continue }
            frames.append(UIImage(cgImage: cg))
            // Frame delay (gif unclamped > clamped)
            if let props = CGImageSourceCopyPropertiesAtIndex(source, i, nil) as? [String: Any],
               let gifProps = props[kCGImagePropertyGIFDictionary as String] as? [String: Any] {
                let delay = (gifProps[kCGImagePropertyGIFUnclampedDelayTime as String] as? Double)
                    ?? (gifProps[kCGImagePropertyGIFDelayTime as String] as? Double) ?? 0.1
                totalDuration += max(delay, 0.02)
            } else {
                totalDuration += 0.1
            }
        }
        guard !frames.isEmpty else { return nil }
        return UIImage.animatedImage(with: frames, duration: totalDuration)
    }
}
