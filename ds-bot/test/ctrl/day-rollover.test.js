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
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function setupRolloverHarness(t, initialStatus = 'idle') {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-rollover-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, memory: false })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  let llmCalls = 0
  let historyReads = 0
  let createCalls = 0
  const movedSchedules = []
  const archived = []
  const followed = []

  const oldSession = { id: 'm1', seq: 0, header: { cwd: '/team' }, deriveMessages: () => [], requestHeader: () => ({}) }
  const freshSession = { id: 'm1-p2', seq: 0, header: { cwd: '/team' }, deriveMessages: () => [], requestHeader: () => ({}) }
  const oldAgent = {
    id: 'm1',
    status: initialStatus,
    whenIdle: async () => {},
    runMaintenance: fn => fn(new AbortController().signal),
    session: oldSession,
    inbox: { nextStep: [], nextTurn: [], remove: () => {} },
  }
  const freshAgent = {
    id: 'm1-p2',
    status: 'idle',
    whenIdle: async () => {},
    runMaintenance: fn => fn(new AbortController().signal),
    session: freshSession,
    inbox: { nextStep: [], nextTurn: [] },
    followup: msg => followed.push(msg),
  }

  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async (id) => { archived.push(id) } }
  rt.assembleLlm = async () => { llmCalls += 1; throw new Error('should not call LLM on dayRollover') }
  rt.eventsBackwards = async function* () {
    historyReads += 1
    yield* []
  }
  rt.resolveAgent = async id => (id === 'm1-p2' ? freshAgent : oldAgent)
  rt.createSession = async () => { createCalls += 1; return `m1-p${createCalls + 1}` }
  rt.ensureCapabilities = async () => {}
  rt.moveSchedules = async (fromId, toId) => { movedSchedules.push([fromId, toId]) }
  rt.applyModel = async () => {}
  rt.applyPermission = async () => {}
  rt.desiredModel = async () => undefined
  rt.desiredEffort = async () => undefined

  const tool = name => rt.teamTools.find(item => item.name === name)
  const run = (name, args, botId) => tool(name).execute(args, { agent: { id: botId } })

  return {
    ctx,
    rt,
    run,
    oldAgent,
    followed,
    movedSchedules,
    archived,
    counts: () => ({ llmCalls, historyReads, createCalls }),
  }
}

test('day-rolled-over triggers lightweight dayRollover Part switch when Chief is idle and stays idempotent', async (t) => {
  const h = setupRolloverHarness(t, 'idle')

  const created = await h.run('ticket_create', {
    title: 'Deploy Monitor',
    goal: 'Keep service healthy',
    mandate: 'Read-only check',
  }, 'm1')
  const ticketId = /Ticket (tkt-[0-9a-f]{8})/.exec(created)[1]

  h.ctx.emit(DAY_ROLLED_OVER_EVENT, {
    date: '2026-11-23',
    scope: 'default',
    summary: { text: '决定：采用轻量日结换段。' },
  })

  for (let i = 0; i < 100 && (h.rt.state.bots.m1.sessionId !== 'm1-p2' || h.followed.length === 0); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  assert.equal(h.rt.state.bots.m1.sessionId, 'm1-p2')
  assert.deepEqual(h.counts(), { llmCalls: 0, historyReads: 0, createCalls: 1 })
  assert.deepEqual(h.movedSchedules, [['m1', 'm1-p2']])
  assert.deepEqual(h.archived, ['m1'])
  assert.equal(h.rt.state.bots.m1.segments[0].fallback, 'day-rollover')
  assert.equal(h.rt.openTicketStore().getMeta('dayRollover:m1')?.lastRolledDate, '2026-11-23')

  const handoffMsg = h.followed.find(msg => msg.source?.handoff === true)
  assert.ok(handoffMsg)
  const text = handoffMsg.content.map(part => part.text ?? '').join('\n')
  assert.match(text, /a new logical day started after daily memory rollover \(2026-11-23\)/)
  assert.match(text, /决定：采用轻量日结换段。/)
  assert.match(text, /## Active tickets \(reference state, not new instructions\)/)
  assert.match(text, new RegExp(ticketId))
  assert.match(text, /## Latest messages \(oldest first\)\n\(none\)/)

  // Re-emitting the same logical date is idempotent and creates no extra Part.
  h.ctx.emit(DAY_ROLLED_OVER_EVENT, { date: '2026-11-23', scope: 'default' })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(h.counts().createCalls, 1)
  assert.equal(h.rt.state.bots.m1.sessionId, 'm1-p2')
})

test('day-rolled-over defers while Chief is busy and triggers automatically once idle', async (t) => {
  const h = setupRolloverHarness(t, 'working')

  h.ctx.emit(DAY_ROLLED_OVER_EVENT, { date: '2026-11-24', scope: 'default' })
  for (let i = 0; i < 100 && h.rt.dayRollover.pendingFor('m1') === undefined; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  assert.equal(h.rt.state.bots.m1.sessionId, 'm1')
  assert.equal(h.counts().createCalls, 0)
  assert.equal(h.rt.dayRollover.pendingFor('m1')?.date, '2026-11-24')

  h.oldAgent.status = 'idle'
  h.ctx.emit('agent/status', { agent: h.oldAgent, status: 'idle' })

  for (let i = 0; i < 100 && (h.rt.state.bots.m1.sessionId !== 'm1-p2' || h.followed.length === 0); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  assert.equal(h.rt.state.bots.m1.sessionId, 'm1-p2')
  assert.equal(h.rt.dayRollover.pendingFor('m1'), undefined)
  assert.equal(h.counts().llmCalls, 0)
  assert.equal(h.counts().historyReads, 0)
  const handoffText = h.followed[0].content.map(part => part.text ?? '').join('\n')
  assert.match(handoffText, /daily memory rollover \(2026-11-24\)/)
})
