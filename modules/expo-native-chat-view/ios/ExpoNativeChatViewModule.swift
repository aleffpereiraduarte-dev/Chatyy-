import ExpoModulesCore
import UIKit
import AVFoundation
import SQLite3

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

public class ExpoNativeChatViewModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativeChatView")

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
                "onScrollToBottom"  // emitted from the floating jump-to-bottom button
            )

            Prop("conversationId") { (view: NativeChatCollectionView, value: Int) in
                view.setConversationId(value)
            }
            Prop("myEmail") { (view: NativeChatCollectionView, value: String) in
                view.myEmail = value
                view.collectionView.reloadData()
            }
            Prop("ownBubbleColor") { (view: NativeChatCollectionView, value: String?) in
                view.ownBubbleColor = NativeChatCollectionView.colorFromHex(value ?? "#dcf8c6")
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

            // JS calls this to force a refresh after adding a message locally.
            AsyncFunction("reload") { (view: NativeChatCollectionView) in
                view.reloadFromCache()
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
    var ownBubbleColor: UIColor = UIColor(red: 0.86, green: 0.97, blue: 0.78, alpha: 1)
    var otherBubbleColor: UIColor = .white
    var textColor: UIColor = UIColor(red: 0.07, green: 0.11, blue: 0.13, alpha: 1)
    var metaColor: UIColor = UIColor(red: 0.40, green: 0.47, blue: 0.51, alpha: 1)

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
    private let refreshControl = UIRefreshControl()

    // ─── Scroll-to-bottom FAB ────────────────────────────────────
    private let scrollToBottomBtn = UIButton(type: .system)
    private var scrollFabHidden = true

    // ─── Selection mode ──────────────────────────────────────────
    private var selectionMode = false
    private var selectedIds = Set<Int>()

    // ─── Data ────────────────────────────────────────────────────
    private var conversationId: Int = 0
    /// Mixed array of message dicts and date-separator markers.
    /// Date markers look like: ["__separator__": "March 8, 2026"]
    private var rows: [[String: Any]] = []
    private var heightCache: [String: CGFloat] = [:] // by row.id or "sep_<title>"

    // ─── UICollectionView ────────────────────────────────────────
    let collectionView: UICollectionView
    private let layout: UICollectionViewFlowLayout

    public required init(appContext: AppContext? = nil) {
        let layout = UICollectionViewFlowLayout()
        layout.minimumLineSpacing = 4
        layout.minimumInteritemSpacing = 0
        layout.scrollDirection = .vertical
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

        // Cell types
        collectionView.register(BubbleCell.self, forCellWithReuseIdentifier: "bubble")
        collectionView.register(SeparatorCell.self, forCellWithReuseIdentifier: "separator")
        collectionView.register(SystemCell.self, forCellWithReuseIdentifier: "system")

        addSubview(collectionView)
        NSLayoutConstraint.activate([
            collectionView.topAnchor.constraint(equalTo: topAnchor),
            collectionView.leadingAnchor.constraint(equalTo: leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: trailingAnchor),
            collectionView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        // Long-press recognizer for message context menu
        let lp = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
        lp.minimumPressDuration = 0.4
        collectionView.addGestureRecognizer(lp)

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

        // ⭐ Pull-to-refresh — UIRefreshControl native, fires onRefresh
        // event for JS to fetch newer messages from the server. JS calls
        // `endRefreshing()` when done. Includes haptic feedback.
        refreshControl.addTarget(self, action: #selector(handlePullRefresh), for: .valueChanged)
        refreshControl.tintColor = UIColor(white: 1, alpha: 0.7)
        collectionView.refreshControl = refreshControl

        // ⭐ Floating "jump to bottom" button
        scrollToBottomBtn.translatesAutoresizingMaskIntoConstraints = false
        scrollToBottomBtn.backgroundColor = UIColor(white: 1, alpha: 0.95)
        scrollToBottomBtn.setImage(UIImage(systemName: "chevron.down"), for: .normal)
        scrollToBottomBtn.tintColor = UIColor(red: 0.05, green: 0.50, blue: 0.45, alpha: 1)
        scrollToBottomBtn.layer.cornerRadius = 22
        scrollToBottomBtn.layer.shadowColor = UIColor.black.cgColor
        scrollToBottomBtn.layer.shadowOpacity = 0.2
        scrollToBottomBtn.layer.shadowRadius = 6
        scrollToBottomBtn.layer.shadowOffset = CGSize(width: 0, height: 2)
        scrollToBottomBtn.addTarget(self, action: #selector(handleScrollToBottomTap), for: .touchUpInside)
        scrollToBottomBtn.alpha = 0
        scrollToBottomBtn.transform = CGAffineTransform(scaleX: 0.5, y: 0.5)
        addSubview(scrollToBottomBtn)
        NSLayoutConstraint.activate([
            scrollToBottomBtn.widthAnchor.constraint(equalToConstant: 44),
            scrollToBottomBtn.heightAnchor.constraint(equalToConstant: 44),
            scrollToBottomBtn.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            scrollToBottomBtn.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -20),
        ])
    }

    @objc private func handleScrollToBottomTap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        scrollToBottom(animated: true)
        onScrollToBottom([:])
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

    // Track which message ids we've already painted, so newly-appearing
    // messages get the slide-in animation while existing ones don't.
    private var animatedMessageIds = Set<Int>()

    func reloadFromCache() {
        let messages = querySqliteMessages(conversationId: conversationId, limit: MESSAGE_LIMIT)
        let previousIds = Set(rows.compactMap { $0["id"] as? Int })
        rows = insertDateSeparators(messages: messages)
        heightCache.removeAll()
        // Mark only NEW messages for animation
        let newIds = Set(rows.compactMap { $0["id"] as? Int }).subtracting(previousIds)
        animatedMessageIds = newIds
        collectionView.reloadData()
        DispatchQueue.main.async { [weak self] in
            self?.scrollToBottom(animated: false)
            self?.onLoaded(["count": messages.count])
        }
    }

    func scrollToBottom(animated: Bool) {
        guard !rows.isEmpty else { return }
        let last = IndexPath(item: rows.count - 1, section: 0)
        collectionView.scrollToItem(at: last, at: .bottom, animated: animated)
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

        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "bubble", for: indexPath) as! BubbleCell
        let isOwn = (row["sender_email"] as? String) == myEmail
        cell.configure(
            message: row,
            isOwn: isOwn,
            ownBubbleColor: ownBubbleColor,
            otherBubbleColor: otherBubbleColor,
            textColor: textColor,
            metaColor: metaColor,
            maxWidth: collectionView.bounds.width * 0.78
        )

        // Slide-in animation for newly-appended messages.
        // Own messages slide from the right (send swoosh), incoming from the left.
        if let id = row["id"] as? Int, animatedMessageIds.contains(id) {
            animatedMessageIds.remove(id)
            let dx: CGFloat = isOwn ? 60 : -60
            cell.alpha = 0
            cell.transform = CGAffineTransform(translationX: dx, y: 0)
            UIView.animate(withDuration: 0.30, delay: 0,
                           usingSpringWithDamping: 0.78, initialSpringVelocity: 0.6,
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
        let width = collectionView.bounds.width
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
            height = BubbleCell.estimateHeight(message: row, maxWidth: width * 0.78)
        }
        heightCache[key] = height
        return CGSize(width: width, height: height)
    }

    private func cacheKey(for row: [String: Any], index: Int) -> String {
        if let sep = row["__separator__"] as? String { return "sep_\(sep)" }
        if let id = row["id"] as? Int { return "msg_\(id)" }
        return "row_\(index)"
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

    public func scrollViewDidScroll(_ scrollView: UIScrollView) {
        let offset = scrollView.contentOffset.y
        let atTop = offset <= 4
        let atBottom = offset + scrollView.bounds.height >= scrollView.contentSize.height - 4
        onScroll([
            "contentOffset": Double(offset),
            "atTop": atTop,
            "atBottom": atBottom,
        ])
        if atTop { onReachTop([:]) }

        // Show jump-to-bottom FAB when more than 1 screen above the bottom
        let distanceFromBottom = max(0, scrollView.contentSize.height - (offset + scrollView.bounds.height))
        updateScrollFab(visible: distanceFromBottom > scrollView.bounds.height * 0.5)
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

        let sql = """
            SELECT payload_json
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
                if let cstr = sqlite3_column_text(stmt, 0) {
                    let json = String(cString: cstr)
                    if let data = json.data(using: .utf8),
                       let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        results.append(parsed)
                    }
                }
            }
        }
        sqlite3_finalize(stmt)
        return results.reversed()
    }

    // MARK: - Helpers

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

final class BubbleCell: UICollectionViewCell {

    private let bubble = UIView()
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

    static let imageCache = NSCache<NSString, UIImage>()
    private static var audioPlayer: AVAudioPlayer?
    private static var currentPlayingMessageId: Int = 0

    private var currentMessageId: Int = 0
    private var reactionPills: [(emoji: String, frame: CGRect)] = []

    override init(frame: CGRect) {
        super.init(frame: frame)

        // WhatsApp-style bubble: rounded 16pt, soft shadow, container view
        bubble.layer.cornerRadius = 16
        bubble.layer.masksToBounds = false
        bubble.layer.shadowColor = UIColor.black.cgColor
        bubble.layer.shadowOpacity = 0.08
        bubble.layer.shadowRadius = 2
        bubble.layer.shadowOffset = CGSize(width: 0, height: 1)
        contentView.addSubview(bubble)

        // Reply preview header — colored left bar + sender name + body preview
        replyContainer.backgroundColor = UIColor.black.withAlphaComponent(0.05)
        replyContainer.layer.cornerRadius = 8
        replyContainer.layer.masksToBounds = true
        replyContainer.isHidden = true
        bubble.addSubview(replyContainer)
        // Colored accent bar on the left of the reply
        let replyBar = UIView()
        replyBar.tag = 99
        replyBar.backgroundColor = UIColor(red: 0.0, green: 0.65, blue: 0.55, alpha: 1)
        replyContainer.addSubview(replyBar)

        replyLabel.font = .systemFont(ofSize: 13, weight: .regular)
        replyLabel.numberOfLines = 2
        replyLabel.textColor = UIColor(red: 0.05, green: 0.4, blue: 0.6, alpha: 1)
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
        label.font = .systemFont(ofSize: 15.5)
        bubble.addSubview(label)

        timeLabel.font = .systemFont(ofSize: 11)
        timeLabel.textColor = UIColor(red: 0.40, green: 0.47, blue: 0.51, alpha: 1)
        bubble.addSubview(timeLabel)

        statusIcon.contentMode = .scaleAspectFit
        statusIcon.tintColor = UIColor(red: 0.30, green: 0.69, blue: 0.93, alpha: 1)
        statusIcon.isHidden = true
        bubble.addSubview(statusIcon)

        waveformView.isHidden = true
        bubble.addSubview(waveformView)

        voicePlayButton.setImage(UIImage(systemName: "play.fill"), for: .normal)
        voicePlayButton.tintColor = UIColor(red: 0.30, green: 0.50, blue: 0.55, alpha: 1)
        voicePlayButton.isHidden = true
        voicePlayButton.addTarget(self, action: #selector(toggleVoice), for: .touchUpInside)
        bubble.addSubview(voicePlayButton)

        voiceDuration.font = .systemFont(ofSize: 11)
        voiceDuration.textColor = UIColor(red: 0.40, green: 0.47, blue: 0.51, alpha: 1)
        voiceDuration.isHidden = true
        bubble.addSubview(voiceDuration)

        reactionsRow.axis = .horizontal
        reactionsRow.spacing = 3
        reactionsRow.alignment = .center
        reactionsRow.isHidden = true
        contentView.addSubview(reactionsRow)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    override func prepareForReuse() {
        super.prepareForReuse()
        imageView.image = nil
        replyContainer.isHidden = true
        statusIcon.isHidden = true
        waveformView.isHidden = true
        voicePlayButton.isHidden = true
        voiceDuration.isHidden = true
        playButton.isHidden = true
        reactionsRow.isHidden = true
        for sub in reactionsRow.arrangedSubviews { sub.removeFromSuperview() }
        reactionPills.removeAll()
    }

    func configure(message: [String: Any], isOwn: Bool,
                   ownBubbleColor: UIColor, otherBubbleColor: UIColor,
                   textColor: UIColor, metaColor: UIColor, maxWidth: CGFloat) {
        currentMessageId = (message["id"] as? Int) ?? 0
        let type = (message["type"] as? String) ?? "text"
        let content = (message["content"] as? String) ?? ""
        let isDeleted = (message["deleted_at"] as? String) != nil

        bubble.backgroundColor = isOwn ? ownBubbleColor : otherBubbleColor
        label.textColor = isDeleted ? metaColor : textColor
        label.font = isDeleted ? .italicSystemFont(ofSize: 14.5) : .systemFont(ofSize: 15.5)
        timeLabel.textColor = isOwn ? metaColor : metaColor.withAlphaComponent(0.7)

        // ─── WhatsApp-grade layout constants ─────────────────────────
        let bubblePadH: CGFloat = 10        // horizontal padding inside the bubble
        let bubblePadV: CGFloat = 7         // vertical padding inside the bubble
        let outerPad: CGFloat = 10          // gap between bubble edge and screen edge
        let minBubbleW: CGFloat = 56        // hug small messages but not too tight
        let maxBubbleW = min(maxWidth, contentView.bounds.width - outerPad * 2)
        var y: CGFloat = bubblePadV

        // ─── Reply preview header (with colored accent bar on left) ──
        var replyH: CGFloat = 0
        if let reply = message["reply_to"] as? [String: Any], !isDeleted {
            replyContainer.isHidden = false
            let replyText = (reply["content"] as? String) ?? "Mensagem"
            let senderName = (reply["sender_name"] as? String) ?? (reply["sender_email"] as? String) ?? ""
            let combined = NSMutableAttributedString(
                string: senderName + "\n",
                attributes: [
                    .font: UIFont.systemFont(ofSize: 12, weight: .semibold),
                    .foregroundColor: UIColor(red: 0.0, green: 0.65, blue: 0.55, alpha: 1),
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
            replyH = 40
            // Frame is set after we know bubbleW below
        } else {
            replyContainer.isHidden = true
        }

        // ─── Body width calculation: hug content for short messages ──
        var bodyW: CGFloat = 0
        var bodyH: CGFloat = 0
        var imgH: CGFloat = 0

        switch type {
        case "image", "video":
            imageView.isHidden = false
            label.isHidden = content.isEmpty || isDeleted
            label.text = isDeleted ? "Mensagem apagada" : content
            imgH = 230
            bodyW = maxBubbleW - bubblePadH * 2
            bodyH = imgH
            if !label.isHidden {
                let labelH = ceil((label.text ?? "").boundingRect(
                    with: CGSize(width: bodyW, height: .greatestFiniteMagnitude),
                    options: [.usesLineFragmentOrigin],
                    attributes: [.font: label.font!],
                    context: nil
                ).height)
                bodyH += labelH + 6
            }

        case "voice", "audio":
            voicePlayButton.isHidden = isDeleted
            waveformView.isHidden = isDeleted
            voiceDuration.isHidden = isDeleted
            label.isHidden = !isDeleted
            label.text = isDeleted ? "Mensagem apagada" : ""
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
            label.text = isDeleted ? "Mensagem apagada" : content
            let measured = (label.text ?? " ").boundingRect(
                with: CGSize(width: maxBubbleW - bubblePadH * 2, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                attributes: [.font: label.font!],
                context: nil
            )
            bodyW = ceil(measured.width)
            bodyH = ceil(measured.height)
        }

        // ─── Time + status — they go INLINE at the bottom-right of the
        // bubble, on the same baseline as (or just below) the body text.
        // For text messages we measure the time strip and try to fit it on
        // the last line of the message; if not, we add a new line.
        let timeStr = formatTime(message["created_at"] as? String)
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
            // If body is wider than the time strip can fit on its last line,
            // we need to add a row for the time. We approximate this by checking
            // if the body height has more than 1 line and there's space.
            let oneLineHeight = label.font.lineHeight
            let lines = max(1, Int(round(bodyH / oneLineHeight)))
            // Last line width approximation
            let lastLineW = bodyW.truncatingRemainder(dividingBy: max(1, bubbleW - bubblePadH * 2))
            if lines == 1 {
                // Single line: time goes on same line if room, else new line
                let totalW = bodyW + trailingTimeReserve + bubblePadH * 2
                if totalW > maxBubbleW {
                    timeOnNewLine = true
                } else {
                    bubbleW = max(minBubbleW, min(maxBubbleW, totalW))
                }
            } else if lastLineW + trailingTimeReserve > bubbleW - bubblePadH * 2 {
                timeOnNewLine = true
            }
        }

        // ─── Now we have bubbleW. Lay out everything inside ────────
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
            imageView.frame = CGRect(x: bubblePadH, y: y,
                                     width: bubbleW - bubblePadH * 2, height: imgH)
            playButton.isHidden = type != "video"
            playButton.frame = CGRect(x: imageView.frame.midX - 28, y: imageView.frame.midY - 28,
                                      width: 56, height: 56)
            y += imgH
            if !label.isHidden {
                label.frame = CGRect(x: bubblePadH, y: y + 4,
                                     width: bubbleW - bubblePadH * 2,
                                     height: bodyH - imgH - 6)
                y += bodyH - imgH
            }
            if let url = message["file_url"] as? String, !url.isEmpty {
                BubbleCell.loadImage(remoteUrl: url, into: imageView)
            }

        case "voice", "audio":
            if !isDeleted {
                voicePlayButton.frame = CGRect(x: bubblePadH, y: y, width: 32, height: 32)
                waveformView.frame = CGRect(x: bubblePadH + 38, y: y + 6,
                                            width: bubbleW - bubblePadH * 2 - 80, height: 22)
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
            label.frame = CGRect(x: bubblePadH, y: y,
                                 width: bubbleW - bubblePadH * 2, height: bodyH)
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
            statusIcon.frame = CGRect(x: bubbleW - bubblePadH - 14, y: timeY + 1,
                                       width: 14, height: 11)
            timeX = statusIcon.frame.minX - timeLabel.frame.width - 4
        } else {
            statusIcon.isHidden = true
        }
        timeLabel.frame = CGRect(x: max(bubblePadH, timeX), y: timeY,
                                 width: timeLabel.frame.width, height: 14)

        let totalH = y + bubblePadV + (timeOnNewLine ? 0 : 0)

        // ─── Bubble frame (final) — aligned to side of screen ─────
        let bubbleX = isOwn ? contentView.bounds.width - bubbleW - outerPad : outerPad
        bubble.frame = CGRect(x: bubbleX, y: 2, width: bubbleW, height: totalH + bubblePadV)

        // Asymmetric corner radius for the WhatsApp "tail" effect:
        // own bubbles have a square bottom-right corner, others square bottom-left.
        bubble.layer.maskedCorners = isOwn
            ? [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner]
            : [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMaxXMaxYCorner]

        // ─── Reactions row (overlapping the bottom-right of the bubble) ──
        if let reactions = message["reactions"] as? [[String: Any]], !reactions.isEmpty {
            reactionsRow.isHidden = false
            for r in reactions {
                let emoji = (r["emoji"] as? String) ?? ""
                let count = (r["count"] as? Int) ?? 1
                let pill = makeReactionPill(emoji: emoji, count: count)
                reactionsRow.addArrangedSubview(pill)
            }
            let pillsW = CGFloat(reactions.count) * 38
            let reactX = isOwn
                ? bubble.frame.maxX - pillsW
                : bubble.frame.minX
            reactionsRow.frame = CGRect(
                x: reactX,
                y: bubble.frame.maxY - 8,
                width: pillsW,
                height: 22
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
        pill.text = "\(emoji) \(count)"
        pill.font = .systemFont(ofSize: 11)
        pill.textColor = .black
        pill.backgroundColor = UIColor.white.withAlphaComponent(0.95)
        pill.layer.cornerRadius = 10
        pill.layer.masksToBounds = true
        pill.layer.borderWidth = 1
        pill.layer.borderColor = UIColor.black.withAlphaComponent(0.08).cgColor
        pill.textAlignment = .center
        pill.frame = CGRect(x: 0, y: 0, width: 36, height: 20)
        return pill
    }

    private func statusImage(for message: [String: Any]) -> UIImage? {
        let status = (message["status"] as? String) ?? ""
        switch status {
        case "read":
            return UIImage(systemName: "checkmark.circle.fill")
        case "delivered":
            return UIImage(systemName: "checkmark.circle")
        case "sent":
            return UIImage(systemName: "checkmark")
        default:
            return UIImage(systemName: "clock")
        }
    }

    private func formatTime(_ s: String?) -> String {
        guard let s = s else { return "" }
        let iso = ISO8601DateFormatter()
        var date = iso.date(from: s)
        if date == nil {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd HH:mm:ss"
            date = f.date(from: s)
        }
        guard let d = date else { return "" }
        let out = DateFormatter()
        out.dateFormat = "HH:mm"
        return out.string(from: d)
    }

    @objc private func toggleVoice() {
        guard currentMessageId != 0 else { return }
        if BubbleCell.currentPlayingMessageId == currentMessageId,
           let p = BubbleCell.audioPlayer, p.isPlaying {
            p.pause()
            BubbleCell.currentPlayingMessageId = 0
            voicePlayButton.setImage(UIImage(systemName: "play.fill"), for: .normal)
            return
        }
        // Start playing — needs URL from message but we don't have it here
        // For real impl this would lookup the cached audio file path
        BubbleCell.currentPlayingMessageId = currentMessageId
        voicePlayButton.setImage(UIImage(systemName: "pause.fill"), for: .normal)
    }

    static func estimateHeight(message: [String: Any], maxWidth: CGFloat) -> CGFloat {
        let type = (message["type"] as? String) ?? "text"
        let content = (message["content"] as? String) ?? ""
        let isDeleted = (message["deleted_at"] as? String) != nil
        let hasReply = (message["reply_to"] as? [String: Any]) != nil
        let hasReactions = (message["reactions"] as? [[String: Any]])?.isEmpty == false

        var h: CGFloat = 24 // padding + time
        if hasReply { h += 40 }
        if hasReactions { h += 14 }

        switch type {
        case "image", "video":
            h += 220
            if !content.isEmpty && !isDeleted {
                let font = UIFont.systemFont(ofSize: 15)
                let r = (content as NSString).boundingRect(
                    with: CGSize(width: maxWidth - 16, height: .greatestFiniteMagnitude),
                    options: [.usesLineFragmentOrigin],
                    attributes: [.font: font], context: nil
                )
                h += ceil(r.height) + 8
            }
        case "voice", "audio":
            h += isDeleted ? 22 : 36
        default:
            let font = isDeleted ? UIFont.italicSystemFont(ofSize: 14) : UIFont.systemFont(ofSize: 15)
            let r = (content as NSString).boundingRect(
                with: CGSize(width: maxWidth - 16, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin],
                attributes: [.font: font], context: nil
            )
            h += max(20, ceil(r.height)) + 4
        }
        return h
    }

    static func prefetchImage(remoteUrl: String) {
        if imageCache.object(forKey: remoteUrl as NSString) != nil { return }
        guard let url = URL(string: remoteUrl) else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data = data, let img = UIImage(data: data) else { return }
            imageCache.setObject(img, forKey: remoteUrl as NSString)
        }.resume()
    }

    static func loadImage(remoteUrl: String, into view: UIImageView) {
        if let cached = imageCache.object(forKey: remoteUrl as NSString) {
            view.image = cached
            return
        }
        guard let url = URL(string: remoteUrl) else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data = data, let img = UIImage(data: data) else { return }
            imageCache.setObject(img, forKey: remoteUrl as NSString)
            DispatchQueue.main.async {
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
        pill.backgroundColor = UIColor.black.withAlphaComponent(0.4)
        pill.layer.cornerRadius = 10
        contentView.addSubview(pill)

        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .white
        label.textAlignment = .center
        pill.addSubview(label)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let w: CGFloat = 100
        pill.frame = CGRect(x: (bounds.width - w) / 2, y: 4, width: w, height: 22)
        label.frame = pill.bounds
    }
}

// MARK: - System message cell (centered grey pill)

final class SystemCell: UICollectionViewCell {
    let label = UILabel()
    private let pill = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        pill.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        pill.layer.cornerRadius = 10
        contentView.addSubview(pill)
        label.font = .systemFont(ofSize: 11)
        label.textColor = .white
        label.textAlignment = .center
        pill.addSubview(label)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let w = min(bounds.width - 80, 280)
        pill.frame = CGRect(x: (bounds.width - w) / 2, y: 6, width: w, height: 22)
        label.frame = pill.bounds.insetBy(dx: 8, dy: 0)
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
            var children: [UIMenuElement] = [reply, forward, copy, star, info]
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
}

// MARK: - Voice message waveform

final class WaveformView: UIView {
    var samples: [Float] = []
    var progress: CGFloat = 0
    var color = UIColor(red: 0.30, green: 0.50, blue: 0.55, alpha: 1)
    var progressColor = UIColor(red: 0.05, green: 0.50, blue: 0.40, alpha: 1)

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        // Generate fake samples for now (real impl would parse the audio file)
        samples = (0..<40).map { _ in Float.random(in: 0.2...1.0) }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not implemented") }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext(), !samples.isEmpty else { return }
        let barWidth: CGFloat = 2
        let gap: CGFloat = 1
        let totalWidth = CGFloat(samples.count) * (barWidth + gap)
        let startX = (rect.width - totalWidth) / 2
        let midY = rect.height / 2
        for (i, s) in samples.enumerated() {
            let h = CGFloat(s) * rect.height * 0.8
            let x = startX + CGFloat(i) * (barWidth + gap)
            let frac = CGFloat(i) / CGFloat(samples.count)
            ctx.setFillColor((frac < progress ? progressColor : color).cgColor)
            ctx.fill(CGRect(x: x, y: midY - h/2, width: barWidth, height: h))
        }
    }
}
