# Marketplace Backend Changes

## New file: `/var/www/mail/api/marketplace.php`

Handles all marketplace actions. Auto-creates PostgreSQL schema on first call.

---

## SQL Schema

```sql
-- Listings
CREATE TABLE IF NOT EXISTS marketplace_listings (
    id          SERIAL PRIMARY KEY,
    seller_email TEXT NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT DEFAULT '',
    price_cents  BIGINT NOT NULL DEFAULT 0,     -- price in BRL centavos (e.g. 150000 = R$1.500,00)
    currency     VARCHAR(3) NOT NULL DEFAULT 'BRL',
    category     TEXT NOT NULL DEFAULT 'Outros', -- Eletrônicos|Veículos|Imóveis|Roupas|Serviços|Outros
    location     TEXT DEFAULT '',
    status       VARCHAR(20) NOT NULL DEFAULT 'active', -- active|sold|deleted
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_listings_seller   ON marketplace_listings(seller_email);
CREATE INDEX IF NOT EXISTS idx_mkt_listings_status   ON marketplace_listings(status);
CREATE INDEX IF NOT EXISTS idx_mkt_listings_category ON marketplace_listings(category);
CREATE INDEX IF NOT EXISTS idx_mkt_listings_created  ON marketplace_listings(created_at DESC);

-- Listing photos
CREATE TABLE IF NOT EXISTS marketplace_photos (
    id         SERIAL PRIMARY KEY,
    listing_id INTEGER NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mkt_photos_listing ON marketplace_photos(listing_id);

-- Saved / favorited listings
CREATE TABLE IF NOT EXISTS marketplace_favorites (
    id         SERIAL PRIMARY KEY,
    listing_id INTEGER NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    email      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(listing_id, email)
);
CREATE INDEX IF NOT EXISTS idx_mkt_fav_email ON marketplace_favorites(email);

-- Buyer offers
CREATE TABLE IF NOT EXISTS marketplace_offers (
    id           SERIAL PRIMARY KEY,
    listing_id   INTEGER NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    buyer_email  TEXT NOT NULL,
    amount_cents BIGINT NOT NULL,              -- offer amount in centavos
    message      TEXT DEFAULT '',
    status       VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|accepted|rejected
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_offers_listing ON marketplace_offers(listing_id);
CREATE INDEX IF NOT EXISTS idx_mkt_offers_buyer   ON marketplace_offers(buyer_email);
```

---

## Endpoints (all require Bearer auth, routed through email.php)

| Action | Method | Description |
|--------|--------|-------------|
| `marketplace_list` | GET | List active listings. Params: `search`, `category`, `limit`, `offset` |
| `marketplace_create` | POST | Create a new listing. Body: `title`, `description`, `price_cents`, `category`, `location`, `photos[]` |
| `marketplace_detail` | GET | Full detail for one listing. Param: `listing_id` |
| `marketplace_favorite` | POST | Toggle save/unsave a listing. Param: `listing_id` |
| `marketplace_offer` | POST | Submit a buyer offer. Params: `listing_id`, `amount_cents`, `message` |
| `marketplace_my_listings` | GET | List all listings by the authenticated seller |
| `marketplace_saved` | GET | List all listings saved/favorited by the authenticated user |
| `marketplace_delete` | POST | Soft-delete a listing (only seller). Param: `listing_id` |

---

## Changes to `email.php`

1. Added 8 marketplace actions to the auth-required actions array (near line 1840).
2. Added `case` entries in the main switch dispatcher to `require_once marketplace.php` and call `handleMarketplaceAction($action)`.

---

## Notes

- Price is stored as integer centavos (`price_cents`). Frontend formats as R$ using `toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })`.
- Photos are stored as URLs (CDN/R2 links). Up to 10 photos per listing.
- `status = 'deleted'` is used for soft-delete to preserve offer history.
- Seller rating table not implemented yet — `seller_rating` returns `null`, `seller_reviews` returns `0`. Extend with a `marketplace_ratings` table when needed.
- Schema is auto-created on first call via `marketplaceEnsureSchema()` — no manual migration needed.
