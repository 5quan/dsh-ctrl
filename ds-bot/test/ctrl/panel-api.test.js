import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../../index.js'
import { TICKET_MILESTONE_PRODUCER } from '../../src/host/ctrl/memory-bridge.js'
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

function createHarness(t, { withMemory = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-panel-api-'))
  const memHome = mkdtempSync(join(tmpdir(), 'ds-bot-panel-mem-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  if (withMemory) {
    mkdirSync(join(memHome, 'entities'), { recursive: true })
    mkdirSync(join(memHome, 'lessons'), { recursive: true })
    mkdirSync(join(memHome, 'journals'), { recursive: true })
    writeFileSync(join(memHome, 'PROFILE.md'), '# Core Profile\n- User prefers TypeScript\n', 'utf8')
    writeFileSync(join(memHome, 'entities', 'alice.md'), '# Alice\n\n- type: person\n- status: active\n- aliases: Ali\n\n## 事实记录\n- Works on backend\n', 'utf8')
    writeFileSync(join(memHome, 'lessons', 'win-ps.md'), '# Windows PowerShell\n\n- status: active\n- tags: windows, ps\n- triggers: powershell\n\n## 避坑条目\n- Do not chain commands with && in PS 5.1\n', 'utf8')
    writeFileSync(join(memHome, 'journals', '2026-11-25.md'), '# 2026-11-25\n- Earlier log\n', 'utf8')
    writeFileSync(join(memHome, 'journals', '2026-11-26.md'), '# 2026-11-26\n- Latest log\n', 'utf8')
  }

  const confirmCalls = []
  const pendingItems = [
    { id: 'buf-1', logical_date: '2026-11-26', source_type: 'extracted', target: 'profile', content: 'Remember this preference' },
    { id: 'buf-auto', logical_date: '2026-11-26', source_type: 'extracted', target: 'note', producer: TICKET_MILESTONE_PRODUCER, content: '[Ticket done] auto note' },
  ]
  const dshMemory = {
    contractVersion: 1,
    home: memHome,
    getCurrentLogicalDate: () => '2026-11-26',
    getMorningBriefing: () => ({
      date: '2026-11-26',
      scope: 'default',
      hasContent: true,
      alreadyDelivered: false,
      yesterday: null,
      buffer: {
        pending: pendingItems,
        approved: [{ id: 'buf-app', logical_date: '2026-11-26', source_type: 'explicit', target: 'entity:alice', content: 'Approved item' }],
        totalPending: pendingItems.length,
        totalApproved: 1,
      },
      markdown: '',
    }),
    listEntities: () => [{ slug: 'alice', name: 'Alice', type: 'person', status: 'active', aliases: ['Ali'], facts: [{ id: 'ent_01', content: 'Works on backend' }] }],
    listLessons: () => [{ slug: 'win-ps', name: 'Windows PowerShell', status: 'active', tags: ['windows', 'ps'], triggers: ['powershell'], entries: [{ id: 'les_01', content: 'Do not chain with &&' }] }],
    confirmBufferItems: async (opts) => {
      confirmCalls.push(opts)
      return { ok: true, approved: opts.approveIds ?? [], rejected: opts.rejectIds ?? [], settlement: opts.settleNow ? { profile: { committed: opts.approveIds ?? [] } } : null }
    },
  }

  const ctx = fakeContext()
  if (withMemory) ctx.get = name => (name === 'dshMemory' ? dshMemory : undefined)
  let route
  ctx.connection.fetch.register = (options) => { route = options; return () => {} }
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(memHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  const call = async (endpoint, payload = {}) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }

  return { home, memHome, rt, ctx, call, confirmCalls }
}

test('panel API degrades gracefully without dshMemory and preserves lazy tickets.sqlite invariant', async (t) => {
  const { home, call } = createHarness(t, { withMemory: false })

  const state = (await call('state')).value
  assert.equal(state.dshMemory, false)
  assert.deepEqual(state.ctrlInbox, { total: 0, counts: { approvals: 0, tickets: 0, memory: 0 } })

  const overview = (await call('ctrl-memory-overview')).value
  assert.deepEqual(overview, { available: false })

  const inbox = (await call('ctrl-inbox')).value
  assert.equal(inbox.total, 0)
  assert.deepEqual(inbox.tickets, [])
  assert.deepEqual(inbox.approvals, [])
  assert.deepEqual(inbox.memoryPending, [])

  const usage = (await call('ctrl-ticket-usage')).value
  assert.deepEqual(usage.tickets, [])
  assert.equal(usage.totals.total, 0)

  assert.equal(existsSync(join(home, 'tickets.sqlite')), false)
})

test('ctrl-memory overview, read, save, confirm enforce validation and immutability', async (t) => {
  const { memHome, call, confirmCalls } = createHarness(t, { withMemory: true })

  const state = (await call('state')).value
  assert.equal(state.dshMemory, true)
  // Auto milestone note from TICKET_MILESTONE_PRODUCER is filtered out, leaving 1 pending item.
  assert.deepEqual(state.ctrlInbox, { total: 1, counts: { approvals: 0, tickets: 0, memory: 1 } })

  const overview = (await call('ctrl-memory-overview')).value
  assert.equal(overview.available, true)
  assert.equal(overview.logicalDate, '2026-11-26')
  assert.match(overview.profile.content, /User prefers TypeScript/)
  assert.equal(overview.entities.length, 1)
  assert.equal(overview.entities[0].factCount, 1)
  assert.equal(overview.lessons.length, 1)
  assert.equal(overview.lessons[0].entryCount, 1)
  assert.deepEqual(overview.journals.dates, ['2026-11-26', '2026-11-25'])
  assert.match(overview.journals.latestContent, /Latest log/)
  assert.equal(overview.buffer.pending.length, 1)
  assert.equal(overview.buffer.pending[0].id, 'buf-1')

  // Read & save entity card atomically
  const readEnt = (await call('ctrl-memory-read', { kind: 'entity', key: 'alice' })).value
  assert.equal(readEnt.editable, true)
  assert.match(readEnt.content, /Works on backend/)

  const savedEnt = (await call('ctrl-memory-save', { kind: 'entity', key: 'alice', content: '# Alice\n\n## 事实记录\n- Updated role\n' })).value
  assert.equal(savedEnt.ok, true)
  assert.match(readFileSync(join(memHome, 'entities', 'alice.md'), 'utf8'), /Updated role/)

  // Read journal allowed; editing journal rejected
  const readJournal = (await call('ctrl-memory-read', { kind: 'journal', key: '2026-11-25' })).value
  assert.equal(readJournal.editable, false)
  assert.match(readJournal.content, /Earlier log/)

  const failJournalSave = await call('ctrl-memory-save', { kind: 'journal', key: '2026-11-25', content: 'hack' })
  assert.equal(failJournalSave.ok, false)
  assert.equal(failJournalSave.error.code, 'bot/invalid')

  // Reject path traversal
  const failTraversal = await call('ctrl-memory-read', { kind: 'entity', key: '../PROFILE' })
  assert.equal(failTraversal.ok, false)
  assert.equal(failTraversal.error.code, 'bot/invalid')

  // Confirm buffer items
  const confirmed = (await call('ctrl-memory-confirm', { approveIds: ['buf-1'], rejectIds: [], settleNow: true, reason: 'looks good' })).value
  assert.equal(confirmed.ok, true)
  assert.equal(confirmCalls.length, 1)
  assert.deepEqual(confirmCalls[0], { approveIds: ['buf-1'], rejectIds: [], settleNow: true, reason: 'looks good', scope: 'default' })
})

test('ctrl-inbox aggregates and prioritizes approvals, attention tickets, and pending memory', async (t) => {
  const { rt, ctx, call } = createHarness(t, { withMemory: true })
  await rt.load()
  const store = rt.openTicketStore()

  store.create({ id: 't-review', title: 'Pending Review', goal: 'Check', ownerBotId: 'b2', createdByBotId: 'm1', status: 'review' })
  store.create({ id: 't-due', title: 'Due Today', goal: 'Ship', ownerBotId: 'm1', createdByBotId: 'm1', status: 'in_progress', deadline: Date.now() - 60_000 })
  store.create({ id: 't-wait', title: 'Need Decision', goal: 'Pick one', ownerBotId: 'm1', createdByBotId: 'm1', status: 'waiting_user', waitingOn: 'user' })
  store.create({ id: 't-calm', title: 'Background Task', goal: 'Silent', ownerBotId: 'b2', createdByBotId: 'm1', status: 'in_progress', deadline: Date.now() + 7 * 86_400_000 })

  // Trigger a pending approval on Chief (hold DSH card open until host answers)
  const approvalPromise = ctx.listeners.get('approval/request').reduceRight(
    (next, fn) => () => fn({ agent: { id: 'm1' }, callId: 'call-1', toolName: 'bash', reason: 'Run deploy script' }, next),
    () => new Promise(() => {}),
  )()

  const inbox = (await call('ctrl-inbox')).value
  assert.equal(inbox.total, 5)
  assert.deepEqual(inbox.counts, { approvals: 1, tickets: 3, memory: 1 })
  assert.equal(inbox.approvals[0].tool, 'bash')
  assert.deepEqual(inbox.tickets.map(item => item.title), ['Need Decision', 'Due Today', 'Pending Review'])
  assert.deepEqual(inbox.tickets[0].reasons, ['waiting_user'])
  assert.deepEqual(inbox.tickets[1].reasons, ['due'])

  // Read-only lock refuses writes but permits reads
  rt.readOnly = () => 'another host holds this team'
  const blockedWrite = await call('ctrl-memory-save', { kind: 'profile', content: 'x' })
  assert.equal(blockedWrite.ok, false)
  assert.equal(blockedWrite.error.code, 'bot/read-only')
  const okRead = await call('ctrl-inbox')
  assert.equal(okRead.ok, true)

  // Answer pending approval so open handle settles cleanly
  rt.readOnly = () => undefined
  await call('approval-answer', { id: inbox.approvals[0].id, choice: 'allow' })
  assert.equal(await approvalPromise, 'allowed-once')
})
