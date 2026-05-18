<?php
/**
 * privacy_endpoints.php — handlers for the "close Privacy/Security to 100%"
 * milestone. Drop-in module that handles its set of actions and returns
 * true if handled, false otherwise. Wire from chat.php (top of the switch):
 *
 *     require_once __DIR__ . '/privacy_endpoints.php';
 *     if (handle_privacy_action($db, $action, $input)) return;
 *
 * Endpoints added here:
 *   - user_activity_log_list / user_activity_log_add  (unified audit log)
 *   - chat_discoverable_get / chat_discoverable_set   (contact-discovery opt-out)
 *   - chat_master_key_fingerprint_get / _set / _clear (BYOK)
 *   - chat_report_spam                                (spam reporting + ML hook)
 *
 * Tables created idempotently:
 *   - chat_user_activity_log        (audit log)
 *   - chat_spam_reports             (per-user spam reports)
 *   - chat_shadowbanned_users       (auto-shadowban list, used by sync_contacts)
 *   - chat_user_master_key_fingerprint  (BYOK fingerprint, NEVER the key)
 *   - chat_user_privacy.discoverable  (added column — opt-out flag)
 *
 * No PII is logged beyond {ip, user_agent, action}. Spam reports keep
 * reporter+reported emails but reason is opt-in.
 */

if (!function_exists('logUserActivity')) {
    /**
     * Helper for OTHER endpoints (login, logout, password change, etc.) to
     * append an audit row. Idempotent table creation; failures are swallowed
     * so logging never blocks user actions.
     */
    function logUserActivity(PDO $db, string $email, string $action, string $deviceLabel = ''): void {
        try {
            @$db->exec("CREATE TABLE IF NOT EXISTS chat_user_activity_log (
                id BIGSERIAL PRIMARY KEY,
                email TEXT NOT NULL,
                action TEXT NOT NULL,
                ip TEXT,
                user_agent TEXT,
                device_label TEXT,
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
            )");
            @$db->exec("CREATE INDEX IF NOT EXISTS idx_user_activity_email_created
                        ON chat_user_activity_log(LOWER(email), created_at DESC)");
            $ip = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? '';
            $ua = substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 240);
            $db->prepare("INSERT INTO chat_user_activity_log (email, action, ip, user_agent, device_label)
                          VALUES (:e, :a, :ip, :ua, :dl)")
               ->execute([':e' => $email, ':a' => $action, ':ip' => $ip, ':ua' => $ua, ':dl' => $deviceLabel]);
        } catch (\Throwable $e) {
            error_log('[logUserActivity] ' . $e->getMessage());
        }
    }
}

if (!function_exists('isShadowbanned')) {
    /** Called from chat_sync_contacts and chat_phone_registry-touching paths. */
    function isShadowbanned(PDO $db, string $email): bool {
        try {
            $st = $db->prepare("SELECT 1 FROM chat_shadowbanned_users WHERE LOWER(email) = LOWER(:e) LIMIT 1");
            $st->execute([':e' => $email]);
            return (bool)$st->fetchColumn();
        } catch (\Throwable $_) { return false; }
    }
}

if (!function_exists('isDiscoverable')) {
    /** True if user opted-in (default) to contact discovery via phone hash. */
    function isDiscoverable(PDO $db, string $email): bool {
        try {
            @$db->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS discoverable BOOLEAN DEFAULT TRUE");
            $st = $db->prepare("SELECT discoverable FROM chat_user_privacy WHERE LOWER(email) = LOWER(:e)");
            $st->execute([':e' => $email]);
            $v = $st->fetchColumn();
            if ($v === false || $v === null) return true;
            return (bool)$v;
        } catch (\Throwable $_) { return true; }
    }
}

if (!function_exists('moderateMessageContent')) {
    /**
     * ML moderation hook. Uses OpenAI's moderation endpoint. Called on
     * chat_send. Returns true if message should be flagged. Persists a row
     * in chat_message_moderation_flags so we can count repeat-offenders.
     * Failure modes (no key, network error, JSON error) all return false
     * so flags never block delivery.
     */
    function moderateMessageContent(PDO $db, string $senderEmail, string $content): bool {
        $text = trim($content);
        if ($text === '' || strlen($text) > 2000) return false;
        $key = getenv('OPENAI_API_KEY') ?: '';
        if (!$key) return false;
        try {
            $payload = json_encode(['model' => 'omni-moderation-latest', 'input' => $text]);
            $ch = curl_init('https://api.openai.com/v1/moderations');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $payload,
                CURLOPT_HTTPHEADER => [
                    'Authorization: Bearer ' . $key,
                    'Content-Type: application/json',
                ],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT_MS => 1200,
                CURLOPT_CONNECTTIMEOUT_MS => 400,
            ]);
            $resp = curl_exec($ch);
            curl_close($ch);
            if (!$resp) return false;
            $j = json_decode((string)$resp, true);
            $cat = $j['results'][0]['categories'] ?? [];
            $flagged = !empty($cat['harassment']) || !empty($cat['harassment/threatening'])
                    || !empty($cat['hate']) || !empty($cat['hate/threatening']);
            if ($flagged) {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_message_moderation_flags (
                    id BIGSERIAL PRIMARY KEY,
                    sender_email TEXT NOT NULL,
                    category TEXT,
                    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
                )");
                @$db->exec("CREATE INDEX IF NOT EXISTS idx_mod_flags_sender_created
                            ON chat_message_moderation_flags(LOWER(sender_email), created_at DESC)");
                $pick = !empty($cat['harassment']) ? 'harassment' : (!empty($cat['hate']) ? 'hate' : 'other');
                $db->prepare("INSERT INTO chat_message_moderation_flags (sender_email, category) VALUES (:e, :c)")
                   ->execute([':e' => $senderEmail, ':c' => $pick]);
                // >=5 harassment flags in 24h -> shadowban.
                if ($pick === 'harassment') {
                    $cnt = $db->prepare("SELECT COUNT(*) FROM chat_message_moderation_flags
                                         WHERE LOWER(sender_email) = LOWER(:e)
                                           AND category = 'harassment'
                                           AND created_at > NOW() - INTERVAL '24 hours'");
                    $cnt->execute([':e' => $senderEmail]);
                    if ((int)$cnt->fetchColumn() >= 5) {
                        @$db->exec("CREATE TABLE IF NOT EXISTS chat_shadowbanned_users (
                            email TEXT PRIMARY KEY,
                            reason TEXT,
                            reports_24h INT,
                            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
                        )");
                        $db->prepare("INSERT INTO chat_shadowbanned_users (email, reason, reports_24h)
                                      VALUES (:e, 'ml_harassment', 5)
                                      ON CONFLICT (email) DO UPDATE SET reason = 'ml_harassment'")
                           ->execute([':e' => $senderEmail]);
                    }
                }
            }
            return $flagged;
        } catch (\Throwable $e) {
            error_log('[moderateMessageContent] ' . $e->getMessage());
            return false;
        }
    }
}

/**
 * @return bool true if this call handled the action (caller should return),
 *              false if the action is none of ours.
 */
function handle_privacy_action(PDO $db, string $action, array $input): bool {
    switch ($action) {

        // --- Unified audit log ---
        case 'user_activity_log_list': {
            $user = requireChatAuth();
            $limit  = max(1, min(500, (int)($input['limit']  ?? 100)));
            $offset = max(0, (int)($input['offset'] ?? 0));
            $items = [];
            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_user_activity_log (
                    id BIGSERIAL PRIMARY KEY,
                    email TEXT NOT NULL,
                    action TEXT NOT NULL,
                    ip TEXT,
                    user_agent TEXT,
                    device_label TEXT,
                    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
                )");
                @$db->exec("CREATE INDEX IF NOT EXISTS idx_user_activity_email_created
                            ON chat_user_activity_log(LOWER(email), created_at DESC)");
                $st = $db->prepare("SELECT id, action, ip, user_agent, device_label,
                                           extract(epoch from created_at)::bigint AS created_at
                                    FROM chat_user_activity_log
                                    WHERE LOWER(email) = LOWER(:e)
                                    ORDER BY created_at DESC
                                    LIMIT :lim OFFSET :off");
                $st->bindValue(':e',   $user['email']);
                $st->bindValue(':lim', $limit,  PDO::PARAM_INT);
                $st->bindValue(':off', $offset, PDO::PARAM_INT);
                $st->execute();
                $items = $st->fetchAll(PDO::FETCH_ASSOC) ?: [];
            } catch (\Throwable $e) { error_log('[user_activity_log_list] ' . $e->getMessage()); }
            jsonResponse(true, ['items' => $items, 'limit' => $limit, 'offset' => $offset]);
            return true;
        }

        case 'user_activity_log_add': {
            $user = requireChatAuth();
            $act = strtolower(trim((string)($input['action'] ?? '')));
            if ($act === '' || strlen($act) > 64) jsonResponse(false, null, 'invalid action', 400);
            $deviceLabel = substr((string)($input['device_label'] ?? ''), 0, 120);
            logUserActivity($db, $user['email'], $act, $deviceLabel);
            jsonResponse(true, ['ok' => true]);
            return true;
        }

        // --- Discoverable toggle ---
        case 'chat_discoverable_get': {
            $user = requireChatAuth();
            jsonResponse(true, ['discoverable' => isDiscoverable($db, $user['email'])]);
            return true;
        }

        case 'chat_discoverable_set': {
            $user = requireChatAuth();
            $disc = !empty($input['discoverable']) ? 1 : 0;
            try {
                @$db->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS discoverable BOOLEAN DEFAULT TRUE");
                // Upsert. Defaults preserved for other privacy columns when
                // the row already exists (no-op on those via the SET clause).
                $db->prepare("INSERT INTO chat_user_privacy (email, discoverable, updated_at)
                              VALUES (:e, :d, (now() AT TIME ZONE 'UTC')::text)
                              ON CONFLICT (email) DO UPDATE SET discoverable = EXCLUDED.discoverable,
                                                                updated_at  = (now() AT TIME ZONE 'UTC')::text")
                   ->execute([':e' => $user['email'], ':d' => $disc ? 'true' : 'false']);
                logUserActivity($db, $user['email'], $disc ? 'discoverable_on' : 'discoverable_off');
            } catch (\Throwable $e) { error_log('[chat_discoverable_set] ' . $e->getMessage()); }
            jsonResponse(true, ['discoverable' => (bool)$disc]);
            return true;
        }

        // --- BYOK fingerprint ---
        case 'chat_master_key_fingerprint_get': {
            $user = requireChatAuth();
            $fp = null; $updatedAt = null;
            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_user_master_key_fingerprint (
                    email TEXT PRIMARY KEY,
                    fingerprint TEXT NOT NULL,
                    algo TEXT NOT NULL DEFAULT 'sha256',
                    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
                )");
                $st = $db->prepare("SELECT fingerprint, extract(epoch from updated_at)::bigint AS updated_at
                                    FROM chat_user_master_key_fingerprint
                                    WHERE LOWER(email) = LOWER(:e) LIMIT 1");
                $st->execute([':e' => $user['email']]);
                $row = $st->fetch();
                if ($row) { $fp = $row['fingerprint']; $updatedAt = (int)$row['updated_at']; }
            } catch (\Throwable $e) { error_log('[chat_master_key_fingerprint_get] ' . $e->getMessage()); }
            jsonResponse(true, ['fingerprint' => $fp, 'updated_at' => $updatedAt]);
            return true;
        }

        case 'chat_master_key_fingerprint_set': {
            $user = requireChatAuth();
            $fp = strtolower(trim((string)($input['fingerprint'] ?? '')));
            if (!preg_match('/^[a-f0-9]{64}$/', $fp)) {
                jsonResponse(false, null, 'fingerprint must be SHA-256 hex (64 chars)', 400);
            }
            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_user_master_key_fingerprint (
                    email TEXT PRIMARY KEY,
                    fingerprint TEXT NOT NULL,
                    algo TEXT NOT NULL DEFAULT 'sha256',
                    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
                )");
                $db->prepare("INSERT INTO chat_user_master_key_fingerprint (email, fingerprint, algo, updated_at)
                              VALUES (:e, :fp, 'sha256', now())
                              ON CONFLICT (email) DO UPDATE SET fingerprint = EXCLUDED.fingerprint,
                                                                 updated_at = now()")
                   ->execute([':e' => $user['email'], ':fp' => $fp]);
                logUserActivity($db, $user['email'], 'byok_key_set');
            } catch (\Throwable $e) { error_log('[chat_master_key_fingerprint_set] ' . $e->getMessage()); }
            jsonResponse(true, ['fingerprint' => $fp]);
            return true;
        }

        case 'chat_master_key_fingerprint_clear': {
            $user = requireChatAuth();
            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_user_master_key_fingerprint (
                    email TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
                    algo TEXT NOT NULL DEFAULT 'sha256',
                    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now())");
                $db->prepare("DELETE FROM chat_user_master_key_fingerprint WHERE LOWER(email) = LOWER(:e)")
                   ->execute([':e' => $user['email']]);
                logUserActivity($db, $user['email'], 'byok_key_cleared');
            } catch (\Throwable $e) { error_log('[chat_master_key_fingerprint_clear] ' . $e->getMessage()); }
            jsonResponse(true, ['cleared' => true]);
            return true;
        }

        // --- Spam reporting ---
        case 'chat_report_spam': {
            $user = requireChatAuth();
            $convId = (int)($input['conv_id'] ?? $input['conversation_id'] ?? 0);
            $reason = substr((string)($input['reason'] ?? ''), 0, 500);
            if ($convId <= 0) jsonResponse(false, null, 'conv_id required', 400);
            $reportedEmail = null;
            try {
                $st = $db->prepare("SELECT LOWER(email) AS e FROM chat_conversation_members
                                    WHERE conversation_id = :c AND LOWER(email) <> LOWER(:me) LIMIT 1");
                $st->execute([':c' => $convId, ':me' => $user['email']]);
                $reportedEmail = $st->fetchColumn() ?: null;
            } catch (\Throwable $_) {}
            try {
                @$db->exec("CREATE TABLE IF NOT EXISTS chat_spam_reports (
                    id BIGSERIAL PRIMARY KEY,
                    reporter_email TEXT NOT NULL,
                    reported_email TEXT,
                    conversation_id BIGINT,
                    reason TEXT,
                    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
                )");
                @$db->exec("CREATE INDEX IF NOT EXISTS idx_spam_reports_reported_created
                            ON chat_spam_reports(LOWER(reported_email), created_at DESC)");
                $db->prepare("INSERT INTO chat_spam_reports (reporter_email, reported_email, conversation_id, reason)
                              VALUES (:r, :t, :c, :reason)")
                   ->execute([
                       ':r' => $user['email'],
                       ':t' => $reportedEmail,
                       ':c' => $convId,
                       ':reason' => $reason,
                   ]);
                logUserActivity($db, $user['email'], 'spam_report');

                if ($reportedEmail) {
                    $cnt = $db->prepare("SELECT COUNT(*) FROM chat_spam_reports
                                         WHERE LOWER(reported_email) = LOWER(:t)
                                           AND created_at > NOW() - INTERVAL '24 hours'");
                    $cnt->execute([':t' => $reportedEmail]);
                    $n = (int)$cnt->fetchColumn();
                    if ($n > 10) {
                        @$db->exec("CREATE TABLE IF NOT EXISTS chat_shadowbanned_users (
                            email TEXT PRIMARY KEY,
                            reason TEXT,
                            reports_24h INT,
                            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
                        )");
                        $db->prepare("INSERT INTO chat_shadowbanned_users (email, reason, reports_24h)
                                      VALUES (:e, 'auto_spam', :n)
                                      ON CONFLICT (email) DO UPDATE SET reports_24h = EXCLUDED.reports_24h,
                                                                          reason = 'auto_spam'")
                           ->execute([':e' => $reportedEmail, ':n' => $n]);
                    }
                }
            } catch (\Throwable $e) { error_log('[chat_report_spam] ' . $e->getMessage()); }
            jsonResponse(true, ['reported' => true]);
            return true;
        }
    }

    return false;
}
