'use strict';

/**
 * build-config.js — electron-builder configuration for Chatyy Desktop
 *
 * Produces:
 *   Windows : NSIS installer (.exe) + portable (.exe)
 *   macOS   : DMG + ZIP (for auto-updater)
 *   Linux   : AppImage + .deb + .rpm
 *
 * Usage (from desktop/ directory):
 *   npm run build:win
 *   npm run build:mac
 *   npm run build:linux
 *   npm run build:all
 */

module.exports = {
  // ── App metadata ───────────────────────────────────────────────────────────
  appId: 'com.onemundo.chatyy',
  productName: 'Chatyy',
  copyright: `Copyright © ${new Date().getFullYear()} Onemundo`,

  // ── Files to include in the package ───────────────────────────────────────
  files: [
    'main.js',
    'preload.js',
    'icons/**',
    'node_modules/**',
    'package.json',
  ],

  // ── Extra resources (outside asar, accessible at runtime) ─────────────────
  extraResources: [
    {
      from: 'icons/',
      to: 'icons/',
      filter: ['**/*'],
    },
  ],

  // ── ASAR archive ───────────────────────────────────────────────────────────
  asar: true,
  asarUnpack: [
    // Native modules need to be outside asar
    'node_modules/electron-log/**',
  ],

  // ── Auto-update publish config ─────────────────────────────────────────────
  // Set GITHUB_TOKEN env var when publishing.
  // Change to your actual GitHub org/repo.
  publish: [
    {
      provider: 'github',
      owner: 'onemundo',
      repo: 'chatyy-desktop',
      releaseType: 'release',
    },
  ],

  // ═══════════════════════════════════════════════════════════════════════════
  // Windows
  // ═══════════════════════════════════════════════════════════════════════════
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64', 'arm64'],
      },
      {
        target: 'portable',
        arch: ['x64'],
      },
    ],
    icon: 'icons/icon.ico',
    // Code signing (set env vars: WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD)
    // certificateFile: process.env.WIN_CSC_LINK,
    // certificatePassword: process.env.WIN_CSC_KEY_PASSWORD,
    // signingHashAlgorithms: ['sha256'],
    publisherName: 'Onemundo',
    verifyUpdateCodeSignature: false, // set true when signing is set up
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    allowElevation: true,
    installerIcon: 'icons/icon.ico',
    uninstallerIcon: 'icons/icon.ico',
    installerHeaderIcon: 'icons/icon.ico',
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Chatyy',
    displayLanguageSelector: false,
    language: '1046', // Portuguese (Brazil)
    include: undefined,
    script: undefined,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // macOS
  // ═══════════════════════════════════════════════════════════════════════════
  mac: {
    target: [
      {
        target: 'dmg',
        arch: ['x64', 'arm64', 'universal'],
      },
      {
        target: 'zip',
        arch: ['x64', 'arm64', 'universal'],
      },
    ],
    icon: 'icons/icon.icns',
    category: 'public.app-category.social-networking',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // Code signing (set env var: APPLE_ID, APPLE_ID_PASSWORD, APPLE_TEAM_ID)
    // identity: process.env.APPLE_IDENTITY,
    extendInfo: {
      NSCameraUsageDescription: 'Chatyy precisa da câmera para videochamadas.',
      NSMicrophoneUsageDescription: 'Chatyy precisa do microfone para chamadas de voz.',
      NSUserNotificationAlertStyle: 'alert',
    },
    // Protocol handler registration
    protocols: [
      {
        name: 'Chatyy',
        schemes: ['chatyy'],
      },
    ],
  },

  dmg: {
    title: 'Instalar Chatyy',
    icon: 'icons/icon.icns',
    background: 'build/dmg-background.png', // optional: 540x380 px background
    iconSize: 80,
    iconTextSize: 12,
    window: { width: 540, height: 380 },
    contents: [
      { x: 150, y: 190, type: 'file' },
      { x: 390, y: 190, type: 'link', path: '/Applications' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Linux
  // ═══════════════════════════════════════════════════════════════════════════
  linux: {
    target: [
      { target: 'AppImage', arch: ['x64', 'arm64'] },
      { target: 'deb', arch: ['x64', 'arm64'] },
      { target: 'rpm', arch: ['x64'] },
    ],
    icon: 'icons/',
    category: 'Network;InstantMessaging;Chat;',
    synopsis: 'Super App de comunicação',
    description:
      'Chatyy — e-mail, chat, videochamadas, calendário e arquivos em um só lugar.',
    maintainer: 'Onemundo <suporte@chatyy.com.br>',
    vendor: 'Onemundo',
    // Desktop integration
    desktop: {
      MimeType: 'x-scheme-handler/chatyy;',
    },
  },

  deb: {
    depends: ['libnotify4', 'libxtst6', 'libnss3'],
    recommends: ['libappindicator3-1'],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Auto-update (electron-updater)
  // ═══════════════════════════════════════════════════════════════════════════
  // Generates latest.yml / latest-mac.yml / latest-linux.yml on publish
  generateUpdatesFilesForAllChannels: true,
};
