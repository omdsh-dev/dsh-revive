import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  version: string
  exports: Record<string, unknown>
  dependencies?: Record<string, string>
  peerDependencies: Record<string, string>
  dsh: {
    bundle: { patch: string }
    client: { platform: string; inject: string[] }
  }
}

const root = new URL('../', import.meta.url)

async function manifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as PackageManifest
}

describe('DSH 0.1.0-rc.3 package contract', () => {
  it('ships one Profile Bundle and a discoverable web client', async () => {
    const pkg = await manifest()

    expect(pkg.version).toBe('0.1.4')
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.exports).toHaveProperty('./client')
    expect(pkg.dsh.client.platform).toBe('web')
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-conversation')
  })

  it('pins every DSH peer to a range that accepts 0.1.0-rc.3', async () => {
    const pkg = await manifest()
    const dshPeers = Object.entries(pkg.peerDependencies)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))

    expect(dshPeers.length).toBeGreaterThan(0)
    for (const [, range] of dshPeers) expect(range).toBe('>=0.1.0-rc.3 <0.2.0')
  })

  it('uses scoped framework packages and never reintroduces session-query', async () => {
    const pkg = await manifest()

    expect(pkg.peerDependencies['@deepseek-ai/cordis']).toBe('>=4.0.1-rc.1 <5.0.0')
    expect(pkg.peerDependencies['@deepseek-ai/schemastery']).toBe('>=3.18.1-rc.1 <4.0.0')
    expect(pkg.dependencies ?? {}).not.toHaveProperty('schemastery')
    expect(pkg.peerDependencies).not.toHaveProperty('schemastery')
    expect(pkg.peerDependencies).not.toHaveProperty('@deepseek-ai/dsh-session-query')
  })
})
