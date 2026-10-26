// Build and publish a new npm release. Nothing is pushed or tagged in Git.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const registry = 'https://registry.npmjs.org/';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const current = args.includes('--current');
const bump = args.find((arg) => ['patch', 'minor', 'major'].includes(arg)) || 'patch';

function npm(args: string[], capture = false) {
  const result = spawnSync('npm', args, {
    cwd: root,
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed; stopping without retrying.`);
  return result.stdout || '';
}

async function main() {
  if (args.includes('--help')) {
    console.log(`Usage: npm run release -- [patch|minor|major] [--dry-run|--current]

Default: check, bump patch, pack, and ask before publishing.
--dry-run  Check and preview the current version without bumping or publishing.
--current  Publish the version already in package.json (resume a prepared release).

Version changes stay local. This script does not commit, tag, or push.`);
    return;
  }
  if (
    args.some((arg) => !['patch', 'minor', 'major', '--dry-run', '--current'].includes(arg)) ||
    args.filter((arg) => ['patch', 'minor', 'major'].includes(arg)).length > 1 ||
    (current && args.some((arg) => ['patch', 'minor', 'major'].includes(arg))) ||
    (current && dryRun)
  ) {
    throw new Error('Invalid release options. Run npm run release -- --help.');
  }
  if (!dryRun && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('Publishing requires an interactive terminal. Use --dry-run for a preview.');
  }

  // Run checks before changing either version file.
  npm(['run', 'build']);
  if (!dryRun) {
    npm(['whoami', '--registry', registry]);
    if (!current) npm(['version', bump, '--no-git-tag-version', '--ignore-scripts']);
  }

  const directory = await mkdtemp(join(tmpdir(), 'pi-character-release-'));
  try {
    // Checks already passed. Publish this exact archive rather than repacking later.
    const [pack] = JSON.parse(
      npm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory], true),
    );
    const archive = join(directory, pack.filename);
    console.log(`\n${pack.name}@${pack.version} — ${pack.size} bytes packed`);
    for (const file of pack.files) console.log(`  ${file.path}`);
    npm([
      'publish',
      archive,
      '--access',
      'public',
      '--registry',
      registry,
      '--ignore-scripts',
      '--dry-run',
    ]);
    if (dryRun) {
      console.log('\nPreview complete. No version changes or publication.');
      return;
    }

    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try {
      answer = await prompt.question(
        `\nPublish ${pack.name}@${pack.version} to public npm? [y/N] `,
      );
    } finally {
      prompt.close();
    }
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
      console.log('Not published. Version changes remain local; use --current to resume.');
      return;
    }
    npm(['publish', archive, '--access', 'public', '--registry', registry, '--ignore-scripts']);
    console.log(`\nPublished ${pack.name}@${pack.version}. npm processing may take a few minutes.`);
    console.log(`Verify later: npm view ${pack.name}@${pack.version} version`);
    console.log('Commit and push package.json and package-lock.json when ready.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  console.error(`Local version: ${version}. No automatic publish retry was attempted.`);
  process.exitCode = 1;
}
