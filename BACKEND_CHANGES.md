# Backend changes — Multi-device linked devices (Signal/WhatsApp parity)

Target: `/var/www/mail/api/e2ee.php` on production. Additive; only one
destructive step (swap a primary key) and it is backfilled first.

## 1. `e2ee_signed_prekeys`: scope per device

Today the PK is `user_email`, so a second device's upload overwrites the
first. Fix:

```sql
ALTER TABLE e2ee_signed_prekeys ADD COLUMN IF NOT EXISTS device_id TEXT;

-- backfill with each user's most recent device
UPDATE e2ee_signed_prekeys sp
SET device_id = k.device_id
FROM (
  SELECT DISTINCT ON (user_email) user_email, device_id
  FROM e2ee_keys
  ORDER BY user_email, created_at DESC
) k
WHERE sp.user_email = k.user_email AND sp.device_id IS NULL;

UPDATE e2ee_signed_prekeys SET device_id = 'legacy' WHERE device_id IS NULL;

ALTER TABLE e2ee_signed_prekeys DROP CONSTRAINT e2ee_signed_prekeys_pkey;
ALTER TABLE e2ee_signed_prekeys
  ADD CONSTRAINT e2ee_signed_prekeys_pkey PRIMARY KEY (user_email, device_id);
```

Update `e2eeMigrateSchema()` so fresh DBs build the per-device shape.

## 2. `e2ee_prekeys`: tag each OPK with the device that uploaded it

```sql
ALTER TABLE e2ee_prekeys ADD COLUMN IF NOT EXISTS device_id TEXT;
CREATE INDEX IF NOT EXISTS idx_e2ee_prekeys_email_device_unused
  ON e2ee_prekeys (user_email, device_id) WHERE used = FALSE;
```

Backfill existing rows using the same "most recent device" heuristic as
above. Claim queries must then filter by `device_id` so device B doesn't
consume device A's one-time prekeys.

## 3. `e2ee_register_keys`: write device-scoped rows

- Insert/upsert signed prekey with `ON CONFLICT (user_email, device_id)` and
  pass `device_id` into the bound params.
- Insert OPKs with the uploader's `device_id` stamped on every row.
- `e2ee_keys` table already keyed on `(user_email, device_id)` — no change.

## 4. `e2ee_get_key_bundle`: return `devices[]` per user

Replace the single-device `DISTINCT ON (user_email)` identity query with
one that returns every registered device, then for each device:
  - fetch its signed prekey (now scoped by `device_id`)
  - claim one unused OPK **belonging to that device**

Response shape per email:

```json
{
  "has_keys": true,
  "devices": [
    {
      "device_id": "did_abc",
      "identity_key": { "key": "<jwk>", "signing_key": "<b64>" },
      "signed_prekey": { "id": 123, "key": "<b64>", "sig": "<b64>" },
      "prekey": { "id": 456, "key": "<jwk>" }
    },
    { "device_id": "did_xyz", ... }
  ]
}
```

Keep the old top-level `identity_key`/`signed_prekey`/`prekey` fields
populated with the FIRST device's data during rollout so legacy clients
still see a valid single-device bundle. The updated frontend
(`services/e2ee.js::getConversationBundles`) already accepts both shapes.

## 5. `e2ee_get_keys` (single-user endpoint)

No longer used by the v3 flow. Leave behavior as "newest device" for any
remaining callers, or deprecate.

## 6. `e2ee_key_backup` — unchanged

Password-encrypted identity-key backup stays per-user. A second device that
restores the backup still generates its OWN signed prekey + OPKs registered
under its own `device_id` via the changes above.

---

# Backend changes — Sender Keys protocol (groups)

Apply on production server `69.62.103.131` against `/var/www/mail/api/chat.php` and the Postgres instance used by `e2ee.php`. Nothing below is deployed from the worktree.

## 1. New table: `e2ee_sender_keys_published`

Tracks which (group, sender, member) triples have already received an
SKDM from a given sender so we don't re-publish on every message.
Storing only metadata here — the SKDM ciphertext itself is transported
over the existing 1:1 DR channel (same table/path as normal chat msgs
or a dedicated control envelope, your call) and is NOT kept on the
server after delivery.

```sql
CREATE TABLE IF NOT EXISTS e2ee_sender_keys_published (
  conversation_id BIGINT     NOT NULL,
  sender_email    TEXT       NOT NULL,
  member_email    TEXT       NOT NULL,
  -- monotonically-increasing epoch. When the sender rotates SCK
  -- (member removed, suspected compromise) they bump this and every
  -- member needs a fresh SKDM for the new epoch.
  epoch           INTEGER    NOT NULL DEFAULT 0,
  published_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, sender_email, member_email, epoch)
);

CREATE INDEX IF NOT EXISTS idx_skp_conv_sender
  ON e2ee_sender_keys_published (conversation_id, sender_email);
```

## 2. New endpoint: `chat_publish_sender_key`

Add to `chat.php`'s action switch. Accepts the batch of
per-member SKDM envelopes the sender built client-side via
`buildSKDM()` and records delivery in `e2ee_sender_keys_published`,
then delivers each envelope as a normal 1:1 E2E control message to
the targeted member (same rails used for `chat_send` today).

### Request
```json
POST /api/chat.php?action=chat_publish_sender_key
{
  "conversation_id": 1234,
  "epoch": 0,
  "skdms": [
    { "member_email": "bob@...",    "skdm_envelope": { e2e:3, ... } },
    { "member_email": "charlie@...","skdm_envelope": { e2e:3, ... } }
  ]
}
```

### Handler outline (PHP)
```php
case 'chat_publish_sender_key': {
    require_auth();
    $me  = $_SESSION['email'] ?? null;
    $cid = (int)($in['conversation_id'] ?? 0);
    $epoch = (int)($in['epoch'] ?? 0);
    $skdms = $in['skdms'] ?? [];
    if (!$cid || !is_array($skdms)) json_err(400, 'bad_request');

    requireConversationMember($pdo, $cid, $me);

    $pdo->beginTransaction();
    $ins = $pdo->prepare(
      "INSERT INTO e2ee_sender_keys_published
         (conversation_id, sender_email, member_email, epoch)
       VALUES (:c, :s, :m, :e)
       ON CONFLICT (conversation_id, sender_email, member_email, epoch)
       DO UPDATE SET published_at = NOW()"
    );
    $delivered = [];
    foreach ($skdms as $row) {
        $to  = strtolower(trim($row['member_email'] ?? ''));
        $env = $row['skdm_envelope'] ?? null;
        if (!$to || !$env) continue;
        // Verify $to is actually a member of $cid (defence in depth).
        if (!isConversationMember($pdo, $cid, $to)) continue;

        // Deliver as a control/system E2E message over existing DR rails.
        // Use the same insert path as chat_send but with message_type='skdm'
        // so clients route it into processSKDM() rather than the chat UI.
        enqueueDirectE2EControl($pdo, $cid, $me, $to, 'skdm', $env);

        $ins->execute([':c'=>$cid, ':s'=>$me, ':m'=>$to, ':e'=>$epoch]);
        $delivered[] = $to;
    }
    $pdo->commit();
    json_ok(['delivered' => $delivered]);
}
```

Notes:
- `isConversationMember` / `requireConversationMember` already exist
  per session notes (fix #49). Reuse them — do not trust client-side
  `member_email` values.
- `enqueueDirectE2EControl` is a thin helper around the existing
  direct-message insert path; you may already have a suitable
  function for system messages (reactions etc.). If not, add one
  that writes into the same messages table with a distinct
  `message_type` column value so receivers can branch on it before
  decrypt.
- Add the `message_type` column if it's not present:
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text';`

## 3. Optional companion endpoint (read)

`chat_sender_key_status` — lets the client decide whether it needs to
re-publish before sending:

```php
case 'chat_sender_key_status': {
    require_auth();
    $me = $_SESSION['email'];
    $cid = (int)($_GET['conversation_id'] ?? 0);
    requireConversationMember($pdo, $cid, $me);
    $rows = $pdo->prepare(
      "SELECT member_email, MAX(epoch) AS epoch
         FROM e2ee_sender_keys_published
        WHERE conversation_id = :c AND sender_email = :s
        GROUP BY member_email"
    );
    $rows->execute([':c'=>$cid, ':s'=>$me]);
    json_ok(['published' => $rows->fetchAll(PDO::FETCH_ASSOC)]);
}
```

Client compares the returned list against current group membership —
any missing member needs a new SKDM.

## 4. Broadcast envelope storage

The `e2e:4` broadcast envelopes are stored in the normal `messages`
table exactly like today's per-recipient `envelopes:{...}`. No schema
change needed beyond making sure the `content` column can hold the
JSON blob `{ e2e:4, group_id, sender_email, iteration, nonce, ct }`
(already the case — it's small and text).

---

# Backend Changes — Interactive Status Stickers

Target file: `/var/www/mail/api/chat.php`
Frontend component: `/root/webmail-app/components/InteractiveStickers.js`

## Database Tables

### `status_poll_votes` (already referenced in code — ensure it exists)

```sql
CREATE TABLE IF NOT EXISTS status_poll_votes (
    id           SERIAL PRIMARY KEY,
    status_id    INTEGER NOT NULL,
    email        TEXT    NOT NULL,
    option_index INTEGER NOT NULL DEFAULT 0,
    voted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (status_id, email)
);
CREATE INDEX IF NOT EXISTS idx_spv_status ON status_poll_votes(status_id);
```

### `status_answers` (already referenced in code — ensure it exists)

```sql
CREATE TABLE IF NOT EXISTS status_answers (
    id          SERIAL PRIMARY KEY,
    status_id   INTEGER NOT NULL,
    email       TEXT    NOT NULL,
    answer      TEXT    NOT NULL,
    answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sa_status ON status_answers(status_id);
```

### `status_quiz_answers` *(new — not yet created)*

```sql
CREATE TABLE IF NOT EXISTS status_quiz_answers (
    id           SERIAL PRIMARY KEY,
    status_id    INTEGER NOT NULL,
    email        TEXT    NOT NULL,
    option_index INTEGER NOT NULL DEFAULT 0,
    is_correct   BOOLEAN NOT NULL DEFAULT FALSE,
    answered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (status_id, email)
);
CREATE INDEX IF NOT EXISTS idx_sqa_status ON status_quiz_answers(status_id);
```

---

## Endpoints

### 1. `status_poll_vote`

Vote on a poll sticker.  Calling again switches the vote (upsert).

**Already implemented** in `chat.php` near line 14559.

- **Auth**: `requireChatAuth()`
- **Method**: POST
- **Request**: `{ status_id: number, option_index: 0|1 }`
- **Response**: `{ success: true, data: { voted: true } }`

**Frontend API** (`services/api.js` line 1490 — already exists):
```js
export async function statusPollVote(statusId, optionIndex) {
  return apiCall('status_poll_vote', { status_id: statusId, option_index: optionIndex }, 'POST');
}
```

---

### 2. `status_question_answer`

Submit a free-text answer to a Question sticker.

**Already implemented** in `chat.php` near line 14570.

- **Auth**: `requireChatAuth()`
- **Method**: POST
- **Request**: `{ status_id: number, answer: string (max 500 chars) }`
- **Response**: `{ success: true, data: { answered: true } }`

**Frontend API** (`services/api.js` line 1491 — already exists):
```js
export async function statusQuestionAnswer(statusId, answer) {
  return apiCall('status_question_answer', { status_id: statusId, answer }, 'POST');
}
```

---

### 3. `status_quiz_answer` *(new — must be added)*

Record the viewer's quiz answer, including whether it was correct.  One answer
per user per status (upsert).

- **Auth**: `requireChatAuth()`
- **Method**: POST
- **Request**: `{ status_id: number, option_index: number, correct_index: number }`
- **Response**: `{ success: true, data: { is_correct: bool, correct_index: number } }`

**PHP — add to `chat.php` after the `status_question_answer` case (~line 14579)**:

```php
// STATUS QUIZ ANSWER
case 'status_quiz_answer': {
    $user       = requireChatAuth();
    $statusId   = (int)($input['status_id']    ?? 0);
    $optIdx     = (int)($input['option_index'] ?? 0);
    $correctIdx = (int)($input['correct_index'] ?? 0);
    if (!$statusId) jsonResponse(false, null, 'status_id required', 400);
    $isCorrect = ($optIdx === $correctIdx);

    // Idempotent migration — create table if first deploy
    try {
        $db->exec("
            CREATE TABLE IF NOT EXISTS status_quiz_answers (
                id           SERIAL PRIMARY KEY,
                status_id    INTEGER NOT NULL,
                email        TEXT    NOT NULL,
                option_index INTEGER NOT NULL DEFAULT 0,
                is_correct   BOOLEAN NOT NULL DEFAULT FALSE,
                answered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (status_id, email)
            )
        ");
    } catch (\Throwable $e) {}

    $db->prepare("
        INSERT INTO status_quiz_answers (status_id, email, option_index, is_correct)
        VALUES (:sid, :e, :oi, :ic)
        ON CONFLICT (status_id, email)
        DO UPDATE SET option_index = :oi2, is_correct = :ic2, answered_at = NOW()
    ")->execute([
        ':sid' => $statusId, ':e'   => $user['email'],
        ':oi'  => $optIdx,   ':ic'  => $isCorrect ? 't' : 'f',
        ':oi2' => $optIdx,   ':ic2' => $isCorrect ? 't' : 'f',
    ]);

    jsonResponse(true, ['is_correct' => $isCorrect, 'correct_index' => $correctIdx]);
}
```

**Frontend API — add to `services/api.js` after line 1491**:
```js
export async function statusQuizAnswer(statusId, selectedIdx, correctIdx) {
  return apiCall('status_quiz_answer',
    { status_id: statusId, option_index: selectedIdx, correct_index: correctIdx },
    'POST'
  );
}
```

> `InteractiveStickers.js` calls `api.statusQuizAnswer(statusId, idx)` with
> only 2 args for now; add the 3rd arg (`sticker.correct`) when wiring it in
> if you want the backend to record correctness.

---

## Sticker Data Storage

Interactive sticker metadata (question text, options, correct index, countdown
target date, etc.) is written by the creator into the `content` field via the
`extraMeta` argument of `api.statusPublish()`.  Currently that 5th argument is
ignored by the function.

**Recommended fix** — update `statusPublish` in `services/api.js`:

```js
export async function statusPublish(content, type = 'text', bgColor = '#7C3AED', musicData = null, extraMeta = null) {
  const params = { content, type, bg_color: bgColor };
  if (musicData) {
    params.music_title       = musicData.title      || '';
    params.music_artist      = musicData.artist     || '';
    params.music_preview_url = musicData.previewUrl || '';
    params.music_cover_url   = musicData.coverUrl   || '';
  }
  if (extraMeta) {
    params.sticker_data = JSON.stringify(extraMeta);
  }
  return apiCall('status_publish', params, 'POST');
}
```

Then in `chat.php` `status_publish` case, add:

```php
// Migration
$db->exec("ALTER TABLE chat_user_status ADD COLUMN IF NOT EXISTS sticker_data TEXT DEFAULT ''");

// In INSERT params:
$stickerData = mb_substr(trim($input['sticker_data'] ?? ''), 0, 8000);
// add :sticker_data to the INSERT ... VALUES list and execute array

// In status_list response array per item:
'sticker_data' => $row['sticker_data'] ?? '',
```

Until this is deployed, `parseStickerData()` in `InteractiveStickers.js`
falls back to trying to JSON-parse `item.content` directly (the sticker array
was always embedded there by the editor's `extraMeta` pattern).

---

## Wiring into the Status Viewer (ChatListTab.js)

Add after the caption block (~line 1182):

```jsx
import { renderInteractiveStickers } from './InteractiveStickers';

// current user's email — retrieve from AuthContext or however the file gets it
{renderInteractiveStickers(item, currentUserEmail, { stacked: true })}
```

---

# Push Notification Improvements — Rich + Actionable

> Changes implemented in this session. Files modified:
> `/var/www/mail/api/firebase_push.php` and `/root/webmail-app/services/pushNotifications.js`.
> Nothing below is deployed. Follow each section's deploy steps when ready.

---

## 1. Rich Media in Push (iOS Notification Service Extension)

### What it is
A Notification Service Extension (NSE) is a small iOS app extension that runs
for up to ~30 s before a notification is displayed. It can download an image
and attach it to the notification so users see sender avatars and post thumbnails
directly on the lock screen / banner — identical to WhatsApp and iMessage.

### Backend changes already applied (`firebase_push.php`)
- `mutable-content: 1` is already set in the `aps` dict for every FCM iOS payload.
  This is the flag that tells iOS to wake the NSE before showing the notification.
- `media_url` is now added to the APNS custom payload whenever `$data['image']`
  is populated (e.g. sender avatar URL, feed post thumbnail URL).
- `fcm_options.image` is also set — FCM's own best-effort image attachment for
  devices without an NSE installed.
- `apns-collapse-id` header is now set to `group_key` (truncated to 64 chars)
  so rapid-fire pushes from the same conversation replace each other at the APNS
  level rather than stacking.

### Native changes required (Xcode — one-time, new build needed)

1. **Add a Notification Service Extension target** in Xcode:
   `File → New → Target → Notification Service Extension`
   Name it `ChatyyNotificationService`.

2. Replace the generated `NotificationService.swift` with:

```swift
import UserNotifications

class NotificationService: UNNotificationServiceExtension {
    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler  = contentHandler
        bestAttemptContent   = request.content.mutableCopy() as? UNMutableNotificationContent

        guard let content = bestAttemptContent else { contentHandler(request.content); return }

        // 1. Accurate badge from server-computed aps.badge (already set by firebase_push.php)
        if let badge = request.content.badge { content.badge = badge }

        // 2. Download and attach the sender avatar / post thumbnail
        guard let urlStr = request.content.userInfo["media_url"] as? String,
              let url    = URL(string: urlStr) else {
            contentHandler(content)
            return
        }

        URLSession.shared.downloadTask(with: url) { tmpURL, _, _ in
            if let tmpURL = tmpURL {
                let ext  = url.pathExtension.isEmpty ? "jpg" : url.pathExtension
                let dest = tmpURL.deletingLastPathComponent().appendingPathComponent("att.\(ext)")
                try? FileManager.default.moveItem(at: tmpURL, to: dest)
                if let att = try? UNNotificationAttachment(identifier: "media", url: dest) {
                    content.attachments = [att]
                }
            }
            contentHandler(content)
        }.resume()
    }

    override func serviceExtensionTimeWillExpire() {
        if let h = contentHandler, let c = bestAttemptContent { h(c) }
    }
}
```

3. In `ios/Podfile`, add:
```ruby
target 'ChatyyNotificationService' do
  use_frameworks! :linkage => :static
end
```

4. All native changes require `eas build --platform ios` — OTA is not sufficient.

---

## 2. Quick Reply from Notification (iOS + Android)

### Already fully implemented — audit result: working correctly.

**iOS**: The `CHAT` / `chat_message` notification categories include a `REPLY`
action with `textInput: { submitButtonTitle: 'Enviar', placeholder: 'Mensagem...' }`.
When the user swipes on the notification and types a reply, the
`addNotificationResponseReceivedListener` handler calls
`handleChatReplyFromNotification(conversationId, userText.trim())` which posts
the message via `chatSend()` and marks the conversation as read via `chatRead()`.
The reply happens silently without opening the app.

**Android**: Same mechanism via `textInput` on the category action. Android 7+.

**FCM payload requirement**: The `categoryId` in the Expo Push payload and
`aps.category` in the APNS payload must match the registered category identifier.
The backend sends `categoryId: 'chat_message'` for all chat pushes. This is
correctly matched by the `chat_message` category registered in `pushNotifications.js`.

**No backend changes needed.** The quick reply path is 100% client-side
after the push triggers it.

---

## 3. Notification Grouping (audit + improvements)

### iOS — thread-id (improved)
All FCM APNS payloads now include:
- `aps.thread-id` = `data['group_key']`
- `apns-collapse-id` header = `data['group_key']` (max 64 chars)

Format of `group_key` values set by the backend:

| Scenario | group_key |
|---|---|
| Chat conversation | `chat_conv_{conversation_id}` |
| Email from same sender | `email_from_{sender_email}` |
| Feed like/comment on same post | `like_post_{post_id}` |
| @mention in conversation | `mention_conv_{conversation_id}` |

iOS stacks all notifications sharing the same `thread-id` into one expandable
group in the Notification Centre.

### Android — collapse_key + tag (improved)
- `message.android.collapse_key` = `group_key` (FCM-level: last message wins on reconnect)
- `message.android.notification.tag` = `group_key` (replaces previous in shade)
- `message.android.notification.notification_count` = `unread_count` (stacked badge number)

### Gap to close in `chat.php`
The `unread_count` per recipient is not currently included in the FCM data
payload. Add this in the chat push batch flush:
```php
// Fetch recipient's unread count for this conversation
$unreadStmt = $db->prepare("
    SELECT unread_count FROM chat_conversation_members
    WHERE conversation_id = :cid AND email = :email
");
$unreadStmt->execute([':cid' => $conversationId, ':email' => $recipientEmail]);
$recipientUnread = (int)($unreadStmt->fetchColumn() ?: 1);

$pushData['unread_count'] = (string)$recipientUnread;
```

---

## 4. Priority Notification Channels (Android)

Four channels are now registered in `pushNotifications.js`:

| Channel ID | Importance | Use case | Bypass DND |
|---|---|---|---|
| `calls` | MAX | Incoming voice/video calls | Yes |
| `chat` | HIGH | Direct messages + group chats | No |
| `email` | DEFAULT | New emails | No |
| `social` | LOW | Likes, comments, follows | No |
| `default` | DEFAULT | Fallback | No |

The backend (`firebase_push.php`) already maps notification types to the
correct `channel_id` in `message.android.notification.channel_id`:
```php
$channelId = match (true) {
    $isCall                                          => 'calls',
    $isSocial                                        => 'social',
    $type === 'chat_message'                         => 'chat',
    in_array($type, ['new_email', 'email'], true)    => 'email',
    default                                          => 'onemundo_default',
};
```

**Important**: Android does not allow upgrading a channel's importance after
first creation. If users have the old `email` channel at HIGH, they keep it
until reinstall. To force a rebuild, rename the channel to `email_v2`.

**Sound file**: `ringtone.wav` must be present at
`android/app/src/main/res/raw/ringtone.wav` for the `calls` channel custom
ringtone to work. Confirm this file exists before publishing a build.

---

## 5. Badge Count (improved)

### Problem
The old code always sent `badge: 1` in the iOS APNS payload. This caused the
app icon badge to always reset to 1 instead of showing the real unread count.

### Backend fix applied (`firebase_push.php`)
New function `fcmGetBadgeCount($userEmail)`:
- Queries `chat_conversation_members.unread_count` sum for chat unread
- Runs `doveadm mailbox status -u $email unseen INBOX` for email unread
- Returns the total; used in both `fcmSendToToken()` and `expoPushSend()`

Both FCM native and Expo Push paths now send the live badge count instead of 1.

### Frontend fix applied (`pushNotifications.js`)
New function `refreshBadgeCount()`:
- Calls `chatUnreadCount()` and `apiCall('folder_counts')`
- Sums chat + email unread
- Calls `Notifications.setBadgeCountAsync(total)`

**Wire `refreshBadgeCount()` in `app/_layout.js`:**
```js
import { AppState } from 'react-native';
import { refreshBadgeCount } from '../services/pushNotifications';

useEffect(() => {
  const sub = AppState.addEventListener('change', state => {
    if (state === 'active') refreshBadgeCount();
  });
  // Also refresh on mount
  refreshBadgeCount();
  return () => sub.remove();
}, []);
```

**Wire in `app/chat-conversation.js`** after `chatRead()`:
```js
const { refreshBadgeCount } = require('../services/pushNotifications');
refreshBadgeCount().catch(() => {});
```

**Wire in `app/read.js`** after marking an email as read:
```js
const { refreshBadgeCount } = require('../services/pushNotifications');
refreshBadgeCount().catch(() => {});
```

---

## 6. Silent Push for Background Sync

### What it is
When a new message arrives and the app is closed, the conversation list shows
stale data until the user opens the app. A silent data-only push wakes the app
briefly so it can pre-fetch new message IDs and update the local DB — keeping
the inbox and chat list fresh at all times, as WhatsApp and Gmail do.

### Backend: `fcmSendSilentSync()` (new function in `firebase_push.php`)

```php
// Send to one user, hint which type of data changed
fcmSendSilentSync($userEmail, [
    'sync_type' => 'chat',   // 'chat' | 'email' | 'all'
    'since'     => (string)time(),
]);
```

Key technical decisions:
- **No `notification` key** → completely invisible, no banner.
- **iOS**: `apns-push-type: background` + `apns-priority: 5` (required by Apple
  for silent pushes; using priority 10 here is a policy violation and will cause
  Apple to revoke the push certificate). `aps.content-available = 1` wakes
  `BGAppRefreshTask`.
- **Android**: Normal-priority data FCM; delivered to `onMessageReceived()` even
  when the app is killed.
- **Expo tokens are skipped** — Expo Push API does not support silent/background
  pushes reliably. Only native FCM tokens are used.
- **TTL 1 hour** — silent syncs are only useful fresh.

### Where to call `fcmSendSilentSync()` in the backend

**In `chat.php`** — after delivering the main push to a recipient, also send a
silent sync to OTHER devices of the SENDER so their own app stays current when
they send from one device:
```php
// After the main push delivery loop in chat_send:
if ($senderEmail !== $recipientEmail) {
    fcmSendSilentSync($senderEmail, ['sync_type' => 'chat', 'since' => (string)time()]);
}
```

**In `push-notify.php`** — after the email push:
```php
// After: $sent = fcmSendToUser($recipient, $from, $pushBody, $pushData);
fcmSendSilentSync($recipient, ['sync_type' => 'email', 'since' => (string)time()]);
```

Use sparingly — Apple limits background wakes to ~1–3 per hour per app.
Reserve for chat messages and email delivery only, not for likes/follows.

### Frontend handler: `triggerBackgroundSync()` (new in `pushNotifications.js`)

The silent push arrives via `addNotificationReceivedListener`. The handler now
checks `data.type === 'silent_sync'` first and routes to `triggerBackgroundSync(data)`.

The function emits `silent_sync` events on the WebSocket service bus so the
chat list and inbox components can trigger an incremental refresh without a
full page reload.

### iOS `Info.plist` additions needed
For background pushes to actually wake the app, add to `ios/OneMundoMail/Info.plist`:
```xml
<key>UIBackgroundModes</key>
<array>
    <string>remote-notification</string>
    <string>fetch</string>
</array>
```
`remote-notification` is what enables `content-available` to wake the app.
`fetch` enables the Background App Refresh (used by `expo-background-fetch`).

Both modes are declared via `app.json` in Expo:
```json
{
  "ios": {
    "infoPlist": {
      "UIBackgroundModes": ["remote-notification", "fetch"]
    }
  }
}
```
This change requires a native build (`eas build --platform ios`).

---

## Summary of All Files Changed

| File | What changed |
|---|---|
| `/var/www/mail/api/firebase_push.php` | Added `fcmGetBadgeCount()`, `fcmSendSilentSync()`; improved iOS payload (apns-collapse-id header, interruption-level/relevance-score, accurate badge count, media_url for NSE, per-type APNS headers); improved Android payload (email/social channel mapping, notification_count for grouping, per-channel TTL); injected `recipient_email` into data dict for badge lookup |
| `/root/webmail-app/services/pushNotifications.js` | Added `social` and `email` Android channels; added `email_new`, `chat_mention`, `feed_like/comment/follow`, `live_start` notification categories; added `refreshBadgeCount()`, `triggerBackgroundSync()`, `handleViewFromNotification()`, `handleJoinLiveFromNotification()`; wired new action identifiers VIEW and JOIN; wired `silent_sync` data push handler; added navigation for feed/live notification types |

## Files NOT Changed (require Xcode / native build)

| Item | Action required |
|---|---|
| iOS Notification Service Extension | Create new Xcode target `ChatyyNotificationService` (see §1 above) |
| `OneMundoMail/Info.plist` | Add `UIBackgroundModes: [remote-notification, fetch]` — or via `app.json` |
| `app.json` | Add `ios.infoPlist.UIBackgroundModes` for silent push background wake |
| `android/app/src/main/res/raw/ringtone.wav` | Verify file exists for calls channel ringtone |

All native changes require `eas build --platform all`. OTA update is not sufficient.
