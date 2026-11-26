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
  const retroItems = () => submitted.filter(item => item.producer === 'dsh-ctrl/ticket-retrospective')
  const milestoneItems = () => submitted.filter(item => item.producer === 'dsh-ctrl/ticket-milestone')
  assert.equal(retroItems().length, 2)
  assert.equal(retroItems()[1].target, 'note')
  assert.equal(milestoneItems().length, 1)

  const t3Out = await run('ticket_create', { title: 'Update Server A IP', goal: 'Record IP' }, 'm1')
  const t3 = /Ticket (tkt-[0-9a-f]{8})/.exec(t3Out)[1]
  const doneEntity = await run('ticket_update', {
    id: t3,
    status: 'done',
    retrospective: 'Server A moved to 10.0.0.8.',
    retrospective_target: 'entity:ServerA',
  }, 'm1')
  assert.match(doneEntity, /target: entity:ServerA, status: pending/)
  assert.equal(retroItems().length, 3)
  assert.equal(retroItems()[2].target, 'entity:ServerA')
  assert.equal(milestoneItems().length, 2)

  // 3. Private Bot ticket never leaks retrospective or milestone note to shared dsh-memory.
  const privOut = await run('ticket_create', { title: 'Private Secret', goal: 'Personal' }, 'p1')
  const privId = /Ticket (tkt-[0-9a-f]{8})/.exec(privOut)[1]
  const privDone = await run('ticket_update', {
    id: privId,
    status: 'done',
    retrospective: 'Sensitive personal detail',
  }, 'p1')
  assert.match(privDone, /Retrospective skipped: private Bot tickets do not write to shared dsh-memory/)
  assert.equal(retroItems().length, 3)
  assert.equal(milestoneItems().length, 2)

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

test('recordTicketMilestone writes single-line note for non-private done tickets, deduplicates, and degrades safely', async (t) => {
  const submitted = []
  const dshMemory = {
    contractVersion: 1,
    getCurrentLogicalDate: () => '2026-11-25',
    submitBufferCandidate: async input => {
      submitted.push(input)
      return { ok: true, id: `buf_ms_${submitted.length}`, status: 'pending' }
    },
  }

  const { rt, run } = startTeam(t, { services: { dshMemory } })

  // Non-done tickets do not record milestones.
  const openOut = await run('ticket_create', { title: 'Open Task', goal: 'Keep waiting' }, 'm1')
  const openId = /Ticket (tkt-[0-9a-f]{8})/.exec(openOut)[1]
  const store = rt.openTicketStore()
  const notDone = await rt.memoryBridge.recordTicketMilestone({ ticket: store.get(openId) })
  assert.deepEqual(notDone, { ok: false, reason: 'NOT_DONE' })

  // Private ticket does not leak milestone.
  const privOut = await run('ticket_create', { title: 'Secret Note', goal: 'Private delivery' }, 'p1')
  const privId = /Ticket (tkt-[0-9a-f]{8})/.exec(privOut)[1]
  await run('ticket_update', { id: privId, status: 'done' }, 'p1')
  assert.equal(submitted.length, 0)

  // Done ticket formats single-line concise note with artifacts and persists idempotency meta.
  const tktOut = await run('ticket_create', {
    title: 'Deploy API Gateway',
    goal: 'Switch production ingress to v2 gateway',
    artifacts: ['docs/gateway.md', 'artifact://art-1111'],
  }, 'm1')
  const tktId = /Ticket (tkt-[0-9a-f]{8})/.exec(tktOut)[1]
  const doneRes = await run('ticket_update', { id: tktId, status: 'done' }, 'm1')
  assert.match(doneRes, /Status: done/)
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].target, 'note')
  assert.equal(submitted[0].sourceType, 'extracted')
  assert.equal(submitted[0].producer, 'dsh-ctrl/ticket-milestone')
  assert.equal(submitted[0].content, `[Ticket ${tktId} 完成] Deploy API Gateway：Switch production ingress to v2 gateway（产物：docs/gateway.md, artifact://art-1111）`)
  assert.ok(store.getMeta(`ticket-milestone:${tktId}`)?.recordedAt)

  // Re-invoking for same ticket is deduplicated across both memory and SQLite meta.
  const dup = await rt.memoryBridge.recordTicketMilestone({
    ticket: store.get(tktId),
    summary: 'Should not duplicate.',
  })
  assert.equal(dup.ok, true)
  assert.equal(dup.deduplicated, true)
  assert.equal(submitted.length, 1)

  // First-sentence extraction handles multi-sentence summaries cleanly.
  const tkt2Out = await run('ticket_create', { title: 'Clean Logs', goal: 'Trim logs' }, 'm1')
  const tkt2Id = /Ticket (tkt-[0-9a-f]{8})/.exec(tkt2Out)[1]
  store.update(tkt2Id, { status: 'done' })
  await rt.memoryBridge.recordTicketMilestone({
    ticket: store.get(tkt2Id),
    summary: '已清理全部 14 天前日志。随后验证了磁盘水位正常。',
    artifacts: ['reports/gc.txt'],
  })
  assert.equal(submitted.length, 2)
  assert.equal(submitted[1].content, `[Ticket ${tkt2Id} 完成] Clean Logs：已清理全部 14 天前日志。（产物：reports/gc.txt）`)

  // Absent dshMemory degrades without throwing.
  const offline = startTeam(t)
  const offRes = await offline.rt.memoryBridge.recordTicketMilestone({
    ticket: { id: 'tkt-offline', title: 'Offline', goal: 'Work', status: 'done', ownerBotId: 'm1', artifacts: [] },
  })
  assert.deepEqual(offRes, { ok: false, reason: 'MEMORY_UNAVAILABLE' })
})

test('buildHandoffMemoryWarmup recalls entities and lessons on intra-day heavy part handoff while respecting privacy and dayRollover', async (t) => {
  const probeCalls = []
  const fakeMemory = {
    matchEntities: (text, opts) => {
      probeCalls.push(['entities', text, opts])
      if (!/server a/i.test(text)) return { totalMatched: 0, matches: [], text: '', estimatedTokens: 0 }
      return { totalMatched: 1, matches: [{ slug: 'server-a' }], text: '### Server A\n- Host: 10.0.0.8', estimatedTokens: 12 }
    },
    matchLessons: (text, opts) => {
      probeCalls.push(['lessons', text, opts])
      if (!/nginx/i.test(text)) return { totalMatched: 0, matches: [], text: '', estimatedTokens: 0 }
      return { totalMatched: 1, matches: [{ slug: 'nginx-reload' }], text: '### Nginx\n- Run nginx -t before reload', estimatedTokens: 14 }
    },
  }

  // Unit coverage for buildHandoffMemoryWarmup.
  const offline = startTeam(t)
  assert.equal(offline.rt.handoffMemoryWarmup({ botId: 'm1', recentLines: ['Check Server A nginx'] }), undefined)

  const { home, ctx, rt } = startTeam(t, { services: { dshMemory: fakeMemory } })
  assert.equal(rt.handoffMemoryWarmup({ botId: 'p1', recentLines: ['Check Server A nginx'] }), undefined, 'private Bot never recalls shared memory')
  assert.equal(rt.handoffMemoryWarmup({ botId: 'm1', recentLines: ['unrelated weather chat'] }), undefined)

  const warmup = rt.handoffMemoryWarmup({ botId: 'm1', recentLines: ['Deploy Server A with nginx'] })
  assert.match(warmup, /### Referenced Entities[\s\S]*Server A/)
  assert.match(warmup, /### Relevant Lessons[\s\S]*Run nginx -t before reload/)

  // Integration check: intra-day rt.newPart injects ## Recalled memory context from recent messages.
  const followed = []
  let createdCount = 0
  const oldSession = { id: 'm1', seq: 0, header: { cwd: home }, deriveMessages: () => [], requestHeader: () => ({}) }
  const freshSession = { id: 'm1-p2', seq: 0, header: { cwd: home }, deriveMessages: () => [], requestHeader: () => ({}) }
  const oldAgent = { id: 'm1', status: 'idle', whenIdle: async () => {}, runMaintenance: fn => fn(new AbortController().signal), session: oldSession, inbox: { nextStep: [], nextTurn: [], remove: () => {} } }
  const freshAgent = { id: 'm1-p2', status: 'idle', whenIdle: async () => {}, runMaintenance: fn => fn(new AbortController().signal), session: freshSession, inbox: { nextStep: [], nextTurn: [] }, followup: msg => followed.push(msg) }

  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  rt.eventsBackwards = async function* () {
    yield { type: 'user/message', seq: 2, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Let us inspect Server A and nginx next.' }] } }
  }
  rt.resolveAgent = async id => (id === 'm1-p2' ? freshAgent : oldAgent)
  rt.createSession = async () => { createdCount += 1; return `m1-p${createdCount + 1}` }
  rt.ensureCapabilities = async () => {}
  rt.moveSchedules = async () => {}
  rt.applyModel = async () => {}
  rt.applyPermission = async () => {}
  rt.desiredModel = async () => undefined
  rt.desiredEffort = async () => undefined

  await rt.newPart('m1')
  const deadline = Date.now() + 2000
  while (followed.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  assert.equal(followed.length, 1)
  const handoffText = followed[0].content[0].text
  assert.match(handoffText, /## Recalled memory context \(reference only, from recent messages\)/)
  assert.match(handoffText, /Host: 10\.0\.0\.8/)
  assert.match(handoffText, /Run nginx -t before reload/)

  // Contrast: lightweight dayRollover must still skip handoffMemoryWarmup.
  const followedRollover = []
  const p3Session = { id: 'm1-p3', seq: 0, header: { cwd: home }, deriveMessages: () => [], requestHeader: () => ({}) }
  const p3Agent = { id: 'm1-p3', status: 'idle', whenIdle: async () => {}, runMaintenance: fn => fn(new AbortController().signal), session: p3Session, inbox: { nextStep: [], nextTurn: [] }, followup: msg => followedRollover.push(msg) }
  rt.resolveAgent = async id => (id === 'm1-p3' ? p3Agent : freshAgent)
  await rt.rolloverPart('m1-p2', { date: '2026-11-26' })
  while (followedRollover.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  assert.equal(followedRollover.length, 1)
  assert.doesNotMatch(followedRollover[0].content[0].text, /Recalled memory context/)
})

test('tools/result on memory_forget purges matching orphan artifacts while keeping ticket references and private isolation', (t) => {
  const { ctx, rt } = startTeam(t)
  const forgetListener = (ctx.listeners.get('tools/result') ?? []).find(fn => fn.name === 'onMemoryForgetResult')
  assert.ok(forgetListener, 'onMemoryForgetResult listener registered')

  const baseMs = Date.UTC(2026, 10, 26, 10, 0, 0)
  const orphanSecret = rt.artifacts.save('forgotten api secret token dump', { sessionId: 'm1', botId: 'm1', now: baseMs })
  const ticketRef = rt.artifacts.save('retained ticket token output', { sessionId: 'm1', botId: 'm1', now: baseMs })
  const privateArt = rt.artifacts.save('private bot token note', { sessionId: 'm1', botId: 'p1', isPrivate: true, now: baseMs })
  const otherSessionArt = rt.artifacts.save('other session token output', { sessionId: 'b2', botId: 'b2', now: baseMs })

  const store = rt.openTicketStore()
  store.create({ title: 'Keep Ref', goal: 'Hold artifact', ownerBotId: 'm1', createdByBotId: 'm1', artifacts: [ticketRef.handle] })

  // Anchor-only, refused, or error calls do not purge artifacts.
  forgetListener(
    { name: 'memory_forget', arguments: { anchor: 'chat://m1/1' }, agent: { id: 'm1' } },
    { isError: false, content: [{ type: 'text', text: 'Forgot 1 archived message(s).' }] },
  )
  forgetListener(
    { name: 'memory_forget', arguments: { sessionId: 'm1', keyword: 'token' }, agent: { id: 'm1' } },
    { isError: true, content: [{ type: 'text', text: 'Error' }] },
  )
  forgetListener(
    { name: 'memory_forget', arguments: { sessionId: 'm1', keyword: 'token' }, agent: { id: 'm1' } },
    { isError: false, content: [{ type: 'text', text: 'Refusing empty forget request' }] },
  )
  assert.equal(rt.artifacts.readRaw(orphanSecret.id), 'forgotten api secret token dump')

  // Valid memory_forget call purges matching unreferenced orphan only.
  forgetListener(
    { name: 'memory_forget', arguments: { sessionId: 'm1', keyword: 'token' }, agent: { id: 'm1' } },
    { isError: false, content: [{ type: 'text', text: 'Forgot 2 archived message(s).' }] },
  )
  assert.equal(rt.artifacts.readRaw(orphanSecret.id), undefined)
  assert.equal(rt.artifacts.readRaw(ticketRef.id), 'retained ticket token output')
  assert.equal(rt.artifacts.readRaw(privateArt.id), 'private bot token note')
  assert.equal(rt.artifacts.readRaw(otherSessionArt.id), 'other session token output')
})
