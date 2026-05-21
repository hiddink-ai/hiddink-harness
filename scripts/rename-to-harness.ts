import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 1. 제외할 디렉토리 및 파일 정의
const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.venv',
  '.claude',
  '.agy',
  '.omx',
  '.kimi',
  'brain',
  '.gemini',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.json',
  '.sh',
  '.yml',
  '.yaml',
  '.md',
  '.html',
  '.en',
  '.ko',
  'package.json',
]);

const ROOT_DIR = '/Users/sangyi/workspace/projects/hiddink-agent';

// 2. 치환 규칙 정의
const REPLACEMENTS: [RegExp, string][] = [
  // 1. 패키지 scope 변경
  [/@hiddink-agent\//g, '@hiddink-harness/'],
  // 2. 깃허브 저장소 주소 및 깃허브 오너명 변경 (baekenough/hiddink-agent -> hiddink-ai/hiddink-harness)
  [/baekenough\/hiddink-agent/g, 'hiddink-ai/hiddink-harness'],
  // 3. 전역 홈 폴더 설정 변경
  [/\.hiddink-agent/g, '.hiddink-harness'],
  // 4. 임시 접두사 변경
  [/hiddink-agent-/g, 'hiddink-harness-'],
  // 5. 일반 단어 변경 (hiddink-agent -> hiddink-harness)
  [/hiddink-agent/g, 'hiddink-harness'],
  [/Hiddink Agent/g, 'Hiddink Harness'],
  [/HIDDINK-AGENT/g, 'HIDDINK-HARNESS'],
];

let processedFiles = 0;
let modifiedFiles = 0;

function scanAndReplace(dir: string): void {
  const items = readdirSync(dir);

  for (const item of items) {
    const fullPath = join(dir, item);

    // 제외할 폴더나 파일 스킵
    if (IGNORE_DIRS.has(item)) continue;

    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      scanAndReplace(fullPath);
    } else if (stat.isFile()) {
      // 확장자나 특정 파일명 매칭 검사
      const ext = fullPath.substring(fullPath.lastIndexOf('.'));
      const isAllowed = ALLOWED_EXTENSIONS.has(ext) || ALLOWED_EXTENSIONS.has(item);

      // 치환 스크립트 본인 제외
      if (item === 'rename-to-harness.ts') continue;

      if (isAllowed) {
        processedFiles++;
        try {
          const content = readFileSync(fullPath, 'utf-8');
          let newContent = content;

          for (const [regex, replacement] of REPLACEMENTS) {
            newContent = newContent.replace(regex, replacement);
          }

          if (newContent !== content) {
            writeFileSync(fullPath, newContent, 'utf-8');
            modifiedFiles++;
            console.log(`[MODIFIED] ${fullPath.replace(ROOT_DIR, '')}`);
          }
        } catch (err) {
          console.error(`[ERROR] Failed to process ${fullPath}:`, err);
        }
      }
    }
  }
}

console.log('🔄 Hiddink Harness 프로젝트 일괄 리네임 리팩토링 스크립트를 기동합니다...');
console.log('------------------------------------------------------------------');
scanAndReplace(ROOT_DIR);
console.log('------------------------------------------------------------------');
console.log(
  `✅ 완료! 총 ${processedFiles}개 파일을 검사했고, ${modifiedFiles}개 파일을 성공적으로 수정하였습니다.`
);
