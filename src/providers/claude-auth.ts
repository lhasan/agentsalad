/**
 * Claude Code Subscription Auth — setup-token / OAuth 토큰 관리
 *
 * Claude Code CLI의 구독 인증 토큰을 활용하여 Anthropic API를 직접 호출.
 * OpenClaw의 auth-profiles.json에서 토큰을 읽거나,
 * claude setup-token으로 생성한 토큰을 사용.
 *
 * 토큰 형태: sk-ant-oat01-... (OAuth Access Token)
 * 용도: Anthropic API x-api-key 헤더에 직접 사용 가능
 *
 * 토큰 소스 우선순위:
 * 1. Maru 자체 저장소 (store/auth/anthropic-token.json)
 * 2. OpenClaw auth-profiles.json (자동 발견)
 * 3. ANTHROPIC_API_KEY 환경변수
 * 4. claude setup-token 으로 신규 획득
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { STORE_DIR } from '../config.js';
import { logger } from '../logger.js';

const AUTH_DIR = join(STORE_DIR, 'auth');
const TOKEN_FILE = join(AUTH_DIR, 'anthropic-token.json');

export interface AnthropicToken {
  token: string;
  source: 'maru' | 'openclaw' | 'env' | 'setup-token';
  expires?: number; // epoch ms
  profileId?: string;
  savedAt: number;
}

export interface AuthDiscoveryResult {
  token: string | null;
  source: string;
  expires?: number;
  expiresIn?: string; // human readable
  error?: string;
}

/**
 * Maru 자체 저장소에서 토큰 읽기
 */
function readMaruToken(): AnthropicToken | null {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
    if (data.token && typeof data.token === 'string') {
      return data as AnthropicToken;
    }
  } catch {
    /* corrupt file */
  }
  return null;
}

/**
 * Maru 저장소에 토큰 저장
 */
export function saveMaruToken(
  token: string,
  source: AnthropicToken['source'],
  expires?: number,
): void {
  if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });
  const data: AnthropicToken = {
    token,
    source,
    expires,
    savedAt: Date.now(),
  };
  writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), 'utf-8');
  logger.info(
    { source, hasExpiry: !!expires },
    'Anthropic token saved to Maru store',
  );
}

/**
 * OpenClaw auth-profiles.json에서 Anthropic 토큰 자동 발견
 */
function discoverOpenClawToken(): AnthropicToken | null {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const openclawBase = join(homeDir, '.openclaw', 'agents');

  if (!existsSync(openclawBase)) return null;

  // 모든 에이전트 디렉토리 탐색
  try {
    const agents = readdirSync(openclawBase, { withFileTypes: true });

    for (const agent of agents) {
      if (!agent.isDirectory()) continue;
      const authFile = join(
        openclawBase,
        agent.name,
        'agent',
        'auth-profiles.json',
      );
      if (!existsSync(authFile)) continue;

      try {
        const data = JSON.parse(readFileSync(authFile, 'utf-8'));
        const profiles = data.profiles;
        if (!profiles || typeof profiles !== 'object') continue;

        // Anthropic 프로파일 중 유효한 토큰 찾기
        for (const [profileId, profile] of Object.entries(profiles)) {
          const p = profile as Record<string, unknown>;
          if (p.provider !== 'anthropic') continue;

          // OAuth 토큰 (access)
          if (p.type === 'oauth' && typeof p.access === 'string') {
            let expires =
              typeof p.expires === 'number' ? p.expires : undefined;
            // expires가 초 단위일 수 있으므로 보정
            if (expires && expires < 1e12) expires = expires * 1000;
            if (expires && expires < Date.now()) continue; // 만료됨
            return {
              token: p.access as string,
              source: 'openclaw',
              expires,
              profileId,
              savedAt: Date.now(),
            };
          }

          // 토큰 타입
          if (p.type === 'token' && typeof p.token === 'string') {
            return {
              token: p.token as string,
              source: 'openclaw',
              profileId,
              savedAt: Date.now(),
            };
          }
        }
      } catch {
        /* corrupt file, skip */
      }
    }
  } catch {
    /* permission error */
  }

  return null;
}

/**
 * 토큰 만료까지 남은 시간을 사람이 읽을 수 있는 형태로
 */
function formatExpiry(expiresMs: number): string {
  const remaining = expiresMs - Date.now();
  if (remaining <= 0) return 'expired';
  const days = Math.floor(remaining / 86400000);
  const hours = Math.floor((remaining % 86400000) / 3600000);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((remaining % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}

/**
 * 최적의 Anthropic 토큰을 자동 발견.
 * 우선순위: Maru 저장소 > OpenClaw > 환경변수
 */
export function discoverAnthropicToken(): AuthDiscoveryResult {
  // 1. Maru 자체 저장소
  const maruToken = readMaruToken();
  if (maruToken?.token) {
    if (maruToken.expires && maruToken.expires < Date.now()) {
      logger.warn('Maru stored token expired, trying other sources');
    } else {
      return {
        token: maruToken.token,
        source: `maru (${maruToken.source})`,
        expires: maruToken.expires,
        expiresIn: maruToken.expires
          ? formatExpiry(maruToken.expires)
          : undefined,
      };
    }
  }

  // 2. OpenClaw auth-profiles.json
  const openclawToken = discoverOpenClawToken();
  if (openclawToken?.token) {
    logger.info(
      { profileId: openclawToken.profileId },
      'Discovered Anthropic token from OpenClaw',
    );
    // Maru 저장소에도 복사
    saveMaruToken(
      openclawToken.token,
      'openclaw',
      openclawToken.expires,
    );
    return {
      token: openclawToken.token,
      source: `openclaw (${openclawToken.profileId})`,
      expires: openclawToken.expires,
      expiresIn: openclawToken.expires
        ? formatExpiry(openclawToken.expires)
        : undefined,
    };
  }

  // 3. 환경변수 (유효한 API 키만)
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.length > 50) {
    return {
      token: envKey,
      source: 'env (ANTHROPIC_API_KEY)',
    };
  }

  return {
    token: null,
    source: 'none',
    error:
      'No Anthropic token found. Options:\n' +
      '1. Run "claude setup-token" and paste in Maru dashboard\n' +
      '2. Install OpenClaw and authenticate\n' +
      '3. Set ANTHROPIC_API_KEY environment variable',
  };
}

/**
 * Web UI용: 전체 인증 상태 보고
 */
export interface ClaudeAuthReport {
  hasToken: boolean;
  tokenSource: string;
  tokenPrefix: string | null;
  expiresIn: string | null;
  cliInstalled: boolean;
  cliVersion: string | null;
  cliLoggedIn: boolean;
  openclawFound: boolean;
  suggestions: string[];
}

export function getClaudeAuthReport(): ClaudeAuthReport {
  const discovery = discoverAnthropicToken();

  // CLI 상태
  let cliInstalled = false;
  let cliVersion: string | null = null;
  let cliLoggedIn = false;

  try {
    execSync('which claude', { stdio: 'ignore' });
    cliInstalled = true;
    cliVersion = execSync('claude --version', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    /* not installed */
  }

  if (cliInstalled) {
    try {
      const authJson = execSync('claude auth status', {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, ANTHROPIC_API_KEY: '' },
      });
      const auth = JSON.parse(authJson);
      cliLoggedIn = auth.loggedIn === true;
    } catch {
      /* auth check failed */
    }
  }

  // OpenClaw 토큰 발견 여부
  const openclawToken = discoverOpenClawToken();

  const suggestions: string[] = [];
  if (!discovery.token) {
    if (cliInstalled)
      suggestions.push(
        'Run "claude setup-token" in terminal, then paste the token in Settings',
      );
    if (!cliInstalled)
      suggestions.push(
        'Install Claude Code CLI: npm install -g @anthropic-ai/claude-code',
      );
    suggestions.push('Or set ANTHROPIC_API_KEY environment variable');
  }

  return {
    hasToken: !!discovery.token,
    tokenSource: discovery.source,
    tokenPrefix: discovery.token
      ? discovery.token.substring(0, 15) + '...'
      : null,
    expiresIn: discovery.expiresIn || null,
    cliInstalled,
    cliVersion,
    cliLoggedIn,
    openclawFound: !!openclawToken,
    suggestions,
  };
}
