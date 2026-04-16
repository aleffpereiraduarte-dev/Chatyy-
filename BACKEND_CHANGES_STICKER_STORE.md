# Backend Changes — Sticker Pack Store

## Overview

This document describes the SQL schema, seed data, and PHP handler additions required to
power the Sticker Pack Store in `components/StickerStore.js`. All changes belong in
`/var/www/mail/api/chat.php` (schema bootstrapped on first request via
`ensureStickerTables()`, matching the pattern used for `feed_posts`, `live_sessions`, etc.).

---

## 1. SQL Schema

### 1.1 `sticker_packs`

Stores every pack available in the store (default packs + user-created packs).

```sql
CREATE TABLE IF NOT EXISTS sticker_packs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    author        TEXT    NOT NULL DEFAULT 'Chatyy',
    cover_url     TEXT,
    cover_emoji   TEXT,
    sticker_count INTEGER NOT NULL DEFAULT 0,
    category      TEXT    NOT NULL DEFAULT 'emoji',
    is_premium    INTEGER NOT NULL DEFAULT 0,  -- 1 = premium/paid
    is_featured   INTEGER NOT NULL DEFAULT 0,  -- 1 = shown in "Em destaque"
    owner_email   TEXT,                        -- NULL = official pack, email = user-created
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_sticker_packs_category  ON sticker_packs(category);
CREATE INDEX IF NOT EXISTS idx_sticker_packs_featured  ON sticker_packs(is_featured);
CREATE INDEX IF NOT EXISTS idx_sticker_packs_owner     ON sticker_packs(owner_email);
```

### 1.2 `sticker_items`

Each row is one sticker belonging to a pack.

```sql
CREATE TABLE IF NOT EXISTS sticker_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pack_id    INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
    url        TEXT,              -- CDN URL for image/animated sticker (NULL for emoji-only)
    emoji_tag  TEXT,              -- Emoji character OR keyword hint (e.g. '😀', ':smile:')
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_sticker_items_pack  ON sticker_items(pack_id, sort_order);
```

### 1.3 `user_sticker_packs`

Tracks which packs each user has installed.

```sql
CREATE TABLE IF NOT EXISTS user_sticker_packs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    email        TEXT    NOT NULL,
    pack_id      INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
    installed_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(email, pack_id)
);

CREATE INDEX IF NOT EXISTS idx_user_sticker_packs_email    ON user_sticker_packs(email);
CREATE INDEX IF NOT EXISTS idx_user_sticker_packs_pack_id  ON user_sticker_packs(pack_id);
```

---

## 2. Seed Data — 3 Default Packs

Run once during schema bootstrap, guarded by a count check so it stays idempotent.

```sql
-- ── Pack 1: Smileys Classicos ──────────────────────────────────────────────
INSERT OR IGNORE INTO sticker_packs (id, name, author, cover_emoji, sticker_count, category, is_featured)
VALUES (1, 'Smileys Classicos', 'Chatyy', '😀', 32, 'emoji', 1);

INSERT OR IGNORE INTO sticker_items (pack_id, emoji_tag, sort_order) VALUES
(1,'😀',1),(1,'😂',2),(1,'🤣',3),(1,'😊',4),(1,'🥰',5),
(1,'😎',6),(1,'😢',7),(1,'😭',8),(1,'😡',9),(1,'🤔',10),
(1,'🙄',11),(1,'😴',12),(1,'🤯',13),(1,'🥳',14),(1,'🤮',15),
(1,'😱',16),(1,'🥺',17),(1,'😏',18),(1,'🤗',19),(1,'😤',20),
(1,'😈',21),(1,'🤡',22),(1,'💀',23),(1,'👻',24),(1,'🫠',25),
(1,'😮',26),(1,'🫣',27),(1,'🫡',28),(1,'🤭',29),(1,'🥹',30),
(1,'😵',31),(1,'🫥',32);

-- ── Pack 2: Gestos & Maos ──────────────────────────────────────────────────
INSERT OR IGNORE INTO sticker_packs (id, name, author, cover_emoji, sticker_count, category, is_featured)
VALUES (2, 'Gestos & Maos', 'Chatyy', '👍', 32, 'emoji', 1);

INSERT OR IGNORE INTO sticker_items (pack_id, emoji_tag, sort_order) VALUES
(2,'👍',1),(2,'👎',2),(2,'👋',3),(2,'✌️',4),(2,'🤞',5),
(2,'🤝',6),(2,'👏',7),(2,'🙏',8),(2,'💪',9),(2,'🤙',10),
(2,'👌',11),(2,'🫶',12),(2,'🤟',13),(2,'🫡',14),(2,'🫰',15),
(2,'👊',16),(2,'✊',17),(2,'🤜',18),(2,'🤛',19),(2,'👆',20),
(2,'👇',21),(2,'👈',22),(2,'👉',23),(2,'🤚',24),(2,'✋',25),
(2,'🖐️',26),(2,'🫱',27),(2,'🫲',28),(2,'🤌',29),(2,'🫳',30),
(2,'🫴',31),(2,'🤏',32);

-- ── Pack 3: Festa & Diversao ───────────────────────────────────────────────
INSERT OR IGNORE INTO sticker_packs (id, name, author, cover_emoji, sticker_count, category, is_featured)
VALUES (3, 'Festa & Diversao', 'Chatyy', '🎉', 32, 'emoji', 0);

INSERT OR IGNORE INTO sticker_items (pack_id, emoji_tag, sort_order) VALUES
(3,'🎉',1),(3,'🎊',2),(3,'🎈',3),(3,'🎁',4),(3,'🏆',5),
(3,'🥇',6),(3,'⚽',7),(3,'🏀',8),(3,'🎮',9),(3,'🎯',10),
(3,'🎲',11),(3,'🎭',12),(3,'🎬',13),(3,'🎵',14),(3,'🎶',15),
(3,'🎸',16),(3,'🎤',17),(3,'🎧',18),(3,'🎺',19),(3,'🥁',20),
(3,'💃',21),(3,'🕺',22),(3,'🏖️',23),(3,'🏔️',24),(3,'🌈',25),
(3,'☀️',26),(3,'🎪',27),(3,'🎡',28),(3,'🛼',29),(3,'🏄',30),
(3,'🎳',31),(3,'🧗',32);
```

---

## 3. PHP Handler — `chat.php` additions

Add `ensureStickerTables()` to the existing schema bootstrap block, then add the
action handlers inside the main `switch ($action)` dispatcher.

### 3.1 Schema bootstrap helper

```php
function ensureStickerTables(PDO $db): void {
    $db->exec("
        CREATE TABLE IF NOT EXISTS sticker_packs (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            name          TEXT    NOT NULL,
            author        TEXT    NOT NULL DEFAULT 'Chatyy',
            cover_url     TEXT,
            cover_emoji   TEXT,
            sticker_count INTEGER NOT NULL DEFAULT 0,
            category      TEXT    NOT NULL DEFAULT 'emoji',
            is_premium    INTEGER NOT NULL DEFAULT 0,
            is_featured   INTEGER NOT NULL DEFAULT 0,
            owner_email   TEXT,
            created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
            updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_sticker_packs_category ON sticker_packs(category);
        CREATE INDEX IF NOT EXISTS idx_sticker_packs_featured ON sticker_packs(is_featured);
        CREATE INDEX IF NOT EXISTS idx_sticker_packs_owner    ON sticker_packs(owner_email);

        CREATE TABLE IF NOT EXISTS sticker_items (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            pack_id    INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
            url        TEXT,
            emoji_tag  TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_sticker_items_pack ON sticker_items(pack_id, sort_order);

        CREATE TABLE IF NOT EXISTS user_sticker_packs (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            email        TEXT    NOT NULL,
            pack_id      INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
            installed_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
            UNIQUE(email, pack_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_sticker_packs_email   ON user_sticker_packs(email);
        CREATE INDEX IF NOT EXISTS idx_user_sticker_packs_pack_id ON user_sticker_packs(pack_id);
    ");

    // Seed default packs once (idempotent guard)
    $count = (int)$db->query("SELECT COUNT(*) FROM sticker_packs WHERE id <= 3")->fetchColumn();
    if ($count === 0) {
        // paste INSERT OR IGNORE statements from section 2 here
    }
}
```

### 3.2 Action: `sticker_store_list`

Lists packs with optional search/category filtering and pagination.
Params: `search`, `category`, `offset`, `limit`.

```php
case 'sticker_store_list': {
    require_auth();
    ensureStickerTables($chatDb);
    $search   = trim($_REQUEST['search']   ?? '');
    $category = trim($_REQUEST['category'] ?? '');
    $offset   = max(0, (int)($_REQUEST['offset'] ?? 0));
    $limit    = min(50, max(1, (int)($_REQUEST['limit'] ?? 20)));

    $where  = ['1=1'];
    $params = [];
    if ($search !== '') {
        $where[]  = "(sp.name LIKE :search OR sp.author LIKE :search)";
        $params[':search'] = '%' . $search . '%';
    }
    if ($category !== '') {
        $where[]  = "sp.category = :category";
        $params[':category'] = $category;
    }
    $whereStr = implode(' AND ', $where);

    $stmt = $chatDb->prepare("
        SELECT sp.*, COUNT(usp.id) AS install_count
        FROM   sticker_packs sp
        LEFT JOIN user_sticker_packs usp ON usp.pack_id = sp.id
        WHERE  $whereStr
        GROUP  BY sp.id
        ORDER  BY sp.is_featured DESC, install_count DESC, sp.created_at DESC
        LIMIT  :limit OFFSET :offset
    ");
    foreach ($params as $k => $v) $stmt->bindValue($k, $v);
    $stmt->bindValue(':limit',  $limit,  PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();
    $packs = $stmt->fetchAll(PDO::FETCH_ASSOC);

    foreach ($packs as &$pack) {
        $pack['is_premium']  = (bool)$pack['is_premium'];
        $pack['is_featured'] = (bool)$pack['is_featured'];
        $prev = $chatDb->prepare("SELECT url, emoji_tag FROM sticker_items
                                  WHERE pack_id = ? ORDER BY sort_order LIMIT 5");
        $prev->execute([$pack['id']]);
        $pack['preview_stickers'] = $prev->fetchAll(PDO::FETCH_ASSOC);
    }
    unset($pack);

    json_out(['success' => true, 'packs' => $packs, 'has_more' => count($packs) >= $limit]);
}
```

### 3.3 Action: `sticker_pack_detail`

Returns all stickers in a pack. Params: `pack_id`.

```php
case 'sticker_pack_detail': {
    require_auth();
    ensureStickerTables($chatDb);
    $packId = (int)($_REQUEST['pack_id'] ?? 0);
    if (!$packId) json_error('pack_id required');

    $ps = $chatDb->prepare("SELECT * FROM sticker_packs WHERE id = ?");
    $ps->execute([$packId]);
    $pack = $ps->fetch(PDO::FETCH_ASSOC);
    if (!$pack) json_error('Pack not found', 404);

    $is = $chatDb->prepare("SELECT url, emoji_tag, sort_order FROM sticker_items
                             WHERE pack_id = ? ORDER BY sort_order");
    $is->execute([$packId]);
    $pack['stickers']    = $is->fetchAll(PDO::FETCH_ASSOC);
    $pack['is_premium']  = (bool)$pack['is_premium'];
    $pack['is_featured'] = (bool)$pack['is_featured'];
    json_out(['success' => true] + $pack);
}
```

### 3.4 Action: `sticker_featured`

Returns up to 10 packs flagged `is_featured = 1`.

```php
case 'sticker_featured': {
    require_auth();
    ensureStickerTables($chatDb);
    $stmt  = $chatDb->query("SELECT * FROM sticker_packs
                              WHERE is_featured = 1 ORDER BY updated_at DESC LIMIT 10");
    $packs = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($packs as &$p) {
        $p['is_premium']  = (bool)$p['is_premium'];
        $p['is_featured'] = (bool)$p['is_featured'];
    }
    unset($p);
    json_out(['success' => true, 'packs' => $packs]);
}
```

### 3.5 Action: `sticker_my_packs`

Returns all packs the current user has installed.

```php
case 'sticker_my_packs': {
    require_auth();
    ensureStickerTables($chatDb);
    $email = get_auth_email();
    $stmt  = $chatDb->prepare("
        SELECT sp.*, usp.installed_at
        FROM   user_sticker_packs usp
        JOIN   sticker_packs sp ON sp.id = usp.pack_id
        WHERE  usp.email = ?
        ORDER  BY usp.installed_at DESC
    ");
    $stmt->execute([$email]);
    $packs = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($packs as &$p) {
        $p['is_premium']  = (bool)$p['is_premium'];
        $p['is_featured'] = (bool)$p['is_featured'];
    }
    unset($p);
    json_out(['success' => true, 'packs' => $packs]);
}
```

### 3.6 Action: `sticker_install`

Installs a pack for the current user. Params: `pack_id`.

```php
case 'sticker_install': {
    require_auth();
    ensureStickerTables($chatDb);
    $email  = get_auth_email();
    $packId = (int)($_REQUEST['pack_id'] ?? 0);
    if (!$packId) json_error('pack_id required');

    $exists = $chatDb->prepare("SELECT id FROM sticker_packs WHERE id = ?");
    $exists->execute([$packId]);
    if (!$exists->fetch()) json_error('Pack not found', 404);

    $chatDb->prepare("INSERT OR IGNORE INTO user_sticker_packs (email, pack_id) VALUES (?, ?)")
           ->execute([$email, $packId]);
    json_out(['success' => true, 'installed' => true]);
}
```

### 3.7 Action: `sticker_uninstall`

Removes an installed pack for the current user. Params: `pack_id`.

```php
case 'sticker_uninstall': {
    require_auth();
    ensureStickerTables($chatDb);
    $email  = get_auth_email();
    $packId = (int)($_REQUEST['pack_id'] ?? 0);
    if (!$packId) json_error('pack_id required');

    $chatDb->prepare("DELETE FROM user_sticker_packs WHERE email = ? AND pack_id = ?")
           ->execute([$email, $packId]);
    json_out(['success' => true, 'removed' => true]);
}
```

### 3.8 Action: `sticker_create_pack`

Creates a custom pack owned by the current user, auto-installs it.
Params: `name`, `cover_url` (optional), `sticker_urls` (JSON array of CDN URLs).

```php
case 'sticker_create_pack': {
    require_auth();
    ensureStickerTables($chatDb);
    $email    = get_auth_email();
    $name     = trim($_REQUEST['name'] ?? '');
    $coverUrl = trim($_REQUEST['cover_url'] ?? '');
    $urlsRaw  = $_REQUEST['sticker_urls'] ?? '[]';

    if (!$name) json_error('name required');
    if (mb_strlen($name) > 40) json_error('name too long (max 40)');

    $urls = is_array($urlsRaw) ? $urlsRaw : (json_decode($urlsRaw, true) ?: []);
    $urls = array_values(array_filter(array_map('trim', $urls)));
    if (count($urls) < 1)  json_error('at least 1 sticker required');
    if (count($urls) > 30) json_error('max 30 stickers per pack');

    // SSRF guard — only allow our own CDN
    $allowed = ['https://media.chatyy.com.br/', 'https://chatyy.com.br/'];
    foreach ($urls as $u) {
        $ok = false;
        foreach ($allowed as $p) { if (str_starts_with($u, $p)) { $ok = true; break; } }
        if (!$ok) json_error('invalid sticker URL');
    }
    if ($coverUrl) {
        $ok = false;
        foreach ($allowed as $p) { if (str_starts_with($coverUrl, $p)) { $ok = true; break; } }
        if (!$ok) $coverUrl = '';
    }

    // Per-user custom pack limit
    $cnt = $chatDb->prepare("SELECT COUNT(*) FROM sticker_packs WHERE owner_email = ?");
    $cnt->execute([$email]);
    if ((int)$cnt->fetchColumn() >= 20) json_error('max 20 custom packs per user');

    $chatDb->beginTransaction();
    try {
        $ins = $chatDb->prepare("
            INSERT INTO sticker_packs (name, author, cover_url, sticker_count, category, owner_email)
            VALUES (?, ?, ?, ?, 'custom', ?)
        ");
        $ins->execute([$name, $email, $coverUrl ?: null, count($urls), $email]);
        $packId = (int)$chatDb->lastInsertId();

        $itemIns = $chatDb->prepare(
            "INSERT INTO sticker_items (pack_id, url, sort_order) VALUES (?, ?, ?)"
        );
        foreach ($urls as $i => $u) $itemIns->execute([$packId, $u, $i + 1]);

        $chatDb->prepare("INSERT OR IGNORE INTO user_sticker_packs (email, pack_id) VALUES (?, ?)")
               ->execute([$email, $packId]);
        $chatDb->commit();
    } catch (Exception $e) {
        $chatDb->rollBack();
        json_error('Failed to create pack: ' . $e->getMessage());
    }

    $pack = $chatDb->query("SELECT * FROM sticker_packs WHERE id = $packId")->fetch(PDO::FETCH_ASSOC);
    $pack['stickers'] = array_map(fn($u) => ['url' => $u, 'emoji_tag' => null], $urls);
    json_out(['success' => true, 'pack' => $pack]);
}
```

---

## 4. File Storage

Custom sticker uploads reuse the existing `/api/rust/upload` endpoint with
`context=sticker`. No new directories are needed — files land in the existing
`chatyy-media` R2 bucket under the `stickers/` prefix.

---

## 5. Security Notes

| Risk | Mitigation |
|------|------------|
| SSRF via sticker URLs | CDN allowlist in `sticker_create_pack` |
| DB bloat from user packs | Max 20 custom packs + 30 stickers per pack per user |
| SQL injection | All IDs cast `(int)`, all strings via PDO `?` placeholders |
| Auth bypass | `require_auth()` + `get_auth_email()` on every action |
| Pack ownership | `sticker_install/uninstall` scoped strictly to authenticated email |
