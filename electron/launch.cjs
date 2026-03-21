#!/usr/bin/env node
/**
 * Electron Launcher - ELECTRON_RUN_AS_NODE 환경변수 해제 후 Electron 실행.
 *
 * Cursor, VSCode 등 Electron 기반 IDE 터미널에서 실행 시
 * ELECTRON_RUN_AS_NODE=1이 상속되어 Electron이 Node.js 모드로 동작하는 문제 방지.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

try {
  execFileSync(electronPath, ['.'], {
    stdio: 'inherit',
    env,
    cwd: path.resolve(__dirname, '..'),
  });
} catch (err) {
  process.exit(err.status || 1);
}
