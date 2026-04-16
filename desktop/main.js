'use strict';

const {
  app,
  BrowserWindow,
  BrowserView,
  Menu,
  Tray,
  shell,
  ipcMain,
  nativeImage,
  Notification,
  session,
  protocol,
  dialog,
  powerMonitor,
} = require('electron');
const path = require('path');
const os = require('os');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');

// ─── Constants ──────────────────────────────────────────────────────────────

const APP_URL = 'https://chatyy.com.br';
const PROTOCOL = 'chatyy';
const IS_DEV = process.argv.includes('--dev');
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

// ─── Persistent store (window size / prefs) ─────────────────────────────────

const store = new Store({
  defaults: {
    windowBounds: { width: 1200, height: 800, x: undefined, y: undefined },
    windowMaximized: false,
    minimizeToTray: true,
    launchOnStartup: false,
    notificationsEnabled: true,
  },
});

// ─── Globals ─────────────────────────────────────────────────────────────────

let mainWindow = null;
let tray = null;
let isQuitting = false;
let unreadCount = 0;

// ─── Logging ─────────────────────────────────────────────────────────────────

log.transports.file.level = 'info';
log.transports.console.level = IS_DEV ? 'debug' : 'warn';
autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// ─── Deep-link protocol registration ────────────────────────────────────────

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// Single-instance lock — forward deep-link args to already-running instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  // Handle deep link passed as argv on Win/Linux
  const deepLink = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
  if (deepLink) handleDeepLink(deepLink);
});

// macOS open-url event
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getIconPath(name = 'icon') {
  const base = path.join(__dirname, 'icons');
  if (IS_WIN) return path.join(base, `${name}.ico`);
  if (IS_MAC) return path.join(base, `${name}.icns`);
  return path.join(base, `${name}.png`);
}

function getTrayIconPath(badgeCount = 0) {
  const base = path.join(__dirname, 'icons');
  if (badgeCount > 0) return path.join(base, 'tray-badge.png');
  return path.join(base, 'tray.png');
}

function handleDeepLink(url) {
  log.info('Deep link received:', url);
  if (!mainWindow) return;
  // Forward the deep-link URL to the renderer so the SPA can handle routing
  mainWindow.webContents.send('deep-link', url);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function saveWindowBounds() {
  if (!mainWindow) return;
  if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
    store.set('windowBounds', mainWindow.getBounds());
  }
  store.set('windowMaximized', mainWindow.isMaximized());
}

// ─── Tray ────────────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = getTrayIconPath(0);
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    // Resize to appropriate tray size
    if (IS_WIN) trayIcon = trayIcon.resize({ width: 16, height: 16 });
    else if (IS_MAC) trayIcon = trayIcon.resize({ width: 22, height: 22 });
    else trayIcon = trayIcon.resize({ width: 24, height: 24 });
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Chatyy');

  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;

  const unreadLabel =
    unreadCount > 0 ? `${unreadCount} mensagem${unreadCount > 1 ? 'ns' : ''} não lida${unreadCount > 1 ? 's' : ''}` : 'Nenhuma mensagem não lida';

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Chatyy',
      enabled: false,
      icon: (() => {
        try {
          return nativeImage
            .createFromPath(path.join(__dirname, 'icons', 'tray.png'))
            .resize({ width: 16, height: 16 });
        } catch {
          return undefined;
        }
      })(),
    },
    { type: 'separator' },
    { label: unreadLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Abrir Chatyy',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: 'Novas mensagens',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('navigate', '/chat');
      },
    },
    { type: 'separator' },
    {
      label: 'Iniciar com o sistema',
      type: 'checkbox',
      checked: store.get('launchOnStartup'),
      click: (menuItem) => {
        const enabled = menuItem.checked;
        store.set('launchOnStartup', enabled);
        app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
      },
    },
    {
      label: 'Minimizar para bandeja',
      type: 'checkbox',
      checked: store.get('minimizeToTray'),
      click: (menuItem) => store.set('minimizeToTray', menuItem.checked),
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function updateTrayBadge(count) {
  unreadCount = count;

  // macOS dock badge
  if (IS_MAC) {
    app.dock.setBadge(count > 0 ? String(count > 99 ? '99+' : count) : '');
  }

  // Windows taskbar overlay icon
  if (IS_WIN && mainWindow) {
    if (count > 0) {
      try {
        const overlayIcon = nativeImage.createFromPath(
          path.join(__dirname, 'icons', 'badge-overlay.png')
        );
        mainWindow.setOverlayIcon(overlayIcon, `${count} mensagens não lidas`);
      } catch {
        mainWindow.setOverlayIcon(null, '');
      }
    } else {
      mainWindow.setOverlayIcon(null, '');
    }
  }

  // Tray icon
  if (tray) {
    const iconPath = getTrayIconPath(count);
    try {
      let icon = nativeImage.createFromPath(iconPath);
      if (IS_WIN) icon = icon.resize({ width: 16, height: 16 });
      else if (IS_MAC) icon = icon.resize({ width: 22, height: 22 });
      else icon = icon.resize({ width: 24, height: 24 });
      tray.setImage(icon);
    } catch {
      /* icon file missing, ignore */
    }
    tray.setToolTip(count > 0 ? `Chatyy (${count})` : 'Chatyy');
    updateTrayMenu();
  }

  // Linux unity counter
  if (IS_LINUX) {
    try {
      app.setBadgeCount(count);
    } catch {
      /* not supported on all DEs */
    }
  }
}

// ─── Native Menu Bar ─────────────────────────────────────────────────────────

function buildMenu() {
  const template = [
    // macOS app menu
    ...(IS_MAC
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: `Sobre o ${app.name}` },
              { type: 'separator' },
              {
                label: 'Preferências…',
                accelerator: 'CmdOrCtrl+,',
                click: () => mainWindow?.webContents.send('navigate', '/settings'),
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide', label: `Ocultar ${app.name}` },
              { role: 'hideOthers', label: 'Ocultar outros' },
              { role: 'unhide', label: 'Mostrar tudo' },
              { type: 'separator' },
              { role: 'quit', label: `Sair do ${app.name}` },
            ],
          },
        ]
      : []),
    {
      label: 'Arquivo',
      submenu: [
        {
          label: 'Nova conversa',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('navigate', '/chat/new'),
        },
        {
          label: 'Nova mensagem de e-mail',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => mainWindow?.webContents.send('navigate', '/compose'),
        },
        { type: 'separator' },
        ...(IS_MAC ? [] : [{ role: 'quit', label: 'Sair' }]),
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer' },
        { role: 'redo', label: 'Refazer' },
        { type: 'separator' },
        { role: 'cut', label: 'Recortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Colar' },
        { role: 'selectAll', label: 'Selecionar tudo' },
        { type: 'separator' },
        {
          label: 'Localizar…',
          accelerator: 'CmdOrCtrl+F',
          click: () => mainWindow?.webContents.send('focus-search'),
        },
      ],
    },
    {
      label: 'Exibir',
      submenu: [
        {
          label: 'Recarregar',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.reload(),
        },
        {
          label: 'Recarregar forçado',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => mainWindow?.webContents.reloadIgnoringCache(),
        },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom padrão' },
        { role: 'zoomIn', label: 'Ampliar' },
        { role: 'zoomOut', label: 'Reduzir' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tela cheia' },
        ...(IS_DEV
          ? [
              { type: 'separator' },
              { role: 'toggleDevTools', label: 'Ferramentas de desenvolvimento' },
            ]
          : []),
      ],
    },
    {
      label: 'Ir para',
      submenu: [
        {
          label: 'Caixa de entrada',
          accelerator: 'CmdOrCtrl+1',
          click: () => mainWindow?.webContents.send('navigate', '/inbox'),
        },
        {
          label: 'Chatyy (Chat)',
          accelerator: 'CmdOrCtrl+2',
          click: () => mainWindow?.webContents.send('navigate', '/chat'),
        },
        {
          label: 'Calendário',
          accelerator: 'CmdOrCtrl+3',
          click: () => mainWindow?.webContents.send('navigate', '/calendar'),
        },
        {
          label: 'Arquivos',
          accelerator: 'CmdOrCtrl+4',
          click: () => mainWindow?.webContents.send('navigate', '/files'),
        },
        {
          label: 'Contatos',
          accelerator: 'CmdOrCtrl+5',
          click: () => mainWindow?.webContents.send('navigate', '/contacts'),
        },
        { type: 'separator' },
        {
          label: 'Voltar',
          accelerator: IS_MAC ? 'Cmd+[' : 'Alt+Left',
          click: () => {
            if (mainWindow?.webContents.canGoBack()) mainWindow.webContents.goBack();
          },
        },
        {
          label: 'Avançar',
          accelerator: IS_MAC ? 'Cmd+]' : 'Alt+Right',
          click: () => {
            if (mainWindow?.webContents.canGoForward()) mainWindow.webContents.goForward();
          },
        },
      ],
    },
    {
      label: 'Janela',
      role: 'window',
      submenu: [
        { role: 'minimize', label: 'Minimizar' },
        { role: 'zoom', label: 'Maximizar' },
        ...(IS_MAC
          ? [{ type: 'separator' }, { role: 'front', label: 'Trazer tudo para frente' }]
          : [
              {
                label: 'Minimizar para bandeja',
                accelerator: 'CmdOrCtrl+W',
                click: () => {
                  if (store.get('minimizeToTray')) mainWindow?.hide();
                  else mainWindow?.minimize();
                },
              },
            ]),
      ],
    },
    {
      label: 'Ajuda',
      role: 'help',
      submenu: [
        {
          label: 'Visitar chatyy.com.br',
          click: () => shell.openExternal('https://chatyy.com.br'),
        },
        {
          label: 'Suporte',
          click: () => shell.openExternal('https://chatyy.com.br/suporte'),
        },
        { type: 'separator' },
        {
          label: `Versão ${app.getVersion()}`,
          enabled: false,
        },
        {
          label: 'Verificar atualizações…',
          click: () => autoUpdater.checkForUpdatesAndNotify(),
        },
        ...(IS_DEV
          ? [
              { type: 'separator' },
              {
                label: 'Abrir dados do app…',
                click: () => shell.openPath(app.getPath('userData')),
              },
              {
                label: 'Abrir logs…',
                click: () => shell.openPath(log.transports.file.getFile().path),
              },
            ]
          : []),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── Main Window ─────────────────────────────────────────────────────────────

function createWindow() {
  const bounds = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 800,
    minHeight: 600,
    title: 'Chatyy',
    backgroundColor: '#1a1a2e',
    show: false, // show after ready-to-show
    icon: getIconPath('icon'),
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 20, y: 18 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Allow web notifications
      nativeWindowOpen: true,
      // Persist session across restarts
      partition: 'persist:chatyy',
    },
  });

  // ── restore maximized state
  if (store.get('windowMaximized')) mainWindow.maximize();

  // ── Load the app
  mainWindow.loadURL(APP_URL);

  // ── Show window when page is ready (prevents white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // ── Persist window bounds on resize/move
  mainWindow.on('resize', saveWindowBounds);
  mainWindow.on('move', saveWindowBounds);

  // ── Intercept close to minimize-to-tray
  mainWindow.on('close', (event) => {
    saveWindowBounds();
    if (!isQuitting && store.get('minimizeToTray')) {
      event.preventDefault();
      mainWindow.hide();
      // On macOS, hide dock icon too so the app feels "backgrounded"
      if (IS_MAC && app.dock) app.dock.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ── Show window/dock when focused from tray
  mainWindow.on('show', () => {
    if (IS_MAC && app.dock) app.dock.show();
  });

  // ── Open external links in default browser (not in-app)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Open mailto: and external http(s) in default browser
    if (url.startsWith('http') && !url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    if (url.startsWith('mailto:')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // ── Block navigation away from our app domain
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const parsed = new URL(url);
    const allowed = new URL(APP_URL);
    if (parsed.hostname !== allowed.hostname) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // ── Page title → window title (strip site suffix)
  mainWindow.webContents.on('page-title-updated', (_event, title) => {
    // Extract unread count from title like "(3) Chatyy" or "Chatyy"
    const match = title.match(/^\((\d+)\)/);
    if (match) {
      updateTrayBadge(parseInt(match[1], 10));
    }
    mainWindow.setTitle(title.replace(/ ?[-–|] ?Chatyy.*$/, '') || 'Chatyy');
  });

  // ── Forward permission requests (camera, mic, notifications)
  session.fromPartition('persist:chatyy').setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = ['notifications', 'media', 'mediaKeySystem', 'geolocation', 'clipboard-read'];
      callback(allowed.includes(permission));
    }
  );

  // ── Certificate errors — only allow our own domain
  mainWindow.webContents.on(
    'certificate-error',
    (event, _url, _error, _cert, callback) => {
      event.preventDefault();
      callback(false); // reject invalid certs
    }
  );
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────

function registerIpcHandlers() {
  // Renderer reports unread count
  ipcMain.on('badge-count', (_event, count) => {
    updateTrayBadge(typeof count === 'number' ? count : 0);
  });

  // Renderer requests a native desktop notification
  ipcMain.on('show-notification', (_event, { title, body, icon, tag }) => {
    if (!store.get('notificationsEnabled')) return;
    if (!Notification.isSupported()) return;

    const notif = new Notification({
      title: title || 'Chatyy',
      body: body || '',
      icon: icon
        ? nativeImage.createFromDataURL(icon)
        : getIconPath('icon'),
      tag: tag,
      silent: false,
    });

    notif.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });

    notif.show();
  });

  // Renderer asks for stored preference
  ipcMain.handle('get-preference', (_event, key) => store.get(key));

  // Renderer sets a preference
  ipcMain.on('set-preference', (_event, key, value) => {
    store.set(key, value);
    if (key === 'launchOnStartup') {
      app.setLoginItemSettings({ openAtLogin: value, openAsHidden: true });
    }
    if (key === 'minimizeToTray') {
      updateTrayMenu();
    }
  });

  // Renderer asks for app/platform info
  ipcMain.handle('app-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
  }));

  // Renderer requests to open a URL externally
  ipcMain.on('open-external', (_event, url) => {
    shell.openExternal(url);
  });

  // Renderer requests to show/hide the window
  ipcMain.on('window-show', () => mainWindow?.show());
  ipcMain.on('window-hide', () => mainWindow?.hide());
  ipcMain.on('window-minimize', () => mainWindow?.minimize());

  // Auto-updater controls
  ipcMain.handle('check-updates', () => autoUpdater.checkForUpdatesAndNotify());
  ipcMain.on('install-update', () => {
    isQuitting = true;
    autoUpdater.quitAndInstall();
  });
}

// ─── Auto-updater events ──────────────────────────────────────────────────────

function setupAutoUpdater() {
  autoUpdater.on('checking-for-update', () => log.info('Verificando atualizações...'));
  autoUpdater.on('update-available', (info) => {
    log.info('Atualização disponível:', info.version);
    mainWindow?.webContents.send('update-available', info);
  });
  autoUpdater.on('update-not-available', () => log.info('App está atualizado.'));
  autoUpdater.on('error', (err) => log.error('Erro no auto-updater:', err));
  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update-progress', progress);
  });
  autoUpdater.on('update-downloaded', (info) => {
    log.info('Atualização baixada:', info.version);
    mainWindow?.webContents.send('update-downloaded', info);

    // Show native notification about the update
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: 'Chatyy — Atualização disponível',
        body: `Versão ${info.version} está pronta para instalar. Clique para reiniciar.`,
      });
      notif.on('click', () => {
        isQuitting = true;
        autoUpdater.quitAndInstall();
      });
      notif.show();
    }
  });
}

// ─── Keyboard shortcuts (global) ─────────────────────────────────────────────
// Note: Most shortcuts are handled via the Menu. Cmd+Q / Alt+F4 we intercept
// at the before-quit level so close goes to tray instead.

app.on('before-quit', () => {
  isQuitting = true;
});

// On non-Mac, Alt+F4 triggers window close event which is already intercepted.
// We additionally intercept Cmd+Q on Mac to distinguish "real quit" from close.

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  log.info(`Chatyy ${app.getVersion()} iniciando em ${process.platform}`);

  // Apply startup launch preference
  const launchOnStartup = store.get('launchOnStartup');
  app.setLoginItemSettings({ openAtLogin: launchOnStartup, openAsHidden: true });

  registerIpcHandlers();
  buildMenu();
  createWindow();
  createTray();
  setupAutoUpdater();

  // Check for updates 5 seconds after launch (not in dev)
  if (!IS_DEV && app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdatesAndNotify().catch(log.warn), 5000);
  }

  app.on('activate', () => {
    // macOS: re-open window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS, keep running in tray even with no windows
  if (!IS_MAC) app.quit();
});

// Power events — reconnect WebSocket after sleep
powerMonitor.on('resume', () => {
  log.info('Sistema voltou do sono, recarregando...');
  setTimeout(() => mainWindow?.webContents.send('power-resume'), 2000);
});
