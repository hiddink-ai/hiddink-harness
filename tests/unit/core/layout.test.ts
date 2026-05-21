/**
 * Unit tests for layout.ts
 * Covers the error path and component source path branches.
 */

import { describe, expect, it } from 'bun:test';
import {
  getComponentPath,
  getEntryTemplateName,
  getProviderLayout,
  getTemplateSourcePath,
} from '../../../src/core/layout.js';

describe('getProviderLayout', () => {
  it('returns the claude layout by default', () => {
    const layout = getProviderLayout();
    expect(layout.rootDir).toBe('.claude');
    expect(layout.entryFile).toBe('CLAUDE.md');
  });

  it('returns correct layout for each provider', () => {
    expect(getProviderLayout('agy').rootDir).toBe('.agy');
    expect(getProviderLayout('codex').rootDir).toBe('.omx');
    expect(getProviderLayout('kimi').rootDir).toBe('.kimi');
  });

  it('throws an error for unsupported provider name', () => {
    expect(() => getProviderLayout('nonexistent-provider')).toThrow(
      'Unsupported provider layout requested: nonexistent-provider'
    );
  });

  it('is case-insensitive', () => {
    const layout = getProviderLayout('CLAUDE');
    expect(layout.rootDir).toBe('.claude');
  });
});

describe('getEntryTemplateName', () => {
  it('returns correct template name for ko locale', () => {
    expect(getEntryTemplateName('claude', 'ko')).toBe('CLAUDE.md.ko');
  });

  it('returns correct template name for en locale', () => {
    expect(getEntryTemplateName('claude', 'en')).toBe('CLAUDE.md.en');
  });
});

describe('getComponentPath', () => {
  it('returns entry file path for entry-md', () => {
    expect(getComponentPath('entry-md')).toBe('CLAUDE.md');
  });

  it('returns "guides" for guides component', () => {
    expect(getComponentPath('guides')).toBe('guides');
  });

  it('returns provider-prefixed path for other components', () => {
    expect(getComponentPath('rules')).toBe('.claude/rules');
    expect(getComponentPath('agents')).toBe('.claude/agents');
    expect(getComponentPath('skills')).toBe('.claude/skills');
  });
});

describe('getTemplateSourcePath', () => {
  it('returns "entry-md" for entry-md component', () => {
    expect(getTemplateSourcePath('entry-md')).toBe('entry-md');
  });

  it('returns "guides" for guides component', () => {
    expect(getTemplateSourcePath('guides')).toBe('guides');
  });

  it('returns claude-specific prefix for claude-only components', () => {
    expect(getTemplateSourcePath('output-styles')).toBe('claude-specific/output-styles');
    expect(getTemplateSourcePath('profiles')).toBe('claude-specific/profiles');
    expect(getTemplateSourcePath('schemas')).toBe('claude-specific/schemas');
    expect(getTemplateSourcePath('config')).toBe('claude-specific/config');
  });

  it('returns component name directly for common components', () => {
    expect(getTemplateSourcePath('rules')).toBe('rules');
    expect(getTemplateSourcePath('agents')).toBe('agents');
    expect(getTemplateSourcePath('skills')).toBe('skills');
    expect(getTemplateSourcePath('hooks')).toBe('hooks');
    expect(getTemplateSourcePath('contexts')).toBe('contexts');
    expect(getTemplateSourcePath('ontology')).toBe('ontology');
  });
});
