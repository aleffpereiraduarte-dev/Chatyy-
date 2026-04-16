# Backend Changes: Status Reply + React

## File: `/var/www/mail/api/chat.php`

Add two new `case` blocks in the main `switch ($action)` statement after the
existing `status_viewers` case (currently around line 5618).

---

### 1. `status_reply` — reply to a status via chat

Finds or creates a direct conversation between the caller and the status
owner, then inserts a quoted chat message.

**Request** (POST JSON):
```json
{ "action": "status_reply", "status_id": 42, "text": "Que linda foto!" }
```
**Response**:
```json
{ "success": true, "data": { "message_id": 9871, "conversation_id": 17 } }
```

**PHP** (paste after `case 'status_viewers'` break):
```php
case 'status_reply': {
    $user = requireChatAuth();
    $input = getInput();
    $statusId = (int)($input['status_id'] ?? 0);
    $text = trim($input['text'] ?? '');

    if ($statusId <= 0) jsonResponse(false, null, 'status_id required', 400);
    if ($text === '')   jsonResponse(false, null, 'text required', 400);
    if (mb_strlen($text) > 2000) jsonResponse(false, null, 'text too long', 400);

    $sStmt = $db->prepare("SELECT id, email, type, content FROM chat_user_status WHERE id = :id AND expires_at > NOW()");
    $sStmt->execute([':id' => $statusId]);
    $statusRow = $sStmt->fetch(PDO::FETCH_ASSOC);
    if (!$statusRow) jsonResponse(false, null, 'Status not found or expired', 404);

    $ownerEmail  = strtolower($statusRow['email']);
    $callerEmail = strtolower($user['email']);

    if ($ownerEmail === $callerEmail) jsonResponse(false, null, 'Cannot reply to your own status', 400);

    // Block check
    $blkStmt = $db->prepare("SELECT 1 FROM chat_blocked_users WHERE (blocker_email=:a AND blocked_email=:b) OR (blocker_email=:b AND blocked_email=:a) LIMIT 1");
    $blkStmt->execute([':a' => $ownerEmail, ':b' => $callerEmail]);
    if ($blkStmt->fetch()) jsonResponse(false, null, 'Not authorized', 403);

    // Find or create direct conversation
    $convStmt = $db->prepare("
        SELECT c.id FROM chat_conversations c
        JOIN chat_conversation_members m1 ON m1.conversation_id=c.id AND LOWER(m1.email)=:a
        JOIN chat_conversation_members m2 ON m2.conversation_id=c.id AND LOWER(m2.email)=:b
        WHERE c.type='direct' LIMIT 1
    ");
    $convStmt->execute([':a' => $callerEmail, ':b' => $ownerEmail]);
    $convRow = $convStmt->fetch(PDO::FETCH_ASSOC);
    if ($convRow) {
        $convId = (int)$convRow['id'];
    } else {
        $db->prepare("INSERT INTO chat_conversations (name,type,created_by,created_at) VALUES ('','direct',:cb,NOW())")->execute([':cb' => $callerEmail]);
        $convId = (int)$db->lastInsertId();
        $db->prepare("INSERT INTO chat_conversation_members (conversation_id,email,role,joined_at) VALUES (:c,:e1,'member',NOW()),(:c,:e2,'member',NOW())")->execute([':c' => $convId, ':e1' => $callerEmail, ':e2' => $ownerEmail]);
    }

    // Build message with status quote
    $statusType = $statusRow['type'] ?? 'text';
    $replyLabel = "\u{21A9}\u{FE0F} Respondeu ao seu status";
    if ($statusType === 'image' || $statusType === 'video') {
        $msgContent = "{$replyLabel}: {$text}";
    } else {
        $preview = mb_substr($statusRow['content'] ?? '', 0, 80);
        $msgContent = "{$replyLabel}: \"{$preview}\"\n\n{$text}";
    }

    $clientMsgId = bin2hex(random_bytes(8));
    $insStmt = $db->prepare("INSERT INTO chat_messages (conversation_id,sender_email,content,type,created_at,client_message_id) VALUES (:cid,:email,:content,'text',NOW(),:cmid) RETURNING id");
    $insStmt->execute([':cid' => $convId, ':email' => $callerEmail, ':content' => $msgContent, ':cmid' => $clientMsgId]);
    $msgId = (int)($insStmt->fetchColumn() ?: 0);

    $db->prepare("UPDATE chat_conversations SET updated_at=NOW() WHERE id=:id")->execute([':id' => $convId]);

    // Push (best-effort)
    try {
        require_once __DIR__ . '/push-notify-functions.php';
        if (function_exists('sendChatPush')) sendChatPush($ownerEmail, chatDisplayName($callerEmail), $msgContent, $convId);
    } catch (\Throwable $e) {}

    jsonResponse(true, ['message_id' => $msgId, 'conversation_id' => $convId]);
    break;
}
```

---

### 2. `status_react` — emoji reaction to a status

Stores in `chat_status_reactions` (auto-created) and sends the emoji as a
chat message. Sending the same emoji again toggles it off.

**Request** (POST JSON):
```json
{ "action": "status_react", "status_id": 42, "emoji": "\u2764\uFE0F" }
```
**Response (reacted)**:
```json
{ "success": true, "data": { "reacted": true, "emoji": "\u2764\uFE0F", "message_id": 9872 } }
```
**Response (toggled off)**:
```json
{ "success": true, "data": { "reacted": false, "emoji": "\u2764\uFE0F" } }
```

**PHP** (paste after `status_reply` case):
```php
case 'status_react': {
    $user = requireChatAuth();
    $input = getInput();
    $statusId = (int)($input['status_id'] ?? 0);
    $emoji    = strip_tags(trim($input['emoji'] ?? ''));

    if ($statusId <= 0)          jsonResponse(false, null, 'status_id required', 400);
    if ($emoji === '')           jsonResponse(false, null, 'emoji required', 400);
    if (mb_strlen($emoji) > 20) jsonResponse(false, null, 'emoji too long', 400);

    // Auto-create table (idempotent in PostgreSQL)
    $db->exec("CREATE TABLE IF NOT EXISTS chat_status_reactions (
        id SERIAL PRIMARY KEY,
        status_id INTEGER NOT NULL,
        reactor_email TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(status_id, reactor_email, emoji)
    )");

    $sStmt = $db->prepare("SELECT id, email, type, content FROM chat_user_status WHERE id=:id AND expires_at>NOW()");
    $sStmt->execute([':id' => $statusId]);
    $statusRow = $sStmt->fetch(PDO::FETCH_ASSOC);
    if (!$statusRow) jsonResponse(false, null, 'Status not found or expired', 404);

    $ownerEmail  = strtolower($statusRow['email']);
    $callerEmail = strtolower($user['email']);

    // Block check
    $blkStmt = $db->prepare("SELECT 1 FROM chat_blocked_users WHERE (blocker_email=:a AND blocked_email=:b) OR (blocker_email=:b AND blocked_email=:a) LIMIT 1");
    $blkStmt->execute([':a' => $ownerEmail, ':b' => $callerEmail]);
    if ($blkStmt->fetch()) jsonResponse(false, null, 'Not authorized', 403);

    // Toggle off if already reacted with same emoji
    $chkStmt = $db->prepare("SELECT id FROM chat_status_reactions WHERE status_id=:s AND reactor_email=:e AND emoji=:emoji");
    $chkStmt->execute([':s' => $statusId, ':e' => $callerEmail, ':emoji' => $emoji]);
    if ($existing = $chkStmt->fetch(PDO::FETCH_ASSOC)) {
        $db->prepare("DELETE FROM chat_status_reactions WHERE id=:id")->execute([':id' => $existing['id']]);
        jsonResponse(true, ['reacted' => false, 'emoji' => $emoji]);
        break;
    }

    // Insert reaction
    $db->prepare("INSERT INTO chat_status_reactions (status_id,reactor_email,emoji) VALUES (:s,:e,:emoji) ON CONFLICT DO NOTHING")
       ->execute([':s' => $statusId, ':e' => $callerEmail, ':emoji' => $emoji]);

    $msgId = 0;
    if ($ownerEmail !== $callerEmail) {
        // Find or create direct conversation (same logic as status_reply)
        $convStmt = $db->prepare("
            SELECT c.id FROM chat_conversations c
            JOIN chat_conversation_members m1 ON m1.conversation_id=c.id AND LOWER(m1.email)=:a
            JOIN chat_conversation_members m2 ON m2.conversation_id=c.id AND LOWER(m2.email)=:b
            WHERE c.type='direct' LIMIT 1
        ");
        $convStmt->execute([':a' => $callerEmail, ':b' => $ownerEmail]);
        $convRow = $convStmt->fetch(PDO::FETCH_ASSOC);
        if ($convRow) {
            $convId = (int)$convRow['id'];
        } else {
            $db->prepare("INSERT INTO chat_conversations (name,type,created_by,created_at) VALUES ('','direct',:cb,NOW())")->execute([':cb' => $callerEmail]);
            $convId = (int)$db->lastInsertId();
            $db->prepare("INSERT INTO chat_conversation_members (conversation_id,email,role,joined_at) VALUES (:c,:e1,'member',NOW()),(:c,:e2,'member',NOW())")->execute([':c' => $convId, ':e1' => $callerEmail, ':e2' => $ownerEmail]);
        }

        $replyLabel = "\u{21A9}\u{FE0F} Reagiu ao seu status";
        $msgContent = "{$emoji} {$replyLabel}";
        $clientMsgId = bin2hex(random_bytes(8));
        $insStmt = $db->prepare("INSERT INTO chat_messages (conversation_id,sender_email,content,type,created_at,client_message_id) VALUES (:cid,:email,:content,'text',NOW(),:cmid) RETURNING id");
        $insStmt->execute([':cid' => $convId, ':email' => $callerEmail, ':content' => $msgContent, ':cmid' => $clientMsgId]);
        $msgId = (int)($insStmt->fetchColumn() ?: 0);

        $db->prepare("UPDATE chat_conversations SET updated_at=NOW() WHERE id=:id")->execute([':id' => $convId]);

        // Push (best-effort)
        try {
            require_once __DIR__ . '/push-notify-functions.php';
            if (function_exists('sendChatPush')) sendChatPush($ownerEmail, chatDisplayName($callerEmail), $msgContent, $convId);
        } catch (\Throwable $e) {}
    }

    jsonResponse(true, ['reacted' => true, 'emoji' => $emoji, 'message_id' => $msgId]);
    break;
}
```

---

## New DB table (auto-created on first use)

```sql
CREATE TABLE IF NOT EXISTS chat_status_reactions (
    id            SERIAL PRIMARY KEY,
    status_id     INTEGER NOT NULL,
    reactor_email TEXT    NOT NULL,
    emoji         TEXT    NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(status_id, reactor_email, emoji)
);
CREATE INDEX IF NOT EXISTS idx_status_reactions_status ON chat_status_reactions(status_id);
```

The `CREATE TABLE IF NOT EXISTS` inside the PHP case handles creation
automatically on first call. Run the SQL directly to create it ahead of time.

---

## api.js additions

Add after `statusViewers` in `/root/webmail-app/services/api.js`:

```js
export async function statusReply(statusId, text) {
  return apiCall('status_reply', { status_id: statusId, text }, 'POST');
}

export async function statusReact(statusId, emoji) {
  return apiCall('status_react', { status_id: statusId, emoji }, 'POST');
}
```

`StatusReplyInput.js` uses `api.apiCall('status_react', ...)` inline as a
fallback so the component works even before this export is added.

---

## i18n keys to add (all 3 language files: pt-BR.js, en.js, es.js)

| Key | pt-BR | en | es |
|-----|-------|----|----|
| `status.replyPlaceholder` | Responder ao status... | Reply to status... | Responder al estado... |
| `status.replyHint` | Enviar resposta para {name} | Send a reply to {name} | Enviar respuesta a {name} |
| `status.viewersList` | Lista de visualizacoes | Status viewers list | Lista de visitas |
| `status.viewersHint` | Quando alguem vir seu status, aparece aqui. | When someone views your status it appears here. | Cuando alguien ve tu estado aparece aqui. |
| `status.viewersError` | Nao foi possivel carregar visualizacoes. | Could not load viewers. | No se pudieron cargar las vistas. |

---

## Security properties

| Concern | Handling |
|---|---|
| Auth | `requireChatAuth()` on both endpoints |
| IDOR | Status owner fetched from DB, never trusted from client |
| Privacy | Block table checked before any action |
| Own-status | `status_reply` rejects caller == owner; `status_react` skips chat delivery for own status |
| Emoji injection | `strip_tags()` + 20-char max |
| Text length | 2000-char cap on reply text |
| Reaction toggle | Same user + same emoji = idempotent toggle-off |
| Push delivery | Wrapped in try/catch — never causes request failure |
