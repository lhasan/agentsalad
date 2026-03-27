# Changelog

## v0.1.4 (2026-03-27)

### Bug Fixes
- 런타임 npm install 제거 — Windows npm.cmd 미발견, Program Files 쓰기 권한 거부(EPERM), macOS npm 캐시 권한 오류(EACCES) 등 4가지 첫 실행 실패 근본 해결

### Features
- 빌드 시점 node_modules 프리번들 — 번들 Node.js로 의존성을 미리 설치하여 패키지에 포함
- "Installing dependencies..." 단계 제거, 첫 실행도 수초 내 서버 시작

### Chores
- ServerManager에서 npm install/ABI 체크/npm 경로 탐색 코드 ~200줄 제거
- electron:prepare 스크립트에 빌드 시 npm install 통합
- Electron 상태 페이지에서 Installing 뷰 제거

## v0.1.3 (2026-03-27)

### Bug Fixes
- Electron 앱에서 Node.js 미설치 환경에서 "Node.js not found" 오류로 실행 불가하던 버그 수정

### Features
- Node.js 풀 배포판 번들링 (node + npm) — 시스템에 Node.js 없이도 앱 실행 가능
- 번들 Node.js 우선 사용 → 시스템 Node.js 폴백 구조로 ABI 불일치 방지

### Chores
- download-node.cjs: 바이너리 전용 → 풀 배포판(node + npm) 다운로드로 변경
- electron-build.yml: CI/CD 파이프라인에 Node.js 번들링 단계 추가

## v0.1.2 (2026-03-26)

### Features
- 크론 반복 예약: weekly(요일별 반복) + interval(시간 간격 반복) 스케줄 타입 추가
- 기존 daily 타입을 weekly로 자동 마이그레이션 (매일 반복 = 전 요일 선택)
- 크론 수정 시 연결된 모든 서비스의 next_run 자동 재계산

### Bug Fixes
- 크론 스케줄 변경 시 service_crons.next_run이 갱신되지 않던 버그 수정

## v0.1.1 (2026-03-26)

### Bug Fixes
- 에이전트 생성 시 시간 인지(time_aware), 스마트 스텝(smart_step), 최대 플랜 단계(max_plan_steps)가 저장되지 않던 버그 수정
- Windows Electron npm install spawn EINVAL 오류 수정 (CVE-2024-27980)
- 크론 스킬 힌트가 에이전트 스킬과 매칭되지 않던 버그 수정

### Features
- GitHub Actions CI/CD 파이프라인 (main 푸시 → 자동 빌드, 태그 푸시 → public 릴리스 자동 업로드)
- 서비스별 워크스페이스 폴더 열기 기능
- 랜딩 페이지 Windows 다운로드 활성화
- 에러 리포트 (Google Form) + Discord 커뮤니티 링크

### Chores
- 랜딩 페이지 정리 (GitHub 리포 링크 제거, hero 노트 통일, NanoClaw 레퍼런스 제거)
- 릴리스 & 배포 워크플로우 문서화

## v0.1.0 (2026-03-23)

- First Public Beta
