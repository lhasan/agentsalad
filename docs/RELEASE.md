# Release & Deployment Guide

Agent Salad의 빌드, 배포, 릴리스 워크플로우.

## Repository 구조

| Remote | URL | 용도 |
|--------|-----|------|
| `origin` | `terry-uu/agentsalad-private` | 전체 소스 코드 (private) |
| `public` | `terry-uu/agentsalad` | 릴리스 에셋 + 랜딩 페이지 (public) |

- **소스 코드 푸시**: `origin` (private)에만 한다.
- **퍼블릭 리포**: 릴리스 파일(.dmg, .zip) 업로드 + `docs/` 랜딩 페이지 반영 전용. 소스 코드를 통째로 푸시하지 않는다.
- **랜딩 페이지**: `docs/index.html` — public 리포의 GitHub Pages로 서빙. https://terry-uu.github.io/agentsalad/

## 빌드 & 패키징

### 1. TypeScript 빌드

```bash
npm run build          # src/ → dist/
```

### 2. Electron 패키징 (macOS arm64)

```bash
npm run electron:build
```

내부적으로 4단계 실행:
1. `npm run build` — TypeScript 컴파일
2. `npm run build:electron` — Electron 코드 컴파일 (`electron/` → `dist-electron/`)
3. `npm run electron:prepare` — `build/app-server-pkg/package.json` 생성 (런타임 의존성만 추출)
4. `electron-builder` — `.dmg` + `.zip` 생성 → `release/` 디렉토리

빌드 결과물:
- `release/Agent Salad-{version}-arm64.dmg` — macOS 설치 이미지
- `release/Agent Salad-{version}-arm64-mac.zip` — macOS 자동 업데이트용

> `GH_TOKEN` 미설정 시 자동 업로드 단계에서 exit code 1이 나오지만, 빌드 자체는 성공한 것이다. 에셋 파일이 `release/`에 정상 생성되었는지만 확인하면 된다.

## 릴리스 절차 (전체 플로우)

**패키징하면 반드시 아래 전부를 수행한다.**

### Step 1. Private 푸시

```bash
git push origin fresh-main:main
```

### Step 2. Electron 패키징

```bash
npm run electron:build
```

### Step 3. Public 릴리스 에셋 교체

기존 에셋 삭제 후 새 빌드 업로드:

```bash
# 기존 에셋 삭제
gh release delete-asset v{VERSION} "Agent.Salad-{VERSION}-arm64-mac.zip" --repo terry-uu/agentsalad --yes
gh release delete-asset v{VERSION} "Agent.Salad-{VERSION}-arm64.dmg" --repo terry-uu/agentsalad --yes

# 새 에셋 업로드
gh release upload v{VERSION} \
  "release/Agent Salad-{VERSION}-arm64-mac.zip" \
  "release/Agent Salad-{VERSION}-arm64.dmg" \
  --repo terry-uu/agentsalad
```

### Step 4. 랜딩 페이지 반영

`docs/index.html`이 변경되었다면 public 리포에 반영한다. GitHub Pages가 자동으로 재배포한다.

```bash
# docs/index.html 변경분만 public에 푸시
git push public fresh-main:main -- docs/
```

또는 변경 파일이 docs만이 아닌 경우, public 리포에서 직접 파일을 업로드한다.

### 새 버전 릴리스 생성 (버전 업 시)

```bash
# package.json version 업데이트 후
gh release create v{VERSION} \
  "release/Agent Salad-{VERSION}-arm64-mac.zip" \
  "release/Agent Salad-{VERSION}-arm64.dmg" \
  --repo terry-uu/agentsalad \
  --title "v{VERSION} — 릴리스 제목" \
  --notes "릴리스 노트 내용"
```

## 환경별 운용

| 환경 | 용도 | 비고 |
|------|------|------|
| 개발 (`npm run dev`) | 기능 개발 + 디버깅 | 로컬 hot reload |
| 스테이징 | 라이브 테스트 | 실제 메신저 채널 연결 테스트 |
| 프로덕션 | 사용자 배포 | 사용자 동의 후에만 배포 |

## 체크리스트

패키징 시 **전부 수행**:

- [ ] TypeScript 빌드 성공 (`npm run build`)
- [ ] 테스트 통과 (`npm test`)
- [ ] Electron 패키징 성공 (`npm run electron:build`)
- [ ] `release/` 디렉토리에 .dmg + .zip 생성 확인
- [ ] private 리포 푸시 (`origin`)
- [ ] public 릴리스 에셋 교체 (`gh release upload`)
- [ ] 랜딩 페이지 변경 시 public 리포 반영 (GitHub Pages)
