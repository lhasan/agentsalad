/**
 * UpdateChecker - GitHub Release 기반 업데이트 알림
 *
 * 앱 시작 시 GitHub API로 최신 Release 태그를 확인하고,
 * 현재 버전보다 높으면 트레이/알림으로 안내.
 * 코드 서명 불필요 — 브라우저에서 다운로드 페이지를 열어주는 방식.
 */
import https from 'https';
import { app, shell, Notification } from 'electron';

const GITHUB_OWNER = 'terry-uu';
const GITHUB_REPO = 'agentsalad';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4시간

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  releaseNotes: string;
}

let latestUpdate: UpdateInfo | null = null;
let checkTimer: ReturnType<typeof setInterval> | null = null;

export function getAvailableUpdate(): UpdateInfo | null {
  return latestUpdate;
}

export function startUpdateChecker(): void {
  checkForUpdate();
  checkTimer = setInterval(checkForUpdate, CHECK_INTERVAL_MS);
}

export function stopUpdateChecker(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

export function openReleasePage(): void {
  if (latestUpdate) {
    shell.openExternal(latestUpdate.releaseUrl);
  }
}

function checkForUpdate(): void {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

  const req = https.get(
    url,
    {
      headers: {
        'User-Agent': `AgentSalad/${app.getVersion()}`,
        Accept: 'application/vnd.github.v3+json',
      },
      timeout: 10_000,
    },
    (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return;
      }

      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const tagName: string = data.tag_name || '';
          const latestVersion = tagName.replace(/^v/, '');
          const currentVersion = app.getVersion();

          if (isNewerVersion(currentVersion, latestVersion)) {
            latestUpdate = {
              currentVersion,
              latestVersion,
              releaseUrl: data.html_url || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
              releaseNotes: (data.body || '').slice(0, 500),
            };
            showUpdateNotification(latestUpdate);
          }
        } catch {
          // JSON 파싱 실패 — 무시
        }
      });
    },
  );

  req.on('error', () => { /* 네트워크 에러 — 무시, 다음 체크에서 재시도 */ });
  req.on('timeout', () => req.destroy());
}

/**
 * 시맨틱 버전 비교. latest > current면 true.
 * "0.1.0" > "0.0.0" → true
 */
function isNewerVersion(current: string, latest: string): boolean {
  const c = current.split('.').map(Number);
  const l = latest.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const cv = c[i] || 0;
    const lv = l[i] || 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

function showUpdateNotification(info: UpdateInfo): void {
  if (!Notification.isSupported()) return;

  const notification = new Notification({
    title: 'Agent Salad 업데이트',
    body: `새 버전 v${info.latestVersion}이 있습니다. (현재 v${info.currentVersion})`,
  });

  notification.on('click', () => {
    shell.openExternal(info.releaseUrl);
  });

  notification.show();
}
