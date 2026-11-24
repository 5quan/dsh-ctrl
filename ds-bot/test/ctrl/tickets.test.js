import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createRuntime } from '../../index.js'
import {
  ASSIGNMENT_STATUSES,
  createTicketStore,
  EFFECT_STATUSES,
  formatActiveTicketsSummary,
  isValidTransition,
} from '../../src/host/ctrl/tickets.js'
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

function startTeam(t, state = TEAM) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-tickets-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext({})
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const tool = name => rt.teamTools.find(item => item.name === name)
  const run = (name, args, botId) => tool(name).execute(args, { agent: { id: botId } })
  return { home, ctx, rt, run }
}

test('ticket store persists CRUD, enforces state transitions and optimistic locking across restarts', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-ticket-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  const dbPath = join(dir, 'tickets.sqlite')

  assert.equal(isValidTransition('open', 'in_progress'), true)
  assert.equal(isValidTransition('in_progress', 'review'), true)
  assert.equal(isValidTransition('review', 'done'), true)
  assert.equal(isValidTransition('in_progress', 'failed'), true)
  assert.equal(isValidTransition('done', 'open'), false)
  assert.equal(isValidTransition('failed', 'in_progress'), false)
  assert.equal(isValidTransition('cancelled', 'in_progress'), false)

  const store1 = createTicketStore(dbPath)
  const dueAt = Date.parse('2026-12-01T12:00:00.000Z')
  const created = store1.create({
    title: 'Ship Ticket Engine',
    goal: 'Persist long-horizon tasks in SQLite and inject active summaries into handoffs.',
    mandate: 'May modify ds-bot/src/host and tests; ask user before changing dsh-Go.',
    acceptance: 'machine: npm test passes; human: user reviews bot-dev output',
    ownerBotId: 'm1',
    createdByBotId: 'm1',
    nextStep: 'Write unit tests',
    waitingOn: 'external_event',
    wakeCondition: 'CI webhook build.passed',
    deadline: '2026-12-01T12:00:00.000Z',
    artifacts: ['ds-bot/src/host/ctrl/tickets.js'],
  })
  assert.match(created.id, /^tkt-[0-9a-f]{8}$/)
  assert.equal(created.status, 'open')
  assert.equal(created.revision, 1)
  assert.equal(created.acceptance, 'machine: npm test passes; human: user reviews bot-dev output')
  assert.equal(created.waitingOn, 'external_event')
  assert.equal(created.wakeCondition, 'CI webhook build.passed')
  assert.equal(created.deadline, dueAt)
  assert.deepEqual(created.artifacts, ['ds-bot/src/host/ctrl/tickets.js'])
  assert.equal(store1.listDue(dueAt - 1).length, 0)
  assert.deepEqual(store1.listDue(dueAt).map(tkt => tkt.id), [created.id])

  // Validation rejects empty required fields, invalid deadline, or terminal initial status.
  assert.throws(() => store1.create({ title: '', goal: 'x', ownerBotId: 'm1', createdByBotId: 'm1' }), /title/)
  assert.throws(() => store1.create({ title: 'x', goal: 'y', status: 'done', ownerBotId: 'm1', createdByBotId: 'm1' }), /Initial status/)
  assert.throws(() => store1.create({ title: 'x', goal: 'y', status: 'failed', ownerBotId: 'm1', createdByBotId: 'm1' }), /Initial status/)
  assert.throws(() => store1.create({ title: 'x', goal: 'y', deadline: 'not-a-date', ownerBotId: 'm1', createdByBotId: 'm1' }), /Invalid deadline/)

  const updated = store1.update(created.id, {
    status: 'in_progress',
    nextStep: 'Wire parts.js handoff injection',
    blockers: 'Waiting for review',
    waitingOn: 'user',
    wakeCondition: 'user approves PR',
    deadline: '',
  }, { expectedRevision: 1 })
  assert.equal(updated.status, 'in_progress')
  assert.equal(updated.revision, 2)
  assert.equal(updated.nextStep, 'Wire parts.js handoff injection')
  assert.equal(updated.waitingOn, 'user')
  assert.equal(updated.deadline, null)

  // Stale expectedRevision is rejected.
  assert.throws(
    () => store1.update(created.id, { nextStep: 'stale write' }, { expectedRevision: 1 }),
    /Revision conflict/,
  )
  store1.close()

  // Reopen database after simulated restart: state survives intact.
  const store2 = createTicketStore(dbPath)
  try {
    const reloaded = store2.get(created.id)
    assert.equal(reloaded.id, created.id)
    assert.equal(reloaded.status, 'in_progress')
    assert.equal(reloaded.revision, 2)
    assert.equal(reloaded.mandate, created.mandate)
    assert.equal(reloaded.nextStep, 'Wire parts.js handoff injection')

    const done = store2.update(created.id, { status: 'done', blockers: '' }, { expectedRevision: 2 })
    assert.equal(done.status, 'done')
    assert.equal(done.revision, 3)

    // Terminal states cannot be modified or reopened.
    assert.throws(() => store2.update(created.id, { status: 'open' }), /already done/)
    assert.throws(() => store2.update(created.id, { nextStep: 'more work' }), /already done/)
    assert.equal(store2.list({ activeOnly: true }).length, 0)
    assert.equal(store2.list().length, 1)
  } finally {
    store2.close()
  }
})

test('ticket tools enforce Main Bot, ordinary Worker, and private Bot boundaries', async (t) => {
  const { run } = startTeam(t)

  // Ordinary Bot cannot create tickets.
  assert.match(await run('ticket_create', { title: 'Unauthorized', goal: 'Nope' }, 'b2'), /Only a Main Bot/)

  // Main Bot cannot assign a ticket to a private Bot.
  assert.match(await run('ticket_create', { title: 'Leak', goal: 'Nope', owner: 'Diary' }, 'm1'), /private Bot Diary/)

  // Main Bot creates one ticket for itself and one for Coder.
  const outChief = await run('ticket_create', {
    title: 'Quarterly Roadmap',
    goal: 'Draft Q4 roadmap',
    mandate: 'Read-only research; confirm before sharing externally',
  }, 'm1')
  const chiefId = /Ticket (tkt-[0-9a-f]{8})/.exec(outChief)?.[1]
  assert.ok(chiefId, outChief)

  const outCoder = await run('ticket_create', {
    title: 'Fix Parser Bug',
    goal: 'Handle escaped quotes',
    mandate: 'Only edit parser.js and tests',
    owner: 'Coder',
    next_step: 'Reproduce failure',
  }, 'm1')
  const coderId = /Ticket (tkt-[0-9a-f]{8})/.exec(outCoder)?.[1]
  assert.ok(coderId, outCoder)

  // Coder sees only its own ticket, not Chief's.
  const coderList = await run('ticket_list', {}, 'b2')
  assert.match(coderList, new RegExp(coderId))
  assert.doesNotMatch(coderList, new RegExp(chiefId))
  assert.match(await run('ticket_get', { id: chiefId }, 'b2'), /Ticket not found/)

  // Coder cannot alter goal, mandate, acceptance, owner, title, or cancel its ticket.
  assert.match(await run('ticket_update', { id: coderId, mandate: 'Full access' }, 'b2'), /Permission denied/)
  assert.match(await run('ticket_update', { id: coderId, acceptance: 'Skip tests' }, 'b2'), /Permission denied/)
  assert.match(await run('ticket_update', { id: coderId, status: 'cancelled' }, 'b2'), /Permission denied/)
  assert.match(await run('ticket_update', { id: coderId, goal: 'Something else' }, 'b2'), /Permission denied/)

  // Coder CAN update its own progress fields, wait metadata, and status (non-cancelled).
  const coderProgress = await run('ticket_update', {
    id: coderId,
    expected_revision: 1,
    status: 'review',
    next_step: 'Await independent review',
    waiting_on: 'user',
    wake_condition: 'review approved',
    artifacts: ['src/parser.js'],
  }, 'b2')
  assert.match(coderProgress, /Status: review/)
  assert.match(coderProgress, /Waiting on: user/)
  assert.match(coderProgress, /rev 2/)

  // Private Bot can create and manage its own private ticket, isolated from everyone else.
  assert.match(await run('ticket_create', { title: 'Private Note', goal: 'Keep private', owner: 'Chief' }, 'p1'), /only create tickets owned by itself/)
  const outPrivate = await run('ticket_create', {
    title: 'Personal Taxes',
    goal: 'Organize receipts',
    mandate: 'Never share outside Diary',
  }, 'p1')
  const privateId = /Ticket (tkt-[0-9a-f]{8})/.exec(outPrivate)?.[1]
  assert.ok(privateId, outPrivate)

  // Chief cannot see or touch Diary's private ticket; Diary cannot see team tickets.
  const chiefList = await run('ticket_list', {}, 'm1')
  assert.match(chiefList, new RegExp(chiefId))
  assert.match(chiefList, new RegExp(coderId))
  assert.doesNotMatch(chiefList, new RegExp(privateId))
  assert.match(await run('ticket_get', { id: privateId }, 'm1'), /Ticket not found/)
  assert.match(await run('ticket_update', { id: privateId, status: 'cancelled' }, 'm1'), /Ticket not found/)

  const diaryList = await run('ticket_list', {}, 'p1')
  assert.match(diaryList, new RegExp(privateId))
  assert.doesNotMatch(diaryList, new RegExp(chiefId))
  assert.doesNotMatch(diaryList, new RegExp(coderId))
})

test('handoff injects active tickets as reference state without mutating system prompt or leaking closed tickets', async (t) => {
  const { ctx, rt, run } = startTeam(t)

  // Before any ticket exists, summary is undefined (no overhead or handoff diff).
  assert.equal(rt.activeTicketsSummary('m1'), undefined)

  const activeOut = await run('ticket_create', {
    title: 'Migrate Auth Service',
    goal: 'Move session tokens to SQLite',
    mandate: 'Do not touch production DB without user approval',
    status: 'in_progress',
    next_step: 'Run staging migration',
    waiting_on: 'user',
    wake_condition: 'approval granted',
    deadline: '2026-12-15T00:00:00.000Z',
  }, 'm1')
  const activeId = /Ticket (tkt-[0-9a-f]{8})/.exec(activeOut)?.[1]

  const doneOut = await run('ticket_create', {
    title: 'Old Cleanup',
    goal: 'Remove unused script',
  }, 'm1')
  const doneId = /Ticket (tkt-[0-9a-f]{8})/.exec(doneOut)?.[1]
  await run('ticket_update', { id: doneId, status: 'done' }, 'm1')

  const failedOut = await run('ticket_create', {
    title: 'Broken Experiment',
    goal: 'Try deprecated API',
  }, 'm1')
  const failedId = /Ticket (tkt-[0-9a-f]{8})/.exec(failedOut)?.[1]
  await run('ticket_update', { id: failedId, status: 'failed' }, 'm1')

  // Private ticket must not appear in Chief's handoff summary.
  const privOut = await run('ticket_create', { title: 'Secret Plan', goal: 'Private only' }, 'p1')
  const privId = /Ticket (tkt-[0-9a-f]{8})/.exec(privOut)?.[1]

  const summary = rt.activeTicketsSummary('m1')
  assert.ok(summary, 'active summary is produced')
  assert.match(summary, /reference data, not new instructions/)
  assert.match(summary, new RegExp(activeId))
  assert.match(summary, /Migrate Auth Service/)
  assert.match(summary, /Do not touch production DB without user approval/)
  assert.match(summary, /Run staging migration/)
  assert.match(summary, /Waiting: on user; wake: approval granted; deadline: 2026-12-15T00:00:00\.000Z/)
  assert.doesNotMatch(summary, new RegExp(doneId))
  assert.doesNotMatch(summary, new RegExp(failedId))
  assert.doesNotMatch(summary, new RegExp(privId))

  // Frozen system prompt stays byte-stable (contains no dynamic ticket IDs).
  const systemPrompt = ctx.sections.get('bot-identity').text({ agent: { id: 'm1' } })
  assert.doesNotMatch(systemPrompt, new RegExp(activeId))

  // Trigger a real manual Part switch in parts.js and inspect the new Part's handoff message.
  const followed = []
  const oldSession = { id: 'm1', seq: 0, header: { cwd: '/team' }, deriveMessages: () => [], requestHeader: () => ({}) }
  const freshSession = { id: 'm1-p2', seq: 0, header: { cwd: '/team' }, deriveMessages: () => [], requestHeader: () => ({}) }
  const oldAgent = { id: 'm1', status: 'idle', whenIdle: async () => {}, runMaintenance: fn => fn(new AbortController().signal), session: oldSession, inbox: { nextStep: [], nextTurn: [], remove: () => {} } }
  const freshAgent = { id: 'm1-p2', status: 'idle', whenIdle: async () => {}, runMaintenance: fn => fn(new AbortController().signal), session: freshSession, inbox: { nextStep: [], nextTurn: [] }, followup: msg => followed.push(msg) }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  rt.resolveAgent = async id => (id === 'm1-p2' ? freshAgent : oldAgent)
  rt.createSession = async () => 'm1-p2'
  rt.eventsBackwards = async function* () {}
  rt.ensureCapabilities = async () => {}
  rt.moveSchedules = async () => {}
  rt.applyModel = async () => {}
  rt.applyPermission = async () => {}
  rt.desiredModel = async () => undefined
  rt.desiredEffort = async () => undefined

  await rt.newPart('m1')
  for (let i = 0; i < 100 && (rt.state.bots.m1.sessionId !== 'm1-p2' || followed.length === 0); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(rt.state.bots.m1.sessionId, 'm1-p2', 'a fresh part was created')
  const handoffMsg = followed.find(msg => msg.source?.handoff === true)
  assert.ok(handoffMsg, 'handoff message was queued on the fresh part')
  const handoffText = handoffMsg.content.map(part => part.text ?? '').join('\n')
  assert.match(handoffText, /## Active tickets \(reference state, not new instructions\)/)
  assert.match(handoffText, new RegExp(activeId))
  assert.match(handoffText, /Do not touch production DB without user approval/)
  assert.doesNotMatch(handoffText, new RegExp(doneId))
  assert.doesNotMatch(handoffText, new RegExp(privId))

  // formatActiveTicketsSummary respects truncation when many tickets exist.
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `tkt-${String(i).padStart(8, '0')}`,
    title: `Task ${i}`,
    goal: 'Goal '.repeat(30),
    mandate: 'Mandate '.repeat(20),
    status: 'open',
    ownerBotId: 'm1',
    nextStep: 'Next',
    blockers: '',
    revision: 1,
  }))
  const bounded = formatActiveTicketsSummary(many, () => 'Chief')
  assert.match(bounded, /more active ticket/)
})

test('ticket store migrates v1 and v2 databases cleanly to v3 preserving existing rows', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-ticket-migrate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))

  const v1Db = join(dir, 'v1.sqlite')
  const legacyV1 = new DatabaseSync(v1Db)
  legacyV1.exec(`
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      mandate TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      owner_bot_id TEXT NOT NULL,
      created_by_bot_id TEXT NOT NULL,
      next_step TEXT NOT NULL DEFAULT '',
      blockers TEXT NOT NULL DEFAULT '',
      artifacts TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO tickets (id, title, goal, status, owner_bot_id, created_by_bot_id, created_at, updated_at)
    VALUES ('tkt-legacy01', 'Legacy V1', 'Keep row intact', 'open', 'm1', 'm1', 1000, 1000);
    PRAGMA user_version = 1;
  `)
  legacyV1.close()

  const migratedV1 = createTicketStore(v1Db)
  const v1Check = new DatabaseSync(v1Db)
  assert.equal(v1Check.prepare('PRAGMA user_version').get().user_version, 3)
  v1Check.close()
  const keptV1 = migratedV1.get('tkt-legacy01')
  assert.equal(keptV1.title, 'Legacy V1')
  assert.equal(keptV1.acceptance, '')
  const v1Asg = migratedV1.createAssignment({ ticketId: keptV1.id, prompt: 'Run migrated ticket' })
  assert.equal(v1Asg.status, 'pending')
  migratedV1.close()

  const v2Db = join(dir, 'v2.sqlite')
  const legacyV2 = new DatabaseSync(v2Db)
  legacyV2.exec(`
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      mandate TEXT NOT NULL DEFAULT '',
      acceptance TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      owner_bot_id TEXT NOT NULL,
      created_by_bot_id TEXT NOT NULL,
      next_step TEXT NOT NULL DEFAULT '',
      blockers TEXT NOT NULL DEFAULT '',
      waiting_on TEXT NOT NULL DEFAULT '',
      wake_condition TEXT NOT NULL DEFAULT '',
      deadline INTEGER,
      artifacts TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO tickets (id, title, goal, mandate, status, owner_bot_id, created_by_bot_id, created_at, updated_at)
    VALUES ('tkt-legacy02', 'Legacy V2', 'Preserve v2 row', 'Read-only', 'in_progress', 'm1', 'm1', 2000, 2000);
    PRAGMA user_version = 2;
  `)
  legacyV2.close()

  const migratedV2 = createTicketStore(v2Db)
  const v2Check = new DatabaseSync(v2Db)
  assert.equal(v2Check.prepare('PRAGMA user_version').get().user_version, 3)
  v2Check.close()
  const keptV2 = migratedV2.get('tkt-legacy02')
  assert.equal(keptV2.mandate, 'Read-only')
  const dispatched = migratedV2.dispatchWithEffect({ ticketId: keptV2.id, idempotencyKey: 'mig-v2-key' })
  assert.equal(dispatched.deduplicated, false)
  assert.equal(dispatched.assignment.mandateSnapshot, 'Read-only')
  migratedV2.close()
})

test('assignments, effects backoff/dead-letter, and recoverInterrupted survive simulated host restarts', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-ticket-v3-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  const dbPath = join(dir, 'tickets.sqlite')

  assert.deepEqual(ASSIGNMENT_STATUSES, ['pending', 'running', 'ended', 'interrupted'])
  assert.deepEqual(EFFECT_STATUSES, ['pending', 'running', 'done', 'dead'])

  const store1 = createTicketStore(dbPath)
  const ticket = store1.create({
    title: 'Background Build',
    goal: 'Build and verify module',
    mandate: 'Only touch ds-bot/',
    ownerBotId: 'm1',
    createdByBotId: 'm1',
  })

  // Atomic dispatchWithEffect deduplicates by idempotencyKey.
  const first = store1.dispatchWithEffect({
    ticketId: ticket.id,
    priority: 'human',
    triggerKind: 'manual',
    triggerRef: 'msg-1',
    prompt: 'Execute task now',
    idempotencyKey: 'dispatch:req-1',
    maxAttempts: 3,
    now: 1000,
  })
  assert.equal(first.deduplicated, false)
  assert.equal(first.assignment.status, 'pending')
  assert.equal(first.assignment.priority, 'human')
  assert.equal(first.assignment.ticketRevision, 1)
  assert.equal(first.assignment.mandateSnapshot, 'Only touch ds-bot/')
  assert.equal(first.effect.status, 'pending')

  const duplicate = store1.dispatchWithEffect({
    ticketId: ticket.id,
    idempotencyKey: 'dispatch:req-1',
    now: 1100,
  })
  assert.equal(duplicate.deduplicated, true)
  assert.equal(duplicate.assignment.id, first.assignment.id)
  assert.equal(duplicate.effect.id, first.effect.id)
  assert.equal(store1.listAssignments({ ticketId: ticket.id }).length, 1)

  // Start assignment & claim effect cleanly.
  const claimed = store1.claimDueEffects({ now: 1200 })
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].status, 'running')
  const runningAsg = store1.startAssignment(first.assignment.id, { workerSessionId: `worker-${ticket.id}-1`, now: 1200 })
  assert.equal(runningAsg.status, 'running')
  assert.equal(runningAsg.workerSessionId, `worker-${ticket.id}-1`)
  store1.updateAssignmentUsage(runningAsg.id, { stepCount: 4, tokenUsage: 1500, now: 1250 })

  // Separate effect tests exponential backoff up to dead-letter after 3 failures.
  const { effect: retryEff } = store1.enqueueEffect({
    kind: 'notify_chief',
    ticketId: ticket.id,
    idempotencyKey: 'notify:1',
    payload: { msg: 'ping' },
    maxAttempts: 3,
    runAt: 1000,
    now: 1000,
  })
  assert.equal(store1.claimDueEffects({ now: 1200, kinds: ['notify_chief'] }).length, 1)
  const fail1 = store1.failEffect(retryEff.id, 'network timeout', { now: 2000, baseDelayMs: 500, maxDelayMs: 5000 })
  assert.equal(fail1.status, 'pending')
  assert.equal(fail1.attempts, 1)
  assert.equal(fail1.nextRunAt, 2500)

  // Not due before 2500.
  assert.equal(store1.claimDueEffects({ now: 2499, kinds: ['notify_chief'] }).length, 0)
  assert.equal(store1.claimDueEffects({ now: 2500, kinds: ['notify_chief'] }).length, 1)
  const fail2 = store1.failEffect(retryEff.id, 'still down', { now: 3000, baseDelayMs: 500, maxDelayMs: 5000 })
  assert.equal(fail2.status, 'pending')
  assert.equal(fail2.attempts, 2)
  assert.equal(fail2.nextRunAt, 4000)

  assert.equal(store1.claimDueEffects({ now: 4000, kinds: ['notify_chief'] }).length, 1)
  const fail3 = store1.failEffect(retryEff.id, 'permanent failure', { now: 4100, baseDelayMs: 500, maxDelayMs: 5000 })
  assert.equal(fail3.status, 'dead')
  assert.equal(fail3.attempts, 3)
  assert.equal(fail3.completedAt, 4100)

  // Complete a separate assignment normally to verify ended state is untouched by crash recovery.
  const finishedAsg = store1.createAssignment({ ticketId: ticket.id, prompt: 'Quick check', now: 4200 })
  store1.startAssignment(finishedAsg.id, { workerSessionId: `worker-${ticket.id}-2`, now: 4210 })
  const endedAsg = store1.completeAssignment(finishedAsg.id, {
    reportStatus: 'review',
    reportSummary: 'Checks passed',
    reportArtifacts: ['artifact://art-1'],
    stepCount: 2,
    tokenUsage: 400,
    now: 4300,
  })
  assert.equal(endedAsg.status, 'ended')
  assert.equal(endedAsg.reportStatus, 'review')

  store1.close()

  // Simulate host restart: reopen SQLite and recover interrupted running assignment & effect.
  const store2 = createTicketStore(dbPath)
  try {
    const recovered = store2.recoverInterrupted({ now: 9000, note: 'Recovered after power loss' })
    assert.equal(recovered.interruptedAssignments.length, 1)
    assert.equal(recovered.interruptedAssignments[0].id, first.assignment.id)
    assert.equal(recovered.interruptedAssignments[0].status, 'interrupted')
    assert.equal(recovered.interruptedAssignments[0].recoveryNote, 'Recovered after power loss')
    assert.equal(recovered.requeuedEffects.length, 1)
    assert.equal(recovered.requeuedEffects[0].id, first.effect.id)
    assert.equal(recovered.requeuedEffects[0].status, 'pending')
    assert.equal(recovered.recoveryEffects.length, 1)
    assert.equal(recovered.recoveryEffects[0].kind, 'recover_assignment')
    assert.equal(recovered.recoveryEffects[0].payload.previousRevision, 1)
    assert.equal(recovered.recoveryEffects[0].payload.recoveryNote, 'Recovered after power loss')

    // Re-running recoverInterrupted when nothing is running is a no-op.
    const secondRecover = store2.recoverInterrupted({ now: 9500 })
    assert.equal(secondRecover.interruptedAssignments.length, 0)
    assert.equal(secondRecover.requeuedEffects.length, 0)
    assert.equal(secondRecover.recoveryEffects.length, 0)

    // Ended assignment stayed ended.
    assert.equal(store2.getAssignment(finishedAsg.id).status, 'ended')
    assert.equal(store2.getAssignment(first.assignment.id).stepCount, 4)
  } finally {
    store2.close()
  }
})
