#!/usr/bin/env node
/**
 * hiddink-harness CLI entry point
 * Main CLI application using Commander.js
 */

import { createRequire } from 'node:module';
import { Command } from 'commander';
import {
  ensureGlobalLayout,
  getProjectId,
  mountSymlinks,
  registerCleanupHandlers,
} from '../core/global-state.js';
import { formatPreflightWarnings, runPreflightCheck } from '../core/preflight.js';
import { unregisterProject } from '../core/registry.js';
import { maybeHandleSelfUpdateForInit } from '../core/self-update.js';
import { detectLanguage, i18n, initI18n } from '../i18n/index.js';
import { doctorCommand } from './doctor.js';
import { initCommand } from './init.js';
import { listCommand } from './list.js';
import { projectsCommand } from './projects.js';
import { securityCommand } from './security.js';
import { serveCommand, serveStopCommand } from './serve-commands.js';
import { syncCommand } from './sync.js';
import { updateCommand } from './update.js';
import {
  webOpenCommand,
  webStartCommand,
  webStatusCommand,
  webStopCommand,
} from './web-commands.js';

// Read version from package.json
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

/**
 * Creates and configures the CLI program
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('hiddink-harness')
    .description(i18n.t('cli.description'))
    .version(packageJson.version, '-v, --version', i18n.t('cli.versionOption'))
    .option('--skip-version-check', 'Skip CLI version pre-flight check')
    .action(async () => {
      const cwd = process.cwd();
      const projectId = getProjectId(cwd);

      const isTest =
        cwd.includes('/tmp/') || process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test';

      if (!isTest) {
        ensureGlobalLayout(projectId);
        mountSymlinks(projectId, cwd);
        registerCleanupHandlers(projectId, cwd);
      }

      const { render } = await import('ink');
      const React = await import('react');
      const { HiddinkTuiDashboard } = await import('./ui/Dashboard.js');

      render(React.createElement(HiddinkTuiDashboard, { cwd }));
    });

  // hiddink-harness init [--lang en|ko] [--domain <domain>] [--yes] [--force]
  program
    .command('init')
    .description(i18n.t('cli.init.description'))
    .option('-l, --lang <language>', i18n.t('cli.init.langOption'))
    .option(
      '--domain <domain>',
      'Install only agents/skills for specific domain (backend, frontend, data-engineering, devops)'
    )
    .option('--yes', 'Skip interactive wizard, use defaults')
    .option('--force', 'Overwrite existing files')
    .option('--from-snapshot <path>', 'Install from a pre-configured team snapshot directory')
    .action(async (options) => {
      await initCommand(options);
    });

  // hiddink-harness update
  program
    .command('update')
    .description(i18n.t('cli.update.description'))
    .option('--dry-run', i18n.t('cli.update.dryRunOption'))
    .option('--force', i18n.t('cli.update.forceOption'))
    .option('--force-overwrite-all', i18n.t('cli.update.forceOverwriteAllOption'))
    .option('--hard', i18n.t('cli.update.hardOption'))
    .option('--backup', i18n.t('cli.update.backupOption'))
    .option('--agents', i18n.t('cli.update.agentsOption'))
    .option('--skills', i18n.t('cli.update.skillsOption'))
    .option('--rules', i18n.t('cli.update.rulesOption'))
    .option('--guides', i18n.t('cli.update.guidesOption'))
    .option('--hooks', i18n.t('cli.update.hooksOption'))
    .option('--contexts', i18n.t('cli.update.contextsOption'))
    .option('--all', i18n.t('cli.update.allOption'))
    .option('--skip-self', 'Skip self-update of hiddink-harness package')
    .action(async (options) => {
      await updateCommand(options);
    });

  // hiddink-harness list [type] [--format table|json|simple]
  program
    .command('list')
    .description(i18n.t('cli.list.description'))
    .argument('[type]', i18n.t('cli.list.typeArgument'), 'all')
    .option('-f, --format <format>', 'Output format: table, json, or simple', 'table')
    .option('--verbose', 'Show detailed information')
    .action(async (type, options) => {
      await listCommand(type, {
        format: options.format,
        verbose: options.verbose,
      });
    });

  // hiddink-harness sync [--check] [--reference <path>] [--export <path>]
  syncCommand(program);

  // hiddink-harness doctor
  program
    .command('doctor')
    .description(i18n.t('cli.doctor.description'))
    .option('--fix', i18n.t('cli.doctor.fixOption'))
    .option('--updates', i18n.t('cli.doctor.updatesOption'))
    .action(async (options) => {
      await doctorCommand(options);
    });

  // hiddink-harness security
  program
    .command('security')
    .description(i18n.t('cli.security.description'))
    .option('--verbose', i18n.t('cli.security.verboseOption'))
    .action(async (options) => {
      const result = await securityCommand(options);
      process.exitCode = result.success ? 0 : 1;
    });

  // hiddink-harness web — subcommand group for Web UI management
  const web = program.command('web').description(i18n.t('cli.web.description'));

  // hiddink-harness web start [--port 4321] [--foreground]
  web
    .command('start')
    .description(i18n.t('cli.web.start.description'))
    .option('-p, --port <port>', i18n.t('cli.web.start.portOption'), '4321')
    .option('--foreground', i18n.t('cli.web.start.foregroundOption'))
    .action(async (options) => {
      await webStartCommand(options);
    });

  // hiddink-harness web stop
  web
    .command('stop')
    .description(i18n.t('cli.web.stop.description'))
    .action(async () => {
      await webStopCommand();
    });

  // hiddink-harness web status
  web
    .command('status')
    .description(i18n.t('cli.web.status.description'))
    .action(async () => {
      await webStatusCommand();
    });

  // hiddink-harness web open [--port 4321]
  web
    .command('open')
    .description(i18n.t('cli.web.open.description'))
    .option('-p, --port <port>', i18n.t('cli.web.open.portOption'), '4321')
    .action(async (options) => {
      await webOpenCommand(options);
    });

  // Default action for `hiddink-harness web` (no subcommand): show status
  web.action(async () => {
    await webStatusCommand();
  });

  // hiddink-harness serve — deprecated alias for `hiddink-harness web start`
  program
    .command('serve')
    .description('(Deprecated) Start the Web UI server — use `hiddink-harness web start` instead')
    .option('-p, --port <port>', i18n.t('cli.web.start.portOption'), '4321')
    .option('--foreground', i18n.t('cli.web.start.foregroundOption'))
    .action(async (options) => {
      console.warn(i18n.t('cli.web.deprecated.serve'));
      await serveCommand(options);
    });

  // hiddink-harness serve-stop — deprecated alias for `hiddink-harness web stop`
  program
    .command('serve-stop')
    .description('(Deprecated) Stop the Web UI server — use `hiddink-harness web stop` instead')
    .action(async () => {
      console.warn(i18n.t('cli.web.deprecated.serveStop'));
      await serveStopCommand();
    });

  // hiddink-harness projects [--format table|json|simple] [--path <dir>] [--migrate] [--clean]
  program
    .command('projects')
    .description('List all projects on this machine where hiddink-harness is installed')
    .option('-f, --format <format>', 'Output format: table, json, or simple', 'table')
    .option(
      '--path <dir>',
      'Additional search directory (can be specified multiple times)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option(
      '--migrate',
      'Scan for existing projects with lock files and import them into the registry'
    )
    .option('--clean', 'Remove registry entries whose project paths no longer exist on disk')
    .action(async (options) => {
      await projectsCommand({
        format: options.format,
        paths: options.path,
        migrate: options.migrate,
        clean: options.clean,
      });
    });

  // hiddink-harness unregister [path]
  program
    .command('unregister [path]')
    .description('Remove a project from the local registry')
    .action(async (projectPath?: string) => {
      const targetPath = projectPath ?? process.cwd();
      try {
        await unregisterProject(targetPath);
        console.log(`  프로젝트가 레지스트리에서 제거되었습니다: ${targetPath}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`  레지스트리 제거 실패: ${msg}`);
        process.exitCode = 1;
      }
    });

  // hiddink-harness mcp-serve
  program
    .command('mcp-serve')
    .description('Start the Stdio based lightweight MCP server for memory management')
    .action(async () => {
      try {
        const { startMcpServer } = await import('../mcp/server.js');
        await startMcpServer();
      } catch (error) {
        console.error('Failed to start MCP server:', error);
        process.exit(1);
      }
    });

  // Pre-flight hook: run before any command
  program.hook('preAction', async (thisCommand, actionCommand) => {
    const cwd = process.cwd();
    const projectId = getProjectId(cwd);

    const isTest =
      cwd.includes('/tmp/') || process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test';

    if (!isTest) {
      ensureGlobalLayout(projectId);
      mountSymlinks(projectId, cwd);
      registerCleanupHandlers(projectId, cwd);
    }

    const opts = thisCommand.optsWithGlobals() as { skipVersionCheck?: boolean };
    const skipCheck = opts.skipVersionCheck || false;

    const cmdName = actionCommand.name();
    const parentName = (actionCommand.parent as Command | undefined)?.name();

    // Skip pre-flight for serve/serve-stop/web subcommands (fast server ops)
    const isServeCmd = cmdName === 'serve' || cmdName === 'serve-stop';
    const isWebCmd = cmdName === 'web' || parentName === 'web';
    if (isServeCmd || isWebCmd) {
      return;
    }

    if (cmdName === 'init') {
      await maybeHandleSelfUpdateForInit({
        currentVersion: packageJson.version,
        skip: skipCheck,
      });
    }

    const result = await runPreflightCheck({ skip: skipCheck });

    if (result.hasUpdates) {
      const warnings = formatPreflightWarnings(result);
      console.warn(warnings);
      console.warn(''); // Empty line for spacing
    }
  });

  return program;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Initialize i18n with detected language
  const lang = detectLanguage();
  await initI18n(lang);

  // Create and run the CLI program
  const program = createProgram();
  await program.parseAsync(process.argv);
}

// Run main if this is the entry point
main().catch((error) => {
  console.error(i18n.t('cli.error.unexpected'), error);
  process.exit(1);
});

export { main };
