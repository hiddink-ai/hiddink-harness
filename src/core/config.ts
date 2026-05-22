/**
 * Configuration management module for Hiddink Harness
 */

import { dirname, join } from 'node:path';
import {
  ensureDirectory,
  fileExists,
  readJsonFile,
  validatePreserveFilePath,
  writeJsonFile,
} from '../utils/fs.js';
import { debug, warn } from '../utils/logger.js';
import { getProjectId, getProjectStateDir } from './global-state.js';

export interface HiddinkConfig {
  /** Config file version */
  configVersion: number;
  /** Package version installed */
  version: string;
  /** Shared fallback language */
  language: string;
  /** Active providers enabled in this project */
  activeProviders: string[];
  /** Installation timestamp */
  installedAt: string;
  /** Last updated timestamp */
  lastUpdated: string;
  /** Installed components */
  installedComponents: string[];
  /** Component versions */
  componentVersions?: Record<string, string>;
  /** Agent configurations */
  agents?: Record<string, AgentConfig>;
  /** User preferences */
  preferences?: UserPreferences;
  /** Source repository for updates */
  sourceRepo?: string;
  /** Auto-update settings */
  autoUpdate?: AutoUpdateConfig;
  /** Files/directories to preserve during update */
  preserveFiles?: string[];
  /** Custom components not managed by hiddink-harness */
  customComponents?: CustomComponentConfig[];
  /** Domain filter used during installation */
  domain?: string;
  /** Team mode enabled */
  teamMode?: boolean;
  /** Evaluation system configuration */
  eval?: {
    enabled: boolean;
    dbDriver: 'sqlite';
    sqlitePath: string;
    autoCollectOnStop: boolean;
  };
}

export type OmccConfig = HiddinkConfig;

/**
 * Configuration for individual agents
 */
export interface AgentConfig {
  /** Agent version */
  version: string;
  /** Source URL or "local" */
  source: string;
  /** Last updated timestamp */
  lastUpdated: string;
  /** Whether agent has local modifications */
  hasLocalModifications: boolean;
  /** Enabled status */
  enabled: boolean;
  /** Custom settings for this agent */
  settings?: Record<string, unknown>;
}

/**
 * Local-only configuration for individual developers (Git-ignored)
 */
export interface HiddinkLocalConfig {
  /** Local overrides for language (e.g. ko, en, fr, zh, es) */
  language?: string;
  /** Local overrides for active providers */
  activeProviders?: string[];
  /** Local-only preferences */
  preferences?: Partial<UserPreferences>;
}

/**
 * Custom component configuration
 */
export interface CustomComponentConfig {
  /** Type of component */
  type: 'agent' | 'skill' | 'rule' | 'guide' | 'hook' | 'context';
  /** Component name */
  name: string;
  /** Relative path from project root */
  path: string;
  /** Always false - indicates this is custom, not managed by hiddink-harness */
  managed: false;
}

/**
 * User preferences
 */
export interface UserPreferences {
  /** Default log level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Use colors in terminal output */
  colors: boolean;
  /** Show progress indicators */
  showProgress: boolean;
  /** Confirmation prompts */
  confirmPrompts: boolean;
  /** Backup before updates */
  autoBackup: boolean;
}

/**
 * Auto-update configuration
 */
export interface AutoUpdateConfig {
  /** Whether auto-update is enabled */
  enabled: boolean;
  /** Check frequency in hours */
  checkIntervalHours: number;
  /** Last check timestamp */
  lastCheck?: string;
  /** Auto-apply minor updates */
  autoApplyMinor: boolean;
  /** Components to auto-update */
  components?: string[];
}

/** Config file names */
const SHARED_CONFIG_FILE = '.hiddinkrc.json';
const LOCAL_CONFIG_FILE = '.hiddinkrc.local.json';

/** Current config version */
const CURRENT_CONFIG_VERSION = 1;

/**
 * Get the default configuration
 */
export function getDefaultConfig(): HiddinkConfig {
  return {
    configVersion: CURRENT_CONFIG_VERSION,
    version: '0.0.0',
    language: 'en',
    activeProviders: ['claude', 'agy'],
    installedAt: '',
    lastUpdated: '',
    installedComponents: [],
    componentVersions: {},
    preferences: getDefaultPreferences(),
    sourceRepo: 'https://github.com/hiddink-ai/hiddink-harness',
    autoUpdate: {
      enabled: false,
      checkIntervalHours: 24,
      autoApplyMinor: false,
    },
    preserveFiles: [
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/agent-memory/',
      '.claude/agent-memory-local/',
      '.agy/settings.json',
      '.agy/agent-memory/',
    ],
    customComponents: [],
    domain: undefined,
    teamMode: false,
  };
}

/**
 * Get default user preferences
 */
export function getDefaultPreferences(): UserPreferences {
  return {
    logLevel: 'info',
    colors: true,
    showProgress: true,
    confirmPrompts: true,
    autoBackup: true,
  };
}

/**
 * Get the path to the shared config file
 */
export function getConfigPath(targetDir: string): string {
  if (
    targetDir.includes('/tmp/') ||
    targetDir.includes('coverage/') ||
    process.env.NODE_ENV === 'test' ||
    process.env.BUN_ENV === 'test'
  ) {
    return join(targetDir, SHARED_CONFIG_FILE);
  }
  const projectId = getProjectId(targetDir);
  return join(getProjectStateDir(projectId), SHARED_CONFIG_FILE);
}

/**
 * Get the path to the local config file
 */
export function getLocalConfigPath(targetDir: string): string {
  if (
    targetDir.includes('/tmp/') ||
    targetDir.includes('coverage/') ||
    process.env.NODE_ENV === 'test' ||
    process.env.BUN_ENV === 'test'
  ) {
    return join(targetDir, LOCAL_CONFIG_FILE);
  }
  const projectId = getProjectId(targetDir);
  return join(getProjectStateDir(projectId), LOCAL_CONFIG_FILE);
}

/**
 * Load configuration from target directory, applying local overrides
 */
export async function loadConfig(targetDir: string): Promise<HiddinkConfig> {
  const configPath = getConfigPath(targetDir);
  const localPath = getLocalConfigPath(targetDir);

  let config = getDefaultConfig();

  // 1. Load shared config
  if (await fileExists(configPath)) {
    try {
      const sharedData = await readJsonFile<Partial<HiddinkConfig>>(configPath);
      config = mergeConfig(getDefaultConfig(), sharedData, targetDir);

      // Migrate version if needed
      if (config.configVersion < CURRENT_CONFIG_VERSION) {
        config = migrateConfig(config);
        await saveConfig(targetDir, config);
      }
    } catch (err) {
      warn('config.load_failed', { error: String(err) });
    }
  } else {
    debug('config.not_found', { path: configPath });
    config.version = '0.0.0';
  }

  // 2. Load and override with local preferences if exist
  if (await fileExists(localPath)) {
    try {
      const localData = await readJsonFile<HiddinkLocalConfig>(localPath);
      if (localData.language) {
        config.language = localData.language;
      }
      if (localData.activeProviders) {
        config.activeProviders = localData.activeProviders;
      }
      if (localData.preferences) {
        config.preferences = {
          ...config.preferences,
          ...localData.preferences,
        } as UserPreferences;
      }
      debug('config.local_loaded', { path: localPath });
    } catch (err) {
      warn('config.local_load_failed', { error: String(err) });
    }
  }

  return config;
}

/**
 * Save shared configuration to target directory
 */
export async function saveConfig(targetDir: string, config: HiddinkConfig): Promise<void> {
  const configPath = getConfigPath(targetDir);

  // Ensure directory exists
  await ensureDirectory(dirname(configPath));

  // Update last updated timestamp
  config.lastUpdated = new Date().toISOString();

  // Strip local properties if they somehow leaked in
  const dataToSave = { ...config };

  await writeJsonFile(configPath, dataToSave);
  debug('config.saved', { path: configPath });
}

/**
 * Save developer local overrides configuration
 */
export async function saveLocalConfig(
  targetDir: string,
  localConfig: HiddinkLocalConfig
): Promise<void> {
  const localPath = getLocalConfigPath(targetDir);
  await ensureDirectory(dirname(localPath));
  await writeJsonFile(localPath, localConfig);
  debug('config.local_saved', { path: localPath });
}

/**
 * Deduplicate custom components by path (later entries win)
 */
function deduplicateCustomComponents(components: CustomComponentConfig[]): CustomComponentConfig[] {
  const seen = new Map<string, CustomComponentConfig>();
  for (const c of components) {
    seen.set(c.path, c);
  }
  return [...seen.values()];
}

/**
 * Merge configuration with defaults
 */
export function mergeConfig(
  defaults: HiddinkConfig,
  overrides: Partial<HiddinkConfig>,
  targetDir?: string
): HiddinkConfig {
  let mergedPreserveFiles: string[] | undefined;
  if (overrides.preserveFiles) {
    const allFiles = [...new Set([...(defaults.preserveFiles || []), ...overrides.preserveFiles])];

    if (targetDir) {
      const validatedFiles: string[] = [];
      for (const filePath of allFiles) {
        const validation = validatePreserveFilePath(filePath, targetDir);
        if (validation.valid) {
          validatedFiles.push(filePath);
        } else {
          warn('config.invalid_preserve_path', {
            path: filePath,
            reason: validation.reason ?? 'Invalid path',
          });
        }
      }
      mergedPreserveFiles = validatedFiles;
    } else {
      mergedPreserveFiles = allFiles;
    }
  } else {
    mergedPreserveFiles = defaults.preserveFiles;
  }

  return {
    ...defaults,
    ...overrides,
    preferences: overrides.preferences
      ? { ...defaults.preferences, ...overrides.preferences }
      : defaults.preferences,
    autoUpdate: overrides.autoUpdate
      ? { ...defaults.autoUpdate, ...overrides.autoUpdate }
      : defaults.autoUpdate,
    componentVersions: {
      ...defaults.componentVersions,
      ...overrides.componentVersions,
    },
    agents:
      defaults.agents || overrides.agents
        ? {
            ...defaults.agents,
            ...overrides.agents,
          }
        : undefined,
    preserveFiles: mergedPreserveFiles,
    customComponents: overrides.customComponents
      ? deduplicateCustomComponents([
          ...(defaults.customComponents || []),
          ...overrides.customComponents,
        ])
      : defaults.customComponents,
  };
}

/**
 * Migrate configuration to current version
 */
function migrateConfig(config: HiddinkConfig): HiddinkConfig {
  const migrated = { ...config };

  if (config.configVersion < 1) {
    migrated.configVersion = 1;
    migrated.preferences = getDefaultPreferences();
    migrated.autoUpdate = {
      enabled: false,
      checkIntervalHours: 24,
      autoApplyMinor: false,
    };
    migrated.activeProviders = ['claude', 'agy'];
  }

  migrated.configVersion = CURRENT_CONFIG_VERSION;
  return migrated;
}

/**
 * Update specific config values in shared config
 */
export async function updateConfig(
  targetDir: string,
  updates: Partial<HiddinkConfig>
): Promise<HiddinkConfig> {
  const current = await loadConfig(targetDir);
  const updated = mergeConfig(current, updates, targetDir);
  await saveConfig(targetDir, updated);
  return updated;
}

/**
 * Get a specific config value
 */
export async function getConfigValue<K extends keyof HiddinkConfig>(
  targetDir: string,
  key: K
): Promise<HiddinkConfig[K]> {
  const config = await loadConfig(targetDir);
  return config[key];
}

/**
 * Set a specific config value in shared config
 */
export async function setConfigValue<K extends keyof HiddinkConfig>(
  targetDir: string,
  key: K,
  value: HiddinkConfig[K]
): Promise<void> {
  const config = await loadConfig(targetDir);
  config[key] = value;
  await saveConfig(targetDir, config);
}

/**
 * Check if shared config exists in target directory
 */
export async function configExists(targetDir: string): Promise<boolean> {
  const configPath = getConfigPath(targetDir);
  return fileExists(configPath);
}

/**
 * Delete config file
 */
export async function deleteConfig(targetDir: string): Promise<void> {
  const fs = await import('node:fs/promises');
  const configPath = getConfigPath(targetDir);
  const localPath = getLocalConfigPath(targetDir);

  if (await fileExists(configPath)) {
    await fs.unlink(configPath);
    debug('config.deleted', { path: configPath });
  }
  if (await fileExists(localPath)) {
    await fs.unlink(localPath);
    debug('config.local_deleted', { path: localPath });
  }
}

/**
 * Validate config structure
 */
export function validateConfig(config: unknown): config is HiddinkConfig {
  if (typeof config !== 'object' || config === null) {
    return false;
  }

  const c = config as Record<string, unknown>;

  return (
    typeof c.configVersion === 'number' &&
    typeof c.version === 'string' &&
    (c.language === 'en' || c.language === 'ko') &&
    (c.activeProviders === undefined || Array.isArray(c.activeProviders))
  );
}

/**
 * Get agent config
 */
export async function getAgentConfig(
  targetDir: string,
  agentName: string
): Promise<AgentConfig | undefined> {
  const config = await loadConfig(targetDir);
  return config.agents?.[agentName];
}

/**
 * Set agent config
 */
export async function setAgentConfig(
  targetDir: string,
  agentName: string,
  agentConfig: AgentConfig
): Promise<void> {
  const config = await loadConfig(targetDir);
  if (!config.agents) {
    config.agents = {};
  }
  config.agents[agentName] = agentConfig;
  await saveConfig(targetDir, config);
}

/**
 * Remove agent config
 */
export async function removeAgentConfig(targetDir: string, agentName: string): Promise<void> {
  const config = await loadConfig(targetDir);
  if (config.agents?.[agentName]) {
    delete config.agents[agentName];
    await saveConfig(targetDir, config);
  }
}

/**
 * Get all configured agents
 */
export async function getConfiguredAgents(targetDir: string): Promise<Record<string, AgentConfig>> {
  const config = await loadConfig(targetDir);
  return config.agents || {};
}
