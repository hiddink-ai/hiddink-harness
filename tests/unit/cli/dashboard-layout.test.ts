import { describe, expect, test } from 'bun:test';
import {
  gitGraphWidth,
  graphGlyphs,
  inkSafeRows,
  parseGitGraphLine,
  shouldShowGitGraph,
} from '../../../src/cli/ui/Dashboard.js';

describe('Dashboard terminal layout', () => {
  test('keeps rendered height below terminal height to avoid Ink full-screen clears', () => {
    expect(inkSafeRows(24)).toBe(23);
    expect(inkSafeRows(1)).toBe(1);
    expect(inkSafeRows(0)).toBe(1);
  });

  test('shows git graph only on wide terminals', () => {
    expect(shouldShowGitGraph({ columns: 99, rows: 24 })).toBe(false);
    expect(shouldShowGitGraph({ columns: 100, rows: 24 })).toBe(true);
  });

  test('caps git graph width to a readable side panel', () => {
    expect(gitGraphWidth(80)).toBe(32);
    expect(gitGraphWidth(120)).toBe(42);
    expect(gitGraphWidth(200)).toBe(48);
  });

  test('converts git graph ascii into graph glyphs', () => {
    expect(graphGlyphs('* |/ \\')).toBe('● │╱ ╲');
  });

  test('parses commit text away from graph lane', () => {
    expect(parseGitGraphLine('* 010d6df fix providers')).toEqual({
      id: '●-010d6df fix providers',
      graph: '●',
      text: '010d6df fix providers',
    });
  });
});
