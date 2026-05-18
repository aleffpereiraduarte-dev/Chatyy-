#!/usr/bin/env python3
"""Apply chat.php patch: bypass premium gate in chat_react when the
sticker_url points to a row in custom_animated_emoji ("Meus emojis").

Custom animated emojis are user-created assets uploaded via
custom_emoji_upload. They share the same on-the-wire reaction format
as sticker reactions (sticker:<url> in the emoji column) but should
NOT be gated by Premium — the user owns the asset.
"""
import sys

PATH = "/var/www/mail/api/chat.php"

with open(PATH, "r", encoding="utf-8") as f:
    src = f.read()

orig_len = len(src)

OLD = """            if ($stickerUrl !== '') {
                $u = parse_url($stickerUrl);
                $okScheme = isset($u['scheme']) && in_array(strtolower($u['scheme']), ['http','https'], true);
                $okPath   = !isset($u['scheme']) && str_starts_with($stickerUrl, '/data/');
                if (!$okScheme && !$okPath) jsonResponse(false, null, 'invalid sticker_url', 400);
                if (strlen($stickerUrl) > 512) jsonResponse(false, null, 'sticker_url too long', 400);
                try {
                    require_once __DIR__ . '/plans.php';
                    $plan = getUserPlan($user['email']);
                    if (($plan['plan'] ?? 'free') === 'free') {
                        jsonResponse(false, null, 'Sticker reactions are a premium feature', 402);
                    }
                } catch (Throwable $e) { /* if plans subsystem fails, fall through to deny */
                    jsonResponse(false, null, 'Premium check unavailable', 503);
                }
                $emoji = 'sticker:' . $stickerUrl;
            } else {"""

NEW = """            if ($stickerUrl !== '') {
                $u = parse_url($stickerUrl);
                $okScheme = isset($u['scheme']) && in_array(strtolower($u['scheme']), ['http','https'], true);
                $okPath   = !isset($u['scheme']) && str_starts_with($stickerUrl, '/data/');
                if (!$okScheme && !$okPath) jsonResponse(false, null, 'invalid sticker_url', 400);
                if (strlen($stickerUrl) > 512) jsonResponse(false, null, 'sticker_url too long', 400);
                // Custom animated emoji ("Meus emojis") share the sticker
                // wire format but are NOT premium-gated — the user (or any
                // user) created the WebP via custom_emoji_upload and owns
                // the asset. Bypass the plan check when the URL matches a
                // custom_animated_emoji row; otherwise enforce premium.
                $isCustomEmoji = false;
                try {
                    $pgChk2 = $db->prepare("SELECT 1 FROM custom_animated_emoji WHERE webp_url = :u LIMIT 1");
                    $pgChk2->execute([':u' => $stickerUrl]);
                    $isCustomEmoji = (bool)$pgChk2->fetchColumn();
                } catch (Throwable $e) { /* table may not exist yet — fall through to premium gate */ }
                if (!$isCustomEmoji) {
                    try {
                        require_once __DIR__ . '/plans.php';
                        $plan = getUserPlan($user['email']);
                        if (($plan['plan'] ?? 'free') === 'free') {
                            jsonResponse(false, null, 'Sticker reactions are a premium feature', 402);
                        }
                    } catch (Throwable $e) { /* if plans subsystem fails, fall through to deny */
                        jsonResponse(false, null, 'Premium check unavailable', 503);
                    }
                }
                $emoji = 'sticker:' . $stickerUrl;
            } else {"""

if OLD not in src:
    if NEW.split("\n", 1)[0] in src and "$isCustomEmoji" in src:
        print("[chat_react custom_emoji] already patched — no-op")
        sys.exit(0)
    print("[chat_react custom_emoji] anchor NOT FOUND — refusing to write")
    sys.exit(1)

src = src.replace(OLD, NEW, 1)

with open(PATH, "w", encoding="utf-8") as f:
    f.write(src)

print(f"[chat_react custom_emoji] applied — {orig_len} → {len(src)} bytes")
