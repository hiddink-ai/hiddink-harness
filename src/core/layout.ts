/**
 * Layout and component mapping for Multi-Providers (Claude, agy, gpt-codex, Kimi)
 */

/**
 * Components that can be installed
 */
export type InstallComponent =
  | 'entry-md'
  | 'rules'
  | 'agents'
  | 'skills'
  | 'guides'
  | 'hooks'
  | 'contexts'
  | 'ontology'
  | 'output-styles'
  | 'profiles'
  | 'schemas'
  | 'config';

export interface ProviderLayout {
  rootDir: string;
  entryFile: string;
  entryTemplatePrefix: string;
  manifestFile: string;
  backupDirPrefix: string;
  directoryStructure: string[];
}

export const CLAUDE_LAYOUT: ProviderLayout = {
  rootDir: '.claude',
  entryFile: 'CLAUDE.md',
  entryTemplatePrefix: 'CLAUDE.md',
  manifestFile: 'manifest.json',
  backupDirPrefix: '.claude-backup-',
  directoryStructure: [
    '.claude',
    '.claude/rules',
    '.claude/hooks',
    '.claude/contexts',
    '.claude/agents',
    '.claude/skills',
    '.claude/ontology',
    'guides',
  ],
};

export const AGY_LAYOUT: ProviderLayout = {
  rootDir: '.agy',
  entryFile: 'AGY.md',
  entryTemplatePrefix: 'AGY.md',
  manifestFile: 'plugin.json',
  backupDirPrefix: '.agy-backup-',
  directoryStructure: [
    '.agy',
    '.agy/rules',
    '.agy/hooks',
    '.agy/contexts',
    '.agy/agents',
    '.agy/skills',
    '.agy/ontology',
    'guides',
  ],
};

export const CODEX_LAYOUT: ProviderLayout = {
  rootDir: '.omx',
  entryFile: 'CODEX.md',
  entryTemplatePrefix: 'CODEX.md',
  manifestFile: 'manifest.json',
  backupDirPrefix: '.omx-backup-',
  directoryStructure: [
    '.omx',
    '.omx/rules',
    '.omx/hooks',
    '.omx/contexts',
    '.omx/agents',
    '.omx/skills',
    '.omx/ontology',
    'guides',
  ],
};

export const KIMI_LAYOUT: ProviderLayout = {
  rootDir: '.kimi',
  entryFile: 'KIMI.md',
  entryTemplatePrefix: 'KIMI.md',
  manifestFile: 'manifest.json',
  backupDirPrefix: '.kimi-backup-',
  directoryStructure: [
    '.kimi',
    '.kimi/rules',
    '.kimi/hooks',
    '.kimi/contexts',
    '.kimi/agents',
    '.kimi/skills',
    '.kimi/ontology',
    'guides',
  ],
};

const LAYOUTS: Record<string, ProviderLayout> = {
  claude: CLAUDE_LAYOUT,
  agy: AGY_LAYOUT,
  codex: CODEX_LAYOUT,
  kimi: KIMI_LAYOUT,
};

/**
 * Get layout definition for a specific provider
 */
export function getProviderLayout(providerName = 'claude'): ProviderLayout {
  const layout = LAYOUTS[providerName.toLowerCase()];
  if (!layout) {
    throw new Error(`Unsupported provider layout requested: ${providerName}`);
  }
  return layout;
}

/**
 * Get localized entry template filename (e.g. CLAUDE.md.ko or AGY.md.en)
 */
export function getEntryTemplateName(providerName: string, language: string): string {
  const layout = getProviderLayout(providerName);
  return `${layout.entryTemplatePrefix}.${language}`;
}

/**
 * Get installation path for a specific component under a provider
 */
export function getComponentPath(component: InstallComponent, providerName = 'claude'): string {
  const layout = getProviderLayout(providerName);

  if (component === 'entry-md') {
    return layout.entryFile;
  }

  if (component === 'guides') {
    return 'guides';
  }

  return `${layout.rootDir}/${component}`;
}

/**
 * Source path within the templates/ directory for a component.
 * Common components live at templates/<component>/.
 * Claude-specific components live at templates/claude-specific/<component>/.
 */
export function getTemplateSourcePath(component: InstallComponent): string {
  const claudeSpecific = new Set<InstallComponent>([
    'output-styles',
    'profiles',
    'schemas',
    'config',
  ]);

  if (component === 'entry-md') {
    return 'entry-md';
  }
  if (component === 'guides') {
    return 'guides';
  }
  if (claudeSpecific.has(component)) {
    return `claude-specific/${component}`;
  }
  return component;
}
