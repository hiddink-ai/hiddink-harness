# hiddink-harness

Universal agent harness for Claude Code, agy, gpt-codex, and Kimi.

---

## Overview

`hiddink-harness` is a lightweight orchestration harness that lets multiple AI coding agents coexist peacefully in a single project. Claude Code, agy/Antigravity, OpenAI Codex CLI, and Kimi each expect their own directory conventions and configuration formats. Without a coordination layer, these agents conflict or overwrite each other's state. `hiddink-harness` solves this by acting as a single source of truth (SSOT) under `~/.hiddink-harness/` and exposing each provider's native directory layout via symlinks that auto-mount in any working directory.

---

## Key Features

1. **Multi-provider coexistence**: Each agent gets its own native directory layout (`.claude/`, `.agy/`, etc.). `hiddink-harness` manages all of them from a single SSOT under `templates/`, eliminating conflicts.
2. **SSOT-based auto-mount**: Agent definitions, behavioral rules, skills, and guides live once in the global SSOT and are exposed to the current working directory via symlinks that mount on CLI entry and clean up on exit. Templates auto-seed on first invocation; updates flow via `npm update -g hiddink-harness`.
3. **Internationalization**: Korean and English locales are supported for agent templates and CLI output, allowing per-developer language preferences without forking configurations.
4. **Stdio-based MCP**: Built-in MCP servers run as stdio subprocesses, eliminating network port conflicts and simplifying security boundaries.
5. **Hub architecture**: `ConversationHub` with a `ProviderAdapter` pattern handles three lifecycle patterns — persistent-bidirectional (Claude/Kimi), per-turn-resume (Codex), and PTY-wrap (agy, Phase 2).

---

## Components

File counts are tracked in `templates/manifest.json` and verified by the test suite.

### Agents (49)

Each file defines a single specialist agent. Frontmatter binds the optimal model, allowed tools, memory scope, and optional soul identity. Agents span language experts, backend and frontend frameworks, data engineering, infrastructure, security, QA, architecture, and system management roles.

### Skills (121)

Reusable task modules that agents import to perform specific workflows. Skills cover code review, refactoring, release management, routing, research, wiki sync, and more. Each skill lives in `.claude/skills/{name}/SKILL.md` with optional shell scripts and context files.

### Rules (23)

Behavioral guidelines (MUST / SHOULD / MAY priority tiers) that govern agent conduct across identification, parallel execution, orchestration, memory, safety, permissions, and continuous improvement. Rules are injected into agent context and re-enforced after compaction.

### Guides (57)

Reference documents covering cloud-native design, token efficiency, security practices, architectural patterns, and framework-specific best practices. Agents consult guides during task execution without loading them into the primary context window.

---

## Quick Start

```bash
npm install -g hiddink-harness
cd any-directory          # no init required
hiddink-harness           # auto-mounts the global SSOT for this CWD
```

The CLI derives a deterministic project ID from the CWD path and mounts `.claude/`, `.agy/`, `.omx/`, `.kimi/` as symlinks pointing to `~/.hiddink-harness/projects/{projectId}/`. Templates (agents, skills, rules, guides) auto-seed on first invocation; updates flow via `npm update -g hiddink-harness`.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `hiddink-harness` | Auto-mount global SSOT for this CWD and launch TUI Dashboard |
| `hiddink-harness list [type] [--format] [--verbose]` | List deployed agents, skills, rules, and guides |
| `hiddink-harness sync` | Sync SSOT state |
| `hiddink-harness doctor [--fix] [--updates]` | Diagnose the installation and configuration |
| `hiddink-harness security [--verbose]` | Run a security audit |

Global flags: `--skip-version-check`, `--auto-self-update`, `--skip-self-update`.

---

## Architecture

### Per-CWD symlink mount

Run `hiddink-harness` in any directory — the CLI automatically mounts symlinks pointing to the global SSOT on entry, and cleans them up on exit. Templates auto-seed on first invocation.

The global state layout is:

```
~/.hiddink-harness/
├── projects/
│   └── {projectId}/          # SHA256-derived deterministic ID per CWD
│       ├── .claude/          # SSOT for Claude Code state
│       ├── .agy/
│       ├── .omx/
│       ├── .kimi/
│       ├── sessions/         # Per-project session index
│       ├── memory/           # Per-project long-term memory
│       └── .seed-version     # Auto-seed stamp
└── state/                    # Global: active-process.json etc.
```

`projectId` format: `{directory-name}-{12-char-sha256-hex}` (e.g., `my-app-8f9a2b3c4d5e`). Computed by `getProjectId` in `src/core/global-state.ts`, so the same directory always resolves to the same SSOT slot.

### ConversationHub

The core abstraction is the `ConversationHub` (`src/core/hub.ts`), which owns the SSOT conversation state and dispatches to provider-specific `ProviderAdapter` implementations (`src/core/providers/`). The current adapters are:

- `claude-adapter.ts` — persistent bidirectional session with Claude Code
- `codex-adapter.ts` — per-turn resume pattern for OpenAI Codex CLI
- `kimi-adapter.ts` — persistent bidirectional session for Kimi
- `stream-json-base.ts` — shared streaming JSON utilities
- `system-prompt.ts` — 4-layer `SystemPromptEvolver` for dynamic prompt construction

The CLI is built with Commander and Ink. Self-update logic hooks into Commander's `preAction` lifecycle. The TUI includes a `Dashboard` and `ChatPanel` component for multi-provider chat interaction.

---

## Repository Layout

This is the source repository layout. For the runtime directory structure created on the user's machine, see the [Architecture — Per-CWD symlink mount](#architecture) section above.

```
hiddink-harness/
├── src/
│   ├── cli/                # CLI commands and Ink-based TUI
│   ├── core/               # Hub, providers, installer, registry
│   ├── mcp/                # MCP server entry point
│   └── i18n/               # Locales (en, ko)
├── templates/
│   ├── agents/             # 49 agent definitions
│   ├── skills/             # 121 skill directories
│   ├── rules/              # 23 rule files
│   ├── hooks/
│   ├── contexts/
│   ├── ontology/
│   ├── guides/             # 57 guide topics
│   ├── claude-specific/    # Claude Code-specific assets
│   │   ├── output-styles/
│   │   ├── profiles/
│   │   ├── schemas/
│   │   └── config/
│   ├── install-hooks.sh
│   ├── uninstall-hooks.sh
│   ├── statusline.sh
│   ├── manifest.json
│   ├── deprecated-files.json
│   └── index.yaml
├── packages/               # Workspace packages (memory-mcp-server, eval-core)
└── tests/                  # Bun test suite (2175 tests passing)
```

---

## Runtime Layout

When you run `hiddink-harness` in any directory, the CLI auto-creates a per-CWD SSOT and mounts symlinks. Templates auto-seed on first invocation.

```
~/.hiddink-harness/
├── projects/
│   └── {projectId}/      # e.g. my-app-8f9a2b3c4d5e
│       ├── .claude/      # Claude Code state (SSOT)
│       ├── .agy/
│       ├── .omx/         # OpenAI Codex
│       ├── .kimi/
│       ├── sessions/     # Per-project session index
│       ├── memory/       # Per-project long-term memory
│       └── .seed-version # Auto-seed stamp
└── state/                # Global: active-process.json
```

The CLI auto-mounts `.claude/`, `.agy/`, `.omx/`, `.kimi/` in the current directory as symlinks pointing to the SSOT on entry, and removes them on exit. State persists across sessions because the projectId is derived deterministically from the CWD path.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding conventions, and the pull request process.

---

## License

**Hiddink Harness License (Source-Available, Non-Commercial)**
SPDX: `LicenseRef-Hiddink-NC-1.0`

This project is source-available under a non-commercial license. Personal and open-source use is permitted; commercial use requires explicit written permission from the author. See the [LICENSE](LICENSE) file for full terms.
