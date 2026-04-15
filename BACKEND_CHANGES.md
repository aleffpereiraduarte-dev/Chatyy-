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
