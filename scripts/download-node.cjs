#!/usr/bin/env node
/**
 * Node.js 풀 배포판 다운로드 — Electron 패키징용
 *
 * node 바이너리 + npm을 포함한 전체 런타임을 다운로드하여
 * build/node/ 디렉토리에 저장한다.
 * electron-builder가 extraResources로 패키징.
 *
 * 시스템에 Node.js 미설치 환경에서도 동작하도록
 * 번들 Node.js로 npm install + 서버 실행을 모두 수행.
 *
 * 사용: node scripts/download-node.cjs [version]
 * 예:   node scripts/download-node.cjs 22.15.0
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const NODE_VERSION = process.argv[2] || '22.15.0';
const BASE_URL = `https://nodejs.org/dist/v${NODE_VERSION}`;

const PLATFORM_MAP = {
  darwin: { os: 'darwin', ext: 'tar.gz', bin: 'bin/node' },
  win32: { os: 'win', ext: 'zip', bin: 'node.exe' },
  linux: { os: 'linux', ext: 'tar.gz', bin: 'bin/node' },
};

const ARCH_MAP = {
  arm64: 'arm64',
  x64: 'x64',
  x86_64: 'x64',
};

function main() {
  const plat = PLATFORM_MAP[process.platform];
  if (!plat) {
    console.error(`Unsupported platform: ${process.platform}`);
    process.exit(1);
  }

  const arch = ARCH_MAP[process.arch];
  if (!arch) {
    console.error(`Unsupported arch: ${process.arch}`);
    process.exit(1);
  }

  const filename = `node-v${NODE_VERSION}-${plat.os}-${arch}.${plat.ext}`;
  const url = `${BASE_URL}/${filename}`;
  const outDir = path.resolve(__dirname, '..', 'build', 'node');
  const archivePath = path.join(outDir, filename);
  const binPath = path.join(outDir, plat.bin);

  if (fs.existsSync(binPath)) {
    console.log(`Node.js binary already exists: ${binPath}`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Downloading Node.js v${NODE_VERSION} full distribution (${plat.os}-${arch})...`);
  console.log(`URL: ${url}`);

  download(url, archivePath, () => {
    console.log('Extracting full distribution...');

    if (plat.ext === 'tar.gz') {
      execSync(
        `tar -xzf "${archivePath}" -C "${outDir}" --strip-components=1`,
        { stdio: 'inherit' },
      );
    } else {
      const prefix = `node-v${NODE_VERSION}-${plat.os}-${arch}`;
      execSync(
        `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${outDir}' -Force"`,
        { stdio: 'inherit' },
      );
      // Windows zip extracts with top-level dir — move contents up
      const extractedDir = path.join(outDir, prefix);
      if (fs.existsSync(extractedDir)) {
        for (const entry of fs.readdirSync(extractedDir)) {
          const src = path.join(extractedDir, entry);
          const dest = path.join(outDir, entry);
          if (!fs.existsSync(dest)) {
            fs.renameSync(src, dest);
          }
        }
        fs.rmSync(extractedDir, { recursive: true, force: true });
      }
    }

    // 불필요 디렉토리 삭제 (사이즈 절감)
    for (const dir of ['include', 'share', 'man']) {
      const p = path.join(outDir, dir);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    }

    // corepack 제거 (모듈 + bin 심볼릭 링크/스크립트)
    const corepackPaths = [
      path.join(outDir, 'lib', 'node_modules', 'corepack'),
      path.join(outDir, 'node_modules', 'corepack'),
      path.join(outDir, 'bin', 'corepack'),
      path.join(outDir, 'corepack'),
      path.join(outDir, 'corepack.cmd'),
    ];
    for (const p of corepackPaths) {
      try {
        const stat = fs.lstatSync(p);
        if (stat.isDirectory()) {
          fs.rmSync(p, { recursive: true, force: true });
        } else {
          fs.unlinkSync(p);
        }
      } catch (_) {
        // 존재하지 않으면 무시
      }
    }

    // 아카이브 삭제
    fs.unlinkSync(archivePath);

    // 실행 권한 설정
    if (process.platform !== 'win32') {
      fs.chmodSync(path.join(outDir, 'bin', 'node'), 0o755);
    }

    const totalSize = getDirSizeMB(outDir);
    console.log(`Node.js v${NODE_VERSION} full distribution ready: ${outDir} (~${totalSize}MB)`);
  });
}

function getDirSizeMB(dirPath) {
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirSizeMB(full);
    } else {
      try {
        total += fs.lstatSync(full).size;
      } catch (_) {
        // 댕글링 심볼릭 링크 등 무시
      }
    }
  }
  return (total / 1048576).toFixed(1);
}

function download(url, dest, cb) {
  const file = fs.createWriteStream(dest);
  https.get(url, (res) => {
    if (res.statusCode === 302 || res.statusCode === 301) {
      file.close();
      fs.unlinkSync(dest);
      download(res.headers.location, dest, cb);
      return;
    }
    if (res.statusCode !== 200) {
      console.error(`Download failed: HTTP ${res.statusCode}`);
      process.exit(1);
    }
    const total = parseInt(res.headers['content-length'] || '0', 10);
    let downloaded = 0;
    res.on('data', (chunk) => {
      downloaded += chunk.length;
      if (total > 0) {
        const pct = ((downloaded / total) * 100).toFixed(0);
        process.stdout.write(`\r  ${pct}% (${(downloaded / 1048576).toFixed(1)}MB)`);
      }
    });
    res.pipe(file);
    file.on('finish', () => {
      process.stdout.write('\n');
      file.close(cb);
    });
  }).on('error', (err) => {
    fs.unlinkSync(dest);
    console.error(`Download error: ${err.message}`);
    process.exit(1);
  });
}

main();
