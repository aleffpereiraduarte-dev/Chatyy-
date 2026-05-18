#!/usr/bin/env python3
"""
Patch /var/www/mail/api/chat.php on the production server to inject
caller_avatar into the FCM/VoIP payloads of call_notify, chat_group_call,
and chat_call_invite, and to add the chatCallerAvatarUrl() helper.

Idempotent — bails early if already patched. Designed to be uploaded to
prod (e.g. via scp) and run as root.

Bug: 2026-05-18 — incoming-call screen showed only the letter "S" for a
"Suporte" call because the FCM payload never carried an avatar URL, so the
Android native UI (IncomingCallActivity.kt) fell through to the
single-letter gradient fallback. Now backend always ships caller_avatar
pointing at email.php?action=get_avatar, which renders either the real
photo OR a colored gradient PNG with proper initials.
"""
import re
import sys

PATH = '/var/www/mail/api/chat.php'

with open(PATH, 'r', encoding='utf-8') as f:
    src = f.read()

if 'function chatCallerAvatarUrl' in src:
    print('Already patched (chatCallerAvatarUrl present). No changes.')
    sys.exit(0)

# 1. Add chatCallerAvatarUrl() right after chatCallerIdentity().
helper = """

/**
 * Public absolute URL for a user's avatar. Used to populate `caller_avatar`
 * in FCM/VoIP call payloads so the native incoming-call UIs
 * (IncomingCallActivity / CallNotificationService / CallKit) can show the
 * caller's real photo instead of just an initials letter.
 *
 * When the user has no uploaded avatar, `get_avatar` falls back to a
 * server-rendered gradient PNG with their initials — still way better
 * than the bare single-letter gradient the native code drew before
 * (incident 2026-05-18: incoming-call screen showed only the letter "S"
 * for a "Suporte" call because the FCM payload never carried an avatar
 * URL, so the Android native UI hit the gradient+initial fallback).
 *
 * Pins `?v=<avatar_version>` when available so cache-bust stays in
 * lockstep with avatar uploads.
 */
function chatCallerAvatarUrl(string $email): string {
    static $cache = [];
    $key = strtolower(trim($email));
    if (isset($cache[$key])) return $cache[$key];
    if ($key === '' || strpos($key, '@') === false) return $cache[$key] = '';
    $domain = substr(strrchr($key, '@'), 1);
    $local  = strstr($key, '@', true);
    $v = 0;
    $path = "/var/mail/vhosts/{$domain}/{$local}/profile/data.json";
    if (is_readable($path)) {
        $j = json_decode(@file_get_contents($path), true);
        if (is_array($j) && !empty($j['avatar_version']) && is_numeric($j['avatar_version'])) {
            $v = (int)$j['avatar_version'];
        }
    }
    $url = 'https://chatyy.com.br/api/email.php?action=get_avatar&email=' . urlencode($key);
    if ($v > 0) $url .= '&v=' . $v;
    return $cache[$key] = $url;
}
"""

needle = "    return $cache[$email] = ['phone' => $phone, 'verified' => $verified];\n}\n"
if needle not in src:
    print('FATAL: chatCallerIdentity close brace not found verbatim - refusing to patch.', file=sys.stderr)
    sys.exit(2)
src = src.replace(needle, needle + helper, 1)

# 2. Inject 'caller_avatar' into each of the 3 $callData arrays.
patterns = [
    # call_notify
    (
        "                    'caller_name'     => $callerName,\n"
        "                    'caller_phone'    => $ci['phone'],",
        "                    'caller_name'     => $callerName,\n"
        "                    // [avatar-on-incoming, 2026-05-18] Native IncomingCallActivity\n"
        "                    // (Android) and CallNotificationService both expect this key\n"
        "                    // and fall back to a single-letter gradient when it's empty\n"
        "                    // - incident report: incoming \"Suporte\" call showed just \"S\".\n"
        "                    'caller_avatar'   => chatCallerAvatarUrl($user['email']),\n"
        "                    'caller_phone'    => $ci['phone'],"
    ),
    # chat_group_call
    (
        "                    'caller_name'      => $callerName,\n"
        "                    'caller_phone'     => $ci['phone'],",
        "                    'caller_name'      => $callerName,\n"
        "                    // [avatar-on-incoming, 2026-05-18] see call_notify above.\n"
        "                    'caller_avatar'    => chatCallerAvatarUrl($user['email']),\n"
        "                    'caller_phone'     => $ci['phone'],"
    ),
    # chat_call_invite
    (
        "                'caller_name'     => $callerName,\n"
        "                'caller_phone'    => $ci['phone'],",
        "                'caller_name'     => $callerName,\n"
        "                // [avatar-on-incoming, 2026-05-18] see call_notify above.\n"
        "                'caller_avatar'   => chatCallerAvatarUrl($user['email']),\n"
        "                'caller_phone'    => $ci['phone'],"
    ),
]

applied = 0
for old, new in patterns:
    if old in src:
        src = src.replace(old, new, 1)
        applied += 1
    else:
        print(f'WARN: pattern not found, skipped: {old[:80]!r}...', file=sys.stderr)

if applied == 0:
    print('FATAL: no payload patterns matched - refusing to write incomplete patch.', file=sys.stderr)
    sys.exit(3)

with open(PATH, 'w', encoding='utf-8') as f:
    f.write(src)

print(f'Patched OK. Payloads patched: {applied}/3')
print(f'caller_avatar occurrences now: {src.count("caller_avatar")}')
