# Release & Deployment Guide

Agent Salad의 빌드, 배포, 릴리스 워크플로우.

## Repository 구조

| Remote | URL | 용도 |
|--------|-----|------|
| `origin` | `terry-uu/agentsalad-private` | 전체 소스 코드 (private) |
| `public` | `terry-uu/agentsalad` | 릴리스 에셋 + 랜딩 페이지 (public) |

- **소스 코드 푸시**: `origin` (private)에만 한다.
- **퍼블릭 리포**: 릴리스 파일(.dmg, .zip, .exe) 업로드 + `docs/` 랜딩 페이지 반영 전용. 소스 코드를 통째로 푸시하지 않는다.
- **랜딩 페이지**: `docs/index.html` — public 리포의 GitHub Pages로 서빙. https://terry-uu.github.io/agentsalad/

## 빌드 & 패키징

### 1. TypeScript 빌드

```bash
npm run build          # src/ → dist/
```

### 2. Electron 패키징

각 플랫폼의 네이티브 머신에서 실행해야 한다.

```bash
npm run electron:build
```

내부적으로 4단계 실행:
1. `npm run build` — TypeScript 컴파일
2. `npm run build:electron` — Electron 코드 컴파일 (`electron/` → `dist-electron/`)
3. `npm run electron:prepare` — `build/app-server-pkg/package.json` 생성 (런타임 의존성만 추출)
4. `electron-builder` — 플랫폼별 인스톨러 생성 → `release/` 디렉토리

빌드 결과물:

| 플랫폼 | 파일 | 용도 |
|--------|------|------|
| macOS | `release/Agent Salad-{version}-arm64.dmg` | macOS 설치 이미지 |
| macOS | `release/Agent Salad-{version}-arm64-mac.zip` | macOS 자동 업데이트용 |
| Windows | `release/Agent Salad Setup {version}.exe` | Windows NSIS 인스톨러 |

> `GH_TOKEN` 미설정 시 자동 업로드 단계에서 exit code 1이 나오지만, 빌드 자체는 성공한 것이다. 에셋 파일이 `release/`에 정상 생성되었는지만 확인하면 된다.

#### Windows 빌드 시 알려진 이슈

electron-builder v26의 `winCodeSign-2.6.0.7z` 아카이브에 macOS 심볼릭 링크가 포함되어 있어, 관리자 권한 없는 Windows에서 추출 실패한다 ([#8149](https://github.com/electron-userland/electron-builder/issues/8149)).

**해결법 (최초 1회):** winCodeSign 캐시를 수동으로 미리 추출해둔다.

```powershell
# 1. 캐시 디렉토리 생성
$cacheDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
New-Item -ItemType Directory -Path $cacheDir -Force

# 2. 아카이브 다운로드
$url = "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z"
Invoke-WebRequest -Uri $url -OutFile "$cacheDir\winCodeSign-2.6.0.7z" -UseBasicParsing

# 3. 7za로 추출 (심볼릭 링크 에러 2개는 macOS 전용이므로 무시)
& "node_modules\7zip-bin\win\x64\7za.exe" x -bd "$cacheDir\winCodeSign-2.6.0.7z" "-o$cacheDir\winCodeSign-2.6.0" -y

# 4. 아카이브 삭제
Remove-Item "$cacheDir\winCodeSign-2.6.0.7z"
```

추출 시 `libcrypto.dylib`, `libssl.dylib` 심볼릭 링크 에러(exit code 2)가 나오지만, 실제 Windows 빌드에 필요한 `rcedit-x64.exe` 등은 정상 추출된다. 캐시가 존재하면 이후 빌드에서 자동으로 재사용한다.

## CI/CD (GitHub Actions)

`.github/workflows/electron-build.yml` — main 푸시마다 자동 빌드, 태그 푸시 시 public 릴리스 자동 업로드.

### 동작 방식

| 트리거 | 빌드 | 릴리스 업로드 |
|--------|------|--------------|
| `push` to `main` | macOS + Windows 빌드 → Actions Artifacts | X |
| `push` tag `v*` | macOS + Windows 빌드 → Actions Artifacts | public 리포 릴리스에 자동 업로드 |

빌드 매트릭스:
- `macos-14` (Apple Silicon arm64): `.dmg` + `.zip`
- `windows-latest` (x64): `.exe` (NSIS)

빌드 스텝은 로컬 `npm run electron:build`와 동일한 4단계를 순서대로 실행한다:
1. `npm run build` — TypeScript 컴파일
2. `npm run build:electron` — Electron 코드 컴파일
3. `npm run electron:prepare` — app-server package.json 생성
4. `npx electron-builder --publish never` — 인스톨러 생성

macOS에서는 `CSC_IDENTITY_AUTO_DISCOVERY=false`로 코드 서명을 건너뛴다 (Apple Developer 인증서 미설정).

### 사전 준비: PAT 시크릿

태그 릴리스 자동 업로드를 위해 **Personal Access Token**이 필요하다.

1. GitHub → Settings → Developer settings → Personal access tokens → **Generate new token (classic)**
2. Scope: `repo` (Full control of private repositories) 선택
3. 생성된 토큰 복사
4. private 리포(`terry-uu/agentsalad-private`) → Settings → Secrets and variables → Actions
5. **New repository secret**: Name = `PUBLIC_REPO_TOKEN`, Value = 복사한 토큰

### 태그 기반 릴리스

```bash
# 1. package.json version 업데이트 + 커밋
# 2. 태그 생성 + 푸시
git tag v0.2.0
git push origin main --tags
# 3. GitHub Actions가 자동으로:
#    - macOS + Windows 빌드
#    - public 리포 릴리스(v0.2.0)에 에셋 업로드
```

> public 리포에 해당 태그의 릴리스가 없으면 워크플로우가 자동으로 생성한다. 수동 생성 불필요.

## 릴리스 절차 (전체 플로우)

CI/CD가 설정된 경우 Step 2~3이 자동화된다. 태그 푸시만으로 빌드+업로드 완료.

### Step 1. Private 푸시

```bash
git push origin fresh-main:main
```

### Step 2. Electron 패키징

**CI/CD 사용 시**: Step 1에서 태그와 함께 푸시하면 자동 실행. 아래 수동 절차 불필요.

**수동 빌드 시**:
```bash
npm run electron:build
```

### Step 3. Public 릴리스 에셋 교체

**CI/CD 사용 시**: 태그 푸시 워크플로우가 자동으로 기존 에셋 삭제 + 새 에셋 업로드. 아래 수동 절차 불필요.

**수동 업로드 시**:

```bash
# 기존 에셋 삭제
gh release delete-asset v{VERSION} "Agent.Salad-{VERSION}-arm64-mac.zip" --repo terry-uu/agentsalad --yes
gh release delete-asset v{VERSION} "Agent.Salad-{VERSION}-arm64.dmg" --repo terry-uu/agentsalad --yes
gh release delete-asset v{VERSION} "Agent.Salad.Setup.{VERSION}.exe" --repo terry-uu/agentsalad --yes

# 새 에셋 업로드 (macOS + Windows)
gh release upload v{VERSION} \
  "release/Agent Salad-{VERSION}-arm64-mac.zip" \
  "release/Agent Salad-{VERSION}-arm64.dmg" \
  "release/Agent Salad Setup {VERSION}.exe" \
  --repo terry-uu/agentsalad
```

### Step 4. 랜딩 페이지 반영

`docs/index.html`이 변경되었다면 public 리포에 반영한다. GitHub Pages가 자동으로 재배포한다.

private/public 리포는 히스토리가 다르므로 `git push`가 아니라 **GitHub API로 파일을 직접 업데이트**한다:

```bash
# 1. 현재 파일의 SHA 조회
SHA=$(gh api repos/terry-uu/agentsalad/contents/docs/index.html --jq '.sha')

# 2. 로컬 파일을 base64 인코딩하여 업데이트
CONTENT=$(base64 -i docs/index.html)
gh api repos/terry-uu/agentsalad/contents/docs/index.html \
  -X PUT \
  -f message="docs: 랜딩 페이지 업데이트" \
  -f content="$CONTENT" \
  -f sha="$SHA"
```

### 다운로드 URL 관리

`docs/index.html`의 다운로드 버튼은 DMG 직접 다운로드 URL을 사용한다:
```
https://github.com/terry-uu/agentsalad/releases/download/v{VERSION}/Agent.Salad-{VERSION}-arm64.dmg
```

**버전 업 시 `docs/index.html`의 다운로드 URL도 함께 변경해야 한다.** hero 버튼과 하단 다운로드 섹션 버튼 모두 확인할 것.

> public 릴리스의 "Source code (zip/tar.gz)"는 GitHub 자동 생성이며 삭제 불가. public 리포에는 LICENSE, PHILOSOPHY.md, docs/만 있으므로 실제 소스 코드 유출 없음.

### 새 버전 릴리스 생성 (버전 업 시)

```bash
# package.json version 업데이트 후
gh release create v{VERSION} \
  "release/Agent Salad-{VERSION}-arm64-mac.zip" \
  "release/Agent Salad-{VERSION}-arm64.dmg" \
  "release/Agent Salad Setup {VERSION}.exe" \
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

## 버전업 절차

버전을 올릴 때 반드시 아래 순서를 따른다:

1. `package.json`의 `version` 필드 업데이트
2. `CHANGELOG.md`에 새 버전 섹션 추가 (Bug Fixes / Features / Chores 분류)
3. `docs/index.html`의 다운로드 URL 버전 갱신 (hero 버튼 + 하단 다운로드 섹션)
4. 커밋 → 태그 생성 → 푸시

## 체크리스트

패키징 시 **전부 수행**:

- [ ] `package.json` 버전 업데이트
- [ ] `CHANGELOG.md` 작성
- [ ] `docs/index.html` 다운로드 URL 갱신
- [ ] TypeScript 빌드 성공 (`npm run build`)
- [ ] 테스트 통과 (`npm test`)
- [ ] Electron 패키징 성공 (`npm run electron:build` 또는 CI/CD 자동 빌드)
- [ ] `release/` 디렉토리에 빌드 결과물 생성 확인 (macOS: .dmg + .zip / Windows: .exe)
- [ ] private 리포 푸시 (`origin`) — CI/CD 사용 시 태그와 함께 (`--tags`)
- [ ] public 릴리스 에셋 교체 (`gh release upload` 또는 CI/CD 자동 업로드)
- [ ] 랜딩 페이지 변경 시 public 리포 반영 (`gh api` 파일 업데이트)
- [ ] CI/CD 사용 시: `PUBLIC_REPO_TOKEN` 시크릿이 유효한지 확인
