#!/usr/bin/env python3
"""
[2026-05-18] Diamond wallet hardening + cashout

Patches:
  1. chat.php wallet_send rate-limit polarity (was firing 429 on every first call)
  2. chat.php wallet_send ledger INSERT — match existing schema
     (delta_diamonds/reason/ref_id) instead of new direction/amount/kind columns
  3. chat.php wallet_send — accrue 70% creator payout (3.5 cents/diamond) to
     receiver's pending_payout_cents so the receiver can later cash out
  4. chat.php — wallet_history maps existing ledger schema → frontend
     direction/amount/kind contract
  5. chat.php — new wallet_cashout_request endpoint (creates pending row in
     chat_wallet_payouts with PIX key + name + cpf, debits pending_payout_cents)
  6. chat.php _walletEnsureSchema — add chat_wallet_payouts table
  7. email.php — route wallet_cashout_request and wallet_cashout_list to
     handleChatAction
"""
import os
import sys

CHAT_PATH = "/var/www/mail/api/chat.php"
EMAIL_PATH = "/var/www/mail/api/email.php"

with open(CHAT_PATH, "r", encoding="utf-8") as f:
    chat_src = f.read()

orig_chat_len = len(chat_src)

# ---------------------------------------------------------------------------
# FIX 1: Rate-limit polarity in wallet_send
# ---------------------------------------------------------------------------
OLD_RL = """            // Rate limit: 30 sends / 60s per sender to stop scripted spam.
            if (chatRateLimit($user['email'], 'wallet_send', 30, 60)) {
                jsonResponse(false, null, 'Slow down — too many sends', 429);
            }"""
NEW_RL = """            // Rate limit: 30 sends / 60s per sender to stop scripted spam.
            // chatRateLimit returns TRUE if allowed, FALSE if exceeded — old
            // code had the polarity inverted (every first call 429'd).
            if (!chatRateLimit($user['email'], 'wallet_send', 30, 60)) {
                jsonResponse(false, null, 'Slow down — too many sends', 429);
            }"""
if OLD_RL not in chat_src:
    print("FIX 1 anchor missing — aborting", file=sys.stderr); sys.exit(1)
chat_src = chat_src.replace(OLD_RL, NEW_RL, 1)
print("FIX 1: wallet_send rate-limit polarity fixed")

# ---------------------------------------------------------------------------
# FIX 2 + 3: Ledger schema mismatch + receiver payout accrual
# ---------------------------------------------------------------------------
OLD_LEDGER = """                try {
                    $db->prepare("
                        INSERT INTO chat_wallet_ledger (email, direction, amount, kind, ref_kind, ref_id, counterparty)
                        VALUES (:e, 'debit', :d, 'send', 'transfer', :r, :cp)
                    ")->execute([
                        ':e' => $user['email'],
                        ':d' => $amount,
                        ':r' => $transferId,
                        ':cp' => $toEmail,
                    ]);
                    $db->prepare("
                        INSERT INTO chat_wallet_ledger (email, direction, amount, kind, ref_kind, ref_id, counterparty)
                        VALUES (:e, 'credit', :d, 'receive', 'transfer', :r, :cp)
                    ")->execute([
                        ':e' => $toEmail,
                        ':d' => $amount,
                        ':r' => $transferId,
                        ':cp' => $user['email'],
                    ]);
                } catch (\\Throwable $_) { /* ledger best-effort */ }"""
NEW_LEDGER = """                // Ledger entries — schema is (delta_diamonds, reason, ref_id).
                // Negative delta = debit, positive = credit. ref_id encodes
                // both the transfer id and the counterparty email so wallet
                // history can render "Enviado para foo" without a join.
                try {
                    $db->prepare("
                        INSERT INTO chat_wallet_ledger (email, delta_diamonds, reason, ref_id)
                        VALUES (:e, :d, :rsn, :r)
                    ")->execute([
                        ':e'   => $user['email'],
                        ':d'   => -$amount,
                        ':rsn' => 'send:' . $toEmail,
                        ':r'   => (string)$transferId,
                    ]);
                    $db->prepare("
                        INSERT INTO chat_wallet_ledger (email, delta_diamonds, reason, ref_id)
                        VALUES (:e, :d, :rsn, :r)
                    ")->execute([
                        ':e'   => $toEmail,
                        ':d'   => $amount,
                        ':rsn' => 'receive:' . $user['email'],
                        ':r'   => (string)$transferId,
                    ]);
                } catch (\\Throwable $e) { error_log('[wallet_send.ledger] ' . $e->getMessage()); }

                // Creator-payout accrual on the receiver side: 70% of diamond
                // value at R$ 0.05/diamond → 3.5 cents per diamond received.
                // 100 ◆ received → 350 cents pending payout (R$ 3.50).
                // The 30% platform fee stays implicit (we never credit it).
                $payoutCents = (int) floor($amount * 35 / 10); // 3.5¢/◆
                try {
                    if ($payoutCents > 0) {
                        $db->prepare("UPDATE chat_wallet_balances SET pending_payout_cents = pending_payout_cents + :c, updated_at = now() WHERE LOWER(email) = LOWER(:e)")
                           ->execute([':c' => $payoutCents, ':e' => $toEmail]);
                    }
                } catch (\\Throwable $e) { error_log('[wallet_send.payout] ' . $e->getMessage()); }"""
if OLD_LEDGER not in chat_src:
    print("FIX 2/3 anchor missing — aborting", file=sys.stderr); sys.exit(1)
chat_src = chat_src.replace(OLD_LEDGER, NEW_LEDGER, 1)
print("FIX 2/3: ledger schema + payout accrual")

# ---------------------------------------------------------------------------
# FIX 4: wallet_history mapper (existing schema → frontend contract)
# ---------------------------------------------------------------------------
OLD_HIST = """                $st = $db->prepare("
                    SELECT id, direction, amount, kind, ref_kind, ref_id, counterparty,
                           EXTRACT(EPOCH FROM created_at)::bigint AS created_at_ts,
                           created_at
                      FROM chat_wallet_ledger
                     WHERE LOWER(email) = LOWER(:e)
                     ORDER BY created_at DESC, id DESC
                     LIMIT :l OFFSET :o
                ");
                $st->bindValue(':e', $user['email']);
                $st->bindValue(':l', $limit, \\PDO::PARAM_INT);
                $st->bindValue(':o', $offset, \\PDO::PARAM_INT);
                $st->execute();
                $rows = $st->fetchAll(\\PDO::FETCH_ASSOC) ?: [];"""
NEW_HIST = """                $st = $db->prepare("
                    SELECT id, delta_diamonds, reason, ref_id,
                           EXTRACT(EPOCH FROM created_at)::bigint AS created_at_ts,
                           created_at
                      FROM chat_wallet_ledger
                     WHERE LOWER(email) = LOWER(:e)
                     ORDER BY created_at DESC, id DESC
                     LIMIT :l OFFSET :o
                ");
                $st->bindValue(':e', $user['email']);
                $st->bindValue(':l', $limit, \\PDO::PARAM_INT);
                $st->bindValue(':o', $offset, \\PDO::PARAM_INT);
                $st->execute();
                $rawRows = $st->fetchAll(\\PDO::FETCH_ASSOC) ?: [];
                // Map storage schema (delta_diamonds/reason) → frontend
                // contract (direction/amount/kind/counterparty). reason is
                // \"send:<email>\" / \"receive:<email>\" / \"topup\" / \"cashout\"
                // — split on \":\" to derive both the kind label and the cp.
                $rows = [];
                foreach ($rawRows as $r) {
                    $delta = (int)($r['delta_diamonds'] ?? 0);
                    $reason = (string)($r['reason'] ?? '');
                    $cp = null;
                    $kind = $reason;
                    if (strpos($reason, ':') !== false) {
                        [$kind, $cp] = explode(':', $reason, 2);
                    }
                    // Normalize legacy kind labels to the frontend set.
                    $kindMap = [
                        'send' => 'send', 'receive' => 'receive',
                        'topup' => 'topup', 'cashout' => 'cashout',
                        'tip_send' => 'tip_send', 'tip_recv' => 'tip_recv',
                        'promote' => 'promote',
                    ];
                    if (!isset($kindMap[$kind])) $kind = $delta < 0 ? 'send' : 'receive';
                    $rows[] = [
                        'id'             => (int)$r['id'],
                        'direction'      => $delta < 0 ? 'debit' : 'credit',
                        'amount'         => abs($delta),
                        'kind'           => $kind,
                        'counterparty'   => $cp,
                        'ref_id'         => $r['ref_id'] ?? null,
                        'created_at_ts'  => (int)($r['created_at_ts'] ?? 0),
                        'created_at'     => $r['created_at'] ?? null,
                    ];
                }"""
if OLD_HIST not in chat_src:
    print("FIX 4 anchor missing — aborting", file=sys.stderr); sys.exit(1)
chat_src = chat_src.replace(OLD_HIST, NEW_HIST, 1)
print("FIX 4: wallet_history row mapper")

# ---------------------------------------------------------------------------
# FIX 5: Add wallet_cashout_request + wallet_cashout_list cases before the
#        default branch of handleChatAction.
# ---------------------------------------------------------------------------
NEW_CASHOUT_CASE = """        // ============================================================
        // wallet_cashout_request — creator requests a PIX payout of their
        // pending earnings. Body: { amount_cents, pix_key, pix_key_type?,
        // full_name, cpf }. Minimum cashout is R$ 50 (5000 cents). Debits
        // pending_payout_cents and writes a row to chat_wallet_payouts in
        // status='pending'. A back-office worker (admin.php cron, out of
        // scope here) reconciles and marks paid.
        //
        // [2026-05-18] Stage-1 plumbing — no real PIX integration yet, just
        // the request + audit trail. Frontend tela /wallet-cashout uses this.
        // ============================================================
        case 'wallet_cashout_request': {
            $user = requireChatAuth();
            $amountCents = (int)($input['amount_cents'] ?? 0);
            $pixKey      = trim((string)($input['pix_key'] ?? ''));
            $pixKeyType  = strtolower(trim((string)($input['pix_key_type'] ?? 'auto')));
            $fullName    = trim((string)($input['full_name'] ?? ''));
            $cpf         = preg_replace('/[^0-9]/', '', (string)($input['cpf'] ?? ''));

            if ($amountCents < 5000)   jsonResponse(false, null, 'min_cashout', 400); // R$ 50
            if ($amountCents > 5000000) jsonResponse(false, null, 'max_cashout', 400); // R$ 50k
            if ($pixKey === '')        jsonResponse(false, null, 'pix_key_required', 400);
            if ($fullName === '' || mb_strlen($fullName) > 120) jsonResponse(false, null, 'full_name_required', 400);
            if (strlen($cpf) !== 11)   jsonResponse(false, null, 'cpf_invalid', 400);

            // Throttle: 3 cashout requests / day per user.
            if (!chatRateLimit($user['email'], 'wallet_cashout', 3, 86400)) {
                jsonResponse(false, null, 'Limite diario de saques atingido', 429);
            }

            try {
                _walletEnsureSchema($db);
                $db->beginTransaction();
                $bal = $db->prepare("SELECT pending_payout_cents FROM chat_wallet_balances WHERE LOWER(email) = LOWER(:e) FOR UPDATE");
                $bal->execute([':e' => $user['email']]);
                $pending = (int)($bal->fetchColumn() ?: 0);
                if ($pending < $amountCents) {
                    $db->rollBack();
                    jsonResponse(false, [
                        'code' => 'insufficient_pending',
                        'pending_payout_cents' => $pending,
                    ], 'Saldo de saque insuficiente', 402);
                }
                $db->prepare("UPDATE chat_wallet_balances SET pending_payout_cents = pending_payout_cents - :c, updated_at = now() WHERE LOWER(email) = LOWER(:e)")
                   ->execute([':c' => $amountCents, ':e' => $user['email']]);
                $ins = $db->prepare("
                    INSERT INTO chat_wallet_payouts (email, amount_cents, pix_key, pix_key_type, full_name, cpf, status, requested_at)
                    VALUES (:e, :a, :k, :kt, :n, :c, 'pending', now())
                    RETURNING id, requested_at
                ");
                $ins->execute([
                    ':e'  => $user['email'],
                    ':a'  => $amountCents,
                    ':k'  => $pixKey,
                    ':kt' => $pixKeyType,
                    ':n'  => $fullName,
                    ':c'  => $cpf,
                ]);
                $row = $ins->fetch(\\PDO::FETCH_ASSOC) ?: [];
                $payoutId = (int)($row['id'] ?? 0);

                // Audit row in the ledger so the user sees "Saque solicitado"
                // in their history right away.
                try {
                    $db->prepare("INSERT INTO chat_wallet_ledger (email, delta_diamonds, reason, ref_id) VALUES (:e, 0, 'cashout', :r)")
                       ->execute([':e' => $user['email'], ':r' => (string)$payoutId]);
                } catch (\\Throwable $_) {}

                $db->commit();

                jsonResponse(true, [
                    'payout_id'             => $payoutId,
                    'amount_cents'          => $amountCents,
                    'status'                => 'pending',
                    'pending_payout_cents'  => $pending - $amountCents,
                    'requested_at'          => $row['requested_at'] ?? null,
                ]);
            } catch (\\Throwable $e) {
                try { if ($db->inTransaction()) $db->rollBack(); } catch (\\Throwable $_) {}
                error_log('[wallet_cashout_request] ' . $e->getMessage());
                jsonResponse(false, null, 'cashout_failed', 500);
            }
            break;
        }

        // wallet_cashout_list — newest-first list of the signed-in user's
        // cashout requests with current status. Used by /wallet-cashout
        // history table.
        case 'wallet_cashout_list': {
            $user = requireChatAuth();
            try {
                _walletEnsureSchema($db);
                $st = $db->prepare("
                    SELECT id, amount_cents, pix_key, pix_key_type, status,
                           EXTRACT(EPOCH FROM requested_at)::bigint AS requested_at_ts,
                           EXTRACT(EPOCH FROM processed_at)::bigint AS processed_at_ts
                      FROM chat_wallet_payouts
                     WHERE LOWER(email) = LOWER(:e)
                     ORDER BY requested_at DESC, id DESC
                     LIMIT 50
                ");
                $st->execute([':e' => $user['email']]);
                $rows = $st->fetchAll(\\PDO::FETCH_ASSOC) ?: [];
                jsonResponse(true, ['items' => $rows]);
            } catch (\\Throwable $e) {
                error_log('[wallet_cashout_list] ' . $e->getMessage());
                jsonResponse(true, ['items' => []]);
            }
            break;
        }

"""

# Insert immediately before the default case in handleChatAction.
OLD_DEFAULT = """        // ============================================================
        // Default — unknown action
        // ============================================================
        default:
            jsonResponse(false, null, 'Unknown chat action: ' . $action, 400);
            break;
    }
}"""
if OLD_DEFAULT not in chat_src:
    print("FIX 5 default-case anchor missing — aborting", file=sys.stderr); sys.exit(1)
if "case 'wallet_cashout_request':" not in chat_src:
    chat_src = chat_src.replace(OLD_DEFAULT, NEW_CASHOUT_CASE + OLD_DEFAULT, 1)
    print("FIX 5: wallet_cashout_request + wallet_cashout_list added")
else:
    print("FIX 5: cashout cases already present — skipping")

# ---------------------------------------------------------------------------
# FIX 6: chat_wallet_payouts table in _walletEnsureSchema
# ---------------------------------------------------------------------------
OLD_SCHEMA_TAIL = """        @$db->exec(\"CREATE INDEX IF NOT EXISTS idx_wallet_transfers_from ON chat_wallet_transfers (from_email, created_at DESC)\");"""
NEW_SCHEMA_TAIL = """        @$db->exec(\"CREATE INDEX IF NOT EXISTS idx_wallet_transfers_from ON chat_wallet_transfers (from_email, created_at DESC)\");
        @$db->exec(\"CREATE TABLE IF NOT EXISTS chat_wallet_payouts (
            id BIGSERIAL PRIMARY KEY,
            email TEXT NOT NULL,
            amount_cents BIGINT NOT NULL,
            pix_key TEXT NOT NULL,
            pix_key_type TEXT NOT NULL DEFAULT 'auto',
            full_name TEXT NOT NULL,
            cpf TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            requested_at TIMESTAMPTZ DEFAULT now(),
            processed_at TIMESTAMPTZ,
            admin_notes TEXT
        )\");
        @$db->exec(\"CREATE INDEX IF NOT EXISTS idx_wallet_payouts_email ON chat_wallet_payouts (email, requested_at DESC)\");
        @$db->exec(\"CREATE INDEX IF NOT EXISTS idx_wallet_payouts_status ON chat_wallet_payouts (status, requested_at)\");"""
if OLD_SCHEMA_TAIL not in chat_src:
    print("FIX 6 schema anchor missing — aborting", file=sys.stderr); sys.exit(1)
if "chat_wallet_payouts" in chat_src and chat_src.count("CREATE TABLE IF NOT EXISTS chat_wallet_payouts") > 0:
    print("FIX 6: chat_wallet_payouts table already in schema")
else:
    chat_src = chat_src.replace(OLD_SCHEMA_TAIL, NEW_SCHEMA_TAIL, 1)
    print("FIX 6: chat_wallet_payouts table added to _walletEnsureSchema")

# Write chat.php
if len(chat_src) != orig_chat_len:
    with open(CHAT_PATH, "w", encoding="utf-8") as f:
        f.write(chat_src)
    print(f"chat.php: {orig_chat_len} → {len(chat_src)} bytes")
else:
    print("chat.php: no changes")

# ---------------------------------------------------------------------------
# FIX 7: email.php — route wallet_cashout_request + wallet_cashout_list
# ---------------------------------------------------------------------------
with open(EMAIL_PATH, "r", encoding="utf-8") as f:
    email_src = f.read()

orig_email_len = len(email_src)

OLD_ROUTE = """        case 'wallet_balance': case 'wallet_topup_verify': case 'wallet_buy_diamonds':
        case 'wallet_send': case 'wallet_history': case 'wallet_pack_catalog':
            require_once __DIR__ . '/chat.php';
            handleChatAction($action);
            break;"""
NEW_ROUTE = """        case 'wallet_balance': case 'wallet_topup_verify': case 'wallet_buy_diamonds':
        case 'wallet_send': case 'wallet_history': case 'wallet_pack_catalog':
        case 'wallet_cashout_request': case 'wallet_cashout_list':
            require_once __DIR__ . '/chat.php';
            handleChatAction($action);
            break;"""
if OLD_ROUTE in email_src:
    email_src = email_src.replace(OLD_ROUTE, NEW_ROUTE, 1)
    print("FIX 7: email.php routing updated")
elif "case 'wallet_cashout_request':" in email_src:
    print("FIX 7: routing already present — skipping")
else:
    print("FIX 7 anchor missing — aborting", file=sys.stderr); sys.exit(1)

if len(email_src) != orig_email_len:
    with open(EMAIL_PATH, "w", encoding="utf-8") as f:
        f.write(email_src)
    print(f"email.php: {orig_email_len} → {len(email_src)} bytes")

print("\nDONE — restart php-fpm to clear opcache:")
print("  docker exec chatyy-php-fpm kill -USR2 1")
