import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../../index.js'
import { TEAM_TOOLS } from '../../src/host/constants.js'
import { createArtifactStore } from '../../src/host/ctrl/artifacts.js'
import {
  assembleWorkerPrompt,
  parseAcceptanceSpec,
  runMachineChecks,
} from '../../src/host/ctrl/worker-executor.js'
import { fakeContext } from '../fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Helper', role: 'Dev', instructions: '', createdAt: 2 },
    p1: { id: 'p1', sessionId: 'p1', name: 'Diary', role: 'Private', private: true, instructions: '', createdAt: 3 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function setupHarness(t, {
  config = {},
  team = TEAM,
  services = {},
  workerHandler,
  reviewerHandler,
  freezeSessionHeader = false,
  busySubagentResolve = false,
  withStandardPreset = true,
  defaultBotModel = 'deepseek/deepseek-chat',
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-worker-'))
  const teamWorkspace = join(home, 'workspace')
  mkdirSync(teamWorkspace, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...team, workspaceId: 'ws-team' }))

  const workspaces = new Map([['ws-team', { id: 'ws-team', path: teamWorkspace }]])
  const liveAgents = new Map()
  const createdSessions = []
  const archivedSessions = []
  const renamedSessions = []
  const scopedToolsBySession = new Map()
  const restrictedToolsBySession = new Map()
  const chiefDeliveries = []
  const entityQueries = []
  const lessonQueries = []
  const retrospectives = []
  const sessionEvents = []
  const handlerErrors = []

  const dshMemory = {
    contractVersion: 1,
    getCurrentLogicalDate: () => '2026-11-24',
    matchEntities: (text) => {
      entityQueries.push(text)
      return { totalMatched: 1, matches: [{ slug: 'alpha', name: 'Alpha' }], text: '### Alpha\n- Core API service', estimatedTokens: 12 }
    },
    matchLessons: (text) => {
      lessonQueries.push(text)
      return { totalMatched: 1, matches: [{ slug: 'win-ps', name: 'Win PS' }], text: '### Win PS\n- Never use && in PS 5.1', estimatedTokens: 12 }
    },
    submitBufferCandidate: async (input) => {
      retrospectives.push(input)
      return { ok: true, id: `buf-${retrospectives.length}`, status: 'pending' }
    },
    getMorningBriefing: () => ({ hasContent: false, alreadyDelivered: true, buffer: { pending: [], approved: [] } }),
    markBriefingDelivered: () => ({ ok: true }),
    confirmBufferItems: async () => ({ ok: true }),
  }

  let rt
  const ctx = fakeContext({
    services: {
      dshMemory,
      ...(withStandardPreset ? { agentPresets: { list: async () => [{ id: 'standard' }] } } : {}),
      agents: {
        list: () => [...liveAgents.values()],
        get: id => liveAgents.get(id),
      },
      ...services,
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
    const header = freezeSessionHeader ? Object.freeze(headerObj) : headerObj
    const scoped = new Map()
    const restricted = []
    scopedToolsBySession.set(sessionId, scoped)
    restrictedToolsBySession.set(sessionId, restricted)
    const modelSelections = []
    let idleWaiters = []
    let busy = false

    const agent = {
      id: sessionId,
      session: { id: sessionId, header, deriveMessages: () => [] },
      status: 'idle',
      modelSelections,
      model: {
        select: (sel) => { modelSelections.push(sel) },
      },
      ctx: {
        tools: {
          register: (toolDef) => {
            scoped.set(toolDef.name, toolDef)
            return () => { scoped.delete(toolDef.name) }
          },
          restrict: (filter) => {
            restricted.push(...(filter?.deny ?? []))
            return () => {}
          },
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
        if (sessionId === 'm1' || sessionId === 'p1') {
          chiefDeliveries.push({ sessionId, message })
          return
        }
        busy = true
        const runTurn = async () => {
          const emitEvent = (type, data) => {
            sessionEvents.push({ sessionId, type, data })
            for (const listener of ctx.listeners.get('session/event') ?? []) {
              if (listener.length >= 2) listener(agent.session, { type, data })
            }
          }
          const callTool = async (name, args) => {
            const toolDef = scoped.get(name) ?? rt.teamTools.find(item => item.name === name)
            if (!toolDef) throw new Error(`Tool ${name} not available on ${sessionId}`)
            return await toolDef.execute(args, { agent, name, callId: `call-${name}` })
          }
          const assemblePromptSections = () => {
            const out = {}
            for (const [secName, section] of ctx.sections.entries()) {
              out[secName] = typeof section.text === 'function' ? section.text({ agent }) : section.text
            }
            return out
          }
          try {
            const isReviewer = sessionId.startsWith('reviewer-')
            const handler = isReviewer ? reviewerHandler : workerHandler
            if (typeof handler === 'function') {
              await handler({
                sessionId,
                agent,
                message,
                scoped,
                restricted,
                callTool,
                emitEvent,
                assemblePromptSections,
                rt,
              })
            }
          } catch (error) {
            handlerErrors.push(error)
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
      archiveSession: async (sessionId, opts) => {
        archivedSessions.push({ sessionId, opts })
      },
    },
    sessionController: {
      create: async (opts) => {
        createdSessions.push(opts)
        assert.equal(opts.workspaceId !== undefined && opts.cwd !== undefined, false, 'never pass both workspaceId and cwd')
        const sid = opts.sessionId ?? `s-${createdSessions.length}`
        ensureAgent(sid, { origin: opts.origin, cwd: opts.cwd, parentSession: opts.parentSession })
        return { sessionId: sid, ...(opts.agentPreset ? { agentPreset: opts.agentPreset } : {}) }
      },
      resolveAgent: async (sessionId) => {
        const agent = ensureAgent(sessionId)
        if (busySubagentResolve && agent.session.header?.origin === 'subagent') {
          return { error: { code: 'session/agent-busy', message: 'subagent owned' } }
        }
        return { agent }
      },
      selectModel: async () => ({ selected: { provider: 'deepseek', model: 'deepseek-chat' } }),
    },
    sessionTitle: {
      rename: async (session, title) => { renamedSessions.push({ id: session.id, title }) },
    },
    sessions: { flush: async () => {} },
  })

  // Seed Chief & Bot agents in live registry.
  ensureAgent('m1')
  ensureAgent('b2')
  ensureAgent('p1')

  rt = createRuntime(ctx, { home, memory: false, ctrl: { effectPollMs: 50, ...config.ctrl } })
  rt.desiredModel = async () => defaultBotModel
  rt.ensureCapabilities = async () => {}
  rt.deliver = async ({ toId, fromName, text, role, recordExchange }) => {
    chiefDeliveries.push({ toId, fromName, text, role, recordExchange })
    return `ex-${chiefDeliveries.length}`
  }

  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  const runTool = (name, args, botId = 'm1') => {
    const def = rt.teamTools.find(item => item.name === name)
    assert.ok(def, `teamTool ${name} exists`)
    return def.execute(args, { agent: ensureAgent(botId) })
  }

  return {
    home,
    teamWorkspace,
    ctx,
    rt,
    runTool,
    ensureAgent,
    createdSessions,
    archivedSessions,
    renamedSessions,
    scopedToolsBySession,
    restrictedToolsBySession,
    chiefDeliveries,
    entityQueries,
    lessonQueries,
    retrospectives,
    sessionEvents,
    handlerErrors,
  }
}

test('parseAcceptanceSpec parses directives, bullets, JSON specs, and plain prose', () => {
  const dirSpec = parseAcceptanceSpec([
    '- cmd: npm test',
    '- file: dist/output.json',
    '- file_nonempty: dist/report.md',
    '- artifact: art-',
    '- reviewer: Check edge cases carefully',
    '- human: Confirm production rollout',
  ].join('\n'))

  assert.equal(dirSpec.checks.length, 4)
  assert.deepEqual(dirSpec.checks[0], { type: 'cmd', command: 'npm test' })
  assert.deepEqual(dirSpec.checks[1], { type: 'file', path: 'dist/output.json', nonEmpty: false })
  assert.deepEqual(dirSpec.checks[2], { type: 'file', path: 'dist/report.md', nonEmpty: true })
  assert.deepEqual(dirSpec.checks[3], { type: 'artifact', match: 'art-' })
  assert.equal(dirSpec.independentReview, 'Check edge cases carefully')
  assert.equal(dirSpec.needsHuman, true)
  assert.deepEqual(dirSpec.humanNotes, ['Confirm production rollout'])

  const jsonSpec = parseAcceptanceSpec(JSON.stringify({
    checks: [{ type: 'cmd', command: 'node -e "process.exit(0)"' }],
    autoComplete: false,
    maxRejections: 1,
  }))
  assert.equal(jsonSpec.checks.length, 1)
  assert.equal(jsonSpec.autoComplete, false)
  assert.equal(jsonSpec.needsHuman, false)
  assert.equal(jsonSpec.maxRejections, 1)

  const proseSpec = parseAcceptanceSpec('Make sure the final report reads clearly.')
  assert.equal(proseSpec.checks.length, 0)
  assert.equal(proseSpec.needsHuman, true)
})

test('runMachineChecks verifies files, artifacts, commands, and offloads huge failure logs', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'ds-bot-checks-'))
  const artDir = join(workDir, 'artifacts')
  t.after(() => rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }))

  writeFileSync(join(workDir, 'ok.txt'), 'hello', 'utf8')
  writeFileSync(join(workDir, 'empty.txt'), '', 'utf8')
  const artifactStore = createArtifactStore({ dir: artDir, thresholdChars: 100, headChars: 40, tailChars: 30 })

  const passRes = await runMachineChecks([
    { type: 'file', path: 'ok.txt', nonEmpty: true },
    { type: 'artifact', match: 'artifact://art-1' },
    { type: 'cmd', command: 'node -e "process.exit(0)"' },
  ], {
    workDir,
    artifacts: ['artifact://art-1'],
    artifactStore,
  })
  assert.equal(passRes.ok, true)

  const failRes = await runMachineChecks([
    { type: 'file', path: 'empty.txt', nonEmpty: true },
    { type: 'cmd', command: 'fail-loud' },
  ], {
    workDir,
    artifactStore,
    runCommand: async () => ({ ok: false, exitCode: 2, stdout: 'ERR_LINE '.repeat(30), stderr: '' }),
  })
  assert.equal(failRes.ok, false)
  assert.equal(failRes.failedArtifacts.length, 1)
  assert.match(failRes.failedArtifacts[0], /^artifact:\/\/art-/)
  assert.match(failRes.summary, /Required file is empty: empty\.txt/)
  assert.match(failRes.summary, /full output: artifact:\/\/art-/)
})

test('assembleWorkerPrompt builds clean context without Chief chat history', () => {
  const prompt = assembleWorkerPrompt({
    ticket: {
      id: 'tkt-12345678',
      title: 'Fix parser',
      goal: 'Fix edge case',
      mandate: 'Only touch parser.js',
      acceptance: 'cmd: npm test',
      nextStep: 'Run tests',
      blockers: 'None',
      revision: 3,
      artifacts: ['artifact://art-abc'],
    },
    assignment: { id: 'asg-1111', triggerKind: 'manual', triggerRef: 'm1', prompt: 'Check null input' },
    entities: { text: '### Entity\n- Parser facts' },
    lessons: { text: '### Lesson\n- Watch UTF-8 BOM' },
    recoveryNote: 'Recovered after crash',
  })

  assert.match(prompt, /## Ticket[\s\S]*tkt-12345678/)
  assert.match(prompt, /## Mandate \(Authorization Boundaries\)[\s\S]*Only touch parser\.js/)
  assert.match(prompt, /## Acceptance Criteria[\s\S]*cmd: npm test/)
  assert.match(prompt, /## Recovery Context[\s\S]*Recovered after crash/)
  assert.match(prompt, /## Existing Artifacts[\s\S]*artifact:\/\/art-abc/)
  assert.match(prompt, /## Relevant Entity Memory/)
  assert.match(prompt, /## Relevant Lessons & Pitfalls/)
  assert.match(prompt, /ticket_report/)
})

test('ticket_dispatch enforces permissions, revision lock, terminal checks, and idempotency_key', async (t) => {
  const h = setupHarness(t)
  await h.runTool('ticket_create', { title: 'Task 1', goal: 'Do work' }, 'm1')
  const ticket = h.rt.openTicketStore().list()[0]

  const nonMainErr = await h.runTool('ticket_dispatch', { id: ticket.id }, 'b2')
  assert.match(nonMainErr, /Only a Main Bot/)

  const revErr = await h.runTool('ticket_dispatch', { id: ticket.id, expected_revision: 99 }, 'm1')
  assert.match(revErr, /Revision conflict/)

  // Private Bot can dispatch its own private ticket, and cannot dispatch Main Bot's ticket.
  assert.match(await h.runTool('ticket_dispatch', { id: ticket.id }, 'p1'), /Ticket not found/)
  await h.runTool('ticket_create', { title: 'Private Task', goal: 'Keep private' }, 'p1')
  const privTicket = h.rt.openTicketStore().list({ ownerBotId: 'p1' })[0]

  // Prevent background pump from running until we inspect dedup behavior.
  const origHandler = h.rt.workerExecutor.handleDispatchAssignment
  assert.ok(origHandler)

  const d1 = await h.runTool('ticket_dispatch', { id: ticket.id, idempotency_key: 'dup-1', prompt: 'Run once' }, 'm1')
  const d2 = await h.runTool('ticket_dispatch', { id: ticket.id, idempotency_key: 'dup-1', prompt: 'Run once' }, 'm1')
  assert.match(d1, /Dispatched background Worker/)
  assert.match(d2, /Dispatch deduplicated/)

  await h.rt.ticketQueue.drain()
  assert.equal(h.rt.openTicketStore().listAssignments({ ticketId: ticket.id }).length, 1)

  // Private ticket skips memoryBridge entity/lesson lookup.
  h.entityQueries.length = 0
  h.lessonQueries.length = 0
  await h.runTool('ticket_dispatch', { id: privTicket.id, prompt: 'Do secret work' }, 'p1')
  await h.rt.ticketQueue.drain()
  assert.equal(h.entityQueries.length, 0)
  assert.equal(h.lessonQueries.length, 0)

  // Terminal ticket refuses dispatch.
  await h.runTool('ticket_update', { id: ticket.id, status: 'cancelled' }, 'm1')
  assert.match(await h.runTool('ticket_dispatch', { id: ticket.id }, 'm1'), /already "cancelled"/)
})

test('isolated worker runs cleanly without polluting state.bots, shares artifact offloading, and cleans up', async (t) => {
  let observedSections
  let observedScopedNames = []
  let observedRestricted = []
  let observedWorkerPrompt = ''
  let wasWorkerDuringRun = false
  let offloadedArtifactRead = ''

  const h = setupHarness(t, {
    freezeSessionHeader: true,
    busySubagentResolve: true,
    config: { ctrl: { artifactThresholdChars: 120, artifactHeadChars: 30, artifactTailChars: 20 } },
    workerHandler: async ({ sessionId, message, scoped, restricted, callTool, emitEvent, assemblePromptSections, rt }) => {
      observedSections = assemblePromptSections()
      observedScopedNames = [...scoped.keys()].sort()
      observedRestricted = [...restricted]
      observedWorkerPrompt = message.content[0].text
      wasWorkerDuringRun = rt.isWorkerSession(sessionId)

      // Simulate large tool output offloaded by artifacts.js tools/post-execute for this Worker.
      const postExecute = h.ctx.listeners.get('tools/post-execute').find(fn => fn.name === 'offloadLargeToolOutput')
      const postDecision = await postExecute(
        { name: 'bash', agent: { id: sessionId, session: { id: sessionId } } },
        { isError: false, content: [{ type: 'text', text: 'LOG_LINE '.repeat(40) }] },
        async () => ({ kind: 'accept' }),
      )
      const [artHandle] = /artifact:\/\/art-[a-z0-9]+/.exec(postDecision.content[0].text)
      offloadedArtifactRead = await callTool('artifact_read', { handle: artHandle, offset: 0, limit: 60 })
      const nonWorkerRefusal = await scoped.get('ticket_report').execute({ status: 'review', summary: 'Spoof' }, { agent: { id: 'm1' } })
      assert.match(nonWorkerRefusal, /Only an active Worker session/)

      emitEvent('step/end', { step: 1 })
      emitEvent('assistant/message', { message: { usage: { inputTokens: 120, outputTokens: 80 } } })

      await callTool('ticket_report', {
        status: 'progress',
        summary: 'Halfway done',
        next_step: 'Finalize output',
        artifacts: [artHandle],
      })
      assert.equal(h.chiefDeliveries.length, 0, 'progress never wakes Chief')

      await callTool('ticket_report', {
        status: 'waiting_user',
        summary: 'Need confirmation on deployment target',
        waiting_on: 'user',
        next_step: 'Pick staging or prod',
      })
    },
  })

  assert.equal(TEAM_TOOLS.includes('ticket_report'), false, 'ticket_report is worker-only, not in Chief TEAM_TOOLS')
  assert.equal(h.rt.teamTools.some(item => item.name === 'ticket_report'), false)

  await h.runTool('ticket_create', {
    title: 'Prepare Release',
    goal: 'Stage artifacts and confirm target',
    mandate: 'Read-only inspection only',
    acceptance: 'human: User picks deployment environment',
    artifacts: ['artifact://art-existing1'],
  }, 'm1')
  const ticket = h.rt.openTicketStore().list()[0]
  const botKeysBefore = Object.keys(h.rt.state.bots).sort()

  await h.runTool('ticket_dispatch', { id: ticket.id, prompt: 'Inspect Alpha release' }, 'm1')
  await h.rt.ticketQueue.drain()

  assert.deepEqual(Object.keys(h.rt.state.bots).sort(), botKeysBefore, 'state.bots is untouched')
  assert.equal(wasWorkerDuringRun, true)
  assert.equal(h.rt.isWorkerSession(h.createdSessions[0].sessionId), false, 'worker unregistered after finish')
  assert.match(h.createdSessions[0].sessionId, new RegExp(`^worker-${ticket.id}-asg-`))
  assert.equal(h.createdSessions[0].origin, 'subagent')
  assert.equal(h.createdSessions[0].agentPreset, 'standard')

  assert.ok(observedSections['ctrl-worker'].includes('Ephemeral Task Worker'))
  assert.equal(h.ctx.sections.get('ctrl-worker').text({ agent: { id: 'm1' } }), '')
  assert.deepEqual(observedScopedNames, ['artifact_read', 'ticket_report'])
  assert.ok(observedRestricted.includes('ask_user_question'))
  assert.ok(observedRestricted.includes('subagent'))
  assert.match(observedWorkerPrompt, /Read-only inspection only/)
  assert.match(observedWorkerPrompt, /artifact:\/\/art-existing1/)
  assert.match(observedWorkerPrompt, /### Alpha/)
  assert.match(observedWorkerPrompt, /### Win PS/)
  assert.match(offloadedArtifactRead, /LOG_LINE/)

  const updated = h.rt.openTicketStore().get(ticket.id)
  assert.equal(updated.status, 'waiting_user')
  assert.equal(updated.waitingOn, 'user')
  assert.equal(updated.artifacts.length, 2)

  const asg = h.rt.openTicketStore().listAssignments({ ticketId: ticket.id })[0]
  assert.equal(asg.status, 'ended')
  assert.equal(asg.reportStatus, 'waiting_user')
  assert.equal(asg.stepCount, 1)
  assert.equal(asg.tokenUsage, 200)

  assert.equal(h.archivedSessions.length, 1)
  assert.equal(h.archivedSessions[0].sessionId, h.createdSessions[0].sessionId)
  assert.deepEqual(h.archivedSessions[0].opts, { stopActivity: true })

  assert.equal(h.chiefDeliveries.length, 1)
  assert.equal(h.chiefDeliveries[0].role, 'worker_report')
  assert.equal(h.chiefDeliveries[0].recordExchange, false)
  assert.match(h.chiefDeliveries[0].text, /waiting_user/)
  assert.deepEqual(h.handlerErrors, [])
})

test('missing structured ticket_report never guesses status from free text and marks ticket recoverable blocked', async (t) => {
  const h = setupHarness(t, {
    workerHandler: async ({ emitEvent }) => {
      // Simulate LLM replying with free text that looks like "done" or "waiting_user", without calling ticket_report.
      emitEvent('assistant/message', {
        message: {
          content: [{ type: 'text', text: 'All done! Everything succeeded, should I deploy now?' }],
          usage: { totalTokens: 42 },
        },
      })
    },
  })

  await h.runTool('ticket_create', { title: 'No guessing', goal: 'Test strict report' }, 'm1')
  const ticket = h.rt.openTicketStore().list()[0]

  await h.runTool('ticket_dispatch', { id: ticket.id, prompt: 'Run' }, 'm1')
  await h.rt.ticketQueue.drain()

  const updated = h.rt.openTicketStore().get(ticket.id)
  assert.equal(updated.status, 'blocked')
  assert.match(updated.blockers, /free-text output is never inferred/)

  const asg = h.rt.openTicketStore().listAssignments({ ticketId: ticket.id })[0]
  assert.equal(asg.reportStatus, 'missing_report')
  assert.equal(asg.tokenUsage, 42)
  assert.equal(h.chiefDeliveries.length, 1)
  assert.match(h.chiefDeliveries[0].text, /blocked/)
  assert.deepEqual(h.handlerErrors, [])
})

test('failed ticket_report transitions to failed and forwards retrospective to dsh-memory buffer', async (t) => {
  const h = setupHarness(t, {
    workerHandler: async ({ callTool }) => {
      await callTool('ticket_report', {
        status: 'failed',
        summary: 'API endpoint permanently deprecated',
        blockers: 'HTTP 410 Gone',
        retrospective: 'Legacy billing v1 API was removed; always use v2',
        retrospective_tags: ['billing', 'api'],
      })
    },
  })

  await h.runTool('ticket_create', { title: 'Legacy API', goal: 'Fetch billing' }, 'm1')
  const ticket = h.rt.openTicketStore().list()[0]

  await h.runTool('ticket_dispatch', { id: ticket.id }, 'm1')
  await h.rt.ticketQueue.drain()

  const updated = h.rt.openTicketStore().get(ticket.id)
  assert.equal(updated.status, 'failed')
  assert.equal(h.retrospectives.length, 1)
  assert.equal(h.retrospectives[0].target, 'lesson:Legacy API')
  assert.deepEqual(h.retrospectives[0].tags, ['billing', 'api'])
  assert.equal(h.chiefDeliveries.length, 1)
  assert.match(h.chiefDeliveries[0].text, /failed/)
})

test('layered acceptance (R-2.6): machine check failure blocks fake completion and auto-reworks until checks pass', async (t) => {
  let runCount = 0
  let reworkPrompt = ''
  const h = setupHarness(t, {
    workerHandler: async ({ message, callTool }) => {
      runCount += 1
      if (runCount === 1) {
        // Claim review without creating required output file!
        await callTool('ticket_report', { status: 'review', summary: 'Finished early' })
        return
      }
      reworkPrompt = message.content[0].text
      writeFileSync(join(h.teamWorkspace, 'deliverable.txt'), 'verified payload', 'utf8')
      await callTool('ticket_report', {
        status: 'review',
        summary: 'Created deliverable and verified',
        retrospective: 'Always write deliverable.txt before calling review',
      })
    },
  })

  await h.runTool('ticket_create', {
    title: 'Build Deliverable',
    goal: 'Produce deliverable.txt and pass check',
    acceptance: [
      'file_nonempty: deliverable.txt',
      'cmd: node -e "const fs=require(\'fs\'); process.exit(fs.readFileSync(\'deliverable.txt\',\'utf8\').includes(\'verified\')?0:1)"',
    ].join('\n'),
  }, 'm1')
  const ticket = h.rt.openTicketStore().list()[0]

  await h.runTool('ticket_dispatch', { id: ticket.id, prompt: 'Generate deliverable' }, 'm1')
  await h.rt.ticketQueue.drain()

  assert.equal(runCount, 2)
  assert.match(reworkPrompt, /## Recovery Context[\s\S]*Missing required file: deliverable\.txt/)

  const assignments = h.rt.openTicketStore().listAssignments({ ticketId: ticket.id })
  assert.equal(assignments.length, 2)
  assert.equal(assignments[1].reportStatus, 'review_rejected')
  assert.equal(assignments[0].triggerKind, 'review_rejected')
  assert.equal(assignments[0].reportStatus, 'done')

  const doneTicket = h.rt.openTicketStore().get(ticket.id)
  assert.equal(doneTicket.status, 'done')
  assert.equal(h.retrospectives.length, 1)
  assert.equal(h.chiefDeliveries.length, 1, 'Chief woken only once when machine acceptance finally passes')
  assert.match(h.chiefDeliveries[0].text, /\*\*done\*\*/)
})

test('layered acceptance (R-2.6): max rejection cap stops rework loop and human gate holds at review', async (t) => {
  let runs = 0
  const h = setupHarness(t, {
    config: { ctrl: { maxReviewRejections: 1 } },
    workerHandler: async ({ callTool }) => {
      runs += 1
      await callTool('ticket_report', { status: 'review', summary: `Attempt ${runs}` })
    },
  })

  await h.runTool('ticket_create', {
    title: 'Always Missing',
    goal: 'Produce missing.txt',
    acceptance: 'file: missing.txt',
  }, 'm1')
  const t1 = h.rt.openTicketStore().list()[0]
  await h.runTool('ticket_dispatch', { id: t1.id }, 'm1')
  await h.rt.ticketQueue.drain()

  assert.equal(runs, 2, '1 initial attempt + 1 rework before hitting maxReviewRejections=1')
  const blocked = h.rt.openTicketStore().get(t1.id)
  assert.equal(blocked.status, 'blocked')
  assert.match(blocked.blockers, /failed after 2 attempt/)
  assert.equal(h.chiefDeliveries.length, 1)
  assert.match(h.chiefDeliveries[0].text, /\*\*blocked\*\*/)

  // Ticket with both cmd check AND human gate stays at review (never auto-closes to done).
  await h.runTool('ticket_create', {
    title: 'Human Gate',
    goal: 'Pass checks then ask human',
    acceptance: 'cmd: node -e "process.exit(0)"\nhuman: Confirm final deployment',
  }, 'm1')
  const t2 = h.rt.openTicketStore().list().find(item => item.title === 'Human Gate')
  await h.runTool('ticket_dispatch', { id: t2.id }, 'm1')
  await h.rt.ticketQueue.drain()

  assert.equal(h.rt.openTicketStore().get(t2.id).status, 'review')
  assert.equal(h.chiefDeliveries.length, 2)
  assert.match(h.chiefDeliveries[1].text, /ready for \*\*review\*\*/)
  assert.match(h.chiefDeliveries[1].text, /Confirm final deployment/)
})

test('layered acceptance (R-2.6): independent reviewer rejects defects and approves clean submission', async (t) => {
  let workerRuns = 0
  let reviewRuns = 0
  const h = setupHarness(t, {
    workerHandler: async ({ callTool }) => {
      workerRuns += 1
      await callTool('ticket_report', { status: 'review', summary: `Worker pass ${workerRuns}` })
    },
    reviewerHandler: async ({ callTool, emitEvent }) => {
      reviewRuns += 1
      emitEvent('step/end', { step: 1 })
      emitEvent('assistant/message', { message: { usage: { totalTokens: 50 } } })
      if (reviewRuns === 1) {
        await callTool('ticket_report', {
          status: 'blocked',
          summary: 'Missing edge-case guard',
          blockers: 'Empty input throws TypeError',
        })
        return
      }
      await callTool('ticket_report', { status: 'review', summary: 'All rubric checks look solid' })
    },
  })

  await h.runTool('ticket_create', {
    title: 'Reviewed Task',
    goal: 'Handle empty inputs',
    acceptance: 'cmd: node -e "process.exit(0)"\nindependent_review: Verify empty input handling',
  }, 'm1')
  const ticket = h.rt.openTicketStore().list()[0]

  await h.runTool('ticket_dispatch', { id: ticket.id }, 'm1')
  await h.rt.ticketQueue.drain()

  assert.equal(workerRuns, 2)
  assert.equal(reviewRuns, 2)
  assert.equal(h.rt.openTicketStore().get(ticket.id).status, 'done')
  assert.equal(h.chiefDeliveries.length, 1)
  assert.match(h.chiefDeliveries[0].text, /Independent review passed: All rubric checks look solid/)
})

test('startup crash recovery resumes interrupted assignment once without loop and ignores stale dispatch effect', async (t) => {
  // Phase 1: create ticket & simulate in-flight worker crash before completion.
  const h1 = setupHarness(t, {
    workerHandler: async () => {},
  })
  const store1 = h1.rt.openTicketStore()
  const ticket = store1.create({
    title: 'Crash Recover',
    goal: 'Finish after restart',
    acceptance: 'cmd: node -e "process.exit(0)"',
    ownerBotId: 'm1',
    createdByBotId: 'm1',
  })
  const { assignment } = store1.dispatchWithEffect({
    ticketId: ticket.id,
    prompt: 'Original work',
    idempotencyKey: 'crash-1',
  })
  store1.claimDueEffects()
  store1.startAssignment(assignment.id, { workerSessionId: `worker-${ticket.id}-${assignment.id}` })

  // Dispose runtime 1 before calling recoverOnStartup on a fresh runtime sharing the same home.
  const persistedHome = h1.home
  await h1.ctx.dispose()

  let resumedPrompt = ''
  const ctx2 = fakeContext({
    services: {
      agents: { list: () => [], get: () => undefined },
    },
  })
  const archivedOnRestart = []
  let activeAgent
  Object.assign(ctx2, {
    workspaceRegistry: {
      get: () => ({ id: 'ws-team', path: join(persistedHome, 'workspace') }),
      resolveByPath: async () => undefined,
      archiveSession: async (sessionId) => { archivedOnRestart.push(sessionId) },
    },
    sessionController: {
      create: async ({ sessionId }) => {
        const scoped = new Map()
        activeAgent = {
          id: sessionId,
          session: { id: sessionId, header: { id: sessionId, origin: 'subagent' }, deriveMessages: () => [] },
          ctx: {
            tools: { register: d => { scoped.set(d.name, d); return () => {} }, restrict: () => () => {} },
          },
          whenIdle: async () => {},
          followup: (msg) => {
            resumedPrompt = msg.content[0].text
            void scoped.get('ticket_report').execute({ status: 'review', summary: 'Recovered & finished' }, { agent: activeAgent })
          },
        }
        return { sessionId }
      },
      resolveAgent: async () => ({ agent: activeAgent }),
    },
    sessions: { flush: async () => {} },
  })
  const rt2 = createRuntime(ctx2, { home: persistedHome, memory: false, ctrl: { effectPollMs: 50 } })
  rt2.ensureCapabilities = async () => {}
  const wakeups = []
  rt2.deliver = async (payload) => { wakeups.push(payload); return 'ex-1' }

  try {
    await rt2.ticketQueue.drain()

    assert.ok(archivedOnRestart.includes(`worker-${ticket.id}-${assignment.id}`), 'orphaned session archived')
    assert.match(resumedPrompt, /## Recovery Context[\s\S]*Interrupted by host restart/)
    assert.equal(rt2.openTicketStore().get(ticket.id).status, 'done')
    assert.equal(wakeups.length, 1)

    // Anti-crash-loop: if a recovery assignment itself gets interrupted, mark ticket blocked instead of looping.
    const tLoop = rt2.openTicketStore().create({
      title: 'Recovery Loop Guard',
      goal: 'Avoid infinite restart loop',
      ownerBotId: 'm1',
      createdByBotId: 'm1',
    })
    const recAsg = rt2.openTicketStore().createAssignment({
      ticketId: tLoop.id,
      triggerKind: 'recovery',
      triggerRef: 'asg-prev',
      prompt: 'Retry',
    })
    rt2.openTicketStore().startAssignment(recAsg.id, { workerSessionId: `worker-${tLoop.id}-${recAsg.id}` })
    const rec = rt2.openTicketStore().recoverInterrupted({ note: 'Second crash during recovery' })
    await rt2.workerExecutor.handleRecoverAssignment(rec.recoveryEffects[0])

    const blockedLoop = rt2.openTicketStore().get(tLoop.id)
    assert.equal(blockedLoop.status, 'blocked')
    assert.match(blockedLoop.blockers, /Second crash during recovery/)
    assert.equal(wakeups.length, 2)
  } finally {
    await ctx2.dispose()
  }
})
