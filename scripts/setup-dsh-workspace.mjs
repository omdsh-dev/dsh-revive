import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const root = process.cwd()
const runtimeRoot = process.env.DSH_RUNTIME_NODE_MODULES === undefined
  ? undefined
  : resolve(process.env.DSH_RUNTIME_NODE_MODULES)
const workspaceRoot = process.env.DSH_WORKSPACE_ROOT === undefined
  ? resolve(root, '../dsh-workspace')
  : resolve(process.env.DSH_WORKSPACE_ROOT)
const links = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/cordis-plugin-timer': 'vendor/timer',
  '@deepseek-ai/schemastery': 'vendor/schemastery',
  '@deepseek-ai/dsh-agent': 'packages/core/agent',
  '@deepseek-ai/dsh-agent-default-model': 'packages/core/agent-default-model',
  '@deepseek-ai/dsh-agent-presets': 'packages/preset/agent-presets',
  '@deepseek-ai/dsh-api-remotes': 'packages/api/remotes',
  '@deepseek-ai/dsh-commands': 'packages/interaction/commands',
  '@deepseek-ai/dsh-host-apiproxy': 'packages/host/apiproxy',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-session': 'packages/core/session',
  '@deepseek-ai/dsh-session-persistence': 'packages/session/session-persistence',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
  '@deepseek-ai/dsh-client-connection': 'packages/client/connection',
  '@deepseek-ai/dsh-client-runtime': 'packages/client/runtime',
  '@deepseek-ai/dsh-client-ui-slots': 'packages/client/ui-slots',
  '@deepseek-ai/dsh-client-ui-conversation': 'packages/client/ui-conversation',
}

if (runtimeRoot === undefined && !existsSync(workspaceRoot)) {
  throw new Error(`Set DSH_RUNTIME_NODE_MODULES to an installed DSH node_modules, or DSH_WORKSPACE_ROOT to a local DSH workspace.`)
}
if (runtimeRoot !== undefined) {
  const manifest = JSON.parse(readFileSync(resolve(runtimeRoot, '@deepseek-ai/dsh/package.json'), 'utf8'))
  if (!isCompatibleDshVersion(manifest.version)) {
    throw new Error(`DSH must satisfy >=0.1.0-rc.3 <0.2.0; found ${String(manifest.version)}`)
  }
}

for (const [packageName, workspacePath] of Object.entries(links)) {
  const target = runtimeRoot === undefined ? resolve(workspaceRoot, workspacePath) : resolve(runtimeRoot, packageName)
  const destination = resolve(root, 'node_modules', packageName)
  if (!existsSync(target)) throw new Error(`DSH package source does not exist: ${target}`)
  ensureLink(destination, target)
}

function ensureLink(destination, target) {
  mkdirSync(dirname(destination), { recursive: true })
  if (pathExists(destination)) {
    if (lstatSync(destination).isSymbolicLink()) {
      const current = resolve(dirname(destination), readlinkSync(destination))
      if (current === target) return
      unlinkSync(destination)
    } else {
      throw new Error(`Refusing to replace existing dependency: ${destination}`)
    }
  }
  const linkTarget = process.platform === 'win32' ? target : relative(dirname(destination), target)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      symlinkSync(linkTarget, destination, process.platform === 'win32' ? 'junction' : 'dir')
      return
    } catch (error) {
      if (attempt === 1 || pathExists(destination)) throw error
    }
  }
}

function isCompatibleDshVersion(version) {
  const match = /^0\.1\.(\d+)(?:-rc\.(\d+))?$/.exec(String(version))
  if (match === null) return false
  const patch = Number(match[1])
  return patch > 0 || match[2] === undefined || Number(match[2]) >= 3
}

function pathExists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false
    throw error
  }
}
