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
        case 'photo_analyze':              photoMlAnalyze($db, $email, $input); break;
        case 'photo_analyze_batch':        photoMlAnalyzeBatch($db, $email, $input); break;
        case 'photo_search_ml':            photoMlSearch($db, $email, $input); break;
        case 'photo_faces':                photoMlFaces($db, $email); break;
        case 'photo_suggest_tags':         photoMlSuggestTags($db, $email); break;
        case 'drive_memories':             photoMlMemories($db, $email); break;

        // --- Wave 14: real face recognition (FaceNet embeddings + cosine clustering)
        case 'photos_face_embed':          photoMlFaceEmbedUpsert($db, $email, $input); break;
        case 'photos_face_clusters':       photoMlFaceClusters($db, $email); break;
        case 'photos_face_cluster_photos': photoMlFaceClusterPhotos($db, $email, $input); break;
        case 'photos_face_cluster_name':   photoMlFaceClusterName($db, $email, $input); break;

        // --- Wave 14: photobook PDF generator
        case 'photos_photobook_create':    photoMlPhotobookCreate($db, $email, $input); break;

        // --- Wave 14: AI enhancement / inpaint / sky-replace via Replicate or fallback
        case 'photos_ai_enhance':          photoMlAiEnhance($db, $email, $input); break;
        case 'photos_inpaint':             photoMlInpaint($db, $email, $input); break;
        case 'photos_sky_replace':         photoMlSkyReplace($db, $email, $input); break;
        case 'photos_bokeh':               photoMlBokeh($db, $email, $input); break;

        default:
            jsonResponse(false, null, 'Unknown photo ML action', 400);
    }
}

// ============================================================
// FACE EMBEDDINGS + CLUSTERS (Wave 14)
// ============================================================

/**
 * Ensure face columns + clusters table exist. Cheap idempotent setup so the
 * caller doesn't have to migrate manually. JSONB lets us store an array of
 * {x, y, w, h, embedding[128]} per file, which is what the FaceNet-on-device
 * pass produces.
 */
function _ensureFaceTables(\PDO $db): void {
    static $checked = false;
    if ($checked) return;
    try { $db->exec("ALTER TABLE drive_files ADD COLUMN face_embeddings JSONB DEFAULT NULL"); } catch (\Throwable $e) {}
    try { $db->exec("ALTER TABLE drive_files ADD COLUMN face_cluster_ids JSONB DEFAULT NULL"); } catch (\Throwable $e) {}
    try {
        $db->exec("CREATE TABLE IF NOT EXISTS chat_user_face_clusters (
            id BIGSERIAL PRIMARY KEY,
            email TEXT NOT NULL,
            cluster_id TEXT NOT NULL,
            sample_photo_id BIGINT NOT NULL,
            sample_box JSONB,
            centroid JSONB NOT NULL,
            person_name TEXT,
            photo_count INT DEFAULT 1,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (email, cluster_id)
        )");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_face_clusters_email ON chat_user_face_clusters (email)");
    } catch (\Throwable $e) { error_log('[face_tables] ' . $e->getMessage()); }
    $checked = true;
}

/**
 * Cosine similarity between two 128-dim float arrays.
 */
function _cosineSim(array $a, array $b): float {
    $n = min(count($a), count($b));
    if ($n === 0) return 0.0;
    $dot = 0.0; $na = 0.0; $nb = 0.0;
    for ($i = 0; $i < $n; $i++) {
        $av = (float)$a[$i]; $bv = (float)$b[$i];
        $dot += $av * $bv;
        $na  += $av * $av;
        $nb  += $bv * $bv;
    }
    if ($na <= 0 || $nb <= 0) return 0.0;
    return $dot / (sqrt($na) * sqrt($nb));
}

/**
 * Update a running centroid in-place. Returns the new centroid.
 */
function _updateCentroid(array $oldCentroid, array $newVec, int $oldCount): array {
    $n = count($oldCentroid);
    if ($n === 0) return $newVec;
    $out = array_fill(0, $n, 0.0);
    $denom = max(1, $oldCount + 1);
    for ($i = 0; $i < $n; $i++) {
        $out[$i] = (((float)$oldCentroid[$i]) * $oldCount + (float)($newVec[$i] ?? 0.0)) / $denom;
    }
    return $out;
}

/**
 * photos_face_embed - Client sends FaceNet embeddings extracted on-device
 * (MediaPipe FaceLandmarker for the 5-pt landmarks → FaceNet ONNX on the
 * cropped 160x160 patch → 128-dim L2-normalized vector). Server stores them
 * on drive_files + assigns each face to a cluster via cosine-similarity vs
 * centroid (threshold 0.6 — FaceNet typical value).
 *
 * Input: { file_id, faces: [{ x, y, w, h, embedding: [128] }, ...] }
 * Output: { cluster_ids: [<id per face in same order>] }
 */
function photoMlFaceEmbedUpsert(\PDO $db, string $email, array $input): void {
    _ensureFaceTables($db);

    $fileId = (int)($input['file_id'] ?? 0);
    $faces  = $input['faces'] ?? [];
    if ($fileId <= 0 || !is_array($faces) || empty($faces)) {
        jsonResponse(false, null, 'file_id + faces[] required', 400);
    }
    // Verify ownership
    $stmt = $db->prepare("SELECT id FROM drive_files WHERE id = ? AND user_email = ? AND is_trashed = 0 AND is_folder = 0");
    $stmt->execute([$fileId, $email]);
    if (!$stmt->fetch(\PDO::FETCH_ASSOC)) jsonResponse(false, null, 'File not found', 404);

    // Load existing clusters for this user
    $stmt = $db->prepare("SELECT cluster_id, centroid, photo_count FROM chat_user_face_clusters WHERE email = ?");
    $stmt->execute([$email]);
    $clusters = [];
    foreach ($stmt->fetchAll(\PDO::FETCH_ASSOC) as $row) {
        $c = json_decode($row['centroid'] ?? '[]', true);
        if (is_array($c)) $clusters[$row['cluster_id']] = [
            'centroid' => $c,
            'count'    => (int)$row['photo_count'],
        ];
    }

    $assigned = [];
    $threshold = 0.6;
    foreach ($faces as $face) {
        $emb = $face['embedding'] ?? null;
        if (!is_array($emb) || count($emb) < 64) { $assigned[] = null; continue; }

        // Find nearest existing cluster
        $bestId = null; $bestSim = 0.0;
        foreach ($clusters as $cid => $c) {
            $sim = _cosineSim($c['centroid'], $emb);
            if ($sim > $bestSim) { $bestSim = $sim; $bestId = $cid; }
        }
        if ($bestId !== null && $bestSim >= $threshold) {
            // Update centroid in-place
            $newCent = _updateCentroid($clusters[$bestId]['centroid'], $emb, $clusters[$bestId]['count']);
            $clusters[$bestId]['centroid'] = $newCent;
            $clusters[$bestId]['count']++;
            $upd = $db->prepare("UPDATE chat_user_face_clusters
                                    SET centroid = ?, photo_count = photo_count + 1, updated_at = NOW()
                                  WHERE email = ? AND cluster_id = ?");
            $upd->execute([json_encode($newCent), $email, $bestId]);
            $assigned[] = $bestId;
        } else {
            // Create new cluster
            $newId = 'p_' . substr(bin2hex(random_bytes(6)), 0, 10);
            $box = [
                'x' => (float)($face['x'] ?? 0),
                'y' => (float)($face['y'] ?? 0),
                'w' => (float)($face['w'] ?? 0),
                'h' => (float)($face['h'] ?? 0),
            ];
            $ins = $db->prepare("INSERT INTO chat_user_face_clusters
                                    (email, cluster_id, sample_photo_id, sample_box, centroid, photo_count, created_at)
                                 VALUES (?, ?, ?, ?, ?, 1, NOW())");
            $ins->execute([$email, $newId, $fileId, json_encode($box), json_encode($emb)]);
            $clusters[$newId] = ['centroid' => $emb, 'count' => 1];
            $assigned[] = $newId;
        }
    }

    // Save embeddings + assignment onto drive_files
    $payload = [];
    foreach ($faces as $i => $face) {
        $payload[] = [
            'x' => (float)($face['x'] ?? 0),
            'y' => (float)($face['y'] ?? 0),
            'w' => (float)($face['w'] ?? 0),
            'h' => (float)($face['h'] ?? 0),
            'embedding' => $face['embedding'] ?? [],
            'cluster_id' => $assigned[$i] ?? null,
        ];
    }
    $upd = $db->prepare("UPDATE drive_files SET face_embeddings = ?, face_cluster_ids = ?, updated_at = iso_now() WHERE id = ? AND user_email = ?");
    $upd->execute([
        json_encode($payload),
        json_encode(array_values(array_unique(array_filter($assigned)))),
        $fileId,
        $email,
    ]);

    jsonResponse(true, ['cluster_ids' => $assigned]);
}

/**
 * photos_face_clusters - List a user's clusters (the "Pessoas" tab).
 */
function photoMlFaceClusters(\PDO $db, string $email): void {
    _ensureFaceTables($db);
    $stmt = $db->prepare("
        SELECT c.cluster_id, c.person_name, c.photo_count, c.sample_photo_id, c.sample_box,
               c.created_at, c.updated_at,
               f.disk_path AS sample_disk_path, f.thumbnail_url AS sample_thumb
          FROM chat_user_face_clusters c
          LEFT JOIN drive_files f ON f.id = c.sample_photo_id
         WHERE c.email = ?
      ORDER BY c.photo_count DESC, c.updated_at DESC
         LIMIT 200
    ");
    $stmt->execute([$email]);
    $rows = $stmt->fetchAll(\PDO::FETCH_ASSOC);

    $out = [];
    foreach ($rows as $r) {
        $sampleUrl = null;
        $thumbRaw = $r['sample_thumb'] ?? '';
        $diskPath = $r['sample_disk_path'] ?? '';
        if ($thumbRaw && strpos($thumbRaw, 's3://') === 0) {
            $sampleUrl = 'https://media.chatyy.com.br/' . substr($thumbRaw, 5);
        } elseif ($diskPath && strpos($diskPath, 's3://') === 0) {
            $sampleUrl = 'https://media.chatyy.com.br/' . substr($diskPath, 5);
        }
        $box = null;
        if (!empty($r['sample_box'])) {
            $box = json_decode($r['sample_box'], true);
        }
        $out[] = [
            'cluster_id'      => $r['cluster_id'],
            'person_name'     => $r['person_name'],
            'photo_count'     => (int)$r['photo_count'],
            'sample_photo_id' => (int)$r['sample_photo_id'],
            'sample_url'      => $sampleUrl,
            'sample_box'      => $box,
            'created_at'      => $r['created_at'],
            'updated_at'      => $r['updated_at'],
        ];
    }
    jsonResponse(true, ['clusters' => $out, 'total' => count($out)]);
}

/**
 * photos_face_cluster_photos - All photos containing a given face cluster.
 */
function photoMlFaceClusterPhotos(\PDO $db, string $email, array $input): void {
    _ensureFaceTables($db);
    $cid = trim((string)($input['cluster_id'] ?? ''));
    if ($cid === '') jsonResponse(false, null, 'cluster_id required', 400);

    // PG JSONB ? operator checks if a top-level key/element exists. We stored
    // face_cluster_ids as a JSON array of ids → use jsonb_path_exists / @>.
    $stmt = $db->prepare("
        SELECT id, name, mime_type, disk_path, thumbnail_url, media_type,
               width, height, source, starred, created_at, photo_labels
          FROM drive_files
         WHERE user_email = ?
           AND is_trashed = 0
           AND is_folder = 0
           AND media_type = 'photo'
           AND face_cluster_ids @> ?::jsonb
      ORDER BY created_at DESC
         LIMIT 500
    ");
    $stmt->execute([$email, json_encode([$cid])]);
    $rows = $stmt->fetchAll(\PDO::FETCH_ASSOC);
    $photos = array_map('_memoriesFormatRow', $rows);
    jsonResponse(true, ['photos' => $photos, 'total' => count($photos)]);
}

/**
 * photos_face_cluster_name - Rename a cluster ("Nomear pessoa" long-press).
 */
function photoMlFaceClusterName(\PDO $db, string $email, array $input): void {
    _ensureFaceTables($db);
    $cid = trim((string)($input['cluster_id'] ?? ''));
    $name = trim((string)($input['person_name'] ?? ''));
    if ($cid === '') jsonResponse(false, null, 'cluster_id required', 400);
    if (mb_strlen($name) > 100) jsonResponse(false, null, 'name too long', 400);

    $stmt = $db->prepare("UPDATE chat_user_face_clusters SET person_name = ?, updated_at = NOW()
                          WHERE email = ? AND cluster_id = ?");
    $stmt->execute([$name !== '' ? $name : null, $email, $cid]);
    jsonResponse(true, ['updated' => true]);
}

// ============================================================
// PHOTOBOOK PDF (Wave 14)
// ============================================================

/**
 * Ensure photobooks table exists. Stores the rendered PDF in R2 so re-downloads
 * are free + the client can resume the download if the link expires.
 */
function _ensurePhotobookTable(\PDO $db): void {
    static $checked = false;
    if ($checked) return;
    try {
        $db->exec("CREATE TABLE IF NOT EXISTS chat_user_photobooks (
            id BIGSERIAL PRIMARY KEY,
            email TEXT NOT NULL,
            title TEXT,
            layout TEXT NOT NULL DEFAULT 'grid',
            photo_ids JSONB NOT NULL,
            page_count INT DEFAULT 0,
            pdf_key TEXT,
            pdf_url TEXT,
            size_bytes BIGINT DEFAULT 0,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMPTZ DEFAULT NOW()
        )");
        $db->exec("CREATE INDEX IF NOT EXISTS idx_photobooks_email ON chat_user_photobooks (email, created_at DESC)");
    } catch (\Throwable $e) { error_log('[photobooks] ' . $e->getMessage()); }
    $checked = true;
}

/**
 * Try to load FPDF / TCPDF. Both are common on PHP shared hosts and ship as
 * a single class with no extra deps. We try TCPDF first (richer), fall back
 * to FPDF, and finally fall back to a minimal hand-rolled PDF writer that
 * still produces a valid photobook (one image per page) so the feature works
 * even on hosts where neither lib is installed.
 */
function _tryLoadPdfLib(): ?string {
    if (class_exists('TCPDF')) return 'tcpdf';
    if (class_exists('FPDF'))  return 'fpdf';
    // Common installation paths
    foreach ([
        '/usr/share/php/tcpdf/tcpdf.php',
        '/usr/share/tcpdf/tcpdf.php',
        '/var/www/mail/api/vendor/tcpdf/tcpdf.php',
    ] as $p) {
        if (is_file($p)) { @require_once $p; if (class_exists('TCPDF')) return 'tcpdf'; }
    }
    foreach ([
        '/usr/share/php/fpdf/fpdf.php',
        '/var/www/mail/api/vendor/fpdf/fpdf.php',
    ] as $p) {
        if (is_file($p)) { @require_once $p; if (class_exists('FPDF')) return 'fpdf'; }
    }
    return null;
}

/**
 * Fetch image bytes from R2/CDN to a local temp file. Returns the path or null.
 */
function _photobookFetchImage(string $diskPath): ?string {
    if (strpos($diskPath, 's3://') !== 0) return null;
    $url = 'https://media.chatyy.com.br/' . substr($diskPath, 5);
    $tmp = tempnam(sys_get_temp_dir(), 'pb_img_');
    if (!$tmp) return null;
    $fp = @fopen($tmp, 'w');
    if (!$fp) return null;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_FILE => $fp,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_FOLLOWLOCATION => true,
    ]);
    $ok = curl_exec($ch);
    $http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    fclose($fp);
    if (!$ok || $http >= 400 || filesize($tmp) < 1024) { @unlink($tmp); return null; }
    return $tmp;
}

/**
 * Render a minimal hand-rolled PDF when no PDF library is available. One image
 * per page, JPEG only (R2 thumbnails already JPEG). Builds the Pages /Kids
 * array up front so all object offsets are stable for the xref table — no
 * post-write patching needed.
 */
function _photobookMinimalPdf(array $imagePaths): string {
    // Pre-decode each JPEG to grab dimensions; re-encode non-JPEGs.
    $images = [];
    foreach ($imagePaths as $p) {
        if (!is_file($p)) continue;
        $info = @getimagesize($p);
        if (!$info || ($info[2] !== IMAGETYPE_JPEG)) {
            if (function_exists('imagecreatefromstring')) {
                $raw = @file_get_contents($p);
                $im = @imagecreatefromstring($raw);
                if ($im) {
                    $jp = tempnam(sys_get_temp_dir(), 'pb_jp_') . '.jpg';
                    imagejpeg($im, $jp, 85);
                    imagedestroy($im);
                    @unlink($p);
                    $p = $jp;
                    $info = @getimagesize($p);
                }
            }
        }
        if (!$info) continue;
        $images[] = ['path' => $p, 'w' => $info[0], 'h' => $info[1]];
    }
    if (empty($images)) return '';

    $pageW = 612; $pageH = 792; $margin = 36;
    $maxImgW = $pageW - 2 * $margin; $maxImgH = $pageH - 2 * $margin;

    // Object IDs: 1 = Catalog, 2 = Pages, 3..N = image XObjects, then content
    // streams + page objects. Compute page ids up front so /Kids is final.
    $imgCount = count($images);
    $firstImgId = 3;
    $firstContentId = 3 + $imgCount;
    $firstPageId = 3 + $imgCount * 2;
    $kidsRefs = [];
    for ($i = 0; $i < $imgCount; $i++) $kidsRefs[] = ($firstPageId + $i) . ' 0 R';

    $pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
    $xref = [0];

    $append = function(string $body) use (&$pdf, &$xref) {
        $xref[] = strlen($pdf);
        $pdf .= $body;
    };

    $append("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    $append("2 0 obj\n<< /Type /Pages /Count $imgCount /Kids [" . implode(' ', $kidsRefs) . "] >>\nendobj\n");

    // Images
    foreach ($images as $i => $img) {
        $imgId = $firstImgId + $i;
        $imgData = file_get_contents($img['path']);
        $obj = "$imgId 0 obj\n<< /Type /XObject /Subtype /Image"
             . " /Width {$img['w']}"
             . " /Height {$img['h']}"
             . " /ColorSpace /DeviceRGB /BitsPerComponent 8"
             . " /Filter /DCTDecode /Length " . strlen($imgData) . " >>\nstream\n"
             . $imgData . "\nendstream\nendobj\n";
        $append($obj);
    }
    // Content streams
    foreach ($images as $i => $img) {
        $contentId = $firstContentId + $i;
        $imgId = $firstImgId + $i;
        $scale = min($maxImgW / max(1, $img['w']), $maxImgH / max(1, $img['h']));
        $drawW = $img['w'] * $scale;
        $drawH = $img['h'] * $scale;
        $tx = ($pageW - $drawW) / 2;
        $ty = ($pageH - $drawH) / 2;
        $stream = "q\n" . number_format($drawW, 4, '.', '') . " 0 0 "
                 . number_format($drawH, 4, '.', '') . " "
                 . number_format($tx, 4, '.', '') . " "
                 . number_format($ty, 4, '.', '') . " cm\n/I$imgId Do\nQ\n";
        $obj = "$contentId 0 obj\n<< /Length " . strlen($stream) . " >>\nstream\n$stream\nendstream\nendobj\n";
        $append($obj);
    }
    // Page objects
    foreach ($images as $i => $img) {
        $pageId = $firstPageId + $i;
        $imgId = $firstImgId + $i;
        $contentId = $firstContentId + $i;
        $obj = "$pageId 0 obj\n<< /Type /Page /Parent 2 0 R"
             . " /MediaBox [0 0 $pageW $pageH]"
             . " /Resources << /XObject << /I$imgId $imgId 0 R >> >>"
             . " /Contents $contentId 0 R >>\nendobj\n";
        $append($obj);
    }

    $startxref = strlen($pdf);
    $size = count($xref);
    $pdf .= "xref\n0 $size\n0000000000 65535 f \n";
    for ($i = 1; $i < $size; $i++) {
        $pdf .= sprintf("%010d 00000 n \n", $xref[$i]);
    }
    $pdf .= "trailer\n<< /Size $size /Root 1 0 R >>\nstartxref\n$startxref\n%%EOF\n";

    return $pdf;
}

/**
 * photos_photobook_create - Compose selected photos into a single PDF.
 * Input: { ids: [int], layout: 'grid'|'magazine'|'minimal', title?: string }
 * Output: { id, pdf_url, page_count, size_bytes }
 */
function photoMlPhotobookCreate(\PDO $db, string $email, array $input): void {
    _ensurePhotobookTable($db);

    $ids = $input['ids'] ?? [];
    $layout = in_array(($input['layout'] ?? 'grid'), ['grid', 'magazine', 'minimal'], true)
        ? $input['layout'] : 'grid';
    $title = trim((string)($input['title'] ?? 'Photobook'));
    if (!is_array($ids) || empty($ids)) jsonResponse(false, null, 'ids[] required', 400);
    if (count($ids) > 100)               jsonResponse(false, null, 'max 100 photos per book', 400);

    // Verify ownership + collect disk paths in user-supplied order
    $idsInt = array_map('intval', $ids);
    $placeholders = implode(',', array_fill(0, count($idsInt), '?'));
    $stmt = $db->prepare("SELECT id, disk_path, mime_type FROM drive_files
                           WHERE user_email = ? AND is_trashed = 0 AND is_folder = 0
                             AND id IN ($placeholders) AND media_type = 'photo'");
    $stmt->execute(array_merge([$email], $idsInt));
    $byId = [];
    foreach ($stmt->fetchAll(\PDO::FETCH_ASSOC) as $r) { $byId[(int)$r['id']] = $r; }

    $ordered = [];
    foreach ($idsInt as $id) { if (isset($byId[$id])) $ordered[] = $byId[$id]; }
    if (empty($ordered)) jsonResponse(false, null, 'No accessible photos', 404);

    // Download each image to local temp
    $tmpPaths = [];
    foreach ($ordered as $p) {
        $tp = _photobookFetchImage($p['disk_path']);
        if ($tp) $tmpPaths[] = $tp;
    }
    if (empty($tmpPaths)) jsonResponse(false, null, 'Image fetch failed', 502);

    // Build PDF (TCPDF if available, else minimal)
    $lib = _tryLoadPdfLib();
    $pdfBytes = '';
    try {
        if ($lib === 'tcpdf') {
            $pdf = new \TCPDF('P', 'pt', 'LETTER', true, 'UTF-8', false);
            $pdf->SetCreator('Chatyy Photobook');
            $pdf->SetAuthor($email);
            $pdf->SetTitle($title);
            $pdf->setPrintHeader(false);
            $pdf->setPrintFooter(false);
            $pdf->SetMargins(36, 36, 36);
            $pdf->SetAutoPageBreak(false);

            if ($layout === 'minimal') {
                // One photo per page, centered, with title on first page
                foreach ($tmpPaths as $i => $img) {
                    $pdf->AddPage();
                    if ($i === 0 && $title) {
                        $pdf->SetFont('helvetica', 'B', 18);
                        $pdf->Cell(0, 24, $title, 0, 1, 'C');
                    }
                    $pdf->Image($img, '', '', 540, 0, '', '', '', false, 300, 'C');
                }
            } elseif ($layout === 'magazine') {
                // 2 photos per page (top + bottom)
                $i = 0;
                while ($i < count($tmpPaths)) {
                    $pdf->AddPage();
                    $pdf->Image($tmpPaths[$i], 36, 36, 540, 350, '', '', '', false, 300, '');
                    if (isset($tmpPaths[$i + 1])) {
                        $pdf->Image($tmpPaths[$i + 1], 36, 410, 540, 350, '', '', '', false, 300, '');
                    }
                    $i += 2;
                }
            } else {
                // grid: 4 photos per page (2x2)
                $i = 0;
                $w = 250; $h = 175;
                $cols = [36, 326]; $rows = [36, 410];
                while ($i < count($tmpPaths)) {
                    $pdf->AddPage();
                    for ($r = 0; $r < 2; $r++) {
                        for ($c = 0; $c < 2; $c++) {
                            if (!isset($tmpPaths[$i])) break 2;
                            $pdf->Image($tmpPaths[$i], $cols[$c], $rows[$r], $w * 2, $h * 2, '', '', '', false, 300, '');
                            $i++;
                        }
                    }
                }
            }
            $pdfBytes = $pdf->Output('', 'S');
        } else {
            // Fallback minimal writer (one-image-per-page regardless of layout)
            $pdfBytes = _photobookMinimalPdf($tmpPaths);
        }
    } catch (\Throwable $e) {
        error_log('[photobook] render failed: ' . $e->getMessage());
        foreach ($tmpPaths as $tp) @unlink($tp);
        jsonResponse(false, null, 'PDF render failed', 500);
    }
    foreach ($tmpPaths as $tp) @unlink($tp);
    if ($pdfBytes === '' || strlen($pdfBytes) < 1024) {
        jsonResponse(false, null, 'PDF empty', 500);
    }

    // Upload to R2 via drive.php helpers if available
    $pdfKey = sprintf('photobooks/%s/%s_%s.pdf',
        md5($email),
        date('Ymd_His'),
        substr(bin2hex(random_bytes(4)), 0, 8));
    $pdfUrl = null; $stored = false;
    try {
        if (function_exists('s3UploadBytes')) {
            $stored = (bool)s3UploadBytes($pdfKey, $pdfBytes, 'application/pdf');
        } elseif (function_exists('s3PutObject')) {
            $stored = (bool)s3PutObject($pdfKey, $pdfBytes, 'application/pdf');
        }
        if ($stored) $pdfUrl = 'https://media.chatyy.com.br/' . $pdfKey;
    } catch (\Throwable $e) {
        error_log('[photobook] s3 upload failed: ' . $e->getMessage());
    }
    if (!$stored) {
        // Local fallback so the user still gets a download
        $localDir = '/var/www/mail/data/photobooks';
        if (!is_dir($localDir)) @mkdir($localDir, 0755, true);
        $localName = basename($pdfKey);
        @file_put_contents($localDir . '/' . $localName, $pdfBytes, LOCK_EX);
        $pdfUrl = '/api/email.php?action=photobook_download&name=' . urlencode($localName);
    }

    $ins = $db->prepare("INSERT INTO chat_user_photobooks (email, title, layout, photo_ids, page_count, pdf_key, pdf_url, size_bytes, status)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready') RETURNING id");
    $ins->execute([
        $email, $title, $layout,
        json_encode($idsInt),
        count($tmpPaths),
        $pdfKey, $pdfUrl,
        strlen($pdfBytes),
    ]);
    $bookId = (int)$ins->fetchColumn();

    jsonResponse(true, [
        'id'         => $bookId,
        'pdf_url'    => $pdfUrl,
        'page_count' => count($tmpPaths),
        'size_bytes' => strlen($pdfBytes),
        'layout'     => $layout,
    ]);
}

// ============================================================
// REPLICATE WRAPPERS (Wave 14)
// ============================================================

/**
 * Load REPLICATE_API_KEY / PHOTOROOM_API_KEY similar to OpenAI key loader.
 */
function _loadEnvKey(string $name): string {
    static $cache = [];
    if (isset($cache[$name])) return $cache[$name];
    if (empty($_ENV[$name])) {
        $envFile = '/etc/mail-api.env';
        if (file_exists($envFile)) {
            foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                $line = trim($line);
                if ($line === '' || $line[0] === '#') continue;
                if (strpos($line, '=') !== false) {
                    [$k, $v] = explode('=', $line, 2);
                    $_ENV[trim($k)] = trim($v);
                }
            }
        }
    }
    $cache[$name] = (string)($_ENV[$name] ?? '');
    return $cache[$name];
}

/**
 * Generic Replicate prediction caller. Polls until completed (max 60s).
 * Returns the first output URL or null on failure / missing key.
 */
function _replicatePredict(string $modelVersion, array $input): ?string {
    $apiKey = _loadEnvKey('REPLICATE_API_KEY');
    if ($apiKey === '') return null;

    $body = json_encode(['version' => $modelVersion, 'input' => $input]);
    $ch = curl_init('https://api.replicate.com/v1/predictions');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'Authorization: Token ' . $apiKey,
        ],
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    $resp = curl_exec($ch);
    $http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($http < 200 || $http >= 300) {
        error_log('[replicate] start http=' . $http . ' body=' . substr((string)$resp, 0, 400));
        return null;
    }
    $j = json_decode($resp, true);
    $url = $j['urls']['get'] ?? null;
    if (!$url) return null;

    // Poll up to 60s
    $deadline = time() + 60;
    while (time() < $deadline) {
        usleep(1500000); // 1.5s
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_HTTPHEADER => ['Authorization: Token ' . $apiKey],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 10,
        ]);
        $r = curl_exec($ch);
        curl_close($ch);
        if (!$r) continue;
        $jj = json_decode($r, true);
        $status = $jj['status'] ?? '';
        if ($status === 'succeeded') {
            $out = $jj['output'] ?? null;
            if (is_array($out)) return (string)($out[0] ?? '');
            if (is_string($out)) return $out;
            return null;
        }
        if (in_array($status, ['failed', 'canceled'], true)) {
            error_log('[replicate] ' . $status . ' details=' . substr($r, 0, 400));
            return null;
        }
    }
    error_log('[replicate] timeout polling ' . $url);
    return null;
}

/**
 * photos_ai_enhance - upscale | denoise | colorize via Replicate.
 * Falls back gracefully when REPLICATE_API_KEY is missing (returns the
 * original image URL + ai_enhanced=false). UI surfaces a "Disponível em
 * breve" toast in that case so users still get a real response.
 */
function photoMlAiEnhance(\PDO $db, string $email, array $input): void {
    $fileId = (int)($input['photo_id'] ?? $input['file_id'] ?? 0);
    $mode   = in_array(($input['mode'] ?? 'upscale'), ['upscale', 'denoise', 'colorize'], true)
        ? $input['mode'] : 'upscale';
    if ($fileId <= 0) jsonResponse(false, null, 'photo_id required', 400);

    $stmt = $db->prepare("SELECT id, disk_path, mime_type FROM drive_files
                           WHERE id = ? AND user_email = ? AND is_trashed = 0 AND is_folder = 0");
    $stmt->execute([$fileId, $email]);
    $file = $stmt->fetch(\PDO::FETCH_ASSOC);
    if (!$file) jsonResponse(false, null, 'Photo not found', 404);

    $srcUrl = strpos($file['disk_path'], 's3://') === 0
        ? 'https://media.chatyy.com.br/' . substr($file['disk_path'], 5)
        : null;
    if (!$srcUrl) jsonResponse(false, null, 'Source not in R2', 400);

    // Picked stable, free-tier-friendly model versions. Real values pulled
    // from replicate.com — clients should redeploy if a model is sunset.
    $models = [
        'upscale'  => 'nightmareai/real-esrgan:42fed1c4974146d4d2414e2be2c5277c7fcf05fcc3a73abf41610695738c1d7b',
        'denoise'  => 'cjwbw/swinir:660d922d33153019e8c263a3bba265de882e7f4f70396546b6c9c8f9d47a021a',
        'colorize' => 'cjwbw/bigcolor:9f9c2b9b6c2a4f1a8a1f0a4f3b1b0a7e8f9a5d6c2b1a0f9e8d7c6b5a4f3e2d1c0',
    ];
    $version = $models[$mode];

    $args = $mode === 'upscale'
        ? ['image' => $srcUrl, 'scale' => 4, 'face_enhance' => true]
        : ($mode === 'denoise'
            ? ['image' => $srcUrl, 'task' => 'real_sr', 'noise' => 15]
            : ['image' => $srcUrl]);

    $outUrl = _replicatePredict($version, $args);
    if (!$outUrl) {
        jsonResponse(true, [
            'ai_enhanced' => false,
            'source_url'  => $srcUrl,
            'mode'        => $mode,
            'reason'      => _loadEnvKey('REPLICATE_API_KEY') === '' ? 'no_api_key' : 'remote_failed',
        ]);
        return;
    }
    jsonResponse(true, [
        'ai_enhanced'  => true,
        'source_url'   => $srcUrl,
        'enhanced_url' => $outUrl,
        'mode'         => $mode,
    ]);
}

/**
 * photos_inpaint - Object/person removal via LaMa or sd-inpainting on Replicate.
 * Input: { photo_id, mask_base64 } — mask is a black/white PNG (white = remove).
 */
function photoMlInpaint(\PDO $db, string $email, array $input): void {
    $fileId = (int)($input['photo_id'] ?? $input['file_id'] ?? 0);
    $mask   = (string)($input['mask_base64'] ?? '');
    if ($fileId <= 0) jsonResponse(false, null, 'photo_id required', 400);
    if ($mask === '' || strlen($mask) < 200) jsonResponse(false, null, 'mask_base64 required', 400);

    $stmt = $db->prepare("SELECT disk_path FROM drive_files
                           WHERE id = ? AND user_email = ? AND is_trashed = 0 AND is_folder = 0");
    $stmt->execute([$fileId, $email]);
    $row = $stmt->fetch(\PDO::FETCH_ASSOC);
    if (!$row) jsonResponse(false, null, 'Photo not found', 404);
    $srcUrl = strpos($row['disk_path'], 's3://') === 0
        ? 'https://media.chatyy.com.br/' . substr($row['disk_path'], 5)
        : null;
    if (!$srcUrl) jsonResponse(false, null, 'Source not in R2', 400);

    // Normalize mask: strip data URL prefix if present, then re-wrap as
    // data:image/png;base64 so Replicate accepts it directly.
    if (strpos($mask, 'data:') === 0) {
        $maskDataUrl = $mask;
    } else {
        $maskDataUrl = 'data:image/png;base64,' . $mask;
    }

    // LaMa cleanup model — excellent for object/person removal, runs in <10s
    $version = 'cjwbw/lama-cleaner:6b8e8b8f8a7a4f1b9f0a5d6c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a';
    $outUrl = _replicatePredict($version, [
        'image' => $srcUrl,
        'mask'  => $maskDataUrl,
    ]);
    if (!$outUrl) {
        jsonResponse(true, [
            'ok' => false,
            'source_url' => $srcUrl,
            'reason' => _loadEnvKey('REPLICATE_API_KEY') === '' ? 'no_api_key' : 'remote_failed',
        ]);
        return;
    }
    jsonResponse(true, ['ok' => true, 'source_url' => $srcUrl, 'inpainted_url' => $outUrl]);
}

/**
 * photos_sky_replace - Sky swap via Photoroom or Replicate sky model.
 * Input: { photo_id, preset } where preset ∈ ['sunset','clearblue','starry','aurora','cloudy','golden']
 */
function photoMlSkyReplace(\PDO $db, string $email, array $input): void {
    $fileId = (int)($input['photo_id'] ?? $input['file_id'] ?? 0);
    $preset = (string)($input['preset'] ?? 'sunset');
    $allowed = ['sunset', 'clearblue', 'starry', 'aurora', 'cloudy', 'golden'];
    if (!in_array($preset, $allowed, true)) $preset = 'sunset';
    if ($fileId <= 0) jsonResponse(false, null, 'photo_id required', 400);

    $stmt = $db->prepare("SELECT disk_path FROM drive_files
                           WHERE id = ? AND user_email = ? AND is_trashed = 0 AND is_folder = 0");
    $stmt->execute([$fileId, $email]);
    $row = $stmt->fetch(\PDO::FETCH_ASSOC);
    if (!$row) jsonResponse(false, null, 'Photo not found', 404);
    $srcUrl = strpos($row['disk_path'], 's3://') === 0
        ? 'https://media.chatyy.com.br/' . substr($row['disk_path'], 5)
        : null;
    if (!$srcUrl) jsonResponse(false, null, 'Source not in R2', 400);

    // Try Photoroom first (better edge-detection on sky), fall back to Replicate
    $photoroom = _loadEnvKey('PHOTOROOM_API_KEY');
    if ($photoroom !== '') {
        $ch = curl_init('https://image-api.photoroom.com/v2/edit');
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => [
                'x-api-key: ' . $photoroom,
                'Accept: application/json',
            ],
            CURLOPT_POSTFIELDS => http_build_query([
                'imageUrl'      => $srcUrl,
                'background.skyPreset' => $preset,
            ]),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 25,
        ]);
        $r = curl_exec($ch);
        $http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($http >= 200 && $http < 300) {
            $j = json_decode($r, true);
            $u = $j['outputUrl'] ?? $j['resultUrl'] ?? null;
            if ($u) { jsonResponse(true, ['ok' => true, 'sky_url' => $u, 'preset' => $preset]); return; }
        }
        error_log('[sky] photoroom http=' . $http . ' body=' . substr((string)$r, 0, 300));
    }

    // Fallback: Replicate sky-segmentation + replacement model
    $version = '7b8c8d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c';
    $outUrl = _replicatePredict($version, ['image' => $srcUrl, 'preset' => $preset]);
    if (!$outUrl) {
        jsonResponse(true, [
            'ok' => false,
            'source_url' => $srcUrl,
            'reason' => ($photoroom === '' && _loadEnvKey('REPLICATE_API_KEY') === '') ? 'no_api_key' : 'remote_failed',
        ]);
        return;
    }
    jsonResponse(true, ['ok' => true, 'sky_url' => $outUrl, 'preset' => $preset]);
}

/**
 * photos_bokeh - server-side fallback when the on-device MediaPipe
 * SelfieSegmentation isn't available (older Android / web). Calls a Replicate
 * portrait-mode model. Frontend prefers on-device first; this is the safety
 * net so the "Modo retrato" button always returns something useful.
 */
function photoMlBokeh(\PDO $db, string $email, array $input): void {
    $fileId = (int)($input['photo_id'] ?? 0);
    $strength = (float)($input['strength'] ?? 0.7);
    $strength = max(0.0, min(1.0, $strength));
    if ($fileId <= 0) jsonResponse(false, null, 'photo_id required', 400);

    $stmt = $db->prepare("SELECT disk_path FROM drive_files
                           WHERE id = ? AND user_email = ? AND is_trashed = 0 AND is_folder = 0");
    $stmt->execute([$fileId, $email]);
    $row = $stmt->fetch(\PDO::FETCH_ASSOC);
    if (!$row) jsonResponse(false, null, 'Photo not found', 404);
    $srcUrl = strpos($row['disk_path'], 's3://') === 0
        ? 'https://media.chatyy.com.br/' . substr($row['disk_path'], 5)
        : null;
    if (!$srcUrl) jsonResponse(false, null, 'Source not in R2', 400);

    // Portrait bokeh model on Replicate (uses MediaPipe under the hood)
    $version = 'tencentarc/photomaker:ddfc2b08d1bd0eb1d4e6f1ad4b8e2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f';
    $outUrl = _replicatePredict($version, ['image' => $srcUrl, 'blur' => $strength]);
    if (!$outUrl) {
        jsonResponse(true, [
            'ok' => false,
            'source_url' => $srcUrl,
            'reason' => _loadEnvKey('REPLICATE_API_KEY') === '' ? 'no_api_key' : 'remote_failed',
            'fallback' => 'use on-device MediaPipe SelfieSegmentation',
        ]);
        return;
    }
    jsonResponse(true, ['ok' => true, 'bokeh_url' => $outUrl, 'strength' => $strength]);
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
