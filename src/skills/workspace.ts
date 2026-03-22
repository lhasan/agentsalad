/**
 * Workspace Manager — 에이전트/채널/타겟 3-depth 격리 파일 공간
 *
 * 멀티채널 + 멀티타겟 구조:
 *   store/workspaces/<agent>/                     — 에이전트 워크스페이스 루트
 *   store/workspaces/<agent>/_shared/             — 공용 폴더 (모든 채널, 모든 타겟 접근)
 *   store/workspaces/<agent>/<channel>/<target>/  — 채널→타겟 개인 폴더 (파일 도구 루트)
 *
 * 커스텀 스킬: store/skills/<folder_name>/ — 사용자/LLM 에이전트가 직접 편집하는 스킬 폴더.
 *
 * 폴더명은 이름 기반 (한글/영문 모두 지원).
 * 인메모리 맵(id → folder_name)으로 경로 해석.
 * 이름 변경 시 물리 폴더도 renameSync으로 추적.
 */
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  chmodSync,
  renameSync,
} from 'fs';
import { resolve, join } from 'path';

const WORKSPACES_ROOT = resolve(process.cwd(), 'store', 'workspaces');
const SKILLS_ROOT = resolve(process.cwd(), 'store', 'skills');

// ── 인메모리 폴더명 맵 (id → folder_name) ──

const folderNameMap = new Map<string, string>();

/** 서버 시작 시 일괄 등록 */
export function initFolderNames(
  entries: Array<{ id: string; folderName: string }>,
): void {
  for (const e of entries) folderNameMap.set(e.id, e.folderName);
}

export function registerFolderName(id: string, folderName: string): void {
  folderNameMap.set(id, folderName);
}

export function unregisterFolderName(id: string): void {
  folderNameMap.delete(id);
}

/** 맵에서 폴더명 조회. 미등록 시 id 그대로 반환 (하위 호환) */
function resolveFolderName(id: string): string {
  return folderNameMap.get(id) || id;
}

// ── Slug 유틸 ──

/**
 * 이름을 파일시스템 안전한 폴더명으로 변환.
 * 한글/영문/숫자/하이픈/언더스코어 유지, 나머지 제거.
 */
export function toFolderSlug(name: string): string {
  return (
    name
      .trim()
      .replace(/[\/\\:*?"<>|.,;!@#$%^&()=+\[\]{}~`]/g, '')
      .replace(/\s+/g, '-')
      .replace(/^\.+/, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || `unnamed-${Date.now().toString(36)}`
  );
}

/**
 * root 디렉토리 기준으로 충돌 없는 슬러그 반환.
 * 파일시스템 존재 + 인메모리 맵 모두 확인.
 */
export function uniqueFolderSlug(root: string, baseSlug: string): string {
  const mapValues = new Set(folderNameMap.values());
  let slug = baseSlug;
  let counter = 2;
  while (existsSync(join(root, slug)) || mapValues.has(slug)) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }
  return slug;
}

// ── 에이전트 워크스페이스 ──

export function getWorkspacesRoot(): string {
  return WORKSPACES_ROOT;
}

export function getWorkspacePath(agentId: string): string {
  return join(WORKSPACES_ROOT, resolveFolderName(agentId));
}

export function ensureWorkspace(agentId: string): string {
  const wsPath = getWorkspacePath(agentId);
  if (!existsSync(wsPath)) {
    mkdirSync(wsPath, { recursive: true });
  }
  return wsPath;
}

// ── 채널+타겟별 워크스페이스 (멀티채널 + 멀티타겟) ──

/** 에이전트 워크스페이스 내 채널→타겟 전용 서브폴더 경로 */
export function getTargetWorkspacePath(
  agentId: string,
  channelId: string,
  targetName: string,
): string {
  const channelSlug = resolveFolderName(channelId);
  const targetSlug = toFolderSlug(targetName);
  return join(getWorkspacePath(agentId), channelSlug, targetSlug);
}

/** 채널→타겟 워크스페이스 + _shared/ 폴더 함께 생성 */
export function ensureTargetWorkspace(
  agentId: string,
  channelId: string,
  targetName: string,
): string {
  ensureWorkspace(agentId);
  const targetPath = getTargetWorkspacePath(agentId, channelId, targetName);
  if (!existsSync(targetPath)) mkdirSync(targetPath, { recursive: true });
  const sharedPath = join(getWorkspacePath(agentId), '_shared');
  if (!existsSync(sharedPath)) mkdirSync(sharedPath, { recursive: true });
  return targetPath;
}

export function removeWorkspace(agentId: string): void {
  const wsPath = getWorkspacePath(agentId);
  if (existsSync(wsPath)) {
    rmSync(wsPath, { recursive: true, force: true });
  }
  unregisterFolderName(agentId);
}

/** 채널 이름 변경 시 에이전트 워크스페이스 내 채널 폴더 리네임 */
export function renameChannelFolder(
  agentId: string,
  channelId: string,
  newFolderName: string,
): void {
  const agentWs = getWorkspacePath(agentId);
  const oldSlug = resolveFolderName(channelId);
  const oldPath = join(agentWs, oldSlug);
  const newPath = join(agentWs, newFolderName);
  if (existsSync(oldPath) && oldPath !== newPath) {
    if (!existsSync(newPath)) {
      renameSync(oldPath, newPath);
    }
  }
  registerFolderName(channelId, newFolderName);
}

/** 에이전트 이름 변경 시 워크스페이스 폴더 리네임 */
export function renameWorkspaceFolder(
  agentId: string,
  newFolderName: string,
): void {
  const oldPath = getWorkspacePath(agentId);
  const newPath = join(WORKSPACES_ROOT, newFolderName);
  if (existsSync(oldPath) && oldPath !== newPath) {
    if (!existsSync(newPath)) {
      renameSync(oldPath, newPath);
    }
  }
  registerFolderName(agentId, newFolderName);
}

/**
 * 사용자가 제공한 상대 경로를 워크스페이스 내 절대 경로로 변환.
 * 경로 탈출(path traversal) 시도 시 에러를 throw.
 *
 * _shared/ 경로: agentWorkspacePath가 제공되면 `_shared/...` 접근을 허용.
 * 타겟 폴더에서 상위의 _shared/ 폴더로 안전하게 접근 가능.
 */
export function resolveWorkspacePath(
  workspacePath: string,
  relativePath: string,
  agentWorkspacePath?: string,
): string {
  // _shared/ 프리픽스 → 에이전트 워크스페이스 루트의 _shared/ 폴더로 해석
  if (
    agentWorkspacePath &&
    relativePath.replace(/^[/\\]+/, '').startsWith('_shared')
  ) {
    const sharedRelative = relativePath.replace(/^[/\\]+/, '');
    const normalized = resolve(agentWorkspacePath, sharedRelative);
    const sharedRoot = join(agentWorkspacePath, '_shared');
    if (!normalized.startsWith(sharedRoot)) {
      throw new Error(`Access denied: path escapes _shared boundary`);
    }
    return normalized;
  }

  const normalized = resolve(workspacePath, relativePath);
  if (!normalized.startsWith(workspacePath)) {
    throw new Error(`Access denied: path escapes workspace boundary`);
  }
  return normalized;
}

// ── Custom Skill Script Files ──

export function getSkillsRoot(): string {
  return SKILLS_ROOT;
}

export function getSkillScriptDir(skillId: string): string {
  return join(SKILLS_ROOT, resolveFolderName(skillId));
}

export function getSkillScriptPath(skillId: string): string {
  return join(SKILLS_ROOT, resolveFolderName(skillId), 'run.sh');
}

export function skillScriptExists(skillId: string): boolean {
  return existsSync(getSkillScriptPath(skillId));
}

export function getSkillSchemaPath(skillId: string): string {
  return join(SKILLS_ROOT, resolveFolderName(skillId), 'schema.json');
}

export function getSkillPromptPath(skillId: string): string {
  return join(SKILLS_ROOT, resolveFolderName(skillId), 'prompt.txt');
}

export function getSkillGuidePath(skillId: string): string {
  return join(SKILLS_ROOT, resolveFolderName(skillId), 'GUIDE.md');
}

/** 스킬 이름 변경 시 폴더 리네임 */
export function renameSkillFolder(
  skillId: string,
  newFolderName: string,
): void {
  const oldPath = getSkillScriptDir(skillId);
  const newPath = join(SKILLS_ROOT, newFolderName);
  if (existsSync(oldPath) && oldPath !== newPath) {
    if (!existsSync(newPath)) {
      renameSync(oldPath, newPath);
    }
  }
  registerFolderName(skillId, newFolderName);
}

/**
 * 스킬 디렉토리 + 4개 파일 템플릿 생성.
 * 이미 존재하는 파일은 덮어쓰지 않음 (사용자/에이전트 편집 보존).
 *
 * 생성되는 파일:
 *   run.sh      — 실행 진입점 (최소한의 구조만)
 *   schema.json — LLM 도구 입력 파라미터 정의
 *   prompt.txt  — LLM에게 도구 사용법을 알려주는 시스템 프롬프트 조각
 *   GUIDE.md    — 사람/LLM 에이전트를 위한 종합 지침서
 */
export function ensureSkillScript(skillId: string, toolName: string): string {
  const dir = getSkillScriptDir(skillId);
  const scriptPath = getSkillScriptPath(skillId);
  const schemaPath = getSkillSchemaPath(skillId);
  const promptPath = getSkillPromptPath(skillId);
  const guidePath = getSkillGuidePath(skillId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (!existsSync(scriptPath)) {
    const template = `#!/bin/bash
# ${toolName} — Agent Salad Custom Skill
# 상세 지침: 같은 폴더의 GUIDE.md 참조

SKILL_DIR=$(dirname "$0")

echo "TODO: ${toolName} — 이 파일을 편집하세요. GUIDE.md를 읽고 구현하세요."
`;
    writeFileSync(scriptPath, template, { mode: 0o755 });
    try {
      chmodSync(scriptPath, 0o755);
    } catch {
      /* chmod 미지원 환경 */
    }
  }

  if (!existsSync(schemaPath)) {
    const schemaTemplate = `[
  {
    "_readme": "이 파일은 LLM이 도구에 전달하는 파라미터를 정의합니다. _로 시작하는 항목은 무시됩니다.",
    "_format": "{ name, type: string|number|boolean, description }",
    "_delivery": "스크립트에 환경변수 INPUT_<NAME>, INPUT_JSON, stdin JSON으로 전달",
    "_no_params": "파라미터 없는 도구는 이 파일을 빈 배열 [] 로 바꾸세요"
  },
  {
    "name": "query",
    "type": "string",
    "description": "검색어 또는 입력값"
  }
]
`;
    writeFileSync(schemaPath, schemaTemplate, 'utf-8');
  }

  if (!existsSync(promptPath)) {
    const promptTemplate = `유저가 ${toolName} 관련 작업을 요청하면 ${toolName} 도구를 사용하세요.
결과를 그대로 전달하거나 요약해서 유저에게 보여주세요.
`;
    writeFileSync(promptPath, promptTemplate, 'utf-8');
  }

  if (!existsSync(guidePath)) {
    writeFileSync(guidePath, buildGuideContent(toolName, skillId), 'utf-8');
  }

  return scriptPath;
}

function buildGuideContent(toolName: string, skillId: string): string {
  return `# ${toolName} — Agent Salad Custom Skill Guide

이 문서는 **사람**과 **LLM 에이전트** 모두를 위한 스킬 구현 지침서입니다.
이 폴더의 파일을 직접 편집하거나, LLM에게 이 파일을 보여주고 구현을 요청하세요.

## 폴더 구조

\`\`\`
store/skills/${skillId}/
├── run.sh          실행 진입점 (bash). 이것만 실행됩니다.
├── schema.json     LLM이 도구에 넘기는 파라미터 정의
├── prompt.txt      LLM에게 도구 사용법을 알려주는 시스템 프롬프트
├── GUIDE.md        이 파일. 구현 지침서.
└── (your files)    스크립트, 설정, 데이터 등 자유롭게 추가
\`\`\`

이 폴더 자체가 스킬의 프로젝트 폴더입니다.
Node.js, Python, 셸 스크립트 등 어떤 프로젝트든 통째로 여기에 놓으세요.

## 실행 환경

| 항목 | 값 |
|------|-----|
| 실행 방식 | \`bash run.sh\` |
| \`SKILL_DIR\` | \`$(dirname "$0")\` — 이 폴더의 절대 경로 |
| cwd (작업 디렉토리) | 에이전트 워크스페이스 (\`store/workspaces/<agent>/\`) |
| 타임아웃 | 기본 30초. 초과 시 SIGTERM |
| stdout | → LLM이 읽는 도구 응답 (결과 텍스트) |
| stderr | → 에러 시 LLM에 전달 (디버그 로그용) |
| exit code | 0 = 성공, 그 외 = 에러 |

### 두 경로의 역할

| 변수 | 경로 | 용도 |
|------|------|------|
| \`SKILL_DIR\` | \`store/skills/<skill>/\` | **코드 + 설정** (불변). run.sh, collect.js, config 등 |
| \`$PWD\` (cwd) | \`store/workspaces/<agent>/\` | **실행 결과 + 임시 데이터**. 에이전트가 read_file/list_files로 접근 가능 |

> **핵심 원칙**: 스크립트가 생성하는 결과물(output)은 **반드시 \`$PWD\`(워크스페이스)**에 저장하세요.
> \`SKILL_DIR\`에 저장하면 에이전트가 파일을 읽을 수 없습니다.
> 같은 스킬을 여러 에이전트가 사용해도, 각자의 워크스페이스에 결과가 격리됩니다.

stdout에 출력한 내용이 LLM에게 결과로 전달됩니다.
결과를 \`$PWD\`에 파일로 저장하고, 요약만 stdout에 출력하는 것을 권장합니다.

## 입력 (LLM → 스크립트)

\`schema.json\`에 정의한 파라미터가 세 가지 방식으로 전달됩니다:

1. **환경변수** \`INPUT_<NAME>\` — 파라미터명을 대문자로 변환
   예: schema에 \`"query"\` 정의 → \`$INPUT_QUERY\`로 접근
2. **환경변수** \`INPUT_JSON\` — 전체 입력을 JSON 문자열로
3. **stdin** — 파이프로 JSON 읽기 가능

파라미터 없는 도구: \`schema.json\`을 빈 배열 \`[]\`로 두세요.

## prompt.txt 작성법

\`prompt.txt\`는 LLM의 시스템 프롬프트에 자동 삽입됩니다.
LLM에게 "이 도구를 **언제**, **어떻게** 써야 하는지" 알려주는 역할입니다.

**좋은 예:**
\`\`\`
유저가 유튜브 채널의 최근 영상을 요약해달라고 하면
${toolName} 도구를 사용하세요. lookback_hours 파라미터로
시간 범위를 지정할 수 있습니다. 결과는 마크다운 형식입니다.
\`\`\`

**포인트:**
- **언제** 쓰는지 (트리거 조건)
- **파라미터**를 어떻게 채우는지
- **결과**가 어떤 형태인지
- **예상 실행 시간** (오래 걸리면 LLM이 유저에게 미리 안내 가능)
- 도구 내부 구현은 쓰지 마세요 (LLM이 알 필요 없음)

> **타임아웃 정보**: 시스템이 자동으로 \`[이 도구의 실행 제한시간: N초]\`를 프롬프트 끝에 첨부합니다.
> prompt.txt에 타임아웃을 직접 적을 필요는 없지만, 실제 예상 실행 시간이 기본 30초를 초과한다면
> Web UI에서 타임아웃을 늘리고, prompt.txt에 "이 도구는 실행에 약 N분 소요됩니다"라고 적어주세요.

## 실전 예시

### A. Node.js 프로젝트 — 코드는 스킬 폴더, 결과는 워크스페이스
\`\`\`bash
SKILL_DIR=$(dirname "$0")

# 코드 실행: 스킬 폴더의 스크립트
# 결과 저장: $PWD (에이전트 워크스페이스)
export OUTPUT_DIR="$PWD/collect-output"
mkdir -p "$OUTPUT_DIR"
node "$SKILL_DIR/collect.js" 2>/dev/null

# stdout으로 요약만 출력
cat "$OUTPUT_DIR/summary.md"
\`\`\`

### B. Python + 파라미터
\`\`\`bash
SKILL_DIR=$(dirname "$0")
# 결과를 워크스페이스에 저장하고 stdout에 출력
python3 "$SKILL_DIR/main.py" --query "$INPUT_QUERY" --output-dir "$PWD"
\`\`\`

### C. 설정은 스킬 폴더, 결과는 워크스페이스
\`\`\`bash
SKILL_DIR=$(dirname "$0")
export MY_CONFIG="$SKILL_DIR/config.yaml"    # 설정 → 스킬 폴더 (불변)
export MY_OUTPUT="$PWD/report-output"        # 결과 → 워크스페이스 (에이전트 접근 가능)
mkdir -p "$MY_OUTPUT"
node "$SKILL_DIR/run.js" 2>/dev/null
cat "$MY_OUTPUT/summary.md"
\`\`\`

### D. 단순 API 호출 (파일 저장 불필요, stdout으로 직접 반환)
\`\`\`bash
curl -s "https://api.example.com/data?q=$INPUT_QUERY"
\`\`\`

### E. 파라미터 없이 실행, 결과 파일은 워크스페이스에
\`\`\`bash
SKILL_DIR=$(dirname "$0")
python3 "$SKILL_DIR/daily_report.py" --output "$PWD/daily-report.md"
cat "$PWD/daily-report.md"
\`\`\`

## 주의사항

### 타임아웃 (30초)
기본 30초. 초과 시 SIGTERM으로 강제 종료됩니다.
오래 걸리는 작업은 사전 캐싱이나 최적화로 대응하세요.

### 크론 + 긴 스크립트 = 프로세스 증식
크론이 매번 이 스킬을 호출합니다. 타임아웃 안에 끝나지 않으면
좀비 프로세스가 쌓입니다. 크론 연결 시 반드시 빠르게 끝나야 합니다.

### 백그라운드 프로세스 금지
\`nohup\`, \`&\`, \`daemon\` 등으로 자식 프로세스를 분리하지 마세요.
\`run.sh\`가 종료되어도 자식이 살아남아 리소스를 소모합니다.

### stdout 관리
디버그 로그는 stderr로: \`echo "debug" >&2\`
stdout의 모든 내용이 LLM 응답 토큰을 소비합니다.
거대한 파일을 cat하면 토큰 낭비 + 컨텍스트 초과 위험.

### 인터랙티브 입력 불가
\`read\`, \`input()\` 등 사용자 입력 대기 코드는 hang됩니다.
모든 입력은 환경변수/stdin JSON으로 받으세요.

### 의존성은 미리 설치
\`pip install\`, \`npm install\` 등은 스킬 실행 전에 완료해야 합니다.
스크립트 안에서 매번 설치하면 타임아웃에 걸립니다.
`;
}

/** 스킬 삭제 시 스크립트 디렉토리 제거 */
export function removeSkillScript(skillId: string): void {
  const dir = getSkillScriptDir(skillId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  unregisterFolderName(skillId);
}
