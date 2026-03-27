/**
 * prepare-app-server.cjs — Electron 패키징용 app-server 준비
 *
 * 1. 루트 package.json에서 dependencies + overrides를 추출하여
 *    build/app-server-pkg/에 최소 package.json 생성.
 * 2. package-lock.json 복사.
 * 3. 번들 Node.js(build/node/)로 npm install --production 실행.
 *    결과 node_modules가 build/app-server-pkg/node_modules/에 생성되며
 *    electron-builder가 extraResources로 패키징.
 *
 * playwright는 서버 내 lazy-install이므로 제외.
 * 번들 Node.js의 npm-cli.js를 직접 실행하여 시스템 npm 의존 없음.
 * native 모듈(better-sqlite3)은 번들 Node ABI로 컴파일됨.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build', 'app-server-pkg');
const NODE_DIR = path.join(ROOT, 'build', 'node');

// ── 1. package.json 생성 ────────────────────────────────────

fs.mkdirSync(OUT_DIR, { recursive: true });

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

const serverPkg = {
  name: 'agentsalad-server',
  version: rootPkg.version || '0.0.0',
  private: true,
  type: 'module',
  dependencies: { ...rootPkg.dependencies },
};

delete serverPkg.dependencies['playwright'];

if (rootPkg.overrides) {
  serverPkg.overrides = { ...rootPkg.overrides };
}

fs.writeFileSync(
  path.join(OUT_DIR, 'package.json'),
  JSON.stringify(serverPkg, null, 2) + '\n',
);

const lockSrc = path.join(ROOT, 'package-lock.json');
if (fs.existsSync(lockSrc)) {
  fs.copyFileSync(lockSrc, path.join(OUT_DIR, 'package-lock.json'));
}

console.log(`[prepare-app-server] Created ${OUT_DIR}/package.json`);
console.log(`  dependencies: ${Object.keys(serverPkg.dependencies).length} packages`);

// ── 2. 번들 Node.js로 npm install ──────────────────────────

const isWin = process.platform === 'win32';

const nodeBin = isWin
  ? path.join(NODE_DIR, 'node.exe')
  : path.join(NODE_DIR, 'bin', 'node');

const npmCli = isWin
  ? path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  : path.join(NODE_DIR, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');

if (!fs.existsSync(nodeBin)) {
  console.error(`[prepare-app-server] Bundled Node.js not found: ${nodeBin}`);
  console.error('  Run "npm run electron:node" first.');
  process.exit(1);
}

if (!fs.existsSync(npmCli)) {
  console.error(`[prepare-app-server] Bundled npm-cli.js not found: ${npmCli}`);
  console.error('  Run "npm run electron:node" first.');
  process.exit(1);
}

// 기존 node_modules 삭제 (클린 설치)
const existingModules = path.join(OUT_DIR, 'node_modules');
if (fs.existsSync(existingModules)) {
  console.log('[prepare-app-server] Removing existing node_modules...');
  fs.rmSync(existingModules, { recursive: true, force: true });
}

console.log('[prepare-app-server] Installing production dependencies...');
console.log(`  node: ${nodeBin}`);
console.log(`  npm:  ${npmCli}`);

const bundledBinDir = path.dirname(nodeBin);
const envPath = `${bundledBinDir}${path.delimiter}${process.env.PATH || ''}`;

try {
  execFileSync(nodeBin, [npmCli, 'install', '--omit=dev', '--omit=optional'], {
    cwd: OUT_DIR,
    stdio: 'inherit',
    env: { ...process.env, PATH: envPath },
  });
} catch (err) {
  console.error('[prepare-app-server] npm install failed');
  process.exit(1);
}

// node_modules 존재 확인
if (!fs.existsSync(existingModules)) {
  console.error('[prepare-app-server] node_modules was not created');
  process.exit(1);
}

// 간단한 사이즈 리포트
function getDirSizeBytes(dirPath) {
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirSizeBytes(full);
    } else {
      try { total += fs.lstatSync(full).size; } catch (_) {}
    }
  }
  return total;
}

const sizeMB = (getDirSizeBytes(existingModules) / 1048576).toFixed(1);
console.log(`[prepare-app-server] Done. node_modules: ${sizeMB}MB`);
