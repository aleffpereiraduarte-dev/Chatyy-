<?php
/**
 * cron-chat-envelope-gc.php — Stage 7 SQLite-first chat migration (2026-05-16)
 *
 * Retention policy for the `chat_pending_envelopes` PG table.
 *
 * Background (Stages 5/6/7 design):
 *   - Stage 1: services/api.js `chatSend` writes a local SQLite row FIRST.
 *   - Stage 5: with the `__chatyy_envelope_mode` feature flag ON, `chatSend`
 *     skips the legacy plaintext `chat_send` path entirely and uploads
 *     per-recipient-device ciphertexts to `chat_envelope_send`. Rows land
 *     in `chat_pending_envelopes` (NOT `chat_messages`) with a default
 *     `expires_at = NOW() + INTERVAL '30 days'`.
 *   - Stage 6 will roll the flag default-ON per account.
 *   - Stage 7 (THIS SCRIPT) enforces the WhatsApp-style retention:
 *       * envelope rows whose `expires_at` has passed → dropped (TTL).
 *       * envelope rows that have been `delivered_at`-stamped AND have
 *         sat for 7 days afterwards → dropped (post-delivery grace).
 *       * envelope rows older than 30 days that were NEVER acked by the
 *         target device (no matching `chat_message_receipts` row) →
 *         dropped (abandoned-device fallback).
 *
 * The `chat_messages` PG table is NOT touched — pre-migration plaintext
 * history remains permanently readable. Only the new ephemeral envelope
 * pipe gets GC'd.
 *
 * ── Sender-Keys body cleanup (2026-05-16 envelope optimisation) ──
 * Sender-Keys mode writes one shared body row to
 * `chat_pending_envelope_bodies` per message plus N key-wrap shards in
 * `chat_pending_envelopes` (with `body_ref` set). After Stage 7 deletes
 * the last shard for a given body_ref, the parent body becomes orphan
 * and MUST also be reaped to keep the table from growing unbounded.
 *
 * Add this DELETE (idempotent) to the Stage 7 schedule, AFTER the
 * existing per-shard sweeps run:
 *
 *     DELETE FROM chat_pending_envelope_bodies b
 *      WHERE NOT EXISTS (
 *          SELECT 1 FROM chat_pending_envelopes e
 *           WHERE e.body_ref = b.id
 *      )
 *        AND b.created_at < NOW() - INTERVAL '5 minutes';
 *
 * The 5-minute grace prevents a race where the body row exists but the
 * shard INSERT hasn't committed yet on a slow sender. Bodies also carry
 * their own `expires_at` (30d default) — a belt-and-suspenders DELETE
 * by `expires_at < NOW()` is also safe to add.
 *
 * (Implementation owner: Stage 7 cron — comment-only spec here.)
 *
 * Idempotent: every statement is `DELETE WHERE <expired condition>`. Safe
 * under concurrent runs because PG row-locks serialize the matching rows.
 *
 * Schedule: every 10 minutes via crontab — see
 * `cron-chat-envelope-gc.cron-template` next to this file.
 *
 * NOTE on `chat_message_receipts.client_message_id`: this column does NOT
 * exist. The receipts table indexes by `(message_id, email, device_id)`
 * where `message_id` is `chat_messages.id` (may be 0 if no legacy row was
 * created, see chat.php `chat_envelope_ack`). Stage 7's "never acked"
 * detection therefore relies on the natural property that `chat_envelope_ack`
 * DELETEs the envelope row inline upon ack — so any row still present
 * past 30 days is by definition un-acked. No JOIN to receipts is needed
 * to identify abandoned envelopes; `created_at < NOW() - INTERVAL '30 days'`
 * is sufficient and matches the spec's intent.
 */

if (php_sapi_name() !== 'cli') {
    // Refuse to run via web — this is a cron-only script.
    http_response_code(403);
    echo "CLI only\n";
    exit(1);
}

require_once __DIR__ . '/db.php';

function _gc_log($msg) {
    fwrite(STDERR, '[' . date('c') . "] [chat-envelope-gc] {$msg}\n");
}

try {
    $pg = getPGDB();
} catch (\Throwable $e) {
    _gc_log('FATAL getPGDB() failed: ' . $e->getMessage());
    exit(2);
}

$totals = [
    'expired'         => 0,
    'delivered_grace' => 0,
    'abandoned'       => 0,
];

// (1) TTL — envelopes past their hard expiry (default 30d from insert).
try {
    $st = $pg->prepare("DELETE FROM chat_pending_envelopes WHERE expires_at < NOW()");
    $st->execute();
    $totals['expired'] = $st->rowCount();
} catch (\Throwable $e) {
    _gc_log('expired DELETE failed: ' . $e->getMessage());
}

// (2) Delivered + 7 day grace — at least one device acked, sat 7 days.
//     `delivered_at` is stamped by chat_envelopes_pull (chat.php) when the
//     receiving device fetches the row. The actual ack/DELETE happens via
//     chat_envelope_ack, but if a device pulls without acking we still drop
//     after 7 days so the row doesn't sit forever.
try {
    $st = $pg->prepare(
        "DELETE FROM chat_pending_envelopes
         WHERE delivered_at IS NOT NULL
           AND delivered_at < NOW() - INTERVAL '7 days'"
    );
    $st->execute();
    $totals['delivered_grace'] = $st->rowCount();
} catch (\Throwable $e) {
    _gc_log('delivered_grace DELETE failed: ' . $e->getMessage());
}

// (3) Abandoned — never acked. See header NOTE: an envelope row only persists
//     past 30d if no device ever acked it (chat_envelope_ack DELETEs on ack).
//     Belt-and-suspenders DELETE in case `expires_at` was somehow nulled or
//     bypassed (e.g. a future ALTER TABLE forgot the DEFAULT, or a manual
//     INSERT skipped the column). Cheap to run, fully idempotent.
try {
    $st = $pg->prepare(
        "DELETE FROM chat_pending_envelopes
         WHERE created_at < NOW() - INTERVAL '30 days'"
    );
    $st->execute();
    $totals['abandoned'] = $st->rowCount();
} catch (\Throwable $e) {
    _gc_log('abandoned DELETE failed: ' . $e->getMessage());
}

// Safety net: confirm Stage 5 `delivered_at` column exists. No-op when it
// does (IF NOT EXISTS). Catches drift on hosts that missed the Stage 5
// migration.
try {
    $pg->exec("ALTER TABLE chat_pending_envelopes ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ");
} catch (\Throwable $e) {
    _gc_log('delivered_at column verify failed: ' . $e->getMessage());
}

_gc_log(sprintf(
    'done — expired=%d delivered_grace=%d abandoned=%d',
    $totals['expired'],
    $totals['delivered_grace'],
    $totals['abandoned']
));

exit(0);
