import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { ensureDirectory } from '../utils/fs.js';
import {
  getRecordByHash,
  getRecordById,
  getSourceCounts,
  getStats,
  initDb,
  type QueryFilter,
  queryRecords,
} from './sqlite.js';

// Define DB path fallback chain:
// 1. HIDDINK_MEMORY_DB env
// 2. HIDDINK_AGENT_MEMORY_DB env
// 3. ~/.hiddink-harness/memory.db
// 4. ~/.hiddink-harness/memory.db
function resolveDbPath(): string {
  if (process.env.HIDDINK_MEMORY_DB) {
    return process.env.HIDDINK_MEMORY_DB;
  }
  if (process.env.HIDDINK_AGENT_MEMORY_DB) {
    return process.env.HIDDINK_AGENT_MEMORY_DB;
  }

  // Default directories
  const hiddinkDir = join(homedir(), '.hiddink-harness');
  return join(hiddinkDir, 'memory.db');
}

/**
 * Lightweight JSON-RPC 2.0 Stdio MCP Server
 */
export async function startMcpServer(): Promise<void> {
  const dbPath = resolveDbPath();

  // Ensure the directory for the database exists
  const dbDir = join(dbPath, '..');
  await ensureDirectory(dbDir);

  const db = initDb(dbPath);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  // Tools manifest
  const tools = [
    {
      name: 'memory.query',
      description:
        'Query memory records with optional filters. Secret-tier records are never returned.',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            enum: ['native', 'claude-mem', 'episodic-memory', 'llm-memory', 'agentmemory'],
            description: 'Filter by memory source',
          },
          sensitivity: {
            type: 'string',
            enum: ['public', 'project', 'sensitive'],
            description: 'Filter by sensitivity tier (secret is never exposed)',
          },
          agent: { type: 'string', description: 'Filter by agent name' },
          project: { type: 'string', description: 'Filter by project path' },
          since: {
            type: 'string',
            description: 'ISO 8601 lower bound on timestamp (inclusive)',
          },
          until: {
            type: 'string',
            description: 'ISO 8601 upper bound on timestamp (inclusive)',
          },
          limit: {
            type: 'number',
            description: 'Maximum records to return (default: 100)',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'memory.get',
      description: 'Get a single memory record by id or hash. Returns null if not found or secret.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Record UUID' },
          hash: { type: 'string', description: 'Record SHA-256 hash' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'memory.list_sources',
      description: 'List unique memory sources with record counts.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'memory.stats',
      description: 'Get aggregate statistics over all non-secret memory records.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ];

  rl.on('line', (line) => {
    if (!line.trim()) return;

    let request: any;
    try {
      request = JSON.parse(line);
    } catch (_err) {
      sendError(null, -32700, 'Parse error');
      return;
    }

    const { jsonrpc, id, method, params } = request;

    if (jsonrpc !== '2.0') {
      sendError(id ?? null, -32600, 'Invalid Request: missing or incorrect jsonrpc version');
      return;
    }

    // Handle notifications (no id)
    if (id === undefined || id === null) {
      // Just log/ignore initialized notification or unsupported notifications
      return;
    }

    try {
      switch (method) {
        case 'initialize': {
          sendResponse(id, {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'hiddink-mcp-server',
              version: '0.1.0',
            },
          });
          break;
        }

        case 'tools/list': {
          sendResponse(id, { tools });
          break;
        }

        case 'tools/call': {
          const { name, arguments: args } = params || {};
          handleToolCall(id, name, args || {});
          break;
        }

        default: {
          sendError(id, -32601, `Method not found: ${method}`);
        }
      }
    } catch (err: any) {
      sendError(id, -32603, `Internal error: ${err.message}`);
    }
  });

  function sendResponse(id: number | string, result: any) {
    const response = {
      jsonrpc: '2.0',
      id,
      result,
    };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }

  function sendError(id: number | string | null, code: number, message: string) {
    const response = {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
      },
    };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }

  async function handleToolCall(id: number | string, name: string, args: any) {
    try {
      switch (name) {
        case 'memory.query': {
          const filter: QueryFilter = {
            source: args.source,
            sensitivity: args.sensitivity,
            agent: args.agent,
            project: args.project,
            fromTimestamp: args.since,
            toTimestamp: args.until,
            limit: args.limit,
          };
          const records = queryRecords(db, filter);
          sendResponse(id, {
            content: [{ type: 'text', text: JSON.stringify(records) }],
            isError: false,
          });
          break;
        }

        case 'memory.get': {
          if (args.id === undefined && args.hash === undefined) {
            throw new Error('Either id or hash must be provided');
          }
          let record = null;
          if (args.id !== undefined) {
            record = getRecordById(db, args.id);
          } else if (args.hash !== undefined) {
            record = getRecordByHash(db, args.hash);
          }
          sendResponse(id, {
            content: [{ type: 'text', text: JSON.stringify(record) }],
            isError: false,
          });
          break;
        }

        case 'memory.list_sources': {
          const counts = getSourceCounts(db);
          sendResponse(id, {
            content: [{ type: 'text', text: JSON.stringify(counts) }],
            isError: false,
          });
          break;
        }

        case 'memory.stats': {
          const stats = getStats(db);
          sendResponse(id, {
            content: [{ type: 'text', text: JSON.stringify(stats) }],
            isError: false,
          });
          break;
        }

        default: {
          sendError(id, -32601, `Unknown tool: ${name}`);
        }
      }
    } catch (err: any) {
      sendResponse(id, {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      });
    }
  }
}
