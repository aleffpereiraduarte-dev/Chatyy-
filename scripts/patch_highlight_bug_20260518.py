#!/usr/bin/env python3
"""Patch prod chat.php for highlight-empty bug (2026-05-18).

Three surgical changes:
  1. status_list:  hard DELETE expired -> soft-archive rows referenced by highlights
  2. status_by_user: same guard
  3. status_highlight_list: compute real active_count, self-heal dead IDs, hide empty highlights

Idempotent: aborts cleanly if anchors are missing (already patched).
"""
import shutil, sys, time
src = '/var/www/mail/api/chat.php'
shutil.copy(src, src + '.bak.' + time.strftime('%Y%m%d_%H%M%S'))
with open(src, 'r') as f: data = f.read()

old1 = """            try { @$db->exec("ALTER TABLE chat_user_status ADD COLUMN IF NOT EXISTS archived_at TEXT"); } catch (Throwable $_) {}
            try { $db->exec("DELETE FROM chat_user_status WHERE expires_at < now()::text"); } catch (Throwable $e) {}
            // Load mute set so we can hide muted contacts' status from the top row."""
new1 = """            try { @$db->exec("ALTER TABLE chat_user_status ADD COLUMN IF NOT EXISTS archived_at TEXT"); } catch (Throwable $_) {}
            // [2026-05-18] Don't hard-delete rows referenced by any highlight —
            // soft-archive them so destaques continue resolving. Unreferenced
            // expired rows are still hard-deleted.
            try {
                $db->exec("UPDATE chat_user_status SET archived_at = (now() AT TIME ZONE 'UTC')::text
                    WHERE expires_at < now()::text AND archived_at IS NULL
                      AND id IN (SELECT DISTINCT (jsonb_array_elements_text(status_ids))::int
                                 FROM chat_status_highlights WHERE status_ids <> '[]'::jsonb)");
            } catch (Throwable $e) {}
            try { $db->exec("DELETE FROM chat_user_status WHERE expires_at < now()::text AND archived_at IS NULL"); } catch (Throwable $e) {}
            // Load mute set so we can hide muted contacts' status from the top row."""

old2 = """            if ($target === "") jsonResponse(false, null, "email required", 400);
            try { $db->exec("DELETE FROM chat_user_status WHERE expires_at < now()::text"); } catch (Throwable $e) {}"""
new2 = """            if ($target === "") jsonResponse(false, null, "email required", 400);
            // [2026-05-18] Soft-archive highlight-referenced rows; hard-delete the rest.
            try { @$db->exec("ALTER TABLE chat_user_status ADD COLUMN IF NOT EXISTS archived_at TEXT"); } catch (Throwable $_) {}
            try {
                $db->exec("UPDATE chat_user_status SET archived_at = (now() AT TIME ZONE 'UTC')::text
                    WHERE expires_at < now()::text AND archived_at IS NULL
                      AND id IN (SELECT DISTINCT (jsonb_array_elements_text(status_ids))::int
                                 FROM chat_status_highlights WHERE status_ids <> '[]'::jsonb)");
            } catch (Throwable $e) {}
            try { $db->exec("DELETE FROM chat_user_status WHERE expires_at < now()::text AND archived_at IS NULL"); } catch (Throwable $e) {}"""

old3 = """                $stmt = $db->prepare("SELECT id, owner_email, name, cover_url, status_ids, created_at FROM chat_status_highlights WHERE LOWER(owner_email) = LOWER(:e) ORDER BY created_at DESC LIMIT 200");
                $stmt->execute([':e' => $target]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
                foreach ($rows as &$r) {
                    $r['id'] = (int)$r['id'];
                    $ids = json_decode($r['status_ids'] ?: '[]', true);
                    $r['status_ids'] = is_array($ids) ? array_map('intval', $ids) : [];
                    $r['count'] = count($r['status_ids']);
                }
                jsonResponse(true, ['highlights' => $rows]);"""
new3 = """                $stmt = $db->prepare("SELECT id, owner_email, name, cover_url, status_ids, created_at FROM chat_status_highlights WHERE LOWER(owner_email) = LOWER(:e) ORDER BY created_at DESC LIMIT 200");
                $stmt->execute([':e' => $target]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

                // [2026-05-18] Self-heal + active_count. status_ids JSONB can hold
                // tombstone IDs (rows hard-deleted before the soft-archive guard).
                // Compute the real active count and prune dead IDs inline so the
                // frontend never sees a destaque that opens vazio.
                $allIds = [];
                foreach ($rows as $r) {
                    $ids = json_decode($r['status_ids'] ?: '[]', true);
                    if (is_array($ids)) foreach ($ids as $sid) { $allIds[(int)$sid] = true; }
                }
                $existSet = [];
                if (!empty($allIds)) {
                    $idList = array_keys($allIds);
                    $placeholders = implode(',', array_fill(0, count($idList), '?'));
                    try {
                        $q = $db->prepare("SELECT id FROM chat_user_status WHERE id IN ($placeholders) AND LOWER(email) = LOWER(?)");
                        $q->execute(array_merge($idList, [$target]));
                        foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $er) { $existSet[(int)$er['id']] = true; }
                    } catch (Throwable $e) { /* fall back to JSONB length */ }
                }

                $cleaned = [];
                foreach ($rows as &$r) {
                    $r['id'] = (int)$r['id'];
                    $ids = json_decode($r['status_ids'] ?: '[]', true);
                    $ids = is_array($ids) ? array_map('intval', $ids) : [];
                    $aliveIds = [];
                    foreach ($ids as $sid) { if (!empty($existSet[$sid])) $aliveIds[] = $sid; }
                    if (count($aliveIds) !== count($ids)) {
                        try {
                            $db->prepare("UPDATE chat_status_highlights SET status_ids = :s::jsonb WHERE id = :id")
                               ->execute([':s' => json_encode($aliveIds), ':id' => $r['id']]);
                        } catch (Throwable $e) {}
                    }
                    $r['status_ids'] = $aliveIds;
                    $r['count'] = count($aliveIds);
                    $r['active_count'] = count($aliveIds);
                    if ($r['active_count'] === 0) continue; // hide empty destaques
                    $cleaned[] = $r;
                }
                jsonResponse(true, ['highlights' => $cleaned]);"""

for i,(old,new) in enumerate([(old1,new1),(old2,new2),(old3,new3)], 1):
    c = data.count(old)
    if c == 0:
        print(f"Patch {i}: anchor missing (already applied?). Skipping.")
        continue
    if c > 1:
        print(f"Patch {i}: anchor found {c}× — refusing to patch.")
        sys.exit(1)
    data = data.replace(old, new)
    print(f"Patch {i}: applied.")

with open(src, 'w') as f: f.write(data)
print("OK done")
