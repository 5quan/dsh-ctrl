import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../../index.js'
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

function createFakeMemory({ date = '2026-11-24', pending = [], highlights = null } = {}) {
  let deliveredDate = null
  const confirmCalls = []
  const markCalls = []
  const service = {
    getCurrentLogicalDate: () => date,
    getMorningBriefing: () => {
      const hasContent = Boolean((highlights && highlights.hasContent) || pending.length > 0)
      return {
        date,
        scope: 'default',
        hasContent,
        alreadyDelivered: deliveredDate === date,
        yesterday: highlights
          ? { date: '2026-11-23', path: 'journals/2026-11-23.md', highlights }
          : null,
        buffer: {
          pending,
          approved: [],
          totalPending: pending.length,
          totalApproved: 0,
        },
        markdown: 'memory markdown',
      }
    },
    markBriefingDelivered: (opts = {}) => {
      deliveredDate = opts.date ?? date
      markCalls.push(opts)
      return { ok: true, date: deliveredDate }
    },
    confirmBufferItems: async (opts = {}) => {
      confirmCalls.push(opts)
      return {
        ok: true,
        scope: opts.scope ?? 'default',
        approved: opts.approveIds ?? [],
        rejected: opts.rejectIds ?? [],
        settlement: opts.settleNow ? { profile: { committed: opts.approveIds ?? [] } } : null,
      }
    },
  }
  return { service, confirmCalls, markCalls, isDelivered: () => deliveredDate === date }
}

function startTeam(t, { services } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-briefing-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services })
  const rt = createRuntime(ctx, { home, memory: false })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const tool = name => rt.teamTools.find(item => item.name === name)
  const run = (name, args, botId) => tool(name).execute(args, { agent: { id: botId } })
  const preStepListener = () => ctx.listeners.get('agent/pre-step').find(fn => String(fn).includes('BRIEFING_SOURCE_KIND'))
  return { home, ctx, rt, run, preStepListener }
}

function runPipeline(middlewares, payload, finalDecision) {
  const dispatch = index => {
    if (index >= middlewares.length) return Promise.resolve(finalDecision())
    return Promise.resolve(middlewares[index](payload, () => dispatch(index + 1)))
  }
  return dispatch(0)
}

test('getUnifiedBriefing merges dsh-memory highlights/buffer with due, waiting_user, and review tickets', async (t) => {
  const mem = createFakeMemory({
    date: '2026-11-24',
    highlights: {
      hasContent: true,
      decisions: ['Use ctrl/ namespace'],
      lessons: ['Skip LLM writeNote on rollover'],
      openQuestions: ['Wire Worker executor'],
      happened: [],
    },
    pending: [
      { id: 'buf_01', logical_date: '2026-11-23', source_type: 'correction', target: 'profile', content: 'Prefer concise reports' },
    ],
  })

  const { run, rt } = startTeam(t, { services: { dshMemory: mem.service } })
  await run('ticket_create', { title: 'Due Today', goal: 'Ship P0', deadline: '2026-11-24T12:00:00.000Z' }, 'm1')
  await run('ticket_create', { title: 'Needs Approval', goal: 'Prod deploy', status: 'waiting_user', waiting_on: 'user' }, 'm1')
  await run('ticket_create', { title: 'Needs Review', goal: 'Verify patch', status: 'review', next_step: 'Run checks' }, 'm1')
  await run('ticket_create', { title: 'Background Task', goal: 'Normal work', status: 'open' }, 'm1')
  await run('ticket_create', { title: 'Private Secret', goal: 'Hidden' }, 'p1')

  const unified = rt.ctrlBriefing.getUnifiedBriefing({ botId: 'm1', date: '2026-11-24', now: Date.parse('2026-11-24T09:00:00.000Z') })
  assert.equal(unified.hasContent, true)
  assert.equal(unified.alreadyDelivered, false)
  assert.equal(unified.tickets.due.length, 1)
  assert.equal(unified.tickets.waitingUser.length, 1)
  assert.equal(unified.tickets.review.length, 1)
  assert.equal(unified.tickets.otherActiveCount, 1)
  assert.match(unified.markdown, /Use ctrl\/ namespace/)
  assert.match(unified.markdown, /buf_01/)
  assert.match(unified.markdown, /Due Today/)
  assert.match(unified.markdown, /Needs Approval/)
  assert.match(unified.markdown, /Needs Review/)
  assert.match(unified.markdown, /另有 1 条进行中\/待办工单/)
  assert.doesNotMatch(unified.markdown, /Private Secret/)
})

test('agent/pre-step deduplicates against dsh-memory in both load orders and keeps user prompt last', async (t) => {
  for (const ctrlFirst of [true, false]) {
    const mem = createFakeMemory({
      date: '2026-11-24',
      pending: [{ id: 'buf_10', logical_date: '2026-11-23', source_type: 'extracted', target: 'note', content: 'Remember release freeze' }],
    })
    const { preStepListener } = startTeam(t, { services: { dshMemory: mem.service } })
    const ctrlMiddleware = preStepListener()

    // Simulates dsh-memory's post-next() delta/briefing pre-step middleware.
    const dshMemoryMiddleware = async (_payload, next) => {
      const decision = await next()
      if (!mem.isDelivered()) {
        mem.service.markBriefingDelivered({ date: '2026-11-24' })
        return {
          ...decision,
          messages: [{ role: 'user', source: { kind: 'dsh-memory/delta' }, content: [{ type: 'text', text: 'duplicate memory briefing' }] }, ...decision.messages],
        }
      }
      return decision
    }

    const stack = ctrlFirst ? [ctrlMiddleware, dshMemoryMiddleware] : [dshMemoryMiddleware, ctrlMiddleware]

    // Bare handoff turn must NOT trigger briefing or mark delivered.
    const handoffMsg = { role: 'user', source: { kind: 'bot', handoff: true }, content: [{ type: 'text', text: '[Handoff]' }] }
    const handoffDecision = await ctrlMiddleware({ agent: { id: 'm1' }, step: 1, messages: [handoffMsg] }, async () => ({ kind: 'enter', messages: [handoffMsg] }))
    assert.equal(handoffDecision.messages.length, 1)
    assert.equal(mem.markCalls.length, 0)

    // First real user message injects unified briefing once, before userMsg, and prevents dsh-memory duplicate.
    const userMsg = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '早安，今天有什么安排？' }] }
    const firstDecision = await runPipeline(stack, { agent: { id: 'm1' }, step: 1, messages: [userMsg] }, () => ({ kind: 'enter', messages: [userMsg] }))
    assert.equal(firstDecision.messages.length, 2, `ctrlFirst=${ctrlFirst}`)
    assert.equal(firstDecision.messages[0].source?.kind, 'dsh-ctrl/briefing')
    assert.equal(firstDecision.messages[1], userMsg)
    assert.equal(mem.markCalls.length, 1)

    // Second turn on the same logical day injects nothing.
    const userMsg2 = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续干活' }] }
    const secondDecision = await runPipeline(stack, { agent: { id: 'm1' }, step: 1, messages: [userMsg2] }, () => ({ kind: 'enter', messages: [userMsg2] }))
    assert.deepEqual(secondDecision.messages, [userMsg2])
  }
})

test('pre-step works without dshMemory for waiting tickets and stays quiet when nothing needs attention', async (t) => {
  const quiet = startTeam(t)
  const quietUser = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }
  const quietDecision = await quiet.preStepListener()({ agent: { id: 'm1' }, step: 1, messages: [quietUser] }, async () => ({ kind: 'enter', messages: [quietUser] }))
  assert.deepEqual(quietDecision.messages, [quietUser])

  const withTicket = startTeam(t)
  await withTicket.run('ticket_create', { title: 'Approve Migration', goal: 'Run DB script', status: 'waiting_user' }, 'm1')
  const userMsg = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }
  const decision = await withTicket.preStepListener()({ agent: { id: 'm1' }, step: 1, messages: [userMsg] }, async () => ({ kind: 'enter', messages: [userMsg] }))
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0].source.kind, 'dsh-ctrl/briefing')
  assert.match(decision.messages[0].content[0].text, /Approve Migration/)
})

test('ctrl_briefing tool enforces permissions and delegates confirm/dismiss', async (t) => {
  const mem = createFakeMemory({
    date: '2026-11-24',
    pending: [{ id: 'buf_1', logical_date: '2026-11-23', source_type: 'explicit', target: 'profile', content: 'Fact' }],
  })
  const { run } = startTeam(t, { services: { dshMemory: mem.service } })

  // Ordinary and private Bots cannot invoke ctrl_briefing.
  assert.match(await run('ctrl_briefing', { action: 'get' }, 'b2'), /Only a non-private Main Bot/)
  assert.match(await run('ctrl_briefing', { action: 'get' }, 'p1'), /Only a non-private Main Bot/)

  const got = await run('ctrl_briefing', { action: 'get' }, 'm1')
  assert.match(got, /buf_1/)

  const confirmed = await run('ctrl_briefing', {
    action: 'confirm',
    approve_ids: ['buf_1'],
    reject_ids: ['buf_2'],
    settle_now: true,
    reason: 'morning review',
  }, 'm1')
  assert.match(confirmed, /1 approved, 1 rejected; settled approved entries immediately/)
  assert.equal(mem.confirmCalls.length, 1)
  assert.deepEqual(mem.confirmCalls[0].approveIds, ['buf_1'])
  assert.deepEqual(mem.confirmCalls[0].rejectIds, ['buf_2'])
  assert.equal(mem.confirmCalls[0].settleNow, true)
  assert.equal(mem.isDelivered(), true)

  const dismissed = await run('ctrl_briefing', { action: 'dismiss', date: '2026-11-24' }, 'm1')
  assert.match(dismissed, /Dismissed unified briefing for 2026-11-24/)
})
