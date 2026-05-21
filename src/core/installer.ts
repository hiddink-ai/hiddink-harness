/**
 * Installer module for Hiddink Harness - Installs/deploys templates dynamically
 */

import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  readdir,
  rename,
  stat,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  copyDirectory,
  copyFile,
  ensureDirectory,
  fileExists,
  getPackageRoot,
  readJsonFile,
  resolveTemplatePath,
  writeJsonFile,
} from '../utils/fs.js';
import { debug, error, info, success, warn } from '../utils/logger.js';
import { installCodex, isCodexInstalled } from './codex-installer.js';
import { loadConfig, saveConfig } from './config.js';
import {
  cleanupPreservation,
  extractCriticalFiles,
  type PreservationResult,
  restoreCriticalFiles,
} from './file-preservation.js';
import {
  detectGitWorkflow,
  getDefaultWorkflow,
  renderGitWorkflowEN,
  renderGitWorkflowKO,
} from './git-workflow.js';
import {
  getComponentPath,
  getEntryTemplateName,
  getProviderLayout,
  getTemplateSourcePath,
  type InstallComponent,
} from './layout.js';
import { generateAndWriteLockfileForDir } from './lockfile.js';
import { installRtk, isRtkInstalled } from './rtk-installer.js';
import {
  getAgentDomain,
  getSkillScope,
  shouldInstallAgent,
  shouldInstallSkill,
} from './scope-filter.js';

/**
 * Options for installation
 */
export interface InstallOptions {
  /** Target directory to install to */
  targetDir: string;
  /** Language override (en or ko, etc.) */
  language?: string;
  /** Whether to overwrite existing files */
  force?: boolean;
  /** Whether to backup existing files before overwriting */
  backup?: boolean;
  /** Specific components to install (default: all) */
  components?: InstallComponent[];
  /** Skip confirmation prompts */
  skipConfirm?: boolean;
  /** Install only agents whose domain matches this filter */
  domain?: string;
  /** Explicitly target a single provider instead of all active ones */
  provider?: string;
}

/**
 * Result of installation
 */
export interface InstallResult {
  /** Whether installation was successful */
  success: boolean;
  /** Path to installed directory */
  installedPath: string;
  /** List of installed components */
  installedComponents: InstallComponent[];
  /** List of skipped components (already exist) */
  skippedComponents: InstallComponent[];
  /** List of backed up paths */
  backedUpPaths: string[];
  /** Any warnings during installation */
  warnings: string[];
  /** Error message if failed */
  error?: string;
}

/**
 * Template manifest describing available templates
 */
export interface TemplateManifest {
  /** Version of the templates */
  version: string;
  /** Last updated timestamp */
  lastUpdated: string;
  /** Available components */
  components: {
    name: InstallComponent;
    path: string;
    description: string;
    files: number;
  }[];
  /** Source repository */
  source: string;
}

const DEFAULT_LANGUAGE = 'en';

/**
 * Get the template directory path from the installed package
 */
export function getTemplateDir(): string {
  const packageRoot = getPackageRoot();
  return join(packageRoot, 'templates');
}

/**
 * Initialize result object for installation
 */
function createInstallResult(targetDir: string): InstallResult {
  return {
    success: false,
    installedPath: targetDir,
    installedComponents: [],
    skippedComponents: [],
    backedUpPaths: [],
    warnings: [],
  };
}

/**
 * Ensure target directory exists
 */
async function ensureTargetDirectory(targetDir: string): Promise<void> {
  const targetExists = await fileExists(targetDir);
  if (!targetExists) {
    await ensureDirectory(targetDir);
  }
}

/**
 * Handle backup of existing provider installation
 */
async function handleBackup(
  targetDir: string,
  provider: string,
  shouldBackup: boolean,
  result: InstallResult
): Promise<PreservationResult | null> {
  if (!shouldBackup) return null;

  const layout = getProviderLayout(provider);
  const rootDir = join(targetDir, layout.rootDir);

  let preservation: PreservationResult | null = null;
  if (await fileExists(rootDir)) {
    const { createTempDir } = await import('../utils/fs.js');
    const tempDir = await createTempDir(`hiddink-harness-preserve-${provider}-`);
    preservation = await extractCriticalFiles(rootDir, tempDir);

    if (preservation.extractedFiles.length > 0 || preservation.extractedDirs.length > 0) {
      info('install.preserved', {
        files: String(preservation.extractedFiles.length),
        dirs: String(preservation.extractedDirs.length),
        provider,
      });
    }
  }

  const backupPaths = await backupExistingInstallation(targetDir, provider);
  result.backedUpPaths.push(...backupPaths);
  if (backupPaths.length > 0) {
    info('install.backup', { path: backupPaths[0], provider });
  }

  return preservation;
}

/**
 * Check for existing files and add warnings
 */
async function checkAndWarnExisting(
  targetDir: string,
  provider: string,
  force: boolean,
  backup: boolean,
  result: InstallResult
): Promise<void> {
  if (force || backup) return;

  const existingPaths = await checkExistingPaths(targetDir, provider);
  if (existingPaths.length > 0) {
    const layout = getProviderLayout(provider);
    warn('install.exists', { rootDir: layout.rootDir, provider });
    result.warnings.push(
      `[${provider}] Existing files found: ${existingPaths.join(', ')}. Use --force or --backup.`
    );
  }
}

/**
 * Verify template directory exists
 */
async function verifyTemplateDirectory(): Promise<void> {
  const templateDir = getTemplateDir();
  if (!(await fileExists(templateDir))) {
    throw new Error(`Template directory not found: ${templateDir}`);
  }
}

/**
 * Install statusline.sh to the target directory (Claude-only)
 */
async function installStatusline(
  targetDir: string,
  provider: string,
  options: InstallOptions
): Promise<void> {
  if (provider !== 'claude') return; // Only Claude Code supports shell statusline script

  const layout = getProviderLayout(provider);
  // statusline.sh now lives at templates/statusline.sh (flattened from templates/.claude/)
  const srcPath = resolveTemplatePath('statusline.sh');
  const destPath = join(targetDir, layout.rootDir, 'statusline.sh');

  if (!(await fileExists(srcPath))) {
    debug('install.statusline_not_found', { path: srcPath });
    return;
  }

  if (await fileExists(destPath)) {
    if (!options.force && !options.backup) {
      debug('install.statusline_skipped', { reason: 'exists' });
      return;
    }
  }

  await copyFile(srcPath, destPath);

  const fs = await import('node:fs/promises');
  await fs.chmod(destPath, 0o755);

  debug('install.statusline_installed', {});
}

/**
 * Create settings.local.json with statusLine config (Claude-only)
 */
async function installSettingsLocal(
  targetDir: string,
  provider: string,
  result: InstallResult
): Promise<void> {
  if (provider !== 'claude') return;

  const layout = getProviderLayout(provider);
  const settingsPath = join(targetDir, layout.rootDir, 'settings.local.json');

  const statusLineConfig = {
    statusLine: {
      type: 'command' as const,
      command: '.claude/statusline.sh',
      padding: 0,
      refreshInterval: 10,
    },
  };

  if (await fileExists(settingsPath)) {
    try {
      const existing = await readJsonFile<Record<string, any>>(settingsPath);
      if (!existing.statusLine) {
        existing.statusLine = statusLineConfig.statusLine;
        await writeJsonFile(settingsPath, existing);
        debug('install.settings_local_merged', {});
      } else if (typeof existing.statusLine === 'object' && existing.statusLine !== null) {
        let modified = false;
        const target = existing.statusLine;
        for (const [key, val] of Object.entries(statusLineConfig.statusLine)) {
          if (target[key] === undefined) {
            target[key] = val;
            modified = true;
          }
        }
        if (modified) {
          await writeJsonFile(settingsPath, existing);
          debug('install.settings_local_backfilled', {});
        }
      }
    } catch {
      result.warnings.push(
        'Failed to parse existing settings.local.json, skipping statusLine config'
      );
    }
    return;
  }

  await writeJsonFile(settingsPath, statusLineConfig);
  debug('install.settings_local_created', {});
}

/**
 * Dynamically generate plugin.json manifest for agy provider
 */
async function installAgyPluginManifest(targetDir: string, provider: string): Promise<void> {
  if (provider !== 'agy') return;

  const layout = getProviderLayout(provider);
  const destPath = join(targetDir, layout.rootDir, layout.manifestFile);

  const manifest = {
    id: 'hiddink-harness-harness',
    name: 'Hiddink Harness for Antigravity',
    version: '0.0.2',
    description:
      'Universal Agent Harness for managing custom agents, skills, and rules on agy runtime.',
    entry: 'AGY.md',
    runtime: {
      provider: 'agy',
      language: 'ko',
    },
    capabilities: {
      skills: [
        {
          name: 'custom-agent-builder',
          description: 'Dynamic specialist agent creation and assembly skill',
          path: '.agy/skills/custom-agent-builder',
        },
      ],
      rules: '.agy/rules/',
      hooks: '.agy/hooks/',
      mcpServers: [],
    },
  };

  await writeJsonFile(destPath, manifest);
  debug('install.agy_plugin_manifest_created', { path: destPath });
}

/**
 * Install entry doc and track result
 */
async function installEntryDocWithTracking(
  targetDir: string,
  provider: string,
  options: InstallOptions,
  language: string,
  result: InstallResult
): Promise<void> {
  const overwrite = !!(options.force || options.backup);
  const installed = await installEntryDoc(targetDir, provider, language, overwrite);

  if (installed) {
    result.installedComponents.push('entry-md');
  } else {
    result.skippedComponents.push('entry-md');
  }
}

/**
 * Single provider installer logic
 */
async function installForProvider(
  targetDir: string,
  provider: string,
  options: InstallOptions,
  language: string,
  result: InstallResult
): Promise<void> {
  info('install.provider_start', { provider, targetDir });

  const preservation = await handleBackup(targetDir, provider, !!options.backup, result);
  await checkAndWarnExisting(targetDir, provider, !!options.force, !!options.backup, result);
  await createDirectoryStructure(targetDir, provider);

  const components = options.components || getAllComponents();
  for (const component of components) {
    try {
      const installed = await installComponent(targetDir, provider, component, options);
      if (installed) {
        result.installedComponents.push(component);
      } else {
        result.skippedComponents.push(component);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.warnings.push(`[${provider}] Failed to install ${component}: ${message}`);
    }
  }

  // Provider-specific auxiliary files
  await installStatusline(targetDir, provider, options);
  await installSettingsLocal(targetDir, provider, result);
  await installAgyPluginManifest(targetDir, provider);
  await installEntryDocWithTracking(targetDir, provider, options, language, result);

  // Restore preserved user files
  if (preservation) {
    const layout = getProviderLayout(provider);
    const rootDir = join(targetDir, layout.rootDir);
    const restoration = await restoreCriticalFiles(rootDir, preservation);

    if (restoration.restoredFiles.length > 0 || restoration.restoredDirs.length > 0) {
      info('install.restored', {
        files: String(restoration.restoredFiles.length),
        dirs: String(restoration.restoredDirs.length),
        provider,
      });
    }

    if (restoration.failures.length > 0) {
      for (const failure of restoration.failures) {
        result.warnings.push(`[${provider}] Failed to restore ${failure.path}: ${failure.reason}`);
      }
    }

    await cleanupPreservation(preservation.tempDir);
  }
}

/**
 * Install RTK if not already installed and record warnings on failure
 */
function installRtkIfNeeded(result: InstallResult): void {
  if (!isRtkInstalled()) {
    info('install.rtk_not_found', {});
    const installed = installRtk();
    if (!installed) {
      result.warnings.push('RTK installation failed');
      warn('install.rtk_failed', {});
    } else {
      success('install.rtk_success');
    }
  }
}

/**
 * Install Codex CLI if not already installed and record warnings on failure
 */
function installCodexIfNeeded(result: InstallResult): void {
  if (!isCodexInstalled()) {
    info('install.codex_not_found', {});
    const installed = installCodex();
    if (!installed) {
      result.warnings.push('Codex CLI installation failed');
      warn('install.codex_failed', {});
    } else {
      success('install.codex_success');
    }
  }
}

/**
 * Main install entry point - Installs templates into active providers
 */
export async function install(options: InstallOptions): Promise<InstallResult> {
  const result = createInstallResult(options.targetDir);

  try {
    info('install.start', { targetDir: options.targetDir });

    await ensureTargetDirectory(options.targetDir);
    await verifyTemplateDirectory();

    // Load config and local override settings to determine active providers and language
    const config = await loadConfig(options.targetDir);
    const language = options.language ?? config.language ?? DEFAULT_LANGUAGE;

    // Choose active providers: either options override or config-registered
    const activeProviders = options.provider
      ? [options.provider]
      : config.activeProviders && config.activeProviders.length > 0
        ? config.activeProviders
        : ['claude', 'agy'];

    info('install.active_providers', { providers: activeProviders.join(', '), language });

    // Loop and install for each provider
    for (const provider of activeProviders) {
      await installForProvider(options.targetDir, provider, options, language, result);
    }

    // Generate lockfile for three-way merge support
    const lockfileResult = await generateAndWriteLockfileForDir(options.targetDir);
    if (lockfileResult.warning) {
      result.warnings.push(lockfileResult.warning);
      warn('install.lockfile_failed', { error: lockfileResult.warning });
    } else {
      info('install.lockfile_generated', { files: String(lockfileResult.fileCount) });
    }

    // Save/update config version to match manifest version
    const manifest = await getTemplateManifest();
    config.version = manifest.version;
    config.installedComponents = result.installedComponents;
    config.componentVersions = config.componentVersions || {};
    for (const comp of result.installedComponents) {
      if (comp !== 'entry-md') {
        config.componentVersions[comp] = manifest.version;
      }
    }
    await saveConfig(options.targetDir, config);

    installRtkIfNeeded(result);
    installCodexIfNeeded(result);

    result.success = true;
    success('install.success');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.error = message;
    error('install.failed', { error: message });
  }

  return result;
}

/**
 * Copy templates from package to target directory
 */
export async function copyTemplates(
  targetDir: string,
  templatePath: string,
  options?: { overwrite?: boolean; preserveSymlinks?: boolean }
): Promise<void> {
  const srcPath = resolveTemplatePath(templatePath);
  const destPath = join(targetDir, templatePath);

  await copyDirectory(srcPath, destPath, {
    overwrite: options?.overwrite ?? false,
    preserveSymlinks: options?.preserveSymlinks ?? true,
    preserveTimestamps: true,
  });
}

/**
 * Create the directory structure for a specific provider
 */
export async function createDirectoryStructure(targetDir: string, provider: string): Promise<void> {
  const layout = getProviderLayout(provider);
  for (const dir of layout.directoryStructure) {
    const fullPath = join(targetDir, dir);
    await ensureDirectory(fullPath);
  }
}

/**
 * Get the template manifest (Claude-centric by layout specification defaults)
 */
export async function getTemplateManifest(provider = 'claude'): Promise<TemplateManifest> {
  const packageRoot = getPackageRoot();
  const layout = getProviderLayout(provider);
  const manifestPath = join(packageRoot, 'templates', layout.manifestFile);

  if (await fileExists(manifestPath)) {
    return readJsonFile<TemplateManifest>(manifestPath);
  }

  return {
    version: '0.0.0',
    lastUpdated: new Date().toISOString(),
    components: getAllComponents().map((name) => ({
      name,
      path: getComponentPath(name, provider),
      description: `${name} component`,
      files: 0,
    })),
    source: 'https://github.com/hiddink-ai/hiddink-harness',
  };
}

/**
 * Get all available components
 */
function getAllComponents(): InstallComponent[] {
  return ['rules', 'agents', 'skills', 'guides', 'hooks', 'contexts', 'ontology'];
}

/**
 * Install skills directory with scope-based filtering
 */
async function installSkillsWithScopeFilter(
  srcPath: string,
  destPath: string,
  options: InstallOptions
): Promise<void> {
  await ensureDirectory(destPath);
  const entries = await readdir(srcPath);

  for (const entry of entries) {
    const entrySrcPath = join(srcPath, entry);
    const isDir = (await stat(entrySrcPath)).isDirectory();
    if (!isDir) {
      continue;
    }

    const skillMdPath = join(entrySrcPath, 'SKILL.md');
    const hasSkillMd = await fileExists(skillMdPath);
    if (hasSkillMd) {
      const content = await fsReadFile(skillMdPath, 'utf-8');
      const scope = getSkillScope(content);
      const shouldInstall = shouldInstallSkill(scope);
      if (!shouldInstall) {
        debug('install.skill_scope_excluded', { skill: entry, scope });
        continue;
      }
    }

    await copyDirectory(entrySrcPath, join(destPath, entry), {
      overwrite: !!(options.force || options.backup),
      preserveSymlinks: true,
      preserveTimestamps: true,
    });
  }
}

/**
 * Install agents directory with domain-based filtering
 */
async function installAgentsWithDomainFilter(
  srcPath: string,
  destPath: string,
  options: InstallOptions
): Promise<void> {
  await ensureDirectory(destPath);
  const entries = await readdir(srcPath);

  for (const entry of entries) {
    const entrySrcPath = join(srcPath, entry);
    const entryStat = await stat(entrySrcPath);

    if (entryStat.isDirectory()) {
      await copyDirectory(entrySrcPath, join(destPath, entry), {
        overwrite: !!(options.force || options.backup),
        preserveSymlinks: true,
        preserveTimestamps: true,
      });
      continue;
    }

    if (!entry.endsWith('.md')) continue;

    if (options.domain) {
      const content = await fsReadFile(entrySrcPath, 'utf-8');
      const agentDomain = getAgentDomain(content);
      if (!shouldInstallAgent(agentDomain, options.domain)) {
        debug('install.agent_domain_excluded', { agent: entry, domain: agentDomain });
        continue;
      }
    }

    await copyFile(entrySrcPath, join(destPath, entry));
  }
}

/**
 * Install a single component under SSOT
 */
async function installComponent(
  targetDir: string,
  provider: string,
  component: InstallComponent,
  options: InstallOptions
): Promise<boolean> {
  if (component === 'entry-md') {
    return false;
  }

  // Get localized path inside the provider structure
  const templatePath = getComponentPath(component, provider);
  const destPath = join(targetDir, templatePath);
  const destExists = await fileExists(destPath);

  let isAlreadyInstalled = destExists;
  if (destExists) {
    const destStat = await stat(destPath);
    if (destStat.isDirectory()) {
      const files = await readdir(destPath);
      isAlreadyInstalled = files.length > 0;
    }
  }

  if (isAlreadyInstalled && !options.force && !options.backup) {
    debug('install.component_skipped', { component, provider });
    return false;
  }

  // SSOT: Templates are sourced from the flattened templates/ root, not the provider-specific .claude/ path.
  // Common components live at templates/<component>/, claude-specific at templates/claude-specific/<component>/.
  const unifiedSourcePath = getTemplateSourcePath(component);
  const srcPath = resolveTemplatePath(unifiedSourcePath);

  if (!(await fileExists(srcPath))) {
    warn('install.template_not_found', { component, path: srcPath });
    return false;
  }

  if (component === 'skills') {
    await installSkillsWithScopeFilter(srcPath, destPath, options);
  } else if (component === 'agents') {
    await installAgentsWithDomainFilter(srcPath, destPath, options);
  } else {
    await copyDirectory(srcPath, destPath, {
      overwrite: !!(options.force || options.backup),
      preserveSymlinks: true,
      preserveTimestamps: true,
    });
  }
  debug('install.component_installed', { component, provider });
  return true;
}

const GIT_WORKFLOW_PLACEHOLDER = '<!-- hiddink-harness:git-workflow -->';

function renderGitWorkflowSection(targetDir: string, language: string): string {
  const result = detectGitWorkflow(targetDir) ?? getDefaultWorkflow();
  return language === 'ko' ? renderGitWorkflowKO(result) : renderGitWorkflowEN(result);
}

/**
 * Install entry doc (CLAUDE.md, AGY.md, etc.) with localized rendering
 */
async function installEntryDoc(
  targetDir: string,
  provider: string,
  language: string,
  overwrite = false
): Promise<boolean> {
  const layout = getProviderLayout(provider);
  // Get template name like CLAUDE.md.ko or AGY.md.ko.
  // Fallback to CLAUDE.md.ko if provider-specific doc template doesn't exist
  let templateFile = getEntryTemplateName(provider, language);
  let srcPath = resolveTemplatePath(templateFile);

  if (!(await fileExists(srcPath))) {
    // Try en fallback
    templateFile = getEntryTemplateName(provider, 'en');
    srcPath = resolveTemplatePath(templateFile);
    if (!(await fileExists(srcPath))) {
      // Fallback to claude-centric template
      templateFile = getEntryTemplateName('claude', language);
      srcPath = resolveTemplatePath(templateFile);
    }
  }

  const destPath = join(targetDir, layout.entryFile);

  if (!(await fileExists(srcPath))) {
    warn('install.entry_md_not_found', { language, path: srcPath, entry: layout.entryFile });
    return false;
  }

  const destExists = await fileExists(destPath);
  if (destExists && !overwrite) {
    debug('install.entry_md_skipped', { reason: 'exists', language, entry: layout.entryFile });
    return false;
  }

  let content = await fsReadFile(srcPath, 'utf-8');

  // Replace file content placeholders appropriately
  if (content.includes(GIT_WORKFLOW_PLACEHOLDER)) {
    const workflowSection = renderGitWorkflowSection(targetDir, language);
    content = content.replace(GIT_WORKFLOW_PLACEHOLDER, workflowSection);
  }

  // String replacement for specific provider references
  if (provider === 'agy') {
    content = content.replaceAll('Claude Code', 'Antigravity (agy)');
    content = content.replaceAll('CLAUDE.md', 'AGY.md');
    content = content.replaceAll('.claude', '.agy');
  } else if (provider === 'codex') {
    content = content.replaceAll('Claude Code', 'GPT Codex');
    content = content.replaceAll('CLAUDE.md', 'CODEX.md');
    content = content.replaceAll('.claude', '.omx');
  } else if (provider === 'kimi') {
    content = content.replaceAll('Claude Code', 'Kimi');
    content = content.replaceAll('CLAUDE.md', 'KIMI.md');
    content = content.replaceAll('.claude', '.kimi');
  }

  await fsWriteFile(destPath, content, 'utf-8');
  debug('install.entry_md_installed', { language, entry: layout.entryFile, provider });
  return true;
}

/**
 * Backup existing directory or file
 */
async function backupExisting(sourcePath: string, backupDir: string): Promise<string> {
  const name = basename(sourcePath);
  const backupPath = join(backupDir, name);

  await rename(sourcePath, backupPath);
  return backupPath;
}

/**
 * Check which installation paths already exist
 */
async function checkExistingPaths(targetDir: string, provider: string): Promise<string[]> {
  const layout = getProviderLayout(provider);
  const pathsToCheck = [layout.entryFile, layout.rootDir];

  const existingPaths: string[] = [];

  for (const relativePath of pathsToCheck) {
    const fullPath = join(targetDir, relativePath);
    if (await fileExists(fullPath)) {
      existingPaths.push(relativePath);
    }
  }

  return existingPaths;
}

/**
 * Backup existing installation files to a timestamped directory
 */
async function backupExistingInstallation(targetDir: string, provider: string): Promise<string[]> {
  const layout = getProviderLayout(provider);
  const existingPaths = await checkExistingPaths(targetDir, provider);

  if (existingPaths.length === 0) {
    return [];
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(targetDir, `${layout.backupDirPrefix}${timestamp}`);
  await ensureDirectory(backupDir);

  const backedUpPaths: string[] = [];

  for (const relativePath of existingPaths) {
    const fullPath = join(targetDir, relativePath);
    try {
      const backupPath = await backupExisting(fullPath, backupDir);
      backedUpPaths.push(backupPath);
      debug('install.backed_up', { from: relativePath, to: backupPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn('install.backup_failed', { path: relativePath, error: message });
    }
  }

  return backedUpPaths.length > 0 ? [backupDir] : [];
}
