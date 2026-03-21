#!/usr/bin/env node
/**
 * Node.js 바이너리 다운로드 — Electron 패키징용
 *
 * 현재 플랫폼에 맞는 Node.js 바이너리를 다운로드하여
 * build/node/ 디렉토리에 저장한다.
 * electron-builder가 extraResources로 패키징.
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
  darwin: { os: 'darwin', ext: 'tar.gz', bin: 'node' },
  win32: { os: 'win', ext: 'zip', bin: 'node.exe' },
  linux: { os: 'linux', ext: 'tar.gz', bin: 'node' },
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

  console.log(`Downloading Node.js v${NODE_VERSION} (${plat.os}-${arch})...`);
  console.log(`URL: ${url}`);

  download(url, archivePath, () => {
    console.log('Extracting binary...');

    if (plat.ext === 'tar.gz') {
      const prefix = `node-v${NODE_VERSION}-${plat.os}-${arch}/bin/node`;
      execSync(
        `tar -xzf "${archivePath}" -C "${outDir}" --strip-components=2 "${prefix}"`,
        { stdio: 'inherit' },
      );
    } else {
      // Windows zip — extract node.exe
      execSync(
        `unzip -jo "${archivePath}" "node-v${NODE_VERSION}-${plat.os}-${arch}/node.exe" -d "${outDir}"`,
        { stdio: 'inherit' },
      );
    }

    // 아카이브 삭제
    fs.unlinkSync(archivePath);

    // 실행 권한 설정
    if (process.platform !== 'win32') {
      fs.chmodSync(binPath, 0o755);
    }

    console.log(`Node.js v${NODE_VERSION} binary ready: ${binPath}`);
  });
}

function download(url, dest, cb) {
  const file = fs.createWriteStream(dest);
  https.get(url, (res) => {
    if (res.statusCode === 302 || res.statusCode === 301) {
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
