/**
 * 4-layer evolving system prompt builder for multi-LLM provider integration.
 *
 * Layer composition order (lower = higher priority):
 *   project → memory → session → provider
 *
 * The Hub calls build(providerId) before every sendTo() so the composed prompt
 * always reflects the latest accumulated state.
 */

import type { ProviderId } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The four composable layers that together form the system prompt. */
export type SystemPromptLayer = 'project' | 'memory' | 'session' | 'provider';

/**
 * Snapshot of the full prompt state.
 * Used for serialization and deserialization (session persistence).
 */
export interface SystemPromptState {
  /** CLAUDE.md / AGENTS.md content + project-level rules. */
  project: string;
  /** R011 memory excerpts (long-term knowledge). */
  memory: string;
  /** Decisions and context accumulated during the current session. */
  session: string;
  /**
   * Per-provider micro-adaptations injected as the last layer.
   * Key is ProviderId; value is provider-specific instruction text.
   */
  provider: Record<ProviderId, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All known ProviderId values used to initialise the provider map. */
const ALL_PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex', 'agy', 'kimi'];

function buildEmptyState(): SystemPromptState {
  const provider = Object.fromEntries(ALL_PROVIDER_IDS.map((id) => [id, ''])) as Record<
    ProviderId,
    string
  >;
  return { project: '', memory: '', session: '', provider };
}

/** Joins non-empty strings with a double newline separator. */
function joinSections(...parts: string[]): string {
  return parts.filter((p) => p.trim().length > 0).join('\n\n');
}

// ---------------------------------------------------------------------------
// SystemPromptEvolver
// ---------------------------------------------------------------------------

/**
 * Maintains the mutable state of a 4-layer system prompt and composes it
 * on demand for a given ProviderId.
 *
 * Usage:
 * ```ts
 * const evolver = new SystemPromptEvolver({ project: claudeMdContent });
 * evolver.appendLayer('session', 'User prefers concise answers.');
 * const prompt = evolver.build('claude');
 * ```
 */
export class SystemPromptEvolver {
  private state: SystemPromptState;

  constructor(initial?: Partial<SystemPromptState>) {
    this.state = buildEmptyState();
    if (initial) {
      this.mergePartial(initial);
    }
  }

  // -------------------------------------------------------------------------
  // Mutation API
  // -------------------------------------------------------------------------

  /**
   * Appends `content` to the specified layer (or the provider sub-key when
   * `layer === 'provider'` and `providerId` is given).
   * Appended content is separated from existing content by a newline.
   */
  appendLayer(layer: SystemPromptLayer, content: string, providerId?: ProviderId): void {
    if (layer === 'provider') {
      if (!providerId) {
        throw new Error("appendLayer: 'providerId' is required when layer === 'provider'");
      }
      const existing = this.state.provider[providerId] ?? '';
      this.state.provider[providerId] = existing ? `${existing}\n${content}` : content;
    } else {
      const existing = this.state[layer];
      this.state[layer] = existing ? `${existing}\n${content}` : content;
    }
  }

  /**
   * Replaces the full content of the specified layer (or the provider sub-key).
   */
  setLayer(layer: SystemPromptLayer, content: string, providerId?: ProviderId): void {
    if (layer === 'provider') {
      if (!providerId) {
        throw new Error("setLayer: 'providerId' is required when layer === 'provider'");
      }
      this.state.provider[providerId] = content;
    } else {
      this.state[layer] = content;
    }
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  /**
   * Composes and returns the full system prompt for the given provider.
   *
   * Layer order (earlier layers appear first in the composed string):
   *   1. project  — stable project-wide context
   *   2. memory   — long-term knowledge excerpts
   *   3. session  — accumulated session decisions
   *   4. provider — provider-specific micro-adaptations (last, highest priority)
   */
  build(provider: ProviderId): string {
    const { project, memory, session } = this.state;
    const providerSection = this.state.provider[provider] ?? '';
    return joinSections(project, memory, session, providerSection);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** Returns a deep-cloned snapshot suitable for JSON serialization. */
  serialize(): SystemPromptState {
    return {
      project: this.state.project,
      memory: this.state.memory,
      session: this.state.session,
      provider: { ...this.state.provider },
    };
  }

  /**
   * Reconstructs a SystemPromptEvolver from a previously serialized state.
   * Useful for restoring session state from disk.
   */
  static deserialize(state: SystemPromptState): SystemPromptEvolver {
    const evolver = new SystemPromptEvolver();
    evolver.state = {
      project: state.project ?? '',
      memory: state.memory ?? '',
      session: state.session ?? '',
      provider: {
        ...buildEmptyState().provider,
        ...state.provider,
      },
    };
    return evolver;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private mergePartial(partial: Partial<SystemPromptState>): void {
    if (partial.project !== undefined) this.state.project = partial.project;
    if (partial.memory !== undefined) this.state.memory = partial.memory;
    if (partial.session !== undefined) this.state.session = partial.session;
    if (partial.provider) {
      this.state.provider = {
        ...this.state.provider,
        ...partial.provider,
      };
    }
  }
}
