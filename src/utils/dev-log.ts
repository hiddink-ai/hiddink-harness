import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof Error) {
      return {
        name: item.name,
        message: item.message,
        stack: item.stack,
      };
    }
    if (typeof item === 'bigint') return item.toString();
    return item;
  });
}

export function devLog(event: string, data: Record<string, unknown> = {}): void {
  const logPath = process.env.HIDDINK_HARNESS_DEV_LOG;
  if (!logPath) return;

  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      `${safeJson({
        ts: new Date().toISOString(),
        pid: process.pid,
        event,
        ...data,
      })}\n`,
      'utf8'
    );
  } catch {
    // Logging must never break the TUI/provider path.
  }
}
