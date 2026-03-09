#!/bin/bash
# Post-build script to enhance web output with meta tags and manifest
DIST="/root/webmail-app/dist"

# Add web manifest
cat > "$DIST/manifest.json" << 'MANIFEST'
{
  "name": "OneMundo Mail",
  "short_name": "Mail",
  "description": "Email, Chat, Calendar, Files - OneMundo",
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
sed -i 's|<link rel="icon" href="/favicon.ico" /></head>|<link rel="icon" href="/favicon.ico" /><link rel="manifest" href="/manifest.json" /><meta name="theme-color" content="#2563eb" /><meta name="description" content="OneMundo Mail - Email, Chat, Calendar, Files" /><meta name="apple-mobile-web-app-capable" content="yes" /><meta name="apple-mobile-web-app-status-bar-style" content="default" /><meta name="apple-mobile-web-app-title" content="OneMundo Mail" /></head>|' "$DIST/index.html"

echo "Web build enhanced with manifest and meta tags"
