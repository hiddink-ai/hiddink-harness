import { Database } from 'bun:sqlite';

export interface MemoryRecord {
  id: string;
  source: 'native' | 'claude-mem' | 'episodic-memory' | 'llm-memory' | 'agentmemory';
  device_id: string;
  project: string;
  agent?: string;
  timestamp: string;
  summary: string;
  content: string;
  tags: string[];
  sensitivity: 'public' | 'project' | 'sensitive' | 'secret';
  hash: string;
  embedding_ref?: string;
  created_at?: string;
  updated_at?: string;
}

export interface QueryFilter {
  source?: 'native' | 'claude-mem' | 'episodic-memory' | 'llm-memory' | 'agentmemory';
  sensitivity?: 'public' | 'project' | 'sensitive';
  agent?: string;
  project?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
  limit?: number;
}

/**
 * Initialize the SQLite database and create memory_records table if not exists.
 */
export function initDb(dbPath: string): Database {
  const db = new Database(dbPath);

  db.run(`
    CREATE TABLE IF NOT EXISTS memory_records (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      device_id TEXT NOT NULL,
      project TEXT NOT NULL,
      agent TEXT,
      timestamp TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      embedding_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  return db;
}

/**
 * Query memory records with optional filters. Secret records are never returned.
 */
export function queryRecords(db: Database, filter: QueryFilter): MemoryRecord[] {
  let sql = "SELECT * FROM memory_records WHERE sensitivity != 'secret'";
  const params: Record<string, any> = {};

  if (filter.source) {
    sql += ' AND source = $source';
    params.$source = filter.source;
  }
  if (filter.sensitivity) {
    sql += ' AND sensitivity = $sensitivity';
    params.$sensitivity = filter.sensitivity;
  }
  if (filter.agent) {
    sql += ' AND agent = $agent';
    params.$agent = filter.agent;
  }
  if (filter.project) {
    sql += ' AND project = $project';
    params.$project = filter.project;
  }
  if (filter.fromTimestamp) {
    sql += ' AND timestamp >= $fromTimestamp';
    params.$fromTimestamp = filter.fromTimestamp;
  }
  if (filter.toTimestamp) {
    sql += ' AND timestamp <= $toTimestamp';
    params.$toTimestamp = filter.toTimestamp;
  }

  sql += ' ORDER BY timestamp DESC LIMIT $limit';
  params.$limit = filter.limit ?? 100;

  const stmt = db.prepare(sql);
  const rows = stmt.all(params) as any[];

  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    device_id: row.device_id,
    project: row.project,
    agent: row.agent || undefined,
    timestamp: row.timestamp,
    summary: row.summary,
    content: row.content,
    tags: JSON.parse(row.tags || '[]'),
    sensitivity: row.sensitivity,
    hash: row.hash,
    embedding_ref: row.embedding_ref || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

/**
 * Get a single non-secret memory record by id.
 */
export function getRecordById(db: Database, id: string): MemoryRecord | null {
  const stmt = db.prepare(
    "SELECT * FROM memory_records WHERE id = $id AND sensitivity != 'secret'"
  );
  const row = stmt.get({ $id: id }) as any;
  if (!row) return null;

  return {
    id: row.id,
    source: row.source,
    device_id: row.device_id,
    project: row.project,
    agent: row.agent || undefined,
    timestamp: row.timestamp,
    summary: row.summary,
    content: row.content,
    tags: JSON.parse(row.tags || '[]'),
    sensitivity: row.sensitivity,
    hash: row.hash,
    embedding_ref: row.embedding_ref || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Get a single non-secret memory record by hash.
 */
export function getRecordByHash(db: Database, hash: string): MemoryRecord | null {
  const stmt = db.prepare(
    "SELECT * FROM memory_records WHERE hash = $hash AND sensitivity != 'secret'"
  );
  const row = stmt.get({ $hash: hash }) as any;
  if (!row) return null;

  return {
    id: row.id,
    source: row.source,
    device_id: row.device_id,
    project: row.project,
    agent: row.agent || undefined,
    timestamp: row.timestamp,
    summary: row.summary,
    content: row.content,
    tags: JSON.parse(row.tags || '[]'),
    sensitivity: row.sensitivity,
    hash: row.hash,
    embedding_ref: row.embedding_ref || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Get unique sources with counts.
 */
export function getSourceCounts(db: Database): { source: string; count: number }[] {
  const stmt = db.prepare(`
    SELECT source, COUNT(*) as count 
    FROM memory_records 
    WHERE sensitivity != 'secret' 
    GROUP BY source 
    ORDER BY count DESC
  `);
  return stmt.all() as { source: string; count: number }[];
}

/**
 * Get aggregate statistics.
 */
export function getStats(db: Database): {
  total: number;
  bySource: Record<string, number>;
  bySensitivity: Record<string, number>;
} {
  const allRecordsStmt = db.prepare(
    "SELECT source, sensitivity FROM memory_records WHERE sensitivity != 'secret'"
  );
  const rows = allRecordsStmt.all() as { source: string; sensitivity: string }[];

  const bySource: Record<string, number> = {};
  const bySensitivity: Record<string, number> = {};

  for (const row of rows) {
    bySource[row.source] = (bySource[row.source] ?? 0) + 1;
    bySensitivity[row.sensitivity] = (bySensitivity[row.sensitivity] ?? 0) + 1;
  }

  return {
    total: rows.length,
    bySource,
    bySensitivity,
  };
}
