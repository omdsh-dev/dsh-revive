import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const stagingRoot = resolve(root, '.build')
const stagingLib = resolve(stagingRoot, 'lib')
const backupLib = resolve(stagingRoot, 'lib.previous')
const currentLib = resolve(root, 'lib')

rmSync(stagingRoot, { recursive: true, force: true })
mkdirSync(stagingRoot, { recursive: true })

try {
  run('node', [
    'node_modules/typescript/bin/tsc',
    '-p', 'tsconfig.json',
    '--outDir', stagingLib,
    '--declarationDir', resolve(stagingLib, 'types'),
  ])
  run('node', ['node_modules/tsdown/dist/run.mjs', '--config', 'tsdown.config.ts', '--out-dir', stagingLib])
  promote(stagingLib, currentLib, backupLib)
} finally {
  rmSync(stagingRoot, { recursive: true, force: true })
}

function promote(source, destination, backup) {
  if (!existsSync(destination)) {
    renameSync(source, destination)
    return
  }

  // Atomic exchange where the toolchain supports it (coreutils >= 9.5);
  // otherwise fall back to the backup-swap path below.
  if (process.platform === 'linux') {
    const exchange = spawnSync('mv', ['--exchange', '-T', source, destination], { stdio: 'ignore', cwd: root })
    if (exchange.status === 0) return
  }

  try {
    renameSync(destination, backup)
    renameSync(source, destination)
    rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (!existsSync(destination) && existsSync(backup)) renameSync(backup, destination)
    throw error
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with status ${result.status ?? 'signal'}`)
}
