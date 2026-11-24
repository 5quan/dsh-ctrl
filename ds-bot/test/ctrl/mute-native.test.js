import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../../index.js'
import { fakeContext } from '../fake-ctx.js'

test('memory: false mutes both native memory and learning while keeping ctrl tickets active', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-mute-native-'))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, memory: false })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  assert.equal(rt.memoryEnabled, false)
  assert.equal(await rt.learningRun(), 0)
  await assert.rejects(() => rt.learningEndpoint('learning-answer', {}), /turned off/)

  assert.equal(ctx.calls.includes('effect ds-bot: tickets'), true)
  assert.equal(ctx.calls.includes('effect ds-bot: memory review'), false)
  assert.equal(ctx.calls.includes('effect ds-bot: memory tidy'), false)
  assert.equal(ctx.calls.includes('prompt bot-memory 645'), false)
  assert.equal(ctx.calls.includes('effect ds-bot: learning'), false)
})
