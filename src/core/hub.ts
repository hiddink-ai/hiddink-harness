/**
 * ConversationHub — Single Source of Truth for multi-provider conversation state.
 *
 * Responsibilities:
 *  - Maintain conversation history across all providers.
 *  - Manage per-provider ChatSession lifetime (spawn / reuse / close).
 *  - Compose system prompts via SystemPromptEvolver before each provider call.
 *  - Implement cross-provider patterns: parallelConsensus, sequentialHandoff, fallbackChain.
 *  - Persist and restore conversation state under ~/.hiddink-harness/projects/{projectId}/sessions/.
 *
 * The Hub is NOT responsible for subprocess I/O — that belongs to adapters.
 * The Hub is NOT responsible for system prompt content — callers push layers in.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { devLog } from '../utils/dev-log.js';
import { getGlobalStateDir, getProjectId, getProjectStateDir } from './global-state.js';
import {
  SystemPromptEvolver,
  type SystemPromptLayer,
  type SystemPromptState,
} from './providers/system-prompt.js';
import type {
  ChatSession,
  NormalizedMessage,
  ProviderAdapter,
  ProviderId,
} from './providers/types.js';

// ---------------------------------------------------------------------------
// Internal state shape
// ---------------------------------------------------------------------------

/**
 * Runtime state held by a ConversationHub instance.
 * Not directly exposed; accessed only through Hub methods.
 */
export interface HubState {
  sessionId: string;
  cwd: string;
  history: NormalizedMessage[];
  systemPrompt: SystemPromptEvolver;
  /** Optional explicit model per provider. Empty means provider CLI default/config. */
  modelOverrides: Map<ProviderId, string>;
  /** Long-lived sessions for persistent-bidirectional providers (claude, kimi). */
  activeSessions: Map<ProviderId, ChatSession>;
  /**
   * Most-recent thread IDs for per-turn-resume providers (codex).
   * Passed as `resumeSessionId` on the next spawn call.
   */
  lastThreadIds: Map<ProviderId, string>;
}

// Serializable snapshot written to disk.
interface PersistedHubState {
  sessionId: string;
  cwd: string;
  history: NormalizedMessage[];
  systemPrompt: SystemPromptState;
  modelOverrides?: Record<string, string>;
  lastThreadIds: Record<string, string>;
}

// ---------------------------------------------------------------------------
// ConversationHub
// ---------------------------------------------------------------------------

export class ConversationHub {
  private readonly adapters: Map<ProviderId, ProviderAdapter> = new Map();
  private readonly state: HubState;
  /** Sessions currently inside sendTo(); used for ESC/cancel from the UI. */
  private readonly inFlightSessions: Map<ProviderId, ChatSession> = new Map();

  constructor(opts: {
    sessionId: string;
    cwd: string;
    initialSystemPrompt?: Partial<SystemPromptState>;
    initialModels?: Partial<Record<ProviderId, string>>;
  }) {
    this.state = {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      history: [],
      systemPrompt: new SystemPromptEvolver(opts.initialSystemPrompt),
      modelOverrides: new Map(
        Object.entries(opts.initialModels ?? {}) as Array<[ProviderId, string]>
      ),
      activeSessions: new Map(),
      lastThreadIds: new Map(),
    };
  }

  // -------------------------------------------------------------------------
  // Adapter registry
  // -------------------------------------------------------------------------

  /** Register a provider adapter. Overwrites any existing registration for the same id. */
  registerAdapter(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /** Returns true when an adapter has been registered for the given provider. */
  hasAdapter(provider: ProviderId): boolean {
    return this.adapters.has(provider);
  }

  getProviderModel(provider: ProviderId): string | undefined {
    return this.state.modelOverrides.get(provider);
  }

  async setProviderModel(provider: ProviderId, model: string | undefined): Promise<void> {
    const normalized = model?.trim();
    if (normalized) {
      this.state.modelOverrides.set(provider, normalized);
    } else {
      this.state.modelOverrides.delete(provider);
    }

    this.state.lastThreadIds.delete(provider);
    const active = this.state.activeSessions.get(provider);
    if (active) {
      this.state.activeSessions.delete(provider);
      await active.close();
    }
  }

  /**
   * Returns the list of provider ids for which a registered adapter reports
   * availability (binary / runtime is present on PATH).
   */
  async listAvailable(): Promise<ProviderId[]> {
    const checks = await Promise.all(
      [...this.adapters.entries()].map(async ([id, adapter]) => {
        const available = await adapter.isAvailable();
        return available ? id : null;
      })
    );
    return checks.filter((id): id is ProviderId => id !== null);
  }

  // -------------------------------------------------------------------------
  // Core: send a message to a provider
  // -------------------------------------------------------------------------

  /**
   * Send `message` to the specified provider and yield the streaming response.
   *
   * Lifecycle behaviour by adapter.lifecycle:
   *   - persistent-bidirectional: Reuses an existing ChatSession when available;
   *     spawns a new one otherwise. Session remains open after the call.
   *   - per-turn-resume: Spawns a fresh session with `resumeSessionId` when a
   *     previous thread exists; collects the full response; closes the session;
   *     stores the new thread ID.
   *   - pty-wrap: Not implemented in MVP — yields an error message and returns.
   *
   * Errors from the provider are converted to NormalizedMessage{role:'system'}
   * entries and yielded rather than thrown, so callers can handle them inline.
   */
  async *sendTo(provider: ProviderId, message: string): AsyncIterable<NormalizedMessage> {
    devLog('hub.send.start', { provider, promptLength: message.length });
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      devLog('hub.send.no_adapter', { provider });
      yield makeErrorMessage(`No adapter registered for provider '${provider}'`);
      return;
    }

    // Append user message to shared history.
    const userMsg: NormalizedMessage = {
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    };
    this.state.history.push(userMsg);

    // Compose the up-to-date system prompt for this provider.
    const systemPrompt = this.state.systemPrompt.build(provider);

    if (adapter.lifecycle === 'pty-wrap') {
      yield makeErrorMessage(
        `Provider '${provider}' uses pty-wrap lifecycle which is not yet implemented in MVP`
      );
      return;
    }

    try {
      const session = await this.acquireSession(adapter, systemPrompt);
      const assistantChunks: NormalizedMessage[] = [];
      this.inFlightSessions.set(provider, session);
      devLog('hub.session.acquired', {
        provider,
        lifecycle: adapter.lifecycle,
        sessionId: session.id,
        model: this.state.modelOverrides.get(provider),
      });

      try {
        for await (const chunk of session.send(message)) {
          assistantChunks.push(chunk);
          devLog('hub.send.chunk', {
            provider,
            role: chunk.role,
            contentLength:
              typeof chunk.content === 'string'
                ? chunk.content.length
                : JSON.stringify(chunk.content).length,
          });
          yield chunk;
        }
      } finally {
        const stillInFlight = this.inFlightSessions.get(provider) === session;
        if (adapter.lifecycle === 'per-turn-resume') {
          // Store thread ID for the next turn, then tear down the transient session.
          if (stillInFlight && session.id) {
            this.state.lastThreadIds.set(provider, session.id);
            devLog('hub.thread.stored', { provider, sessionId: session.id });
          }
          await session.close();
        }
        if (stillInFlight) {
          this.inFlightSessions.delete(provider);
        }
        // For persistent-bidirectional, the session stays in activeSessions.
      }

      // Append the full assistant response(s) to history.
      for (const chunk of assistantChunks) {
        this.state.history.push(chunk);
      }
      devLog('hub.send.done', { provider, chunks: assistantChunks.length });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      devLog('hub.send.error', { provider, error: msg });
      const errMsg = makeErrorMessage(`Provider '${provider}' failed: ${msg}`);
      this.state.history.push(errMsg);
      yield errMsg;
    }
  }

  /**
   * Cancel an active provider turn, closing the current session/process and
   * clearing any resume pointer that may otherwise point at a partial turn.
   */
  async cancelProvider(provider: ProviderId): Promise<void> {
    const inFlight = this.inFlightSessions.get(provider);
    const active = this.state.activeSessions.get(provider);
    const session = inFlight ?? active;

    if (!session) {
      devLog('hub.cancel.no_session', { provider });
      return;
    }

    devLog('hub.cancel.start', { provider, sessionId: session.id });
    this.inFlightSessions.delete(provider);
    this.state.activeSessions.delete(provider);
    this.state.lastThreadIds.delete(provider);

    try {
      await session.close();
      devLog('hub.cancel.done', { provider, sessionId: session.id });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      devLog('hub.cancel.error', { provider, sessionId: session.id, error: msg });
      throw err;
    }
  }

  /** Cancel multiple provider turns concurrently. */
  async cancelProviders(providers: ProviderId[]): Promise<void> {
    await Promise.all([...new Set(providers)].map((provider) => this.cancelProvider(provider)));
  }

  // -------------------------------------------------------------------------
  // Cross-provider patterns
  // -------------------------------------------------------------------------

  /**
   * Sends the same `message` to all specified providers concurrently.
   * Returns a Map keyed by ProviderId with the collected response messages.
   * Provider failures are captured as error messages in the corresponding list.
   */
  async parallelConsensus(
    message: string,
    providers: ProviderId[]
  ): Promise<Map<ProviderId, NormalizedMessage[]>> {
    const results = new Map<ProviderId, NormalizedMessage[]>();

    await Promise.all(
      providers.map(async (provider) => {
        const collected: NormalizedMessage[] = [];
        try {
          for await (const msg of this.sendTo(provider, message)) {
            collected.push(msg);
          }
        } catch (err: unknown) {
          const errText = err instanceof Error ? err.message : String(err);
          collected.push(makeErrorMessage(`parallelConsensus[${provider}] error: ${errText}`));
        }
        results.set(provider, collected);
      })
    );

    return results;
  }

  /**
   * Executes a series of provider/prompt steps sequentially.
   * Each step yields its messages tagged with the provider that produced them.
   * Errors in a step are yielded as system messages; subsequent steps still run.
   */
  async *sequentialHandoff(
    steps: Array<{ provider: ProviderId; prompt: string }>
  ): AsyncIterable<{ provider: ProviderId; message: NormalizedMessage }> {
    for (const step of steps) {
      try {
        for await (const msg of this.sendTo(step.provider, step.prompt)) {
          yield { provider: step.provider, message: msg };
        }
      } catch (err: unknown) {
        const errText = err instanceof Error ? err.message : String(err);
        yield {
          provider: step.provider,
          message: makeErrorMessage(`sequentialHandoff[${step.provider}] error: ${errText}`),
        };
      }
    }
  }

  /**
   * Tries providers in order until one succeeds.
   * A provider is considered to have "failed" if its response is empty or if
   * the first message has role === 'system' (i.e. an error message from sendTo).
   * On failure it moves on to the next provider in the list.
   * If all providers fail, the last error message is yielded.
   */
  async *fallbackChain(message: string, providers: ProviderId[]): AsyncIterable<NormalizedMessage> {
    let lastError: NormalizedMessage | null = null;

    for (const provider of providers) {
      const collected: NormalizedMessage[] = [];
      let failed = false;

      try {
        for await (const msg of this.sendTo(provider, message)) {
          collected.push(msg);
        }
      } catch {
        failed = true;
      }

      // Determine whether this attempt counts as a failure.
      const firstMsg = collected[0];
      if (failed || collected.length === 0 || (firstMsg && firstMsg.role === 'system')) {
        lastError =
          firstMsg ??
          makeErrorMessage(`fallbackChain: provider '${provider}' returned no response`);
        continue;
      }

      // Success — yield all collected messages.
      for (const msg of collected) {
        yield msg;
      }
      return;
    }

    // All providers failed.
    yield lastError ?? makeErrorMessage('fallbackChain: all providers failed');
  }

  // -------------------------------------------------------------------------
  // System prompt management
  // -------------------------------------------------------------------------

  /**
   * Delegates to the internal SystemPromptEvolver.
   * `providerId` is required when `layer === 'provider'`.
   */
  appendSystemContext(layer: SystemPromptLayer, content: string, providerId?: ProviderId): void {
    this.state.systemPrompt.appendLayer(layer, content, providerId);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Writes the current session state to
   * ~/.hiddink-harness/projects/{projectId}/sessions/session-{id}.json
   */
  async saveSession(): Promise<void> {
    const sessionsDir = join(getProjectStateDir(getProjectId(this.state.cwd)), 'sessions');
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }

    const persisted: PersistedHubState = {
      sessionId: this.state.sessionId,
      cwd: this.state.cwd,
      history: this.state.history,
      systemPrompt: this.state.systemPrompt.serialize(),
      modelOverrides: Object.fromEntries(this.state.modelOverrides),
      lastThreadIds: Object.fromEntries(this.state.lastThreadIds),
    };

    const filePath = join(sessionsDir, `session-${this.state.sessionId}.json`);
    writeFileSync(filePath, JSON.stringify(persisted, null, 2), 'utf-8');
  }

  /**
   * Restores a ConversationHub from a previously saved session file.
   * Active sessions and registered adapters are NOT restored — callers must
   * re-register adapters before sending messages.
   */
  static loadSession(sessionId: string, cwd: string = process.cwd()): ConversationHub {
    const projectFilePath = join(
      getProjectStateDir(getProjectId(cwd)),
      'sessions',
      `session-${sessionId}.json`
    );
    const legacyFilePath = join(getGlobalStateDir(), 'sessions', `session-${sessionId}.json`);
    const filePath = existsSync(projectFilePath) ? projectFilePath : legacyFilePath;

    if (!existsSync(filePath)) {
      throw new Error(`Session file not found: ${projectFilePath}`);
    }

    const raw = readFileSync(filePath, 'utf-8');
    const persisted = JSON.parse(raw) as PersistedHubState;

    const hub = new ConversationHub({
      sessionId: persisted.sessionId,
      cwd: persisted.cwd ?? cwd,
    });

    hub.state.history = persisted.history ?? [];
    hub.state.systemPrompt = SystemPromptEvolver.deserialize(persisted.systemPrompt);
    hub.state.modelOverrides = new Map(
      Object.entries(persisted.modelOverrides ?? {}) as Array<[ProviderId, string]>
    );

    for (const [provider, threadId] of Object.entries(persisted.lastThreadIds ?? {})) {
      hub.state.lastThreadIds.set(provider as ProviderId, threadId);
    }

    return hub;
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /**
   * Closes all active ChatSessions.
   * Safe to call multiple times — already-closed sessions are silently skipped.
   */
  async close(): Promise<void> {
    await Promise.all(
      [...this.state.activeSessions.values(), ...this.inFlightSessions.values()].map((session) =>
        session.close().catch(() => {
          // Ignore individual close errors during bulk teardown.
        })
      )
    );
    this.state.activeSessions.clear();
    this.inFlightSessions.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Returns an existing active session for the provider, or spawns a new one.
   * For `per-turn-resume` providers a fresh session is always spawned; the
   * most-recent thread ID is forwarded as `resumeSessionId` when available.
   */
  private async acquireSession(
    adapter: ProviderAdapter,
    systemPrompt: string
  ): Promise<ChatSession> {
    const provider = adapter.id;

    if (adapter.lifecycle === 'persistent-bidirectional') {
      const existing = this.state.activeSessions.get(provider);
      if (existing) {
        return existing;
      }
      const session = await adapter.spawn({
        systemPrompt,
        cwd: this.state.cwd,
        model: this.state.modelOverrides.get(provider),
      });
      this.state.activeSessions.set(provider, session);
      return session;
    }

    // per-turn-resume: always spawn fresh, carry forward previous thread ID.
    const resumeSessionId = this.state.lastThreadIds.get(provider);
    return adapter.spawn({
      systemPrompt,
      cwd: this.state.cwd,
      resumeSessionId,
      model: this.state.modelOverrides.get(provider),
    });
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

function makeErrorMessage(text: string): NormalizedMessage {
  return {
    role: 'system',
    content: text,
    timestamp: new Date().toISOString(),
  };
}
