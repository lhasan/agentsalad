/**
 * ServerManager — agentsalad 서버 프로세스 생명주기 관리
 *
 * Node.js 번들링: 패키징 시 build/node/에 Node.js 풀 배포판(node + npm)을 포함.
 * node_modules 프리번들: 빌드 시 번들 Node.js로 npm install을 실행하여
 * app-server/node_modules/를 패키지에 포함. 런타임 npm install 불필요.
 * 번들 Node.js 우선 → 시스템 Node.js 폴백 → 둘 다 없으면 에러.
 *
 * PATH 복원: macOS GUI 앱은 터미널 PATH를 상속받지 못함.
 * 로그인 셸($SHELL -lc)에서 실제 PATH를 가져와 모든 child_process에 주입.
 * Windows는 GUI도 시스템 PATH를 상속하므로 불필요.
 *
 * 데이터 영속성: 패키징 시 AGENTSALAD_STORE_DIR을 app.getPath('userData')/store로
 * 설정하여 앱 번들 외부에 DB/워크스페이스를 저장. 앱 업데이트 시에도 데이터 보존.
 * 레거시 데이터(앱 번들 내 store/)가 있으면 자동 마이그레이션.
 *
 * 상태 흐름:
 *   stopped → (start)
 *     → checking   : PATH 복원 + Node.js 감지 + 데이터 마이그레이션
 *     → starting   : 서버 프로세스 spawn + health check
 *     → running    : 서버 정상 가동
 *     → error      : 어느 단계든 실패
 */
import { EventEmitter } from 'events';
import { spawn, execFile, type ChildProcess } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

export type ServerStatus =
  | 'stopped'
  | 'checking'
  | 'starting'
  | 'running'
  | 'error';

const HEALTH_CHECK_URL = 'http://127.0.0.1:3210';
const HEALTH_POLL_MS = 500;
const HEALTH_TIMEOUT_MS = 60_000;
const GRACEFUL_KILL_MS = 3_000;
const LOG_BUFFER_MAX = 300;

export class ServerManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private _status: ServerStatus = 'stopped';
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthStartedAt = 0;
  private logBuffer: string[] = [];
  private isExternalServer = false;
  private isStopping = false;
  private runningWatchTimer: ReturnType<typeof setInterval> | null = null;
  /** 로그인 셸에서 복원한 환경변수 (PATH 포함) */
  private shellEnv: Record<string, string> | null = null;
  /** detectNode에서 확정된 node 바이너리 경로 */
  private resolvedNodePath: string | null = null;

  get status(): ServerStatus {
    return this._status;
  }

  get logs(): string[] {
    return [...this.logBuffer];
  }

  private getAppRoot(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'app-server');
    }
    return app.getAppPath();
  }

  /**
   * 사용자 데이터 디렉토리 (DB, 워크스페이스 등).
   * 패키징: ~/Library/Application Support/AgentSalad/store (macOS 기준)
   * 개발: 프로젝트 루트의 store/ (기존 동작 유지)
   */
  private getStoreDir(): string {
    if (app.isPackaged) {
      return path.join(app.getPath('userData'), 'store');
    }
    return path.join(app.getAppPath(), 'store');
  }

  /**
   * 레거시 마이그레이션: 이전 버전에서 앱 번들 내부(appRoot/store/)에
   * 저장된 데이터를 userData/store/로 이동.
   * 새 위치에 DB가 이미 있으면 스킵 (마이그레이션 완료 또는 신규 설치).
   */
  private migrateStoreIfNeeded(): void {
    if (!app.isPackaged) return;

    const newStoreDir = this.getStoreDir();
    const legacyStoreDir = path.join(this.getAppRoot(), 'store');
    const newDbPath = path.join(newStoreDir, 'messages.db');
    const legacyDbPath = path.join(legacyStoreDir, 'messages.db');

    if (fs.existsSync(newDbPath) || !fs.existsSync(legacyDbPath)) return;

    this.appendLog('[migration] Legacy store detected inside app bundle, migrating...');
    try {
      fs.mkdirSync(newStoreDir, { recursive: true });
      this.copyDirRecursive(legacyStoreDir, newStoreDir);
      this.appendLog(`[migration] Data migrated to ${newStoreDir}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendLog(`[migration] Migration failed: ${msg} — starting fresh`);
    }
  }

  private copyDirRecursive(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (fs.existsSync(destPath)) continue;
      if (entry.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  // ── 셸 환경 복원 ──────────────────────────────────────────

  /**
   * macOS/Linux GUI 앱은 터미널 PATH를 상속받지 못함.
   * 사용자의 로그인 셸을 통해 실제 환경변수를 가져온다.
   * Windows는 GUI도 시스템 PATH를 상속하므로 불필요.
   */
  private resolveShellEnv(): Promise<Record<string, string>> {
    if (this.shellEnv) return Promise.resolve(this.shellEnv);
    if (process.platform === 'win32') {
      this.shellEnv = { ...process.env } as Record<string, string>;
      return Promise.resolve(this.shellEnv);
    }

    return new Promise((resolve) => {
      const loginShell = process.env.SHELL || '/bin/zsh';
      this.appendLog(`[setup] Resolving PATH from ${loginShell}...`);

      execFile(loginShell, ['-lc', 'env'], {
        timeout: 5_000,
        encoding: 'utf-8',
      }, (err, stdout) => {
        if (err || !stdout) {
          this.appendLog('[setup] Shell env resolution failed, using fallback PATH');
          this.shellEnv = this.buildFallbackEnv();
          resolve(this.shellEnv);
          return;
        }

        const env: Record<string, string> = {};
        for (const line of stdout.split('\n')) {
          const idx = line.indexOf('=');
          if (idx > 0) {
            env[line.slice(0, idx)] = line.slice(idx + 1);
          }
        }

        if (env.PATH) {
          this.appendLog(`[setup] PATH resolved (${env.PATH.split(':').length} entries)`);
        }
        this.shellEnv = { ...process.env, ...env } as Record<string, string>;
        resolve(this.shellEnv);
      });
    });
  }

  /** 셸 env 실패 시 흔한 Node.js 경로를 직접 추가 */
  private buildFallbackEnv(): Record<string, string> {
    const home = process.env.HOME || '';
    const extra = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      `${home}/.nvm/versions/node`,
      `${home}/.volta/bin`,
      `${home}/.fnm/aliases/default/bin`,
    ];
    const currentPath = process.env.PATH || '/usr/bin:/bin';
    return {
      ...process.env,
      PATH: `${extra.join(':')}:${currentPath}`,
    } as Record<string, string>;
  }

  // ── 외부 서버 감지 ─────────────────────────────────────────

  async detectRunningServer(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(HEALTH_CHECK_URL, { timeout: 2_000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          this.appendLog('[electron] Detected existing server on :3210');
          this.isExternalServer = true;
          this.setStatus('running');
          resolve(true);
        } else {
          resolve(false);
        }
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  // ── 메인 시작 흐름 ────────────────────────────────────────

  async start(): Promise<void> {
    if (
      this._status === 'checking' ||
      this._status === 'starting' ||
      this._status === 'running'
    )
      return;

    this.isExternalServer = false;
    this.isStopping = false;
    this.logBuffer = [];

    try {
      this.setStatus('checking');

      const env = await this.resolveShellEnv();
      await this.detectNode(env);
      this.migrateStoreIfNeeded();

      this.setStatus('starting');
      this.spawnServer(this.getAppRoot(), env);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendLog(`[electron] Setup failed: ${msg}`);
      this.setStatus('error');
    }
  }

  // ── 번들 Node.js 경로 ──────────────────────────────────────

  /**
   * 번들된 Node.js 바이너리 경로.
   * 패키징: <resourcesPath>/node/bin/node (macOS/Linux) 또는 <resourcesPath>/node/node.exe (Windows)
   * 개발: <appRoot>/build/node/bin/node
   */
  private getBundledNodePath(): string | null {
    const isWin = process.platform === 'win32';
    const base = app.isPackaged
      ? path.join(process.resourcesPath, 'node')
      : path.join(app.getAppPath(), 'build', 'node');

    const nodePath = isWin
      ? path.join(base, 'node.exe')
      : path.join(base, 'bin', 'node');

    return fs.existsSync(nodePath) ? nodePath : null;
  }

  // ── Node.js 감지 ──────────────────────────────────────────

  /**
   * 번들 Node.js 우선 → 시스템 Node.js 폴백.
   * 감지 성공 시 resolvedNodePath에 경로 저장.
   */
  private async detectNode(env: Record<string, string>): Promise<void> {
    this.appendLog('[setup] Checking Node.js...');

    const bundledNode = this.getBundledNodePath();
    if (bundledNode) {
      const version = await this.getNodeVersion(bundledNode, env);
      if (version) {
        this.appendLog(`[setup] Bundled Node.js ${version} detected`);
        this.resolvedNodePath = bundledNode;
        return;
      }
      this.appendLog('[setup] Bundled Node.js exists but failed to execute, trying system...');
    }

    const systemVersion = await this.getNodeVersion('node', env);
    if (systemVersion) {
      const major = parseInt(systemVersion.replace('v', ''), 10);
      if (major < 20) {
        throw new Error(`System Node.js ${systemVersion} is too old. Version 20+ required.`);
      }
      this.appendLog(`[setup] System Node.js ${systemVersion} detected (fallback)`);
      this.resolvedNodePath = 'node';
      return;
    }

    throw new Error(
      'Node.js not found. Bundled Node.js missing and system Node.js not installed.',
    );
  }

  private getNodeVersion(nodePath: string, env: Record<string, string>): Promise<string | null> {
    return new Promise((resolve) => {
      const check = spawn(nodePath, ['--version'], { stdio: 'pipe', env });
      let version = '';
      check.stdout?.on('data', (d: Buffer) => { version += d.toString().trim(); });
      check.on('error', () => resolve(null));
      check.on('exit', (code) => resolve(code === 0 && version ? version : null));
    });
  }

  // ── 서버 프로세스 spawn ───────────────────────────────────

  private spawnServer(
    appRoot: string,
    env: Record<string, string>,
  ): void {
    const nodePath = this.resolvedNodePath || 'node';
    const serverEntry = path.join(appRoot, 'dist', 'index.js');
    this.appendLog(`[electron] Starting server: ${nodePath} ${serverEntry}`);

    const storeDir = this.getStoreDir();
    this.appendLog(`[electron] Store directory: ${storeDir}`);

    this.process = spawn(nodePath, [serverEntry], {
      cwd: appRoot,
      env: {
        ...env,
        NODE_ENV: 'production',
        WEB_UI_ENABLED: 'true',
        WEB_UI_HOST: '127.0.0.1',
        WEB_UI_PORT: '3210',
        AGENTSALAD_STORE_DIR: storeDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.appendLog(chunk.toString().trimEnd());
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.appendLog(`[stderr] ${chunk.toString().trimEnd()}`);
    });

    this.process.on('error', (err) => {
      this.appendLog(`[electron] Process error: ${err.message}`);
      this.cleanupProcess();
      this.setStatus('error');
    });

    this.process.on('exit', (code, signal) => {
      this.appendLog(
        `[electron] Process exited (code=${code}, signal=${signal})`,
      );
      this.cleanupProcess();
      if (this.isStopping) return;
      if (this._status === 'running' || this._status === 'starting') {
        this.setStatus(code === 0 ? 'stopped' : 'error');
      }
    });

    this.startHealthCheck();
  }

  // ── 서버 정지 ─────────────────────────────────────────────

  async stop(): Promise<void> {
    this.stopHealthCheck();
    this.stopRunningWatch();

    if (this.isExternalServer) {
      this.isExternalServer = false;
      this.setStatus('stopped');
      return;
    }

    if (!this.process || this.process.killed) {
      this.setStatus('stopped');
      return;
    }

    this.isStopping = true;
    this.appendLog('[electron] Stopping server (SIGTERM)...');
    this.process.kill('SIGTERM');

    const exited = await this.waitForExit(GRACEFUL_KILL_MS);
    if (!exited && this.process && !this.process.killed) {
      this.appendLog('[electron] Graceful shutdown timeout, sending SIGKILL');
      this.process.kill('SIGKILL');
      await this.waitForExit(2_000);
    }

    this.cleanupProcess();
    this.isStopping = false;
    this.setStatus('stopped');
  }

  // ── Health check ──────────────────────────────────────────

  private startHealthCheck(): void {
    this.healthStartedAt = Date.now();
    this.healthTimer = setInterval(() => {
      this.checkHealth();
    }, HEALTH_POLL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private checkHealth(): void {
    if (this._status !== 'starting') {
      this.stopHealthCheck();
      return;
    }

    if (Date.now() - this.healthStartedAt > HEALTH_TIMEOUT_MS) {
      this.appendLog('[electron] Health check timeout (60s)');
      this.stopHealthCheck();
      this.setStatus('error');
      return;
    }

    const req = http.get(HEALTH_CHECK_URL, { timeout: 2_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
        this.stopHealthCheck();
        this.appendLog('[electron] Server is ready');
        this.setStatus('running');
      }
      res.resume();
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
  }

  // ── Running watch ─────────────────────────────────────────

  private startRunningWatch(): void {
    this.stopRunningWatch();
    this.runningWatchTimer = setInterval(() => {
      const req = http.get(HEALTH_CHECK_URL, { timeout: 3_000 }, (res) => {
        res.resume();
      });
      req.on('error', () => {
        if (this._status === 'running') {
          this.appendLog('[electron] Server is no longer reachable');
          this.stopRunningWatch();
          this.isExternalServer = false;
          this.setStatus('stopped');
        }
      });
      req.on('timeout', () => req.destroy());
    }, 5_000);
  }

  private stopRunningWatch(): void {
    if (this.runningWatchTimer) {
      clearInterval(this.runningWatchTimer);
      this.runningWatchTimer = null;
    }
  }

  // ── 내부 유틸 ─────────────────────────────────────────────

  private setStatus(status: ServerStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit('status-changed', status);

    if (status === 'running') {
      this.startRunningWatch();
    } else {
      this.stopRunningWatch();
    }
  }

  private appendLog(line: string): void {
    this.logBuffer.push(line);
    if (this.logBuffer.length > LOG_BUFFER_MAX) {
      this.logBuffer.shift();
    }
    this.emit('log', line);
  }

  private waitForExit(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.process || this.process.killed) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        this.process?.removeListener('exit', onExit);
        resolve(false);
      }, ms);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.process.once('exit', onExit);
    });
  }

  private cleanupProcess(): void {
    this.stopHealthCheck();
    this.process = null;
  }
}
