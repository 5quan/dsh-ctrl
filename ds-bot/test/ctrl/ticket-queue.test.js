import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../../index.js'
import { createTicketQueue } from '../../src/host/ctrl/ticket-queue.js'
import { createTicketStore } from '../../src/host/ctrl/tickets.js'
import { fakeContext } from '../fake-ctx.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function setupStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-queue-'))
  const dbPath = join(dir, 'tickets.sqlite')
  const store = createTicketStore(dbPath)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })
  return { dir, dbPath, store }
}

function makeTicket(store, title = 'Task') {
  return store.create({
    title,
    goal: `Complete ${title}`,
    ownerBotId: 'm1',
    createdByBotId: 'm1',
  })
}

test('single ticket tasks execute strictly serially while different tickets run in parallel', async (t) => {
  const { store } = setupStore(t)
  const queue = createTicketQueue({ openStore: () => store, maxWorkers: 2, humanReserve: 1 })
  t.after(() => queue.stop())

  const t1 = makeTicket(store, 'Ticket 1')
  const t2 = makeTicket(store, 'Ticket 2')

  let t1Concurrent = 0
  let t1MaxConcurrent = 0
  let globalConcurrent = 0
  let globalMaxConcurrent = 0
  const events = []

  const runOnT1 = label => queue.enqueue({
    ticketId: t1.id,
    run: async () => {
      t1Concurrent += 1
      t1MaxConcurrent = Math.max(t1MaxConcurrent, t1Concurrent)
      globalConcurrent += 1
      globalMaxConcurrent = Math.max(globalMaxConcurrent, globalConcurrent)
      events.push(`start:${label}`)
      await delay(25)
      events.push(`end:${label}`)
      t1Concurrent -= 1
      globalConcurrent -= 1
      return label
    },
  })

  const runOnT2 = queue.enqueue({
    ticketId: t2.id,
    run: async () => {
      globalConcurrent += 1
      globalMaxConcurrent = Math.max(globalMaxConcurrent, globalConcurrent)
      events.push('start:t2')
      await delay(25)
      events.push('end:t2')
      globalConcurrent -= 1
      return 't2'
    },
  })

  const results = await Promise.all([runOnT1('a'), runOnT1('b'), runOnT2])
  assert.deepEqual(results, ['a', 'b', 't2'])
  assert.equal(t1MaxConcurrent, 1, 'same ticket never overlaps')
  assert.equal(globalMaxConcurrent, 2, 'distinct tickets run concurrently across maxWorkers')
  assert.ok(events.indexOf('end:a') < events.indexOf('start:b'))
})

test('stale expectedRevision is rejected before running', async (t) => {
  const { store } = setupStore(t)
  const queue = createTicketQueue({ openStore: () => store, maxWorkers: 2, humanReserve: 1 })
  t.after(() => queue.stop())

  const ticket = makeTicket(store, 'Versioned')
  store.update(ticket.id, { nextStep: 'Step 2' }, { expectedRevision: 1 })

  await assert.rejects(
    queue.enqueue({ ticketId: ticket.id, expectedRevision: 1, run: async () => 'should not run' }),
    /Revision conflict/,
  )

  const ok = await queue.enqueue({ ticketId: ticket.id, expectedRevision: 2, run: async () => 'ran-v2' })
  assert.equal(ok, 'ran-v2')
})

test('human reserve slot bypasses saturated normal slots and jumps ahead per ticket', async (t) => {
  const { store } = setupStore(t)
  const queue = createTicketQueue({ openStore: () => store, maxWorkers: 2, humanReserve: 1 })
  t.after(() => queue.stop())

  const t1 = makeTicket(store, 'Busy 1')
  const t2 = makeTicket(store, 'Busy 2')
  const t3 = makeTicket(store, 'Queued Normal')
  const t4 = makeTicket(store, 'Human Priority')

  let releaseNormal1
  let releaseNormal2
  const gate1 = new Promise(resolve => { releaseNormal1 = resolve })
  const gate2 = new Promise(resolve => { releaseNormal2 = resolve })

  const order = []
  const p1 = queue.enqueue({
    ticketId: t1.id,
    run: async () => {
      order.push('start:t1-normal-1')
      await gate1
      order.push('end:t1-normal-1')
      return 1
    },
  })
  const p2 = queue.enqueue({
    ticketId: t2.id,
    run: async () => {
      order.push('start:t2-normal')
      await gate2
      order.push('end:t2-normal')
      return 2
    },
  })

  // Queue another normal job on t1 AND a human-priority job on t1.
  const p1NormalQueued = queue.enqueue({
    ticketId: t1.id,
    priority: 'normal',
    run: async () => {
      order.push('start:t1-normal-2')
      return 'n2'
    },
  })
  const p1HumanQueued = queue.enqueue({
    ticketId: t1.id,
    priority: 'human',
    run: async () => {
      order.push('start:t1-human')
      return 'h1'
    },
  })

  // Normal queue for t3 must wait while maxWorkers=2 is full, but human job on t4 runs immediately via +1 reserve.
  const p3Normal = queue.enqueue({
    ticketId: t3.id,
    priority: 'normal',
    run: async () => {
      order.push('start:t3-normal')
      return 'n3'
    },
  })
  const p4Human = queue.enqueue({
    ticketId: t4.id,
    priority: 'human',
    run: async () => {
      order.push('start:t4-human')
      return 'h4'
    },
  })

  assert.equal(await p4Human, 'h4', 'human reserve slot ran while normal slots were saturated')
  assert.ok(!order.includes('start:t3-normal'), 'normal task t3 waits until a normal slot opens')
  assert.equal(queue.stats().runningNormal, 2)

  releaseNormal1()
  await p1
  await p1HumanQueued
  releaseNormal2()
  await Promise.all([p2, p1NormalQueued, p3Normal])

  assert.ok(order.indexOf('start:t1-human') < order.indexOf('start:t1-normal-2'), 'human waiter jumps ahead on same ticket')
})

test('submitAssignment, effect pump retry, and startup crash recovery stay reliable across restarts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-queue-recover-'))
  const dbPath = join(dir, 'tickets.sqlite')
  let store1
  let store2
  let queue2
  t.after(() => {
    queue2?.stop()
    try { store1?.close() } catch {}
    store2?.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  let nowMs = 10_000
  const clock = { now: () => nowMs }

  store1 = createTicketStore(dbPath)
  const ticket = makeTicket(store1, 'Recoverable')
  const { assignment, effect } = store1.dispatchWithEffect({
    ticketId: ticket.id,
    prompt: 'Do background check',
    idempotencyKey: 'bg-1',
    maxAttempts: 3,
    now: nowMs,
  })
  store1.claimDueEffects({ now: nowMs })
  store1.startAssignment(assignment.id, { workerSessionId: `worker-${ticket.id}-1`, now: nowMs })
  store1.close()
  store1 = undefined

  // Simulate host restart with fresh store & queue.
  nowMs = 20_000
  store2 = createTicketStore(dbPath)
  queue2 = createTicketQueue({ openStore: () => store2, clock })

  const recovery = queue2.recoverOnStartup({ now: nowMs, note: 'Host restarted mid-run' })
  assert.equal(recovery.interruptedAssignments.length, 1)
  assert.equal(recovery.requeuedEffects[0].id, effect.id)
  assert.equal(recovery.recoveryEffects.length, 1)

  const seen = []
  let failDispatchOnce = true
  queue2.registerEffectHandler('dispatch_assignment', async (eff) => {
    seen.push(`dispatch:${eff.id}`)
    if (failDispatchOnce) {
      failDispatchOnce = false
      throw new Error('transient error')
    }
  })
  queue2.registerEffectHandler('recover_assignment', async (eff) => {
    seen.push(`recover:${eff.id}:${eff.payload.recoveryNote}`)
  })

  await queue2.drain()
  const afterFail = store2.getEffect(effect.id)
  assert.equal(afterFail.status, 'pending')
  assert.equal(afterFail.attempts, 1)
  assert.ok(afterFail.nextRunAt > nowMs)

  // Advance clock past backoff and pump again.
  nowMs = afterFail.nextRunAt + 1
  const pumped = await queue2.pumpEffects({ now: nowMs })
  assert.equal(pumped.claimed, 1)
  assert.equal(pumped.completed, 1)
  assert.equal(store2.getEffect(effect.id).status, 'done')
  assert.ok(seen.some(line => line.includes('Host restarted mid-run')))

  // submitAssignment dispatches and completes cleanly.
  const sub = queue2.submitAssignment({ ticketId: ticket.id, idempotencyKey: 'bg-2', prompt: 'Second pass' })
  await queue2.drain()
  assert.equal(store2.getEffect(sub.effect.id).status, 'done')
})

test('install attaches rt.ticketQueue lazily without creating tickets.sqlite upfront', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-queue-install-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['m1'],
    revision: 1,
    bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief', createdAt: 1 } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))
  const ctx = fakeContext({})
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  assert.ok(rt.ticketQueue)
  assert.equal(existsSync(join(home, 'tickets.sqlite')), false, 'startup does not create empty tickets.sqlite')
})
