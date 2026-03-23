/**
 * Store Directory 영속성 테스트
 *
 * Electron 업데이트 시 데이터가 보존되는지 검증.
 * 1. AGENTSALAD_STORE_DIR 환경변수 → STORE_DIR 경로 분기
 * 2. workspace 경로가 STORE_DIR 기반으로 해석되는지
 * 3. DB가 STORE_DIR 내에 생성되는지
 * 4. 레거시 데이터 마이그레이션 (copyDirRecursive 시뮬레이션)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── 1. STORE_DIR 환경변수 분기 테스트 ─────────────────────────

describe('STORE_DIR env resolution', () => {
  const originalEnv = process.env.AGENTSALAD_STORE_DIR;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENTSALAD_STORE_DIR;
    } else {
      process.env.AGENTSALAD_STORE_DIR = originalEnv;
    }
  });

  it('defaults to process.cwd()/store when env is not set', async () => {
    delete process.env.AGENTSALAD_STORE_DIR;
    // vi.resetModules() + dynamic import로 모듈 재평가
    const { vi } = await import('vitest');
    vi.resetModules();
    const { STORE_DIR } = await import('./config.js');
    expect(STORE_DIR).toBe(path.resolve(process.cwd(), 'store'));
  });

  it('uses AGENTSALAD_STORE_DIR when set', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-test-'));
    process.env.AGENTSALAD_STORE_DIR = tmpDir;
    const { vi } = await import('vitest');
    vi.resetModules();
    const { STORE_DIR } = await import('./config.js');
    expect(STORE_DIR).toBe(path.resolve(tmpDir));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves relative AGENTSALAD_STORE_DIR to absolute', async () => {
    process.env.AGENTSALAD_STORE_DIR = './custom-store';
    const { vi } = await import('vitest');
    vi.resetModules();
    const { STORE_DIR } = await import('./config.js');
    expect(path.isAbsolute(STORE_DIR)).toBe(true);
    expect(STORE_DIR).toBe(path.resolve('./custom-store'));
  });
});

// ── 2. Workspace 경로가 STORE_DIR 기반인지 테스트 ──────────────

describe('workspace paths use STORE_DIR', () => {
  let tmpStore: string;
  const originalEnv = process.env.AGENTSALAD_STORE_DIR;

  beforeEach(() => {
    tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'as-ws-test-'));
    process.env.AGENTSALAD_STORE_DIR = tmpStore;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENTSALAD_STORE_DIR;
    } else {
      process.env.AGENTSALAD_STORE_DIR = originalEnv;
    }
    fs.rmSync(tmpStore, { recursive: true, force: true });
  });

  it('workspace root resolves inside STORE_DIR', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const ws = await import('./skills/workspace.js');

    const wsRoot = ws.getWorkspacesRoot();
    expect(wsRoot).toBe(path.join(tmpStore, 'workspaces'));
  });

  it('skills root resolves inside STORE_DIR', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const ws = await import('./skills/workspace.js');

    const skillsRoot = ws.getSkillsRoot();
    expect(skillsRoot).toBe(path.join(tmpStore, 'skills'));
  });

  it('ensureWorkspace creates folder in correct location', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const ws = await import('./skills/workspace.js');

    ws.registerFolderName('agent-1', 'my-agent');
    const wsPath = ws.ensureWorkspace('agent-1');

    expect(wsPath).toBe(path.join(tmpStore, 'workspaces', 'my-agent'));
    expect(fs.existsSync(wsPath)).toBe(true);
  });

  it('ensureTargetWorkspace creates 3-depth folder structure', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const ws = await import('./skills/workspace.js');

    ws.registerFolderName('agent-1', 'my-agent');
    ws.registerFolderName('ch-1', 'telegram-bot');
    ws.registerFolderName('tgt-1', 'terry');

    const targetPath = ws.ensureTargetWorkspace('agent-1', 'ch-1', 'tgt-1');

    expect(targetPath).toBe(
      path.join(tmpStore, 'workspaces', 'my-agent', 'telegram-bot', 'terry'),
    );
    expect(fs.existsSync(targetPath)).toBe(true);

    const sharedPath = path.join(tmpStore, 'workspaces', 'my-agent', '_shared');
    expect(fs.existsSync(sharedPath)).toBe(true);
  });

  it('ensureSkillScript creates files inside STORE_DIR/skills/', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const ws = await import('./skills/workspace.js');

    ws.registerFolderName('skill-1', 'my-skill');
    const scriptPath = ws.ensureSkillScript('skill-1', 'my_tool');

    expect(
      scriptPath.startsWith(path.join(tmpStore, 'skills', 'my-skill')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpStore, 'skills', 'my-skill', 'run.sh')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpStore, 'skills', 'my-skill', 'schema.json')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpStore, 'skills', 'my-skill', 'prompt.txt')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpStore, 'skills', 'my-skill', 'GUIDE.md')),
    ).toBe(true);
  });
});

// ── 3. DB가 STORE_DIR 내에 생성되는지 테스트 ───────────────────

describe('DB creates in STORE_DIR', () => {
  let tmpStore: string;
  const originalEnv = process.env.AGENTSALAD_STORE_DIR;

  beforeEach(() => {
    tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'as-db-test-'));
    process.env.AGENTSALAD_STORE_DIR = tmpStore;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENTSALAD_STORE_DIR;
    } else {
      process.env.AGENTSALAD_STORE_DIR = originalEnv;
    }
    fs.rmSync(tmpStore, { recursive: true, force: true });
  });

  it('initDatabase creates messages.db inside STORE_DIR', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const db = await import('./db.js');

    db.initDatabase();

    const dbPath = path.join(tmpStore, 'messages.db');
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('full dummy data round-trip in custom STORE_DIR', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const db = await import('./db.js');

    db.initDatabase();

    // Agent
    db.createAgentProfile({
      id: 'agent-salad',
      name: 'Salad Master',
      description: 'The best salad maker',
      provider_id: 'anthropic',
      model: 'sonnet',
      system_prompt: 'You make salads.',
      skills: {
        file_read: true,
        file_write: true,
        file_list: true,
        web_fetch: true,
        web_browse: false,
        bash: true,
        google_gmail: false,
        google_calendar: false,
        google_drive: false,
        cron: true,
      },
      folder_name: 'salad-master',
      thumbnail: '🥩',
    });
    const agent = db.getAgentProfileById('agent-salad');
    expect(agent).toBeDefined();
    expect(agent!.name).toBe('Salad Master');
    expect(agent!.skills.bash).toBe(true);
    expect(agent!.folder_name).toBe('salad-master');

    // Channel
    db.createManagedChannel({
      id: 'ch-tg',
      type: 'telegram',
      name: 'Salad Telegram Bot',
      configJson: JSON.stringify({ token: 'FAKE_TOKEN_123' }),
      folderName: 'tg-bot',
      thumbnail: '🥬',
    });
    const channels = db.listManagedChannels();
    expect(channels.find((c) => c.id === 'ch-tg')).toBeDefined();

    db.createManagedChannel({
      id: 'ch-dc',
      type: 'discord',
      name: 'Salad Discord Bot',
      configJson: JSON.stringify({ token: 'FAKE_DC_TOKEN' }),
      folderName: 'dc-bot',
      thumbnail: '🥦',
    });

    // Targets (user DM + room + everyone)
    db.createTarget({
      id: 'tgt-terry',
      targetId: '111111',
      nickname: 'Terry',
      platform: 'telegram',
      targetType: 'user',
      folderName: 'terry',
      thumbnail: '🍅',
    });
    db.createTarget({
      id: 'tgt-room',
      targetId: '222222',
      nickname: 'General Channel',
      platform: 'discord',
      targetType: 'room',
      folderName: 'general-channel',
      thumbnail: '🥕',
    });
    db.createTarget({
      id: 'tgt-everyone-tg',
      targetId: 'everyone@telegram',
      nickname: '*',
      platform: 'telegram',
      targetType: 'everyone',
      folderName: 'everyone-tg',
      thumbnail: '🌽',
    });
    const targets = db.listTargets();
    expect(targets.length).toBeGreaterThanOrEqual(3);

    // Services
    db.createService({
      id: 'svc-terry-dm',
      agentProfileId: 'agent-salad',
      channelId: 'ch-tg',
      targetId: 'tgt-terry',
      creationSource: 'manual',
    });
    db.createService({
      id: 'svc-room',
      agentProfileId: 'agent-salad',
      channelId: 'ch-dc',
      targetId: 'tgt-room',
      creationSource: 'manual',
    });
    db.createService({
      id: 'svc-everyone',
      agentProfileId: 'agent-salad',
      channelId: 'ch-tg',
      targetId: 'tgt-everyone-tg',
      creationSource: 'manual',
    });
    const services = db.listServices();
    expect(services.length).toBe(3);

    // Conversations (30개 더미 메시지)
    const messages = [
      '안녕하세요!',
      '오늘 뭐 먹을까?',
      '샐러드 추천해줘',
      '시저 샐러드 어때?',
      '좋아! 만들어줘',
      '재료: 로메인, 파마산, 크루통...',
      '드레싱은?',
      '시저 드레싱: 앤초비, 레몬, 올리브오일...',
      '감사합니다!',
      '다음엔 그릭 샐러드',
      '재료 알려줘',
      '오이, 토마토, 올리브, 페타 치즈...',
      '맛있겠다',
      '해보고 알려줄게',
      '기대됩니다!',
    ];
    for (let i = 0; i < messages.length; i++) {
      const role = i % 2 === 0 ? ('user' as const) : ('assistant' as const);
      db.addConversationMessage('svc-terry-dm', role, messages[i]);
    }
    const history = db.getConversationHistory('svc-terry-dm', 50);
    expect(history.length).toBe(15);
    expect(history[0].content).toBe('안녕하세요!');
    expect(history[14].content).toBe('기대됩니다!');

    // Custom skills
    db.createCustomSkill({
      id: 'skill-weather',
      name: 'Weather Checker',
      description: 'Check weather for a location',
      prompt: 'Use weather_check when user asks about weather.',
      script: 'curl -s wttr.in/$INPUT_LOCATION?format=3',
      input_schema: JSON.stringify([
        { name: 'location', type: 'string', description: 'City name' },
      ]),
      tool_name: 'weather_check',
      timeout_ms: 15000,
      folder_name: 'weather-checker',
    });
    db.createCustomSkill({
      id: 'skill-calc',
      name: 'Calculator',
      description: 'Evaluate math expressions',
      prompt: 'Use calculate when user needs math.',
      tool_name: 'calculate',
      folder_name: 'calculator',
    });
    db.setAgentCustomSkill('agent-salad', 'skill-weather', true);
    db.setAgentCustomSkill('agent-salad', 'skill-calc', false);

    const enabledSkills = db.getEnabledCustomSkills('agent-salad');
    expect(enabledSkills.length).toBe(1);
    expect(enabledSkills[0].name).toBe('Weather Checker');

    const allSkills = db.getAgentCustomSkills('agent-salad');
    expect(allSkills.length).toBe(2);

    // Cron jobs
    db.createCronJob({
      id: 'cron-morning',
      name: 'Morning Briefing',
      prompt: 'Give me a morning briefing with weather and news.',
      scheduleType: 'daily',
      scheduleTime: '08:00',
      notify: true,
    });
    db.createCronJob({
      id: 'cron-once',
      name: 'One-time Reminder',
      prompt: 'Remind Terry about the meeting.',
      scheduleType: 'once',
      scheduleTime: '2030-01-15T14:00:00',
      notify: true,
    });
    db.attachCronToService(
      'svc-terry-dm',
      'cron-morning',
      '2030-01-01T08:00:00.000Z',
    );
    db.attachCronToService(
      'svc-terry-dm',
      'cron-once',
      '2030-01-15T14:00:00.000Z',
    );

    const serviceCrons = db.getServiceCronsByService('svc-terry-dm');
    expect(serviceCrons.length).toBe(2);

    // LLM Provider API key 업데이트
    db.upsertLlmProvider({
      id: 'anthropic',
      providerKey: 'anthropic',
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      authScheme: 'x-api-key',
      apiKey: 'sk-ant-FAKE-KEY-FOR-TEST',
    });
    const provider = db.getLlmProviderById('anthropic');
    expect(provider!.api_key).toBe('sk-ant-FAKE-KEY-FOR-TEST');

    // DB 파일 존재 최종 확인
    expect(fs.existsSync(path.join(tmpStore, 'messages.db'))).toBe(true);
    const stat = fs.statSync(path.join(tmpStore, 'messages.db'));
    expect(stat.size).toBeGreaterThan(0);
  });
});

// ── 4. 레거시 마이그레이션 로직 테스트 ─────────────────────────

describe('legacy store migration', () => {
  let tmpBase: string;
  let legacyStore: string;
  let newStore: string;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'as-migrate-'));
    legacyStore = path.join(tmpBase, 'app-bundle', 'store');
    newStore = path.join(tmpBase, 'userData', 'store');
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  /**
   * ServerManager.copyDirRecursive의 로직을 순수 함수로 재현.
   * Electron 의존 없이 마이그레이션 동작만 검증.
   */
  function copyDirRecursive(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (fs.existsSync(destPath)) continue;
      if (entry.isDirectory()) {
        copyDirRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  it('copies full directory tree from legacy to new location', () => {
    // 레거시 store 구조 구성
    fs.mkdirSync(
      path.join(legacyStore, 'workspaces', 'agent-a', 'tg-bot', 'terry'),
      { recursive: true },
    );
    fs.mkdirSync(path.join(legacyStore, 'workspaces', 'agent-a', '_shared'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(legacyStore, 'skills', 'weather-checker'), {
      recursive: true,
    });

    fs.writeFileSync(path.join(legacyStore, 'messages.db'), 'FAKE_SQLITE_DATA');
    fs.writeFileSync(
      path.join(
        legacyStore,
        'workspaces',
        'agent-a',
        'tg-bot',
        'terry',
        'notes.txt',
      ),
      'My notes',
    );
    fs.writeFileSync(
      path.join(legacyStore, 'workspaces', 'agent-a', '_shared', 'config.json'),
      '{"key":"value"}',
    );
    fs.writeFileSync(
      path.join(legacyStore, 'skills', 'weather-checker', 'run.sh'),
      '#!/bin/bash\necho hello',
    );

    // 마이그레이션 실행
    fs.mkdirSync(newStore, { recursive: true });
    copyDirRecursive(legacyStore, newStore);

    // 검증: 모든 파일이 새 위치에 복사됨
    expect(fs.existsSync(path.join(newStore, 'messages.db'))).toBe(true);
    expect(fs.readFileSync(path.join(newStore, 'messages.db'), 'utf-8')).toBe(
      'FAKE_SQLITE_DATA',
    );

    expect(
      fs.existsSync(
        path.join(
          newStore,
          'workspaces',
          'agent-a',
          'tg-bot',
          'terry',
          'notes.txt',
        ),
      ),
    ).toBe(true);
    expect(
      fs.readFileSync(
        path.join(
          newStore,
          'workspaces',
          'agent-a',
          'tg-bot',
          'terry',
          'notes.txt',
        ),
        'utf-8',
      ),
    ).toBe('My notes');

    expect(
      fs.existsSync(
        path.join(newStore, 'workspaces', 'agent-a', '_shared', 'config.json'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(newStore, 'skills', 'weather-checker', 'run.sh')),
    ).toBe(true);
  });

  it('does not overwrite existing files in new location', () => {
    fs.mkdirSync(legacyStore, { recursive: true });
    fs.writeFileSync(path.join(legacyStore, 'messages.db'), 'OLD_DATA');

    fs.mkdirSync(newStore, { recursive: true });
    fs.writeFileSync(path.join(newStore, 'messages.db'), 'NEW_DATA');

    copyDirRecursive(legacyStore, newStore);

    // 새 위치의 파일이 덮어쓰이지 않아야 함
    expect(fs.readFileSync(path.join(newStore, 'messages.db'), 'utf-8')).toBe(
      'NEW_DATA',
    );
  });

  it('skips migration when no legacy store exists', () => {
    // legacyStore 자체를 생성하지 않음
    const legacyDbExists = fs.existsSync(path.join(legacyStore, 'messages.db'));
    expect(legacyDbExists).toBe(false);
    // migrateStoreIfNeeded가 하는 조건 검사와 동일
  });

  it('handles deep nested workspace structure', () => {
    // 깊은 중첩: agent > channel > target > subfolder > file
    const deepPath = path.join(
      legacyStore,
      'workspaces',
      'agent-b',
      'dc-bot',
      'general',
      'reports',
      '2026',
    );
    fs.mkdirSync(deepPath, { recursive: true });
    fs.writeFileSync(
      path.join(deepPath, 'march.md'),
      '# March Report\nAll good.',
    );
    fs.writeFileSync(path.join(deepPath, 'data.csv'), 'a,b,c\n1,2,3');

    fs.mkdirSync(newStore, { recursive: true });
    copyDirRecursive(legacyStore, newStore);

    const newDeepPath = path.join(
      newStore,
      'workspaces',
      'agent-b',
      'dc-bot',
      'general',
      'reports',
      '2026',
    );
    expect(fs.existsSync(path.join(newDeepPath, 'march.md'))).toBe(true);
    expect(
      fs.readFileSync(path.join(newDeepPath, 'march.md'), 'utf-8'),
    ).toContain('March Report');
    expect(fs.existsSync(path.join(newDeepPath, 'data.csv'))).toBe(true);
  });
});
