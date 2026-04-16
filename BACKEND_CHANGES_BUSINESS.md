# Backend Changes — WhatsApp Business Features

## SQL Schema

Run these on the PostgreSQL master (US Central). Connect as the mail DB user.

```sql
-- ─── 1. Business Profiles ───────────────────────────────────────────────────
CREATE TABLE business_profiles (
    id              SERIAL PRIMARY KEY,
    email           VARCHAR(255) NOT NULL UNIQUE,
    company_name    VARCHAR(255) NOT NULL DEFAULT '',
    description     TEXT DEFAULT '',
    address         VARCHAR(500) DEFAULT '',
    website         VARCHAR(500) DEFAULT '',
    category        VARCHAR(100) DEFAULT '',
    hours           VARCHAR(255) DEFAULT '',
    phone           VARCHAR(50) DEFAULT '',
    logo_url        TEXT DEFAULT '',
    cover_url       TEXT DEFAULT '',
    is_verified     BOOLEAN NOT NULL DEFAULT FALSE,
    product_count   INT NOT NULL DEFAULT 0,
    order_count     INT NOT NULL DEFAULT 0,
    rating          NUMERIC(3,2) DEFAULT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_business_profiles_email ON business_profiles(email);


-- ─── 2. Business Products ────────────────────────────────────────────────────
-- stock NULL = unlimited.
CREATE TABLE business_products (
    id              SERIAL PRIMARY KEY,
    owner_email     VARCHAR(255) NOT NULL,
    name            VARCHAR(255) NOT NULL,
    description     TEXT DEFAULT '',
    price           NUMERIC(12,2) NOT NULL DEFAULT 0,
    photo_url       TEXT DEFAULT '',
    stock           INT DEFAULT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_business_products_owner  ON business_products(owner_email);
CREATE INDEX idx_business_products_active ON business_products(owner_email, is_active);


-- ─── 3. Business Orders ──────────────────────────────────────────────────────
-- Items stored as JSONB: [{product_id, name, qty, price}]
CREATE TABLE business_orders (
    id              SERIAL PRIMARY KEY,
    buyer_email     VARCHAR(255) NOT NULL,
    seller_email    VARCHAR(255) NOT NULL,
    items           JSONB NOT NULL DEFAULT '[]',
    total           NUMERIC(12,2) NOT NULL DEFAULT 0,
    note            TEXT DEFAULT '',
    status          VARCHAR(50) NOT NULL DEFAULT 'pending',
    conversation_id INT DEFAULT NULL,
    message_id      BIGINT DEFAULT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_business_orders_buyer  ON business_orders(buyer_email);
CREATE INDEX idx_business_orders_seller ON business_orders(seller_email);
CREATE INDEX idx_business_orders_status ON business_orders(seller_email, status);


-- ─── 4. Auto-Replies ─────────────────────────────────────────────────────────
CREATE TABLE business_auto_replies (
    id                  SERIAL PRIMARY KEY,
    email               VARCHAR(255) NOT NULL UNIQUE,
    greeting_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
    greeting_message    TEXT DEFAULT '',
    away_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
    away_message        TEXT DEFAULT '',
    away_schedule       VARCHAR(50) NOT NULL DEFAULT 'always',
    away_start_time     TIME DEFAULT NULL,
    away_end_time       TIME DEFAULT NULL,
    away_days           VARCHAR(50) DEFAULT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE business_quick_replies (
    id          SERIAL PRIMARY KEY,
    email       VARCHAR(255) NOT NULL,
    shortcut    VARCHAR(50) NOT NULL,
    message     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (email, shortcut)
);
CREATE INDEX idx_business_qr_email ON business_quick_replies(email);


-- ─── 5. Business Labels ──────────────────────────────────────────────────────
CREATE TABLE business_labels (
    id          SERIAL PRIMARY KEY,
    email       VARCHAR(255) NOT NULL,
    name        VARCHAR(100) NOT NULL,
    color       VARCHAR(20) NOT NULL DEFAULT '#22c55e',
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (email, name)
);
CREATE INDEX idx_business_labels_email ON business_labels(email);

CREATE TABLE business_conversation_labels (
    label_id        INT NOT NULL REFERENCES business_labels(id) ON DELETE CASCADE,
    conversation_id INT NOT NULL,
    assigned_by     VARCHAR(255) NOT NULL,
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (label_id, conversation_id)
);
CREATE INDEX idx_bcl_conversation ON business_conversation_labels(conversation_id);
```


## Endpoints Needed

All route through `email.php?action=<action>` to a new `business.php` include (same pattern as chat.php, meet.php, docs.php).

### Profile
| action | method | params | description |
|--------|--------|--------|-------------|
| `business_get_profile` | GET | — | Return own profile; auto-create row if absent |
| `business_save_profile` | POST | company_name, description, address, website, category, hours, phone | Upsert |
| `business_upload_product_photo` | POST multipart | photo (file) | Upload to R2; return `data.url` CDN URL |

### Products
| action | method | params | description |
|--------|--------|--------|-------------|
| `business_list_products` | GET | search? | Active products ordered by sort_order |
| `business_add_product` | POST | name, description, price, photo_url, stock | Insert + bump profile.product_count |
| `business_update_product` | POST | product_id, ...fields | Update (ownership check) |
| `business_delete_product` | POST | product_id | Soft-delete (is_active=false), decrement count |

### Orders
| action | method | params | description |
|--------|--------|--------|-------------|
| `business_place_order` | POST | items[], total, note, message | Insert order; send order message to seller DM via chat; increment seller.order_count |

### Auto-Replies
| action | method | params | description |
|--------|--------|--------|-------------|
| `business_get_autoreplies` | GET | — | Return settings + quick_replies[] |
| `business_save_autoreplies` | POST | greeting_enabled, greeting_message, away_enabled, away_message, away_schedule | Upsert |
| `business_add_quick_reply` | POST | shortcut, message | Insert |
| `business_update_quick_reply` | POST | id, shortcut, message | Update (ownership check) |
| `business_delete_quick_reply` | POST | id | Delete (ownership check) |

### Labels
| action | method | params | description |
|--------|--------|--------|-------------|
| `business_list_labels` | GET | — | Labels + chat_count via LEFT JOIN |
| `business_add_label` | POST | name, color | Insert |
| `business_update_label` | POST | label_id, name, color | Update (ownership check) |
| `business_delete_label` | POST | label_id | Delete + cascade |
| `business_assign_label` | POST | conversation_id, label_id | Assign label to conversation |
| `business_remove_label` | POST | conversation_id, label_id | Remove label |


## Auto-Reply Hook (in chat.php chat_send handler)

After saving the incoming message, check if the receiver has auto-reply configured:

```php
// After message INSERT in chat_send:
$bizReply = _loadBusinessAutoReply($pg, $receiverEmail);
if ($bizReply) {
    $isNew = _isFirstMessage($pg, $senderEmail, $receiverEmail);
    $replyText = null;
    if ($bizReply['greeting_enabled'] && $isNew) {
        $replyText = $bizReply['greeting_message'];
    } elseif ($bizReply['away_enabled'] && _isBizCurrentlyAway($bizReply)) {
        $replyText = $bizReply['away_message'];
    }
    if ($replyText) {
        _insertAutoReplyMessage($pg, $conversationId, $receiverEmail, $replyText);
    }
}

function _isBizCurrentlyAway(array $s): bool {
    if ($s['away_schedule'] === 'always') return true;
    $now = new DateTime('now', new DateTimeZone('America/Sao_Paulo'));
    if ($s['away_schedule'] === 'outside_hours' && $s['away_start_time'] && $s['away_end_time']) {
        $start = DateTime::createFromFormat('H:i:s', $s['away_start_time']);
        $end   = DateTime::createFromFormat('H:i:s', $s['away_end_time']);
        $t     = DateTime::createFromFormat('H:i:s', $now->format('H:i:s'));
        return !($t >= $start && $t <= $end);
    }
    return false;
}
```


## Photo Upload

Reuse `s3Upload()` from `drive.php`. Store key: `business-products/{md5(email)}/{random_hex}.jpg`.
Return CDN URL in `data.url`. Validate MIME with `mime_content_type()`. Apply same extension blocklist as chat.php (php, sh, exe, html, svg, js, etc.).


## Verified Badge — Admin Endpoint

In `admin.php`, add:

```php
case 'business_verify_profile':
    requireAdmin();
    $email    = filter_var(getInput('email'), FILTER_VALIDATE_EMAIL);
    $verified = (int)getInput('verified') ? true : false;
    if (!$email) { jsonResponse(false, 'Invalid email'); }
    pg_query_params($pg,
        "UPDATE business_profiles SET is_verified=$2, updated_at=NOW() WHERE email=$1",
        [$email, $verified ? 't' : 'f']
    );
    jsonResponse(true, 'Profile verification updated');
```


## File to Create

Create `/var/www/mail/api/business.php` with all the above actions. Include it from `email.php` with:

```php
// In email.php action router (after chat.php include):
if (str_starts_with($action, 'business_')) {
    require_once __DIR__ . '/business.php';
    exit;
}
```
