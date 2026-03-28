/**
 * Maru - Electron Main Process
 *
 * 서버 프로세스를 child_process로 관리하고,
 * BrowserWindow에 상태 페이지 또는 웹 UI를 표시.
 * 시스템 트레이로 백그라운드 동작 지원.
 * 앱 아이콘: build/icon.{icns,ico,png} — BrowserWindow + electron-builder 모두 적용.
 * 트레이 아이콘: 상태별 컬러 원형 — 원시 RGBA에서 PNG 직접 생성.
 * 외부 링크: 127.0.0.1:3210 / file:// 외 URL은 시스템 브라우저로 열림.
 *
 * IPC: server:start/stop/status/logs + server:app-info(버전/OS) + server:open-external(URL).
 * app-info/open-external은 에러 화면의 Google Form 이슈 리포트에서 사용.
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
  shell,
  Tray,
  Menu,
  nativeImage,
  type NativeImage,
} from 'electron';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { ServerManager, type ServerStatus } from './server-manager';
import { startUpdateChecker, stopUpdateChecker, getAvailableUpdate, openReleasePage } from './update-checker';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
const serverManager = new ServerManager();
let isQuitting = false;

// ── Tray Icons (PNG 생성) ────────────────────────────────────
// Electron의 nativeImage.createFromBuffer는 PNG/JPEG만 디코딩.
// SVG 버퍼는 빈 이미지가 되므로, 원시 RGBA → PNG 직접 생성.

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([t, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(payload));
  return Buffer.concat([len, payload, crcBuf]);
}

function circlePng(size: number, r: number, g: number, b: number): Buffer {
  const cx = size / 2, cy = size / 2, rad = size / 2 - 1;
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.sqrt((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2);
      const o = y * stride + 1 + x * 4;
      const a = Math.min(1, Math.max(0, rad - d + 0.5));
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createTrayIcon(color: 'green' | 'red' | 'gray'): NativeImage {
  const rgb: Record<string, [number, number, number]> = {
    green: [34, 197, 94],
    red: [239, 68, 68],
    gray: [156, 163, 175],
  };
  const [r, g, b] = rgb[color];
  const png = circlePng(32, r, g, b);
  const img = nativeImage.createFromBuffer(png, { scaleFactor: 2 });
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
  TRAY_ICONS.checking = createTrayIcon('gray');
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
    title: 'Maru',
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

  // 외부 링크: 앱 내부가 아닌 시스템 기본 브라우저에서 열기.
  // 127.0.0.1:3210 (Web UI)과 상태 페이지(file://) 외 모든 URL을 외부로 보낸다.
  const isInternalUrl = (url: string) =>
    url.startsWith('http://127.0.0.1:3210') || url.startsWith('file://');

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternalUrl(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isInternalUrl(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

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
  const htmlPath = path.join(__dirname, '..', 'electron', 'renderer', 'index.html');
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
  tray.setToolTip('Maru — Stopped');
  updateTrayMenu();

  // macOS: 트레이 클릭 = 컨텍스트 메뉴 (OS 표준). click 핸들러에서
  // showWindow 호출 시 메뉴 팝업과 충돌해 깜빡임+Finder 포커스 발생.
  // Windows/Linux만 click→showWindow, macOS는 메뉴의 Show Window 사용.
  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      showWindow();
    });
  }

  // macOS: Dock 아이콘 클릭 시 창 복원
  app.on('activate', () => {
    showWindow();
  });
}

function updateTrayMenu(): void {
  const isRunning = serverManager.status === 'running';
  const isBusy = ['checking', 'starting'].includes(serverManager.status);
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
      label: isRunning ? 'Server Running' : isBusy ? 'Starting...' : 'Server Stopped',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Start Server',
      enabled: !isRunning && !isBusy,
      click: () => void serverManager.start(),
    },
    {
      label: 'Stop Server',
      enabled: isRunning || isBusy,
      click: () => void serverManager.stop(),
    },
    { type: 'separator' },
    {
      label: 'Show Window',
      click: () => showWindow(),
    },
    { type: 'separator' },
    {
      label: 'Quit Maru',
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
    stopped: 'Maru — Stopped',
    checking: 'Maru — Checking...',
    starting: 'Maru — Starting...',
    running: 'Maru — Running',
    error: 'Maru — Error',
  };
  tray?.setToolTip(labels[status]);
  updateTrayMenu();
}

// ── IPC Handlers ────────────────────────────────────────────

function setupIPC(): void {
  ipcMain.handle('server:start', async () => {
    await serverManager.start();
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

  ipcMain.handle('server:app-info', () => {
    const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
    return {
      version: app.getVersion(),
      os: `${platform} ${os.release()}`,
    };
  });

  ipcMain.handle('server:open-external', (_event, url: string) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url);
    }
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
