/**
 * Agent Salad - Electron Main Process
 *
 * 서버 프로세스를 child_process로 관리하고,
 * BrowserWindow에 상태 페이지 또는 웹 UI를 표시.
 * 시스템 트레이로 백그라운드 동작 지원.
 * 앱 아이콘: build/icon.{icns,ico,png} — BrowserWindow + electron-builder 모두 적용.
 *
 * 동작:
 *  - X 버튼 → 창 숨김 (트레이에 유지, 서버 계속 동작)
 *  - 트레이 Quit / Cmd+Q → 서버 kill + 앱 완전 종료
 *  - 트레이 클릭 → 창 다시 표시
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  type NativeImage,
} from 'electron';
import path from 'path';
import { ServerManager, type ServerStatus } from './server-manager';
import { startUpdateChecker, stopUpdateChecker, getAvailableUpdate, openReleasePage } from './update-checker';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
const serverManager = new ServerManager();
let isQuitting = false;

// ── Tray Icons ──────────────────────────────────────────────

function createTrayIcon(color: 'green' | 'red' | 'gray'): NativeImage {
  const palette: Record<string, string> = {
    green: '#22c55e',
    red: '#ef4444',
    gray: '#9ca3af',
  };
  const fill = palette[color];

  const size = 32;
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="${fill}" />
    </svg>`;

  const img = nativeImage.createFromBuffer(
    Buffer.from(svg),
    { scaleFactor: 2 },
  );
  if (process.platform === 'darwin') {
    img.setTemplateImage(false);
  }
  return img;
}

const TRAY_ICONS: Record<ServerStatus, NativeImage> = {} as Record<
  ServerStatus,
  NativeImage
>;

function initTrayIcons(): void {
  TRAY_ICONS.stopped = createTrayIcon('gray');
  TRAY_ICONS.starting = createTrayIcon('gray');
  TRAY_ICONS.running = createTrayIcon('green');
  TRAY_ICONS.error = createTrayIcon('red');
}

// ── Window ──────────────────────────────────────────────────

async function createWindow(): Promise<void> {
  const preloadPath = path.join(__dirname, 'preload.js');
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'Agent Salad',
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // 서버가 이미 떠있으면 바로 웹 UI, 아니면 상태 페이지
  const alreadyRunning = await serverManager.detectRunningServer();
  if (alreadyRunning) {
    loadWebUI();
  } else {
    loadStatusPage();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // X 버튼 → 창 숨김 (트레이에 유지). Quit 시에만 실제 종료.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
      if (process.platform === 'darwin') {
        app.dock?.hide();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function loadStatusPage(): void {
  const htmlPath = path.join(
    app.isPackaged ? __dirname : path.resolve(__dirname, '..', 'electron'),
    'renderer',
    'index.html',
  );
  mainWindow?.loadFile(htmlPath);
}

function loadWebUI(): void {
  mainWindow?.loadURL('http://127.0.0.1:3210');
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  mainWindow.show();
  if (process.platform === 'darwin') {
    app.dock?.show();
  }
}

// ── Tray ────────────────────────────────────────────────────

function createTray(): void {
  tray = new Tray(TRAY_ICONS.stopped);
  tray.setToolTip('Agent Salad — Stopped');
  updateTrayMenu();

  tray.on('click', () => {
    showWindow();
  });

  // macOS: Dock 아이콘 클릭 시 창 복원
  app.on('activate', () => {
    showWindow();
  });
}

function updateTrayMenu(): void {
  const isRunning = serverManager.status === 'running';
  const isStarting = serverManager.status === 'starting';
  const update = getAvailableUpdate();

  const template: Electron.MenuItemConstructorOptions[] = [];

  if (update) {
    template.push(
      { label: `Update available: v${update.latestVersion}`, click: () => openReleasePage() },
      { type: 'separator' },
    );
  }

  template.push(
    {
      label: isRunning ? 'Server Running' : isStarting ? 'Starting...' : 'Server Stopped',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Start Server',
      enabled: !isRunning && !isStarting,
      click: () => serverManager.start(),
    },
    {
      label: 'Stop Server',
      enabled: isRunning || isStarting,
      click: () => void serverManager.stop(),
    },
    { type: 'separator' },
    {
      label: 'Show Window',
      click: () => showWindow(),
    },
    { type: 'separator' },
    {
      label: 'Quit Agent Salad',
      click: () => {
        isQuitting = true;
        void serverManager.stop().finally(() => {
          app.quit();
        });
      },
    },
  );

  tray?.setContextMenu(Menu.buildFromTemplate(template));
}

function updateTrayForStatus(status: ServerStatus): void {
  const icon = TRAY_ICONS[status];
  if (icon) tray?.setImage(icon);

  const labels: Record<ServerStatus, string> = {
    stopped: 'Agent Salad — Stopped',
    starting: 'Agent Salad — Starting...',
    running: 'Agent Salad — Running',
    error: 'Agent Salad — Error',
  };
  tray?.setToolTip(labels[status]);
  updateTrayMenu();
}

// ── IPC Handlers ────────────────────────────────────────────

function setupIPC(): void {
  ipcMain.handle('server:start', () => {
    serverManager.start();
  });

  ipcMain.handle('server:stop', async () => {
    await serverManager.stop();
  });

  ipcMain.handle('server:status', () => {
    return serverManager.status;
  });

  ipcMain.handle('server:logs', () => {
    return serverManager.logs;
  });
}

// ── Server Events → Window/Tray ─────────────────────────────

function setupServerEvents(): void {
  serverManager.on('status-changed', (status: ServerStatus) => {
    mainWindow?.webContents.send('server:status-changed', status);
    updateTrayForStatus(status);

    if (status === 'running') {
      loadWebUI();
    } else if (status === 'stopped' || status === 'error') {
      // 서버가 꺼지면 상태 페이지로 전환.
      // loadURL 중이면 돌아올 수 없으므로 상태 페이지 reload.
      loadStatusPage();
    }
  });

  serverManager.on('log', (line: string) => {
    mainWindow?.webContents.send('server:log', line);
  });
}

// ── App Lifecycle ───────────────────────────────────────────

app.whenReady().then(async () => {
  initTrayIcons();
  setupIPC();
  setupServerEvents();
  await createWindow();
  createTray();
  updateTrayForStatus(serverManager.status);
  startUpdateChecker();
});

// macOS: Cmd+Q → 완전 종료
app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', (e) => {
  stopUpdateChecker();
  if (serverManager.status === 'running' || serverManager.status === 'starting') {
    e.preventDefault();
    void serverManager.stop().finally(() => {
      app.quit();
    });
  }
});

// Windows/Linux: 모든 창 닫혀도 트레이로 유지
app.on('window-all-closed', () => {
  // 트레이가 있으므로 종료하지 않음
});
