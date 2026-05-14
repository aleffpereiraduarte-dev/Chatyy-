<?php
/**
 * Chatyy Photo ML — Google Photos-style ML features using OpenAI GPT-4o-mini Vision
 *
 * Standalone include for email.php. Depends on: jsonResponse(), getInput(),
 * $_SESSION['email'], drive.php (getDriveDB, _loadS3Config, s3Sign)
 */

// ============================================================
// CONSTANTS
// ============================================================
define('PHOTO_ML_RATE_LIMIT', 100);        // max analyses per hour per user
define('PHOTO_ML_BATCH_DELAY_US', 300000); // 300ms between batch API calls
define('PHOTO_ML_PRESIGN_EXPIRY', 300);    // 5 min presigned GET URL
define('PHOTO_ML_MODEL', 'gpt-4o-mini');   // ~6x cheaper than Claude Haiku

// ============================================================
// HELPERS
// ============================================================

/**
 * Load the OpenAI API key from env file.
 */
function _loadOpenAIKey(): string {
    static $key = null;
    if ($key !== null) return $key;

    $envFile = '/etc/mail-api.env';
    if (file_exists($envFile)) {
        foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#') continue;
            if (strpos($line, '=') !== false) {
                [$k, $v] = explode('=', $line, 2);
                $k = trim($k);
                $v = trim($v);
                if (!isset($_ENV[$k])) $_ENV[$k] = $v;
            }
        }
    }

    $key = $_ENV['OPENAI_API_KEY'] ?? '';
    return $key;
}

/**
 * Generate a public R2 URL for a file.
 * R2 bucket has public access via media.chatyy.com.br custom domain.
 */
function _s3PresignedGetUrl(string $s3Key, int $expires = 300): string {
    return s3PublicUrl($s3Key);
}

/**
 * Call OpenAI GPT-4o-mini Vision API to analyze a photo.
 * ~6x cheaper than Claude Haiku for vision tasks.
 * Returns parsed JSON analysis or null on failure.
 */
function _callVisionAPI(string $imageUrl, string $mimeType): ?array {
    $apiKey = _loadOpenAIKey();
    if (empty($apiKey)) return null;

    $prompt = 'Analyze this photo. Return JSON with: objects (array of detected objects), scene (description), colors (dominant colors array), people_count (number of people), has_faces (boolean), emotions (array, if people visible, else empty), activities (array of what\'s happening), location_type (indoor/outdoor/unknown), tags (searchable keywords array, minimum 10 tags). Be thorough with tags - include animals, objects, colors, activities, weather, time of day, etc. Return ONLY valid JSON, no markdown formatting.';

    $body = [
        'model' => PHOTO_ML_MODEL,
        'max_tokens' => 1024,
        'response_format' => ['type' => 'json_object'],
        'messages' => [
            [
                'role' => 'user',
                'content' => [
                    [
                        'type' => 'image_url',
                        'image_url' => ['url' => $imageUrl, 'detail' => 'low'],
                    ],
                    [
                        'type' => 'text',
                        'text' => $prompt,
                    ],
                ],
            ],
        ],
    ];

    $ch = curl_init('https://api.openai.com/v1/chat/completions');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'Authorization: Bearer ' . $apiKey,
        ],
        CURLOPT_POSTFIELDS => json_encode($body),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
    ]);

    $result = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($result === false || $httpCode < 200 || $httpCode >= 300) {
        error_log("OpenAI Vision API error: HTTP {$httpCode}, curl: {$curlErr}, body: " . substr((string)$result, 0, 500));
        return null;
    }

    $response = json_decode($result, true);
    $text = $response['choices'][0]['message']['content'] ?? '';
    if (empty($text)) {
        error_log("OpenAI Vision API: empty response");
        return null;
    }

    // Strip markdown code fences if present
    $text = preg_replace('/^```(?:json)?\s*/i', '', $text);
    $text = preg_replace('/\s*```\s*$/', '', $text);

    $analysis = json_decode($text, true);
    if (!$analysis) {
        error_log("OpenAI Vision API: failed to parse JSON: " . substr($text, 0, 500));
        return null;
    }

    return $analysis;
}

/**
 * Check rate limit for photo analysis.
 */
function _photoMlCheckRateLimit(string $email): bool {
    $dir = '/var/www/mail/data/rate_limits';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);

    $file = $dir . '/photo_ml_' . md5($email) . '.json';
    $now = time();
    $window = 3600; // 1 hour

    $data = [];
    if (file_exists($file)) {
        $raw = file_get_contents($file);
        $data = json_decode($raw, true) ?: [];
    }

    // Clean old entries
    $data = array_filter($data, fn($ts) => ($now - $ts) < $window);

    if (count($data) >= PHOTO_ML_RATE_LIMIT) {
        return false;
    }

    $data[] = $now;
    file_put_contents($file, json_encode(array_values($data)), LOCK_EX);
    return true;
}

/**
 * Ensure photo_labels column exists in files table.
 */
function _ensurePhotoLabelsColumn(\PDO $db): void {
    static $checked = false;
    if ($checked) return;
    try {
        $db->exec("ALTER TABLE drive_files ADD COLUMN photo_labels TEXT DEFAULT NULL");
    } catch (\Throwable $e) {
        // Column already exists — ignore
    }
    $checked = true;
}

// ============================================================
// ACTION HANDLER
// ============================================================
function handlePhotoMlAction(string $action): void {
    $email = $_SESSION['email'] ?? '';
    $input = getInput();

    if (empty($email)) {
        jsonResponse(false, null, 'Authentication required', 401);
    }

    $db = getDriveDB();
    _ensurePhotoLabelsColumn($db);

    switch ($action) {
        case 'photo_analyze':       photoMlAnalyze($db, $email, $input); break;
        case 'photo_analyze_batch': photoMlAnalyzeBatch($db, $email, $input); break;
        case 'photo_search_ml':     photoMlSearch($db, $email, $input); break;
        case 'photo_faces':         photoMlFaces($db, $email); break;
        case 'photo_suggest_tags':  photoMlSuggestTags($db, $email); break;
        case 'drive_memories':      photoMlMemories($db, $email); break;
        default:
            jsonResponse(false, null, 'Unknown photo ML action', 400);
    }
}

/**
 * drive_memories - Google Photos-grade "On this day" buckets.
 *
 * TIER 1 plan:
 *   - DOY-precise (±3 days) match against previous years' photos
 *   - Plus a "this_week" bucket of last 7 days' photos
 *   - Grouped by years-ago so frontend can render "1 ano atrás" / "2 anos atrás"
 *
 * Uses PG's EXTRACT(DOY ...) so leap years / month-edge cases work as long as
 * the original timestamp is preserved. Caps at 60 rows to keep the carousel
 * snappy on cold start.
 */
function photoMlMemories(\PDO $db, string $email): void {
    error_log('[memories] start email=' . $email);

    $buckets = [];

    // ----- Bucket A: same DOY ±3 days, more than 11 months ago, grouped per year -----
    try {
        $sql = "SELECT id, name, mime_type, disk_path, thumbnail_url, media_type,
                       width, height, source, starred, created_at, photo_labels
                  FROM drive_files
                 WHERE user_email = ?
                   AND is_trashed = 0
                   AND is_folder = 0
                   AND media_type = 'photo'
                   AND created_at IS NOT NULL
                   AND EXTRACT(DOY FROM created_at::timestamptz)
                       BETWEEN EXTRACT(DOY FROM NOW()) - 3
                           AND EXTRACT(DOY FROM NOW()) + 3
                   AND created_at::timestamptz < NOW() - INTERVAL '11 months'
              ORDER BY created_at DESC
                 LIMIT 60";
        $stmt = $db->prepare($sql);
        $stmt->execute([$email]);
        $rows = $stmt->fetchAll(\PDO::FETCH_ASSOC);

        // Group by years-ago. Use UTC year diff so DST jitter doesn't shift
        // a photo from "1 ano atrás" → "2 anos atrás".
        $byYear = [];
        $nowYear = (int)date('Y');
        foreach ($rows as $row) {
            $createdYear = (int)substr((string)$row['created_at'], 0, 4);
            if ($createdYear <= 0) continue;
            $yearsAgo = $nowYear - $createdYear;
            if ($yearsAgo < 1) continue;
            if (!isset($byYear[$yearsAgo])) $byYear[$yearsAgo] = [];
            $byYear[$yearsAgo][] = _memoriesFormatRow($row);
        }
        ksort($byYear); // 1 ano, 2 anos, ...
        foreach ($byYear as $yearsAgo => $photos) {
            $buckets[] = [
                'type'       => 'years_ago',
                'years'      => (int)$yearsAgo,
                'photos'     => $photos,
            ];
        }
        error_log('[memories] years_ago buckets=' . count($byYear) . ' rows=' . count($rows));
    } catch (\Throwable $e) {
        error_log('[memories] years_ago query failed: ' . $e->getMessage());
    }

    // ----- Bucket B: "Esta semana" - last 7 days, any year (just feel-good recents) -----
    try {
        $sql2 = "SELECT id, name, mime_type, disk_path, thumbnail_url, media_type,
                        width, height, source, starred, created_at, photo_labels
                   FROM drive_files
                  WHERE user_email = ?
                    AND is_trashed = 0
                    AND is_folder = 0
                    AND media_type = 'photo'
                    AND created_at IS NOT NULL
                    AND created_at::timestamptz >= NOW() - INTERVAL '7 days'
               ORDER BY created_at DESC
                  LIMIT 30";
        $stmt2 = $db->prepare($sql2);
        $stmt2->execute([$email]);
        $rows2 = $stmt2->fetchAll(\PDO::FETCH_ASSOC);
        if (!empty($rows2)) {
            $thisWeek = [];
            foreach ($rows2 as $row) {
                $thisWeek[] = _memoriesFormatRow($row);
            }
            $buckets[] = [
                'type'   => 'this_week',
                'photos' => $thisWeek,
            ];
            error_log('[memories] this_week rows=' . count($thisWeek));
        } else {
            error_log('[memories] this_week empty');
        }
    } catch (\Throwable $e) {
        error_log('[memories] this_week query failed: ' . $e->getMessage());
    }

    error_log('[memories] done buckets=' . count($buckets));
    jsonResponse(true, ['buckets' => $buckets]);
}

/**
 * Helper: shape a drive_files row into the photo card the frontend expects.
 * Mirrors the fields photos.js reads (id, thumbnail_url, created_at, ...) so
 * the existing carousel render keeps working without further changes.
 */
function _memoriesFormatRow(array $row): array {
    $diskPath  = $row['disk_path'] ?? '';
    $thumbRaw  = $row['thumbnail_url'] ?? '';
    $thumbUrl  = null;
    if ($thumbRaw !== '' && strpos($thumbRaw, 's3://') === 0) {
        $thumbUrl = 'https://media.chatyy.com.br/' . substr($thumbRaw, 5);
    } elseif ($thumbRaw !== '') {
        $thumbUrl = '/api/email.php?action=drive_thumb&id=' . (int)$row['id'];
    } elseif ($diskPath !== '' && strpos($diskPath, 's3://') === 0) {
        // Photos in R2: serve via CDN (same fallback _driveThumbUrl uses).
        $thumbUrl = 'https://media.chatyy.com.br/' . substr($diskPath, 5);
    }
    $cdnUrl = null;
    if ($diskPath !== '' && strpos($diskPath, 's3://') === 0) {
        $cdnUrl = 'https://media.chatyy.com.br/' . substr($diskPath, 5);
    }

    $labels = null;
    if (!empty($row['photo_labels'])) {
        $decoded = json_decode((string)$row['photo_labels'], true);
        if (is_array($decoded)) $labels = $decoded;
    }

    return [
        'id'            => (int)$row['id'],
        'name'          => $row['name'] ?? '',
        'mime_type'     => $row['mime_type'] ?? '',
        'media_type'    => $row['media_type'] ?? 'photo',
        'width'         => $row['width'] !== null ? (int)$row['width'] : null,
        'height'        => $row['height'] !== null ? (int)$row['height'] : null,
        'source'        => $row['source'] ?? 'upload',
        'starred'       => (int)($row['starred'] ?? 0),
        'created_at'    => $row['created_at'] ?? null,
        'thumbnail_url' => $thumbUrl,
        'cdn_url'       => $cdnUrl,
        'photo_labels'  => $labels,
    ];
}

// ============================================================
// ACTIONS
// ============================================================

/**
 * photo_analyze - Analyze a single photo using Claude Vision.
 */
function photoMlAnalyze(\PDO $db, string $email, array $input): void {
    $fileId = (int)($input['file_id'] ?? 0);
    if ($fileId <= 0) {
        jsonResponse(false, null, 'file_id required', 400);
    }

    // Rate limit
    if (!_photoMlCheckRateLimit($email)) {
        jsonResponse(false, null, 'Analysis rate limit exceeded (max 100/hour)', 429);
    }

    // Fetch file record
    $stmt = $db->prepare("SELECT id, name, mime_type, disk_path, media_type, photo_labels FROM drive_files WHERE id = ? AND user_email = ? AND is_trashed = 0 AND is_folder = 0");
    $stmt->execute([$fileId, $email]);
    $file = $stmt->fetch(\PDO::FETCH_ASSOC);

    if (!$file) {
        jsonResponse(false, null, 'File not found', 404);
    }

    // Must be a photo
    if ($file['media_type'] !== 'photo') {
        jsonResponse(false, null, 'File is not a photo', 400);
    }

    // Check if already analyzed
    if (!empty($file['photo_labels'])) {
        $existing = json_decode($file['photo_labels'], true);
        if ($existing) {
            jsonResponse(true, ['analysis' => $existing, 'cached' => true]);
            return;
        }
    }

    // Generate presigned URL for the image
    $diskPath = $file['disk_path'];
    if (strpos($diskPath, 's3://') !== 0) {
        jsonResponse(false, null, 'File not stored on S3', 400);
    }

    $s3Key = substr($diskPath, 5); // strip "s3://"
    $presignedUrl = _s3PresignedGetUrl($s3Key, PHOTO_ML_PRESIGN_EXPIRY);
    if (empty($presignedUrl)) {
        jsonResponse(false, null, 'Failed to generate S3 URL', 500);
    }

    // Call Claude Vision
    $analysis = _callVisionAPI($presignedUrl, $file['mime_type']);
    if ($analysis === null) {
        jsonResponse(false, null, 'Photo analysis failed. Please try again later.', 500);
    }

    // Save to DB
    $labelsJson = json_encode($analysis, JSON_UNESCAPED_UNICODE);
    $stmt = $db->prepare("UPDATE drive_files SET photo_labels = ?, updated_at = iso_now() WHERE id = ? AND user_email = ?");
    $stmt->execute([$labelsJson, $fileId, $email]);

    jsonResponse(true, ['analysis' => $analysis, 'cached' => false]);
}

/**
 * photo_analyze_batch - Analyze multiple photos in sequence.
 */
function photoMlAnalyzeBatch(\PDO $db, string $email, array $input): void {
    $limit = min(50, max(1, (int)($input['limit'] ?? 20)));

    // Find photos without labels
    $stmt = $db->prepare("
        SELECT id, name, mime_type, disk_path
        FROM drive_files
        WHERE user_email = ?
          AND is_trashed = 0
          AND is_folder = 0
          AND media_type = 'photo'
          AND photo_labels IS NULL
          AND disk_path LIKE 's3://%'
        ORDER BY created_at DESC
        LIMIT ?
    ");
    $stmt->execute([$email, $limit]);
    $photos = $stmt->fetchAll(\PDO::FETCH_ASSOC);

    if (empty($photos)) {
        jsonResponse(true, ['analyzed' => 0, 'message' => 'No unanalyzed photos found']);
        return;
    }

    $analyzed = 0;
    $errors = 0;

    foreach ($photos as $photo) {
        // Check rate limit for each call
        if (!_photoMlCheckRateLimit($email)) {
            break; // Stop batch if rate limited
        }

        $s3Key = substr($photo['disk_path'], 5);
        $presignedUrl = _s3PresignedGetUrl($s3Key, PHOTO_ML_PRESIGN_EXPIRY);
        if (empty($presignedUrl)) {
            $errors++;
            continue;
        }

        $analysis = _callVisionAPI($presignedUrl, $photo['mime_type']);
        if ($analysis === null) {
            $errors++;
            continue;
        }

        $labelsJson = json_encode($analysis, JSON_UNESCAPED_UNICODE);
        $stmt = $db->prepare("UPDATE drive_files SET photo_labels = ?, updated_at = iso_now() WHERE id = ? AND user_email = ?");
        $stmt->execute([$labelsJson, (int)$photo['id'], $email]);
        $analyzed++;

        // Delay between calls to avoid rate limits
        if ($analyzed < count($photos)) {
            usleep(PHOTO_ML_BATCH_DELAY_US);
        }
    }

    jsonResponse(true, [
        'analyzed' => $analyzed,
        'errors' => $errors,
        'remaining' => count($photos) - $analyzed - $errors,
    ]);
}

/**
 * photo_search_ml - Search photos by ML labels/tags.
 */
function photoMlSearch(\PDO $db, string $email, array $input): void {
    $query = trim($input['query'] ?? '');
    if (empty($query)) {
        jsonResponse(false, null, 'query required', 400);
    }

    $page  = max(1, (int)($input['page'] ?? 1));
    $limit = min(100, max(1, (int)($input['limit'] ?? 50)));
    $offset = ($page - 1) * $limit;

    // Split query into search terms
    $terms = preg_split('/\s+/', mb_strtolower($query));
    $terms = array_filter($terms, fn($t) => strlen($t) >= 2);
    if (empty($terms)) {
        jsonResponse(false, null, 'Search query too short', 400);
    }

    // Fetch all photos with labels for this user
    $stmt = $db->prepare("
        SELECT id, name, mime_type, size, disk_path, media_type, width, height,
               source, created_at, updated_at, photo_labels, starred
        FROM drive_files
        WHERE user_email = ?
          AND is_trashed = 0
          AND is_folder = 0
          AND media_type = 'photo'
          AND photo_labels IS NOT NULL
        ORDER BY created_at DESC
    ");
    $stmt->execute([$email]);
    $allPhotos = $stmt->fetchAll(\PDO::FETCH_ASSOC);

    // Score each photo against search terms
    $results = [];
    foreach ($allPhotos as $photo) {
        $labels = json_decode($photo['photo_labels'], true);
        if (!$labels) continue;

        $score = 0;
        $labelsLower = mb_strtolower(json_encode($labels, JSON_UNESCAPED_UNICODE));

        foreach ($terms as $term) {
            // Check specific fields with different weights
            // Tags (highest weight)
            if (!empty($labels['tags']) && is_array($labels['tags'])) {
                foreach ($labels['tags'] as $tag) {
                    if (stripos($tag, $term) !== false) {
                        $score += 3;
                        break;
                    }
                }
            }

            // Objects
            if (!empty($labels['objects']) && is_array($labels['objects'])) {
                foreach ($labels['objects'] as $obj) {
                    if (stripos($obj, $term) !== false) {
                        $score += 3;
                        break;
                    }
                }
            }

            // Scene
            if (!empty($labels['scene']) && stripos($labels['scene'], $term) !== false) {
                $score += 2;
            }

            // Colors
            if (!empty($labels['colors']) && is_array($labels['colors'])) {
                foreach ($labels['colors'] as $color) {
                    if (stripos($color, $term) !== false) {
                        $score += 1;
                        break;
                    }
                }
            }

            // Activities
            if (!empty($labels['activities']) && is_array($labels['activities'])) {
                foreach ($labels['activities'] as $activity) {
                    if (stripos($activity, $term) !== false) {
                        $score += 2;
                        break;
                    }
                }
            }

            // Location type
            if (!empty($labels['location_type']) && stripos($labels['location_type'], $term) !== false) {
                $score += 1;
            }

            // Emotions
            if (!empty($labels['emotions']) && is_array($labels['emotions'])) {
                foreach ($labels['emotions'] as $emotion) {
                    if (stripos($emotion, $term) !== false) {
                        $score += 1;
                        break;
                    }
                }
            }
        }

        if ($score > 0) {
            $results[] = [
                'id' => (int)$photo['id'],
                'name' => $photo['name'],
                'mime_type' => $photo['mime_type'],
                'size' => (int)$photo['size'],
                'disk_path' => $photo['disk_path'],
                'media_type' => $photo['media_type'],
                'width' => $photo['width'] ? (int)$photo['width'] : null,
                'height' => $photo['height'] ? (int)$photo['height'] : null,
                'source' => $photo['source'],
                'starred' => (bool)$photo['starred'],
                'created_at' => $photo['created_at'],
                'updated_at' => $photo['updated_at'],
                'score' => $score,
                'labels' => $labels,
            ];
        }
    }

    // Sort by relevance score descending
    usort($results, fn($a, $b) => $b['score'] <=> $a['score']);

    $total = count($results);
    $paged = array_slice($results, $offset, $limit);

    jsonResponse(true, [
        'files' => $paged,
        'total' => $total,
        'page' => $page,
        'pages' => (int)ceil($total / $limit),
        'query' => $query,
    ]);
}

/**
 * photo_faces - Get face clusters (photos grouped by people detected).
 */
function photoMlFaces(\PDO $db, string $email): void {
    // Fetch all photos with faces
    $stmt = $db->prepare("
        SELECT id, name, mime_type, size, disk_path, created_at, photo_labels
        FROM drive_files
        WHERE user_email = ?
          AND is_trashed = 0
          AND is_folder = 0
          AND media_type = 'photo'
          AND photo_labels IS NOT NULL
        ORDER BY created_at DESC
    ");
    $stmt->execute([$email]);
    $photos = $stmt->fetchAll(\PDO::FETCH_ASSOC);

    // Group by face characteristics
    $withFaces = [];
    $withoutFaces = [];

    foreach ($photos as $photo) {
        $labels = json_decode($photo['photo_labels'], true);
        if (!$labels) continue;

        $hasFaces = !empty($labels['has_faces']);
        $peopleCount = (int)($labels['people_count'] ?? 0);

        if ($hasFaces && $peopleCount > 0) {
            $withFaces[] = [
                'id' => (int)$photo['id'],
                'name' => $photo['name'],
                'mime_type' => $photo['mime_type'],
                'size' => (int)$photo['size'],
                'disk_path' => $photo['disk_path'],
                'created_at' => $photo['created_at'],
                'people_count' => $peopleCount,
                'emotions' => $labels['emotions'] ?? [],
            ];
        } else {
            $withoutFaces[] = [
                'id' => (int)$photo['id'],
                'name' => $photo['name'],
                'created_at' => $photo['created_at'],
            ];
        }
    }

    // Group photos by people count (simple clustering without face embeddings)
    $clusters = [];

    // Singles (1 person)
    $singles = array_filter($withFaces, fn($p) => $p['people_count'] === 1);
    if (!empty($singles)) {
        $singles = array_values($singles);
        $clusters[] = [
            'label' => 'Selfies & Portraits',
            'people_count' => 1,
            'photo_count' => count($singles),
            'cover_photo' => $singles[0] ?? null,
            'photos' => $singles,
        ];
    }

    // Couples (2 people)
    $couples = array_filter($withFaces, fn($p) => $p['people_count'] === 2);
    if (!empty($couples)) {
        $couples = array_values($couples);
        $clusters[] = [
            'label' => 'Two People',
            'people_count' => 2,
            'photo_count' => count($couples),
            'cover_photo' => $couples[0] ?? null,
            'photos' => $couples,
        ];
    }

    // Groups (3+ people)
    $groups = array_filter($withFaces, fn($p) => $p['people_count'] >= 3);
    if (!empty($groups)) {
        $groups = array_values($groups);
        $clusters[] = [
            'label' => 'Group Photos',
            'people_count' => '3+',
            'photo_count' => count($groups),
            'cover_photo' => $groups[0] ?? null,
            'photos' => $groups,
        ];
    }

    jsonResponse(true, [
        'clusters' => $clusters,
        'total_with_faces' => count($withFaces),
        'total_without_faces' => count($withoutFaces),
    ]);
}

/**
 * photo_suggest_tags - Get popular tags across user's photos.
 */
function photoMlSuggestTags(\PDO $db, string $email): void {
    $stmt = $db->prepare("
        SELECT photo_labels
        FROM drive_files
        WHERE user_email = ?
          AND is_trashed = 0
          AND is_folder = 0
          AND media_type = 'photo'
          AND photo_labels IS NOT NULL
    ");
    $stmt->execute([$email]);
    $rows = $stmt->fetchAll(\PDO::FETCH_ASSOC);

    $tagCounts = [];
    $objectCounts = [];
    $colorCounts = [];
    $locationCounts = [];
    $activityCounts = [];

    foreach ($rows as $row) {
        $labels = json_decode($row['photo_labels'], true);
        if (!$labels) continue;

        // Count tags
        if (!empty($labels['tags']) && is_array($labels['tags'])) {
            foreach ($labels['tags'] as $tag) {
                $tag = mb_strtolower(trim($tag));
                if (!empty($tag)) {
                    $tagCounts[$tag] = ($tagCounts[$tag] ?? 0) + 1;
                }
            }
        }

        // Count objects
        if (!empty($labels['objects']) && is_array($labels['objects'])) {
            foreach ($labels['objects'] as $obj) {
                $obj = mb_strtolower(trim($obj));
                if (!empty($obj)) {
                    $objectCounts[$obj] = ($objectCounts[$obj] ?? 0) + 1;
                }
            }
        }

        // Count colors
        if (!empty($labels['colors']) && is_array($labels['colors'])) {
            foreach ($labels['colors'] as $color) {
                $color = mb_strtolower(trim($color));
                if (!empty($color)) {
                    $colorCounts[$color] = ($colorCounts[$color] ?? 0) + 1;
                }
            }
        }

        // Count location types
        if (!empty($labels['location_type'])) {
            $loc = mb_strtolower(trim($labels['location_type']));
            $locationCounts[$loc] = ($locationCounts[$loc] ?? 0) + 1;
        }

        // Count activities
        if (!empty($labels['activities']) && is_array($labels['activities'])) {
            foreach ($labels['activities'] as $activity) {
                $activity = mb_strtolower(trim($activity));
                if (!empty($activity)) {
                    $activityCounts[$activity] = ($activityCounts[$activity] ?? 0) + 1;
                }
            }
        }
    }

    // Sort by frequency
    arsort($tagCounts);
    arsort($objectCounts);
    arsort($colorCounts);
    arsort($locationCounts);
    arsort($activityCounts);

    jsonResponse(true, [
        'tags' => array_slice($tagCounts, 0, 50, true),
        'objects' => array_slice($objectCounts, 0, 30, true),
        'colors' => array_slice($colorCounts, 0, 20, true),
        'locations' => $locationCounts,
        'activities' => array_slice($activityCounts, 0, 30, true),
        'total_analyzed' => count($rows),
    ]);
}
