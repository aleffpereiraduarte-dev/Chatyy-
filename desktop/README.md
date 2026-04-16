# Chatyy Desktop

Electron wrapper for [chatyy.com.br](https://chatyy.com.br) — gives Chatyy a native desktop experience on Windows, macOS and Linux.

## Features

- Loads `https://chatyy.com.br` in a native window with persistent session
- **System tray** with unread badge (disappears when all messages read)
- **Native OS notifications** (bypasses web push — works even when window is hidden)
- **Minimize to tray** on Cmd+W / Alt+F4 / window close (configurable)
- **Deep links** via `chatyy://` protocol — e.g. `chatyy://chat/123`
- **Auto-launch on startup** (configurable from tray menu)
- **Window size/position persistence** across restarts
- **Auto-updater** (electron-updater via GitHub Releases)
- **Back/Forward** navigation (Alt+Left/Right, Cmd+[/])
- Full **native menu bar** with keyboard shortcuts
- macOS: dock badge, traffic light buttons, hiddenInset title bar
- Windows: taskbar overlay badge icon
- Linux: unity badge count, .deb / .rpm / AppImage targets

## Quick Start (Development)

```bash
cd desktop/
npm install
npm start
```

Pass `--dev` to open DevTools automatically:

```bash
npm run dev
```

## Building

### Prerequisites

| Platform | Requirements |
|----------|-------------|
| Windows  | Node 18+, Windows 10+ (build on Windows or use Wine on Linux/Mac) |
| macOS    | Node 18+, Xcode CLI tools, optionally Apple Developer account for signing |
| Linux    | Node 18+, `fakeroot`, `rpm` (for RPM target) |

Install dependencies first:

```bash
cd desktop/
npm install
```

### Generate Icons (first time only)

Icons are pre-generated in `icons/` from the source Chatyy PNG. To re-generate:

```bash
# Requires: imagemagick (brew install imagemagick / apt install imagemagick)
bash scripts/generate-icons.sh
```

For macOS `.icns`, run `generate-icons.sh` on a Mac (requires `iconutil` from Xcode).

### Build Commands

```bash
# Windows installer (.exe) — run on Windows or with Wine
npm run build:win

# macOS DMG — must run on macOS for correct signing
npm run build:mac

# Linux AppImage + .deb + .rpm
npm run build:linux

# All platforms (requires all toolchains)
npm run build:all
```

Build output goes to `dist/`.

### Code Signing

#### macOS

```bash
export APPLE_ID="you@example.com"
export APPLE_ID_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="XXXXXXXXXX"
```

Uncomment `identity` in `build-config.js → mac` section.

#### Windows

```bash
export WIN_CSC_LINK="path/to/cert.p12"
export WIN_CSC_KEY_PASSWORD="cert-password"
```

Uncomment the `certificateFile`/`certificatePassword` lines in `build-config.js → win`.

## Auto-Updater (GitHub Releases)

1. Push a new release tag: `git tag v2.3.1 && git push --tags`
2. Build with `GITHUB_TOKEN=xxx npm run build:all` — electron-builder uploads artifacts and
   creates `latest.yml` / `latest-mac.yml` / `latest-linux.yml` automatically.
3. Running apps will check for updates 5 seconds after launch and download in the background.
   The tray notification fires when ready; user clicks to restart.

Update the `publish` section in `build-config.js` with your real GitHub org/repo.

## Deep Links

Register the `chatyy://` protocol by installing the app (NSIS/DMG/AppImage auto-registers it).
For development, run `npm start` once — Electron calls `app.setAsDefaultProtocolClient`.

Example URLs:

| URL | Opens |
|-----|-------|
| `chatyy://chat` | Chat tab |
| `chatyy://inbox` | Email inbox |
| `chatyy://meet/room-id` | Join meeting room |
| `chatyy://calendar` | Calendar |

The web app receives deep links via:

```js
window.chatyy.on('navigate', (path) => {
  // path = '/chat', '/inbox', etc.
  router.push(path); // or window.location.hash = path
});
```

## Web App Integration (window.chatyy API)

The preload script exposes `window.chatyy` to the web app:

```js
// Detect desktop
if (window.chatyy?.isDesktop) { /* desktop-specific code */ }

// Update tray badge + dock badge + taskbar overlay
window.chatyy.setBadgeCount(5);

// Native notification
window.chatyy.showNotification({ title: 'Nova mensagem', body: 'Oi!' });

// Preferences
await window.chatyy.getPreference('minimizeToTray'); // → true/false
window.chatyy.setPreference('launchOnStartup', true);

// Open link in default browser
window.chatyy.openExternal('https://example.com');

// Listen for events from main process
const unsub = window.chatyy.on('navigate', (path) => router.push(path));
// Later: unsub() to remove listener

// App info
const info = await window.chatyy.getAppInfo();
// → { version, platform, arch, isPackaged }

// Updater
await window.chatyy.updater.check();
window.chatyy.on('update-downloaded', ({ version }) => {
  if (confirm(`Instalar versão ${version} agora?`)) window.chatyy.updater.install();
});

// Power resume (e.g. reconnect WebSocket after sleep)
window.chatyy.on('power-resume', () => wsClient.reconnect());
```

## Directory Structure

```
desktop/
├── main.js              Main process — BrowserWindow, tray, menu, IPC
├── preload.js           Renderer bridge — contextBridge, Notification override
├── build-config.js      electron-builder config (Win/Mac/Linux)
├── package.json         npm config, scripts, dependencies
├── icons/               Generated icon files (all sizes)
│   ├── source.png       Source icon (1024x1024) — edit this to rebrand
│   ├── icon.png         256px PNG (Linux)
│   ├── icon.ico         Multi-size ICO (Windows)
│   ├── icon.icns        ICNS (macOS — regenerate with iconutil on Mac)
│   ├── tray.png         22px tray icon
│   └── tray-badge.png   22px tray icon with red badge dot
├── build/
│   └── entitlements.mac.plist   macOS sandbox entitlements
└── scripts/
    └── generate-icons.sh        Generates all icon sizes from source.png
```
