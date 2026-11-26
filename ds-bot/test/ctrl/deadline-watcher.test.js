import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../../index.js'
import {
  DEFAULT_IN_PROGRESS_STALE_MS,
  DEFAULT_REMINDER_COOLDOWN_MS,
  DEFAULT_REVIEW_STALE_MS,
  DEFAULT_UPCOMING_LEAD_MS,
  DEFAULT_WAITING_USER_STALE_MS,
  evaluateTicketWatch,
  parseTimeWakeCondition,
} from '../../src/host/ctrl/deadline-watcher.js'
import { fakeContext } from '../fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Helper', role: 'Dev', createdAt: 2 },
    p1: { id: 'p1', sessionId: 'p1', name: 'Diary', role: 'Private', private: true, createdAt: 3 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function setupWatcherHarness(t, { home: existingHome, config = {}, workerHandler } = {}) {
  const ownHome = !existingHome
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'ds-bot-deadline-'))
  const teamWorkspace = join(home, 'workspace')
  if (ownHome) {
    mkdirSync(teamWorkspace, { recursive: true })
    writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, workspaceId: 'ws-team' }))
  }

  const workspaces = new Map([['ws-team', { id: 'ws-team', path: teamWorkspace }]])
  const liveAgents = new Map()
  const deliveries = []
  const followups = []

  let rt
  const ctx = fakeContext({
    services: {
      agentPresets: { list: async () => [{ id: 'standard' }] },
      agents: {
        list: () => [...liveAgents.values()],
        get: id => liveAgents.get(id),
      },
    },
  })

  function ensureAgent(sessionId, { origin, cwd, parentSession } = {}) {
    if (liveAgents.has(sessionId)) return liveAgents.get(sessionId)
    const headerObj = {
      id: sessionId,
      cwd: cwd ?? teamWorkspace,
      ...(origin !== undefined ? { origin } : {}),
      ...(parentSession !== undefined ? { parentSession } : {}),
    }
    const scoped = new Map()
    const idleWaiters = []
    let busy = false

    const agent = {
      id: sessionId,
      session: { id: sessionId, header: Object.freeze(headerObj), deriveMessages: () => [] },
      status: 'idle',
      model: { select: () => {} },
      ctx: {
        tools: {
          register: (toolDef) => {
            scoped.set(toolDef.name, toolDef)
            return () => { scoped.delete(toolDef.name) }
          },
          restrict: () => () => {},
        },
        effect: fn => (typeof fn === 'function' ? fn() : undefined),
        on: () => () => {},
      },
      async whenIdle() {
        if (!busy) return
        await new Promise(resolve => idleWaiters.push(resolve))
      },
      cancel() {
        busy = false
        for (const res of idleWaiters.splice(0)) res()
      },
      followup(message) {
        if (sessionId === 'm1' || sessionId === 'b2' || sessionId === 'p1') {
          followups.push({ sessionId, message })
          return
        }
        busy = true
        const runTurn = async () => {
          const callTool = async (name, args) => {
            const def = scoped.get(name) ?? rt.teamTools.find(item => item.name === name)
            if (!def) throw new Error(`Tool ${name} not available on ${sessionId}`)
            return await def.execute(args, { agent, name, callId: `call-${name}` })
          }
          try {
            if (typeof workerHandler === 'function') {
              await workerHandler({ sessionId, agent, message, callTool, rt })
            }
          } finally {
            busy = false
            for (const res of idleWaiters.splice(0)) res()
          }
        }
        queueMicrotask(() => { void runTurn() })
      },
    }
    liveAgents.set(sessionId, agent)
    return agent
  }

  Object.assign(ctx, {
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async path => [...workspaces.values()].find(w => w.path === path),
      create: async (path) => {
        const ws = { id: `ws-${workspaces.size + 1}`, path }
        workspaces.set(ws.id, ws)
        return ws
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async (opts) => {
        const sid = opts.sessionId ?? 'worker-created'
        ensureAgent(sid, { origin: opts.origin, cwd: opts.cwd, parentSession: opts.parentSession })
        return { sessionId: sid }
      },
      resolveAgent: async sessionId => ({ agent: ensureAgent(sessionId) }),
      selectModel: async () => ({ selected: { provider: 'deepseek', model: 'deepseek-chat' } }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })

  ensureAgent('m1')
  ensureAgent('b2')
  ensureAgent('p1')

  rt = createRuntime(ctx, {
    home,
    memory: false,
    ctrl: {
      effectPollMs: 40,
      deadlinePollMs: 3_600_000,
      deadlineStartupDelayMs: 3_600_000,
      ...config.ctrl,
    },
  })
  rt.desiredModel = async () => 'deepseek/deepseek-chat'
  rt.ensureCapabilities = async () => {}
  rt.deliver = async (payload) => {
    deliveries.push(payload)
    return `ex-${deliveries.length}`
  }

  if (ownHome) {
    t.after(async () => {
      await ctx.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    })
  }

  return { home, ctx, rt, deliveries, followups }
}

test('parseTimeWakeCondition and evaluateTicketWatch enforce time rules, priorities, and waiting_user safety', () => {
  const due = 2_000_000
  assert.deepEqual(parseTimeWakeCondition('', due), { autoDispatch: false, triggerAt: null, mode: 'none' })
  assert.deepEqual(parseTimeWakeCondition('auto_wake', due), { autoDispatch: true, triggerAt: due, mode: 'due' })
  assert.deepEqual(parseTimeWakeCondition('- wake: worker', due), { autoDispatch: true, triggerAt: due, mode: 'due' })
  assert.deepEqual(parseTimeWakeCondition('remind_only\nauto_wake', due), { autoDispatch: false, triggerAt: null, mode: 'remind' })

  const iso = '2026-11-26T10:00:00.000Z'
  assert.deepEqual(parseTimeWakeCondition(`at: ${iso}`, due), {
    autoDispatch: true,
    triggerAt: Date.parse(iso),
    mode: 'scheduled',
  })
  assert.deepEqual(parseTimeWakeCondition('after: 5000', null), {
    autoDispatch: true,
    triggerAt: 5000,
    mode: 'scheduled',
  })

  const baseTicket = {
    id: 'tkt-1',
    title: 'Sample',
    goal: 'Do work',
    status: 'open',
    revision: 1,
    deadline: due,
    wakeCondition: 'auto_wake',
    updatedAt: 1_000_000,
  }

  // Done tickets are ignored.
  assert.equal(evaluateTicketWatch({ ticket: { ...baseTicket, status: 'done' }, now: due + 1000 }), null)

  // Overdue auto-wake ticket dispatches when idle.
  const dispatchDecision = evaluateTicketWatch({ ticket: baseTicket, now: due })
  assert.equal(dispatchDecision.action, 'dispatch')
  assert.equal(dispatchDecision.kind, 'time_wake')

  // Busy ticket does not auto-dispatch or emit stalled alerts, though overdue reminder may still hold if overdue; wait:
  // If already dispatched for (revision, triggerAt), overdue reminder is suppressed? Test deduplication first:
  assert.equal(
    evaluateTicketWatch({
      ticket: baseTicket,
      now: due,
      state: { dispatches: { [dispatchDecision.dispatchKey]: { dispatchedAt: due } } },
    }),
    null,
  )

  // waiting_user and review NEVER auto-dispatch even with auto_wake.
  const waitingDecision = evaluateTicketWatch({
    ticket: { ...baseTicket, status: 'waiting_user' },
    now: due + 10_000,
  })
  assert.equal(waitingDecision.action, 'remind')
  assert.equal(waitingDecision.kind, 'overdue')

  // Overdue takes priority over stalled when both apply.
  const reviewOverdue = evaluateTicketWatch({
    ticket: { ...baseTicket, status: 'review', updatedAt: 0 },
    now: due + DEFAULT_REVIEW_STALE_MS + 1000,
  })
  assert.equal(reviewOverdue.kind, 'overdue')

  assert.equal(DEFAULT_UPCOMING_LEAD_MS, 30 * 60 * 1000)
  assert.equal(DEFAULT_REMINDER_COOLDOWN_MS, 6 * 60 * 60 * 1000)
  assert.equal(DEFAULT_IN_PROGRESS_STALE_MS, 2 * 60 * 60 * 1000)
  assert.equal(DEFAULT_WAITING_USER_STALE_MS, 24 * 60 * 60 * 1000)
})

test('deadlineWatcher preserves lazy tickets.sqlite invariant on startup and empty scanOnce', async (t) => {
  const h = setupWatcherHarness(t)
  assert.equal(h.rt.hasTicketStore(), false)
  const emptyRes = await h.rt.deadlineWatcher.scanOnce()
  assert.deepEqual(emptyRes, { scanned: 0, dispatched: [], reminded: [], skipped: 0 })
  assert.equal(h.rt.hasTicketStore(), false)
  assert.equal(existsSync(join(h.home, 'tickets.sqlite')), false)
  assert.equal(h.deliveries.length, 0)
})

test('deadlineWatcher sends grouped upcoming/overdue alerts with ctrl_meta cooldown across restarts', async (t) => {
  const h1 = setupWatcherHarness(t)
  const store1 = h1.rt.openTicketStore()
  const baseNow = Date.now()

  const tOverdue = store1.create({
    title: 'Submit Tax Report',
    goal: 'File quarterly taxes',
    ownerBotId: 'b2',
    createdByBotId: 'm1',
    deadline: baseNow + 10 * 60 * 1000,
  })
  const tUpcoming = store1.create({
    title: 'Prep Demo Deck',
    goal: 'Finalize slides',
    ownerBotId: 'm1',
    createdByBotId: 'm1',
    deadline: baseNow + 70 * 60 * 1000,
  })

  // At baseNow + 50m: tOverdue is 40m overdue, tUpcoming is due in 20m (within 30m lead) -> 1 grouped Chief delivery!
  const scan1At = baseNow + 50 * 60 * 1000
  const res1 = await h1.rt.deadlineWatcher.scanOnce({ now: scan1At })
  assert.equal(res1.reminded.length, 2)
  assert.equal(h1.deliveries.length, 1, 'multiple alerts for Chief grouped into one message')
  assert.equal(h1.deliveries[0].toId, 'm1')
  assert.equal(h1.deliveries[0].role, 'deadline_watch')
  assert.match(h1.deliveries[0].text, new RegExp(tOverdue.id))
  assert.match(h1.deliveries[0].text, new RegExp(tUpcoming.id))

  // Immediate repeat scan suppresses both upcoming and overdue reminders.
  const resRepeat = await h1.rt.deadlineWatcher.scanOnce({ now: scan1At + 60_000 })
  assert.equal(resRepeat.reminded.length, 0)
  assert.equal(h1.deliveries.length, 1)

  // Simulated restart: dispose h1, open h2 on same home within cooldown (and before tUpcoming hits its 70m deadline) -> suppressed.
  await h1.ctx.dispose()
  const h2 = setupWatcherHarness(t, { home: h1.home })
  try {
    const resAfterRestart = await h2.rt.deadlineWatcher.scanOnce({ now: scan1At + 10 * 60 * 1000 })
    assert.equal(resAfterRestart.reminded.length, 0)
    assert.equal(h2.deliveries.length, 0)

    // Once cooldown elapses (scan1At + 6h + 1m), overdue re-alerts while upcoming for tUpcoming (now overdue too!) alerts as overdue.
    const resAfterCooldown = await h2.rt.deadlineWatcher.scanOnce({
      now: scan1At + DEFAULT_REMINDER_COOLDOWN_MS + 60_000,
    })
    assert.equal(resAfterCooldown.reminded.length, 2)
    assert.equal(h2.deliveries.length, 1)
    assert.match(h2.deliveries[0].text, /\*\*Overdue \(2\)\*\*/)
  } finally {
    await h2.ctx.dispose()
  }
})

test('deadlineWatcher flags stalled in_progress, waiting_user, and review tickets while ignoring busy workers', async (t) => {
  const h = setupWatcherHarness(t)
  const store = h.rt.openTicketStore()
  const baseNow = Date.now()

  const tBusy = store.create({
    title: 'Busy In Progress',
    goal: 'Active worker running',
    status: 'in_progress',
    ownerBotId: 'm1',
    createdByBotId: 'm1',
  })
  store.createAssignment({ ticketId: tBusy.id, prompt: 'Keep working' })

  const tIdleInProgress = store.create({
    title: 'Stalled In Progress',
    goal: 'Forgotten active ticket',
    status: 'in_progress',
    ownerBotId: 'm1',
    createdByBotId: 'm1',
  })
  const tWaitingUser = store.create({
    title: 'Waiting Decision',
    goal: 'Needs approval',
    status: 'waiting_user',
    ownerBotId: 'm1',
    createdByBotId: 'm1',
  })
  const tReview = store.create({
    title: 'Waiting Review',
    goal: 'Review output',
    status: 'review',
    ownerBotId: 'm1',
    createdByBotId: 'm1',
  })

  // At +3h: only tIdleInProgress crosses 2h threshold; tBusy is ignored because assignment is pending/running; waiting_user (24h) & review (12h) not stale yet.
  const scan3h = await h.rt.deadlineWatcher.scanOnce({ now: baseNow + 3 * 3_600_000 })
  assert.deepEqual(scan3h.reminded.map(r => r.ticketId), [tIdleInProgress.id])

  // At +13h: tReview crosses 12h; tIdleInProgress still within 6h cooldown from +3h (at +9h would expire, wait +13h > 3h + 6h so tIdleInProgress also re-alerts).
  const scan13h = await h.rt.deadlineWatcher.scanOnce({ now: baseNow + 13 * 3_600_000 })
  assert.equal(scan13h.reminded.some(r => r.ticketId === tReview.id), true)
  assert.equal(scan13h.reminded.some(r => r.ticketId === tBusy.id), false)
  assert.equal(scan13h.reminded.some(r => r.ticketId === tWaitingUser.id), false)

  // At +25h: tWaitingUser crosses 24h.
  const scan25h = await h.rt.deadlineWatcher.scanOnce({ now: baseNow + 25 * 3_600_000 })
  assert.equal(scan25h.reminded.some(r => r.ticketId === tWaitingUser.id), true)
  assert.equal(scan25h.reminded.some(r => r.ticketId === tBusy.id), false)
})

test('deadlineWatcher deterministically auto-dispatches time_wake open/blocked tickets once and never dispatches waiting_user/review', async (t) => {
  const dispatchedPrompts = []
  const h1 = setupWatcherHarness(t, {
    workerHandler: async ({ message, callTool }) => {
      dispatchedPrompts.push(message.content[0].text)
      await callTool('ticket_report', { status: 'waiting_user', summary: 'Paused for confirmation after auto-wake' })
    },
  })
  const store1 = h1.rt.openTicketStore()
  const baseNow = Date.now()
  const dueAt = baseNow + 5 * 60_000
  const scheduledAt = baseNow + 8 * 60_000

  const tAutoDue = store1.create({
    title: 'Auto Wake Due',
    goal: 'Run report on deadline',
    ownerBotId: 'm1',
    createdByBotId: 'm1',
    deadline: dueAt,
    wakeCondition: 'auto_wake',
  })
  const tScheduled = store1.create({
    title: 'Scheduled Blocked Wake',
    goal: 'Retry after maintenance window',
    status: 'blocked',
    ownerBotId: 'm1',
    createdByBotId: 'm1',
    wakeCondition: `at: ${new Date(scheduledAt).toISOString()}`,
  })
  const tWaitingUser = store1.create({
    title: 'Human Gate Only',
    goal: 'Never auto dispatch',
    status: 'waiting_user',
    ownerBotId: 'm1',
    createdByBotId: 'm1',
    deadline: dueAt,
    wakeCondition: 'auto_wake',
  })

  const scanAt = baseNow + 10 * 60_000
  const res = await h1.rt.deadlineWatcher.scanOnce({ now: scanAt })
  await h1.rt.ticketQueue.drain()

  assert.deepEqual(res.dispatched.map(d => d.ticketId).sort(), [tAutoDue.id, tScheduled.id].sort())
  assert.equal(dispatchedPrompts.length, 2)
  assert.match(dispatchedPrompts[0], /Auto-Wake/)

  // waiting_user must NEVER auto-dispatch; it only receives an overdue reminder.
  assert.deepEqual(res.reminded.map(r => r.ticketId), [tWaitingUser.id])
  assert.equal(store1.listAssignments({ ticketId: tWaitingUser.id }).length, 0)

  // Repeat scan + restart must NOT re-dispatch already triggered tickets (note: worker moved tAutoDue/tScheduled to waiting_user too,
  // and even if a ticket stays open/blocked with same revision, dispatchKey blocks duplicates across restarts).
  const tStayOpen = store1.create({
    title: 'Persistent Key Check',
    goal: 'Check idempotency',
    ownerBotId: 'm1',
    createdByBotId: 'm1',
    deadline: dueAt,
    wakeCondition: 'auto_wake',
  })
  await h1.rt.deadlineWatcher.scanOnce({ now: scanAt })
  await h1.rt.ticketQueue.drain()
  assert.equal(store1.listAssignments({ ticketId: tStayOpen.id }).length, 1)

  await h1.ctx.dispose()
  const h2 = setupWatcherHarness(t, { home: h1.home })
  try {
    const res2 = await h2.rt.deadlineWatcher.scanOnce({ now: scanAt + 60_000 })
    assert.equal(res2.dispatched.length, 0)
    assert.equal(h2.rt.openTicketStore().listAssignments({ ticketId: tStayOpen.id }).length, 1)
  } finally {
    await h2.ctx.dispose()
  }
})

test('deadlineWatcher isolates private Bot alerts from Chief', async (t) => {
  const h = setupWatcherHarness(t)
  const store = h.rt.openTicketStore()
  const baseNow = Date.now()

  const privTicket = store.create({
    title: 'Private Renewal',
    goal: 'Secret diary reminder',
    ownerBotId: 'p1',
    createdByBotId: 'p1',
    deadline: baseNow - 60_000,
  })
  const teamTicket = store.create({
    title: 'Team Deploy',
    goal: 'Deploy release',
    ownerBotId: 'b2',
    createdByBotId: 'm1',
    deadline: baseNow - 60_000,
  })

  const res = await h.rt.deadlineWatcher.scanOnce({ now: baseNow })
  assert.equal(res.reminded.length, 2)
  assert.equal(h.deliveries.length, 2)

  const privDelivery = h.deliveries.find(d => d.toId === 'p1')
  const chiefDelivery = h.deliveries.find(d => d.toId === 'm1')
  assert.ok(privDelivery, 'private Bot gets its own deadline reminder')
  assert.ok(chiefDelivery, 'Chief gets team deadline reminder')
  assert.match(privDelivery.text, new RegExp(privTicket.id))
  assert.doesNotMatch(chiefDelivery.text, new RegExp(privTicket.id), 'Chief never sees private Bot ticket')
  assert.match(chiefDelivery.text, new RegExp(teamTicket.id))
})
