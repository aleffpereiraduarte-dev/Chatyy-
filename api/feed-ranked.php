<?php
/**
 * Ranked Feed Logic — included from email.php feed_list when algorithm=fyp.
 *
 * Variables available from parent scope:
 *   $pg        — PDO PG connection (getPGDB())
 *   $auth      — auth array (['email' => ...])
 *   $where     — already-built WHERE clause (with placeholders)
 *   $params    — bound params for $where
 *   $limit     — page size (1..50)
 *   $offset    — pagination offset
 *   $page      — current page (1..N)
 *
 * Algorithm: 30% sender affinity + 25% recency decay + 25% engagement
 * + 20% completion (video) / engagement proxy (image). Caps:
 *   - hide posts the viewer has marked "not_interested" or "hide".
 *   - downweight authors muted via feed_user_topics weight column.
 *   - diversity: no more than 2 consecutive posts from same author.
 *   - promoted posts (chat_feed_promotions, active window) get a
 *     1.5x score multiplier so non-followers see them more often.
 *
 * Notes:
 *   - candidate pool is 3x the page size capped at 60 so the ranker
 *     has enough rows to differentiate; finer pages just re-rank the
 *     same candidate pool further down.
 *   - this branch is invoked AFTER $where + $params are constructed
 *     in email.php, so the audience filter (follows / shared convs /
 *     QA-exclusion) is preserved automatically.
 */

$candidateLimit = max(60, $limit * 3);

// Wave 15: ensure required columns exist on the table. Idempotent
// ADD COLUMN IF NOT EXISTS — cheap to run on every call. Mirrors what
// feed_list / feed_create_post do in email.php.
try {
    @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS is_ad BOOLEAN DEFAULT FALSE");
    @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS is_promoted BOOLEAN DEFAULT FALSE");
    @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS promoted_until TIMESTAMP");
    @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS tagged_users TEXT");
    @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION");
    @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS location_lon DOUBLE PRECISION");
    @$pg->exec("ALTER TABLE chat_feed_posts ADD COLUMN IF NOT EXISTS location_name TEXT");
} catch (Throwable $_e) {}

try {
    // Pull candidate pool with raw counts (one query, three LEFT JOIN
    // aggregates). Same shape email.php uses + view_count + share_count.
    $rstmt = $pg->prepare("
        SELECT p.id, p.author_email, p.author_name, p.caption, p.media_type,
               p.media_urls, p.thumbnail_url, p.location, p.location_lat, p.location_lon, p.location_name,
               p.tagged_users, p.is_ad, p.is_promoted, p.promoted_until,
               p.created_at,
               p.video_hls_url, p.video_duration_ms, p.blurhash, p.image_variants,
               p.subtitles, p.repost_of_id, p.sound_id, p.allow_duet, p.allow_stitch,
               COALESCE(fl_count.cnt, 0) AS like_count,
               COALESCE(fc_count.cnt, 0) AS comment_count,
               COALESCE(fv_count.cnt, 0) AS view_count,
               COALESCE(share_count.cnt, 0) AS share_count,
               COALESCE(fl_user.cnt, 0) AS user_liked,
               COALESCE(fb_user.cnt, 0) AS user_bookmarked
        FROM chat_feed_posts p
        LEFT JOIN (SELECT post_id, COUNT(*) AS cnt FROM chat_feed_likes GROUP BY post_id) fl_count ON fl_count.post_id = p.id
        LEFT JOIN (SELECT post_id, COUNT(*) AS cnt FROM chat_feed_comments WHERE is_deleted = 0 GROUP BY post_id) fc_count ON fc_count.post_id = p.id
        LEFT JOIN (SELECT post_id, COUNT(*) AS cnt FROM chat_feed_views GROUP BY post_id) fv_count ON fv_count.post_id = p.id
        LEFT JOIN (SELECT post_id, COUNT(*) AS cnt FROM feed_interactions WHERE action = 'share' GROUP BY post_id) share_count ON share_count.post_id = p.id
        LEFT JOIN (SELECT post_id, COUNT(*) AS cnt FROM chat_feed_likes WHERE email = :uemail GROUP BY post_id) fl_user ON fl_user.post_id = p.id
        LEFT JOIN (SELECT post_id, COUNT(*) AS cnt FROM chat_feed_bookmarks WHERE email = :uemail2 GROUP BY post_id) fb_user ON fb_user.post_id = p.id
        WHERE {$where}
        ORDER BY p.created_at DESC
        LIMIT {$candidateLimit}
    ");
    // :ns_email (negative-signal filter) + any muted-word :mwN placeholders
    // are ALREADY in $params from email.php — we just append the two we own
    // (the user_liked + user_bookmarked subqueries).
    $rparams = array_merge($params, [
        ':uemail'  => $auth['email'],
        ':uemail2' => $auth['email'],
    ]);
    $rstmt->execute($rparams);
    $candidates = $rstmt->fetchAll(PDO::FETCH_ASSOC);

    // Sender affinity: last-30-days interaction count per author.
    $affinityStmt = $pg->prepare("
        SELECT fp.author_email, COUNT(*) AS cnt
        FROM feed_interactions fi
        JOIN chat_feed_posts fp ON fp.id = fi.post_id
        WHERE fi.user_email = :email AND fi.created_at > NOW() - INTERVAL '30 days'
        GROUP BY fp.author_email
    ");
    $affinityStmt->execute([':email' => $auth['email']]);
    $affinityMap = [];
    $maxAffinity = 1;
    foreach ($affinityStmt->fetchAll(PDO::FETCH_ASSOC) as $ar) {
        $cnt = (int)$ar['cnt'];
        $affinityMap[$ar['author_email']] = $cnt;
        if ($cnt > $maxAffinity) $maxAffinity = $cnt;
    }

    // Video completion map.
    $completionStmt = $pg->prepare("
        SELECT post_id,
               AVG(CASE WHEN video_duration_ms > 0
                   THEN LEAST(1.0, watch_duration_ms::float / video_duration_ms)
                   ELSE 0 END) AS avg_completion
        FROM feed_interactions
        WHERE action = 'watch' AND video_duration_ms > 0
        GROUP BY post_id
    ");
    $completionStmt->execute();
    $completionMap = [];
    foreach ($completionStmt->fetchAll(PDO::FETCH_ASSOC) as $cr) {
        $completionMap[(int)$cr['post_id']] = (float)$cr['avg_completion'];
    }

    // Paid promotion boost — chat_feed_promotions rows with is_active=1 and
    // ends_at > now() apply the row's boost_factor (default 1.5x) so the
    // ranker surfaces them to non-followers more often. Soft-fail when the
    // table doesn't exist yet (older deploys before feed_post_promote).
    $promoMap = [];
    try {
        $pStmt = $pg->query("SELECT post_id, MAX(boost_factor) AS bf FROM chat_feed_promotions WHERE is_active = 1 AND ends_at > now() GROUP BY post_id");
        foreach ($pStmt->fetchAll(PDO::FETCH_ASSOC) as $pr) {
            $promoMap[(int)$pr['post_id']] = (float)$pr['bf'];
        }
    } catch (Throwable $_e) { /* promotions table optional */ }

    // Topic penalties — feed_user_topics with weight < 1 downweights posts
    // whose caption contains the topic word. Topics are stored as plain
    // lower-case keywords; we do a case-insensitive substring match.
    $topicMap = [];
    try {
        $tStmt = $pg->prepare("SELECT topic, weight FROM feed_user_topics WHERE email = :email");
        $tStmt->execute([':email' => $auth['email']]);
        foreach ($tStmt->fetchAll(PDO::FETCH_ASSOC) as $tr) {
            $topicMap[strtolower($tr['topic'])] = (float)$tr['weight'];
        }
    } catch (Throwable $_e) { /* table is optional */ }

    // ── Wave 15: location + followed-hashtag boosts ───────────────────
    // 1) City match boost (1.2x): pull caller's city + each author's
    //    city, then bump posts whose author shares the same city.
    // 2) Followed-hashtag boost (1.3x): match against caption.
    $viewerCity = '';
    try {
        $cq = $pg->prepare("SELECT city FROM chat_user_profile WHERE LOWER(email) = LOWER(:e) LIMIT 1");
        $cq->execute([':e' => $auth['email']]);
        $viewerCity = trim((string)($cq->fetchColumn() ?: ''));
    } catch (Throwable $_e) {}

    $authorCity = [];
    if ($viewerCity !== '') {
        $authorEmails = array_values(array_unique(array_map(fn($p) => strtolower($p['author_email']), $candidates)));
        if (!empty($authorEmails)) {
            try {
                $in = implode(',', array_fill(0, count($authorEmails), '?'));
                $cs = $pg->prepare("SELECT LOWER(email) AS email, city FROM chat_user_profile WHERE LOWER(email) IN ($in)");
                $cs->execute($authorEmails);
                foreach ($cs->fetchAll(PDO::FETCH_ASSOC) as $r) {
                    if (!empty($r['city'])) $authorCity[$r['email']] = $r['city'];
                }
            } catch (Throwable $_e) {}
        }
    }

    $followedTags = [];
    try {
        @$pg->exec("CREATE TABLE IF NOT EXISTS chat_user_followed_hashtags (
            email TEXT NOT NULL,
            tag TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (email, tag)
        )");
        $ftq = $pg->prepare("SELECT tag FROM chat_user_followed_hashtags WHERE LOWER(email) = LOWER(:e)");
        $ftq->execute([':e' => $auth['email']]);
        $followedTags = $ftq->fetchAll(PDO::FETCH_COLUMN) ?: [];
    } catch (Throwable $_e) {}

    $now = time();
    $scored = [];
    foreach ($candidates as $row) {
        $pid = (int)$row['id'];
        $author = $row['author_email'];
        $likes = (int)$row['like_count'];
        $comments = (int)$row['comment_count'];
        $shares = (int)$row['share_count'];
        $views = max(1, (int)$row['view_count']);
        $createdTs = strtotime($row['created_at']);
        $hoursAgo = $createdTs > 0 ? max(0, ($now - $createdTs) / 3600.0) : 240;

        $affinity = isset($affinityMap[$author]) ? ($affinityMap[$author] / $maxAffinity) : 0;
        $recency = exp(-0.05 * $hoursAgo);
        $engagement = min(1.0, ($likes + $comments + $shares) / $views);
        $completion = $completionMap[$pid] ?? 0;
        if ($row['media_type'] !== 'video') {
            $completion = $engagement;
        }

        $score = 0.30 * $affinity
               + 0.25 * $recency
               + 0.25 * $engagement
               + 0.20 * $completion;

        // Apply topic-based downweight (default 1.0 = no change).
        if (!empty($topicMap) && !empty($row['caption'])) {
            $captionLower = mb_strtolower((string)$row['caption']);
            foreach ($topicMap as $topic => $weight) {
                if ($weight < 1.0 && $topic !== '' && mb_strpos($captionLower, $topic) !== false) {
                    $score *= $weight; // e.g. 0.7 = 30% penalty
                }
            }
        }

        // Wave 15: city match (1.2x) when viewer + author share a city.
        if ($viewerCity !== '' && isset($authorCity[strtolower($author)])) {
            if (strcasecmp(trim($authorCity[strtolower($author)]), $viewerCity) === 0) {
                $score *= 1.2;
            }
        }
        // Wave 15: followed-hashtag boost (1.3x), applied once per post
        // regardless of how many tags match.
        if (!empty($followedTags) && !empty($row['caption'])) {
            $caption = (string)$row['caption'];
            foreach ($followedTags as $ft) {
                if (preg_match('/(^|[^\w])#' . preg_quote($ft, '/') . '($|[^\w])/iu', $caption)) {
                    $score *= 1.3;
                    break;
                }
            }
        }

        // Paid promotion boost — applied LAST so it stacks on top of any
        // topic downweight (a promoted post you've muted topics in still
        // gets the boost; muting only nudges, promotion outright lifts).
        $isPromoted = false;
        if (isset($promoMap[$pid])) {
            $score *= $promoMap[$pid];
            $isPromoted = true;
        }
        // is_promoted column (set by feed_promote_post) — same 1.4x boost
        // as feed_explore_nearby. Coexists with the legacy
        // chat_feed_promotions row above.
        if (!empty($row['is_promoted']) && (!$row['promoted_until'] || strtotime($row['promoted_until']) > $now)) {
            $score *= 1.4;
            $isPromoted = true;
        }

        $row['_score'] = round($score, 6);
        $row['_author'] = $author;
        $row['_promoted'] = $isPromoted;
        $scored[] = $row;
    }

    // Sort by score desc.
    usort($scored, function ($a, $b) {
        return $b['_score'] <=> $a['_score'];
    });

    // Diversity: cap 2 consecutive posts per author.
    $diversified = [];
    $consecutiveAuthor = '';
    $consecutiveCount = 0;
    $deferred = [];
    foreach ($scored as $row) {
        if ($row['_author'] === $consecutiveAuthor) {
            $consecutiveCount++;
            if ($consecutiveCount > 2) {
                $deferred[] = $row;
                continue;
            }
        } else {
            $consecutiveAuthor = $row['_author'];
            $consecutiveCount = 1;
        }
        $diversified[] = $row;
    }
    $diversified = array_merge($diversified, $deferred);

    // Paginate.
    $pagedRows = array_slice($diversified, $offset, $limit);

    // Batch fetch original_post for reposts (parity with feed_list).
    $repostIds = array_values(array_unique(array_filter(array_map(fn($p) => (int)($p['repost_of_id'] ?? 0), $pagedRows))));
    $origMap = [];
    if (!empty($repostIds)) {
        try {
            $inR = implode(',', array_fill(0, count($repostIds), '?'));
            $st = $pg->prepare("SELECT id, author_email, author_name, caption, media_type, media_urls, thumbnail_url, created_at FROM chat_feed_posts WHERE id IN ($inR) AND is_deleted = 0");
            $st->execute($repostIds);
            foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $o) {
                $o['id'] = (int)$o['id'];
                $o['media_urls'] = function_exists('_cdnifyArray')
                    ? _cdnifyArray(json_decode($o['media_urls'] ?: '[]', true) ?: [])
                    : (json_decode($o['media_urls'] ?: '[]', true) ?: []);
                $o['thumbnail_url'] = function_exists('_cdnify') ? _cdnify($o['thumbnail_url'] ?? '') : ($o['thumbnail_url'] ?? '');
                $origMap[$o['id']] = $o;
            }
        } catch (Throwable $_e) {}
    }

    $posts = [];
    foreach ($pagedRows as $row) {
        $likeCount = (int)$row['like_count'];
        $commentCount = (int)$row['comment_count'];
        $mediaUrls = json_decode($row['media_urls'] ?? '[]', true) ?: [];
        if (function_exists('_cdnifyArray')) $mediaUrls = _cdnifyArray($mediaUrls);
        $thumbnail = $row['thumbnail_url'] ?? '';
        if (function_exists('_cdnify')) $thumbnail = _cdnify($thumbnail);
        $subs = $row['subtitles'] ?? null;
        if (!empty($subs)) {
            $dec = json_decode($subs, true);
            if (is_array($dec)) $subs = $dec;
        }
        // Wave 15: decode tagged_users (TEXT JSON array → PHP array).
        $tagged = [];
        if (!empty($row['tagged_users'])) {
            $tu = json_decode((string)$row['tagged_users'], true);
            if (is_array($tu)) $tagged = $tu;
        }
        $isAd = !empty($row['is_ad']);
        $sponsored = $isAd || !empty($row['_promoted']);
        $entry = [
            'id'              => (int)$row['id'],
            'author_email'    => $row['author_email'],
            'author_name'     => $row['author_name'],
            'caption'         => $row['caption'],
            'media_type'      => $row['media_type'],
            'media_urls'      => $mediaUrls,
            'thumbnail_url'   => $thumbnail,
            'location'        => $row['location'] ?? '',
            // Wave 15: structured location.
            'location_lat'    => isset($row['location_lat']) && $row['location_lat'] !== null ? (float)$row['location_lat'] : null,
            'location_lon'    => isset($row['location_lon']) && $row['location_lon'] !== null ? (float)$row['location_lon'] : null,
            'location_name'   => $row['location_name'] ?? '',
            'tagged_users'    => $tagged,
            'is_ad'           => $isAd,
            'sponsored'       => $sponsored,
            'created_at'      => $row['created_at'],
            'video_hls_url'   => $row['video_hls_url'] ?? '',
            'video_duration_ms' => (int)($row['video_duration_ms'] ?? 0),
            'blurhash'        => $row['blurhash'] ?? '',
            'image_variants'  => !empty($row['image_variants']) ? json_decode($row['image_variants'], true) : null,
            'subtitles'       => $subs,
            'repost_of_id'    => $row['repost_of_id'] ? (int)$row['repost_of_id'] : null,
            'likes'           => $likeCount,
            'likes_count'     => $likeCount,
            'like_count'      => $likeCount,
            'comments'        => $commentCount,
            'comments_count'  => $commentCount,
            'comment_count'   => $commentCount,
            'view_count'      => (int)($row['view_count'] ?? 0),
            'user_liked'      => (int)$row['user_liked'] > 0,
            'user_bookmarked' => (int)$row['user_bookmarked'] > 0,
            'sound_id'        => isset($row['sound_id']) && $row['sound_id'] !== '' ? (string)$row['sound_id'] : null,
            'allow_duet'      => (bool)($row['allow_duet'] ?? true),
            'allow_stitch'    => (bool)($row['allow_stitch'] ?? true),
            'score'           => $row['_score'],
            'is_promoted'     => !empty($row['_promoted']),
        ];
        if (!empty($row['repost_of_id']) && isset($origMap[(int)$row['repost_of_id']])) {
            $entry['original_post'] = $origMap[(int)$row['repost_of_id']];
        }
        $posts[] = $entry;
    }

    // ── Wave 15: ads insertion ────────────────────────────────────────
    // Inject 1 ad every FEED_AD_INTERVAL organic posts (default 7).
    // Pull a small ad pool ordered by recency. Skipped when there are
    // no organic posts on the page (no slots to fill).
    if (!empty($posts)) {
        try {
            $adStmt = $pg->prepare("
                SELECT id, author_email, author_name, caption, media_type, media_urls,
                       thumbnail_url, location, location_lat, location_lon, location_name,
                       tagged_users, created_at, video_hls_url, video_duration_ms, blurhash
                FROM chat_feed_posts
                WHERE is_deleted = 0 AND is_ad = TRUE
                  AND (published IS NULL OR published = TRUE)
                ORDER BY created_at DESC
                LIMIT 12
            ");
            $adStmt->execute();
            $adRows = $adStmt->fetchAll(PDO::FETCH_ASSOC);
            if (!empty($adRows)) {
                foreach ($adRows as &$ar) {
                    $au = json_decode($ar['media_urls'] ?? '[]', true) ?: [];
                    if (function_exists('_cdnifyArray')) $au = _cdnifyArray($au);
                    $ar = [
                        'id'              => (int)$ar['id'],
                        'author_email'    => $ar['author_email'],
                        'author_name'     => $ar['author_name'],
                        'caption'         => $ar['caption'],
                        'media_type'      => $ar['media_type'],
                        'media_urls'      => $au,
                        'thumbnail_url'   => function_exists('_cdnify') ? _cdnify($ar['thumbnail_url'] ?? '') : ($ar['thumbnail_url'] ?? ''),
                        'location'        => $ar['location'] ?? '',
                        'location_lat'    => isset($ar['location_lat']) && $ar['location_lat'] !== null ? (float)$ar['location_lat'] : null,
                        'location_lon'    => isset($ar['location_lon']) && $ar['location_lon'] !== null ? (float)$ar['location_lon'] : null,
                        'location_name'   => $ar['location_name'] ?? '',
                        'tagged_users'    => [],
                        'is_ad'           => true,
                        'sponsored'       => true,
                        'created_at'      => $ar['created_at'],
                        'likes' => 0, 'likes_count' => 0, 'like_count' => 0,
                        'comments' => 0, 'comments_count' => 0, 'comment_count' => 0,
                        'user_liked' => false, 'user_bookmarked' => false,
                    ];
                }
                unset($ar);
                $interval = (int)(getenv('FEED_AD_INTERVAL') ?: 7);
                if ($interval < 3) $interval = 7;
                $withAds = [];
                $adIdx = 0;
                foreach ($posts as $idx => $p) {
                    $withAds[] = $p;
                    if (($idx + 1) % $interval === 0 && $adIdx < count($adRows)) {
                        $withAds[] = $adRows[$adIdx];
                        $adIdx++;
                    }
                }
                $posts = $withAds;
            }
        } catch (Throwable $_adE) {
            error_log('[feed-ranked.ads] ' . $_adE->getMessage());
        }
    }

    jsonResponse(true, [
        'posts' => $posts,
        'page' => $page,
        'has_more' => ($offset + $limit) < count($diversified),
        'algorithm' => 'fyp',
    ]);
} catch (Throwable $e) {
    error_log('[feed-ranked] ' . $e->getMessage());
    jsonResponse(true, ['posts' => [], 'page' => $page, 'has_more' => false, 'algorithm' => 'fyp']);
}
