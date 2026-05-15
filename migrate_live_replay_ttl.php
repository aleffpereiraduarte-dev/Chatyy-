<?php
// Bug #978-6 — live replay 7-day TTL migration.
//
// Adds the `replay_expires_at` column to chat_live_sessions and backfills
// historical rows where save_replay=true and ended_at is set. From now on
// the chat.php `live_end_cf` handler should set this column when ending a
// live with save_replay=true (see TODO in the bug #978-6 commit message —
// that edit was sandbox-blocked from the worktree; apply it on the prod
// server directly).
//
// Run on prod with:
//   php /var/www/mail/migrate_live_replay_ttl.php
//
// Idempotent — safe to re-run.

require_once '/var/www/mail/api/db.php';

$pg = getPGDB();

echo "Adding replay_expires_at column...\n";
@$pg->exec("ALTER TABLE chat_live_sessions ADD COLUMN IF NOT EXISTS replay_expires_at TIMESTAMPTZ");
@$pg->exec("CREATE INDEX IF NOT EXISTS idx_chat_live_sessions_replay_expiry
            ON chat_live_sessions (replay_expires_at)
            WHERE replay_expires_at IS NOT NULL");
echo "Column + index ensured.\n";

// Backfill: any historical session that was saved (save_replay=true) and
// has an ended_at gets ended_at + 7d. Sessions that aren't supposed to be
// saved get NULL (the live_recordings_list query treats NULL as either
// 'never expires' or 'no replay' — depending on whether recording_url is
// populated, the existing query already gates on that).
echo "Backfilling expiry for save_replay=true rows...\n";
$stmt = $pg->prepare("
    UPDATE chat_live_sessions
       SET replay_expires_at = (ended_at::timestamptz + INTERVAL '7 days')
     WHERE save_replay = TRUE
       AND ended_at IS NOT NULL
       AND replay_expires_at IS NULL
");
$stmt->execute();
echo "Backfilled " . $stmt->rowCount() . " rows.\n";

// Diagnostic: how many active vs expired replays do we have right now?
$now = $pg->query("
    SELECT
      COUNT(*) FILTER (WHERE replay_expires_at IS NULL) AS no_ttl,
      COUNT(*) FILTER (WHERE replay_expires_at > NOW()) AS active,
      COUNT(*) FILTER (WHERE replay_expires_at <= NOW()) AS expired
    FROM chat_live_sessions
")->fetch(PDO::FETCH_ASSOC);
echo sprintf("Replay state: %d active, %d expired, %d without TTL.\n",
    (int)$now['active'], (int)$now['expired'], (int)$now['no_ttl']);

echo "Done.\n";
echo "\nNEXT STEPS (apply manually on prod):\n";
echo "1) In /var/www/mail/api/chat.php case 'live_end_cf', after the UPDATE\n";
echo "   that sets status='ended', add:\n";
echo "     if (\$saveReplay) {\n";
echo "       \$db->prepare(\"UPDATE chat_live_sessions\n";
echo "                     SET replay_expires_at = NOW() + INTERVAL '7 days'\n";
echo "                     WHERE id = :id\")->execute([':id' => \$sessionId]);\n";
echo "     }\n";
echo "2) In case 'live_recordings_list' add to the WHERE clause:\n";
echo "     AND (s.replay_expires_at IS NULL OR s.replay_expires_at > NOW())\n";
echo "3) Add a weekly cron that DELETEs CF Stream videos where\n";
echo "   replay_expires_at < NOW() and NULLs out recording_url/recording_mp4.\n";
