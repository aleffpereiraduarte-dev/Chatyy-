<?php
// scripts/fly/equiv.php — [voar 2026-10-22] compara o motor PHP (api/games_engine_fly.php) com as partidas do node.
// uso: php equiv.php partidas.json   → "N/N iguais"; sai 1 na 1ª diferença (mostra qual).
require '/var/www/mail/api/games_engine_fly.php';
$all = json_decode(file_get_contents($argv[1]), true);
$ok = 0; $valid = 0; $maxScore = 0; $maxT = 0;
foreach ($all as $i => $g) {
    $ticks = fly_decode_ticks($g['d']) ?? [];
    if (!$g['d']) $ticks = [];
    $r = fly_simulate((int)$g['seed'], $ticks);
    $same = $r['ok'] === $g['ok'] && $r['err'] === $g['err'] && $r['score'] === $g['score'] && $r['ticks'] === $g['ticks'] && ($r['flaps'] ?? null) === $g['flaps'];
    if (!$same) { fwrite(STDERR, "DIFERENTE #$i seed={$g['seed']}\n js=" . json_encode([$g['ok'], $g['err'], $g['score'], $g['ticks'], $g['flaps']]) . "\nphp=" . json_encode([$r['ok'], $r['err'], $r['score'], $r['ticks'], $r['flaps'] ?? null]) . "\n"); exit(1); }
    $ok++; if ($r['ok']) { $valid++; $maxScore = max($maxScore, $r['score']); $maxT = max($maxT, $r['ticks']); }
}
echo "$ok/" . count($all) . " iguais (válidas $valid, maior pontuação $maxScore, maior duração " . round($maxT / 120) . " s)\n";
