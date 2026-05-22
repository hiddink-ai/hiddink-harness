# PRD: Rust Ratatui TUI Migration while Preserving the TypeScript Backend

Recovered from the interrupted OMX/Codex session on 2026-05-22.

## 1. Background

`hiddink-harness` is currently a TypeScript/Bun CLI that launches an Ink/React TUI by default. The existing backend is already structured around `ConversationHub` and provider adapters, so the migration should replace only the user-facing terminal UI and preserve the provider/backend implementation.

Evidence from the existing codebase:

- `package.json` exposes `hiddink-harness` and `hiddink-harness_dev` binaries.
- The dev launcher runs `bun run src/cli/index.ts`.
- The current TUI stack uses `ink`, `ink-text-input`, and `react`.
- The default CLI action renders the Ink dashboard from `src/cli/index.ts`.
- Backend/provider ownership lives in `src/core/hub.ts` and `src/core/providers/*`.

Primary files:

- `src/cli/index.ts`
- `src/cli/ui/Dashboard.tsx`
- `src/cli/ui/ChatPanel.tsx`
- `src/core/hub.ts`
- `src/core/providers/*`

## 2. Goal

Replace the user-facing Ink/React TUI with a Rust `ratatui` TUI while preserving the TypeScript backend and provider adapter logic.

Target architecture:

```text
Rust ratatui TUI
└─ spawns TypeScript backend subprocess
   └─ ConversationHub
      ├─ ClaudeAdapter
      ├─ CodexAdapter
      └─ KimiAdapter
```

Rust and TypeScript communicate through a `stdio` JSON-lines IPC protocol.

Architecture constraints:

- Rust owns only terminal rendering, input handling, and subprocess lifecycle.
- TypeScript remains the source of truth for providers, session semantics, memory/RAG integration, project IDs, and configuration.
- Phase boundaries are strict: Phase 1 must not import or spawn the TypeScript backend.
- Any behavior that cannot be backed by real backend data in Phase 1 must be rendered as an explicit placeholder, not mocked as real data.

## 3. Non-goals

- Do not port `ConversationHub` to Rust.
- Do not rewrite Claude/Codex/Kimi provider adapters in Rust.
- Do not implement backend IPC in Phase 1.
- Do not complete sessions/RAG/settings parity in Phase 1.
- Do not perform npm publish, public release, or external deployment work as part of this migration plan.

## 4. Current State Analysis

### Existing UI

`Dashboard.tsx` already defines the main screen structure:

- Header
- Tabs: `sessions`, `rag`, `settings`, `talk`
- Sessions tab
- RAG tab
- Talk tab
- Settings tab
- Bottom/system logs

`ChatPanel.tsx` is responsible for:

- Provider selection
- Message input
- Slash commands
- Streaming state display
- Sending messages through `ConversationHub`

### Existing backend

`ConversationHub` remains the backend single source of truth.

It owns:

- Adapter registry
- Provider dispatch and streaming
- Session persistence
- Provider lifecycle management

The Claude provider already uses JSONL-style process streaming, which makes it a good fit for a future TypeScript backend subprocess boundary.

Relevant backend behavior:

- Claude process spawn arguments
- Claude user message JSON serialization
- Shared JSONL reader/writer utilities

## 5. Release Scope

## Phase 1 — Standalone Rust TUI Scaffold

### Objective

Create an independent Rust crate at `crates/hiddink-tui/`.

No IPC or backend calls are included in this phase.

Phase 1 is intentionally a UI shell. It should prove that the ratatui app can render, handle input, and restore the terminal safely before backend coupling is introduced.

### Requirements

- Use `ratatui` with alternate screen mode.
- Render these regions:
  - Header
  - Tabs: `talk`, `sessions`, `rag`, `settings`
  - Message area
  - Input box
  - Bottom hint/status bar
- Support these controls:
  - `Tab`, `Left`, and `Right` cycle between tabs
  - Slash commands: `/sessions`, `/rag`, `/settings`, `/talk`, `/exit`
  - `Esc` clears non-empty input; otherwise it returns to `talk` from non-talk tabs
  - `Ctrl-C` exits from any state
  - `q` exits only when it is treated as a command/global shortcut, not while entering normal message text
- Show backend disconnected state clearly:
  - `backend: disconnected (phase 1 scaffold)`
- Make placeholder state explicit:
  - Sessions tab: no backend/session listing yet
  - RAG tab: no memory index connected yet
  - Settings tab: static/current-process values only
- Restore terminal state on exit:
  - Leave alternate screen
  - Restore cursor
  - Disable raw mode
  - Attempt restoration even after render-loop errors or panics

### Rust crate baseline

- Start as a standalone crate, not a root workspace member.
- Use `edition = "2021"` unless a later repository-wide Rust standard is adopted.
- Keep Phase 1 dependencies minimal:
  - `ratatui` for rendering
  - `crossterm` for terminal events/backend
  - no async runtime unless Phase 2 subprocess handling proves it is needed
- Keep app state transitions in testable pure Rust modules where practical.
- Do not add packaging/install logic in Phase 1.

### Candidate file layout

```text
crates/hiddink-tui/
├─ Cargo.toml
└─ src/
   ├─ main.rs
   ├─ app.rs
   ├─ ui.rs
   └─ event.rs
```

Recommended responsibilities:

- `main.rs`: terminal setup, teardown guard, CLI flags, event loop entrypoint.
- `app.rs`: tab enum, input buffer, status/backend state, slash-command handling.
- `ui.rs`: pure rendering functions that can be tested with `ratatui::backend::TestBackend`.
- `event.rs`: crossterm event mapping into app actions.

### Phase 1 validation

```bash
cargo fmt --manifest-path crates/hiddink-tui/Cargo.toml -- --check
cargo check --manifest-path crates/hiddink-tui/Cargo.toml
cargo test --manifest-path crates/hiddink-tui/Cargo.toml
cargo run --manifest-path crates/hiddink-tui/Cargo.toml -- --smoke
cargo run --manifest-path crates/hiddink-tui/Cargo.toml
```

`--smoke` must be non-interactive. It should render at least one frame using a test/offscreen backend or equivalent deterministic path and exit with status 0. The interactive `cargo run` remains a manual verification step.

Minimum Phase 1 test coverage:

- tab cycling wraps in both directions
- slash commands switch to the expected placeholder tabs
- `/exit`, `Ctrl-C`, and command-mode `q` request shutdown
- `Esc` clears input before switching tabs
- disconnected backend status is present in the rendered frame

## Phase 2 — TypeScript Backend Subprocess + JSON-lines IPC

### Objective

Have the Rust TUI spawn a TypeScript backend subprocess and stream real Claude provider responses through JSON-lines IPC.

### Candidate TypeScript backend entrypoint

```text
src/cli/ipc-backend.ts
```

Responsibilities:

- Create `ConversationHub`.
- Register `ClaudeAdapter` first.
- Read JSONL requests from stdin.
- Write JSONL events to stdout.
- Write logs/errors only to stderr.
- Avoid the Commander default action, Ink rendering path, preflight warning path, and self-update path from `src/cli/index.ts`.
- Exit non-zero only for unrecoverable process-level startup failures; request-level failures should be sent as JSONL `error` events.

### IPC draft

Protocol version: `1`.

Rust → TypeScript:

```jsonl
{"id":"1","type":"init","protocolVersion":1,"cwd":"/path/to/project"}
{"id":"2","type":"listProviders"}
{"id":"3","type":"send","provider":"claude","message":"hello"}
{"id":"4","type":"abort","targetId":"3"}
{"id":"5","type":"shutdown"}
```

TypeScript → Rust:

```jsonl
{"id":"1","type":"ready","protocolVersion":1,"projectId":"my-app-abc123","providers":["claude"]}
{"id":"2","type":"providers","providers":["claude"]}
{"id":"3","type":"message.delta","role":"assistant","content":"partial text"}
{"id":"3","type":"message","message":{"role":"assistant","content":"full text","timestamp":"..."}}
{"id":"3","type":"done"}
{"id":"3","type":"error","message":"..."}
```

IPC rules:

- stdout is reserved for IPC JSONL only.
- stderr is reserved for logs and diagnostics.
- Each JSON object is exactly one line.
- TypeScript must flatten provider `ContentBlock[]` into display text before sending events to Rust.
- Every response event must include the originating request `id`.
- Unknown request types must return an `error` event with the same `id`.
- In the first IPC implementation, allow only one active `send` request at a time unless concurrent stream handling is explicitly designed and tested.
- `abort.targetId` cancels the active stream for that target request and should produce either `done` with an aborted flag or an `error` with a stable abort code.
- Backend process startup must never print banners, prompts, warnings, or progress messages to stdout.

Phase 2 validation should include:

- TypeScript unit tests for JSONL parsing/framing and stdout/stderr separation.
- TypeScript backend tests with a mocked `ConversationHub`.
- Rust IPC client tests using a fake subprocess or fixture JSONL stream.
- An integration smoke test that sends `init`, `listProviders`, and a mocked `send`.

## Phase 3 — Sessions/RAG/Settings Parity

### Objective

Make the Rust TUI match or improve the existing Ink tab behavior.

### Sessions

The current code may have a session path mismatch:

- The dashboard reads project-scoped sessions.
- `ConversationHub.saveSession()` writes global sessions.
- `global-state` treats project sessions as the standard.

Before Phase 3 implementation, define one session storage policy.

Recommended policy:

```text
~/.hiddink-harness/projects/{projectId}/sessions
```

The policy decision must update both read and write paths. In particular, `ConversationHub.saveSession()` and `ConversationHub.loadSession()` should not continue using the legacy global `~/.hiddink-harness/sessions` path if project-scoped sessions are the standard.

Add backend IPC support for:

```text
listSessions
```

### RAG initial parity

- Show memory DB path.
- Show indexed concept/count placeholder.
- Later integrate with `packages/eval-core` or MCP memory.

### Settings initial parity

- Language
- Active providers
- Current working directory
- Project ID
- Backend status

## Phase 4 — `hiddink-harness_dev` Rust Binary Transition

The current dev launcher runs the TypeScript CLI directly.

Target flow:

```bash
hiddink-harness_dev
→ cargo run --manifest-path crates/hiddink-tui/Cargo.toml -- ...
→ Rust TUI spawns TypeScript backend
```

Production packaging remains a separate decision. Options:

- Include prebuilt Rust binaries.
- Build via postinstall.
- Use a TypeScript wrapper that selects the platform binary.
- Keep Rust TUI dev-only until packaging is decided.

## 6. Key Risks

1. **Session path mismatch**
   - Dashboard and hub persistence may use different session directories.
   - Resolve before Phase 3.

2. **ContentBlock display**
   - Claude adapters may emit `ContentBlock[]`.
   - Rust UI should receive flattened display text from the TypeScript IPC backend.

3. **stdout contamination**
   - JSONL IPC breaks if the backend writes regular logs to stdout.
   - Enforce stderr-only diagnostics and keep the IPC backend separate from CLI hooks that may print warnings.

4. **No root Rust workspace yet**
   - The root currently has no `Cargo.toml`.
   - `packages/ontology-rag/Cargo.toml` is separate.
   - Start `crates/hiddink-tui` as a standalone crate.

5. **Interactive TUI regressions**
   - Manual `cargo run` is not enough to catch app-state and render regressions.
   - Add deterministic app-state tests and a non-interactive render smoke path in Phase 1.

6. **Developer environment drift**
   - `hiddink-harness_dev` currently assumes Bun only.
   - Phase 4 must handle missing Rust/Cargo with a clear error or keep the Rust TUI opt-in until packaging is decided.

## 7. Acceptance Criteria

### Phase 1 acceptance criteria

- `crates/hiddink-tui` builds as a standalone Rust crate.
- The TUI renders header, tabs, message area, input, and bottom hint/status.
- Input handling and tab switching work.
- Backend disconnected state is visible.
- Terminal state is restored after exit.
- Placeholder tabs are clearly labeled as disconnected/not yet backed by IPC.
- Non-interactive render smoke mode passes.
- `cargo fmt`, `cargo check`, `cargo test`, and `cargo run -- --smoke` pass for the crate.

### Full migration acceptance criteria

- `hiddink-harness` or `hiddink-harness_dev` launches the Rust TUI.
- Rust TUI manages the TypeScript backend subprocess safely.
- Claude streaming responses render in the `talk` tab.
- Sessions/RAG/settings are equivalent to or clearer than the Ink UI.
- Existing TypeScript backend tests continue to pass.
- IPC protocol framing, error handling, abort behavior, and stdout/stderr separation are covered by tests.

## 8. Recovered Verification Record

The interrupted session recorded this backend-focused test run:

```text
bun test tests/unit/core/hub.test.ts   tests/unit/core/providers/claude-adapter.test.ts   tests/unit/core/providers/stream-json-base.test.ts

73 pass, 3 skip, 0 fail
```

The recovered conclusion was that preserving the TypeScript backend and replacing only the TUI is aligned with the current code structure.

## 9. Immediate Next Step

Implement Phase 1 only:

1. Create `crates/hiddink-tui/` as a standalone crate.
2. Build the static `ratatui` scaffold.
3. Add app-state tests for tab switching, slash commands, exit handling, and `Esc`.
4. Add non-interactive `--smoke` render validation.
5. Run the Phase 1 validation commands.
