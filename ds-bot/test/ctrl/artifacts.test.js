import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../../index.js'
import { ARTIFACT_PREFIX, createArtifactStore, parseArtifactHandle } from '../../src/host/ctrl/artifacts.js'
import { fakeContext } from '../fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Coder', role: 'Dev', createdAt: 2 },
    p1: { id: 'p1', sessionId: 'p1', name: 'Diary', role: 'Private', private: true, createdAt: 3 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function startTeam(t, config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-artifacts-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({})
  const rt = createRuntime(ctx, { home, ...config })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const postExecute = ctx.listeners.get('tools/post-execute').find(fn => fn.name === 'offloadLargeToolOutput')
  const tool = rt.teamTools.find(item => item.name === 'artifact_read')
  const runRead = (args, sessionId) => tool.execute(args, { agent: { id: sessionId } })
  return { home, ctx, rt, postExecute, runRead }
}

test('tools/post-execute offloads 50KB output to artifact:// and reconstructs exact content via paging', async (t) => {
  const { postExecute, rt, runRead } = startTeam(t, { ctrl: { artifactThresholdChars: 1000, artifactHeadChars: 120, artifactTailChars: 80 } })
  assert.ok(postExecute)

  const lines = Array.from({ length: 1200 }, (_, i) => `LINE_${String(i + 1).padStart(4, '0')}: payload chunk ${'x'.repeat(30)}${i === 777 ? ' NEEDLE_MATCH' : ''}`)
  const hugeText = lines.join('\n')
  assert.ok(hugeText.length > 50_000)

  const imageBlock = { type: 'image', attachment: { attachmentId: 'sha256:abc' } }
  const result = {
    isError: false,
    content: [imageBlock, { type: 'text', text: hugeText }],
  }
  const decision = await postExecute(
    { name: 'bash', agent: { id: 'm1', session: { id: 'm1' } } },
    result,
    async () => ({ kind: 'accept' }),
  )

  assert.equal(decision.kind, 'accept')
  assert.equal(Object.hasOwn(decision, 'value'), false, 'never returns conflicting value alongside content')
  assert.equal(decision.content.length, 2)
  assert.deepEqual(decision.content[0], imageBlock, 'non-text blocks are preserved')

  const summary = decision.content[1].text
  assert.ok(summary.length < 1500, 'summary stays compact')
  assert.match(summary, /artifact:\/\/art-[a-z0-9]+/)
  assert.match(summary, /Head preview/)
  assert.match(summary, /Tail preview/)

  const [handle] = /artifact:\/\/art-[a-z0-9]+/.exec(summary)

  // Reconstruct full 50KB content page-by-page using offset/limit.
  let offset = 0
  let rebuilt = ''
  let pages = 0
  while (true) {
    const page = rt.artifacts.readPage(handle, { offset, limit: 4000 })
    rebuilt += page.text
    pages += 1
    if (!page.hasMore) break
    offset = page.nextOffset
  }
  assert.ok(pages > 10)
  assert.equal(rebuilt, hugeText)

  // Tool artifact_read supports line-range, char offset, and keyword query.
  const lineView = await runRead({ handle, start_line: 777, end_line: 780 }, 'b2')
  assert.match(lineView, /lines 777\.\.780 of 1200/)
  assert.match(lineView, /LINE_0778:.*NEEDLE_MATCH/)

  const queryView = await runRead({ handle, query: 'needle_match' }, 'b2')
  assert.match(queryView, /1\/1 matching line/)
  assert.match(queryView, /L778: LINE_0778/)
})

test('below-threshold, skipped tools, and non-team sessions pass through untouched', async (t) => {
  const { postExecute } = startTeam(t, { ctrl: { artifactThresholdChars: 1000 } })

  const smallDecision = await postExecute(
    { name: 'read', agent: { id: 'm1' } },
    { isError: false, content: [{ type: 'text', text: 'short text' }] },
    async () => ({ kind: 'accept' }),
  )
  assert.deepEqual(smallDecision, { kind: 'accept' })

  const skippedDecision = await postExecute(
    { name: 'artifact_read', agent: { id: 'm1' } },
    { isError: false, content: [{ type: 'text', text: 'y'.repeat(5000) }] },
    async () => ({ kind: 'accept' }),
  )
  assert.deepEqual(skippedDecision, { kind: 'accept' })

  const outsiderDecision = await postExecute(
    { name: 'bash', agent: { id: 'plain-dsh-session' } },
    { isError: false, content: [{ type: 'text', text: 'z'.repeat(5000) }] },
    async () => ({ kind: 'accept' }),
  )
  assert.deepEqual(outsiderDecision, { kind: 'accept' })

  // Worker session hook is accepted when rt.isWorkerSession marks a session.
  const { postExecute: postWorker, rt: workerRt, runRead } = startTeam(t, { ctrl: { artifactThresholdChars: 100 } })
  workerRt.isWorkerSession = id => id === 'worker-tkt-1'
  const workerDecision = await postWorker(
    { name: 'bash', agent: { id: 'worker-tkt-1' } },
    { isError: true, content: [{ type: 'text', text: 'E'.repeat(500) }] },
    async () => ({ kind: 'accept', additionalContexts: [{ role: 'user', content: [{ type: 'text', text: 'extra' }] }] }),
  )
  assert.equal(workerDecision.additionalContexts.length, 1)
  const [workerHandle] = /artifact:\/\/art-[a-z0-9]+/.exec(workerDecision.content[0].text)
  const workerRead = await runRead({ handle: workerHandle }, 'worker-tkt-1')
  assert.match(workerRead, /chars 0\.\.500 of 500/)
})

test('artifact_read isolates private Bot artifacts and blocks path traversal handles', async (t) => {
  const { postExecute, runRead } = startTeam(t, { ctrl: { artifactThresholdChars: 50 } })

  assert.equal(parseArtifactHandle('../../etc/passwd'), undefined)
  assert.equal(parseArtifactHandle(`${ARTIFACT_PREFIX}../secret`), undefined)
  assert.match(await runRead({ handle: '../../etc/passwd' }, 'm1'), /Artifact not found/)

  const privDecision = await postExecute(
    { name: 'bash', agent: { id: 'p1' } },
    { isError: false, content: [{ type: 'text', text: 'TOP_SECRET_DIARY_LINE '.repeat(10) }] },
    async () => ({ kind: 'accept' }),
  )
  const [privHandle] = /artifact:\/\/art-[a-z0-9]+/.exec(privDecision.content[0].text)

  assert.match(await runRead({ handle: privHandle }, 'm1'), /Artifact not found/)
  assert.match(await runRead({ handle: privHandle }, 'b2'), /Artifact not found/)
  assert.match(await runRead({ handle: privHandle }, 'p1'), /TOP_SECRET_DIARY_LINE/)
})

test('createArtifactStore handles empty/zero threshold edge inputs safely', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-art-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))

  const store = createArtifactStore({ dir, thresholdChars: 100 })
  const meta = store.save('alpha\nbeta', { toolName: 'custom' })
  assert.equal(meta.lines, 2)
  assert.equal(store.readRaw(meta.id), 'alpha\nbeta')
  assert.equal(store.readPage(meta.handle, { startLine: 2, endLine: 2 }).text, 'beta')
  assert.equal(store.readPage(meta.handle, { query: 'missing' }).totalMatches, 0)
})

test('pruneExpired and pruneOrphans delete expired unreferenced artifacts while preserving referenced ones and lazy tickets.sqlite', (t) => {
  const freshTeam = startTeam(t, { ctrl: { artifactRetentionDays: 14, artifactGcStartupDelayMs: 60_000 } })
  const now = Date.now()
  const dayMs = 86_400_000

  // Empty/lazy runtime without tickets.sqlite: pruneOrphans works and never creates tickets.sqlite.
  const preMeta = freshTeam.rt.artifacts.save('stale pre-ticket log', { toolName: 'bash', now: now - 20 * dayMs })
  const preRes = freshTeam.rt.artifacts.pruneOrphans({ now })
  assert.equal(preRes.deleted, 1)
  assert.equal(existsSync(join(freshTeam.home, 'tickets.sqlite')), false, 'GC must preserve lazy tickets.sqlite invariant')
  assert.equal(freshTeam.rt.artifacts.readRaw(preMeta.id), undefined)

  // With ticket store open: active tickets, closed tickets, and assignments keep their referenced artifacts past TTL.
  const store = freshTeam.rt.openTicketStore()
  const artActive = freshTeam.rt.artifacts.save('active ticket artifact', { now: now - 30 * dayMs })
  const artClosed = freshTeam.rt.artifacts.save('done ticket artifact', { now: now - 30 * dayMs })
  const artAsg = freshTeam.rt.artifacts.save('assignment artifact', { now: now - 30 * dayMs })
  const artOrphanOld = freshTeam.rt.artifacts.save('expired orphan', { now: now - 20 * dayMs })
  const artOrphanFresh = freshTeam.rt.artifacts.save('fresh orphan', { now: now - 2 * dayMs })

  // Also test meta-less orphan falling back to file mtime.
  const artTxtOnly = freshTeam.rt.artifacts.save('meta-less stale txt', { now: now - 20 * dayMs })
  rmSync(join(freshTeam.rt.artifacts.dir, `${artTxtOnly.id}.json`), { force: true })
  const staleSec = (now - 20 * dayMs) / 1000
  utimesSync(join(freshTeam.rt.artifacts.dir, `${artTxtOnly.id}.txt`), staleSec, staleSec)

  store.create({ title: 'Active', goal: 'G1', ownerBotId: 'm1', createdByBotId: 'm1', artifacts: [artActive.handle] })
  const closed = store.create({ title: 'Closed', goal: 'G2', ownerBotId: 'm1', createdByBotId: 'm1', artifacts: [`log in ${artClosed.handle}`] })
  const asg = store.createAssignment({ ticketId: closed.id, prompt: 'work' })
  store.completeAssignment(asg.id, { reportStatus: 'done', reportSummary: 'ok', reportArtifacts: [artAsg.handle] })
  store.update(closed.id, { status: 'done' })

  const gcRes = freshTeam.rt.artifacts.pruneOrphans({ now })
  assert.deepEqual(gcRes, {
    scanned: 6,
    deleted: 2,
    keptReferenced: 3,
    keptFresh: 1,
    errors: 0,
  })
  assert.equal(freshTeam.rt.artifacts.readRaw(artActive.id), 'active ticket artifact')
  assert.equal(freshTeam.rt.artifacts.readRaw(artClosed.id), 'done ticket artifact')
  assert.equal(freshTeam.rt.artifacts.readRaw(artAsg.id), 'assignment artifact')
  assert.equal(freshTeam.rt.artifacts.readRaw(artOrphanFresh.id), 'fresh orphan')
  assert.equal(freshTeam.rt.artifacts.readRaw(artOrphanOld.id), undefined)
  assert.equal(existsSync(join(freshTeam.rt.artifacts.dir, `${artOrphanOld.id}.json`)), false)
  assert.equal(freshTeam.rt.artifacts.readRaw(artTxtOnly.id), undefined)
})
