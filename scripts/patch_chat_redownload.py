#!/usr/bin/env python3
"""Insert chat_redownload_media case into chat.php.

Idempotent: re-runs leave the file unchanged.
"""
import sys
import time
from pathlib import Path

CHAT_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/var/www/mail/api/chat.php")
SENTINEL = "case 'chat_redownload_media'"

ANCHOR_BEFORE = """            jsonResponse(true, ['unread_count' => (int)$row['total_unread']]);
            break;
        }

        // ============================================================
        // chat_favorite — Toggle pinned/favorite conversation
        // ============================================================
        case 'chat_favorite':
        case 'chat_pin_conversation': {"""

NEW_CASE = """            jsonResponse(true, ['unread_count' => (int)$row['total_unread']]);
            break;
        }

        // ============================================================
        // chat_redownload_media — Re-fetch a media URL that was evicted
        // from local cache. R2 retention is indefinite so this should
        // always succeed unless the message itself was hard-deleted.
        // Client flow:
        //   1. Local cache miss → render "tap to download" bubble
        //   2. Network attempt to original file_url 404s
        //   3. Client calls this endpoint with message_id
        //   4. Server returns fresh URL (R2 public > local origin > presigned GET)
        //   5. Client caches + replays
        // ============================================================
        case 'chat_redownload_media': {
            $user = requireChatAuth();
            $messageId = (int)($input['message_id'] ?? $_GET['message_id'] ?? 0);
            if (!$messageId) jsonResponse(false, null, 'message_id required', 400);

            // One-time idempotent column add — track LRU access for future
            // server-side cache decisions (e.g. cold-storage tier in R2).
            try { $db->exec("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS last_download_at TIMESTAMPTZ"); } catch (\\Throwable $_) {}

            $st = $db->prepare("SELECT id, conversation_id, sender_email, type, file_url, file_name, file_size, deleted_at, created_at FROM chat_messages WHERE id = :id");
            $st->execute([':id' => $messageId]);
            $msg = $st->fetch(\\PDO::FETCH_ASSOC);
            if (!$msg) jsonResponse(false, null, 'message not found', 404);
            if (!empty($msg['deleted_at'])) jsonResponse(false, null, 'message deleted', 410);

            // Auth — must be a member of the conversation. requireConversationMember
            // throws 403 itself, no need to wrap.
            requireConversationMember($db, (int)$msg['conversation_id'], $user['email']);

            $fileUrl = trim((string)($msg['file_url'] ?? ''));
            if ($fileUrl === '') jsonResponse(false, null, 'no media on this message', 404);

            // Three URL candidates, tried in order of preference:
            //   1. CDN public URL (media.chatyy.com.br/<key>) — fastest, edge-cached
            //   2. Original file_url (relative path served by origin nginx) — local fallback
            //   3. Presigned S3 GET — works even if R2 bucket goes private
            $resolved = null;
            $resolvedKind = null;

            // Candidate 1: R2 public CDN. Object key mirrors file_url with leading
            // slash stripped (see chat_upload r2Key construction).
            require_once __DIR__ . '/drive.php';
            $publicUrl = '';
            if (function_exists('s3PublicUrl')) {
                $objectKey = ltrim($fileUrl, '/');
                // file_url is sometimes already an absolute media.chatyy.com.br URL
                // for older rows that were re-uploaded. Skip the prefix in that case.
                if (preg_match('#^https?://#i', $fileUrl)) {
                    $parsed = parse_url($fileUrl);
                    $objectKey = ltrim($parsed['path'] ?? '', '/');
                }
                if ($objectKey !== '') {
                    try { $publicUrl = (string)s3PublicUrl($objectKey); } catch (\\Throwable $_) {}
                }
            }

            // HEAD the public CDN URL to confirm the object is still in R2.
            // 5-second timeout — if Cloudflare edge is slow we'd rather fall
            // through to presigned than block the response.
            if ($publicUrl !== '') {
                $ch = curl_init($publicUrl);
                curl_setopt_array($ch, [
                    CURLOPT_NOBODY         => true,
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_FOLLOWLOCATION => true,
                    CURLOPT_TIMEOUT        => 5,
                    CURLOPT_CONNECTTIMEOUT => 3,
                ]);
                curl_exec($ch);
                $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
                curl_close($ch);
                if ($code >= 200 && $code < 400) {
                    $resolved = $publicUrl;
                    $resolvedKind = 'cdn';
                }
            }

            // Candidate 2: local origin path. We can stat() since the file
            // would be under /var/www/mail. Only valid for relative URLs.
            if (!$resolved && $fileUrl !== '' && $fileUrl[0] === '/') {
                $localPath = '/var/www/mail' . $fileUrl;
                if (is_file($localPath) && filesize($localPath) > 0) {
                    // Return an absolute URL so the client doesn't have to know
                    // the base host. Same host the bubble already loads from.
                    $host = $_SERVER['HTTP_HOST'] ?? 'chatyy.com.br';
                    $resolved = 'https://' . $host . $fileUrl;
                    $resolvedKind = 'origin';
                }
            }

            // Candidate 3: presigned GET to the bucket. Works even if the CDN
            // hostname is down or the bucket is private. 1-hour expiry — long
            // enough for client to download but short enough to avoid leaking
            // long-lived URLs.
            if (!$resolved && function_exists('s3PresignUrl')) {
                $objectKey = ltrim($fileUrl, '/');
                if (preg_match('#^https?://#i', $fileUrl)) {
                    $parsed = parse_url($fileUrl);
                    $objectKey = ltrim($parsed['path'] ?? '', '/');
                }
                if ($objectKey !== '') {
                    try {
                        $signed = s3PresignUrl('GET', $objectKey, [], 3600);
                        if ($signed) {
                            $resolved = $signed;
                            $resolvedKind = 'presigned';
                        }
                    } catch (\\Throwable $_) {}
                }
            }

            if (!$resolved) {
                jsonResponse(false, [
                    'message_id'  => (int)$msg['id'],
                    'file_url'    => $fileUrl,
                ], 'media unavailable in any tier', 404);
            }

            // Bump LRU. Best-effort — failure here just means the next
            // cold-storage sweep might evict this row earlier. Never block
            // the user-facing response on it.
            try {
                $upd = $db->prepare("UPDATE chat_messages SET last_download_at = NOW() WHERE id = :id");
                $upd->execute([':id' => (int)$msg['id']]);
            } catch (\\Throwable $_) {}

            jsonResponse(true, [
                'message_id'  => (int)$msg['id'],
                'url'         => $resolved,
                'kind'        => $resolvedKind,
                'type'        => $msg['type'],
                'file_name'   => $msg['file_name'],
                'file_size'   => (int)$msg['file_size'],
                'created_at'  => $msg['created_at'],
                'expires_in'  => $resolvedKind === 'presigned' ? 3600 : 0,
            ]);
            break;
        }

        // ============================================================
        // chat_favorite — Toggle pinned/favorite conversation
        // ============================================================
        case 'chat_favorite':
        case 'chat_pin_conversation': {"""


def main():
    src = CHAT_PATH.read_text()
    if SENTINEL in src:
        print("already patched, no-op")
        return 0
    if ANCHOR_BEFORE not in src:
        print("ERROR: anchor not found", file=sys.stderr)
        return 1
    out = src.replace(ANCHOR_BEFORE, NEW_CASE, 1)
    backup = CHAT_PATH.with_suffix(".php.bak-redl-" + time.strftime("%Y%m%d-%H%M%S"))
    backup.write_text(src)
    CHAT_PATH.write_text(out)
    print(f"patched. backup at {backup}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
