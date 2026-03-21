/**
 * ServerManager - agentsalad 서버 프로세스 생명주기 관리
 *
 * child_process.spawn으로 서버를 시작/종료하고,
 * HTTP health check로 ready 상태를 판단한다.
 * EventEmitter 패턴으로 상태 변화를 main process에 전파.
 *
 * 외부 서버 감지: detectRunningServer()로 이미 떠있는 서버를 감지.
 * running 상태 감시: 5초 간격 health check로 서버 죽음 감지 → stopped 전환.
 * 종료 분류: code=0 정상 종료(stopped), code≠0 크래시(error), isStopping 의도적 종료(stopped).
 */
import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import http from 'http';
import path from 'path';
import { app } from 'electron';

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'error';

const HEALTH_CHECK_URL = 'http://127.0.0.1:3210';
const HEALTH_POLL_MS = 500;
const HEALTH_TIMEOUT_MS = 30_000;
const GRACEFUL_KILL_MS = 3_000;
const LOG_BUFFER_MAX = 200;

export class ServerManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private _status: ServerStatus = 'stopped';
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthStartedAt = 0;
  private logBuffer: string[] = [];
  /** 외부 서버 감지 시 true — stop()에서 프로세스 kill 불필요 */
  private isExternalServer = false;
  /** 의도적 종료 중 — exit 핸들러가 error 대신 stopped 처리 */
  private isStopping = false;
  private runningWatchTimer: ReturnType<typeof setInterval> | null = null;

  get status(): ServerStatus {
    return this._status;
  }

  get logs(): string[] {
    return [...this.logBuffer];
  }

  /**
   * 프로젝트 루트 경로 결정.
   * 패키징 시 extraResources/app-server, 개발 시 app.getAppPath() (package.json 위치).
   */
  private getAppRoot(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'app-server');
    }
    return app.getAppPath();
  }

  /**
   * Node 실행 파일 경로.
   * 패키징 시 번들된 node 바이너리, 개발 시 시스템 node.
   */
  private getNodeBin(): string {
    if (app.isPackaged) {
      const bundledNode = path.join(
        process.resourcesPath,
        'node',
        process.platform === 'win32' ? 'node.exe' : 'node',
      );
      const fs = require('fs') as typeof import('fs');
      if (fs.existsSync(bundledNode)) return bundledNode;
      this.appendLog('[electron] Bundled node not found, falling back to system node');
    }
    return 'node';
  }

  /**
   * 포트 3210에 이미 서버가 떠있는지 확인.
   * 외부에서 실행된 서버(npm run dev 등)를 자동 감지.
   */
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
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  /** Node.js 설치 여부 확인. 없으면 에러 상태로 전환. */
  async checkNodeAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const check = spawn('node', ['--version'], { stdio: 'pipe' });
      check.on('error', () => {
        this.appendLog('[electron] Node.js not found in PATH');
        resolve(false);
      });
      check.on('exit', (code) => {
        if (code === 0) {
          check.stdout?.once('data', (d: Buffer) => {
            this.appendLog(`[electron] Node.js ${d.toString().trim()} detected`);
          });
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  start(): void {
    if (this._status === 'starting' || this._status === 'running') return;

    this.isExternalServer = false;
    this.isStopping = false;
    this.setStatus('starting');
    this.logBuffer = [];

    const appRoot = this.getAppRoot();
    const serverEntry = path.join(appRoot, 'dist', 'index.js');
    const nodeBin = this.getNodeBin();

    this.appendLog(`[electron] Starting server: ${nodeBin} ${serverEntry}`);
    this.appendLog(`[electron] Working directory: ${appRoot}`);

    this.process = spawn(nodeBin, [serverEntry], {
      cwd: appRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        WEB_UI_ENABLED: 'true',
        WEB_UI_HOST: '127.0.0.1',
        WEB_UI_PORT: '3210',
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
        // code 0 = 정상 종료 (웹 UI 셧다운 등), 그 외 = 비정상 크래시
        this.setStatus(code === 0 ? 'stopped' : 'error');
      }
    });

    this.startHealthCheck();
  }

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
      this.appendLog('[electron] Health check timeout (30s)');
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

    req.on('error', () => {
      // 아직 서버가 안 떴음 — 다음 폴링에서 재시도
    });

    req.on('timeout', () => {
      req.destroy();
    });
  }

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

  /**
   * running 상태 감시: 5초마다 서버 생존 확인.
   * 외부 서버가 꺼지거나 자체 서버가 비정상 종료되었을 때 감지.
   */
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

  private appendLog(line: string): void {
    this.logBuffer.push(line);
    if (this.logBuffer.length > LOG_BUFFER_MAX) {
      this.logBuffer.shift();
    }
    this.emit('log', line);
  }

  private cleanupProcess(): void {
    this.stopHealthCheck();
    this.process = null;
  }
}
