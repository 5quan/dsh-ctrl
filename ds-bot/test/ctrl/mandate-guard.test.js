import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../../index.js'
import {
  DEFAULT_MAX_WORKER_STEPS,
  DEFAULT_MAX_WORKER_TOKENS,
  evaluateMandateCall,
  parseMandatePolicy,
} from '../../src/host/ctrl/mandate-guard.js'
import { fakeContext } from '../fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Helper', role: 'Dev', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

async function runWaterfall(listeners, ...args) {
  let idx = 0
  const dispatch = () => {
    if (idx >= listeners.length) return Promise.resolve({ kind: 'allow' })
    const fn = listeners[idx++]
    return Promise.resolve(fn(...args, dispatch))
  }
  return dispatch()
}

async function runPreExecuteGate(ctx, exec) {
  const listeners = ctx.listeners.get('tools/pre-execute') ?? []
  return runWaterfall(listeners, exec)
}

async function waitUntil(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error('Timed out waiting for condition')
}

async function createTicket(h, args) {
  const out = String(await h.runTool('ticket_create', args))
  const match = /\b(tkt-[0-9a-zA-Z_-]+)\b/.exec(out)
  assert.ok(match, `expected ticket id in ticket_create output: ${out}`)
  return { id: match[1] }
}

function setupMandateHarness(t, { config = {}, workerHandler } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-mandate-'))
  const teamWorkspace = join(home, 'workspace')
  mkdirSync(join(teamWorkspace, 'allowed'), { recursive: true })
  mkdirSync(join(teamWorkspace, 'forbidden'), { recursive: true })
  writeFileSync(join(teamWorkspace, 'allowed', 'notes.txt'), 'ok')
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, workspaceId: 'ws-team' }))

  const workspaces = new Map([['ws-team', { id: 'ws-team', path: teamWorkspace }]])
  const liveAgents = new Map()
  const scopedToolsBySession = new Map()
  const archivedSessions = []
  const chiefDeliveries = []
  const approvalEvents = []
  const approvalWaitingAlerts = []
  const noteApprovals = []

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
    scopedToolsBySession.set(sessionId, scoped)
    const idleWaiters = []
    let busy = false

    const agent = {
      id: sessionId,
      session: { id: sessionId, header: Object.freeze(headerObj), deriveMessages: () => [] },
      status: 'idle',
      cancelledWith: null,
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
      cancel(reason) {
        agent.cancelledWith = reason ?? { kind: 'cancel' }
        busy = false
        for (const res of idleWaiters.splice(0)) res()
      },
      followup(message) {
        if (sessionId === 'm1') {
          chiefDeliveries.push({ sessionId, message })
          return
        }
        busy = true
        const runTurn = async () => {
          const emitEvent = (type, data) => {
            for (const listener of ctx.listeners.get('session/event') ?? []) {
              if (listener.length >= 2) listener(agent.session, { type, data })
            }
          }
          const runPreGate = (name, args, callId = `call-${name}-${Date.now()}`) => {
            return runPreExecuteGate(ctx, { name, arguments: args, callId, agent })
          }
          const callTool = async (name, args, callId = `call-${name}`) => {
            const gate = await runPreGate(name, args, callId)
            if (gate.kind !== 'allow') {
              return { blocked: true, decision: gate }
            }
            const toolDef = scoped.get(name) ?? rt.teamTools.find(item => item.name === name)
            if (!toolDef) throw new Error(`Tool ${name} not available on ${sessionId}`)
            return await toolDef.execute(args, { agent, name, callId })
          }
          try {
            if (typeof workerHandler === 'function') {
              await workerHandler({
                sessionId,
                agent,
                message,
                callTool,
                runPreGate,
                emitEvent,
                rt,
                ctx,
              })
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
      archiveSession: async (sessionId, opts) => {
        archivedSessions.push({ sessionId, opts })
      },
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

  rt = createRuntime(ctx, { home, memory: false, ctrl: { effectPollMs: 40, ...config.ctrl } })
  rt.desiredModel = async () => 'deepseek/deepseek-chat'
  rt.ensureCapabilities = async () => {}
  rt.approvalWaiting = entry => approvalWaitingAlerts.push(entry)
  rt.noteApproval = (sid, info) => noteApprovals.push({ sid, info })
  rt.deliver = async ({ toId, fromName, text, role, recordExchange }) => {
    chiefDeliveries.push({ toId, fromName, text, role, recordExchange })
    return `ex-${chiefDeliveries.length}`
  }
  const offApproval = rt.onApproval((kind, data) => approvalEvents.push({ kind, data }))

  t.after(async () => {
    offApproval()
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
    chiefDeliveries,
    archivedSessions,
    approvalEvents,
    approvalWaitingAlerts,
    noteApprovals,
  }
}

test('parseMandatePolicy supports both JSON and line-directive mandates', () => {
  const jsonPolicy = parseMandatePolicy(JSON.stringify({
    read_only: true,
    allow_dirs: ['./src', './test'],
    deny_dirs: ['./src/secrets'],
    allow_tools: ['read_*', 'grep', 'bash'],
    deny_tools: ['write_*'],
    deny_commands: ['rm -rf', '/sudo\\s+/i'],
    allow_external: false,
    max_steps: 12,
    max_tokens: 50_000,
  }))
  assert.equal(jsonPolicy.readOnly, true)
  assert.deepEqual(jsonPolicy.allowDirs, ['./src', './test'])
  assert.deepEqual(jsonPolicy.denyDirs, ['./src/secrets'])
  assert.deepEqual(jsonPolicy.allowTools, ['read_*', 'grep', 'bash'])
  assert.deepEqual(jsonPolicy.denyTools, ['write_*'])
  assert.deepEqual(jsonPolicy.denyCommands, ['rm -rf', '/sudo\\s+/i'])
  assert.equal(jsonPolicy.denyExternal, true)
  assert.equal(jsonPolicy.maxSteps, 12)
  assert.equal(jsonPolicy.maxTokens, 50_000)

  const directivePolicy = parseMandatePolicy([
    '- mode: read-only',
    '- allow_dirs: ./src, ./docs',
    '- deny_dirs: ./src/private',
    '- deny_tools: delete_*, fs_*',
    '- deny_commands: /\\b(DROP|TRUNCATE)\\b/i, curl -d',
    '- no_external',
    '- max_steps: 8',
    '- max_tokens: 12000',
  ].join('\n'))
  assert.equal(directivePolicy.readOnly, true)
  assert.deepEqual(directivePolicy.allowDirs, ['./src', './docs'])
  assert.deepEqual(directivePolicy.denyDirs, ['./src/private'])
  assert.deepEqual(directivePolicy.denyTools, ['delete_*', 'fs_*'])
  assert.deepEqual(directivePolicy.denyCommands, ['/\\b(DROP|TRUNCATE)\\b/i', 'curl -d'])
  assert.equal(directivePolicy.denyExternal, true)
  assert.equal(directivePolicy.maxSteps, 8)
  assert.equal(directivePolicy.maxTokens, 12_000)
})

test('evaluateMandateCall enforces tool lists, read-only, directories, deny_commands, and outbound guards', () => {
  const workDir = join(tmpdir(), 'mandate-eval-workspace')
  const mandate = [
    'read_only: true',
    'allow_dirs: ./allowed',
    'deny_dirs: ./allowed/secret, ~/.ssh',
    'allow_tools: read_file, write_file, bash, grep_search',
    'deny_tools: *evil*',
    'deny_commands: rm -rf, /drop\\s+table/i',
    'allow_external: false',
  ].join('\n')

  // Safe builtins always pass even with allow_tools restriction.
  assert.equal(evaluateMandateCall({ toolName: 'ticket_report', args: { status: 'done' }, mandate, workDir }).allowed, true)
  assert.equal(evaluateMandateCall({ toolName: 'artifact_read', args: { uri: 'artifact://a' }, mandate, workDir }).allowed, true)

  // Read-only file inside allowed dir passes; outside or sibling-prefix path is denied.
  assert.equal(evaluateMandateCall({
    toolName: 'read_file',
    args: { file_path: './allowed/notes.txt' },
    mandate,
    workDir,
  }).allowed, true)

  const escapeRes = evaluateMandateCall({
    toolName: 'read_file',
    args: { file_path: '../outside.txt' },
    mandate,
    workDir,
  })
  assert.equal(escapeRes.allowed, false)
  assert.equal(escapeRes.rule, 'allow_dirs')

  const prefixTrap = evaluateMandateCall({
    toolName: 'read_file',
    args: { file_path: './allowed-evil/notes.txt' },
    mandate,
    workDir,
  })
  assert.equal(prefixTrap.allowed, false)
  assert.equal(prefixTrap.rule, 'allow_dirs')

  const deniedSubdir = evaluateMandateCall({
    toolName: 'read_file',
    args: { file_path: './allowed/secret/token.txt' },
    mandate,
    workDir,
  })
  assert.equal(deniedSubdir.allowed, false)
  assert.equal(deniedSubdir.rule, 'deny_dirs')

  const tildeDenied = evaluateMandateCall({
    toolName: 'read_file',
    args: { file_path: join(homedir(), '.ssh', 'id_rsa') },
    mandate,
    workDir,
  })
  assert.equal(tildeDenied.allowed, false)
  assert.equal(tildeDenied.rule, 'deny_dirs')

  // Read-only blocks writes and mutating shell commands, allows read-only shell inside allowed dir.
  const writeBlocked = evaluateMandateCall({
    toolName: 'write_file',
    args: { file_path: './allowed/new.txt', content: 'x' },
    mandate,
    workDir,
  })
  assert.equal(writeBlocked.allowed, false)
  assert.equal(writeBlocked.rule, 'read_only')

  assert.equal(evaluateMandateCall({
    toolName: 'bash',
    args: { command: 'ls ./allowed' },
    mandate,
    workDir,
  }).allowed, true)

  assert.equal(evaluateMandateCall({
    toolName: 'bash',
    args: { command: 'echo hack > ./allowed/new.txt' },
    mandate,
    workDir,
  }).allowed, false)

  // Command & external checks under read-write mandate.
  const rwMandate = [
    'allow_dirs: ./allowed',
    'deny_commands: rm -rf, /drop\\s+table/i',
    'allow_external: false',
  ].join('\n')

  const extPush = evaluateMandateCall({
    toolName: 'bash',
    args: { command: 'git push origin main' },
    mandate: rwMandate,
    workDir,
  })
  assert.equal(extPush.allowed, false)
  assert.equal(extPush.rule, 'deny_external')

  const extCurl = evaluateMandateCall({
    toolName: 'bash',
    args: { command: 'curl -X POST https://example.com/hook -d "{}"' },
    mandate: rwMandate,
    workDir,
  })
  assert.equal(extCurl.allowed, false)
  assert.equal(extCurl.rule, 'deny_external')

  const extEmailTool = evaluateMandateCall({
    toolName: 'email_send',
    args: { to: 'x@example.com' },
    mandate: rwMandate,
    workDir,
  })
  assert.equal(extEmailTool.allowed, false)
  assert.equal(extEmailTool.rule, 'deny_external')

  const deniedCmd = evaluateMandateCall({
    toolName: 'bash',
    args: { command: 'psql -c "DROP TABLE users;"' },
    mandate: rwMandate,
    workDir,
  })
  assert.equal(deniedCmd.allowed, false)
  assert.equal(deniedCmd.rule, 'deny_commands')

  const shellEscape = evaluateMandateCall({
    toolName: 'bash',
    args: { command: 'cat ../forbidden/key.txt' },
    mandate: rwMandate,
    workDir,
  })
  assert.equal(shellEscape.allowed, false)
  assert.equal(shellEscape.rule, 'allow_dirs')
})

test('non-worker sessions pass through mandateGuard without interference', async (t) => {
  const h = setupMandateHarness(t)
  await h.rt.load()

  let nextCalled = false
  const listeners = h.ctx.listeners.get('tools/pre-execute')
  const mandateListener = listeners.find(fn => fn.name === 'mandateGuard')
  assert.ok(mandateListener, 'mandateGuard listener registered')

  const decision = await mandateListener(
    { callId: 'c1', name: 'write_file', arguments: { file_path: '../anywhere.txt' }, agent: h.ensureAgent('m1') },
    async () => {
      nextCalled = true
      return { kind: 'allow' }
    },
  )
  assert.equal(nextCalled, true)
  assert.equal(decision.kind, 'allow')
})

test('mandate violation denies tool, cancels turn, blocks trailing ticket_report, and escalates ticket to waiting_user', async (t) => {
  const decisions = []
  const h = setupMandateHarness(t, {
    workerHandler: async ({ runPreGate }) => {
      const readAllowed = await runPreGate('read_file', { file_path: './allowed/notes.txt' })
      decisions.push({ step: 'read', decision: readAllowed })

      // Attempt out-of-scope write alongside a parallel trailing ticket_report in the same step: both must be denied.
      const [denied, trailingGate] = await Promise.all([
        runPreGate('write_file', { file_path: './forbidden/leak.txt', content: 'secret' }),
        runPreGate('ticket_report', { status: 'review', summary: 'sneak pass' }),
      ])
      decisions.push({ step: 'write', decision: denied })
      decisions.push({ step: 'trailing', trailing: trailingGate })
    },
  })

  await h.rt.load()
  const created = await createTicket(h, {
    title: 'Mandate escape test',
    goal: 'Inspect allowed folder under read-only mandate without touching forbidden paths',
    mandate: 'mode: read-only\nallow_dirs: ./allowed',
  })
  await h.runTool('ticket_dispatch', { id: created.id, prompt: 'Inspect allowed folder only' })

  const store = h.rt.openTicketStore()
  await waitUntil(() =>
    store.get(created.id)?.status === 'waiting_user'
    && h.archivedSessions.length === 1
    && h.chiefDeliveries.some(d => /Mandate Guard/i.test(d.text) && d.text.includes('waiting_user')),
  )

  assert.equal(decisions[0].decision.kind, 'allow')
  assert.equal(decisions[1].decision.kind, 'deny')
  assert.match(decisions[1].decision.reason, /MANDATE_VIOLATION/)
  assert.equal(decisions[2].trailing.kind, 'deny')

  const finalTicket = store.get(created.id)
  assert.equal(finalTicket.status, 'waiting_user')
  assert.equal(finalTicket.waitingOn, 'user')
  assert.match(finalTicket.blockers, /read-only|allowed/i)

  const assignments = store.listAssignments(created.id)
  assert.equal(assignments[0].reportStatus, 'waiting_user')
  assert.ok(assignments[0].error.length > 0)
})

test('hidden worker approval/request is intercepted ahead of next(), forwarded cleanly, and settled on allow/reject/cancel', async (t) => {
  const outcomes = []
  let activeApprovalWorkerSessionId = ''
  const h = setupMandateHarness(t, {
    workerHandler: async ({ sessionId, callTool, runPreGate, agent, ctx }) => {
      activeApprovalWorkerSessionId = sessionId
      const approvalListeners = ctx.listeners.get('approval/request')
      assert.ok(approvalListeners.length > 0)

      // 1. Pre-execute stores call details before approval fires.
      const gate = await runPreGate('bash', {
        command: 'npm run migrate',
        description: 'Run DB schema migration',
      }, 'call-migrate-1')
      assert.equal(gate.kind, 'allow')

      let downstreamNextCalled = false
      const res1 = await runWaterfall(
        approvalListeners,
        {
          toolName: 'bash',
          callId: 'call-migrate-1',
          reason: 'Needs permission to modify DB',
          agent,
        },
        () => {
          downstreamNextCalled = true
          return new Promise(() => {}) // Would hang unseen if reached!
        },
      )
      outcomes.push({ which: 'first', outcome: res1, nextCalled: downstreamNextCalled })

      // 2. Second request rejected.
      await runPreGate('write_file', { file_path: './allowed/out.txt' }, 'call-write-2')
      const res2 = await runWaterfall(
        approvalListeners,
        {
          toolName: 'write_file',
          callId: 'call-write-2',
          reason: 'Confirm overwriting out.txt',
          agent,
        },
        () => { throw new Error('Hidden worker approval must not invoke next()') },
      )
      outcomes.push({ which: 'second', outcome: res2 })

      await callTool('ticket_report', { status: 'review', summary: 'Migration completed after approval.' })
    },
  })

  await h.rt.load()
  const created = await createTicket(h, {
    title: 'Approval bridge test',
    goal: 'Run migration steps while forwarding hidden worker approvals to Chief',
    mandate: 'allow_dirs: ./allowed',
  })
  await h.runTool('ticket_dispatch', { id: created.id, prompt: 'Run migration with user approval' })

  // Wait for first open approval card.
  await waitUntil(() => h.rt.approvalsView().length === 1)
  const [firstEntry] = h.rt.approvalsView()
  assert.equal(firstEntry.sessionId, activeApprovalWorkerSessionId)
  assert.equal(firstEntry.botId, 'm1')
  assert.equal(firstEntry.worker, true)
  assert.equal(firstEntry.ticketId, created.id)
  assert.equal(firstEntry.tool, 'bash')
  assert.equal(firstEntry.answerable, true)
  assert.deepEqual(firstEntry.detail, { text: 'Run DB schema migration', code: 'npm run migrate' })
  assert.equal(h.rt.waitsForApproval(activeApprovalWorkerSessionId), true)
  assert.equal(h.rt.activityView().m1, 'alert')
  assert.ok(h.approvalWaitingAlerts.some(a => a.id === firstEntry.id))
  await waitUntil(() => h.chiefDeliveries.some(d => d.text.includes(firstEntry.id) && d.text.includes('approval')))

  h.rt.answerApproval(firstEntry.id, 'allow')

  // Wait for second approval card.
  await waitUntil(() => h.rt.approvalsView().some(e => e.tool === 'write_file'))
  const secondEntry = h.rt.approvalsView().find(e => e.tool === 'write_file')
  h.rt.answerApproval(secondEntry.id, 'reject')

  const store = h.rt.openTicketStore()
  await waitUntil(() => store.get(created.id)?.status === 'review' && h.archivedSessions.length === 1)

  assert.deepEqual(outcomes, [
    { which: 'first', outcome: 'allowed-once', nextCalled: false },
    { which: 'second', outcome: 'rejected' },
  ])
  assert.equal(h.rt.approvalsView().length, 0)
  assert.equal(h.rt.waitsForApproval(activeApprovalWorkerSessionId), false)
  assert.deepEqual(h.rt.workerCallDetail(activeApprovalWorkerSessionId, 'call-migrate-1'), {}, 'worker call cache cleared on exit')
  assert.ok(h.approvalEvents.some(e => e.kind === 'settled' && e.data.id === firstEntry.id && e.data.outcome === 'allowed-once'))
  assert.ok(h.approvalEvents.some(e => e.kind === 'settled' && e.data.id === secondEntry.id && e.data.outcome === 'rejected'))
})

test('cancelApprovals settles pending hidden worker approvals when worker exits, while own-chat approvals keep racing next()', async (t) => {
  let pendingWorkerPromise = null
  const h = setupMandateHarness(t, {
    workerHandler: async ({ agent, ctx }) => {
      const approvalListeners = ctx.listeners.get('approval/request')
      pendingWorkerPromise = runWaterfall(
        approvalListeners,
        { toolName: 'bash', callId: 'c-abort', reason: 'Pending when worker stops', agent },
        () => new Promise(() => {}),
      )
      // Worker resolves its turn via whenIdle without waiting for approval (simulating abort/timeout/circuit break).
      await new Promise(resolve => setTimeout(resolve, 40))
    },
  })

  await h.rt.load()

  // Verify own-chat approval regression: next() IS called for normal chat session.
  h.rt.chatOwners.set('m1', 'm1')
  let ownChatNextCalled = false
  const ownOutcomePromise = runWaterfall(
    h.ctx.listeners.get('approval/request'),
    { toolName: 'bash', callId: 'c-chat', reason: 'Chat tool', agent: h.ensureAgent('m1') },
    () => {
      ownChatNextCalled = true
      return Promise.resolve('allowed-always')
    },
  )
  assert.equal(ownChatNextCalled, true)
  assert.equal(await ownOutcomePromise, 'allowed-always')

  // Verify worker exit cancels pending worker approvals cleanly.
  const created = await createTicket(h, {
    title: 'Cancel approvals on exit',
    goal: 'Ensure pending worker approvals settle cleanly as cancelled on exit',
  })
  await h.runTool('ticket_dispatch', { id: created.id, prompt: 'Wait on approval while exiting' })

  await waitUntil(() => pendingWorkerPromise !== null && h.archivedSessions.length === 1)
  assert.equal(await pendingWorkerPromise, 'cancelled')
  assert.equal(h.rt.approvalsView().length, 0)
  assert.ok(h.approvalEvents.some(e => e.kind === 'settled' && e.data.outcome === 'cancelled'))
})

test('step and token circuit breakers respect stricter cap and transition ticket to blocked (circuit_broken)', async (t) => {
  assert.equal(DEFAULT_MAX_WORKER_STEPS, 25)
  assert.equal(DEFAULT_MAX_WORKER_TOKENS, 200_000)

  let mode = 'steps'
  const h = setupMandateHarness(t, {
    config: { ctrl: { effectPollMs: 40, maxWorkerSteps: 10, maxWorkerTokens: 1000 } },
    workerHandler: async ({ emitEvent, agent, callTool }) => {
      if (mode === 'steps') {
        emitEvent('step/end', {})
        emitEvent('step/end', {})
        await agent.whenIdle()
      } else if (mode === 'tokens') {
        emitEvent('assistant/message', { message: { usage: { input_tokens: 650, output_tokens: 400 } } })
        await agent.whenIdle()
      } else {
        // Exact limit on final step AFTER structured ticket_report should complete cleanly.
        emitEvent('step/end', {})
        await callTool('ticket_report', { status: 'review', summary: 'Finished within step budget' })
        emitEvent('step/end', {})
      }
    },
  })

  await h.rt.load()
  const store = h.rt.openTicketStore()

  // 1. Step circuit breaker: mandate max_steps=2 < config 10 -> stricter 2 wins.
  const stepTicket = await createTicket(h, {
    title: 'Runaway steps',
    goal: 'Verify step limit trips circuit breaker',
    mandate: 'max_steps: 2',
  })
  await h.runTool('ticket_dispatch', { id: stepTicket.id, prompt: 'Loop steps' })
  await waitUntil(() =>
    store.get(stepTicket.id)?.status === 'blocked'
    && h.archivedSessions.length === 1
    && h.chiefDeliveries.some(d => d.text.includes('circuit breaker') && d.text.includes('2/2')),
  )

  const stepFinal = store.get(stepTicket.id)
  assert.equal(stepFinal.status, 'blocked')
  assert.match(stepFinal.blockers, /max steps \(2\/2\)/)
  assert.equal(store.listAssignments(stepTicket.id)[0].reportStatus, 'circuit_broken')

  // 2. Token circuit breaker: mandate max_tokens=50000 > config 1000 -> stricter 1000 wins.
  mode = 'tokens'
  const tokTicket = await createTicket(h, {
    title: 'Runaway tokens',
    goal: 'Verify token limit trips circuit breaker',
    mandate: 'max_tokens: 50000',
  })
  await h.runTool('ticket_dispatch', { id: tokTicket.id, prompt: 'Burn tokens' })
  await waitUntil(() =>
    store.get(tokTicket.id)?.status === 'blocked'
    && h.archivedSessions.length === 2
    && h.chiefDeliveries.some(d => d.text.includes('token') && d.text.includes('1050/1000')),
  )

  const tokFinal = store.get(tokTicket.id)
  assert.equal(tokFinal.status, 'blocked')
  assert.match(tokFinal.blockers, /token limit \(1050\/1000\)/)
  assert.equal(store.listAssignments(tokTicket.id)[0].reportStatus, 'circuit_broken')

  // 3. Finishing cleanly on the exact N-th step (ticket_report called before final step/end) does NOT trip breaker.
  mode = 'clean_exact_step'
  const exactTicket = await createTicket(h, {
    title: 'Exact budget finish',
    goal: 'Verify completing on exact max_steps succeeds without false break',
    mandate: 'max_steps: 2',
  })
  await h.runTool('ticket_dispatch', { id: exactTicket.id, prompt: 'Finish in 2 steps' })
  await waitUntil(() => store.get(exactTicket.id)?.status === 'review' && h.archivedSessions.length === 3)
  assert.equal(store.get(exactTicket.id).status, 'review')
})
