#!/bin/bash
# Post-build script to enhance web output with meta tags and manifest
DIST="/root/webmail-app/dist"

# Add web manifest
cat > "$DIST/manifest.json" << 'MANIFEST'
{
  "name": "Chatyy",
  "short_name": "Mail",
  "description": "Email, Chat, Calendar, Files - Chatyy",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#2563eb",
  "icons": [
    { "src": "/favicon.ico", "sizes": "64x64", "type": "image/x-icon" }
  ]
}
MANIFEST

# Inject meta tags and manifest link into index.html
sed -i 's|<link rel="icon" href="/favicon.ico" /></head>|<link rel="icon" href="/favicon.ico" /><link rel="manifest" href="/manifest.json" /><meta name="theme-color" content="#2563eb" /><meta name="description" content="Chatyy - Email, Chat, Calendar, Files" /><meta name="mobile-web-app-capable" content="yes" /><meta name="apple-mobile-web-app-status-bar-style" content="default" /><meta name="apple-mobile-web-app-title" content="Chatyy" /></head>|' "$DIST/index.html"

# Inject token cleanup script before app loads (clears corrupted JWT auth tokens)
sed -i 's|<div id="root"></div>|<script>try{var t=localStorage.getItem("mail_token");if(t\&\&(t.startsWith("eyJ")||t.length>128)){localStorage.removeItem("mail_token");console.warn("Cleared corrupted auth token")}}catch(e){}</script>\n    <div id="root"></div>|' "$DIST/index.html"

echo "Web build enhanced with manifest and meta tags"
