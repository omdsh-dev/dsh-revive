import assert from 'node:assert/strict'
import { detectRawHealth } from '../lib/raw-health.js'

const TARGET_BYTES = 32 * 1024 * 1024
const header = '{"type":"session","version":1,"id":"oom-smoke","createdAt":0,"delegationDepth":0}\n'
const start = '{"type":"turn/start","seq":0,"time":0,"data":{"turn":1}}\n'
const irrelevant = '{"type":"assistant/chunk","seq":1,"time":0,"data":{"chunk":{"type":"text-delta","text":"x"}}}\n'
const repeats = Math.ceil(TARGET_BYTES / Buffer.byteLength(irrelevant))
const content = header + start + irrelevant.repeat(repeats)

assert.ok(Buffer.byteLength(content) >= TARGET_BYTES)
assert.deepEqual(detectRawHealth(content), { state: 'interrupted', reason: 'killed-mid-turn' })

process.stdout.write(JSON.stringify({
  artifactBytes: Buffer.byteLength(content),
  heapLimitMiB: 128,
  health: 'killed-mid-turn',
}) + '\n')
