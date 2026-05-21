import { describe, expect, it } from 'bun:test';
import {
  mergeEntryDoc,
  parseEntryDoc,
  wrapInManagedMarkers,
} from '../../../src/core/entry-merger.js';

describe('entry-merger', () => {
  describe('parseEntryDoc', () => {
    it('should parse document with no markers as single custom section', () => {
      const content = 'This is custom content\nNo markers here';
      const result = parseEntryDoc(content);

      expect(result.sections.length).toBe(1);
      expect(result.sections[0].type).toBe('custom');
      expect(result.sections[0].content).toBe('This is custom content\nNo markers here');
    });

    it('should parse document with one managed section', () => {
      const content = `<!-- hiddink-harness:start -->
Managed content here
<!-- hiddink-harness:end -->`;

      const result = parseEntryDoc(content);

      expect(result.sections.length).toBe(1);
      expect(result.sections[0].type).toBe('managed');
      expect(result.sections[0].content).toBe('Managed content here');
    });

    it('should parse document with custom + managed + custom sections', () => {
      const content = `Custom intro
<!-- hiddink-harness:start -->
Managed content
<!-- hiddink-harness:end -->
Custom outro`;

      const result = parseEntryDoc(content);

      expect(result.sections.length).toBe(3);
      expect(result.sections[0].type).toBe('custom');
      expect(result.sections[0].content).toBe('Custom intro');
      expect(result.sections[1].type).toBe('managed');
      expect(result.sections[1].content).toBe('Managed content');
      expect(result.sections[2].type).toBe('custom');
      expect(result.sections[2].content).toBe('Custom outro');
    });

    it('should handle empty content', () => {
      const content = '';
      const result = parseEntryDoc(content);

      // Empty content results in empty custom section
      expect(result.sections.length).toBe(1);
      expect(result.sections[0].type).toBe('custom');
      expect(result.sections[0].content).toBe('');
    });

    it('should handle multiple managed sections', () => {
      const content = `<!-- hiddink-harness:start -->
First managed section
<!-- hiddink-harness:end -->
Middle custom content
<!-- hiddink-harness:start -->
Second managed section
<!-- hiddink-harness:end -->`;

      const result = parseEntryDoc(content);

      expect(result.sections.length).toBe(3);
      expect(result.sections[0].type).toBe('managed');
      expect(result.sections[0].content).toBe('First managed section');
      expect(result.sections[1].type).toBe('custom');
      expect(result.sections[1].content).toBe('Middle custom content');
      expect(result.sections[2].type).toBe('managed');
      expect(result.sections[2].content).toBe('Second managed section');
    });

    it('should handle markers with whitespace', () => {
      const content = `   <!-- hiddink-harness:start -->
Managed with whitespace
   <!-- hiddink-harness:end -->   `;

      const result = parseEntryDoc(content);

      expect(result.sections.length).toBe(1);
      expect(result.sections[0].type).toBe('managed');
      expect(result.sections[0].content).toBe('Managed with whitespace');
    });

    it('should handle stray end marker without matching start marker', () => {
      const content = `Custom content
<!-- hiddink-harness:end -->
More custom content`;

      const result = parseEntryDoc(content);

      // Stray end marker is ignored, all content treated as custom
      expect(result.sections.length).toBe(1);
      expect(result.sections[0].type).toBe('custom');
      expect(result.sections[0].content).toContain('Custom content');
      expect(result.sections[0].content).toContain('More custom content');
    });

    it('should handle unclosed managed section', () => {
      const content = `<!-- hiddink-harness:start -->
Unclosed managed section`;

      const result = parseEntryDoc(content);

      // Unclosed section is treated as custom content
      expect(result.sections.length).toBe(1);
      expect(result.sections[0].type).toBe('custom');
      expect(result.sections[0].content).toBe('Unclosed managed section');
    });

    it('should ignore markers inside fenced code blocks with backticks', () => {
      const content = `Custom intro
\`\`\`markdown
<!-- hiddink-harness:start -->
This is example code, not a real marker
<!-- hiddink-harness:end -->
\`\`\`
Custom outro`;

      const result = parseEntryDoc(content);

      // Entire content should be treated as one custom section
      expect(result.sections.length).toBe(1);
      expect(result.sections[0].type).toBe('custom');
      expect(result.sections[0].content).toBe(content);
    });

    it('should ignore markers inside fenced code blocks with tildes', () => {
      const content = `Custom intro
~~~
<!-- hiddink-harness:start -->
Example marker inside tilde code block
<!-- hiddink-harness:end -->
~~~
Custom outro`;

      const result = parseEntryDoc(content);

      // Entire content should be treated as one custom section
      expect(result.sections.length).toBe(1);
      expect(result.sections[0].type).toBe('custom');
      expect(result.sections[0].content).toBe(content);
    });

    it('should handle markers in code blocks with language specifier', () => {
      const content = `Documentation text
\`\`\`typescript
// Showing how markers work:
<!-- hiddink-harness:start -->
<!-- hiddink-harness:end -->
\`\`\`
More documentation`;

      const result = parseEntryDoc(content);

      expect(result.sections.length).toBe(1);
      expect(result.sections[0].type).toBe('custom');
      expect(result.sections[0].content).toBe(content);
    });

    it('should detect real markers after closing code block', () => {
      const content = `\`\`\`
<!-- hiddink-harness:start -->
Fake marker in code
<!-- hiddink-harness:end -->
\`\`\`
<!-- hiddink-harness:start -->
Real managed section
<!-- hiddink-harness:end -->`;

      const result = parseEntryDoc(content);

      expect(result.sections.length).toBe(2);
      expect(result.sections[0].type).toBe('custom');
      expect(result.sections[0].content).toContain('Fake marker in code');
      expect(result.sections[1].type).toBe('managed');
      expect(result.sections[1].content).toBe('Real managed section');
    });

    it('should handle multiple code blocks', () => {
      const content = `Text
\`\`\`
<!-- hiddink-harness:start -->
\`\`\`
Middle text
\`\`\`
<!-- hiddink-harness:end -->
\`\`\`
End text`;

      const result = parseEntryDoc(content);

      // All markers are in code blocks, so all custom
      expect(result.sections.length).toBe(1);
      expect(result.sections[0].type).toBe('custom');
      expect(result.sections[0].content).toBe(content);
    });

    it('should handle nested code block scenarios', () => {
      const content = `Custom intro
<!-- hiddink-harness:start -->
Managed content with code example:
\`\`\`
<!-- This marker in code should be ignored -->
\`\`\`
More managed content
<!-- hiddink-harness:end -->
Custom outro`;

      const result = parseEntryDoc(content);

      expect(result.sections.length).toBe(3);
      expect(result.sections[0].type).toBe('custom');
      expect(result.sections[0].content).toBe('Custom intro');
      expect(result.sections[1].type).toBe('managed');
      expect(result.sections[1].content).toContain('Managed content with code example');
      expect(result.sections[2].type).toBe('custom');
      expect(result.sections[2].content).toBe('Custom outro');
    });

    it('should handle inline code with marker-like text', () => {
      const content = `Use \`<!-- hiddink-harness:start -->\` in your docs
<!-- hiddink-harness:start -->
Real managed section
<!-- hiddink-harness:end -->`;

      const result = parseEntryDoc(content);

      // Inline code is NOT fenced blocks, so real markers still work
      expect(result.sections.length).toBe(2);
      expect(result.sections[0].type).toBe('custom');
      expect(result.sections[0].content).toContain('Use `<!-- hiddink-harness:start -->`');
      expect(result.sections[1].type).toBe('managed');
      expect(result.sections[1].content).toBe('Real managed section');
    });
  });

  describe('mergeEntryDoc', () => {
    it('should wrap template when no markers exist in existing content', () => {
      const existingContent = 'Custom user content';
      const templateContent = 'Template content';

      const result = mergeEntryDoc(existingContent, templateContent);

      expect(result.content).toBe(`<!-- hiddink-harness:start -->
Template content
<!-- hiddink-harness:end -->

Custom user content`);
      expect(result.managedSections).toBe(1);
      expect(result.customSections).toBe(1);
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain('No managed sections found');
      expect(result.warnings[0]).toContain('preserved below');
    });

    it('should only wrap template when existing content is empty', () => {
      const existingContent = '';
      const templateContent = 'Template content';

      const result = mergeEntryDoc(existingContent, templateContent);

      expect(result.content).toBe(`<!-- hiddink-harness:start -->
Template content
<!-- hiddink-harness:end -->`);
      expect(result.managedSections).toBe(1);
      expect(result.customSections).toBe(0);
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain('wrapping template entirely');
    });

    it('should preserve multiline project content when no markers exist', () => {
      const existingContent = `# My Project

This is a project-specific README.
It has multiple lines of important content.

## Setup
Run \`npm install\` to get started.`;
      const templateContent = 'Template content';

      const result = mergeEntryDoc(existingContent, templateContent);

      expect(result.content).toBe(`<!-- hiddink-harness:start -->
Template content
<!-- hiddink-harness:end -->

# My Project

This is a project-specific README.
It has multiple lines of important content.

## Setup
Run \`npm install\` to get started.`);
      expect(result.managedSections).toBe(1);
      expect(result.customSections).toBe(1);
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain('preserved below');
    });

    it('should replace managed section with new template', () => {
      const existingContent = `<!-- hiddink-harness:start -->
Old template content
<!-- hiddink-harness:end -->`;
      const templateContent = 'New template content';

      const result = mergeEntryDoc(existingContent, templateContent);

      expect(result.content).toBe(`<!-- hiddink-harness:start -->
New template content
<!-- hiddink-harness:end -->`);
      expect(result.managedSections).toBe(1);
      expect(result.customSections).toBe(0);
      expect(result.warnings.length).toBe(0);
    });

    it('should preserve custom sections around managed section', () => {
      const existingContent = `Custom intro
<!-- hiddink-harness:start -->
Old template
<!-- hiddink-harness:end -->
Custom outro`;
      const templateContent = 'New template';

      const result = mergeEntryDoc(existingContent, templateContent);

      expect(result.content).toBe(`Custom intro
<!-- hiddink-harness:start -->
New template
<!-- hiddink-harness:end -->
Custom outro`);
      expect(result.managedSections).toBe(1);
      expect(result.customSections).toBe(2);
      expect(result.warnings.length).toBe(0);
    });

    it('should handle multiple custom sections', () => {
      const existingContent = `First custom
<!-- hiddink-harness:start -->
Template
<!-- hiddink-harness:end -->
Second custom
Third custom`;
      const templateContent = 'New template';

      const result = mergeEntryDoc(existingContent, templateContent);

      expect(result.content).toBe(`First custom
<!-- hiddink-harness:start -->
New template
<!-- hiddink-harness:end -->
Second custom
Third custom`);
      expect(result.managedSections).toBe(1);
      expect(result.customSections).toBe(2);
    });

    it('should warn about multiple managed sections', () => {
      const existingContent = `<!-- hiddink-harness:start -->
First managed
<!-- hiddink-harness:end -->
Custom content
<!-- hiddink-harness:start -->
Second managed
<!-- hiddink-harness:end -->`;
      const templateContent = 'New template';

      const result = mergeEntryDoc(existingContent, templateContent);

      // Only first managed section should be replaced
      expect(result.content).toBe(`<!-- hiddink-harness:start -->
New template
<!-- hiddink-harness:end -->
Custom content`);
      expect(result.managedSections).toBe(1);
      expect(result.customSections).toBe(1);
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain('Multiple managed sections found');
    });

    it('should handle empty template content', () => {
      const existingContent = `<!-- hiddink-harness:start -->
Old content
<!-- hiddink-harness:end -->`;
      const templateContent = '';

      const result = mergeEntryDoc(existingContent, templateContent);

      expect(result.content).toBe(`<!-- hiddink-harness:start -->

<!-- hiddink-harness:end -->`);
      expect(result.managedSections).toBe(1);
      expect(result.warnings.length).toBe(0);
    });

    it('should handle multiline template content', () => {
      const existingContent = `Custom intro
<!-- hiddink-harness:start -->
Old
<!-- hiddink-harness:end -->`;
      const templateContent = `Line 1
Line 2
Line 3`;

      const result = mergeEntryDoc(existingContent, templateContent);

      expect(result.content).toBe(`Custom intro
<!-- hiddink-harness:start -->
Line 1
Line 2
Line 3
<!-- hiddink-harness:end -->`);
      expect(result.managedSections).toBe(1);
      expect(result.customSections).toBe(1);
    });
  });

  describe('wrapInManagedMarkers', () => {
    it('should wrap content with start and end markers', () => {
      const content = 'Template content';
      const result = wrapInManagedMarkers(content);

      expect(result).toBe(`<!-- hiddink-harness:start -->
Template content
<!-- hiddink-harness:end -->`);
    });

    it('should handle multiline content', () => {
      const content = `Line 1
Line 2
Line 3`;
      const result = wrapInManagedMarkers(content);

      expect(result).toBe(`<!-- hiddink-harness:start -->
Line 1
Line 2
Line 3
<!-- hiddink-harness:end -->`);
    });

    it('should handle empty content', () => {
      const content = '';
      const result = wrapInManagedMarkers(content);

      expect(result).toBe(`<!-- hiddink-harness:start -->

<!-- hiddink-harness:end -->`);
    });

    it('should handle content with special characters', () => {
      const content = 'Content with <tags> and "quotes"';
      const result = wrapInManagedMarkers(content);

      expect(result).toBe(`<!-- hiddink-harness:start -->
Content with <tags> and "quotes"
<!-- hiddink-harness:end -->`);
    });
  });
});
