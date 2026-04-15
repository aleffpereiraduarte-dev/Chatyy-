#!/bin/bash
# Post-build script to enhance web output with meta tags and manifest
set -e
DIST="${DIST:-/root/webmail-app/dist}"

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
HEAD_INJECT+='<link rel="dns-prefetch" href="https://chatyy.com.br" />'
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

# Token cleanup + SW registration before #root
BODY_INJECT='<script>try{var t=localStorage.getItem("mail_token");if(t\&\&(t.startsWith("eyJ")||t.length>128)){localStorage.removeItem("mail_token");console.warn("Cleared corrupted auth token")}}catch(e){}if("serviceWorker" in navigator){window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){})})}</script>'
sed -i "s|<div id=\"root\"></div>|${BODY_INJECT}<div id=\"root\"></div>|" "$INDEX"

echo "Web build enhanced: manifest, PWA meta, OG tags, preconnect, lang=pt-BR"
