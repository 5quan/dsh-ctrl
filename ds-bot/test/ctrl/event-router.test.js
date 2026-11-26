import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../../index.js'
import { adapters } from '../../src/host/im/platforms/index.js'
import {
  classifyEventNoise,
  computeEventFingerprint,
  matchEventToTicket,
  parseEventWakeRules,
} from '../../src/host/ctrl/event-router.js'
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

function setupRouterHarness(t, { home: existingHome, config = {}, workerHandler, statePatch = {} } = {}) {
  const ownHome = !existingHome
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'ds-bot-event-router-'))
  const teamWorkspace = join(home, 'workspace')
  if (ownHome) {
    mkdirSync(teamWorkspace, { recursive: true })
    writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, ...statePatch, workspaceId: 'ws-team' }))
  }

  const workspaces = new Map([['ws-team', { id: 'ws-team', path: teamWorkspace }]])
  const liveAgents = new Map()
  const deliveries = []
  const userMessages = []

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
        if (sessionId === 'm1' || sessionId === 'b2' || sessionId === 'p1') return
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
      mailEventPollMs: 3_600_000,
      mailEventStartupDelayMs: 3_600_000,
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
  rt.sendUser = async (payload) => {
    userMessages.push(payload)
  }

  if (ownHome) {
    t.after(async () => {
      await ctx.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    })
  }

  return { home, ctx, rt, deliveries, userMessages }
}

test('computeEventFingerprint, classifyEventNoise, parseEventWakeRules, and matchEventToTicket work deterministically', () => {
  // Fingerprint uses externalId when present, hashes fallback when allowed, returns null when requireExternalId.
  assert.equal(
    computeEventFingerprint({ source: 'mail', channel: 'Ops@Co.com', externalId: 'acc1:42' }),
    'mail:ops@co.com:acc1:42',
  )
  assert.equal(computeEventFingerprint({ source: 'im', channel: 'c1', text: 'ok', requireExternalId: true }), null)
  const fallbackFp = computeEventFingerprint({ source: 'mail', channel: 'box', sender: 'a@b.com', subject: 'Hi', text: 'Body' })
  assert.match(fallbackFp, /^mail:box:sha256:[0-9a-f]{16}$/)

  // Noise classification covers mail automated headers, senders, subjects, IM bot senders, and custom patterns.
  assert.equal(classifyEventNoise({ source: 'mail', headers: { 'Auto-Submitted': 'auto-replied' } }).reason, 'automated_header')
  assert.equal(classifyEventNoise({ source: 'mail', headers: { 'List-Unsubscribe': '<https://unsub.example>' } }).isNoise, true)
  assert.equal(classifyEventNoise({ source: 'mail', sender: 'noreply@github.com', subject: 'Digest' }).reason, 'automated_sender')
  assert.equal(classifyEventNoise({ source: 'mail', sender: 'alice@co.com', subject: 'Out of Office: Vacation' }).reason, 'auto_reply_subject')
  assert.equal(classifyEventNoise({ source: 'mail', sender: 'alice@co.com', subject: 'Contract approval', text: 'Please check' }).isNoise, false)
  assert.equal(classifyEventNoise({ source: 'im', senderIsBot: true, text: 'ping' }).reason, 'bot_sender')
  assert.equal(classifyEventNoise({ source: 'im', text: '[自动回复] 暂不在线' }).reason, 'auto_reply_text')
  assert.equal(classifyEventNoise({ source: 'mail', sender: 'a@b.com', subject: 'Weekly Promo' }, ['/promo/i']).reason, 'custom_noise_rule')

  // Rule parsing & matching across JSON, directive lines, waiting_on emails, and direct ticket IDs.
  const tDir = {
    id: 'tkt-abcd1234',
    status: 'waiting_user',
    updatedAt: 500,
    waitingOn: 'vendor@acme.com',
    wakeCondition: 'source: mail\nfrom: vendor@acme.com\nkeyword: invoice, approved',
  }
  const parsed = parseEventWakeRules(tDir)
  assert.deepEqual(parsed.sources, ['mail'])
  assert.deepEqual(parsed.senders, ['vendor@acme.com'])
  assert.deepEqual(parsed.keywords, ['invoice', 'approved'])
  assert.deepEqual(parsed.waitingEmails, ['vendor@acme.com'])

  assert.equal(
    matchEventToTicket({ source: 'mail', sender: 'Vendor <vendor@acme.com>', subject: 'Invoice #99', text: 'Attached' }, tDir).matched,
    true,
  )
  assert.equal(
    matchEventToTicket({ source: 'im', sender: 'vendor@acme.com', text: 'Invoice #99' }, tDir).matched,
    false,
    'source mismatch rejects',
  )
  assert.equal(
    matchEventToTicket({ source: 'mail', sender: 'other@co.com', text: 'About tkt-abcd1234 update' }, tDir).reason,
    'ticket_id_ref',
  )
  assert.equal(
    matchEventToTicket({ source: 'mail', sender: 'other@co.com', text: 'About tkt-abcd1234' }, { ...tDir, status: 'done' }).matched,
    false,
    'terminal tickets never match',
  )

  const tJson = {
    id: 'tkt-9999aaaa',
    status: 'open',
    updatedAt: 100,
    wakeCondition: JSON.stringify({ from: 'alice', subject: 'Deploy' }),
  }
  assert.equal(matchEventToTicket({ source: 'im', sender: 'Alice Wang', subject: 'Deploy v3', text: 'go' }, tJson).matched, true)
  assert.equal(matchEventToTicket({ source: 'im', sender: 'Bob', subject: 'Deploy v3', text: 'go' }, tJson).matched, false)
})

test('eventRouter preserves lazy tickets.sqlite invariant when ingesting or polling with no ticket store', async (t) => {
  const h = setupRouterHarness(t)
  assert.equal(h.rt.hasTicketStore(), false)

  const noise = await h.rt.eventRouter.ingestEvent({
    source: 'mail',
    externalId: 'm-1',
    sender: 'newsletter@promo.example',
    subject: 'Deals',
  })
  assert.equal(noise.action, 'dropped_noise')

  const normal = await h.rt.eventRouter.ingestEvent({
    source: 'mail',
    externalId: 'm-2',
    sender: 'bob@partner.example',
    subject: 'Question',
    text: 'Hello Chief',
  }, { notifyChiefOnUnmatched: true })
  assert.equal(normal.action, 'forwarded_chief')
  assert.equal(h.deliveries.length, 1)
  assert.equal(h.rt.hasTicketStore(), false)
  assert.equal(existsSync(join(h.home, 'tickets.sqlite')), false)
})

test('pollMailOnce dispatches matched ticket events silently, drops noise, forwards human mail, and deduplicates across restarts', async (t) => {
  const workerPrompts = []
  const h1 = setupRouterHarness(t, {
    workerHandler: async ({ message, callTool }) => {
      workerPrompts.push(message.content[0].text)
      await callTool('ticket_report', { status: 'review', summary: 'Processed vendor invoice email' })
    },
  })

  const store1 = h1.rt.openTicketStore()
  const tVendor = store1.create({
    title: 'Await Vendor Invoice',
    goal: 'Process invoice once vendor emails it',
    status: 'waiting_user',
    ownerBotId: 'm1',
    createdByBotId: 'm1',
    waitingOn: 'billing@vendor.com',
    wakeCondition: 'source: mail\nkeyword: invoice',
  })
  const tPrivate = store1.create({
    title: 'Private Mail Secret',
    goal: 'Do not match shared inbox',
    ownerBotId: 'p1',
    createdByBotId: 'p1',
    waitingOn: 'friend@example.com',
    wakeCondition: 'from: friend@example.com\nkeyword: diary',
  })

  const fakeRows = [
    {
      uid: '101',
      from: 'Billing <billing@vendor.com>',
      subject: 'Your April Invoice',
      snippet: 'Here is invoice #404.',
      headers: {},
    },
    {
      uid: '102',
      from: 'mailer@digest.example',
      subject: 'Weekly Digest',
      snippet: 'Lots of spam links',
      headers: { 'List-Unsubscribe': '<https://digest.example/unsub>' },
    },
    {
      uid: '103',
      from: 'ceo@company.com',
      subject: 'Quick sync tomorrow?',
      snippet: 'Can we meet at 10am?',
      headers: {},
    },
    {
      uid: '104',
      from: 'friend@example.com',
      subject: 'Personal diary note',
      snippet: 'diary secret',
      headers: {},
    },
  ]

  h1.rt.mailConnector = {
    hasAccounts: () => true,
    accounts: () => [{ id: 'acc-1', address: 'chief@company.com' }],
    connect: async () => ({
      search: async () => fakeRows,
    }),
  }

  const res1 = await h1.rt.eventRouter.pollMailOnce({ now: 1_000_000 })
  await h1.rt.ticketQueue.drain()

  assert.deepEqual(res1, {
    accounts: 1,
    fetched: 4,
    dispatched: 1,
    forwarded: 2,
    dropped: 1,
    deduplicated: 0,
  })
  assert.equal(workerPrompts.length, 1)
  assert.match(workerPrompts[0], /billing@vendor\.com/)
  assert.match(workerPrompts[0], /invoice #404/)
  assert.equal(store1.listAssignments({ ticketId: tPrivate.id }).length, 0, 'shared mail never triggers private Bot ticket')
  assert.equal(store1.listAssignments({ ticketId: tVendor.id })[0].triggerKind, 'event')
  assert.equal(h1.deliveries.filter(d => d.role === 'mail').length, 2, 'only unmatched non-noise emails forward to Chief')

  // Re-poll same UIDs after simulated host restart -> all 4 deduplicated via persisted ctrl_meta!
  await h1.ctx.dispose()
  const h2 = setupRouterHarness(t, { home: h1.home })
  try {
    h2.rt.mailConnector = h1.rt.mailConnector
    const res2 = await h2.rt.eventRouter.pollMailOnce({ now: 1_060_000 })
    assert.deepEqual(res2, {
      accounts: 1,
      fetched: 4,
      dispatched: 0,
      forwarded: 0,
      dropped: 0,
      deduplicated: 4,
    })
    assert.equal(h2.deliveries.length, 0)
  } finally {
    await h2.ctx.dispose()
  }
})

test('im/index.js routes matched IM events straight to Ticket Worker and passes normal human chat to Chief', async (t) => {
  let capturedHandlers = null
  const realTelegram = adapters.telegram
  adapters.telegram = {
    id: 'telegram',
    async check() { return { account: { id: 'bot1', name: '@fake' } } },
    connect(_fields, _env, handlers) {
      capturedHandlers = handlers
      handlers.onStatus?.({ state: 'ready', account: { id: 'bot1', name: '@fake' } })
      return {
        send: async () => ({ messageId: 1 }),
        edit: async () => {},
        typing: async () => {},
        stop: () => {},
      }
    },
  }
  t.after(() => {
    adapters.telegram = realTelegram
  })

  const workerPrompts = []
  const h = setupRouterHarness(t, {
    workerHandler: async ({ message, callTool }) => {
      workerPrompts.push(message.content[0].text)
      await callTool('ticket_report', { status: 'waiting_user', summary: 'Handled IM update' })
    },
  })

  await h.rt.imEndpoint('im-add', { platform: 'telegram', botId: 'm1', fields: { token: 'tok-1234' } })
  const [conn] = Object.values(h.rt.state.im.connections)
  assert.ok(capturedHandlers?.onMessage, 'IM adapter started and bound onMessage')

  // Pair sender u1 through the real im-pair endpoint.
  await capturedHandlers.onMessage({
    chat: { key: 'dm-u1', kind: 'direct', title: 'Alice' },
    sender: { id: 'u1', name: 'Alice' },
    text: 'hello',
  })
  await h.rt.imEndpoint('im-pair', { id: conn.id, senderId: 'u1', allow: true })

  const store = h.rt.openTicketStore()
  const tIm = store.create({
    title: 'Wait Alice IM Confirm',
    goal: 'Proceed when Alice confirms deployment',
    status: 'waiting_user',
    ownerBotId: 'm1',
    createdByBotId: 'm1',
    wakeCondition: 'source: im\nfrom: Alice\nkeyword: confirm',
  })

  // 1. Matched IM event dispatches directly to Worker without calling rt.sendUser (Chief).
  await capturedHandlers.onMessage({
    id: 'msg-100',
    sender: { id: 'u1', name: 'Alice' },
    chat: { key: 'dm-u1', kind: 'direct', title: 'Alice' },
    text: 'Please confirm deploy now',
  })
  await h.rt.ticketQueue.drain()
  assert.equal(workerPrompts.length, 1)
  assert.match(workerPrompts[0], /Please confirm deploy now/)
  assert.equal(h.userMessages.length, 0, 'matched IM event must not interrupt Chief chat')
  assert.equal(store.listAssignments({ ticketId: tIm.id })[0].priority, 'human')

  // 2. Duplicate IM webhook with same id is deduplicated cleanly.
  await capturedHandlers.onMessage({
    id: 'msg-100',
    sender: { id: 'u1', name: 'Alice' },
    chat: { key: 'dm-u1', kind: 'direct', title: 'Alice' },
    text: 'Please confirm deploy now',
  })
  await h.rt.ticketQueue.drain()
  assert.equal(workerPrompts.length, 1)

  // 3. Unmatched normal IM messages (even repeating "ok" without message id) pass through to rt.sendUser.
  await capturedHandlers.onMessage({
    sender: { id: 'u1', name: 'Alice' },
    chat: { key: 'dm-u1', kind: 'direct', title: 'Alice' },
    text: 'ok',
  })
  await capturedHandlers.onMessage({
    sender: { id: 'u1', name: 'Alice' },
    chat: { key: 'dm-u1', kind: 'direct', title: 'Alice' },
    text: 'ok',
  })
  assert.equal(h.userMessages.length, 2)
})
