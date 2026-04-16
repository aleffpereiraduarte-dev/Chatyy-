#!/usr/bin/env bash
# generate-icons.sh — Generate all required icon sizes for Chatyy Desktop
#
# Requires:
#   macOS:  brew install imagemagick
#   Linux:  sudo apt install imagemagick
#   Win:    choco install imagemagick  OR use WSL
#
# Source icon: ../icons/source.png  (must be at least 1024x1024 px)
# If you don't have a source icon, copy assets/icon.png from the root of the repo:
#   cp ../../assets/icon.png ../icons/source.png

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ICONS_DIR="$SCRIPT_DIR/../icons"
SOURCE="$ICONS_DIR/source.png"

if [ ! -f "$SOURCE" ]; then
  # Try to use the repo's existing icon as source
  REPO_ICON="$SCRIPT_DIR/../../assets/icon.png"
  if [ -f "$REPO_ICON" ]; then
    echo "Using repo icon as source: $REPO_ICON"
    cp "$REPO_ICON" "$SOURCE"
  else
    echo "ERROR: No source icon found."
    echo "Place a 1024x1024 PNG at: $SOURCE"
    exit 1
  fi
fi

mkdir -p "$ICONS_DIR"

echo "Generating PNG icons..."
for SIZE in 16 24 32 48 64 128 256 512 1024; do
  convert "$SOURCE" -resize "${SIZE}x${SIZE}" "$ICONS_DIR/icon-${SIZE}.png"
  echo "  icon-${SIZE}.png"
done

# icon.png (256px) — Linux tray / generic
cp "$ICONS_DIR/icon-256.png" "$ICONS_DIR/icon.png"

# tray icons (22x22 template for macOS, 24x24 for others)
convert "$SOURCE" -resize "22x22" "$ICONS_DIR/tray.png"
convert "$SOURCE" -resize "22x22" "$ICONS_DIR/trayTemplate.png"   # macOS dark mode

# Tray icon with badge dot (red dot overlay)
composite \
  -gravity SouthEast \
  -geometry +0+0 \
  <(convert -size 8x8 xc:red -fill red -draw "circle 4,4 4,1" png:-) \
  "$ICONS_DIR/tray.png" \
  "$ICONS_DIR/tray-badge.png" 2>/dev/null || cp "$ICONS_DIR/tray.png" "$ICONS_DIR/tray-badge.png"

echo "Generating Windows ICO (multi-size)..."
convert \
  "$ICONS_DIR/icon-16.png" \
  "$ICONS_DIR/icon-24.png" \
  "$ICONS_DIR/icon-32.png" \
  "$ICONS_DIR/icon-48.png" \
  "$ICONS_DIR/icon-64.png" \
  "$ICONS_DIR/icon-128.png" \
  "$ICONS_DIR/icon-256.png" \
  "$ICONS_DIR/icon.ico"
echo "  icon.ico"

# Badge overlay (Windows taskbar — small red dot 16x16)
convert -size 16x16 xc:none \
  -fill red -draw "circle 8,8 8,2" \
  -fill white -font DejaVu-Sans-Bold -pointsize 9 \
  -gravity center -annotate 0 "!" \
  "$ICONS_DIR/badge-overlay.png" 2>/dev/null || cp "$ICONS_DIR/icon-16.png" "$ICONS_DIR/badge-overlay.png"

echo "Generating macOS ICNS..."
# macOS iconutil requires a specific directory structure
ICONSET_DIR="$ICONS_DIR/AppIcon.iconset"
mkdir -p "$ICONSET_DIR"
cp "$ICONS_DIR/icon-16.png"   "$ICONSET_DIR/icon_16x16.png"
cp "$ICONS_DIR/icon-32.png"   "$ICONSET_DIR/icon_16x16@2x.png"
cp "$ICONS_DIR/icon-32.png"   "$ICONSET_DIR/icon_32x32.png"
cp "$ICONS_DIR/icon-64.png"   "$ICONSET_DIR/icon_32x32@2x.png"
cp "$ICONS_DIR/icon-128.png"  "$ICONSET_DIR/icon_128x128.png"
cp "$ICONS_DIR/icon-256.png"  "$ICONSET_DIR/icon_128x128@2x.png"
cp "$ICONS_DIR/icon-256.png"  "$ICONSET_DIR/icon_256x256.png"
cp "$ICONS_DIR/icon-512.png"  "$ICONSET_DIR/icon_256x256@2x.png"
cp "$ICONS_DIR/icon-512.png"  "$ICONSET_DIR/icon_512x512.png"
cp "$ICONS_DIR/icon-1024.png" "$ICONSET_DIR/icon_512x512@2x.png"

if command -v iconutil &>/dev/null; then
  iconutil -c icns "$ICONSET_DIR" -o "$ICONS_DIR/icon.icns"
  echo "  icon.icns (via iconutil)"
else
  # Fallback: png2icns or skip
  if command -v png2icns &>/dev/null; then
    png2icns "$ICONS_DIR/icon.icns" \
      "$ICONS_DIR/icon-512.png" \
      "$ICONS_DIR/icon-256.png" \
      "$ICONS_DIR/icon-128.png" \
      "$ICONS_DIR/icon-32.png" \
      "$ICONS_DIR/icon-16.png"
    echo "  icon.icns (via png2icns)"
  else
    # Last resort: use 512px PNG as placeholder (won't work for distribution)
    cp "$ICONS_DIR/icon-512.png" "$ICONS_DIR/icon.icns"
    echo "  icon.icns (placeholder — iconutil required for real macOS builds)"
  fi
fi

rm -rf "$ICONSET_DIR"

echo ""
echo "Done! Icons in: $ICONS_DIR"
ls -lh "$ICONS_DIR"/*.{png,ico,icns} 2>/dev/null || true
