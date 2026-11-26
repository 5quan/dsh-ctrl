import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief', model: 'deepseek/v4-flash', instructions: '', createdAt: 1 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

async function drain(gen) {
  while (!(await gen.next()).done) {}
}

test('ticket usage attribution tracks live Worker streams without double counting or breaking lazy sqlite', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-ticket-usage-'))
  const teamWs = join(home, 'workspace')
  mkdirSync(teamWs, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, workspaceId: 'ws-team' }))

  const logs = {}
  const listed = []
  const archived = []
  const scoped = new Map()
  let createdWorkerSession = ''
  const workspaces = new Map([['ws-team', { id: 'ws-team', path: teamWs }]])

  const ctx = fakeContext()
  let rt
  const agentsMap = new Map()
  const ensureAgent = (sessionId, { origin } = {}) => {
    if (agentsMap.has(sessionId)) return agentsMap.get(sessionId)
    let idleResolve
    let busy = false
    const agent = {
      id: sessionId,
      session: { id: sessionId, header: { id: sessionId, cwd: teamWs, ...(origin ? { origin } : {}) }, deriveMessages: () => [] },
      status: 'idle',
      model: { select: () => {} },
      ctx: {
        tools: {
          register: (toolDef) => { scoped.set(`${sessionId}:${toolDef.name}`, toolDef); return () => scoped.delete(`${sessionId}:${toolDef.name}`) },
          restrict: () => () => {},
        },
        effect: fn => (typeof fn === 'function' ? fn() : undefined),
        on: () => () => {},
      },
      whenIdle: async () => { if (busy) await new Promise((resolve) => { idleResolve = resolve }) },
      cancel: () => { busy = false; idleResolve?.() },
      followup: () => {
        if (sessionId === 'm1') return
        busy = true
        void (async () => {
          try {
            const meter = ctx.listeners.get('llm/stream').at(-1)
            await drain(meter(
              { sessionId, provider: 'deepseek', model: 'v4-flash', messages: [] },
              async function* () {
                yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 40 } }
              },
            ))
            const reportTool = scoped.get(`${sessionId}:ticket_report`) ?? rt.teamTools.find(tool => tool.name === 'ticket_report')
            await reportTool.execute({ status: 'blocked', summary: 'Paused for test verification' }, { agent })
          } finally {
            busy = false
            agent.status = 'idle'
            idleResolve?.()
          }
        })()
      },
    }
    agentsMap.set(sessionId, agent)
    return agent
  }

  ctx.sessionController = {
    create: async ({ header } = {}) => {
      createdWorkerSession = `w-sess-${Date.now()}`
      listed.push({ sessionId: createdWorkerSession, origin: header?.origin ?? 'subagent', parentSessionId: 'm1', projections: { kind: 'cached', asOfSeq: 0, values: {} } })
      ensureAgent(createdWorkerSession, { origin: header?.origin ?? 'subagent' })
      return { sessionId: createdWorkerSession }
    },
    resolveAgent: async sessionId => ({ agent: ensureAgent(sessionId) }),
    list: async () => ({ items: listed }),
    projections: async ({ sessionId }) => (logs[sessionId] ? { asOfSeq: logs[sessionId].length - 1, values: {} } : null),
    page: async () => ({ records: [], hasMore: false }),
  }
  ctx.workspaceRegistry = {
    get: id => workspaces.get(id),
    resolveByPath: async () => undefined,
    archiveSession: async (id) => { archived.push(id) },
  }

  let route
  ctx.connection.fetch.register = (options) => { route = options; return () => {} }
  rt = createRuntime(ctx, { home })
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 25))
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  const call = async (endpoint, payload = {}) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }

  // Before any tickets exist, ctrl-ticket-usage must not create tickets.sqlite or usage.sqlite
  const emptySummary = (await call('ctrl-ticket-usage')).value
  assert.deepEqual(emptySummary.tickets, [])
  assert.equal(existsSync(join(home, 'tickets.sqlite')), false)
  assert.equal(existsSync(join(home, 'usage.sqlite')), false)

  // Create Ticket and dispatch background Worker
  const store = rt.openTicketStore()
  const ticket = store.create({
    id: 't-usage-1',
    title: 'Index Billing Logs',
    goal: 'Aggregate worker tokens',
    ownerBotId: 'm1',
    createdByBotId: 'm1',
  })

  const dispatchTool = rt.teamTools.find(tool => tool.name === 'ticket_dispatch')
  await dispatchTool.execute({ id: ticket.id, prompt: 'Run test pass' }, { agent: { id: 'm1' } })
  await rt.ticketQueue.drain()

  assert.equal(archived.includes(createdWorkerSession), true)

  // Verify usageView attributes the Worker tokens to `ticket:<id>` and kind `worker`
  const view = (await call('usage', { timeZone: 'Asia/Shanghai' })).value
  const ticketOwnerIndex = view.owners.findIndex(o => o.key === `ticket:${ticket.id}`)
  assert.notEqual(ticketOwnerIndex, -1)
  assert.equal(view.owners[ticketOwnerIndex].kind, 'ticket')
  assert.equal(view.owners[ticketOwnerIndex].name, 'Index Billing Logs')
  const workerKindIndex = view.kinds.indexOf('worker')
  assert.notEqual(workerKindIndex, -1)

  const workerRows = view.rows.filter(r => r[1] === ticketOwnerIndex && r[3] === workerKindIndex)
  assert.equal(workerRows.length, 1)
  assert.equal(workerRows[0][4], 120)
  assert.equal(workerRows[0][5], 40)
  assert.equal(workerRows[0][7], 30)

  // Verify ctrl-ticket-usage details + no double counting on a subsequent scan
  const summary = (await call('ctrl-ticket-usage')).value
  assert.equal(summary.totals.total, 190)
  assert.equal(summary.totals.ticketCount, 1)
  assert.equal(summary.tickets[0].id, ticket.id)
  assert.equal(summary.tickets[0].total, 190)
  assert.equal(summary.tickets[0].assignments.length, 1)
  assert.equal(summary.tickets[0].assignments[0].estimated, false)

  // Fallback to assignment.token_usage when an historical assignment has no ledger rows
  const t2 = store.create({ id: 't-usage-2', title: 'Legacy Assignment', goal: 'Fallback', ownerBotId: 'm1', createdByBotId: 'm1' })
  const a2 = store.createAssignment({ ticketId: t2.id, workerSessionId: 'w-legacy-1', prompt: 'old' })
  store.completeAssignment(a2.id, { reportStatus: 'review', reportSummary: 'ok', tokenUsage: 550, stepCount: 3 })

  const summaryWithLegacy = (await call('ctrl-ticket-usage')).value
  assert.equal(summaryWithLegacy.totals.ticketCount, 2)
  assert.equal(summaryWithLegacy.totals.total, 740)
  const legacyTicket = summaryWithLegacy.tickets.find(item => item.id === t2.id)
  assert.equal(legacyTicket.total, 550)
  assert.equal(legacyTicket.steps, 3)
  assert.equal(legacyTicket.assignments[0].estimated, true)
})
