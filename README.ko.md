# hiddink-harness

Claude Code, agy, gpt-codex, Kimi를 위한 범용 에이전트 하네스.

> 영문 버전은 [README.md](README.md)를 참조하세요.

---

## 개요

`hiddink-harness`는 여러 AI 코딩 에이전트가 단일 프로젝트 안에서 충돌 없이 공존할 수 있도록 설계된 경량 오케스트레이션 하네스입니다. Claude Code, agy/Antigravity, OpenAI Codex CLI, Kimi는 각자 고유한 디렉토리 규약과 설정 형식을 요구합니다. 조율 레이어 없이는 이 에이전트들이 서로의 상태를 덮어쓰거나 충돌을 일으킵니다. `hiddink-harness`는 에이전트 정의, 스킬, 규칙, 가이드를 SSOT(단일 정보 원천)로 한 번만 작성하고, 필요할 때 각 프로바이더의 네이티브 형식으로 배포함으로써 이 문제를 해결합니다.

---

## 핵심 기능

1. **멀티 프로바이더 공존**: 각 에이전트는 자체 네이티브 디렉토리 구조(`.claude/`, `.agy/` 등)를 유지합니다. `hiddink-harness`는 `templates/` 하위의 단일 SSOT에서 이 모든 구조를 관리하여 충돌을 원천 차단합니다.
2. **SSOT 기반 동적 배포**: 에이전트 정의, 행동 규칙, 스킬, 가이드를 한 번만 작성하면 `hiddink-harness init`과 `hiddink-harness update`를 통해 프로바이더별 형식으로 배포됩니다.
3. **다국어 지원**: 에이전트 템플릿과 CLI 출력에 한국어/영어 로케일이 지원됩니다. 설정을 분기하지 않고도 개발자별 언어 선호를 반영할 수 있습니다.
4. **stdio 기반 MCP**: 내장 MCP 서버가 stdio 서브프로세스로 동작하여 네트워크 포트 충돌을 없애고 보안 경계를 단순하게 유지합니다.
5. **Hub 아키텍처**: `ConversationHub`와 `ProviderAdapter` 패턴이 세 가지 라이프사이클을 처리합니다 — persistent-bidirectional (Claude/Kimi), per-turn-resume (Codex), PTY-wrap (agy, Phase 2).

---

## 구성 요소

파일 카운트는 `templates/manifest.json`에서 관리되며 테스트 스위트가 검증합니다.

### Agents (49)

각 파일은 단일 전문 에이전트를 정의합니다. 프론트매터에 최적 모델, 허용 도구, 메모리 스코프, 선택적 soul 아이덴티티를 바인딩합니다. 에이전트는 언어 전문가, 백엔드/프론트엔드 프레임워크, 데이터 엔지니어링, 인프라, 보안, QA, 아키텍처, 시스템 관리 역할을 아우릅니다.

### Skills (121)

에이전트가 특정 워크플로우를 수행할 때 가져다 쓰는 재사용 가능한 태스크 모듈입니다. 코드 리뷰, 리팩토링, 릴리즈 관리, 라우팅, 리서치, wiki 동기화 등을 다룹니다. 각 스킬은 `.claude/skills/{name}/SKILL.md`에 위치하며 선택적으로 셸 스크립트와 컨텍스트 파일을 포함합니다.

### Rules (23)

에이전트 행동을 규율하는 행동 지침입니다(MUST / SHOULD / MAY 우선순위 계층). 식별, 병렬 실행, 오케스트레이션, 메모리, 안전, 권한, 지속적 개선 전반을 다룹니다. 규칙은 에이전트 컨텍스트에 주입되고 컴팩션 이후에도 재적용됩니다.

### Guides (57)

클라우드 네이티브 설계, 토큰 효율성, 보안 실천법, 아키텍처 패턴, 프레임워크별 모범 사례를 다루는 레퍼런스 문서입니다. 에이전트는 태스크 실행 중 가이드를 참조하되 기본 컨텍스트 윈도우에는 로드하지 않습니다.

---

## 빠른 시작

```bash
npm install -g hiddink-harness
cd your-project
hiddink-harness init --yes
```

`hiddink-harness init`은 전체 템플릿 세트를 배포합니다. 선택한 언어와 환경에 맞게 구성된 `CLAUDE.md`, `.claude/`, 그 외 프로바이더 디렉토리들이 생성됩니다.

---

## CLI 명령어

| 명령어 | 설명 |
|--------|------|
| `hiddink-harness init` | 프로젝트 초기화 및 템플릿 배포 |
| `hiddink-harness update` | 최신 설치 버전에서 템플릿 동기화 |
| `hiddink-harness list` | 배포된 에이전트, 스킬, 규칙, 가이드 목록 출력 |
| `hiddink-harness doctor` | 설치 및 설정 상태 진단 |
| `hiddink-harness security` | 보안 감사 실행 |
| `hiddink-harness web start\|stop\|status\|open` | 웹 대시보드 관리 |
| `hiddink-harness serve` / `serve-stop` | 로컬 서버 시작 또는 중지 |
| `hiddink-harness projects` | 등록된 프로젝트 목록 출력 |
| `hiddink-harness unregister [path]` | 등록된 프로젝트 제거 |
| `hiddink-harness mcp-serve` | stdio를 통한 내장 MCP 서버 실행 |

전역 플래그: `--auto-self-update`, `--skip-self-update`.

---

## 아키텍처

핵심 추상화는 `ConversationHub`(`src/core/hub.ts`)입니다. SSOT 대화 상태를 소유하고 프로바이더별 `ProviderAdapter` 구현체(`src/core/providers/`)로 디스패치합니다. 현재 구현된 어댑터는 다음과 같습니다.

- `claude-adapter.ts` — Claude Code와의 영속적 양방향 세션
- `codex-adapter.ts` — OpenAI Codex CLI를 위한 per-turn resume 패턴
- `kimi-adapter.ts` — Kimi와의 영속적 양방향 세션
- `stream-json-base.ts` — 공유 스트리밍 JSON 유틸리티
- `system-prompt.ts` — 동적 프롬프트 구성을 위한 4-레이어 `SystemPromptEvolver`

CLI는 Commander와 Ink로 구축됩니다. 자동 업데이트 로직은 Commander의 `preAction` 라이프사이클에 연결됩니다. TUI에는 멀티 프로바이더 채팅 인터랙션을 위한 `Dashboard`와 `ChatPanel` 컴포넌트가 포함됩니다.

---

## 리포지토리 구조

```
hiddink-harness/
├── src/
│   ├── cli/                # CLI 명령어 및 Ink 기반 TUI
│   ├── core/               # Hub, providers, installer, registry
│   ├── mcp/                # MCP 서버 진입점
│   └── i18n/               # 로케일 (en, ko)
├── templates/
│   ├── .claude/agents/     # 에이전트 정의 49개
│   ├── .claude/skills/     # 스킬 디렉토리 121개
│   ├── .claude/rules/      # 규칙 파일 23개
│   └── guides/             # 가이드 토픽 57개
├── packages/               # 워크스페이스 패키지 (memory-mcp-server, eval-core)
└── tests/                  # Bun 테스트 스위트 (2175개 통과)
```

---

## 기여

개발 환경 설정, 코딩 컨벤션, 풀 리퀘스트 절차는 [CONTRIBUTING.md](CONTRIBUTING.md)를 참조하세요.

---

## 라이선스

**Hiddink Harness License (Source-Available, Non-Commercial)**
SPDX: `LicenseRef-Hiddink-NC-1.0`

이 프로젝트는 비상업적 라이선스 하에 소스를 공개합니다. 개인 및 오픈소스 용도의 사용은 허용됩니다. 상업적 이용은 저자의 명시적인 서면 허가가 필요합니다. 전체 조건은 [LICENSE](LICENSE) 파일을 참조하세요.

참고: `package.json`의 `"license": "MIT"` 표기는 레지스트리 호환성을 위한 것으로, 실제 적용되는 라이선스는 `LICENSE` 파일의 Hiddink Non-Commercial License입니다.
