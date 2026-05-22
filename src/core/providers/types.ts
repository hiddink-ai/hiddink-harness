/**
 * Core type definitions for multi-LLM provider integration.
 *
 * This module is the primary contract for the Hub core and all ProviderAdapters.
 * Downstream implementors (claude, codex, kimi adapters + TUI ChatPanel) depend
 * on these types — treat all exports as a stable public API.
 */

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/** Supported provider identifiers. */
export type ProviderId = 'claude' | 'codex' | 'agy' | 'kimi';

/**
 * Defines how a provider manages its subprocess lifetime.
 *
 * - `persistent-bidirectional`: One spawn per session; messages are sent
 *   interactively over stdin/stdout (claude, kimi).
 * - `per-turn-resume`: A fresh subprocess is spawned for every turn and
 *   re-attached to an existing thread via `--resume <thread_id>` (codex).
 * - `pty-wrap`: PTY-based wrapping — reserved for future interactive wrappers.
 */
export type ProviderLifecycle = 'persistent-bidirectional' | 'per-turn-resume' | 'pty-wrap';

// ---------------------------------------------------------------------------
// Message structure
// ---------------------------------------------------------------------------

/**
 * A single content block within a message.
 * Supports multi-modal content as produced by LLM APIs.
 */
export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  /** Present for type === 'text' | 'thinking' */
  text?: string;
  /** Present for type === 'tool_use' */
  toolName?: string;
  /** Present for type === 'tool_use' */
  toolInput?: unknown;
  /** Present for type === 'tool_result' */
  toolOutput?: unknown;
}

/**
 * Provider-agnostic representation of a single conversation turn.
 * Adapters MUST normalize all provider-specific payloads into this shape.
 */
export interface NormalizedMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** Plain string for simple messages; ContentBlock[] for structured/multi-modal. */
  content: string | ContentBlock[];
  /** ISO 8601 timestamp of when the message was produced or received. */
  timestamp: string;
  /** Raw provider-specific metadata — preserved for debugging; never relied on by Hub logic. */
  providerMeta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Options passed to ProviderAdapter.spawn().
 * The Hub pre-composes the system prompt from the SystemPromptEvolver before
 * calling spawn, so adapters receive a single opaque string.
 */
export interface SpawnOptions {
  /** Fully-composed system prompt from the Hub's SystemPromptEvolver. */
  systemPrompt: string;
  /** Working directory for the spawned subprocess. */
  cwd: string;
  /**
   * When set, the adapter should resume an existing conversation thread
   * rather than starting a new one (e.g. `codex --resume <id>`).
   */
  resumeSessionId?: string;
  /** Controls subprocess permission level. Defaults to adapter implementation's choice. */
  permissionMode?: 'bypass' | 'sandbox' | 'plan';
  /** Explicit tool allowlist forwarded to the provider when supported. */
  allowedTools?: string[];
  /** Optional model override; if absent, the adapter uses its configured default. */
  model?: string;
}

/**
 * An active conversation session with a specific provider.
 * For `persistent-bidirectional` providers the session object remains alive
 * across multiple turns. For `per-turn-resume` providers it is closed after
 * a single exchange.
 */
export interface ChatSession {
  /** Unique session identifier (used as thread ID for resume-capable providers). */
  readonly id: string;
  /** Which provider backs this session. */
  readonly provider: ProviderId;
  /**
   * Send a user message and receive the streaming assistant response.
   * Each yielded NormalizedMessage may be a partial chunk (streaming) or a
   * complete message depending on the provider's capabilities.
   */
  send(message: string): AsyncIterable<NormalizedMessage>;
  /**
   * Terminate the session and release all associated resources.
   * Idempotent — calling close() on an already-closed session is a no-op.
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

/**
 * The primary integration point for each LLM provider backend.
 *
 * Adapter implementations MUST NOT be aware of conversation history or
 * system prompt construction — those are the Hub's sole responsibility.
 * Adapters are pure I/O bridges between the Hub and provider CLIs/APIs.
 */
export interface ProviderAdapter {
  /** Must match the ProviderId for which this adapter is registered. */
  readonly id: ProviderId;
  /**
   * Subprocess lifecycle strategy this adapter uses.
   * The Hub uses this field to decide session management behaviour in sendTo().
   */
  readonly lifecycle: ProviderLifecycle;
  /**
   * Returns true if the provider's required binary/runtime is available on PATH.
   * Hub calls this before routing to avoid spawning non-functional adapters.
   */
  isAvailable(): Promise<boolean>;
  /**
   * Spawn a new ChatSession.
   * For `per-turn-resume` providers this creates a lightweight transient session
   * that the Hub will close after collecting the response.
   */
  spawn(opts: SpawnOptions): Promise<ChatSession>;
}
