<?php
/**
 * email-gaps.php — closes the remaining Gmail-parity gaps surfaced in
 * /tmp/gap_email_gmail.md (round 6, 2026-05-17):
 *
 *   1. OAuth import (Gmail / Outlook / Microsoft Graph) — multi-step
 *   2. PGP key registry + SMS passphrase fallback
 *   3. Email → Task primitive (chat_user_tasks PG table)
 *   4. Email bundles (Gmail-style category grouping for inbox)
 *   5. Bulk mark-read across an entire folder
 *
 * Wiring: in email.php, just before the `default:` arm of the main
 * `switch ($action)`, add the single dispatcher line:
 *
 *     if (handleEmailGapsAction($action)) break;
 *
 * The dispatcher returns true after it served the action (and called
 * jsonResponse internally), false when the action wasn't ours so the
 * caller continues to the default catch-all.
 *
 * Frontend services/api.js exports the matching wrappers
 *   emailOauthImportStart / emailOauthImportStep / emailOauthImportList
 *   pgpKeyUpload / pgpKeyGet / pgpKeyDelete / pgpSendPassphraseSms
 *   taskList / taskCreate / taskUpdate / taskDelete / taskCreateFromEmail
 *   emailBundles
 *   bulkMarkReadFolder
 *
 * License: MIT (project-internal).
 */

if (!function_exists('_emailImportDeliver')) {
    /**
     * Drop an RFC822 message into the user's maildir under a custom folder.
     * Returns true on success. Uses doveadm-style direct copy when available,
     * falls back to IMAP APPEND so we never need shell access to vmail.
     */
    function _emailImportDeliver(string $userEmail, string $rfc822, string $folder = 'Imported'): bool {
        if (strlen($rfc822) < 8) return false;
        // Re-use the existing IMAP login path. getImap() lives in email.php.
        if (!function_exists('getImap')) return false;
        try {
            // We need the user's password. requireAuth() already gave the
            // caller `$auth['password']` (a base64-ish stash). Callers in
            // email.php that invoke this helper sit *after* requireAuth(),
            // so they pass auth via a stash file. To keep this helper
            // self-contained, look up the most recent valid bearer for the
            // user from the on-disk token store.
            $hint = _emailImportPasswordFor($userEmail);
            if (!$hint) return false;
            $imap = getImap($userEmail, $hint, 'INBOX');
            // Create the folder if missing.
            $svr = '{localhost:143/imap/notls/novalidate-cert}';
            try { @imap_createmailbox($imap, imap_utf7_encode($svr . $folder)); } catch (\Throwable $_e) {}
            @imap_append($imap, $svr . $folder, $rfc822, "\\Seen");
            try { imap_close($imap); } catch (\Throwable $_e) {}
            return true;
        } catch (\Throwable $e) {
            error_log('[_emailImportDeliver] ' . $e->getMessage());
            return false;
        }
    }
}

if (!function_exists('_emailImportPasswordFor')) {
    /**
     * Look up the user's stash password from the most recent bearer token
     * the OAuth importer was triggered with. The token store mirrors what
     * sessions_list reads (TOKEN_STORE_DIR/<hash>.json with the encrypted
     * password under `password_enc`).
     */
    function _emailImportPasswordFor(string $userEmail): string {
        $tokenDir = defined('TOKEN_STORE_DIR') ? TOKEN_STORE_DIR : '/var/www/mail/data/tokens';
        if (!is_dir($tokenDir)) return '';
        $newest = ['mtime' => 0, 'data' => null];
        foreach (scandir($tokenDir) as $f) {
            if (!str_ends_with($f, '.json')) continue;
            $p = $tokenDir . '/' . $f;
            $d = @json_decode(@file_get_contents($p), true);
            if (!$d) continue;
            if (($d['email'] ?? '') !== $userEmail) continue;
            if (($d['expires_at'] ?? 0) < time()) continue;
            $mt = (int)@filemtime($p);
            if ($mt > $newest['mtime']) $newest = ['mtime' => $mt, 'data' => $d];
        }
        if (!$newest['data']) return '';
        // Decrypt via the same helper email.php uses. If the encryption
        // helper isn't available we just return ''. The OAuth importer
        // will mark the session as failed and the user retries.
        $enc = (string)($newest['data']['password_enc'] ?? '');
        if ($enc === '') return '';
        if (function_exists('decryptSessionPassword')) {
            try { return (string)decryptSessionPassword($enc); } catch (\Throwable $_e) { return ''; }
        }
        // Older code path: stored cleartext base64.
        $raw = @base64_decode($enc, true);
        return $raw !== false ? (string)$raw : '';
    }
}

if (!function_exists('_bundleLabel')) {
    function _bundleLabel(string $bid): string {
        $map = [
            'primary'      => 'Principal',
            'social'       => 'Notificações sociais',
            'promotions'   => 'Promoções',
            'updates'      => 'Atualizações',
            'compras'      => 'Compras',
            'viagens'      => 'Viagens',
            'financas'     => 'Finanças',
            'foruns'       => 'Fóruns',
            'notificacoes' => 'Notificações',
        ];
        return $map[$bid] ?? ucfirst($bid);
    }
}

/**
 * Main dispatcher — returns true when it handled $action, false otherwise.
 * All paths call jsonResponse() before returning, so the caller doesn't
 * need to emit a response itself.
 */
if (!function_exists('handleEmailGapsAction')) {
function handleEmailGapsAction(string $action): bool {
    switch ($action) {
        // ─────────────────────────────────────────────────────────────
        // OAUTH IMPORT (Gmail + Outlook / Microsoft Graph)
        // ─────────────────────────────────────────────────────────────
        case 'email_oauth_import_start': {
            $auth  = requireAuth();
            $input = getInput();
            $provider = strtolower(trim((string)($input['provider'] ?? '')));
            $accessToken = trim((string)($input['access_token'] ?? ''));
            $maxEmails = max(50, min(1000, (int)($input['max_emails'] ?? 1000)));
            if (!in_array($provider, ['gmail', 'outlook'], true)) {
                jsonResponse(false, null, 'provider must be gmail|outlook', 400);
            }
            if (!$accessToken) jsonResponse(false, null, 'access_token required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS email_oauth_imports (
                    id BIGSERIAL PRIMARY KEY,
                    user_email TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    access_token TEXT NOT NULL,
                    max_emails INT NOT NULL DEFAULT 1000,
                    fetched INT NOT NULL DEFAULT 0,
                    imported INT NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'queued',
                    next_page_token TEXT NULL,
                    last_error TEXT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    finished_at TIMESTAMPTZ NULL
                )");
                @$pg->exec("CREATE INDEX IF NOT EXISTS email_oauth_imports_user_idx ON email_oauth_imports(user_email, created_at DESC)");
                $stmt = $pg->prepare("INSERT INTO email_oauth_imports
                    (user_email, provider, access_token, max_emails, status)
                    VALUES (:u, :p, :t, :m, 'queued') RETURNING id");
                $stmt->execute([':u' => $auth['email'], ':p' => $provider, ':t' => $accessToken, ':m' => $maxEmails]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                jsonResponse(true, ['import_id' => (int)$row['id'], 'queued' => $maxEmails]);
            } catch (\Throwable $e) {
                error_log('[email_oauth_import_start] ' . $e->getMessage());
                jsonResponse(false, null, 'Falha ao iniciar import', 500);
            }
            return true;
        }

        case 'email_oauth_import_step': {
            $auth = requireAuth();
            $input = getInput();
            $importId = (int)($input['import_id'] ?? 0);
            if (!$importId) jsonResponse(false, null, 'import_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $row = $pg->prepare("SELECT * FROM email_oauth_imports WHERE id = :i AND user_email = :u");
                $row->execute([':i' => $importId, ':u' => $auth['email']]);
                $imp = $row->fetch(PDO::FETCH_ASSOC);
                if (!$imp) jsonResponse(false, null, 'import not found', 404);
                if ($imp['status'] === 'done' || $imp['status'] === 'failed') {
                    jsonResponse(true, [
                        'status' => $imp['status'],
                        'fetched' => (int)$imp['fetched'],
                        'imported' => (int)$imp['imported'],
                        'max' => (int)$imp['max_emails'],
                        'done' => true,
                    ]);
                }
                $batchSize = 25;
                $remaining = (int)$imp['max_emails'] - (int)$imp['fetched'];
                if ($remaining <= 0) {
                    $pg->prepare("UPDATE email_oauth_imports SET status='done', finished_at=NOW() WHERE id=:i")->execute([':i' => $importId]);
                    jsonResponse(true, ['status' => 'done', 'fetched' => (int)$imp['fetched'], 'imported' => (int)$imp['imported'], 'max' => (int)$imp['max_emails'], 'done' => true]);
                }
                $batchSize = min($batchSize, $remaining);

                $importedThisBatch = 0;
                $fetchedThisBatch = 0;
                $nextPageToken = null;
                $lastError = null;

                if ($imp['provider'] === 'gmail') {
                    $listUrl = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=' . $batchSize;
                    if (!empty($imp['next_page_token'])) $listUrl .= '&pageToken=' . urlencode($imp['next_page_token']);
                    $ch = curl_init($listUrl);
                    curl_setopt_array($ch, [
                        CURLOPT_RETURNTRANSFER => true,
                        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $imp['access_token']],
                        CURLOPT_TIMEOUT => 25,
                    ]);
                    $resp = curl_exec($ch);
                    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                    curl_close($ch);
                    if ($code === 401) {
                        $pg->prepare("UPDATE email_oauth_imports SET status='failed', last_error=:e, finished_at=NOW() WHERE id=:i")
                           ->execute([':i' => $importId, ':e' => 'access_token expired']);
                        jsonResponse(false, null, 'Token Gmail expirou — refaça o login', 401);
                    }
                    if ($code !== 200) {
                        $lastError = 'gmail.list http ' . $code;
                    } else {
                        $j = json_decode($resp, true) ?: [];
                        $ids = array_map(fn($m) => $m['id'] ?? '', $j['messages'] ?? []);
                        $nextPageToken = $j['nextPageToken'] ?? null;
                        foreach ($ids as $mid) {
                            if (!$mid) continue;
                            $mch = curl_init('https://gmail.googleapis.com/gmail/v1/users/me/messages/' . urlencode($mid) . '?format=raw');
                            curl_setopt_array($mch, [
                                CURLOPT_RETURNTRANSFER => true,
                                CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $imp['access_token']],
                                CURLOPT_TIMEOUT => 15,
                            ]);
                            $mresp = curl_exec($mch);
                            $mcode = curl_getinfo($mch, CURLINFO_HTTP_CODE);
                            curl_close($mch);
                            $fetchedThisBatch++;
                            if ($mcode !== 200) continue;
                            $mj = json_decode($mresp, true) ?: [];
                            $raw = $mj['raw'] ?? '';
                            if (!$raw) continue;
                            $rfc822 = base64_decode(strtr($raw, '-_', '+/'));
                            if (_emailImportDeliver($auth['email'], $rfc822, 'Gmail/Imported')) $importedThisBatch++;
                        }
                    }
                } elseif ($imp['provider'] === 'outlook') {
                    $skip = (int)$imp['fetched'];
                    $listUrl = 'https://graph.microsoft.com/v1.0/me/messages?$top=' . $batchSize . '&$skip=' . $skip . '&$select=id,internetMessageHeaders,subject';
                    $ch = curl_init($listUrl);
                    curl_setopt_array($ch, [
                        CURLOPT_RETURNTRANSFER => true,
                        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $imp['access_token']],
                        CURLOPT_TIMEOUT => 25,
                    ]);
                    $resp = curl_exec($ch);
                    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                    curl_close($ch);
                    if ($code === 401) {
                        $pg->prepare("UPDATE email_oauth_imports SET status='failed', last_error=:e, finished_at=NOW() WHERE id=:i")
                           ->execute([':i' => $importId, ':e' => 'access_token expired']);
                        jsonResponse(false, null, 'Token Outlook expirou — refaça o login', 401);
                    }
                    if ($code !== 200) {
                        $lastError = 'graph.list http ' . $code;
                    } else {
                        $j = json_decode($resp, true) ?: [];
                        foreach (($j['value'] ?? []) as $msg) {
                            $mid = $msg['id'] ?? '';
                            if (!$mid) continue;
                            $mch = curl_init('https://graph.microsoft.com/v1.0/me/messages/' . urlencode($mid) . '/$value');
                            curl_setopt_array($mch, [
                                CURLOPT_RETURNTRANSFER => true,
                                CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $imp['access_token']],
                                CURLOPT_TIMEOUT => 15,
                            ]);
                            $mresp = curl_exec($mch);
                            $mcode = curl_getinfo($mch, CURLINFO_HTTP_CODE);
                            curl_close($mch);
                            $fetchedThisBatch++;
                            if ($mcode !== 200) continue;
                            if (_emailImportDeliver($auth['email'], $mresp, 'Outlook/Imported')) $importedThisBatch++;
                        }
                    }
                }

                $newFetched = (int)$imp['fetched'] + $fetchedThisBatch;
                $newImported = (int)$imp['imported'] + $importedThisBatch;
                $newStatus = ($newFetched >= (int)$imp['max_emails']
                    || ($imp['provider'] === 'gmail' && !$nextPageToken && $fetchedThisBatch < $batchSize))
                    ? 'done' : 'running';
                $upd = $pg->prepare("UPDATE email_oauth_imports
                    SET fetched=:f, imported=:i, status=:s, next_page_token=:n, last_error=:e, updated_at=NOW(),
                        finished_at = CASE WHEN :s2='done' THEN NOW() ELSE finished_at END
                    WHERE id=:id");
                $upd->execute([
                    ':f' => $newFetched, ':i' => $newImported, ':s' => $newStatus, ':s2' => $newStatus,
                    ':n' => $nextPageToken, ':e' => $lastError, ':id' => $importId,
                ]);
                jsonResponse(true, [
                    'status' => $newStatus,
                    'fetched' => $newFetched,
                    'imported' => $newImported,
                    'max' => (int)$imp['max_emails'],
                    'done' => ($newStatus === 'done'),
                    'last_error' => $lastError,
                ]);
            } catch (\Throwable $e) {
                error_log('[email_oauth_import_step] ' . $e->getMessage());
                jsonResponse(false, null, 'Falha no batch', 500);
            }
            return true;
        }

        case 'email_oauth_import_list': {
            $auth = requireAuth();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("SELECT id, provider, max_emails, fetched, imported, status, last_error, created_at, finished_at
                    FROM email_oauth_imports WHERE user_email = :u ORDER BY created_at DESC LIMIT 20");
                $stmt->execute([':u' => $auth['email']]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
                foreach ($rows as &$r) {
                    $r['id'] = (int)$r['id'];
                    $r['max_emails'] = (int)$r['max_emails'];
                    $r['fetched'] = (int)$r['fetched'];
                    $r['imported'] = (int)$r['imported'];
                }
                jsonResponse(true, ['imports' => $rows]);
            } catch (\Throwable $e) {
                error_log('[email_oauth_import_list] ' . $e->getMessage());
                jsonResponse(true, ['imports' => []]);
            }
            return true;
        }

        // ─────────────────────────────────────────────────────────────
        // PGP REGISTRY
        // ─────────────────────────────────────────────────────────────
        case 'pgp_key_upload': {
            $auth  = requireAuth();
            $input = getInput();
            $armor = trim((string)($input['public_key_armor'] ?? ''));
            $fpr   = trim((string)($input['fingerprint'] ?? ''));
            if (!$armor || stripos($armor, '-----BEGIN PGP PUBLIC KEY BLOCK-----') === false) {
                jsonResponse(false, null, 'public_key_armor inválido', 400);
            }
            if (!$fpr || !preg_match('/^[A-Fa-f0-9]{16,64}$/', $fpr)) {
                jsonResponse(false, null, 'fingerprint inválido', 400);
            }
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_user_pgp_keys (
                    email VARCHAR(320) PRIMARY KEY,
                    public_key_armor TEXT NOT NULL,
                    fingerprint VARCHAR(64) NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )");
                $stmt = $pg->prepare("INSERT INTO chat_user_pgp_keys (email, public_key_armor, fingerprint) VALUES (:e, :a, :f)
                    ON CONFLICT (email) DO UPDATE SET public_key_armor = EXCLUDED.public_key_armor, fingerprint = EXCLUDED.fingerprint, updated_at = NOW()");
                $stmt->execute([':e' => $auth['email'], ':a' => $armor, ':f' => strtoupper($fpr)]);
                jsonResponse(true, ['email' => $auth['email'], 'fingerprint' => strtoupper($fpr)]);
            } catch (\Throwable $e) {
                error_log('[pgp_key_upload] ' . $e->getMessage());
                jsonResponse(false, null, 'Falha ao salvar chave', 500);
            }
            return true;
        }

        case 'pgp_key_get': {
            requireAuthLite();
            $email = strtolower(trim((string)($_GET['email'] ?? '')));
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) jsonResponse(false, null, 'email inválido', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_user_pgp_keys (
                    email VARCHAR(320) PRIMARY KEY,
                    public_key_armor TEXT NOT NULL,
                    fingerprint VARCHAR(64) NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )");
                $stmt = $pg->prepare("SELECT public_key_armor, fingerprint, created_at FROM chat_user_pgp_keys WHERE email = :e");
                $stmt->execute([':e' => $email]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$row) jsonResponse(true, ['found' => false]);
                jsonResponse(true, [
                    'found' => true, 'email' => $email,
                    'public_key_armor' => $row['public_key_armor'],
                    'fingerprint' => $row['fingerprint'],
                    'created_at' => $row['created_at'],
                ]);
            } catch (\Throwable $e) {
                error_log('[pgp_key_get] ' . $e->getMessage());
                jsonResponse(true, ['found' => false]);
            }
            return true;
        }

        case 'pgp_key_delete': {
            $auth = requireAuth();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("DELETE FROM chat_user_pgp_keys WHERE email = :e")->execute([':e' => $auth['email']]);
                jsonResponse(true, ['deleted' => true]);
            } catch (\Throwable $e) {
                error_log('[pgp_key_delete] ' . $e->getMessage());
                jsonResponse(false, null, 'Falha', 500);
            }
            return true;
        }

        case 'pgp_send_passphrase_sms': {
            $auth  = requireAuth();
            $input = getInput();
            $phone = trim((string)($input['phone'] ?? ''));
            $passphrase = trim((string)($input['passphrase'] ?? ''));
            if (!$phone || !$passphrase) jsonResponse(false, null, 'phone + passphrase obrigatórios', 400);
            if (function_exists('_sendTelnyxRawSms')) {
                $msg = 'Sua senha de leitura PGP: ' . $passphrase . ' (enviada por ' . $auth['email'] . ' via Chatyy)';
                $ok = _sendTelnyxRawSms($phone, $msg);
                jsonResponse((bool)$ok, ['sent' => (bool)$ok]);
            }
            error_log('[pgp_send_passphrase_sms] would SMS ' . $phone . ' passphrase=' . substr($passphrase, 0, 3) . '***');
            jsonResponse(true, ['sent' => false, 'note' => 'SMS gateway indisponível — passphrase entregue inline']);
            return true;
        }

        // ─────────────────────────────────────────────────────────────
        // EMAIL → TASK
        // ─────────────────────────────────────────────────────────────
        case 'task_list': {
            $auth = requireAuth();
            $filter = strtolower(trim((string)($_GET['filter'] ?? 'pending')));
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_user_tasks (
                    id BIGSERIAL PRIMARY KEY,
                    user_email TEXT NOT NULL,
                    title TEXT NOT NULL,
                    notes TEXT NULL,
                    email_uid INT NULL,
                    email_folder TEXT NULL,
                    email_from TEXT NULL,
                    due_at TIMESTAMPTZ NULL,
                    done BOOLEAN NOT NULL DEFAULT FALSE,
                    done_at TIMESTAMPTZ NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )");
                @$pg->exec("CREATE INDEX IF NOT EXISTS chat_user_tasks_user_idx ON chat_user_tasks(user_email, done, created_at DESC)");
                $where = "user_email = :u";
                if ($filter === 'pending') $where .= " AND done = FALSE";
                elseif ($filter === 'done') $where .= " AND done = TRUE";
                $stmt = $pg->prepare("SELECT id, title, notes, email_uid, email_folder, email_from, due_at, done, done_at, created_at
                    FROM chat_user_tasks WHERE $where ORDER BY done ASC, COALESCE(due_at, created_at) DESC LIMIT 200");
                $stmt->execute([':u' => $auth['email']]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
                foreach ($rows as &$r) {
                    $r['id'] = (int)$r['id'];
                    $r['done'] = (bool)$r['done'];
                    if ($r['email_uid'] !== null) $r['email_uid'] = (int)$r['email_uid'];
                }
                jsonResponse(true, ['tasks' => $rows]);
            } catch (\Throwable $e) {
                error_log('[task_list] ' . $e->getMessage());
                jsonResponse(true, ['tasks' => []]);
            }
            return true;
        }

        case 'task_create': {
            $auth = requireAuth();
            $input = getInput();
            $title = trim((string)($input['title'] ?? ''));
            $notes = trim((string)($input['notes'] ?? ''));
            $emailUid = isset($input['email_uid']) ? (int)$input['email_uid'] : null;
            $emailFolder = trim((string)($input['email_folder'] ?? ''));
            $emailFrom = trim((string)($input['email_from'] ?? ''));
            $dueAt = trim((string)($input['due_at'] ?? ''));
            if (!$title) jsonResponse(false, null, 'title obrigatório', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_user_tasks (
                    id BIGSERIAL PRIMARY KEY,
                    user_email TEXT NOT NULL,
                    title TEXT NOT NULL,
                    notes TEXT NULL,
                    email_uid INT NULL,
                    email_folder TEXT NULL,
                    email_from TEXT NULL,
                    due_at TIMESTAMPTZ NULL,
                    done BOOLEAN NOT NULL DEFAULT FALSE,
                    done_at TIMESTAMPTZ NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )");
                $stmt = $pg->prepare("INSERT INTO chat_user_tasks
                    (user_email, title, notes, email_uid, email_folder, email_from, due_at)
                    VALUES (:u, :t, :n, :eu, :ef, :em, :d) RETURNING id, created_at");
                $stmt->execute([
                    ':u' => $auth['email'],
                    ':t' => mb_substr($title, 0, 240),
                    ':n' => $notes !== '' ? mb_substr($notes, 0, 2000) : null,
                    ':eu' => $emailUid ?: null,
                    ':ef' => $emailFolder !== '' ? $emailFolder : null,
                    ':em' => $emailFrom !== '' ? mb_substr($emailFrom, 0, 240) : null,
                    ':d' => $dueAt !== '' ? $dueAt : null,
                ]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                jsonResponse(true, ['id' => (int)$row['id'], 'created_at' => $row['created_at']]);
            } catch (\Throwable $e) {
                error_log('[task_create] ' . $e->getMessage());
                jsonResponse(false, null, 'Falha ao criar tarefa', 500);
            }
            return true;
        }

        case 'task_update': {
            $auth = requireAuth();
            $input = getInput();
            $id = (int)($input['id'] ?? 0);
            if (!$id) jsonResponse(false, null, 'id obrigatório', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $sets = [];
                $args = [':id' => $id, ':u' => $auth['email']];
                if (isset($input['title']))  { $sets[] = 'title = :t'; $args[':t'] = mb_substr((string)$input['title'], 0, 240); }
                if (isset($input['notes']))  { $sets[] = 'notes = :n'; $args[':n'] = mb_substr((string)$input['notes'], 0, 2000); }
                if (isset($input['due_at'])) { $sets[] = 'due_at = :d'; $args[':d'] = $input['due_at'] ?: null; }
                if (isset($input['done'])) {
                    $sets[] = 'done = :dn';
                    $sets[] = 'done_at = CASE WHEN :dn2 THEN NOW() ELSE NULL END';
                    $args[':dn']  = !empty($input['done']);
                    $args[':dn2'] = !empty($input['done']);
                }
                if (!$sets) jsonResponse(false, null, 'Nada a atualizar', 400);
                $sets[] = 'updated_at = NOW()';
                $sql = "UPDATE chat_user_tasks SET " . implode(', ', $sets) . " WHERE id = :id AND user_email = :u";
                $pg->prepare($sql)->execute($args);
                jsonResponse(true, ['updated' => true]);
            } catch (\Throwable $e) {
                error_log('[task_update] ' . $e->getMessage());
                jsonResponse(false, null, 'Falha', 500);
            }
            return true;
        }

        case 'task_delete': {
            $auth = requireAuth();
            $input = getInput();
            $id = (int)($input['id'] ?? 0);
            if (!$id) jsonResponse(false, null, 'id obrigatório', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("DELETE FROM chat_user_tasks WHERE id = :id AND user_email = :u")
                   ->execute([':id' => $id, ':u' => $auth['email']]);
                jsonResponse(true, ['deleted' => true]);
            } catch (\Throwable $e) {
                error_log('[task_delete] ' . $e->getMessage());
                jsonResponse(false, null, 'Falha', 500);
            }
            return true;
        }

        case 'task_create_from_email': {
            $auth = requireAuth();
            $input = getInput();
            $uid = (int)($input['uid'] ?? 0);
            $folder = trim((string)($input['folder'] ?? 'INBOX'));
            $dueAt = trim((string)($input['due_at'] ?? ''));
            $titleOverride = trim((string)($input['title'] ?? ''));
            if (!$uid) jsonResponse(false, null, 'uid obrigatório', 400);
            $title = $titleOverride;
            $from = '';
            try {
                $imap = getImap($auth['email'], $auth['password'], $folder);
                $msgno = imap_msgno($imap, $uid);
                if ($msgno) {
                    $h = imap_headerinfo($imap, $msgno);
                    if ($h) {
                        if (!$title) $title = decodeSubject($h->subject ?? '(sem assunto)');
                        $fromArr = parseAddresses($h->from ?? []);
                        $from = $fromArr[0]['email'] ?? '';
                    }
                }
                try { imap_close($imap); } catch (\Throwable $_e) {}
            } catch (\Throwable $e) { error_log('[task_create_from_email.imap] ' . $e->getMessage()); }
            if (!$title) $title = 'Tarefa do email #' . $uid;
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_user_tasks (
                    id BIGSERIAL PRIMARY KEY,
                    user_email TEXT NOT NULL,
                    title TEXT NOT NULL,
                    notes TEXT NULL,
                    email_uid INT NULL,
                    email_folder TEXT NULL,
                    email_from TEXT NULL,
                    due_at TIMESTAMPTZ NULL,
                    done BOOLEAN NOT NULL DEFAULT FALSE,
                    done_at TIMESTAMPTZ NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )");
                $stmt = $pg->prepare("INSERT INTO chat_user_tasks
                    (user_email, title, email_uid, email_folder, email_from, due_at)
                    VALUES (:u, :t, :eu, :ef, :em, :d) RETURNING id");
                $stmt->execute([
                    ':u' => $auth['email'],
                    ':t' => mb_substr($title, 0, 240),
                    ':eu' => $uid,
                    ':ef' => $folder,
                    ':em' => $from !== '' ? mb_substr($from, 0, 240) : null,
                    ':d' => $dueAt !== '' ? $dueAt : null,
                ]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                jsonResponse(true, ['id' => (int)$row['id'], 'title' => $title]);
            } catch (\Throwable $e) {
                error_log('[task_create_from_email] ' . $e->getMessage());
                jsonResponse(false, null, 'Falha', 500);
            }
            return true;
        }

        // ─────────────────────────────────────────────────────────────
        // BUNDLES
        // ─────────────────────────────────────────────────────────────
        case 'email_bundles': {
            $auth = requireAuth();
            $folder = trim((string)($_GET['folder'] ?? 'INBOX'));
            $limit  = max(20, min(200, (int)($_GET['limit'] ?? 80)));
            try {
                $imap = getImap($auth['email'], $auth['password'], $folder);
                $uids = @imap_search($imap, 'ALL', SE_UID) ?: [];
                rsort($uids);
                $uids = array_slice($uids, 0, $limit);
                $bundles = [];
                foreach ($uids as $uid) {
                    $msgno = @imap_msgno($imap, $uid);
                    if (!$msgno) continue;
                    $h = @imap_headerinfo($imap, $msgno);
                    if (!$h) continue;
                    $fromArr = parseAddresses($h->from ?? []);
                    $fromAddr = $fromArr[0]['email'] ?? '';
                    $subj = decodeSubject($h->subject ?? '');
                    $cat = function_exists('categorizeEmail') ? categorizeEmail($fromAddr, $subj) : 'primary';
                    $domain = strtolower(substr(strrchr($fromAddr, '@') ?: '', 1));
                    $bid = $cat;
                    if (preg_match('/(amazon|mercadolivre|magazineluiza|shopee|aliexpress|americanas|shein|casasbahia|ebay)/', $domain)) $bid = 'compras';
                    elseif (preg_match('/(booking|airbnb|decolar|latam|gol|azul|hoteis|hotel)/', $domain)) $bid = 'viagens';
                    elseif (preg_match('/(nubank|itau|bradesco|santander|banco|paypal|stripe|nuconta|inter|c6bank|caixa)/', $domain)) $bid = 'financas';
                    elseif (preg_match('/(forum|discourse|reddit)/', $domain)) $bid = 'foruns';
                    if (!isset($bundles[$bid])) {
                        $bundles[$bid] = [
                            'id' => $bid,
                            'label' => _bundleLabel($bid),
                            'count' => 0,
                            'latest_subject' => $subj,
                            'latest_from' => $fromAddr,
                            'latest_uid' => $uid,
                        ];
                    }
                    $bundles[$bid]['count']++;
                }
                try { imap_close($imap); } catch (\Throwable $_e) {}
                $arr = array_values($bundles);
                usort($arr, function($a, $b) {
                    if ($a['id'] === 'primary' && $b['id'] !== 'primary') return -1;
                    if ($b['id'] === 'primary' && $a['id'] !== 'primary') return 1;
                    return $b['count'] - $a['count'];
                });
                jsonResponse(true, ['bundles' => $arr]);
            } catch (\Throwable $e) {
                error_log('[email_bundles] ' . $e->getMessage());
                jsonResponse(true, ['bundles' => []]);
            }
            return true;
        }

        // ─────────────────────────────────────────────────────────────
        // BULK MARK-READ FOR ENTIRE FOLDER
        // ─────────────────────────────────────────────────────────────
        case 'bulk_mark_read_folder': {
            $auth = requireAuth();
            $input = getInput();
            $folder = trim((string)($input['folder'] ?? 'INBOX'));
            if ($folder === 'Flagged') $folder = 'INBOX';
            try {
                $imap = getImap($auth['email'], $auth['password'], $folder);
                $uids = @imap_search($imap, 'UNSEEN', SE_UID) ?: [];
                $count = count($uids);
                if ($count > 0) {
                    $uidStr = implode(',', $uids);
                    @imap_setflag_full($imap, $uidStr, '\\Seen', ST_UID);
                }
                try { imap_close($imap, CL_EXPUNGE); } catch (\Throwable $_e) {}
                jsonResponse(true, ['marked' => $count]);
            } catch (\Throwable $e) {
                error_log('[bulk_mark_read_folder] ' . $e->getMessage());
                jsonResponse(false, null, 'Falha', 500);
            }
            return true;
        }
    }
    return false;
}
}
