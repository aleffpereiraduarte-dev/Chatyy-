#!/usr/bin/env python3
"""Apply chat.php fixes for chat_privacy_set + reaction push notification data fields."""
import sys
import os

PATH = "/var/www/mail/api/chat.php"

with open(PATH, "r", encoding="utf-8") as f:
    src = f.read()

orig_len = len(src)

# ============================================================
# FIX 1: chat_privacy_set
# ============================================================
OLD_PRIVACY = """        case 'chat_privacy_set': {
            $user = requireChatAuth();
            $valid = ['everyone', 'contacts', 'nobody'];
            // phone_visibility uses 'all'/'contacts'/'nobody' shape — same
            // semantics with a different first label to match WhatsApp UI.
            $validPhone = ['all', 'contacts', 'nobody'];
            $lsIn = $input['last_seen']     ?? 'everyone';
            $ppIn = $input['profile_photo'] ?? 'everyone';
            $abIn = $input['about']         ?? 'everyone';
            $gaIn = $input['group_add']     ?? 'everyone';
            $pvIn = $input['phone_visibility'] ?? null;
            $lastSeen = in_array($lsIn, $valid, true) ? $lsIn : 'everyone';
            $photo    = in_array($ppIn, $valid, true) ? $ppIn : 'everyone';
            $about    = in_array($abIn, $valid, true) ? $abIn : 'everyone';
            $groupAdd = in_array($gaIn, $valid, true) ? $gaIn : 'everyone';
            $rrIn = $input['read_receipts'] ?? true;
            $reads = (is_bool($rrIn) ? $rrIn : (int)$rrIn === 1) ? 1 : 0;
            // Telegram Cloud parity. When OFF, new conversations created by
            // this user inherit cloud_storage=false (chat_send relays via WS
            // only, no PG persist — peers store locally). null = unchanged.
            $ccIn = array_key_exists('cloud_chats_default', $input) ? $input['cloud_chats_default'] : null;
            $cloudDefault = null;
            if ($ccIn !== null) {
                $cloudDefault = (is_bool($ccIn) ? $ccIn : (int)$ccIn === 1) ? 1 : 0;
            }
            try { $db->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS group_add TEXT NOT NULL DEFAULT 'everyone'"); } catch (Throwable $_) {}
            try { $db->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS phone_visibility TEXT DEFAULT 'contacts'"); } catch (Throwable $_) {}
            try { $db->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS cloud_chats_default BOOLEAN DEFAULT TRUE"); } catch (Throwable $_) {}
            $db->prepare("INSERT INTO chat_user_privacy (email, last_seen, online, profile_photo, status, about, read_receipts, group_add, updated_at)
                          VALUES (:e, :ls, 'everyone', :pp, 'everyone', :ab, :rr, :ga, (now() AT TIME ZONE 'UTC')::text)
                          ON CONFLICT (email) DO UPDATE SET last_seen = EXCLUDED.last_seen, profile_photo = EXCLUDED.profile_photo, about = EXCLUDED.about, read_receipts = EXCLUDED.read_receipts, group_add = EXCLUDED.group_add, updated_at = (now() AT TIME ZONE 'UTC')::text")
               ->execute([':e' => $user['email'], ':ls' => $lastSeen, ':pp' => $photo, ':ab' => $about, ':rr' => $reads, ':ga' => $groupAdd]);
            // phone_visibility is updated separately when the client sends it,
            // so users who never expose this option don't have their existing
            // value clobbered by a default on every privacy_set call.
            $phoneVisOut = null;
            if ($pvIn !== null) {
                $pv = in_array($pvIn, $validPhone, true) ? $pvIn : 'contacts';
                try {
                    $db->prepare("UPDATE chat_user_privacy SET phone_visibility = :pv, updated_at = (now() AT TIME ZONE 'UTC')::text WHERE LOWER(email) = LOWER(:e)")
                       ->execute([':pv' => $pv, ':e' => $user['email']]);
                    $phoneVisOut = $pv;
                } catch (\\Throwable $e) { error_log('[chat_privacy_set/phone_visibility] ' . $e->getMessage()); }
            }
            // cloud_chats_default — same partial-update pattern. When the
            // client sends explicitly we persist; otherwise the existing
            // value is left untouched.
            $cloudOut = null;
            if ($cloudDefault !== null) {
                try {
                    $db->prepare("UPDATE chat_user_privacy SET cloud_chats_default = :cc, updated_at = (now() AT TIME ZONE 'UTC')::text WHERE LOWER(email) = LOWER(:e)")
                       ->execute([':cc' => $cloudDefault ? 'true' : 'false', ':e' => $user['email']]);
                    $cloudOut = (bool)$cloudDefault;
                } catch (\\Throwable $e) { error_log('[chat_privacy_set/cloud_chats_default] ' . $e->getMessage()); }
            }
            $resp = ['last_seen' => $lastSeen, 'profile_photo' => $photo, 'about' => $about, 'read_receipts' => (bool)$reads, 'group_add' => $groupAdd];
            if ($phoneVisOut !== null) $resp['phone_visibility'] = $phoneVisOut;
            if ($cloudOut !== null)    $resp['cloud_chats_default'] = $cloudOut;
            jsonResponse(true, $resp);
            break;
        }"""

NEW_PRIVACY = """        case 'chat_privacy_set': {
            $user = requireChatAuth();
            // 'except' = visible to everyone EXCEPT the listed contacts.
            // Persisted in chat_user_privacy_contacts(email, contact_email,
            // field, visibility='hide') so reader-side joins reuse the same
            // table that already drives chat_privacy_contact_set.
            $valid = ['everyone', 'contacts', 'nobody', 'except'];
            // phone_visibility uses 'all'/'contacts'/'nobody' shape — same
            // semantics with a different first label to match WhatsApp UI.
            $validPhone = ['all', 'contacts', 'nobody', 'except'];
            $lsIn = $input['last_seen']        ?? 'everyone';
            $ppIn = $input['profile_photo']    ?? 'everyone';
            $abIn = $input['about']            ?? 'everyone';
            $gaIn = $input['group_add']        ?? 'everyone';
            $onIn = $input['online']           ?? 'everyone';
            $spIn = $input['story_privacy']    ?? 'everyone';
            $pvIn = $input['phone_visibility'] ?? null;
            $lastSeen = in_array($lsIn, $valid, true) ? $lsIn : 'everyone';
            $photo    = in_array($ppIn, $valid, true) ? $ppIn : 'everyone';
            $about    = in_array($abIn, $valid, true) ? $abIn : 'everyone';
            $groupAdd = in_array($gaIn, $valid, true) ? $gaIn : 'everyone';
            $online   = in_array($onIn, $valid, true) ? $onIn : 'everyone';
            $story    = in_array($spIn, $valid, true) ? $spIn : 'everyone';
            $rrIn = $input['read_receipts'] ?? true;
            $reads = (is_bool($rrIn) ? $rrIn : (int)$rrIn === 1) ? 1 : 0;
            // Telegram Cloud parity. When OFF, new conversations created by
            // this user inherit cloud_storage=false (chat_send relays via WS
            // only, no PG persist — peers store locally). null = unchanged.
            $ccIn = array_key_exists('cloud_chats_default', $input) ? $input['cloud_chats_default'] : null;
            $cloudDefault = null;
            if ($ccIn !== null) {
                $cloudDefault = (is_bool($ccIn) ? $ccIn : (int)$ccIn === 1) ? 1 : 0;
            }
            try { $db->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS group_add TEXT NOT NULL DEFAULT 'everyone'"); } catch (Throwable $_) {}
            try { $db->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS phone_visibility TEXT DEFAULT 'contacts'"); } catch (Throwable $_) {}
            try { $db->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS cloud_chats_default BOOLEAN DEFAULT TRUE"); } catch (Throwable $_) {}
            try { $db->exec("ALTER TABLE chat_user_privacy ADD COLUMN IF NOT EXISTS story_privacy TEXT NOT NULL DEFAULT 'everyone'"); } catch (Throwable $_) {}
            $db->prepare("INSERT INTO chat_user_privacy (email, last_seen, online, profile_photo, status, about, read_receipts, group_add, story_privacy, updated_at)
                          VALUES (:e, :ls, :on, :pp, 'everyone', :ab, :rr, :ga, :sp, (now() AT TIME ZONE 'UTC')::text)
                          ON CONFLICT (email) DO UPDATE SET last_seen = EXCLUDED.last_seen, online = EXCLUDED.online, profile_photo = EXCLUDED.profile_photo, about = EXCLUDED.about, read_receipts = EXCLUDED.read_receipts, group_add = EXCLUDED.group_add, story_privacy = EXCLUDED.story_privacy, updated_at = (now() AT TIME ZONE 'UTC')::text")
               ->execute([':e' => $user['email'], ':ls' => $lastSeen, ':on' => $online, ':pp' => $photo, ':ab' => $about, ':rr' => $reads, ':ga' => $groupAdd, ':sp' => $story]);
            // phone_visibility is updated separately when the client sends it,
            // so users who never expose this option don't have their existing
            // value clobbered by a default on every privacy_set call.
            $phoneVisOut = null;
            if ($pvIn !== null) {
                $pv = in_array($pvIn, $validPhone, true) ? $pvIn : 'contacts';
                try {
                    $db->prepare("UPDATE chat_user_privacy SET phone_visibility = :pv, updated_at = (now() AT TIME ZONE 'UTC')::text WHERE LOWER(email) = LOWER(:e)")
                       ->execute([':pv' => $pv, ':e' => $user['email']]);
                    $phoneVisOut = $pv;
                } catch (\\Throwable $e) { error_log('[chat_privacy_set/phone_visibility] ' . $e->getMessage()); }
            }
            // cloud_chats_default — same partial-update pattern. When the
            // client sends explicitly we persist; otherwise the existing
            // value is left untouched.
            $cloudOut = null;
            if ($cloudDefault !== null) {
                try {
                    $db->prepare("UPDATE chat_user_privacy SET cloud_chats_default = :cc, updated_at = (now() AT TIME ZONE 'UTC')::text WHERE LOWER(email) = LOWER(:e)")
                       ->execute([':cc' => $cloudDefault ? 'true' : 'false', ':e' => $user['email']]);
                    $cloudOut = (bool)$cloudDefault;
                } catch (\\Throwable $e) { error_log('[chat_privacy_set/cloud_chats_default] ' . $e->getMessage()); }
            }
            // 'except' lists — persist per-field excluded contacts so the
            // reader-side visibility check has the same shape regardless of
            // which field is in 'except' mode. We wipe + reinsert per field
            // only when the client sent a value for that field in this call
            // (avoids clobbering an unrelated field's list).
            $exceptMap = [
                'last_seen'     => $lastSeen,
                'profile_photo' => $photo,
                'about'         => $about,
                'group_add'     => $groupAdd,
                'online'        => $online,
                'story_privacy' => $story,
            ];
            if ($phoneVisOut !== null) $exceptMap['phone_visibility'] = $phoneVisOut;
            $exceptOut = [];
            $rawExcept = $input['_except_emails'] ?? null;
            foreach ($exceptMap as $field => $mode) {
                // Only touch the per-field exclusion list when the client
                // sent that field in this request — otherwise leave the row
                // alone (partial updates).
                if (!array_key_exists($field, $input)) continue;
                try {
                    $db->prepare("DELETE FROM chat_user_privacy_contacts WHERE LOWER(email) = LOWER(:e) AND field = :f")
                       ->execute([':e' => $user['email'], ':f' => $field]);
                } catch (\\Throwable $e) { error_log('[chat_privacy_set/except.del] ' . $e->getMessage()); }
                if ($mode !== 'except') continue;
                // Accept either a flat _except_emails array (applies to every
                // field currently set to 'except') or a per-field map like
                // _except_emails: { profile_photo: ['a@b','c@d'] }.
                $list = [];
                if (is_array($rawExcept)) {
                    if (isset($rawExcept[$field]) && is_array($rawExcept[$field])) {
                        $list = $rawExcept[$field];
                    } elseif (!empty($rawExcept) && array_keys($rawExcept) === range(0, count($rawExcept) - 1)) {
                        // Indexed array — flat list applies to all 'except' fields.
                        $list = $rawExcept;
                    }
                }
                $clean = [];
                foreach ($list as $ex) {
                    $ex = strtolower(trim((string)$ex));
                    if ($ex === '' || !filter_var($ex, FILTER_VALIDATE_EMAIL)) continue;
                    $clean[$ex] = true;
                }
                $clean = array_keys($clean);
                if (!empty($clean)) {
                    $ins = $db->prepare("INSERT INTO chat_user_privacy_contacts (email, contact_email, field, visibility, updated_at) VALUES (:e, :c, :f, 'hide', (now() AT TIME ZONE 'UTC')::text) ON CONFLICT (email, contact_email, field) DO UPDATE SET visibility = 'hide', updated_at = EXCLUDED.updated_at");
                    foreach ($clean as $cEmail) {
                        try { $ins->execute([':e' => $user['email'], ':c' => $cEmail, ':f' => $field]); }
                        catch (\\Throwable $e) { error_log('[chat_privacy_set/except.ins] ' . $e->getMessage()); }
                    }
                }
                $exceptOut[$field] = $clean;
            }
            $resp = ['last_seen' => $lastSeen, 'profile_photo' => $photo, 'about' => $about, 'read_receipts' => (bool)$reads, 'group_add' => $groupAdd, 'online' => $online, 'story_privacy' => $story];
            if ($phoneVisOut !== null) $resp['phone_visibility'] = $phoneVisOut;
            if ($cloudOut !== null)    $resp['cloud_chats_default'] = $cloudOut;
            if (!empty($exceptOut))    $resp['_except_emails'] = $exceptOut;
            jsonResponse(true, $resp);
            break;
        }"""

if OLD_PRIVACY not in src:
    print("ERROR: chat_privacy_set block not found verbatim", file=sys.stderr)
    sys.exit(2)
src = src.replace(OLD_PRIVACY, NEW_PRIVACY, 1)
print("OK: chat_privacy_set patched")

# ============================================================
# FIX 2: reaction push — add conv_id + reactor aliases
# ============================================================
OLD_PUSH = """                            $pushData = [
                                'type'            => 'chat_reaction',
                                'conversation_id' => (string)$msg['conversation_id'],
                                'message_id'      => (string)$messageId,
                                'reactor_email'   => $user['email'],
                                'emoji'           => $displayEmoji,
                                'categoryId'      => 'chat_reaction',
                                'group_key'       => 'chat_' . (string)$msg['conversation_id'],
                                'thread_id'       => 'chat_' . (string)$msg['conversation_id'],
                            ];"""

NEW_PUSH = """                            $pushData = [
                                'type'            => 'chat_reaction',
                                'conversation_id' => (string)$msg['conversation_id'],
                                'conv_id'         => (string)$msg['conversation_id'],
                                'message_id'      => (string)$messageId,
                                'reactor_email'   => $user['email'],
                                'reactor'         => $user['email'],
                                'emoji'           => $displayEmoji,
                                'categoryId'      => 'chat_reaction',
                                'group_key'       => 'chat_' . (string)$msg['conversation_id'],
                                'thread_id'       => 'chat_' . (string)$msg['conversation_id'],
                            ];"""

if OLD_PUSH not in src:
    print("ERROR: reaction pushData block not found verbatim", file=sys.stderr)
    sys.exit(3)
src = src.replace(OLD_PUSH, NEW_PUSH, 1)
print("OK: reaction pushData patched")

tmp = PATH + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    f.write(src)
os.replace(tmp, PATH)
print(f"WROTE {PATH}  delta={len(src) - orig_len:+d} bytes  total={len(src)}")
