import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const targetDir = '/Users/sangyi/workspace/projects/hiddink-harness';

async function walkAndReplace(dir: string) {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === '.venv' ||
        entry.name === 'dist'
      ) {
        continue;
      }
      await walkAndReplace(fullPath);
    } else if (entry.isFile()) {
      const isTextFile =
        entry.name.endsWith('.ts') ||
        entry.name.endsWith('.json') ||
        entry.name.endsWith('.md') ||
        entry.name.endsWith('.sh') ||
        entry.name.endsWith('.yaml') ||
        entry.name.endsWith('.yml') ||
        entry.name.endsWith('.en') ||
        entry.name.endsWith('.ko') ||
        entry.name === 'package.json' ||
        entry.name === 'CLAUDE.md' ||
        entry.name === 'README.md' ||
        entry.name === 'AGY.md' ||
        entry.name === 'CODEX.md' ||
        entry.name === 'KIMI.md';

      if (isTextFile) {
        let content = await readFile(fullPath, 'utf-8');
        let modified = false;

        // hiddink-harness ➡️ hiddink-harness
        if (content.includes('hiddink-harness')) {
          content = content.replaceAll('hiddink-harness', 'hiddink-harness');
          modified = true;
        }

        // hiddink-harness ➡️ hiddink-harness
        if (content.includes('hiddink-harness')) {
          content = content.replaceAll('hiddink-harness', 'hiddink-harness');
          modified = true;
        }

        // HIDDINK_AGENT ➡️ HIDDINK_AGENT
        if (content.includes('HIDDINK_AGENT')) {
          content = content.replaceAll('HIDDINK_AGENT', 'HIDDINK_AGENT');
          modified = true;
        }

        // .hiddinkrc.json ➡️ .hiddinkrc.json
        if (content.includes('.hiddinkrc.json')) {
          content = content.replaceAll('.hiddinkrc.json', '.hiddinkrc.json');
          modified = true;
        }

        // .hiddink.lock.json ➡️ .hiddink.lock.json
        if (content.includes('.hiddink.lock.json')) {
          content = content.replaceAll('.hiddink.lock.json', '.hiddink.lock.json');
          modified = true;
        }

        if (modified) {
          await writeFile(fullPath, content, 'utf-8');
          console.log(`Replaced matches in: ${fullPath}`);
        }
      }
    }
  }
}

async function generateProviderTemplates() {
  const templatesDir = join(targetDir, 'templates');
  const entryFiles = ['CLAUDE.md', 'CLAUDE.md.ko', 'CLAUDE.md.en'];

  const providers = [
    {
      name: 'agy',
      agentName: 'Antigravity (agy)',
      entryFile: 'AGY.md',
      dirName: '.agy',
    },
    {
      name: 'codex',
      agentName: 'GPT Codex',
      entryFile: 'CODEX.md',
      dirName: '.omx',
    },
    {
      name: 'kimi',
      agentName: 'Kimi',
      entryFile: 'KIMI.md',
      dirName: '.kimi',
    },
  ];

  for (const provider of providers) {
    for (const entry of entryFiles) {
      const srcPath = join(templatesDir, entry);
      const destName = entry.replaceAll('CLAUDE.md', provider.entryFile);
      const destPath = join(templatesDir, destName);

      try {
        let content = await readFile(srcPath, 'utf-8');

        // Replace provider specific terms
        content = content.replaceAll('Claude Code', provider.agentName);
        content = content.replaceAll('CLAUDE.md', provider.entryFile);
        content = content.replaceAll('.claude', provider.dirName);

        await writeFile(destPath, content, 'utf-8');
        console.log(`Generated: ${destPath}`);
      } catch (err: any) {
        console.error(`Failed to generate ${destName}: ${err.message}`);
      }
    }
  }
}

async function run() {
  console.log('Starting full workspace renaming...');

  // 1. 전체 디렉토리 리팩토링
  await walkAndReplace(targetDir);

  // 2. 각 프로바이더 다국어 진입점 템플릿 재생성
  await generateProviderTemplates();

  console.log('Renaming and template generation finished successfully!');
}

run().catch(console.error);
