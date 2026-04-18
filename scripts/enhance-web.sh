#!/bin/bash
# Post-build script to enhance web output with meta tags and manifest
set -e
DIST="${DIST:-/root/webmail-app/dist}"

# Copy the canonical PWA icon to a stable path. Without this, manifest.json
# points to /assets/icon.png which Expo's asset hasher doesn't produce, so
# browsers warn "Download error or resource isn't a valid image".
mkdir -p "$DIST/assets"
cp -f /root/webmail-app/assets/icon.png "$DIST/assets/icon.png" 2>/dev/null || true

cat > "$DIST/manifest.json" << 'MANIFEST'
{
  "name": "Chatyy",
  "short_name": "Chatyy",
  "description": "Email, Chat, Calendar, Files - Chatyy",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#ffffff",
  "theme_color": "#2563eb",
  "lang": "pt-BR",
  "dir": "ltr",
  "categories": ["productivity", "communication", "social"],
  "icons": [
    { "src": "/favicon.ico", "sizes": "64x64", "type": "image/x-icon" },
    { "src": "/assets/icon.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
MANIFEST

INDEX="$DIST/index.html"

# lang attribute on <html>
sed -i 's|<html lang="en">|<html lang="pt-BR">|' "$INDEX"
sed -i 's|<html>|<html lang="pt-BR">|' "$INDEX"

# viewport-fit=cover for iOS safe-area
sed -i 's|width=device-width,initial-scale=1|width=device-width,initial-scale=1,viewport-fit=cover|' "$INDEX"

# Read head-inject block
HEAD_INJECT='<link rel="manifest" href="/manifest.json" />'
HEAD_INJECT+='<meta name="theme-color" content="#2563eb" media="(prefers-color-scheme: light)" />'
HEAD_INJECT+='<meta name="theme-color" content="#0b0f19" media="(prefers-color-scheme: dark)" />'
HEAD_INJECT+='<meta name="description" content="Chatyy - Email, Chat, Calendar, Files, Meet. Tudo num só app." />'
HEAD_INJECT+='<meta name="mobile-web-app-capable" content="yes" />'
HEAD_INJECT+='<meta name="apple-mobile-web-app-capable" content="yes" />'
HEAD_INJECT+='<meta name="apple-mobile-web-app-status-bar-style" content="default" />'
HEAD_INJECT+='<meta name="apple-mobile-web-app-title" content="Chatyy" />'
HEAD_INJECT+='<meta name="format-detection" content="telephone=no" />'
HEAD_INJECT+='<link rel="apple-touch-icon" href="/favicon.ico" />'
HEAD_INJECT+='<link rel="preconnect" href="https://chatyy.com.br" />'
HEAD_INJECT+='<link rel="preconnect" href="https://media.chatyy.com.br" crossorigin />'
HEAD_INJECT+='<link rel="preconnect" href="wss://ws.chatyy.com.br" crossorigin />'
HEAD_INJECT+='<link rel="dns-prefetch" href="https://chatyy.com.br" />'
HEAD_INJECT+='<link rel="dns-prefetch" href="https://media.chatyy.com.br" />'
# Preload the main JS bundle so the browser starts downloading it the moment
# HTML reaches the client, in parallel with CSS. Knocks another ~200ms off
# first paint on cold loads.
MAIN_BUNDLE=$(ls "$DIST"/_expo/static/js/web/entry-*.js 2>/dev/null | head -1)
MAIN_BUNDLE=${MAIN_BUNDLE#$DIST}
if [ -n "$MAIN_BUNDLE" ]; then
  HEAD_INJECT+="<link rel=\"modulepreload\" href=\"${MAIN_BUNDLE}\" />"
fi
HEAD_INJECT+='<meta property="og:type" content="website" />'
HEAD_INJECT+='<meta property="og:title" content="Chatyy" />'
HEAD_INJECT+='<meta property="og:description" content="Email, Chat, Calendar, Files, Meet. Tudo num só app." />'
HEAD_INJECT+='<meta property="og:site_name" content="Chatyy" />'
HEAD_INJECT+='<meta property="og:locale" content="pt_BR" />'
HEAD_INJECT+='<meta name="twitter:card" content="summary" />'
HEAD_INJECT+='<meta name="twitter:title" content="Chatyy" />'
HEAD_INJECT+='<meta name="twitter:description" content="Email, Chat, Calendar, Files, Meet." />'

# Inject before </head>
sed -i "s|</head>|${HEAD_INJECT}</head>|" "$INDEX"

# Token cleanup + SW registration before #root. We build the script, then
# write it to a temp file and use `r` + delete pattern via awk because:
# - sed `|` delimiter conflicts with JS `||`
# - sed `&` in replacement expands to the matched pattern (so `&&` in JS
#   comes out as two copies of the <div id="root">, corrupting the HTML)
# awk substitution avoids both traps.
BODY_INJECT='<script>try{var t=localStorage.getItem("mail_token");if(t&&(t.startsWith("eyJ")||t.length>128)){localStorage.removeItem("mail_token");console.warn("Cleared corrupted auth token")}}catch(e){}if("serviceWorker" in navigator){window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){})})}</script>'
# awk gsub() treats `&` in the replacement as the matched text — same trap as
# sed. BODY_INJECT contains `if(t&&(...))` so gsub would expand those `&&` into
# copies of `<div id="root"></div>`, corrupting the HTML. Use match()+substr()
# which does NOT interpret `&` in the inserted string.
awk -v inject="$BODY_INJECT" '
  !done && match($0, "<div id=\"root\"></div>") {
    print substr($0, 1, RSTART-1) inject substr($0, RSTART)
    done = 1
    next
  }
  { print }
' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"

echo "Web build enhanced: manifest, PWA meta, OG tags, preconnect, lang=pt-BR"
