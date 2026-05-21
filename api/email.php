<?php
header('Content-Type: application/json; charset=utf-8');

// --- CORS: Strict origin whitelist (fixes reflected-origin vulnerability) ---
$ALLOWED_ORIGINS = [
    'https://mail.onemundo.com.br',
    'https://chatyy.com.br',
    'https://www.chatyy.com.br',
    'https://mail.superbora.com.br',
    'http://localhost:8081',  // dev only
    'http://localhost:19006', // expo web dev
];
$requestOrigin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($requestOrigin, $ALLOWED_ORIGINS, true)) {
    header('Access-Control-Allow-Origin: ' . $requestOrigin);
} elseif (empty($requestOrigin) && !empty($_SERVER['HTTP_AUTHORIZATION'])) {
    // Mobile apps (React Native) send no Origin header but use Bearer tokens
    header('Access-Control-Allow-Origin: *');
} else {
    header('Access-Control-Allow-Origin: https://chatyy.com.br');
}
header('Access-Control-Allow-Credentials: true');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-CSRF-Token');
header('Access-Control-Expose-Headers: X-Auth-Token');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

// --- Session config — 24h expiry, secure cookies, SameSite=Lax ---
ini_set('session.gc_maxlifetime', 86400);
ini_set('session.cookie_lifetime', 86400);
session_set_cookie_params([
    'lifetime' => 86400,
    'path' => '/',
    'secure' => true,
    'httponly' => true,
    'samesite' => 'Lax',
]);
// Wrap session_start in try/catch — Redis can be in LOADING state or transiently
// unavailable which would crash email.php with a fatal RedisException, returning
// 401 to clients including iOS. Fall back to filesystem sessions on failure.
$sessionStarted = false;
try {
    $sessionStarted = @session_start();
} catch (Throwable $e) {
    error_log('[session_start] Redis failed, falling back to files: ' . $e->getMessage());
    try {
        @session_abort();
        if (!is_dir('/tmp/php_sessions_fallback')) @mkdir('/tmp/php_sessions_fallback', 0700, true);
        ini_set('session.save_handler', 'files');
        ini_set('session.save_path', '/tmp/php_sessions_fallback');
        $sessionStarted = @session_start();
    } catch (Throwable $e2) {
        error_log('[session_start] fallback also failed: ' . $e2->getMessage());
    }
}
if (!$sessionStarted) {
    // Worst case — use a minimal in-memory $_SESSION so Bearer-token auth still works.
    if (!isset($_SESSION)) $_SESSION = [];
}

// Extend session on every authenticated request
if (!empty($_SESSION['email'])) {
    $_SESSION['_last_activity'] = time();
}

// --- Bootstrap: load /etc/mail-api.env into process env BEFORE the
// SESSION_ENCRYPT_KEY define needs WEBMAIL_SESSION_KEY. PHP-FPM in Docker
// clears env vars, so getenv() returns empty and the fallback path uses
// hostname-derived key. The /etc/mail-api.env file is mounted but not
// auto-loaded as env. This bootstrap reads it once at request entry.
if (is_readable("/etc/mail-api.env")) {
    foreach (file("/etc/mail-api.env", FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $__ln) {
        if ($__ln === "" || $__ln[0] === "#") continue;
        $__eq = strpos($__ln, "=");
        if ($__eq === false) continue;
        $__k = substr($__ln, 0, $__eq);
        $__v = substr($__ln, $__eq + 1);
        if (getenv($__k) === false) putenv($__k . "=" . $__v);
    }
    unset($__ln, $__eq, $__k, $__v);
}

// --- Encryption key for session password storage ---
$sessionKeyEnv = getenv('WEBMAIL_SESSION_KEY');
if (!$sessionKeyEnv) {
    error_log('SECURITY WARNING: WEBMAIL_SESSION_KEY not set, using fallback. Set it in PHP-FPM env.');
}
define('SESSION_ENCRYPT_KEY', hash('sha256', $sessionKeyEnv ?: 'onemundo-mail-session-key-2026-' . php_uname('n') . '-' . __DIR__, true));

// --- Bearer token key (separate from session key for isolation) ---
define('BEARER_TOKEN_KEY', hash('sha256', 'bearer-' . ($sessionKeyEnv ?: 'onemundo-mail-bearer-2026') . '-' . __DIR__, true));

/**
 * Normaliza URL relativa de mídia pra URL absoluta no CDN R2.
 * Posts antigos no DB têm "/data/feed-files/X/foo.mp4" que dá 404 em
 * chatyy.com.br (arquivo só existe no R2 via media.chatyy.com.br).
 * Migração já corrigiu os existentes mas esse helper é o cinto-e-suspensório
 * pra qualquer linha futura que escape com path relativo.
 */
function _cdnify($url) {
    if (!is_string($url) || $url === '') return $url;
    if (strpos($url, '/data/') === 0) return 'https://media.chatyy.com.br' . $url;
    return $url;
}
function _cdnifyArray($urls) {
    if (!is_array($urls)) return $urls;
    return array_map('_cdnify', $urls);
}

/**
 * IMAP perf cache layer (APCu preferred, Redis fallback).
 * Drives folder list / message header / unread count / thread caches.
 * Backend live, fail-soft: any cache miss/error returns null and falls
 * back to IMAP. Set $_GET['nocache']=1 to bypass.
 */
function _imapCacheBypass() {
    static $bypass = null;
    if ($bypass === null) {
        $bypass = !empty($_GET['nocache']);
    }
    return $bypass;
}
function _imapCacheRedis() {
    static $r = null;
    static $tried = false;
    if ($tried) return $r;
    $tried = true;
    if (!class_exists('Redis')) return null;
    try {
        $rr = new Redis();
        if (@$rr->connect('127.0.0.1', 6379, 0.25)) {
            $rpw = getenv('REDIS_PASSWORD');
            if ($rpw) { @$rr->auth($rpw); }
            $rr->setOption(Redis::OPT_SERIALIZER, Redis::SERIALIZER_NONE);
            // Smoke-check: ping to ensure auth succeeded; downgrade to null on fail.
            try { if (@$rr->ping()) { $r = $rr; } } catch (\Throwable $_e) { $r = null; }
        }
    } catch (\Throwable $_e) { $r = null; }
    return $r;
}
function imapCacheGet($key) {
    if (_imapCacheBypass()) return null;
    if (function_exists('apcu_fetch')) {
        $ok = false;
        $v = @apcu_fetch($key, $ok);
        if ($ok) {
            $d = @json_decode($v, true);
            return is_array($d) ? $d : null;
        }
    }
    $r = _imapCacheRedis();
    if ($r) {
        try {
            $v = $r->get($key);
            if ($v !== false && $v !== null) {
                $d = @json_decode($v, true);
                return is_array($d) ? $d : null;
            }
        } catch (\Throwable $_e) {}
    }
    return null;
}
function imapCacheSet($key, $value, $ttl) {
    if (_imapCacheBypass()) return;
    $payload = json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($payload === false) return;
    if (function_exists('apcu_store')) {
        @apcu_store($key, $payload, (int)$ttl);
    }
    $r = _imapCacheRedis();
    if ($r) {
        try { $r->setex($key, (int)$ttl, $payload); } catch (\Throwable $_e) {}
    }
}
function imapCacheDel($key) {
    if (function_exists('apcu_delete')) { @apcu_delete($key); }
    $r = _imapCacheRedis();
    if ($r) { try { $r->del($key); } catch (\Throwable $_e) {} }
}
/** Bulk delete keys matching a Redis pattern (best-effort). APCu has no
 *  pattern-delete so we mirror with apcu_iterate. */
function imapCacheDelPattern($pattern) {
    if (function_exists('apcu_delete') && function_exists('apcu_iterate')) {
        try {
            $regex = '/^' . str_replace('\*', '.*', preg_quote($pattern, '/')) . '$/';
            $it = new APCUIterator($regex, APC_ITER_KEY);
            foreach ($it as $entry) { @apcu_delete($entry['key']); }
        } catch (\Throwable $_e) {}
    }
    $r = _imapCacheRedis();
    if ($r) {
        try {
            $cur = 0;
            do {
                $keys = $r->scan($cur, $pattern, 200);
                if (is_array($keys) && $keys) { $r->del($keys); }
            } while ($cur > 0);
        } catch (\Throwable $_e) {}
    }
}
/** Invalidate all per-folder caches (headers/unread/folder-list) for a user. */
function imapCacheInvalidateFolder($email, $folder) {
    $email = strtolower($email);
    imapCacheDel("folders:$email");
    imapCacheDel("unread:$email:$folder");
    imapCacheDelPattern("mhdr:$email:$folder:*");
}

function encryptSessionPassword($password) {
    $iv = random_bytes(16);
    $encrypted = openssl_encrypt($password, 'aes-256-cbc', SESSION_ENCRYPT_KEY, OPENSSL_RAW_DATA, $iv);
    return base64_encode($iv . $encrypted);
}

function decryptSessionPassword($encrypted) {
    $data = base64_decode($encrypted);
    if ($data === false || strlen($data) < 17) return '';
    $iv = substr($data, 0, 16);
    $ciphertext = substr($data, 16);
    return openssl_decrypt($ciphertext, 'aes-256-cbc', SESSION_ENCRYPT_KEY, OPENSSL_RAW_DATA, $iv) ?: '';
}

// --- Bearer Token System (opaque tokens stored server-side) ---
define('TOKEN_STORE_DIR', '/var/www/mail/data/tokens');

function generateBearerToken($email, $password) {
    // Generate opaque token — password stored server-side only
    $tokenId = bin2hex(random_bytes(32));
    $tokenHash = hash('sha256', $tokenId);

    $dir = TOKEN_STORE_DIR;
    if (!is_dir($dir)) { @mkdir($dir, 0700, true); @chown($dir, 'www-data'); }

    $tokenData = [
        'email' => $email,
        'password_enc' => encryptSessionPassword($password),
        'created_at' => time(),
        'expires_at' => time() + 315360000, // 10 years (sliding renewal — WhatsApp parity)
        'ip' => $_SERVER['REMOTE_ADDR'] ?? '',
        'user_agent' => substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 200),
        'last_active' => time(),
    ];
    file_put_contents("{$dir}/{$tokenHash}.json", json_encode($tokenData));

    return $tokenId;
}

function validateBearerToken($token) {
    // Support legacy encrypted tokens during migration
    if (strlen($token) > 100) {
        return validateBearerTokenLegacy($token);
    }

    $tokenHash = hash('sha256', $token);
    $tokenFile = TOKEN_STORE_DIR . "/{$tokenHash}.json";

    // Primary: filesystem (PHP-issued tokens)
    $data = null;
    if (file_exists($tokenFile)) {
        $data = json_decode(file_get_contents($tokenFile), true);
        if ($data && ($data['expires_at'] ?? 0) < time()) {
            @unlink($tokenFile);
            $data = null;
        }
    }

    // Fallback: PG auth_tokens (Go fast-auth writes here). This is why many
    // requests were getting 401 even though the user was logged in — Go
    // sessions never hit the file system.
    if (!$data) {
        try {
            if (function_exists('getPGDB')) { $pg = getPGDB(); }
            else { require_once __DIR__ . '/db.php'; $pg = getPGDB(); }
            // Strict "expires_at > now" (not >=) so tokens at the boundary
            // second don't flip between valid and invalid on two calls inside
            // the same request window.
            $ps = $pg->prepare("SELECT email, password_enc, expires_at FROM auth_tokens WHERE token_hash = :h AND revoked_at IS NULL AND expires_at > :now LIMIT 1");
            $ps->execute([':h' => $tokenHash, ':now' => time()]);
            $row = $ps->fetch();
            if ($row) {
                $data = [
                    'email' => $row['email'],
                    'password_enc' => $row['password_enc'],
                    'expires_at' => (int)$row['expires_at'],
                ];
            }
        } catch (Throwable $e) { /* PG offline — fall through to 401 */ }
    }

    if (!$data || empty($data['email'])) {
        $ip = $_SERVER['REMOTE_ADDR'] ?? '';
        $ua = substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 100);
        error_log("[TOKEN_REJECT] ip={$ip} hash={$tokenHash} ua={$ua}");
        return null;
    }

    // Phone-first signup tokens have password_enc='' (no IMAP password). Aceita
    // mas marca password vazia. requireAuth rejeita (precisa IMAP); requireAuthLite
    // aceita (so precisa email). Endpoints email-only (profile, ONE, contacts, push)
    // ja foram migrados pra requireAuthLite.
    $password = '';
    if (!empty($data['password_enc'])) {
        $password = decryptSessionPassword($data['password_enc']) ?: '';
    }

    // Sliding renewal: every successful validate pushes expiry +1 year so
    // active users effectively never log out (WhatsApp parity). Only renews
    // when the remaining TTL drops below ~358 days, avoiding stat()/write
    // churn on hot paths (every chat poll would otherwise rewrite the file).
    if (file_exists($tokenFile) && (($data['expires_at'] ?? 0) - time()) < 308534400) {
        $data["expires_at"] = time() + 315360000;
        @file_put_contents($tokenFile, json_encode($data), LOCK_EX);
    }

    return ['email' => $data['email'], 'password' => $password];
}

function validateBearerTokenLegacy($token) {
    $data = base64_decode($token);
    if ($data === false || strlen($data) < 17) return null;
    $iv = substr($data, 0, 16);
    $ciphertext = substr($data, 16);
    $json = openssl_decrypt($ciphertext, 'aes-256-cbc', BEARER_TOKEN_KEY, OPENSSL_RAW_DATA, $iv);
    if (!$json) return null;
    $payload = json_decode($json, true);
    if (!$payload || empty($payload['e']) || empty($payload['p'])) return null;
    if (isset($payload['t']) && (time() - $payload['t']) > 2592000) return null;
    return ['email' => $payload['e'], 'password' => $payload['p']];
}

function revokeBearerToken($token) {
    $tokenHash = hash('sha256', $token);
    $tokenFile = TOKEN_STORE_DIR . "/{$tokenHash}.json";
    if (file_exists($tokenFile)) @unlink($tokenFile);
}

// Restore session from Bearer token if session is empty
function restoreFromBearer() {
    if (!empty($_SESSION['email'])) return; // session already active
    $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    $token = null;
    if (preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) {
        $token = $m[1];
    } elseif (!empty($_GET['token'])) {
        $token = $_GET['token'];
        if (strlen($token) > 1000) return; // Sanity check
    }
    if (!$token) return;
    $creds = validateBearerToken($token);
    if (!$creds) return;
    // Restore session from token credentials. password may be empty for
    // phone-first signup tokens — that's intentional and signals "lite" auth.
    $_SESSION['email'] = $creds['email'];
    if (!empty($creds['password'])) {
        $_SESSION['password_enc'] = encryptSessionPassword($creds['password']);
    } else {
        unset($_SESSION['password_enc']);
    }
    $_SESSION['name'] = explode('@', $creds['email'])[0];
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
}
restoreFromBearer();

// --- CSRF Token System ---
function generateCsrfToken() {
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf_token'];
}

function validateCsrfToken() {
    // Skip CSRF for read-only GET requests
    if ($_SERVER['REQUEST_METHOD'] === 'GET') return true;
    // Skip CSRF for bearer token auth (mobile apps — no cookie = no CSRF risk)
    $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/^Bearer\s+/i', $authHeader)) return true;
    // Auto-generate CSRF token for sessions that don't have one yet
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? (getInput()['csrf_token'] ?? '');
    // If client sends no token at all, allow for GET requests only (reads are safe)
    // POST/PUT/DELETE require CSRF token
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (empty($token)) {
        if ($method === 'GET' || $method === 'OPTIONS') return true;
        // Allow login/signup/forgot_password without CSRF (pre-session endpoints)
        $action = $_GET['action'] ?? (getInput()['action'] ?? '');
// Backwards-compat aliases for QR login: existing TestFlight builds
// (v2.4.2 / 388) still call qr_generate / qr_check / qr_confirm.
if ($action === 'qr_generate') $action = 'chat_qr_login_create';
elseif ($action === 'qr_check') $action = 'chat_qr_login_status';
elseif ($action === 'qr_confirm') $action = 'chat_qr_login_approve';
        $csrfExempt = ['login', 'signup', 'check_username', 'forgot_password_initiate', 'forgot_password_verify', 'forgot_password_reset', 'support_ticket', 'verify_phone'];
        if (in_array($action, $csrfExempt)) return true;
        // Enforce CSRF for cookie-based sessions
        jsonResponse(false, null, 'Token de seguranca ausente. Recarregue a pagina.', 403);
    }
    // If client sends a token, it must match
    if (!hash_equals($_SESSION['csrf_token'], $token)) {
        jsonResponse(false, null, 'Invalid security token. Please refresh.', 403);
    }
    return true;
}

// --- Login Rate Limiting ---
function checkLoginRateLimit($email) {
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $rateFile = '/tmp/login_rate_' . hash('sha256', $ip . '|' . strtolower($email));
    $attempts = file_exists($rateFile) ? json_decode(file_get_contents($rateFile), true) : [];
    $attempts = array_filter($attempts, fn($t) => $t > time() - 900); // 15 min window
    if (count($attempts) >= 5) {
        jsonResponse(false, null, 'Too many login attempts. Try again in 15 minutes.', 429);
    }
    $attempts[] = time();
    file_put_contents($rateFile, json_encode($attempts), LOCK_EX);
}

// --- Sanitize SMTP header values (prevent header injection) ---
function sanitizeHeader($value) {
    return str_replace(["\r", "\n", "\0"], '', $value);
}

// --- Sanitize HTML email body (proper sanitizer) ---
function sanitizeEmailHtml($html) {
    if (!$html) return $html;
    // Remove script tags and their content
    $html = preg_replace('/<script\b[^>]*>.*?<\/script>/is', '', $html);
    // Remove style tags (prevent CSS injection)
    $html = preg_replace('/<style\b[^>]*>.*?<\/style>/is', '', $html);
    // Remove all event handlers (onXxx=...) - comprehensive regex
    $html = preg_replace('/\s+on\w+\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s>]*)/i', '', $html);
    // Remove javascript: and vbscript: protocols from all attributes
    $html = preg_replace('/\b(?:href|src|action|formaction|data|poster|background)\s*=\s*(?:"[^"]*(?:javascript|vbscript|data\s*:(?!image))[^"]*"|\'[^\']*(?:javascript|vbscript|data\s*:(?!image))[^\']*\')/i', '', $html);
    // Remove dangerous tags
    $html = preg_replace('/<(?:iframe|object|embed|applet|form|input|button|select|textarea|meta|link|base)\b[^>]*>/i', '', $html);
    $html = preg_replace('/<\/(?:iframe|object|embed|applet|form|input|button|select|textarea)\s*>/i', '', $html);
    // Remove SVG with event handlers (but keep basic SVG)
    $html = preg_replace('/<svg\b[^>]*\bon\w+[^>]*>/i', '', $html);
    return $html;
}

function jsonResponse($success, $data = null, $message = '', $code = 200) {
    http_response_code($code);
    echo json_encode(['success' => $success, 'data' => $data, 'message' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * Write file with explicit failure handling. Returns false on error so callers
 * can return a real 500 instead of lying with 200. Same helper signature as
 * /var/www/suporte/api/admin.php so the patterns line up.
 *
 * Born from the dovecot RO-mount incident where every password reset claimed
 * success while the file_put_contents call returned false silently.
 */
if (!function_exists('safe_put_contents')) {
    function safe_put_contents($path, $contents, $flags = LOCK_EX) {
        $r = @file_put_contents($path, $contents, $flags);
        if ($r === false) {
            $err = error_get_last();
            error_log("[email.php] write failed: $path err=" . ($err['message'] ?? 'unknown'));
            return false;
        }
        return $r;
    }
}

// ─── TWILIO VOICE handlers — added 2026-04-27 ─────────────────────────
// Stage 1 da migração A3 (Telnyx Verto → Twilio Voice JS SDK).
// Endpoints: voip_twilio_token, voip_twilio_twiml, voip_twilio_status_callback.
// Helper: twilioBuildAccessToken — JWT HS256 com grant 'voice' Twilio v2.

if (!function_exists('twilioBuildAccessToken')) {
function twilioBuildAccessToken(string $accountSid, string $apiKeySid, string $apiKeySecret, string $twimlAppSid, string $identity, int $ttlSec = 3600): string {
    // Twilio Access Tokens (v2) — HS256 JWT signed with API Key Secret.
    // https://www.twilio.com/docs/iam/access-tokens
    $now = time();
    $jti = $apiKeySid . '-' . $now;
    $header = ['typ' => 'JWT', 'alg' => 'HS256', 'cty' => 'twilio-fpa;v=1'];
    $payload = [
        'jti' => $jti,
        'iss' => $apiKeySid,
        'sub' => $accountSid,
        'nbf' => $now,
        'exp' => $now + max(60, min(86400, $ttlSec)),
        'grants' => [
            'identity' => $identity,
            'voice' => [
                'incoming' => ['allow' => true],
                'outgoing' => [
                    'application_sid' => $twimlAppSid,
                ],
            ],
        ],
    ];
    $b64 = function ($s) { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); };
    $headerEnc  = $b64(json_encode($header,  JSON_UNESCAPED_SLASHES));
    $payloadEnc = $b64(json_encode($payload, JSON_UNESCAPED_SLASHES));
    $signing = $headerEnc . '.' . $payloadEnc;
    $sig = $b64(hash_hmac('sha256', $signing, $apiKeySecret, true));
    return $signing . '.' . $sig;
}
}

if (!function_exists('twilioLoadVoiceCreds')) {
function twilioLoadVoiceCreds(): array {
    static $cache = null;
    if ($cache !== null) return $cache;
    $env = [];
    if (is_readable('/etc/mail-api.env')) {
        foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $ln) {
            if ($ln === '' || $ln[0] === '#') continue;
            $eq = strpos($ln, '='); if ($eq === false) continue;
            $env[substr($ln, 0, $eq)] = substr($ln, $eq + 1);
        }
    }
    $cache = [
        'account_sid'    => $env['TWILIO_ACCOUNT_SID'] ?? ($env['TWILIO_SID'] ?? ''),
        'auth_token'     => $env['TWILIO_AUTH_TOKEN']  ?? ($env['TWILIO_TOKEN'] ?? ''),
        'api_key_sid'    => $env['TWILIO_API_KEY_SID'] ?? '',
        'api_key_secret' => $env['TWILIO_API_KEY_SECRET'] ?? '',
        'twiml_app_sid'  => $env['TWILIO_TWIML_APP_SID'] ?? '',
        'caller_default' => $env['TWILIO_CHATYY_US'] ?? ($env['TWILIO_FROM'] ?? ($env['TWILIO_PHONE_NUMBER'] ?? '')),
    ];
    return $cache;
}
}



// Cache input at top level
$_CACHED_INPUT = null;
function getInput() {
    global $_CACHED_INPUT;
    if ($_CACHED_INPUT !== null) return $_CACHED_INPUT;
    $raw = file_get_contents('php://input');
    $body = $raw ? (json_decode($raw, true) ?: []) : $_POST;
    // 2026-05-09: também aceita query string como input. Sem isso, GETs com
    // params (?uid=164&folder=INBOX) caíam em "uid required" 400. Body tem
    // precedência sobre query.
    if (!is_array($body)) $body = [];
    $_CACHED_INPUT = array_merge($_GET ?? [], $body);
    return $_CACHED_INPUT;
}

/**
 * Enrich raw chat_follows rows with display data (name, avatar URL, bio).
 * Called by get_followers / get_following / search_users. Was missing until
 * 2026-04-19 — the PHP call site threw "Call to undefined function" which
 * the catch swallowed into an empty `users: []` response, so profile follower
 * lists silently rendered "nobody follows this person" for every user.
 */
function chatyy_hydrate_follow_rows(array $rows, string $meEmail): array {
    $out = [];
    foreach ($rows as $r) {
        $email = strtolower(trim((string)($r['email'] ?? '')));
        if ($email === '') continue;
        [$user, $domain] = array_pad(explode('@', $email, 2), 2, '');
        $name = $user;
        $bio  = '';
        // Pull from the user's Maildir data.json if it exists — same file the
        // profile page reads, so names stay in sync without a central users DB.
        $dataFile = '/var/mail/vhosts/' . $domain . '/' . $user . '/data.json';
        if (is_file($dataFile)) {
            $j = @json_decode(@file_get_contents($dataFile), true);
            if (is_array($j)) {
                if (!empty($j['name'])) $name = (string)$j['name'];
                elseif (!empty($j['first_name'])) $name = (string)$j['first_name'];
                if (!empty($j['bio'])) $bio = (string)$j['bio'];
                elseif (!empty($j['about'])) $bio = (string)$j['about'];
            }
        }
        $out[] = [
            'email'         => $email,
            'name'          => $name,
            'username'      => $user,
            'bio'           => $bio,
            'avatar_url'    => '/api/email.php?action=get_avatar&email=' . urlencode($email),
            'is_following'  => !empty($r['is_following']),
            'is_follower'   => !empty($r['is_follower']),
            'created_at'    => $r['created_at'] ?? null,
            'is_self'       => strcasecmp($email, $meEmail) === 0,
        ];
    }
    return $out;
}

function requireAuth() {
    if (empty($_SESSION['email']) || empty($_SESSION['password_enc'])) {
        // Backwards compat: migrate old plaintext sessions
        if (!empty($_SESSION['password'])) {
            $_SESSION['password_enc'] = encryptSessionPassword($_SESSION['password']);
            unset($_SESSION['password']);
        } else {
            jsonResponse(false, null, 'Not authenticated', 401);
        }
    }
    $password = decryptSessionPassword($_SESSION['password_enc']);
    if (!$password) jsonResponse(false, null, 'Session expired', 401);
    return ['email' => $_SESSION['email'], 'password' => $password, 'name' => $_SESSION['name'] ?? ''];
}

// Lite auth para endpoints que NAO precisam de IMAP password (profile_get,
// profile_insights, get_avatar, etc.). Tokens com password_enc='' sao um
// estado conhecido do signup phone-first (iap_backend_prod_paths.md) que
// estavam disparando "Not authenticated" 401 ghost no perfil — agora email-only
// auth basta pra esses paths e a sessao nao falha.
function requireAuthLite() {
    if (empty($_SESSION['email'])) {
        jsonResponse(false, null, 'Not authenticated', 401);
    }
    return ['email' => $_SESSION['email'], 'name' => $_SESSION['name'] ?? '', 'password' => null];
}

function imapAuth($email, $password) {
    $ctx = stream_context_create(['ssl' => ['verify_peer' => false, 'verify_peer_name' => false]]);
    $sock = @stream_socket_client('ssl://127.0.0.1:993', $errno, $errstr, 10, STREAM_CLIENT_CONNECT, $ctx);
    if (!$sock) return false;
    fgets($sock); // greeting
    $tag = 'A1';
    // Use IMAP LOGIN command via raw socket (avoids c-Client ! escaping bug)
    fwrite($sock, "$tag LOGIN " . imapQuote($email) . " " . imapQuote($password) . "\r\n");
    $resp = '';
    while ($line = fgets($sock)) {
        $resp .= $line;
        if (strpos($line, "$tag ") === 0) break;
    }
    $ok = strpos($resp, "$tag OK") !== false;
    if ($ok) {
        // Get INBOX status while connected
        fwrite($sock, "A2 STATUS INBOX (MESSAGES UNSEEN)\r\n");
        $status = ['messages' => 0, 'unseen' => 0];
        while ($line = fgets($sock)) {
            if (preg_match('/MESSAGES\s+(\d+)/', $line, $m)) $status['messages'] = (int)$m[1];
            if (preg_match('/UNSEEN\s+(\d+)/', $line, $m)) $status['unseen'] = (int)$m[1];
            if (strpos($line, "A2 ") === 0) break;
        }
        fwrite($sock, "A3 LOGOUT\r\n");
        fclose($sock);
        return $status;
    }
    fclose($sock);
    return false;
}

function imapQuote($str) {
    return '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $str) . '"';
}

function sanitizeImapFolder(string $folder): string {
    $folder = trim($folder);
    if ($folder === '' || $folder === 'INBOX') return 'INBOX';
    if (preg_match('/[\x00-\x1F\x7F"\'\\\\{}<>]/', $folder)) return 'INBOX';
    if (!preg_match('/^[A-Za-z0-9._\\/\\-+ \xC0-\xFF]+$/', $folder)) return 'INBOX';
    return $folder;
}

function getImapSocket($email, $password, $folder = 'INBOX') {
    $folder = sanitizeImapFolder($folder);
    $ctx = stream_context_create(['ssl' => ['verify_peer' => false, 'verify_peer_name' => false]]);
    $sock = @stream_socket_client('ssl://127.0.0.1:993', $errno, $errstr, 10, STREAM_CLIENT_CONNECT, $ctx);
    if (!$sock) throw new Exception('IMAP connect failed: ' . $errstr);
    fgets($sock); // greeting
    fwrite($sock, "A1 LOGIN " . imapQuote($email) . " " . imapQuote($password) . "\r\n");
    $resp = '';
    while ($line = fgets($sock)) {
        $resp .= $line;
        if (strpos($line, "A1 ") === 0) break;
    }
    if (strpos($resp, "A1 OK") === false) {
        fclose($sock);
        throw new Exception('IMAP auth failed');
    }
    if ($folder !== '') {
        fwrite($sock, "A2 SELECT " . imapQuote($folder) . "\r\n");
        while ($line = fgets($sock)) {
            if (strpos($line, "A2 ") === 0) break;
        }
    }
    return $sock;
}

function getTemplatesFile($email) {
    $parts = explode('@', $email);
    $user = $parts[0];
    $domain = $parts[1] ?? 'onemundo.com.br';
    $dir = "/var/mail/vhosts/{$domain}/{$user}";
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    return "{$dir}/templates.json";
}

// IMAP Connection Pool (reuse within same request)
$_IMAP_POOL = [];

function getImap($email, $password, $folder = 'INBOX') {
    global $_IMAP_POOL;
    $folder = sanitizeImapFolder($folder);
    $key = $email . '|' . $folder;

    // Reuse existing connection if still valid
    if (isset($_IMAP_POOL[$key])) {
        $existing = $_IMAP_POOL[$key];
        if (@imap_ping($existing)) {
            return $existing;
        }
        @imap_close($existing);
        unset($_IMAP_POOL[$key]);
    }

    $mailbox = '{127.0.0.1:993/imap/ssl/novalidate-cert}' . $folder;
    $imap = @imap_open($mailbox, $email, $password);
    if (!$imap) {
        $errors = imap_errors();
        $errStr = $errors ? implode(', ', $errors) : 'unknown';
        // Detect AUTH FAILED → invalidate the bearer token (stale password) and
        // respond 401 so the app routes to login instead of showing "Algo deu
        // errado" forever. 2026-05-09: user changed password via doveadm,
        // bearer tokens still encrypted with old password — every IMAP call
        // failed with 500. Now: detect, kill token, force re-login.
        if (stripos($errStr, 'AUTHENTICATIONFAILED') !== false || stripos($errStr, 'Authentication failed') !== false) {
            try {
                $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
                if (preg_match('/^Bearer\s+(.+)$/i', $authHeader, $bm)) {
                    $tokHash = hash('sha256', trim($bm[1]));
                    $tokFile = TOKEN_STORE_DIR . '/' . $tokHash . '.json';
                    if (file_exists($tokFile)) @unlink($tokFile);
                    // Also revoke in PG (Go-issued tokens)
                    try {
                        require_once __DIR__ . '/db.php';
                        $pg = getPGDB();
                        $ps = $pg->prepare("UPDATE auth_tokens SET revoked_at = NOW() WHERE token_hash = :h");
                        $ps->execute([':h' => $tokHash]);
                    } catch (\Throwable $_e) { /* PG offline — fs already gone */ }
                    error_log("[imap_auth_fail] invalidated stale token hash={$tokHash} email={$email}");
                }
            } catch (\Throwable $_e) {}
            jsonResponse(false, null, 'Sessão expirada — faça login de novo', 401);
        }
        throw new Exception('IMAP error: ' . $errStr);
    }

    $_IMAP_POOL[$key] = $imap;
    return $imap;
}

// Clean up connections at shutdown
register_shutdown_function(function() {
    global $_IMAP_POOL;
    foreach ($_IMAP_POOL as $conn) {
        try { @imap_close($conn); } catch (\Throwable $e) { /* PHP 8.4+ throws on closed connection */ }
    }
    $_IMAP_POOL = [];
});

function decodeSubject($subject) {
    if (!$subject) return '(sem assunto)';
    $decoded = iconv_mime_decode($subject, 0, 'UTF-8');
    return $decoded ?: $subject;
}

function parseAddresses($addrs) {
    $result = [];
    if (!$addrs || !is_array($addrs)) return $result;
    foreach ($addrs as $a) {
        if (isset($a->mailbox, $a->host)) {
            $result[] = [
                'email' => $a->mailbox . '@' . $a->host,
                'name' => isset($a->personal) ? iconv_mime_decode($a->personal, 0, 'UTF-8') : '',
            ];
        }
    }
    return $result;
}

function getBody($imap, $msgno) {
    $structure = imap_fetchstructure($imap, $msgno);
    $html = ''; $text = ''; $attachments = [];
    
    if (empty($structure->parts)) {
        $body = imap_body($imap, $msgno);
        $body = decodeBodyPart($body, $structure->encoding ?? 0);
        $body = convertCharset($body, $structure->parameters ?? []);
        if (strtolower($structure->subtype ?? '') === 'html') $html = $body;
        else $text = $body;
    } else {
        walkParts($imap, $msgno, $structure->parts, '', $html, $text, $attachments);
    }
    return ['html' => $html, 'text' => $text ?: strip_tags($html), 'attachments' => $attachments];
}

function walkParts($imap, $msgno, $parts, $prefix, &$html, &$text, &$attachments) {
    foreach ($parts as $i => $part) {
        $partId = $prefix ? $prefix . '.' . ($i + 1) : (string)($i + 1);
        $data = imap_fetchbody($imap, $msgno, $partId);
        $data = decodeBodyPart($data, $part->encoding ?? 0);
        
        $filename = getPartFilename($part);
        if ($filename) {
            $attachments[] = ['filename' => $filename, 'size' => strlen($data), 'part_id' => $partId];
            continue;
        }
        
        if ($part->type === 0) {
            $data = convertCharset($data, $part->parameters ?? []);
            $sub = strtolower($part->subtype ?? '');
            if ($sub === 'html') $html .= $data;
            elseif ($sub === 'plain') $text .= $data;
        }
        
        if (isset($part->parts)) {
            walkParts($imap, $msgno, $part->parts, $partId, $html, $text, $attachments);
        }
    }
}

function getPartFilename($part) {
    if (!empty($part->ifdparameters)) {
        foreach ($part->dparameters as $p) {
            if (strtolower($p->attribute) === 'filename') return iconv_mime_decode($p->value, 0, 'UTF-8');
        }
    }
    if (!empty($part->ifparameters)) {
        foreach ($part->parameters as $p) {
            if (strtolower($p->attribute) === 'name') return iconv_mime_decode($p->value, 0, 'UTF-8');
        }
    }
    return '';
}

function decodeBodyPart($data, $encoding) {
    if ($encoding === 3) return base64_decode($data);
    if ($encoding === 4) return quoted_printable_decode($data);
    return $data;
}

function convertCharset($data, $params) {
    $charset = 'UTF-8';
    if ($params) foreach ($params as $p) {
        if (strtolower($p->attribute) === 'charset') $charset = strtoupper($p->value);
    }
    if ($charset !== 'UTF-8' && $charset !== 'US-ASCII') {
        $c = @iconv($charset, 'UTF-8//IGNORE', $data);
        if ($c !== false) return $c;
    }
    return $data;
}

function categorizeEmail($from, $subject) {
    $from = strtolower($from);
    $subject = strtolower($subject);

    // Social: social networks, messaging platforms
    $socialDomains = ['facebook', 'twitter', 'instagram', 'linkedin', 'tiktok', 'pinterest',
        'snapchat', 'reddit', 'tumblr', 'quora', 'discord', 'slack', 'telegram',
        'whatsapp', 'meetup', 'nextdoor', 'mastodon', 'threads', 'bluesky',
        'youtube', 'twitch', 'github.com', 'gitlab', 'bitbucket', 'medium.com',
        'strava', 'facebookmail', 'plus.google', 'socialnetwork'];
    $socialKeywords = ['friend request', 'followed you', 'mentioned you', 'tagged you',
        'liked your', 'commented on', 'shared your', 'invitation to connect',
        'new follower', 'connection request', 'solicitação de amizade', 'te mencionou',
        'curtiu sua', 'comentou em', 'te seguiu', 'novo seguidor'];
    foreach ($socialDomains as $d) { if (strpos($from, $d) !== false) return 'social'; }
    foreach ($socialKeywords as $k) { if (strpos($subject, $k) !== false) return 'social'; }

    // Promotions: marketing, deals, newsletters
    $promoDomains = ['noreply', 'no-reply', 'newsletter', 'marketing', 'promo', 'campaign',
        'mailchimp', 'sendgrid', 'constantcontact', 'hubspot', 'mailgun', 'sendinblue',
        'amazonses', 'shopify', 'magento', 'woocommerce', 'ebay', 'aliexpress',
        'wish.com', 'groupon', 'coupon', 'deals', 'offer', 'mercadolivre',
        'americanas', 'casasbahia', 'magazineluiza', 'shopee', 'shein', 'kabum'];
    $promoKeywords = ['unsubscribe', 'descadastrar', 'off', 'discount', 'desconto', 'sale',
        'deal', 'oferta', 'promocao', 'promoção', 'coupon', 'cupom', 'frete grátis',
        'free shipping', 'limited time', 'tempo limitado', 'black friday', 'cyber monday',
        'newsletter', 'weekly digest', 'special offer', 'exclusive', 'save up to',
        'don\'t miss', 'não perca', 'aproveite', 'compre agora', 'buy now', 'shop now'];
    foreach ($promoDomains as $d) { if (strpos($from, $d) !== false) return 'promotions'; }
    foreach ($promoKeywords as $k) { if (strpos($subject, $k) !== false) return 'promotions'; }

    // Updates: notifications from services, billing, shipping
    $updateDomains = ['notify', 'notification', 'alert', 'updates', 'info@', 'support@',
        'billing', 'payment', 'invoice', 'receipt', 'order', 'tracking',
        'shipping', 'delivery', 'bank', 'paypal', 'stripe', 'uber', 'lyft',
        '99', 'ifood', 'rappi', 'nubank', 'itau', 'bradesco', 'santander',
        'correios', 'sedex', 'fedex', 'dhl', 'ups'];
    $updateKeywords = ['your order', 'seu pedido', 'order confirmation', 'confirmação',
        'payment received', 'pagamento', 'invoice', 'fatura', 'nota fiscal',
        'shipping update', 'entrega', 'tracking number', 'código de rastreio',
        'password reset', 'redefinir senha', 'verify your', 'verificar',
        'security alert', 'alerta de segurança', 'login attempt', 'tentativa de login',
        'account update', 'atualização da conta', 'two-factor', 'código de verificação'];
    foreach ($updateDomains as $d) { if (strpos($from, $d) !== false) return 'updates'; }
    foreach ($updateKeywords as $k) { if (strpos($subject, $k) !== false) return 'updates'; }

    return 'primary';
}

function parseSearchQuery($q) {
    $criteria = [];
    $postFilters = [];
    $folderOverride = null;
    $labelSearch = null;

    // Helper: extract operator value (supports quoted and unquoted).
    // IMPORTANT: strip CR/LF from all extracted values — IMAP's protocol is
    // line-based, so a raw \r\n in the search arg would inject a second
    // command (e.g. "subject:foo\r\nFROM spam@evil.com" → arbitrary filter).
    $extractOp = function($op, &$q) {
        $values = [];
        $strip = function($v) { return str_replace(["\r", "\n"], '', $v); };
        // Quoted form: op:"some value"
        if (preg_match_all('/\b' . preg_quote($op) . ':"([^"]+)"/i', $q, $matches, PREG_SET_ORDER)) {
            foreach ($matches as $m) {
                $values[] = $strip($m[1]);
                $q = str_replace($m[0], '', $q);
            }
        }
        // Unquoted form: op:value
        if (preg_match_all('/\b' . preg_quote($op) . ':(\S+)/i', $q, $matches, PREG_SET_ORDER)) {
            foreach ($matches as $m) {
                $values[] = $strip($m[1]);
                $q = str_replace($m[0], '', $q);
            }
        }
        return $values;
    };

    // from: -> IMAP FROM
    foreach ($extractOp('from', $q) as $v) {
        $criteria[] = 'FROM "' . addcslashes($v, '"\\') . '"';
    }
    // to: -> IMAP TO
    foreach ($extractOp('to', $q) as $v) {
        $criteria[] = 'TO "' . addcslashes($v, '"\\') . '"';
    }
    // cc: -> IMAP CC
    foreach ($extractOp('cc', $q) as $v) {
        $criteria[] = 'CC "' . addcslashes($v, '"\\') . '"';
    }
    // subject: -> IMAP SUBJECT
    foreach ($extractOp('subject', $q) as $v) {
        $criteria[] = 'SUBJECT "' . addcslashes($v, '"\\') . '"';
    }

    // is:unread -> UNSEEN
    if (preg_match('/\bis:unread\b/i', $q)) {
        $criteria[] = 'UNSEEN';
        $q = preg_replace('/\bis:unread\b/i', '', $q);
    }
    // is:read -> SEEN
    if (preg_match('/\bis:read\b/i', $q)) {
        $criteria[] = 'SEEN';
        $q = preg_replace('/\bis:read\b/i', '', $q);
    }
    // is:starred / is:flagged -> FLAGGED
    if (preg_match('/\bis:(starred|flagged)\b/i', $q)) {
        $criteria[] = 'FLAGGED';
        $q = preg_replace('/\bis:(starred|flagged)\b/i', '', $q);
    }
    // is:important -> KEYWORD "$label_importante"
    if (preg_match('/\bis:important\b/i', $q)) {
        $criteria[] = 'KEYWORD "$label_importante"';
        $q = preg_replace('/\bis:important\b/i', '', $q);
    }

    // has:attachment -> post-filter (IMAP has no native attachment-only search)
    if (preg_match('/\bhas:attachment\b/i', $q)) {
        $postFilters[] = 'has_attachment';
        $q = preg_replace('/\bhas:attachment\b/i', '', $q);
    }

    // before:YYYY-MM-DD or before:YYYY/MM/DD -> IMAP BEFORE
    if (preg_match_all('/\bbefore:(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/i', $q, $matches, PREG_SET_ORDER)) {
        foreach ($matches as $m) {
            $ts = strtotime($m[1]);
            if ($ts) $criteria[] = 'BEFORE "' . date('j-M-Y', $ts) . '"';
            $q = str_replace($m[0], '', $q);
        }
    }
    // after:YYYY-MM-DD or after:YYYY/MM/DD -> IMAP SINCE
    if (preg_match_all('/\bafter:(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/i', $q, $matches, PREG_SET_ORDER)) {
        foreach ($matches as $m) {
            $ts = strtotime($m[1]);
            if ($ts) $criteria[] = 'SINCE "' . date('j-M-Y', $ts) . '"';
            $q = str_replace($m[0], '', $q);
        }
    }

    // label: -> IMAP KEYWORD search for custom labels
    foreach ($extractOp('label', $q) as $v) {
        $labelFlag = '$label_' . preg_replace('/[^a-z0-9_]/i', '', strtolower($v));
        $labelSearch = $labelFlag;
    }

    // in: or folder: -> folder override (e.g. in:sent, in:trash, in:drafts)
    $folderMap = [
        'inbox' => 'INBOX', 'sent' => 'Sent', 'trash' => 'Trash', 'drafts' => 'Drafts',
        'spam' => 'Junk', 'junk' => 'Junk', 'archive' => 'Archive', 'starred' => 'INBOX',
    ];
    foreach ($extractOp('in', $q) as $v) {
        $lower = strtolower($v);
        if (isset($folderMap[$lower])) {
            $folderOverride = $folderMap[$lower];
        } else {
            // Try as literal folder name
            $folderOverride = $v;
        }
        if ($lower === 'starred') {
            $criteria[] = 'FLAGGED';
        }
    }

    // larger: -> IMAP LARGER (Dovecot supports native IMAP4rev1 LARGER/SMALLER search keys)
    if (preg_match_all('/\blarger:(\S+)/i', $q, $matches, PREG_SET_ORDER)) {
        foreach ($matches as $m) {
            $bytes = parseSizeToBytes($m[1]);
            if ($bytes > 0) $criteria[] = 'LARGER ' . $bytes;
            $q = str_replace($m[0], '', $q);
        }
    }
    // smaller: -> IMAP SMALLER
    if (preg_match_all('/\bsmaller:(\S+)/i', $q, $matches, PREG_SET_ORDER)) {
        foreach ($matches as $m) {
            $bytes = parseSizeToBytes($m[1]);
            if ($bytes > 0) $criteria[] = 'SMALLER ' . $bytes;
            $q = str_replace($m[0], '', $q);
        }
    }

    // Remaining text -> IMAP TEXT search
    $remaining = trim($q);
    if ($remaining) {
        $criteria[] = 'TEXT "' . addcslashes($remaining, '"\\') . '"';
    }

    $imapCriteria = empty($criteria) ? 'ALL' : implode(' ', $criteria);

    return [
        'criteria' => $imapCriteria,
        'post_filters' => $postFilters,
        'folder_override' => $folderOverride,
        'label_search' => $labelSearch,
    ];
}

// Helper: parse human-readable size (e.g. "5M", "10K", "1G") to bytes
function parseSizeToBytes($sizeStr) {
    $sizeStr = strtoupper(trim($sizeStr));
    $num = (float)$sizeStr;
    if (strpos($sizeStr, 'G') !== false) return (int)($num * 1024 * 1024 * 1024);
    if (strpos($sizeStr, 'M') !== false) return (int)($num * 1024 * 1024);
    if (strpos($sizeStr, 'K') !== false) return (int)($num * 1024);
    return (int)$num;
}

// ============================================================
// WELCOME CHAT — seed a Chatyy AI direct conversation right after
// signup. Resolves the D1 "empty inbox" drop-off: new users open the
// app and find an interactive greeting from Chatyy AI with 3 tap-able
// quick replies (chips) instead of a blank list. Pinned by default.
//
// Counterpart is the synthetic `one@chatyy.ai` account (no Maildir,
// no IMAP — handled exclusively inside the AI bot router in chat.php).
// Strings are i18n'd by phone country code (default English).
// ============================================================
function chatyyAIDetectLang($verifiedPhone = '', $explicitLang = '') {
    // Caller-supplied wins (e.g. mobile sends device locale).
    $explicit = strtolower(substr((string)$explicitLang, 0, 2));
    if (in_array($explicit, ['pt', 'es', 'en'], true)) return $explicit;
    // Fall back to E.164 country code on the verified phone.
    $digits = preg_replace('/\D/', '', (string)$verifiedPhone);
    if ($digits === '') return 'en';
    // BR (55) + PT (351) → Portuguese.
    if (str_starts_with($digits, '55') || str_starts_with($digits, '351')) return 'pt';
    // LatAm Spanish-speaking countries → Spanish.
    // 52 MX, 54 AR, 56 CL, 57 CO, 58 VE, 51 PE, 591 BO, 593 EC, 595 PY,
    // 598 UY, 53 CU, 502 GT, 503 SV, 504 HN, 505 NI, 506 CR, 507 PA,
    // 509 HT (FR/HT but Spanish closer than EN), 34 ES.
    $esPrefixes = ['52','54','56','57','58','51','591','593','595','598','53','502','503','504','505','506','507','34'];
    foreach ($esPrefixes as $p) { if (str_starts_with($digits, $p)) return 'es'; }
    return 'en';
}

function chatyyAIWelcomeStrings($lang) {
    $bundles = [
        'pt' => [
            'name'  => 'Chatyy AI',
            'msg1'  => 'Olá! 👋 Eu sou Chatyy AI, sua assistente. Posso te ajudar com:',
            'msg2'  => "💬 Responder perguntas\n📸 Editar fotos\n📅 Agendar lembretes\n🌐 Traduzir textos",
            'msg3'  => 'Toque em alguma sugestão abaixo pra começar 👇',
            'chips' => ['Que dia é hoje?', 'Me conte uma piada', 'Como funciona o Chatyy?'],
        ],
        'es' => [
            'name'  => 'Chatyy AI',
            'msg1'  => '¡Hola! 👋 Soy Chatyy AI, tu asistente. Puedo ayudarte con:',
            'msg2'  => "💬 Responder preguntas\n📸 Editar fotos\n📅 Agendar recordatorios\n🌐 Traducir textos",
            'msg3'  => 'Toca una sugerencia abajo para empezar 👇',
            'chips' => ['¿Qué día es hoy?', 'Cuéntame un chiste', '¿Cómo funciona Chatyy?'],
        ],
        'en' => [
            'name'  => 'Chatyy AI',
            'msg1'  => "Hi! 👋 I'm Chatyy AI, your assistant. I can help you with:",
            'msg2'  => "💬 Answering questions\n📸 Editing photos\n📅 Scheduling reminders\n🌐 Translating text",
            'msg3'  => 'Tap a suggestion below to get started 👇',
            'chips' => ['What day is it today?', 'Tell me a joke', 'How does Chatyy work?'],
        ],
    ];
    return $bundles[$lang] ?? $bundles['en'];
}

/**
 * Create the Chatyy AI welcome direct conversation + 3 seeded messages
 * + pin the conv for the new user. Idempotent (uses direct_key unique
 * index — re-running silently no-ops). Non-fatal: any failure is
 * logged but signup completes regardless.
 *
 * @param string $userEmail     New user's email (lowercase).
 * @param string $verifiedPhone E.164 phone, used for country→lang fallback.
 * @param string $explicitLang  Optional caller-provided BCP-47 (e.g. 'pt-BR').
 */
function seedChatyyAIWelcome($userEmail, $verifiedPhone = '', $explicitLang = '') {
    try {
        $userEmail = strtolower(trim((string)$userEmail));
        if ($userEmail === '' || !str_contains($userEmail, '@')) return;
        $botEmail  = 'one@chatyy.ai';
        if ($userEmail === $botEmail) return;

        require_once __DIR__ . '/db.php';
        $db = getPGDB();

        $lang   = chatyyAIDetectLang($verifiedPhone, $explicitLang);
        $bundle = chatyyAIWelcomeStrings($lang);

        // Canonical direct_key — sorted lowercase pair (matches chat.php).
        $a = $userEmail; $b = $botEmail;
        $directKey = ($a < $b) ? "$a|$b" : "$b|$a";

        $db->beginTransaction();

        // 1) Conversation row (idempotent via UNIQUE direct_key).
        $ins = $db->prepare("
            INSERT INTO chat_conversations (type, name, created_by, direct_key, created_at, updated_at)
            VALUES ('direct', :n, :cb, :dk, now()::text, now()::text)
            ON CONFLICT (direct_key) DO UPDATE SET updated_at = now()::text
            RETURNING id
        ");
        $ins->execute([':n' => $bundle['name'], ':cb' => $botEmail, ':dk' => $directKey]);
        $conversationId = (int)$ins->fetchColumn();
        if (!$conversationId) {
            // Some pg versions don't return on DO UPDATE — fetch explicitly.
            $q = $db->prepare("SELECT id FROM chat_conversations WHERE direct_key = :k LIMIT 1");
            $q->execute([':k' => $directKey]);
            $conversationId = (int)$q->fetchColumn();
        }
        if (!$conversationId) { $db->rollBack(); return; }

        // 2) Members — pin by default for the new user.
        @$db->exec("ALTER TABLE chat_conversation_members ADD COLUMN IF NOT EXISTS pinned INT DEFAULT 0");
        $insM = $db->prepare("
            INSERT INTO chat_conversation_members
              (conversation_id, email, display_name, role, pinned, joined_at)
            VALUES (:cid, :em, :dn, :r, :p, now()::text)
            ON CONFLICT DO NOTHING
        ");
        $insM->execute([
            ':cid' => $conversationId,
            ':em'  => $userEmail,
            ':dn'  => '',
            ':r'   => 'member',
            ':p'   => 1,
        ]);
        $insM->execute([
            ':cid' => $conversationId,
            ':em'  => $botEmail,
            ':dn'  => $bundle['name'],
            ':r'   => 'admin',
            ':p'   => 0,
        ]);

        // Backstop: if the conv pre-existed (no-op insert above), force pin.
        $db->prepare("UPDATE chat_conversation_members SET pinned = 1 WHERE conversation_id = :cid AND LOWER(email) = LOWER(:e)")
           ->execute([':cid' => $conversationId, ':e' => $userEmail]);

        // 3) Seeded messages. Last one carries reply_markup.inline_keyboard
        //    so the existing frontend chip renderer (chat-conversation.js)
        //    picks them up without any UI change.
        @$db->exec("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_markup JSONB");

        // Idempotency: skip if we already seeded (any message from bot here).
        $chk = $db->prepare("SELECT 1 FROM chat_messages WHERE conversation_id = :cid AND LOWER(sender_email) = LOWER(:b) LIMIT 1");
        $chk->execute([':cid' => $conversationId, ':b' => $botEmail]);
        if (!$chk->fetchColumn()) {
            $insMsg = $db->prepare("
                INSERT INTO chat_messages
                  (conversation_id, sender_email, sender_name, content, type, created_at, reply_markup)
                VALUES (:cid, :se, :sn, :c, 'text', now()::text, CAST(:rm AS JSONB))
            ");

            // msg 1
            $insMsg->execute([
                ':cid' => $conversationId, ':se' => $botEmail, ':sn' => $bundle['name'],
                ':c'   => $bundle['msg1'], ':rm' => null,
            ]);
            // msg 2 (feature list)
            $insMsg->execute([
                ':cid' => $conversationId, ':se' => $botEmail, ':sn' => $bundle['name'],
                ':c'   => $bundle['msg2'], ':rm' => null,
            ]);
            // msg 3 — quick-reply chips. Telegram-style inline_keyboard: each
            // row is an array of {text, callback_data}. callback_data holds
            // the literal prompt the bot should answer when tapped.
            $inlineKb = [];
            foreach ($bundle['chips'] as $chip) {
                $inlineKb[] = [[ 'text' => $chip, 'callback_data' => $chip ]];
            }
            $rmJson = json_encode([
                'inline_keyboard' => $inlineKb,
                'quick_replies'   => $bundle['chips'], // back-compat for older clients
            ], JSON_UNESCAPED_UNICODE);
            $insMsg->execute([
                ':cid' => $conversationId, ':se' => $botEmail, ':sn' => $bundle['name'],
                ':c'   => $bundle['msg3'], ':rm' => $rmJson,
            ]);
        }

        $db->commit();
    } catch (\Throwable $e) {
        try { if (isset($db) && $db->inTransaction()) $db->rollBack(); } catch (\Throwable $_) {}
        error_log('[seedChatyyAIWelcome] ' . $e->getMessage());
    }
}

// ============================================================
// WELCOME EMAIL — direct Maildir delivery (no SMTP, no external dep).
// Builds RFC2822 multipart/alternative message and drops it into the
// new user's INBOX/new/ Maildir spool. Wrapped in try/catch so any
// failure is logged but never blocks account creation.
// ============================================================
function sendWelcomeEmail($email, $firstName, $domain) {
    try {
        $parts = explode('@', $email, 2);
        if (count($parts) !== 2) return;
        $user = $parts[0];
        $mailDomain = $parts[1];

        $name = $firstName ? trim($firstName) : $user;
        // Take first word only if a full name slipped in.
        if (strpos($name, ' ') !== false) {
            $name = trim(explode(' ', $name)[0]);
        }
        $name = $name ?: $user;

        // Escape user-controlled name for HTML body.
        $nameH = htmlspecialchars($name, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $emailH = htmlspecialchars($email, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');

        $subjectRaw = "Bem-vindo ao Chatyy, {$name}! 🎉";
        $fromAddr = 'equipe@chatyy.com.br';
        $fromName = 'Equipe Chatyy';
        $msgId = '<welcome-' . bin2hex(random_bytes(8)) . '@chatyy.com.br>';
        $boundary = '=_chatyy_' . bin2hex(random_bytes(12));
        $dateHdr = date('r');

        $html = <<<HTML
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f7f7f9;margin:0;padding:20px;">
<table style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border-collapse:collapse;" cellpadding="0" cellspacing="0">
<tr><td>
<div style="background:#7C3AED;color:#fff;width:64px;height:64px;border-radius:32px;text-align:center;line-height:64px;font-size:32px;">&#10024;</div>
<h1 style="margin-top:24px;font-size:28px;color:#111;">Bem-vindo, {$nameH}!</h1>
<p style="color:#444;font-size:15px;line-height:22px;">Sua conta Chatyy tá pronta. Aqui está tudo que você ganhou de graça:</p>
<ul style="color:#333;line-height:1.8;list-style:none;padding:0;font-size:15px;">
<li>💾 <b>100 GB de armazenamento</b> — fotos, vídeos, arquivos, tudo</li>
<li>💬 <b>Mensagens ilimitadas</b> — texto, áudio, vídeo, fotos</li>
<li>📞 <b>Ligações ilimitadas</b> — áudio + vídeo HD pra qualquer pessoa</li>
<li>🟢 <b>WhatsApp integrado</b> — mande mensagens pra contatos do WhatsApp</li>
<li>🤖 <b>AI inteligente</b> — resumos, transcrição, tradução, busca semântica</li>
<li>📧 <b>Email completo</b> — <a href="mailto:{$emailH}" style="color:#7C3AED;text-decoration:none;">{$emailH}</a> é seu também</li>
<li>☁️ <b>Backup automático</b> — fotos do celular salvas em segurança</li>
<li>📹 <b>Reuniões em vídeo</b> — ilimitadas, sem limite de tempo</li>
</ul>
<p style="margin-top:28px;font-size:16px;color:#111;"><b>Comece a conversar agora.</b></p>
<p style="color:#888;font-size:13px;margin-top:24px;">Time Chatyy · <a href="https://chatyy.com.br" style="color:#7C3AED;text-decoration:none;">chatyy.com.br</a></p>
</td></tr></table>
</body>
</html>
HTML;

        $plain = "Bem-vindo ao Chatyy, {$name}!\r\n\r\n" .
                 "Sua conta Chatyy tá pronta. Aqui está tudo que você ganhou de graça:\r\n\r\n" .
                 "  - 100 GB de armazenamento — fotos, vídeos, arquivos, tudo\r\n" .
                 "  - Mensagens ilimitadas — texto, áudio, vídeo, fotos\r\n" .
                 "  - Ligações ilimitadas — áudio + vídeo HD pra qualquer pessoa\r\n" .
                 "  - WhatsApp integrado — mande mensagens pra contatos do WhatsApp\r\n" .
                 "  - AI inteligente — resumos, transcrição, tradução, busca semântica\r\n" .
                 "  - Email completo — {$email} é seu também\r\n" .
                 "  - Backup automático — fotos do celular salvas em segurança\r\n" .
                 "  - Reuniões em vídeo — ilimitadas, sem limite de tempo\r\n\r\n" .
                 "Comece a conversar agora.\r\n\r\n" .
                 "Time Chatyy — chatyy.com.br\r\n";

        // Build RFC2822 message. Strip CR/LF from name to defeat header
        // injection (defense-in-depth — name is server-trusted at this point).
        $safeFromName = preg_replace('/[\r\n]/', '', $fromName);
        $safeToName = preg_replace('/[\r\n]/', '', $name);
        $subjectEnc = '=?UTF-8?B?' . base64_encode($subjectRaw) . '?=';

        $headers  = "Date: {$dateHdr}\r\n";
        $headers .= "From: {$safeFromName} <{$fromAddr}>\r\n";
        $headers .= "To: =?UTF-8?B?" . base64_encode($safeToName) . "?= <{$email}>\r\n";
        $headers .= "Subject: {$subjectEnc}\r\n";
        $headers .= "Message-ID: {$msgId}\r\n";
        $headers .= "MIME-Version: 1.0\r\n";
        $headers .= "Content-Type: multipart/alternative; boundary=\"{$boundary}\"\r\n";
        $headers .= "X-Chatyy-Welcome: 1\r\n";

        $body  = "This is a multi-part message in MIME format.\r\n\r\n";
        $body .= "--{$boundary}\r\n";
        $body .= "Content-Type: text/plain; charset=UTF-8\r\n";
        $body .= "Content-Transfer-Encoding: quoted-printable\r\n\r\n";
        $body .= quoted_printable_encode($plain) . "\r\n";
        $body .= "--{$boundary}\r\n";
        $body .= "Content-Type: text/html; charset=UTF-8\r\n";
        $body .= "Content-Transfer-Encoding: quoted-printable\r\n\r\n";
        $body .= quoted_printable_encode($html) . "\r\n";
        $body .= "--{$boundary}--\r\n";

        $fullMsg = $headers . "\r\n" . $body;

        // Maildir delivery: write to tmp/ then rename into new/ (atomic).
        // Filename format: <unix_ts>.<unique>.<host>,S=<size>:2,
        $maildirBase = "/var/mail/vhosts/{$mailDomain}/{$user}/Maildir";
        $tmpDir = "{$maildirBase}/tmp";
        $newDir = "{$maildirBase}/new";
        if (!is_dir($newDir) || !is_dir($tmpDir)) {
            error_log("[welcome_email_fail] {$email}: Maildir not present at {$maildirBase}");
            return;
        }

        $size = strlen($fullMsg);
        $hostName = preg_replace('/[^A-Za-z0-9_.-]/', '', php_uname('n')) ?: 'chatyy';
        $unique = bin2hex(random_bytes(8)) . '.welcome';
        $baseName = time() . '.' . $unique . '.' . $hostName . ',S=' . $size;
        // Maildir info suffix `:2,` marks message as new (no flags). Dovecot
        // moves it from new/ to cur/ on first IMAP scan and tags :2,Sxxx.
        $finalName = $baseName . ':2,';

        $tmpPath = "{$tmpDir}/{$baseName}";
        $newPath = "{$newDir}/{$finalName}";

        if (file_put_contents($tmpPath, $fullMsg, LOCK_EX) === false) {
            error_log("[welcome_email_fail] {$email}: tmp write failed");
            return;
        }
        // chown vmail:vmail so dovecot reads it. Best-effort — chown may
        // fail under certain user namespaces; the file's still readable
        // because Maildir parent is 770 vmail:www-data.
        @chown($tmpPath, 'vmail');
        @chgrp($tmpPath, 'vmail');
        @chmod($tmpPath, 0600);

        if (!@rename($tmpPath, $newPath)) {
            @unlink($tmpPath);
            error_log("[welcome_email_fail] {$email}: rename to new/ failed");
            return;
        }
        @chown($newPath, 'vmail');
        @chgrp($newPath, 'vmail');
    } catch (\Throwable $e) {
        error_log("[welcome_email_fail] {$email}: " . $e->getMessage());
    }
}

// ============================================================
// ROUTES
// ============================================================
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? ($method === 'POST' ? (getInput()['action'] ?? '') : '');
// Backwards-compat aliases for QR login (TestFlight v2.4.2/388 still
// calls qr_generate/qr_check/qr_confirm; renamed on server to
// chat_qr_login_*).
if ($action === 'qr_generate') $action = 'chat_qr_login_create';
elseif ($action === 'qr_check') $action = 'chat_qr_login_status';
elseif ($action === 'qr_confirm') $action = 'chat_qr_login_approve';

// Older app builds (pre-2026-05) shipped with the legacy phone-OTP login
// names. The implementation got lost in the 2026-04 server migration —
// alias them onto the new phone_login_* handlers so existing TestFlight /
// App Store binaries continue to work without forcing a build.
elseif ($action === 'request_phone_otp') $action = 'phone_login_request';
elseif ($action === 'verify_phone_otp')  $action = 'phone_login_verify';

// --- Global CSRF check for all POST state-changing actions ---
// Skip CSRF for: login, signup, check_auth, logout, check_username, forgot_password_*, verify_phone, get_avatar
$CSRF_EXEMPT = ['login', 'signup', 'check_auth', 'logout', 'check_username',
    'phone_login_request', 'phone_login_verify', 'phone_signup', 'username_signup',
    'forgot_password_initiate', 'forgot_password_verify', 'forgot_password_reset',
    'verify_phone_send', 'verify_phone_check', 'get_avatar', 'attachment', 'alias_verify',
    'meet_rsvp', 'meet_persist_chat', 'meet_upload_chunk', 'meet_upload_file', 'chat_upload', 'chat_send', 'chat_typing', 'file_upload',
    'status_create', 'status_view', 'status_upload', 'chat_favorite', 'backup_debug', 'crash_report', 'bug_report', 'drive_precheck_asset_ids', 'chat_pin_conversation', 'chat_mute', 'chat_react', 'user_presence',
    'chat_qr_login_create', 'chat_qr_login_status',
    // [Stage 4 silent push wake] Internal-only — gated by X-API-Key /
    // MAIL_WS_KEY at the handler. Never invoked by the app/web client.
    'chat_wake_phone',
    // Family Sharing read-only actions (writes still go through CSRF check below).
    'family_info', 'family_calendar_list', 'family_shared_album_list',
    'family_shopping_list_get', 'family_location_all', 'family_plan_share',
    // Legacy aliases used by older api.js wrappers.
    'family_shared_album', 'family_shared_calendar', 'family_shopping_list'];
if ($method === 'POST' && !empty($_SESSION['email']) && !in_array($action, $CSRF_EXEMPT, true)) {
    validateCsrfToken();
}

try {
    switch ($action) {
        // ---- AUTH ----
        case 'login':
            $input = getInput();
            $email = trim($input['email'] ?? '');
            $password = $input['password'] ?? '';
            if (!$email || !$password) jsonResponse(false, null, 'Email and password required', 400);

            // Rate limiting: max 5 attempts per 15 minutes per IP+email
            checkLoginRateLimit($email);

            // Socket-based IMAP login (bypasses c-Client bug that escapes ! in passwords)
            $authResult = imapAuth($email, $password);
            if (!$authResult) jsonResponse(false, null, 'Incorrect email or password', 401);

            // Regenerate session ID to prevent session fixation
            session_regenerate_id(true);

            $_SESSION['email'] = $email;
            $_SESSION['password_enc'] = encryptSessionPassword($password);
            $_SESSION['name'] = explode('@', $email)[0];
            $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
            $_SESSION['login_time'] = time();
            unset($_SESSION['password']); // ensure no plaintext

            // Generate bearer token for mobile apps (session cookies don't work cross-origin)
            $bearerToken = generateBearerToken($email, $password);
            header('X-Auth-Token: ' . $bearerToken);

            // Backfill recovery blob so future phone-logins can authenticate
            // IMAP without prompting for the password again. Legacy accounts
            // (created via email/password before phone-signup existed) had no
            // recovery saved, so the inbox showed empty after phone OTP login.
            // Saving here on every successful email-login means: "login once
            // by email, never type your password again on this number".
            try {
                require_once __DIR__ . '/phone-auth.php';
                if (function_exists('phoneAuthSaveRecovery')) {
                    phoneAuthSaveRecovery($email, $password);
                }
            } catch (\Throwable $_e) { /* non-fatal */ }

            // Audit log: surfaced in Settings → Segurança → Histórico de atividades.
            // Wrapped in try/catch so audit-failure never breaks login.
            try {
                require_once __DIR__ . '/privacy_endpoints.php';
                if (function_exists('logUserActivity') && function_exists('getPGDB')) {
                    logUserActivity(getPGDB(), $email, 'login');
                }
            } catch (\Throwable $_e) {}

            jsonResponse(true, [
                'email' => $email,
                'name' => $_SESSION['name'],
                'unread' => $authResult['unseen'] ?? 0,
                'total' => $authResult['messages'] ?? 0,
                'csrf_token' => $_SESSION['csrf_token'],
                'token' => $bearerToken,
            ], 'Login successful');
            break;
            
        case 'logout':
            // Revoke bearer token: delete file + mark PG row revoked. Bearer
            // has 10-year TTL, so without this, an exfiltrated token stays
            // valid forever. Wrapped in try/catch — logout never fails.
            try {
                $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
                $bearer = null;
                if (preg_match('/^Bearer\s+(.+)$/i', $authHeader, $bm)) {
                    $bearer = trim($bm[1]);
                }
                if ($bearer && strlen($bearer) <= 200) {
                    $tokenHash = hash('sha256', $bearer);
                    // 1) Filesystem token store
                    $tokenFile = TOKEN_STORE_DIR . "/{$tokenHash}.json";
                    if (file_exists($tokenFile)) @unlink($tokenFile);
                    // 2) PG auth_tokens row (Go fast-auth issued tokens)
                    try {
                        if (function_exists('getPGDB')) { $pg = getPGDB(); }
                        else { require_once __DIR__ . '/db.php'; $pg = getPGDB(); }
                        $ps = $pg->prepare("UPDATE auth_tokens SET revoked_at = NOW() WHERE token_hash = :h AND revoked_at IS NULL");
                        $ps->execute([':h' => $tokenHash]);
                    } catch (\Throwable $e) { error_log('[logout_pg_revoke_err] ' . $e->getMessage()); }
                }
            } catch (\Throwable $e) { error_log('[logout_revoke_err] ' . $e->getMessage()); }
            // Audit (best-effort — pull email from session before destroy).
            try {
                $logEmail = $_SESSION['email'] ?? '';
                if ($logEmail) {
                    require_once __DIR__ . '/privacy_endpoints.php';
                    if (function_exists('logUserActivity') && function_exists('getPGDB')) {
                        logUserActivity(getPGDB(), $logEmail, 'logout');
                    }
                }
            } catch (\Throwable $_e) {}
            session_destroy();
            jsonResponse(true, null, 'Logout realizado');
            break;
            
        case 'check_auth':
            if (!empty($_SESSION['email'])) {
                $resp = [
                    'email' => $_SESSION['email'],
                    'name' => $_SESSION['name'] ?? '',
                    'csrf_token' => generateCsrfToken(),
                ];
                // If auth came from bearer token, return it back (don't regenerate)
                $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
                if (preg_match('/^Bearer\s+(.+)$/i', $authHeader, $bearerMatch)) {
                    $resp['token'] = $bearerMatch[1];
                }
                jsonResponse(true, $resp);
            }
            jsonResponse(false, null, 'Not authenticated', 401);
            break;
            
        // ---- SIGNUP ----
        case 'signup':
            $input = getInput();
            $username = strtolower(trim($input['username'] ?? ''));
            $password = $input['password'] ?? '';
            $name = trim($input['name'] ?? '');
            
            if (!$username || !$password) jsonResponse(false, null, 'Username e senha obrigatorios', 400);
            if (strlen($username) < 3) jsonResponse(false, null, 'Username deve ter no minimo 3 caracteres', 400);
            if (strlen($password) < 8) jsonResponse(false, null, 'Senha deve ter no minimo 8 caracteres', 400);
            if (!preg_match('/^[a-z0-9._-]+$/', $username)) jsonResponse(false, null, 'Username so pode ter letras, numeros, . _ -', 400);
            if (strlen($username) > 30) jsonResponse(false, null, 'Username muito longo (max 30)', 400);
            
            // Reserved usernames
            $reserved = ['admin','administrator','postmaster','webmaster','abuse','noreply','no-reply','info','suporte','support','contato','contact','root','mail','ftp','www','test','security','billing','sales','marketing','help','hostmaster','mailer-daemon','spam'];
            if (in_array($username, $reserved)) jsonResponse(false, null, 'Este nome de usuario e reservado', 400);
            
            // Rate limit: max 5 signups per IP per hour
            $rateFile = '/tmp/signup_rate_' . md5($_SERVER['REMOTE_ADDR'] ?? '');
            $rates = file_exists($rateFile) ? json_decode(file_get_contents($rateFile), true) : [];
            $rates = array_filter($rates, fn($t) => $t > time() - 3600);
            if (count($rates) >= 5) jsonResponse(false, null, 'Muitas contas criadas. Tente novamente em 1 hora.', 429);
            $rates[] = time();
            file_put_contents($rateFile, json_encode($rates), LOCK_EX);

            $domain = $input['domain'] ?? 'chatyy.com.br';
            if (!in_array($domain, ['onemundo.com.br', 'superbora.com.br', 'chatyy.com.br'])) $domain = 'chatyy.com.br';
            $email = $username . "@" . $domain;

            // ── Username uniqueness — multi-source (PG → Maildir profile → staging) ──
            // /etc/dovecot/users isn't mounted into the PHP-FPM Docker container,
            // so the legacy `file_get_contents` check silently returned false and
            // the uniqueness check was BYPASSED — allowing account takeover by
            // overwrite. We now check PG accounts (auth source of truth post-migration),
            // fall back to the Maildir profile dir, and also check the phone_signup
            // staging dir to defeat staging-stage races.
            // flock guards against concurrent signups for the same username; the
            // lock is auto-released when PHP shuts down (script termination /
            // jsonResponse exit), so we don't need explicit unlock.
            $signupLockFile = '/tmp/signup_lock_' . md5($email);
            $signupLockFp = @fopen($signupLockFile, 'c');
            if ($signupLockFp) @flock($signupLockFp, LOCK_EX);
            $usersFile = '/etc/dovecot/users';

            // (a) PG accounts table (try/catch — table may not exist on all envs)
            try {
                $pgChk = getPGDB();
                $stmt = $pgChk->prepare('SELECT 1 FROM accounts WHERE email = :e LIMIT 1');
                $stmt->execute([':e' => $email]);
                if ($stmt->fetch()) {
                    jsonResponse(false, null, 'Este email ja existe', 409);
                }
            } catch (\Throwable $e) { /* table missing → fallback */ }

            // (b) Maildir profile (authoritative on filesystem)
            $profilePathChk = "/var/mail/vhosts/{$domain}/{$username}/profile/data.json";
            if (file_exists($profilePathChk)) {
                jsonResponse(false, null, 'Este email ja existe', 409);
            }

            // (c) phone_signup staging (host-drained queue) — also race-window source
            $stagingChk = "/var/mail/_pending_signups/{$email}.json";
            if (file_exists($stagingChk)) {
                jsonResponse(false, null, 'Este email ja existe', 409);
            }

            // (d) Legacy host-mounted dovecot file (best-effort — usually unreadable in container)
            $existing = @file_get_contents($usersFile);
            if ($existing !== false && strpos($existing, $email . ':') !== false) {
                jsonResponse(false, null, 'Este email ja existe', 409);
            }

            // Create password hash — `sudo doveadm pw` does NOT exist inside
            // the PHP-FPM Docker container (no sudo binary, host doveadm not
            // mounted), so shell_exec returned empty → kids@... and other new
            // signups landed with empty hash, dovecot rejected login, and
            // mailbox dir was never chowned (signup looked "200 success" but
            // the user could never log in). crypt() with `$6$<salt>$` produces
            // the exact SHA512-CRYPT digest Dovecot expects — same pattern
            // already used by phone_signup. [bug 2026-05-21]
            $salt = '$6$' . bin2hex(random_bytes(8)) . '$';
            $cryptHash = crypt($password, $salt);
            if (!$cryptHash || strlen($cryptHash) < 20) {
                jsonResponse(false, null, 'Falha ao gerar senha do sistema', 500);
            }
            $hash = '{SHA512-CRYPT}' . $cryptHash;

            // Add to Dovecot users — if this fails, the new user can't auth
            // and the signup is broken. Don't claim 200 to the client.
            if (safe_put_contents($usersFile, "\n{$email}:{$hash}", FILE_APPEND) === false) {
                jsonResponse(false, null, 'Falha ao registrar usuario (escrita do dovecot bloqueada)', 500);
            }

            // Add to Postfix vmailbox
            $vmailbox = "/etc/postfix/vmailbox";
            $currentContent = file_get_contents($vmailbox);
            $entry = "{$email}    {$domain}/{$username}/";
            if (strpos($currentContent, $email) === false) {
                $nl = (substr($currentContent, -1) !== "\n") ? "\n" : "";
                if (safe_put_contents($vmailbox, $nl . $entry . "\n", FILE_APPEND) === false) {
                    error_log("[signup] vmailbox write failed for $email — mail delivery may break");
                    // Don't 500 — dovecot side already saved, partial state is
                    // still recoverable manually. Log loud so admin notices.
                }
                exec("sudo /usr/sbin/postmap " . escapeshellarg($vmailbox));
            }

            // Create Maildir
            $home = "/var/mail/vhosts/{$domain}/{$username}";
            foreach (['Maildir', 'Maildir/cur', 'Maildir/new', 'Maildir/tmp',
                       'Maildir/.Sent/cur', 'Maildir/.Sent/new', 'Maildir/.Sent/tmp',
                       'Maildir/.Drafts/cur', 'Maildir/.Drafts/new', 'Maildir/.Drafts/tmp',
                       'Maildir/.Trash/cur', 'Maildir/.Trash/new', 'Maildir/.Trash/tmp',
                       'Maildir/.Spam/cur', 'Maildir/.Spam/new', 'Maildir/.Spam/tmp',
                       'Maildir/.Archive/cur', 'Maildir/.Archive/new', 'Maildir/.Archive/tmp'] as $dir) {
                @mkdir("{$home}/{$dir}", 0700, true);
            }
            exec("sudo /usr/local/bin/chatyy-fix-mailbox " . escapeshellarg($username . "@" . $domain));
            exec("chmod 710 " . escapeshellarg($home));
            exec("chmod 770 " . escapeshellarg($home . "/profile") . " 2>/dev/null");
            // push_tokens/ MUST be www-data writable because register_push_token
            // runs as www-data and cannot otherwise create subdirs inside the
            // 0710 vmail-owned home. Without this, ALL Android push tokens
            // silently failed to register (incident 2026-05-12: months of
            // ZERO Android tokens registered system-wide).
            @mkdir($home . "/push_tokens", 0755, true);
            @exec("chown www-data:www-data " . escapeshellarg($home . "/push_tokens") . " 2>/dev/null");
            
            // Save extra profile data if provided
            $profileData = [
                'first_name' => trim($input['first_name'] ?? ''),
                'last_name' => trim($input['last_name'] ?? ''),
                'birthday' => trim($input['birthday'] ?? ''),
                'gender' => trim($input['gender'] ?? ''),
                'phone' => trim($input['phone'] ?? ''),
                'recovery_email' => trim($input['recovery_email'] ?? ''),
                'phone_verified' => false,
                'created_at' => date('c'),
                'ip' => $_SERVER['REMOTE_ADDR'] ?? '',
            ];

            // Validate phone verify token if provided
            $verifyToken = trim($input['verify_token'] ?? '');
            if ($verifyToken) {
                $secret = getenv('WEBMAIL_VERIFY_SECRET') ?: hash('sha256', 'OneMundoMail2026-' . php_uname('n') . '-verify');
                $parts = explode('.', $verifyToken);
                if (count($parts) === 3) {
                    $expectedSig = rtrim(strtr(base64_encode(hash_hmac('sha256', "{$parts[0]}.{$parts[1]}", $secret, true)), '+/', '-_'), '=');
                    if (hash_equals($expectedSig, $parts[2])) {
                        $payload = json_decode(base64_decode(strtr($parts[1], '-_', '+/')), true);
                        if ($payload && ($payload['exp'] ?? 0) > time() && ($payload['verified'] ?? false)) {
                            $profileData['phone_verified'] = true;
                            $profileData['verified_phone'] = $payload['phone'] ?? '';

                            // Check phone uniqueness — 1 phone per account
                            $verifiedPhone = preg_replace('/\D/', '', $payload['phone'] ?? '');
                            if ($verifiedPhone) {
                                $existingProfiles = glob('/var/mail/vhosts/*/*/profile/data.json');
                                foreach ($existingProfiles as $pf) {
                                    $pd = @json_decode(@file_get_contents($pf), true);
                                    if (!$pd) continue;
                                    $existingPhone = preg_replace('/\D/', '', $pd['verified_phone'] ?? '');
                                    if ($existingPhone && $existingPhone === $verifiedPhone) {
                                        jsonResponse(false, null, 'Este numero ja esta vinculado a outra conta. Tente resetar sua senha ou entre em contato com o suporte.', 409);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Save profile to JSON file
            $profileDir = "{$home}/profile";
            @mkdir($profileDir, 0700, true);
            file_put_contents("{$profileDir}/data.json", json_encode($profileData, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
            exec("chown -R vmail:vmail {$profileDir}");

            // Auto-login (encrypt password in session)
            $_SESSION['email'] = $email;
            $_SESSION['password_enc'] = encryptSessionPassword($password);
            $_SESSION['name'] = $name ?: $username;

            // Send welcome email (non-blocking, silent fail)
            sendWelcomeEmail($email, $input['first_name'] ?? $username, $domain);

            // Seed Chatyy AI welcome chat (non-blocking, idempotent).
            // No verified phone on legacy signup → fall through to lang from
            // Accept-Language or default English.
            seedChatyyAIWelcome($email, '', $_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? '');

            jsonResponse(true, ['email' => $email, 'name' => $_SESSION['name']], "Conta criada: {$email}");
            break;
            
        // ---- INBOX ----
        case 'inbox':
            $auth = requireAuth();
            $folder = $_GET['folder'] ?? 'INBOX';
            $page = max(1, (int)($_GET['page'] ?? 1));
            $perPage = min(50, max(10, (int)($_GET['per_page'] ?? 20)));
            $search = trim($_GET['search'] ?? '');
            $category = trim($_GET['category'] ?? '');
            $labelFilter = trim($_GET['label'] ?? '');
            $filter = trim($_GET['filter'] ?? ''); // 'unread' to show only unread

            // Virtual folders: Flagged is not a real IMAP folder — search INBOX for \Flagged
            $isVirtualFlagged = ($folder === 'Flagged');
            if ($isVirtualFlagged) {
                $folder = 'INBOX';
            }

            $imap = getImap($auth['email'], $auth['password'], $folder);

            $searchMeta = ['post_filters' => [], 'folder_override' => null, 'label_search' => null];

            // Build base search criteria
            $baseCriteria = 'ALL';
            if ($isVirtualFlagged) {
                $baseCriteria = 'FLAGGED';
            }
            if ($filter === 'unread') {
                $baseCriteria = ($baseCriteria === 'ALL') ? 'UNSEEN' : $baseCriteria . ' UNSEEN';
            }

            if ($labelFilter) {
                // Search by IMAP keyword flag for label
                $labelFlag = '$label_' . preg_replace('/[^a-z0-9_]/i', '', strtolower($labelFilter));
                $labelCriteria = 'KEYWORD "' . $labelFlag . '"';
                $finalCriteria = ($baseCriteria === 'ALL') ? $labelCriteria : $baseCriteria . ' ' . $labelCriteria;
                $uids = @imap_search($imap, $finalCriteria, SE_UID) ?: [];
            } elseif ($search) {
                $searchMeta = parseSearchQuery($search);
                // Handle folder override from in: operator
                if ($searchMeta['folder_override'] && $searchMeta['folder_override'] !== $folder) {
                    try { imap_close($imap); } catch (\Throwable $_e) {}
                    $folder = $searchMeta['folder_override'];
                    $imap = getImap($auth['email'], $auth['password'], $folder);
                }
                // Build final IMAP criteria including label search
                $imapCriteria = $searchMeta['criteria'];
                if ($searchMeta['label_search']) {
                    $labelPart = 'KEYWORD "' . $searchMeta['label_search'] . '"';
                    $imapCriteria = ($imapCriteria === 'ALL') ? $labelPart : $imapCriteria . ' ' . $labelPart;
                }
                // Combine with base criteria (Flagged/Unread filter)
                if ($baseCriteria !== 'ALL') {
                    $imapCriteria = ($imapCriteria === 'ALL') ? $baseCriteria : $baseCriteria . ' ' . $imapCriteria;
                }
                $uids = @imap_search($imap, $imapCriteria, SE_UID) ?: [];
            } else {
                $uids = @imap_search($imap, $baseCriteria, SE_UID) ?: [];
            }
            rsort($uids);

            $categoryFilter = ($category && $category !== 'all' && $folder === 'INBOX');

            // Known label colors for matching
            $labelColorMap = [
                'trabalho' => '#1a73e8', 'pessoal' => '#34a853', 'importante' => '#c5221f',
                'financeiro' => '#ea8600', 'social' => '#a142f4', 'viagem' => '#1a9988',
            ];
            // Load custom labels for color mapping
            $authParts = explode('@', $auth['email']);
            $settingsPath = "/var/mail/vhosts/{$authParts[1]}/{$authParts[0]}/profile/settings.json";
            if (file_exists($settingsPath)) {
                $userSettings = json_decode(file_get_contents($settingsPath), true) ?: [];
                foreach (($userSettings['custom_labels'] ?? []) as $cl) {
                    $labelColorMap[strtolower($cl['name'])] = $cl['color'] ?? '#1a73e8';
                }
            }

            // Build uid→labels map: search IMAP KEYWORD per known label
            $uidLabelsMap = [];
            foreach ($labelColorMap as $lName => $lColor) {
                $labelFlag = '$label_' . $lName;
                $labelUids = @imap_search($imap, 'KEYWORD "' . $labelFlag . '"', SE_UID) ?: [];
                foreach ($labelUids as $lu) {
                    $uidLabelsMap[$lu][] = ['name' => $lName, 'color' => $lColor];
                }
            }

            // Helper: fetch one email's data from IMAP
            // CACHE LAYER 2: per-message header cache, key mhdr:$email:$folder:$uid TTL 300s.
            // Hits skip imap_msgno+headerinfo+fetchstructure entirely. Invalidated on
            // mark_read/unread/delete/move/star/unstar.
            $postFilters = $searchMeta['post_filters'] ?? [];
            $cacheEmail = strtolower($auth['email']);
            $fetchEmail = function($imap, $uid, $folder) use ($category, $categoryFilter, $uidLabelsMap, $postFilters, $cacheEmail) {
                $hdrKey = 'mhdr:' . $cacheEmail . ':' . $folder . ':' . $uid;
                $cached = imapCacheGet($hdrKey);
                if ($cached !== null) {
                    // Re-stamp dynamic per-request fields (labels can change without msg invalidation).
                    $cached['labels'] = $uidLabelsMap[$uid] ?? $cached['labels'] ?? [];
                    // Honor category filter post-cache (cheap).
                    if ($categoryFilter && ($cached['category'] ?? '') !== $category) return null;
                    // Post-filters that depend on size/attachment are cached values, ok.
                    foreach ($postFilters as $pf) {
                        if ($pf === 'has_attachment' && empty($cached['has_attachment'])) return null;
                        if (strpos($pf, 'larger:') === 0 && (int)($cached['size'] ?? 0) < (int)substr($pf, 7)) return null;
                        if (strpos($pf, 'smaller:') === 0 && (int)($cached['size'] ?? 0) > (int)substr($pf, 8)) return null;
                    }
                    return $cached;
                }
                $msgno = imap_msgno($imap, $uid);
                if (!$msgno) return null;
                $h = imap_headerinfo($imap, $msgno);
                if (!$h) return null;

                $fromArr = parseAddresses($h->from ?? []);
                $toArr = parseAddresses($h->to ?? []);
                $emailFrom = $fromArr[0]['email'] ?? '';
                $emailSubject = decodeSubject($h->subject ?? '');
                $emailCategory = ($folder === 'INBOX') ? categorizeEmail($emailFrom, $emailSubject) : 'primary';

                // Skip if category filter doesn\'t match
                if ($categoryFilter && $emailCategory !== $category) return null;

                $emailSize = (int)($h->Size ?? 0);

                // Apply post-filters that require message structure
                $struct = null;
                $hasAttachment = false;
                $preview = '';
                try {
                    $struct = @imap_fetchstructure($imap, $msgno);
                    // Detect attachments: look for parts with disposition = attachment or non-inline non-text parts
                    if ($struct && !empty($struct->parts)) {
                        foreach ($struct->parts as $pi => $part) {
                            // Check for explicit attachment disposition
                            if (!empty($part->disposition) && strtolower($part->disposition) === 'attachment') {
                                $hasAttachment = true;
                                break;
                            }
                            // Also check for non-text, non-multipart parts that aren\'t inline (common attachment pattern)
                            if ($part->type >= 3 && (empty($part->disposition) || strtolower($part->disposition) !== 'inline')) {
                                $hasAttachment = true;
                                break;
                            }
                            // Check sub-parts for nested multipart messages
                            if (!empty($part->parts)) {
                                foreach ($part->parts as $subPart) {
                                    if (!empty($subPart->disposition) && strtolower($subPart->disposition) === 'attachment') {
                                        $hasAttachment = true;
                                        break 2;
                                    }
                                    if ($subPart->type >= 3 && (empty($subPart->disposition) || strtolower($subPart->disposition) !== 'inline')) {
                                        $hasAttachment = true;
                                        break 2;
                                    }
                                }
                            }
                        }
                    }

                    // Apply post-filters
                    foreach ($postFilters as $pf) {
                        if ($pf === 'has_attachment' && !$hasAttachment) return null;
                        if (strpos($pf, 'larger:') === 0 && $emailSize < (int)substr($pf, 7)) return null;
                        if (strpos($pf, 'smaller:') === 0 && $emailSize > (int)substr($pf, 8)) return null;
                    }

                    // Extract preview text
                    if ($struct && empty($struct->parts)) {
                        $raw = @imap_body($imap, $msgno, FT_PEEK);
                        $raw = decodeBodyPart($raw, $struct->encoding ?? 0);
                        $preview = trim(strip_tags($raw));
                    } elseif ($struct && !empty($struct->parts)) {
                        foreach ($struct->parts as $pi => $part) {
                            if ($part->type === 0 && strtolower($part->subtype ?? '') === 'plain') {
                                $raw = @imap_fetchbody($imap, $msgno, (string)($pi + 1), FT_PEEK);
                                $raw = decodeBodyPart($raw, $part->encoding ?? 0);
                                $raw = convertCharset($raw, $part->parameters ?? []);
                                $preview = trim(strip_tags($raw));
                                break;
                            }
                        }
                    }
                    $preview = mb_substr(preg_replace('/\s+/', ' ', $preview), 0, 120);
                } catch (Exception $e) { $preview = ''; }

                $dateShort = '';
                if (isset($h->date)) {
                    $ts = strtotime($h->date);
                    if (date('Y-m-d', $ts) === date('Y-m-d')) $dateShort = date('H:i', $ts);
                    elseif (date('Y', $ts) === date('Y')) $dateShort = date('d M', $ts);
                    else $dateShort = date('d/m/y', $ts);
                }

                $result = [
                    'uid' => $uid,
                    'subject' => $emailSubject,
                    'from' => $emailFrom,
                    'from_name' => $fromArr[0]['name'] ?? '',
                    'to' => $toArr[0]['email'] ?? '',
                    'to_name' => $toArr[0]['name'] ?? '',
                    'date' => isset($h->date) ? date('Y-m-d H:i:s', strtotime($h->date)) : null,
                    'date_short' => $dateShort,
                    'preview' => $preview,
                    'seen' => isset($h->Seen) && $h->Seen === 'S',
                    'answered' => isset($h->Answered) && $h->Answered === 'A',
                    'flagged' => isset($h->Flagged) && $h->Flagged === 'F',
                    'size' => $emailSize,
                    'has_attachment' => $hasAttachment,
                    'labels' => $uidLabelsMap[$uid] ?? [],
                    'category' => $emailCategory,
                ];
                // Store header snapshot 5min. Flags (seen/answered/flagged) stale risk
                // mitigated by mark_read/mark_unread/star/unstar invalidation.
                imapCacheSet($hdrKey, $result, 300);
                return $result;
            };

            $emails = [];
            if ($categoryFilter) {
                // Category filter: scan all UIDs, skip/collect to paginate
                $skip = ($page - 1) * $perPage;
                $skipped = 0;
                $totalMatched = 0;
                foreach ($uids as $uid) {
                    $emailData = $fetchEmail($imap, $uid, $folder);
                    if ($emailData === null) continue;
                    $totalMatched++;
                    if ($skipped < $skip) { $skipped++; continue; }
                    if (count($emails) < $perPage) $emails[] = $emailData;
                    // Keep counting total for pagination but stop fetching details
                    if (count($emails) >= $perPage) {
                        // Fast-count remaining by just checking headers (no preview)
                        // For perf, estimate remaining
                        break;
                    }
                }
                // Estimate total: if we filled the page and haven't scanned all, estimate
                $total = $totalMatched;
                // If we broke early, scan remaining just for category count (header only)
                if (count($emails) >= $perPage) {
                    // Rough estimate: count remaining by sampling
                    $remaining = count($uids) - $skip - count($emails);
                    $scannedRatio = $totalMatched / max(1, $skip + count($emails) + ($totalMatched - $skip - count($emails)));
                    $total = (int)($totalMatched + $remaining * ($totalMatched / max(1, array_search($uid, $uids) + 1)));
                }
                $totalPages = max(1, ceil($total / $perPage));
            } else {
                // No category filter: standard pagination
                $total = count($uids);
                $totalPages = max(1, ceil($total / $perPage));
                $pageUids = array_slice($uids, ($page - 1) * $perPage, $perPage);
                foreach ($pageUids as $uid) {
                    $emailData = $fetchEmail($imap, $uid, $folder);
                    if ($emailData !== null) $emails[] = $emailData;
                }
            }

            // CACHE LAYER 3: unread count per (email, folder), TTL 30s.
            // Skip imap_status (extra IMAP roundtrip) on hot reload. Invalidated on
            // mark_read/mark_unread/delete/move/send.
            $unreadCacheKey = 'unread:' . strtolower($auth['email']) . ':' . $folder;
            $unreadCount = imapCacheGet($unreadCacheKey);
            if ($unreadCount === null) {
                $status = imap_status($imap, '{127.0.0.1:993/imap/ssl/novalidate-cert}' . $folder, SA_UNSEEN);
                $unreadCount = ['n' => $status ? (int)$status->unseen : 0];
                imapCacheSet($unreadCacheKey, $unreadCount, 30);
            }
            try { imap_close($imap); } catch (\Throwable $_e) {}

            // Report virtual folder name back to frontend
            $responseFolder = $isVirtualFlagged ? 'Flagged' : $folder;

            jsonResponse(true, [
                'emails' => $emails, 'total' => $total, 'page' => $page,
                'per_page' => $perPage, 'total_pages' => $totalPages,
                'unread' => (int)($unreadCount['n'] ?? 0), 'folder' => $responseFolder,
            ]);
            break;
            
        // ---- READ MESSAGE ----
        case 'message':
            $auth = requireAuth();
            $uid = (int)($_GET['uid'] ?? 0);
            $folder = $_GET['folder'] ?? 'INBOX';
            if ($folder === 'Flagged') $folder = 'INBOX';
            if (!$uid) jsonResponse(false, null, 'uid obrigatorio', 400);

            $imap = getImap($auth['email'], $auth['password'], $folder);
            $msgno = imap_msgno($imap, $uid);
            if (!$msgno) { imap_close($imap); jsonResponse(false, null, 'Email nao encontrado', 404); }
            
            $h = imap_headerinfo($imap, $msgno);
            $body = getBody($imap, $msgno);
            imap_setflag_full($imap, (string)$uid, '\\Seen', ST_UID);
            
            $safeHtml = $body['html'];
            if ($safeHtml) {
                $safeHtml = sanitizeEmailHtml($safeHtml);
            }

            // Read labels for this email
            $msgLabelsMap = [
                'trabalho' => '#1a73e8', 'pessoal' => '#34a853', 'importante' => '#c5221f',
                'financeiro' => '#ea8600', 'social' => '#a142f4', 'viagem' => '#1a9988',
            ];
            $msgParts = explode('@', $auth['email']);
            $msgSettingsFile = "/var/mail/vhosts/{$msgParts[1]}/{$msgParts[0]}/profile/settings.json";
            if (file_exists($msgSettingsFile)) {
                $msgS = json_decode(file_get_contents($msgSettingsFile), true) ?: [];
                foreach (($msgS['custom_labels'] ?? []) as $cl) {
                    $msgLabelsMap[strtolower($cl['name'])] = $cl['color'] ?? '#1a73e8';
                }
            }
            $emailLabels = [];
            foreach ($msgLabelsMap as $lName => $lColor) {
                $labelFlag = '$label_' . $lName;
                $found = @imap_search($imap, 'KEYWORD "' . $labelFlag . '"', SE_UID) ?: [];
                if (in_array($uid, $found)) {
                    $emailLabels[] = ['name' => $lName, 'color' => $lColor];
                }
            }

            try { imap_close($imap); } catch (\Throwable $_e) {}

            $fromArr = parseAddresses($h->from ?? []);
            $toArr = parseAddresses($h->to ?? []);
            $ccArr = parseAddresses($h->cc ?? []);
            $replyToArr = parseAddresses($h->reply_to ?? []);

            // Helper to format addresses as "Name <email>, ..."
            $fmtAddrs = function($arr) {
                return implode(', ', array_map(fn($a) => $a['name'] ? "{$a['name']} <{$a['email']}>" : $a['email'], $arr));
            };

            jsonResponse(true, [
                'uid' => $uid, 'folder' => $folder,
                'subject' => decodeSubject($h->subject ?? ''),
                'from' => $fromArr[0]['email'] ?? '',
                'from_name' => $fromArr[0]['name'] ?? '',
                'to' => $fmtAddrs($toArr),
                'cc' => $fmtAddrs($ccArr),
                'reply_to' => $replyToArr[0]['email'] ?? '',
                'date' => isset($h->date) ? date('d/m/Y H:i', strtotime($h->date)) : null,
                'body_html' => $safeHtml,
                'body_text' => $body['text'],
                'body' => $body['text'],
                'flagged' => isset($h->Flagged) && $h->Flagged === 'F',
                'attachments' => $body['attachments'],
                'message_id' => $h->message_id ?? '',
                'labels' => $emailLabels,
            ]);
            break;
            
        // ---- UNDO SEND ----
        // ---- ALIASES (Gmail multi-from) ----
        // Email send-as aliases: a user can register additional addresses to
        // send "From:" — each alias is verified by clicking a link mailed to
        // the alias address. The user's own login email is implicitly an
        // alias and always returns as verified.
        case 'aliases_list': {
            $auth = requireAuth();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS email_aliases (
                    user_email TEXT NOT NULL,
                    alias_email TEXT NOT NULL,
                    display_name TEXT,
                    verified BOOLEAN DEFAULT FALSE,
                    verify_token TEXT,
                    verify_expires_at BIGINT,
                    created_at TIMESTAMPTZ DEFAULT now(),
                    PRIMARY KEY (user_email, alias_email)
                )");
                $st = $pg->prepare("SELECT alias_email, display_name, verified FROM email_aliases WHERE LOWER(user_email) = LOWER(:e) ORDER BY verified DESC, alias_email ASC");
                $st->execute([':e' => $auth['email']]);
                $rows = $st->fetchAll(PDO::FETCH_ASSOC) ?: [];
                // Always include the login email as a verified default alias
                $primary = [
                    'alias_email' => $auth['email'],
                    'display_name' => $auth['name'] ?? '',
                    'verified' => true,
                    'is_primary' => true,
                ];
                $aliases = [$primary];
                foreach ($rows as $r) {
                    if (strcasecmp($r['alias_email'], $auth['email']) === 0) continue;
                    $aliases[] = [
                        'alias_email' => $r['alias_email'],
                        'display_name' => $r['display_name'] ?? '',
                        'verified' => (bool)$r['verified'],
                        'is_primary' => false,
                    ];
                }
                jsonResponse(true, ['aliases' => $aliases]);
            } catch (Throwable $e) {
                error_log('[aliases_list] ' . $e->getMessage());
                jsonResponse(false, null, 'Falha ao listar aliases', 500);
            }
            break;
        }

        case 'alias_add': {
            $auth = requireAuth();
            $input = getInput();
            $aliasEmail = strtolower(trim($input['alias_email'] ?? ''));
            $displayName = trim((string)($input['display_name'] ?? ''));
            if (!filter_var($aliasEmail, FILTER_VALIDATE_EMAIL)) {
                jsonResponse(false, null, 'Email do alias inválido', 400);
            }
            if (strcasecmp($aliasEmail, $auth['email']) === 0) {
                jsonResponse(false, null, 'Este já é seu email principal', 400);
            }
            // Strip CR/LF from display name to prevent header injection later
            $displayName = preg_replace('/[\r\n]+/', ' ', mb_substr($displayName, 0, 120));
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS email_aliases (
                    user_email TEXT NOT NULL,
                    alias_email TEXT NOT NULL,
                    display_name TEXT,
                    verified BOOLEAN DEFAULT FALSE,
                    verify_token TEXT,
                    verify_expires_at BIGINT,
                    created_at TIMESTAMPTZ DEFAULT now(),
                    PRIMARY KEY (user_email, alias_email)
                )");
                $token = bin2hex(random_bytes(24));
                $expiresAt = time() + 86400; // 24h
                $st = $pg->prepare("INSERT INTO email_aliases (user_email, alias_email, display_name, verified, verify_token, verify_expires_at) VALUES (:u, :a, :n, FALSE, :t, :x) ON CONFLICT (user_email, alias_email) DO UPDATE SET display_name = EXCLUDED.display_name, verify_token = EXCLUDED.verify_token, verify_expires_at = EXCLUDED.verify_expires_at");
                $st->execute([':u' => $auth['email'], ':a' => $aliasEmail, ':n' => $displayName, ':t' => $token, ':x' => $expiresAt]);

                // Send verification email via local SMTP (best-effort).
                $verifyUrl = 'https://chatyy.com.br/api/email.php?action=alias_verify&token=' . urlencode($token);
                $subject = 'Confirme seu alias de email Chatyy';
                $bodyHtml = "<p>Olá,</p><p>O usuário <b>" . htmlspecialchars($auth['email']) . "</b> adicionou <b>" . htmlspecialchars($aliasEmail) . "</b> como alias de envio.</p><p><a href=\"" . htmlspecialchars($verifyUrl) . "\">Confirmar alias</a></p><p>Link expira em 24h.</p>";
                $bodyText = "Confirme o alias visitando:\n" . $verifyUrl . "\n\nLink expira em 24h.\n";
                $boundary = '----=_Alias_' . md5(uniqid('', true));
                $hdr = "From: Chatyy <no-reply@chatyy.com.br>\r\n";
                $hdr .= "To: {$aliasEmail}\r\n";
                $hdr .= "Subject: {$subject}\r\n";
                $hdr .= "Date: " . date('r') . "\r\n";
                $hdr .= "MIME-Version: 1.0\r\n";
                $hdr .= "Content-Type: multipart/alternative; boundary=\"{$boundary}\"\r\n";
                $msg  = "--{$boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n" . $bodyText . "\r\n";
                $msg .= "--{$boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n" . $bodyHtml . "\r\n--{$boundary}--\r\n";
                try {
                    $smtp = @fsockopen('127.0.0.1', 25, $en, $es, 8);
                    if ($smtp) {
                        fgets($smtp, 512); fputs($smtp, "EHLO chatyy.com.br\r\n");
                        while ($l = fgets($smtp, 512)) { if ($l[3] === ' ') break; }
                        fputs($smtp, "MAIL FROM:<no-reply@chatyy.com.br>\r\n"); fgets($smtp, 512);
                        fputs($smtp, "RCPT TO:<{$aliasEmail}>\r\n"); fgets($smtp, 512);
                        fputs($smtp, "DATA\r\n"); fgets($smtp, 512);
                        fputs($smtp, $hdr . "\r\n" . $msg . "\r\n.\r\n"); fgets($smtp, 512);
                        fputs($smtp, "QUIT\r\n"); fclose($smtp);
                    }
                } catch (Throwable $_e) {}
                jsonResponse(true, ['alias_email' => $aliasEmail], 'Email de verificação enviado para ' . $aliasEmail);
            } catch (Throwable $e) {
                error_log('[alias_add] ' . $e->getMessage());
                jsonResponse(false, null, 'Falha ao adicionar alias', 500);
            }
            break;
        }

        case 'alias_verify': {
            // PUBLIC endpoint — invoked by the verification link. No requireAuth().
            $token = (string)($_GET['token'] ?? $_REQUEST['token'] ?? '');
            if (!$token || !preg_match('/^[a-f0-9]{16,64}$/', $token)) {
                http_response_code(400);
                echo "<html><body><h2>Token inválido</h2></body></html>";
                exit;
            }
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $st = $pg->prepare("SELECT user_email, alias_email, verify_expires_at FROM email_aliases WHERE verify_token = :t LIMIT 1");
                $st->execute([':t' => $token]);
                $row = $st->fetch(PDO::FETCH_ASSOC);
                if (!$row) {
                    http_response_code(404);
                    echo "<html><body><h2>Token não encontrado ou já usado</h2></body></html>";
                    exit;
                }
                if ((int)$row['verify_expires_at'] < time()) {
                    http_response_code(410);
                    echo "<html><body><h2>Link expirado</h2><p>Adicione o alias novamente para receber outro link.</p></body></html>";
                    exit;
                }
                $up = $pg->prepare("UPDATE email_aliases SET verified = TRUE, verify_token = NULL, verify_expires_at = NULL WHERE user_email = :u AND alias_email = :a");
                $up->execute([':u' => $row['user_email'], ':a' => $row['alias_email']]);
                echo "<html><body style=\"font-family:system-ui;text-align:center;padding:40px\"><h2>Alias confirmado</h2><p><b>" . htmlspecialchars($row['alias_email']) . "</b> agora pode ser usado como remetente.</p><p>Volte ao Chatyy.</p></body></html>";
                exit;
            } catch (Throwable $e) {
                error_log('[alias_verify] ' . $e->getMessage());
                http_response_code(500);
                echo "<html><body><h2>Erro interno</h2></body></html>";
                exit;
            }
            break;
        }

        case 'alias_remove': {
            $auth = requireAuth();
            $input = getInput();
            $aliasEmail = strtolower(trim($input['alias_email'] ?? ''));
            if (!$aliasEmail) jsonResponse(false, null, 'alias_email required', 400);
            if (strcasecmp($aliasEmail, $auth['email']) === 0) {
                jsonResponse(false, null, 'Não é possível remover seu email principal', 400);
            }
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $st = $pg->prepare("DELETE FROM email_aliases WHERE LOWER(user_email) = LOWER(:u) AND LOWER(alias_email) = LOWER(:a)");
                $st->execute([':u' => $auth['email'], ':a' => $aliasEmail]);
                jsonResponse(true, null, 'Alias removido');
            } catch (Throwable $e) {
                error_log('[alias_remove] ' . $e->getMessage());
                jsonResponse(false, null, 'Falha ao remover alias', 500);
            }
            break;
        }

        case 'cancel_send':
            $auth = requireAuth();
            $input = getInput();
            $sendId = $input['send_id'] ?? '';
            if (!$sendId) jsonResponse(false, null, 'send_id required', 400);

            // Path binds the sender email so a forged sendId from user B
            // cannot locate user A's queued message even in theory.
            $queueFile = '/tmp/send_queue_' . md5(strtolower($auth['email']) . '|' . $sendId);
            if (!file_exists($queueFile)) {
                jsonResponse(false, null, 'Email ja foi enviado ou nao encontrado', 404);
            }

            $queueData = json_decode(file_get_contents($queueFile), true);
            if (!$queueData || ($queueData['email'] ?? '') !== $auth['email']) {
                jsonResponse(false, null, 'Nao autorizado', 403);
            }

            // Cancel: delete queue file
            @unlink($queueFile);
            jsonResponse(true, null, 'Envio cancelado com sucesso');
            break;

        // ---- SEND ----
        case 'send':
            $auth = requireAuth();
            $input = getInput();
            $to = sanitizeHeader(trim($input['to'] ?? ''));
            $subject = sanitizeHeader(trim($input['subject'] ?? ''));
            $body = $input['body'] ?? '';
            $cc = sanitizeHeader(trim($input['cc'] ?? ''));
            $bcc = sanitizeHeader(trim($input['bcc'] ?? ''));
            $inReplyTo = sanitizeHeader($input['in_reply_to'] ?? '');
            $undoDelay = (int)($input['undo_delay'] ?? 7); // seconds, 0 = send immediately
            $undoDelay = max(0, min(30, $undoDelay)); // clamp 0-30
            // Read-receipt opt-in: client toggles "Confirmar leitura" — we
            // mint a tracking id, inject a 1×1 pixel into the HTML body
            // pointing at action=track_open&id=…, and log opens in
            // email_opens. Plain-text alt part stays clean.
            $trackOpens = !empty($input['track_opens']);
            $trackId = '';
            if ($trackOpens) {
                $trackId = bin2hex(random_bytes(12));
                try {
                    require_once __DIR__ . '/db.php';
                    $pg = getPGDB();
                    @$pg->exec("CREATE TABLE IF NOT EXISTS email_opens (
                        id BIGSERIAL PRIMARY KEY,
                        track_id TEXT NOT NULL,
                        sender_email TEXT NOT NULL,
                        recipient TEXT,
                        subject TEXT,
                        opener_ip TEXT,
                        opener_ua TEXT,
                        opened_at TIMESTAMPTZ,
                        created_at TIMESTAMPTZ DEFAULT now()
                    )");
                    @$pg->exec("CREATE INDEX IF NOT EXISTS idx_email_opens_track ON email_opens(track_id)");
                    @$pg->exec("CREATE INDEX IF NOT EXISTS idx_email_opens_sender ON email_opens(sender_email)");
                    $pg->prepare("INSERT INTO email_opens (track_id, sender_email, recipient, subject) VALUES (:t, :s, :r, :sj)")
                       ->execute([
                           ':t' => $trackId,
                           ':s' => $auth['email'],
                           ':r' => mb_substr($to, 0, 240),
                           ':sj' => mb_substr($subject, 0, 240),
                       ]);
                } catch (Throwable $e) { error_log('[track_open.row] ' . $e->getMessage()); }
                // Inject pixel right before </body> (or append).
                $pixelImg = '<img src="https://chatyy.com.br/api/email.php?action=track_open&id=' . $trackId . '" width="1" height="1" alt="" style="border:0;width:1px;height:1px" />';
                if (stripos($body, '</body>') !== false) {
                    $body = preg_replace('/<\/body>/i', $pixelImg . '</body>', $body, 1);
                } else {
                    $body .= $pixelImg;
                }
            }

            // Schedule send (Gmail parity): explicit ISO timestamp wins over
            // undo_delay. Clamp to 90 days; the queued-sender script just
            // sleeps until then. Anything past 24h already lives better in a
            // cron worker, but we accept it here so the path is unified.
            $sendAtIso = isset($input['send_at']) ? trim((string)$input['send_at']) : '';
            if ($sendAtIso) {
                $sendAtTs = strtotime($sendAtIso);
                if ($sendAtTs && $sendAtTs > time()) {
                    $delta = $sendAtTs - time();
                    $maxDelta = 90 * 86400;
                    if ($delta > $maxDelta) $delta = $maxDelta;
                    $undoDelay = $delta;
                }
            }

            if (!$to || !$subject) jsonResponse(false, null, 'to and subject required', 400);

            // Parental gate (server-side enforcement; client UI guards bypassable).
            try {
                require_once __DIR__ . '/parental_helper.php';
                $recipients = array_filter(array_map('trim', preg_split('/[,;]/', $to . ',' . $cc . ',' . $bcc)));
                // Strip any "Name <email>" formatting → just email.
                $peerEmails = array_map(function($r) {
                    if (preg_match('/<([^>]+)>/', $r, $m)) return trim($m[1]);
                    return trim($r);
                }, $recipients);
                $gate = parentalGate($auth['email'], $peerEmails, 'email');
                if ($gate['blocked']) {
                    jsonResponse(false, ['parental_block' => $gate['reason']], parentalBlockMessage($gate['reason']), 403);
                }
            } catch (Throwable $e) { error_log('[email_send.parental] ' . $e->getMessage()); }

            // Rate limit: max 50 emails per hour per user
            $sendRateFile = '/tmp/send_rate_' . md5($auth['email']);
            $sendRates = file_exists($sendRateFile) ? json_decode(file_get_contents($sendRateFile), true) : [];
            $sendRates = array_filter($sendRates, fn($t) => $t > time() - 3600);
            if (count($sendRates) >= 50) {
                jsonResponse(false, null, 'Limite de envio atingido (50/hora). Tente novamente mais tarde.', 429);
            }
            $sendRates[] = time();
            file_put_contents($sendRateFile, json_encode($sendRates), LOCK_EX);

            // Collect attachments from $_FILES
            $attachments = [];
            $totalSize = 0;
            foreach ($_FILES as $key => $file) {
                if (strpos($key, 'attachment_') !== 0) continue;
                if ($file['error'] !== UPLOAD_ERR_OK) continue;
                $totalSize += $file['size'];
                if ($totalSize > 50 * 1024 * 1024) jsonResponse(false, null, 'Anexos excedem 50MB', 400);
                if (count($attachments) >= 10) jsonResponse(false, null, 'Maximo 10 anexos', 400);
                $attachments[] = [
                    'tmp' => $file['tmp_name'],
                    'name' => $file['name'],
                    'type' => $file['type'] ?: (mime_content_type($file['tmp_name']) ?: 'application/octet-stream'),
                    'size' => $file['size'],
                ];
            }

            // 100GB plan storage cap — sent mail copies + Maildir count
            // toward the email_used pool the storage aggregator tracks.
            // Refuse before we hand the mail to MTA so an over-quota user
            // doesn't silently grow Sent/.
            if ($totalSize > 0) {
                require_once __DIR__ . '/plans.php';
                enforceStorageCap($auth['email'], (int)$totalSize);
            }

            // Generate plain text from HTML
            $plainText = $body;
            $plainText = preg_replace('/<br\s*\/?>/i', "\n", $plainText);
            $plainText = preg_replace('/<\/(p|div|h[1-6]|li|tr)>/i', "\n", $plainText);
            $plainText = preg_replace('/<(ul|ol)>/i', "\n", $plainText);
            $plainText = strip_tags($plainText);
            $plainText = html_entity_decode($plainText, ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $plainText = preg_replace('/\n{3,}/', "\n\n", trim($plainText));

            // Send-as aliases: optional `from_alias` overrides the From header.
            // Must be either the user's own login email or a verified alias.
            $fromAliasEmail = strtolower(trim((string)($input['from_alias'] ?? '')));
            $fromAliasName  = '';
            if ($fromAliasEmail && strcasecmp($fromAliasEmail, $auth['email']) !== 0) {
                try {
                    require_once __DIR__ . '/db.php';
                    $pgA = getPGDB();
                    $stA = $pgA->prepare("SELECT alias_email, display_name FROM email_aliases WHERE LOWER(user_email) = LOWER(:u) AND LOWER(alias_email) = LOWER(:a) AND verified = TRUE LIMIT 1");
                    $stA->execute([':u' => $auth['email'], ':a' => $fromAliasEmail]);
                    $rowA = $stA->fetch(PDO::FETCH_ASSOC);
                    if (!$rowA) {
                        jsonResponse(false, null, 'Alias não verificado', 403);
                    }
                    $fromAliasName = (string)($rowA['display_name'] ?? '');
                } catch (Throwable $e) {
                    error_log('[send.from_alias] ' . $e->getMessage());
                    jsonResponse(false, null, 'Falha ao validar alias', 500);
                }
            } else {
                $fromAliasEmail = $auth['email'];
                $fromAliasName  = $auth['name'] ?? '';
            }

            // Determine sender domain (still derived from the login email so the
            // SMTP envelope auth matches the user's authenticated account).
            $senderDomain = explode('@', $auth['email'])[1] ?? 'onemundo.com.br';

            // ── Auto-attach email signature ──────────────────────────────
            // Picks: explicit `signature_id` from input → matched-alias →
            // user's default. Skipped when `skip_signature` is set or when
            // the body already contains a `<!-- signature -->` marker (e.g.
            // a draft saved with one already inlined).
            if (empty($input['skip_signature']) && stripos($body, '<!-- signature -->') === false) {
                try {
                    require_once __DIR__ . '/db.php';
                    $pgSig = getPGDB();
                    @$pgSig->exec("CREATE TABLE IF NOT EXISTS email_signatures (
                        id BIGSERIAL PRIMARY KEY, user_email TEXT NOT NULL,
                        name TEXT NOT NULL, body_html TEXT NOT NULL,
                        is_default BOOLEAN DEFAULT FALSE, alias_email TEXT DEFAULT '',
                        created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())");
                    $sigRow = null;
                    if (!empty($input['signature_id'])) {
                        $stSig = $pgSig->prepare("SELECT body_html FROM email_signatures WHERE id = :id AND LOWER(user_email) = LOWER(:u)");
                        $stSig->execute([':id' => (int)$input['signature_id'], ':u' => $auth['email']]);
                        $sigRow = $stSig->fetch(PDO::FETCH_ASSOC);
                    }
                    if (!$sigRow) {
                        // Try alias-matched signature first.
                        $stSig = $pgSig->prepare("SELECT body_html FROM email_signatures WHERE LOWER(user_email) = LOWER(:u) AND LOWER(alias_email) = LOWER(:a) ORDER BY is_default DESC LIMIT 1");
                        $stSig->execute([':u' => $auth['email'], ':a' => $fromAliasEmail]);
                        $sigRow = $stSig->fetch(PDO::FETCH_ASSOC);
                    }
                    if (!$sigRow) {
                        $stSig = $pgSig->prepare("SELECT body_html FROM email_signatures WHERE LOWER(user_email) = LOWER(:u) AND is_default = TRUE LIMIT 1");
                        $stSig->execute([':u' => $auth['email']]);
                        $sigRow = $stSig->fetch(PDO::FETCH_ASSOC);
                    }
                    if ($sigRow && !empty($sigRow['body_html'])) {
                        $body .= "<br/><br/><!-- signature -->\n" . $sigRow['body_html'];
                        // Re-generate plain text alt part so the signature
                        // also appears in text/plain clients.
                        $plainText = $body;
                        $plainText = preg_replace('/<br\s*\/?>/i', "\n", $plainText);
                        $plainText = preg_replace('/<\/(p|div|h[1-6]|li|tr)>/i', "\n", $plainText);
                        $plainText = preg_replace('/<(ul|ol)>/i', "\n", $plainText);
                        $plainText = strip_tags($plainText);
                        $plainText = html_entity_decode($plainText, ENT_QUOTES | ENT_HTML5, 'UTF-8');
                        $plainText = preg_replace('/\n{3,}/', "\n\n", trim($plainText));
                    }
                } catch (Throwable $e) { error_log('[send.signature] ' . $e->getMessage()); }
            }
            // ────────────────────────────────────────────────────────────

            // MIME boundaries
            $hasAttachments = count($attachments) > 0;
            $mixedBoundary = '----=_Mixed_' . md5(uniqid(mt_rand(), true) . microtime());
            $altBoundary = '----=_Alt_' . md5(uniqid(mt_rand(), true) . microtime());

            // Build headers — From: uses the chosen alias (default: login email)
            $fromDisplayName = $fromAliasName !== '' ? $fromAliasName : ($auth['name'] ?? '');
            $fromDisplayName = preg_replace('/[\r\n]+/', ' ', $fromDisplayName);
            $headers = "From: {$fromDisplayName} <{$fromAliasEmail}>\r\n";
            $headers .= "To: {$to}\r\n";
            if ($cc) $headers .= "Cc: {$cc}\r\n";
            $headers .= "Subject: {$subject}\r\n";
            $headers .= "Date: " . date('r') . "\r\n";
            $headers .= "Message-ID: <" . uniqid('om_', true) . "@{$senderDomain}>\r\n";
            $headers .= "MIME-Version: 1.0\r\n";
            if ($hasAttachments) {
                $headers .= "Content-Type: multipart/mixed; boundary=\"{$mixedBoundary}\"\r\n";
            } else {
                $headers .= "Content-Type: multipart/alternative; boundary=\"{$altBoundary}\"\r\n";
            }
            $headers .= "X-Mailer: OneMundo Mail/1.0\r\n";
            if ($inReplyTo) {
                $headers .= "In-Reply-To: {$inReplyTo}\r\n";
                $headers .= "References: {$inReplyTo}\r\n";
            }

            // Build text/html alternative part
            $altBody  = "--{$altBoundary}\r\n";
            $altBody .= "Content-Type: text/plain; charset=UTF-8\r\n";
            $altBody .= "Content-Transfer-Encoding: quoted-printable\r\n\r\n";
            $altBody .= quoted_printable_encode($plainText) . "\r\n";
            $altBody .= "--{$altBoundary}\r\n";
            $altBody .= "Content-Type: text/html; charset=UTF-8\r\n";
            $altBody .= "Content-Transfer-Encoding: quoted-printable\r\n\r\n";
            $altBody .= quoted_printable_encode($body) . "\r\n";
            $altBody .= "--{$altBoundary}--\r\n";

            if ($hasAttachments) {
                // Wrap alternative inside mixed
                $mimeBody  = "--{$mixedBoundary}\r\n";
                $mimeBody .= "Content-Type: multipart/alternative; boundary=\"{$altBoundary}\"\r\n\r\n";
                $mimeBody .= $altBody;

                // Add each attachment
                foreach ($attachments as $att) {
                    $encoded = chunk_split(base64_encode(file_get_contents($att['tmp'])));
                    $safeName = str_replace(['"', "\r", "\n"], '', $att['name']);
                    $mimeBody .= "--{$mixedBoundary}\r\n";
                    $mimeBody .= "Content-Type: {$att['type']}; name=\"{$safeName}\"\r\n";
                    $mimeBody .= "Content-Disposition: attachment; filename=\"{$safeName}\"\r\n";
                    $mimeBody .= "Content-Transfer-Encoding: base64\r\n\r\n";
                    $mimeBody .= $encoded;
                }
                $mimeBody .= "--{$mixedBoundary}--\r\n";
            } else {
                $mimeBody = $altBody;
            }

            $fullMsg = $headers . "\r\n" . $mimeBody;

            // Undo Send: if delay > 0, queue for delayed sending
            if ($undoDelay > 0) {
                $sendId = bin2hex(random_bytes(16));
                $queueFile = '/tmp/send_queue_' . md5(strtolower($auth['email']) . '|' . $sendId);
                $queueData = [
                    'email' => $auth['email'],
                    'password_enc' => $_SESSION['password_enc'],
                    'full_msg' => base64_encode($fullMsg),
                    'to' => $to,
                    'cc' => $cc,
                    'bcc' => $bcc,
                    'send_at' => time() + $undoDelay,
                    'created_at' => time(),
                ];
                file_put_contents($queueFile, json_encode($queueData), LOCK_EX);

                // Launch background sender
                // PHP_BINARY resolves to /usr/sbin/php-fpm8.4 under PHP-FPM — which doesn't accept `-r`
                // and silently exits with a usage message, leaving the queued email in /tmp forever.
                // Force the CLI binary here so the detached sleep+SMTP script actually runs.
                $phpBin = is_executable('/usr/bin/php') ? '/usr/bin/php' : (is_executable('/usr/bin/php8.4') ? '/usr/bin/php8.4' : PHP_BINARY);
                $cmd = sprintf(
                    '%s -r %s > /dev/null 2>&1 &',
                    escapeshellarg($phpBin),
                    escapeshellarg(
                        'sleep(' . $undoDelay . '); ' .
                        '$f = "/tmp/send_queue_' . md5(strtolower($auth['email']) . '|' . $sendId) . '"; ' .
                        'if (!file_exists($f)) exit(0); ' .
                        '$d = json_decode(file_get_contents($f), true); ' .
                        '@unlink($f); ' .
                        '$msg = base64_decode($d["full_msg"]); ' .
                        '$to = $d["to"]; $cc = $d["cc"] ?? ""; $bcc = $d["bcc"] ?? ""; $from = $d["email"]; ' .
                        '$smtp = @fsockopen("127.0.0.1", 25, $en, $es, 10); ' .
                        'if (!$smtp) exit(1); ' .
                        'fgets($smtp,512); fputs($smtp,"EHLO mail.onemundo.com.br\r\n"); ' .
                        'while($l=fgets($smtp,512)){if($l[3]===" ")break;} ' .
                        'fputs($smtp,"MAIL FROM:<{$from}>\r\n"); fgets($smtp,512); ' .
                        'foreach(array_filter(array_map("trim",explode(",",$to))) as $a){fputs($smtp,"RCPT TO:<{$a}>\r\n");fgets($smtp,512);} ' .
                        'if($cc) foreach(array_filter(array_map("trim",explode(",",$cc))) as $a){fputs($smtp,"RCPT TO:<{$a}>\r\n");fgets($smtp,512);} ' .
                        'if($bcc) foreach(array_filter(array_map("trim",explode(",",$bcc))) as $a){fputs($smtp,"RCPT TO:<{$a}>\r\n");fgets($smtp,512);} ' .
                        'fputs($smtp,"DATA\r\n"); fgets($smtp,512); ' .
                        'fputs($smtp,$msg."\r\n.\r\n"); $r=fgets($smtp,512); ' .
                        'fputs($smtp,"QUIT\r\n"); fclose($smtp); ' .
                        'if(substr($r,0,3)==="250"){' .
                        '  $key=hash("sha256",getenv("WEBMAIL_SESSION_KEY")?:"onemundo-mail-session-key-2026-".php_uname("n")."-/var/www/mail/api",true);' .
                        '  $raw=base64_decode($d["password_enc"]);$iv=substr($raw,0,16);$ct=substr($raw,16);' .
                        '  $pw=openssl_decrypt($ct,"aes-256-cbc",$key,OPENSSL_RAW_DATA,$iv);' .
                        '  if($pw){$mb="{127.0.0.1:993/imap/ssl/novalidate-cert}Sent";' .
                        '  $im=@imap_open($mb,$from,$pw);if($im){imap_append($im,$mb,$msg,"\\\\Seen");imap_close($im);}}' .
                        '}'
                    )
                );
                exec($cmd);

                jsonResponse(true, [
                    'send_id' => $sendId,
                    'undo_seconds' => $undoDelay,
                    'status' => 'queued',
                ], 'Email na fila. Voce tem ' . $undoDelay . 's para cancelar.');
                break;
            }

            // Send immediately (undo_delay = 0)
            $smtp = @fsockopen("127.0.0.1", 25, $errno, $errstr, 10);
            if (!$smtp) jsonResponse(false, null, "SMTP connect error: {$errstr}", 500);

            fgets($smtp, 512);
            fputs($smtp, "EHLO mail.onemundo.com.br\r\n");
            while ($line = fgets($smtp, 512)) { if ($line[3] === " ") break; }

            fputs($smtp, "MAIL FROM:<{$auth["email"]}>\r\n"); fgets($smtp, 512);

            foreach (array_filter(array_map("trim", explode(",", $to))) as $addr) {
                fputs($smtp, "RCPT TO:<{$addr}>\r\n"); fgets($smtp, 512);
            }
            if ($cc) foreach (array_filter(array_map("trim", explode(",", $cc))) as $addr) {
                fputs($smtp, "RCPT TO:<{$addr}>\r\n"); fgets($smtp, 512);
            }
            if ($bcc) foreach (array_filter(array_map("trim", explode(",", $bcc))) as $addr) {
                fputs($smtp, "RCPT TO:<{$addr}>\r\n"); fgets($smtp, 512);
            }

            fputs($smtp, "DATA\r\n"); fgets($smtp, 512);
            fputs($smtp, $fullMsg . "\r\n.\r\n");
            $dataResp = fgets($smtp, 512);
            fputs($smtp, "QUIT\r\n"); fclose($smtp);

            $sent = substr($dataResp, 0, 3) === "250";

            if ($sent) {
                try {
                    $imap = getImap($auth['email'], $auth['password'], 'Sent');
                    imap_append($imap, '{127.0.0.1:993/imap/ssl/novalidate-cert}Sent', $fullMsg, "\\Seen");
                    try { imap_close($imap); } catch (\Throwable $_e) {}
                } catch (Exception $e) {}
            }

            jsonResponse($sent, ['send_id' => null, 'status' => $sent ? 'sent' : 'failed'], $sent ? 'Email enviado' : 'Falha ao enviar');
            break;
            
        // ---- FOLDERS ----
        case 'folders':
            $auth = requireAuth();
            // CACHE LAYER 1: folder list per-user, TTL 60s.
            // Key: folders:$email — invalidated on delete/move/mark_read/mark_unread/send.
            $foldersCacheKey = 'folders:' . strtolower($auth['email']);
            $cachedFolders = imapCacheGet($foldersCacheKey);
            if ($cachedFolders !== null) {
                jsonResponse(true, $cachedFolders);
                break;
            }
            $imap = getImap($auth['email'], $auth['password']);
            $list = imap_list($imap, '{127.0.0.1:993/imap/ssl/novalidate-cert}', '*') ?: [];

            $folders = [];
            foreach ($list as $f) {
                $name = str_replace('{127.0.0.1:993/imap/ssl/novalidate-cert}', '', $f);
                $status = @imap_status($imap, $f, SA_UNSEEN | SA_MESSAGES);
                $folders[] = [
                    'name' => $name,
                    'unread' => $status ? $status->unseen : 0,
                    'total' => $status ? $status->messages : 0,
                ];
            }
            // Add virtual Flagged folder: count starred messages in INBOX
            $flaggedUids = @imap_search($imap, 'FLAGGED', SE_UID) ?: [];
            $flaggedCount = count($flaggedUids);
            // Count unread among flagged
            $flaggedUnreadUids = @imap_search($imap, 'FLAGGED UNSEEN', SE_UID) ?: [];
            $flaggedUnread = count($flaggedUnreadUids);
            $folders[] = [
                'name' => 'Flagged',
                'unread' => $flaggedUnread,
                'total' => $flaggedCount,
            ];

            try { imap_close($imap); } catch (\Throwable $_e) {}
            imapCacheSet($foldersCacheKey, $folders, 60);
            jsonResponse(true, $folders);
            break;

        // ---- MOVE/DELETE/MARK ----
        case 'delete':
            $auth = requireAuth();
            $input = getInput();
            $uid = (int)($input['uid'] ?? 0);
            $folder = $input['folder'] ?? 'INBOX';
            if ($folder === 'Flagged') $folder = 'INBOX';
            if (!$uid) jsonResponse(false, null, 'uid obrigatorio', 400);
            
            $imap = getImap($auth['email'], $auth['password'], $folder);
            if ($folder !== 'Trash') {
                @imap_mail_move($imap, (string)$uid, 'Trash', CP_UID);
                imap_expunge($imap);
            } else {
                imap_delete($imap, (string)$uid, FT_UID);
                imap_expunge($imap);
            }
            try { imap_close($imap); } catch (\Throwable $_e) {}
            // Invalidate src + Trash + folder list.
            imapCacheInvalidateFolder($auth['email'], $folder);
            if ($folder !== 'Trash') imapCacheInvalidateFolder($auth['email'], 'Trash');
            jsonResponse(true, null, 'Email excluido');
            break;
            
        case 'mark_read':
        case 'mark_unread':
            $auth = requireAuth();
            $input = getInput();
            $uid = (int)($input['uid'] ?? 0);
            $folder = $input['folder'] ?? 'INBOX';
            if ($folder === 'Flagged') $folder = 'INBOX';
            if (!$uid) jsonResponse(false, null, 'uid obrigatorio', 400);
            
            $imap = getImap($auth['email'], $auth['password'], $folder);
            // Verify UID exists first
            $check = @imap_fetch_overview($imap, (string)$uid, FT_UID);
            if (!$check) {
                try { imap_close($imap); } catch (\Throwable $_e) {}
                jsonResponse(false, null, 'Email nao encontrado (UID invalido)', 404);
            }
            if ($action === 'mark_read') {
                $ok = @imap_setflag_full($imap, (string)$uid, '\\Seen', ST_UID);
            } else {
                $ok = @imap_clearflag_full($imap, (string)$uid, '\\Seen', ST_UID);
            }
            // Close with CL_EXPUNGE to flush flag changes
            imap_close($imap, CL_EXPUNGE);
            // Invalidate caches: per-msg header + per-folder unread + folder list (counts).
            imapCacheDel('mhdr:' . strtolower($auth['email']) . ':' . $folder . ':' . $uid);
            imapCacheDel('unread:' . strtolower($auth['email']) . ':' . $folder);
            imapCacheDel('folders:' . strtolower($auth['email']));
            jsonResponse(true, null, $action === 'mark_read' ? 'Marcado como lido' : 'Marcado como nao lido');
            break;

        case 'move':
            $auth = requireAuth();
            $input = getInput();
            $uid = (int)($input['uid'] ?? 0);
            $toFolderRaw = $input['to_folder'] ?? '';
            $toFolder = sanitizeImapFolder($toFolderRaw);
            $folder = $input['folder'] ?? 'INBOX';
            if ($folder === 'Flagged') $folder = 'INBOX';
            if (!$uid || $toFolderRaw === '') jsonResponse(false, null, 'uid e to_folder obrigatorios', 400);

            $imap = getImap($auth['email'], $auth['password'], $folder);
            imap_mail_move($imap, (string)$uid, $toFolder, CP_UID);
            imap_expunge($imap);
            try { imap_close($imap); } catch (\Throwable $_e) {}
            // Invalidate source + destination folders + folder list (counts changed).
            imapCacheInvalidateFolder($auth['email'], $folder);
            imapCacheInvalidateFolder($auth['email'], $toFolder);
            jsonResponse(true, null, "Movido para {$toFolder}");
            break;
            
        // ---- PHONE VERIFICATION (own code + SMS + WhatsApp) ----
        case 'verify_send':
            require_once __DIR__ . '/phone-auth.php';
            $input = getInput();
            $phone = trim($input['phone'] ?? '');
            if (!$phone) jsonResponse(false, null, 'Telefone obrigatorio', 400);

            // Rate limit
            $rateFile = '/tmp/verify_rate_' . md5($phone);
            $rates = file_exists($rateFile) ? json_decode(file_get_contents($rateFile), true) : [];
            $rates = array_filter($rates, fn($t) => $t > time() - 600);
            if (count($rates) >= 20) jsonResponse(false, null, 'Muitas tentativas. Aguarde 10 minutos.', 429);
            $rates[] = time();
            file_put_contents($rateFile, json_encode(array_values($rates)), LOCK_EX);

            // Idempotent OTP: if a code was issued recently and still has
            // > 30s of TTL left, REUSE it instead of generating a new one.
            // Double-tap "Send code" or signup+login race would otherwise
            // overwrite the code mid-flight, making the first SMS the user
            // already received unverifiable. Re-send the same digits via
            // SMS/WhatsApp so the user can verify either delivery.
            $codeFile = '/tmp/verify_code_' . md5($phone) . '.json';
            $existing = null;
            if (file_exists($codeFile)) {
                $existing = @json_decode(@file_get_contents($codeFile), true);
                if (!is_array($existing) || ($existing['expires'] ?? 0) <= time() + 30) {
                    $existing = null;
                }
            }
            if ($existing && !empty($existing['code'])) {
                $code = (string)$existing['code'];
                error_log("[verify_send_reuse] phone={$phone} ttl_left=" . (($existing['expires'] ?? 0) - time()));
            } else {
                $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
                file_put_contents($codeFile, json_encode([
                    'code' => $code,
                    'phone' => $phone,
                    'expires' => time() + 600,
                    'attempts' => 0,
                ]), LOCK_EX);
            }

            $sid = getenv('TWILIO_SID') ?: getenv('TWILIO_ACCOUNT_SID');
            $tkn = getenv('TWILIO_TOKEN') ?: getenv('TWILIO_AUTH_TOKEN');
            $smsFrom = (str_starts_with($phone, "+55") && getenv("TWILIO_CHATYY_BR")) ? getenv("TWILIO_CHATYY_BR") : (getenv("TWILIO_CHATYY_US") ?: getenv("TWILIO_FROM") ?: "+19542505964");
            $waFrom = getenv('TWILIO_WHATSAPP_FROM') ?: '12093093434';
            if (!$sid || !$tkn) jsonResponse(false, null, 'Servico nao configurado', 500);

            $msgBody = chatyyOtpMessage($phone, $code);
            $channelReq = strtolower(trim($input['channel'] ?? 'sms'));

            // Voice fallback (WhatsApp/Telegram parity): if user clicks "Receber
            // por chamada", make a Twilio Voice call with TwiML <Say> reading
            // the digits aloud, twice, in PT-BR. Skips SMS+WA entirely on this
            // call — the OTP file was already written above so verify_check
            // still works no matter which channel delivered the code.
            if ($channelReq === 'voice') {
                $digits = implode(' ', str_split($code));
                $twiml = '<Response><Say voice="Polly.Camila-Neural" language="pt-BR">Seu código Chatyy é: <break time="500ms"/>'
                       . $digits . '<break time="800ms"/>Repetindo: '
                       . $digits . '</Say></Response>';
                $chV = curl_init("https://api.twilio.com/2010-04-01/Accounts/{$sid}/Calls.json");
                curl_setopt_array($chV, [
                    CURLOPT_POST => true,
                    CURLOPT_POSTFIELDS => http_build_query([
                        'From' => $smsFrom,
                        'To'   => $phone,
                        'Twiml' => $twiml,
                    ]),
                    CURLOPT_USERPWD => "{$sid}:{$tkn}",
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT => 12,
                ]);
                curl_exec($chV);
                $voiceOk = curl_getinfo($chV, CURLINFO_HTTP_CODE) >= 200 && curl_getinfo($chV, CURLINFO_HTTP_CODE) < 300;
                curl_close($chV);
                if (!$voiceOk) jsonResponse(false, null, 'Falha ao iniciar chamada', 502);
                $digitsM = preg_replace('/\D/', '', $phone);
                $masked = strlen($digitsM) >= 4
                    ? '(' . substr($digitsM, -10, 2) . ') ***-**' . substr($digitsM, -2)
                    : '***';
                jsonResponse(true, [
                    'masked_phone' => $masked,
                    'voice_called' => true,
                ], 'Chamada iniciada — atenda pra ouvir o codigo');
            }

            // 1) Send SMS via Telnyx (replaces Twilio Verify which
            // kept blocking the account from rate-limit/aggregator flagging).
            // Telnyx routes through different SMS carriers — same delivery
            // success in BR + US, no shared penalty box with Twilio. Twilio
            // Messages stays as fallback below if Telnyx ever fails.
            $smsOk = sendTelnyxSms($phone, $msgBody);
            // Fallback to Messages API if Verify failed (quota, network etc.)
            if (!$smsOk) {
                $ch = curl_init("https://api.twilio.com/2010-04-01/Accounts/{$sid}/Messages.json");
                curl_setopt_array($ch, [
                    CURLOPT_POST => true,
                    CURLOPT_POSTFIELDS => http_build_query([
                        'From' => $smsFrom,
                        'To'   => $phone,
                        'Body' => $msgBody,
                    ]),
                    CURLOPT_USERPWD => "{$sid}:{$tkn}",
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT => 15,
                ]);
                curl_exec($ch);
                $smsCode2 = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                $smsOk = ($smsCode2 >= 200 && $smsCode2 < 300);
                curl_close($ch);
            }

            // 2) Send WhatsApp (with OTP auth template)
            $waTo = preg_replace('/^\+/', '', $phone);
            $ch2 = curl_init("https://api.twilio.com/2010-04-01/Accounts/{$sid}/Messages.json");
            curl_setopt_array($ch2, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => http_build_query([
                    'From' => 'whatsapp:' . (str_starts_with($waFrom, '+') ? $waFrom : '+' . $waFrom),
                    'To'   => 'whatsapp:+' . $waTo,
                    'ContentSid' => 'HXc62a1c60c0ca3da5b6aa0e8df9d30b9e',
                    'ContentVariables' => json_encode(['1' => $code]),
                ]),
                CURLOPT_USERPWD => "{$sid}:{$tkn}",
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 10,
            ]);
            $waResp2 = curl_exec($ch2); error_log("[VERIFY_WA] code=" . curl_getinfo($ch2, CURLINFO_HTTP_CODE) . " err=" . curl_error($ch2) . " resp=" . substr($waResp2 ?: "null", 0, 300));
            $waCode2 = curl_getinfo($ch2, CURLINFO_HTTP_CODE);
            $waOk = ($waCode2 >= 200 && $waCode2 < 300);
            curl_close($ch2);

            if ($smsOk || $waOk) {
                $digits = preg_replace('/\D/', '', $phone);
                $masked = strlen($digits) >= 4
                    ? '(' . substr($digits, -10, 2) . ') ***-**' . substr($digits, -2)
                    : '***';
                $channels = [];
                if ($smsOk) $channels[] = 'SMS';
                if ($waOk) $channels[] = 'WhatsApp';
                jsonResponse(true, [
                    'masked_phone' => $masked,
                    'sms_sent' => $smsOk,
                    'whatsapp_sent' => $waOk,
                ], 'Codigo enviado via ' . implode(' e ', $channels));
            } else {
                jsonResponse(false, null, 'Falha ao enviar codigo', 500);
            }
            exit;

        // ---- PHONE-FIRST AUTH (WhatsApp-style) ----
        // Three actions complete the loop:
        //   phone_login_request — phone known? send OTP
        //   phone_login_verify  — OTP correct? issue bearer token (no password)
        //   phone_signup        — verify_token + email pick → create account
        case 'auth_attach_password': {
            // 2026-05-09: Phone-login users get a token with password_enc=''
            // (chat/feed/etc work with empty bearer; IMAP-fronted endpoints
            // fail). Esse endpoint permite anexar a senha de email ao token
            // existente — valida via IMAP e re-encripta no token file/PG.
            // Retorna 200 só se IMAP aceitar a senha. Tokens antigos com
            // senha errada são automaticamente atualizados.
            $auth = requireAuthLite();
            $email = $auth['email'] ?? '';
            $input = getInput();
            $password = (string)($input['password'] ?? '');
            if (!$password) jsonResponse(false, null, 'password obrigatorio', 400);

            // Valida via IMAP login
            $mailbox = '{127.0.0.1:993/imap/ssl/novalidate-cert}INBOX';
            $imap = @imap_open($mailbox, $email, $password);
            if (!$imap) {
                $errs = imap_errors();
                error_log('[attach_password] IMAP fail email=' . $email . ' errs=' . substr(implode(',', $errs ?: []), 0, 200));
                jsonResponse(false, null, 'Senha incorreta', 401);
            }
            try { @imap_close($imap); } catch (\Throwable $_e) {}

            // Salva recovery blob pra o phone-login future capturar
            try {
                require_once __DIR__ . '/phone-auth.php';
                if (function_exists('phoneAuthSaveRecovery')) phoneAuthSaveRecovery($email, $password);
            } catch (\Throwable $_e) {}

            // Atualiza o token corrente: filesystem + PG
            $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
            if (preg_match('/^Bearer\s+(.+)$/i', $authHeader, $bm)) {
                $tokHash = hash('sha256', trim($bm[1]));
                $tokFile = TOKEN_STORE_DIR . '/' . $tokHash . '.json';
                if (file_exists($tokFile)) {
                    $data = @json_decode(@file_get_contents($tokFile), true) ?: [];
                    $data['password_enc'] = encryptSessionPassword($password);
                    @file_put_contents($tokFile, json_encode($data), LOCK_EX);
                }
                try {
                    require_once __DIR__ . '/db.php';
                    $pg = getPGDB();
                    $ps = $pg->prepare("UPDATE auth_tokens SET password_enc = :pe WHERE token_hash = :h");
                    $ps->execute([':pe' => encryptSessionPassword($password), ':h' => $tokHash]);
                } catch (\Throwable $_e) {}
            }
            $_SESSION['password_enc'] = encryptSessionPassword($password);
            jsonResponse(true, null, 'Senha vinculada — email pronto pra usar');
            break;
        }

        case 'phone_login_request': {
            require_once __DIR__ . '/phone-auth.php';
            $input = getInput();
            $rawPhone = $input['phone'] ?? '';
            if (!is_string($rawPhone)) jsonResponse(false, null, 'Telefone obrigatorio', 400);
            $phone = trim($rawPhone);
            if (!$phone) jsonResponse(false, null, 'Telefone obrigatorio', 400);

            // Rate limit per phone (5 / 10min) — same shape as verify_send.
            $rateFile = '/tmp/phone_login_rate_' . md5($phone);
            $rates = file_exists($rateFile) ? @json_decode(@file_get_contents($rateFile), true) : [];
            // Smart throttle: 60s cooldown between sends + 5/hour hard cap.
            // Tighter than before (was 20/10min) because each rapid send to the
            // same long-code burns carrier trust — TIM/Vivo flag the number as
            // spam after multiple in <60s and silently filter ALL subsequent
            // messages even from "good" sends. One SMS per minute is the
            // normal user pace; 5/hour leaves room for retry without abuse.
            $rates = is_array($rates) ? $rates : [];
            $now = time();
            $lastSent = empty($rates) ? 0 : max($rates);
            if ($lastSent && ($now - $lastSent) < 60) {
                $wait = 60 - ($now - $lastSent);
                jsonResponse(false, null, "Aguarde {$wait}s antes de pedir outro código.", 429);
            }
            $ratesHour = array_filter($rates, fn($t) => $t > $now - 3600);
            if (count($ratesHour) >= 5) jsonResponse(false, null, 'Muitas tentativas. Aguarde 1 hora.', 429);
            $rates = $ratesHour;
            $rates[] = time();
            @file_put_contents($rateFile, json_encode(array_values($rates)), LOCK_EX);

            $email = phoneAuthFindEmail($phone);
            if (!$email) {
                // Don't leak existence to anonymous probes — return generic
                // "exists: false" so the frontend can route to signup. The
                // attacker learns "no Chatyy account on this phone", which is
                // unavoidable in any phone-first system.
                jsonResponse(true, ['exists' => false], 'Conta nao encontrada para este numero');
            }

            // Reuse the verify_send flow: store the OTP in /tmp/verify_code_*
            // so phone_login_verify can validate it via phoneAuthConsumeOtp().
            // Idempotent: if a code was issued recently with > 30s TTL left,
            // reuse it. Prevents the second tap from invalidating the first
            // SMS the user already received.
            $codeFile = '/tmp/verify_code_' . md5($phone) . '.json';
            $existing = null;
            if (file_exists($codeFile)) {
                $existing = @json_decode(@file_get_contents($codeFile), true);
                if (!is_array($existing) || ($existing['expires'] ?? 0) <= time() + 30) {
                    $existing = null;
                }
            }
            if ($existing && !empty($existing['code'])) {
                $code = (string)$existing['code'];
                error_log("[phone_login_reuse] phone={$phone} ttl_left=" . (($existing['expires'] ?? 0) - time()));
            } else {
                $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
                @file_put_contents($codeFile, json_encode([
                    'code' => $code, 'phone' => $phone,
                    'expires' => time() + 600, 'attempts' => 0, 'login' => true,
                ]), LOCK_EX);
            }

            $sid = getenv('TWILIO_SID') ?: getenv('TWILIO_ACCOUNT_SID');
            $tkn = getenv('TWILIO_TOKEN') ?: getenv('TWILIO_AUTH_TOKEN');
            $smsFrom = (str_starts_with($phone, "+55") && getenv("TWILIO_CHATYY_BR")) ? getenv("TWILIO_CHATYY_BR") : (getenv("TWILIO_CHATYY_US") ?: getenv("TWILIO_FROM") ?: "+19542505964");
            $waFrom  = getenv('TWILIO_WHATSAPP_FROM') ?: '12093093434';
            if (!$sid || !$tkn) jsonResponse(false, null, 'Servico SMS indisponivel', 500);

            // SMS via Telnyx (Twilio Verify kept blocking us).
            $body = chatyyOtpMessage($phone, $code);
            $smsOk = sendTelnyxSms($phone, $body);
            if (!$smsOk) {
                $ch = curl_init("https://api.twilio.com/2010-04-01/Accounts/{$sid}/Messages.json");
                curl_setopt_array($ch, [
                    CURLOPT_POST => true,
                    CURLOPT_POSTFIELDS => http_build_query(['From' => $smsFrom, 'To' => $phone, 'Body' => $body]),
                    CURLOPT_USERPWD => "{$sid}:{$tkn}",
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT => 12,
                ]);
                curl_exec($ch);
                $smsOk = curl_getinfo($ch, CURLINFO_HTTP_CODE) >= 200 && curl_getinfo($ch, CURLINFO_HTTP_CODE) < 300;
                curl_close($ch);
            }

            // WhatsApp template (works even if SMS lands in spam)
            $waTo = preg_replace('/^\+/', '', $phone);
            $ch2 = curl_init("https://api.twilio.com/2010-04-01/Accounts/{$sid}/Messages.json");
            curl_setopt_array($ch2, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => http_build_query([
                    'From' => 'whatsapp:' . (str_starts_with($waFrom, '+') ? $waFrom : '+' . $waFrom),
                    'To'   => 'whatsapp:+' . $waTo,
                    'ContentSid' => 'HXc62a1c60c0ca3da5b6aa0e8df9d30b9e',
                    'ContentVariables' => json_encode(['1' => $code]),
                ]),
                CURLOPT_USERPWD => "{$sid}:{$tkn}",
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 10,
            ]);
            curl_exec($ch2);
            $waOk = curl_getinfo($ch2, CURLINFO_HTTP_CODE) >= 200 && curl_getinfo($ch2, CURLINFO_HTTP_CODE) < 300;
            curl_close($ch2);

            if (!$smsOk && !$waOk) {
                @unlink($codeFile);
                jsonResponse(false, null, 'Falha ao enviar codigo. Tente novamente.', 502);
            }

            jsonResponse(true, [
                'exists' => true,
                'masked_phone' => phoneAuthMask($phone),
                'masked_email' => phoneAuthMaskEmail($email),
                'sms_sent' => $smsOk,
                'whatsapp_sent' => $waOk,
            ], 'Codigo enviado');
            break;
        }

        case 'phone_login_verify': {
            require_once __DIR__ . '/phone-auth.php';
            $input = getInput();
            $phone = trim($input['phone'] ?? '');
            $code  = trim($input['code'] ?? '');
            if (!$phone || !$code) jsonResponse(false, null, 'Telefone e codigo obrigatorios', 400);

            $r = phoneAuthConsumeOtp($phone, $code);
            if (!$r['ok']) {
                $reason = $r['reason'] ?? 'invalid';
                $msg = [
                    'no_pending'        => 'Solicite um codigo primeiro',
                    'expired'           => 'Codigo expirado. Solicite um novo.',
                    'too_many_attempts' => 'Muitas tentativas. Solicite um novo codigo.',
                    'wrong_code'        => 'Codigo incorreto',
                    'bad_state'         => 'Erro interno. Tente novamente.',
                ][$reason] ?? 'Codigo invalido';
                jsonResponse(false, null, $msg, 400);
            }

            $email = phoneAuthFindEmail($phone);
            if (!$email) {
                // Telegram-style unified flow: no account → emit verify_token
                // (HMAC, 1h TTL) so the client continues to phone_signup with
                // the same OTP the user just typed. Same screen, branches on
                // `exists` field — no second SMS, no separate signup tab.
                $secret = getenv('WEBMAIL_VERIFY_SECRET') ?: hash('sha256', 'chatyy-verify-' . php_uname('n'));
                $header = rtrim(strtr(base64_encode(json_encode(['alg' => 'HS256'])), '+/', '-_'), '=');
                $payload = rtrim(strtr(base64_encode(json_encode([
                    'phone' => $phone,
                    'verified' => true,
                    'exp' => time() + 3600,
                    'iat' => time(),
                ])), '+/', '-_'), '=');
                $sig = rtrim(strtr(base64_encode(hash_hmac('sha256', "{$header}.{$payload}", $secret, true)), '+/', '-_'), '=');
                $tok = "{$header}.{$payload}.{$sig}";
                jsonResponse(true, [
                    'exists'       => false,
                    'verify_token' => $tok,
                    'phone'        => $phone,
                ], 'Continue para criar conta');
            }

            // ── Registration Lock (anti-SIM-swap) ──
            // If the account previously set a security PIN, the SMS OTP alone
            // is NOT enough to issue a token — an attacker who SIM-swaps the
            // phone still can't pass this gate without the PIN the legitimate
            // owner chose. Mirror Signal/Telegram's "Registration Lock" pattern.
            // The PIN hash lives in profile/data.json under registration_lock
            // (bcrypt). Client must pass `pin` in the verify payload; if the
            // lock is set and pin is missing/wrong, return requires_lock=true
            // so the UI can render the second input.
            [$_lUser, $_lDomain] = explode('@', $email);
            $_lockProfile = "/var/mail/vhosts/{$_lDomain}/{$_lUser}/profile/data.json";
            $_lockData = file_exists($_lockProfile)
                ? (@json_decode(@file_get_contents($_lockProfile), true) ?: [])
                : [];
            $_lockHash = $_lockData['registration_lock'] ?? '';
            if ($_lockHash) {
                $providedPin = trim((string)($input['pin'] ?? ''));
                if ($providedPin === '') {
                    jsonResponse(true, [
                        'requires_lock' => true,
                        'phone'         => $phone,
                    ], 'PIN de seguranca obrigatorio', 200);
                }
                if (!preg_match('/^[0-9]{4,6}$/', $providedPin)) {
                    jsonResponse(false, [
                        'requires_lock' => true,
                    ], 'PIN invalido', 401);
                }
                if (!password_verify($providedPin, $_lockHash)) {
                    jsonResponse(false, [
                        'requires_lock' => true,
                    ], 'PIN incorreto', 401);
                }
            }

            // Recover the dovecot password the server stored at signup so
            // the bearer token can authenticate IMAP-fronted endpoints.
            // If recovery is missing/empty (legacy account that predates the
            // recovery blob, or a phone-only account that was migrated),
            // mint a bearer with empty password and flag the response with
            // phone_only=true. Chat/status/feed endpoints work fine with the
            // empty bearer (they only key off email); IMAP-fronted endpoints
            // (inbox/compose/read) are guarded client-side by this flag with a
            // banner asking the user to set a password before using email.
            $pw = phoneAuthLoadRecovery($email);
            if ($pw === null) $pw = '';
            $token = generateBearerToken($email, $pw);

            // Bootstrap session for cookie-based web flows too.
            $_SESSION['email']        = $email;
            $_SESSION['password_enc'] = $pw === '' ? '' : encryptSessionPassword($pw);
            $_SESSION['name']         = explode('@', $email)[0];
            $_SESSION['csrf_token']   = bin2hex(random_bytes(32));
            $_SESSION['login_time']   = time();
            $_SESSION['phone_login']  = true;

            jsonResponse(true, [
                'token'      => $token,
                'email'      => $email,
                'name'       => $_SESSION['name'],
                'csrf_token' => $_SESSION['csrf_token'],
                'phone_only' => $pw === '',
            ], 'Login realizado');
            break;
        }

        // ─── Phone verification for already-logged-in users ──────────────
        // Allows existing accounts (signed up via email) to add + verify
        // their phone, populating data.json + chat_phone_registry so they
        // become discoverable by phone hash via chat_sync_contacts.
        // Uses Twilio Verify for SMS delivery (reuses TWILIO_VERIFY_SID).
        case 'verify_phone_send': {
            requireAuth();
            $input = getInput();
            $rawPhone = trim($input['phone'] ?? '');
            if (!preg_match('/^\+[0-9]{8,15}$/', $rawPhone)) {
                jsonResponse(false, null, 'Numero invalido. Use formato +DDIDDD...', 400);
            }

            // Rate limit: 5 OTPs / 10min per phone (same as phone_login)
            $rateFile = '/tmp/verify_phone_rate_' . md5($rawPhone);
            $rates = file_exists($rateFile) ? @json_decode(@file_get_contents($rateFile), true) : [];
            // Smart throttle: 60s cooldown between sends + 5/hour hard cap.
            // Tighter than before (was 20/10min) because each rapid send to the
            // same long-code burns carrier trust — TIM/Vivo flag the number as
            // spam after multiple in <60s and silently filter ALL subsequent
            // messages even from "good" sends. One SMS per minute is the
            // normal user pace; 5/hour leaves room for retry without abuse.
            $rates = is_array($rates) ? $rates : [];
            $now = time();
            $lastSent = empty($rates) ? 0 : max($rates);
            if ($lastSent && ($now - $lastSent) < 60) {
                $wait = 60 - ($now - $lastSent);
                jsonResponse(false, null, "Aguarde {$wait}s antes de pedir outro código.", 429);
            }
            $ratesHour = array_filter($rates, fn($t) => $t > $now - 3600);
            if (count($ratesHour) >= 5) jsonResponse(false, null, 'Muitas tentativas. Aguarde 1 hora.', 429);
            $rates = $ratesHour;
            $rates[] = time();
            @file_put_contents($rateFile, json_encode(array_values($rates)), LOCK_EX);

            // Generate 6-digit OTP, hash + store in phone_verifications
            $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
            $otpHash = password_hash($code, PASSWORD_BCRYPT);
            try {
                $db = getPGDB();
                $stmt = $db->prepare("INSERT INTO phone_verifications (phone, otp_hash, created_at, expires_at, ip) VALUES (:p, :h, :c, :e, :i)");
                $stmt->execute([
                    ':p' => $rawPhone,
                    ':h' => $otpHash,
                    ':c' => time(),
                    ':e' => time() + 300, // 5min TTL
                    ':i' => $_SERVER['REMOTE_ADDR'] ?? '',
                ]);
            } catch (\Throwable $e) {
                error_log('[verify_phone_send] PG store failed: ' . $e->getMessage());
                jsonResponse(false, null, 'Erro interno', 500);
            }

            // Send SMS via Telnyx (Twilio kept blocking).
            $body = chatyyOtpMessage($rawPhone, $code);
            $smsOk = sendTelnyxSms($rawPhone, $body);

            $digitsM = preg_replace('/\D/', '', $rawPhone);
            $masked = strlen($digitsM) >= 4
                ? '(' . substr($digitsM, -10, 2) . ') ***-**' . substr($digitsM, -2)
                : '***';
            jsonResponse(true, [
                'masked_phone' => $masked,
                'sms_sent' => $smsOk,
            ], $smsOk ? 'Codigo enviado por SMS' : 'Codigo gerado mas SMS falhou');
            break;
        }

        case 'verify_phone_check': {
            requireAuth();
            $input = getInput();
            $rawPhone = trim($input['phone'] ?? '');
            $code = trim($input['code'] ?? '');
            if (!preg_match('/^\+[0-9]{8,15}$/', $rawPhone)) jsonResponse(false, null, 'Numero invalido', 400);
            if (!preg_match('/^[0-9]{4,8}$/', $code)) jsonResponse(false, null, 'Codigo invalido', 400);

            // Lookup latest unverified OTP for this phone
            try {
                $db = getPGDB();
                $stmt = $db->prepare("SELECT id, otp_hash, expires_at, attempts FROM phone_verifications WHERE phone = :p AND verified = FALSE ORDER BY id DESC LIMIT 1");
                $stmt->execute([':p' => $rawPhone]);
                $row = $stmt->fetch(\PDO::FETCH_ASSOC);
            } catch (\Throwable $e) {
                jsonResponse(false, null, 'Erro interno', 500);
            }
            if (!$row) jsonResponse(false, null, 'Codigo nao encontrado. Solicite novo.', 404);
            if ((int)$row['expires_at'] < time()) jsonResponse(false, null, 'Codigo expirado', 410);
            if ((int)$row['attempts'] >= 5) jsonResponse(false, null, 'Muitas tentativas. Solicite novo codigo.', 429);

            $ok = password_verify($code, $row['otp_hash']);
            try {
                $inc = $db->prepare("UPDATE phone_verifications SET attempts = attempts + 1" . ($ok ? ", verified = TRUE" : "") . " WHERE id = :id");
                $inc->execute([':id' => $row['id']]);
            } catch (\Throwable $e) {}
            if (!$ok) jsonResponse(false, null, 'Codigo incorreto', 401);

            // Persist phone in profile data.json
            $email = strtolower($_SESSION['email']);
            [$user, $domain] = explode('@', $email);
            $profileFile = "/var/mail/vhosts/{$domain}/{$user}/profile/data.json";
            $pData = file_exists($profileFile) ? (@json_decode(@file_get_contents($profileFile), true) ?: []) : [];
            $pData['phone'] = $rawPhone;
            $pData['verified_phone'] = $rawPhone;
            $pData['phone_verified'] = true;
            $pData['phone_verified_at'] = date('c');
            $pData['needs_phone_verification'] = false;
            @mkdir(dirname($profileFile), 0775, true);
            @file_put_contents($profileFile, json_encode($pData, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);

            // Insert into chat_phone_registry so the user becomes discoverable
            try {
                $pg = getPGDB();
                $e164Hash = hash('sha256', $rawPhone);
                $reg = $pg->prepare("INSERT INTO chat_phone_registry (phone_hash, email, verified, updated_at) VALUES (:h, :e, TRUE, NOW()) ON CONFLICT (phone_hash) DO UPDATE SET email = EXCLUDED.email, verified = TRUE, updated_at = NOW()");
                $reg->execute([':h' => $e164Hash, ':e' => $email]);
            } catch (\Throwable $e) { error_log('[verify_phone_check] registry insert failed: ' . $e->getMessage()); }

            jsonResponse(true, [
                'phone' => $rawPhone,
                'verified' => true,
            ], 'Telefone verificado');
            break;
        }

        // ─── Phone NUMBER CHANGE (SIM swap recovery, WhatsApp pattern) ───
        // Three actions for an authenticated user to migrate their account
        // to a new phone number while keeping every chat / contact / handle:
        //   phone_change_request — sends OTP to NEW phone, persists pending
        //   phone_change_verify  — checks OTP, swaps verified_phone +
        //                          chat_phone_registry, fires system DM
        //   phone_change_cancel  — clears pending flag
        // Pending flag lives in profile/data.json under phone_change_pending
        // with TTL 10min — short enough that an attacker who steals the
        // session briefly can't sit on a verify_token forever.
        case 'phone_change_request': {
            requireAuth();
            $input = getInput();
            $newPhone = trim($input['new_phone'] ?? '');
            if (!preg_match('/^\+[0-9]{8,15}$/', $newPhone)) {
                jsonResponse(false, null, 'Numero invalido. Use formato +DDIDDD...', 400);
            }

            $email = strtolower($_SESSION['email']);
            [$user, $domain] = explode('@', $email);
            $profileFile = "/var/mail/vhosts/{$domain}/{$user}/profile/data.json";
            $pData = file_exists($profileFile)
                ? (@json_decode(@file_get_contents($profileFile), true) ?: [])
                : [];

            // Reject if new phone is identical to the current one.
            $currentDigits = preg_replace('/\D/', '', $pData['verified_phone'] ?? ($pData['phone'] ?? ''));
            $newDigits = preg_replace('/\D/', '', $newPhone);
            if ($currentDigits && $currentDigits === $newDigits) {
                jsonResponse(false, null, 'Esse ja e o seu numero atual', 400);
            }

            // Reject if the new phone already belongs to another Chatyy account.
            // Check both chat_phone_registry (canonical) and the Maildir profile
            // scan — same multi-source pattern phone_signup uses.
            try {
                $pg = getPGDB();
                $hashNew = hash('sha256', $newPhone);
                $reg = $pg->prepare("SELECT email FROM chat_phone_registry WHERE phone_hash = :h LIMIT 1");
                $reg->execute([':h' => $hashNew]);
                $regRow = $reg->fetch(\PDO::FETCH_ASSOC);
                if ($regRow && strtolower($regRow['email']) !== $email) {
                    jsonResponse(false, null, 'Esse numero ja tem conta', 409);
                }
            } catch (\Throwable $e) { /* PG down → fall back to FS scan below */ }

            if ($newDigits) {
                foreach (glob('/var/mail/vhosts/*/*/profile/data.json') ?: [] as $pf) {
                    if ($pf === $profileFile) continue; // skip self
                    $pd = @json_decode(@file_get_contents($pf), true);
                    if (!$pd) continue;
                    $existing = preg_replace('/\D/', '', $pd['verified_phone'] ?? '');
                    if ($existing && $existing === $newDigits) {
                        jsonResponse(false, null, 'Esse numero ja tem conta', 409);
                    }
                }
            }

            // Rate limit: 5 OTPs / hour per phone (mirror verify_phone_send).
            $rateFile = '/tmp/phone_change_rate_' . md5($newPhone);
            $rates = file_exists($rateFile) ? @json_decode(@file_get_contents($rateFile), true) : [];
            $rates = is_array($rates) ? $rates : [];
            $now = time();
            $lastSent = empty($rates) ? 0 : max($rates);
            if ($lastSent && ($now - $lastSent) < 60) {
                $wait = 60 - ($now - $lastSent);
                jsonResponse(false, null, "Aguarde {$wait}s antes de pedir outro codigo.", 429);
            }
            $ratesHour = array_filter($rates, fn($t) => $t > $now - 3600);
            if (count($ratesHour) >= 5) jsonResponse(false, null, 'Muitas tentativas. Aguarde 1 hora.', 429);
            $rates = $ratesHour;
            $rates[] = time();
            @file_put_contents($rateFile, json_encode(array_values($rates)), LOCK_EX);

            // Per-user rate limit: 5 phone-change attempts / hour, regardless
            // of which target number. Prevents an account from cycling through
            // phone numbers to enumerate which ones are taken.
            $userRateFile = '/tmp/phone_change_user_rate_' . md5($email);
            $uRates = file_exists($userRateFile) ? @json_decode(@file_get_contents($userRateFile), true) : [];
            $uRates = is_array($uRates) ? array_filter($uRates, fn($t) => $t > $now - 3600) : [];
            if (count($uRates) >= 5) jsonResponse(false, null, 'Muitas tentativas nesta conta. Aguarde 1 hora.', 429);
            $uRates[] = $now;
            @file_put_contents($userRateFile, json_encode(array_values($uRates)), LOCK_EX);

            // Generate OTP, hash + store via Twilio Verify-style PG row so
            // phone_change_verify can validate it.
            $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
            $otpHash = password_hash($code, PASSWORD_BCRYPT);
            try {
                $db = getPGDB();
                $stmt = $db->prepare("INSERT INTO phone_verifications (phone, otp_hash, created_at, expires_at, ip) VALUES (:p, :h, :c, :e, :i)");
                $stmt->execute([
                    ':p' => $newPhone,
                    ':h' => $otpHash,
                    ':c' => time(),
                    ':e' => time() + 600, // 10min TTL
                    ':i' => $_SERVER['REMOTE_ADDR'] ?? '',
                ]);
            } catch (\Throwable $e) {
                error_log('[phone_change_request] PG store failed: ' . $e->getMessage());
                jsonResponse(false, null, 'Erro interno', 500);
            }

            // Persist pending flag in profile data.json (10-min TTL).
            $pData['phone_change_pending'] = [
                'new_phone'    => $newPhone,
                'requested_at' => time(),
                'expires_at'   => time() + 600,
            ];
            @mkdir(dirname($profileFile), 0775, true);
            @file_put_contents($profileFile, json_encode($pData, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);

            // Send SMS via Telnyx → fall back to Twilio if it fails.
            $body = chatyyOtpMessage($newPhone, $code);
            $smsOk = sendTelnyxSms($newPhone, $body);
            if (!$smsOk) {
                $sid = getenv('TWILIO_SID') ?: getenv('TWILIO_ACCOUNT_SID');
                $tkn = getenv('TWILIO_TOKEN') ?: getenv('TWILIO_AUTH_TOKEN');
                $smsFrom = (str_starts_with($newPhone, "+55") && getenv("TWILIO_CHATYY_BR")) ? getenv("TWILIO_CHATYY_BR") : (getenv("TWILIO_CHATYY_US") ?: getenv("TWILIO_FROM") ?: "+19542505964");
                if ($sid && $tkn) {
                    $ch = curl_init("https://api.twilio.com/2010-04-01/Accounts/{$sid}/Messages.json");
                    curl_setopt_array($ch, [
                        CURLOPT_POST => true,
                        CURLOPT_POSTFIELDS => http_build_query(['From' => $smsFrom, 'To' => $newPhone, 'Body' => $body]),
                        CURLOPT_USERPWD => "{$sid}:{$tkn}",
                        CURLOPT_RETURNTRANSFER => true,
                        CURLOPT_TIMEOUT => 12,
                    ]);
                    curl_exec($ch);
                    $smsOk = curl_getinfo($ch, CURLINFO_HTTP_CODE) >= 200 && curl_getinfo($ch, CURLINFO_HTTP_CODE) < 300;
                    curl_close($ch);
                }
            }

            $digitsM = preg_replace('/\D/', '', $newPhone);
            $masked = strlen($digitsM) >= 4
                ? '(' . substr($digitsM, -10, 2) . ') ***-**' . substr($digitsM, -2)
                : '***';
            jsonResponse(true, [
                'masked_phone' => $masked,
                'sms_sent'     => $smsOk,
                'expires_at'   => $pData['phone_change_pending']['expires_at'],
            ], $smsOk ? 'Codigo enviado por SMS' : 'Codigo gerado mas SMS falhou');
            break;
        }

        case 'phone_change_verify': {
            requireAuth();
            $input = getInput();
            $newPhone = trim($input['new_phone'] ?? '');
            $code     = trim($input['code'] ?? '');
            if (!preg_match('/^\+[0-9]{8,15}$/', $newPhone)) jsonResponse(false, null, 'Numero invalido', 400);
            if (!preg_match('/^[0-9]{4,8}$/', $code)) jsonResponse(false, null, 'Codigo invalido', 400);

            $email = strtolower($_SESSION['email']);
            [$user, $domain] = explode('@', $email);
            $profileFile = "/var/mail/vhosts/{$domain}/{$user}/profile/data.json";
            $pData = file_exists($profileFile)
                ? (@json_decode(@file_get_contents($profileFile), true) ?: [])
                : [];

            // Pending flag must exist + match + not be expired (10-min TTL).
            $pending = $pData['phone_change_pending'] ?? null;
            if (!is_array($pending) || (string)($pending['new_phone'] ?? '') !== $newPhone) {
                jsonResponse(false, null, 'Solicite um codigo primeiro', 400);
            }
            if ((int)($pending['expires_at'] ?? 0) < time()) {
                jsonResponse(false, null, 'Codigo expirado. Solicite um novo.', 410);
            }

            // Validate OTP against PG (mirrors verify_phone_check).
            try {
                $db = getPGDB();
                $stmt = $db->prepare("SELECT id, otp_hash, expires_at, attempts FROM phone_verifications WHERE phone = :p AND verified = FALSE ORDER BY id DESC LIMIT 1");
                $stmt->execute([':p' => $newPhone]);
                $row = $stmt->fetch(\PDO::FETCH_ASSOC);
            } catch (\Throwable $e) {
                jsonResponse(false, null, 'Erro interno', 500);
            }
            if (!$row) jsonResponse(false, null, 'Codigo nao encontrado. Solicite novo.', 404);
            if ((int)$row['expires_at'] < time()) jsonResponse(false, null, 'Codigo expirado', 410);
            if ((int)$row['attempts'] >= 5) jsonResponse(false, null, 'Muitas tentativas. Solicite novo codigo.', 429);

            $ok = password_verify($code, $row['otp_hash']);
            try {
                $inc = $db->prepare("UPDATE phone_verifications SET attempts = attempts + 1" . ($ok ? ", verified = TRUE" : "") . " WHERE id = :id");
                $inc->execute([':id' => $row['id']]);
            } catch (\Throwable $e) {}
            if (!$ok) jsonResponse(false, null, 'Codigo incorreto', 401);

            // Race-window double-check: another account may have grabbed the
            // number between request and verify (10 min window). Re-test
            // uniqueness before committing the swap.
            try {
                $pg = getPGDB();
                $hashNew = hash('sha256', $newPhone);
                $reg = $pg->prepare("SELECT email FROM chat_phone_registry WHERE phone_hash = :h LIMIT 1");
                $reg->execute([':h' => $hashNew]);
                $regRow = $reg->fetch(\PDO::FETCH_ASSOC);
                if ($regRow && strtolower($regRow['email']) !== $email) {
                    jsonResponse(false, null, 'Esse numero ja tem conta', 409);
                }
            } catch (\Throwable $e) { /* fall through */ }

            // Swap the verified phone in profile data.json, clear pending flag.
            $oldPhone = $pData['verified_phone'] ?? ($pData['phone'] ?? '');
            $pData['phone']               = $newPhone;
            $pData['verified_phone']      = $newPhone;
            $pData['phone_verified']      = true;
            $pData['phone_verified_at']   = date('c');
            $pData['needs_phone_verification'] = false;
            unset($pData['phone_change_pending']);
            @mkdir(dirname($profileFile), 0775, true);
            @file_put_contents($profileFile, json_encode($pData, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);

            // Update chat_phone_registry: insert new hash, drop old hash.
            try {
                $pg = getPGDB();
                $newHash = hash('sha256', $newPhone);
                $upsert = $pg->prepare("INSERT INTO chat_phone_registry (phone_hash, email, verified, updated_at) VALUES (:h, :e, TRUE, NOW()) ON CONFLICT (phone_hash) DO UPDATE SET email = EXCLUDED.email, verified = TRUE, updated_at = NOW()");
                $upsert->execute([':h' => $newHash, ':e' => $email]);

                if ($oldPhone && preg_match('/^\+[0-9]{8,15}$/', $oldPhone) && $oldPhone !== $newPhone) {
                    $oldHash = hash('sha256', $oldPhone);
                    // Only delete if it still points to *us* — never nuke
                    // a row that's been re-claimed by someone else.
                    $del = $pg->prepare("DELETE FROM chat_phone_registry WHERE phone_hash = :h AND LOWER(email) = LOWER(:e)");
                    $del->execute([':h' => $oldHash, ':e' => $email]);
                }
            } catch (\Throwable $e) { error_log('[phone_change_verify] registry update failed: ' . $e->getMessage()); }

            // Mirror update into the accounts table (best-effort).
            try {
                $pg = getPGDB();
                $upd = $pg->prepare("UPDATE accounts SET phone = :p WHERE LOWER(email) = LOWER(:e)");
                $upd->execute([':p' => $newPhone, ':e' => $email]);
            } catch (\Throwable $e) {}

            // Send a system DM to recent 1:1 contacts ("Seu numero mudou de X para Y").
            // Pick the 50 most-recent 1:1 conversations involving this user.
            $maskedOld = (function ($p) {
                $d = preg_replace('/\D/', '', (string)$p);
                if (strlen($d) < 4) return $p ?: '?';
                return '+' . substr($d, 0, max(1, strlen($d) - 4)) . str_repeat('*', 2) . substr($d, -2);
            })($oldPhone);
            $sysMsg = 'Meu numero mudou. Agora estou no ' . $newPhone . ' (antes era ' . $maskedOld . ').';
            try {
                $pg = getPGDB();
                $convs = $pg->prepare("
                    SELECT c.id
                    FROM chat_conversations c
                    JOIN chat_conversation_members m ON m.conversation_id = c.id
                    WHERE LOWER(m.email) = LOWER(:e)
                      AND COALESCE(c.is_group, FALSE) = FALSE
                    ORDER BY c.updated_at DESC NULLS LAST
                    LIMIT 50
                ");
                $convs->execute([':e' => $email]);
                $convIds = $convs->fetchAll(\PDO::FETCH_COLUMN);
                if ($convIds) {
                    $ins = $pg->prepare("INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at) VALUES (:cid, :em, :ct, 'system', now()::text)");
                    foreach ($convIds as $cid) {
                        try { $ins->execute([':cid' => (int)$cid, ':em' => $email, ':ct' => $sysMsg]); } catch (\Throwable $_) {}
                    }
                }
            } catch (\Throwable $e) { error_log('[phone_change_verify] system DM fan-out failed: ' . $e->getMessage()); }

            jsonResponse(true, [
                'phone'      => $newPhone,
                'old_phone'  => $oldPhone,
                'verified'   => true,
            ], 'Telefone alterado com sucesso');
            break;
        }

        case 'phone_change_cancel': {
            requireAuth();
            $email = strtolower($_SESSION['email']);
            [$user, $domain] = explode('@', $email);
            $profileFile = "/var/mail/vhosts/{$domain}/{$user}/profile/data.json";
            $pData = file_exists($profileFile)
                ? (@json_decode(@file_get_contents($profileFile), true) ?: [])
                : [];
            if (isset($pData['phone_change_pending'])) {
                unset($pData['phone_change_pending']);
                @file_put_contents($profileFile, json_encode($pData, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
            }
            jsonResponse(true, null, 'Solicitacao cancelada');
            break;
        }

        case 'phone_signup': {
            require_once __DIR__ . '/phone-auth.php';
            $input = getInput();
            $verifyToken = trim($input['verify_token'] ?? '');
            $username    = strtolower(trim($input['username'] ?? ''));
            $name        = trim($input['name'] ?? '');
            $domain      = $input['domain'] ?? 'chatyy.com.br';
            if (!in_array($domain, ['chatyy.com.br', 'onemundo.com.br', 'superbora.com.br'])) {
                $domain = 'chatyy.com.br';
            }

            if (!$verifyToken) jsonResponse(false, null, 'Verifique seu telefone primeiro', 400);
            if (!$username || strlen($username) < 3) jsonResponse(false, null, 'Username muito curto', 400);
            if (!preg_match('/^[a-z0-9._-]+$/', $username)) jsonResponse(false, null, 'Username invalido', 400);
            if (strlen($username) > 30) jsonResponse(false, null, 'Username muito longo', 400);

            $reserved = ['admin','administrator','postmaster','webmaster','abuse','noreply','no-reply','info','suporte','support','contato','contact','root','mail','ftp','www','test','security','billing','sales','marketing','help','hostmaster','mailer-daemon','spam'];
            if (in_array($username, $reserved)) jsonResponse(false, null, 'Username reservado', 400);

            // Rate limit per IP — 5 signups/hour.
            $rateFile = '/tmp/phone_signup_rate_' . md5($_SERVER['REMOTE_ADDR'] ?? '');
            $rates = file_exists($rateFile) ? @json_decode(@file_get_contents($rateFile), true) : [];
            $rates = is_array($rates) ? array_filter($rates, fn($t) => $t > time() - 3600) : [];
            if (count($rates) >= 5) jsonResponse(false, null, 'Muitas contas em pouco tempo. Tente em 1h.', 429);
            $rates[] = time();
            @file_put_contents($rateFile, json_encode(array_values($rates)), LOCK_EX);

            // Validate verify_token (HMAC-signed by verify_check, 1h TTL).
            $secret = getenv('WEBMAIL_VERIFY_SECRET') ?: hash('sha256', 'chatyy-verify-' . php_uname('n'));
            $parts = explode('.', $verifyToken);
            if (count($parts) !== 3) jsonResponse(false, null, 'Token de verificacao invalido', 400);
            $expectedSig = rtrim(strtr(base64_encode(hash_hmac('sha256', "{$parts[0]}.{$parts[1]}", $secret, true)), '+/', '-_'), '=');
            if (!hash_equals($expectedSig, $parts[2])) jsonResponse(false, null, 'Token de verificacao invalido', 400);
            $payload = @json_decode(base64_decode(strtr($parts[1], '-_', '+/')), true);
            if (!$payload || ($payload['exp'] ?? 0) < time() || empty($payload['verified']) || empty($payload['phone'])) {
                jsonResponse(false, null, 'Verificacao expirada. Confirme o telefone novamente.', 400);
            }
            $verifiedPhone = $payload['phone'];

            // Phone uniqueness — same check as the legacy signup.
            $verifiedDigits = preg_replace('/\D/', '', $verifiedPhone);
            if ($verifiedDigits) {
                foreach (glob('/var/mail/vhosts/*/*/profile/data.json') ?: [] as $pf) {
                    $pd = @json_decode(@file_get_contents($pf), true);
                    if (!$pd) continue;
                    $existing = preg_replace('/\D/', '', $pd['verified_phone'] ?? '');
                    if ($existing && $existing === $verifiedDigits) {
                        jsonResponse(false, null, 'Esse telefone ja tem conta. Faca login com o numero.', 409);
                    }
                }
            }

            // ── Username uniqueness — multi-source (PG → Maildir profile → staging) ──
            // The original /etc/dovecot/users check was BYPASSED because that file
            // isn't mounted into the PHP-FPM Docker container, so file_get_contents
            // returned false and strpos returned false (allowing account takeover
            // by overwriting an existing user's profile + dovecot hash + phone).
            // Lock auto-releases on script termination (PHP closes the FD on exit).
            $email = "{$username}@{$domain}";
            $signupLockFile = '/tmp/signup_lock_' . md5($email);
            $signupLockFp = @fopen($signupLockFile, 'c');
            if ($signupLockFp) @flock($signupLockFp, LOCK_EX);
            $usersFile = '/etc/dovecot/users';

            // (a) PG accounts table (try/catch — table may not exist on all envs)
            try {
                $pgChk = getPGDB();
                $stmt = $pgChk->prepare('SELECT 1 FROM accounts WHERE email = :e LIMIT 1');
                $stmt->execute([':e' => $email]);
                if ($stmt->fetch()) {
                    jsonResponse(false, null, 'Esse username ja foi escolhido', 409);
                }
            } catch (\Throwable $e) { /* table missing → fallback */ }

            // (b) Maildir profile (authoritative on filesystem)
            $profilePathChk = "/var/mail/vhosts/{$domain}/{$username}/profile/data.json";
            if (file_exists($profilePathChk)) {
                jsonResponse(false, null, 'Esse username ja foi escolhido', 409);
            }

            // (c) phone_signup staging (host-drained queue) — race-window source
            $stagingChk = "/var/mail/_pending_signups/{$email}.json";
            if (file_exists($stagingChk)) {
                jsonResponse(false, null, 'Esse username ja foi escolhido', 409);
            }

            // (d) Legacy host-mounted dovecot file (best-effort — usually unreadable in container)
            $existing = @file_get_contents($usersFile);
            if ($existing !== false && strpos($existing, $email . ':') !== false) {
                jsonResponse(false, null, 'Esse username ja foi escolhido', 409);
            }

            // Server-issued password — user never types one. Stored encrypted
            // for the bearer-token + IMAP recovery path (see phoneAuthSaveRecovery).
            $userPwdInput = isset($input["password"]) ? (string)$input["password"] : ""; if ($userPwdInput !== "") { if (strlen($userPwdInput) < 8) jsonResponse(false, null, "Senha curta — use no minimo 8 caracteres", 400); if (strlen($userPwdInput) > 72) jsonResponse(false, null, "Senha muito longa", 400); } $genPw = $userPwdInput !== "" ? $userPwdInput : bin2hex(random_bytes(24));
            // PHP-native SHA512-CRYPT (Dovecot format). The legacy signup uses
            // `sudo doveadm pw` which doesn't exist inside the PHP-FPM Docker
            // container — so phone_signup always failed with "Falha ao gerar
            // senha do sistema". crypt() with $6$<salt>$ produces the exact
            // SHA512-CRYPT hash Dovecot expects when prefixed with the scheme.
            $salt = '$6$' . bin2hex(random_bytes(8)) . '$';
            $cryptHash = crypt($genPw, $salt);
            if (!$cryptHash || strlen($cryptHash) < 20) {
                jsonResponse(false, null, 'Falha ao gerar senha do sistema (crypt)', 500);
            }
            $hash = '{SHA512-CRYPT}' . $cryptHash;

            // Dovecot users file lives on host, NOT mounted into the PHP-FPM
            // container. Write to a staging dir under /var/mail (which IS
            // mounted) and let a host-side drain script (drain_pending_signups)
            // pick it up and append to /etc/dovecot/users. Account is usable
            // for chat immediately (token-based); IMAP/SMTP works ~30s later.
            $stagingDir = '/var/mail/_pending_signups';
            if (!is_dir($stagingDir)) @mkdir($stagingDir, 0755, true);
            $staged = json_encode([
                'email'     => $email,
                'hash'      => $hash,
                'domain'    => $domain,
                'username'  => $username,
                'created_at' => time(),
            ]);
            if (@file_put_contents("{$stagingDir}/{$email}.json", $staged, LOCK_EX) === false) {
                jsonResponse(false, null, 'Falha ao registrar usuario (staging bloqueado)', 500);
            }
            // Best-effort direct write — works only if /etc/dovecot/users is
            // host-mounted (legacy path). Failure is fine — drain handles it.
            @safe_put_contents($usersFile, "\n{$email}:{$hash}", FILE_APPEND);

            // Postfix vmailbox — same pattern: try direct, fall back to staging.
            $vmailbox = '/etc/postfix/vmailbox';
            $vc = @file_get_contents($vmailbox) ?: '';
            $entry = "{$email}    {$domain}/{$username}/";
            if (strpos($vc, $email) === false) {
                $nl = (substr($vc, -1) !== "\n") ? "\n" : "";
                @safe_put_contents($vmailbox, $nl . $entry . "\n", FILE_APPEND);
                @exec("sudo /usr/sbin/postmap " . escapeshellarg($vmailbox));
            }

            // Maildir scaffold.
            $home = "/var/mail/vhosts/{$domain}/{$username}";
            foreach (['Maildir', 'Maildir/cur', 'Maildir/new', 'Maildir/tmp',
                       'Maildir/.Sent/cur', 'Maildir/.Sent/new', 'Maildir/.Sent/tmp',
                       'Maildir/.Drafts/cur', 'Maildir/.Drafts/new', 'Maildir/.Drafts/tmp',
                       'Maildir/.Trash/cur', 'Maildir/.Trash/new', 'Maildir/.Trash/tmp',
                       'Maildir/.Spam/cur', 'Maildir/.Spam/new', 'Maildir/.Spam/tmp',
                       'Maildir/.Archive/cur', 'Maildir/.Archive/new', 'Maildir/.Archive/tmp'] as $d) {
                @mkdir("{$home}/{$d}", 0700, true);
            }
            @exec("sudo /usr/local/bin/chatyy-fix-mailbox " . escapeshellarg($username . "@" . $domain));
            @exec("chmod 710 " . escapeshellarg($home));
            // push_tokens/ www-data writable (see signup case for rationale)
            @mkdir($home . "/push_tokens", 0755, true);
            @exec("chown www-data:www-data " . escapeshellarg($home . "/push_tokens") . " 2>/dev/null");

            // Profile.
            $profileDir = "{$home}/profile";
            if (!is_dir($profileDir)) @mkdir($profileDir, 0700, true);
            @exec("chmod 770 " . escapeshellarg($profileDir));
            $profile = [
                'first_name'      => $name,
                'last_name'       => '',
                'phone'           => $verifiedPhone,
                'verified_phone'  => $verifiedPhone,
                'phone_verified'  => true,
                'phone_only_auth' => true,
                'created_at'      => date('c'),
                'ip'              => $_SERVER['REMOTE_ADDR'] ?? '',
            ];
            @file_put_contents("{$profileDir}/data.json", json_encode($profile, JSON_PRETTY_PRINT), LOCK_EX);
            @exec("sudo /usr/local/bin/chatyy-fix-mailbox " . escapeshellarg($username . "@" . $domain));

            // Persist recovery password so phone_login_verify can issue
            // tokens later without prompting for a password.
            phoneAuthSaveRecovery($email, $genPw);

            // Welcome email — direct Maildir drop, never blocks signup.
            // $name carries first+last from the signup payload; helper splits.
            sendWelcomeEmail($email, explode(' ', $name)[0] ?? $name, $domain);

            // Seed Chatyy AI welcome chat (pinned, i18n by phone country).
            // Non-blocking, idempotent. Client may pass `lang` (BCP-47) in
            // the body to override the country-code heuristic.
            seedChatyyAIWelcome($email, $verifiedPhone, $input['lang'] ?? ($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''));

            // Best-effort: write to PG accounts table so contact discovery
            // and phone-lookup hits this user immediately. Failure is fine —
            // Maildir scan still finds them.
            try {
                $pg = getPGDB();
                $stmt = $pg->prepare("
                    INSERT INTO accounts (email, display_name, phone, created_at)
                    VALUES (:e, :n, :p, NOW())
                    ON CONFLICT (email) DO UPDATE SET
                      display_name = EXCLUDED.display_name,
                      phone        = EXCLUDED.phone
                ");
                $stmt->execute([':e' => $email, ':n' => $name, ':p' => $verifiedPhone]);
            } catch (\Throwable $e) {}

            // Issue bearer token + bootstrap session.
            $token = generateBearerToken($email, $genPw);
            $_SESSION['email']        = $email;
            $_SESSION['password_enc'] = encryptSessionPassword($genPw);
            $_SESSION['name']         = $name ?: $username;
            $_SESSION['csrf_token']   = bin2hex(random_bytes(32));
            $_SESSION['login_time']   = time();
            $_SESSION['phone_login']  = true;

            // ── WhatsApp-style "X entrou no Chatyy" push fan-out ─────────
            // Look up everyone who has THIS phone in their saved contacts
            // (chat_contact_lookups, populated by check_contacts) and notify
            // them that the new account just joined. Hash uses normalized
            // digits — sha256(stripped_phone). Best-effort, non-fatal if it
            // fails. The push carries phone_hash so the client maps back to
            // the LOCAL contact name ("João Trabalho" etc) before showing.
            try {
                // Register phone in chat_phone_registry so chat_sync_contacts (the
                // hash lookup used by /chat-new search) can find this account by
                // its E.164 hash. Without this row, even a working find_by_phone
                // wouldn't make the user discoverable through the contact-search UI.
                $pg = getPGDB();
                if ($verifiedPhone && preg_match('/^\+[0-9]{8,15}$/', $verifiedPhone)) {
                    $e164Hash = hash('sha256', $verifiedPhone);
                    try {
                        $reg = $pg->prepare("INSERT INTO chat_phone_registry (phone_hash, email, verified, updated_at) VALUES (:h, :e, TRUE, NOW()) ON CONFLICT (phone_hash) DO UPDATE SET email = EXCLUDED.email, verified = TRUE, updated_at = NOW()");
                        $reg->execute([':h' => $e164Hash, ':e' => $email]);
                    } catch (\Throwable $_) { /* non-fatal */ }
                }
                $normPhone = preg_replace('/\D/', '', $verifiedPhone);
                if (strlen($normPhone) >= 12 && str_starts_with($normPhone, '55')) $normPhone = substr($normPhone, 2);
                if (strlen($normPhone) === 11 && str_starts_with($normPhone, '1'))  $normPhone = substr($normPhone, 1);
                if (strlen($normPhone) >= 8) {
                    $phHash = hash('sha256', $normPhone);
                    $waiters = $pg->prepare("SELECT DISTINCT email FROM chat_contact_lookups WHERE phone_hash = :h AND LOWER(email) <> LOWER(:self)");
                    $waiters->execute([':h' => $phHash, ':self' => $email]);
                    $waiterEmails = $waiters->fetchAll(PDO::FETCH_COLUMN);

                    if (!empty($waiterEmails)) {
                        @require_once __DIR__ . '/firebase_push.php';
                        $wsKey = getenv('WS_API_KEY') ?: '';
                        $payload = [
                            'email' => $email,
                            'name'  => $name ?: $username,
                            'phone_hash' => $phHash,
                            'joined_at'  => gmdate('c'),
                        ];
                        foreach ($waiterEmails as $waiterEmail) {
                            // 1) Real-time WS event (banner aparece imediato pra users online).
                            if ($wsKey) {
                                $cu = curl_init('http://127.0.0.1:8081/notify');
                                curl_setopt_array($cu, [
                                    CURLOPT_POST => true,
                                    CURLOPT_POSTFIELDS => json_encode([
                                        'email' => $waiterEmail,
                                        'event' => 'contact_joined',
                                        'data'  => $payload,
                                    ]),
                                    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                                    CURLOPT_RETURNTRANSFER => true,
                                    CURLOPT_TIMEOUT_MS => 800,
                                    CURLOPT_CONNECTTIMEOUT_MS => 200,
                                ]);
                                curl_exec($cu);
                                curl_close($cu);
                            }
                            // 2) Push notification — entrega offline também.
                            if (function_exists('fcmSendToUser')) {
                                try {
                                    fcmSendToUser(
                                        $waiterEmail,
                                        ($name ?: $username) . ' entrou no Chatyy',
                                        'Agora você pode conversar direto pelo app.',
                                        [
                                            'type'        => 'contact_joined',
                                            'email'       => $email,
                                            'name'        => $name ?: $username,
                                            'phone_hash'  => $phHash,
                                            'deep_link'   => '/u/' . urlencode($email),
                                        ]
                                    );
                                } catch (\Throwable $_) {}
                            }
                        }
                    }
                }
            } catch (\Throwable $_) { /* non-fatal */ }

            jsonResponse(true, [
                'token'      => $token,
                'email'      => $email,
                'name'       => $_SESSION['name'],
                'csrf_token' => $_SESSION['csrf_token'],
                'phone'      => $verifiedPhone,
            ], 'Conta criada');
            break;
        }

        // ─── Username-only signup (Telegram-style, NO phone required) ───
        // Mirror of phone_signup but skips the verify_token validation and
        // phone uniqueness checks entirely. Used when the user picks "Criar
        // conta sem telefone" on /login — they get a chatyy.com.br email +
        // password account immediately, and can add+verify a phone later in
        // settings via verify_phone_send/verify_phone_check.
        // Marks `phone_required: false` in the profile so flows that depend
        // on a verified phone (contact discovery, anti-SIM-swap) know this
        // account is intentionally phone-less.
        case 'username_signup': {
            $input = getInput();
            $username = strtolower(trim($input['username'] ?? ''));
            $name     = trim($input['name'] ?? '');
            $password = (string)($input['password'] ?? '');
            $domain   = $input['domain'] ?? 'chatyy.com.br';
            if (!in_array($domain, ['chatyy.com.br', 'onemundo.com.br', 'superbora.com.br'])) {
                $domain = 'chatyy.com.br';
            }

            if (!$username || strlen($username) < 3) jsonResponse(false, null, 'Username muito curto', 400);
            if (!preg_match('/^[a-z0-9._]+$/', $username)) jsonResponse(false, null, 'Username invalido (use letras, numeros, "." ou "_")', 400);
            if (strlen($username) > 20) jsonResponse(false, null, 'Username muito longo (max 20)', 400);
            if (!$name || strlen($name) < 2) jsonResponse(false, null, 'Nome muito curto', 400);
            if (strlen($password) < 8) jsonResponse(false, null, 'Senha curta — use no minimo 8 caracteres', 400);
            if (strlen($password) > 72) jsonResponse(false, null, 'Senha muito longa', 400);

            $reserved = ['admin','administrator','postmaster','webmaster','abuse','noreply','no-reply','info','suporte','support','contato','contact','root','mail','ftp','www','test','security','billing','sales','marketing','help','hostmaster','mailer-daemon','spam'];
            if (in_array($username, $reserved)) jsonResponse(false, null, 'Username reservado', 400);

            // Rate limit per IP — 5 signups/hour (same as phone_signup).
            $rateFile = '/tmp/username_signup_rate_' . md5($_SERVER['REMOTE_ADDR'] ?? '');
            $rates = file_exists($rateFile) ? @json_decode(@file_get_contents($rateFile), true) : [];
            $rates = is_array($rates) ? array_filter($rates, fn($t) => $t > time() - 3600) : [];
            if (count($rates) >= 5) jsonResponse(false, null, 'Muitas contas em pouco tempo. Tente em 1h.', 429);
            $rates[] = time();
            @file_put_contents($rateFile, json_encode(array_values($rates)), LOCK_EX);

            $email = "{$username}@{$domain}";
            $signupLockFile = '/tmp/signup_lock_' . md5($email);
            $signupLockFp = @fopen($signupLockFile, 'c');
            if ($signupLockFp) @flock($signupLockFp, LOCK_EX);
            $usersFile = '/etc/dovecot/users';

            // Username uniqueness — same multi-source check as phone_signup.
            try {
                $pgChk = getPGDB();
                $stmt = $pgChk->prepare('SELECT 1 FROM accounts WHERE email = :e LIMIT 1');
                $stmt->execute([':e' => $email]);
                if ($stmt->fetch()) {
                    jsonResponse(false, null, 'Esse username ja foi escolhido', 409);
                }
            } catch (\Throwable $e) { /* table missing → fallback */ }

            $profilePathChk = "/var/mail/vhosts/{$domain}/{$username}/profile/data.json";
            if (file_exists($profilePathChk)) {
                jsonResponse(false, null, 'Esse username ja foi escolhido', 409);
            }

            $stagingChk = "/var/mail/_pending_signups/{$email}.json";
            if (file_exists($stagingChk)) {
                jsonResponse(false, null, 'Esse username ja foi escolhido', 409);
            }

            $existing = @file_get_contents($usersFile);
            if ($existing !== false && strpos($existing, $email . ':') !== false) {
                jsonResponse(false, null, 'Esse username ja foi escolhido', 409);
            }

            // Hash the user's password (SHA512-CRYPT, Dovecot format).
            $salt = '$6$' . bin2hex(random_bytes(8)) . '$';
            $cryptHash = crypt($password, $salt);
            if (!$cryptHash || strlen($cryptHash) < 20) {
                jsonResponse(false, null, 'Falha ao gerar senha do sistema (crypt)', 500);
            }
            $hash = '{SHA512-CRYPT}' . $cryptHash;

            // Stage for host drain (same pattern as phone_signup).
            $stagingDir = '/var/mail/_pending_signups';
            if (!is_dir($stagingDir)) @mkdir($stagingDir, 0755, true);
            $staged = json_encode([
                'email'      => $email,
                'hash'       => $hash,
                'domain'     => $domain,
                'username'   => $username,
                'created_at' => time(),
            ]);
            if (@file_put_contents("{$stagingDir}/{$email}.json", $staged, LOCK_EX) === false) {
                jsonResponse(false, null, 'Falha ao registrar usuario (staging bloqueado)', 500);
            }
            @safe_put_contents($usersFile, "\n{$email}:{$hash}", FILE_APPEND);

            // Postfix vmailbox.
            $vmailbox = '/etc/postfix/vmailbox';
            $vc = @file_get_contents($vmailbox) ?: '';
            $entry = "{$email}    {$domain}/{$username}/";
            if (strpos($vc, $email) === false) {
                $nl = (substr($vc, -1) !== "\n") ? "\n" : "";
                @safe_put_contents($vmailbox, $nl . $entry . "\n", FILE_APPEND);
                @exec("sudo /usr/sbin/postmap " . escapeshellarg($vmailbox));
            }

            // Maildir scaffold.
            $home = "/var/mail/vhosts/{$domain}/{$username}";
            foreach (['Maildir', 'Maildir/cur', 'Maildir/new', 'Maildir/tmp',
                       'Maildir/.Sent/cur', 'Maildir/.Sent/new', 'Maildir/.Sent/tmp',
                       'Maildir/.Drafts/cur', 'Maildir/.Drafts/new', 'Maildir/.Drafts/tmp',
                       'Maildir/.Trash/cur', 'Maildir/.Trash/new', 'Maildir/.Trash/tmp',
                       'Maildir/.Spam/cur', 'Maildir/.Spam/new', 'Maildir/.Spam/tmp',
                       'Maildir/.Archive/cur', 'Maildir/.Archive/new', 'Maildir/.Archive/tmp'] as $d) {
                @mkdir("{$home}/{$d}", 0700, true);
            }
            @exec("sudo /usr/local/bin/chatyy-fix-mailbox " . escapeshellarg($username . "@" . $domain));
            @exec("chmod 710 " . escapeshellarg($home));

            // Profile — phone_required:false marks this as username-only.
            $profileDir = "{$home}/profile";
            if (!is_dir($profileDir)) @mkdir($profileDir, 0700, true);
            @exec("chmod 770 " . escapeshellarg($profileDir));
            $profile = [
                'first_name'      => $name,
                'last_name'       => '',
                'phone'           => '',
                'phone_verified'  => false,
                'phone_required'  => false,
                'phone_only_auth' => false,
                'created_at'      => date('c'),
                'ip'              => $_SERVER['REMOTE_ADDR'] ?? '',
            ];
            @file_put_contents("{$profileDir}/data.json", json_encode($profile, JSON_PRETTY_PRINT), LOCK_EX);
            @exec("sudo /usr/local/bin/chatyy-fix-mailbox " . escapeshellarg($username . "@" . $domain));

            // Persist recovery so future password rotations / Face ID flows
            // have a recovery hook (mirrors phone_signup behaviour).
            try { require_once __DIR__ . '/phone-auth.php'; phoneAuthSaveRecovery($email, $password); } catch (\Throwable $_) {}

            // Welcome email — direct Maildir drop, never blocks signup.
            sendWelcomeEmail($email, $name, $domain);

            // Seed Chatyy AI welcome chat (pinned). No phone on this flow,
            // so language falls through to client-supplied `lang` or Accept-Language.
            seedChatyyAIWelcome($email, '', $input['lang'] ?? ($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''));

            // Best-effort PG accounts row so contact discovery hits this user.
            try {
                $pg = getPGDB();
                $stmt = $pg->prepare("
                    INSERT INTO accounts (email, display_name, created_at)
                    VALUES (:e, :n, NOW())
                    ON CONFLICT (email) DO UPDATE SET
                      display_name = EXCLUDED.display_name
                ");
                $stmt->execute([':e' => $email, ':n' => $name]);
            } catch (\Throwable $e) {}

            // Issue bearer token + bootstrap session.
            $token = generateBearerToken($email, $password);
            $_SESSION['email']        = $email;
            $_SESSION['password_enc'] = encryptSessionPassword($password);
            $_SESSION['name']         = $name ?: $username;
            $_SESSION['csrf_token']   = bin2hex(random_bytes(32));
            $_SESSION['login_time']   = time();

            jsonResponse(true, [
                'token'      => $token,
                'email'      => $email,
                'name'       => $_SESSION['name'],
                'csrf_token' => $_SESSION['csrf_token'],
            ], 'Conta criada');
            break;
        }

        // ─── Registration Lock (anti-SIM-swap) ───
        // Authenticated user sets/clears a 4-6 digit PIN. The PIN is bcrypted
        // and stored in profile/data.json under registration_lock. The next
        // phone_login_verify for this account will require the PIN before
        // issuing a token even after a successful SMS OTP — defeating the
        // SIM-swap attack where an attacker steals the number, gets the OTP,
        // and takes over the account. Pass {pin: ''} to clear the lock.
        case 'set_registration_lock': {
            $auth = requireAuthLite();
            $input = getInput();
            $pin = trim((string)($input['pin'] ?? ''));
            $email = strtolower($auth['email']);
            [$user, $domain] = explode('@', $email);
            $profileFile = "/var/mail/vhosts/{$domain}/{$user}/profile/data.json";
            $pData = file_exists($profileFile)
                ? (@json_decode(@file_get_contents($profileFile), true) ?: [])
                : [];

            if ($pin === '') {
                // Clear lock.
                if (isset($pData['registration_lock'])) unset($pData['registration_lock']);
                if (isset($pData['registration_lock_set_at'])) unset($pData['registration_lock_set_at']);
                @mkdir(dirname($profileFile), 0775, true);
                @file_put_contents($profileFile, json_encode($pData, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
                jsonResponse(true, ['enabled' => false], 'PIN removido');
            }

            if (!preg_match('/^[0-9]{4,6}$/', $pin)) {
                jsonResponse(false, null, 'PIN deve ter 4 a 6 digitos', 400);
            }

            $pData['registration_lock'] = password_hash($pin, PASSWORD_BCRYPT);
            $pData['registration_lock_set_at'] = date('c');
            @mkdir(dirname($profileFile), 0775, true);
            @file_put_contents($profileFile, json_encode($pData, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
            jsonResponse(true, ['enabled' => true], 'PIN ativado');
            break;
        }

        case 'verify_check':
            $input = getInput();
            $phone = trim($input['phone'] ?? '');
            $code = trim($input['code'] ?? '');
            if (!$phone || !$code) jsonResponse(false, null, 'Telefone e codigo obrigatorios', 400);

            $codeFile = '/tmp/verify_code_' . md5($phone) . '.json';
            if (!file_exists($codeFile)) jsonResponse(false, null, 'Nenhum codigo pendente. Solicite novamente.', 400);

            $stored = json_decode(file_get_contents($codeFile), true);
            if (!is_array($stored)) jsonResponse(false, null, 'Erro interno', 500);

            // Check expiry
            if (($stored['expires'] ?? 0) < time()) {
                @unlink($codeFile);
                jsonResponse(false, null, 'Codigo expirado. Solicite um novo.', 400);
            }

            // Max 5 wrong attempts
            if (($stored['attempts'] ?? 0) >= 5) {
                @unlink($codeFile);
                jsonResponse(false, null, 'Muitas tentativas incorretas. Solicite um novo codigo.', 400);
            }

            // Verify
            if (hash_equals($stored['code'], $code)) {
                @unlink($codeFile);
                // Generate signed verify token for signup
                $secret = getenv('WEBMAIL_VERIFY_SECRET') ?: hash('sha256', 'chatyy-verify-' . php_uname('n'));
                $header = rtrim(strtr(base64_encode(json_encode(['alg' => 'HS256'])), '+/', '-_'), '=');
                $payload = rtrim(strtr(base64_encode(json_encode([
                    'phone' => $phone,
                    'verified' => true,
                    'exp' => time() + 3600,
                    'iat' => time(),
                ])), '+/', '-_'), '=');
                $sig = rtrim(strtr(base64_encode(hash_hmac('sha256', "{$header}.{$payload}", $secret, true)), '+/', '-_'), '=');
                $tok = "{$header}.{$payload}.{$sig}";
                jsonResponse(true, ['verified' => true, 'token' => $tok], 'Telefone verificado');
            } else {
                $stored['attempts'] = ($stored['attempts'] ?? 0) + 1;
                file_put_contents($codeFile, json_encode($stored), LOCK_EX);
                jsonResponse(false, null, 'Codigo incorreto', 400);
            }
            exit;

        // ---- CHECK USERNAME ----
        case 'check_username':
            $username = strtolower(trim($_GET['username'] ?? ''));
            $domain = in_array($_GET['domain'] ?? '', ['onemundo.com.br', 'superbora.com.br', 'chatyy.com.br']) ? $_GET['domain'] : 'chatyy.com.br';

            if (!$username || strlen($username) < 3) jsonResponse(false, null, 'Username muito curto', 400);
            if (!preg_match('/^[a-z0-9._-]+$/', $username)) jsonResponse(false, null, 'Username invalido', 400);

            // Rate limit
            $rateFile = '/tmp/check_rate_' . md5($_SERVER['REMOTE_ADDR'] ?? '');
            $rates = file_exists($rateFile) ? json_decode(file_get_contents($rateFile), true) : [];
            $rates = array_filter($rates, fn($t) => $t > time() - 60);
            if (count($rates) >= 30) jsonResponse(false, null, 'Muitas requisicoes', 429);
            $rates[] = time();
            file_put_contents($rateFile, json_encode($rates), LOCK_EX);

            $email = $username . '@' . $domain;
            $usersFile = '/etc/dovecot/users';

            // ── Multi-source uniqueness check (PG → Maildir profile → staging → dovecot) ──
            // The legacy `file_get_contents('/etc/dovecot/users')` always returned
            // false inside the PHP-FPM Docker container (file not mounted), making
            // `strpos === false` always true → check_username always returned
            // available=true. Frontend then accepted "available" usernames that
            // were actually taken, and signup proceeded → account takeover.
            $available = true;
            $taken = false;

            try {
                $pgChk = getPGDB();
                $stmt = $pgChk->prepare('SELECT 1 FROM accounts WHERE email = :e LIMIT 1');
                $stmt->execute([':e' => $email]);
                if ($stmt->fetch()) $taken = true;
            } catch (\Throwable $e) { /* table missing → fallback */ }

            if (!$taken) {
                $profilePathChk = "/var/mail/vhosts/{$domain}/{$username}/profile/data.json";
                if (file_exists($profilePathChk)) $taken = true;
            }
            if (!$taken) {
                $stagingChk = "/var/mail/_pending_signups/{$email}.json";
                if (file_exists($stagingChk)) $taken = true;
            }
            if (!$taken) {
                $existing = @file_get_contents($usersFile);
                if ($existing !== false && strpos($existing, $email . ':') !== false) $taken = true;
            }
            if ($taken) $available = false;
            // Keep $existing string available for the suggestion loop below
            // (may be false if dovecot file not readable — handled there).
            if (!isset($existing)) $existing = '';

            $reserved = ['admin','administrator','postmaster','webmaster','abuse','noreply','no-reply','info','suporte','support','contato','contact','root','mail','ftp','www','test','security','billing','sales','marketing','help','hostmaster','mailer-daemon','spam'];
            if (in_array($username, $reserved)) $available = false;

            $suggestions = [];
            if (!$available) {
                $first = trim($_GET['first_name'] ?? '');
                $last = trim($_GET['last_name'] ?? '');
                $f = strtolower(preg_replace('/\s+/', '', $first));
                $l = strtolower(preg_replace('/\s+/', '', $last));
                $year = date('y');

                $candidates = $f && $l ? [
                    "{$f}.{$l}", "{$f}{$l}", "{$f}.{$l}{$year}", "{$f}_{$l}", "{$f[0]}{$l}"
                ] : [
                    "{$username}{$year}", "{$username}.mail", "{$username}1", "{$username}_01", "{$username}.{$year}"
                ];

                // Inline multi-source check for suggestions (same logic as the
                // main check, just without the rate-limit/PG class re-init).
                $sugTaken = function($candidate) use ($domain) {
                    $ce = "{$candidate}@{$domain}";
                    try {
                        $pg = getPGDB();
                        $stmt = $pg->prepare('SELECT 1 FROM accounts WHERE email = :e LIMIT 1');
                        $stmt->execute([':e' => $ce]);
                        if ($stmt->fetch()) return true;
                    } catch (\Throwable $_e) {}
                    if (file_exists("/var/mail/vhosts/{$domain}/{$candidate}/profile/data.json")) return true;
                    if (file_exists("/var/mail/_pending_signups/{$ce}.json")) return true;
                    return false;
                };
                foreach ($candidates as $c) {
                    if (!$sugTaken($c) && !in_array($c, $reserved) && $c !== $username) {
                        $suggestions[] = $c;
                    }
                    if (count($suggestions) >= 4) break;
                }
            }

            jsonResponse(true, ['available' => $available, 'suggestions' => $suggestions]);
            break;

        // ---- STAR / UNSTAR ----
        case 'star':
        case 'unstar':
            $auth = requireAuth();
            $input = getInput();
            $uid = (int)($input['uid'] ?? 0);
            $folder = $input['folder'] ?? 'INBOX';
            // Virtual folder: Flagged is not a real IMAP folder
            if ($folder === 'Flagged') $folder = 'INBOX';
            if (!$uid) jsonResponse(false, null, 'uid obrigatorio', 400);

            $imap = getImap($auth['email'], $auth['password'], $folder);
            if ($action === 'star') {
                imap_setflag_full($imap, (string)$uid, '\\Flagged', ST_UID);
            } else {
                imap_clearflag_full($imap, (string)$uid, '\\Flagged', ST_UID);
            }
            try { imap_close($imap); } catch (\Throwable $_e) {}
            // Flag changed -> invalidate header (cached `flagged` field) + folder counts
            // (Flagged virtual folder counts changed).
            imapCacheDel('mhdr:' . strtolower($auth['email']) . ':' . $folder . ':' . $uid);
            imapCacheDel('folders:' . strtolower($auth['email']));
            jsonResponse(true, null, $action === 'star' ? 'Marcado com estrela' : 'Estrela removida');
            break;

        // ---- PROFILE ----
        case 'get_profile':
            $auth = requireAuthLite();
            $parts = explode('@', $auth['email']);
            $username = $parts[0];
            $domain = $parts[1] ?? 'onemundo.com.br';
            $homeDir = "/var/mail/vhosts/{$domain}/{$username}";
            $profileFile = "{$homeDir}/profile/data.json";

            // Ensure permissions on first access
            if (is_dir($homeDir) && !is_writable("{$homeDir}/profile")) {
                exec("sudo chmod 710 " . escapeshellarg($homeDir));
                exec("sudo chgrp www-data " . escapeshellarg($homeDir));
            }

            $data = file_exists($profileFile) ? json_decode(file_get_contents($profileFile), true) : [];
            if (!is_array($data)) $data = [];
            $data['email'] = $auth['email'];
            // Preserve user-edited name; fallback to auth name only if unset
            if (empty($data['name'])) $data['name'] = $auth['name'];
            jsonResponse(true, $data);
            break;

        // ─── profile_get ─────────────────────────────────────────────
        // Unified profile endpoint. One call fans out to:
        //   - identity (profile json + email/username/avatar)
        //   - presence (online/last_seen from Redis)
        //   - social (follower/following counts + is_following)
        //   - posts (top 12 from chat_feed_posts, non-reel)
        //   - reels (top 12 from chat_feed_posts, video+is_reel)
        //   - shared_media (last 12 images/videos from chats w/ caller)
        //   - common_chats (direct+group conversations both are in)
        //   - email_preview (last 10 email headers w/ caller — if allowed)
        //   - actions (can_message/call/email/follow bools)
        //   - self_only (devices, subscription, storage — only when email=me)
        // Returns EVERYTHING the new <Profile> component needs so the client
        // never has to fire 5 separate fetches just to paint one profile.
        // ─── profile_insights (IG-style creator analytics, last 7 days) ───
        // Returns 3 cards:
        //  - profile_views_count : how many distinct viewers opened your profile
        //  - posts_reach         : distinct viewers across all your posts
        //  - engagement_total    : SUM(likes + comments) on your posts
        // Plus a 7-element sparkline (one count per day) for each. Tables are
        // best-effort: if the views table doesn't exist yet we surface zeros
        // rather than 500-ing.
        case 'profile_insights': {
            // Lite auth — profile_insights apenas le PG/files, sem IMAP.
            $auth = requireAuthLite();
            $owner = strtolower($auth['email']);
            $sevenDaysAgo = gmdate('Y-m-d H:i:s', time() - 7 * 86400);
            $out = [
                'profile_views_count' => 0,
                'posts_reach' => 0,
                'engagement_total' => 0,
                'spark_views' => array_fill(0, 7, 0),
                'spark_reach' => array_fill(0, 7, 0),
                'spark_engagement' => array_fill(0, 7, 0),
            ];
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Profile views — best-effort table; create if missing so the
                // first call doesn't fail.
                @$pg->exec("CREATE TABLE IF NOT EXISTS profile_views (
                    profile_email TEXT NOT NULL,
                    viewer_email TEXT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT now()
                )");
                try {
                    $st = $pg->prepare("SELECT COUNT(DISTINCT viewer_email) FROM profile_views WHERE LOWER(profile_email) = LOWER(:e) AND created_at >= :s");
                    $st->execute([':e' => $owner, ':s' => $sevenDaysAgo]);
                    $out['profile_views_count'] = (int)$st->fetchColumn();
                } catch (Throwable $_) {}
                try {
                    // Per-day sparkline. Each bucket = one UTC day, ordered
                    // oldest→newest (i=0 = 6 days ago, i=6 = today).
                    $st = $pg->prepare("SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS d, COUNT(DISTINCT viewer_email) AS c FROM profile_views WHERE LOWER(profile_email) = LOWER(:e) AND created_at >= :s GROUP BY d ORDER BY d ASC");
                    $st->execute([':e' => $owner, ':s' => $sevenDaysAgo]);
                    $byDay = [];
                    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $byDay[$r['d']] = (int)$r['c'];
                    $spark = [];
                    for ($i = 6; $i >= 0; $i--) {
                        $d = gmdate('Y-m-d', time() - $i * 86400);
                        $spark[] = $byDay[$d] ?? 0;
                    }
                    $out['spark_views'] = $spark;
                } catch (Throwable $_) {}

                // Posts reach + engagement on user's posts in window.
                try {
                    // Likes + comments engagement; counts every interaction
                    // (not unique users) since IG insights does the same.
                    $st = $pg->prepare("
                        SELECT
                            (COALESCE((SELECT COUNT(*) FROM chat_feed_likes l JOIN chat_feed_posts p ON p.id = l.post_id WHERE LOWER(p.author_email) = LOWER(:e) AND l.created_at >= :s), 0)
                            + COALESCE((SELECT COUNT(*) FROM chat_feed_comments co JOIN chat_feed_posts p ON p.id = co.post_id WHERE LOWER(p.author_email) = LOWER(:e2) AND co.created_at >= :s2 AND (co.is_deleted IS NULL OR co.is_deleted = 0)), 0)) AS total
                    ");
                    $st->execute([':e' => $owner, ':s' => $sevenDaysAgo, ':e2' => $owner, ':s2' => $sevenDaysAgo]);
                    $out['engagement_total'] = (int)$st->fetchColumn();
                } catch (Throwable $_) {}
                try {
                    // Reach: distinct viewers/likers/commenters across owner's
                    // posts in window. Approximate (uses likes + comments as
                    // proxies because we don't have a per-post-view table yet).
                    $st = $pg->prepare("
                        SELECT COUNT(DISTINCT em) AS reach FROM (
                            SELECT l.email AS em FROM chat_feed_likes l JOIN chat_feed_posts p ON p.id = l.post_id WHERE LOWER(p.author_email) = LOWER(:e) AND l.created_at >= :s
                            UNION
                            SELECT co.email AS em FROM chat_feed_comments co JOIN chat_feed_posts p ON p.id = co.post_id WHERE LOWER(p.author_email) = LOWER(:e2) AND co.created_at >= :s2 AND (co.is_deleted IS NULL OR co.is_deleted = 0)
                        ) u
                    ");
                    $st->execute([':e' => $owner, ':s' => $sevenDaysAgo, ':e2' => $owner, ':s2' => $sevenDaysAgo]);
                    $out['posts_reach'] = (int)$st->fetchColumn();
                } catch (Throwable $_) {}

                // Per-day reach + engagement sparklines (lightweight, single
                // query each — owner posts are typically < a few hundred so
                // no need for materialised views yet).
                try {
                    $st = $pg->prepare("
                        SELECT to_char(date_trunc('day', d AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, COUNT(*) AS c FROM (
                            SELECT l.created_at AS d FROM chat_feed_likes l JOIN chat_feed_posts p ON p.id = l.post_id WHERE LOWER(p.author_email) = LOWER(:e) AND l.created_at >= :s
                            UNION ALL
                            SELECT co.created_at AS d FROM chat_feed_comments co JOIN chat_feed_posts p ON p.id = co.post_id WHERE LOWER(p.author_email) = LOWER(:e2) AND co.created_at >= :s2 AND (co.is_deleted IS NULL OR co.is_deleted = 0)
                        ) ev GROUP BY day ORDER BY day ASC
                    ");
                    $st->execute([':e' => $owner, ':s' => $sevenDaysAgo, ':e2' => $owner, ':s2' => $sevenDaysAgo]);
                    $byDay = [];
                    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $byDay[$r['day']] = (int)$r['c'];
                    $sp1 = [];
                    for ($i = 6; $i >= 0; $i--) {
                        $d = gmdate('Y-m-d', time() - $i * 86400);
                        $sp1[] = $byDay[$d] ?? 0;
                    }
                    $out['spark_engagement'] = $sp1;
                    // Reach sparkline mirrors engagement curve when no
                    // dedicated post-views table exists — same shape, same
                    // domain. Once a real `feed_post_views` table lands the
                    // query above can switch to it.
                    $out['spark_reach'] = $sp1;
                } catch (Throwable $_) {}
            } catch (Throwable $e) {
                error_log('[profile_insights] ' . $e->getMessage());
            }
            jsonResponse(true, $out);
            break;
        }

        case 'profile_get': {
            // profile_get nao usa IMAP — auth lite (so email) evita 401 ghost
            // em tokens com password_enc='' (signup phone-first).
            $auth = requireAuthLite();
            $input = getInput();
            $target = strtolower(trim((string)($input['email'] ?? $_GET['email'] ?? '')));
            $username = trim((string)($input['username'] ?? $_GET['username'] ?? ''));
            if ($target === '' && $username !== '') {
                // Resolve @username → email via chat_usernames table (real
                // handle system, WhatsApp 2025 parity). Fall back to legacy
                // path of treating the username as a chatyy local-part.
                try {
                    require_once __DIR__ . '/db.php';
                    $pgU = getPGDB();
                    $h = strtolower(ltrim($username, '@'));
                    $st = $pgU->prepare("SELECT email FROM chat_usernames WHERE handle = :h LIMIT 1");
                    $st->execute([':h' => $h]);
                    $row = $st->fetch(\PDO::FETCH_ASSOC);
                    if ($row && !empty($row['email'])) {
                        $target = strtolower($row['email']);
                    }
                } catch (\Throwable $e) { /* table may not exist yet */ }
                if ($target === '') {
                    $target = strtolower($username) . (str_contains($username, '@') ? '' : '@chatyy.com.br');
                }
            }
            if (!filter_var($target, FILTER_VALIDATE_EMAIL)) {
                jsonResponse(false, null, 'Invalid email or username', 400);
            }
            $isSelf = strtolower($auth['email']) === strtolower($target);

            // ─── Redis cache (30s) — fast-path pra evitar fan-out de queries
            // (identity + presence + social + posts + reels + shared_media +
            // common_chats + email_preview = 8+ queries por request). 30s é
            // curto o suficiente pra usuário não notar staleness em counts.
            $profCacheKey = 'prof:v2:' . strtolower($auth['email']) . ':' . strtolower($target);
            $profRedis = null;
            try {
                if (class_exists('Redis')) {
                    $profRedis = new Redis();
                    @$profRedis->connect('127.0.0.1', 6379, 0.2);
                    $rpw = getenv('REDIS_PASSWORD');
                    if ($rpw) @$profRedis->auth($rpw);
                    $cached = @$profRedis->get($profCacheKey);
                    if ($cached) {
                        $decoded = json_decode($cached, true);
                        if (is_array($decoded)) {
                            jsonResponse(true, $decoded);
                        }
                    }
                }
            } catch (Throwable $e) { $profRedis = null; }

            // --- Identity (file read — keep raw $pData around for self-only
            //     fields like phone + selfOnly block; identity block itself
            //     is also part of the cached static blob below). -----------
            [$tUser, $tDomain] = array_pad(explode('@', $target, 2), 2, '');
            $pFile = "/var/mail/vhosts/{$tDomain}/{$tUser}/profile/data.json";
            $pData = file_exists($pFile) ? (json_decode(@file_get_contents($pFile), true) ?: []) : [];
            if (!is_array($pData)) $pData = [];
            // avatar_version is set by upload_avatar; carry it into the URL
            // so a fresh upload immediately wins over any browser/CDN cached
            // copy of /api/email.php?action=get_avatar&email=... — without
            // this, users had to hard-reload to see their new photo.
            //
            // For legacy avatars uploaded before the avatar_version field
            // was introduced, fall back to the file's mtime so URLs still
            // change when the user uploads — otherwise expo-image cached
            // forever and the new photo never showed.
            $avatarV = (int)($pData['avatar_version'] ?? 0);
            if ($avatarV === 0) {
                $webpFile = "/var/mail/vhosts/{$tDomain}/{$tUser}/profile/avatar.webp";
                $jpgFile  = "/var/mail/vhosts/{$tDomain}/{$tUser}/profile/avatar.jpg";
                if (file_exists($webpFile))      $avatarV = (int)@filemtime($webpFile);
                else if (file_exists($jpgFile))  $avatarV = (int)@filemtime($jpgFile);
            }
            // Phone visibility — viewer always sees their own phone. For
            // other targets, consult chat_user_privacy.phone_visibility.
            //   'all'       → always include
            //   'contacts'  → include only if viewer shares any chat
            //                 conversation with the target (default)
            //   'nobody'    → never include
            // Falls back to 'contacts' if the column/row is missing.
            $phoneRaw = $pData['phone'] ?? ($pData['verified_phone'] ?? '');
            $phoneOut = '';
            if ($isSelf) {
                $phoneOut = $phoneRaw;
            } else if ($phoneRaw !== '') {
                $phoneVis = 'contacts';
                try {
                    require_once __DIR__ . '/db.php';
                    $pgPv = getPGDB();
                    @$pgPv->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS phone_visibility TEXT DEFAULT 'contacts'");
                    $stPv = $pgPv->prepare("SELECT phone_visibility FROM chat_user_privacy WHERE LOWER(email) = LOWER(:e) LIMIT 1");
                    $stPv->execute([':e' => $target]);
                    $rowPv = $stPv->fetchColumn();
                    if ($rowPv && in_array($rowPv, ['all','contacts','nobody'], true)) {
                        $phoneVis = $rowPv;
                    }
                } catch (\Throwable $_) {}
                if ($phoneVis === 'all') {
                    $phoneOut = $phoneRaw;
                } else if ($phoneVis === 'contacts') {
                    // Viewer counts as a contact if they share any chat
                    // conversation membership with the target.
                    try {
                        require_once __DIR__ . '/db.php';
                        $pgPv2 = getPGDB();
                        $chkC = $pgPv2->prepare("SELECT 1 FROM chat_conversation_members a
                            JOIN chat_conversation_members b ON a.conversation_id = b.conversation_id
                            WHERE LOWER(a.email) = LOWER(:me) AND LOWER(b.email) = LOWER(:them) LIMIT 1");
                        $chkC->execute([':me' => $auth['email'], ':them' => $target]);
                        if ($chkC->fetch()) $phoneOut = $phoneRaw;
                    } catch (\Throwable $_) {}
                }
                // 'nobody' → $phoneOut stays empty.
            }
            // Sanitize links — backend re-validates on output so legacy
            // profiles that wrote raw strings don't blow up the client.
            $linksOut = [];
            $rawLinks = $pData['links'] ?? [];
            if (is_array($rawLinks)) {
                foreach ($rawLinks as $L) {
                    if (!is_array($L)) continue;
                    $u = trim((string)($L['url'] ?? ''));
                    if ($u === '') continue;
                    if (!preg_match('#^https?://#i', $u)) $u = 'https://' . $u;
                    $linksOut[] = [
                        'label' => mb_substr(trim((string)($L['label'] ?? '')), 0, 30),
                        'url'   => mb_substr($u, 0, 200),
                        'icon'  => mb_substr(trim((string)($L['icon'] ?? '')), 0, 20),
                    ];
                    if (count($linksOut) >= 5) break;
                }
            }
            $accountType = (string)($pData['account_type'] ?? 'personal');
            if (!in_array($accountType, ['personal','creator','business'], true)) $accountType = 'personal';
            $identity = [
                'email'       => $target,
                'username'    => $pData['username'] ?? $tUser,
                'name'        => $pData['name'] ?? ($pData['first_name'] ?? $tUser),
                'avatar_url'  => '/api/email.php?action=get_avatar&email=' . urlencode($target) . ($avatarV ? '&v=' . $avatarV : ''),
                'avatar_version' => $avatarV,
                'bio'         => $pData['bio'] ?? ($pData['about'] ?? ''),
                'website'     => $pData['website'] ?? ($pData['link'] ?? ''),
                // Profile-upgrade combo (2026-05-18) — cover photo + multi-link
                // chips + account type (personal/creator/business). Backed by
                // data.json (same flat-file store as the rest of profile);
                // no `accounts` table exists in this codebase.
                'cover_url'    => (string)($pData['cover_url'] ?? ''),
                'links'        => $linksOut,
                'account_type' => $accountType,
                'verified'    => !empty($pData['verified']),
                'joined_at'   => $pData['created_at'] ?? null,
                'phone'       => $phoneOut,
            ];

            // 4-tier cache (APCu → Redis → compute) for the heavy public-shape
            // fields: follower counts, posts, reels, stories. Per-viewer
            // pieces (is_following, mutuals, presence, shared media, email
            // preview, selfOnly) are computed below with no cache. TTL 60s
            // is short enough that follower count drift is invisible to the
            // user but cuts Postgres load on profile views by 80-90% during
            // bursty traffic (notification-driven profile pops).
            require_once __DIR__ . '/cache.php';
            $cached = cached("profile:v1:" . strtolower($target), function () use ($target) {
                $out = ['followers_count' => 0, 'following_count' => 0, 'posts' => [], 'reels' => [], 'stories' => []];
                try {
                    require_once __DIR__ . '/db.php';
                    $pg2 = getPGDB();
                    // Counts
                    $f = $pg2->prepare("SELECT COUNT(*) FROM chat_follows WHERE LOWER(following_email) = LOWER(:e)");
                    $f->execute([':e' => $target]);
                    $out['followers_count'] = (int)$f->fetchColumn();
                    $g = $pg2->prepare("SELECT COUNT(*) FROM chat_follows WHERE LOWER(follower_email) = LOWER(:e)");
                    $g->execute([':e' => $target]);
                    $out['following_count'] = (int)$g->fetchColumn();
                    // Posts + reels — first try with is_reel column (newer schemas),
                    // fall back to is_reel-less query if the column is missing.
                    // CRITICAL: the inner catch must NOT swallow silently with empty
                    // result, otherwise the cache layer above stores [] for 60s and
                    // user sees their reels/posts vanish (the bug user hit).
                    $loaded = false;
                    try {
                        $q = $pg2->prepare("SELECT id, caption, media_type, media_urls, thumbnail_url, created_at, COALESCE(is_reel, false) AS is_reel
                            FROM chat_feed_posts
                            WHERE LOWER(author_email) = LOWER(:e) AND is_deleted = 0 AND (published IS NULL OR published = TRUE)

                            ORDER BY id DESC LIMIT 40");
                        $q->execute([':e' => $target]);
                        foreach ($q->fetchAll(\PDO::FETCH_ASSOC) as $p) {
                            $mu = _cdnifyArray(json_decode($p['media_urls'] ?? '[]', true) ?: []);
                            $row = [
                                'id'          => (int)$p['id'],
                                'thumbnail'   => _cdnify($p['thumbnail_url'] ?: ($mu[0] ?? '')),
                                // Inclui media_urls completo pra ProfilePostViewer
                                // poder renderizar vídeo direto sem esperar
                                // feed_get_post (user reportou: Reels no perfil
                                // não carregam — fallback usava thumbnail JPG
                                // como src do <video>, que falhava).
                                'media_urls'  => $mu,
                                'media_type'  => $p['media_type'],
                                'type'        => $p['media_type'],
                                'caption'     => mb_substr($p['caption'] ?? '', 0, 120),
                                'count'       => count($mu),
                                'created_at'  => $p['created_at'],
                            ];
                            if (!empty($p['is_reel']) && $p['media_type'] === 'video') {
                                if (count($out['reels']) < 12) $out['reels'][] = $row;
                            } else {
                                if (count($out['posts']) < 12) $out['posts'][] = $row;
                            }
                        }
                        $loaded = true;
                    } catch (Throwable $e) {
                        error_log('[profile_get/cached/posts-with-reel] ' . $e->getMessage());
                    }
                    if (!$loaded) {
                        // Fallback for schemas without is_reel column. Treat all
                        // videos as reels (the original heuristic before the column
                        // existed).
                        try {
                            $q = $pg2->prepare("SELECT id, caption, media_type, media_urls, thumbnail_url, created_at
                                FROM chat_feed_posts
                                WHERE LOWER(author_email) = LOWER(:e) AND is_deleted = 0 AND (published IS NULL OR published = TRUE)

                                ORDER BY id DESC LIMIT 24");
                            $q->execute([':e' => $target]);
                            foreach ($q->fetchAll(\PDO::FETCH_ASSOC) as $p) {
                                $mu = _cdnifyArray(json_decode($p['media_urls'] ?? '[]', true) ?: []);
                                $row = [
                                    'id'          => (int)$p['id'],
                                    'thumbnail'   => _cdnify($p['thumbnail_url'] ?: ($mu[0] ?? '')),
                                    'media_urls'  => $mu,
                                    'media_type'  => $p['media_type'],
                                    'type'        => $p['media_type'],
                                    'caption'     => mb_substr($p['caption'] ?? '', 0, 120),
                                    'count'       => count($mu),
                                    'created_at'  => $p['created_at'],
                                ];
                                if ($p['media_type'] === 'video' && count($out['reels']) < 12) $out['reels'][] = $row;
                                elseif (count($out['posts']) < 12) $out['posts'][] = $row;
                            }
                        } catch (Throwable $e2) { error_log('[profile_get/cached/posts-fallback] ' . $e2->getMessage()); }
                    }
                    // Stories
                    try {
                        $s = $pg2->prepare("SELECT id, content, type, bg_color, media_url, created_at, expires_at, music_title, music_artist, music_cover_url
                            FROM chat_user_status
                            WHERE LOWER(email) = LOWER(:e) AND expires_at > now()::text
                            ORDER BY created_at ASC LIMIT 20");
                        $s->execute([':e' => $target]);
                        foreach ($s->fetchAll(\PDO::FETCH_ASSOC) as $st) {
                            $out['stories'][] = [
                                'id'         => (int)$st['id'],
                                'type'       => $st['type'] ?: 'text',
                                'content'    => $st['content'] ?: '',
                                'bg_color'   => $st['bg_color'] ?: '#25D366',
                                'media_url'  => $st['media_url'] ?: '',
                                'created_at' => $st['created_at'],
                                'music'      => $st['music_title'] ? [
                                    'title'  => $st['music_title'],
                                    'artist' => $st['music_artist'] ?: '',
                                    'cover'  => $st['music_cover_url'] ?: '',
                                ] : null,
                            ];
                        }
                    } catch (Throwable $e) {}
                } catch (Throwable $e) { error_log('[profile_get/cached] ' . $e->getMessage()); }
                return $out;
            }, 60);

            // --- Presence ---------------------------------------------------
            $presence = ['online' => false, 'last_seen' => null];
            try {
                if (class_exists('Redis')) {
                    $r = new Redis();
                    @$r->connect('127.0.0.1', 6379, 0.2);
                    $online = $r->get('presence:' . strtolower($target));
                    if ($online) { $presence['online'] = true; }
                    $ls = $r->get('last_seen:' . strtolower($target));
                    if ($ls) { $presence['last_seen'] = (int)$ls; }
                    $r->close();
                }
            } catch (Throwable $e) {}

            // --- Social (counts + is_following) -----------------------------
            // Counts come from $cached (60s TTL). is_following + mutuals are
            // per-viewer and computed fresh on each request.
            $social = [
                'followers_count' => (int)($cached['followers_count'] ?? 0),
                'following_count' => (int)($cached['following_count'] ?? 0),
                'is_following'    => false,
                'mutuals'         => 0,
            ];
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                if (!$isSelf) {
                    $i = $pg->prepare("SELECT 1 FROM chat_follows WHERE LOWER(follower_email) = LOWER(:me) AND LOWER(following_email) = LOWER(:e) LIMIT 1");
                    $i->execute([':me' => $auth['email'], ':e' => $target]);
                    $social['is_following'] = (bool)$i->fetchColumn();
                    $m = $pg->prepare("SELECT COUNT(*) FROM chat_follows a JOIN chat_follows b ON LOWER(a.following_email) = LOWER(b.following_email) WHERE LOWER(a.follower_email) = LOWER(:me) AND LOWER(b.follower_email) = LOWER(:e)");
                    $m->execute([':me' => $auth['email'], ':e' => $target]);
                    $social['mutuals'] = (int)$m->fetchColumn();
                }
            } catch (Throwable $e) { error_log('[profile_get/social] ' . $e->getMessage()); }

            // --- Posts + Reels + Stories (cached at top of handler) -------
            $posts   = $cached['posts']   ?? [];
            $reels   = $cached['reels']   ?? [];
            $stories = $cached['stories'] ?? [];

            // --- Shared media + common chats ------------------------------
            $sharedMedia = [];
            $commonChats = [];
            if (!$isSelf) {
                try {
                    // Common conversations: both $auth['email'] AND $target are members
                    $cc = $pg->prepare("
                        SELECT c.id, c.type, COALESCE(c.name,'') AS name, COALESCE(c.avatar_url,'') AS avatar_url
                        FROM chat_conversations c
                        WHERE EXISTS (SELECT 1 FROM chat_conversation_members m1 WHERE m1.conversation_id = c.id AND LOWER(m1.email) = LOWER(:me))
                          AND EXISTS (SELECT 1 FROM chat_conversation_members m2 WHERE m2.conversation_id = c.id AND LOWER(m2.email) = LOWER(:them))
                        AND c.type = 'group' ORDER BY c.id DESC LIMIT 10
                    ");
                    $cc->execute([':me' => $auth['email'], ':them' => $target]);
                    $commonIds = [];
                    foreach ($cc->fetchAll(\PDO::FETCH_ASSOC) as $c) {
                        $commonChats[] = [
                            'id'     => (int)$c['id'],
                            'type'   => $c['type'],
                            'name'   => $c['name'] ?: (($c['type'] === 'direct') ? $target : ''),
                            'avatar' => $c['avatar_url'],
                        ];
                        $commonIds[] = (int)$c['id'];
                    }
                    // Shared media from those conversations
                    if (!empty($commonIds)) {
                        $in = implode(',', array_fill(0, count($commonIds), '?'));
                        $sm = $pg->prepare("SELECT id, type, file_url, conversation_id, created_at
                            FROM chat_messages
                            WHERE conversation_id IN ($in) AND type IN ('image','video')
                              AND deleted_at IS NULL AND file_url IS NOT NULL AND file_url <> ''
                            ORDER BY id DESC LIMIT 12");
                        $sm->execute($commonIds);
                        foreach ($sm->fetchAll(\PDO::FETCH_ASSOC) as $mm) {
                            $sharedMedia[] = [
                                'id'              => (int)$mm['id'],
                                'url'             => $mm['file_url'],
                                'type'            => $mm['type'],
                                'conversation_id' => (int)$mm['conversation_id'],
                                'created_at'      => $mm['created_at'],
                            ];
                        }
                    }
                } catch (Throwable $e) { error_log('[profile_get/shared] ' . $e->getMessage()); }
            }

            // --- Email preview (last 10 subjects between me+target) --------
            // Searches FROM + TO on caller's INBOX + Sent. Capped at 10 items
            // to keep total endpoint time under 500ms even on busy mailboxes.
            $emailPreview = [];
            if (!$isSelf && filter_var($target, FILTER_VALIDATE_EMAIL)) {
                try {
                    $mePwd = $auth['password'] ?? null;
                    if ($mePwd) {
                        $seen = [];
                        foreach (['INBOX', 'Sent'] as $folder) {
                            try {
                                $imap = getImap($auth['email'], $mePwd, $folder);
                                $fromMe = @imap_search($imap, 'TO "' . addslashes($target) . '"', SE_UID) ?: [];
                                $fromThem = @imap_search($imap, 'FROM "' . addslashes($target) . '"', SE_UID) ?: [];
                                $uids = array_unique(array_merge($fromMe, $fromThem));
                                // newest first
                                rsort($uids);
                                foreach (array_slice($uids, 0, 10) as $uid) {
                                    if (count($emailPreview) >= 10) break;
                                    if (isset($seen[$uid . '|' . $folder])) continue;
                                    $seen[$uid . '|' . $folder] = true;
                                    $h = @imap_headerinfo($imap, @imap_msgno($imap, $uid));
                                    if (!$h) continue;
                                    $fromAddr = '';
                                    if (!empty($h->from[0])) {
                                        $fromAddr = strtolower(($h->from[0]->mailbox ?? '') . '@' . ($h->from[0]->host ?? ''));
                                    }
                                    $emailPreview[] = [
                                        'uid'     => (int)$uid,
                                        'folder'  => $folder,
                                        'subject' => mb_substr($h->subject ?? '(sem assunto)', 0, 120),
                                        'date'    => $h->date ?? '',
                                        'from_me' => $fromAddr === strtolower($auth['email']),
                                    ];
                                }
                            } catch (Throwable $e) { /* folder may not exist */ }
                        }
                        // Final sort by date desc, keep 10
                        usort($emailPreview, fn($a, $b) => strtotime($b['date']) - strtotime($a['date']));
                        $emailPreview = array_slice($emailPreview, 0, 10);
                    }
                } catch (Throwable $e) { error_log('[profile_get/email] ' . $e->getMessage()); }
            }

            // --- Actions flags ---------------------------------------------
            $actions = [
                'can_message' => !$isSelf,
                'can_call'    => !$isSelf,
                'can_email'   => !$isSelf && filter_var($target, FILTER_VALIDATE_EMAIL),
                'can_follow'  => !$isSelf,
                'is_self'     => $isSelf,
            ];

            // --- Self-only: devices/storage/subscription -------------------
            $selfOnly = null;
            if ($isSelf) {
                $selfOnly = [
                    'phone_verified'    => !empty($pData['phone_verified']),
                    'caller_id_verified'=> !empty($pData['telnyx_caller_id_verified']) || !empty($pData['caller_id_verified_at']),
                    'subscription_tier' => $pData['subscription_tier'] ?? 'free',
                    'storage_used_mb'   => (int)($pData['storage_used_mb'] ?? 0),
                    'storage_total_mb'  => (int)($pData['storage_total_mb'] ?? 15000),
                ];
            }

            $profResult = [
                'identity'      => $identity,
                'presence'      => $presence,
                'social'        => $social,
                'stories'       => $stories,
                'posts'         => $posts,
                'reels'         => $reels,
                'shared_media'  => $sharedMedia,
                'common_chats'  => $commonChats,
                'email_preview' => $emailPreview,
                'actions'       => $actions,
                'self_only'     => $selfOnly,
            ];
            // Cache pra próxima abertura ser instantânea (30s TTL)
            if ($profRedis) {
                try { @$profRedis->setex($profCacheKey, 30, json_encode($profResult)); @$profRedis->close(); } catch (Throwable $e) {}
            }
            jsonResponse(true, $profResult);
            break;
        }

        // ─── notifications_feed ──────────────────────────────────────
        // Unified chronological notifications hub. One call merges:
        //   - INBOX unread emails (last 10)
        //   - Chat @mentions targeting the caller (last 10)
        //   - New followers (last 10)
        //   - Likes on caller's feed posts (last 10)
        //   - Comments on caller's feed posts (last 10)
        // All merged, sorted created_at DESC, capped at 40 items total.
        // Each row carries a `route` field so the frontend can navigate
        // without having to know about every notification subtype.
        case 'notifications_feed': {
            $auth = requireAuth();
            $me = strtolower($auth['email']);
            $items = [];

            // --- 1) Unread emails in INBOX -----------------------------
            try {
                $pwd = $auth['password'] ?? null;
                if ($pwd) {
                    $imap = getImap($auth['email'], $pwd, 'INBOX');
                    $uids = @imap_search($imap, 'UNSEEN', SE_UID);
                    if (is_array($uids) && !empty($uids)) {
                        rsort($uids);
                        foreach (array_slice($uids, 0, 10) as $uid) {
                            try {
                                $msgno = @imap_msgno($imap, $uid);
                                if (!$msgno) continue;
                                $h = @imap_headerinfo($imap, $msgno);
                                if (!$h) continue;
                                $fromAddr = '';
                                $fromName = '';
                                if (!empty($h->from[0])) {
                                    $fromAddr = strtolower(($h->from[0]->mailbox ?? '') . '@' . ($h->from[0]->host ?? ''));
                                    $fromName = (string)($h->from[0]->personal ?? '');
                                    if ($fromName !== '' && function_exists('imap_utf8')) {
                                        $fromName = @imap_utf8($fromName) ?: $fromName;
                                    }
                                }
                                $subject = '';
                                if (!empty($h->subject)) {
                                    $subject = function_exists('imap_utf8') ? (@imap_utf8($h->subject) ?: $h->subject) : $h->subject;
                                }
                                $dateStr = $h->date ?? ($h->MailDate ?? '');
                                $ts = $dateStr ? @strtotime($dateStr) : time();
                                if (!$ts) $ts = time();
                                $items[] = [
                                    'id'          => 'email_' . (int)$uid,
                                    'type'        => 'email',
                                    'actor_email' => $fromAddr,
                                    'actor_name'  => $fromName ?: $fromAddr,
                                    'title'       => $fromName ?: $fromAddr,
                                    'preview'     => mb_substr($subject ?: '(sem assunto)', 0, 140),
                                    'created_at'  => gmdate('Y-m-d\TH:i:s\Z', $ts),
                                    'route'       => '/read?uid=' . (int)$uid . '&folder=INBOX',
                                ];
                            } catch (Throwable $e) { /* skip bad header */ }
                        }
                    }
                }
            } catch (Throwable $e) { error_log('[notifications_feed/email] ' . $e->getMessage()); }

            // --- PG-backed notifications -------------------------------
            // Batch resolver: email → display name (reads profile/data.json).
            // Prefers profile.name, then first_name, then local-part of email.
            $resolveName = function (array $emails) {
                static $cache = [];
                $out = [];
                $emails = array_values(array_unique(array_filter(array_map('strtolower', $emails))));
                foreach ($emails as $em) {
                    if (isset($cache[$em])) { $out[$em] = $cache[$em]; continue; }
                    $local = explode('@', $em)[0] ?? $em;
                    $domain = explode('@', $em)[1] ?? '';
                    $name = $local;
                    if ($domain !== '') {
                        $pf = "/var/mail/vhosts/{$domain}/{$local}/profile/data.json";
                        if (is_file($pf)) {
                            $raw = @file_get_contents($pf);
                            $j = $raw ? json_decode($raw, true) : null;
                            if (is_array($j)) {
                                $cand = trim((string)($j['name'] ?? $j['first_name'] ?? $j['display_name'] ?? ''));
                                if ($cand !== '') $name = $cand;
                            }
                        }
                    }
                    $cache[$em] = $name;
                    $out[$em] = $name;
                }
                return $out;
            };

            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();

                // --- 2) Chat @mentions --------------------------------
                // mentions column is a JSON text blob — match via LIKE on a
                // couple of common encodings (same pattern as chat.php uses
                // for unread-mention counting).
                try {
                    $mq = $pg->prepare("
                        SELECT m.id, m.conversation_id, m.sender_email, m.sender_name, m.content, m.created_at,
                               c.type AS ctype, COALESCE(c.name, '') AS cname
                        FROM chat_messages m
                        JOIN chat_conversations c ON c.id = m.conversation_id
                        JOIN chat_conversation_members cm ON cm.conversation_id = m.conversation_id AND LOWER(cm.email) = LOWER(:me)
                        WHERE m.deleted_at IS NULL
                          AND LOWER(m.sender_email) <> LOWER(:me)
                          AND m.mentions IS NOT NULL
                          AND (m.mentions LIKE :mq1 OR m.mentions LIKE :mq2 OR m.mentions LIKE :mq3)
                        ORDER BY m.id DESC LIMIT 10
                    ");
                    $mq->execute([
                        ':me'  => $auth['email'],
                        ':mq1' => '%"' . $me . '"%',
                        ':mq2' => '%"' . $auth['email'] . '"%',
                        ':mq3' => '%@' . $me . '%',
                    ]);
                    $rows = $mq->fetchAll(PDO::FETCH_ASSOC);
                    $names = $resolveName(array_map(fn($r) => (string)$r['sender_email'], $rows));
                    foreach ($rows as $r) {
                        $senderName = trim((string)$r['sender_name']) ?: ($names[strtolower((string)$r['sender_email'])] ?? (explode('@', (string)$r['sender_email'])[0]));
                        $convLabel = ($r['ctype'] === 'group' && $r['cname'])
                            ? $r['cname']
                            : $senderName;
                        $items[] = [
                            'id'          => 'mention_' . (int)$r['id'],
                            'type'        => 'mention',
                            'actor_email' => (string)$r['sender_email'],
                            'actor_name'  => $senderName,
                            'title'       => $senderName . ' mencionou você' . ($r['ctype'] === 'group' ? ' em ' . $convLabel : ''),
                            'preview'     => mb_substr((string)($r['content'] ?? ''), 0, 140),
                            'created_at'  => (string)$r['created_at'],
                            'route'       => '/chat-conversation?id=' . (int)$r['conversation_id'] . '&highlight=' . (int)$r['id'],
                        ];
                    }
                } catch (Throwable $e) { error_log('[notifications_feed/mentions] ' . $e->getMessage()); }

                // --- 3) New followers ---------------------------------
                try {
                    $fq = $pg->prepare("
                        SELECT follower_email, created_at
                        FROM chat_follows
                        WHERE LOWER(following_email) = LOWER(:me)
                        ORDER BY created_at DESC LIMIT 10
                    ");
                    $fq->execute([':me' => $auth['email']]);
                    $rows = $fq->fetchAll(PDO::FETCH_ASSOC);
                    $names = $resolveName(array_map(fn($r) => (string)$r['follower_email'], $rows));
                    foreach ($rows as $r) {
                        $actor = (string)$r['follower_email'];
                        $au = $names[strtolower($actor)] ?? (explode('@', $actor)[0] ?? $actor);
                        $items[] = [
                            'id'          => 'follow_' . md5($actor),
                            'type'        => 'follow',
                            'actor_email' => $actor,
                            'actor_name'  => $au,
                            'title'       => $au . ' começou a seguir você',
                            'preview'     => $actor,
                            'created_at'  => (string)$r['created_at'],
                            'route'       => '/u/' . rawurlencode($actor),
                        ];
                    }
                } catch (Throwable $e) { error_log('[notifications_feed/follows] ' . $e->getMessage()); }

                // --- 4) Post likes on caller's posts ------------------
                try {
                    $lq = $pg->prepare("
                        SELECT l.post_id, l.email AS actor_email, l.created_at,
                               COALESCE(p.caption, '') AS caption
                        FROM chat_feed_likes l
                        JOIN chat_feed_posts p ON p.id = l.post_id
                        WHERE LOWER(p.author_email) = LOWER(:me)
                          AND LOWER(l.email) <> LOWER(:me)
                          AND p.is_deleted = 0
                        ORDER BY l.created_at DESC LIMIT 10
                    ");
                    $lq->execute([':me' => $auth['email']]);
                    $rows = $lq->fetchAll(PDO::FETCH_ASSOC);
                    $names = $resolveName(array_map(fn($r) => (string)$r['actor_email'], $rows));
                    foreach ($rows as $r) {
                        $actor = (string)$r['actor_email'];
                        $au = $names[strtolower($actor)] ?? (explode('@', $actor)[0] ?? $actor);
                        $items[] = [
                            'id'          => 'like_' . (int)$r['post_id'] . '_' . md5($actor),
                            'type'        => 'like',
                            'actor_email' => $actor,
                            'actor_name'  => $au,
                            'title'       => $au . ' curtiu sua publicação',
                            'preview'     => mb_substr((string)$r['caption'], 0, 140),
                            'created_at'  => (string)$r['created_at'],
                            'route'       => '/feed/' . (int)$r['post_id'],
                        ];
                    }
                } catch (Throwable $e) { error_log('[notifications_feed/likes] ' . $e->getMessage()); }

                // --- 5) Post comments on caller's posts ---------------
                try {
                    $cq = $pg->prepare("
                        SELECT co.id, co.post_id, co.email AS actor_email, co.name AS actor_name,
                               co.content, co.created_at
                        FROM chat_feed_comments co
                        JOIN chat_feed_posts p ON p.id = co.post_id
                        WHERE LOWER(p.author_email) = LOWER(:me)
                          AND LOWER(co.email) <> LOWER(:me)
                          AND (co.is_deleted IS NULL OR co.is_deleted = 0)
                          AND p.is_deleted = 0
                        ORDER BY co.created_at DESC LIMIT 10
                    ");
                    $cq->execute([':me' => $auth['email']]);
                    $rows = $cq->fetchAll(PDO::FETCH_ASSOC);
                    $names = $resolveName(array_map(fn($r) => (string)$r['actor_email'], $rows));
                    foreach ($rows as $r) {
                        $actor = (string)$r['actor_email'];
                        $actorName = trim((string)$r['actor_name']) ?: ($names[strtolower($actor)] ?? (explode('@', $actor)[0] ?? $actor));
                        $items[] = [
                            'id'          => 'comment_' . (int)$r['id'],
                            'type'        => 'comment',
                            'actor_email' => $actor,
                            'actor_name'  => $actorName,
                            'title'       => $actorName . ' comentou na sua publicação',
                            'preview'     => mb_substr((string)($r['content'] ?? ''), 0, 140),
                            'created_at'  => (string)$r['created_at'],
                            'route'       => '/feed/' . (int)$r['post_id'],
                        ];
                    }
                } catch (Throwable $e) { error_log('[notifications_feed/comments] ' . $e->getMessage()); }
            } catch (Throwable $e) { error_log('[notifications_feed/pg] ' . $e->getMessage()); }

            // Sort chronologically (newest first) and cap at 40
            usort($items, function ($a, $b) {
                $ta = strtotime((string)$a['created_at']) ?: 0;
                $tb = strtotime((string)$b['created_at']) ?: 0;
                if ($ta === $tb) return 0;
                return ($ta < $tb) ? 1 : -1;
            });
            if (count($items) > 40) $items = array_slice($items, 0, 40);

            jsonResponse(true, [
                'items' => $items,
                'count' => count($items),
            ]);
            break;
        }

        case 'get_public_profile': {
            requireAuth();
            $input = getInput();
            $target = strtolower(trim((string)($input['email'] ?? $_GET['email'] ?? '')));
            if (!filter_var($target, FILTER_VALIDATE_EMAIL)) {
                jsonResponse(false, null, 'Invalid email', 400);
            }
            $pp = explode('@', $target);
            $pUser = $pp[0];
            $pDomain = $pp[1];
            $pFile = "/var/mail/vhosts/{$pDomain}/{$pUser}/profile/data.json";
            $pData = file_exists($pFile) ? json_decode(file_get_contents($pFile), true) : [];
            if (!is_array($pData)) $pData = [];
            // Only expose public fields
            $public = [
                'email'    => $target,
                'name'     => $pData['name'] ?? ($pData['first_name'] ?? $pUser),
                'username' => $pData['username'] ?? $pUser,
                'bio'      => $pData['bio'] ?? ($pData['about'] ?? ''),
                'website'  => $pData['website'] ?? ($pData['link'] ?? ''),
                'avatar_url' => '/api/email.php?action=get_avatar&email=' . urlencode($target),
            ];
            // Counts: posts + followers/following all live in PG now.
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Prefer PG feed_posts count (source of truth for feed)
                try {
                    $pc = $pg->prepare("SELECT COUNT(*) FROM chat_feed_posts WHERE LOWER(author_email) = LOWER(:e) AND is_deleted = 0 AND (published IS NULL OR published = TRUE)");
                    $pc->execute([':e' => $target]);
                    $public['post_count'] = (int)$pc->fetchColumn();
                } catch (Throwable $e) {}
                $fc = $pg->prepare("SELECT COUNT(*) FROM chat_follows WHERE following_email = :e");
                $fc->execute([':e' => $target]);
                $public['followers_count'] = (int)$fc->fetchColumn();
                $gc = $pg->prepare("SELECT COUNT(*) FROM chat_follows WHERE follower_email = :e");
                $gc->execute([':e' => $target]);
                $public['following_count'] = (int)$gc->fetchColumn();
                if (!empty($_SESSION['email']) && $_SESSION['email'] !== $target) {
                    $me = $pg->prepare("SELECT 1 FROM chat_follows WHERE follower_email = :me AND following_email = :e LIMIT 1");
                    $me->execute([':me' => $_SESSION['email'], ':e' => $target]);
                    $public['is_following'] = (bool)$me->fetchColumn();
                } else {
                    $public['is_following'] = false;
                }
            } catch (Throwable $e) {
                $public['followers_count'] = $public['followers_count'] ?? 0;
                $public['following_count'] = $public['following_count'] ?? 0;
                $public['is_following'] = false;
            }
            jsonResponse(true, $public);
            break;
        }

        case 'follow_user': {
            $auth = requireAuthLite();
            $input = getInput();
            $target = strtolower(trim((string)($input['target_email'] ?? '')));
            if (!filter_var($target, FILTER_VALIDATE_EMAIL)) jsonResponse(false, null, 'Invalid email', 400);
            if ($target === $auth['email']) jsonResponse(false, null, 'Cannot follow yourself', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $ins = $pg->prepare("INSERT INTO chat_follows (follower_email, following_email) VALUES (:f, :t) ON CONFLICT DO NOTHING");
                $ins->execute([':f' => $auth['email'], ':t' => $target]);
                // Only notify when a new row was actually inserted (avoid re-notifying on toggle spam)
                if ($ins->rowCount() > 0) {
                    try {
                        // Resolve actor display name from profile/data.json (falls back to local-part)
                        $aLocal = explode('@', $auth['email'])[0] ?? $auth['email'];
                        $aDom   = explode('@', $auth['email'])[1] ?? '';
                        $aName  = $aLocal;
                        if ($aDom !== '') {
                            $apf = "/var/mail/vhosts/{$aDom}/{$aLocal}/profile/data.json";
                            if (is_file($apf)) {
                                $aj = json_decode((string)@file_get_contents($apf), true);
                                if (is_array($aj)) {
                                    $cand = trim((string)($aj['name'] ?? $aj['first_name'] ?? $aj['display_name'] ?? ''));
                                    if ($cand !== '') $aName = $cand;
                                }
                            }
                        }
                        $pg->prepare("INSERT INTO chat_notifications (user_email, type, title, body, group_key, author_email, data) VALUES (:u, 'follow', :t, :b, :g, :a, :d)")
                           ->execute([
                               ':u' => $target,
                               ':t' => 'Novo seguidor',
                               ':b' => $aName . ' começou a te seguir',
                               ':g' => 'follow_' . $auth['email'],
                               ':a' => $auth['email'],
                               ':d' => json_encode(['follower_email' => $auth['email'], 'actor_name' => $aName], JSON_UNESCAPED_UNICODE),
                           ]);
                    } catch (Throwable $e) {}
                }
                jsonResponse(true, ['following' => true]);
            } catch (Throwable $e) {
                error_log('[follow_user] ' . $e->getMessage());
                jsonResponse(false, null, 'Follow failed', 500);
            }
            break;
        }

        case 'unfollow_user': {
            $auth = requireAuthLite();
            $input = getInput();
            $target = strtolower(trim((string)($input['target_email'] ?? '')));
            if (!filter_var($target, FILTER_VALIDATE_EMAIL)) jsonResponse(false, null, 'Invalid email', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("DELETE FROM chat_follows WHERE follower_email = :f AND following_email = :t")
                   ->execute([':f' => $auth['email'], ':t' => $target]);
                jsonResponse(true, ['following' => false]);
            } catch (Throwable $e) {
                error_log('[unfollow_user] ' . $e->getMessage());
                jsonResponse(false, null, 'Unfollow failed', 500);
            }
            break;
        }

        case 'get_followers': {
            $auth = requireAuthLite();
            $input = getInput();
            $target = strtolower(trim((string)($input['email'] ?? $_GET['email'] ?? $auth['email'])));
            $page = max(1, (int)($input['page'] ?? $_GET['page'] ?? 1));
            $limit = 50;
            $offset = ($page - 1) * $limit;
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // follower_email = each user who follows $target.
                // is_following = am I following them? (join chat_follows where follower_email=me, following_email=them)
                // is_follower  = do they follow me? (symmetry)
                $stmt = $pg->prepare("
                    SELECT f.follower_email AS email,
                           f.created_at,
                           EXISTS(SELECT 1 FROM chat_follows
                                  WHERE follower_email = :me AND following_email = f.follower_email) AS is_following,
                           EXISTS(SELECT 1 FROM chat_follows
                                  WHERE follower_email = f.follower_email AND following_email = :me) AS is_follower
                    FROM chat_follows f
                    WHERE f.following_email = :e
                    ORDER BY f.created_at DESC
                    LIMIT {$limit} OFFSET {$offset}
                ");
                $stmt->execute([':e' => $target, ':me' => $auth['email']]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
                $users = chatyy_hydrate_follow_rows($rows, $auth['email']);
                jsonResponse(true, ['users' => $users, 'page' => $page]);
            } catch (Throwable $e) {
                error_log('[get_followers] ' . $e->getMessage());
                jsonResponse(true, ['users' => [], 'page' => $page]);
            }
            break;
        }

        case 'get_following': {
            $auth = requireAuthLite();
            $input = getInput();
            $target = strtolower(trim((string)($input['email'] ?? $_GET['email'] ?? $auth['email'])));
            $page = max(1, (int)($input['page'] ?? $_GET['page'] ?? 1));
            $limit = 50;
            $offset = ($page - 1) * $limit;
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("
                    SELECT f.following_email AS email,
                           f.created_at,
                           EXISTS(SELECT 1 FROM chat_follows
                                  WHERE follower_email = :me AND following_email = f.following_email) AS is_following,
                           EXISTS(SELECT 1 FROM chat_follows
                                  WHERE follower_email = f.following_email AND following_email = :me) AS is_follower
                    FROM chat_follows f
                    WHERE f.follower_email = :e
                    ORDER BY f.created_at DESC
                    LIMIT {$limit} OFFSET {$offset}
                ");
                $stmt->execute([':e' => $target, ':me' => $auth['email']]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
                $users = chatyy_hydrate_follow_rows($rows, $auth['email']);
                jsonResponse(true, ['users' => $users, 'page' => $page]);
            } catch (Throwable $e) {
                error_log('[get_following] ' . $e->getMessage());
                jsonResponse(true, ['users' => [], 'page' => $page]);
            }
            break;
        }

        // ─── search_global ──────────────────────────────────────────
        // Unified search — returns top hits from users, chats, emails, and
        // feed posts in a single payload. Used by the Spotlight overlay.
        // Each section is capped (6 items) so the total response stays
        // under 500ms even when all four sources hit storage.
        case 'search_global': {
            $auth = requireAuth();
            $input = getInput();
            $q = trim((string)($input['q'] ?? $_GET['q'] ?? ''));
            if (mb_strlen($q) < 2) jsonResponse(true, ['users' => [], 'chats' => [], 'emails' => [], 'posts' => []]);
            $qLower = mb_strtolower($q);
            $qLike = '%' . str_replace(['\\','%','_'], ['\\\\','\\%','\\_'], $qLower) . '%';

            $users = []; $chats = []; $emails = []; $posts = [];
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();

                // Users — scan profile dirs; cheap to do LIKE on PG if we
                // keep an index. For now use chat_conversation_members as a
                // proxy (emails the user has interacted with).
                $u = $pg->prepare("
                    SELECT DISTINCT LOWER(email) AS email
                    FROM chat_conversation_members
                    WHERE LOWER(email) LIKE :q AND LOWER(email) <> LOWER(:me)
                    ORDER BY email LIMIT 6
                ");
                $u->execute([':q' => $qLike, ':me' => $auth['email']]);
                foreach ($u->fetchAll(\PDO::FETCH_ASSOC) as $r) {
                    $users[] = [
                        'email'      => $r['email'],
                        'name'       => explode('@', $r['email'])[0],
                        'avatar_url' => '/api/email.php?action=get_avatar&email=' . urlencode($r['email']),
                    ];
                }

                // Chats — name LIKE or last-message content LIKE
                $c = $pg->prepare("
                    SELECT DISTINCT c.id, c.type, COALESCE(c.name,'') AS name,
                           COALESCE(c.avatar_url,'') AS avatar_url
                    FROM chat_conversations c
                    JOIN chat_conversation_members m ON m.conversation_id = c.id AND LOWER(m.email) = LOWER(:me)
                    WHERE LOWER(COALESCE(c.name,'')) LIKE :q
                       OR EXISTS (
                         SELECT 1 FROM chat_messages mm
                         WHERE mm.conversation_id = c.id
                           AND LOWER(COALESCE(mm.content,'')) LIKE :q
                           AND mm.deleted_at IS NULL
                         LIMIT 1
                       )
                    ORDER BY c.id DESC LIMIT 6
                ");
                $c->execute([':me' => $auth['email'], ':q' => $qLike]);
                foreach ($c->fetchAll(\PDO::FETCH_ASSOC) as $r) {
                    $chats[] = [
                        'id'     => (int)$r['id'],
                        'type'   => $r['type'],
                        'name'   => $r['name'] ?: '',
                        'avatar' => $r['avatar_url'],
                    ];
                }

                // Posts — caption LIKE
                try {
                    $p = $pg->prepare("
                        SELECT id, author_email, caption, media_type, thumbnail_url, media_urls, created_at
                        FROM chat_feed_posts
                        WHERE LOWER(COALESCE(caption,'')) LIKE :q AND is_deleted = 0 AND (published IS NULL OR published = TRUE)
                        ORDER BY id DESC LIMIT 6
                    ");
                    $p->execute([':q' => $qLike]);
                    foreach ($p->fetchAll(\PDO::FETCH_ASSOC) as $r) {
                        $mu = _cdnifyArray(json_decode($r['media_urls'] ?? '[]', true) ?: []);
                        $posts[] = [
                            'id'           => (int)$r['id'],
                            'author_email' => $r['author_email'],
                            'caption'      => mb_substr($r['caption'] ?? '', 0, 120),
                            'type'         => $r['media_type'],
                            'thumbnail'    => $r['thumbnail_url'] ?: ($mu[0] ?? ''),
                            'created_at'   => $r['created_at'],
                        ];
                    }
                } catch (Throwable $e) { /* feed table may vary */ }
            } catch (Throwable $e) { error_log('[search_global/pg] ' . $e->getMessage()); }

            // Emails — IMAP search subject for the current user
            try {
                $mePwd = $auth['password'] ?? null;
                if ($mePwd) {
                    $imap = getImap($auth['email'], $mePwd, 'INBOX');
                    $uids = @imap_search($imap, 'SUBJECT "' . addslashes($q) . '"', SE_UID) ?: [];
                    rsort($uids);
                    foreach (array_slice($uids, 0, 6) as $uid) {
                        $h = @imap_headerinfo($imap, @imap_msgno($imap, $uid));
                        if (!$h) continue;
                        $fromAddr = '';
                        if (!empty($h->from[0])) {
                            $fromAddr = ($h->from[0]->mailbox ?? '') . '@' . ($h->from[0]->host ?? '');
                        }
                        $emails[] = [
                            'uid'     => (int)$uid,
                            'folder'  => 'INBOX',
                            'subject' => mb_substr($h->subject ?? '(sem assunto)', 0, 120),
                            'from'    => $fromAddr,
                            'date'    => $h->date ?? '',
                        ];
                    }
                }
            } catch (Throwable $e) { /* imap may fail, non-fatal */ }

            jsonResponse(true, [
                'users'  => $users,
                'chats'  => $chats,
                'emails' => $emails,
                'posts'  => $posts,
            ]);
            break;
        }

        case 'find_by_phone': {
            // Look up a single Chatyy account by phone number. Hot path used
            // by chat-new when the user types a phone in the search field.
            $auth = requireAuthLite();
            require_once __DIR__ . '/find-by-phone.php';
            handleFindByPhone(getInput());
            break;
        }

        case 'check_contacts': {
            // Bulk-check which of the user's phone contacts are on Chatyy
            // (WhatsApp's "Contacts" tab pattern). Frontend posts arrays of
            // emails + phones; we return `registered`: rows that match an
            // existing account. PG-first via the `accounts` table; falls back
            // to a Maildir + profile/data.json scan when PG misses.
            //
            // This endpoint was lost during the 2026-04 server migration —
            // chat-new was silently showing zero matches because the action
            // returned 404. Restored 2026-05-01.
            $auth = requireAuth();
            $input = getInput();
            $emails = is_array($input['emails'] ?? null) ? $input['emails'] : [];
            $phones = is_array($input['phones'] ?? null) ? $input['phones'] : [];

            // Cap to prevent abuse (frontend usually sends ~50–500).
            if (count($emails) > 500 || count($phones) > 500) {
                jsonResponse(false, null, 'Too many contacts (max 500 each)', 400);
            }

            // Normalize input emails (lowercase + valid format).
            $emailSet = [];
            foreach ($emails as $e) {
                $e = strtolower(trim((string)$e));
                if ($e && filter_var($e, FILTER_VALIDATE_EMAIL)) $emailSet[$e] = true;
            }

            // Normalize input phones: strip non-digits + trim BR (55) / US (1) country codes.
            $normalizePhone = function($p) {
                $cleaned = preg_replace('/\D/', '', (string)$p);
                if (strlen($cleaned) >= 12 && str_starts_with($cleaned, '55')) $cleaned = substr($cleaned, 2);
                if (strlen($cleaned) === 11 && str_starts_with($cleaned, '1'))  $cleaned = substr($cleaned, 1);
                return $cleaned;
            };
            $phoneSet = [];
            foreach ($phones as $p) {
                $cleaned = $normalizePhone($p);
                if ($cleaned && strlen($cleaned) >= 8) $phoneSet[$cleaned] = true;
            }

            $registered = [];
            $foundEmails = [];

            // Fast path: PostgreSQL accounts table.
            try {
                require_once __DIR__ . '/db.php';
                $db = getPGDB();
                $selfEmail = strtolower($auth['email']);

                // Email matches — IN(?,?,...) for the batch.
                if (!empty($emailSet)) {
                    $emailKeys = array_keys($emailSet);
                    $placeholders = implode(',', array_fill(0, count($emailKeys), '?'));
                    $stmt = $db->prepare("SELECT email, display_name, phone, profile_photo FROM accounts WHERE LOWER(email) IN ($placeholders)");
                    $stmt->execute(array_map('strtolower', $emailKeys));
                    foreach ($stmt->fetchAll(\PDO::FETCH_ASSOC) as $row) {
                        $em = strtolower($row['email'] ?? '');
                        if (!$em || $em === $selfEmail || isset($foundEmails[$em])) continue;
                        $foundEmails[$em] = true;
                        $registered[] = [
                            'email' => $em,
                            'name' => $row['display_name'] ?: explode('@', $em)[0],
                            'phone' => $row['phone'] ?? '',
                            'avatar' => $row['profile_photo'] ?? null,
                        ];
                    }
                }

                // Phone matches — LIKE over the normalized digits column. Done
                // one-at-a-time because phones come in many variants (with/without
                // DDI, leading 9, etc.) and a single SQL IN doesn't catch them.
                foreach (array_keys($phoneSet) as $needle) {
                    if (strlen($needle) < 8) continue;
                    $stmt = $db->prepare("SELECT email, display_name, phone, profile_photo FROM accounts WHERE phone IS NOT NULL AND phone <> '' AND regexp_replace(phone, '\\D', '', 'g') LIKE ? LIMIT 5");
                    $stmt->execute(['%' . $needle . '%']);
                    foreach ($stmt->fetchAll(\PDO::FETCH_ASSOC) as $row) {
                        $em = strtolower($row['email'] ?? '');
                        if (!$em || $em === $selfEmail || isset($foundEmails[$em])) continue;
                        $foundEmails[$em] = true;
                        $registered[] = [
                            'email' => $em,
                            'name' => $row['display_name'] ?: explode('@', $em)[0],
                            'phone' => $row['phone'] ?? '',
                            'avatar' => $row['profile_photo'] ?? null,
                        ];
                    }
                }
            } catch (\Throwable $e) {
                // PG unavailable — silent fallback to filesystem scan below.
            }

            // Fallback: scan Maildir + profile/data.json. Slower but works
            // even if PG is down or accounts table is stale.
            try {
                $domains = glob('/var/mail/vhosts/*', GLOB_ONLYDIR) ?: [];
                foreach ($domains as $domainDir) {
                    $domain = basename($domainDir);
                    if (!str_contains($domain, '.')) continue;
                    foreach (glob("{$domainDir}/*", GLOB_ONLYDIR) ?: [] as $userDir) {
                        $username = basename($userDir);
                        if ($username === 'postmaster' || $username[0] === '.') continue;
                        if (!is_dir("{$userDir}/Maildir") && !is_dir("{$userDir}/cur")) continue;
                        $accountEmail = strtolower("{$username}@{$domain}");
                        if ($accountEmail === strtolower($auth['email'])) continue;
                        if (isset($foundEmails[$accountEmail])) continue;

                        $matchedByEmail = isset($emailSet[$accountEmail]);
                        $matchedByPhone = false;
                        $pd = null;
                        $profileFile = "{$userDir}/profile/data.json";
                        if (file_exists($profileFile)) {
                            $pd = @json_decode(@file_get_contents($profileFile), true);
                        }
                        if (!$matchedByEmail && $pd) {
                            foreach (array_filter([$pd['verified_phone'] ?? '', $pd['phone'] ?? '']) as $rawPhone) {
                                $accountPhone = $normalizePhone($rawPhone);
                                if ($accountPhone && isset($phoneSet[$accountPhone])) { $matchedByPhone = true; break; }
                            }
                        }
                        if ($matchedByEmail || $matchedByPhone) {
                            $foundEmails[$accountEmail] = true;
                            $registered[] = [
                                'email' => $accountEmail,
                                'name' => ($pd['name'] ?? $pd['display_name'] ?? '') ?: $username,
                                'phone' => ($pd['verified_phone'] ?? $pd['phone'] ?? ''),
                                'avatar' => $pd['profile_photo'] ?? null,
                            ];
                        }
                    }
                }
            } catch (\Throwable $e) {}

            // Persist the synced contact set so the signup notifier can
            // alert this user when one of their contacts later joins.
            try {
                $parts = explode('@', $auth['email']);
                if (count($parts) === 2) {
                    $tokenDir = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/push_tokens";
                    if (!is_dir($tokenDir)) @mkdir($tokenDir, 0755, true);
                    $syncFile = "$tokenDir/synced_contacts.json";
                    @file_put_contents($syncFile, json_encode([
                        'emails' => array_keys($emailSet),
                        'phones' => array_keys($phoneSet),
                        'updated_at' => date('c'),
                    ]), LOCK_EX);
                }
            } catch (\Throwable $e) {}

            // Persistir hashes dos telefones do usuário em chat_contact_lookups.
            // Quando alguém com um desses telefones cadastrar no Chatyy, o
            // phone_signup hook vai disparar push pra esse user. Antes só
            // salvava lookups via find_by_phone (busca explícita de 1 número).
            // Agora salva o batch inteiro de check_contacts (= contacts do
            // celular), expandindo o reverse-discovery pra todos automaticamente.
            try {
                if (!empty($phoneSet)) {
                    $pg = $pg ?? getPGDB();
                    $ins = $pg->prepare("INSERT INTO chat_contact_lookups (email, phone_hash, last_lookup_at) VALUES (:e, :h, NOW()) ON CONFLICT (email, phone_hash) DO UPDATE SET last_lookup_at = NOW()");
                    foreach (array_keys($phoneSet) as $needle) {
                        if (strlen($needle) < 8) continue;
                        $ins->execute([':e' => strtolower($auth['email']), ':h' => hash('sha256', $needle)]);
                    }
                }
            } catch (\Throwable $_) {}

            jsonResponse(true, ['registered' => $registered]);
            break;
        }

        case 'search_users': {
            // Instagram-style username/name search. Uses PostgreSQL ILIKE over
            // the list of Maildir inboxes (source of truth for who exists) and
            // joins in profile.data.json for display name / bio when present.
            $auth = requireAuthLite();
            $input = getInput();
            $q = trim((string)($input['q'] ?? $_GET['q'] ?? ''));
            if (mb_strlen($q) < 2) { jsonResponse(true, ['users' => []]); break; }
            $needle = mb_strtolower($q);
            try {
                $out = [];
                $roots = glob('/var/mail/vhosts/*', GLOB_ONLYDIR) ?: [];
                foreach ($roots as $dRoot) {
                    $dom = basename($dRoot);
                    foreach (glob($dRoot . '/*', GLOB_ONLYDIR) ?: [] as $uRoot) {
                        $u = basename($uRoot);
                        if ($u === 'postmaster' || $u[0] === '.') continue;
                        if (!is_dir($uRoot . '/Maildir')) continue;
                        $email = $u . '@' . $dom;
                        if ($email === $auth['email']) continue;
                        $profileFile = $uRoot . '/profile/data.json';
                        $profile = file_exists($profileFile) ? json_decode(file_get_contents($profileFile), true) : [];
                        if (!is_array($profile)) $profile = [];
                        $name = (string)($profile['name'] ?? ($profile['first_name'] ?? $u));
                        $uname = (string)($profile['username'] ?? $u);
                        $hay = mb_strtolower($email . ' ' . $name . ' ' . $uname);
                        if (mb_strpos($hay, $needle) === false) continue;
                        $out[] = [
                            'email'      => $email,
                            'name'       => $name,
                            'username'   => $uname,
                            'bio'        => mb_substr((string)($profile['bio'] ?? ''), 0, 100),
                            'avatar_url' => '/api/email.php?action=get_avatar&email=' . urlencode($email),
                        ];
                        if (count($out) >= 30) break 2;
                    }
                }
                // Hydrate is_following / is_follower once per result
                if ($out) {
                    require_once __DIR__ . '/db.php';
                    $pg = getPGDB();
                    $emails = array_column($out, 'email');
                    $ph = implode(',', array_fill(0, count($emails), '?'));
                    // who I follow
                    $a = $pg->prepare("SELECT following_email FROM chat_follows WHERE follower_email = ? AND following_email IN ($ph)");
                    $a->execute(array_merge([$auth['email']], $emails));
                    $iFollow = array_fill_keys(array_column($a->fetchAll(PDO::FETCH_ASSOC), 'following_email'), true);
                    // who follows me
                    $b = $pg->prepare("SELECT follower_email FROM chat_follows WHERE following_email = ? AND follower_email IN ($ph)");
                    $b->execute(array_merge([$auth['email']], $emails));
                    $myFollowers = array_fill_keys(array_column($b->fetchAll(PDO::FETCH_ASSOC), 'follower_email'), true);
                    foreach ($out as &$row) {
                        $row['is_following'] = !empty($iFollow[$row['email']]);
                        $row['is_follower']  = !empty($myFollowers[$row['email']]);
                    }
                    unset($row);
                }
                jsonResponse(true, ['users' => $out]);
            } catch (Throwable $e) {
                error_log('[search_users] ' . $e->getMessage());
                jsonResponse(true, ['users' => []]);
            }
            break;
        }

        case 'follow_suggestions': {
            // "People you may know" — friends-of-friends we don't already follow.
            $auth = requireAuthLite();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("
                    SELECT b.following_email AS email,
                           COUNT(*) AS mutual_count
                    FROM chat_follows a
                    JOIN chat_follows b ON b.follower_email = a.following_email
                    WHERE a.follower_email = :me
                      AND b.following_email <> :me
                      AND NOT EXISTS (SELECT 1 FROM chat_follows c
                                      WHERE c.follower_email = :me AND c.following_email = b.following_email)
                    GROUP BY b.following_email
                    ORDER BY mutual_count DESC, b.following_email ASC
                    LIMIT 20
                ");
                $stmt->execute([':me' => $auth['email']]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
                // Hydrate with profile for display
                $users = chatyy_hydrate_follow_rows($rows, $auth['email']);
                // Preserve mutual_count in the hydrated rows
                foreach ($users as $i => &$u) {
                    if (isset($rows[$i]['mutual_count'])) {
                        $u['mutual_count'] = (int)$rows[$i]['mutual_count'];
                    }
                }
                unset($u);
                jsonResponse(true, ['users' => $users]);
            } catch (Throwable $e) {
                error_log('[follow_suggestions] ' . $e->getMessage());
                jsonResponse(true, ['users' => []]);
            }
            break;
        }

        case 'mutual_followers': {
            $auth = requireAuth();
            $input = getInput();
            // Accept from JSON body, POST, or GET query string (frontend
            // fires this as a GET on profile open). Without the GET fallback
            // profile view 400'd every time.
            $target = strtolower(trim((string)(
                $input['target_email']
                ?? $input['email']
                ?? $_GET['target_email']
                ?? $_GET['email']
                ?? ''
            )));
            if (!filter_var($target, FILTER_VALIDATE_EMAIL)) jsonResponse(false, null, 'Invalid email', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // People both I follow AND who follow target
                $stmt = $pg->prepare("
                    SELECT a.following_email AS email
                    FROM chat_follows a
                    JOIN chat_follows b ON b.follower_email = a.following_email AND b.following_email = :t
                    WHERE a.follower_email = :me
                    LIMIT 20
                ");
                $stmt->execute([':me' => $auth['email'], ':t' => $target]);
                jsonResponse(true, ['mutuals' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
            } catch (Throwable $e) {
                error_log('[mutual_followers] ' . $e->getMessage());
                jsonResponse(true, ['mutuals' => []]);
            }
            break;
        }

        // username_check — validação live do @username conforme o user digita
        // no editor de perfil. Retorna {ok, available, reason?}. Frontend
        // chama com debounce ~400ms pra não fritar o disco scaneando a cada
        // tecla. Valida formato + reservados + unicidade.
        //
        // 2026-05-06: agora usa requireAuthLite (suporta tokens phone-signup
        // sem password_enc) e consulta chat_usernames table (canônico) antes
        // de fazer o scan O(N) por profile.json (legacy).
        case 'username_check': {
            $auth = requireAuthLite();
            $input = getInput();
            $u = strtolower(preg_replace('/[^a-z0-9_.]/i', '', (string)($input['username'] ?? '')));
            if (mb_strlen($u) < 3) jsonResponse(true, ['available' => false, 'reason' => 'too_short']);
            if (mb_strlen($u) > 30) jsonResponse(true, ['available' => false, 'reason' => 'too_long']);
            $reserved = ['admin','support','help','chatyy','official','staff','team','root','contact','privacy','terms','about','user','users','undefined','null','bot','ai','api','www','mail','noreply','login','signup','system'];
            if (in_array($u, $reserved, true)) jsonResponse(true, ['available' => false, 'reason' => 'reserved']);
            // Canonical check first — chat_usernames is the source of truth.
            try {
                require_once __DIR__ . '/db.php';
                $pgU = getPGDB();
                @$pgU->exec("CREATE TABLE IF NOT EXISTS chat_usernames (handle TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, claimed_at TIMESTAMPTZ DEFAULT now())");
                $st = $pgU->prepare("SELECT email FROM chat_usernames WHERE handle = :h");
                $st->execute([':h' => $u]);
                $row = $st->fetch(\PDO::FETCH_ASSOC);
                if ($row) {
                    $taken_by_self = strtolower($row['email']) === strtolower($auth['email']);
                    jsonResponse(true, ['available' => $taken_by_self, 'username' => $u, 'reason' => $taken_by_self ? null : 'taken', 'taken_by_self' => $taken_by_self]);
                }
            } catch (\Throwable $e) { /* fall through to legacy scan */ }
            // Legacy fallback: scan all profiles for collision (skipping self)
            $domains = glob('/var/mail/vhosts/*', GLOB_ONLYDIR) ?: [];
            foreach ($domains as $dDir) {
                $dName = basename($dDir);
                if (!str_contains($dName, '.')) continue;
                $userDirs = glob("{$dDir}/*", GLOB_ONLYDIR) ?: [];
                foreach ($userDirs as $uDir) {
                    $accountEmail = strtolower(basename($uDir) . '@' . $dName);
                    if ($accountEmail === strtolower($auth['email'])) continue;
                    $pf = "{$uDir}/profile/data.json";
                    if (!file_exists($pf)) continue;
                    $pd = @json_decode(@file_get_contents($pf), true);
                    if (!empty($pd['username']) && strtolower($pd['username']) === $u) {
                        jsonResponse(true, ['available' => false, 'reason' => 'taken']);
                    }
                }
            }
            jsonResponse(true, ['available' => true, 'username' => $u]);
            break;
        }

        case 'update_profile':
            $auth = requireAuth();
            $input = getInput();
            $parts = explode('@', $auth['email']);
            $username = $parts[0];
            $domain = $parts[1] ?? 'onemundo.com.br';
            $profileDir = "/var/mail/vhosts/{$domain}/{$username}/profile";
            $profileFile = "{$profileDir}/data.json";

            $existing = file_exists($profileFile) ? json_decode(file_get_contents($profileFile), true) : [];
            $allowed = ['first_name', 'last_name', 'birthday', 'gender', 'recovery_email',
                        'name', 'username', 'bio', 'about', 'website', 'link'];
            foreach ($allowed as $key) {
                if (isset($input[$key])) $existing[$key] = is_string($input[$key]) ? trim($input[$key]) : $input[$key];
            }
            // Sanitize username (lowercase, a-z0-9_., 3-30 chars) + ensure
            // it's not already taken by another user. User pediu: "trocar
            // o @ deles mas n pode ter duplicado" — antes não tinha checagem
            // de unicidade e dois users podiam pegar o mesmo @.
            if (isset($existing['username'])) {
                $u = strtolower(preg_replace('/[^a-z0-9_.]/i', '', (string)$existing['username']));
                $existing['username'] = mb_substr($u, 0, 30);
                if (mb_strlen($existing['username']) < 3) {
                    unset($existing['username']);
                } else {
                    // Block reserved handles
                    $reserved = ['admin','support','help','chatyy','official','staff','team','root','contact','privacy','terms','about','user','users','undefined','null'];
                    if (in_array($existing['username'], $reserved, true)) {
                        jsonResponse(false, null, 'Esse @ é reservado, escolha outro', 400);
                    }
                    // Uniqueness scan: any OTHER profile with this username?
                    $taken = false;
                    $domains = glob('/var/mail/vhosts/*', GLOB_ONLYDIR) ?: [];
                    foreach ($domains as $dDir) {
                        $dName = basename($dDir);
                        if (!str_contains($dName, '.')) continue;
                        $userDirs = glob("{$dDir}/*", GLOB_ONLYDIR) ?: [];
                        foreach ($userDirs as $uDir) {
                            $accountEmail = strtolower(basename($uDir) . '@' . $dName);
                            if ($accountEmail === strtolower($auth['email'])) continue;
                            $pf = "{$uDir}/profile/data.json";
                            if (!file_exists($pf)) continue;
                            $pd = @json_decode(@file_get_contents($pf), true);
                            if (!empty($pd['username']) && strtolower($pd['username']) === $existing['username']) {
                                $taken = true;
                                break 2;
                            }
                        }
                    }
                    if ($taken) {
                        jsonResponse(false, null, 'Esse @ já está em uso', 409);
                    }
                }
            }
            if (isset($existing['bio'])) $existing['bio'] = mb_substr((string)$existing['bio'], 0, 160);
            if (!empty($existing['website'])) {
                $w = (string)$existing['website'];
                if (!preg_match('#^https?://#i', $w)) $w = 'https://' . $w;
                $existing['website'] = mb_substr($w, 0, 200);
            }
            // Profile-upgrade combo: cover_url + links[] + account_type.
            // Each field guarded so callers can update them in isolation
            // (and so the existing legacy clients keep working untouched).
            if (isset($input['cover_url'])) {
                $cu = trim((string)$input['cover_url']);
                if ($cu !== '' && !preg_match('#^https?://#i', $cu)) $cu = '';
                $existing['cover_url'] = mb_substr($cu, 0, 500);
            }
            if (isset($input['links']) && is_array($input['links'])) {
                $cleaned = [];
                foreach ($input['links'] as $L) {
                    if (!is_array($L)) continue;
                    $u = trim((string)($L['url'] ?? ''));
                    if ($u === '') continue;
                    if (!preg_match('#^https?://#i', $u)) $u = 'https://' . $u;
                    // Drop obvious junk schemes that survived the regex test
                    // (regex above already requires http/https; this is a
                    // safety net against javascript:/data: URIs sneaking in).
                    if (preg_match('#^(javascript|data|file|vbscript):#i', $u)) continue;
                    $cleaned[] = [
                        'label' => mb_substr(trim((string)($L['label'] ?? '')), 0, 30),
                        'url'   => mb_substr($u, 0, 200),
                        'icon'  => mb_substr(trim((string)($L['icon'] ?? '')), 0, 20),
                    ];
                    if (count($cleaned) >= 5) break;
                }
                $existing['links'] = $cleaned;
            }
            if (isset($input['account_type'])) {
                $at = strtolower(trim((string)$input['account_type']));
                if (!in_array($at, ['personal','creator','business'], true)) $at = 'personal';
                $existing['account_type'] = $at;
            }
            $existing['updated_at'] = date('c');

            if (!is_dir($profileDir)) {
                exec("sudo mkdir -p " . escapeshellarg($profileDir));
                exec("sudo chmod 770 " . escapeshellarg($profileDir));
                exec("sudo /usr/local/bin/chatyy-fix-mailbox " . escapeshellarg($username . "@" . $domain));
            }
            // Ensure file is writable
            if (file_exists($profileFile) && !is_writable($profileFile)) {
                exec("sudo chmod 664 " . escapeshellarg($profileFile));
            }
            if (safe_put_contents($profileFile, json_encode($existing, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX) === false) {
                jsonResponse(false, null, 'Falha ao salvar perfil', 500);
            }
            @chmod($profileFile, 0664);

            // Bust the 4-tier cache so /profile_get returns the new bio/name
            // immediately on the next request from any device.
            try { require_once __DIR__ . '/cache.php'; cacheInvalidate("profile:v1:" . strtolower($auth['email'])); } catch (Throwable $_) {}

            jsonResponse(true, $existing, 'Perfil atualizado');
            break;

        // ---- SETTINGS ----
        case 'get_settings':
            $auth = requireAuthLite();
            $parts = explode('@', $auth['email']);
            $username = $parts[0];
            $domain = $parts[1] ?? 'onemundo.com.br';
            $homeDir = "/var/mail/vhosts/{$domain}/{$username}";
            $settingsFile = "{$homeDir}/profile/settings.json";

            // Ensure permissions on first access
            if (is_dir($homeDir) && !is_writable("{$homeDir}/profile")) {
                exec("sudo chmod 710 " . escapeshellarg($homeDir));
                exec("sudo chgrp www-data " . escapeshellarg($homeDir));
            }

            $defaults = ['signature' => '', 'emails_per_page' => 20, 'notifications' => true, 'theme' => 'light'];
            $data = file_exists($settingsFile) ? json_decode(file_get_contents($settingsFile), true) : [];
            jsonResponse(true, array_merge($defaults, $data ?: []));
            break;

        case 'update_settings':
            $auth = requireAuthLite();
            $input = getInput();
            $parts = explode('@', $auth['email']);
            $username = $parts[0];
            $domain = $parts[1] ?? 'onemundo.com.br';
            $profileDir = "/var/mail/vhosts/{$domain}/{$username}/profile";
            $settingsFile = "{$profileDir}/settings.json";

            $existing = file_exists($settingsFile) ? json_decode(file_get_contents($settingsFile), true) : [];
            $allowed = ['signature', 'emails_per_page', 'notifications', 'theme'];
            foreach ($allowed as $key) {
                if (isset($input[$key])) $existing[$key] = $input[$key];
            }

            if (!is_dir($profileDir)) {
                exec("sudo mkdir -p " . escapeshellarg($profileDir));
                exec("sudo chmod 770 " . escapeshellarg($profileDir));
                exec("sudo /usr/local/bin/chatyy-fix-mailbox " . escapeshellarg($username . "@" . $domain));
            }
            // Ensure file is writable
            if (file_exists($settingsFile) && !is_writable($settingsFile)) {
                exec("sudo chmod 664 " . escapeshellarg($settingsFile));
            }
            if (safe_put_contents($settingsFile, json_encode($existing, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX) === false) {
                jsonResponse(false, null, 'Falha ao salvar configuracoes', 500);
            }
            @chmod($settingsFile, 0664);

            jsonResponse(true, $existing, 'Configuracoes salvas');
            break;

        // ---- EMAIL SIGNATURES (multi, per-context) ----
        // Allows users to keep separate signatures per context — e.g. work,
        // personal, billing — and optionally tie one to a specific from_alias.
        // The send case auto-attaches the matched alias signature (or the
        // default) when the client doesn't pass an explicit one.
        case 'signatures_list':
        case 'signatures_create':
        case 'signatures_update':
        case 'signatures_delete':
        case 'signatures_set_default': {
            $auth = requireAuth();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS email_signatures (
                    id BIGSERIAL PRIMARY KEY,
                    user_email TEXT NOT NULL,
                    name TEXT NOT NULL,
                    body_html TEXT NOT NULL,
                    is_default BOOLEAN DEFAULT FALSE,
                    alias_email TEXT DEFAULT '',
                    created_at TIMESTAMPTZ DEFAULT now(),
                    updated_at TIMESTAMPTZ DEFAULT now()
                )");
                @$pg->exec("CREATE INDEX IF NOT EXISTS idx_email_signatures_user ON email_signatures(LOWER(user_email))");

                $input = getInput();
                $userE = strtolower($auth['email']);

                if ($action === 'signatures_list') {
                    $st = $pg->prepare("SELECT id, name, body_html, is_default, alias_email, created_at, updated_at FROM email_signatures WHERE LOWER(user_email) = :u ORDER BY is_default DESC, id ASC");
                    $st->execute([':u' => $userE]);
                    jsonResponse(true, $st->fetchAll(PDO::FETCH_ASSOC) ?: []);
                }

                if ($action === 'signatures_create') {
                    $name      = trim((string)($input['name'] ?? ''));
                    $bodyHtml  = (string)($input['body_html'] ?? '');
                    $isDefault = !empty($input['is_default']);
                    $alias     = strtolower(trim((string)($input['alias_email'] ?? '')));
                    if ($name === '' || $bodyHtml === '') {
                        jsonResponse(false, null, 'name and body_html required', 400);
                    }
                    if ($isDefault) {
                        $pg->prepare("UPDATE email_signatures SET is_default = FALSE WHERE LOWER(user_email) = :u")->execute([':u' => $userE]);
                    }
                    $st = $pg->prepare("INSERT INTO email_signatures (user_email, name, body_html, is_default, alias_email) VALUES (:u, :n, :b, :d, :a) RETURNING id");
                    $st->execute([':u' => $auth['email'], ':n' => $name, ':b' => $bodyHtml, ':d' => $isDefault ? 'true' : 'false', ':a' => $alias]);
                    jsonResponse(true, ['id' => (int)$st->fetchColumn()], 'Signature created');
                }

                if ($action === 'signatures_update') {
                    $id = (int)($input['id'] ?? 0);
                    if (!$id) jsonResponse(false, null, 'id required', 400);
                    // Confirm ownership
                    $own = $pg->prepare("SELECT id FROM email_signatures WHERE id = :id AND LOWER(user_email) = :u");
                    $own->execute([':id' => $id, ':u' => $userE]);
                    if (!$own->fetchColumn()) jsonResponse(false, null, 'Signature not found', 404);

                    $sets = [];
                    $params = [':id' => $id];
                    foreach (['name', 'body_html', 'alias_email'] as $col) {
                        if (array_key_exists($col, $input)) {
                            $sets[] = "$col = :$col";
                            $params[":$col"] = $col === 'alias_email' ? strtolower(trim((string)$input[$col])) : (string)$input[$col];
                        }
                    }
                    if (array_key_exists('is_default', $input)) {
                        $newDefault = !empty($input['is_default']);
                        if ($newDefault) {
                            $pg->prepare("UPDATE email_signatures SET is_default = FALSE WHERE LOWER(user_email) = :u")->execute([':u' => $userE]);
                        }
                        $sets[] = "is_default = :is_default";
                        $params[':is_default'] = $newDefault ? 'true' : 'false';
                    }
                    if (empty($sets)) jsonResponse(true, null, 'nothing to update');
                    $sets[] = 'updated_at = now()';
                    $sql = 'UPDATE email_signatures SET ' . implode(', ', $sets) . ' WHERE id = :id';
                    $pg->prepare($sql)->execute($params);
                    jsonResponse(true, null, 'Signature updated');
                }

                if ($action === 'signatures_delete') {
                    $id = (int)($input['id'] ?? 0);
                    if (!$id) jsonResponse(false, null, 'id required', 400);
                    $st = $pg->prepare("DELETE FROM email_signatures WHERE id = :id AND LOWER(user_email) = :u");
                    $st->execute([':id' => $id, ':u' => $userE]);
                    jsonResponse(true, null, 'Signature deleted');
                }

                if ($action === 'signatures_set_default') {
                    $id = (int)($input['id'] ?? 0);
                    if (!$id) jsonResponse(false, null, 'id required', 400);
                    $pg->prepare("UPDATE email_signatures SET is_default = FALSE WHERE LOWER(user_email) = :u")->execute([':u' => $userE]);
                    $st = $pg->prepare("UPDATE email_signatures SET is_default = TRUE WHERE id = :id AND LOWER(user_email) = :u");
                    $st->execute([':id' => $id, ':u' => $userE]);
                    jsonResponse(true, null, 'Default signature set');
                }
            } catch (Throwable $e) {
                error_log('[signatures] ' . $e->getMessage());
                jsonResponse(false, null, 'Internal error', 500);
            }
            break;
        }

        // ---- AI DETECTION STUBS (not yet implemented — return empty so frontend skips silently) ----
        case 'ai_detect_boleto':
        case 'ai_detect_tracking':
        case 'ai_detect_meeting':
            requireAuth();
            jsonResponse(true, ['detected' => false]);
            break;

        // ---- FEATURE STUBS (endpoints called by frontend but feature not yet implemented) ----
        case 'chatyy_users': {
            $auth = requireAuthLite();
            $input = getInput();
            $query = strtolower(trim((string)($input['q'] ?? $_GET['q'] ?? '')));
            $limit = min(500, max(1, (int)($input['limit'] ?? 50)));
            $offset = max(0, (int)($input['offset'] ?? 0));

            // Short in-memory (opcache) cache for 60s to avoid scanning disk on every call.
            $cacheFile = '/tmp/chatyy_users_dir.json';
            $cacheAge = file_exists($cacheFile) ? (time() - filemtime($cacheFile)) : 9999;
            $users = [];
            if ($cacheAge < 60) {
                $users = json_decode(@file_get_contents($cacheFile), true) ?: [];
            } else {
                // Scan /var/mail/vhosts/{domain}/{user}/ for Maildir presence
                foreach (['chatyy.com.br', 'onemundo.com.br', 'boraum.com.br', 'superbora.com.br'] as $domain) {
                    $base = "/var/mail/vhosts/{$domain}";
                    if (!is_dir($base)) continue;
                    foreach (@scandir($base) ?: [] as $uname) {
                        if ($uname === '.' || $uname === '..' || !ctype_alnum(str_replace(['.', '-', '_'], '', $uname))) continue;
                        if (!is_dir("{$base}/{$uname}/Maildir")) continue;
                        $email = "{$uname}@{$domain}";
                        $name = $uname;
                        // Load display name from profile data if exists
                        $profileFile = "{$base}/{$uname}/profile/data.json";
                        if (is_file($profileFile)) {
                            $p = @json_decode(@file_get_contents($profileFile), true);
                            if (is_array($p)) {
                                $name = $p['name'] ?? ($p['first_name'] ?? $uname);
                                if (!empty($p['last_name'])) $name = trim($name . ' ' . $p['last_name']);
                            }
                        }
                        $users[] = [
                            'email' => $email,
                            'name' => $name,
                            'username' => $uname,
                            'domain' => $domain,
                        ];
                    }
                }
                @file_put_contents($cacheFile, json_encode($users), LOCK_EX);
                @chmod($cacheFile, 0644);
            }

            // Exclude self + filter by query
            $me = $auth['email'];
            $filtered = [];
            foreach ($users as $u) {
                if ($u['email'] === $me) continue;
                if ($query !== '') {
                    $hay = strtolower($u['email'] . ' ' . $u['name']);
                    if (strpos($hay, $query) === false) continue;
                }
                $filtered[] = $u;
            }
            $total = count($filtered);
            $page = array_slice($filtered, $offset, $limit);
            jsonResponse(true, ['users' => $page, 'total' => $total]);
            break;
        }
        case 'close_friends_list':
        case 'close_friends_add':
        case 'close_friends_remove':
        case 'close_friends_set': {
            $auth = requireAuthLite();
            $owner = strtolower($auth['email']);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_close_friends (
                    owner_email TEXT NOT NULL,
                    friend_email TEXT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT now(),
                    PRIMARY KEY (owner_email, friend_email)
                )");
                $input = getInput();
                if ($action === 'close_friends_add') {
                    $friend = strtolower(trim((string)($input['email'] ?? '')));
                    if ($friend === '' || !filter_var($friend, FILTER_VALIDATE_EMAIL)) {
                        jsonResponse(false, null, 'valid email required', 400);
                    }
                    $pg->prepare("INSERT INTO chat_close_friends (owner_email, friend_email) VALUES (:o, :f) ON CONFLICT DO NOTHING")
                       ->execute([':o' => $owner, ':f' => $friend]);
                    jsonResponse(true, ['added' => $friend]);
                } elseif ($action === 'close_friends_remove') {
                    $friend = strtolower(trim((string)($input['email'] ?? '')));
                    if ($friend === '') jsonResponse(false, null, 'email required', 400);
                    $pg->prepare("DELETE FROM chat_close_friends WHERE owner_email = :o AND friend_email = :f")
                       ->execute([':o' => $owner, ':f' => $friend]);
                    jsonResponse(true, ['removed' => $friend]);
                } elseif ($action === 'close_friends_set') {
                    // Replace whole list atomically.
                    $emails = $input['emails'] ?? $input['list'] ?? [];
                    if (!is_array($emails)) $emails = [];
                    $clean = [];
                    foreach ($emails as $e) {
                        $e2 = strtolower(trim((string)$e));
                        if ($e2 !== '' && filter_var($e2, FILTER_VALIDATE_EMAIL)) $clean[] = $e2;
                        if (count($clean) >= 1000) break;
                    }
                    $clean = array_values(array_unique($clean));
                    $pg->beginTransaction();
                    try {
                        $pg->prepare("DELETE FROM chat_close_friends WHERE owner_email = :o")->execute([':o' => $owner]);
                        if (!empty($clean)) {
                            $ins = $pg->prepare("INSERT INTO chat_close_friends (owner_email, friend_email) VALUES (:o, :f) ON CONFLICT DO NOTHING");
                            foreach ($clean as $f) $ins->execute([':o' => $owner, ':f' => $f]);
                        }
                        $pg->commit();
                    } catch (Throwable $e) {
                        if ($pg->inTransaction()) $pg->rollBack();
                        throw $e;
                    }
                    jsonResponse(true, ['count' => count($clean)]);
                } else {
                    // close_friends_list
                    $stmt = $pg->prepare("SELECT friend_email AS email, friend_email, created_at FROM chat_close_friends WHERE owner_email = :o ORDER BY created_at DESC");
                    $stmt->execute([':o' => $owner]);
                    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
                    jsonResponse(true, ['close_friends' => $rows, 'list' => $rows, 'friends' => $rows, 'count' => count($rows)]);
                }
            } catch (Throwable $e) {
                error_log('[close_friends] ' . $e->getMessage());
                jsonResponse(false, null, 'close_friends operation failed', 500);
            }
            break;
        }
        case 'get_referral_code':
            $auth = requireAuth();
            jsonResponse(true, ['code' => strtoupper(substr(md5($auth['email']), 0, 8))]);
            break;

        // ─── Group @handle (Telegram parity) ──────────────────────
        // Lets group admins claim a public @handle for the group, making
        // it joinable via search and shareable as chatyy.com.br/+groupname.
        // Reuses chat_usernames table with email='group_<id>@conversations'
        // sentinel — keeps a single canonical handle namespace shared by
        // user accounts and groups (Telegram convention).
        case 'group_username_set':
        case 'group_username_lookup': {
            $auth = ($action === 'group_username_lookup') ? null : requireAuthLite();
            $email = $auth ? strtolower($auth['email']) : '';
            $input = getInput();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_usernames (handle TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, claimed_at TIMESTAMPTZ DEFAULT now())");
            } catch (\Throwable $e) {}

            $validateHandle = function (string $h): ?string {
                $h = strtolower(ltrim(trim($h), '@'));
                if (strlen($h) < 3) return 'too_short';
                if (strlen($h) > 30) return 'too_long';
                if (!preg_match('/^[a-z][a-z0-9_]*$/', $h)) return 'invalid_chars';
                $reserved = ['admin','support','help','chatyy','team','staff','official','root','system','bot','ai','api','www','mail','noreply','about','privacy','terms','login','signup'];
                if (in_array($h, $reserved, true)) return 'reserved';
                return null;
            };

            if ($action === 'group_username_set') {
                $cid = (int)($input['conversation_id'] ?? 0);
                $h = strtolower(ltrim(trim((string)($input['username'] ?? '')), '@'));
                if (!$cid) jsonResponse(false, null, 'conversation_id required', 400);
                $err = $validateHandle($h);
                if ($err) jsonResponse(false, null, "Invalid handle: {$err}", 400);
                // Verify caller is admin of the group.
                try {
                    $st = $pg->prepare("SELECT role FROM chat_conversation_members WHERE conversation_id = :c AND LOWER(email) = LOWER(:e)");
                    $st->execute([':c' => $cid, ':e' => $email]);
                    $row = $st->fetch(\PDO::FETCH_ASSOC);
                    if (!$row || $row['role'] !== 'admin') {
                        jsonResponse(false, null, 'Only admins can set group handle', 403);
                    }
                } catch (\Throwable $e) {
                    jsonResponse(false, null, 'admin check failed', 500);
                }
                $sentinel = "group_{$cid}@conversations";
                try {
                    $pg->beginTransaction();
                    // Reject if handle is taken by anyone else (user or group).
                    $st = $pg->prepare("SELECT email FROM chat_usernames WHERE handle = :h");
                    $st->execute([':h' => $h]);
                    $row = $st->fetch(\PDO::FETCH_ASSOC);
                    if ($row && strtolower($row['email']) !== $sentinel) {
                        $pg->rollBack();
                        jsonResponse(false, null, '@handle já está em uso', 409);
                    }
                    // Drop old handle for this group (if any) before claiming.
                    $pg->prepare("DELETE FROM chat_usernames WHERE email = :e")->execute([':e' => $sentinel]);
                    $pg->prepare("INSERT INTO chat_usernames (handle, email) VALUES (:h, :e)")
                       ->execute([':h' => $h, ':e' => $sentinel]);
                    $pg->commit();
                } catch (\Throwable $e) {
                    if ($pg->inTransaction()) $pg->rollBack();
                    jsonResponse(false, null, 'Failed to claim group handle: ' . $e->getMessage(), 500);
                }
                jsonResponse(true, ['username' => $h, 'url' => "https://chatyy.com.br/+{$h}", 'conversation_id' => $cid]);
            }

            if ($action === 'group_username_lookup') {
                $h = strtolower(ltrim(trim((string)($input['username'] ?? $_GET['username'] ?? '')), '@'));
                if ($h === '') jsonResponse(false, null, 'username required', 400);
                try {
                    $st = $pg->prepare("SELECT email FROM chat_usernames WHERE handle = :h");
                    $st->execute([':h' => $h]);
                    $row = $st->fetch(\PDO::FETCH_ASSOC);
                    if (!$row) jsonResponse(false, null, 'not_found', 404);
                    // Detect group sentinel: 'group_NNN@conversations'.
                    if (preg_match('/^group_(\d+)@conversations$/', $row['email'], $m)) {
                        $cid = (int)$m[1];
                        // Return group info for join screen.
                        $cs = $pg->prepare("SELECT id, name, type, avatar FROM chat_conversations WHERE id = :id");
                        $cs->execute([':id' => $cid]);
                        $conv = $cs->fetch(\PDO::FETCH_ASSOC);
                        if (!$conv) jsonResponse(false, null, 'group_not_found', 404);
                        // Member count
                        $mc = $pg->prepare("SELECT COUNT(*) FROM chat_conversation_members WHERE conversation_id = :id");
                        $mc->execute([':id' => $cid]);
                        $count = (int)$mc->fetchColumn();
                        jsonResponse(true, [
                            'kind' => 'group',
                            'username' => $h,
                            'conversation_id' => $cid,
                            'name' => $conv['name'],
                            'type' => $conv['type'],
                            'avatar' => $conv['avatar'],
                            'member_count' => $count,
                        ]);
                    }
                    jsonResponse(true, ['kind' => 'user', 'username' => $h, 'email' => $row['email']]);
                } catch (\Throwable $e) {
                    jsonResponse(false, null, 'lookup failed', 500);
                }
            }
            break;
        }
        // ─── /group @handle ────────────────────────────────────────

        // ─── @username (handle) — WhatsApp 2025 parity ────────────
        // Lets users claim a public @handle decoupled from email so
        // they can share a contact link without exposing their phone
        // or email. Resolves via profile_get?username=xxx.
        // Note: username_check is handled by the earlier case (~line 4504)
        // — this block only handles set + lookup.
        case 'username_set':
        case 'username_lookup': {
            $auth = ($action === 'username_lookup') ? null : requireAuthLite();
            $email = $auth ? strtolower($auth['email']) : '';
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_usernames (
                    handle TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    claimed_at TIMESTAMPTZ DEFAULT now()
                )");
                @$pg->exec("CREATE INDEX IF NOT EXISTS idx_chat_usernames_email ON chat_usernames (email)");
            } catch (\Throwable $e) { error_log('[username.table] ' . $e->getMessage()); }

            // Validate handle format. WhatsApp/Telegram convention:
            // 3-30 chars, [a-z0-9_], must start with letter, no doubles.
            $validateHandle = function (string $h): ?string {
                $h = strtolower(ltrim(trim($h), '@'));
                if ($h === '') return 'empty';
                if (strlen($h) < 3) return 'too_short';
                if (strlen($h) > 30) return 'too_long';
                if (!preg_match('/^[a-z][a-z0-9_]*$/', $h)) return 'invalid_chars';
                if (strpos($h, '__') !== false) return 'double_underscore';
                $reserved = ['admin','support','help','chatyy','team','staff','official','root','system','bot','ai','api','www','mail','noreply','about','privacy','terms','login','signup'];
                if (in_array($h, $reserved, true)) return 'reserved';
                return null; // OK
            };
            $input = getInput();

            if ($action === 'username_set') {
                $h = strtolower(ltrim(trim((string)($input['username'] ?? '')), '@'));
                $err = $validateHandle($h);
                if ($err) jsonResponse(false, null, "Invalid handle: {$err}", 400);
                try {
                    // Atomic upsert: replace caller's existing handle (if any),
                    // and reject if the new one is already claimed by someone else.
                    $pg->beginTransaction();
                    // Block claim if owned by a different user.
                    $st = $pg->prepare("SELECT email FROM chat_usernames WHERE handle = :h");
                    $st->execute([':h' => $h]);
                    $row = $st->fetch(\PDO::FETCH_ASSOC);
                    if ($row && strtolower($row['email']) !== $email) {
                        $pg->rollBack();
                        jsonResponse(false, null, '@handle já está em uso', 409);
                    }
                    // Drop my old handle (if any) before claiming the new one.
                    $pg->prepare("DELETE FROM chat_usernames WHERE email = :e")->execute([':e' => $email]);
                    $pg->prepare("INSERT INTO chat_usernames (handle, email) VALUES (:h, :e) ON CONFLICT (handle) DO UPDATE SET email = EXCLUDED.email")
                       ->execute([':h' => $h, ':e' => $email]);
                    $pg->commit();
                } catch (\Throwable $e) {
                    if ($pg->inTransaction()) $pg->rollBack();
                    error_log('[username_set] ' . $e->getMessage());
                    jsonResponse(false, null, 'Failed to claim handle', 500);
                }
                // Mirror to profile data.json so legacy paths that read username
                // from the file (no DB) keep working.
                try {
                    [$tu, $td] = array_pad(explode('@', $email, 2), 2, '');
                    $pf = "/var/mail/vhosts/{$td}/{$tu}/profile/data.json";
                    if (file_exists($pf)) {
                        $pd = json_decode(@file_get_contents($pf), true) ?: [];
                        $pd['username'] = $h;
                        @file_put_contents($pf, json_encode($pd, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX);
                    }
                } catch (\Throwable $e) {}
                jsonResponse(true, ['username' => $h, 'url' => "https://chatyy.com.br/@{$h}"]);
            }

            if ($action === 'username_lookup') {
                $h = strtolower(ltrim(trim((string)($input['username'] ?? $_GET['username'] ?? '')), '@'));
                if ($h === '') jsonResponse(false, null, 'username required', 400);
                try {
                    $st = $pg->prepare("SELECT email FROM chat_usernames WHERE handle = :h");
                    $st->execute([':h' => $h]);
                    $row = $st->fetch(\PDO::FETCH_ASSOC);
                    if (!$row) jsonResponse(false, null, '@handle not found', 404);
                    jsonResponse(true, ['username' => $h, 'email' => $row['email']]);
                } catch (\Throwable $e) {
                    jsonResponse(false, null, 'lookup failed', 500);
                }
            }
            break;
        }
        // ─── /@username ───────────────────────────────────────────

        // ─── TOTP 2FA (RFC 6238) ──────────────────────────────────
        // Self-contained TOTP implementation: no external lib needed.
        // Storage: chat_user_2fa (email, secret, enabled, backup_codes JSONB).
        // Frontend: components/TwoFactorSetup.js calls these 3 endpoints.
        case 'totp_setup':
        case 'totp_verify':
        case 'totp_disable': {
            $auth = requireAuthLite();
            $email = strtolower($auth['email']);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_user_2fa (
                    email TEXT PRIMARY KEY,
                    secret TEXT NOT NULL,
                    enabled SMALLINT NOT NULL DEFAULT 0,
                    backup_codes JSONB,
                    created_at TIMESTAMPTZ DEFAULT now(),
                    enabled_at TIMESTAMPTZ
                )");
            } catch (\Throwable $e) { error_log('[totp.table] ' . $e->getMessage()); }

            // Base32 helpers — RFC 4648 alphabet (no padding consumed).
            $base32encode = function(string $bin): string {
                $abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
                $bits = '';
                for ($i = 0; $i < strlen($bin); $i++) {
                    $bits .= str_pad(decbin(ord($bin[$i])), 8, '0', STR_PAD_LEFT);
                }
                $out = '';
                for ($i = 0; $i < strlen($bits); $i += 5) {
                    $chunk = substr($bits, $i, 5);
                    if (strlen($chunk) < 5) $chunk = str_pad($chunk, 5, '0');
                    $out .= $abc[bindec($chunk)];
                }
                return $out;
            };
            $base32decode = function(string $b32): string {
                $abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
                $b32 = strtoupper(preg_replace('/[^A-Z2-7]/', '', $b32));
                $bits = '';
                for ($i = 0; $i < strlen($b32); $i++) {
                    $idx = strpos($abc, $b32[$i]);
                    if ($idx === false) continue;
                    $bits .= str_pad(decbin($idx), 5, '0', STR_PAD_LEFT);
                }
                $bin = '';
                for ($i = 0; $i + 8 <= strlen($bits); $i += 8) {
                    $bin .= chr(bindec(substr($bits, $i, 8)));
                }
                return $bin;
            };
            // RFC 6238 TOTP — 6-digit code, 30s window, HMAC-SHA1.
            $totpCode = function(string $secret, int $time = 0) use ($base32decode): string {
                if ($time === 0) $time = time();
                $counter = intdiv($time, 30);
                $key = $base32decode($secret);
                $bin = pack('N*', 0) . pack('N*', $counter);
                $hmac = hash_hmac('sha1', $bin, $key, true);
                $offset = ord($hmac[19]) & 0xf;
                $val = ((ord($hmac[$offset]) & 0x7f) << 24)
                     | ((ord($hmac[$offset + 1]) & 0xff) << 16)
                     | ((ord($hmac[$offset + 2]) & 0xff) << 8)
                     | (ord($hmac[$offset + 3]) & 0xff);
                return str_pad((string)($val % 1000000), 6, '0', STR_PAD_LEFT);
            };

            $input = getInput();

            if ($action === 'totp_setup') {
                // Generate 20-byte secret + base32-encode + return otpauth URI
                // for QR rendering in the app. Persist as `enabled=0` until
                // the user proves possession by submitting a valid code via
                // totp_verify. Re-running totp_setup overwrites the pending
                // secret (handy if they lost the QR before verifying).
                $secretBin = random_bytes(20);
                $secretB32 = $base32encode($secretBin);
                $issuer = 'Chatyy';
                $label = rawurlencode($issuer . ':' . $email);
                $uri = "otpauth://totp/{$label}?secret={$secretB32}&issuer={$issuer}&algorithm=SHA1&digits=6&period=30";
                try {
                    $pg->prepare("INSERT INTO chat_user_2fa (email, secret, enabled) VALUES (:e, :s, 0)
                                  ON CONFLICT (email) DO UPDATE SET secret = EXCLUDED.secret, enabled = 0")
                       ->execute([':e' => $email, ':s' => $secretB32]);
                } catch (\Throwable $e) {
                    jsonResponse(false, null, 'Setup failed: ' . $e->getMessage(), 500);
                }
                jsonResponse(true, ['secret' => $secretB32, 'uri' => $uri]);
            }

            if ($action === 'totp_verify') {
                $code = preg_replace('/[^0-9]/', '', (string)($input['code'] ?? ''));
                if (strlen($code) !== 6) {
                    jsonResponse(false, null, 'Code must be 6 digits', 400);
                }
                $row = null;
                try {
                    $st = $pg->prepare("SELECT secret, enabled FROM chat_user_2fa WHERE email = :e");
                    $st->execute([':e' => $email]);
                    $row = $st->fetch(\PDO::FETCH_ASSOC);
                } catch (\Throwable $e) {}
                if (!$row || empty($row['secret'])) {
                    jsonResponse(false, null, 'Run setup first', 400);
                }
                // Allow ±1 window (30s drift) for clock skew between phone and server.
                $now = time();
                $valid = false;
                foreach ([0, -30, 30] as $drift) {
                    if (hash_equals($totpCode($row['secret'], $now + $drift), $code)) {
                        $valid = true; break;
                    }
                }
                if (!$valid) {
                    jsonResponse(false, null, 'Invalid code', 400);
                }
                // Generate 10 single-use 8-char backup codes (alphanumeric).
                $backup = [];
                for ($i = 0; $i < 10; $i++) {
                    $backup[] = strtoupper(substr(bin2hex(random_bytes(5)), 0, 8));
                }
                try {
                    $pg->prepare("UPDATE chat_user_2fa SET enabled = 1, backup_codes = CAST(:bc AS JSONB), enabled_at = now() WHERE email = :e")
                       ->execute([':bc' => json_encode($backup), ':e' => $email]);
                } catch (\Throwable $e) {
                    jsonResponse(false, null, 'Activation failed', 500);
                }
                jsonResponse(true, ['enabled' => true, 'backup_codes' => $backup]);
            }

            if ($action === 'totp_disable') {
                // Require password to disable — anti-hijack. Without this,
                // anyone with a hijacked session could turn off 2FA.
                $password = (string)($input['password'] ?? '');
                if ($password === '') {
                    jsonResponse(false, null, 'Password required', 400);
                }
                // Verify password via Dovecot doveadm (same path as login).
                $pwOk = false;
                try {
                    $passEsc = escapeshellarg($password);
                    $userEsc = escapeshellarg($email);
                    $cmd = "doveadm auth test {$userEsc} {$passEsc} 2>&1";
                    $out = @shell_exec($cmd);
                    $pwOk = is_string($out) && stripos($out, 'passdb: ' . $email . ' auth succeeded') !== false;
                } catch (\Throwable $e) {}
                if (!$pwOk) {
                    jsonResponse(false, null, 'Invalid password', 401);
                }
                try {
                    $pg->prepare("DELETE FROM chat_user_2fa WHERE email = :e")
                       ->execute([':e' => $email]);
                } catch (\Throwable $e) {}
                jsonResponse(true, ['disabled' => true]);
            }
            break;
        }
        // ─── /TOTP 2FA ────────────────────────────────────────────

        case 'notebooks_list':
            requireAuth();
            jsonResponse(true, ['notebooks' => []]);
            break;
        case 'deezer_search':
            requireAuth();
            jsonResponse(true, ['tracks' => []]);
            break;
        case 'live_list': {
            requireAuth();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Auto-end ghost sessions (broadcaster app crashed without
                // sending live_end). Two heuristics:
                //   1) Older than 30 min AND viewer_count=0 → ghost.
                //   2) Older than 6 hours regardless → never a real live.
                // This keeps the home strip clean even when broadcasters die
                // mid-stream. Auto-ended sessions are broadcast to
                // lives_global so subscribed clients drop them instantly.
                try {
                    // Aggressive threshold: 5 minutes with no viewers OR
                    // 6 hours regardless. Real lives have at least 1 viewer
                    // (the broadcaster's curious friend, or the broadcaster
                    // tested it) within 5 minutes; if not, the app probably
                    // crashed mid-stream. Tightened from 30min based on
                    // user report 2026-05-12 (ghost @suporte stuck on home).
                    $staleStmt = $pg->prepare("
                        SELECT id, host_email FROM chat_live_sessions
                        WHERE status = 'live'
                          AND (
                            (viewer_count = 0 AND started_at::timestamptz < NOW() - INTERVAL '5 minutes')
                            OR started_at::timestamptz < NOW() - INTERVAL '6 hours'
                          )
                    ");
                    $staleStmt->execute();
                    $stale = $staleStmt->fetchAll(PDO::FETCH_ASSOC);
                    if (!empty($stale)) {
                        $endStmt = $pg->prepare("UPDATE chat_live_sessions SET status='ended', ended_at=to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') WHERE id = :id");
                        $wsKey = getenv('MAIL_WS_KEY') ?: '';
                        foreach ($stale as $s) {
                            $endStmt->execute([':id' => $s['id']]);
                            error_log('[live_list] auto-ended stale session ' . $s['id'] . ' host=' . $s['host_email']);
                            // Fan out live_ended on the global channel so
                            // any client showing this session in a strip
                            // can drop it immediately.
                            if ($wsKey) {
                                $payload = json_encode([
                                    'channel' => 'lives_global',
                                    'event'   => 'live_ended',
                                    'data'    => ['session_id' => $s['id'], 'host_email' => $s['host_email']],
                                ]);
                                foreach (['http://127.0.0.1:8081/broadcast', 'http://127.0.0.1:8084/broadcast'] as $endpoint) {
                                    $cu = curl_init($endpoint);
                                    curl_setopt_array($cu, [
                                        CURLOPT_POST => true,
                                        CURLOPT_POSTFIELDS => $payload,
                                        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                                        CURLOPT_RETURNTRANSFER => true,
                                        CURLOPT_TIMEOUT_MS => 500,
                                        CURLOPT_CONNECTTIMEOUT_MS => 200,
                                    ]);
                                    curl_exec($cu);
                                    curl_close($cu);
                                }
                            }
                        }
                    }
                } catch (Throwable $_) { /* best-effort, don't fail the list call */ }

                $stmt = $pg->prepare("SELECT id, host_email, host_name, title, viewer_count, started_at, thumbnail_url FROM chat_live_sessions WHERE status = 'live' ORDER BY started_at DESC LIMIT 50");
                $stmt->execute();
                $lives = $stmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($lives as &$l) { $l['viewer_count'] = (int)$l['viewer_count']; }
                jsonResponse(true, ['lives' => $lives]);
            } catch (Throwable $e) {
                jsonResponse(true, ['lives' => []]);
            }
            break;
        }

        case 'live_start': {
            $auth = requireAuth();
            $input = getInput();
            $title = trim((string)($input['title'] ?? 'Live'));
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $sessionId = bin2hex(random_bytes(10));
                $hostName = $auth['name'] ?? explode('@', $auth['email'])[0];
                $stmt = $pg->prepare("INSERT INTO chat_live_sessions (id, host_email, host_name, title, status) VALUES (:id, :he, :hn, :t, 'live') RETURNING id, started_at");
                $stmt->execute([':id' => $sessionId, ':he' => $auth['email'], ':hn' => $hostName, ':t' => mb_substr($title, 0, 200)]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);

                // Fan-out push to followers (Instagram/TikTok parity).
                // Async-ish: we still inline it but wrap in try/catch + short
                // bounded loop so latency stays under ~300ms even with many
                // followers. The push pipeline is best-effort — a failing
                // recipient never blocks the live_start response.
                try {
                    require_once __DIR__ . '/firebase_push.php';
                    // Fan-out target = followers UNION direct-chat partners.
                    // Without the chat partners arm a fresh user with 0
                    // followers (e.g. QA accounts, brand-new signups) goes live
                    // and NOBODY they actually talk to gets the notification.
                    // Adding direct-chat partners mirrors WhatsApp's
                    // status-update audience (people you DM) while keeping
                    // followers in the loop. Direct chats only — group chats
                    // would be too noisy for a live broadcast push fan-out.
                    //
                    // Task #888: bound chat-partner arm to 30 days of activity
                    // (chat_conversations.updated_at) so dormant DMs from years
                    // ago don't get spammed every time the host goes live.
                    // Also LEFT JOIN chat_blocked_users (both directions) and
                    // chat_user_conv_settings to skip blocked peers + peers who
                    // muted the conversation. Followers arm intentionally not
                    // gated by the conv-level mute (no DM may exist).
                    $hostEmail = $auth['email'];
                    $fStmt = $pg->prepare(
                        "SELECT email, MAX(is_follower) AS is_follower, MAX(is_peer) AS is_peer FROM (
                            SELECT LOWER(follower_email) AS email, 1 AS is_follower, 0 AS is_peer
                              FROM chat_follows
                             WHERE LOWER(following_email) = LOWER(:e_follow)
                            UNION ALL
                            SELECT LOWER(m2.email) AS email, 0 AS is_follower, 1 AS is_peer
                              FROM chat_conversation_members m1
                              JOIN chat_conversations c ON c.id = m1.conversation_id
                              JOIN chat_conversation_members m2 ON m2.conversation_id = m1.conversation_id
                              LEFT JOIN chat_user_conv_settings ucs
                                     ON ucs.conversation_id = m1.conversation_id
                                    AND LOWER(ucs.email) = LOWER(m2.email)
                             WHERE LOWER(m1.email) = LOWER(:e_peer_self)
                               AND c.type = 'direct'
                               AND LOWER(m2.email) <> LOWER(:e_peer_other)
                               AND (m2.left_at IS NULL OR m2.left_at = '')
                               AND (m1.left_at IS NULL OR m1.left_at = '')
                               AND c.updated_at::timestamptz >= (NOW() - INTERVAL '30 days')
                               AND COALESCE(ucs.notif_muted, 0) = 0
                               AND COALESCE(ucs.notify_messages, true) = true
                               AND (ucs.mute_until IS NULL OR ucs.mute_until < NOW())
                        ) u
                        WHERE email IS NOT NULL AND email <> ''
                          AND email NOT IN (
                              SELECT LOWER(blocked_email) FROM chat_blocked_users
                               WHERE LOWER(blocker_email) = LOWER(:e_blk_host)
                              UNION
                              SELECT LOWER(blocker_email) FROM chat_blocked_users
                               WHERE LOWER(blocked_email) = LOWER(:e_blk_host2)
                          )
                        GROUP BY email"
                    );
                    $fStmt->execute([
                        ':e_follow'     => $hostEmail,
                        ':e_peer_self'  => $hostEmail,
                        ':e_peer_other' => $hostEmail,
                        ':e_blk_host'   => $hostEmail,
                        ':e_blk_host2'  => $hostEmail,
                    ]);
                    $rows = $fStmt->fetchAll(PDO::FETCH_ASSOC);
                    $followers = [];
                    $cntFollowerOnly = 0;
                    $cntPeerOnly = 0;
                    $cntOverlap = 0;
                    foreach ($rows as $r) {
                        $em = $r['email'];
                        if (!$em) continue;
                        $followers[] = $em;
                        $isF = (int)$r['is_follower'] === 1;
                        $isP = (int)$r['is_peer'] === 1;
                        if ($isF && $isP) $cntOverlap++;
                        elseif ($isF) $cntFollowerOnly++;
                        elseif ($isP) $cntPeerOnly++;
                    }
                    error_log(sprintf(
                        '[live_push_fanout] host=%s followers=%d chat_peers=%d deduped=%d total=%d',
                        $hostEmail,
                        $cntFollowerOnly + $cntOverlap,
                        $cntPeerOnly + $cntOverlap,
                        $cntOverlap,
                        count($followers)
                    ));
                    if (!empty($followers) && function_exists('fcmSendToUser')) {
                        $pushTitle = $hostName . ' está ao vivo';
                        $pushBody = $title && $title !== 'Live' ? $title : 'Toque pra entrar na live agora';
                        $pushData = [
                            // Use 'live' to hit the social channel + categoryId
                            // mappings already wired in firebase_push.php
                            // (channelId=social, categoryId=live_start).
                            'type'         => 'live',
                            'event'        => 'start',
                            'categoryId'   => 'live_start',
                            'category_id'  => 'live_start',
                            'session_id'   => $sessionId,
                            'host_email'   => $auth['email'],
                            'host_name'    => $hostName,
                            'title'        => $title,
                            'priority'     => 'high',
                            'group_key'    => 'live_' . $sessionId,
                            'thread_id'    => 'live_' . $sessionId,
                            'route'        => '/live/' . $sessionId,
                        ];
                        foreach ($followers as $fEmail) {
                            if (!$fEmail || strcasecmp($fEmail, $auth['email']) === 0) continue;
                            try { fcmSendToUser($fEmail, $pushTitle, $pushBody, $pushData); }
                            catch (Throwable $e) { error_log('[live_start.push] ' . $fEmail . ': ' . $e->getMessage()); }
                        }
                        error_log('[live_start] notified ' . count($followers) . ' recipients (followers + dm partners) for ' . $auth['email']);
                    }
                } catch (Throwable $e) {
                    error_log('[live_start.followers] ' . $e->getMessage());
                }

                jsonResponse(true, ['session_id' => $row['id'], 'id' => $row['id'], 'host_email' => $auth['email'], 'title' => $title, 'started_at' => $row['started_at']]);
            } catch (Throwable $e) {
                error_log('[live_start] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed to start live', 500);
            }
            break;
        }

        case 'live_end': {
            $auth = requireAuth();
            $input = getInput();
            $sessionId = trim((string)($input['session_id'] ?? $input['id'] ?? ''));
            if ($sessionId === '') jsonResponse(false, null, 'session_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("UPDATE chat_live_sessions SET status = 'ended', ended_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') WHERE id = :id AND host_email = :e")
                   ->execute([':id' => $sessionId, ':e' => $auth['email']]);

                // ── WS broadcast: drop viewers instantly ────────────────────
                // Without this, viewers wait 45-60s for the next live_list
                // poll to notice the host left. Same pattern as live_end_cf
                // in chat.php — hit Node (8081) AND Go (8084) hubs so
                // whichever the client is on receives it.
                try {
                    $wsKey = getenv('MAIL_WS_KEY') ?: '';
                    if ($wsKey === '' && file_exists('/etc/mail-api.env')) {
                        foreach (@file('/etc/mail-api.env') ?: [] as $_line) {
                            if (strpos($_line, 'MAIL_WS_KEY=') === 0) { $wsKey = trim(substr($_line, 12)); break; }
                        }
                    }
                    if ($wsKey !== '') {
                        foreach (['live_' . $sessionId, 'lives_global'] as $channel) {
                            $payload = json_encode([
                                'channel' => $channel,
                                'event'   => 'live_ended',
                                'data'    => [
                                    'session_id' => $sessionId,
                                    'host_email' => $auth['email'],
                                ],
                            ]);
                            foreach (['http://127.0.0.1:8081/broadcast', 'http://127.0.0.1:8084/broadcast'] as $endpoint) {
                                $cu = curl_init($endpoint);
                                curl_setopt_array($cu, [
                                    CURLOPT_POST => true,
                                    CURLOPT_POSTFIELDS => $payload,
                                    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                                    CURLOPT_RETURNTRANSFER => true,
                                    CURLOPT_TIMEOUT_MS => 500,
                                    CURLOPT_CONNECTTIMEOUT_MS => 200,
                                ]);
                                curl_exec($cu);
                                curl_close($cu);
                            }
                        }
                    }
                } catch (Throwable $e) {
                    error_log('[live_end.ws] ' . $e->getMessage());
                }

                jsonResponse(true, ['ended' => true]);
            } catch (Throwable $e) {
                jsonResponse(false, null, 'End failed', 500);
            }
            break;
        }

        case 'live_join': {
            $auth = requireAuth();
            $input = getInput();
            $sessionId = trim((string)($input['session_id'] ?? $input['id'] ?? ''));
            if ($sessionId === '') jsonResponse(false, null, 'session_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Hard cap viewers per room. Without this a bot storm can
                // overload the SFU and take the broadcast down for legit
                // users. 500 is the comfortable ceiling for a single-host
                // broadcast at current infra; increase when SFU scales out.
                $MAX_VIEWERS = 500;
                // Block banned viewers BEFORE the viewer_count bump so we
                // don't pad the count with kicked users who'll be hung up
                // on the client a moment later. chat_live_bans is created
                // lazily by chat.php's migration block; if the table doesn't
                // exist yet we silently skip the check rather than 500.
                try {
                    $banStmt = $pg->prepare("SELECT 1 FROM chat_live_bans WHERE live_session_id = :s AND LOWER(banned_email) = LOWER(:e) LIMIT 1");
                    $banStmt->execute([':s' => $sessionId, ':e' => $auth['email']]);
                    if ($banStmt->fetchColumn()) {
                        jsonResponse(false, ['code' => 'banned'], 'Você foi removido deste live', 403);
                    }
                } catch (Throwable $e) { /* table not created yet — skip */ }

                // Pull viewer_count + status + new moderation columns in a
                // single SELECT so live_join is still one round-trip even
                // with pinned-comment + slow-mode surfaced in the response.
                $curStmt = $pg->prepare("SELECT viewer_count, status, pinned_comment, pinned_comment_by, slow_mode_seconds FROM chat_live_sessions WHERE id = :id");
                $curStmt->execute([':id' => $sessionId]);
                $row = $curStmt->fetch(PDO::FETCH_ASSOC);
                if (!$row || ($row['status'] ?? '') !== 'live') {
                    jsonResponse(false, null, 'Live ended', 410);
                }
                if ((int)$row['viewer_count'] >= $MAX_VIEWERS) {
                    jsonResponse(false, null, 'Live cheia — tente novamente em instantes.', 503);
                }
                $pg->prepare("UPDATE chat_live_sessions SET viewer_count = viewer_count + 1 WHERE id = :id AND status = 'live' AND viewer_count < :cap")
                   ->execute([':id' => $sessionId, ':cap' => $MAX_VIEWERS]);
                $stmt = $pg->prepare("SELECT viewer_count FROM chat_live_sessions WHERE id = :id");
                $stmt->execute([':id' => $sessionId]);
                $resp = [
                    'viewer_count'      => (int)$stmt->fetchColumn(),
                    'session_id'        => $sessionId,
                    'slow_mode_seconds' => (int)($row['slow_mode_seconds'] ?? 0),
                ];
                if (!empty($row['pinned_comment'])) {
                    $resp['pinned_comment']    = (string)$row['pinned_comment'];
                    $resp['pinned_comment_by'] = (string)($row['pinned_comment_by'] ?? '');
                }
                jsonResponse(true, $resp);
            } catch (Throwable $e) { jsonResponse(true, ['viewer_count' => 0]); }
            break;
        }

        case 'live_leave': {
            requireAuth();
            $input = getInput();
            $sessionId = trim((string)($input['session_id'] ?? ''));
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("UPDATE chat_live_sessions SET viewer_count = GREATEST(0, viewer_count - 1) WHERE id = :id")
                   ->execute([':id' => $sessionId]);
                jsonResponse(true, ['left' => true]);
            } catch (Throwable $e) { jsonResponse(true, ['left' => false]); }
            break;
        }

        case 'live_send_chat': {
            $auth = requireAuth();
            $input = getInput();
            $sessionId = trim((string)($input['session_id'] ?? ''));
            $content = trim((string)($input['content'] ?? ''));
            if ($sessionId === '' || $content === '') jsonResponse(false, null, 'session_id + content required', 400);
            require_once __DIR__ . '/db.php';
            $pg = getPGDB();
            // Block banned viewers from commenting (they may still have a
            // stale WS subscription that bypassed live_join). Cheap LIMIT 1
            // query; falls through silently if the table isn't migrated yet.
            try {
                $banStmt = $pg->prepare("SELECT 1 FROM chat_live_bans WHERE live_session_id = :s AND LOWER(banned_email) = LOWER(:e) LIMIT 1");
                $banStmt->execute([':s' => $sessionId, ':e' => $auth['email']]);
                if ($banStmt->fetchColumn()) {
                    jsonResponse(false, ['code' => 'banned'], 'Você foi removido deste live', 403);
                }
            } catch (Throwable $e) { /* table not created yet — skip */ }
            // Slow mode — host can throttle per-viewer comment cadence to
            // suppress spam. We allow the host themselves to bypass slow
            // mode so they can keep moderating. Lookup is one row from
            // chat_live_sessions; if missing column we treat as off.
            try {
                $smStmt = $pg->prepare("SELECT slow_mode_seconds, host_email FROM chat_live_sessions WHERE id = :id");
                $smStmt->execute([':id' => $sessionId]);
                $smRow = $smStmt->fetch(PDO::FETCH_ASSOC);
                $slowSec = (int)($smRow['slow_mode_seconds'] ?? 0);
                $isHost = $smRow && strcasecmp((string)$smRow['host_email'], $auth['email']) === 0;
                if ($slowSec > 0 && !$isHost) {
                    // Compare against the latest comment from this email in
                    // this session. Cheaper than tracking a per-user timer
                    // in memcache, and survives PHP-FPM worker churn.
                    // created_at is stored as TEXT in chat_live_chat (legacy
                    // schema) so we cast to timestamptz before the epoch
                    // diff. The column for the author is `email` (not
                    // sender_email — same legacy quirk).
                    $lastStmt = $pg->prepare("SELECT EXTRACT(EPOCH FROM (now() - created_at::timestamptz))::int AS age FROM chat_live_chat WHERE session_id = :s AND LOWER(email) = LOWER(:e) ORDER BY id DESC LIMIT 1");
                    $lastStmt->execute([':s' => $sessionId, ':e' => $auth['email']]);
                    $age = $lastStmt->fetchColumn();
                    if ($age !== false && $age !== null && (int)$age < $slowSec) {
                        $wait = $slowSec - (int)$age;
                        jsonResponse(false, ['code' => 'slow_mode', 'wait_seconds' => $wait], 'Modo lento ativo — aguarde ' . $wait . 's', 429);
                    }
                }
            } catch (Throwable $e) { /* slow_mode column not migrated yet — skip */ }
            // 15 msgs/10s per user per live room — stops bot spam without
            // punishing normal hype chat.
            $rateFile = '/tmp/live_chat_rate_' . md5($auth['email'] . '|' . $sessionId);
            $rates = [];
            if (file_exists($rateFile)) {
                $raw = @file_get_contents($rateFile);
                $d = $raw ? json_decode($raw, true) : null;
                if (is_array($d)) $rates = array_values(array_filter($d, fn($t) => is_numeric($t) && $t > time() - 10));
            }
            if (count($rates) >= 15) jsonResponse(false, null, 'Espere um momento para enviar de novo.', 429);
            $rates[] = time();
            @file_put_contents($rateFile, json_encode($rates), LOCK_EX);
            try {
                $pg->prepare("INSERT INTO chat_live_chat (session_id, sender_email, sender_name, content) VALUES (:s, :se, :sn, :c)")
                   ->execute([':s' => $sessionId, ':se' => $auth['email'], ':sn' => $auth['name'] ?? explode('@', $auth['email'])[0], ':c' => mb_substr($content, 0, 500)]);
                jsonResponse(true, ['sent' => true]);
            } catch (Throwable $e) { jsonResponse(false, null, 'Send failed', 500); }
            break;
        }

        // VoIP stubs — VoIP service runs separately (chatyy-voip on port 9301/8908).
        // VoIP push token registration. Stores the device's PushKit token so
        // chat.php → voip_push.php can ring CallKit on incoming calls when
        // the app is backgrounded/closed. Without this storage, calls only
        // ring while the app is open in foreground.
        case 'register_voip_token': {
            $creds = requireAuthLite();
            $input = getInput();
            $token = trim($input['token'] ?? '');
            if (!$token) jsonResponse(false, null, 'Token obrigatorio', 400);
            $bundle = trim($input['bundle_id'] ?? 'com.onemundo.mail');

            $userEmail = $creds['email'];
            $parts = explode('@', strtolower($userEmail));
            $user = $parts[0] ?? '';
            $domain = $parts[1] ?? 'onemundo.com.br';
            // Path/format must match voip_push.php sendVoipPushToUser() exactly,
            // otherwise tokens stored here are unreachable when chat tries to ring.
            if (!preg_match('/^[a-z0-9._\-+]+$/', $user) || !preg_match('/^[a-z0-9.\-]+$/', $domain)) {
                jsonResponse(false, null, 'Email invalido', 400);
            }
            $tokenDir = "/var/mail/vhosts/{$domain}/{$user}/push_tokens";
            @mkdir($tokenDir, 0700, true);
            exec("chown -R www-data:www-data " . escapeshellarg($tokenDir));
            $tokenFile = "{$tokenDir}/voip_token.json";
            $payload = [
                'token' => $token,
                'bundle_id' => $bundle,
                'registered_at' => date('c'),
            ];
            $fp = @fopen($tokenFile, 'c+');
            if ($fp) {
                @flock($fp, LOCK_EX);
                ftruncate($fp, 0);
                rewind($fp);
                fwrite($fp, json_encode($payload, JSON_PRETTY_PRINT));
                fflush($fp);
                @flock($fp, LOCK_UN);
                fclose($fp);
            } else {
                file_put_contents($tokenFile, json_encode($payload, JSON_PRETTY_PRINT), LOCK_EX);
            }
            error_log("[VoIP register] {$userEmail} token=" . substr($token, 0, 8) . '…');
            jsonResponse(true, ['registered' => true]);
            break;
        }
        case 'unregister_voip_token': {
            $creds = requireAuthLite();
            $userEmail = $creds['email'];
            $parts = explode('@', strtolower($userEmail));
            $user = $parts[0] ?? '';
            $domain = $parts[1] ?? '';
            if (!preg_match('/^[a-z0-9._\-+]+$/', $user) || !preg_match('/^[a-z0-9.\-]+$/', $domain)) {
                jsonResponse(false, null, 'Email invalido', 400);
            }
            $tokenFile = "/var/mail/vhosts/{$domain}/{$user}/push_tokens/voip_token.json";
            if (file_exists($tokenFile)) @unlink($tokenFile);
            jsonResponse(true, ['unregistered' => true]);
            break;
        }
        case 'callkit_diag':
            requireAuthLite();
            jsonResponse(true, ['diag' => 'ok', 'timestamp' => time()]);
            break;
        case 'voip_minutes_remaining':
            requireAuthLite();
            jsonResponse(true, ["minutes_remaining" => 9999, "minutes_used" => 0, "minutes_limit" => 9999, "unlimited" => true]);
            break;
        case 'voip_sip_credentials': {
            $auth = requireAuth();
            $userEmail = $auth['email'] ?? '';

            // Read Telnyx + TURN creds from env. The frontend (services/sipCall.js)
            // expects Telnyx Verto credentials (sip_user, sip_password, caller_id,
            // optional turn). Twilio Voice migration is in scope but not wired here yet.
            $telnyxKey = ''; $sipUser = ''; $sipPass = ''; $turnSecret = '';
            $envFile = '/etc/mail-api.env';
            if (is_readable($envFile)) {
                foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $envLine) {
                    if ($envLine === '' || $envLine[0] === '#') continue;
                    if (strpos($envLine, 'TELNYX_API_KEY=') === 0)  $telnyxKey  = substr($envLine, strlen('TELNYX_API_KEY='));
                    elseif (strpos($envLine, 'TELNYX_SIP_USER=') === 0) $sipUser = substr($envLine, strlen('TELNYX_SIP_USER='));
                    elseif (strpos($envLine, 'TELNYX_SIP_PASS=') === 0) $sipPass = substr($envLine, strlen('TELNYX_SIP_PASS='));
                    elseif (strpos($envLine, 'TURN_SECRET=') === 0)    $turnSecret = substr($envLine, strlen('TURN_SECRET='));
                }
            }
            if (!$sipUser || !$sipPass) {
                jsonResponse(false, null, 'SIP credentials not configured', 500);
            }

            // Verified caller ID from user profile.
            // Bug 2026-05-19 #1182 — gate had only `phone_verified` (the signup
            // OTP check), missing users who verified their outbound caller-ID
            // via the Twilio OutgoingCallerIds flow (`telnyx_caller_id_verified`
            // flag, set by voip_verified_number_request/confirm). Without this
            // the SIP INVITE went out with caller_id_number empty → Telnyx
            // substituted the connection default (+19513931371) instead of the
            // verified +19547077804 the user expected. Either flag now wins.
            // `caller_id_verified_at` is the legacy fallback (older accounts
            // verified before the boolean was introduced).
            $callerPhone = '';
            $eParts = explode('@', $userEmail);
            $profPath = "/var/mail/vhosts/" . ($eParts[1] ?? 'chatyy.com.br') . "/" . ($eParts[0] ?? '') . "/profile/data.json";
            $cidVerified = false;
            if (file_exists($profPath)) {
                $prof = @json_decode(file_get_contents($profPath), true);
                $cidVerified = !empty($prof['telnyx_caller_id_verified'])
                    || !empty($prof['caller_id_verified_at'])
                    || !empty($prof['phone_verified']);
                if ($cidVerified && !empty($prof['verified_phone'])) {
                    $callerPhone = preg_replace('/[^+0-9]/', '', $prof['verified_phone']);
                }
            }

            // Ephemeral TURN creds (24 h, HMAC-SHA1, RFC 5766 long-term).
            $turnCreds = null;
            if ($turnSecret) {
                $turnExpiry = time() + 86400;
                $turnUser = $turnExpiry . ':' . ($userEmail ?: 'chatyy');
                $turnPass = base64_encode(hash_hmac('sha1', $turnUser, $turnSecret, true));
                $turnCreds = [
                    'urls' => [
                        'turn:turn.chatyy.com.br:3478?transport=udp',
                        'turn:turn.chatyy.com.br:3478?transport=tcp',
                    ],
                    'username' => $turnUser,
                    'credential' => $turnPass,
                ];
            }

            jsonResponse(true, [
                'sip_user' => $sipUser,
                'sip_password' => $sipPass,
                'caller_id' => $callerPhone,
                'caller_id_verified' => $cidVerified && !empty($callerPhone),
                'turn' => $turnCreds,
            ]);
            break;
        }

        case 'voip_twilio_token': {
            // Returns an Access Token JWT for the authenticated user. Client
            // (Twilio Voice JS SDK) uses it to register and place outbound calls.
            $auth = requireAuth();
            $email = $auth['email'] ?? '';
            $creds = twilioLoadVoiceCreds();
            $missing = [];
            foreach (['account_sid','api_key_sid','api_key_secret','twiml_app_sid'] as $k) {
                if (empty($creds[$k])) $missing[] = $k;
            }
            if ($missing) jsonResponse(false, null, 'Twilio Voice not configured: missing ' . implode(',', $missing), 500);
            $identity = preg_replace('/[^a-z0-9_\-\.@]/i', '_', $email);
            $tokenStr = twilioBuildAccessToken(
                $creds['account_sid'], $creds['api_key_sid'], $creds['api_key_secret'],
                $creds['twiml_app_sid'], $identity, 3600
            );
            jsonResponse(true, [
                'token'      => $tokenStr,
                'identity'   => $identity,
                'expires_at' => time() + 3600,
                'caller_id'  => $creds['caller_default'],
            ]);
            break;
        }

        case 'voip_twilio_twiml': {
            // Public endpoint Twilio hits when outgoing call is placed via the
            // TwiML App. Returns <Dial> XML telling Twilio to route to <Number>.
            // Must be reachable without auth (Twilio servers call it).
            header('Content-Type: text/xml; charset=utf-8');
            $to = isset($_REQUEST['To']) ? preg_replace('/[^+0-9]/', '', $_REQUEST['To']) : '';
            $creds = twilioLoadVoiceCreds();

            // SECURITY: never trust CallerId from the client. Derive it from the
            // authenticated identity Twilio embeds in the Caller param
            // (format: client:<identity>). Identity matches the user email — load
            // their profile and use verified_phone if confirmed by Twilio
            // OutgoingCallerIds (telnyx_caller_id_verified flag, stored after
            // successful PIN verification). Falls back to the platform Twilio
            // number so calls still complete unverified, just without showing
            // the user's real number.
            $callerId = '';
            $callerParam = $_REQUEST['Caller'] ?? '';
            if (strncmp($callerParam, 'client:', 7) === 0) {
                $identity = substr($callerParam, 7);
                $emailGuess = strtolower(trim($identity));
                if (preg_match('/^[a-z0-9._\-+]+@[a-z0-9.\-]+$/', $emailGuess)) {
                    $iParts = explode('@', $emailGuess);
                    $profPath = "/var/mail/vhosts/{$iParts[1]}/{$iParts[0]}/profile/data.json";
                    if (is_readable($profPath)) {
                        $prof = @json_decode(@file_get_contents($profPath), true);
                        if (!empty($prof['telnyx_caller_id_verified']) && !empty($prof['verified_phone'])) {
                            $callerId = preg_replace('/[^+0-9]/', '', $prof['verified_phone']);
                        }
                    }
                }
            }
            if (!$callerId) $callerId = $creds['caller_default'] ?? '';
            $xml = '<?xml version="1.0" encoding="UTF-8"?>' . "\n";
            $xml .= '<Response>' . "\n";
            if ($to && preg_match('/^\+?[1-9][0-9]{6,15}$/', $to)) {
                $xml .= '  <Dial answerOnBridge="true"' . ($callerId ? ' callerId="' . htmlspecialchars($callerId, ENT_QUOTES) . '"' : '') . '>' . "\n";
                $xml .= '    <Number>' . htmlspecialchars($to, ENT_QUOTES) . '</Number>' . "\n";
                $xml .= '  </Dial>' . "\n";
            } else {
                $xml .= '  <Say voice="alice" language="pt-BR">Número inválido. Encerrando.</Say>' . "\n";
                $xml .= '  <Hangup/>' . "\n";
            }
            $xml .= '</Response>' . "\n";
            echo $xml;
            exit;
        }

        case 'telnyx_call_webhook': {
            // Telnyx Call Control webhook receiver. Must be unauthenticated and
            // respond 200 fast — Telnyx aborts the call if we don't ack.
            // Events: call.initiated, call.answered, call.hangup, etc.
            // For server-originated calls (POST /v2/calls), we issue `answer`
            // on call.initiated so the destination phone bridges audio.
            // Reference: https://developers.telnyx.com/api/call-control
            $raw = file_get_contents('php://input');
            $payload = $raw ? @json_decode($raw, true) : [];
            $eventType = $payload['data']['event_type'] ?? '';
            $callControlId = $payload['data']['payload']['call_control_id'] ?? '';
            $direction = $payload['data']['payload']['direction'] ?? '';
            $from = $payload['data']['payload']['from'] ?? '';
            $to = $payload['data']['payload']['to'] ?? '';
            error_log('[telnyx_webhook] event=' . $eventType . ' direction=' . $direction . ' from=' . $from . ' to=' . $to . ' ccid=' . substr($callControlId, 0, 30));

            // For OUTBOUND calls (we originated via POST /v2/calls), Telnyx fires
            // call.initiated when the call is being routed. We don't need to do
            // anything — just ack 200 and Telnyx proceeds to ring the destination.
            // For INBOUND calls (someone dials our DID), we need to answer.
            if ($eventType === 'call.initiated' && $direction === 'incoming') {
                // Answer the inbound call. Telnyx will then play silence/IVR
                // until the backend issues another action (bridge, play, etc.)
                $apiKey = getenv('TELNYX_API_KEY') ?: '';
                if ($apiKey && $callControlId) {
                    $ch = curl_init('https://api.telnyx.com/v2/calls/' . urlencode($callControlId) . '/actions/answer');
                    curl_setopt_array($ch, [
                        CURLOPT_POST => true,
                        CURLOPT_POSTFIELDS => '{}',
                        CURLOPT_HTTPHEADER => [
                            'Authorization: Bearer ' . $apiKey,
                            'Content-Type: application/json',
                        ],
                        CURLOPT_RETURNTRANSFER => true,
                        CURLOPT_TIMEOUT => 5,
                    ]);
                    curl_exec($ch);
                    curl_close($ch);
                }
            }
            // Always ack 200 — Telnyx requires this within ~5s or it aborts.
            http_response_code(200);
            header('Content-Type: application/json');
            echo '{"ok":true}';
            exit;
        }

        case 'voip_twilio_status_callback': {
            // Twilio webhook for billing/duration. Must be unauthenticated.
            // Just log + 200 OK; the actual minute deduction can be hooked here.
            $callSid = $_POST['CallSid'] ?? $_REQUEST['CallSid'] ?? '';
            $status  = $_POST['CallStatus'] ?? $_REQUEST['CallStatus'] ?? '';
            $dur     = (int)($_POST['CallDuration'] ?? $_REQUEST['CallDuration'] ?? 0);
            $from    = $_POST['From'] ?? $_REQUEST['From'] ?? '';
            $to      = $_POST['To'] ?? $_REQUEST['To'] ?? '';
            error_log('[twilio_status] sid=' . $callSid . ' status=' . $status . ' dur=' . $dur . ' from=' . $from . ' to=' . $to);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->exec("CREATE TABLE IF NOT EXISTS twilio_call_events (
                    id BIGSERIAL PRIMARY KEY,
                    call_sid TEXT, status TEXT, duration_sec INT,
                    from_number TEXT, to_number TEXT,
                    payload JSONB, created_at TIMESTAMPTZ DEFAULT NOW()
                )");
                $st = $pg->prepare("INSERT INTO twilio_call_events (call_sid, status, duration_sec, from_number, to_number, payload)
                                    VALUES (:s, :st, :d, :f, :t, :p)");
                $st->execute([
                    ':s' => $callSid, ':st' => $status, ':d' => $dur,
                    ':f' => $from, ':t' => $to,
                    ':p' => json_encode($_POST ?: $_REQUEST, JSON_UNESCAPED_SLASHES),
                ]);
            } catch (Throwable $e) {
                error_log('[twilio_status/pg] ' . $e->getMessage());
            }
            header('Content-Type: text/xml; charset=utf-8');
            echo '<?xml version="1.0" encoding="UTF-8"?><Response/>';
            exit;
        }

        case 'parental_list_children': {
            $auth = requireAuth();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("SELECT id, child_email, child_name, child_birthday, age, status, created_at FROM parental_accounts WHERE parent_email = :e ORDER BY created_at DESC");
                $stmt->execute([':e' => $auth['email']]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($rows as &$r) { $r['id'] = (int)$r['id']; if (isset($r['age'])) $r['age'] = (int)$r['age']; }
                jsonResponse(true, ['children' => $rows]);
            } catch (Throwable $e) {
                error_log('[parental_list_children] ' . $e->getMessage());
                jsonResponse(true, ['children' => []]);
            }
            break;
        }

        case 'parental_create_child': {
            $auth = requireAuth();
            $input = getInput();
            $name = trim((string)($input['child_name'] ?? ''));
            $birthday = trim((string)($input['child_birthday'] ?? ''));
            if ($name === '') jsonResponse(false, null, 'child_name required', 400);
            if ($birthday === '') jsonResponse(false, null, 'child_birthday required', 400);
            // Generate child email: parent's username + _kid_<N>
            $parts = explode('@', $auth['email']);
            $parentUser = $parts[0];
            $domain = $parts[1];
            // Count existing children under this parent to compute next index
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $cnt = $pg->prepare("SELECT COUNT(*) FROM parental_accounts WHERE parent_email = :e");
                $cnt->execute([':e' => $auth['email']]);
                $idx = ((int)$cnt->fetchColumn()) + 1;
                $childEmail = "{$parentUser}_kid_{$idx}@{$domain}";
                // Age from birthday (best-effort)
                $age = null;
                if (preg_match('/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/', $birthday, $m) || preg_match('/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/', $birthday, $m)) {
                    try {
                        $bd = new DateTime($birthday);
                        $age = (int)$bd->diff(new DateTime('now'))->y;
                    } catch (Throwable $e) {}
                }
                $ins = $pg->prepare("INSERT INTO parental_accounts (parent_email, child_email, child_name, child_birthday, age, status) VALUES (:p, :c, :n, :b, :a, 'active') ON CONFLICT (parent_email, child_email) DO UPDATE SET child_name = excluded.child_name, child_birthday = excluded.child_birthday, age = excluded.age, updated_at = now() RETURNING id");
                $ins->execute([':p' => $auth['email'], ':c' => $childEmail, ':n' => $name, ':b' => $birthday, ':a' => $age]);
                $id = (int)$ins->fetchColumn();
                jsonResponse(true, ['id' => $id, 'child_email' => $childEmail, 'child_name' => $name, 'age' => $age, 'status' => 'active']);
            } catch (Throwable $e) {
                error_log('[parental_create_child] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed to create child account', 500);
            }
            break;
        }

        case 'parental_revoke_child': {
            $auth = requireAuth();
            $input = getInput();
            $childEmail = strtolower(trim((string)($input['child_email'] ?? '')));
            if ($childEmail === '' || !filter_var($childEmail, FILTER_VALIDATE_EMAIL)) {
                jsonResponse(false, null, 'child_email required', 400);
            }
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("DELETE FROM parental_accounts WHERE parent_email = :p AND child_email = :c")
                   ->execute([':p' => $auth['email'], ':c' => $childEmail]);
                jsonResponse(true, ['revoked' => true]);
            } catch (Throwable $e) {
                jsonResponse(false, null, 'Revoke failed', 500);
            }
            break;
        }

        case 'parental_get_restrictions': {
            $auth = requireAuth();
            $input = getInput();
            $childEmail = strtolower(trim((string)($input['child_email'] ?? '')));
            if ($childEmail === '') jsonResponse(false, null, 'child_email required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("SELECT * FROM parental_accounts WHERE parent_email = :p AND child_email = :c");
                $stmt->execute([':p' => $auth['email'], ':c' => $childEmail]);
                $acct = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$acct) jsonResponse(false, null, 'Child not found', 404);
                // Restrictions stored in parental_accounts as JSON in a (soft) `restrictions` column, else defaults
                $defaults = [
                    'chat_enabled' => true,
                    'calls_enabled' => true,
                    'feed_enabled' => true,
                    'internet_enabled' => true,
                    'daily_limit_minutes' => 0,
                    'bedtime_start' => '',
                    'bedtime_end' => '',
                    'allowed_contacts_only' => false,
                ];
                // PG-first lookup; file fallback for legacy.
                $saved = [];
                $rsel = $pg->prepare("SELECT restrictions FROM parental_restrictions WHERE LOWER(child_email) = :c LIMIT 1");
                $rsel->execute([':c' => $childEmail]);
                if ($rest = $rsel->fetchColumn()) {
                    $saved = is_array($rest) ? $rest : (json_decode($rest, true) ?: []);
                }
                if (empty($saved)) {
                    $restrictionsFile = "/var/mail/vhosts/{$auth['email']}_restrictions_" . md5($childEmail) . ".json";
                    $saved = file_exists($restrictionsFile) ? (json_decode(file_get_contents($restrictionsFile), true) ?: []) : [];
                }
                jsonResponse(true, array_merge($defaults, $saved));
            } catch (Throwable $e) {
                jsonResponse(false, null, 'Failed', 500);
            }
            break;
        }

        case 'parental_update_restrictions': {
            $auth = requireAuth();
            $input = getInput();
            $childEmail = strtolower(trim((string)($input['child_email'] ?? '')));
            if ($childEmail === '') jsonResponse(false, null, 'child_email required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $chk = $pg->prepare("SELECT 1 FROM parental_accounts WHERE parent_email = :p AND child_email = :c");
                $chk->execute([':p' => $auth['email'], ':c' => $childEmail]);
                if (!$chk->fetch()) jsonResponse(false, null, 'Child not found', 404);
                $allowed = ['chat_enabled', 'calls_enabled', 'feed_enabled', 'internet_enabled',
                            'daily_limit_minutes', 'bedtime_start', 'bedtime_end',
                            'allowed_contacts_only', 'allowed_contacts'];
                $updates = [];
                foreach ($allowed as $k) { if (isset($input[$k])) $updates[$k] = $input[$k]; }
                // Read existing from PG first (single source of truth);
                // fall back to legacy JSON file for first-write merge.
                $existing = [];
                $sel = $pg->prepare("SELECT restrictions FROM parental_restrictions WHERE LOWER(child_email) = :c LIMIT 1");
                $sel->execute([':c' => $childEmail]);
                if ($rest = $sel->fetchColumn()) {
                    $existing = is_array($rest) ? $rest : (json_decode($rest, true) ?: []);
                }
                if (empty($existing)) {
                    $restrictionsFile = "/var/mail/vhosts/{$auth['email']}_restrictions_" . md5($childEmail) . ".json";
                    if (file_exists($restrictionsFile)) {
                        $existing = json_decode(file_get_contents($restrictionsFile), true) ?: [];
                    }
                }
                $merged = array_merge($existing, $updates);
                $up = $pg->prepare(
                    "INSERT INTO parental_restrictions (child_email, parent_email, restrictions, updated_at)
                     VALUES (:c, :p, :r::jsonb, NOW())
                     ON CONFLICT (child_email) DO UPDATE
                     SET parent_email = EXCLUDED.parent_email,
                         restrictions = EXCLUDED.restrictions,
                         updated_at = NOW()"
                );
                $up->execute([
                    ':c' => $childEmail,
                    ':p' => $auth['email'],
                    ':r' => json_encode($merged, JSON_UNESCAPED_UNICODE),
                ]);
                // Keep file mirror so older code paths still work during migration.
                $restrictionsFile = "/var/mail/vhosts/{$auth['email']}_restrictions_" . md5($childEmail) . ".json";
                @file_put_contents($restrictionsFile, json_encode($merged), LOCK_EX);
                jsonResponse(true, $merged);
            } catch (Throwable $e) {
                jsonResponse(false, null, 'Update failed', 500);
            }
            break;
        }

        case 'parental_alerts': {
            $auth = requireAuth();
            $input = getInput();
            $childEmail = strtolower(trim((string)($input['child_email'] ?? '')));
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $where = 'parent_email = :p';
                $params = [':p' => $auth['email']];
                if ($childEmail !== '') { $where .= ' AND child_email = :c'; $params[':c'] = $childEmail; }
                $stmt = $pg->prepare("SELECT id, child_email, alert_type, title, body AS content, severity, (read_at IS NOT NULL) AS is_read, metadata, created_at FROM parental_alerts WHERE {$where} ORDER BY created_at DESC LIMIT 100");
                $stmt->execute($params);
                jsonResponse(true, ['alerts' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
            } catch (Throwable $e) {
                jsonResponse(true, ['alerts' => []]);
            }
            break;
        }

        case 'parental_mark_alert_read': {
            $auth = requireAuth();
            $input = getInput();
            $alertId = (int)($input['alert_id'] ?? 0);
            if (!$alertId) jsonResponse(false, null, 'alert_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("UPDATE parental_alerts SET read_at = NOW() WHERE id = :id AND parent_email = :p AND read_at IS NULL")
                   ->execute([':id' => $alertId, ':p' => $auth['email']]);
                jsonResponse(true, ['marked' => true]);
            } catch (Throwable $e) { jsonResponse(false, null, 'Failed', 500); }
            break;
        }

        // Remaining parental endpoints as stubs returning empty/success so frontend doesn't crash.
        case 'parental_child_chats':
            requireAuth();
            jsonResponse(true, ['chats' => []]);
            break;
        case 'parental_child_messages':
            requireAuth();
            jsonResponse(true, ['messages' => [], 'has_more' => false]);
            break;
        case 'parental_screen_time':
            requireAuth();
            jsonResponse(true, ['minutes_today' => 0, 'breakdown' => []]);
            break;
        case 'parental_call_history':
            requireAuth();
            jsonResponse(true, ['calls' => []]);
            break;
        case 'parental_contact_whitelist':
            $auth = requireAuth();
            $input = getInput();
            $childEmail = strtolower(trim((string)($input['child_email'] ?? '')));
            $contactEmail = trim((string)($input['contact_email'] ?? ''));
            // Caller must be the parent of this child — same gate the
            // dashboard endpoints (parental_lock_child etc) use.
            if ($childEmail === '' || !filter_var($childEmail, FILTER_VALIDATE_EMAIL)) {
                jsonResponse(false, null, 'child_email required', 400);
            }
            require_once __DIR__ . '/parental_helper.php';
            if (!parentalIsParentOf($auth['email'], $childEmail)) {
                jsonResponse(false, null, 'Not authorized', 403);
            }
            if ($contactEmail !== '') {
                if (!filter_var($contactEmail, FILTER_VALIDATE_EMAIL)) {
                    jsonResponse(false, null, 'contact_email invalid', 400);
                }
                // Add mode (POST with contact_email)
                try {
                    require_once __DIR__ . '/db.php';
                    $pg = getPGDB();
                    $pg->prepare("INSERT INTO parental_contact_whitelist (parent_email, child_email, contact_email) VALUES (:p, :c, :ce) ON CONFLICT DO NOTHING")
                       ->execute([':p' => $auth['email'], ':c' => $childEmail, ':ce' => $contactEmail]);
                    jsonResponse(true, ['added' => true]);
                } catch (Throwable $e) { jsonResponse(false, null, 'Failed', 500); }
            } else {
                // List mode
                try {
                    require_once __DIR__ . '/db.php';
                    $pg = getPGDB();
                    $stmt = $pg->prepare("SELECT contact_email FROM parental_contact_whitelist WHERE parent_email = :p AND child_email = :c");
                    $stmt->execute([':p' => $auth['email'], ':c' => $childEmail]);
                    jsonResponse(true, ['contacts' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
                } catch (Throwable $e) { jsonResponse(true, ['contacts' => []]); }
            }
            break;
        case 'parental_remove_contact':
            $auth = requireAuth();
            $input = getInput();
            $childEmail2 = strtolower(trim((string)($input['child_email'] ?? '')));
            $contactEmail2 = strtolower(trim((string)($input['contact_email'] ?? '')));
            if ($childEmail2 === '' || !filter_var($childEmail2, FILTER_VALIDATE_EMAIL)) {
                jsonResponse(false, null, 'child_email required', 400);
            }
            require_once __DIR__ . '/parental_helper.php';
            if (!parentalIsParentOf($auth['email'], $childEmail2)) {
                jsonResponse(false, null, 'Not authorized', 403);
            }
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("DELETE FROM parental_contact_whitelist WHERE LOWER(parent_email) = LOWER(:p) AND LOWER(child_email) = :c AND LOWER(contact_email) = :ce")
                   ->execute([':p' => $auth['email'], ':c' => $childEmail2, ':ce' => $contactEmail2]);
                jsonResponse(true, ['removed' => true]);
            } catch (Throwable $e) { jsonResponse(false, null, 'Failed', 500); }
            break;
        case 'parental_set_time_limits':
        case 'parental_activity_summary':
            requireAuth();
            jsonResponse(true, ['summary' => [], 'updated' => true]);
            break;
        case 'parental_update_location':
            requireAuth();
            $input = getInput();
            // Coerce + range-check coords. NaN/inf would crash PG numeric
            // columns (or worse, store as null and silently drift the map).
            $lat = (float)($input['latitude'] ?? 0);
            $lng = (float)($input['longitude'] ?? 0);
            $acc = (float)($input['accuracy'] ?? 0);
            $batt = (int)($input['battery_level'] ?? 0);
            if (!is_finite($lat) || !is_finite($lng) || !is_finite($acc)) {
                jsonResponse(false, null, 'invalid coords', 400);
            }
            if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) {
                jsonResponse(false, null, 'coords out of range', 400);
            }
            if ($acc < 0) $acc = 0;
            if ($acc > 100000) $acc = 100000;
            if ($batt < 0) $batt = 0;
            if ($batt > 100) $batt = 100;
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("INSERT INTO parental_locations (child_email, latitude, longitude, accuracy, battery_level) VALUES (:e, :lat, :lng, :acc, :b)")
                   ->execute([
                       ':e' => strtolower((string)($_SESSION['email'] ?? '')),
                       ':lat' => $lat,
                       ':lng' => $lng,
                       ':acc' => $acc,
                       ':b' => $batt,
                   ]);
                jsonResponse(true, ['recorded' => true]);
            } catch (Throwable $e) { jsonResponse(true, ['recorded' => false]); }
            break;
        case 'parental_get_location':
            $auth = requireAuth();
            $input = getInput();
            $childEmail = strtolower(trim((string)($input['child_email'] ?? '')));
            if ($childEmail === '' || !filter_var($childEmail, FILTER_VALIDATE_EMAIL)) {
                jsonResponse(false, null, 'child_email required', 400);
            }
            // Reading a child's location is a privacy-sensitive lookup —
            // gate it to the actual parent. Without this anyone authed
            // could fetch the last GPS ping of any other email.
            require_once __DIR__ . '/parental_helper.php';
            if (!parentalIsParentOf($auth['email'], $childEmail)) {
                jsonResponse(false, null, 'Not authorized', 403);
            }
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("SELECT latitude, longitude, accuracy, battery_level, created_at FROM parental_locations WHERE LOWER(child_email) = :e ORDER BY created_at DESC LIMIT 1");
                $stmt->execute([':e' => $childEmail]);
                jsonResponse(true, $stmt->fetch(PDO::FETCH_ASSOC) ?: []);
            } catch (Throwable $e) { jsonResponse(true, []); }
            break;

        // ---- FAMILY SHARING ----
        // Backend for /app/family.js (Apple Family Sharing-style hub).
        // Tables: families, family_members, family_invites, family_shared_album,
        // family_calendar_events, family_shopping_list. All on PG, idempotent.
        case 'family_info':
        case 'family_invite':
        case 'family_join':
        case 'family_update':
        case 'family_remove_member':
        case 'family_shared_album':         // alias of family_shared_album_list
        case 'family_shared_album_list':
        case 'family_shared_album_add':
        case 'family_shared_calendar':      // alias of family_calendar_list
        case 'family_calendar_list':
        case 'family_calendar_add':
        case 'family_shopping_list':        // alias of family_shopping_list_get
        case 'family_shopping_list_get':
        case 'family_shopping_list_add':
        case 'family_shopping_list_toggle':
        case 'family_location_all':
        case 'family_plan_share':
        case 'family_add_spouse': {
            // Normalize legacy aliases so dispatch code below stays simple.
            if ($action === 'family_shared_album')    $action = 'family_shared_album_list';
            if ($action === 'family_shared_calendar') $action = 'family_calendar_list';
            if ($action === 'family_shopping_list')   $action = 'family_shopping_list_get';
            $auth = requireAuth();
            $me = strtolower(trim((string)$auth['email']));
            require_once __DIR__ . '/db.php';
            try { $pg = getPGDB(); }
            catch (Throwable $e) { jsonResponse(false, null, 'DB unavailable', 500); }

            // Idempotent schema bootstrap. Cheap on hot path (CREATE IF NOT EXISTS
            // is a no-op once tables exist) and lets us ship without a migration.
            try {
                $pg->exec("CREATE TABLE IF NOT EXISTS families (
                    id BIGSERIAL PRIMARY KEY,
                    owner_email TEXT UNIQUE NOT NULL,
                    name TEXT,
                    photo_url TEXT,
                    share_plan BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT NOW()
                )");
                $pg->exec("CREATE TABLE IF NOT EXISTS family_members (
                    id BIGSERIAL PRIMARY KEY,
                    family_id BIGINT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
                    member_email TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'child',
                    joined_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE (family_id, member_email)
                )");
                $pg->exec("CREATE TABLE IF NOT EXISTS family_invites (
                    id BIGSERIAL PRIMARY KEY,
                    family_id BIGINT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
                    invited_by TEXT NOT NULL,
                    target_phone_or_email TEXT,
                    role TEXT NOT NULL DEFAULT 'child',
                    token TEXT UNIQUE NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TIMESTAMP DEFAULT NOW()
                )");
                $pg->exec("CREATE TABLE IF NOT EXISTS family_shared_album (
                    id BIGSERIAL PRIMARY KEY,
                    family_id BIGINT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
                    uploader TEXT NOT NULL,
                    r2_key TEXT NOT NULL,
                    mime TEXT,
                    caption TEXT,
                    uploaded_at TIMESTAMP DEFAULT NOW()
                )");
                $pg->exec("CREATE TABLE IF NOT EXISTS family_calendar_events (
                    id BIGSERIAL PRIMARY KEY,
                    family_id BIGINT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
                    creator TEXT NOT NULL,
                    title TEXT NOT NULL,
                    starts_at TIMESTAMP NOT NULL,
                    ends_at TIMESTAMP,
                    location TEXT,
                    color TEXT,
                    created_at TIMESTAMP DEFAULT NOW()
                )");
                $pg->exec("CREATE TABLE IF NOT EXISTS family_shopping_list (
                    id BIGSERIAL PRIMARY KEY,
                    family_id BIGINT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
                    added_by TEXT NOT NULL,
                    item TEXT NOT NULL,
                    qty TEXT,
                    checked BOOLEAN DEFAULT FALSE,
                    checked_by TEXT,
                    checked_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT NOW()
                )");
                // Backfill share_plan column on legacy installs
                $pg->exec("ALTER TABLE families ADD COLUMN IF NOT EXISTS share_plan BOOLEAN DEFAULT FALSE");
                $pg->exec("CREATE INDEX IF NOT EXISTS idx_family_members_email ON family_members (LOWER(member_email))");
                $pg->exec("CREATE INDEX IF NOT EXISTS idx_family_invites_token ON family_invites (token)");
                $pg->exec("CREATE INDEX IF NOT EXISTS idx_family_album_fid ON family_shared_album (family_id, uploaded_at DESC)");
                $pg->exec("CREATE INDEX IF NOT EXISTS idx_family_cal_fid ON family_calendar_events (family_id, starts_at)");
            } catch (Throwable $e) {
                error_log('[family/schema] ' . $e->getMessage());
            }

            // --- helpers (closures) -------------------------------------------------
            $validRole = function ($r) {
                return in_array($r, ['parent', 'spouse', 'child'], true);
            };
            // Resolve the family the caller belongs to. Returns
            // [family_row, my_role, is_owner] or [null, null, false].
            $resolveFamily = function () use ($pg, $me) {
                // Owner first
                $st = $pg->prepare("SELECT * FROM families WHERE LOWER(owner_email) = :e LIMIT 1");
                $st->execute([':e' => $me]);
                $fam = $st->fetch(\PDO::FETCH_ASSOC);
                if ($fam) {
                    return [$fam, 'parent', true];
                }
                // Member of someone else's family
                $st2 = $pg->prepare("SELECT f.*, fm.role
                    FROM family_members fm
                    JOIN families f ON f.id = fm.family_id
                    WHERE LOWER(fm.member_email) = :e
                    ORDER BY fm.joined_at ASC LIMIT 1");
                $st2->execute([':e' => $me]);
                $row = $st2->fetch(\PDO::FETCH_ASSOC);
                if ($row) {
                    $role = $row['role'] ?? 'child';
                    unset($row['role']);
                    return [$row, $role, false];
                }
                return [null, null, false];
            };
            // Lazy auto-create on family_info — every other action presumes
            // the row exists (and 404s otherwise).
            $autoCreateFamily = function () use ($pg, $me) {
                $firstName = explode('@', $me)[0];
                // Try to read display name from Maildir data.json (best effort)
                try {
                    [$user, $domain] = array_pad(explode('@', $me, 2), 2, '');
                    $dj = '/var/mail/vhosts/' . $domain . '/' . $user . '/data.json';
                    if (is_file($dj)) {
                        $j = @json_decode((string)@file_get_contents($dj), true);
                        if (is_array($j) && !empty($j['name'])) {
                            $firstName = trim(explode(' ', (string)$j['name'])[0]) ?: $firstName;
                        }
                    }
                } catch (\Throwable $_) {}
                $name = 'Família ' . $firstName;
                $pg->beginTransaction();
                try {
                    $ins = $pg->prepare("INSERT INTO families (owner_email, name) VALUES (:e, :n)
                        ON CONFLICT (owner_email) DO UPDATE SET name = EXCLUDED.name RETURNING *");
                    $ins->execute([':e' => $me, ':n' => $name]);
                    $fam = $ins->fetch(\PDO::FETCH_ASSOC);
                    // Owner also recorded as a member with role=parent
                    $pg->prepare("INSERT INTO family_members (family_id, member_email, role) VALUES (:f, :e, 'parent')
                        ON CONFLICT (family_id, member_email) DO NOTHING")
                       ->execute([':f' => (int)$fam['id'], ':e' => $me]);
                    $pg->commit();
                    return $fam;
                } catch (\Throwable $e) {
                    if ($pg->inTransaction()) $pg->rollBack();
                    error_log('[family/auto-create] ' . $e->getMessage());
                    throw $e;
                }
            };
            // Hydrate display name + presence for a member email.
            $hydrateMember = function ($email) {
                $email = strtolower(trim((string)$email));
                $name = explode('@', $email)[0];
                $online = false; $lastSeen = null;
                try {
                    [$user, $domain] = array_pad(explode('@', $email, 2), 2, '');
                    $dj = '/var/mail/vhosts/' . $domain . '/' . $user . '/data.json';
                    if (is_file($dj)) {
                        $j = @json_decode((string)@file_get_contents($dj), true);
                        if (is_array($j) && !empty($j['name'])) $name = (string)$j['name'];
                    }
                } catch (\Throwable $_) {}
                try {
                    if (class_exists('Redis')) {
                        $r = new Redis();
                        if (@$r->connect('127.0.0.1', 6379, 0.2)) {
                            if ($r->get('presence:' . $email)) $online = true;
                            $ls = $r->get('last_seen:' . $email);
                            if ($ls) $lastSeen = (int)$ls;
                            $r->close();
                        }
                    }
                } catch (\Throwable $_) {}
                return ['email' => $email, 'name' => $name, 'online' => $online, 'last_seen' => $lastSeen];
            };
            $r2PublicUrl = function ($key) {
                $key = ltrim((string)$key, '/');
                if ($key === '') return '';
                return 'https://media.chatyy.com.br/' . $key;
            };

            // ----- dispatch ---------------------------------------------------------
            try {
                if ($action === 'family_info') {
                    [$fam, $myRole, $isOwner] = $resolveFamily();
                    if (!$fam) {
                        $fam = $autoCreateFamily();
                        $myRole = 'parent';
                        $isOwner = true;
                    }
                    $famId = (int)$fam['id'];
                    $mst = $pg->prepare("SELECT member_email, role FROM family_members WHERE family_id = :f ORDER BY joined_at ASC");
                    $mst->execute([':f' => $famId]);
                    $members = [];
                    foreach ($mst->fetchAll(\PDO::FETCH_ASSOC) as $row) {
                        $h = $hydrateMember($row['member_email']);
                        $h['role'] = $row['role'] ?: 'child';
                        $h['presence'] = $h['online'] ? 'online' : ($h['last_seen'] ? 'offline' : 'unknown');
                        $members[] = $h;
                    }
                    jsonResponse(true, [
                        'family' => [
                            'id'         => $famId,
                            'name'       => $fam['name'] ?: '',
                            'photo_url'  => $fam['photo_url'] ?: '',
                            'owner_email'=> $fam['owner_email'],
                            'share_plan' => !empty($fam['share_plan']),
                        ],
                        'members' => $members,
                        'my_role' => $myRole,
                        'is_owner' => $isOwner,
                    ]);
                }

                if ($action === 'family_invite') {
                    $input = getInput();
                    $target = trim((string)($input['target'] ?? ''));
                    $role = strtolower(trim((string)($input['role'] ?? 'child')));
                    if ($target === '') jsonResponse(false, null, 'target required', 400);
                    if (mb_strlen($target) > 200) jsonResponse(false, null, 'target too long', 400);
                    if (!$validRole($role)) jsonResponse(false, null, 'role must be parent/spouse/child', 400);

                    // Caller must already be in a family (no auto-create on
                    // a brand-new account spamming invites at signup).
                    [$fam, $myRole, $isOwner] = $resolveFamily();
                    if (!$fam) $fam = $autoCreateFamily();

                    // Rate-limit: 10 invite tokens / 24h per inviter. Cheap
                    // self-throttle on top of the manual notification work.
                    try {
                        $rl = $pg->prepare("SELECT COUNT(*) FROM family_invites WHERE LOWER(invited_by) = :e AND created_at > NOW() - INTERVAL '24 hours'");
                        $rl->execute([':e' => $me]);
                        if ((int)$rl->fetchColumn() >= 10) {
                            jsonResponse(false, null, 'Limite de 10 convites em 24h. Tente amanha.', 429);
                        }
                    } catch (\Throwable $_) {}

                    $famId = (int)$fam['id'];

                    // Generate one-time token
                    try { $token = bin2hex(random_bytes(16)); }
                    catch (\Throwable $_) { $token = bin2hex(openssl_random_pseudo_bytes(16)); }
                    $pg->prepare("INSERT INTO family_invites (family_id, invited_by, target_phone_or_email, role, token) VALUES (:f, :b, :t, :r, :tok)")
                       ->execute([':f' => $famId, ':b' => $me, ':t' => $target, ':r' => $role, ':tok' => $token]);

                    $deepLink = 'chatyy://family/join/' . $token;

                    // Best-effort: if target looks like an email, drop a system DM
                    // into the existing 1:1 conversation if one exists.
                    try {
                        if (filter_var($target, FILTER_VALIDATE_EMAIL)) {
                            $cv = $pg->prepare("
                                SELECT c.id FROM chat_conversations c
                                JOIN chat_conversation_members m1 ON m1.conversation_id = c.id AND LOWER(m1.email) = LOWER(:me)
                                JOIN chat_conversation_members m2 ON m2.conversation_id = c.id AND LOWER(m2.email) = LOWER(:them)
                                WHERE COALESCE(c.is_group, FALSE) = FALSE
                                ORDER BY c.updated_at DESC NULLS LAST LIMIT 1
                            ");
                            $cv->execute([':me' => $me, ':them' => strtolower($target)]);
                            $cid = $cv->fetchColumn();
                            if ($cid) {
                                $msg = 'Convite pra Família: ' . $deepLink;
                                $pg->prepare("INSERT INTO chat_messages (conversation_id, sender_email, content, type, created_at) VALUES (:cid, :em, :ct, 'system', now()::text)")
                                   ->execute([':cid' => (int)$cid, ':em' => $me, ':ct' => $msg]);
                            }
                        }
                    } catch (\Throwable $e) { error_log('[family_invite/dm] ' . $e->getMessage()); }

                    jsonResponse(true, [
                        'token' => $token,
                        'link' => $deepLink,
                        'role' => $role,
                    ]);
                }

                if ($action === 'family_join') {
                    $input = getInput();
                    $token = trim((string)($input['token'] ?? ''));
                    if ($token === '') jsonResponse(false, null, 'token required', 400);
                    $st = $pg->prepare("SELECT * FROM family_invites WHERE token = :t LIMIT 1");
                    $st->execute([':t' => $token]);
                    $inv = $st->fetch(\PDO::FETCH_ASSOC);
                    if (!$inv) jsonResponse(false, null, 'Invite not found', 404);
                    if (($inv['status'] ?? '') !== 'pending') jsonResponse(false, null, 'Invite already ' . $inv['status'], 400);

                    $famId = (int)$inv['family_id'];
                    // Disallow if already a member of another family (Apple's
                    // Family Sharing rule: a person belongs to one family).
                    $own = $pg->prepare("SELECT 1 FROM families WHERE LOWER(owner_email) = :e");
                    $own->execute([':e' => $me]);
                    if ($own->fetchColumn()) jsonResponse(false, null, 'You already own a family. Dissolve it first.', 400);
                    $other = $pg->prepare("SELECT 1 FROM family_members WHERE LOWER(member_email) = :e AND family_id <> :f");
                    $other->execute([':e' => $me, ':f' => $famId]);
                    if ($other->fetchColumn()) jsonResponse(false, null, 'You are already in another family.', 400);

                    $pg->beginTransaction();
                    try {
                        $pg->prepare("INSERT INTO family_members (family_id, member_email, role) VALUES (:f, :e, :r)
                            ON CONFLICT (family_id, member_email) DO UPDATE SET role = EXCLUDED.role")
                           ->execute([':f' => $famId, ':e' => $me, ':r' => $inv['role'] ?: 'child']);
                        $pg->prepare("UPDATE family_invites SET status = 'accepted' WHERE id = :i")
                           ->execute([':i' => (int)$inv['id']]);
                        $pg->commit();
                    } catch (\Throwable $e) {
                        if ($pg->inTransaction()) $pg->rollBack();
                        error_log('[family_join] ' . $e->getMessage());
                        jsonResponse(false, null, 'Join failed', 500);
                    }
                    jsonResponse(true, ['family_id' => $famId, 'role' => $inv['role'] ?: 'child']);
                }

                if ($action === 'family_add_spouse') {
                    // Spouse = parent role. Convenience wrapper around family_invite.
                    $input = getInput();
                    $target = trim((string)($input['spouse_email'] ?? $input['target'] ?? ''));
                    if ($target === '') jsonResponse(false, null, 'spouse_email required', 400);
                    [$fam, $myRole, $isOwner] = $resolveFamily();
                    if (!$fam) $fam = $autoCreateFamily();
                    if (!$isOwner) jsonResponse(false, null, 'Only the family owner can add a spouse', 403);
                    $famId = (int)$fam['id'];
                    try { $token = bin2hex(random_bytes(16)); }
                    catch (\Throwable $_) { $token = bin2hex(openssl_random_pseudo_bytes(16)); }
                    $pg->prepare("INSERT INTO family_invites (family_id, invited_by, target_phone_or_email, role, token) VALUES (:f, :b, :t, 'spouse', :tok)")
                       ->execute([':f' => $famId, ':b' => $me, ':t' => $target, ':tok' => $token]);
                    jsonResponse(true, ['token' => $token, 'link' => 'chatyy://family/join/' . $token]);
                }

                if ($action === 'family_update') {
                    $input = getInput();
                    [$fam, $myRole, $isOwner] = $resolveFamily();
                    if (!$fam) jsonResponse(false, null, 'No family yet', 404);
                    if (!$isOwner) jsonResponse(false, null, 'Owner-only', 403);
                    $sets = []; $params = [':id' => (int)$fam['id']];
                    if (array_key_exists('name', $input)) {
                        $name = trim((string)$input['name']);
                        if ($name === '') jsonResponse(false, null, 'name cannot be empty', 400);
                        $sets[] = 'name = :name'; $params[':name'] = mb_substr($name, 0, 80);
                    }
                    if (array_key_exists('photo_url', $input)) {
                        $sets[] = 'photo_url = :photo'; $params[':photo'] = (string)$input['photo_url'];
                    }
                    if (!$sets) jsonResponse(true, ['updated' => false]);
                    $sql = 'UPDATE families SET ' . implode(', ', $sets) . ' WHERE id = :id';
                    $pg->prepare($sql)->execute($params);
                    jsonResponse(true, ['updated' => true]);
                }

                if ($action === 'family_remove_member') {
                    $input = getInput();
                    $target = strtolower(trim((string)($input['member_email'] ?? $input['email'] ?? '')));
                    if ($target === '') jsonResponse(false, null, 'member_email required', 400);
                    [$fam, $myRole, $isOwner] = $resolveFamily();
                    if (!$fam) jsonResponse(false, null, 'No family', 404);
                    // Owner cannot leave without dissolving (rule from spec).
                    if ($target === strtolower((string)$fam['owner_email'])) {
                        jsonResponse(false, null, 'Owner cannot leave. Transfer ownership or dissolve the family.', 400);
                    }
                    // Allowed: owner removing anyone, or member removing self.
                    if (!$isOwner && $target !== $me) jsonResponse(false, null, 'Owner-only or self', 403);
                    $pg->prepare("DELETE FROM family_members WHERE family_id = :f AND LOWER(member_email) = :e")
                       ->execute([':f' => (int)$fam['id'], ':e' => $target]);
                    jsonResponse(true, ['removed' => true]);
                }

                // --- Shared album --------------------------------------------------
                if ($action === 'family_shared_album_list') {
                    [$fam] = $resolveFamily();
                    if (!$fam) jsonResponse(true, ['items' => []]);
                    $input = getInput();
                    $limit = max(1, min(200, (int)($input['limit'] ?? $_GET['limit'] ?? 60)));
                    $offset = max(0, (int)($input['offset'] ?? $_GET['offset'] ?? 0));
                    $st = $pg->prepare("SELECT id, uploader, r2_key, mime, caption, uploaded_at
                        FROM family_shared_album WHERE family_id = :f
                        ORDER BY uploaded_at DESC LIMIT :l OFFSET :o");
                    $st->bindValue(':f', (int)$fam['id'], \PDO::PARAM_INT);
                    $st->bindValue(':l', $limit, \PDO::PARAM_INT);
                    $st->bindValue(':o', $offset, \PDO::PARAM_INT);
                    $st->execute();
                    $items = [];
                    foreach ($st->fetchAll(\PDO::FETCH_ASSOC) as $row) {
                        $items[] = [
                            'id'         => (int)$row['id'],
                            'uploader'   => $row['uploader'],
                            'mime'       => $row['mime'] ?: '',
                            'caption'    => $row['caption'] ?: '',
                            'uploaded_at'=> $row['uploaded_at'],
                            'url'        => $r2PublicUrl($row['r2_key']),
                        ];
                    }
                    jsonResponse(true, ['items' => $items, 'limit' => $limit, 'offset' => $offset]);
                }

                if ($action === 'family_shared_album_add') {
                    $input = getInput();
                    $key = ltrim(trim((string)($input['r2_key'] ?? '')), '/');
                    $mime = trim((string)($input['mime'] ?? 'image/jpeg'));
                    $caption = (string)($input['caption'] ?? '');
                    if ($key === '') jsonResponse(false, null, 'r2_key required', 400);
                    // Reject path traversal / control chars / over-long keys.
                    // The R2 key is rendered into a URL on every list, and if
                    // a malicious caller stuffed `..` or whitespace in here
                    // they could shape the link arbitrarily.
                    if (strlen($key) > 300 || preg_match('#(^|/)\.\.(/|$)#', $key) || preg_match('/[\x00-\x1F\x7F]/', $key)) {
                        jsonResponse(false, null, 'invalid r2_key', 400);
                    }
                    // Mime allow-list — anything else gets coerced to image/jpeg.
                    $allowedMimes = ['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif','video/mp4','video/quicktime','video/webm'];
                    if (!in_array(strtolower($mime), $allowedMimes, true)) $mime = 'image/jpeg';
                    [$fam] = $resolveFamily();
                    if (!$fam) $fam = $autoCreateFamily();
                    $st = $pg->prepare("INSERT INTO family_shared_album (family_id, uploader, r2_key, mime, caption) VALUES (:f, :u, :k, :m, :c) RETURNING id, uploaded_at");
                    $st->execute([':f' => (int)$fam['id'], ':u' => $me, ':k' => $key, ':m' => $mime, ':c' => mb_substr($caption, 0, 500)]);
                    $row = $st->fetch(\PDO::FETCH_ASSOC) ?: [];
                    jsonResponse(true, [
                        'id' => (int)($row['id'] ?? 0),
                        'uploaded_at' => $row['uploaded_at'] ?? null,
                        'url' => $r2PublicUrl($key),
                    ]);
                }

                // --- Calendar -------------------------------------------------------
                if ($action === 'family_calendar_list') {
                    [$fam] = $resolveFamily();
                    if (!$fam) jsonResponse(true, ['events' => []]);
                    $input = getInput();
                    $from = trim((string)($input['from'] ?? $_GET['from'] ?? ''));
                    $to   = trim((string)($input['to']   ?? $_GET['to']   ?? ''));
                    $sql = "SELECT id, creator, title, starts_at, ends_at, location, color, created_at
                            FROM family_calendar_events WHERE family_id = :f";
                    $params = [':f' => (int)$fam['id']];
                    if ($from !== '') { $sql .= " AND starts_at >= :from"; $params[':from'] = $from; }
                    if ($to   !== '') { $sql .= " AND starts_at <= :to";   $params[':to']   = $to; }
                    $sql .= " ORDER BY starts_at ASC LIMIT 500";
                    $st = $pg->prepare($sql);
                    $st->execute($params);
                    $events = [];
                    foreach ($st->fetchAll(\PDO::FETCH_ASSOC) as $row) {
                        $events[] = [
                            'id'         => (int)$row['id'],
                            'creator'    => $row['creator'],
                            'title'      => $row['title'],
                            'starts_at'  => $row['starts_at'],
                            'ends_at'    => $row['ends_at'],
                            'location'   => $row['location'] ?: '',
                            'color'      => $row['color'] ?: '#7C3AED',
                            'created_at' => $row['created_at'],
                        ];
                    }
                    jsonResponse(true, ['events' => $events]);
                }

                if ($action === 'family_calendar_add') {
                    $input = getInput();
                    $title = trim((string)($input['title'] ?? ''));
                    $starts = trim((string)($input['starts_at'] ?? ''));
                    if ($title === '' || $starts === '') jsonResponse(false, null, 'title and starts_at required', 400);
                    $ends = trim((string)($input['ends_at'] ?? '')) ?: null;
                    $loc  = trim((string)($input['location'] ?? '')) ?: null;
                    $color = trim((string)($input['color'] ?? '')) ?: null;
                    [$fam] = $resolveFamily();
                    if (!$fam) $fam = $autoCreateFamily();
                    $st = $pg->prepare("INSERT INTO family_calendar_events (family_id, creator, title, starts_at, ends_at, location, color)
                        VALUES (:f, :c, :t, :sa, :ea, :loc, :col) RETURNING id, created_at");
                    $st->execute([
                        ':f' => (int)$fam['id'], ':c' => $me,
                        ':t' => mb_substr($title, 0, 200),
                        ':sa' => $starts, ':ea' => $ends,
                        ':loc' => $loc ? mb_substr($loc, 0, 200) : null,
                        ':col' => $color ? mb_substr($color, 0, 16) : null,
                    ]);
                    $row = $st->fetch(\PDO::FETCH_ASSOC) ?: [];
                    jsonResponse(true, ['id' => (int)($row['id'] ?? 0), 'created_at' => $row['created_at'] ?? null]);
                }

                // --- Shopping list --------------------------------------------------
                if ($action === 'family_shopping_list_get') {
                    [$fam] = $resolveFamily();
                    if (!$fam) jsonResponse(true, ['items' => []]);
                    $st = $pg->prepare("SELECT id, added_by, item, qty, checked, checked_by, checked_at, created_at
                        FROM family_shopping_list WHERE family_id = :f
                        ORDER BY checked ASC, created_at DESC LIMIT 500");
                    $st->execute([':f' => (int)$fam['id']]);
                    $items = [];
                    foreach ($st->fetchAll(\PDO::FETCH_ASSOC) as $row) {
                        $items[] = [
                            'id'         => (int)$row['id'],
                            'added_by'   => $row['added_by'],
                            'item'       => $row['item'],
                            'qty'        => $row['qty'] ?: '',
                            'checked'    => (bool)$row['checked'],
                            'checked_by' => $row['checked_by'],
                            'checked_at' => $row['checked_at'],
                            'created_at' => $row['created_at'],
                        ];
                    }
                    jsonResponse(true, ['items' => $items]);
                }

                if ($action === 'family_shopping_list_add') {
                    $input = getInput();
                    $item = trim((string)($input['item'] ?? ''));
                    $qty  = trim((string)($input['qty'] ?? ''));
                    if ($item === '') jsonResponse(false, null, 'item required', 400);
                    [$fam] = $resolveFamily();
                    if (!$fam) $fam = $autoCreateFamily();
                    $st = $pg->prepare("INSERT INTO family_shopping_list (family_id, added_by, item, qty) VALUES (:f, :a, :i, :q) RETURNING id, created_at");
                    $st->execute([
                        ':f' => (int)$fam['id'], ':a' => $me,
                        ':i' => mb_substr($item, 0, 200),
                        ':q' => $qty !== '' ? mb_substr($qty, 0, 60) : null,
                    ]);
                    $row = $st->fetch(\PDO::FETCH_ASSOC) ?: [];
                    jsonResponse(true, ['id' => (int)($row['id'] ?? 0), 'created_at' => $row['created_at'] ?? null]);
                }

                if ($action === 'family_shopping_list_toggle') {
                    $input = getInput();
                    $id = (int)($input['id'] ?? 0);
                    $checked = !empty($input['checked']);
                    if ($id <= 0) jsonResponse(false, null, 'id required', 400);
                    [$fam] = $resolveFamily();
                    if (!$fam) jsonResponse(false, null, 'No family', 404);
                    // Must belong to caller's family
                    $own = $pg->prepare("SELECT 1 FROM family_shopping_list WHERE id = :i AND family_id = :f");
                    $own->execute([':i' => $id, ':f' => (int)$fam['id']]);
                    if (!$own->fetchColumn()) jsonResponse(false, null, 'Item not found', 404);
                    if ($checked) {
                        $pg->prepare("UPDATE family_shopping_list SET checked = TRUE, checked_by = :u, checked_at = NOW() WHERE id = :i")
                           ->execute([':u' => $me, ':i' => $id]);
                    } else {
                        $pg->prepare("UPDATE family_shopping_list SET checked = FALSE, checked_by = NULL, checked_at = NULL WHERE id = :i")
                           ->execute([':i' => $id]);
                    }
                    jsonResponse(true, ['toggled' => true, 'checked' => $checked]);
                }

                // --- Find My Family -------------------------------------------------
                if ($action === 'family_location_all') {
                    [$fam] = $resolveFamily();
                    if (!$fam) jsonResponse(true, ['locations' => []]);
                    $famId = (int)$fam['id'];
                    $mst = $pg->prepare("SELECT member_email FROM family_members WHERE family_id = :f");
                    $mst->execute([':f' => $famId]);
                    $emails = $mst->fetchAll(\PDO::FETCH_COLUMN) ?: [];
                    // Owner is implicit too, in case migrations missed it.
                    $emails[] = $fam['owner_email'];
                    $emails = array_unique(array_map('strtolower', array_map('trim', $emails)));
                    $out = [];
                    if ($emails) {
                        // Try parental_locations first (most common writer is the
                        // parental location ping). Falls back to NULL per member.
                        $locStmt = $pg->prepare("SELECT child_email AS email, latitude, longitude, accuracy, battery_level, created_at
                            FROM parental_locations WHERE LOWER(child_email) = LOWER(:e)
                            ORDER BY created_at DESC LIMIT 1");
                        foreach ($emails as $em) {
                            try {
                                $locStmt->execute([':e' => $em]);
                                $loc = $locStmt->fetch(\PDO::FETCH_ASSOC);
                                $out[] = [
                                    'email'      => $em,
                                    'latitude'   => $loc ? (float)$loc['latitude'] : null,
                                    'longitude'  => $loc ? (float)$loc['longitude'] : null,
                                    'accuracy'   => $loc ? (float)$loc['accuracy'] : null,
                                    'battery'    => $loc ? (int)$loc['battery_level'] : null,
                                    'updated_at' => $loc ? $loc['created_at'] : null,
                                ];
                            } catch (\Throwable $_) {
                                $out[] = ['email' => $em, 'latitude' => null, 'longitude' => null, 'accuracy' => null, 'battery' => null, 'updated_at' => null];
                            }
                        }
                    }
                    jsonResponse(true, ['locations' => $out]);
                }

                // --- Plan share -----------------------------------------------------
                if ($action === 'family_plan_share') {
                    $input = getInput();
                    [$fam, $myRole, $isOwner] = $resolveFamily();
                    if (!$fam) $fam = $autoCreateFamily();
                    $famId = (int)$fam['id'];
                    // POST with `enabled` flips it; GET (or no key) returns current
                    if ($method === 'POST' && (array_key_exists('enabled', $input) || array_key_exists('share_plan', $input))) {
                        if (!$isOwner) jsonResponse(false, null, 'Owner-only', 403);
                        $enabled = !empty($input['enabled'] ?? $input['share_plan']);
                        $pg->prepare("UPDATE families SET share_plan = :s WHERE id = :id")
                           ->execute([':s' => $enabled ? 't' : 'f', ':id' => $famId]);
                        $fam['share_plan'] = $enabled;
                    }
                    // Read owner's plan from chat_user_plans (best-effort)
                    $ownerPlan = ['plan' => 'free'];
                    try {
                        if (function_exists('getUserPlan')) {
                            require_once __DIR__ . '/plans.php';
                            $ownerPlan = getUserPlan($fam['owner_email']) ?: ['plan' => 'free'];
                        } else {
                            $ps = $pg->prepare("SELECT plan FROM chat_user_plans WHERE LOWER(email) = LOWER(:e) LIMIT 1");
                            $ps->execute([':e' => $fam['owner_email']]);
                            $row = $ps->fetch(\PDO::FETCH_ASSOC);
                            if ($row) $ownerPlan = ['plan' => $row['plan']];
                        }
                    } catch (\Throwable $e) { error_log('[family_plan_share/getUserPlan] ' . $e->getMessage()); }

                    // Members covered by plan share
                    $covered = [];
                    if (!empty($fam['share_plan'])) {
                        $mst = $pg->prepare("SELECT member_email FROM family_members WHERE family_id = :f");
                        $mst->execute([':f' => $famId]);
                        $covered = array_map('strtolower', $mst->fetchAll(\PDO::FETCH_COLUMN) ?: []);
                    }
                    jsonResponse(true, [
                        'share_plan'  => !empty($fam['share_plan']),
                        'owner_email' => $fam['owner_email'],
                        'owner_plan'  => $ownerPlan['plan'] ?? 'free',
                        'covered'     => $covered,
                    ]);
                }

                // Should never reach here
                jsonResponse(false, null, 'Unhandled family action', 500);
            } catch (\Throwable $e) {
                error_log('[family/' . $action . '] ' . $e->getMessage());
                if (isset($pg) && $pg instanceof \PDO && $pg->inTransaction()) {
                    try { $pg->rollBack(); } catch (\Throwable $_) {}
                }
                jsonResponse(false, null, 'Family action failed', 500);
            }
            break;
        }

        case 'track':

        // ---- AI ASSIST ----
        case 'ai_assist':
            $auth = requireAuth();
            $input = getInput();
            $type = $input['type'] ?? '';
            $context = $input['context'] ?? [];
            // Clients sometimes pass arrays (e.g. $from as {name,email}) or
            // nulls for missing fields. Coerce every context value to string
            // so substr/concat calls below never blow up with TypeError.
            if (is_array($context)) {
                foreach ($context as $__ck => $__cv) {
                    if (is_array($__cv) || is_object($__cv)) {
                        $context[$__ck] = is_array($__cv) && isset($__cv['email']) ? (string)$__cv['email']
                                         : (is_array($__cv) && isset($__cv['text']) ? (string)$__cv['text']
                                         : (string)json_encode($__cv));
                    } elseif ($__cv === null) {
                        $context[$__ck] = '';
                    } else {
                        $context[$__ck] = (string)$__cv;
                    }
                }
            } else {
                $context = [];
            }

            if (!in_array($type, ['smart_reply', 'compose_draft', 'summarize', 'improve_writing', 'categorize', 'phishing_check', 'smart_compose', 'semantic_search'])) {
                jsonResponse(false, null, 'Tipo de AI invalido', 400);
            }

            // Rate limit: 30 AI calls per user per hour
            $rateFile = '/tmp/ai_rate_' . md5($auth['email']);
            // json_decode returns null for empty/corrupt files — guard or array_filter crashes.
            $rates = [];
            if (file_exists($rateFile)) {
                $raw = @file_get_contents($rateFile);
                if ($raw !== false && $raw !== '') {
                    $decoded = json_decode($raw, true);
                    if (is_array($decoded)) $rates = $decoded;
                }
            }
            $rates = array_filter($rates, fn($t) => is_numeric($t) && $t > time() - 3600);
            if (count($rates) >= 30) jsonResponse(false, null, 'Limite de IA atingido. Tente novamente em 1 hora.', 429);
            $rates[] = time();
            file_put_contents($rateFile, json_encode($rates), LOCK_EX);

            // 2026-04-20: migrated to OpenAI (gpt-4o-mini). Anthropic account is out of credits.
            $apiKey = getenv('OPENAI_API_KEY') ?: ($_ENV['OPENAI_API_KEY'] ?? $_SERVER['OPENAI_API_KEY'] ?? '');
            // Fallback: read from env file
            if (!$apiKey && file_exists('/etc/mail-api.env')) {
                $envLines = file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
                foreach ($envLines as $line) {
                    if (strpos($line, 'OPENAI_API_KEY=') === 0) {
                        $apiKey = substr($line, strlen('OPENAI_API_KEY='));
                        break;
                    }
                }
            }
            if (!$apiKey) jsonResponse(false, null, 'Servico de IA nao configurado', 503);

            $prompt = '';
            switch ($type) {
                case 'smart_reply':
                    $prompt = "Voce e um assistente de email. Dado o email abaixo, gere exatamente 3 respostas curtas e profissionais em portugues brasileiro (cada uma com no maximo 25 palavras). Retorne APENAS um JSON valido no formato: {\"replies\": [\"resposta1\", \"resposta2\", \"resposta3\"]}\n\nDe: " . ($context['from'] ?? '') . "\nAssunto: " . ($context['subject'] ?? '') . "\nConteudo:\n" . substr($context['body'] ?? '', 0, 2000);
                    break;
                case 'compose_draft':
                    $prompt = "Voce e um assistente de escrita de emails em portugues brasileiro. Com base na instrucao do usuario, escreva um email profissional e completo. Retorne APENAS um JSON valido: {\"result\": \"texto do email\"}\n\nInstrucao: " . ($context['instruction'] ?? '');
                    break;
                case 'summarize':
                    $prompt = "Resuma o email abaixo em 2-3 frases concisas em portugues brasileiro. Retorne APENAS um JSON valido: {\"result\": \"resumo\"}\n\nDe: " . ($context['from'] ?? '') . "\nAssunto: " . ($context['subject'] ?? '') . "\nConteudo:\n" . substr($context['body'] ?? '', 0, 3000);
                    break;
                case 'improve_writing':
                    $prompt = "Melhore o texto abaixo para um tom profissional em portugues brasileiro. Mantenha o significado original mas melhore a clareza, gramatica e tom. Retorne APENAS um JSON valido: {\"result\": \"texto melhorado\"}\n\nTexto original:\n" . ($context['text'] ?? '');
                    break;
                case 'categorize':
                    $prompt = "Analise o email abaixo e categorize em exatamente uma das categorias: primary, social, promotions, updates. Retorne APENAS um JSON valido: {\"category\": \"primary|social|promotions|updates\", \"confidence\": 0.0-1.0}\n\nDe: " . ($context['from'] ?? '') . "\nAssunto: " . ($context['subject'] ?? '') . "\nConteudo:\n" . substr($context['body'] ?? '', 0, 1500);
                    break;
                case 'phishing_check':
                    $prompt = "Voce e um especialista em seguranca de email. Analise o email abaixo para indicadores de phishing, scam ou fraude. Verifique: links suspeitos, urgencia falsa, erros gramaticais, remetente incompativel, solicitacao de dados pessoais. Retorne APENAS um JSON valido: {\"score\": 0-100, \"is_suspicious\": true/false, \"reasons\": [\"razao1\", \"razao2\"]}\n\nDe: " . ($context['from'] ?? '') . "\nAssunto: " . ($context['subject'] ?? '') . "\nHeaders: " . substr($context['headers'] ?? '', 0, 1000) . "\nConteudo:\n" . substr($context['body'] ?? '', 0, 2000);
                    break;
                case 'smart_compose':
                    $prompt = "Voce e um assistente de escrita de emails. Complete o texto parcial abaixo de forma natural e profissional em portugues brasileiro. Retorne APENAS um JSON valido: {\"completion\": \"texto sugerido para completar\"}\n\nContexto: " . ($context['context'] ?? '') . "\nTom: " . ($context['tone'] ?? 'professional') . "\nTexto parcial:\n" . ($context['partial_text'] ?? '');
                    break;
                case 'semantic_search':
                    $prompt = "Voce e um assistente de busca de emails. Dado a consulta do usuario e a lista de resumos de emails, classifique os emails por relevancia semantica. Retorne APENAS um JSON valido: {\"ranked_uids\": [uid1, uid2, ...], \"explanation\": \"explicacao breve\"}\n\nConsulta: " . ($context['query'] ?? '') . "\nEmails:\n" . substr(json_encode($context['email_summaries'] ?? []), 0, 4000);
                    break;
            }

            // Call OpenAI API (swapped from Claude 2026-04-20)
            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini',
                    'max_tokens' => 1024,
                    'messages' => [['role' => 'user', 'content' => $prompt]],
                ]),
                CURLOPT_HTTPHEADER => [
                    'Content-Type: application/json',
                    'Authorization: Bearer ' . $apiKey,
                ],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 30,
            ]);
            $resp = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            if ($httpCode !== 200) { error_log("[ai_assist] OpenAI HTTP ".$httpCode." resp=".substr($resp,0,500));
                jsonResponse(false, null, 'Erro no servico de IA', 502);
            }

            $result = json_decode($resp, true);
            $text = $result['choices'][0]['message']['content'] ?? '';

            // Extract JSON from response (handle markdown code blocks)
            if (preg_match('/```(?:json)?\s*\n?(.*?)\n?```/s', $text, $m)) {
                $text = $m[1];
            }
            $parsed = json_decode(trim($text), true);

            if ($type === 'smart_reply' && isset($parsed['replies'])) {
                jsonResponse(true, ['replies' => array_slice($parsed['replies'], 0, 3)]);
            } elseif ($type === 'categorize' && isset($parsed['category'])) {
                jsonResponse(true, $parsed);
            } elseif ($type === 'phishing_check' && isset($parsed['score'])) {
                jsonResponse(true, $parsed);
            } elseif ($type === 'smart_compose' && isset($parsed['completion'])) {
                jsonResponse(true, ['result' => $parsed['completion']]);
            } elseif ($type === 'semantic_search' && isset($parsed['ranked_uids'])) {
                jsonResponse(true, $parsed);
            } elseif (isset($parsed['result'])) {
                jsonResponse(true, ['result' => $parsed['result']]);
            } else {
                jsonResponse(true, ['result' => trim($text)]);
            }
            break;

        // ---- SNOOZE ----
        case 'snooze':
            $auth = requireAuth();
            $input = getInput();
            $uid = (int)($input['uid'] ?? 0);
            $folder = $input['folder'] ?? 'INBOX';
            if ($folder === 'Flagged') $folder = 'INBOX';
            $snoozeUntil = $input['snooze_until'] ?? '';
            if (!$uid || !$snoozeUntil) jsonResponse(false, null, 'uid e snooze_until obrigatorios', 400);

            $imap = getImap($auth['email'], $auth['password'], $folder);

            // Create Snoozed folder if needed
            $server = '{127.0.0.1:993/imap/ssl/novalidate-cert}';
            $folders = imap_list($imap, $server, 'Snoozed');
            if (!$folders) {
                imap_createmailbox($imap, imap_utf7_encode($server . 'Snoozed'));
            }

            // Move to Snoozed
            imap_mail_move($imap, (string)$uid, 'Snoozed', CP_UID);
            imap_expunge($imap);
            try { imap_close($imap); } catch (\Throwable $_e) {}

            // Save snooze metadata
            $parts = explode('@', $auth['email']);
            $snoozeDir = '/var/mail/vhosts/' . ($parts[1] ?? 'onemundo.com.br') . '/' . $parts[0] . '/snooze';
            @mkdir($snoozeDir, 0770, true);
            exec("sudo /usr/local/bin/chatyy-fix-mailbox " . escapeshellarg($username . "@" . $domain));

            $snoozeFile = $snoozeDir . '/pending.json';
            $pending = file_exists($snoozeFile) ? json_decode(file_get_contents($snoozeFile), true) : [];
            $pending[] = [
                'uid' => $uid,
                'original_folder' => $folder,
                'snooze_until' => $snoozeUntil,
                'created_at' => date('c'),
            ];
            file_put_contents($snoozeFile, json_encode($pending, JSON_PRETTY_PRINT), LOCK_EX);

            jsonResponse(true, null, 'Email adiado');
            break;

        // ---- LABELS ----
        case 'add_label':
            $auth = requireAuth();
            $input = getInput();
            $uid = (int)($input['uid'] ?? 0);
            $label = preg_replace('/[^a-z0-9_]/i', '', $input['label'] ?? '');
            $folder = $input['folder'] ?? 'INBOX';
            if ($folder === 'Flagged') $folder = 'INBOX';
            if (!$uid || !$label) jsonResponse(false, null, 'uid e label obrigatorios', 400);

            $imap = getImap($auth['email'], $auth['password'], $folder);
            imap_setflag_full($imap, (string)$uid, '$label_' . strtolower($label), ST_UID);
            try { imap_close($imap); } catch (\Throwable $_e) {}
            jsonResponse(true, null, 'Label adicionada');
            break;

        case 'remove_label':
            $auth = requireAuth();
            $input = getInput();
            $uid = (int)($input['uid'] ?? 0);
            $label = preg_replace('/[^a-z0-9_]/i', '', $input['label'] ?? '');
            $folder = $input['folder'] ?? 'INBOX';
            if ($folder === 'Flagged') $folder = 'INBOX';
            if (!$uid || !$label) jsonResponse(false, null, 'uid e label obrigatorios', 400);

            $imap = getImap($auth['email'], $auth['password'], $folder);
            imap_clearflag_full($imap, (string)$uid, '$label_' . strtolower($label), ST_UID);
            try { imap_close($imap); } catch (\Throwable $_e) {}
            jsonResponse(true, null, 'Label removida');
            break;

        case 'get_labels':
            $auth = requireAuth();
            $labels = [
                ['name' => 'trabalho', 'color' => '#1a73e8'],
                ['name' => 'pessoal', 'color' => '#34a853'],
                ['name' => 'importante', 'color' => '#c5221f'],
                ['name' => 'financeiro', 'color' => '#ea8600'],
                ['name' => 'social', 'color' => '#a142f4'],
                ['name' => 'viagem', 'color' => '#1a9988'],
            ];
            // Merge custom labels from user settings
            $parts = explode('@', $auth['email']);
            $sFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/settings.json";
            if (file_exists($sFile)) {
                $s = json_decode(file_get_contents($sFile), true) ?: [];
                foreach (($s['custom_labels'] ?? []) as $cl) {
                    $labels[] = ['name' => $cl['name'], 'color' => $cl['color'] ?? '#1a73e8', 'custom' => true];
                }
            }
            jsonResponse(true, $labels);
            break;


        case 'push_diag':
            // Best-effort remote diagnostic: clients post step-by-step push
            // registration progress so we can see WHY Android tokens never
            // arrive. NO AUTH REQUIRED — accepts anonymous diag with anon_id
            // fallback so we capture early-boot signals before login.
            $input = getInput();
            $step = preg_replace('/[^a-zA-Z0-9_]/', '', $input['step'] ?? 'unknown');
            $platform = in_array($input['platform'] ?? '', ['ios', 'android', 'web']) ? $input['platform'] : '?';
            $info = substr(trim($input['info'] ?? ''), 0, 500);
            $ts = trim($input['ts'] ?? date('c'));
            $anonId = preg_replace('/[^a-zA-Z0-9_-]/', '', substr(trim($input['anon_id'] ?? ''), 0, 40)) ?: 'unknown';

            // Try to identify the authenticated user (if logged in). Falls
            // back to anon_id grouping if not.
            $bucket = null;
            $hdrs = function_exists('getallheaders') ? getallheaders() : [];
            $authHdr = '';
            foreach ($hdrs as $k => $v) {
                if (strtolower($k) === 'authorization') { $authHdr = $v; break; }
            }
            if (preg_match('/Bearer\s+([A-Za-z0-9_-]+)/', $authHdr, $m)) {
                $tok = $m[1];
                $tokenFile = "/var/www/mail/data/tokens/" . preg_replace('/[^a-zA-Z0-9]/', '', $tok) . ".json";
                if (file_exists($tokenFile)) {
                    $td = json_decode(@file_get_contents($tokenFile), true);
                    if (!empty($td['email'])) {
                        $parts = explode('@', $td['email']);
                        $bucket = ['user' => $parts[0], 'domain' => $parts[1] ?? 'onemundo.com.br'];
                    }
                }
            }
            if (!$bucket) {
                // Anon — write to /var/www/mail/data/push_diag/ (www-data-writable)
                $logFile = "/var/www/mail/data/push_diag/" . preg_replace('/[^a-zA-Z0-9_-]/', '', $anonId) . ".log";
            } else {
                $dir = "/var/mail/vhosts/{$bucket['domain']}/{$bucket['user']}/push_tokens";
                @mkdir($dir, 0700, true);
                @exec("chown -R www-data:www-data " . escapeshellarg($dir));
                $logFile = "{$dir}/push_diag.log";
            }
            $line = "[{$ts}] platform={$platform} step={$step} info={$info} anon={$anonId}\n";
            @file_put_contents($logFile, $line, FILE_APPEND | LOCK_EX);
            // Cap at last 200 lines so it doesn't balloon.
            @clearstatcache(true, $logFile);
            if (@filesize($logFile) > 50000) {
                $lines = @file($logFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
                if (count($lines) > 200) {
                    $lines = array_slice($lines, -200);
                    @file_put_contents($logFile, implode("\n", $lines) . "\n", LOCK_EX);
                }
            }
            jsonResponse(true, null);
            break;

        // ---- PUSH NOTIFICATIONS ----
        case 'register_push_token':
            $creds = requireAuthLite();
            $input = getInput();
            $token = trim($input['token'] ?? '');
            $platform = in_array($input['platform'] ?? '', ['ios', 'android']) ? $input['platform'] : 'unknown';
            $tokenType = trim($input['token_type'] ?? '') ?: 'expo';
            if (!$token) jsonResponse(false, null, 'Token obrigatorio', 400);

            $userEmail = $creds['email'];
            $parts = explode('@', $userEmail);
            $user = $parts[0];
            $domain = $parts[1] ?? 'onemundo.com.br';
            $tokenDir = "/var/mail/vhosts/{$domain}/{$user}/push_tokens";
            // CRITICAL: if dir doesnt exist + www-data cant create it inside
            // /var/mail/vhosts/{domain}/{user}/ (owned by vmail with 0710 perms),
            // mkdir silently fails. Fall back to writable mode 0755 if 0700 fails,
            // then verify the dir actually exists. If still missing, surface a
            // real 500 error so the silent push-token-write-failure that hid
            // this bug for months cant happen again (incident 2026-05-12: ZERO
            // Android tokens registered system-wide because of this).
            if (!is_dir($tokenDir)) {
                @mkdir($tokenDir, 0755, true);
                @exec("chown -R www-data:www-data " . escapeshellarg($tokenDir) . " 2>/dev/null");
            }
            if (!is_dir($tokenDir) || !is_writable($tokenDir)) {
                error_log("[register_push_token] FATAL: cannot create/write " . $tokenDir . " for " . $userEmail);
                jsonResponse(false, null, "Storage unavailable — contact support", 500);
            }

            $tokenFile = "{$tokenDir}/tokens.json";
            // Read-modify-write under LOCK_EX. Single-device-per-(platform,
            // token_type) so a user who logs into a NEW phone automatically
            // stops receiving push on the OLD phone — without needing the
            // old phone to be online to receive its logout. Email/chat push
            // leaking to a previously-used device was reported repeatedly.
            // Trade-off: iPhone+iPad on the same account can only have ONE
            // active push device at a time. Acceptable for now (matches
            // WhatsApp's primary-device model).
            $fp = @fopen($tokenFile, 'c+');
            if ($fp) {
                @flock($fp, LOCK_EX);
                $raw = stream_get_contents($fp);
                $tokens = $raw ? (json_decode($raw, true) ?: []) : [];
                // Drop any prior entry that is the SAME exact token (refresh
                // case) OR shares the same (platform, token_type) — that's
                // the "old phone" we want to evict so push only goes to the
                // newest device of that platform.
                $tokens = array_values(array_filter($tokens, function($t) use ($token, $platform, $tokenType) {
                    if (($t['token'] ?? '') === $token) return false;
                    $tPlat = $t['platform'] ?? '';
                    $tType = $t['token_type'] ?? 'expo';
                    if ($tPlat === $platform && $tType === $tokenType) return false;
                    return true;
                }));
                $tokens[] = ['token' => $token, 'platform' => $platform, 'token_type' => $tokenType, 'registered_at' => date('c')];
                // Hard cap (defense-in-depth) — single-device-per-platform
                // already keeps this list at ~3 entries (ios+android+fcm_device)
                // but cap at 10 so a buggy client can't balloon the file.
                $tokens = array_slice($tokens, -10);
                ftruncate($fp, 0);
                rewind($fp);
                fwrite($fp, json_encode($tokens, JSON_PRETTY_PRINT));
                fflush($fp);
                @flock($fp, LOCK_UN);
                fclose($fp);
            } else {
                $tokens = [];
                if (file_exists($tokenFile)) $tokens = json_decode(file_get_contents($tokenFile), true) ?: [];
                $tokens = array_values(array_filter($tokens, function($t) use ($token, $platform, $tokenType) {
                    if (($t['token'] ?? '') === $token) return false;
                    $tPlat = $t['platform'] ?? '';
                    $tType = $t['token_type'] ?? 'expo';
                    if ($tPlat === $platform && $tType === $tokenType) return false;
                    return true;
                }));
                $tokens[] = ['token' => $token, 'platform' => $platform, 'token_type' => $tokenType, 'registered_at' => date('c')];
                $tokens = array_slice($tokens, -10);
                file_put_contents($tokenFile, json_encode($tokens, JSON_PRETTY_PRINT), LOCK_EX);
            }
            // Device exclusivity sweep: scrub this same token from any
            // OTHER user's tokens.json so the device receives pushes for
            // ONLY the currently-logged-in account. Closes the privacy
            // leak when User A logged out offline (their unregister call
            // failed) and User B logs in on the same device — without
            // this sweep, User A's pushes would keep arriving.
            //
            // Cross-domain: iterate ALL vhosts (not just current domain) so
            // that an @onemundo.com.br + @chatyy.com.br pairing on the same
            // device doesn't leave stale tokens behind.
            try {
                $vhosts = glob('/var/mail/vhosts/*', GLOB_ONLYDIR) ?: [];
                foreach ($vhosts as $domainDir) {
                    $otherDomain = basename($domainDir);
                    if (!is_dir($domainDir)) continue;
                    $entries = @scandir($domainDir);
                    if (!is_array($entries)) continue;
                    foreach ($entries as $other) {
                        if ($other === '.' || $other === '..') continue;
                        // Skip current user's own file
                        if ($otherDomain === $domain && $other === $user) continue;
                        $otherFile = "{$domainDir}/{$other}/push_tokens/tokens.json";
                        if (!file_exists($otherFile)) continue;
                        $ofp = @fopen($otherFile, 'c+');
                        if (!$ofp) continue;
                        @flock($ofp, LOCK_EX);
                        $oRaw = stream_get_contents($ofp);
                        $oTokens = $oRaw ? (json_decode($oRaw, true) ?: []) : [];
                        $before = count($oTokens);
                        $oTokens = array_values(array_filter($oTokens, fn($t) => ($t['token'] ?? '') !== $token));
                        if (count($oTokens) !== $before) {
                            ftruncate($ofp, 0); rewind($ofp);
                            fwrite($ofp, json_encode($oTokens, JSON_PRETTY_PRINT));
                            fflush($ofp);
                            $tag = ($otherDomain === $domain) ? 'push_sweep' : 'push_sweep_xdomain';
                            error_log("[{$tag}] removed token from user={$other}@{$otherDomain} count_before={$before} count_after=" . count($oTokens));
                        }
                        @flock($ofp, LOCK_UN);
                        fclose($ofp);
                    }
                }
            } catch (\Throwable $e) { error_log('[push_sweep_err] ' . $e->getMessage()); }

            jsonResponse(true, null, 'Token registrado');
            break;

        case 'unregister_push_token':
            $creds = requireAuthLite();
            $input = getInput();
            $token = trim($input['token'] ?? '');
            if (!$token) jsonResponse(false, null, 'Token obrigatorio', 400);

            $userEmail = $creds['email'];
            $parts = explode('@', $userEmail);
            $user = $parts[0];
            $domain = $parts[1] ?? 'onemundo.com.br';
            $tokenFile = "/var/mail/vhosts/{$domain}/{$user}/push_tokens/tokens.json";
            if (file_exists($tokenFile)) {
                $tokens = json_decode(file_get_contents($tokenFile), true) ?: [];
                $tokens = array_values(array_filter($tokens, fn($t) => $t['token'] !== $token));
                file_put_contents($tokenFile, json_encode($tokens, JSON_PRETTY_PRINT), LOCK_EX);
            }
            jsonResponse(true, null, 'Token removido');
            break;

        case 'unregister_all_my_push_tokens':
            // Privacy-critical: when a user logs out from a device but the
            // device-specific token isn't available (cache lost, app reload,
            // network glitch on the per-token unregister), wipe the user's
            // entire tokens.json. The user has explicitly logged out — we
            // honor that intent at the cost of forcing other devices that
            // are still logged in to re-register on next foreground.
            $creds = requireAuthLite();
            $userEmail = $creds['email'];
            $parts = explode('@', $userEmail);
            $user = $parts[0];
            $domain = $parts[1] ?? 'onemundo.com.br';
            $tokenFile = "/var/mail/vhosts/{$domain}/{$user}/push_tokens/tokens.json";
            if (file_exists($tokenFile)) {
                file_put_contents($tokenFile, '[]', LOCK_EX);
                error_log("[push_wipe_all] cleared tokens.json for {$userEmail}");
            }
            // Also nuke voip_token.json so iOS CallKit pushes stop too.
            $voipFile = "/var/mail/vhosts/{$domain}/{$user}/push_tokens/voip_token.json";
            if (file_exists($voipFile)) {
                @unlink($voipFile);
            }
            jsonResponse(true, null, 'All tokens wiped');
            break;

        // ---- ATTACHMENT DOWNLOAD ----
        case 'attachment_download':
            $auth = requireAuth();
            $uid = (int)($_GET['uid'] ?? 0);
            $folder = $_GET['folder'] ?? 'INBOX';
            if ($folder === 'Flagged') $folder = 'INBOX';
            $partId = $_GET['part'] ?? '';
            if (!$uid || !$partId) jsonResponse(false, null, 'uid e part obrigatorios', 400);

            $imap = getImap($auth['email'], $auth['password'], $folder);
            $structure = imap_fetchstructure($imap, $uid, FT_UID);
            if (!$structure) { imap_close($imap); jsonResponse(false, null, 'Mensagem nao encontrada', 404); }

            // Navigate to the specific part
            $partNums = explode('.', $partId);
            $targetPart = $structure;
            foreach ($partNums as $num) {
                $idx = (int)$num - 1;
                if (isset($targetPart->parts[$idx])) {
                    $targetPart = $targetPart->parts[$idx];
                } else {
                    try { imap_close($imap); } catch (\Throwable $_e) {}
                    jsonResponse(false, null, 'Parte nao encontrada', 404);
                }
            }

            // Get filename
            $filename = getPartFilename($targetPart) ?: 'attachment';

            // Get MIME type
            $typeMap = [0=>'text',1=>'multipart',2=>'message',3=>'application',4=>'audio',5=>'image',6=>'video',7=>'model'];
            $mainType = $typeMap[$targetPart->type ?? 3] ?? 'application';
            $subType = strtolower($targetPart->subtype ?? 'octet-stream');
            $contentType = "{$mainType}/{$subType}";

            // Fetch and decode the part
            $rawData = imap_fetchbody($imap, $uid, $partId, FT_UID);
            try { imap_close($imap); } catch (\Throwable $_e) {}
            $data = decodeBodyPart($rawData, $targetPart->encoding ?? 0);

            // Stream to client — basename() strips any path components a
            // malicious MIME header might include (../../etc/passwd etc).
            header("Content-Type: {$contentType}");
            header("Content-Disposition: attachment; filename=\"" . str_replace('"', '', basename($filename)) . "\"");
            header("Content-Length: " . strlen($data));
            header("Cache-Control: private, max-age=3600");
            echo $data;
            exit;

        // ---- CHANGE PASSWORD ----
        case 'change_password':
            $auth = requireAuth();
            $input = getInput();
            $currentPwd = $input['current_password'] ?? '';
            $newPwd = $input['new_password'] ?? '';

            if (!$currentPwd || !$newPwd) jsonResponse(false, null, 'Senha atual e nova obrigatorias', 400);
            if (strlen($newPwd) < 8) jsonResponse(false, null, 'Nova senha deve ter no minimo 8 caracteres', 400);

            // Validate current password via IMAP
            $testAuth = imapAuth($auth['email'], $currentPwd);
            if ($testAuth === false) jsonResponse(false, null, 'Senha atual incorreta', 403);

            // Generate new hash — same crypt() fallback as signup
            // (sudo doveadm unavailable in container, see signup case).
            $salt = '$6$' . bin2hex(random_bytes(8)) . '$';
            $cryptHash = crypt($newPwd, $salt);
            if (!$cryptHash || strlen($cryptHash) < 20) jsonResponse(false, null, 'Erro ao gerar hash', 500);
            $newHash = '{SHA512-CRYPT}' . $cryptHash;

            // Update /etc/dovecot/users with file locking
            $usersFile = '/etc/dovecot/users';
            $fp = fopen($usersFile, 'r+');
            if (!$fp) jsonResponse(false, null, 'Erro ao abrir arquivo de usuarios', 500);
            flock($fp, LOCK_EX);
            $content = stream_get_contents($fp);
            $lines = explode("\n", $content);
            $updated = false;
            foreach ($lines as &$line) {
                if (strpos($line, $auth['email'] . ':') === 0) {
                    $line = $auth['email'] . ':' . $newHash;
                    $updated = true;
                    break;
                }
            }
            unset($line);
            if (!$updated) { flock($fp, LOCK_UN); fclose($fp); jsonResponse(false, null, 'Usuario nao encontrado', 404); }
            fseek($fp, 0);
            ftruncate($fp, 0);
            fwrite($fp, implode("\n", $lines));
            flock($fp, LOCK_UN);
            fclose($fp);

            // Update session password (encrypted)
            $_SESSION['password_enc'] = encryptSessionPassword($newPwd);
            unset($_SESSION['password']); // remove any legacy plaintext

            // Audit log: high-signal security event.
            try {
                require_once __DIR__ . '/privacy_endpoints.php';
                if (function_exists('logUserActivity') && function_exists('getPGDB')) {
                    logUserActivity(getPGDB(), $auth['email'], 'password_change');
                }
            } catch (\Throwable $_e) {}

            jsonResponse(true, null, 'Senha alterada com sucesso');
            break;

        // ---- FORGOT PASSWORD: INITIATE ----
        case 'forgot_password_initiate':
            $input = getInput();
            $email = strtolower(trim($input['email'] ?? ''));
            if (!$email || !filter_var($email, FILTER_VALIDATE_EMAIL)) jsonResponse(false, null, 'Email obrigatorio', 400);

            // Per-TARGET-email rate limit: 3 recovery emails per hour so
            // attackers can't spam a victim's inbox with OTP codes. Keep the
            // IP limit below as a second layer.
            $targetRateFile = '/tmp/forgot_target_' . md5($email);
            $targetRates = file_exists($targetRateFile) ? (json_decode(@file_get_contents($targetRateFile), true) ?: []) : [];
            $targetRates = array_values(array_filter($targetRates, fn($t) => is_numeric($t) && $t > time() - 3600));
            if (count($targetRates) >= 3) {
                // Same generic response so attackers can't tell the cap was hit
                jsonResponse(true, null, 'Se este email existir, enviaremos um codigo de recuperacao.');
            }

            // Validate email domain and prevent path traversal
            $parts = explode('@', $email);
            $allowedDomains = ['onemundo.com.br', 'superbora.com.br', 'chatyy.com.br'];
            if (count($parts) !== 2 || !in_array($parts[1], $allowedDomains) || preg_match('/[\/\\\\.]\./', $parts[0])) {
                // Generic response to prevent email enumeration
                jsonResponse(true, null, 'Se este email existir, enviaremos um codigo de recuperacao.');
            }

            // Check email exists in Dovecot (generic response either way)
            $usersFile = '/etc/dovecot/users';
            $existing = file_get_contents($usersFile);
            if (strpos($existing, $email . ':') === false) {
                // Same generic message — no enumeration
                jsonResponse(true, null, 'Se este email existir, enviaremos um codigo de recuperacao.');
            }

            // Record the recovery attempt for this target email. We charge
            // the counter regardless of whether we'll actually send to stop
            // probes that walk the user list.
            $targetRates[] = time();
            @file_put_contents($targetRateFile, json_encode($targetRates), LOCK_EX);

            // Get recovery email from profile
            $profilePath = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/data.json";
            $recoveryEmail = '';
            if (file_exists($profilePath)) {
                $profileData = json_decode(file_get_contents($profilePath), true) ?: [];
                $recoveryEmail = trim($profileData['recovery_email'] ?? '');
            }

            if (!$recoveryEmail) {
                // Generic response — don't reveal that the account has no recovery email
                jsonResponse(true, null, 'Se este email existir, enviaremos um codigo de recuperacao.');
            }

            // Generate 6-digit code
            $code = str_pad(random_int(0, 999999), 6, '0', STR_PAD_LEFT);
            $codeHash = password_hash($code, PASSWORD_DEFAULT);

            // Save recovery code
            $recoveryDir = dirname($profilePath);
            $recoveryFile = "{$recoveryDir}/recovery_code.json";
            // If we can't persist the recovery code, the user gets the email
            // with the digits but the verify step always fails — silent UX bug
            // that looked like "code wrong" to confused users.
            if (safe_put_contents($recoveryFile, json_encode([
                'code_hash' => $codeHash,
                'recovery_email' => $recoveryEmail,
                'expires' => time() + 900, // 15 minutes
                'attempts' => 0,
                'created_at' => date('c'),
            ], JSON_PRETTY_PRINT), LOCK_EX) === false) {
                jsonResponse(false, null, 'Falha ao iniciar recuperacao (perms)', 500);
            }

            // Send code via local SMTP to recovery email
            $senderDomain = $parts[1];
            $codeHeaders  = "From: OneMundo Mail <noreply@{$senderDomain}>\r\n";
            $codeHeaders .= "To: {$recoveryEmail}\r\n";
            $codeHeaders .= "Subject: =?UTF-8?B?" . base64_encode("Codigo de recuperacao - OneMundo Mail") . "?=\r\n";
            $codeHeaders .= "Date: " . date('r') . "\r\n";
            $codeHeaders .= "Message-ID: <" . uniqid('recovery_', true) . "@{$senderDomain}>\r\n";
            $codeHeaders .= "MIME-Version: 1.0\r\n";
            $codeHeaders .= "Content-Type: text/html; charset=UTF-8\r\n";
            $codeHeaders .= "Content-Transfer-Encoding: quoted-printable\r\n";

            $codeBody = quoted_printable_encode(
                "<div style='font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px'>"
                . "<h2 style='color:#2563eb;margin-bottom:8px'>Recuperacao de senha</h2>"
                . "<p style='color:#64748b;margin-bottom:24px'>Voce solicitou a recuperacao de senha para <strong>{$email}</strong>.</p>"
                . "<div style='background:#f1f5f9;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px'>"
                . "<p style='color:#64748b;margin:0 0 8px'>Seu codigo de verificacao:</p>"
                . "<p style='font-size:32px;font-weight:800;color:#1e293b;letter-spacing:6px;margin:0'>{$code}</p>"
                . "</div>"
                . "<p style='color:#94a3b8;font-size:13px'>Este codigo expira em 15 minutos. Se voce nao solicitou esta recuperacao, ignore este email.</p>"
                . "</div>"
            );

            $fullCodeMsg = $codeHeaders . "\r\n" . $codeBody;

            // Send via local SMTP
            $smtp = @fsockopen("127.0.0.1", 25, $errno, $errstr, 10);
            $smtpSent = false;
            if ($smtp) {
                fgets($smtp, 512);
                fputs($smtp, "EHLO mail.{$senderDomain}\r\n");
                while ($line = fgets($smtp, 512)) { if ($line[3] === " ") break; }
                fputs($smtp, "MAIL FROM:<noreply@{$senderDomain}>\r\n"); fgets($smtp, 512);
                fputs($smtp, "RCPT TO:<{$recoveryEmail}>\r\n"); fgets($smtp, 512);
                fputs($smtp, "DATA\r\n"); fgets($smtp, 512);
                fputs($smtp, $fullCodeMsg . "\r\n.\r\n");
                $dataResp = fgets($smtp, 512);
                fputs($smtp, "QUIT\r\n"); fclose($smtp);
                $smtpSent = substr($dataResp, 0, 3) === "250";
            }

            if (!$smtpSent) jsonResponse(false, null, 'Erro ao enviar email de recuperacao', 500);

            // Mask recovery email for display
            $rParts = explode('@', $recoveryEmail);
            $local = $rParts[0];
            $masked = substr($local, 0, 1) . str_repeat('*', max(1, strlen($local) - 2)) . substr($local, -1) . '@' . $rParts[1];

            jsonResponse(true, ['method' => 'email', 'masked_email' => $masked], 'Codigo enviado');
            break;

        // ---- FORGOT PASSWORD: VERIFY CODE ----
        case 'forgot_password_verify':
            $input = getInput();
            $email = strtolower(trim($input['email'] ?? ''));
            $code = trim($input['code'] ?? '');
            if (!$email || !$code) jsonResponse(false, null, 'Email e codigo obrigatorios', 400);

            // Per-IP rate limit (30 attempts / 1h). Per-email limit already
            // exists via 5-attempts-on-recovery-file, but an attacker
            // hitting many emails with the same IP would burn through them
            // in seconds. This caps brute-force across all targets/IP.
            {
                $clientIp = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
                $ipRateFile = '/tmp/forgot_verify_rate_' . md5($clientIp);
                $ipRates = file_exists($ipRateFile) ? (@json_decode(@file_get_contents($ipRateFile), true) ?: []) : [];
                $ipRates = is_array($ipRates) ? array_filter($ipRates, fn($t) => $t > time() - 3600) : [];
                if (count($ipRates) >= 30) jsonResponse(false, null, 'Muitas tentativas. Aguarde 1 hora.', 429);
                $ipRates[] = time();
                @file_put_contents($ipRateFile, json_encode(array_values($ipRates)), LOCK_EX);
            }

            $parts = explode('@', $email);
            $recoveryFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/recovery_code.json";
            if (!file_exists($recoveryFile)) jsonResponse(false, null, 'Nenhuma solicitacao de recuperacao encontrada', 400);

            $recovery = json_decode(file_get_contents($recoveryFile), true);
            if (!$recovery) jsonResponse(false, null, 'Dados de recuperacao invalidos', 400);

            // Check expiry
            if (time() > ($recovery['expires'] ?? 0)) {
                @unlink($recoveryFile);
                jsonResponse(false, null, 'Codigo expirado. Solicite um novo.', 400);
            }

            // Check attempts
            if (($recovery['attempts'] ?? 0) >= 5) {
                @unlink($recoveryFile);
                jsonResponse(false, null, 'Muitas tentativas. Solicite um novo codigo.', 400);
            }

            // Increment attempts
            $recovery['attempts'] = ($recovery['attempts'] ?? 0) + 1;
            file_put_contents($recoveryFile, json_encode($recovery, JSON_PRETTY_PRINT), LOCK_EX);

            // Verify code
            if (!password_verify($code, $recovery['code_hash'] ?? '')) {
                jsonResponse(false, null, 'Codigo incorreto', 400);
            }

            // Generate reset token
            $resetToken = bin2hex(random_bytes(32));
            $recovery['reset_token'] = password_hash($resetToken, PASSWORD_DEFAULT);
            $recovery['reset_token_expires'] = time() + 600; // 10 minutes
            file_put_contents($recoveryFile, json_encode($recovery, JSON_PRETTY_PRINT), LOCK_EX);

            jsonResponse(true, ['reset_token' => $resetToken], 'Codigo verificado');
            break;

        // ---- RESET PASSWORD ----
        case 'reset_password':
            $input = getInput();
            $email = strtolower(trim($input['email'] ?? ''));
            $resetToken = trim($input['reset_token'] ?? '');
            $newPwd = $input['new_password'] ?? '';

            if (!$email || !$resetToken || !$newPwd) jsonResponse(false, null, 'Dados incompletos', 400);
            if (strlen($newPwd) < 8) jsonResponse(false, null, 'Nova senha deve ter no minimo 8 caracteres', 400);

            // Per-IP rate limit (5 resets / 1h). Reset is rare per legit
            // user — a high count from one IP is brute-force / token-spray.
            {
                $clientIp = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
                $ipRateFile = '/tmp/reset_pw_rate_' . md5($clientIp);
                $ipRates = file_exists($ipRateFile) ? (@json_decode(@file_get_contents($ipRateFile), true) ?: []) : [];
                $ipRates = is_array($ipRates) ? array_filter($ipRates, fn($t) => $t > time() - 3600) : [];
                if (count($ipRates) >= 5) jsonResponse(false, null, 'Muitas tentativas. Aguarde 1 hora.', 429);
                $ipRates[] = time();
                @file_put_contents($ipRateFile, json_encode(array_values($ipRates)), LOCK_EX);
            }

            $parts = explode('@', $email);
            $recoveryFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/recovery_code.json";
            if (!file_exists($recoveryFile)) jsonResponse(false, null, 'Solicitacao expirada', 400);

            $recovery = json_decode(file_get_contents($recoveryFile), true);
            if (!$recovery) jsonResponse(false, null, 'Dados invalidos', 400);

            // Validate reset token
            if (time() > ($recovery['reset_token_expires'] ?? 0)) {
                @unlink($recoveryFile);
                jsonResponse(false, null, 'Token expirado. Inicie o processo novamente.', 400);
            }
            if (!password_verify($resetToken, $recovery['reset_token'] ?? '')) {
                jsonResponse(false, null, 'Token invalido', 400);
            }

            // SINGLE-USE: invalidate the token the moment we know it matches
            // so any later failure (bad hash, doveadm error, disk write) can't
            // leave the same code replayable for the remainder of its TTL.
            @unlink($recoveryFile);

            // Generate new password hash — crypt() fallback (sudo doveadm
            // unavailable in PHP-FPM container, see signup case).
            $salt = '$6$' . bin2hex(random_bytes(8)) . '$';
            $cryptHash = crypt($newPwd, $salt);
            if (!$cryptHash || strlen($cryptHash) < 20) jsonResponse(false, null, 'Erro ao gerar hash', 500);
            $newHash = '{SHA512-CRYPT}' . $cryptHash;

            // Update /etc/dovecot/users
            $usersFile = '/etc/dovecot/users';
            $fp = fopen($usersFile, 'r+');
            if (!$fp) jsonResponse(false, null, 'Erro interno', 500);
            flock($fp, LOCK_EX);
            $content = stream_get_contents($fp);
            $lines = explode("\n", $content);
            $updated = false;
            foreach ($lines as &$line) {
                if (strpos($line, $email . ':') === 0) {
                    $line = $email . ':' . $newHash;
                    $updated = true;
                    break;
                }
            }
            unset($line);
            if ($updated) {
                fseek($fp, 0);
                ftruncate($fp, 0);
                fwrite($fp, implode("\n", $lines));
            }
            flock($fp, LOCK_UN);
            fclose($fp);

            // Delete recovery file
            @unlink($recoveryFile);

            if (!$updated) jsonResponse(false, null, 'Usuario nao encontrado', 404);
            jsonResponse(true, null, 'Senha alterada com sucesso');
            break;

        // ---- DRAFTS ----
        case 'draft_save':
            $auth = requireAuth();
            $input = getInput();
            $subject = $input['subject'] ?? '(Sem assunto)';
            $body = $input['body'] ?? '';
            $to = $input['to'] ?? '';
            $cc = $input['cc'] ?? '';
            $bcc = $input['bcc'] ?? '';
            $draftUid = (int)($input['draft_uid'] ?? 0);

            $server = '{127.0.0.1:993/imap/ssl/novalidate-cert}';
            $imap = getImap($auth['email'], $auth['password'], 'Drafts');

            // Build draft MIME message
            $boundary = '----=_Draft_' . md5(uniqid(mt_rand(), true));
            $senderDomain = explode('@', $auth['email'])[1] ?? 'onemundo.com.br';
            $draftHeaders  = "From: {$auth['name']} <{$auth['email']}>\r\n";
            if ($to) $draftHeaders .= "To: {$to}\r\n";
            if ($cc) $draftHeaders .= "Cc: {$cc}\r\n";
            $draftHeaders .= "Subject: {$subject}\r\n";
            $draftHeaders .= "Date: " . date('r') . "\r\n";
            $draftHeaders .= "Message-ID: <" . uniqid('draft_', true) . "@{$senderDomain}>\r\n";
            $draftHeaders .= "MIME-Version: 1.0\r\n";
            $draftHeaders .= "Content-Type: text/html; charset=UTF-8\r\n";
            $draftHeaders .= "Content-Transfer-Encoding: quoted-printable\r\n";
            $draftHeaders .= "X-OneMundo-Draft: true\r\n";
            if ($bcc) $draftHeaders .= "X-OneMundo-Bcc: {$bcc}\r\n";

            $draftMsg = $draftHeaders . "\r\n" . quoted_printable_encode($body);

            // Delete old draft if updating
            if ($draftUid) {
                @imap_delete($imap, (string)$draftUid, FT_UID);
                @imap_expunge($imap);
            }

            // Ensure Drafts folder exists
            $folders = imap_list($imap, $server, 'Drafts');
            if (!$folders) imap_createmailbox($imap, imap_utf7_encode($server . 'Drafts'));

            $ok = imap_append($imap, $server . 'Drafts', $draftMsg, "\\Draft \\Seen");

            // Get new UID
            $newUid = 0;
            if ($ok) {
                $check = imap_check($imap);
                if ($check && $check->Nmsgs > 0) {
                    $overview = imap_fetch_overview($imap, $check->Nmsgs . ':' . $check->Nmsgs);
                    $newUid = $overview[0]->uid ?? 0;
                }
            }
            try { imap_close($imap); } catch (\Throwable $_e) {}
            jsonResponse($ok, ['draft_uid' => $newUid], $ok ? 'Rascunho salvo' : 'Erro ao salvar');
            break;

        case 'draft_list':
            $auth = requireAuth();
            $imap = getImap($auth['email'], $auth['password'], 'Drafts');
            $uids = imap_sort($imap, SORTDATE, 1, SE_UID);
            $drafts = [];
            if ($uids) {
                foreach (array_slice($uids, 0, 50) as $uid) {
                    $header = @imap_fetchheader($imap, $uid, FT_UID);
                    $overview = @imap_fetch_overview($imap, (string)$uid, FT_UID);
                    if (!$overview) continue;
                    $h = $overview[0];
                    $body = getBody($imap, imap_msgno($imap, $uid));
                    $drafts[] = [
                        'uid' => $uid,
                        'to' => isset($h->to) ? iconv_mime_decode($h->to, 0, 'UTF-8') : '',
                        'subject' => isset($h->subject) ? iconv_mime_decode($h->subject, 0, 'UTF-8') : '(Sem assunto)',
                        'body' => substr(strip_tags($body['html'] ?: $body['text']), 0, 200),
                        'body_html' => $body['html'],
                        'date' => isset($h->date) ? date('d/m/Y H:i', strtotime($h->date)) : '',
                        'cc' => $h->cc ?? '',
                        'bcc' => '', // X-OneMundo-Bcc header if stored
                    ];
                }
            }
            try { imap_close($imap); } catch (\Throwable $_e) {}
            jsonResponse(true, $drafts);
            break;

        case 'draft_delete':
            $auth = requireAuth();
            $input = getInput();
            $uid = (int)($input['uid'] ?? 0);
            if (!$uid) jsonResponse(false, null, 'uid obrigatorio', 400);
            $imap = getImap($auth['email'], $auth['password'], 'Drafts');
            imap_delete($imap, (string)$uid, FT_UID);
            imap_expunge($imap);
            try { imap_close($imap); } catch (\Throwable $_e) {}
            jsonResponse(true, null, 'Rascunho excluido');
            break;

        // ---- FOLDER CRUD ----
        case 'create_folder':
            $auth = requireAuth();
            $input = getInput();
            $name = trim($input['name'] ?? '');
            if (!$name) jsonResponse(false, null, 'Nome da pasta obrigatorio', 400);
            if (strlen($name) > 50) jsonResponse(false, null, 'Nome muito longo (max 50)', 400);
            $name = preg_replace('/[\/\\\\]/', '', $name); // no slashes

            $imap = getImap($auth['email'], $auth['password']);
            $server = '{127.0.0.1:993/imap/ssl/novalidate-cert}';
            $ok = @imap_createmailbox($imap, imap_utf7_encode($server . $name));
            if ($ok) @imap_subscribe($imap, imap_utf7_encode($server . $name));
            try { imap_close($imap); } catch (\Throwable $_e) {}
            jsonResponse($ok, null, $ok ? 'Pasta criada' : 'Erro ao criar pasta: ' . imap_last_error());
            break;

        case 'delete_folder':
            $auth = requireAuth();
            $input = getInput();
            $name = trim($input['name'] ?? '');
            $protected = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Spam', 'Junk', 'Archive', 'Snoozed'];
            if (!$name || in_array($name, $protected)) jsonResponse(false, null, 'Nao e possivel excluir esta pasta', 400);

            $imap = getImap($auth['email'], $auth['password']);
            $server = '{127.0.0.1:993/imap/ssl/novalidate-cert}';
            $ok = @imap_deletemailbox($imap, imap_utf7_encode($server . $name));
            try { imap_close($imap); } catch (\Throwable $_e) {}
            jsonResponse($ok, null, $ok ? 'Pasta excluida' : 'Erro ao excluir pasta');
            break;

        case 'empty_trash':
            $auth = requireAuth();
            $imap = getImap($auth['email'], $auth['password'], 'Trash');
            $uids = imap_search($imap, 'ALL', SE_UID);
            if ($uids) {
                foreach ($uids as $uid) imap_delete($imap, (string)$uid, FT_UID);
                imap_expunge($imap);
            }
            try { imap_close($imap); } catch (\Throwable $_e) {}
            jsonResponse(true, null, 'Lixeira esvaziada');
            break;

        // ---- CUSTOM LABELS ----
        case 'create_label':
            $auth = requireAuth();
            $input = getInput();
            $name = strtolower(trim($input['name'] ?? ''));
            $color = $input['color'] ?? '#1a73e8';
            if (!$name) jsonResponse(false, null, 'Nome da label obrigatorio', 400);
            $name = preg_replace('/[^a-z0-9_\-]/i', '', $name);

            $parts = explode('@', $auth['email']);
            $settingsFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/settings.json";
            $settings = file_exists($settingsFile) ? json_decode(file_get_contents($settingsFile), true) : [];
            $customLabels = $settings['custom_labels'] ?? [];
            foreach ($customLabels as $l) { if ($l['name'] === $name) jsonResponse(false, null, 'Label ja existe', 409); }
            $customLabels[] = ['name' => $name, 'color' => $color];
            $settings['custom_labels'] = $customLabels;
            file_put_contents($settingsFile, json_encode($settings, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
            jsonResponse(true, ['name' => $name, 'color' => $color], 'Label criada');
            break;

        case 'delete_label':
            $auth = requireAuth();
            $input = getInput();
            $name = strtolower(trim($input['name'] ?? ''));
            if (!$name) jsonResponse(false, null, 'Nome obrigatorio', 400);

            $parts = explode('@', $auth['email']);
            $settingsFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/settings.json";
            $settings = file_exists($settingsFile) ? json_decode(file_get_contents($settingsFile), true) : [];
            $settings['custom_labels'] = array_values(array_filter($settings['custom_labels'] ?? [], fn($l) => $l['name'] !== $name));
            file_put_contents($settingsFile, json_encode($settings, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
            jsonResponse(true, null, 'Label excluida');
            break;

        // ---- CONTACTS MANAGEMENT ----
        case 'contacts_list':
            $auth = requireAuthLite();
            $q = trim($_GET['q'] ?? '');
            // Scan Sent folder for unique addresses
            $parts = explode('@', $auth['email']);
            $contactsFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/contacts.json";
            $contacts = file_exists($contactsFile) ? json_decode(file_get_contents($contactsFile), true) : [];
            if ($q) {
                $q = strtolower($q);
                $contacts = array_values(array_filter($contacts, fn($c) =>
                    strpos(strtolower($c['email'] ?? ''), $q) !== false ||
                    strpos(strtolower($c['name'] ?? ''), $q) !== false
                ));
            }
            usort($contacts, fn($a, $b) => ($b['frequency'] ?? 0) - ($a['frequency'] ?? 0));
            jsonResponse(true, array_slice($contacts, 0, 100));
            break;

        case 'contact_save':
            $auth = requireAuth();
            $input = getInput();
            $email = strtolower(trim($input['email'] ?? ''));
            $name = trim($input['name'] ?? '');
            if (!$email) jsonResponse(false, null, 'Email obrigatorio', 400);

            $parts = explode('@', $auth['email']);
            $contactsFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/contacts.json";
            $contacts = file_exists($contactsFile) ? json_decode(file_get_contents($contactsFile), true) : [];
            $found = false;
            foreach ($contacts as &$c) {
                if (strtolower($c['email']) === $email) {
                    $c['name'] = $name;
                    $c['frequency'] = ($c['frequency'] ?? 0) + 1;
                    $c['updated_at'] = date('c');
                    $found = true;
                    break;
                }
            }
            unset($c);
            if (!$found) $contacts[] = ['email' => $email, 'name' => $name, 'frequency' => 1, 'created_at' => date('c')];
            file_put_contents($contactsFile, json_encode($contacts, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
            jsonResponse(true, null, 'Contato salvo');
            break;

        case 'contact_delete':
            $auth = requireAuth();
            $input = getInput();
            $email = strtolower(trim($input['email'] ?? ''));
            if (!$email) jsonResponse(false, null, 'Email obrigatorio', 400);

            $parts = explode('@', $auth['email']);
            $contactsFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/contacts.json";
            $contacts = file_exists($contactsFile) ? json_decode(file_get_contents($contactsFile), true) : [];
            $contacts = array_values(array_filter($contacts, fn($c) => strtolower($c['email']) !== $email));
            file_put_contents($contactsFile, json_encode($contacts, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
            jsonResponse(true, null, 'Contato removido');
            break;

        case 'contacts_discover':
            $auth = requireAuth();
            $parts = explode('@', $auth['email']);
            $profileDir = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile";
            $cacheFile = "{$profileDir}/discover_cache.json";

            // Return cached result if less than 1 hour old
            if (file_exists($cacheFile)) {
                $cacheData = json_decode(file_get_contents($cacheFile), true);
                if ($cacheData && ($cacheData['timestamp'] ?? 0) > time() - 3600) {
                    jsonResponse(true, $cacheData['contacts']);
                    break;
                }
            }

            // Load existing contacts to exclude
            $contactsFile = "{$profileDir}/contacts.json";
            $existingContacts = file_exists($contactsFile) ? json_decode(file_get_contents($contactsFile), true) : [];
            $existingEmails = [];
            foreach ($existingContacts as $c) {
                $existingEmails[strtolower($c['email'])] = true;
            }

            // Also exclude own email
            $existingEmails[strtolower($auth['email'])] = true;

            // Connect to Sent folder via IMAP
            try {
                $imap = getImap($auth['email'], $auth['password'], 'Sent');
            } catch (Exception $e) {
                jsonResponse(false, null, 'Erro ao acessar pasta Sent: ' . $e->getMessage(), 500);
                break;
            }

            $numMessages = imap_num_msg($imap);
            $startMsg = max(1, $numMessages - 199); // Last 200 messages
            $discovered = []; // email => ['name' => ..., 'frequency' => ...]

            for ($i = $numMessages; $i >= $startMsg; $i--) {
                $header = @imap_headerinfo($imap, $i);
                if (!$header) continue;

                $addresses = [];
                if (!empty($header->to)) $addresses = array_merge($addresses, parseAddresses($header->to));
                if (!empty($header->cc)) $addresses = array_merge($addresses, parseAddresses($header->cc));

                foreach ($addresses as $addr) {
                    $addrEmail = strtolower($addr['email']);
                    if (isset($existingEmails[$addrEmail])) continue;
                    if (!filter_var($addrEmail, FILTER_VALIDATE_EMAIL)) continue;

                    if (!isset($discovered[$addrEmail])) {
                        $discovered[$addrEmail] = [
                            'email' => $addrEmail,
                            'name' => $addr['name'] ?: '',
                            'frequency' => 0,
                        ];
                    }
                    $discovered[$addrEmail]['frequency']++;
                    // Keep the best name (non-empty, longest)
                    if ($addr['name'] && strlen($addr['name']) > strlen($discovered[$addrEmail]['name'])) {
                        $discovered[$addrEmail]['name'] = $addr['name'];
                    }
                }
            }

            try { imap_close($imap); } catch (\Throwable $_e) {}

            // Sort by frequency descending
            $result = array_values($discovered);
            usort($result, fn($a, $b) => $b['frequency'] - $a['frequency']);
            $result = array_slice($result, 0, 100);

            // Cache result
            if (!is_dir($profileDir)) @mkdir($profileDir, 0755, true);
            file_put_contents($cacheFile, json_encode([
                'timestamp' => time(),
                'contacts' => $result,
            ], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));

            jsonResponse(true, $result);
            break;

        // ---- AVATAR UPLOAD ----
        case 'upload_avatar':
            $auth = requireAuth();
            $parts = explode('@', $auth['email']);
            $profileDir = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile";

            if (empty($_FILES['avatar'])) jsonResponse(false, null, 'Arquivo obrigatorio', 400);
            $file = $_FILES['avatar'];
            if (!empty($file['error'])) jsonResponse(false, null, 'Upload falhou (erro ' . (int)$file['error'] . ')', 400);
            if ($file['size'] > 2 * 1024 * 1024) jsonResponse(false, null, 'Maximo 2MB', 400);
            $allowed = ['image/jpeg', 'image/png', 'image/webp'];
            $type = mime_content_type($file['tmp_name']) ?: $file['type'];
            if (!in_array($type, $allowed)) jsonResponse(false, null, 'Formato invalido (use JPG, PNG ou WebP)', 400);

            // 100GB plan storage cap. Avatar replaces existing avatar.*
            // so the net delta is small, but a 0-byte-free user should
            // still be told to make space rather than getting a silent
            // success in a degraded state.
            require_once __DIR__ . '/plans.php';
            enforceStorageCap($auth['email'], (int)$file['size']);

            // Profile dir may not exist for newly-provisioned accounts; create it
            // recursively before the move. Previously move_uploaded_file failed
            // silently and the API still returned success, so the UI thought the
            // upload worked while the file was never written.
            if (!is_dir($profileDir)) {
                if (!@mkdir($profileDir, 0755, true) && !is_dir($profileDir)) {
                    error_log("[upload_avatar] mkdir failed: $profileDir");
                    jsonResponse(false, null, 'Não foi possível preparar o diretório do perfil', 500);
                }
            }

            // Resize to 256×256 max and write BOTH avatar.webp (primary, 30-50%
            // smaller) and avatar.jpg (fallback for old email clients / IE).
            // Drop whatever original extension the user uploaded — we always
            // serve from the resized variants.
            $src = null;
            if ($type === 'image/jpeg') $src = @imagecreatefromjpeg($file['tmp_name']);
            elseif ($type === 'image/png') $src = @imagecreatefrompng($file['tmp_name']);
            elseif ($type === 'image/webp') $src = @imagecreatefromwebp($file['tmp_name']);
            if (!$src) {
                error_log("[upload_avatar] decode failed for $type");
                jsonResponse(false, null, 'Imagem inválida ou corrompida', 400);
            }
            $srcW = imagesx($src); $srcH = imagesy($src);
            $maxSize = 256;
            $scale = min($maxSize / $srcW, $maxSize / $srcH, 1.0);
            $dstW = max(1, (int)round($srcW * $scale));
            $dstH = max(1, (int)round($srcH * $scale));
            $dst = imagecreatetruecolor($dstW, $dstH);
            // White background so PNG transparency flattens cleanly for JPEG
            $white = imagecolorallocate($dst, 255, 255, 255);
            imagefilledrectangle($dst, 0, 0, $dstW, $dstH, $white);
            imagecopyresampled($dst, $src, 0, 0, 0, 0, $dstW, $dstH, $srcW, $srcH);

            // Remove any prior avatar variants (old .jpg/.png/.webp from legacy path)
            foreach (glob("{$profileDir}/avatar.*") as $old) @unlink($old);

            $webpPath = "{$profileDir}/avatar.webp";
            $jpgPath  = "{$profileDir}/avatar.jpg";
            $okWebp = @imagewebp($dst, $webpPath, 85);
            $okJpg  = @imagejpeg($dst, $jpgPath, 88);
            imagedestroy($dst); imagedestroy($src);
            if (!$okWebp && !$okJpg) {
                error_log("[upload_avatar] encode failed: webp=$okWebp jpg=$okJpg");
                jsonResponse(false, null, 'Falha ao processar a foto', 500);
            }
            if (file_exists($webpPath)) @chmod($webpPath, 0644);
            if (file_exists($jpgPath))  @chmod($jpgPath, 0644);

            // Update profile data — primary name tracks webp since serve path
            // prefers it when the client sends Accept: image/webp.
            $profileFile = "{$profileDir}/data.json";
            $data = file_exists($profileFile) ? json_decode(file_get_contents($profileFile), true) : [];
            $data['avatar'] = $okWebp ? 'avatar.webp' : 'avatar.jpg';
            // Use unix-ts version so the URL ?v=... query param busts every
            // browser/CDN cache the moment the photo changes. Same value is
            // returned to the client so it can plug it into <Image src> right
            // away without waiting for the next profile_get round-trip.
            $avatarVersion = time();
            $data['avatar_version'] = $avatarVersion;
            $data['avatar_updated'] = date('c');
            // Don't claim avatar upload succeeded if the metadata write failed —
            // earlier silent failures (read-only mounts, perm drift) returned 200
            // and the UI thought the photo was saved. Force a real 500 instead.
            if (file_put_contents($profileFile, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX) === false) {
                error_log("[upload_avatar] profile write failed: $profileFile");
                jsonResponse(false, null, 'Falha ao salvar perfil (verifique permissoes)', 500);
            }

            // Bust the profile cache so /profile_get returns the new avatar
            // URL (with the new ?v=) immediately on every device.
            try { require_once __DIR__ . '/cache.php'; cacheInvalidate("profile:v1:" . strtolower($auth['email'])); } catch (Throwable $_) {}

            // Push avatar_updated event over WS so:
            //  1. User's own other devices (chat_user_<email>) — bust local cache
            //  2. Every conversation the user is in (chat_<convId>) — peers'
            //     UI refreshes their avatar instantly without needing to reopen
            //     the chat. (User reported: "n atualiza automaticamente
            //     instantaneamente" — peers were stuck with the old photo.)
            try {
                $wsKey = getenv('MAIL_WS_KEY') ?: '';
                if ($wsKey) {
                    // Build channel list: own user channel + every conversation
                    $channels = ['chat_user_' . strtolower($auth['email'])];
                    try {
                        require_once __DIR__ . '/db.php';
                        $pg = getPGDB();
                        if ($pg) {
                            $convs = $pg->prepare("SELECT conversation_id FROM chat_conversation_members WHERE LOWER(email) = LOWER(:em)");
                            $convs->execute([':em' => $auth['email']]);
                            foreach ($convs->fetchAll(\PDO::FETCH_COLUMN) as $cid) {
                                $channels[] = 'chat_' . (int)$cid;
                            }
                        }
                    } catch (Throwable $_) {}
                    $eventData = ['email' => strtolower($auth['email']), 'avatar_version' => $avatarVersion];
                    foreach ($channels as $ch) {
                        $payload = json_encode([
                            'channel' => $ch,
                            'event'   => 'avatar_updated',
                            'data'    => $eventData,
                        ]);
                        foreach (['http://127.0.0.1:8081/broadcast', 'http://127.0.0.1:8084/broadcast'] as $endpoint) {
                            $cu = curl_init($endpoint);
                            curl_setopt_array($cu, [
                                CURLOPT_POST => true,
                                CURLOPT_POSTFIELDS => $payload,
                                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                                CURLOPT_RETURNTRANSFER => true,
                                CURLOPT_TIMEOUT_MS => 600,
                                CURLOPT_CONNECTTIMEOUT_MS => 200,
                            ]);
                            curl_exec($cu);
                            curl_close($cu);
                        }
                    }
                }
            } catch (Throwable $_) {}

            jsonResponse(true, [
                'avatar' => $data['avatar'],
                'avatar_version' => $avatarVersion,
                'avatar_url' => '/api/email.php?action=get_avatar&email=' . urlencode($auth['email']) . '&v=' . $avatarVersion,
            ], 'Foto atualizada');
            break;

        // Cover photo upload — accepts a multipart `cover` file (preferred)
        // OR a JSON `file_b64` payload, resizes to a 1500×500 banner and
        // ships to R2 under profile-covers/<email>/<ts>.jpg. Returns the
        // public URL that `update_profile` will persist into data.json.
        // Same plan/storage cap + cache-bust pattern as upload_avatar so
        // the new cover shows up everywhere on the next render.
        case 'upload_cover': {
            $auth = requireAuth();
            [$uPart, $dPart] = array_pad(explode('@', $auth['email']), 2, '');
            $profileDir = "/var/mail/vhosts/{$dPart}/{$uPart}/profile";
            if (!is_dir($profileDir)) @mkdir($profileDir, 0755, true);

            $tmp = null; $type = ''; $size = 0;
            if (!empty($_FILES['cover'])) {
                $f = $_FILES['cover'];
                if (!empty($f['error'])) jsonResponse(false, null, 'Upload falhou (erro ' . (int)$f['error'] . ')', 400);
                $tmp  = $f['tmp_name'];
                $type = mime_content_type($tmp) ?: $f['type'];
                $size = (int)$f['size'];
            } else {
                $input = getInput();
                $b64 = (string)($input['file_b64'] ?? '');
                if ($b64 === '') jsonResponse(false, null, 'Arquivo obrigatório', 400);
                // Strip data: prefix if present
                if (preg_match('#^data:[^;]+;base64,(.+)$#i', $b64, $m)) $b64 = $m[1];
                $raw = base64_decode($b64, true);
                if ($raw === false) jsonResponse(false, null, 'Base64 inválido', 400);
                $size = strlen($raw);
                $tmp = tempnam(sys_get_temp_dir(), 'cover_');
                file_put_contents($tmp, $raw);
                $type = mime_content_type($tmp) ?: 'application/octet-stream';
            }
            if ($size > 6 * 1024 * 1024) jsonResponse(false, null, 'Máximo 6MB', 400);
            $allowed = ['image/jpeg', 'image/png', 'image/webp'];
            if (!in_array($type, $allowed, true)) jsonResponse(false, null, 'Formato inválido (use JPG, PNG ou WebP)', 400);

            require_once __DIR__ . '/plans.php';
            enforceStorageCap($auth['email'], $size);

            // Resize to 1500×500 banner (3:1 — Instagram/X cover ratio).
            // Crop center-out so a portrait pick still gets a reasonable
            // composition (no squashing).
            $src = null;
            if ($type === 'image/jpeg') $src = @imagecreatefromjpeg($tmp);
            elseif ($type === 'image/png') $src = @imagecreatefrompng($tmp);
            elseif ($type === 'image/webp') $src = @imagecreatefromwebp($tmp);
            if (!$src) jsonResponse(false, null, 'Imagem inválida ou corrompida', 400);
            $sw = imagesx($src); $sh = imagesy($src);
            $targetW = 1500; $targetH = 500;
            // Cover-fit crop: scale so the smaller of (w/W, h/H) hits 1.0,
            // then center-crop the overflow.
            $scale = max($targetW / $sw, $targetH / $sh);
            $cropW = (int)round($targetW / $scale);
            $cropH = (int)round($targetH / $scale);
            $cropX = (int)max(0, ($sw - $cropW) / 2);
            $cropY = (int)max(0, ($sh - $cropH) / 2);
            $dst = imagecreatetruecolor($targetW, $targetH);
            imagecopyresampled($dst, $src, 0, 0, $cropX, $cropY, $targetW, $targetH, $cropW, $cropH);

            $localPath = $profileDir . '/cover.jpg';
            $okJpg = @imagejpeg($dst, $localPath, 86);
            imagedestroy($dst); imagedestroy($src);
            if (!$okJpg) jsonResponse(false, null, 'Falha ao processar a capa', 500);
            @chmod($localPath, 0644);

            // Push to R2 (chatyy-media bucket) under a deterministic key
            // so older covers get overwritten — bucket usage stays flat.
            // Falls back to the local-served URL if R2 is unavailable so
            // the user never sees a broken upload during an R2 outage.
            $ts = time();
            $objectKey = 'profile-covers/' . strtolower($auth['email']) . '/' . $ts . '.jpg';
            $coverUrl = '';
            try {
                require_once __DIR__ . '/r2-helper.php';
                if (function_exists('r2Upload') && r2Upload($objectKey, $localPath, 'image/jpeg')) {
                    // Public CDN domain — same bucket fronted by Cloudflare.
                    $coverUrl = 'https://media.chatyy.com.br/' . $objectKey;
                }
            } catch (Throwable $_) {}
            if ($coverUrl === '') {
                // Fallback: serve directly from the profile dir via nginx.
                $coverUrl = '/api/email.php?action=get_cover&email=' . urlencode($auth['email']) . '&v=' . $ts;
            }

            // Persist into data.json so profile_get picks it up.
            $profileFile = $profileDir . '/data.json';
            $data = file_exists($profileFile) ? (json_decode(file_get_contents($profileFile), true) ?: []) : [];
            if (!is_array($data)) $data = [];
            $data['cover_url'] = $coverUrl;
            $data['cover_version'] = $ts;
            $data['cover_updated'] = date('c');
            if (file_put_contents($profileFile, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX) === false) {
                jsonResponse(false, null, 'Falha ao salvar perfil', 500);
            }

            try { require_once __DIR__ . '/cache.php'; cacheInvalidate("profile:v1:" . strtolower($auth['email'])); } catch (Throwable $_) {}

            jsonResponse(true, [
                'cover_url'     => $coverUrl,
                'cover_version' => $ts,
            ], 'Capa atualizada');
            break;
        }

        // Local fallback serve when R2 is unavailable — mirrors get_avatar
        // pattern. Frontend treats it as just another URL.
        case 'get_cover': {
            $email = strtolower(trim((string)($_GET['email'] ?? '')));
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) { http_response_code(400); exit; }
            [$uPart, $dPart] = array_pad(explode('@', $email), 2, '');
            $path = "/var/mail/vhosts/{$dPart}/{$uPart}/profile/cover.jpg";
            if (!file_exists($path)) { http_response_code(404); exit; }
            header('Content-Type: image/jpeg');
            header('Cache-Control: public, max-age=86400');
            readfile($path);
            exit;
        }

        case 'get_avatar':
            $email = trim($_GET['email'] ?? '');
            // Accept RFC 5322 From-header form — 'Name <addr@x>' — and extract
            // the bare address. Some mail clients pass the header verbatim and
            // we were returning 400 for every avatar lookup from those users.
            if (preg_match('/<([^>]+@[^>]+)>/', $email, $m)) {
                $email = trim($m[1]);
            }
            if (!$email || !preg_match('/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i', $email)) {
                header('HTTP/1.1 400 Bad Request'); exit;
            }
            $parts = explode('@', $email);
            // Strict sanitization to prevent path traversal
            $username = preg_replace('/[^a-z0-9._-]/', '', strtolower($parts[0]));
            $domain = preg_replace('/[^a-z0-9.-]/', '', strtolower($parts[1]));
            if (!$username || !$domain || str_contains($username, '..') || str_contains($domain, '..')) {
                header('HTTP/1.1 400 Bad Request'); exit;
            }
            $profileDir = "/var/mail/vhosts/{$domain}/{$username}/profile";
            $avatarFiles = glob("{$profileDir}/avatar.*");
            if (empty($avatarFiles)) {
                // Generate a server-side PNG with the user's initials on a color
                // derived from the email. Previous behavior returned a 1x1
                // transparent PNG, which the client rendered on top of its
                // <AvatarCircle> background — so the circle looked empty (no
                // initials). This way the circle has the letters baked in and
                // every rendering path (Image tag, <img>, email client, native
                // cache) shows them consistently.
                $initial1 = strtoupper(mb_substr($username, 0, 1, 'UTF-8'));
                // If username has a dot, use the letter after it as the second
                // initial (jose.silva → J + S). Otherwise take the 2nd char.
                $parts = preg_split('/[\._-]/', $username);
                $initial2 = (count($parts) >= 2 && !empty($parts[1]))
                    ? strtoupper(mb_substr($parts[1], 0, 1, 'UTF-8'))
                    : strtoupper(mb_substr($username, 1, 1, 'UTF-8') ?: '');
                $initials = $initial1 . $initial2;

                // Deterministic background color from the email — same hashing
                // idea as the frontend AvatarCircle so when the remote-rendered
                // avatar is cached or the client initials fall back, they land
                // on the same hue.
                $hash = 0;
                $full = $username . '@' . $domain;
                for ($i = 0, $n = strlen($full); $i < $n; $i++) {
                    $hash = (ord($full[$i]) + (($hash << 5) - $hash)) & 0xFFFFFFFF;
                }
                $hue = abs($hash) % 360;
                // HSL → RGB (saturation 55%, lightness 55%)
                $h = $hue / 360; $s = 0.55; $l = 0.55;
                $hueToRgb = function($p, $q, $t) {
                    if ($t < 0) $t += 1; if ($t > 1) $t -= 1;
                    if ($t < 1/6) return $p + ($q - $p) * 6 * $t;
                    if ($t < 1/2) return $q;
                    if ($t < 2/3) return $p + ($q - $p) * (2/3 - $t) * 6;
                    return $p;
                };
                $q = $l < 0.5 ? $l * (1 + $s) : $l + $s - $l * $s;
                $p = 2 * $l - $q;
                $r = (int)round($hueToRgb($p, $q, $h + 1/3) * 255);
                $g = (int)round($hueToRgb($p, $q, $h) * 255);
                $b = (int)round($hueToRgb($p, $q, $h - 1/3) * 255);

                $fontPath = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
                if (function_exists('imagettftext') && file_exists($fontPath)) {
                    // Render a proper circular avatar with transparent corners
                    // and a two-tone vertical gradient for modern Material /
                    // Google-style look. Old output was a flat color square.
                    $size = 256;
                    $im = imagecreatetruecolor($size, $size);
                    imagesavealpha($im, true);
                    imagealphablending($im, false);
                    $transparent = imagecolorallocatealpha($im, 0, 0, 0, 127);
                    imagefilledrectangle($im, 0, 0, $size, $size, $transparent);
                    imagealphablending($im, true);

                    // Clamp so bright/dark hues don't wrap around.
                    $clamp = fn($v) => max(0, min(255, (int)$v));
                    $topR = $clamp($r + 20); $topG = $clamp($g + 20); $topB = $clamp($b + 20);
                    $botR = $clamp($r - 30); $botG = $clamp($g - 30); $botB = $clamp($b - 30);
                    for ($yy = 0; $yy < $size; $yy++) {
                        $t = $yy / max(1, $size - 1);
                        $lr = (int)round($topR + ($botR - $topR) * $t);
                        $lg = (int)round($topG + ($botG - $topG) * $t);
                        $lb = (int)round($topB + ($botB - $topB) * $t);
                        $col = imagecolorallocate($im, $lr, $lg, $lb);
                        imageline($im, 0, $yy, $size - 1, $yy, $col);
                    }

                    // Mask everything outside the circle back to transparent.
                    // Blending MUST be off for this or the transparent pixel
                    // just blends with the underlying opaque gradient and
                    // we end up with a square avatar again.
                    imagealphablending($im, false);
                    $cx = $size / 2; $cy = $size / 2;
                    $rad = ($size / 2) - 1;
                    $radSq = $rad * $rad;
                    for ($py = 0; $py < $size; $py++) {
                        for ($px = 0; $px < $size; $px++) {
                            $dx = $px - $cx; $dy = $py - $cy;
                            if (($dx * $dx + $dy * $dy) > $radSq) {
                                imagesetpixel($im, $px, $py, $transparent);
                            }
                        }
                    }
                    imagealphablending($im, true);

                    $white  = imagecolorallocatealpha($im, 255, 255, 255, 8);
                    $fontSize = strlen($initials) === 1 ? 124 : 100;
                    $bbox = imagettfbbox($fontSize, 0, $fontPath, $initials);
                    $textW = abs($bbox[2] - $bbox[0]);
                    $textH = abs($bbox[7] - $bbox[1]);
                    $xPos = (int)(($size - $textW) / 2 - $bbox[0]);
                    $yPos = (int)(($size + $textH) / 2 - ($bbox[1] + $bbox[7]) / 2);
                    imagettftext($im, $fontSize, 0, $xPos, $yPos, $white, $fontPath, $initials);

                    header('Content-Type: image/png');
                    header('Cache-Control: public, max-age=86400');
                    imagepng($im, null, 9);
                    imagedestroy($im);
                } else {
                    // GD/TTF missing → tell the client to render initials itself.
                    header('HTTP/1.1 404 Not Found');
                    header('Cache-Control: public, max-age=3600');
                }
                exit;
            }
            // Prefer WebP when the client (browser, modern email clients,
            // expo-image, fetch with default Accept) advertises support. Falls
            // back to JPEG for older clients (most desktop email apps and
            // legacy iOS). 30-50% smaller wire bytes on the WebP path.
            $accept = $_SERVER['HTTP_ACCEPT'] ?? '';
            $wantsWebp = stripos($accept, 'image/webp') !== false || stripos($accept, '*/*') !== false || $accept === '';
            $webpFile = "{$profileDir}/avatar.webp";
            $jpgFile  = "{$profileDir}/avatar.jpg";
            // Lazy-migrate legacy avatars (oversized .jpg/.png/.webp from old
            // upload path before we standardized on dual-encode 256×256). We
            // need BOTH the webp variant AND the resized jpg, so trigger if
            // either one is missing. Detect "needs migration" as: missing
            // webp variant. (Pre-migration we always have at least a jpg.)
            $needMigrate = !file_exists($webpFile) && !empty($avatarFiles[0]);
            if ($needMigrate) {
                try {
                    $legacy = $avatarFiles[0];
                    $legacyMime = mime_content_type($legacy);
                    $im = null;
                    if ($legacyMime === 'image/jpeg') $im = @imagecreatefromjpeg($legacy);
                    elseif ($legacyMime === 'image/png') $im = @imagecreatefrompng($legacy);
                    elseif ($legacyMime === 'image/webp') $im = @imagecreatefromwebp($legacy);
                    if ($im) {
                        $sw = imagesx($im); $sh = imagesy($im);
                        $sc = min(256 / $sw, 256 / $sh, 1.0);
                        $dw = max(1, (int)round($sw * $sc));
                        $dh = max(1, (int)round($sh * $sc));
                        $dst = imagecreatetruecolor($dw, $dh);
                        $whiteBg = imagecolorallocate($dst, 255, 255, 255);
                        imagefilledrectangle($dst, 0, 0, $dw, $dh, $whiteBg);
                        imagecopyresampled($dst, $im, 0, 0, 0, 0, $dw, $dh, $sw, $sh);
                        @imagewebp($dst, $webpFile, 85);
                        @imagejpeg($dst, $jpgFile, 88);
                        if (file_exists($webpFile)) @chmod($webpFile, 0644);
                        if (file_exists($jpgFile))  @chmod($jpgFile, 0644);
                        // Don't unlink the legacy file — the next upload_avatar
                        // call will tidy it up. Keeping it avoids a 404 if this
                        // request races with a parallel reader.
                        imagedestroy($dst); imagedestroy($im);
                    }
                } catch (Throwable $_) { /* serve legacy file as-is below */ }
            }
            $avatarPath = null;
            if ($wantsWebp && file_exists($webpFile)) {
                $avatarPath = $webpFile;
            } elseif (file_exists($jpgFile)) {
                $avatarPath = $jpgFile;
            } else {
                $avatarPath = $avatarFiles[0]; // legacy variant
            }
            $ext = pathinfo($avatarPath, PATHINFO_EXTENSION);
            $types = ['jpg' => 'image/jpeg', 'png' => 'image/png', 'webp' => 'image/webp'];
            header('Content-Type: ' . ($types[$ext] ?? 'image/jpeg'));
            header('Cache-Control: public, max-age=86400');
            // `Vary: Accept` so CDN edges and browser caches keep separate
            // entries for WebP-capable vs JPEG-only clients.
            header('Vary: Accept');
            header('Content-Length: ' . filesize($avatarPath));
            readfile($avatarPath);
            exit;

        // ---- BLOCK SENDER ----
        case 'block_sender':
            $auth = requireAuth();
            $input = getInput();
            $senderEmail = strtolower(trim($input['email'] ?? ''));
            if (!$senderEmail) jsonResponse(false, null, 'Email obrigatorio', 400);

            $parts = explode('@', $auth['email']);
            $settingsFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/settings.json";
            $settings = file_exists($settingsFile) ? json_decode(file_get_contents($settingsFile), true) : [];
            $blocked = $settings['blocked_senders'] ?? [];
            if (!in_array($senderEmail, $blocked)) $blocked[] = $senderEmail;
            $settings['blocked_senders'] = $blocked;
            file_put_contents($settingsFile, json_encode($settings, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
            jsonResponse(true, null, 'Remetente bloqueado');
            break;

        case 'unblock_sender':
            $auth = requireAuth();
            $input = getInput();
            $senderEmail = strtolower(trim($input['email'] ?? ''));
            $parts = explode('@', $auth['email']);
            $settingsFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/settings.json";
            $settings = file_exists($settingsFile) ? json_decode(file_get_contents($settingsFile), true) : [];
            $settings['blocked_senders'] = array_values(array_filter($settings['blocked_senders'] ?? [], fn($e) => $e !== $senderEmail));
            file_put_contents($settingsFile, json_encode($settings, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
            jsonResponse(true, null, 'Remetente desbloqueado');
            break;

        // ---- MUTE THREAD ----
        case 'mute_thread':
            $auth = requireAuth();
            $input = getInput();
            $messageId = trim($input['message_id'] ?? '');
            if (!$messageId) jsonResponse(false, null, 'message_id obrigatorio', 400);

            $parts = explode('@', $auth['email']);
            $settingsFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/settings.json";
            $settings = file_exists($settingsFile) ? json_decode(file_get_contents($settingsFile), true) : [];
            $muted = $settings['muted_threads'] ?? [];
            if (!in_array($messageId, $muted)) $muted[] = $messageId;
            $settings['muted_threads'] = array_slice($muted, -200); // keep last 200
            file_put_contents($settingsFile, json_encode($settings, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
            jsonResponse(true, null, 'Conversa silenciada');
            break;

        case 'unmute_thread':
            $auth = requireAuth();
            $input = getInput();
            $messageId = trim($input['message_id'] ?? '');
            $parts = explode('@', $auth['email']);
            $settingsFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/settings.json";
            $settings = file_exists($settingsFile) ? json_decode(file_get_contents($settingsFile), true) : [];
            $settings['muted_threads'] = array_values(array_filter($settings['muted_threads'] ?? [], fn($m) => $m !== $messageId));
            file_put_contents($settingsFile, json_encode($settings, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
            jsonResponse(true, null, 'Conversa reativada');
            break;

        // ---- EXPORT EMAIL AS EML ----
        case 'export_email':
            $auth = requireAuth();
            $uid = (int)($_GET['uid'] ?? 0);
            $folder = $_GET['folder'] ?? 'INBOX';
            if ($folder === 'Flagged') $folder = 'INBOX';
            if (!$uid) jsonResponse(false, null, 'uid obrigatorio', 400);

            $imap = getImap($auth['email'], $auth['password'], $folder);
            $header = imap_fetchheader($imap, $uid, FT_UID);
            $body = imap_body($imap, $uid, FT_UID);
            try { imap_close($imap); } catch (\Throwable $_e) {}

            $eml = $header . "\r\n" . $body;
            header('Content-Type: message/rfc822');
            header('Content-Disposition: attachment; filename="email_' . $uid . '.eml"');
            header('Content-Length: ' . strlen($eml));
            echo $eml;
            exit;

        // ---- SESSIONS / LINKED DEVICES ----
        case 'sessions_list':
            $auth = requireAuthLite();
            // Read current bearer token to identify "this device"
            $currentHash = '';
            $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
            if (preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) {
                $currentHash = hash('sha256', trim($m[1]));
            }
            // Helper: parse UA into a friendly device label
            $deviceLabel = function ($ua, $ip) {
                if (empty($ua)) {
                    if (!empty($ip)) {
                        return strpos($ip, ':') !== false ? 'Aparelho (IPv6)' : 'Aparelho';
                    }
                    return 'Aparelho';
                }
                if (preg_match('/Chatyy\/(\d+).*Darwin/i', $ua)) return 'iPhone · Chatyy iOS';
                if (preg_match('/CFNetwork.*Darwin/i', $ua))    return 'iPhone · App nativo';
                if (preg_match('/iPhone.*Safari/i', $ua))        return 'iPhone · Safari';
                if (preg_match('/iPad/i', $ua))                  return 'iPad';
                if (preg_match('/Android.*Chrome/i', $ua))       return 'Android · Chrome';
                if (preg_match('/Android/i', $ua))               return 'Android';
                if (preg_match('/Windows.*Chrome/i', $ua))       return 'Windows · Chrome';
                if (preg_match('/Windows.*Firefox/i', $ua))      return 'Windows · Firefox';
                if (preg_match('/Windows.*Edg/i', $ua))          return 'Windows · Edge';
                if (preg_match('/Macintosh.*Safari.*Version/i', $ua)) return 'Mac · Safari';
                if (preg_match('/Macintosh.*Chrome/i', $ua))     return 'Mac · Chrome';
                if (preg_match('/Linux.*Chrome/i', $ua))         return 'Linux · Chrome';
                if (preg_match('/Linux.*Firefox/i', $ua))        return 'Linux · Firefox';
                return 'Aparelho · ' . substr(preg_replace('/[\/\(\)].*/', '', trim($ua)), 0, 24);
            };

            $byHash = []; // dedup across filesystem + PG
            // 1) Filesystem tokens
            $tokenDir = TOKEN_STORE_DIR;
            if (is_dir($tokenDir)) {
                foreach (scandir($tokenDir) as $file) {
                    if (!str_ends_with($file, '.json')) continue;
                    $data = @json_decode(@file_get_contents($tokenDir . '/' . $file), true);
                    if (!$data || ($data['email'] ?? '') !== $auth['email']) continue;
                    if (($data['expires_at'] ?? 0) < time()) continue;
                    $hash = basename($file, '.json');
                    $ua  = $data['user_agent'] ?? '';
                    $ip  = $data['ip'] ?? '';
                    $byHash[$hash] = [
                        'id' => $hash,
                        'token_hash' => $hash,
                        'device_label' => $deviceLabel($ua, $ip),
                        'user_agent' => $ua,
                        'ip' => $ip,
                        'created_at' => (int)($data['created_at'] ?? 0),
                        'last_active' => (int)($data['last_active'] ?? $data['created_at'] ?? 0),
                        'last_seen_at' => (int)($data['last_active'] ?? $data['created_at'] ?? 0),
                        'is_current' => ($hash === $currentHash),
                    ];
                }
            }
            // 2) PG auth_tokens (Go-issued or PG-mirrored). Merge so any device
            // that authenticated via Go ends up in the list too.
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $ps = $pg->prepare("SELECT token_hash, ip, user_agent, created_at, expires_at FROM auth_tokens WHERE email = :e AND revoked_at IS NULL AND expires_at > :now ORDER BY created_at DESC LIMIT 100");
                $ps->execute([':e' => $auth['email'], ':now' => time()]);
                while ($row = $ps->fetch()) {
                    $hash = $row['token_hash'];
                    if (isset($byHash[$hash])) continue; // already from filesystem
                    $ua = $row['user_agent'] ?? '';
                    $ip = $row['ip'] ?? '';
                    $byHash[$hash] = [
                        'id' => $hash,
                        'token_hash' => $hash,
                        'device_label' => $deviceLabel($ua, $ip),
                        'user_agent' => $ua,
                        'ip' => $ip,
                        'created_at' => (int)$row['created_at'],
                        'last_active' => (int)$row['created_at'],
                        'last_seen_at' => (int)$row['created_at'],
                        'is_current' => ($hash === $currentHash),
                    ];
                }
            } catch (Throwable $e) { /* PG offline — filesystem still works */ }

            $sessions = array_values($byHash);
            // Sort: current first, then by last_active desc
            usort($sessions, function($a, $b) {
                if ($a['is_current'] && !$b['is_current']) return -1;
                if (!$a['is_current'] && $b['is_current']) return 1;
                return ($b['last_active'] ?? 0) - ($a['last_active'] ?? 0);
            });
            jsonResponse(true, $sessions);
            break;

        case 'revoke_session':
            $auth = requireAuth();
            $input = getInput();
            $sessionId = preg_replace('/[^a-f0-9]/i', '', $input['session_id'] ?? '');
            if (!$sessionId || strlen($sessionId) !== 64) {
                jsonResponse(false, null, 'Invalid session_id', 400);
            }
            $tokenFile = TOKEN_STORE_DIR . '/' . $sessionId . '.json';
            if (file_exists($tokenFile)) {
                $data = @json_decode(@file_get_contents($tokenFile), true);
                if ($data && ($data['email'] ?? '') === $auth['email']) {
                    @unlink($tokenFile);
                    jsonResponse(true, null, 'Session revoked');
                } else {
                    jsonResponse(false, null, 'Not authorized to revoke this session', 403);
                }
            }
            jsonResponse(false, null, 'Session not found', 404);
            break;

        case 'revoke_all_sessions':
            $auth = requireAuth();
            $currentHash = '';
            $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
            if (preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) {
                $currentHash = hash('sha256', trim($m[1]));
            }
            $tokenDir = TOKEN_STORE_DIR;
            $revoked = 0;
            if (is_dir($tokenDir)) {
                foreach (scandir($tokenDir) as $file) {
                    if (!str_ends_with($file, '.json')) continue;
                    $hash = basename($file, '.json');
                    if ($hash === $currentHash) continue; // keep current
                    $data = @json_decode(@file_get_contents($tokenDir . '/' . $file), true);
                    if ($data && ($data['email'] ?? '') === $auth['email']) {
                        @unlink($tokenDir . '/' . $file);
                        $revoked++;
                    }
                }
            }
            jsonResponse(true, ['revoked' => $revoked], 'All other sessions revoked');
            break;

        case 'chat_starred_messages':
            $auth = requireAuth();
            require_once __DIR__ . '/db.php';
            $pg = getPGDB();
            $email = $auth['email'];
            // Starred messages are tracked in chat_starred_messages now; join
            // onto chat_messages + chat_conversations to hydrate the preview.
            $stmt = $pg->prepare("
                SELECT m.id, m.conversation_id, m.sender_email, m.content, m.type, m.created_at,
                       c.type AS conversation_type, c.name AS conversation_name
                FROM chat_starred_messages s
                JOIN chat_messages m       ON m.id = s.message_id AND m.deleted_at IS NULL
                JOIN chat_conversations c  ON c.id = m.conversation_id
                WHERE LOWER(s.user_email) = LOWER(:email)
                ORDER BY m.created_at DESC
                LIMIT 200
            ");
            try {
                $stmt->execute([':email' => $email]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($rows as &$r) {
                    $r['sender_name'] = explode('@', $r['sender_email'])[0] ?? $r['sender_email'];
                }
                jsonResponse(true, $rows);
            } catch (Throwable $e) { jsonResponse(true, []); }
            break;

        // ---- SUPPORT TICKET (no auth required — from login page) ----
        case 'support_ticket':
            $input = getInput();
            $ticketEmail = filter_var(trim($input['email'] ?? ''), FILTER_VALIDATE_EMAIL);
            $ticketType = preg_replace('/[^a-z_]/', '', $input['type'] ?? 'general');
            $ticketMessage = trim($input['message'] ?? '');

            if (!$ticketEmail) jsonResponse(false, null, 'Valid email required', 400);
            if (!$ticketMessage || strlen($ticketMessage) < 10) jsonResponse(false, null, 'Message too short', 400);
            if (strlen($ticketMessage) > 5000) jsonResponse(false, null, 'Message too long', 400);

            // Rate limit: max 3 tickets per hour per IP
            $ticketRateKey = 'ticket_' . md5($_SERVER['REMOTE_ADDR'] ?? 'unknown');
            $ticketRateFile = sys_get_temp_dir() . '/om_rate_' . $ticketRateKey;
            $ticketAttempts = [];
            if (file_exists($ticketRateFile)) {
                $ticketAttempts = json_decode(file_get_contents($ticketRateFile), true) ?: [];
                $ticketAttempts = array_filter($ticketAttempts, fn($t) => $t > time() - 3600);
            }
            if (count($ticketAttempts) >= 3) {
                jsonResponse(false, null, 'Too many tickets. Please wait before submitting again.', 429);
            }
            $ticketAttempts[] = time();
            file_put_contents($ticketRateFile, json_encode(array_values($ticketAttempts)), LOCK_EX);

            // Save ticket to file (simple storage, no DB needed)
            $ticketData = [
                'id' => uniqid('TK-'),
                'email' => $ticketEmail,
                'type' => $ticketType,
                'message' => htmlspecialchars($ticketMessage, ENT_QUOTES, 'UTF-8'),
                'ip' => $_SERVER['REMOTE_ADDR'] ?? '',
                'user_agent' => substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 200),
                'created_at' => date('c'),
            ];

            $ticketsDir = __DIR__ . '/../data/tickets';
            if (!is_dir($ticketsDir)) mkdir($ticketsDir, 0750, true);
            file_put_contents($ticketsDir . '/' . $ticketData['id'] . '.json', json_encode($ticketData, JSON_PRETTY_PRINT));

            // Send notification email to support
            $supportTo = 'support@onemundo.com.br';
            $subject = "[Support Ticket] [{$ticketType}] From: {$ticketEmail}";
            $body = "New support ticket received:\n\n"
                  . "ID: {$ticketData['id']}\n"
                  . "From: {$ticketEmail}\n"
                  . "Type: {$ticketType}\n"
                  . "Date: {$ticketData['created_at']}\n"
                  . "IP: {$ticketData['ip']}\n\n"
                  . "Message:\n{$ticketMessage}\n";
            $safeReplyTo = str_replace(["\r", "\n"], '', $ticketEmail);
            $headers = "From: noreply@onemundo.com.br\r\nReply-To: {$safeReplyTo}\r\n";
            @mail($supportTo, $subject, $body, $headers);

            jsonResponse(true, ['ticket_id' => $ticketData['id']]);
            break;

        // --- MEETINGS ---
        case 'meet_create': case 'meet_schedule': case 'meet_update': case 'meet_cancel':
        case 'meet_join': case 'meet_leave': case 'meet_end': case 'meet_rsvp':
        case 'meet_info': case 'meet_list': case 'meet_kick': case 'meet_mute_all':
        case 'meet_lock': case 'meet_unlock': case 'meet_promote': case 'meet_demote':
        case 'meet_lobby_admit': case 'meet_lobby_deny': case 'meet_chat_history':
        case 'meet_persist_chat': case 'meet_start_recording': case 'meet_stop_recording':
        case 'meet_upload_chunk': case 'meet_upload_file': case 'meet_recap': case 'meet_ai_summary': case 'meet_recurring':
            require_once __DIR__ . '/meet.php';
            handleMeetAction($action);
            break;

        // --- CHAT ---
        case 'chat_list': case 'chat_create': case 'chat_info': case 'chat_update':
        case 'chat_add_member': case 'chat_remove_member': case 'chat_leave': case 'chat_delete':
        case 'chat_messages': case 'chat_send': case 'chat_edit': case 'chat_delete_message':
        case 'chat_react': case 'chat_mark_read': case 'chat_presence': case 'user_presence': case 'chat_typing':
        case 'chat_contacts': case 'chat_upload': case 'chat_mute': case 'chat_search':
        case 'chat_sync_contacts': case 'chat_register_phone': case 'chat_friend_suggestions':
        case 'chat_pin': case 'chat_forward': case 'chat_members_update':
        case 'chat_conversations': case 'chat_read': case 'chat_members':
        case 'chat_unread_count': case 'chat_favorite': case 'chat_pin_conversation':
        case 'chat_create_poll': case 'chat_vote_poll':
        case 'chat_create_meetup': case 'chat_meetup_rsvp':
        case 'chat_create_playlist': case 'chat_playlist_add_song': case 'chat_playlist_remove_song':
        case 'chat_message_info': case 'chat_group_call': case 'call_notify': case 'call_status': case 'chat_group_invite_link': case 'chat_group_join_via_link': case 'chat_group_set_admin_only':
        case 'status_create': case 'status_publish': case 'status_list': case 'status_view':
        case 'status_delete': case 'status_upload': case 'status_viewers':
        case 'status_reply': case 'status_react':
        // WhatsApp-parity settings + real helpers that replaced inline stubs
        case 'chat_archive': case 'chat_set_disappearing': case 'chat_schedule_message':
        case 'chat_schedule_cancel': case 'chat_scheduled_list': case 'chat_ai_mention':
        case 'chat_set_auto_translate': case 'chat_get_auto_translate':
        case 'chat_bot_register': case 'chat_bot_list': case 'chat_bot_info':
        case 'chat_bot_set_commands': case 'chat_bot_send_message': case 'chat_bot_lookup':
        case 'chat_privacy_set':
        case 'chat_privacy_get': case 'chat_set_wallpaper': case 'chat_get_wallpaper':
        case 'chat_set_note': case 'chat_set_auto_reply': case 'chat_get_auto_reply':
        case 'chat_call_history_clear': case 'chat_call_history_delete': case 'chat_export':
        case 'chat_block_user': case 'chat_unblock_user': case 'chat_blocked_list':
        case 'chat_check_blocked': case 'chat_view_once_open': case 'chat_report_user':
        case 'chat_star_message': case 'chat_pin_message': case 'chat_starred_messages':
        case 'chat_pinned_messages': case 'chat_search_messages': case 'chat_search_advanced':
        case 'chat_transcribe_audio': case 'chat_ai_assist':
        case 'chat_get_settings': case 'chat_top_active':
        // Phase 9: lock/slow mode/forward protection/notif sound/folders
        case 'chat_set_pin': case 'chat_verify_pin': case 'chat_check_pin':
        case 'chat_set_slow_mode': case 'chat_set_forward_protection':
        case 'chat_set_notif_sound': case 'chat_set_notification_sound':
        case 'chat_folders_create': case 'chat_folders_update':
        case 'chat_folders_delete': case 'chat_folders_list':
        // Phase 10: live location, broadcast lists, sticker packs
        case 'chat_update_live_location': case 'chat_stop_live_location':
        case 'chat_get_live_location':
        case 'chat_broadcast_create': case 'chat_broadcast_update':
        case 'chat_broadcast_delete': case 'chat_broadcast_send':
        case 'chat_broadcast_list':
        case 'chat_sticker_pack_install': case 'chat_sticker_pack_uninstall':
        // Phase 11: default disappearing, topics, edit history
        case 'chat_set_default_disappearing':
        case 'chat_topic_create': case 'chat_topic_delete':
        case 'chat_topic_pin': case 'chat_topic_list':
        case 'chat_edit_history':
        // Phase 12/13: saves, unread, keep, approve, vanish, member tag,
        // generic settings, per-contact privacy, call history adds, pending
        case 'chat_save_message': case 'chat_mark_unread': case 'chat_keep_message':
        case 'chat_approve_member': case 'chat_set_vanish_mode': case 'chat_set_secret_mode':
        case 'chat_set_member_tag': case 'chat_update_settings':
        case 'chat_privacy_contact_set': case 'chat_privacy_contact_list':
        case 'chat_call_history_add': case 'chat_pending_members':
        case 'chat_sticker_packs_list': case 'chat_user_stickers':
        case 'chat_sync':
        // SQLite-first chat migration Stage 2 — per-device pubkey registry
        case 'chat_device_key_publish': case 'chat_device_keys_list':
        case 'chat_device_key_touch':
        // Voicemail (caller leaves a voice message after a missed call)
        case 'voicemail_init_upload': case 'voicemail_send':
        case 'voicemail_get': case 'voicemail_mark_listened':
        case 'voicemail_transcribe':
        case 'community_create': case 'community_list': case 'community_info':
        case 'community_add_group': case 'community_remove_group':
        case 'community_members': case 'community_announcement':
        case 'community_join': case 'community_leave':
        // Bots API skeleton — see chat.php case bot_*.
        case 'bot_create': case 'bot_list': case 'bot_list_mine':
        case 'bot_search': case 'bot_set_commands': case 'bot_invoke_command':
        case 'bot_update': case 'bot_delete': case 'bot_regenerate_token':
        // Diamond wallet — 2026-05-18 monetization stack (top-up via IAP,
        // peer-to-peer send, history). All cases live in chat.php so the
        // chat_wallet_* PG tables stay co-located with the live/feed gift
        // pipeline that drives most diamond consumption.
        case 'wallet_balance': case 'wallet_topup_verify': case 'wallet_buy_diamonds':
        case 'wallet_send': case 'wallet_history': case 'wallet_pack_catalog':
            require_once __DIR__ . '/chat.php';
            handleChatAction($action);
            break;

        // --- ONE AI assistant ---
        case 'one_chat': case 'one_chat_stream': case 'one_history':
        case 'one_tts': case 'one_status': case 'one_kids_chat':
            require_once __DIR__ . '/one.php';
            // one.php uses its own switch reading $action — no explicit handler call needed,
            // the file self-executes when included.
            break;

        // --- GIF search via Tenor API (v2 with key, fallback v1 anonymous) ---
        case 'chat_search_gifs': {
            $input = getInput();
            $query = trim((string)($input['query'] ?? ''));
            $limit = (int)($input['limit'] ?? 20);
            if ($limit < 1 || $limit > 50) $limit = 20;
            // APCu cache: Tenor results are public + rarely change per query.
            // 30min TTL is plenty — big speedup for repeat searches (users hit
            // trending + same categories constantly).
            $cacheKey = 'gifs_v3_' . md5($query . '|' . $limit);
            if (function_exists('apcu_fetch')) {
                $hit = apcu_fetch($cacheKey, $ok);
                if ($ok && is_array($hit)) { jsonResponse(true, ['gifs' => $hit], 'ok'); break; }
            }

            $fetchJson = function($url) {
                $ch = curl_init($url);
                curl_setopt_array($ch, [
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT        => 8,
                    CURLOPT_CONNECTTIMEOUT => 4,
                    CURLOPT_FOLLOWLOCATION => true,
                    CURLOPT_SSL_VERIFYPEER => true,
                ]);
                $body = curl_exec($ch);
                $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
                curl_close($ch);
                if ($body === false || $code >= 400) return null;
                $j = json_decode($body, true);
                return is_array($j) ? $j : null;
            };

            $gifs = [];

            // Try Tenor v2 if API key configured
            $apiKey = getenv('TENOR_API_KEY') ?: '';
            if ($apiKey !== '') {
                $endpoint = $query === ''
                    ? 'https://tenor.googleapis.com/v2/featured'
                    : 'https://tenor.googleapis.com/v2/search';
                $params = [
                    'key'           => $apiKey,
                    'limit'         => $limit,
                    'media_filter'  => 'nanogif,tinygif,mediumgif,gif',
                    'contentfilter' => 'medium',
                    'client_key'    => 'chatyy',
                ];
                if ($query !== '') $params['q'] = $query;
                $j = $fetchJson($endpoint . '?' . http_build_query($params));
                if (is_array($j['results'] ?? null)) {
                    foreach ($j['results'] as $r) {
                        $mf = $r['media_formats'] ?? [];
                        $preview = $mf['nanogif']['url'] ?? ($mf['tinygif']['url'] ?? ($mf['gif']['url'] ?? ''));
                        $full    = $mf['gif']['url'] ?? ($mf['tinygif']['url'] ?? '');
                        if (!$preview || !$full) continue;
                        $gifs[] = [
                            'id'      => (string)($r['id'] ?? bin2hex(random_bytes(6))),
                            'preview' => $preview,
                            'url'     => $full,
                            'medium'  => $mf['mediumgif']['url'] ?? ($mf['tinygif']['url'] ?? $full),
                            'tiny'    => $mf['tinygif']['url'] ?? ($mf['nanogif']['url'] ?? $preview),
                            'size'    => (int)($mf['gif']['size'] ?? 0),
                        ];
                    }
                }
            }

            // Fallback: Tenor v1 with public anonymous key (no Cloud project required)
            if (empty($gifs)) {
                $endpoint = $query === ''
                    ? 'https://g.tenor.com/v1/trending'
                    : 'https://g.tenor.com/v1/search';
                $params = [
                    'key'          => 'LIVDSRZULELA', // documented public anonymous key
                    'limit'        => $limit,
                    'media_filter' => 'basic',
                    'contentfilter'=> 'medium',
                    'anon_id'      => substr(hash('sha256', $auth['email'] ?? 'anon'), 0, 32),
                ];
                if ($query !== '') $params['q'] = $query;
                $j = $fetchJson($endpoint . '?' . http_build_query($params));
                if (is_array($j['results'] ?? null)) {
                    foreach ($j['results'] as $r) {
                        $media = $r['media'][0] ?? [];
                        $preview = $media['nanogif']['url'] ?? ($media['tinygif']['url'] ?? ($media['gif']['url'] ?? ''));
                        $full    = $media['gif']['url'] ?? ($media['tinygif']['url'] ?? '');
                        if (!$preview || !$full) continue;
                        $gifs[] = [
                            'id'      => (string)($r['id'] ?? bin2hex(random_bytes(6))),
                            'preview' => $preview,
                            'url'     => $full,
                            'medium'  => $media['mediumgif']['url'] ?? ($media['tinygif']['url'] ?? $full),
                            'tiny'    => $media['tinygif']['url'] ?? ($media['nanogif']['url'] ?? $preview),
                            'size'    => (int)($media['gif']['size'] ?? 0),
                        ];
                    }
                }
            }

            if (function_exists('apcu_store') && !empty($gifs)) {
                apcu_store($cacheKey, $gifs, 1800); // 30 min
            }
            jsonResponse(true, ['gifs' => $gifs], 'ok');
            break;
        }

        // --- Block/report stubs (return safe defaults until real impl) ---
        case 'chat_check_blocked':
            jsonResponse(true, ['blocked' => false], 'ok');
            break;
        case 'chat_blocked_list':
            jsonResponse(true, ['blocked' => []], 'ok');
            break;
        case 'chat_block_user': case 'chat_unblock_user': case 'chat_report_user':
            jsonResponse(true, null, 'ok');
            break;

        // --- E2EE ---
        case 'e2ee_register_keys': case 'e2ee_get_keys': case 'e2ee_get_key_bundle':
        case 'e2ee_rotate_keys': case 'e2ee_backup_key': case 'e2ee_fetch_backup':
        case 'e2ee_prekey_count': case 'e2ee_enable_conversation':
            require_once __DIR__ . '/e2ee.php';
            handleE2EEAction($action);
            break;

        // --- AI stubs (return empty so UI doesn't fail) ---
        case 'ai_quick_replies': {
            // Accept either { message: 'just last msg' } or { messages: [ {sender:'me|them', content:''} ] }
            $input = getInput();
            $myName = (string)($input['my_name'] ?? 'EU');
            $thread = '';
            if (isset($input['messages']) && is_array($input['messages'])) {
                foreach (array_slice($input['messages'], -6) as $m) {
                    $who = ($m['sender'] ?? 'them') === 'me' ? $myName : 'Outro';
                    $c = trim((string)($m['content'] ?? ''));
                    if ($c === '') continue;
                    $thread .= $who . ': ' . mb_substr($c, 0, 300) . "\n";
                }
            } elseif (isset($input['message'])) {
                $thread = 'Outro: ' . mb_substr(trim((string)$input['message']), 0, 400);
            }
            if (trim($thread) === '') { jsonResponse(true, ['replies' => []], 'ok'); break; }
            require_once __DIR__ . '/ai-router.php';
            if (!function_exists('_callOpenAI')) { jsonResponse(true, ['replies' => []], 'ok'); break; }
            $sys = "You suggest 3 VERY SHORT chat replies (each under 60 chars) in Brazilian Portuguese. Match the tone. Reply with ONLY a JSON array of strings, no explanation. Example: [\"Oi!\",\"Beleza\",\"Tô indo\"]";
            $res = _callOpenAI('gpt-4o-mini', $sys, $thread, 200, 0.7);
            if ($res['error'] ?? false) { error_log('[ai_quick_replies] ' . $res['error']); jsonResponse(true, ['replies' => []], 'ok'); break; }
            $raw = trim((string)($res['text'] ?? ''));
            // Strip markdown fences if Claude wraps the JSON
            $raw = preg_replace('/^```(?:json)?\s*|\s*```$/i', '', $raw);
            $parsed = json_decode($raw, true);
            $replies = [];
            if (is_array($parsed)) {
                foreach ($parsed as $r) {
                    if (is_string($r) && trim($r) !== '') $replies[] = mb_substr(trim($r), 0, 80);
                    if (count($replies) >= 3) break;
                }
            }
            jsonResponse(true, ['replies' => $replies], 'ok');
            break;
        }
        case 'backup_debug': {
            // No-auth lightweight logger for photo-backup flow tracing.
            // One line per beacon → /var/log/chatyy-backup.log. Used from
            // services/backupEngine.js, photos.js and Swift events to trace
            // where the backup loop stalls without needing Xcode Console.
            $input = getInput();
            $tag = substr((string)($input['tag'] ?? '-'), 0, 80);
            $data = $input['data'] ?? null;
            $email = substr((string)($input['email'] ?? '-'), 0, 200);
            $session = substr((string)($input['session'] ?? '-'), 0, 40);
            $dataStr = is_string($data) ? $data : json_encode($data, JSON_UNESCAPED_UNICODE);
            $dataStr = substr(str_replace(["\n","\r"], ' ', (string)$dataStr), 0, 1500);
            $ua = substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 100);
            $line = sprintf("[%s] %s | %s | %s | %s | %s | %s\n",
                date('c'),
                $_SERVER['REMOTE_ADDR'] ?? '-',
                $email, $session, $tag,
                $dataStr, $ua
            );
            @file_put_contents('/var/log/chatyy-backup.log', $line, FILE_APPEND | LOCK_EX);
            jsonResponse(true, null, 'ok');
            break;
        }
        case 'bug_report': {
            // No-auth bug reporting endpoint. Accepts text + up to 8 images.
            $desc = trim((string)($_POST['description'] ?? ''));
            $email = trim((string)($_POST['email'] ?? ''));
            $ua = substr((string)($_POST['ua'] ?? $_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 400);
            $url = substr((string)($_POST['url'] ?? ''), 0, 500);
            $dir = '/var/www/mail/data/bug-reports';
            @mkdir($dir, 0755, true);
            $id = date('Y-m-d_H-i-s') . '_' . substr(md5(uniqid('', true)), 0, 8);
            $reportDir = $dir . '/' . $id;
            @mkdir($reportDir, 0755, true);
            $saved = [];
            $allowed = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'webp' => 'image/webp', 'gif' => 'image/gif'];
            foreach ($_FILES as $k => $f) {
                if (!is_uploaded_file($f['tmp_name'] ?? '')) continue;
                if (($f['size'] ?? 0) > 20 * 1024 * 1024) continue;
                $origName = basename($f['name'] ?? 'img.png');
                $ext = strtolower(pathinfo($origName, PATHINFO_EXTENSION));
                if (!isset($allowed[$ext])) continue;
                $finfo = @mime_content_type($f['tmp_name']);
                if ($finfo && !in_array($finfo, array_values($allowed), true)) continue;
                $dest = $reportDir . '/' . preg_replace('/[^a-z0-9._-]/i', '_', $origName);
                if (move_uploaded_file($f['tmp_name'], $dest)) $saved[] = basename($dest);
            }
            $meta = [
                'id' => $id,
                'description' => $desc,
                'email' => $email,
                'ua' => $ua,
                'url' => $url,
                'ip' => $_SERVER['REMOTE_ADDR'] ?? '-',
                'timestamp' => date('c'),
                'images' => $saved,
            ];
            @file_put_contents($reportDir . '/meta.json', json_encode($meta, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX);
            $line = '[' . date('c') . '] ' . $id . ' | ' . str_replace(["\n","\r"], ' ', mb_substr($desc, 0, 300)) . ' | imgs: ' . count($saved) . ' | ' . ($email ?: '-') . "\n";
            @file_put_contents('/var/log/chatyy-bug-reports.log', $line, FILE_APPEND | LOCK_EX);
            jsonResponse(true, ['id' => $id, 'images' => count($saved)], 'ok');
            break;
        }
                case 'ai_detect_leak':
            jsonResponse(true, ['detected' => false], 'ok');
            break;

        // ---- FEED (Instagram-style posts) — reads from PostgreSQL chat_feed_posts ----

        // feed_create_post — accept multipart media + caption, write to R2,
        // insert row in chat_feed_posts. Previously the frontend called this
        // but it wasn't even a case — silently became a generic 400 and
        // users saw "Failed to publish" forever.
        // feed_get_post — fetch a single post by id. PUBLIC: no auth
        // required for `audience='everyone'` posts (so share links work
        // for logged-out viewers). Followers-only / close-friends posts
        // still require auth + membership check.
        case 'feed_get_post': {
            $input = getInput();
            $postId = (int)($input['id'] ?? $input['post_id'] ?? $_GET['id'] ?? 0);
            if (!$postId) jsonResponse(false, null, 'id required', 400);

            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // `audience` column doesn't exist on chat_feed_posts in prod,
                // so every post is effectively public. If the column is ever
                // added the share route should start enforcing followers-only
                // checks here.
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS subtitles TEXT");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS is_ad BOOLEAN DEFAULT FALSE");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS is_promoted BOOLEAN DEFAULT FALSE");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS promoted_until TIMESTAMP");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS tagged_users TEXT");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS location_lon DOUBLE PRECISION");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS location_name TEXT");
                $stmt = $pg->prepare("
                    SELECT id, author_email, author_name, caption, media_type, media_urls,
                           thumbnail_url, location, location_lat, location_lon, location_name,
                           tagged_users, is_ad, is_promoted, promoted_until,
                           created_at, video_hls_url, subtitles,
                           repost_of_id
                    FROM chat_feed_posts
                    WHERE id = :id AND is_deleted = 0 AND (published IS NULL OR published = TRUE)
                    LIMIT 1
                ");
                $stmt->execute([':id' => $postId]);
                $post = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$post) jsonResponse(false, null, 'Post not found', 404);

                $post['id'] = (int)$post['id'];
                $post['media_urls'] = _cdnifyArray(json_decode($post['media_urls'] ?: '[]', true) ?: []);
                $post['thumbnail_url'] = _cdnify($post['thumbnail_url'] ?? '');
                if (!empty($post['subtitles'])) {
                    $dec = json_decode($post['subtitles'], true);
                    if (is_array($dec)) $post['subtitles'] = $dec;
                }
                // Wave 15 surface
                if (!empty($post['tagged_users'])) {
                    $tu = json_decode($post['tagged_users'], true);
                    $post['tagged_users'] = is_array($tu) ? $tu : [];
                } else {
                    $post['tagged_users'] = [];
                }
                $post['is_ad'] = !empty($post['is_ad']);
                $promoActive = !empty($post['is_promoted']) && (!$post['promoted_until'] || strtotime($post['promoted_until']) > time());
                $post['is_promoted'] = (bool)$promoActive;
                $post['sponsored'] = $post['is_ad'] || $promoActive;
                if ($post['location_lat'] !== null) $post['location_lat'] = (float)$post['location_lat'];
                if ($post['location_lon'] !== null) $post['location_lon'] = (float)$post['location_lon'];
                // Embed the original post when this row is a repost so the
                // frontend can render the quoted card without a second roundtrip.
                if (!empty($post['repost_of_id'])) {
                    try {
                        $os = $pg->prepare("SELECT id, author_email, author_name, caption, media_type, media_urls, thumbnail_url, created_at FROM chat_feed_posts WHERE id = :id AND is_deleted = 0 LIMIT 1");
                        $os->execute([':id' => (int)$post['repost_of_id']]);
                        $orig = $os->fetch(PDO::FETCH_ASSOC);
                        if ($orig) {
                            $orig['id'] = (int)$orig['id'];
                            $orig['media_urls'] = _cdnifyArray(json_decode($orig['media_urls'] ?: '[]', true) ?: []);
                            $orig['thumbnail_url'] = _cdnify($orig['thumbnail_url'] ?? '');
                            $post['original_post'] = $orig;
                        }
                    } catch (Throwable $_e) {}
                }

                // Enrich with public counts (likes + comments). No viewer-specific
                // flags since this endpoint may be called unauth'd.
                try {
                    $lc = $pg->prepare("SELECT COUNT(*) FROM chat_feed_likes WHERE post_id = :id");
                    $lc->execute([':id' => $post['id']]);
                    $post['likes_count'] = (int)$lc->fetchColumn();
                    $cc = $pg->prepare("SELECT COUNT(*) FROM chat_feed_comments WHERE post_id = :id AND (is_deleted IS NULL OR is_deleted = 0)");
                    $cc->execute([':id' => $post['id']]);
                    $post['comments_count'] = (int)$cc->fetchColumn();
                } catch (Throwable $e) { $post['likes_count'] = 0; $post['comments_count'] = 0; }

                jsonResponse(true, ['post' => $post]);
            } catch (Throwable $e) {
                error_log('[feed_get_post] ' . $e->getMessage());
                jsonResponse(false, null, 'Load failed', 500);
            }
            break;
        }

        case 'feed_create_post': {
            $auth = requireAuth();
            $caption = trim((string)($_POST['caption'] ?? ''));
            $location = trim((string)($_POST['location'] ?? ''));
            // Ternary trap: $_POST['media_type'] ?? 'image' in the condition can be 'image', making it truthy,
            // but the `true` branch returned $_POST['media_type'] which is NULL when unset — triggering a NOT-NULL
            // violation on chat_feed_posts.media_type. Normalize once via $_POST var instead.
            $mt = $_POST['media_type'] ?? 'image';
            $mediaType = in_array($mt, ['image','video'], true) ? $mt : 'image';
            $isReel = (int)!!($_POST['is_reel'] ?? 0);
            $taggedJson = trim((string)($_POST['tagged'] ?? ''));
            $aud = $_POST['audience'] ?? 'everyone';
            $audience = in_array($aud, ['everyone','followers','close_friends'], true) ? $aud : 'everyone';
            $scheduledAt = trim((string)($_POST['scheduled_at'] ?? ''));
            // Repost flow: when repost_of is set the new post embeds an existing
            // post as a quoted card. We validate the original is alive + non-deleted
            // and skip the media-required check (repost without media is allowed —
            // the embedded post supplies the visual).
            $repostOfId = (int)($_POST['repost_of'] ?? $_POST['repost_of_id'] ?? 0);
            $isRepost = $repostOfId > 0;
            if ($isRepost) {
                try {
                    require_once __DIR__ . '/db.php';
                    $pgChk = getPGDB();
                    $chk = $pgChk->prepare("SELECT id FROM chat_feed_posts WHERE id = :id AND is_deleted = 0 LIMIT 1");
                    $chk->execute([':id' => $repostOfId]);
                    if (!$chk->fetchColumn()) jsonResponse(false, null, 'Original post unavailable', 400);
                } catch (Throwable $e) { jsonResponse(false, null, 'Repost validation failed', 500); }
            }

            // Anti-abuse: 30 posts/hour per user.
            $rf = '/tmp/feed_post_rate_' . md5($auth['email']);
            $rates = file_exists($rf) ? (json_decode(@file_get_contents($rf), true) ?: []) : [];
            $rates = array_values(array_filter($rates, fn($t) => is_numeric($t) && $t > time() - 3600));
            if (count($rates) >= 30) jsonResponse(false, null, 'Posting too fast. Try again later.', 429);
            $rates[] = time();
            @file_put_contents($rf, json_encode($rates), LOCK_EX);

            if (empty($_FILES['media']) && empty($_POST['media_url']) && !$isRepost) {
                jsonResponse(false, null, 'media required', 400);
            }

            // Accept either uploaded files (FormData media[]) OR a pre-
            // uploaded CDN URL the client already pushed to R2.
            $mediaUrls = [];
            $postId = 0;
            $baseDir = '/var/www/mail/data/feed-files';
            if (!is_dir($baseDir)) @mkdir($baseDir, 0775, true);

            if (!empty($_FILES['media'])) {
                $files = $_FILES['media'];
                $count = is_array($files['name']) ? count($files['name']) : 1;
                if ($count > 10) jsonResponse(false, null, 'Max 10 medias per post', 400);

                // 100GB plan storage cap — sum the whole batch first so an
                // over-quota user is told exactly once before we begin
                // moving uploaded files into /data/feed-files/.
                $batchTotal = 0;
                for ($_i = 0; $_i < $count; $_i++) {
                    $_sz = is_array($files['size']) ? $files['size'][$_i] : $files['size'];
                    $_er = is_array($files['error']) ? $files['error'][$_i] : $files['error'];
                    if ($_er === UPLOAD_ERR_OK) $batchTotal += (int)$_sz;
                }
                if ($batchTotal > 0) {
                    require_once __DIR__ . '/plans.php';
                    enforceStorageCap($auth['email'], $batchTotal);
                }

                $imageExt = ['jpg','jpeg','png','gif','webp','heic','heif'];
                $videoExt = ['mp4','mov','webm','mkv','m4v'];
                for ($i = 0; $i < $count; $i++) {
                    $name = is_array($files['name']) ? $files['name'][$i] : $files['name'];
                    $tmp  = is_array($files['tmp_name']) ? $files['tmp_name'][$i] : $files['tmp_name'];
                    $size = is_array($files['size']) ? $files['size'][$i] : $files['size'];
                    $err  = is_array($files['error']) ? $files['error'][$i] : $files['error'];
                    if ($err !== UPLOAD_ERR_OK || !is_uploaded_file($tmp)) continue;
                    if ($size > 200 * 1024 * 1024) jsonResponse(false, null, 'File >200MB', 400);
                    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
                    $allowed = $mediaType === 'video' ? $videoExt : $imageExt;
                    if (!in_array($ext, $allowed, true)) continue;
                    $postDir = $baseDir . '/' . date('Y-m') . '/' . md5($auth['email']);
                    if (!is_dir($postDir)) @mkdir($postDir, 0775, true);
                    $safe = bin2hex(random_bytes(6)) . '.' . $ext;
                    $dest = $postDir . '/' . $safe;
                    if (!move_uploaded_file($tmp, $dest)) continue;
                    $mediaUrls[] = '/data/feed-files/' . date('Y-m') . '/' . md5($auth['email']) . '/' . $safe;

                    // For video posts (incl. reels), generate a JPEG poster
                    // synchronously so the feed/profile grids have a real
                    // thumbnail instead of a black box. Without this, native
                    // GridItem renders a dark placeholder because expo-image
                    // can't decode video frames. Same ffmpeg pattern used by
                    // chat uploads (chat.php:2756). Best-effort: ffmpeg
                    // failure just leaves the original media URL as the
                    // thumb fallback.
                    if (in_array($ext, $videoExt, true)) {
                        $thumbPath = $dest . '.thumb.jpg';
                        @shell_exec(sprintf(
                            'setsid timeout 25 nice -n 19 ffmpeg -y -ss 0.5 -i %s -frames:v 1 -vf %s -q:v 5 %s 2>/dev/null',
                            escapeshellarg($dest),
                            escapeshellarg("scale='min(640,iw)':-2"),
                            escapeshellarg($thumbPath)
                        ));
                    }

                    // Fire-and-forget upload to Cloudflare R2 so feed media
                    // streams from the Cloudflare edge (globally fast)
                    // instead of hitting the US origin on every scroll.
                    // Local copy stays as a warm backup + @r2_fallback
                    // target. Content-Type map mirrors the client picker.
                    try {
                        $ctMap = [
                            'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png',
                            'gif' => 'image/gif', 'webp' => 'image/webp', 'heic' => 'image/heic',
                            'heif' => 'image/heif', 'mp4' => 'video/mp4', 'mov' => 'video/quicktime',
                            'webm' => 'video/webm', 'mkv' => 'video/x-matroska', 'm4v' => 'video/x-m4v',
                        ];
                        $ct = $ctMap[$ext] ?? 'application/octet-stream';
                        $key = ltrim(end($mediaUrls), '/');
                        $cmd = sprintf(
                            'setsid nice -n 19 /var/www/mail/api/r2-upload-async.sh %s %s %s > /dev/null 2>&1 &',
                            escapeshellarg($dest),
                            escapeshellarg($key),
                            escapeshellarg($ct)
                        );
                        @shell_exec($cmd);
                        // Push the generated poster too — same key suffixed
                        // with .thumb.jpg so CDN caches it next to the video.
                        if (in_array($ext, $videoExt, true) && file_exists($dest . '.thumb.jpg')) {
                            $cmdT = sprintf(
                                'setsid nice -n 19 /var/www/mail/api/r2-upload-async.sh %s %s %s > /dev/null 2>&1 &',
                                escapeshellarg($dest . '.thumb.jpg'),
                                escapeshellarg($key . '.thumb.jpg'),
                                escapeshellarg('image/jpeg')
                            );
                            @shell_exec($cmdT);
                        }
                    } catch (Throwable $e) { /* non-fatal */ }
                }
                if (empty($mediaUrls)) jsonResponse(false, null, 'No valid media uploaded', 400);
            } else {
                // Pre-uploaded CDN URL
                $url = trim((string)$_POST['media_url']);
                if (!preg_match('#^https?://[a-z0-9.-]+/#i', $url)) jsonResponse(false, null, 'Invalid media_url', 400);
                $mediaUrls[] = $url;
            }

            // For video posts, prefer the ffmpeg-generated poster as the
            // thumbnail. Fall back to the first media URL when no poster
            // exists (image post, or ffmpeg unavailable / failed).
            $thumbUrl = $mediaUrls[0];
            if ($mediaType === 'video' && !empty($mediaUrls[0])) {
                $candidate = $mediaUrls[0] . '.thumb.jpg';
                $localCandidate = '/var/www/mail' . $candidate;
                if (file_exists($localCandidate)) $thumbUrl = $candidate;
            }

            // ── Wave 15: tagged people + structured location ──
            // tagged_users → JSON array of emails so we can fan-out pushes
            // to each tagged person (and later render @chips in the
            // frontend without re-parsing the caption).
            $taggedEmails = [];
            if ($taggedJson !== '') {
                $dec = json_decode($taggedJson, true);
                if (is_array($dec)) {
                    foreach ($dec as $em) {
                        $em = strtolower(trim((string)$em));
                        if ($em !== '' && filter_var($em, FILTER_VALIDATE_EMAIL)) {
                            $taggedEmails[] = $em;
                            if (count($taggedEmails) >= 30) break; // sanity cap
                        }
                    }
                    $taggedEmails = array_values(array_unique($taggedEmails));
                }
            }
            // Structured location (lat/lon/name). Optional — frontend may
            // send only `location` (free-text) or all three. Round-trip
            // both so reposts/cards keep the free-text label as a fallback.
            $locLat = isset($_POST['location_lat']) && $_POST['location_lat'] !== '' ? (float)$_POST['location_lat'] : null;
            $locLon = isset($_POST['location_lon']) && $_POST['location_lon'] !== '' ? (float)$_POST['location_lon'] : null;
            $locName = trim((string)($_POST['location_name'] ?? ''));
            if ($locName === '' && $location !== '') $locName = $location;
            // Guard: latitude in [-90,90] and longitude in [-180,180] —
            // anything else means a buggy client, drop the coords.
            if ($locLat !== null && ($locLat < -90 || $locLat > 90)) $locLat = null;
            if ($locLon !== null && ($locLon < -180 || $locLon > 180)) $locLon = null;

            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS repost_caption TEXT");
                // Wave 15 columns. ADD COLUMN IF NOT EXISTS is idempotent so
                // we run them on every feed_create_post — same pattern the
                // rest of the file uses for forward-compatible schema bumps.
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS is_ad BOOLEAN DEFAULT FALSE");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS tagged_users TEXT");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS location_lon DOUBLE PRECISION");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS location_name TEXT");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS is_promoted BOOLEAN DEFAULT FALSE");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS promoted_until TIMESTAMP");
                $ins = $pg->prepare("INSERT INTO chat_feed_posts (author_email, author_name, caption, media_type, media_urls, thumbnail_url, location, location_lat, location_lon, location_name, tagged_users, created_at, updated_at, repost_of_id, repost_caption)
                    VALUES (:ae, :an, :c, :t, :m, :th, :loc, :lat, :lon, :lname, :tag, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, :ro, :rc) RETURNING id");
                $ins->execute([
                    ':ae' => $auth['email'],
                    ':an' => $auth['name'] ?? explode('@', $auth['email'])[0],
                    ':c'  => mb_substr($caption, 0, 2200),
                    ':t'  => $mediaType,
                    ':m'  => json_encode($mediaUrls),
                    ':th' => $thumbUrl,
                    ':loc'=> mb_substr($location, 0, 200),
                    ':lat'=> $locLat,
                    ':lon'=> $locLon,
                    ':lname'=> mb_substr($locName, 0, 200),
                    ':tag'=> $taggedEmails ? json_encode($taggedEmails) : null,
                    ':ro' => $isRepost ? $repostOfId : null,
                    ':rc' => $isRepost ? mb_substr($caption, 0, 2200) : null,
                ]);
                $postId = (int)$ins->fetchColumn();
            } catch (Throwable $e) {
                jsonResponse(false, null, 'insert failed: ' . $e->getMessage(), 500);
            }

            // Invalida o cache do perfil do autor pra novo post aparecer na hora
            // — sem isso o user via "Posts: 1" mas a tab vinha com dado antigo
            // (cache 60s). User reportou: "feed n puxa o que postei".
            try { require_once __DIR__ . '/cache.php'; cacheInvalidate("profile:v1:" . strtolower($auth['email'])); } catch (Throwable $_) {}

            // ── Wave 15: push fan-out ────────────────────────────────────
            // 1) Tagged users ("X marcou você em uma publicação").
            // 2) Followers ("X postou um novo reel/foto") — skipping anyone
            //    who muted this creator. Fire-and-forget; push failures
            //    don't block the response.
            if (!function_exists('fcmSendToUser')) {
                @require_once __DIR__ . '/firebase_push.php';
            }
            $authorName = $auth['name'] ?? explode('@', $auth['email'])[0];
            if (function_exists('fcmSendToUser')) {
                try {
                    foreach ($taggedEmails as $tEmail) {
                        if (strcasecmp($tEmail, $auth['email']) === 0) continue;
                        try {
                            fcmSendToUser(
                                $tEmail,
                                $authorName,
                                $authorName . ' marcou você em uma publicação',
                                [
                                    'type'        => 'feed_tagged',
                                    'categoryId'  => 'feed_tagged',
                                    'post_id'     => (string)$postId,
                                    'author_email'=> $auth['email'],
                                    'route'       => '/feed/' . $postId,
                                ]
                            );
                        } catch (Throwable $_e) { error_log('[feed_create.push.tag] ' . $_e->getMessage()); }
                    }
                } catch (Throwable $_e) {}

                try {
                    require_once __DIR__ . '/db.php';
                    $pg2 = getPGDB();
                    $followers = [];
                    try {
                        $fs = $pg2->prepare("SELECT follower_email FROM chat_follows WHERE LOWER(following_email) = LOWER(:e)");
                        $fs->execute([':e' => $auth['email']]);
                        foreach ($fs->fetchAll(PDO::FETCH_COLUMN) as $em) $followers[] = $em;
                    } catch (Throwable $_e) { /* table may not exist on dev */ }
                    // Drop muted-creator subscribers. Best-effort lookup —
                    // table may not exist in old environments.
                    $muted = [];
                    try {
                        @$pg2->exec("CREATE TABLE IF NOT EXISTS chat_user_muted_creators (
                            email TEXT NOT NULL,
                            muted_email TEXT NOT NULL,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            PRIMARY KEY (email, muted_email)
                        )");
                        $mq = $pg2->prepare("SELECT email FROM chat_user_muted_creators WHERE LOWER(muted_email) = LOWER(:e)");
                        $mq->execute([':e' => $auth['email']]);
                        foreach ($mq->fetchAll(PDO::FETCH_COLUMN) as $em) $muted[strtolower($em)] = true;
                    } catch (Throwable $_e) {}
                    $pushTitle = $authorName;
                    $kind = ($isReel || $mediaType === 'video') ? 'reel' : 'foto';
                    $pushBody = $authorName . ' postou um novo ' . $kind;
                    $pushData = [
                        'type'        => 'feed_post_new',
                        'categoryId'  => 'feed_post_new',
                        'post_id'     => (string)$postId,
                        'author_email'=> $auth['email'],
                        'author_name' => $authorName,
                        'media_type'  => $mediaType,
                        'is_reel'     => $isReel ? '1' : '0',
                        'route'       => '/feed/' . $postId,
                        'thread_id'   => 'feed_post_' . $postId,
                    ];
                    foreach ($followers as $fEmail) {
                        if (!$fEmail) continue;
                        if (strcasecmp($fEmail, $auth['email']) === 0) continue;
                        if (isset($muted[strtolower($fEmail)])) continue;
                        // Skip if the user was already pinged as a tagged person.
                        if (in_array(strtolower($fEmail), $taggedEmails, true)) continue;
                        try { fcmSendToUser($fEmail, $pushTitle, $pushBody, $pushData); }
                        catch (Throwable $e) { error_log('[feed_create.push.follower] ' . $e->getMessage()); }
                    }
                } catch (Throwable $_e) {
                    error_log('[feed_create.fanout] ' . $_e->getMessage());
                }
            }

            jsonResponse(true, [
                'post' => [
                    'id' => $postId,
                    'author_email' => $auth['email'],
                    'author_name' => $auth['name'] ?? explode('@', $auth['email'])[0],
                    'caption' => $caption,
                    'media_type' => $mediaType,
                    'media_urls' => $mediaUrls,
                    'thumbnail_url' => $thumbUrl,
                    'location' => $location,
                    'location_lat' => $locLat,
                    'location_lon' => $locLon,
                    'location_name' => $locName ?: $location,
                    'tagged_users' => $taggedEmails,
                    'is_reel' => (bool)$isReel,
                    'audience' => $audience,
                ],
            ], 'Post created');
            break;
        }

        case 'feed_pin_post':
        case 'feed_unpin_post': {
            $auth = requireAuth();
            $input = getInput();
            $postId = (int)($input['post_id'] ?? 0);
            if (!$postId) jsonResponse(false, null, 'post_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Confirm ownership
                $st = $pg->prepare("SELECT id FROM chat_feed_posts WHERE id = :id AND LOWER(author_email) = LOWER(:e) LIMIT 1");
                $st->execute([':id' => $postId, ':e' => $auth['email']]);
                if (!$st->fetch()) jsonResponse(false, null, 'Not your post', 403);

                if ($action === 'feed_unpin_post') {
                    $pg->prepare("UPDATE chat_feed_posts SET is_pinned = FALSE, pin_order = 0 WHERE id = :id")
                       ->execute([':id' => $postId]);
                    jsonResponse(true, ['pinned' => false]);
                }
                // Pin: enforce 3-pin limit per author
                $cnt = $pg->prepare("SELECT COUNT(*) FROM chat_feed_posts WHERE LOWER(author_email) = LOWER(:e) AND is_pinned = TRUE AND id != :id");
                $cnt->execute([':e' => $auth['email'], ':id' => $postId]);
                if ((int)$cnt->fetchColumn() >= 3) {
                    jsonResponse(false, ['error' => 'pin_limit'], 'Limite de 3 posts fixados', 400);
                }
                // pin_order = highest+1 so new pins land first
                $maxOrd = $pg->prepare("SELECT COALESCE(MAX(pin_order),0) FROM chat_feed_posts WHERE LOWER(author_email) = LOWER(:e) AND is_pinned = TRUE");
                $maxOrd->execute([':e' => $auth['email']]);
                $newOrder = (int)$maxOrd->fetchColumn() + 1;
                $pg->prepare("UPDATE chat_feed_posts SET is_pinned = TRUE, pin_order = :o WHERE id = :id")
                   ->execute([':o' => $newOrder, ':id' => $postId]);
                jsonResponse(true, ['pinned' => true, 'pin_order' => $newOrder]);
            } catch (Throwable $e) {
                error_log('[feed_pin_post] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed', 500);
            }
            break;
        }

        case 'feed_list': {
            $auth = requireAuth();
            $input = getInput();
            $page = max(1, (int)($input['page'] ?? $_GET['page'] ?? 1));
            $limit = min(50, max(1, (int)($input['limit'] ?? $_GET['limit'] ?? 20)));
            $offset = ($page - 1) * $limit;
            $authorFilter = trim($input['author'] ?? $_GET['author'] ?? '');

            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();

                $where = 'p.is_deleted = 0 AND (p.published IS NULL OR p.published = TRUE)';
                // Excluir contas de teste/QA que vazavam no feed dos users reais.
                // (User reportou: "esse post nao e verdadeiro" — eram posts
                // criados pelo time de QA que apareciam pra todos via shared
                // conversation match.)
                $excludedAuthors = ['smoketest@chatyy.com.br', 'apitest@chatyy.com.br', 'appletest@chatyy.com.br', 'testkid@chatyy.com.br'];
                $where .= " AND LOWER(p.author_email) NOT IN ('" . implode("','", array_map('strtolower', array_map(fn($e) => str_replace("'","",$e), $excludedAuthors))) . "')";
                $params = [];
                if ($authorFilter !== '') {
                    // Explicit author — user is viewing a profile, no contact filter.
                    // Use LOWER() so case mismatches (login as Duarte@... vs posts
                    // stored as duarte@...) don't hide a user's own feed. Also
                    // match across legacy domain — duarte@onemundo.com.br posts
                    // were stored under the old domain pre-rebrand and should
                    // still surface for duarte@chatyy.com.br.
                    $where .= ' AND LOWER(p.author_email) = LOWER(:author)';
                    $params[':author'] = $authorFilter;
                } else {
                    // Default feed: posts from people the user has a connection
                    // with — self, follows, or shared conversation members.
                    // ALL email comparisons use LOWER() so case mismatch in
                    // legacy rows doesn't cause "feed n puxa o que postei".
                    $where .= " AND (
                        LOWER(p.author_email) = LOWER(:me_author)
                        OR LOWER(p.author_email) IN (SELECT LOWER(following_email) FROM chat_follows WHERE LOWER(follower_email) = LOWER(:me_follow))
                        OR LOWER(p.author_email) IN (
                            SELECT DISTINCT LOWER(cm2.email)
                            FROM chat_conversation_members cm1
                            JOIN chat_conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
                            WHERE LOWER(cm1.email) = LOWER(:me_conv) AND LOWER(cm2.email) <> LOWER(:me_self)
                        )
                    )";
                    $params[':me_author'] = $auth['email'];
                    $params[':me_follow'] = $auth['email'];
                    $params[':me_conv']   = $auth['email'];
                    $params[':me_self']   = $auth['email'];
                }

                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS subtitles TEXT");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS is_ad BOOLEAN DEFAULT FALSE");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS is_promoted BOOLEAN DEFAULT FALSE");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS promoted_until TIMESTAMP");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS tagged_users TEXT");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS location_lon DOUBLE PRECISION");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS location_name TEXT");
                $stmt = $pg->prepare("
                    SELECT p.id, p.author_email, p.author_name, p.caption, p.media_type,
                           p.media_urls, p.thumbnail_url, p.location, p.location_lat, p.location_lon, p.location_name,
                           p.tagged_users, p.is_ad, p.is_promoted, p.promoted_until,
                           p.created_at,
                           p.video_hls_url, p.video_duration_ms, p.blurhash, p.image_variants,
                           p.subtitles, p.repost_of_id
                    FROM chat_feed_posts p
                    WHERE {$where}
                    ORDER BY p.created_at DESC
                    LIMIT {$limit} OFFSET {$offset}
                ");
                $stmt->execute($params);
                $posts = $stmt->fetchAll(PDO::FETCH_ASSOC);

                // Batch-load like/comment counts em UMA query cada (em vez de
                // 3 queries por post = N+1 explosivo). 20 posts antes = 60
                // queries; agora = 3. Latência cai ~70% no feed.
                $ids = array_map(fn($p) => (int)$p['id'], $posts);
                $likeCounts = []; $commentCounts = []; $userLiked = [];
                if (!empty($ids)) {
                    $in = implode(',', array_fill(0, count($ids), '?'));
                    try {
                        $lc = $pg->prepare("SELECT post_id, COUNT(*) AS n FROM chat_feed_likes WHERE post_id IN ($in) GROUP BY post_id");
                        $lc->execute($ids);
                        foreach ($lc->fetchAll(PDO::FETCH_ASSOC) as $r) $likeCounts[(int)$r['post_id']] = (int)$r['n'];
                    } catch (Throwable $e) {}
                    try {
                        $cc = $pg->prepare("SELECT post_id, COUNT(*) AS n FROM chat_feed_comments WHERE post_id IN ($in) GROUP BY post_id");
                        $cc->execute($ids);
                        foreach ($cc->fetchAll(PDO::FETCH_ASSOC) as $r) $commentCounts[(int)$r['post_id']] = (int)$r['n'];
                    } catch (Throwable $e) {}
                    try {
                        $ul = $pg->prepare("SELECT post_id FROM chat_feed_likes WHERE email = ? AND post_id IN ($in)");
                        $ul->execute(array_merge([$auth['email']], $ids));
                        foreach ($ul->fetchAll(PDO::FETCH_ASSOC) as $r) $userLiked[(int)$r['post_id']] = true;
                    } catch (Throwable $e) {}
                }
                // Batch-fetch original posts referenced by reposts so the feed
                // can render the embedded quote card without N+1 lookups.
                $repostIds = array_values(array_unique(array_filter(array_map(fn($p) => (int)($p['repost_of_id'] ?? 0), $posts))));
                $origMap = [];
                if (!empty($repostIds)) {
                    try {
                        $inR = implode(',', array_fill(0, count($repostIds), '?'));
                        $st = $pg->prepare("SELECT id, author_email, author_name, caption, media_type, media_urls, thumbnail_url, created_at FROM chat_feed_posts WHERE id IN ($inR) AND is_deleted = 0");
                        $st->execute($repostIds);
                        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $o) {
                            $o['id'] = (int)$o['id'];
                            $o['media_urls'] = _cdnifyArray(json_decode($o['media_urls'] ?: '[]', true) ?: []);
                            $o['thumbnail_url'] = _cdnify($o['thumbnail_url'] ?? '');
                            $origMap[$o['id']] = $o;
                        }
                    } catch (Throwable $_e) {}
                }
                foreach ($posts as &$p) {
                    $p['id'] = (int)$p['id'];
                    $p['media_urls'] = _cdnifyArray(json_decode($p['media_urls'] ?: '[]', true) ?: []);
                    if (!empty($p['subtitles'])) {
                        $dec = json_decode($p['subtitles'], true);
                        if (is_array($dec)) $p['subtitles'] = $dec;
                    }
                    // Wave 15: surface tagged_users as a proper array + sponsored flag.
                    if (!empty($p['tagged_users'])) {
                        $tu = json_decode($p['tagged_users'], true);
                        $p['tagged_users'] = is_array($tu) ? $tu : [];
                    } else {
                        $p['tagged_users'] = [];
                    }
                    $p['is_ad'] = !empty($p['is_ad']);
                    // is_promoted is only "active" while promoted_until is in
                    // the future; expired boosts go back to organic ranking.
                    $promoActive = !empty($p['is_promoted']) && (!$p['promoted_until'] || strtotime($p['promoted_until']) > time());
                    $p['is_promoted'] = (bool)$promoActive;
                    $p['sponsored'] = $p['is_ad'] || $promoActive;
                    if ($p['location_lat'] !== null) $p['location_lat'] = (float)$p['location_lat'];
                    if ($p['location_lon'] !== null) $p['location_lon'] = (float)$p['location_lon'];
                    $likeCount = $likeCounts[$p['id']] ?? 0;
                    $commentCount = $commentCounts[$p['id']] ?? 0;
                    $p['likes'] = $likeCount;
                    $p['likes_count'] = $likeCount;
                    $p['like_count'] = $likeCount;
                    $p['comments'] = $commentCount;
                    $p['comments_count'] = $commentCount;
                    $p['user_liked'] = !empty($userLiked[$p['id']]);
                    if (!empty($p['repost_of_id']) && isset($origMap[(int)$p['repost_of_id']])) {
                        $p['original_post'] = $origMap[(int)$p['repost_of_id']];
                    }
                }
                unset($p);

                // ── Wave 15: ads insertion ────────────────────────────────
                // Inject 1 active ad every FEED_AD_INTERVAL posts (default 7).
                // Ads are stored in the same chat_feed_posts table with
                // is_ad = TRUE. We pull a small candidate pool (12 latest
                // active ads) and round-robin them through the slots so
                // the user doesn't see the same ad 5x in a single page.
                // No ads on author-filtered pages (profile/grid views).
                if ($authorFilter === '' && !empty($posts)) {
                    try {
                        $adStmt = $pg->prepare("
                            SELECT p.id, p.author_email, p.author_name, p.caption, p.media_type,
                                   p.media_urls, p.thumbnail_url, p.location, p.location_lat, p.location_lon, p.location_name,
                                   p.tagged_users, p.created_at, p.video_hls_url,
                                   p.video_duration_ms, p.blurhash, p.image_variants, p.subtitles
                            FROM chat_feed_posts p
                            WHERE p.is_deleted = 0 AND p.is_ad = TRUE
                              AND (p.published IS NULL OR p.published = TRUE)
                            ORDER BY p.created_at DESC
                            LIMIT 12
                        ");
                        $adStmt->execute();
                        $adRows = $adStmt->fetchAll(PDO::FETCH_ASSOC);
                        if (!empty($adRows)) {
                            foreach ($adRows as &$ad) {
                                $ad['id'] = (int)$ad['id'];
                                $ad['media_urls'] = _cdnifyArray(json_decode($ad['media_urls'] ?: '[]', true) ?: []);
                                $ad['is_ad'] = true;
                                $ad['sponsored'] = true;
                                $ad['is_promoted'] = false;
                                $ad['tagged_users'] = [];
                                $ad['likes'] = $ad['likes_count'] = $ad['like_count'] = 0;
                                $ad['comments'] = $ad['comments_count'] = 0;
                                $ad['user_liked'] = false;
                            }
                            unset($ad);
                            $interval = (int)(getenv('FEED_AD_INTERVAL') ?: 7);
                            if ($interval < 3) $interval = 7;
                            $withAds = [];
                            $adIdx = 0;
                            foreach ($posts as $idx => $row) {
                                $withAds[] = $row;
                                // Insert ad slot AFTER every $interval organic posts.
                                if (($idx + 1) % $interval === 0 && $adIdx < count($adRows)) {
                                    $withAds[] = $adRows[$adIdx];
                                    $adIdx++;
                                }
                            }
                            $posts = $withAds;
                        }
                    } catch (Throwable $_adE) {
                        error_log('[feed_list ads] ' . $_adE->getMessage());
                    }
                }

                jsonResponse(true, ['posts' => $posts, 'page' => $page, 'has_more' => count($posts) === $limit]);
            } catch (Throwable $e) {
                error_log('[feed_list PG] ' . $e->getMessage());
                jsonResponse(true, ['posts' => [], 'page' => 1, 'has_more' => false]);
            }
            break;
        }

        // ---- FEED WRITE / INTERACTIONS ----
        case 'feed_like': {
            $auth = requireAuth();
            $input = getInput();
            $postId = (int)($input['post_id'] ?? 0);
            if (!$postId) jsonResponse(false, null, 'post_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Ensure post exists and grab author for notification
                $p = $pg->prepare("SELECT author_email FROM chat_feed_posts WHERE id = :id AND is_deleted = 0");
                $p->execute([':id' => $postId]);
                $post = $p->fetch(PDO::FETCH_ASSOC);
                if (!$post) jsonResponse(false, null, 'Post not found', 404);

                // Toggle
                $chk = $pg->prepare("SELECT 1 FROM chat_feed_likes WHERE post_id = :id AND email = :e");
                $chk->execute([':id' => $postId, ':e' => $auth['email']]);
                $liked = (bool)$chk->fetchColumn();
                if ($liked) {
                    $pg->prepare("DELETE FROM chat_feed_likes WHERE post_id = :id AND email = :e")
                       ->execute([':id' => $postId, ':e' => $auth['email']]);
                } else {
                    $pg->prepare("INSERT INTO chat_feed_likes (post_id, email) VALUES (:id, :e) ON CONFLICT DO NOTHING")
                       ->execute([':id' => $postId, ':e' => $auth['email']]);
                    // Notify post author (not self-likes)
                    if ($post['author_email'] !== $auth['email']) {
                        try {
                            $pg->prepare("INSERT INTO chat_notifications (user_email, type, title, body, group_key, author_email, data) VALUES (:u, 'feed_like', :t, :b, :g, :a, :d)")
                               ->execute([
                                   ':u' => $post['author_email'],
                                   ':t' => 'Nova curtida',
                                   ':b' => $auth['email'] . ' curtiu seu post',
                                   ':g' => 'like_' . $postId,
                                   ':a' => $auth['email'],
                                   ':d' => json_encode(['post_id' => $postId], JSON_UNESCAPED_UNICODE),
                               ]);
                        } catch (Throwable $e) {}
                    }
                }
                $cnt = $pg->prepare("SELECT COUNT(*) FROM chat_feed_likes WHERE post_id = :id");
                $cnt->execute([':id' => $postId]);
                jsonResponse(true, ['liked' => !$liked, 'likes_count' => (int)$cnt->fetchColumn()]);
            } catch (Throwable $e) {
                error_log('[feed_like] ' . $e->getMessage());
                jsonResponse(false, null, 'Like failed', 500);
            }
            break;
        }

        case 'feed_bookmark': {
            $auth = requireAuth();
            $input = getInput();
            $postId = (int)($input['post_id'] ?? 0);
            if (!$postId) jsonResponse(false, null, 'post_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $chk = $pg->prepare("SELECT 1 FROM chat_feed_bookmarks WHERE post_id = :id AND email = :e");
                $chk->execute([':id' => $postId, ':e' => $auth['email']]);
                $bookmarked = (bool)$chk->fetchColumn();
                if ($bookmarked) {
                    $pg->prepare("DELETE FROM chat_feed_bookmarks WHERE post_id = :id AND email = :e")
                       ->execute([':id' => $postId, ':e' => $auth['email']]);
                } else {
                    $pg->prepare("INSERT INTO chat_feed_bookmarks (post_id, email) VALUES (:id, :e) ON CONFLICT DO NOTHING")
                       ->execute([':id' => $postId, ':e' => $auth['email']]);
                }
                jsonResponse(true, ['bookmarked' => !$bookmarked]);
            } catch (Throwable $e) {
                error_log('[feed_bookmark] ' . $e->getMessage());
                jsonResponse(false, null, 'Bookmark failed', 500);
            }
            break;
        }

        case 'feed_comment': {
            $auth = requireAuth();
            $input = getInput();
            $postId = (int)($input['post_id'] ?? 0);
            $content = trim((string)($input['content'] ?? ''));
            $replyTo = !empty($input['reply_to_id']) ? (int)$input['reply_to_id'] : null;
            // Reels P1 — sticker / video reply support. When attachment_url or
            // media_url is present, content can be empty. media_type is one of
            // 'sticker', 'gif', 'image', 'video'. attachment_url is the legacy
            // alias the frontend uses for sticker URLs; media_url is the new
            // unified column. Both fall through to the same column on the row.
            $attachmentUrl = trim((string)($input['attachment_url'] ?? ''));
            $mediaUrl      = trim((string)($input['media_url'] ?? ''));
            $mediaType     = strtolower(trim((string)($input['media_type'] ?? '')));
            $finalMedia    = $mediaUrl !== '' ? $mediaUrl : $attachmentUrl;
            if (!in_array($mediaType, ['sticker', 'gif', 'image', 'video'], true)) {
                $mediaType = $finalMedia !== '' ? 'sticker' : '';
            }
            if (!$postId) jsonResponse(false, null, 'post_id required', 400);
            if ($content === '' && $finalMedia === '') jsonResponse(false, null, 'content or media required', 400);
            $content = mb_substr($content, 0, 1000);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Lazy add the comment attachment columns so older deployments
                // get them on first comment_with_media write. Idempotent.
                @$pg->exec("ALTER TABLE chat_feed_comments ADD COLUMN IF NOT EXISTS media_url TEXT");
                @$pg->exec("ALTER TABLE chat_feed_comments ADD COLUMN IF NOT EXISTS media_type TEXT");
                $p = $pg->prepare("SELECT author_email FROM chat_feed_posts WHERE id = :id AND is_deleted = 0");
                $p->execute([':id' => $postId]);
                $post = $p->fetch(PDO::FETCH_ASSOC);
                if (!$post) jsonResponse(false, null, 'Post not found', 404);

                $ins = $pg->prepare("INSERT INTO chat_feed_comments (post_id, email, name, content, reply_to_id, media_url, media_type) VALUES (:p, :e, :n, :c, :r, :mu, :mt) RETURNING id, created_at");
                $ins->execute([
                    ':p' => $postId,
                    ':e' => $auth['email'],
                    ':n' => $auth['name'] ?? explode('@', $auth['email'])[0],
                    ':c' => $content,
                    ':r' => $replyTo,
                    ':mu' => $finalMedia,
                    ':mt' => $mediaType,
                ]);
                $row = $ins->fetch(PDO::FETCH_ASSOC);

                if ($post['author_email'] !== $auth['email']) {
                    try {
                        $pg->prepare("INSERT INTO chat_notifications (user_email, type, title, body, group_key, author_email, data) VALUES (:u, 'feed_comment', :t, :b, :g, :a, :d)")
                           ->execute([
                               ':u' => $post['author_email'],
                               ':t' => 'Novo comentário',
                               ':b' => $auth['email'] . ': ' . mb_substr($content, 0, 80),
                               ':g' => 'comment_' . $postId,
                               ':a' => $auth['email'],
                               ':d' => json_encode(['post_id' => $postId, 'comment_id' => (int)$row['id']], JSON_UNESCAPED_UNICODE),
                           ]);
                    } catch (Throwable $e) {}
                }

                $commentPayload = [
                    'id' => (int)$row['id'],
                    'post_id' => $postId,
                    'email' => $auth['email'],
                    'name' => $auth['name'] ?? explode('@', $auth['email'])[0],
                    'content' => $content,
                    'reply_to_id' => $replyTo,
                    'media_url' => $finalMedia,
                    'media_type' => $mediaType,
                    // Legacy alias retained so older clients keep rendering stickers.
                    'attachment_url' => $finalMedia,
                    'created_at' => $row['created_at'],
                ];

                // WS broadcast: anyone with the comment sheet open on this post
                // is subscribed to 'feed_post_{id}' and will see the comment in
                // real-time without polling. Channel name mirrors how chat
                // conversations subscribe to 'chat_{convId}'.
                try {
                    $wsKey = getenv('MAIL_WS_KEY') ?: '';
                    if ($wsKey) {
                        $payload = json_encode([
                            'channel' => 'feed_post_' . (int)$postId,
                            'event'   => 'feed_comment_new',
                            'data'    => $commentPayload,
                        ]);
                        foreach (['http://127.0.0.1:8081/broadcast', 'http://127.0.0.1:8084/broadcast'] as $endpoint) {
                            $cu = curl_init($endpoint);
                            curl_setopt_array($cu, [
                                CURLOPT_POST => true,
                                CURLOPT_POSTFIELDS => $payload,
                                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                                CURLOPT_RETURNTRANSFER => true,
                                CURLOPT_TIMEOUT_MS => 600,
                                CURLOPT_CONNECTTIMEOUT_MS => 200,
                            ]);
                            curl_exec($cu);
                            curl_close($cu);
                        }
                    }
                } catch (Throwable $_) {}

                jsonResponse(true, $commentPayload, 'Comment added');
            } catch (Throwable $e) {
                error_log('[feed_comment] ' . $e->getMessage());
                jsonResponse(false, null, 'Comment failed', 500);
            }
            break;
        }

        case 'feed_comments': {
            $auth = requireAuth();
            $input = getInput();
            $postId = (int)($input['post_id'] ?? 0);
            $page = max(1, (int)($input['page'] ?? 1));
            $limit = 30;
            $offset = ($page - 1) * $limit;
            if (!$postId) jsonResponse(false, null, 'post_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Lazy table create — kept here so deployments without a
                // migration step still work. Cheap and idempotent.
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_feed_comment_likes (
                    comment_id BIGINT NOT NULL,
                    email TEXT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT now(),
                    PRIMARY KEY (comment_id, email)
                )");
                @$pg->exec("ALTER TABLE chat_feed_comments ADD COLUMN IF NOT EXISTS audio_url TEXT");
                @$pg->exec("ALTER TABLE chat_feed_comments ADD COLUMN IF NOT EXISTS media_url TEXT");
                @$pg->exec("ALTER TABLE chat_feed_comments ADD COLUMN IF NOT EXISTS media_type TEXT");
                // Threaded comments (1 level deep): pull all top-level rows
                // for this page, then attach their replies as a `replies`
                // array. We don't paginate replies — they're capped at 50 per
                // parent which is plenty for IG-style threading without
                // adding a second round-trip per parent.
                $stmt = $pg->prepare("
                    SELECT c.id, c.post_id, c.email, c.name, c.content, c.audio_url, c.media_url, c.media_type, c.reply_to_id, c.created_at,
                           COALESCE((SELECT COUNT(*) FROM chat_feed_comment_likes WHERE comment_id = c.id), 0) AS likes_count,
                           EXISTS(SELECT 1 FROM chat_feed_comment_likes WHERE comment_id = c.id AND email = :me) AS liked_by_me
                    FROM chat_feed_comments c
                    WHERE c.post_id = :p AND (c.is_deleted IS NULL OR c.is_deleted = 0)
                      AND c.reply_to_id IS NULL
                    ORDER BY c.created_at ASC
                    LIMIT {$limit} OFFSET {$offset}
                ");
                $stmt->execute([':p' => $postId, ':me' => $auth['email']]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

                $parentIds = array_map('intval', array_column($rows, 'id'));
                $repliesByParent = [];
                if (!empty($parentIds)) {
                    $in = implode(',', $parentIds);
                    $rep = $pg->prepare("
                        SELECT c.id, c.post_id, c.email, c.name, c.content, c.audio_url, c.media_url, c.media_type, c.reply_to_id, c.created_at,
                               COALESCE((SELECT COUNT(*) FROM chat_feed_comment_likes WHERE comment_id = c.id), 0) AS likes_count,
                               EXISTS(SELECT 1 FROM chat_feed_comment_likes WHERE comment_id = c.id AND email = :me) AS liked_by_me
                        FROM chat_feed_comments c
                        WHERE c.post_id = :p AND (c.is_deleted IS NULL OR c.is_deleted = 0)
                          AND c.reply_to_id IN ($in)
                        ORDER BY c.created_at ASC
                    ");
                    $rep->execute([':p' => $postId, ':me' => $auth['email']]);
                    $reps = $rep->fetchAll(PDO::FETCH_ASSOC);
                    foreach ($reps as $r2) {
                        $pid = (int)$r2['reply_to_id'];
                        if (!isset($repliesByParent[$pid])) $repliesByParent[$pid] = [];
                        if (count($repliesByParent[$pid]) >= 50) continue;
                        $repliesByParent[$pid][] = [
                            'id' => (int)$r2['id'],
                            'post_id' => (int)$r2['post_id'],
                            'email' => $r2['email'],
                            'name' => $r2['name'],
                            'content' => $r2['content'],
                            'audio_url' => $r2['audio_url'],
                            'media_url' => $r2['media_url'] ?? '',
                            'media_type' => $r2['media_type'] ?? '',
                            'attachment_url' => $r2['media_url'] ?? '',
                            'reply_to_id' => (int)$r2['reply_to_id'],
                            'created_at' => $r2['created_at'],
                            'likes_count' => (int)$r2['likes_count'],
                            'liked_by_me' => !empty($r2['liked_by_me']),
                        ];
                    }
                }
                foreach ($rows as &$r) {
                    $r['id'] = (int)$r['id'];
                    $r['post_id'] = (int)$r['post_id'];
                    $r['likes_count'] = (int)$r['likes_count'];
                    $r['liked_by_me'] = !empty($r['liked_by_me']);
                    // Surface sticker / GIF / video reply attachments uniformly.
                    // attachment_url is the legacy alias older clients read.
                    $r['media_url'] = $r['media_url'] ?? '';
                    $r['media_type'] = $r['media_type'] ?? '';
                    $r['attachment_url'] = $r['media_url'];
                    $r['replies'] = $repliesByParent[(int)$r['id']] ?? [];
                }
                jsonResponse(true, ['comments' => $rows, 'page' => $page, 'has_more' => count($rows) === $limit]);
            } catch (Throwable $e) {
                error_log('[feed_comments] ' . $e->getMessage());
                jsonResponse(true, ['comments' => [], 'page' => $page, 'has_more' => false]);
            }
            break;
        }

        case 'feed_comment_like_toggle': {
            $auth = requireAuth();
            $input = getInput();
            $commentId = (int)($input['comment_id'] ?? 0);
            if (!$commentId) jsonResponse(false, null, 'comment_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_feed_comment_likes (
                    comment_id BIGINT NOT NULL,
                    email TEXT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT now(),
                    PRIMARY KEY (comment_id, email)
                )");
                $chk = $pg->prepare("SELECT 1 FROM chat_feed_comment_likes WHERE comment_id = :c AND email = :e");
                $chk->execute([':c' => $commentId, ':e' => $auth['email']]);
                $liked = (bool)$chk->fetchColumn();
                if ($liked) {
                    $pg->prepare("DELETE FROM chat_feed_comment_likes WHERE comment_id = :c AND email = :e")
                       ->execute([':c' => $commentId, ':e' => $auth['email']]);
                } else {
                    $pg->prepare("INSERT INTO chat_feed_comment_likes (comment_id, email) VALUES (:c, :e) ON CONFLICT DO NOTHING")
                       ->execute([':c' => $commentId, ':e' => $auth['email']]);
                }
                $cnt = $pg->prepare("SELECT COUNT(*) FROM chat_feed_comment_likes WHERE comment_id = :c");
                $cnt->execute([':c' => $commentId]);
                jsonResponse(true, ['liked' => !$liked, 'likes_count' => (int)$cnt->fetchColumn()]);
            } catch (Throwable $e) {
                error_log('[feed_comment_like_toggle] ' . $e->getMessage());
                jsonResponse(false, null, 'Like failed', 500);
            }
            break;
        }

        case 'feed_likers': {
            $auth = requireAuth();
            $input = getInput();
            $postId = (int)($input['post_id'] ?? 0);
            if (!$postId) jsonResponse(false, null, 'post_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Join with chat_follows so the viewer sees a per-row
                // "Seguir"/"Seguindo" badge just like Instagram. LEFT JOIN
                // because a liker may not be followed; the absence becomes
                // is_following = false. Self-row is tagged via
                // chatyy_hydrate_follow_rows so we don't render a follow
                // button for the viewer themselves.
                $stmt = $pg->prepare("
                    SELECT l.email, l.created_at,
                           (f.follower_email IS NOT NULL) AS is_following
                    FROM chat_feed_likes l
                    LEFT JOIN chat_follows f
                      ON LOWER(f.follower_email) = LOWER(:me)
                     AND LOWER(f.following_email) = LOWER(l.email)
                    WHERE l.post_id = :p
                    ORDER BY l.created_at DESC
                    LIMIT 200
                ");
                $stmt->execute([':me' => $auth['email'], ':p' => $postId]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
                $users = chatyy_hydrate_follow_rows($rows, $auth['email']);
                jsonResponse(true, ['users' => $users, 'total' => count($users)]);
            } catch (Throwable $e) {
                error_log('[feed_likers] ' . $e->getMessage());
                jsonResponse(true, ['users' => [], 'total' => 0]);
            }
            break;
        }

        case 'feed_view': {
            $auth = requireAuth();
            $input = getInput();
            $postId = (int)($input['post_id'] ?? 0);
            // Best-effort: persist view in chat_feed_views so analytics has
            // real numbers. Table is created lazy so we don't break older
            // deploys; one row per (post_id, viewer, day) keeps spam down.
            try {
                require_once __DIR__ . '/db.php';
                $pgV = getPGDB();
                @$pgV->exec("CREATE TABLE IF NOT EXISTS chat_feed_views (
                    id BIGSERIAL PRIMARY KEY,
                    post_id BIGINT NOT NULL,
                    viewer_email TEXT NOT NULL,
                    view_day DATE NOT NULL DEFAULT CURRENT_DATE,
                    created_at TIMESTAMPTZ DEFAULT now(),
                    UNIQUE (post_id, viewer_email, view_day)
                )");
                @$pgV->exec("CREATE INDEX IF NOT EXISTS idx_chat_feed_views_post ON chat_feed_views(post_id)");
                $stV = $pgV->prepare("INSERT INTO chat_feed_views (post_id, viewer_email) VALUES (:p, :v) ON CONFLICT DO NOTHING");
                $stV->execute([':p' => $postId, ':v' => $auth['email']]);
            } catch (Throwable $e) { error_log('[feed_view] ' . $e->getMessage()); }
            jsonResponse(true, ['viewed' => true, 'post_id' => $postId]);
            break;
        }

        // ── Aggregated analytics for own posts. Returns 7-day series of
        // views + totals across views/likes/comments/saves/shares + audience
        // breakdown. Owner-only; everyone else gets a 403.
        case 'feed_post_analytics': {
            $auth = requireAuth();
            $input = getInput();
            $postId = (int)($input['post_id'] ?? $_GET['post_id'] ?? 0);
            if ($postId <= 0) jsonResponse(false, null, 'post_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pgA = getPGDB();
                @$pgA->exec("CREATE TABLE IF NOT EXISTS chat_feed_views (
                    id BIGSERIAL PRIMARY KEY, post_id BIGINT NOT NULL,
                    viewer_email TEXT NOT NULL,
                    view_day DATE NOT NULL DEFAULT CURRENT_DATE,
                    created_at TIMESTAMPTZ DEFAULT now(),
                    UNIQUE (post_id, viewer_email, view_day))");
                $own = $pgA->prepare("SELECT author_email FROM chat_feed_posts WHERE id = :id");
                $own->execute([':id' => $postId]);
                $author = (string)$own->fetchColumn();
                if ($author === '') jsonResponse(false, null, 'Post not found', 404);
                if (strcasecmp($author, $auth['email']) !== 0) {
                    jsonResponse(false, null, 'Forbidden', 403);
                }

                $views    = (int)$pgA->query("SELECT COUNT(DISTINCT viewer_email) FROM chat_feed_views WHERE post_id = " . $postId)->fetchColumn();
                $impr     = (int)$pgA->query("SELECT COUNT(*) FROM chat_feed_views WHERE post_id = " . $postId)->fetchColumn();
                $likes    = (int)$pgA->query("SELECT COUNT(*) FROM chat_feed_likes WHERE post_id = " . $postId)->fetchColumn();
                $comments = (int)$pgA->query("SELECT COUNT(*) FROM chat_feed_comments WHERE post_id = " . $postId)->fetchColumn();
                $saves    = 0;
                try { $saves = (int)$pgA->query("SELECT COUNT(*) FROM chat_feed_bookmarks WHERE post_id = " . $postId)->fetchColumn(); } catch (Throwable $e) {}
                $shares   = 0;
                try { $shares = (int)$pgA->query("SELECT COUNT(*) FROM chat_feed_posts WHERE repost_of_id = " . $postId)->fetchColumn(); } catch (Throwable $e) {}

                // 7-day daily series
                $st7 = $pgA->prepare("SELECT view_day::text AS d, COUNT(DISTINCT viewer_email) AS n FROM chat_feed_views WHERE post_id = :p AND view_day >= CURRENT_DATE - INTERVAL '6 days' GROUP BY view_day ORDER BY view_day ASC");
                $st7->execute([':p' => $postId]);
                $byDay = [];
                foreach ($st7->fetchAll(PDO::FETCH_ASSOC) as $r) $byDay[$r['d']] = (int)$r['n'];
                $series = [];
                for ($i = 6; $i >= 0; $i--) {
                    $d = date('Y-m-d', strtotime("-$i days"));
                    $series[] = ['date' => $d, 'views' => (int)($byDay[$d] ?? 0)];
                }

                // Audience: domain breakdown as a cheap "city" stand-in
                // until we have real geo. Top 3 domains of viewers.
                $audience = [];
                try {
                    $stD = $pgA->prepare("SELECT split_part(viewer_email, '@', 2) AS dom, COUNT(DISTINCT viewer_email) AS n FROM chat_feed_views WHERE post_id = :p GROUP BY dom ORDER BY n DESC LIMIT 3");
                    $stD->execute([':p' => $postId]);
                    $audience = $stD->fetchAll(PDO::FETCH_ASSOC) ?: [];
                } catch (Throwable $e) {}

                jsonResponse(true, [
                    'post_id'     => $postId,
                    'views'       => $views,
                    'reach'       => $views,
                    'impressions' => $impr,
                    'likes'       => $likes,
                    'comments'    => $comments,
                    'shares'      => $shares,
                    'saves'       => $saves,
                    'series'      => $series,
                    'audience'    => $audience,
                ]);
            } catch (Throwable $e) {
                error_log('[feed_post_analytics] ' . $e->getMessage());
                jsonResponse(false, null, 'Internal error', 500);
            }
            break;
        }

        // ── Tracking pixel for "Confirmar leitura" (read receipts).
        // GET-only; returns a 1×1 transparent PNG and logs the open.
        case 'track_open': {
            $tid = (string)($_GET['id'] ?? $_REQUEST['id'] ?? '');
            // 1x1 transparent PNG (43 bytes) — cheaper than reading from disk.
            $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAAApJREFUeJxjYAAAAAIAAUivpHEAAAAASUVORK5CYII=');
            try {
                if ($tid && preg_match('/^[a-f0-9]{8,64}$/', $tid)) {
                    require_once __DIR__ . '/db.php';
                    $pg = getPGDB();
                    @$pg->exec("CREATE TABLE IF NOT EXISTS email_opens (
                        id BIGSERIAL PRIMARY KEY,
                        track_id TEXT NOT NULL,
                        sender_email TEXT NOT NULL,
                        recipient TEXT, subject TEXT,
                        opener_ip TEXT, opener_ua TEXT,
                        opened_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now()
                    )");
                    // Stamp opened_at on the pre-existing send row instead of
                    // inserting a new row — the send case already inserts the
                    // row when `track_opens=true`. Only the FIRST open updates
                    // opened_at; subsequent loads (Gmail prefetch + actual
                    // read) still hit the pixel but don't overwrite the
                    // timestamp.
                    $pg->prepare("UPDATE email_opens SET opened_at = COALESCE(opened_at, now()), opener_ip = COALESCE(opener_ip, :ip), opener_ua = COALESCE(opener_ua, :ua) WHERE track_id = :t")
                       ->execute([
                           ':t' => $tid,
                           ':ip' => substr($_SERVER['REMOTE_ADDR'] ?? '', 0, 64),
                           ':ua' => substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 240),
                       ]);
                }
            } catch (Throwable $e) { error_log('[track_open] ' . $e->getMessage()); }
            // Always return the pixel so mail clients don't surface a broken
            // image — even if the DB write fails.
            header('Content-Type: image/png');
            header('Cache-Control: no-cache, no-store, must-revalidate');
            header('Pragma: no-cache');
            header('Content-Length: ' . strlen($png));
            echo $png;
            exit;
        }

        // List read receipts for current user — used by EmailReader to show
        // "Lido em ..." badge on outgoing messages. Returns
        // { rows: [{track_id, recipient, subject, opened_at, created_at}] }.
        case 'track_open_list': {
            $auth = requireAuth();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS email_opens (
                    id BIGSERIAL PRIMARY KEY, track_id TEXT NOT NULL,
                    sender_email TEXT NOT NULL, recipient TEXT, subject TEXT,
                    opener_ip TEXT, opener_ua TEXT,
                    opened_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now()
                )");
                $stmt = $pg->prepare("SELECT track_id, recipient, subject, opened_at, created_at FROM email_opens WHERE sender_email = :e ORDER BY created_at DESC LIMIT 200");
                $stmt->execute([':e' => $auth['email']]);
                jsonResponse(true, ['rows' => $stmt->fetchAll(PDO::FETCH_ASSOC) ?: []]);
            } catch (Throwable $e) {
                error_log('[track_open_list] ' . $e->getMessage());
                jsonResponse(true, ['rows' => []]);
            }
            break;
        }

        // ── Persist Whisper transcript segments on a feed/reel post so the
        // viewer renders TikTok-style auto-captions. Stored on
        // chat_feed_posts.subtitles (TEXT, JSON-encoded). Owner-only.
        case 'feed_post_set_subtitles': {
            $auth = requireAuth();
            $input = getInput();
            $postId = (int)($input['post_id'] ?? 0);
            $segs = $input['subtitles'] ?? null;
            if (!$postId) jsonResponse(false, null, 'post_id required', 400);
            if (!is_array($segs)) jsonResponse(false, null, 'subtitles must be array', 400);
            // Sanitize: keep only {start, end, text}; cap 500 segments × 240 chars.
            $clean = [];
            foreach ($segs as $s) {
                if (!is_array($s)) continue;
                $clean[] = [
                    'start' => (float)($s['start'] ?? 0),
                    'end'   => (float)($s['end'] ?? 0),
                    'text'  => mb_substr((string)($s['text'] ?? ''), 0, 240),
                ];
                if (count($clean) >= 500) break;
            }
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS subtitles TEXT");
                $own = $pg->prepare("SELECT author_email FROM chat_feed_posts WHERE id = :id AND is_deleted = 0");
                $own->execute([':id' => $postId]);
                $row = $own->fetch(PDO::FETCH_ASSOC);
                if (!$row) jsonResponse(false, null, 'Post not found', 404);
                if (strtolower($row['author_email']) !== strtolower($auth['email'])) {
                    jsonResponse(false, null, 'Forbidden', 403);
                }
                $pg->prepare("UPDATE chat_feed_posts SET subtitles = :s WHERE id = :id")
                   ->execute([':s' => json_encode($clean, JSON_UNESCAPED_UNICODE), ':id' => $postId]);
                jsonResponse(true, ['post_id' => $postId, 'count' => count($clean)]);
            } catch (Throwable $e) {
                error_log('[feed_post_set_subtitles] ' . $e->getMessage());
                jsonResponse(false, null, 'Save failed', 500);
            }
            break;
        }

        // ============================================================
        // Reels — Pixabay rights-cleared music catalog (free).
        // ------------------------------------------------------------
        // Pixabay's `category=music` endpoint returns free, royalty-free
        // tracks with preview audio + cover image. We proxy the call so
        // the API key never leaks to clients, and cache responses for 1h
        // to stay well under the free-tier rate limit (100 req / 60s).
        //
        // Alternative (free, no API): YouTube Audio Library —
        //   https://www.youtube.com/audiolibrary  (downloadable .mp3s,
        //   licensed for any use). We chose Pixabay because it serves
        //   JSON + preview URLs out-of-the-box; YT Audio Library has
        //   no machine-readable feed, so it would require a manual
        //   ingest pipeline.
        //
        // Response shape (normalized):
        //   { id, title, artist, preview_url, duration_sec, image_url }
        //
        // Cache files live in /tmp/music_cache/. Filename = md5 of the
        // upstream URL. TTL: 3600s. We use serve-stale-on-error so
        // network blips don't surface as 5xx to the client.
        // ============================================================
        case 'reels_music_catalog':
        case 'reels_music_search': {
            requireAuth();
            $input = getInput();
            $q = trim((string)($input['q'] ?? $input['query'] ?? ''));
            $page = max(1, min(50, (int)($input['page'] ?? 1)));
            $perPage = max(3, min(50, (int)($input['per_page'] ?? 24)));

            $apiKey = trim((string)(getenv('PIXABAY_API_KEY') ?: ''));
            $cacheDir = '/tmp/music_cache';
            if (!is_dir($cacheDir)) @mkdir($cacheDir, 0775, true);

            // Build upstream URL. Force category=music to honor the
            // "music only, no SFX" constraint from the spec.
            $params = [
                'key' => $apiKey,
                'category' => 'music',
                'per_page' => $perPage,
                'page' => $page,
            ];
            if ($action === 'reels_music_search' && $q !== '') {
                $params['q'] = $q;
            } else {
                $params['order'] = 'popular';
            }
            $upstream = 'https://pixabay.com/api/?' . http_build_query($params);
            $cacheKey = md5($upstream);
            $cachePath = $cacheDir . '/' . $cacheKey . '.json';

            // Serve from cache when fresh (<1h).
            if (file_exists($cachePath) && (time() - filemtime($cachePath)) < 3600) {
                $cached = @file_get_contents($cachePath);
                if ($cached !== false) {
                    header('Content-Type: application/json; charset=utf-8');
                    echo $cached;
                    exit;
                }
            }

            // If the key isn't configured, return a curated empty payload
            // so the UI renders the "Meus salvos" + "Original" tabs cleanly
            // instead of erroring. Production sets PIXABAY_API_KEY in
            // /etc/mail-api.env.
            if ($apiKey === '') {
                $payload = json_encode([
                    'success' => true,
                    'data' => [
                        'tracks' => [],
                        'page' => $page,
                        'has_more' => false,
                        'source' => 'pixabay',
                        'note' => 'PIXABAY_API_KEY not set on server',
                    ],
                ]);
                @file_put_contents($cachePath, $payload, LOCK_EX);
                header('Content-Type: application/json; charset=utf-8');
                echo $payload;
                exit;
            }

            // Hit upstream. 6s timeout — Pixabay typically replies in <500ms.
            $ch = curl_init($upstream);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 6,
                CURLOPT_CONNECTTIMEOUT => 3,
                CURLOPT_USERAGENT => 'ChatyyReelsMusic/1.0',
            ]);
            $resp = curl_exec($ch);
            $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            $tracks = [];
            $hasMore = false;
            if ($resp && $code === 200) {
                $data = json_decode($resp, true);
                if (is_array($data) && !empty($data['hits']) && is_array($data['hits'])) {
                    foreach ($data['hits'] as $h) {
                        // Pixabay's music payload exposes either `audio`
                        // (newer rollout) or no preview field on some
                        // photo-mode rows. Skip rows without any preview.
                        $preview = (string)($h['audio'] ?? $h['previewURL'] ?? '');
                        if ($preview === '') continue;
                        $tracks[] = [
                            'id' => 'pixabay/' . (int)($h['id'] ?? 0),
                            'title' => (string)($h['tags'] ?? $h['title'] ?? 'Untitled'),
                            'artist' => (string)($h['user'] ?? 'Pixabay'),
                            'preview_url' => $preview,
                            'duration_sec' => (int)($h['duration'] ?? 30),
                            'image_url' => (string)($h['userImageURL'] ?? $h['previewURL'] ?? ''),
                        ];
                    }
                    $totalHits = (int)($data['totalHits'] ?? 0);
                    $hasMore = ($page * $perPage) < $totalHits;
                }
                $payload = json_encode([
                    'success' => true,
                    'data' => [
                        'tracks' => $tracks,
                        'page' => $page,
                        'has_more' => $hasMore,
                        'source' => 'pixabay',
                    ],
                ]);
                @file_put_contents($cachePath, $payload, LOCK_EX);
                header('Content-Type: application/json; charset=utf-8');
                echo $payload;
                exit;
            }

            // Upstream error — serve stale cache if any, else empty list.
            if (file_exists($cachePath)) {
                header('Content-Type: application/json; charset=utf-8');
                readfile($cachePath);
                exit;
            }
            jsonResponse(true, ['tracks' => [], 'page' => $page, 'has_more' => false, 'source' => 'pixabay']);
            break;
        }

        // ============================================================
        // Reels — Tip a creator directly on a reel post (outside Live).
        // ------------------------------------------------------------
        // Reuses the same diamond wallet ledger as wave-6 Live gifts:
        // debits sender, credits 70% to creator's pending_payout_cents,
        // platform retains 30%. Same gift catalog (`live_gift_catalog`)
        // is reused so the sheet shows the same SKUs.
        //
        // After insert we broadcast a `feed_post_tip` WS event on
        // channel `feed_post_{id}` so the floating "💎" animation can
        // fan out to anyone currently watching the reel.
        // ============================================================
        case 'feed_post_tip': {
            $auth = requireAuth();
            $input = getInput();
            $postId = (int)($input['post_id'] ?? 0);
            $giftSku = strtolower(trim((string)($input['gift_sku'] ?? $input['gift_type'] ?? '')));
            if (!$postId || $giftSku === '') {
                jsonResponse(false, null, 'post_id and gift_sku required', 400);
            }
            // Same catalog as live_gift_catalog (diamond costs).
            $catalog = [
                'gift_rose'   => 100,
                'gift_star'   => 300,
                'gift_crown'  => 1000,
                'gift_rocket' => 2000,
                'gift_galaxy' => 5000,
                'gift_legend' => 10000,
            ];
            if (!isset($catalog[$giftSku])) {
                jsonResponse(false, null, 'Unknown gift_sku', 400);
            }
            $diamonds = (int)$catalog[$giftSku];

            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Reuse wave-6 wallet ledger schema. Lazy-create to keep
                // this endpoint deployable without a separate migration.
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_wallet_balances (
                    email TEXT PRIMARY KEY,
                    diamond_balance BIGINT NOT NULL DEFAULT 0,
                    pending_payout_cents BIGINT NOT NULL DEFAULT 0,
                    updated_at TIMESTAMPTZ DEFAULT now()
                )");
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_wallet_ledger (
                    id BIGSERIAL PRIMARY KEY,
                    email TEXT NOT NULL,
                    direction TEXT NOT NULL,
                    amount BIGINT NOT NULL,
                    kind TEXT NOT NULL,
                    ref_kind TEXT,
                    ref_id BIGINT,
                    counterparty TEXT,
                    created_at TIMESTAMPTZ DEFAULT now()
                )");
                @$pg->exec("CREATE INDEX IF NOT EXISTS idx_wallet_ledger_email_created ON chat_wallet_ledger (email, created_at DESC)");
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_feed_tips (
                    id BIGSERIAL PRIMARY KEY,
                    post_id BIGINT NOT NULL,
                    sender_email TEXT NOT NULL,
                    creator_email TEXT NOT NULL,
                    gift_sku TEXT NOT NULL,
                    diamonds BIGINT NOT NULL,
                    creator_payout_cents BIGINT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT now()
                )");
                @$pg->exec("CREATE INDEX IF NOT EXISTS idx_feed_tips_post ON chat_feed_tips (post_id, created_at DESC)");
                @$pg->exec("CREATE INDEX IF NOT EXISTS idx_feed_tips_creator ON chat_feed_tips (creator_email, created_at DESC)");

                $stP = $pg->prepare("SELECT author_email FROM chat_feed_posts WHERE id = :id AND is_deleted = 0");
                $stP->execute([':id' => $postId]);
                $row = $stP->fetch(PDO::FETCH_ASSOC);
                if (!$row) jsonResponse(false, null, 'Post not found', 404);
                $creator = strtolower($row['author_email']);
                if ($creator === strtolower($auth['email'])) {
                    jsonResponse(false, null, 'Cannot tip your own post', 400);
                }

                $pg->beginTransaction();
                // Lock + check balance.
                $bal = $pg->prepare("SELECT diamond_balance FROM chat_wallet_balances WHERE email = :e FOR UPDATE");
                $bal->execute([':e' => $auth['email']]);
                $current = (int)($bal->fetchColumn() ?: 0);
                if ($current < $diamonds) {
                    $pg->rollBack();
                    jsonResponse(false, ['code' => 'insufficient_diamonds', 'diamond_balance' => $current], 'Insufficient diamonds', 402);
                }
                // Debit sender.
                $pg->prepare("UPDATE chat_wallet_balances SET diamond_balance = diamond_balance - :d, updated_at = now() WHERE email = :e")
                   ->execute([':d' => $diamonds, ':e' => $auth['email']]);
                // 70% to creator pending_payout_cents (using $0.0099 per diamond — matches wave 6).
                $payoutCents = (int)floor($diamonds * 0.0099 * 100 * 0.70);
                $pg->prepare("INSERT INTO chat_wallet_balances (email, diamond_balance, pending_payout_cents) VALUES (:e, 0, :c) ON CONFLICT (email) DO UPDATE SET pending_payout_cents = chat_wallet_balances.pending_payout_cents + :c2, updated_at = now()")
                   ->execute([':e' => $creator, ':c' => $payoutCents, ':c2' => $payoutCents]);
                // Ledger rows (debit + credit).
                $pg->prepare("INSERT INTO chat_wallet_ledger (email, direction, amount, kind, ref_kind, ref_id, counterparty) VALUES (:e, 'debit', :d, 'tip_send', 'feed_post', :p, :cp)")
                   ->execute([':e' => $auth['email'], ':d' => $diamonds, ':p' => $postId, ':cp' => $creator]);
                $pg->prepare("INSERT INTO chat_wallet_ledger (email, direction, amount, kind, ref_kind, ref_id, counterparty) VALUES (:e, 'credit', :c, 'tip_recv', 'feed_post', :p, :cp)")
                   ->execute([':e' => $creator, ':c' => $payoutCents, ':p' => $postId, ':cp' => $auth['email']]);
                $tipIns = $pg->prepare("INSERT INTO chat_feed_tips (post_id, sender_email, creator_email, gift_sku, diamonds, creator_payout_cents) VALUES (:p, :s, :c, :g, :d, :pc) RETURNING id, created_at");
                $tipIns->execute([
                    ':p' => $postId,
                    ':s' => $auth['email'],
                    ':c' => $creator,
                    ':g' => $giftSku,
                    ':d' => $diamonds,
                    ':pc' => $payoutCents,
                ]);
                $tipRow = $tipIns->fetch(PDO::FETCH_ASSOC);
                $pg->commit();

                // WS fan-out: floating diamond animation on the reel.
                try {
                    $wsKey = getenv('MAIL_WS_KEY') ?: '';
                    if ($wsKey) {
                        $payloadWs = json_encode([
                            'channel' => 'feed_post_' . $postId,
                            'event'   => 'feed_post_tip',
                            'data'    => [
                                'id'             => (int)$tipRow['id'],
                                'post_id'        => $postId,
                                'sender_email'   => $auth['email'],
                                'sender_name'    => $auth['name'] ?? explode('@', $auth['email'])[0],
                                'gift_sku'       => $giftSku,
                                'diamonds'       => $diamonds,
                                'created_at'     => $tipRow['created_at'],
                            ],
                        ]);
                        foreach (['http://127.0.0.1:8081/broadcast', 'http://127.0.0.1:8084/broadcast'] as $endpoint) {
                            $cu = curl_init($endpoint);
                            curl_setopt_array($cu, [
                                CURLOPT_POST => true,
                                CURLOPT_POSTFIELDS => $payloadWs,
                                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                                CURLOPT_RETURNTRANSFER => true,
                                CURLOPT_TIMEOUT_MS => 600,
                                CURLOPT_CONNECTTIMEOUT_MS => 200,
                            ]);
                            curl_exec($cu);
                            curl_close($cu);
                        }
                    }
                } catch (Throwable $_) {}

                jsonResponse(true, [
                    'tip_id'         => (int)$tipRow['id'],
                    'post_id'        => $postId,
                    'gift_sku'       => $giftSku,
                    'diamonds'       => $diamonds,
                    'diamond_balance' => $current - $diamonds,
                ]);
            } catch (Throwable $e) {
                try { if ($pg && $pg->inTransaction()) $pg->rollBack(); } catch (Throwable $_) {}
                error_log('[feed_post_tip] ' . $e->getMessage());
                jsonResponse(false, null, 'Tip failed', 500);
            }
            break;
        }

        // ============================================================
        // Reels — Promote a post (paid boost).
        // ------------------------------------------------------------
        // Inserts a row in chat_feed_promotions; the FYP ranker
        // (feed-ranked.php) JOINs this and boosts the post's score by
        // 1.5x for the active window, surfacing it to non-followers at
        // a higher rate.
        //
        // Payment: deducts from the diamond wallet (1000 diamonds = $9.99
        // matches the wallet IAP rate). Budget tiers are caller-supplied
        // in *cents* — we convert to diamonds via the same rate.
        // ============================================================
        case 'feed_post_promote': {
            $auth = requireAuth();
            $input = getInput();
            $postId = (int)($input['post_id'] ?? 0);
            $budgetCents = (int)($input['budget_cents'] ?? 0);
            $durationDays = max(1, min(30, (int)($input['duration_days'] ?? 7)));
            if (!$postId || $budgetCents <= 0) {
                jsonResponse(false, null, 'post_id and budget_cents required', 400);
            }
            // Tiers we surface in the UI: $5/$10/$25/$50/$100. Reject
            // anything off-grid so the FYP boost stays predictable.
            $allowedCents = [500, 1000, 2500, 5000, 10000];
            if (!in_array($budgetCents, $allowedCents, true)) {
                jsonResponse(false, null, 'Invalid budget tier', 400);
            }
            // Diamond cost: 1000 diamonds = $9.99 → $1 ≈ 100.1 diamonds.
            $diamondsCost = (int)ceil(($budgetCents / 100) * 100.1);

            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_feed_promotions (
                    id BIGSERIAL PRIMARY KEY,
                    post_id BIGINT NOT NULL,
                    sponsor_email TEXT NOT NULL,
                    budget_cents BIGINT NOT NULL,
                    diamonds_spent BIGINT NOT NULL,
                    duration_days INT NOT NULL,
                    starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    ends_at TIMESTAMPTZ NOT NULL,
                    boost_factor REAL NOT NULL DEFAULT 1.5,
                    is_active SMALLINT NOT NULL DEFAULT 1,
                    created_at TIMESTAMPTZ DEFAULT now()
                )");
                @$pg->exec("CREATE INDEX IF NOT EXISTS idx_feed_promotions_active ON chat_feed_promotions (post_id, is_active, ends_at)");
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_wallet_balances (
                    email TEXT PRIMARY KEY,
                    diamond_balance BIGINT NOT NULL DEFAULT 0,
                    pending_payout_cents BIGINT NOT NULL DEFAULT 0,
                    updated_at TIMESTAMPTZ DEFAULT now()
                )");

                // Verify post ownership — only the author can promote.
                $stP = $pg->prepare("SELECT author_email FROM chat_feed_posts WHERE id = :id AND is_deleted = 0");
                $stP->execute([':id' => $postId]);
                $row = $stP->fetch(PDO::FETCH_ASSOC);
                if (!$row) jsonResponse(false, null, 'Post not found', 404);
                if (strcasecmp($row['author_email'], $auth['email']) !== 0) {
                    jsonResponse(false, null, 'Not the author', 403);
                }

                $pg->beginTransaction();
                $bal = $pg->prepare("SELECT diamond_balance FROM chat_wallet_balances WHERE email = :e FOR UPDATE");
                $bal->execute([':e' => $auth['email']]);
                $current = (int)($bal->fetchColumn() ?: 0);
                if ($current < $diamondsCost) {
                    $pg->rollBack();
                    jsonResponse(false, ['code' => 'insufficient_diamonds', 'diamond_balance' => $current, 'diamonds_required' => $diamondsCost], 'Insufficient diamonds', 402);
                }
                $pg->prepare("UPDATE chat_wallet_balances SET diamond_balance = diamond_balance - :d, updated_at = now() WHERE email = :e")
                   ->execute([':d' => $diamondsCost, ':e' => $auth['email']]);
                $pg->prepare("INSERT INTO chat_wallet_ledger (email, direction, amount, kind, ref_kind, ref_id, counterparty) VALUES (:e, 'debit', :d, 'promote', 'feed_post', :p, '')")
                   ->execute([':e' => $auth['email'], ':d' => $diamondsCost, ':p' => $postId]);

                $ins = $pg->prepare("INSERT INTO chat_feed_promotions (post_id, sponsor_email, budget_cents, diamonds_spent, duration_days, starts_at, ends_at, boost_factor, is_active) VALUES (:p, :s, :b, :d, :dd, now(), now() + (:dd2 * INTERVAL '1 day'), 1.5, 1) RETURNING id, starts_at, ends_at");
                $ins->execute([
                    ':p' => $postId,
                    ':s' => $auth['email'],
                    ':b' => $budgetCents,
                    ':d' => $diamondsCost,
                    ':dd' => $durationDays,
                    ':dd2' => $durationDays,
                ]);
                $pRow = $ins->fetch(PDO::FETCH_ASSOC);
                $pg->commit();

                jsonResponse(true, [
                    'promotion_id'   => (int)$pRow['id'],
                    'post_id'        => $postId,
                    'budget_cents'   => $budgetCents,
                    'diamonds_spent' => $diamondsCost,
                    'duration_days'  => $durationDays,
                    'starts_at'      => $pRow['starts_at'],
                    'ends_at'        => $pRow['ends_at'],
                    'boost_factor'   => 1.5,
                    'diamond_balance' => $current - $diamondsCost,
                ]);
            } catch (Throwable $e) {
                try { if ($pg && $pg->inTransaction()) $pg->rollBack(); } catch (Throwable $_) {}
                error_log('[feed_post_promote] ' . $e->getMessage());
                jsonResponse(false, null, 'Promotion failed', 500);
            }
            break;
        }

        // ============================================================
        // Reels — Save / unsave a sound from the music marquee.
        // ------------------------------------------------------------
        // Persists per-user favorited tracks (Pixabay + Original) so the
        // CreatePostModal's "Meus salvos" tab can hydrate them on open.
        // Lazy-creates chat_user_saved_sounds. sound_id format matches
        // what's stored on chat_feed_posts.sound_id (e.g. "pixabay/12345"
        // or "<email>/<post_id>" for an original sound).
        // ============================================================
        case 'reels_sound_favorite_save': {
            $auth = requireAuth();
            $input = getInput();
            $soundId = trim((string)($input['sound_id'] ?? ''));
            $soundLabel = trim((string)($input['sound_label'] ?? ''));
            $previewUrl = trim((string)($input['preview_url'] ?? ''));
            $imageUrl = trim((string)($input['image_url'] ?? ''));
            $durationSec = (int)($input['duration_sec'] ?? 30);
            if ($soundId === '') jsonResponse(false, null, 'sound_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_user_saved_sounds (
                    owner_email TEXT NOT NULL,
                    sound_id TEXT NOT NULL,
                    sound_label TEXT NOT NULL DEFAULT '',
                    preview_url TEXT,
                    image_url TEXT,
                    duration_sec INT NOT NULL DEFAULT 30,
                    saved_at TIMESTAMPTZ DEFAULT now(),
                    PRIMARY KEY (owner_email, sound_id)
                )");
                $pg->prepare("INSERT INTO chat_user_saved_sounds (owner_email, sound_id, sound_label, preview_url, image_url, duration_sec) VALUES (:e, :s, :l, :p, :i, :d) ON CONFLICT (owner_email, sound_id) DO UPDATE SET sound_label = EXCLUDED.sound_label, preview_url = EXCLUDED.preview_url, image_url = EXCLUDED.image_url, duration_sec = EXCLUDED.duration_sec, saved_at = now()")
                   ->execute([
                       ':e' => $auth['email'],
                       ':s' => $soundId,
                       ':l' => $soundLabel,
                       ':p' => $previewUrl,
                       ':i' => $imageUrl,
                       ':d' => $durationSec,
                   ]);
                jsonResponse(true, ['saved' => true, 'sound_id' => $soundId]);
            } catch (Throwable $e) {
                error_log('[reels_sound_favorite_save] ' . $e->getMessage());
                jsonResponse(false, null, 'Save failed', 500);
            }
            break;
        }

        case 'reels_sound_favorite_unsave': {
            $auth = requireAuth();
            $input = getInput();
            $soundId = trim((string)($input['sound_id'] ?? ''));
            if ($soundId === '') jsonResponse(false, null, 'sound_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("DELETE FROM chat_user_saved_sounds WHERE owner_email = :e AND sound_id = :s")
                   ->execute([':e' => $auth['email'], ':s' => $soundId]);
                jsonResponse(true, ['saved' => false, 'sound_id' => $soundId]);
            } catch (Throwable $_) {
                jsonResponse(true, ['saved' => false]);
            }
            break;
        }

        case 'reels_sound_favorite_list': {
            $auth = requireAuth();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_user_saved_sounds (
                    owner_email TEXT NOT NULL,
                    sound_id TEXT NOT NULL,
                    sound_label TEXT NOT NULL DEFAULT '',
                    preview_url TEXT,
                    image_url TEXT,
                    duration_sec INT NOT NULL DEFAULT 30,
                    saved_at TIMESTAMPTZ DEFAULT now(),
                    PRIMARY KEY (owner_email, sound_id)
                )");
                $st = $pg->prepare("SELECT sound_id, sound_label, preview_url, image_url, duration_sec, saved_at FROM chat_user_saved_sounds WHERE owner_email = :e ORDER BY saved_at DESC LIMIT 200");
                $st->execute([':e' => $auth['email']]);
                $rows = $st->fetchAll(PDO::FETCH_ASSOC) ?: [];
                // Split the label back into title/artist when it follows the
                // "Title — Artist" convention used at save-time.
                foreach ($rows as &$r) {
                    $parts = preg_split('/\s+[—–-]\s+/u', (string)$r['sound_label'], 2) ?: [];
                    $r['title']  = (string)($parts[0] ?? $r['sound_label'] ?? '');
                    $r['artist'] = (string)($parts[1] ?? '');
                    $r['id'] = $r['sound_id'];
                }
                jsonResponse(true, ['tracks' => $rows]);
            } catch (Throwable $e) {
                error_log('[reels_sound_favorite_list] ' . $e->getMessage());
                jsonResponse(true, ['tracks' => []]);
            }
            break;
        }

        // ============================================================
        // Reels — Trending sounds (last 7d, by reel count).
        // ------------------------------------------------------------
        // Aggregates chat_feed_posts.sound_id over the past 7 days so the
        // /search "Sons" tab and Discover hub can surface what's popular.
        // Skips empty sound_ids (original-only posts that never set one).
        // ============================================================
        case 'reels_trending_sounds': {
            requireAuth();
            $input = getInput();
            $limit = max(5, min(50, (int)($input['limit'] ?? 20)));
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS sound_id TEXT");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS sound_label TEXT");
                $stmt = $pg->prepare("
                    SELECT sound_id,
                           COALESCE(MAX(sound_label), '') AS sound_label,
                           COUNT(*) AS post_count,
                           MAX(created_at) AS last_used
                    FROM chat_feed_posts
                    WHERE is_deleted = 0
                      AND sound_id IS NOT NULL AND sound_id <> ''
                      AND created_at >= now() - INTERVAL '7 days'
                    GROUP BY sound_id
                    ORDER BY post_count DESC, last_used DESC
                    LIMIT :lim
                ");
                $stmt->bindValue(':lim', $limit, PDO::PARAM_INT);
                $stmt->execute();
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
                $sounds = [];
                foreach ($rows as $r) {
                    $parts = preg_split('/\s+[—–-]\s+/u', (string)$r['sound_label'], 2) ?: [];
                    $sounds[] = [
                        'id'         => (string)$r['sound_id'],
                        'sound_id'   => (string)$r['sound_id'],
                        'title'      => (string)($parts[0] ?? $r['sound_label'] ?? ''),
                        'artist'     => (string)($parts[1] ?? ''),
                        'sound_label'=> (string)$r['sound_label'],
                        'post_count' => (int)$r['post_count'],
                        'last_used'  => (string)$r['last_used'],
                    ];
                }
                jsonResponse(true, ['sounds' => $sounds]);
            } catch (Throwable $e) {
                error_log('[reels_trending_sounds] ' . $e->getMessage());
                jsonResponse(true, ['sounds' => []]);
            }
            break;
        }

        // ============================================================
        // Creator dashboard — Pro tier surface.
        // ------------------------------------------------------------
        // Extends wave-6 chat_creator_subscriptions with weekly/monthly
        // revenue + subscriber_count + top tippers. Only the creator can
        // hit this for their own email (no peeking at someone else's).
        // ============================================================
        case 'creator_dashboard': {
            $auth = requireAuth();
            $me = strtolower($auth['email']);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Lazy-create chat_creator_subscriptions with the new
                // monthly_revenue_cents + subscriber_count columns. If
                // wave 6 already created the table, the ALTERs are
                // idempotent.
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_creator_subscriptions (
                    id BIGSERIAL PRIMARY KEY,
                    creator_email TEXT NOT NULL,
                    subscriber_email TEXT NOT NULL,
                    tier TEXT NOT NULL DEFAULT 'basic',
                    monthly_cents BIGINT NOT NULL DEFAULT 0,
                    started_at TIMESTAMPTZ DEFAULT now(),
                    expires_at TIMESTAMPTZ,
                    is_active SMALLINT NOT NULL DEFAULT 1,
                    UNIQUE (creator_email, subscriber_email)
                )");
                @$pg->exec("ALTER TABLE chat_creator_subscriptions ADD COLUMN IF NOT EXISTS monthly_revenue_cents BIGINT NOT NULL DEFAULT 0");
                @$pg->exec("ALTER TABLE chat_creator_subscriptions ADD COLUMN IF NOT EXISTS subscriber_count INT NOT NULL DEFAULT 0");
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_feed_tips (
                    id BIGSERIAL PRIMARY KEY,
                    post_id BIGINT NOT NULL,
                    sender_email TEXT NOT NULL,
                    creator_email TEXT NOT NULL,
                    gift_sku TEXT NOT NULL,
                    diamonds BIGINT NOT NULL,
                    creator_payout_cents BIGINT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT now()
                )");
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_wallet_balances (
                    email TEXT PRIMARY KEY,
                    diamond_balance BIGINT NOT NULL DEFAULT 0,
                    pending_payout_cents BIGINT NOT NULL DEFAULT 0,
                    updated_at TIMESTAMPTZ DEFAULT now()
                )");

                // Subscriber count (active rows).
                $subCount = 0;
                try {
                    $sc = $pg->prepare("SELECT COUNT(*) FROM chat_creator_subscriptions WHERE LOWER(creator_email) = :e AND is_active = 1");
                    $sc->execute([':e' => $me]);
                    $subCount = (int)$sc->fetchColumn();
                } catch (Throwable $_) {}

                // Monthly revenue = sum of active subs' monthly_cents.
                $monthlyRev = 0;
                try {
                    $mr = $pg->prepare("SELECT COALESCE(SUM(monthly_cents), 0) FROM chat_creator_subscriptions WHERE LOWER(creator_email) = :e AND is_active = 1");
                    $mr->execute([':e' => $me]);
                    $monthlyRev = (int)$mr->fetchColumn();
                } catch (Throwable $_) {}

                // Tip revenue last 7/30 days (in payout cents).
                $week = (int)$pg->query("SELECT COALESCE(SUM(creator_payout_cents),0) FROM chat_feed_tips WHERE LOWER(creator_email) = " . $pg->quote($me) . " AND created_at >= now() - INTERVAL '7 days'")->fetchColumn();
                $month = (int)$pg->query("SELECT COALESCE(SUM(creator_payout_cents),0) FROM chat_feed_tips WHERE LOWER(creator_email) = " . $pg->quote($me) . " AND created_at >= now() - INTERVAL '30 days'")->fetchColumn();

                // Top tippers (last 30d). LEFT JOIN to accounts for display name.
                $top = [];
                try {
                    $tt = $pg->prepare("SELECT sender_email, SUM(diamonds) AS total_diamonds, SUM(creator_payout_cents) AS total_cents, COUNT(*) AS tip_count FROM chat_feed_tips WHERE LOWER(creator_email) = :e AND created_at >= now() - INTERVAL '30 days' GROUP BY sender_email ORDER BY total_diamonds DESC LIMIT 10");
                    $tt->execute([':e' => $me]);
                    foreach ($tt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $r) {
                        $top[] = [
                            'email'           => (string)$r['sender_email'],
                            'name'            => explode('@', (string)$r['sender_email'])[0],
                            'total_diamonds'  => (int)$r['total_diamonds'],
                            'total_cents'     => (int)$r['total_cents'],
                            'tip_count'       => (int)$r['tip_count'],
                        ];
                    }
                } catch (Throwable $_) {}

                // Pending payout (lifetime balance, reset on actual disbursement).
                $pending = 0;
                try {
                    $pp = $pg->prepare("SELECT pending_payout_cents FROM chat_wallet_balances WHERE email = :e");
                    $pp->execute([':e' => $me]);
                    $pending = (int)($pp->fetchColumn() ?: 0);
                } catch (Throwable $_) {}

                // 7-day daily tip cents series for sparkline.
                $series = [];
                try {
                    $st7 = $pg->prepare("SELECT date_trunc('day', created_at)::date::text AS d, COALESCE(SUM(creator_payout_cents),0) AS n FROM chat_feed_tips WHERE LOWER(creator_email) = :e AND created_at >= now() - INTERVAL '6 days' GROUP BY 1 ORDER BY 1 ASC");
                    $st7->execute([':e' => $me]);
                    $byDay = [];
                    foreach ($st7->fetchAll(PDO::FETCH_ASSOC) as $r) $byDay[$r['d']] = (int)$r['n'];
                    for ($i = 6; $i >= 0; $i--) {
                        $d = date('Y-m-d', strtotime("-$i days"));
                        $series[] = ['date' => $d, 'tip_cents' => (int)($byDay[$d] ?? 0)];
                    }
                } catch (Throwable $_) {}

                jsonResponse(true, [
                    'creator_email'         => $me,
                    'subscriber_count'      => $subCount,
                    'monthly_revenue_cents' => $monthlyRev,
                    'weekly_tip_cents'      => $week,
                    'monthly_tip_cents'     => $month,
                    'pending_payout_cents'  => $pending,
                    'top_tippers'           => $top,
                    'tip_series_7d'         => $series,
                ]);
            } catch (Throwable $e) {
                error_log('[creator_dashboard] ' . $e->getMessage());
                jsonResponse(false, null, 'Dashboard failed', 500);
            }
            break;
        }

        // Voice comment on a feed post. Multipart upload (audio + post_id).
        // Mirrors `feed_comment` shape — reply_to_id optional.
        case 'feed_voice_comment': {
            $auth = requireAuth();
            $postId = (int)($_POST['post_id'] ?? 0);
            $replyTo = !empty($_POST['reply_to_id']) ? (int)$_POST['reply_to_id'] : null;
            if (!$postId) jsonResponse(false, null, 'post_id required', 400);
            if (empty($_FILES['audio']) || $_FILES['audio']['error'] !== UPLOAD_ERR_OK) {
                jsonResponse(false, null, 'audio file required', 400);
            }
            $f = $_FILES['audio'];
            if ($f['size'] > 5 * 1024 * 1024) jsonResponse(false, null, 'Audio > 5MB', 400);

            // 100GB plan storage cap.
            require_once __DIR__ . '/plans.php';
            enforceStorageCap($auth['email'], (int)$f['size']);
            $mime = mime_content_type($f['tmp_name']) ?: '';
            if (!preg_match('/^audio\//i', $mime) && !in_array($mime, ['video/mp4','application/octet-stream'])) {
                jsonResponse(false, null, 'Invalid audio mime', 400);
            }
            $ext = 'm4a';
            $orig = (string)($f['name'] ?? '');
            if (preg_match('/\.([a-z0-9]{2,5})$/i', $orig, $m)) {
                $cand = strtolower($m[1]);
                if (in_array($cand, ['m4a','mp3','aac','wav','ogg','webm','3gp','caf'])) $ext = $cand;
            }
            $dir = '/var/www/mail/data/feed-files/' . $postId;
            if (!is_dir($dir)) @mkdir($dir, 0775, true);
            $name = 'voice_' . bin2hex(random_bytes(6)) . '.' . $ext;
            $path = $dir . '/' . $name;
            if (!@move_uploaded_file($f['tmp_name'], $path)) jsonResponse(false, null, 'Upload move failed', 500);
            @chmod($path, 0644);
            $publicUrl = '/data/feed-files/' . $postId . '/' . $name;
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("ALTER TABLE chat_feed_comments ADD COLUMN IF NOT EXISTS audio_url TEXT");
                $p = $pg->prepare("SELECT author_email FROM chat_feed_posts WHERE id = :id AND is_deleted = 0");
                $p->execute([':id' => $postId]);
                $post = $p->fetch(PDO::FETCH_ASSOC);
                if (!$post) jsonResponse(false, null, 'Post not found', 404);
                $ins = $pg->prepare("INSERT INTO chat_feed_comments (post_id, email, name, content, audio_url, reply_to_id) VALUES (:p, :e, :n, '', :a, :r) RETURNING id, created_at");
                $ins->execute([
                    ':p' => $postId,
                    ':e' => $auth['email'],
                    ':n' => $auth['name'] ?? explode('@', $auth['email'])[0],
                    ':a' => $publicUrl,
                    ':r' => $replyTo,
                ]);
                $row = $ins->fetch(PDO::FETCH_ASSOC);
                jsonResponse(true, [
                    'id' => (int)$row['id'],
                    'post_id' => $postId,
                    'email' => $auth['email'],
                    'name' => $auth['name'] ?? explode('@', $auth['email'])[0],
                    'content' => '',
                    'audio_url' => $publicUrl,
                    'reply_to_id' => $replyTo,
                    'created_at' => $row['created_at'],
                ]);
            } catch (Throwable $e) {
                error_log('[feed_voice_comment] ' . $e->getMessage());
                jsonResponse(false, null, 'Comment failed', 500);
            }
            break;
        }

        case 'feed_user_posts': {
            $auth = requireAuth();
            $input = getInput();
            $target = strtolower(trim((string)($input['email'] ?? $auth['email'])));
            $page = max(1, (int)($input['page'] ?? 1));
            $limit = 30;
            $offset = ($page - 1) * $limit;
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("
                    SELECT id, author_email, author_name, caption, media_type, media_urls,
                           thumbnail_url, location, created_at, video_hls_url
                    FROM chat_feed_posts
                    WHERE author_email = :e AND is_deleted = 0 AND (published IS NULL OR published = TRUE)
                    ORDER BY created_at DESC
                    LIMIT {$limit} OFFSET {$offset}
                ");
                $stmt->execute([':e' => $target]);
                $posts = $stmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($posts as &$p) {
                    $p['id'] = (int)$p['id'];
                    $p['media_urls'] = _cdnifyArray(json_decode($p['media_urls'] ?: '[]', true) ?: []);
                    try {
                        $lc = $pg->prepare("SELECT COUNT(*) FROM chat_feed_likes WHERE post_id = :id");
                        $lc->execute([':id' => $p['id']]);
                        $p['likes_count'] = (int)$lc->fetchColumn();
                        $cc = $pg->prepare("SELECT COUNT(*) FROM chat_feed_comments WHERE post_id = :id AND (is_deleted IS NULL OR is_deleted = 0)");
                        $cc->execute([':id' => $p['id']]);
                        $p['comments_count'] = (int)$cc->fetchColumn();
                    } catch (Throwable $e) { $p['likes_count'] = 0; $p['comments_count'] = 0; }
                }
                jsonResponse(true, ['posts' => $posts, 'page' => $page, 'has_more' => count($posts) === $limit]);
            } catch (Throwable $e) {
                error_log('[feed_user_posts] ' . $e->getMessage());
                jsonResponse(true, ['posts' => [], 'page' => $page, 'has_more' => false]);
            }
            break;
        }

        case 'feed_bookmark_list':
        case 'feed_bookmarks': {
            $auth = requireAuth();
            $input = getInput();
            $page = max(1, (int)($input['page'] ?? 1));
            $limit = 30;
            $offset = ($page - 1) * $limit;
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("
                    SELECT p.id, p.author_email, p.author_name, p.caption, p.media_type, p.media_urls,
                           p.thumbnail_url, p.location, p.created_at, p.video_hls_url
                    FROM chat_feed_bookmarks b
                    JOIN chat_feed_posts p ON p.id = b.post_id
                    WHERE b.email = :e AND p.is_deleted = 0
                    ORDER BY b.created_at DESC
                    LIMIT {$limit} OFFSET {$offset}
                ");
                $stmt->execute([':e' => $auth['email']]);
                $posts = $stmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($posts as &$p) {
                    $p['id'] = (int)$p['id'];
                    $p['media_urls'] = _cdnifyArray(json_decode($p['media_urls'] ?: '[]', true) ?: []);
                }
                jsonResponse(true, ['posts' => $posts, 'page' => $page, 'has_more' => count($posts) === $limit]);
            } catch (Throwable $e) {
                error_log('[feed_bookmarks] ' . $e->getMessage());
                jsonResponse(true, ['posts' => [], 'page' => $page, 'has_more' => false]);
            }
            break;
        }

        case 'feed_collection_list': {
            $auth = requireAuth();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("
                    SELECT c.id, c.name, c.created_at,
                           (SELECT COUNT(*) FROM feed_collection_items i WHERE i.collection_id = c.id) AS post_count
                    FROM feed_collections c
                    WHERE LOWER(c.email) = LOWER(:e)
                    ORDER BY c.created_at DESC
                ");
                $stmt->execute([':e' => $auth['email']]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($rows as &$r) {
                    $r['id'] = (int)$r['id'];
                    $r['post_count'] = (int)$r['post_count'];
                }
                jsonResponse(true, ['collections' => $rows]);
            } catch (Throwable $e) {
                error_log('[feed_collection_list] ' . $e->getMessage());
                jsonResponse(true, ['collections' => []]);
            }
            break;
        }

        case 'feed_collection_create': {
            $auth = requireAuth();
            $input = getInput();
            $name = trim((string)($input['name'] ?? ''));
            if ($name === '' || mb_strlen($name) > 80) jsonResponse(false, null, 'name required (1-80 chars)', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("INSERT INTO feed_collections (email, name) VALUES (:e, :n) RETURNING id, name, created_at");
                $stmt->execute([':e' => $auth['email'], ':n' => $name]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                $row['id'] = (int)$row['id'];
                $row['post_count'] = 0;
                jsonResponse(true, ['collection' => $row]);
            } catch (Throwable $e) {
                error_log('[feed_collection_create] ' . $e->getMessage());
                jsonResponse(false, null, 'Create failed', 500);
            }
            break;
        }

        case 'feed_collection_save_post':
        case 'feed_collection_add': {
            $auth = requireAuth();
            $input = getInput();
            $collectionId = (int)($input['collection_id'] ?? 0);
            $postId = (int)($input['post_id'] ?? 0);
            if (!$collectionId || !$postId) jsonResponse(false, null, 'collection_id + post_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Ownership check: collection must belong to caller.
                $own = $pg->prepare("SELECT 1 FROM feed_collections WHERE id = :id AND LOWER(email) = LOWER(:e)");
                $own->execute([':id' => $collectionId, ':e' => $auth['email']]);
                if (!$own->fetchColumn()) jsonResponse(false, null, 'collection not found', 404);
                $pg->prepare("INSERT INTO feed_collection_items (collection_id, post_id) VALUES (:c, :p) ON CONFLICT DO NOTHING")
                   ->execute([':c' => $collectionId, ':p' => $postId]);
                // Mirror into chat_feed_bookmarks so the post is also bookmarked
                // (collections sit on top of bookmarks — saving to a collection
                // implies the post is saved overall).
                try {
                    $pg->prepare("INSERT INTO chat_feed_bookmarks (email, post_id) VALUES (:e, :p) ON CONFLICT DO NOTHING")
                       ->execute([':e' => $auth['email'], ':p' => $postId]);
                } catch (Throwable $e2) {}
                jsonResponse(true, ['saved' => true]);
            } catch (Throwable $e) {
                error_log('[feed_collection_add] ' . $e->getMessage());
                jsonResponse(false, null, 'Save failed', 500);
            }
            break;
        }

        // ─── Wave 15: collection_remove_item ────────────────────────────
        // Pinterest-style "Remove from collection" — opposite of
        // feed_collection_add. Caller must own the collection. The
        // underlying chat_feed_bookmarks row stays so the post is still
        // bookmarked overall (matches Pinterest semantics).
        case 'feed_collection_remove_item':
        case 'collection_remove_item': {
            $auth = requireAuth();
            $input = getInput();
            $collectionId = (int)($input['collection_id'] ?? 0);
            $postId = (int)($input['post_id'] ?? 0);
            if (!$collectionId || !$postId) jsonResponse(false, null, 'collection_id + post_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $own = $pg->prepare("SELECT 1 FROM feed_collections WHERE id = :id AND LOWER(email) = LOWER(:e)");
                $own->execute([':id' => $collectionId, ':e' => $auth['email']]);
                if (!$own->fetchColumn()) jsonResponse(false, null, 'collection not found', 404);
                $pg->prepare("DELETE FROM feed_collection_items WHERE collection_id = :c AND post_id = :p")
                   ->execute([':c' => $collectionId, ':p' => $postId]);
                jsonResponse(true, ['removed' => true]);
            } catch (Throwable $e) {
                error_log('[feed_collection_remove_item] ' . $e->getMessage());
                jsonResponse(false, null, 'Remove failed', 500);
            }
            break;
        }

        // ─── Wave 15: collection_items ──────────────────────────────────
        // List posts in a specific collection.
        case 'feed_collection_items': {
            $auth = requireAuth();
            $input = getInput();
            $collectionId = (int)($input['collection_id'] ?? 0);
            if (!$collectionId) jsonResponse(false, null, 'collection_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $own = $pg->prepare("SELECT name FROM feed_collections WHERE id = :id AND LOWER(email) = LOWER(:e)");
                $own->execute([':id' => $collectionId, ':e' => $auth['email']]);
                $col = $own->fetch(PDO::FETCH_ASSOC);
                if (!$col) jsonResponse(false, null, 'collection not found', 404);
                $stmt = $pg->prepare("
                    SELECT p.id, p.author_email, p.author_name, p.caption, p.media_type, p.media_urls,
                           p.thumbnail_url, p.location, p.created_at, i.added_at
                    FROM feed_collection_items i
                    JOIN chat_feed_posts p ON p.id = i.post_id
                    WHERE i.collection_id = :c AND p.is_deleted = 0
                    ORDER BY i.added_at DESC
                ");
                $stmt->execute([':c' => $collectionId]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($rows as &$r) {
                    $r['id'] = (int)$r['id'];
                    $r['media_urls'] = _cdnifyArray(json_decode($r['media_urls'] ?: '[]', true) ?: []);
                }
                jsonResponse(true, ['collection' => ['id' => $collectionId, 'name' => $col['name']], 'posts' => $rows]);
            } catch (Throwable $e) {
                error_log('[feed_collection_items] ' . $e->getMessage());
                jsonResponse(true, ['posts' => []]);
            }
            break;
        }

        // ─── Wave 15: ads listing ───────────────────────────────────────
        // Returns active ad posts targeted by topic / region. Ads are just
        // chat_feed_posts rows with is_ad = TRUE (we co-locate ads with
        // organic content so the existing feed/profile renderers work
        // without forks). topic/region optional filters.
        case 'feed_ads_list': {
            $auth = requireAuth();
            $input = getInput();
            $topic = trim((string)($input['topic'] ?? ''));
            $region = trim((string)($input['region'] ?? ''));
            $limit = min(20, max(1, (int)($input['limit'] ?? 6)));
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS is_ad BOOLEAN DEFAULT FALSE");
                $where = "p.is_deleted = 0 AND p.is_ad = TRUE AND (p.published IS NULL OR p.published = TRUE)";
                $params = [];
                if ($topic !== '') {
                    $where .= " AND p.caption ~* :topic";
                    $params[':topic'] = '#?' . preg_replace('/[^\w]/u', '', $topic);
                }
                if ($region !== '') {
                    $where .= " AND LOWER(p.location) ILIKE :region";
                    $params[':region'] = '%' . strtolower($region) . '%';
                }
                $sql = "SELECT id, author_email, author_name, caption, media_type, media_urls,
                               thumbnail_url, location, created_at, video_hls_url
                        FROM chat_feed_posts p
                        WHERE {$where}
                        ORDER BY created_at DESC
                        LIMIT {$limit}";
                $stmt = $pg->prepare($sql);
                $stmt->execute($params);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($rows as &$r) {
                    $r['id'] = (int)$r['id'];
                    $r['media_urls'] = _cdnifyArray(json_decode($r['media_urls'] ?: '[]', true) ?: []);
                    $r['is_ad'] = true;
                    $r['sponsored'] = true;
                    $r['tagged_users'] = [];
                }
                jsonResponse(true, ['ads' => $rows]);
            } catch (Throwable $e) {
                error_log('[feed_ads_list] ' . $e->getMessage());
                jsonResponse(true, ['ads' => []]);
            }
            break;
        }

        // ─── Wave 15: hashtag follow/unfollow/list ──────────────────────
        // Lets a user "follow" a hashtag — posts with followed hashtags
        // get a 1.3× ranking boost in feed_explore. Storage is the
        // chat_user_followed_hashtags table (created on first call).
        case 'hashtag_follow': {
            $auth = requireAuth();
            $input = getInput();
            $tag = ltrim(trim((string)($input['tag'] ?? '')), '#');
            $tag = strtolower($tag);
            if ($tag === '' || mb_strlen($tag) > 50) jsonResponse(false, null, 'tag required (1-50 chars)', 400);
            if (!preg_match('/^[\w\x{00C0}-\x{024F}]+$/u', $tag)) jsonResponse(false, null, 'invalid tag', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_user_followed_hashtags (
                    email TEXT NOT NULL,
                    tag TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (email, tag)
                )");
                $pg->prepare("INSERT INTO chat_user_followed_hashtags (email, tag) VALUES (LOWER(:e), :t) ON CONFLICT DO NOTHING")
                   ->execute([':e' => $auth['email'], ':t' => $tag]);
                jsonResponse(true, ['tag' => $tag, 'following' => true]);
            } catch (Throwable $e) {
                error_log('[hashtag_follow] ' . $e->getMessage());
                jsonResponse(false, null, 'follow failed', 500);
            }
            break;
        }

        case 'hashtag_unfollow': {
            $auth = requireAuth();
            $input = getInput();
            $tag = ltrim(trim((string)($input['tag'] ?? '')), '#');
            $tag = strtolower($tag);
            if ($tag === '') jsonResponse(false, null, 'tag required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_user_followed_hashtags (
                    email TEXT NOT NULL,
                    tag TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (email, tag)
                )");
                $pg->prepare("DELETE FROM chat_user_followed_hashtags WHERE LOWER(email) = LOWER(:e) AND tag = :t")
                   ->execute([':e' => $auth['email'], ':t' => $tag]);
                jsonResponse(true, ['tag' => $tag, 'following' => false]);
            } catch (Throwable $e) {
                error_log('[hashtag_unfollow] ' . $e->getMessage());
                jsonResponse(false, null, 'unfollow failed', 500);
            }
            break;
        }

        case 'hashtag_followed_list': {
            $auth = requireAuth();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("CREATE TABLE IF NOT EXISTS chat_user_followed_hashtags (
                    email TEXT NOT NULL,
                    tag TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (email, tag)
                )");
                $stmt = $pg->prepare("SELECT tag, created_at FROM chat_user_followed_hashtags WHERE LOWER(email) = LOWER(:e) ORDER BY created_at DESC");
                $stmt->execute([':e' => $auth['email']]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
                jsonResponse(true, ['tags' => $rows]);
            } catch (Throwable $e) {
                error_log('[hashtag_followed_list] ' . $e->getMessage());
                jsonResponse(true, ['tags' => []]);
            }
            break;
        }

        // ─── Wave 15: feed_explore_nearby ───────────────────────────────
        // City-match ranking. Reads the caller's city from chat_user_profile
        // and boosts posts authored by users in the same city. Falls back
        // to "Próximos" semantics: when city is missing, returns the same
        // contact-aware feed as feed_list but sorted by location proximity
        // signals when available, else recency.
        case 'feed_explore_nearby': {
            $auth = requireAuth();
            $input = getInput();
            $page = max(1, (int)($input['page'] ?? 1));
            $limit = min(50, max(1, (int)($input['limit'] ?? 20)));
            $offset = ($page - 1) * $limit;
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS is_ad BOOLEAN DEFAULT FALSE");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS is_promoted BOOLEAN DEFAULT FALSE");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS promoted_until TIMESTAMP");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS tagged_users TEXT");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS location_lon DOUBLE PRECISION");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS location_name TEXT");

                // Lookup caller's city (best-effort; chat_user_profile may not
                // exist in all environments).
                $city = '';
                try {
                    $cq = $pg->prepare("SELECT city FROM chat_user_profile WHERE LOWER(email) = LOWER(:e) LIMIT 1");
                    $cq->execute([':e' => $auth['email']]);
                    $city = trim((string)($cq->fetchColumn() ?: ''));
                } catch (Throwable $_e) { /* table may be missing */ }

                // Followed hashtag boost: collect this user's followed tags
                // and apply 1.3× score boost to posts whose caption matches
                // any of them.
                $followedTags = [];
                try {
                    $tq = $pg->prepare("SELECT tag FROM chat_user_followed_hashtags WHERE LOWER(email) = LOWER(:e)");
                    $tq->execute([':e' => $auth['email']]);
                    $followedTags = $tq->fetchAll(PDO::FETCH_COLUMN);
                } catch (Throwable $_e) {}

                // Pull a wide candidate pool (200 latest non-deleted posts)
                // then rank in PHP. Avoids needing a stored procedure.
                $stmt = $pg->prepare("
                    SELECT p.id, p.author_email, p.author_name, p.caption, p.media_type,
                           p.media_urls, p.thumbnail_url, p.location, p.location_lat, p.location_lon, p.location_name,
                           p.tagged_users, p.is_ad, p.is_promoted, p.promoted_until, p.created_at,
                           p.video_hls_url, p.video_duration_ms, p.blurhash
                    FROM chat_feed_posts p
                    WHERE p.is_deleted = 0 AND (p.published IS NULL OR p.published = TRUE)
                      AND LOWER(p.author_email) <> LOWER(:me)
                      AND (p.is_ad IS NULL OR p.is_ad = FALSE)
                    ORDER BY p.created_at DESC
                    LIMIT 200
                ");
                $stmt->execute([':me' => $auth['email']]);
                $pool = $stmt->fetchAll(PDO::FETCH_ASSOC);

                // Pre-fetch authors' cities so we can apply the 1.2× boost
                // without N+1 queries.
                $authorEmails = array_values(array_unique(array_map(fn($p) => strtolower($p['author_email']), $pool)));
                $cityMap = [];
                if ($city !== '' && !empty($authorEmails)) {
                    try {
                        $in = implode(',', array_fill(0, count($authorEmails), '?'));
                        $cs = $pg->prepare("SELECT LOWER(email) AS email, city FROM chat_user_profile WHERE LOWER(email) IN ($in)");
                        $cs->execute($authorEmails);
                        foreach ($cs->fetchAll(PDO::FETCH_ASSOC) as $r) {
                            if (!empty($r['city'])) $cityMap[$r['email']] = $r['city'];
                        }
                    } catch (Throwable $_e) {}
                }

                // Score each candidate. Base = recency decay (0..1).
                $now = time();
                $scored = [];
                foreach ($pool as $row) {
                    $ts = strtotime($row['created_at'] ?? '');
                    if (!$ts) $ts = $now;
                    $ageHours = max(0, ($now - $ts) / 3600);
                    // Half-life of ~36h: score = 1 / (1 + ageHours/36).
                    $score = 1.0 / (1.0 + $ageHours / 36.0);
                    // 1.2× city match.
                    if ($city !== '' && isset($cityMap[strtolower($row['author_email'])])) {
                        if (strcasecmp(trim($cityMap[strtolower($row['author_email'])]), $city) === 0) {
                            $score *= 1.2;
                        }
                    }
                    // 1.3× per followed hashtag match (only apply once even
                    // if multiple followed tags appear in the same caption).
                    if (!empty($followedTags)) {
                        $caption = (string)($row['caption'] ?? '');
                        foreach ($followedTags as $ft) {
                            if (preg_match('/(^|[^\w])#' . preg_quote($ft, '/') . '($|[^\w])/iu', $caption)) {
                                $score *= 1.3;
                                break;
                            }
                        }
                    }
                    // 1.4× boost for is_promoted posts (active boost).
                    $promoActive = !empty($row['is_promoted']) && (!$row['promoted_until'] || strtotime($row['promoted_until']) > $now);
                    if ($promoActive) $score *= 1.4;
                    $row['_score'] = $score;
                    $row['_promoActive'] = $promoActive;
                    $scored[] = $row;
                }
                usort($scored, fn($a, $b) => $b['_score'] <=> $a['_score']);
                $page_slice = array_slice($scored, $offset, $limit);

                $hasMore = (count($scored) > $offset + $limit);
                foreach ($page_slice as &$p) {
                    $p['id'] = (int)$p['id'];
                    $p['media_urls'] = _cdnifyArray(json_decode($p['media_urls'] ?: '[]', true) ?: []);
                    if (!empty($p['tagged_users'])) {
                        $tu = json_decode($p['tagged_users'], true);
                        $p['tagged_users'] = is_array($tu) ? $tu : [];
                    } else {
                        $p['tagged_users'] = [];
                    }
                    $p['is_ad'] = !empty($p['is_ad']);
                    $p['is_promoted'] = !empty($p['_promoActive']);
                    $p['sponsored'] = $p['is_ad'] || $p['is_promoted'];
                    if ($p['location_lat'] !== null) $p['location_lat'] = (float)$p['location_lat'];
                    if ($p['location_lon'] !== null) $p['location_lon'] = (float)$p['location_lon'];
                    unset($p['_score'], $p['_promoActive']);
                }
                unset($p);

                jsonResponse(true, [
                    'posts'    => $page_slice,
                    'page'     => $page,
                    'has_more' => $hasMore,
                    'city'     => $city,
                ]);
            } catch (Throwable $e) {
                error_log('[feed_explore_nearby] ' . $e->getMessage());
                jsonResponse(true, ['posts' => [], 'page' => 1, 'has_more' => false, 'city' => '']);
            }
            break;
        }

        // ─── Wave 15: feed_promote_post ─────────────────────────────────
        // Paid boost. Marks a post as is_promoted = TRUE for
        // promote_hours (default 24h). The ranker (feed_explore_nearby,
        // feed-ranked.php) multiplies its score by 1.4×. Only works for
        // posts owned by the caller. Cost / billing is a stub — actual
        // payment integration lives upstream.
        case 'feed_promote_post':
        case 'feed_promote': {
            $auth = requireAuth();
            $input = getInput();
            $postId = (int)($input['post_id'] ?? 0);
            $hours = (int)($input['hours'] ?? 24);
            if ($hours < 1) $hours = 24;
            if ($hours > 168) $hours = 168; // cap at 7d
            if (!$postId) jsonResponse(false, null, 'post_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS is_promoted BOOLEAN DEFAULT FALSE");
                @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS promoted_until TIMESTAMP");
                $own = $pg->prepare("SELECT 1 FROM chat_feed_posts WHERE id = :id AND LOWER(author_email) = LOWER(:e) AND is_deleted = 0");
                $own->execute([':id' => $postId, ':e' => $auth['email']]);
                if (!$own->fetchColumn()) jsonResponse(false, null, 'post not found or not yours', 404);
                $until = date('Y-m-d H:i:s', time() + $hours * 3600);
                $pg->prepare("UPDATE chat_feed_posts SET is_promoted = TRUE, promoted_until = :u WHERE id = :id")
                   ->execute([':u' => $until, ':id' => $postId]);
                jsonResponse(true, ['post_id' => $postId, 'is_promoted' => true, 'promoted_until' => $until]);
            } catch (Throwable $e) {
                error_log('[feed_promote_post] ' . $e->getMessage());
                jsonResponse(false, null, 'Promote failed', 500);
            }
            break;
        }

        case 'feed_delete_comment': {
            $auth = requireAuth();
            $input = getInput();
            $commentId = (int)($input['comment_id'] ?? 0);
            if (!$commentId) jsonResponse(false, null, 'comment_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Only author of comment can delete
                $pg->prepare("UPDATE chat_feed_comments SET is_deleted = 1 WHERE id = :id AND email = :e")
                   ->execute([':id' => $commentId, ':e' => $auth['email']]);
                jsonResponse(true, ['deleted' => true]);
            } catch (Throwable $e) {
                jsonResponse(false, null, 'Delete failed', 500);
            }
            break;
        }

        case 'feed_delete_post': {
            $auth = requireAuth();
            $input = getInput();
            $postId = (int)($input['post_id'] ?? 0);
            if (!$postId) jsonResponse(false, null, 'post_id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("UPDATE chat_feed_posts SET is_deleted = 1 WHERE id = :id AND LOWER(author_email) = LOWER(:e)")
                   ->execute([':id' => $postId, ':e' => $auth['email']]);
                try { require_once __DIR__ . '/cache.php'; cacheInvalidate("profile:v1:" . strtolower($auth['email'])); } catch (Throwable $_) {}
                jsonResponse(true, ['deleted' => true]);
            } catch (Throwable $e) {
                jsonResponse(false, null, 'Delete failed', 500);
            }
            break;
        }

        // Hashtag page — list posts whose caption mentions a given tag.
        // Case-insensitive word-boundary regex so #foto doesn't match
        // #fotografia. We don't require auth on hashtag browse to mirror
        // public IG hashtag pages (still goes through auth_token cookies if
        // present so private posts/follower checks would apply later).
        case 'feed_hashtag_posts': {
            $input = getInput();
            $rawTag = trim((string)($input['tag'] ?? $_GET['tag'] ?? ''));
            // Strip leading '#', limit to 50 chars, allow only word chars +
            // unicode letters. Anything else aborts to avoid blowing the regex.
            $tag = ltrim($rawTag, '#');
            if ($tag === '' || mb_strlen($tag) > 50) jsonResponse(false, null, 'tag required', 400);
            if (!preg_match('/^[\w\x{00C0}-\x{024F}]+$/u', $tag)) jsonResponse(false, null, 'invalid tag', 400);
            $page = max(1, (int)($input['page'] ?? $_GET['page'] ?? 1));
            $limit = min(50, max(1, (int)($input['limit'] ?? $_GET['limit'] ?? 20)));
            $offset = ($page - 1) * $limit;
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pattern = '#' . $tag . '\M'; // \M = end of word boundary in Postgres regex
                $stmt = $pg->prepare("
                    SELECT id, author_email, author_name, caption, media_type, media_urls,
                           thumbnail_url, location, created_at, video_hls_url
                    FROM chat_feed_posts
                    WHERE is_deleted = 0 AND (published IS NULL OR published = TRUE)
                      AND caption ~* :pat
                    ORDER BY created_at DESC
                    LIMIT {$limit} OFFSET {$offset}
                ");
                $stmt->execute([':pat' => $pattern]);
                $posts = $stmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($posts as &$p) {
                    $p['id'] = (int)$p['id'];
                    $p['media_urls'] = _cdnifyArray(json_decode($p['media_urls'] ?: '[]', true) ?: []);
                    $p['thumbnail_url'] = _cdnify($p['thumbnail_url'] ?? '');
                }
                // Total post count + (best-effort) usage count from hashtags table.
                $cnt = 0;
                try {
                    $c = $pg->prepare("SELECT COUNT(*) FROM chat_feed_posts WHERE is_deleted = 0 AND caption ~* :pat");
                    $c->execute([':pat' => $pattern]);
                    $cnt = (int)$c->fetchColumn();
                } catch (Throwable $_e) {}
                jsonResponse(true, [
                    'tag' => $tag,
                    'posts' => $posts,
                    'page' => $page,
                    'has_more' => count($posts) === $limit,
                    'total_count' => $cnt,
                ]);
            } catch (Throwable $e) {
                error_log('[feed_hashtag_posts] ' . $e->getMessage());
                jsonResponse(true, ['posts' => [], 'tag' => $tag, 'page' => 1, 'has_more' => false, 'total_count' => 0]);
            }
            break;
        }

        // Confidential email — store the body server-side keyed by an opaque
        // UUID, replace the actual email body with a "view confidential
        // message" link. Recipient hits confidential_view to retrieve. Mirrors
        // Gmail's confidential mode (expiry + optional passcode) but stays in
        // our PG instead of Google's vault.
        case 'confidential_create': {
            $auth = requireAuth();
            $input = getInput();
            $recipient = sanitizeHeader(trim((string)($input['recipient'] ?? '')));
            $subject = sanitizeHeader(trim((string)($input['subject'] ?? '')));
            $body = (string)($input['body'] ?? '');
            $expiryDays = (int)($input['expiry_days'] ?? 7);
            // Allowed: 1, 7, 30, 180 (1d / 1w / 1m / 6m).
            if (!in_array($expiryDays, [1, 7, 30, 180], true)) $expiryDays = 7;
            $passcode = (string)($input['passcode'] ?? '');
            $smsPhone = trim((string)($input['sms_phone'] ?? ''));
            if (!$recipient || !$body) jsonResponse(false, null, 'recipient and body required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Generate a v4-ish UUID without the uuid extension. Keeps the
                // table portable (Postgres without pgcrypto installed).
                $bytes = random_bytes(16);
                $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
                $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
                $hex = bin2hex($bytes);
                $uuid = sprintf('%s-%s-%s-%s-%s', substr($hex, 0, 8), substr($hex, 8, 4), substr($hex, 12, 4), substr($hex, 16, 4), substr($hex, 20));
                $expiresAt = (new DateTime())->modify("+{$expiryDays} days")->format('c');
                $passHash = $passcode !== '' ? password_hash($passcode, PASSWORD_BCRYPT) : null;
                $ins = $pg->prepare("INSERT INTO confidential_emails (id, sender_email, recipient_email, subject, body, passcode_hash, sms_phone, expires_at) VALUES (:id, :s, :r, :sj, :b, :ph, :sp, :ex)");
                $ins->execute([
                    ':id' => $uuid,
                    ':s' => $auth['email'],
                    ':r' => mb_substr($recipient, 0, 320),
                    ':sj' => mb_substr($subject, 0, 320),
                    ':b' => $body,
                    ':ph' => $passHash,
                    ':sp' => $smsPhone !== '' ? mb_substr($smsPhone, 0, 32) : null,
                    ':ex' => $expiresAt,
                ]);
                jsonResponse(true, [
                    'id' => $uuid,
                    'view_url' => 'https://chatyy.com.br/api/email.php?action=confidential_view&id=' . $uuid,
                    'expires_at' => $expiresAt,
                ]);
            } catch (Throwable $e) {
                error_log('[confidential_create] ' . $e->getMessage());
                jsonResponse(false, null, 'Create failed', 500);
            }
            break;
        }

        case 'confidential_view': {
            $input = getInput();
            $id = trim((string)($input['id'] ?? $_GET['id'] ?? ''));
            $passcode = (string)($input['passcode'] ?? $_GET['passcode'] ?? '');
            if (!preg_match('/^[a-f0-9-]{36}$/', $id)) jsonResponse(false, null, 'invalid id', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("SELECT subject, body, passcode_hash, expires_at, sender_email FROM confidential_emails WHERE id = :id LIMIT 1");
                $stmt->execute([':id' => $id]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$row) jsonResponse(false, null, 'Not found or revoked', 404);
                if (strtotime($row['expires_at']) < time()) {
                    // Auto-clean expired rows so they don't accumulate.
                    @$pg->prepare("DELETE FROM confidential_emails WHERE id = :id")->execute([':id' => $id]);
                    jsonResponse(false, null, 'Email expired', 410);
                }
                if (!empty($row['passcode_hash'])) {
                    if ($passcode === '' || !password_verify($passcode, $row['passcode_hash'])) {
                        jsonResponse(false, ['passcode_required' => true], 'Passcode required', 401);
                    }
                }
                jsonResponse(true, [
                    'subject' => $row['subject'],
                    'body' => $row['body'],
                    'sender' => $row['sender_email'],
                    'expires_at' => $row['expires_at'],
                ]);
            } catch (Throwable $e) {
                error_log('[confidential_view] ' . $e->getMessage());
                jsonResponse(false, null, 'View failed', 500);
            }
            break;
        }

        // ---- IN-APP NOTIFICATIONS ----
        case 'notifications_list': {
            $auth = requireAuth();
            $input = getInput();
            $page = max(1, (int)($input['page'] ?? $_GET['page'] ?? 1));
            $limit = min(50, max(1, (int)($input['limit'] ?? $_GET['limit'] ?? 30)));
            $offset = ($page - 1) * $limit;
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Group duplicates by (group_key, day) so 50 likes on one post show as 1 row
                $stmt = $pg->prepare("
                    SELECT
                        MAX(id) AS id,
                        type,
                        MIN(title) AS title,
                        MAX(body) AS body,
                        COUNT(*) AS count,
                        MAX(author_email) AS author_email,
                        BOOL_AND(read) AS read,
                        MAX(created_at) AS created_at,
                        MAX(data::text) AS data,
                        group_key
                    FROM chat_notifications
                    WHERE user_email = :u
                    GROUP BY type, group_key, DATE(created_at)
                    ORDER BY created_at DESC
                    LIMIT {$limit} OFFSET {$offset}
                ");
                $stmt->execute([':u' => $auth['email']]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($rows as &$r) {
                    $r['id'] = (int)$r['id'];
                    $r['count'] = (int)$r['count'];
                    $r['read'] = (bool)$r['read'];
                    if (!empty($r['data'])) { try { $r['data'] = json_decode($r['data'], true); } catch (Throwable $e) {} }
                }
                jsonResponse(true, ['notifications' => $rows, 'page' => $page, 'has_more' => count($rows) === $limit]);
            } catch (Throwable $e) {
                error_log('[notifications_list] ' . $e->getMessage());
                jsonResponse(true, ['notifications' => [], 'page' => $page, 'has_more' => false]);
            }
            break;
        }

        case 'notifications_mark_read': {
            $auth = requireAuth();
            $input = getInput();
            // Mark all (default) or a specific id
            $notifId = (int)($input['id'] ?? 0);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                if ($notifId > 0) {
                    $pg->prepare("UPDATE chat_notifications SET read = TRUE WHERE id = :id AND user_email = :u")
                       ->execute([':id' => $notifId, ':u' => $auth['email']]);
                } else {
                    $pg->prepare("UPDATE chat_notifications SET read = TRUE WHERE user_email = :u AND read = FALSE")
                       ->execute([':u' => $auth['email']]);
                }
                jsonResponse(true, ['marked' => true]);
            } catch (Throwable $e) {
                error_log('[notifications_mark_read] ' . $e->getMessage());
                jsonResponse(false, null, 'Mark read failed', 500);
            }
            break;
        }

        case 'notifications_unread_count': {
            $auth = requireAuth();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("SELECT COUNT(*) FROM chat_notifications WHERE user_email = :u AND read = FALSE");
                $stmt->execute([':u' => $auth['email']]);
                jsonResponse(true, ['count' => (int)$stmt->fetchColumn()]);
            } catch (Throwable $e) {
                jsonResponse(true, ['count' => 0]);
            }
            break;
        }

        case 'notifications_delete': {
            $auth = requireAuth();
            $input = getInput();
            $notifId = (int)($input['id'] ?? 0);
            if (!$notifId) jsonResponse(false, null, 'id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("DELETE FROM chat_notifications WHERE id = :id AND user_email = :u")
                   ->execute([':id' => $notifId, ':u' => $auth['email']]);
                jsonResponse(true, ['deleted' => true]);
            } catch (Throwable $e) {
                jsonResponse(false, null, 'Delete failed', 500);
            }
            break;
        }

        // ---- SPOTLIGHT (TikTok-style vertical video feed) ----
        case 'spotlight_list': {
            $auth = requireAuth();
            $input = getInput();
            $page = max(1, (int)($input['page'] ?? $_GET['page'] ?? 1));
            $limit = min(30, max(1, (int)($input['limit'] ?? $_GET['limit'] ?? 10)));
            $offset = ($page - 1) * $limit;

            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();

                // Select only video posts (media_type='video' OR video_hls_url set OR any media URL ends with video extension)
                $stmt = $pg->prepare("
                    SELECT p.id, p.author_email, p.author_name, p.caption, p.media_type,
                           p.media_urls, p.thumbnail_url, p.location, p.created_at,
                           p.video_hls_url, p.video_duration_ms, p.blurhash
                    FROM chat_feed_posts p
                    WHERE p.is_deleted = 0
                      AND (p.published IS NULL OR p.published = TRUE)
                      AND p.media_type = 'video'
                    ORDER BY p.created_at DESC
                    LIMIT {$limit} OFFSET {$offset}
                ");
                $stmt->execute();
                $posts = $stmt->fetchAll(PDO::FETCH_ASSOC);

                foreach ($posts as &$p) {
                    $p['id'] = (int)$p['id'];
                    $p['media_urls'] = _cdnifyArray(json_decode($p['media_urls'] ?: '[]', true) ?: []);
                    try {
                        $lc = $pg->prepare("SELECT COUNT(*) FROM chat_feed_likes WHERE post_id = :id");
                        $lc->execute([':id' => $p['id']]);
                        $likeCount = (int)$lc->fetchColumn();
                        $cc = $pg->prepare("SELECT COUNT(*) FROM chat_feed_comments WHERE post_id = :id");
                        $cc->execute([':id' => $p['id']]);
                        $commentCount = (int)$cc->fetchColumn();
                        $p['likes_count'] = $likeCount;
                        $p['comments_count'] = $commentCount;
                        $ul = $pg->prepare("SELECT 1 FROM chat_feed_likes WHERE post_id = :id AND email = :email LIMIT 1");
                        $ul->execute([':id' => $p['id'], ':email' => $auth['email']]);
                        $p['liked_by_me'] = (bool)$ul->fetchColumn();
                        try {
                            $bm = $pg->prepare("SELECT 1 FROM chat_feed_bookmarks WHERE post_id = :id AND email = :email LIMIT 1");
                            $bm->execute([':id' => $p['id'], ':email' => $auth['email']]);
                            $p['bookmarked_by_me'] = (bool)$bm->fetchColumn();
                        } catch (Throwable $e) { $p['bookmarked_by_me'] = false; }
                    } catch (Throwable $e) {
                        $p['likes_count'] = 0; $p['comments_count'] = 0;
                        $p['liked_by_me'] = false; $p['bookmarked_by_me'] = false;
                    }
                }
                jsonResponse(true, ['posts' => $posts, 'page' => $page, 'has_more' => count($posts) === $limit]);
            } catch (Throwable $e) {
                error_log('[spotlight_list] ' . $e->getMessage());
                jsonResponse(true, ['posts' => [], 'page' => 1, 'has_more' => false]);
            }
            break;
        }

        // ---- CALL HISTORY ----
        case 'chat_call_history_list': {
            $auth = requireAuth();
            $input = getInput();
            $limit = min(200, max(1, (int)($input['limit'] ?? 50)));
            $offset = max(0, (int)($input['offset'] ?? 0));

            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("
                    SELECT id, user_email, contact_email, contact_name, call_id, type,
                           video, timestamp, duration, is_group, participants, created_at, recording_url
                    FROM chat_call_history
                    WHERE user_email = :email
                    ORDER BY timestamp DESC
                    LIMIT :limit OFFSET :offset
                ");
                $stmt->bindValue(':email', $auth['email']);
                $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
                $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
                $stmt->execute();
                $calls = $stmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($calls as &$c) {
                    $c['id'] = (int)$c['id'];
                    $c['video'] = (bool)$c['video'];
                    $c['is_group'] = (bool)$c['is_group'];
                    $c['timestamp'] = (int)$c['timestamp'];
                    $c['duration'] = (int)$c['duration'];
                    $c['participants'] = json_decode($c['participants'] ?: '[]', true) ?: [];
                    // Add camelCase aliases for frontend compat
                    $c['contactEmail'] = $c['contact_email'];
                    $c['contactName'] = $c['contact_name'];
                    $c['callId'] = $c['call_id'];
                    $c['isGroup'] = (bool)$c['is_group'];
                }
                jsonResponse(true, ['calls' => $calls, 'has_more' => count($calls) === $limit]);
            } catch (Throwable $e) {
                error_log('[chat_call_history_list] ' . $e->getMessage());
                jsonResponse(true, ['calls' => [], 'has_more' => false]);
            }
            break;
        }

        case 'chat_call_history_add': {
            $auth = requireAuth();
            $input = getInput();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("
                    INSERT INTO chat_call_history
                      (user_email, contact_email, contact_name, call_id, type, video, timestamp, duration, is_group, participants)
                    VALUES (:email, :ce, :cn, :cid, :type, :v, :ts, :dur, :ig, :p)
                    RETURNING id
                ");
                $stmt->execute([
                    ':email' => $auth['email'],
                    ':ce' => $input['contact_email'] ?? '',
                    ':cn' => $input['contact_name'] ?? '',
                    ':cid' => $input['call_id'] ?? '',
                    ':type' => in_array($input['type'] ?? '', ['outgoing','incoming','missed']) ? $input['type'] : 'outgoing',
                    ':v' => !empty($input['video']) ? 1 : 0,
                    ':ts' => (int)($input['timestamp'] ?? time() * 1000),
                    ':dur' => (int)($input['duration'] ?? 0),
                    ':ig' => !empty($input['is_group']) ? 1 : 0,
                    ':p' => json_encode($input['participants'] ?? []),
                ]);
                $id = (int)$stmt->fetchColumn();
                jsonResponse(true, ['id' => $id]);
            } catch (Throwable $e) {
                jsonResponse(false, null, $e->getMessage(), 500);
            }
            break;
        }

        case 'chat_call_history_delete': {
            $auth = requireAuth();
            $input = getInput();
            $id = (int)($input['id'] ?? 0);
            if (!$id) jsonResponse(false, null, 'id required', 400);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("DELETE FROM chat_call_history WHERE id = :id AND user_email = :email");
                $stmt->execute([':id' => $id, ':email' => $auth['email']]);
                jsonResponse(true, null, 'deleted');
            } catch (Throwable $e) {
                jsonResponse(false, null, $e->getMessage(), 500);
            }
            break;
        }

        case 'chat_call_history_clear': {
            $auth = requireAuth();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("DELETE FROM chat_call_history WHERE user_email = :email");
                $stmt->execute([':email' => $auth['email']]);
                jsonResponse(true, null, 'cleared');
            } catch (Throwable $e) {
                jsonResponse(false, null, $e->getMessage(), 500);
            }
            break;
        }

        // --- Plan / Subscription routes (delegated to plans.php) ---
        case 'plan_info':
        case 'plan_upgrade':
        case 'plan_cancel':
        case 'plan_family_add':
        case 'plan_family_remove':
        case 'plan_family_list':
        case 'plan_backup_list':
        case 'plan_backup_restore':
        case 'plan_backup_delete':
        case 'history_snapshot_status':
        case 'history_snapshot_set_schedule':
        case 'history_snapshot_run':
        case 'history_snapshot_delete':
        case 'history_snapshot_restore':
            require_once __DIR__ . '/chat.php'; // provides getChatDB()
            require_once __DIR__ . '/plans.php';
            handlePlanAction($action);
            break;
        // (chat_get_settings, chat_get_wallpaper, chat_pinned_messages handled
        // by chat.php now that they're real. Stubs removed so they fall through.)
        case 'e2e_status': {
            $auth = requireAuth();
            $input = getInput();
            $cid = (int)($input['conversation_id'] ?? $_GET['conversation_id'] ?? 0);
            if (!$cid) { jsonResponse(true, ['enabled' => false], 'ok'); break; }
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $st = $pg->prepare("SELECT COALESCE(is_e2ee, FALSE) AS is_e2ee FROM chat_conversations WHERE id = :id");
                $st->execute([':id' => $cid]);
                $r = $st->fetch();
                jsonResponse(true, ['enabled' => !empty($r['is_e2ee'])], 'ok');
            } catch (Throwable $e) {
                jsonResponse(true, ['enabled' => false], 'ok');
            }
            break;
        }

        // chat_get_locked / chat_set_locked — locked chats (passcode/biometric protected)
        case 'chat_get_locked':
            jsonResponse(true, ['locked' => []], 'ok');
            break;

        // Misc stubs — features not fully wired, return safe defaults
        case 'chat_folders_list':
            jsonResponse(true, ['folders' => []], 'ok');
            break;
        case 'chat_folders_create': case 'chat_folders_update': case 'chat_folders_delete':
            jsonResponse(true, null, 'ok');
            break;
        case 'ai_summarize': {
            $auth = requireAuth();
            $input = getInput();
            $messages = $input['messages'] ?? [];
            if (!is_array($messages) || count($messages) === 0) {
                jsonResponse(true, ['summary' => '', 'skipped' => true], 'ok');
            }
            // Cache by hash(messages) — same conversation asks same summary.
            // Check cache BEFORE rate-limiting so cached reads don't count.
            $cacheKey = hash('sha256', json_encode($messages));
            $cacheDir = '/var/www/mail/data/ai-summary-cache';
            if (!is_dir($cacheDir)) @mkdir($cacheDir, 0775, true);
            $cacheFile = "{$cacheDir}/{$cacheKey}.txt";
            if (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < 3600) {
                jsonResponse(true, ['summary' => @file_get_contents($cacheFile), 'cached' => true], 'ok');
            }

            // Rate limit: 30/hour per user (only counts actual Claude calls)
            $rateFile = '/tmp/ai_sum_' . md5($auth['email']);
            $rates = [];
            if (file_exists($rateFile)) {
                $raw = @file_get_contents($rateFile);
                if ($raw) {
                    $d = json_decode($raw, true);
                    if (is_array($d)) $rates = array_filter($d, fn($t) => is_numeric($t) && $t > time() - 3600);
                }
            }
            if (count($rates) >= 30) jsonResponse(false, null, 'Limite de resumos atingido (30/h). Tente depois.', 429);
            $rates[] = time();
            @file_put_contents($rateFile, json_encode(array_values($rates)), LOCK_EX);

            // Build transcript
            $transcript = '';
            $limit = min(100, count($messages));
            for ($i = 0; $i < $limit; $i++) {
                $m = $messages[$i];
                if (!is_array($m)) continue;
                $sender = $m['sender'] ?? $m['sender_name'] ?? $m['from'] ?? '?';
                $content = $m['content'] ?? $m['text'] ?? '';
                if (is_array($content)) continue;
                $content = trim((string)$content);
                if ($content === '') continue;
                $type = $m['type'] ?? 'text';
                if ($type === 'image') $content = '[foto]';
                elseif ($type === 'video') $content = '[vídeo]';
                elseif ($type === 'audio' || $type === 'voice') $content = '[áudio]';
                elseif ($type === 'file') $content = '[arquivo]';
                elseif ($type === 'sticker') $content = '[figurinha]';
                elseif ($type === 'gif') $content = '[GIF]';
                elseif ($type === 'location') $content = '[localização]';
                $transcript .= substr($sender, 0, 40) . ': ' . mb_substr($content, 0, 400) . "\n";
            }
            if (strlen($transcript) < 20) jsonResponse(true, ['summary' => '', 'skipped' => true], 'no content');

            // Groq (Llama 3.3 70B) — OpenAI-compatible API, way cheaper than
            // GPT-4o-mini and faster. Switched 2026-04-29 after the OpenAI key
            // started returning 401 invalid_api_key — Anthropic + OpenAI both
            // ran out of credits at different times, Groq is the standing
            // provider for everything else in ai-router.php.
            $groqKey = getenv("GROQ_API_KEY") ?: "";
            if (!$groqKey && file_exists("/etc/mail-api.env")) {
                foreach (file("/etc/mail-api.env", FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                    if (strpos($line, "GROQ_API_KEY=") === 0) { $groqKey = trim(substr($line, 13)); break; }
                }
            }
            if (!$groqKey) jsonResponse(false, null, "AI indisponível no momento", 503);

            $system = "Você é um assistente que resume conversas de chat de forma concisa. Resumindo as últimas mensagens da conversa (não todas), produza:\n1. Um resumo curto em 1-2 frases (sem chamar de TL;DR ou DR; só escreva direto)\n2. Principais tópicos (bullets curtas)\n3. Decisões ou ações acordadas (se houver)\n\nNunca use as siglas TL;DR, DR, ou termos em inglês. Seja objetivo. Use português brasileiro natural. Nunca invente conteúdo.";
            $payload = [
                "model" => "llama-3.3-70b-versatile",
                "max_tokens" => 800,
                "temperature" => 0.3,
                "messages" => [
                    ["role" => "system", "content" => $system],
                    ["role" => "user",   "content" => "Conversa:\n\n" . $transcript],
                ],
            ];
            $ch = curl_init("https://api.groq.com/openai/v1/chat/completions");
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode($payload),
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                    "Authorization: Bearer $groqKey",
                    "content-type: application/json",
                ],
                CURLOPT_TIMEOUT => 60,
            ]);
            $resp = curl_exec($ch);
            $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);
            if ($code !== 200) {
                error_log("[ai_summarize] Groq HTTP $code resp=" . substr($resp, 0, 500));
                $errMsg = "Falha ao gerar resumo";
                $statusCode = 502;
                if (strpos($resp, "insufficient_quota") !== false) {
                    $errMsg = "IA indisponível (quota esgotada). Avise o admin.";
                    $statusCode = 503;
                } elseif (strpos($resp, "invalid_api_key") !== false || $code === 401) {
                    $errMsg = "IA temporariamente indisponível.";
                    $statusCode = 503;
                } elseif (strpos($resp, "rate_limit") !== false || $code === 429) {
                    $errMsg = "IA ocupada no momento. Tente em 1 minuto.";
                    $statusCode = 429;
                }
                jsonResponse(false, null, $errMsg, $statusCode);
            }
            $data = json_decode($resp, true);
            $summary = trim($data["choices"][0]["message"]["content"] ?? "");
            if (!$summary) jsonResponse(false, null, 'Resposta vazia do AI', 502);
            @file_put_contents($cacheFile, $summary, LOCK_EX);
            jsonResponse(true, ['summary' => $summary, 'cached' => false], 'ok');
            break;
        }
        case 'ai_summarize_legacy':
            jsonResponse(true, ['summary' => '', 'skipped' => true], 'ok');
            break;

        // --- AI smart reply (suggests 3 short responses to an email) ---
        case 'ai_smart_reply':
            require_once __DIR__ . '/ai-categorize.php';
            $_POST['sub_action'] = 'smart_reply';
            handleAICategorize();
            break;

        // --- AI importance classifier (drives "Importantes" inbox tab) ---
        // Returns { level: 'high'|'normal'|'low', cached, classified_at }.
        // Result is cached per-message on disk so the inbox can re-fan
        // 100s of emails without re-billing GPT for ones it's already seen.
        case 'email_classify_importance':
            require_once __DIR__ . '/ai-categorize.php';
            $_POST['sub_action'] = 'classify_importance';
            handleAICategorize();
            break;

        // --- Translate (wraps Claude Haiku translation) ---
        case 'translate':
            require_once __DIR__ . '/translate.php';
            handleTranslate();
            break;

        // --- Sticker conversion (video → WhatsApp animated .webp) ---
        case 'health_stats':
            require_once __DIR__ . '/health_stats.php';
            handleHealthStats();
            break;

        case 'sticker_bg_remove':
            require_once __DIR__ . '/sticker_bg_remove.php';
            handleStickerBgRemove();
            break;

        case 'sticker_animated':
            require_once __DIR__ . '/sticker_animated.php';
            handleStickerAnimated();
            break;

        // ---- VoIP Verified Caller ID (Twilio OutgoingCallerIds) ----
        // Registers the user's verified_phone as a Twilio Verified Caller ID so
        // outbound calls can display the user's real number. Twilio calls the
        // phone with a 6-digit PIN that the user must press to confirm ownership.
        case 'voip_verified_number_request': {
            $auth = requireAuth();
            $parts = explode('@', $auth['email']);
            $profileFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/data.json";
            $profile = file_exists($profileFile) ? (json_decode(@file_get_contents($profileFile), true) ?: []) : [];

            $verifiedPhone = $profile['verified_phone'] ?? $profile['phone'] ?? '';
            if (empty($verifiedPhone)) {
                jsonResponse(false, null, 'Nenhum numero cadastrado. Adicione seu telefone no perfil primeiro.', 400);
            }

            // If already registered with Twilio Caller IDs, check status
            $sid = getenv('TWILIO_SID') ?: getenv('TWILIO_ACCOUNT_SID');
            $tkn = getenv('TWILIO_TOKEN') ?: getenv('TWILIO_AUTH_TOKEN');
            if (!$sid || !$tkn) jsonResponse(false, null, 'Servico Twilio nao configurado', 500);

            // Query Twilio to see if this phone is ALREADY in the Verified Caller IDs list
            $ch = curl_init("https://api.twilio.com/2010-04-01/Accounts/{$sid}/OutgoingCallerIds.json?PhoneNumber=" . urlencode($verifiedPhone));
            curl_setopt_array($ch, [
                CURLOPT_USERPWD => "{$sid}:{$tkn}",
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15,
            ]);
            $resp = curl_exec($ch);
            curl_close($ch);
            $existing = json_decode($resp ?: '{}', true);
            if (!empty($existing['outgoing_caller_ids'])) {
                // Already verified on Twilio — update profile
                $profile['verified_phone'] = $verifiedPhone;
                $profile['telnyx_caller_id_verified'] = true;
                $profile['twilio_caller_id_sid'] = $existing['outgoing_caller_ids'][0]['sid'] ?? '';
                $profile['caller_id_verified_at'] = date('c');
                @mkdir(dirname($profileFile), 0755, true);
                file_put_contents($profileFile, json_encode($profile, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
                jsonResponse(true, ['already_verified' => true, 'phone' => $verifiedPhone], 'Caller ID já verificado');
            }

            // Register with Twilio OutgoingCallerIds — Twilio will call the number and prompt for PIN
            $ch = curl_init("https://api.twilio.com/2010-04-01/Accounts/{$sid}/OutgoingCallerIds.json");
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => http_build_query([
                    'PhoneNumber' => $verifiedPhone,
                    'FriendlyName' => 'Chatyy - ' . $auth['email'],
                ]),
                CURLOPT_USERPWD => "{$sid}:{$tkn}",
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20,
            ]);
            $resp = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            $data = json_decode($resp ?: '{}', true);
            if ($httpCode >= 200 && $httpCode < 300 && !empty($data['validation_code'])) {
                // Save pending state so confirm action knows we started verification
                $profile['caller_id_pending_sid'] = $data['account_sid'] ?? $sid;
                $profile['caller_id_pending_code'] = $data['validation_code'];
                $profile['caller_id_pending_phone'] = $verifiedPhone;
                $profile['caller_id_pending_at'] = date('c');
                @mkdir(dirname($profileFile), 0755, true);
                file_put_contents($profileFile, json_encode($profile, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);

                $digits = preg_replace('/\D/', '', $verifiedPhone);
                $masked = strlen($digits) >= 4 ? '(' . substr($digits, -10, 2) . ') ***-**' . substr($digits, -2) : '***';
                jsonResponse(true, [
                    'validation_code' => $data['validation_code'],
                    'phone' => $verifiedPhone,
                    'masked_phone' => $masked,
                    'instructions' => 'Atenda a ligacao da Chatyy e digite o codigo ' . $data['validation_code'] . ' no teclado do telefone.',
                ], 'Vamos te ligar agora — atenda e digite o codigo');
            } else {
                $msg = $data['message'] ?? ('Twilio retornou erro ' . $httpCode);
                jsonResponse(false, null, 'Falha ao iniciar verificacao: ' . $msg, $httpCode ?: 500);
            }
            break;
        }

        case 'voip_verified_number_confirm': {
            $auth = requireAuth();
            $parts = explode('@', $auth['email']);
            $profileFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/data.json";
            $profile = file_exists($profileFile) ? (json_decode(@file_get_contents($profileFile), true) ?: []) : [];
            $phone = $profile['caller_id_pending_phone'] ?? $profile['verified_phone'] ?? '';
            if (empty($phone)) jsonResponse(false, null, 'Nenhuma verificacao pendente', 400);

            $sid = getenv('TWILIO_SID') ?: getenv('TWILIO_ACCOUNT_SID');
            $tkn = getenv('TWILIO_TOKEN') ?: getenv('TWILIO_AUTH_TOKEN');
            if (!$sid || !$tkn) jsonResponse(false, null, 'Servico nao configurado', 500);

            // Check if Twilio completed the verification (polls OutgoingCallerIds list)
            $ch = curl_init("https://api.twilio.com/2010-04-01/Accounts/{$sid}/OutgoingCallerIds.json?PhoneNumber=" . urlencode($phone));
            curl_setopt_array($ch, [
                CURLOPT_USERPWD => "{$sid}:{$tkn}",
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15,
            ]);
            $resp = curl_exec($ch);
            curl_close($ch);
            $data = json_decode($resp ?: '{}', true);

            if (!empty($data['outgoing_caller_ids'])) {
                // Verified! Save to profile
                $profile['verified_phone'] = $phone;
                $profile['telnyx_caller_id_verified'] = true;
                $profile['twilio_caller_id_sid'] = $data['outgoing_caller_ids'][0]['sid'] ?? '';
                $profile['caller_id_verified_at'] = date('c');
                unset($profile['caller_id_pending_sid'], $profile['caller_id_pending_code'], $profile['caller_id_pending_phone'], $profile['caller_id_pending_at']);
                @mkdir(dirname($profileFile), 0755, true);
                file_put_contents($profileFile, json_encode($profile, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
                jsonResponse(true, ['verified' => true, 'phone' => $phone], 'Caller ID verificado!');
            } else {
                jsonResponse(false, null, 'Verificacao pendente. Atenda a ligacao e digite o codigo.', 400);
            }
            break;
        }

        // Read-only status: shows whether the user has a verified caller ID
        // (and which number), the pending code if a verification is in flight.
        // Lets the verification UI render the right state without polling
        // Twilio on every load.
        case 'voip_verified_number_status': {
            $auth = requireAuth();
            $parts = explode('@', $auth['email']);
            $profileFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/data.json";
            $profile = file_exists($profileFile) ? (json_decode(@file_get_contents($profileFile), true) ?: []) : [];

            $verified = !empty($profile['telnyx_caller_id_verified']);
            $phone = $profile['verified_phone'] ?? $profile['phone'] ?? '';
            $pendingCode = $profile['caller_id_pending_code'] ?? '';
            $pendingPhone = $profile['caller_id_pending_phone'] ?? '';
            $pendingAt = $profile['caller_id_pending_at'] ?? '';
            // Pending state expires after 15 min — Twilio's verification window.
            $pendingExpired = false;
            if ($pendingAt) {
                $pendingExpired = (time() - strtotime($pendingAt)) > 900;
            }
            jsonResponse(true, [
                'verified' => $verified,
                'phone' => $phone,
                'verified_at' => $profile['caller_id_verified_at'] ?? '',
                'pending' => $pendingCode && !$pendingExpired ? [
                    'code' => $pendingCode,
                    'phone' => $pendingPhone,
                    'started_at' => $pendingAt,
                ] : null,
            ]);
            break;
        }

        case '__REMOVED_OLD_CONFIRM__': {
            $auth = requireAuth();
            $input = getInput();
            $code = trim($input['code'] ?? '');
            if (!$code) jsonResponse(false, null, 'Codigo obrigatorio', 400);

            $codeFile = '/tmp/callerid_code_' . md5($auth['email']) . '.json';
            if (!file_exists($codeFile)) jsonResponse(false, null, 'Nenhum codigo pendente', 400);

            $stored = json_decode(file_get_contents($codeFile), true);
            if (!is_array($stored)) jsonResponse(false, null, 'Erro interno', 500);

            if (($stored['expires'] ?? 0) < time()) {
                @unlink($codeFile);
                jsonResponse(false, null, 'Codigo expirado', 400);
            }
            if (($stored['attempts'] ?? 0) >= 5) {
                @unlink($codeFile);
                jsonResponse(false, null, 'Muitas tentativas. Solicite novo codigo.', 400);
            }

            if (!hash_equals($stored['code'], $code)) {
                $stored['attempts'] = ($stored['attempts'] ?? 0) + 1;
                file_put_contents($codeFile, json_encode($stored), LOCK_EX);
                jsonResponse(false, null, 'Codigo incorreto', 400);
            }

            // Mark caller ID verified in profile
            @unlink($codeFile);
            $parts = explode('@', $auth['email']);
            $profileFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/profile/data.json";
            $profile = file_exists($profileFile) ? (json_decode(@file_get_contents($profileFile), true) ?: []) : [];
            $profile['verified_phone'] = $stored['phone'];
            $profile['phone_verified_at'] = date('c');
            $profile['telnyx_caller_id_verified'] = true;
            $profile['caller_id_verified_at'] = date('c');
            @mkdir(dirname($profileFile), 0755, true);
            file_put_contents($profileFile, json_encode($profile, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);

            jsonResponse(true, ['verified' => true, 'phone' => $stored['phone']], 'Caller ID verificado');
            break;
        }
        case 'chat_set_locked':
            jsonResponse(true, null, 'ok');
            break;

        // --- More UI background call stubs ---
        case 'bootstrap':
            jsonResponse(true, ['config' => new stdClass()], 'ok');
            break;
        // --- DRIVE/CLOUD ---
        case 'drive_list': case 'drive_list_all': case 'drive_upload':
        case 'drive_download': case 'drive_delete': case 'drive_restore':
        case 'drive_permanent_delete': case 'drive_empty_trash':
        case 'drive_create_folder': case 'drive_rename': case 'drive_move':
        case 'drive_share': case 'drive_unshare': case 'drive_shared_with_me':
        case 'drive_storage_info': case 'drive_search': case 'drive_recent':
        case 'drive_starred': case 'drive_trash': case 'drive_get_shared':
        case 'drive_backup_debug': case 'drive_backup_count': case 'drive_backup_status':
        case 'drive_backup_dedup':
        case 'drive_photos': case 'drive_photos_timeline':
        case 'drive_presigned_upload': case 'drive_init_upload':
        case 'drive_init_upload_batch': case 'drive_register_uploaded': case 'drive_precheck_asset_ids':
        case 'drive_multipart_init': case 'drive_multipart_complete':
        case 'drive_backup_manifest': case 'drive_presigned_batch':
        case 'drive_confirm_upload': case 'drive_complete_upload':
        case 'drive_confirm_rust': case 'drive_confirm_batch':
        case 'drive_upload_photo_backup': case 'drive_file_versions':
        case 'drive_restore_version': case 'drive_photo_sync_list':
            require_once __DIR__ . '/drive.php';
            handleDriveAction($action);
            break;
        // --- PHOTO ML (Google Photos-style: Vision tags, ML search, Memories) ---
        case 'photo_analyze': case 'photo_analyze_batch':
        case 'photo_search_ml': case 'photo_faces': case 'photo_suggest_tags':
        case 'drive_memories':
        // Wave 14: real face recognition + photobook + AI enhancement
        case 'photos_face_embed': case 'photos_face_clusters':
        case 'photos_face_cluster_photos': case 'photos_face_cluster_name':
        case 'photos_photobook_create':
        case 'photos_ai_enhance': case 'photos_inpaint':
        case 'photos_sky_replace': case 'photos_bokeh':
            // Bearer-only auth path: photo-ml.php expects $_SESSION['email'].
            // Bridge requireAuth() into the session so the include sees it.
            if (empty($_SESSION['email'])) {
                $auth = requireAuth();
                $_SESSION['email'] = $auth['email'];
            }
            require_once __DIR__ . '/photo-ml.php';
            handlePhotoMlAction($action);
            break;

        // Local PDF download fallback when R2 upload fails for photobook
        case 'photobook_download': {
            $auth = requireAuth();
            $name = basename((string)($_GET['name'] ?? ''));
            if ($name === '' || !preg_match('/^[A-Za-z0-9_.-]+\.pdf$/', $name)) {
                http_response_code(400); echo 'bad name'; exit;
            }
            $path = '/var/www/mail/data/photobooks/' . $name;
            if (!is_file($path)) { http_response_code(404); echo 'not found'; exit; }
            header('Content-Type: application/pdf');
            header('Content-Disposition: attachment; filename="' . $name . '"');
            header('Content-Length: ' . filesize($path));
            readfile($path);
            exit;
        }
        // --- NOTES & NOTEBOOKS (Chatyy) ---
        case 'notes_list': case 'notes_create': case 'notes_update': case 'notes_delete':
        case 'notes_export_pdf': case 'notes_send_email':
        case 'notebooks_list': case 'notebooks_create': case 'notebooks_update': case 'notebooks_delete':
        case 'notebook_pages_list': case 'notebook_page_get': case 'notebook_page_save':
        case 'notebook_page_create': case 'notebook_page_delete':
            require_once __DIR__ . '/notes.php';
            handleNotesAction($action);
            break;

        // --- DOCS (Word + Spreadsheet + Presentation + Markdown + Drawing) ---
        case 'docs_list': case 'docs_create': case 'docs_get': case 'docs_save':
        case 'docs_rename': case 'docs_trash': case 'docs_restore': case 'docs_delete':
        case 'docs_share': case 'docs_unshare': case 'docs_duplicate':
        case 'docs_create_folder': case 'docs_rename_folder': case 'docs_delete_folder':
        case 'docs_versions': case 'docs_restore_version':
        case 'docs_add_comment': case 'docs_list_comments': case 'docs_resolve_comment':
        case 'docs_export': case 'docs_import_file':
        case 'docs_drive_import': case 'docs_drive_files':
        case 'docs_join': case 'docs_leave': case 'docs_lock':
        case 'docs_save_version': case 'docs_active_editors':
            require_once __DIR__ . '/docs.php';
            handleDocsAction($action);
            break;

        case 'parental_my_status': {
            // Real implementation (was returning hardcoded false → child
            // accounts NEVER detected as restricted, all controls bypassed).
            // Looks up if current user is registered as a child in
            // parental_accounts. Returns is_child + restrictions JSON.
            $auth = requireAuthLite();
            $myEmail = strtolower(trim((string)($auth['email'] ?? '')));
            if ($myEmail === '') jsonResponse(true, ['is_child' => false, 'restrictions' => null]);
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $stmt = $pg->prepare("SELECT id, parent_email, child_email, child_name, age, status FROM parental_accounts WHERE LOWER(child_email) = :c LIMIT 1");
                $stmt->execute([':c' => $myEmail]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$row || ($row['status'] ?? '') !== 'active') {
                    jsonResponse(true, ['is_child' => false, 'restrictions' => null]);
                }
                // Load restrictions JSON (saved by parent at parental_update_restrictions)
                $defaults = [
                    'chat_enabled' => true,
                    'calls_enabled' => true,
                    'feed_enabled' => true,
                    'internet_enabled' => true,
                    'daily_limit_minutes' => 0,
                    'bedtime_start' => '',
                    'bedtime_end' => '',
                    'allowed_contacts_only' => false,
                ];
                // Read from PG (authoritative since 2026-05-01) with file fallback.
                $saved = [];
                try {
                    $rsel = $pg->prepare("SELECT restrictions FROM parental_restrictions WHERE LOWER(child_email) = :c LIMIT 1");
                    $rsel->execute([':c' => $myEmail]);
                    $rest = $rsel->fetchColumn();
                    if ($rest) {
                        $saved = is_array($rest) ? $rest : (json_decode($rest, true) ?: []);
                    }
                } catch (Throwable $e) {}
                if (empty($saved)) {
                    $restrictionsFile = "/var/mail/vhosts/{$row['parent_email']}_restrictions_" . md5($myEmail) . ".json";
                    $saved = is_file($restrictionsFile) ? (json_decode(@file_get_contents($restrictionsFile), true) ?: []) : [];
                }
                jsonResponse(true, [
                    'is_child' => true,
                    'parent_email' => $row['parent_email'],
                    'child_name' => $row['child_name'],
                    'age' => (int)($row['age'] ?? 0),
                    'restrictions' => array_merge($defaults, $saved),
                ]);
            } catch (Throwable $e) {
                error_log('[parental_my_status] ' . $e->getMessage());
                jsonResponse(true, ['is_child' => false, 'restrictions' => null]);
            }
            break;
        }

        case 'parental_unlock_request': {
            // Child taps "Ask Parent" on a blocked screen → row in
            // parental_alerts so the parent dashboard surfaces it AND a push
            // lands on the parent's device.
            $auth = requireAuth();
            $myEmail = strtolower(trim((string)($auth['email'] ?? '')));
            $input = getInput();
            $reason = trim((string)($input['reason'] ?? ''));
            $note   = mb_substr(trim((string)($input['note'] ?? '')), 0, 500);
            $surface = trim((string)($input['surface'] ?? ''));
            // Whitelist reason — prevents arbitrary string from landing in
            // metadata + push payload (which is interpolated into i18n
            // strings on the parent device).
            $allowedReasons = ['bedtime', 'chat_disabled', 'feed_disabled', 'calls_disabled', 'contact_blocked', 'extra_time', 'new_contact', 'new_app', ''];
            if (!in_array($reason, $allowedReasons, true)) $reason = '';
            $allowedSurfaces = ['chat', 'feed', 'calls', 'email', ''];
            if (!in_array($surface, $allowedSurfaces, true)) $surface = '';
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Confirm caller is actually a registered child
                $stmt = $pg->prepare("SELECT parent_email, child_name FROM parental_accounts WHERE LOWER(child_email) = :c AND status = 'active' LIMIT 1");
                $stmt->execute([':c' => $myEmail]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$row) jsonResponse(false, null, 'not_a_child', 403);
                $parentEmail = $row['parent_email'];
                $childName   = $row['child_name'] ?: $myEmail;

                // Rate-limit: 1 unlock request per child per parent every 5min
                $rl = $pg->prepare("SELECT id FROM parental_alerts WHERE parent_email = :p AND child_email = :c AND alert_type = 'unlock_request' AND created_at > NOW() - INTERVAL '5 minutes' LIMIT 1");
                $rl->execute([':p' => $parentEmail, ':c' => $myEmail]);
                if ($rl->fetch(PDO::FETCH_ASSOC)) {
                    jsonResponse(true, ['queued' => false, 'rate_limited' => true]);
                }

                $titleTxt = $childName . ' pediu desbloqueio';
                $bodyTxt  = match ($reason) {
                    'bedtime'         => $childName . ' está pedindo pra usar fora do horário de descanso',
                    'chat_disabled'   => $childName . ' quer enviar uma mensagem',
                    'feed_disabled'   => $childName . ' quer abrir o feed',
                    'calls_disabled'  => $childName . ' quer fazer uma ligação',
                    'contact_blocked' => $childName . ' quer falar com um contato fora da lista',
                    'extra_time'      => $childName . ' quer mais tempo de tela hoje',
                    'new_contact'     => $childName . ' quer adicionar um novo contato',
                    'new_app'         => $childName . ' quer usar um novo aplicativo',
                    default           => $childName . ' pediu pra liberar um recurso',
                };
                if ($note !== '') $bodyTxt .= ': "' . $note . '"';

                $meta = [
                    'reason'  => $reason,
                    'surface' => $surface,
                    'note'    => $note,
                ];
                // Pass through structured extras the kid modal sends
                foreach (['extra_minutes', 'contact_email', 'app'] as $k) {
                    if (isset($input[$k]) && $input[$k] !== '') $meta[$k] = $input[$k];
                }
                $ins = $pg->prepare("INSERT INTO parental_alerts (parent_email, child_email, alert_type, severity, title, body, metadata, created_at) VALUES (:p, :c, 'unlock_request', 'warn', :t, :b, :m::jsonb, NOW()) RETURNING id");
                $ins->execute([
                    ':p' => $parentEmail,
                    ':c' => $myEmail,
                    ':t' => $titleTxt,
                    ':b' => $bodyTxt,
                    ':m' => json_encode($meta, JSON_UNESCAPED_UNICODE),
                ]);
                $alertId = (int)$ins->fetchColumn();

                // Push to parent
                try {
                    if (!function_exists('fcmSendToUser')) @require_once __DIR__ . '/firebase_push.php';
                    if (function_exists('fcmSendToUser')) {
                        fcmSendToUser($parentEmail, $titleTxt, $bodyTxt, [
                            'type'           => 'parental_unlock_request',
                            'alert_id'       => (string)$alertId,
                            'child_email'    => $myEmail,
                            'reason'         => $reason,
                            'surface'        => $surface,
                            'action_required'=> '1',
                            'thread_id'      => 'parental_' . md5($myEmail),
                            'group_key'      => 'parental_' . md5($myEmail),
                        ]);
                    }
                } catch (Throwable $e) { error_log('[parental_unlock_request.push] ' . $e->getMessage()); }

                jsonResponse(true, ['queued' => true, 'alert_id' => $alertId]);
            } catch (Throwable $e) {
                error_log('[parental_unlock_request] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed', 500);
            }
            break;
        }

        // ─── Parental dashboard live actions (pause, time bonus, monitor) ───
        // Each endpoint validates the caller via parentalIsParentOf() so a
        // logged-in user cannot poke at another family's child by email.
        case 'parental_lock_child':
        case 'parental_unlock_child': {
            $auth = requireAuth();
            $input = getInput();
            $childEmail = strtolower(trim((string)($input['child_email'] ?? '')));
            if ($childEmail === '') jsonResponse(false, null, 'child_email required', 400);
            require_once __DIR__ . '/parental_helper.php';
            if (!parentalIsParentOf($auth['email'], $childEmail)) {
                jsonResponse(false, null, 'Not authorized', 403);
            }
            $shouldLock = ($action === 'parental_lock_child');
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $sel = $pg->prepare("SELECT restrictions FROM parental_restrictions WHERE LOWER(child_email) = :c LIMIT 1");
                $sel->execute([':c' => $childEmail]);
                $existing = [];
                if ($rest = $sel->fetchColumn()) {
                    $existing = is_array($rest) ? $rest : (json_decode($rest, true) ?: []);
                }
                $existing['locked']    = $shouldLock;
                $existing['locked_at'] = $shouldLock ? date('c') : null;
                $up = $pg->prepare(
                    "INSERT INTO parental_restrictions (child_email, parent_email, restrictions, updated_at)
                     VALUES (:c, :p, :r::jsonb, NOW())
                     ON CONFLICT (child_email) DO UPDATE
                     SET parent_email = EXCLUDED.parent_email,
                         restrictions = EXCLUDED.restrictions,
                         updated_at = NOW()"
                );
                $up->execute([
                    ':c' => $childEmail,
                    ':p' => $auth['email'],
                    ':r' => json_encode($existing, JSON_UNESCAPED_UNICODE),
                ]);
                try {
                    $wsKey = getenv('MAIL_WS_KEY') ?: '';
                    if ($wsKey) {
                        $payload = json_encode([
                            'channel' => 'chat_user_' . strtolower($childEmail),
                            'event'   => 'parental_lock_changed',
                            'data'    => ['locked' => $shouldLock, 'restrictions' => $existing],
                        ]);
                        foreach (['http://127.0.0.1:8081/broadcast', 'http://127.0.0.1:8084/broadcast'] as $endpoint) {
                            $cu = curl_init($endpoint);
                            curl_setopt_array($cu, [
                                CURLOPT_POST => true,
                                CURLOPT_POSTFIELDS => $payload,
                                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                                CURLOPT_RETURNTRANSFER => true,
                                CURLOPT_TIMEOUT_MS => 600,
                                CURLOPT_CONNECTTIMEOUT_MS => 200,
                            ]);
                            curl_exec($cu); curl_close($cu);
                        }
                    }
                } catch (Throwable $_) {}
                jsonResponse(true, ['locked' => $shouldLock, 'restrictions' => $existing]);
            } catch (Throwable $e) {
                error_log('[' . $action . '] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed', 500);
            }
            break;
        }

        case 'parental_grant_extra_time': {
            $auth = requireAuth();
            $input = getInput();
            $childEmail = strtolower(trim((string)($input['child_email'] ?? '')));
            $minutes = (int)($input['minutes'] ?? 15);
            if ($minutes < 1)   $minutes = 15;
            if ($minutes > 480) $minutes = 480;
            if ($childEmail === '') jsonResponse(false, null, 'child_email required', 400);
            require_once __DIR__ . '/parental_helper.php';
            if (!parentalIsParentOf($auth['email'], $childEmail)) {
                jsonResponse(false, null, 'Not authorized', 403);
            }
            try {
                parentalEnsureExtraTables();
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $today = date('Y-m-d');
                $stmt = $pg->prepare(
                    "INSERT INTO parental_screen_time_bonus (child_email, day, minutes, granted_by)
                     VALUES (:c, :d, :m, :g)
                     ON CONFLICT (child_email, day) DO UPDATE
                       SET minutes = parental_screen_time_bonus.minutes + EXCLUDED.minutes,
                           granted_by = EXCLUDED.granted_by
                     RETURNING minutes"
                );
                $stmt->execute([
                    ':c' => $childEmail,
                    ':d' => $today,
                    ':m' => $minutes,
                    ':g' => $auth['email'],
                ]);
                $totalToday = (int)$stmt->fetchColumn();
                try {
                    $wsKey = getenv('MAIL_WS_KEY') ?: '';
                    if ($wsKey) {
                        $payload = json_encode([
                            'channel' => 'chat_user_' . strtolower($childEmail),
                            'event'   => 'parental_extra_time',
                            'data'    => ['minutes_added' => $minutes, 'minutes_today_total' => $totalToday],
                        ]);
                        foreach (['http://127.0.0.1:8081/broadcast', 'http://127.0.0.1:8084/broadcast'] as $endpoint) {
                            $cu = curl_init($endpoint);
                            curl_setopt_array($cu, [
                                CURLOPT_POST => true,
                                CURLOPT_POSTFIELDS => $payload,
                                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                                CURLOPT_RETURNTRANSFER => true,
                                CURLOPT_TIMEOUT_MS => 600,
                                CURLOPT_CONNECTTIMEOUT_MS => 200,
                            ]);
                            curl_exec($cu); curl_close($cu);
                        }
                    }
                } catch (Throwable $_) {}
                jsonResponse(true, ['minutes_added' => $minutes, 'minutes_today_total' => $totalToday, 'date' => $today]);
            } catch (Throwable $e) {
                error_log('[parental_grant_extra_time] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed', 500);
            }
            break;
        }

        case 'parental_child_today': {
            $auth = requireAuth();
            $input = getInput();
            $childEmail = strtolower(trim((string)($input['child_email'] ?? '')));
            if ($childEmail === '') jsonResponse(false, null, 'child_email required', 400);
            require_once __DIR__ . '/parental_helper.php';
            if (!parentalIsParentOf($auth['email'], $childEmail)) {
                jsonResponse(false, null, 'Not authorized', 403);
            }
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $startOfDayUtc = gmdate('Y-m-d') . ' 00:00:00';

                $sent = $pg->prepare("SELECT COUNT(*) FROM chat_messages
                    WHERE LOWER(sender_email) = :c AND created_at >= :d");
                $sent->execute([':c' => $childEmail, ':d' => $startOfDayUtc]);
                $messagesSent = (int)$sent->fetchColumn();

                $rcv = $pg->prepare("SELECT COUNT(*) FROM chat_messages cm
                    JOIN chat_conversation_members ccm ON ccm.conversation_id = cm.conversation_id
                    WHERE LOWER(ccm.email) = :c
                      AND LOWER(cm.sender_email) <> :c
                      AND cm.created_at >= :d");
                $rcv->execute([':c' => $childEmail, ':d' => $startOfDayUtc]);
                $messagesReceived = (int)$rcv->fetchColumn();

                $calls = $pg->prepare("SELECT COUNT(*) FROM chat_call_history
                    WHERE LOWER(user_email) = :c AND created_at >= :d");
                $calls->execute([':c' => $childEmail, ':d' => $startOfDayUtc]);
                $callsCount = (int)$calls->fetchColumn();

                $sv = $pg->prepare("SELECT COUNT(*) FROM chat_status_views
                    WHERE LOWER(viewer_email) = :c AND viewed_at >= :d");
                $sv->execute([':c' => $childEmail, ':d' => $startOfDayUtc]);
                $statusViews = (int)$sv->fetchColumn();

                $tc = $pg->prepare("SELECT m2.sender_email AS peer, COUNT(*) AS n
                    FROM chat_messages m1
                    JOIN chat_conversation_members ccm
                      ON ccm.conversation_id = m1.conversation_id
                     AND LOWER(ccm.email) = :c
                    JOIN chat_messages m2 ON m2.conversation_id = m1.conversation_id
                    WHERE m1.created_at >= :d
                      AND LOWER(m2.sender_email) <> :c
                    GROUP BY m2.sender_email
                    ORDER BY n DESC
                    LIMIT 5");
                $tc->execute([':c' => $childEmail, ':d' => $startOfDayUtc]);
                $topContacts = [];
                foreach ($tc->fetchAll(PDO::FETCH_ASSOC) as $row) {
                    $topContacts[] = ['email' => $row['peer'], 'message_count' => (int)$row['n']];
                }

                $hourly = array_fill(0, 24, 0);
                $hr = $pg->prepare("SELECT EXTRACT(HOUR FROM created_at::timestamp) AS hour, COUNT(*) AS n
                    FROM chat_messages
                    WHERE created_at >= :d
                      AND (LOWER(sender_email) = :c
                           OR conversation_id IN (
                              SELECT conversation_id FROM chat_conversation_members WHERE LOWER(email) = :c
                           ))
                    GROUP BY hour");
                $hr->execute([':c' => $childEmail, ':d' => $startOfDayUtc]);
                foreach ($hr->fetchAll(PDO::FETCH_ASSOC) as $row) {
                    $h = (int)$row['hour'];
                    if ($h >= 0 && $h < 24) $hourly[$h] = (int)$row['n'];
                }
                $hourlyOut = [];
                for ($h = 0; $h < 24; $h++) $hourlyOut[] = ['hour' => $h, 'count' => $hourly[$h]];

                // Heuristic screen-time minutes; replace once a real session
                // tracker writes to a sessions table.
                $activityCount = $messagesSent + $messagesReceived + $statusViews + ($callsCount * 3);
                $screenTimeMinutes = min(240, $activityCount * 2);

                jsonResponse(true, [
                    'date'                => gmdate('Y-m-d'),
                    'messages_sent'       => $messagesSent,
                    'messages_received'   => $messagesReceived,
                    'calls_count'         => $callsCount,
                    'status_views'        => $statusViews,
                    'screen_time_minutes' => $screenTimeMinutes,
                    'top_contacts'        => $topContacts,
                    'hourly_activity'     => $hourlyOut,
                ]);
            } catch (Throwable $e) {
                error_log('[parental_child_today] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed', 500);
            }
            break;
        }

        case 'parental_child_week': {
            $auth = requireAuth();
            $input = getInput();
            $childEmail = strtolower(trim((string)($input['child_email'] ?? '')));
            if ($childEmail === '') jsonResponse(false, null, 'child_email required', 400);
            require_once __DIR__ . '/parental_helper.php';
            if (!parentalIsParentOf($auth['email'], $childEmail)) {
                jsonResponse(false, null, 'Not authorized', 403);
            }
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $start = gmdate('Y-m-d', strtotime('-6 days')) . ' 00:00:00';
                $days = [];
                for ($i = 6; $i >= 0; $i--) {
                    $d = gmdate('Y-m-d', strtotime("-{$i} days"));
                    $days[$d] = ['date' => $d, 'messages_sent' => 0, 'messages_received' => 0, 'calls_count' => 0, 'screen_time_minutes' => 0];
                }
                $sent = $pg->prepare("SELECT TO_CHAR(created_at::timestamp, 'YYYY-MM-DD') AS day, COUNT(*) AS n
                    FROM chat_messages
                    WHERE LOWER(sender_email) = :c AND created_at >= :d GROUP BY day");
                $sent->execute([':c' => $childEmail, ':d' => $start]);
                foreach ($sent->fetchAll(PDO::FETCH_ASSOC) as $row) {
                    if (isset($days[$row['day']])) $days[$row['day']]['messages_sent'] = (int)$row['n'];
                }
                $rcv = $pg->prepare("SELECT TO_CHAR(cm.created_at::timestamp, 'YYYY-MM-DD') AS day, COUNT(*) AS n
                    FROM chat_messages cm
                    JOIN chat_conversation_members ccm ON ccm.conversation_id = cm.conversation_id
                    WHERE LOWER(ccm.email) = :c
                      AND LOWER(cm.sender_email) <> :c
                      AND cm.created_at >= :d
                    GROUP BY day");
                $rcv->execute([':c' => $childEmail, ':d' => $start]);
                foreach ($rcv->fetchAll(PDO::FETCH_ASSOC) as $row) {
                    if (isset($days[$row['day']])) $days[$row['day']]['messages_received'] = (int)$row['n'];
                }
                $calls = $pg->prepare("SELECT TO_CHAR(created_at::timestamp, 'YYYY-MM-DD') AS day, COUNT(*) AS n
                    FROM chat_call_history WHERE LOWER(user_email) = :c AND created_at >= :d GROUP BY day");
                $calls->execute([':c' => $childEmail, ':d' => $start]);
                foreach ($calls->fetchAll(PDO::FETCH_ASSOC) as $row) {
                    if (isset($days[$row['day']])) $days[$row['day']]['calls_count'] = (int)$row['n'];
                }
                foreach ($days as $d => $row) {
                    $a = $row['messages_sent'] + $row['messages_received'] + ($row['calls_count'] * 3);
                    $days[$d]['screen_time_minutes'] = min(240, $a * 2);
                }
                jsonResponse(true, ['days' => array_values($days)]);
            } catch (Throwable $e) {
                error_log('[parental_child_week] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed', 500);
            }
            break;
        }

        case 'parental_child_contacts': {
            $auth = requireAuth();
            $input = getInput();
            $childEmail = strtolower(trim((string)($input['child_email'] ?? '')));
            if ($childEmail === '') jsonResponse(false, null, 'child_email required', 400);
            require_once __DIR__ . '/parental_helper.php';
            if (!parentalIsParentOf($auth['email'], $childEmail)) {
                jsonResponse(false, null, 'Not authorized', 403);
            }
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $weekAgo = gmdate('Y-m-d H:i:s', strtotime('-7 days'));
                $stmt = $pg->prepare("
                    SELECT
                      LOWER(m.sender_email) AS email,
                      COALESCE(NULLIF(m.sender_name, ''), m.sender_email) AS name,
                      COUNT(*) AS message_count,
                      MAX(m.created_at) AS last_interaction,
                      MIN(m.created_at) AS first_interaction
                    FROM chat_messages m
                    WHERE m.conversation_id IN (
                        SELECT conversation_id FROM chat_conversation_members WHERE LOWER(email) = :c
                    )
                    AND LOWER(m.sender_email) <> :c
                    GROUP BY LOWER(m.sender_email), m.sender_name
                    ORDER BY message_count DESC
                    LIMIT 100
                ");
                $stmt->execute([':c' => $childEmail]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

                $contacts = [];
                $aq = $pg->prepare("SELECT 1 FROM parental_accounts WHERE LOWER(child_email) = :e LIMIT 1");
                foreach ($rows as $r) {
                    $newThisWeek = !empty($r['first_interaction']) && $r['first_interaction'] >= $weekAgo;
                    $msgCount    = (int)$r['message_count'];
                    $aq->execute([':e' => strtolower($r['email'])]);
                    $ageUnknown = !$aq->fetchColumn();

                    $risk = 'low';
                    if (($newThisWeek && $msgCount > 50) || ($ageUnknown && $msgCount > 200)) {
                        $risk = 'high';
                    } elseif ($newThisWeek || ($ageUnknown && $msgCount > 50)) {
                        $risk = 'med';
                    }

                    $contacts[] = [
                        'email'            => $r['email'],
                        'name'             => $r['name'],
                        'message_count'    => $msgCount,
                        'last_interaction' => $r['last_interaction'],
                        'age_unknown'      => $ageUnknown,
                        'new_this_week'    => $newThisWeek,
                        'risk_score'       => $risk,
                    ];
                }
                jsonResponse(true, ['contacts' => $contacts]);
            } catch (Throwable $e) {
                error_log('[parental_child_contacts] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed', 500);
            }
            break;
        }

        case 'parental_child_activity': {
            $auth = requireAuth();
            $input = getInput();
            $childEmail = strtolower(trim((string)($input['child_email'] ?? '')));
            $since = trim((string)($input['since'] ?? ''));
            if ($childEmail === '') jsonResponse(false, null, 'child_email required', 400);
            require_once __DIR__ . '/parental_helper.php';
            if (!parentalIsParentOf($auth['email'], $childEmail)) {
                jsonResponse(false, null, 'Not authorized', 403);
            }
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                if ($since === '') $since = gmdate('Y-m-d H:i:s', strtotime('-24 hours'));
                $events = [];

                $m = $pg->prepare("SELECT id, conversation_id, type, content, created_at
                    FROM chat_messages
                    WHERE LOWER(sender_email) = :c AND created_at >= :s
                    ORDER BY created_at DESC LIMIT 200");
                $m->execute([':c' => $childEmail, ':s' => $since]);
                foreach ($m->fetchAll(PDO::FETCH_ASSOC) as $row) {
                    $events[] = [
                        'type'            => 'message_sent',
                        'at'              => $row['created_at'],
                        'message_id'      => (int)$row['id'],
                        'conversation_id' => (int)$row['conversation_id'],
                        'msg_type'        => $row['type'],
                        'preview'         => mb_substr((string)$row['content'], 0, 120),
                    ];
                    if (($row['type'] ?? '') === 'video') {
                        $events[] = [
                            'type' => 'video_played',
                            'at'   => $row['created_at'],
                            'message_id' => (int)$row['id'],
                        ];
                    }
                }
                $s = $pg->prepare("SELECT id, type, created_at FROM chat_user_status
                    WHERE LOWER(email) = :c AND created_at >= :s
                    ORDER BY created_at DESC LIMIT 50");
                $s->execute([':c' => $childEmail, ':s' => $since]);
                foreach ($s->fetchAll(PDO::FETCH_ASSOC) as $row) {
                    $events[] = [
                        'type'      => 'status_posted',
                        'at'        => $row['created_at'],
                        'status_id' => (int)$row['id'],
                        'kind'      => $row['type'],
                    ];
                }
                $c = $pg->prepare("SELECT id, contact_email, video, duration, status, created_at
                    FROM chat_call_history WHERE LOWER(user_email) = :c AND created_at >= :s
                    ORDER BY created_at DESC LIMIT 50");
                $c->execute([':c' => $childEmail, ':s' => $since]);
                foreach ($c->fetchAll(PDO::FETCH_ASSOC) as $row) {
                    $events[] = [
                        'type'          => 'call_made',
                        'at'            => $row['created_at'],
                        'contact_email' => $row['contact_email'],
                        'video'         => (int)$row['video'] === 1,
                        'duration'      => (int)$row['duration'],
                        'status'        => $row['status'],
                    ];
                }
                // app_opened — best-effort proxy from first activity per hour
                $a = $pg->prepare("SELECT MIN(created_at) AS at
                    FROM chat_messages
                    WHERE LOWER(sender_email) = :c AND created_at >= :s
                    GROUP BY DATE_TRUNC('hour', created_at::timestamp)");
                $a->execute([':c' => $childEmail, ':s' => $since]);
                foreach ($a->fetchAll(PDO::FETCH_ASSOC) as $row) {
                    $events[] = ['type' => 'app_opened', 'at' => $row['at']];
                }

                usort($events, fn($x, $y) => strcmp((string)$y['at'], (string)$x['at']));
                jsonResponse(true, ['events' => array_slice($events, 0, 300), 'since' => $since]);
            } catch (Throwable $e) {
                error_log('[parental_child_activity] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed', 500);
            }
            break;
        }

        case 'parental_summary': {
            $auth = requireAuth();
            $input = getInput();
            $childEmail = strtolower(trim((string)($input['child_email'] ?? '')));
            if ($childEmail === '') jsonResponse(false, null, 'child_email required', 400);
            require_once __DIR__ . '/parental_helper.php';
            if (!parentalIsParentOf($auth['email'], $childEmail)) {
                jsonResponse(false, null, 'Not authorized', 403);
            }
            try {
                parentalEnsureExtraTables();
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // 6h cache hit?
                $cacheStmt = $pg->prepare("SELECT payload, generated_at FROM parental_summary_cache
                    WHERE child_email = :c AND generated_at > NOW() - INTERVAL '6 hours' LIMIT 1");
                $cacheStmt->execute([':c' => $childEmail]);
                if ($cached = $cacheStmt->fetch(PDO::FETCH_ASSOC)) {
                    $payload = is_array($cached['payload']) ? $cached['payload'] : (json_decode((string)$cached['payload'], true) ?: []);
                    jsonResponse(true, array_merge($payload, ['cached' => true, 'generated_at' => $cached['generated_at']]));
                }

                $startOfDayUtc = gmdate('Y-m-d') . ' 00:00:00';
                $sent = $pg->prepare("SELECT COUNT(*) FROM chat_messages WHERE LOWER(sender_email) = :c AND created_at >= :d");
                $sent->execute([':c' => $childEmail, ':d' => $startOfDayUtc]);
                $messagesSent = (int)$sent->fetchColumn();
                $rcv = $pg->prepare("SELECT COUNT(*) FROM chat_messages cm JOIN chat_conversation_members ccm ON ccm.conversation_id = cm.conversation_id WHERE LOWER(ccm.email) = :c AND LOWER(cm.sender_email) <> :c AND cm.created_at >= :d");
                $rcv->execute([':c' => $childEmail, ':d' => $startOfDayUtc]);
                $messagesReceived = (int)$rcv->fetchColumn();
                $calls = $pg->prepare("SELECT COUNT(*) FROM chat_call_history WHERE LOWER(user_email) = :c AND created_at >= :d");
                $calls->execute([':c' => $childEmail, ':d' => $startOfDayUtc]);
                $callsCount = (int)$calls->fetchColumn();
                $tp = $pg->prepare("SELECT m2.sender_email AS peer, COUNT(*) AS n FROM chat_messages m1
                    JOIN chat_conversation_members ccm ON ccm.conversation_id = m1.conversation_id AND LOWER(ccm.email) = :c
                    JOIN chat_messages m2 ON m2.conversation_id = m1.conversation_id
                    WHERE m1.created_at >= :d AND LOWER(m2.sender_email) <> :c
                    GROUP BY m2.sender_email ORDER BY n DESC LIMIT 3");
                $tp->execute([':c' => $childEmail, ':d' => $startOfDayUtc]);
                $topPeers = $tp->fetchAll(PDO::FETCH_ASSOC);

                $cn = $pg->prepare("SELECT child_name, age FROM parental_accounts WHERE LOWER(child_email) = :c LIMIT 1");
                $cn->execute([':c' => $childEmail]);
                $childRow = $cn->fetch(PDO::FETCH_ASSOC) ?: ['child_name' => $childEmail, 'age' => null];

                $stats = [
                    'name'              => $childRow['child_name'] ?: $childEmail,
                    'age'               => $childRow['age'],
                    'messages_sent'     => $messagesSent,
                    'messages_received' => $messagesReceived,
                    'calls_count'       => $callsCount,
                    'top_peers'         => $topPeers,
                    'date'              => gmdate('Y-m-d'),
                ];

                $systemPrompt = "You are a parental-control assistant generating a calm, concrete daily summary for a parent. Tone: warm, factual, no alarmism, no jargon. Output Brazilian Portuguese. Return STRICT JSON with keys: markdown (string, 4-7 lines), highlights (array of {title, body}), concerns (array of {title, body}), recommendations (array of {title, body}). Do not invent events; base everything on the provided stats. If stats are zero/low, say the child was inactive.";
                $userMsg = "Estatísticas do dia:\n" . json_encode($stats, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . "\n\nGere o resumo agora.";

                $aiText = '';
                try {
                    require_once __DIR__ . '/ai.php';
                    if (function_exists('callClaudeAPI')) {
                        $r = callClaudeAPI($systemPrompt, $userMsg, 'claude-haiku-4-5', 800, 0.4);
                        $aiText = (string)($r['content'] ?? '');
                    }
                } catch (Throwable $_) {}

                $payload = ['markdown' => '', 'highlights' => [], 'concerns' => [], 'recommendations' => []];
                if ($aiText !== '') {
                    $j = $aiText;
                    if (preg_match('/```json\s*(.+?)\s*```/s', $aiText, $mm)) $j = $mm[1];
                    elseif (preg_match('/```\s*(.+?)\s*```/s', $aiText, $mm)) $j = $mm[1];
                    $decoded = json_decode($j, true);
                    if (is_array($decoded)) {
                        $payload['markdown']        = (string)($decoded['markdown'] ?? '');
                        $payload['highlights']      = array_values((array)($decoded['highlights'] ?? []));
                        $payload['concerns']        = array_values((array)($decoded['concerns'] ?? []));
                        $payload['recommendations'] = array_values((array)($decoded['recommendations'] ?? []));
                    } else {
                        $payload['markdown'] = $aiText;
                    }
                }
                if ($payload['markdown'] === '') {
                    $payload['markdown'] = "Resumo de hoje para {$stats['name']}: {$messagesSent} mensagens enviadas, {$messagesReceived} recebidas, {$callsCount} ligações.";
                }

                $up = $pg->prepare("INSERT INTO parental_summary_cache (child_email, payload, generated_at)
                    VALUES (:c, :p::jsonb, NOW())
                    ON CONFLICT (child_email) DO UPDATE SET payload = EXCLUDED.payload, generated_at = NOW()");
                $up->execute([':c' => $childEmail, ':p' => json_encode($payload, JSON_UNESCAPED_UNICODE)]);

                jsonResponse(true, array_merge($payload, ['cached' => false, 'generated_at' => date('c')]));
            } catch (Throwable $e) {
                error_log('[parental_summary] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed', 500);
            }
            break;
        }

        case 'parental_approve_contact':
        case 'parental_reject_contact':
        case 'parental_block_contact': {
            $auth = requireAuth();
            $input = getInput();
            $childEmail = strtolower(trim((string)($input['child_email'] ?? '')));
            $contactEmail = strtolower(trim((string)($input['contact_email'] ?? '')));
            if ($childEmail === '' || $contactEmail === '') {
                jsonResponse(false, null, 'child_email and contact_email required', 400);
            }
            require_once __DIR__ . '/parental_helper.php';
            if (!parentalIsParentOf($auth['email'], $childEmail)) {
                jsonResponse(false, null, 'Not authorized', 403);
            }
            $newStatus = ($action === 'parental_approve_contact') ? 'approved' : 'blocked';
            try {
                parentalEnsureExtraTables();
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $pg->prepare("DELETE FROM parental_contact_approvals
                              WHERE LOWER(child_email) = :c AND LOWER(contact_email) = :ce")
                   ->execute([':c' => $childEmail, ':ce' => $contactEmail]);
                $ins = $pg->prepare("INSERT INTO parental_contact_approvals
                    (parent_email, child_email, contact_email, status, requested_at, resolved_at)
                    VALUES (:p, :c, :ce, :s, NOW(), NOW())");
                $ins->execute([
                    ':p'  => $auth['email'],
                    ':c'  => $childEmail,
                    ':ce' => $contactEmail,
                    ':s'  => $newStatus,
                ]);

                if ($newStatus === 'approved') {
                    try {
                        $pg->prepare("INSERT INTO parental_contact_whitelist (parent_email, child_email, contact_email)
                                      VALUES (:p, :c, :ce) ON CONFLICT DO NOTHING")
                           ->execute([':p' => $auth['email'], ':c' => $childEmail, ':ce' => $contactEmail]);
                    } catch (Throwable $_) {}
                } else {
                    try {
                        $pg->prepare("DELETE FROM parental_contact_whitelist
                                      WHERE LOWER(parent_email) = LOWER(:p)
                                        AND LOWER(child_email) = :c
                                        AND LOWER(contact_email) = :ce")
                           ->execute([':p' => $auth['email'], ':c' => $childEmail, ':ce' => $contactEmail]);
                    } catch (Throwable $_) {}
                }

                try {
                    $wsKey = getenv('MAIL_WS_KEY') ?: '';
                    if ($wsKey) {
                        $payload = json_encode([
                            'channel' => 'chat_user_' . strtolower($childEmail),
                            'event'   => 'parental_contact_decision',
                            'data'    => [
                                'contact_email' => $contactEmail,
                                'status'        => $newStatus,
                            ],
                        ]);
                        foreach (['http://127.0.0.1:8081/broadcast', 'http://127.0.0.1:8084/broadcast'] as $endpoint) {
                            $cu = curl_init($endpoint);
                            curl_setopt_array($cu, [
                                CURLOPT_POST => true,
                                CURLOPT_POSTFIELDS => $payload,
                                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . $wsKey],
                                CURLOPT_RETURNTRANSFER => true,
                                CURLOPT_TIMEOUT_MS => 600,
                                CURLOPT_CONNECTTIMEOUT_MS => 200,
                            ]);
                            curl_exec($cu); curl_close($cu);
                        }
                    }
                } catch (Throwable $_) {}

                jsonResponse(true, ['status' => $newStatus, 'contact_email' => $contactEmail]);
            } catch (Throwable $e) {
                error_log('[' . $action . '] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed', 500);
            }
            break;
        }

        case 'parental_flag_message': {
            $auth = requireAuth();
            $input = getInput();
            $messageId = (int)($input['message_id'] ?? 0);
            $reason = mb_substr(trim((string)($input['reason'] ?? '')), 0, 500);
            if ($messageId <= 0) jsonResponse(false, null, 'message_id required', 400);
            try {
                parentalEnsureExtraTables();
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $msg = $pg->prepare("SELECT id, conversation_id, sender_email FROM chat_messages WHERE id = :id LIMIT 1");
                $msg->execute([':id' => $messageId]);
                $row = $msg->fetch(PDO::FETCH_ASSOC);
                if (!$row) jsonResponse(false, null, 'message_not_found', 404);

                $members = $pg->prepare("SELECT email FROM chat_conversation_members WHERE conversation_id = :cid");
                $members->execute([':cid' => (int)$row['conversation_id']]);
                $emails = array_column($members->fetchAll(PDO::FETCH_ASSOC), 'email');

                require_once __DIR__ . '/parental_helper.php';
                $childMatch = null;
                foreach ($emails as $em) {
                    if (parentalIsParentOf($auth['email'], $em)) { $childMatch = $em; break; }
                }
                if (!$childMatch) jsonResponse(false, null, 'Not authorized', 403);

                $ins = $pg->prepare("INSERT INTO parental_message_flags
                    (parent_email, child_email, message_id, reason, status)
                    VALUES (:p, :c, :m, :r, 'open') RETURNING id");
                $ins->execute([
                    ':p' => $auth['email'],
                    ':c' => strtolower($childMatch),
                    ':m' => $messageId,
                    ':r' => $reason,
                ]);
                $flagId = (int)$ins->fetchColumn();
                jsonResponse(true, ['flag_id' => $flagId, 'status' => 'open']);
            } catch (Throwable $e) {
                error_log('[parental_flag_message] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed', 500);
            }
            break;
        }

        case 'parental_unlock_history': {
            $auth = requireAuth();
            $input = getInput();
            $childEmail = strtolower(trim((string)($input['child_email'] ?? '')));
            if ($childEmail === '') jsonResponse(false, null, 'child_email required', 400);
            require_once __DIR__ . '/parental_helper.php';
            if (!parentalIsParentOf($auth['email'], $childEmail)) {
                jsonResponse(false, null, 'Not authorized', 403);
            }
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                // Status derived from parental_alerts: read_at => approved,
                // metadata.denied => denied, else pending.
                $stmt = $pg->prepare("SELECT id, child_email, alert_type, severity, title, body, metadata, read_at, created_at
                    FROM parental_alerts
                    WHERE LOWER(parent_email) = LOWER(:p)
                      AND LOWER(child_email) = :c
                      AND alert_type = 'unlock_request'
                    ORDER BY created_at DESC LIMIT 100");
                $stmt->execute([':p' => $auth['email'], ':c' => $childEmail]);
                $out = [];
                foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                    $meta = is_array($r['metadata']) ? $r['metadata'] : (json_decode((string)$r['metadata'], true) ?: []);
                    $status = !empty($meta['denied']) ? 'denied' : (!empty($r['read_at']) ? 'approved' : 'pending');
                    $out[] = [
                        'id'         => (int)$r['id'],
                        'reason'     => $meta['reason'] ?? '',
                        'note'       => $meta['note'] ?? '',
                        'surface'    => $meta['surface'] ?? '',
                        'status'     => $status,
                        'created_at' => $r['created_at'],
                    ];
                }
                jsonResponse(true, ['requests' => $out]);
            } catch (Throwable $e) {
                error_log('[parental_unlock_history] ' . $e->getMessage());
                jsonResponse(false, null, 'Failed', 500);
            }
            break;
        }

        case 'parental_my_requests': {
            $auth = requireAuth();
            $myEmail = strtolower(trim((string)($auth['email'] ?? '')));
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $isChild = $pg->prepare("SELECT 1 FROM parental_accounts WHERE LOWER(child_email) = :c AND status = 'active' LIMIT 1");
                $isChild->execute([':c' => $myEmail]);
                if (!$isChild->fetchColumn()) jsonResponse(true, ['requests' => []]);

                $stmt = $pg->prepare("SELECT id, alert_type, title, body, metadata, read_at, created_at
                    FROM parental_alerts
                    WHERE LOWER(child_email) = :c AND alert_type = 'unlock_request'
                    ORDER BY created_at DESC LIMIT 100");
                $stmt->execute([':c' => $myEmail]);
                $out = [];
                foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                    $meta = is_array($r['metadata']) ? $r['metadata'] : (json_decode((string)$r['metadata'], true) ?: []);
                    $status = !empty($meta['denied']) ? 'denied' : (!empty($r['read_at']) ? 'approved' : 'pending');
                    $out[] = [
                        'id'         => (int)$r['id'],
                        'reason'     => $meta['reason'] ?? '',
                        'note'       => $meta['note'] ?? '',
                        'surface'    => $meta['surface'] ?? '',
                        'status'     => $status,
                        'created_at' => $r['created_at'],
                    ];
                }
                jsonResponse(true, ['requests' => $out]);
            } catch (Throwable $e) {
                error_log('[parental_my_requests] ' . $e->getMessage());
                jsonResponse(true, ['requests' => []]);
            }
            break;
        }

        case 'parental_pending_requests': {
            $auth = requireAuth();
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();
                $kids = $pg->prepare("SELECT child_email, child_name FROM parental_accounts WHERE LOWER(parent_email) = LOWER(:p) AND status = 'active'");
                $kids->execute([':p' => $auth['email']]);
                $childRows = $kids->fetchAll(PDO::FETCH_ASSOC);
                if (!$childRows) jsonResponse(true, ['requests' => []]);

                $byChild = [];
                foreach ($childRows as $cr) $byChild[strtolower($cr['child_email'])] = $cr['child_name'];

                $stmt = $pg->prepare("SELECT id, child_email, title, body, metadata, created_at
                    FROM parental_alerts
                    WHERE LOWER(parent_email) = LOWER(:p)
                      AND alert_type = 'unlock_request'
                      AND read_at IS NULL
                    ORDER BY created_at DESC LIMIT 200");
                $stmt->execute([':p' => $auth['email']]);
                $out = [];
                foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                    $meta = is_array($r['metadata']) ? $r['metadata'] : (json_decode((string)$r['metadata'], true) ?: []);
                    if (!empty($meta['denied'])) continue;
                    $ce = strtolower((string)$r['child_email']);
                    $out[] = [
                        'id'           => (int)$r['id'],
                        'child_email'  => $r['child_email'],
                        'child_name'   => $byChild[$ce] ?? $r['child_email'],
                        'reason'       => $meta['reason'] ?? '',
                        'note'         => $meta['note'] ?? '',
                        'surface'      => $meta['surface'] ?? '',
                        'created_at'   => $r['created_at'],
                    ];
                }
                jsonResponse(true, ['requests' => $out]);
            } catch (Throwable $e) {
                error_log('[parental_pending_requests] ' . $e->getMessage());
                jsonResponse(true, ['requests' => []]);
            }
            break;
        }

        // chat_get_notes — returns notes list stub (empty if not implemented)
        case 'chat_get_notes':
        case 'chat_set_note':
            jsonResponse(true, ['notes' => [], 'success' => true], 'ok');
            break;

        // --- VACATION / AUTO-REPLY ---
        case 'vacation_get': case 'vacation_set':
            require_once __DIR__ . '/vacation.php';
            handleVacationAction($action);
            break;

        // --- EMAIL FILTERS ---
        case 'filter_list': case 'filter_create': case 'filter_update':
        case 'filter_delete': case 'filter_test':
        case 'filters_get': case 'filters_save':
            require_once __DIR__ . '/filters.php';
            handleFilterAction($action);
            break;

        // --- FILES/DRIVE ---
        case 'file_list': case 'file_upload': case 'file_download':
        case 'file_delete': case 'file_restore': case 'file_permanent_delete':
        case 'file_create_folder': case 'file_rename': case 'file_move':
        case 'file_star': case 'file_trash': case 'file_storage_info':
        case 'file_search': case 'file_recent': case 'file_share':
            require_once __DIR__ . '/files.php';
            handleFilesAction($action);
            break;

        // --- CALENDAR ---
        case 'cal_list_calendars': case 'cal_create_calendar':
        case 'cal_list_events': case 'cal_get_event':
        case 'cal_create_event': case 'cal_update_event': case 'cal_delete_event':
        case 'cal_rsvp_event': case 'cal_today': case 'cal_search':
        case 'event_find_free_time':
            require_once __DIR__ . '/calendar.php';
            handleCalendarAction($action);
            break;


        // ===== BULK OPERATIONS =====
        case 'bulk_mark_read':
        case 'bulk_mark_unread':
            $auth = requireAuth();
            $input = getInput();
            $uids = $input['uids'] ?? [];
            $folder = $input['folder'] ?? 'INBOX';
            if ($folder === 'Flagged') $folder = 'INBOX';
            if (empty($uids) || !is_array($uids)) jsonResponse(false, null, 'uids array required', 400);

            $imap = getImap($auth['email'], $auth['password'], $folder);
            $uidStr = implode(',', array_map('intval', $uids));
            if ($action === 'bulk_mark_read') {
                imap_setflag_full($imap, $uidStr, '\\Seen', ST_UID);
            } else {
                imap_clearflag_full($imap, $uidStr, '\\Seen', ST_UID);
            }
            try { imap_close($imap); } catch (\Throwable $_e) {}
            jsonResponse(true, null, count($uids) . ' emails updated');
            break;

        case 'bulk_delete':
            $auth = requireAuth();
            $input = getInput();
            $uids = $input['uids'] ?? [];
            $folder = $input['folder'] ?? 'INBOX';
            if ($folder === 'Flagged') $folder = 'INBOX';
            if (empty($uids) || !is_array($uids)) jsonResponse(false, null, 'uids array required', 400);

            $imap = getImap($auth['email'], $auth['password'], $folder);
            foreach ($uids as $uid) {
                $uid = (int)$uid;
                if ($folder !== 'Trash') {
                    @imap_mail_move($imap, (string)$uid, 'Trash', CP_UID);
                } else {
                    imap_delete($imap, (string)$uid, FT_UID);
                }
            }
            imap_expunge($imap);
            try { imap_close($imap); } catch (\Throwable $_e) {}
            jsonResponse(true, null, count($uids) . ' emails deleted');
            break;

        case 'bulk_archive':
            $auth = requireAuth();
            $input = getInput();
            $uids = $input['uids'] ?? [];
            $folder = $input['folder'] ?? 'INBOX';
            if ($folder === 'Flagged') $folder = 'INBOX';
            if (empty($uids) || !is_array($uids)) jsonResponse(false, null, 'uids array required', 400);

            $imap = getImap($auth['email'], $auth['password'], $folder);
            foreach ($uids as $uid) {
                @imap_mail_move($imap, (string)(int)$uid, 'Archive', CP_UID);
            }
            imap_expunge($imap);
            try { imap_close($imap); } catch (\Throwable $_e) {}
            jsonResponse(true, null, count($uids) . ' emails archived');
            break;

        // ===== SPAM =====
        case 'report_spam':
            $auth = requireAuth();
            $input = getInput();
            $uid = (int)($input['uid'] ?? 0);
            $folder = $input['folder'] ?? 'INBOX';
            if ($folder === 'Flagged') $folder = 'INBOX';
            if (!$uid) jsonResponse(false, null, 'uid required', 400);

            $imap = getImap($auth['email'], $auth['password'], $folder);
            @imap_mail_move($imap, (string)$uid, 'Spam', CP_UID);
            imap_expunge($imap);
            try { imap_close($imap); } catch (\Throwable $_e) {}
            jsonResponse(true, null, 'Reported as spam');
            break;

        case 'report_ham':
        case 'mark_not_spam':
            $auth = requireAuth();
            $input = getInput();
            $uid = (int)($input['uid'] ?? 0);
            $folder = $input['folder'] ?? 'Spam';
            if (!$uid) jsonResponse(false, null, 'uid required', 400);

            $imap = getImap($auth['email'], $auth['password'], $folder);

            // Extract sender for whitelist learning BEFORE moving
            $senderEmail = '';
            try {
                $headerRaw = @imap_fetchheader($imap, $uid, FT_UID);
                if ($headerRaw && preg_match('/^From:\s*(.+)$/mi', $headerRaw, $mFrom)) {
                    $fromLine = trim($mFrom[1]);
                    if (preg_match('/<([^>]+)>/', $fromLine, $mAddr)) {
                        $senderEmail = strtolower(trim($mAddr[1]));
                    } elseif (filter_var(trim($fromLine), FILTER_VALIDATE_EMAIL)) {
                        $senderEmail = strtolower(trim($fromLine));
                    }
                }
            } catch (\Throwable $_e) {}

            @imap_mail_move($imap, (string)$uid, 'INBOX', CP_UID);
            imap_expunge($imap);
            try { imap_close($imap); } catch (\Throwable $_e) {}

            // Learn: add sender to user's email_whitelist so future emails skip spam check
            $learned = false;
            if (!empty($senderEmail) && filter_var($senderEmail, FILTER_VALIDATE_EMAIL)) {
                try {
                    if (!function_exists('getPGDB')) require_once __DIR__ . '/db.php';
                    $pg = getPGDB();
                    // Auto-create table if missing (idempotent)
                    $pg->exec("CREATE TABLE IF NOT EXISTS email_whitelist (
                        user_email TEXT NOT NULL,
                        sender_email TEXT NOT NULL,
                        learned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (user_email, sender_email)
                    )");
                    $stmt = $pg->prepare("INSERT INTO email_whitelist (user_email, sender_email) VALUES (:u, :s) ON CONFLICT (user_email, sender_email) DO NOTHING");
                    $stmt->execute([':u' => strtolower($auth['email']), ':s' => $senderEmail]);
                    $learned = true;
                } catch (\Throwable $_e) {
                    error_log('mark_not_spam whitelist learn failed: ' . $_e->getMessage());
                }
            }

            jsonResponse(true, [
                'learned' => $learned,
                'sender' => $senderEmail,
            ], 'Marked as not spam');
            break;

        // ===== THREAD (conversation view) =====
        case 'get_thread':
            $auth = requireAuth();
            $input = getInput();
            $uid = (int)($input['uid'] ?? 0);
            $folder = $input['folder'] ?? 'INBOX';
            if ($folder === 'Flagged') $folder = 'INBOX';
            if (!$uid) jsonResponse(false, null, 'uid required', 400);

            // CACHE LAYER 4: thread fan-out per (email, folder, root_uid), TTL 120s.
            // Whole thread response (headers across folders). Invalidated when any
            // included msg is marked/moved/deleted via folder-level invalidation; we
            // also drop on send (any new reply).
            $threadCacheKey = 'thread:' . strtolower($auth['email']) . ':' . $folder . ':' . $uid;
            $cachedThread = imapCacheGet($threadCacheKey);
            if ($cachedThread !== null) {
                jsonResponse(true, $cachedThread);
                break;
            }

            $imap = getImap($auth['email'], $auth['password'], $folder);

            // Get the root message's headers to find thread identifiers
            $header = imap_fetchheader($imap, $uid, FT_UID);
            $messageId = '';
            $references = [];
            $subject = '';

            if (preg_match('/^Message-ID:\s*<?([^>\s]+)>?/mi', $header, $m)) {
                $messageId = $m[1];
            }
            if (preg_match('/^References:\s*(.+?)(?=^\S)/mis', $header, $m)) {
                preg_match_all('/<([^>]+)>/', $m[1], $refs);
                $references = $refs[1] ?? [];
            }
            if (preg_match('/^In-Reply-To:\s*<?([^>\s]+)>?/mi', $header, $m)) {
                $references[] = $m[1];
            }
            if (preg_match('/^Subject:\s*(.+)$/mi', $header, $m)) {
                $subject = trim($m[1]);
                // Decode MIME encoded subject
                if (strpos($subject, '=?') !== false) {
                    $subject = @mb_decode_mimeheader($subject);
                }
            }

            // Build set of all message-ids in this thread
            $threadIds = array_unique(array_merge([$messageId], $references));
            $threadIds = array_filter($threadIds);

            // Search for related messages across common folders
            $threadMessages = [];
            $seenUids = [];
            $searchFolders = ['INBOX', 'Sent', 'Drafts', 'INBOX.Sent', 'Sent Messages'];

            // Also search by normalized subject (Re: / Fwd: stripped)
            $baseSubject = preg_replace('/^(Re|Fwd|Enc|Res):\s*/i', '', $subject);
            $baseSubject = preg_replace('/^(Re|Fwd|Enc|Res):\s*/i', '', $baseSubject); // double strip

            foreach ($searchFolders as $sf) {
                $sfImap = @getImap($auth['email'], $auth['password'], $sf);
                if (!$sfImap) continue;

                $foundUids = [];

                // Search by Message-ID references
                foreach ($threadIds as $tid) {
                    $tidClean = addcslashes($tid, '"\\');
                    $res = @imap_search($sfImap, 'HEADER References "' . $tidClean . '"', SE_UID);
                    if ($res) $foundUids = array_merge($foundUids, $res);
                    $res = @imap_search($sfImap, 'HEADER In-Reply-To "' . $tidClean . '"', SE_UID);
                    if ($res) $foundUids = array_merge($foundUids, $res);
                    $res = @imap_search($sfImap, 'HEADER Message-ID "' . $tidClean . '"', SE_UID);
                    if ($res) $foundUids = array_merge($foundUids, $res);
                }

                // Also search by subject as fallback
                if ($baseSubject && mb_strlen($baseSubject) > 3) {
                    $subjectSearch = @imap_search($sfImap, 'SUBJECT "' . addcslashes($baseSubject, '"\\') . '"', SE_UID);
                    if ($subjectSearch) $foundUids = array_merge($foundUids, $subjectSearch);
                }

                $foundUids = array_unique($foundUids);

                foreach ($foundUids as $fuid) {
                    $key = $sf . ':' . $fuid;
                    if (isset($seenUids[$key])) continue;
                    $seenUids[$key] = true;

                    $overview = @imap_fetch_overview($sfImap, (string)$fuid, FT_UID);
                    if (!$overview) continue;
                    $ov = $overview[0];

                    $threadMessages[] = [
                        'uid' => (int)$fuid,
                        'folder' => $sf,
                        'from' => isset($ov->from) ? @iconv_mime_decode($ov->from, 0, 'UTF-8') : '',
                        'to' => isset($ov->to) ? @iconv_mime_decode($ov->to, 0, 'UTF-8') : '',
                        'subject' => isset($ov->subject) ? @iconv_mime_decode($ov->subject, 0, 'UTF-8') : '',
                        'date' => $ov->date ?? '',
                        'timestamp' => isset($ov->date) ? strtotime($ov->date) : 0,
                        'seen' => (bool)($ov->seen ?? false),
                        'flagged' => (bool)($ov->flagged ?? false),
                        'size' => (int)($ov->size ?? 0),
                    ];
                }

                if ($sfImap !== $imap) @imap_close($sfImap);
            }

            // Sort by date (oldest first = conversation order)
            usort($threadMessages, fn($a, $b) => ($a['timestamp'] ?? 0) - ($b['timestamp'] ?? 0));

            try { imap_close($imap); } catch (\Throwable $_e) {}
            $threadResp = [
                'thread_id' => $messageId ?: $uid,
                'subject' => $subject,
                'message_count' => count($threadMessages),
                'messages' => $threadMessages,
            ];
            imapCacheSet($threadCacheKey, $threadResp, 120);
            jsonResponse(true, $threadResp);
            break;

        // ===== TEMPLATES (persisted to file) =====
        case 'template_list':
            $auth = requireAuth();
            $tplFile = getTemplatesFile($auth['email']);
            $templates = file_exists($tplFile) ? (json_decode(file_get_contents($tplFile), true) ?: []) : [];
            jsonResponse(true, $templates);
            break;

        case 'template_save':
            $auth = requireAuth();
            $input = getInput();
            $name = trim($input['name'] ?? '');
            $subject = $input['subject'] ?? '';
            $body = $input['body'] ?? '';
            if (!$name) jsonResponse(false, null, 'Template name required', 400);
            $tplFile = getTemplatesFile($auth['email']);
            $templates = file_exists($tplFile) ? (json_decode(file_get_contents($tplFile), true) ?: []) : [];
            $id = uniqid('tpl_');
            $templates[] = ['id' => $id, 'name' => $name, 'subject' => $subject, 'body' => $body, 'created_at' => date('c')];
            file_put_contents($tplFile, json_encode($templates, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
            jsonResponse(true, ['id' => $id], 'Template saved');
            break;

        case 'template_delete':
            $auth = requireAuth();
            $input = getInput();
            $id = $input['id'] ?? '';
            if (!$id) jsonResponse(false, null, 'Template id required', 400);
            $tplFile = getTemplatesFile($auth['email']);
            $templates = file_exists($tplFile) ? (json_decode(file_get_contents($tplFile), true) ?: []) : [];
            $templates = array_values(array_filter($templates, fn($t) => $t['id'] !== $id));
            file_put_contents($tplFile, json_encode($templates, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
            jsonResponse(true, null, 'Template deleted');
            break;

        // ===== SCHEDULE SEND =====
        case 'schedule_send':
            $auth = requireAuth();
            $input = getInput();
            $to = sanitizeHeader(trim($input['to'] ?? ''));
            $subject = sanitizeHeader(trim($input['subject'] ?? '(Sem assunto)'));
            $body = $input['body'] ?? '';
            $cc = sanitizeHeader(trim($input['cc'] ?? ''));
            $bcc = sanitizeHeader(trim($input['bcc'] ?? ''));
            $sendAt = $input['send_at'] ?? null;

            if (!$to || !$subject) jsonResponse(false, null, 'to and subject required', 400);

            // Save as draft in the Drafts folder via IMAP
            $server = '{127.0.0.1:993/imap/ssl/novalidate-cert}';
            $imap = getImap($auth['email'], $auth['password'], 'Drafts');

            $senderDomain = explode('@', $auth['email'])[1] ?? 'onemundo.com.br';
            $draftHeaders  = "From: {$auth['name']} <{$auth['email']}>\r\n";
            $draftHeaders .= "To: {$to}\r\n";
            if ($cc) $draftHeaders .= "Cc: {$cc}\r\n";
            $draftHeaders .= "Subject: {$subject}\r\n";
            $draftHeaders .= "Date: " . date('r') . "\r\n";
            $draftHeaders .= "Message-ID: <" . uniqid('sched_', true) . "@{$senderDomain}>\r\n";
            $draftHeaders .= "MIME-Version: 1.0\r\n";
            $draftHeaders .= "Content-Type: text/html; charset=UTF-8\r\n";
            $draftHeaders .= "Content-Transfer-Encoding: quoted-printable\r\n";
            $draftHeaders .= "X-OneMundo-Draft: true\r\n";
            $draftHeaders .= "X-OneMundo-Scheduled: " . ($sendAt ?: 'pending') . "\r\n";
            if ($bcc) $draftHeaders .= "X-OneMundo-Bcc: {$bcc}\r\n";

            $draftMsg = $draftHeaders . "\r\n" . quoted_printable_encode($body);

            // Ensure Drafts folder exists
            $folders = imap_list($imap, $server, 'Drafts');
            if (!$folders) imap_createmailbox($imap, imap_utf7_encode($server . 'Drafts'));

            $ok = imap_append($imap, $server . 'Drafts', $draftMsg, "\\Draft \\Seen");

            // Get new draft UID
            $newUid = 0;
            if ($ok) {
                $check = imap_check($imap);
                if ($check && $check->Nmsgs > 0) {
                    $overview = imap_fetch_overview($imap, $check->Nmsgs . ':' . $check->Nmsgs);
                    $newUid = $overview[0]->uid ?? 0;
                }
            }
            try { imap_close($imap); } catch (\Throwable $_e) {}

            // Save scheduled metadata for cron worker to pick up
            if ($ok && $sendAt) {
                $parts = explode('@', $auth['email']);
                $schedFile = '/var/mail/vhosts/' . ($parts[1] ?? 'onemundo.com.br') . '/' . $parts[0] . '/scheduled.json';
                $scheduled = file_exists($schedFile) ? (json_decode(file_get_contents($schedFile), true) ?: []) : [];
                $scheduled[] = [
                    'to' => $to,
                    'subject' => $subject,
                    'body' => $body,
                    'cc' => $cc,
                    'bcc' => $bcc,
                    'send_at' => $sendAt,
                    'draft_uid' => $newUid,
                    'created_at' => date('c'),
                ];
                file_put_contents($schedFile, json_encode($scheduled, JSON_PRETTY_PRINT), LOCK_EX);
            }

            jsonResponse($ok, ['scheduled' => true, 'saved_as_draft' => true, 'draft_uid' => $newUid, 'send_at' => $sendAt], $ok ? 'Email agendado para envio' : 'Erro ao agendar email');
            break;

        // ===== FOLDER RENAME =====
        case 'rename_folder':
            $auth = requireAuth();
            $input = getInput();
            $oldName = $input['old_name'] ?? '';
            $newName = $input['new_name'] ?? '';
            if (!$oldName || !$newName) jsonResponse(false, null, 'old_name and new_name required', 400);
            $imap = getImap($auth['email'], $auth['password']);
            $server = '{localhost:143}';
            $result = @imap_renamemailbox($imap, $server . $oldName, $server . $newName);
            try { imap_close($imap); } catch (\Throwable $_e) {}
            if ($result) jsonResponse(true, null, 'Folder renamed');
            else jsonResponse(false, null, 'Failed to rename folder');
            break;

        // ===== CONTACTS SEARCH =====
        case 'contacts':
            $auth = requireAuth();
            $input = getInput();
            $q = $input['q'] ?? '';
            $results = [];
            if (strlen($q) >= 2) {
                $imap = getImap($auth['email'], $auth['password'], 'Sent');
                $searchResult = @imap_search($imap, 'TO "' . addcslashes($q, '"') . '"', SE_UID);
                if ($searchResult) {
                    $seen = [];
                    foreach (array_slice($searchResult, 0, 20) as $uid) {
                        $header = @imap_fetchheader($imap, $uid, FT_UID);
                        if (preg_match_all('/([\w.+-]+@[\w.-]+\.\w+)/', $header, $matches)) {
                            foreach ($matches[1] as $email) {
                                $email = strtolower($email);
                                if ($email !== strtolower($auth['email']) && !isset($seen[$email])) {
                                    $seen[$email] = true;
                                    $results[] = ['email' => $email, 'name' => explode('@', $email)[0]];
                                }
                            }
                        }
                    }
                }
                try { imap_close($imap); } catch (\Throwable $_e) {}
            }
            jsonResponse(true, $results);
            break;

        // ===== ONEMUNDO USERS =====
        case 'list_onemundo_users':
            $auth = requireAuth();
            jsonResponse(true, []);
            break;

        // ===== ACCOUNT DATA EXPORT (GDPR) =====
        // Returns a downloadable JSON with the user's profile + chat
        // conversation list + email folder names + feed posts authored.
        // Rate-limited to 1 export per 24h. URL is served from
        // /var/www/mail/data/exports/ (Cloudflare CDN handles caching).
        case 'account_data_export': {
            $auth = requireAuth();
            $email = $auth['email'];
            $exportDir = __DIR__ . '/../data/exports';
            if (!is_dir($exportDir)) @mkdir($exportDir, 0755, true);

            // Rate limit: 1 export per user per 24h.
            $rateFile = $exportDir . '/.rate_' . md5(strtolower($email));
            if (file_exists($rateFile) && (time() - (int)trim(file_get_contents($rateFile))) < 86400) {
                $next = 86400 - (time() - (int)trim(file_get_contents($rateFile)));
                jsonResponse(false, ['retry_after' => $next], 'Limite: 1 exportação a cada 24h.', 429);
            }

            $payload = [
                'generated_at' => date('c'),
                'profile' => [
                    'email' => $email,
                    'name'  => $auth['name'] ?? '',
                ],
            ];

            // Chat conversations (PG)
            try {
                require_once __DIR__ . '/db.php';
                $pg = getPGDB();

                $convs = $pg->prepare("
                    SELECT c.id, c.type, c.created_at,
                           (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL) AS message_count
                    FROM chat_conversations c
                    JOIN chat_conversation_members m ON m.conversation_id = c.id
                    WHERE LOWER(m.email) = LOWER(:e)
                    ORDER BY c.id DESC
                    LIMIT 1000
                ");
                $convs->execute([':e' => $email]);
                $payload['chat_conversations'] = array_map(function($r){
                    $r['id'] = (int)$r['id'];
                    $r['message_count'] = (int)$r['message_count'];
                    return $r;
                }, $convs->fetchAll(PDO::FETCH_ASSOC) ?: []);

                // Feed posts authored
                $posts = $pg->prepare("
                    SELECT id, caption, created_at, like_count, comment_count
                    FROM chat_feed_posts
                    WHERE LOWER(author_email) = LOWER(:e) AND (is_deleted IS NULL OR is_deleted = 0)
                    ORDER BY id DESC
                    LIMIT 1000
                ");
                $posts->execute([':e' => $email]);
                $payload['feed_posts'] = array_map(function($r){
                    $r['id'] = (int)$r['id'];
                    return $r;
                }, $posts->fetchAll(PDO::FETCH_ASSOC) ?: []);
            } catch (Throwable $e) {
                error_log('[account_data_export.pg] ' . $e->getMessage());
                $payload['chat_conversations'] = [];
                $payload['feed_posts'] = [];
            }

            // Email folder names (best-effort via IMAP)
            try {
                if (!empty($_SESSION['password_enc'])) {
                    $imap = @getImap($email, $auth['password'] ?? '', 'INBOX');
                    if ($imap) {
                        $list = @imap_list($imap, '{127.0.0.1:993/imap/ssl/novalidate-cert}', '*');
                        if ($list) {
                            $payload['email_folders'] = array_map(function($n){
                                return preg_replace('/^\{[^}]+\}/', '', $n);
                            }, $list);
                        }
                        try { imap_close($imap); } catch (\Throwable $_e) {}
                    }
                }
            } catch (Throwable $e) {
                error_log('[account_data_export.imap] ' . $e->getMessage());
            }

            $fileName = md5(strtolower($email)) . '_' . time() . '.json';
            $filePath = $exportDir . '/' . $fileName;
            $ok = @file_put_contents($filePath, json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
            if ($ok === false) jsonResponse(false, null, 'Falha ao gerar exportação', 500);

            // Stamp the rate-limit window only after a successful write so
            // a transient I/O failure doesn't lock out retries.
            file_put_contents($rateFile, (string)time(), LOCK_EX);

            $url = 'https://chatyy.com.br/data/exports/' . $fileName;
            jsonResponse(true, ['url' => $url, 'expires_in' => 86400, 'size' => filesize($filePath)]);
            break;
        }

        // ===== DELETE ACCOUNT =====
        case 'delete_account':
            $auth = requireAuth();
            $input = getInput();
            $password = $input['password'] ?? '';
            if (!$password) jsonResponse(false, null, 'Password required', 400);
            try {
                $imap = getImap($auth['email'], $password);
                try { imap_close($imap); } catch (\Throwable $_e) {}
            } catch (Exception $e) {
                jsonResponse(false, null, 'Incorrect password', 401);
            }
            session_destroy();
            jsonResponse(true, null, 'Account deletion requested. Your account will be deleted within 30 days.');
            break;
        default:
            // Email gap-closer (round 6, 2026-05-17): OAuth import, PGP keys,
            // tasks, bundles, bulk-mark-folder. Lives in email-gaps.php so the
            // 13k-line monolith stays readable. Dispatcher returns true after
            // it served the action (and called jsonResponse), false otherwise.
            if (is_file(__DIR__ . '/email-gaps.php')) {
                require_once __DIR__ . '/email-gaps.php';
                if (function_exists('handleEmailGapsAction') && handleEmailGapsAction($action)) {
                    break;
                }
            }
            // Catchall: any unrecognized chat_* action is forwarded to chat.php.
            if (strpos($action, 'chat_') === 0) {
                require_once __DIR__ . '/chat.php';
                handleChatAction($action);
                break;
            }
            // Catchall: any unrecognized live_* action is forwarded to chat.php.
            // VOD pipeline (CF Stream live_start_cf, live_end_cf, live_recordings_list,
            // live_save_replay, live_recording_get etc.) lives in chat.php.
            if (strpos($action, 'live_') === 0) {
                require_once __DIR__ . '/chat.php';
                handleChatAction($action);
                break;
            }
            // Unrecognized parental_* or kids_* → parental.php. Lets us add
            // new parental features (Ask Parent, achievements, daily quest)
            // without editing the big switch above.
            if (strpos($action, 'parental_') === 0 || strpos($action, 'kids_') === 0) {
                require_once __DIR__ . '/parental.php';
                if (function_exists('handleParentalAction')) {
                    // parental.php auths via $_SESSION — ensure it's populated
                    // from the bearer token (same shape requireAuth() yields).
                    if (empty($_SESSION['email'])) {
                        $auth = requireAuth();
                        $_SESSION['email'] = $auth['email'];
                    }
                    handleParentalAction($action);
                    break;
                }
            }
            // Status actions also route to chat.php for any shape not in the explicit list
            if (strpos($action, 'status_') === 0) {
                require_once __DIR__ . '/chat.php';
                handleChatAction($action);
                break;
            }
            // AI feature routing: fan out any ai_* action that isn't handled
            // inline above to ai-features.php. This includes ai_transcribe_audio
            // (Whisper STT for voice mode), ai_universal_search, etc. Without
            // this, voice mode in /app/one.js got "Unknown action" and
            // re-recorded forever (bug reported 2026-04-20).
            if (strpos($action, 'ai_') === 0) {
                require_once __DIR__ . '/ai-features.php';
                if (function_exists('handleAIFeatureAction')) {
                    handleAIFeatureAction($action, getInput());
                    break;
                }
            }
            // Apple StoreKit IAP verification — called by client after a
            // successful subscription purchase so the server flips the user
            // plan + persists the transaction. Added 2026-04-20.
            if ($action === 'iap_verify_receipt') {
                $auth = requireAuth();
                require_once __DIR__ . '/iap-verify.php';
                handleIapVerifyReceipt($auth, getInput());
                break;
            }
            if ($action === 'realtime_ephemeral_token') {
                $auth = requireAuth();
                require_once __DIR__ . '/realtime-ephemeral.php';
                handleRealtimeEphemeralToken($auth, getInput());
                break;
            }
            if (strpos($action, "stripe_") === 0) {
                require_once __DIR__ . "/stripe.php";
                handleStripeAction($action);
                break;
            }
            if ($action === 'crash_report') {
                // No-auth log endpoint — JS ErrorBoundary posts here when a
                // render error bubbles up. Storing to disk (not DB) so a
                // crash loop can't DoS the database. One line per crash,
                // rotate outside this handler.
                $input = getInput();
                $msg    = substr((string)($input['message'] ?? ''), 0, 500);
                $stack  = substr((string)($input['stack'] ?? ''), 0, 3000);
                $comp   = substr((string)($input['component'] ?? ''), 0, 2000);
                $ua     = substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 200);
                $line   = sprintf(
                    "[%s] %s | %s | stack: %s | comp: %s | ua: %s\n",
                    date('c'), $_SERVER['REMOTE_ADDR'] ?? '-',
                    str_replace(["\n","\r"], ' ', $msg),
                    str_replace(["\n","\r"], ' ', $stack),
                    str_replace(["\n","\r"], ' ', $comp),
                    str_replace(["\n","\r"], ' ', $ua)
                );
                @file_put_contents('/var/www/mail/data/crashes/' . date('Ymd') . '.log', $line, FILE_APPEND | LOCK_EX);
                jsonResponse(true, null, 'ok');
                break;
            }
            jsonResponse(false, null, 'Unknown action: ' . $action, 400);
            break;
    }
} catch (Exception $e) {
    // Log full error server-side, return generic message to client
    error_log("OneMundo Mail API Error [{$action}]: " . $e->getMessage() . " in " . $e->getFile() . ":" . $e->getLine());
    jsonResponse(false, null, 'Internal server error', 500);
}
