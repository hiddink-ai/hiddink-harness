# Hiddink House 개발 이정표 및 인수인계 가이드 (DEVELOPER_GUIDE.md)

Hiddink House (`hiddink-harness` / CLI: `hiddink-harness`) 프로젝트에 오신 것을 환영합니다!  
본 문서는 본 프로젝트의 핵심 설계와 아키텍처를 빠르게 이해하고, 중단 없이 **다음 개발 단계로 진입하여 개발을 이어갈 수 있도록 돕는 실무형 개발자 가이드**이자 **핵심 산출물**입니다.

---

## 1. 프로젝트 정체성 & 철학

Hiddink House는 **Claude Code, GPT Codex (OMX), agy, Kimi** 등 다양한 AI 에이전트 서비스 환경에 맞춤형 전문가 에이전트, 스킬, 규칙 및 훅 시스템을 동적으로 생성/배포/관리해주는 **다중 AI 서비스 범용 에이전트 하네스 (Universal Agent Harness)** 입니다.

> **핵심 철학**: *"No expert? CREATE one, connect knowledge, and USE it."*  
> 특정 분야의 전문 에이전트가 존재하지 않으면, 시스템이 스킬 and 가이드를 분석하여 즉석에서 새로운 스페셜리스트 에이전트를 조립해내고 태스크를 수행합니다.

---

## 2. 핵심 아키텍처 및 소스코드 맵핑

프로젝트 코드는 크게 **추상화 엔진(Core)**, **템플릿(Assets)**, 그리고 **보조 도구(Packages & Scripts)** 로 나뉩니다.

### 주요 소스 파일 역할

| 파일 경로 | 주요 역할 및 기능 | 핵심 추상화 내용 |
| :--- | :--- | :--- |
| `src/core/layout.ts` | 프로바이더별 레이아웃 정의 | 각 AI 도구(Claude, Codex, agy 등)가 기대하는 디렉토리 구조 및 엔트리 파일 정의 |
| `src/core/provider.ts` | 런타임 환경 감지 | 실행 디렉토리의 파일 구조나 환경 변수를 스캔하여 어떤 AI 환경인지 동적으로 판단 |
| `src/core/installer.ts` | 템플릿 복사 및 빌드 | 공통 에이전트/스킬/규칙 템플릿을 타겟 프로바이더 규격에 맞춰 트랜스파일링 및 설치 |
| `src/core/lockfile.ts` | 하네스 동기화 상태 추적 | 설치된 템플릿의 버전 및 무결성을 검증하고 추적하기 위한 락파일 관리 |
| `templates/` | 공통 템플릿 원천 | 실제 에이전트, 스킬, 규칙의 원본 템플릿 소스 파일들이 모여있는 공간 |

---

## 3. 개발 시작하기 (Getting Started)

본 프로젝트는 초고속 JS 런타임인 **Bun**을 기반으로 구축되었습니다.

### 3.1 의존성 설치 및 로컬 CLI 테스트
```bash
# 1. 의존성 설치
bun install

# 2. 로컬 개발 모드로 CLI 실행 (hiddink-harness 개발 세션 실행)
bun run dev

# 3. 프로젝트 빌드 (dist/ 폴더 생성)
bun run build

# 4. 전체 테스트 실행 (유닛 및 eval-core 테스트)
bun run test
```

### 3.2 코드 스타일 및 품질 검증 (Biome)
프로젝트는 Biome을 사용하여 매우 엄격하고 빠른 린팅과 포맷팅을 강제합니다.
```bash
# 코드 포맷팅 및 린트 검사
bun run lint

# 발견된 린트 에러 자동 수정 및 포맷팅 적용
bun run lint:fix
```

---

## 4. 🚀 개발을 이어나가기 위한 핵심 개발 태스크 (Roadmap)

지금 바로 개발에 투입되어 이어나갈 수 있는 **우선순위가 가장 높고 구체적인 4가지 백로그**입니다.

### Task 1: `agy` 플러그인 아키텍처 연동 및 호환성 완성 (최우선)
*   **목적**: Hiddink House를 `agy` 에이전트 도구의 공식 플러그인으로 동작할 수 있도록 통합을 마무리합니다.
*   **작업 내용**:
    1.  프로젝트 루트 또는 `templates/`에 `plugin.json` (agy 플러그인 매니페스트) 템플릿을 추가합니다.
    2.  `src/core/installer.ts`에서 `provider === 'agy'`일 때, `plugin.json`을 알맞게 가공하여 대상 폴더에 써주도록 빌더를 구현합니다.
    3.  로컬에서 `agy plugin validate .` 명령어를 테스트 파이프라인에 연결하여 유효성을 검증합니다.

### Task 2: 서비스 다형성을 위한 '템플릿 일반화(Generalization)' 고도화
*   **목적**: 현재 `templates/` 아래 에이전트나 규칙 명세가 Claude Code(예: `sonnet` 등)에 다소 편향되어 있습니다. 이를 프로바이더-중립적으로 추상화합니다.
*   **작업 내용**:
    1.  템플릿 파일 내의 모델 정보나 인프라 정보를 플레이스홀더(예: `{{HIGH_CAPABILITY_MODEL}}`) 형태로 전환합니다.
    2.  설치 대상 프로바이더(Claude vs Codex vs Kimi)에 따라 플레이스홀더를 매핑된 값으로 치환하는 치환 엔진(Parser)을 보강합니다.

### Task 3: 훅(Hook) 시스템 안정성 확보 및 이코모드(Ecomode) 정합성 검증
*   **목적**: CLI를 사용해 배포된 자동화 훅들이 각 타겟 CLI 환경에서 비정상적으로 작동하거나 무한 루프를 도는 문제를 원천 방증합니다.
*   **작업 내용**:
    1.  `stage-blocker.sh` 및 `content-hash-validator.sh` 등의 쉘 스크립트가 비동기/동기 도구 호출 시 안정적으로 에러를 반환하는지 테스트 케이스를 구축합니다.
    2.  컨텍스트 사용량을 능동적으로 조절하는 `context-budget-advisor.sh` (Ecomode)의 판단 임계값 설정을 다듬습니다.

### Task 4: CLI 설정 마법사(hiddink-harness setup) 구현
*   **목적**: 사용자가 CLI 상에서 손쉽게 프로바이더와 다국어(English, Korean) 및 설치할 컴포넌트(에이전트, 스킬, 가이드 등)를 고를 수 있게 합니다.
*   **작업 내용**:
    1.  `@inquirer/prompts` 또는 `@clack/prompts` 패키지를 활용하여 세련된 인터랙티브 CLI 질의 단계를 구현합니다.
    2.  `hiddink-harness init` 실행 시 자동으로 로컬 환경을 스캔하고 최적의 설정을 추천해 주는 대화형 셋업 Flow를 작성합니다.

---

## 5. 학습 및 참조 문서 목록

더 정교한 시스템 기여를 위해 먼저 읽어봐야 할 풍부한 레퍼런스 목록입니다:

*   **상세 아키텍처 다이어그램 및 정적 설계 문서**:  
    👉 `ARCHITECTURE.md` (ag-research 레포지토리 내)
*   **전체 18개 미해결 이슈 기반의 상세 마일스톤**:  
    👉 `TODO-ROADMAP.md` (ag-research 레포지토리 내)
*   **프로젝트 기본 설명서**:  
    👉 `README.md` (ag-research 레포지토리 내)

---

> 💡 **새로운 에이전트 또는 스킬을 추가하고자 한다면**, `templates/.claude/agents/` 또는 `templates/.claude/skills/`에 템플릿 마크다운 파일을 생성한 후 `bun run build`를 통해 검증 및 테스트를 시작할 수 있습니다.
