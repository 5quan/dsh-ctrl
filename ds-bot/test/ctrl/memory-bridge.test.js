import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../../index.js'
import { DAY_ROLLED_OVER_EVENT } from '../../src/host/ctrl/memory-bridge.js'
import { fakeContext } from '../fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Coder', role: 'Dev', instructions: '', createdAt: 2 },
    p1: { id: 'p1', sessionId: 'p1', name: 'Diary', role: 'Private', private: true, instructions: '', createdAt: 3 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function startTeam(t, { services } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-bridge-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services })
  const rt = createRuntime(ctx, { home, memory: false })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const tool = name => rt.teamTools.find(item => item.name === name)
  const run = (name, args, botId) => tool(name).execute(args, { agent: { id: botId } })
  return { home, ctx, rt, run }
}

test('memoryBridge degrades gracefully when dshMemory service is absent', async (t) => {
  const { rt } = startTeam(t)

  assert.equal(rt.memoryBridge.isAvailable(), false)
  assert.equal(rt.memoryBridge.getService(), undefined)
  assert.match(rt.memoryBridge.getCurrentLogicalDate(), /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(rt.memoryBridge.getMorningBriefing(), undefined)
  assert.deepEqual(rt.memoryBridge.markBriefingDelivered({ date: '2026-11-24' }), { ok: false, reason: 'MEMORY_UNAVAILABLE' })
  assert.deepEqual(await rt.memoryBridge.confirmBufferItems({ approveIds: ['buf_1'] }), { ok: false, reason: 'MEMORY_UNAVAILABLE' })
  assert.deepEqual(rt.memoryBridge.matchEntities('server A'), { totalMatched: 0, matches: [], text: '', estimatedTokens: 0 })
  assert.deepEqual(rt.memoryBridge.matchLessons('nginx deploy'), { totalMatched: 0, matches: [], text: '', estimatedTokens: 0 })
  assert.deepEqual(await rt.memoryBridge.submitBufferCandidate({ content: 'fact' }), { ok: false, reason: 'MEMORY_UNAVAILABLE' })
})

test('memoryBridge forwards service calls and fans out day-rolled-over events', async (t) => {
  const calls = []
  const fakeMemory = {
    getCurrentLogicalDate: () => '2026-11-24',
    getMorningBriefing: opts => ({ date: opts?.date ?? '2026-11-24', hasContent: true }),
    markBriefingDelivered: opts => { calls.push(['markBriefingDelivered', opts]); return { ok: true } },
    confirmBufferItems: async opts => { calls.push(['confirmBufferItems', opts]); return { ok: true, approved: opts.approveIds ?? [], rejected: [] } },
    matchEntities: (text, opts) => { calls.push(['matchEntities', text, opts]); return { totalMatched: 1, matches: [{ slug: 'srv-a' }], text: 'srv-a', estimatedTokens: 10 } },
    matchLessons: (text, opts) => { calls.push(['matchLessons', text, opts]); return { totalMatched: 1, matches: [{ slug: 'nginx-check' }], text: 'nginx-check', estimatedTokens: 12 } },
    submitBufferCandidate: async input => { calls.push(['submitBufferCandidate', input]); return { ok: true, id: 'buf_9', status: 'pending', sourceType: input.sourceType } },
  }

  const { ctx, rt } = startTeam(t, { services: { dshMemory: fakeMemory } })
  assert.equal(rt.memoryBridge.isAvailable(), true)
  assert.equal(rt.memoryBridge.getCurrentLogicalDate(), '2026-11-24')
  assert.equal(rt.memoryBridge.matchEntities('srv-a', { maxTokens: 500 }).totalMatched, 1)
  assert.equal(rt.memoryBridge.matchLessons('nginx', { tags: ['ops'] }).totalMatched, 1)
  assert.equal((await rt.memoryBridge.confirmBufferItems({ approveIds: ['buf_1'] })).ok, true)

  const seen = []
  const off1 = rt.memoryBridge.onDayRolledOver(() => { throw new Error('boom') })
  const off2 = rt.memoryBridge.onDayRolledOver(payload => seen.push(payload))
  ctx.emit(DAY_ROLLED_OVER_EVENT, { date: '2026-11-23', scope: 'default' })
  assert.deepEqual(seen, [{ date: '2026-11-23', scope: 'default' }])
  off1()
  off2()
  ctx.emit(DAY_ROLLED_OVER_EVENT, { date: '2026-11-24', scope: 'default' })
  assert.equal(seen.length, 1)
  assert.equal(calls.some(([name]) => name === 'matchLessons'), true)
})

test('ticket_update retrospective queues candidates on done/failed, enforces private isolation, and handles absent service', async (t) => {
  const submitted = []
  let seq = 0
  const fakeMemory = {
    submitBufferCandidate: async input => {
      submitted.push(input)
      seq += 1
      return { ok: true, id: `buf_${seq}`, status: 'pending', sourceType: input.sourceType }
    },
  }

  const { run } = startTeam(t, { services: { dshMemory: fakeMemory } })

  // 1. Failed ticket defaults target to lesson:<title> with tags and sourceType: 'extracted'.
  const t1Out = await run('ticket_create', { title: 'Nginx Reload Bug', goal: 'Fix reload' }, 'm1')
  const t1 = /Ticket (tkt-[0-9a-f]{8})/.exec(t1Out)[1]
  // Non-terminal update skips retrospective.
  const progOut = await run('ticket_update', { id: t1, status: 'in_progress', retrospective: 'Should not submit yet' }, 'm1')
  assert.match(progOut, /Retrospective skipped: only recorded when status transitions to "done" or "failed"/)
  assert.equal(submitted.length, 0)

  const failOut = await run('ticket_update', {
    id: t1,
    status: 'failed',
    retrospective: 'Always run nginx -t before systemctl reload nginx.',
    retrospective_tags: ['nginx', 'ops'],
  }, 'm1')
  assert.match(failOut, /Memory buffer candidate queued \(buf_1, target: lesson:Nginx Reload Bug, status: pending\)/)
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].sourceType, 'extracted')
  assert.equal(submitted[0].target, 'lesson:Nginx Reload Bug')
  assert.deepEqual(submitted[0].tags, ['nginx', 'ops'])
  assert.equal(submitted[0].producer, 'dsh-ctrl/ticket-retrospective')
  assert.match(submitted[0].content, new RegExp(`Ticket ${t1} · failed`))

  // 2. Done ticket defaults target to 'note', and respects explicit retrospective_target.
  const t2Out = await run('ticket_create', { title: 'Audit Server A', goal: 'Check ports' }, 'm1')
  const t2 = /Ticket (tkt-[0-9a-f]{8})/.exec(t2Out)[1]
  const doneDefault = await run('ticket_update', {
    id: t2,
    status: 'done',
    retrospective: 'Port 8080 serves healthcheck.',
  }, 'm1')
  assert.match(doneDefault, /target: note, status: pending/)
  assert.equal(submitted[1].target, 'note')

  const t3Out = await run('ticket_create', { title: 'Update Server A IP', goal: 'Record IP' }, 'm1')
  const t3 = /Ticket (tkt-[0-9a-f]{8})/.exec(t3Out)[1]
  const doneEntity = await run('ticket_update', {
    id: t3,
    status: 'done',
    retrospective: 'Server A moved to 10.0.0.8.',
    retrospective_target: 'entity:ServerA',
  }, 'm1')
  assert.match(doneEntity, /target: entity:ServerA, status: pending/)
  assert.equal(submitted[2].target, 'entity:ServerA')

  // 3. Private Bot ticket never leaks retrospective to shared dsh-memory.
  const privOut = await run('ticket_create', { title: 'Private Secret', goal: 'Personal' }, 'p1')
  const privId = /Ticket (tkt-[0-9a-f]{8})/.exec(privOut)[1]
  const privDone = await run('ticket_update', {
    id: privId,
    status: 'done',
    retrospective: 'Sensitive personal detail',
  }, 'p1')
  assert.match(privDone, /Retrospective skipped: private Bot tickets do not write to shared dsh-memory/)
  assert.equal(submitted.length, 3)

  // 4. Absent dshMemory service still commits ticket update cleanly.
  const noMem = startTeam(t)
  const t4Out = await noMem.run('ticket_create', { title: 'Offline Task', goal: 'Verify' }, 'm1')
  const t4 = /Ticket (tkt-[0-9a-f]{8})/.exec(t4Out)[1]
  const offlineDone = await noMem.run('ticket_update', {
    id: t4,
    status: 'done',
    retrospective: 'Still works without dshMemory',
  }, 'm1')
  assert.match(offlineDone, /Status: done/)
  assert.match(offlineDone, /Memory buffer skipped \(MEMORY_UNAVAILABLE\)/)
})
