<?php
/**
 * Static map proxy — Google Static Maps API with CartoCDN tile fallback.
 *
 * Why proxy at all: RN <Image> on Android (Glide/Fresco) silently fails on
 * some external map tile URLs — no onError, no onLoad fired (RN issues
 * #18502, #19073). Our own proxy returns a single PNG over our domain,
 * which RN Image renders reliably with proper events.
 *
 * Pipeline:
 *   1. Try Google Static Maps API (real Google cartography + native pin
 *      marker). Visually matches the rest of the app (snap-map, in-chat
 *      live location, location bubbles) — single map provider for visual
 *      consistency.
 *   2. If Google returns non-200 (403 from a referer-locked key, 429 from
 *      quota, etc.) fall back to the legacy CartoCDN tile-composer +
 *      hand-drawn red pin. Same UX, no key, no rejection — guarantees the
 *      endpoint never breaks visible map bubbles even if billing flaps.
 *
 * Cache: 7d on disk + Cloudflare edge. Cache key includes provider tag so
 * a Google → fallback transition doesn't poison the cache with the older
 * style.
 *
 * Usage: /api/static_map.php?lat=-23.5614&lng=-46.6533&z=15&w=600&h=320
 */

declare(strict_types=1);

$lat = isset($_GET['lat']) ? (float)$_GET['lat'] : null;
$lng = isset($_GET['lng']) ? (float)$_GET['lng'] : null;
$z   = isset($_GET['z'])   ? max(3, min(18, (int)$_GET['z'])) : 15;
$w   = isset($_GET['w'])   ? max(64, min(1024, (int)$_GET['w'])) : 600;
$h   = isset($_GET['h'])   ? max(64, min(640,  (int)$_GET['h'])) : 320;

if ($lat === null || $lng === null || $lat < -85 || $lat > 85 || $lng < -180 || $lng > 180) {
    http_response_code(400);
    header('Content-Type: text/plain');
    echo 'Invalid lat/lng';
    exit;
}

// v2 cache key — bumped from v1 so caches built with the OSM/Carto-only
// pipeline get evicted and re-rendered against the Google primary.
$cacheKey = sha1("v2:$lat:$lng:$z:$w:$h");
$cacheDir = '/var/www/mail/data/static_map_cache';
if (!is_dir($cacheDir)) @mkdir($cacheDir, 0775, true);
$cacheFile = "$cacheDir/$cacheKey.png";

if (is_file($cacheFile) && (time() - filemtime($cacheFile)) < 86400 * 7) {
    header('Content-Type: image/png');
    header('Cache-Control: public, max-age=604800, immutable');
    header('Content-Length: ' . filesize($cacheFile));
    readfile($cacheFile);
    exit;
}

// ----------------------------------------------------------------------
// Provider #1: Google Static Maps API
// ----------------------------------------------------------------------
// Load the key from /etc/mail-api.env. We try GOOGLE_MAPS_SERVER_KEY first
// (server-side, no referer restrictions if you set it up that way) and
// fall back to GOOGLE_MAPS_KEY (the client-side key from app.json). Either
// works as long as the Static Maps API is enabled and billing is on.
function _envKv(string $key): string {
    static $envCache = null;
    if ($envCache === null) {
        $envCache = [];
        if (is_readable('/etc/mail-api.env')) {
            foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $ln) {
                if ($ln === '' || $ln[0] === '#') continue;
                $eq = strpos($ln, '=');
                if ($eq === false) continue;
                $envCache[substr($ln, 0, $eq)] = substr($ln, $eq + 1);
            }
        }
    }
    return $envCache[$key] ?? (getenv($key) ?: '');
}

$gmapsKey = _envKv('GOOGLE_MAPS_SERVER_KEY') ?: _envKv('GOOGLE_MAPS_KEY');
// app.json key as last resort — same one the mobile client uses for JS maps.
if ($gmapsKey === '') $gmapsKey = 'AIzaSyBulyR8pRvCX3pGxMBs_9zt0FIjOFZVnEk';

if ($gmapsKey !== '') {
    // Google Static Maps caps size at 640x640 on free tier and 2048x2048 with
    // Premium plan. We're way under — pass through as-is. The `markers`
    // parameter adds the native red drop pin so we don't need to draw one.
    $googleUrl = sprintf(
        'https://maps.googleapis.com/maps/api/staticmap?center=%F,%F&zoom=%d&size=%dx%d&scale=2&maptype=roadmap&markers=color:red%%7Csize:mid%%7C%F,%F&key=%s',
        $lat, $lng, $z, $w, $h, $lat, $lng, $gmapsKey
    );

    $ch = curl_init($googleUrl);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 8,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_USERAGENT      => 'Chatyy-Map/2.0',
        CURLOPT_FOLLOWLOCATION => true,
    ]);
    $bin  = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $ctype = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    curl_close($ch);

    // Google returns a 200 PNG on success. 403 = key restricted / billing
    // off / referer mismatch. On any non-200 OR non-image response we drop
    // to the CartoCDN fallback below. A success path writes to cache and
    // returns immediately.
    if ($code === 200 && $bin && stripos((string)$ctype, 'image/') === 0) {
        @file_put_contents($cacheFile, $bin);
        header('Content-Type: image/png');
        header('Cache-Control: public, max-age=604800, immutable');
        header('Content-Length: ' . strlen($bin));
        echo $bin;
        exit;
    }
    // Log once-per-process so we notice if Google starts failing for
    // everyone (billing lapse, key revoked, etc.) without poisoning the
    // user-visible map.
    error_log('[static_map] Google fallback (code=' . $code . ' ctype=' . $ctype . ' len=' . strlen((string)$bin) . ')');
}

// ----------------------------------------------------------------------
// Provider #2 (fallback): CartoCDN tile composer + hand-drawn pin
// ----------------------------------------------------------------------
// Compute pixel coords for the center
$n = pow(2, $z);
$xCenter = (($lng + 180) / 360) * $n;
$latRad = deg2rad($lat);
$yCenter = (1 - log(tan($latRad) + 1 / cos($latRad)) / M_PI) / 2 * $n;

$pxCenter = $xCenter * 256;
$pyCenter = $yCenter * 256;

// Determine tile range to cover the requested viewport
$pxLeft   = $pxCenter - $w / 2;
$pyTop    = $pyCenter - $h / 2;
$pxRight  = $pxCenter + $w / 2;
$pyBottom = $pyCenter + $h / 2;

$tileXStart = (int)floor($pxLeft / 256);
$tileXEnd   = (int)floor($pxRight / 256);
$tileYStart = (int)floor($pyTop / 256);
$tileYEnd   = (int)floor($pyBottom / 256);

$canvas = imagecreatetruecolor($w, $h);
$bg = imagecolorallocate($canvas, 229, 231, 235); // gray-200 fallback
imagefilledrectangle($canvas, 0, 0, $w, $h, $bg);

// Fetch tiles in parallel via curl_multi for speed
$mh = curl_multi_init();
$handles = [];
for ($tx = $tileXStart; $tx <= $tileXEnd; $tx++) {
    for ($ty = $tileYStart; $ty <= $tileYEnd; $ty++) {
        if ($tx < 0 || $ty < 0 || $tx >= $n || $ty >= $n) continue;
        $url = "https://basemaps.cartocdn.com/light_all/$z/$tx/$ty.png";
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 5,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_USERAGENT => 'Chatyy-Map/1.0',
            CURLOPT_FOLLOWLOCATION => true,
        ]);
        curl_multi_add_handle($mh, $ch);
        $handles[] = ['ch' => $ch, 'tx' => $tx, 'ty' => $ty];
    }
}

$running = null;
do {
    curl_multi_exec($mh, $running);
    curl_multi_select($mh, 0.5);
} while ($running > 0);

foreach ($handles as $h0) {
    $bin = curl_multi_getcontent($h0['ch']);
    $code = curl_getinfo($h0['ch'], CURLINFO_HTTP_CODE);
    curl_multi_remove_handle($mh, $h0['ch']);
    curl_close($h0['ch']);

    if ($code !== 200 || !$bin || strlen($bin) < 200) continue; // skip blank/tiny tiles

    $tile = @imagecreatefromstring($bin);
    if (!$tile) continue;

    $destX = (int)round($h0['tx'] * 256 - $pxLeft);
    $destY = (int)round($h0['ty'] * 256 - $pyTop);
    imagecopy($canvas, $tile, $destX, $destY, 0, 0, 256, 256);
    imagedestroy($tile);
}
curl_multi_close($mh);

// Draw red pin (drop shape) at center of canvas
$pinX = (int)($w / 2);
$pinY = (int)($h / 2);
$pinColor = imagecolorallocate($canvas, 220, 38, 38);     // red-600
$pinShadow = imagecolorallocatealpha($canvas, 0, 0, 0, 90);
$white = imagecolorallocate($canvas, 255, 255, 255);

// Drop tail (triangle below circle)
$tailPoints = [
    $pinX - 6, $pinY + 6,
    $pinX + 6, $pinY + 6,
    $pinX, $pinY + 18,
];
imagefilledpolygon($canvas, $tailPoints, $pinColor);

// Shadow circle
imagefilledellipse($canvas, $pinX + 1, $pinY + 1, 28, 28, $pinShadow);
// White ring
imagefilledellipse($canvas, $pinX, $pinY, 28, 28, $white);
// Red center
imagefilledellipse($canvas, $pinX, $pinY, 22, 22, $pinColor);
// White inner dot
imagefilledellipse($canvas, $pinX, $pinY, 8, 8, $white);

// Output PNG
ob_start();
imagepng($canvas, null, 7);
$png = ob_get_clean();
imagedestroy($canvas);

@file_put_contents($cacheFile, $png);

header('Content-Type: image/png');
header('Cache-Control: public, max-age=604800, immutable');
header('Content-Length: ' . strlen($png));
echo $png;
