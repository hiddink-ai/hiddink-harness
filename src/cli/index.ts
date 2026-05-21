#!/usr/bin/env node
/**
 * hiddink-harness CLI entry point
 * Main CLI application using Commander.js
 */

import { Command } from 'commander';
import packageJson from '../../package.json' with { type: 'json' };
import {
  ensureGlobalLayout,
  getProjectId,
  mountSymlinks,
  registerCleanupHandlers,
  seedTemplatesIfNeeded,
} from '../core/global-state.js';
import { formatPreflightWarnings, runPreflightCheck } from '../core/preflight.js';
import { maybeHandleSelfUpdateForCommand } from '../core/self-update.js';
import { detectLanguage, i18n, initI18n } from '../i18n/index.js';
import { doctorCommand } from './doctor.js';
import { listCommand } from './list.js';
import { securityCommand } from './security.js';
import { syncCommand } from './sync.js';

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
    .option('--auto-self-update', 'Automatically upgrade hiddink-harness without prompting')
    .option('--skip-self-update', 'Skip hiddink-harness self-update check')
    .action(async () => {
      const cwd = process.cwd();
      const projectId = getProjectId(cwd);

      const isTest =
        cwd.includes('/tmp/') || process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test';

      if (!isTest) {
        ensureGlobalLayout(projectId);
        const seed = seedTemplatesIfNeeded(projectId);
        if (seed.seeded) {
          process.stderr.write(`✓ Templates ${seed.reason}\n`);
        }
        mountSymlinks(projectId, cwd);
        registerCleanupHandlers(projectId, cwd);
      }

      const { render } = await import('ink');
      const React = await import('react');
      const { HiddinkTuiDashboard } = await import('./ui/Dashboard.js');

      render(React.createElement(HiddinkTuiDashboard, { cwd }));
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

  // Pre-flight hook: run before any command
  program.hook('preAction', async (thisCommand, actionCommand) => {
    const cwd = process.cwd();
    const projectId = getProjectId(cwd);

    const isTest =
      cwd.includes('/tmp/') || process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test';

    if (!isTest) {
      ensureGlobalLayout(projectId);
      const seed = seedTemplatesIfNeeded(projectId);
      if (seed.seeded) {
        process.stderr.write(`✓ Templates ${seed.reason}\n`);
      }
      mountSymlinks(projectId, cwd);
      registerCleanupHandlers(projectId, cwd);
    }

    const opts = thisCommand.optsWithGlobals() as {
      skipVersionCheck?: boolean;
      autoSelfUpdate?: boolean;
      skipSelfUpdate?: boolean;
    };
    const skipCheck = opts.skipVersionCheck || false;

    const cmdName = actionCommand.name();

    // All commands: non-blocking self-update check
    const autoApply =
      opts.autoSelfUpdate === true || process.env.HIDDINK_HARNESS_AUTO_SELF_UPDATE === '1';
    const skipSelfUpdate = opts.skipSelfUpdate === true;

    // Determine whether we are in TUI mode (no-arg default action)
    // The default action is registered directly on `program`, so its name() is
    // the program name ("hiddink-harness") rather than a subcommand name.
    const isTuiMode = cmdName === 'hiddink-harness' || cmdName === program.name();

    const selfUpdateResult = await maybeHandleSelfUpdateForCommand({
      currentVersion: packageJson.version,
      skip: skipSelfUpdate,
      autoApply,
      mode: isTuiMode ? 'tui' : 'subcommand',
    });

    if (selfUpdateResult.applied && selfUpdateResult.latestVersion) {
      // Newly installed version is in a different binary — must re-exec
      process.stderr.write(
        `✓ Upgraded hiddink-harness to ${selfUpdateResult.latestVersion}, please re-run the command.\n`
      );
      process.exit(0);
    } else if (selfUpdateResult.updateAvailable && selfUpdateResult.latestVersion) {
      // Print a one-line notice to stderr so it does not pollute stdout
      process.stderr.write(
        `⚠ hiddink-harness ${selfUpdateResult.latestVersion} available (current: ${packageJson.version}). Run with --auto-self-update or \`hiddink-harness sync\`\n`
      );
    }
    // error / skipped / no update → silent

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
