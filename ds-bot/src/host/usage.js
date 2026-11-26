// Usage ledger: the tokens each model call in this DSH spent, for the Usage page.
//
// A call that a Session logs (one assistant settlement per attempt) is read from that
// log, so calls made before this ledger existed count too. A call outside every log (a
// checkpoint, a handoff note, the steward, an image reading, DSH titles and compaction)
// is metered while it streams, from the time DS Bot runs. Rows go to usage.sqlite; like
// the chat index it is derived from the logs, and deleting it loses only the metered
// calls and the names of deleted Bots.
//
// A call belongs to a Bot (its own chat, its group Sessions, their earlier parts, and
// any Session forked or spawned under them), to a group chat's own Session, or to the
// rest of DSH ("other").
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const LEDGER_VERSION = 3
const PAGE_MESSAGES = 400
const PAGE_TIMEOUT_MS = 20_000
const SCAN_TIMEOUT_MS = 180_000
const SCAN_PARALLEL = 4
// A view waits this long for a scan, then answers with what it has.
const VIEW_WAIT_MS = 6_000
const RESCAN_AFTER_MS = 5_000
// An ended part still gets a few events (a title, a late reply) just after it ends.
const SEAL_AFTER_MS = 60_000
// Calls are summed per quarter hour, which every time zone offset divides.
const SLOT_MS = 15 * 60_000

const count = value => (Number.isSafeInteger(value) && value > 0 ? value : 0)

function usageChunk(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

const tokensOf = usage => ({
  input: count(usage.inputTokens),
  cacheRead: count(usage.cacheReadTokens),
  cacheWrite: count(usage.cacheWriteTokens),
  output: count(usage.outputTokens),
})

// Folds Session events, oldest first, into one row per billed attempt, as DSH's own
// tokenUsage projection counts them: a later sample of one attempt replaces the earlier
// one, and `llm/retry-started` begins a new attempt. The model is the one the latest
// request header named. A fork's events up to its inherited cut are the parent's, so
// the cut drops the rows before it (`reset`).
export function foldCalls(events, from = {}) {
  const state = { provider: from.provider ?? '', model: from.model ?? '', retry: from.retry ?? null }
  const rows = new Map()
  let reset = false
  for (const event of events) {
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'request/header': {
        const config = data.header?.config
        if (config?.provider && config?.model) Object.assign(state, { provider: config.provider, model: config.model })
        break
      }
      case 'request/context':
        if (data.provider && data.model) Object.assign(state, { provider: data.provider, model: data.model })
        break
      case 'llm/retry-started':
        state.retry = state.retry?.turn === data.turn && state.retry.step === data.step
          ? { ...state.retry, count: state.retry.count + 1 }
          : { turn: data.turn, step: data.step, count: 1 }
        break
      case 'session/end-seed':
        if (data.inherited === true) {
          rows.clear()
          reset = true
        }
        break
      case 'assistant/message':
      case 'assistant/attempt': {
        const usage = (event.type === 'assistant/message' ? data.usage : undefined) ?? usageChunk(data.stream)
        if (usage === undefined || usage === null) break
        const attempt = state.retry?.turn === data.turn && state.retry.step === data.step ? state.retry.count : 0
        const key = `${data.turn}:${data.step}:${attempt}`
        rows.set(key, { key, time: Number.isFinite(event.time) ? event.time : 0, provider: state.provider, model: state.model, ...tokensOf(usage) })
        break
      }
      default:
        break
    }
  }
  return { rows: [...rows.values()], state, reset }
}

// One aggregate per Session, model, use, and quarter hour.
function addTo(groups, row) {
  const slot = Math.floor(row.time / SLOT_MS)
  const id = `${row.session}\n${row.provider}\n${row.model}\n${row.kind}\n${slot}`
  const group = groups.get(id) ?? { session: row.session, provider: row.provider, model: row.model, kind: row.kind, slot, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }
  group.input += row.input
  group.cacheRead += row.cacheRead
  group.cacheWrite += row.cacheWrite
  group.output += row.output
  group.calls += row.calls ?? 1
  groups.set(id, group)
}

// A Session's seal, as the marks keep it. `seal` is undefined while the Session can
// still grow; `{listed: null}` for an ended part; `{listed}` for a cold Session, at
// the checkpoint watermark its listing showed.
const sealFields = seal => ({ sealed: seal !== undefined, listed: seal?.listed ?? null })

function memoryLedger() {
  const calls = new Map()
  const marks = new Map()
  const owners = new Map()
  const kinds = new Map()
  return {
    mark: session => marks.get(session),
    commit(session, { rows, reset, mark }) {
      if (reset) for (const [key, row] of calls) if (row.session === session && !row.live) calls.delete(key)
      for (const row of rows) calls.set(row.key, row)
      marks.set(session, mark)
    },
    add: row => calls.set(row.key, { ...row, live: true }),
    owners: () => new Map(owners),
    setOwner: (session, owner) => owners.set(session, owner),
    kinds: () => new Map(kinds),
    setKind: (session, kind) => kinds.set(session, kind),
    groups() {
      const groups = new Map()
      for (const row of calls.values()) addTo(groups, row)
      return [...groups.values()]
    },
    close() {},
  }
}

function sqliteLedger(DatabaseSync, path) {
  const db = new DatabaseSync(path)
  try {
    // Desktop and Web may share one DSH home; the other writer holds the lock
    // briefly, and the timeout must be armed before the WAL pragma can block.
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA journal_mode = WAL')
    const version = db.prepare('PRAGMA user_version').get().user_version
    // Version 2 lacks only the seal's watermark, so its rows are kept and gain the column.
    // Desktop and Web may open it at once: the version is read again under the write lock.
    if (version === 2) {
      db.exec('BEGIN IMMEDIATE')
      try {
        if (db.prepare('PRAGMA user_version').get().user_version === 2) {
          db.exec(`ALTER TABLE marks ADD COLUMN listed INTEGER;
            PRAGMA user_version = ${LEDGER_VERSION};`)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } else if (version !== LEDGER_VERSION) {
      db.exec(`
        DROP TABLE IF EXISTS calls;
        DROP TABLE IF EXISTS marks;
        DROP TABLE IF EXISTS owners;
        DROP TABLE IF EXISTS kinds;
        CREATE TABLE calls (key TEXT PRIMARY KEY, session TEXT NOT NULL, time INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, live INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL);
        CREATE INDEX calls_session ON calls (session);
        CREATE TABLE marks (session TEXT PRIMARY KEY, through INTEGER NOT NULL, fold TEXT NOT NULL, sealed INTEGER NOT NULL, listed INTEGER);
        CREATE TABLE owners (session TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL);
        CREATE TABLE kinds (session TEXT PRIMARY KEY, kind TEXT NOT NULL);
        PRAGMA user_version = ${LEDGER_VERSION};`)
    }
    const put = db.prepare('INSERT OR REPLACE INTO calls (key, session, time, provider, model, kind, live, input, cache_read, cache_write, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const dropLogged = db.prepare('DELETE FROM calls WHERE session = ? AND live = 0')
    const getMark = db.prepare('SELECT through, fold, sealed, listed FROM marks WHERE session = ?')
    const setMark = db.prepare('INSERT OR REPLACE INTO marks (session, through, fold, sealed, listed) VALUES (?, ?, ?, ?, ?)')
    const allOwners = db.prepare('SELECT session, owner, name FROM owners')
    const putOwner = db.prepare('INSERT OR REPLACE INTO owners (session, owner, name) VALUES (?, ?, ?)')
    const allKinds = db.prepare('SELECT session, kind FROM kinds')
    const putKind = db.prepare('INSERT OR REPLACE INTO kinds (session, kind) VALUES (?, ?)')
    const grouped = db.prepare(`SELECT session, provider, model, kind, time / ${SLOT_MS} AS slot, SUM(input) AS input, SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite, SUM(output) AS output, COUNT(*) AS calls FROM calls GROUP BY session, provider, model, kind, slot`)
    const insert = (row, live) => put.run(row.key, row.session, row.time, row.provider, row.model, row.kind, live ? 1 : 0, row.input, row.cacheRead, row.cacheWrite, row.output)
    return {
      mark(session) {
        const row = getMark.get(session)
        return row === undefined ? undefined : { through: row.through, fold: JSON.parse(row.fold), sealed: row.sealed === 1, listed: row.listed ?? null }
      },
      commit(session, { rows, reset, mark }) {
        db.exec('BEGIN')
        try {
          if (reset) dropLogged.run(session)
          for (const row of rows) insert(row, false)
          setMark.run(session, mark.through, JSON.stringify(mark.fold), mark.sealed ? 1 : 0, mark.listed ?? null)
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      },
      add: row => insert(row, true),
      owners: () => new Map(allOwners.all().map(row => [row.session, { owner: row.owner, name: row.name }])),
      setOwner: (session, owner) => putOwner.run(session, owner.owner, owner.name),
      kinds: () => new Map(allKinds.all().map(row => [row.session, row.kind])),
      setKind: (session, kind) => putKind.run(session, kind),
      groups: () => grouped.all().map(row => ({ ...row, slot: Number(row.slot) })),
      close: () => db.close(),
    }
  } catch (error) {
    db.close()
    throw error
  }
}

// Every hour bucket in one time zone, as `YYYY-MM-DD HH`.
export function hourKeys(timeZone) {
  let format
  try {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
  } catch {
    format = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
  }
  const cache = new Map()
  return (time) => {
    const slot = Math.floor(time / SLOT_MS)
    let key = cache.get(slot)
    if (key === undefined) {
      const part = Object.fromEntries(format.formatToParts(new Date(slot * SLOT_MS)).map(({ type, value }) => [type, value]))
      key = `${part.year}-${part.month}-${part.day} ${part.hour}`
      cache.set(slot, key)
    }
    return key
  }
}

async function eachLimited(items, limit, work) {
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
}

export function install(rt) {
  const { ctx, home, state } = rt
  const path = join(home, 'usage.sqlite')

  let ledger
  let opening
  // Metered calls that finish before the ledger opens.
  const early = []
  function openLedger() {
    if (ledger !== undefined) return Promise.resolve(ledger)
    const job = opening ??= (async () => {
      let DatabaseSync
      try {
        ({ DatabaseSync } = await import('node:sqlite'))
        await mkdir(home, { recursive: true })
      } catch (error) {
        rt.warn('ds-bot: usage is kept in memory only: %s', error)
        return memoryLedger()
      }
      // Only proven damage warrants a rebuild: Desktop and Web share this file,
      // and a busy lock must never read as corruption, or the other writer's
      // ledger would be deleted under it.
      const damaged = error => /malformed|not a database|corrupt/i.test(String(error?.message ?? error))
      for (const fresh of [false, true]) {
        try {
          if (fresh) await unlink(path).catch(() => {})
          return sqliteLedger(DatabaseSync, path)
        } catch (error) {
          if (fresh || !damaged(error)) {
            rt.warn('ds-bot: usage is kept in memory only: %s', error)
            return memoryLedger()
          }
        }
      }
      return memoryLedger()
    })().then((opened) => {
      // The plugin may have been disposed while the file opened.
      if (opening !== job) {
        opened.close()
        return memoryLedger()
      }
      for (const row of early.splice(0)) opened.add(row)
      return ledger = opened
    })
    return job
  }
  ctx.effect(() => () => {
    ledger?.close()
    ledger = undefined
    opening = undefined
  }, 'ds-bot: usage ledger')

  // Who each Session's calls belong to, from the team as it is now. Sessions forked or
  // spawned under one belong to the same owner, and a parent the team has lost
  // (a deleted Bot) still passes its journaled owner down the chain.
  function liveOwners(listed, stored) {
    const owners = new Map()
    const botOwner = bot => ({ owner: bot.id, name: bot.name })
    for (const bot of Object.values(state.bots)) {
      for (const sessionId of [bot.id, rt.chatOf(bot.id), ...(bot.segments ?? []).map(segment => segment.sessionId)]) owners.set(sessionId, botOwner(bot))
    }
    for (const room of Object.values(state.rooms)) {
      for (const sessionId of [rt.sessionOfRoom(room), ...(room.parts ?? []).map(segment => segment.sessionId)].filter(Boolean)) owners.set(sessionId, { owner: `room:${room.id}`, name: room.name })
      const memberOwner = botId => ({ owner: botId, name: rt.botOf(botId)?.name ?? '' })
      for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) owners.set(sessionId, memberOwner(botId))
      for (const [botId, segments] of Object.entries(room.segments ?? {})) {
        for (const segment of segments) owners.set(segment.sessionId, memberOwner(botId))
      }
    }
    // The DSH Agent is part of the team: its Sessions count beside the Bots, not
    // with the other sessions.
    for (const agent of Object.values(state.agents ?? {})) {
      for (const sessionId of agent.sessions ?? []) owners.set(sessionId, { owner: `agent:${agent.id}`, name: agent.name })
    }
    const ticketMap = rt.ticketUsageMap?.()
    const ticketOwners = ticketMap?.bySession
    if (ticketOwners) {
      for (const [sessionId, ticketOwner] of ticketOwners) {
        owners.set(sessionId, { owner: ticketOwner.owner, name: ticketOwner.name })
      }
    }
    const workerOwnerOf = (sessionId) => {
      const mapped = ticketOwners?.get(sessionId)
      if (mapped) return { owner: mapped.owner, name: mapped.name }
      const wCtx = rt.workerContextOf?.(sessionId) ?? rt.workerExecutor?.workerContextOf?.(sessionId)
      if (!wCtx?.ticketId) return undefined
      const ticket = ticketMap?.tickets?.get(wCtx.ticketId) ?? (rt.hasTicketStore?.() ? rt.openTicketStore().get(wCtx.ticketId) : undefined)
      return { owner: `ticket:${wCtx.ticketId}`, name: ticket?.title || wCtx.ticketId }
    }
    for (const item of listed ?? []) {
      if (item?.sessionId && !owners.has(item.sessionId)) {
        const found = workerOwnerOf(item.sessionId)
        if (found) owners.set(item.sessionId, found)
      }
    }
    const parents = new Map((listed ?? []).filter(item => item.parentSessionId).map(item => [item.sessionId, item.parentSessionId]))
    for (const sessionId of parents.keys()) {
      let root = sessionId
      for (let depth = 0; parents.has(root) && depth < 32; depth += 1) root = parents.get(root)
      if (owners.has(sessionId)) continue
      const found = owners.get(root) ?? stored?.get(root)
      if (found !== undefined) owners.set(sessionId, found)
    }
    return owners
  }

  let listed = []
  let scanning
  let scannedAt = 0

  // Sessions that speak inside a group chat, from the rooms as they are now.
  const inGroup = () => new Set(Object.values(state.rooms).flatMap(room => [
    ...Object.values(room.sessions ?? {}),
    ...Object.values(room.segments ?? {}).flat().map(segment => segment.sessionId),
  ]))

  // DSH reads a subagent Session only through its parent's address; the parent
  // need not exist any more. One with no parent on record cannot be read.
  const addressOf = item => (item.origin !== 'subagent'
    ? { kind: 'session', sessionId: item.sessionId }
    : item.parentSessionId === undefined
      ? undefined
      : { kind: 'subagent', parentSessionId: item.parentSessionId, childSessionId: item.sessionId, mode: 'unknown' })
  // Sessions that already failed to read, so each one warns once, not every scan.
  const unreadable = new Set()

  async function scanSession(ledger, address, asOfSeq, seal, signal) {
    const sessionId = address.kind === 'session' ? address.sessionId : address.childSessionId
    const mark = ledger.mark(sessionId)
    // A seal stands only while the listing shows the watermark it was sealed at, so a
    // cold Session whose log grew since is read again.
    if (mark?.sealed && seal !== undefined && mark.listed === seal.listed) return
    let through = asOfSeq
    if (through === undefined) {
      const projections = await ctx.sessionController.projections({ sessionId }, signal)
      if (projections === null || projections === undefined) return
      through = projections.asOfSeq
    }
    const from = mark?.through ?? -1
    if (!Number.isSafeInteger(through) || through <= from) {
      // Nothing new to read: a warm Session's seal is cleared, and a cold one is sealed again at its watermark.
      if (mark !== undefined && (seal !== undefined || mark.sealed)) ledger.commit(sessionId, { rows: [], reset: false, mark: { ...mark, ...sealFields(seal) } })
      return
    }
    const events = []
    let beforeSeq
    for (let reached = false; !reached;) {
      const page = await ctx.sessionController.page({
        address,
        throughSeq: through,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        maxMessages: PAGE_MESSAGES,
      }, AbortSignal.any([signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)]))
      const got = page.records.map(record => record.event)
      for (let index = got.length - 1; index >= 0; index -= 1) {
        if (got[index].seq <= from) {
          reached = true
          break
        }
        events.push(got[index])
      }
      if (!page.hasMore || got.length === 0) break
      beforeSeq = got[0].seq
    }
    events.reverse()
    if (events.length > 0 && events[0].seq !== from + 1) throw new Error(`the history of ${sessionId} came back with a gap`)
    const fold = foldCalls(events, mark?.fold)
    ledger.commit(sessionId, {
      rows: fold.rows.map(row => ({ ...row, key: `${sessionId}#${row.key}`, session: sessionId, kind: 'turn' })),
      reset: fold.reset,
      mark: { through, fold: fold.state, ...sealFields(seal) },
    })
  }

  // Catches every known Session up to its log. A part that ended a while ago is
  // complete, so it is sealed and never read again.
  function scan() {
    if (scanning !== undefined) return scanning
    if (Date.now() - scannedAt < RESCAN_AFTER_MS) return Promise.resolve()
    const job = (async () => {
      const ledger = await openLedger()
      await rt.load()
      const signal = AbortSignal.timeout(SCAN_TIMEOUT_MS)
      try {
        listed = (await ctx.sessionController.list({}, signal)).items ?? []
      } catch (error) {
        rt.warn('ds-bot: usage could not list the Sessions: %s', error)
      }
      const stored = ledger.owners()
      const owners = liveOwners(listed, stored)
      for (const [sessionId, owner] of owners) {
        const before = stored.get(sessionId)
        if (owner.name !== '' && (before?.owner !== owner.owner || before?.name !== owner.name)) ledger.setOwner(sessionId, owner)
      }
      // Group membership vanishes with the room, but a call that happened in a
      // group chat must stay one, so the kind is remembered like the owner is.
      const storedKinds = ledger.kinds()
      for (const sessionId of inGroup()) if (storedKinds.get(sessionId) !== 'group') ledger.setKind(sessionId, 'group')
      const ended = new Set()
      const longAgo = Date.now() - SEAL_AFTER_MS
      for (const bot of Object.values(state.bots)) for (const segment of bot.segments ?? []) if (segment.endedAt < longAgo) ended.add(segment.sessionId)
      for (const room of Object.values(state.rooms)) {
        for (const segments of Object.values(room.segments ?? {})) for (const segment of segments) if (segment.endedAt < longAgo) ended.add(segment.sessionId)
      }
      // A listing row's projections are hints, not cursors. Only a 'sequenced'
      // block shares the Session log's sequence space; a 'cached' block carries
      // the persisted cache's own watermark, so it must not cut a page. The
      // Session's exact cursor is read below when no hint is usable.
      const listedCursor = item => (item.projections?.kind === 'sequenced' ? item.projections.asOfSeq : undefined)
      // A Session with no Agent attached is cold. Its listing carries the watermark of its
      // checkpoint, which DSH rewrites at each turn end and when the Session is detached, so
      // the watermark moves when the log does. A cold Session seals at that watermark only:
      // the watermark is compared with an earlier listing, never with a log sequence.
      const coldWatermarks = new Map(listed
        .filter(item => item.agentAvailable !== true && item.running !== true && item.projections?.kind === 'cached' && Number.isSafeInteger(item.projections.asOfSeq))
        .map(item => [item.sessionId, item.projections.asOfSeq]))
      // An ended part is complete, so it seals for good.
      const sealOf = sessionId => (ended.has(sessionId) ? { listed: null } : coldWatermarks.has(sessionId) ? { listed: coldWatermarks.get(sessionId) } : undefined)
      const targets = new Map()
      for (const item of listed) {
        if (item.blank !== true && storedKinds.get(item.sessionId) !== 'worker') {
          targets.set(item.sessionId, listedCursor(item))
        }
      }
      for (const sessionId of owners.keys()) {
        if (storedKinds.get(sessionId) === 'worker') continue
        if (!targets.has(sessionId)) targets.set(sessionId, undefined)
      }
      const addresses = new Map(listed.map(item => [item.sessionId, addressOf(item)]))
      let cut = 0
      const failed = []
      await eachLimited([...targets], SCAN_PARALLEL, async ([sessionId, asOfSeq]) => {
        if (signal.aborted) {
          cut += 1
          return
        }
        const address = addresses.has(sessionId) ? addresses.get(sessionId) : { kind: 'session', sessionId }
        if (address === undefined) return
        try {
          await scanSession(ledger, address, asOfSeq, sealOf(sessionId), signal)
          unreadable.delete(sessionId)
        } catch (error) {
          // The scan timeout cancels the reads still open. Those Sessions are not broken,
          // so they are counted with the ones it never reached, not remembered as unreadable.
          if (signal.aborted) {
            cut += 1
            return
          }
          if (unreadable.has(sessionId)) return
          unreadable.add(sessionId)
          failed.push([sessionId, error])
        }
      })
      // One line for the whole scan, not one per Session it could not read.
      const missed = failed.length + cut
      if (missed > 0) {
        rt.warn('ds-bot: usage could not read %d Session%s%s%s', missed, missed === 1 ? '' : 's',
          cut > 0 ? ' before the scan ran out of time' : '',
          failed.length > 0 ? `: ${failed.map(([sessionId]) => sessionId).join(', ')} (first error: ${failed[0][1]})` : '')
      }
    })().finally(() => {
      scannedAt = Date.now()
      scanning = undefined
    })
    scanning = job
    return job
  }

  // Tokens per hour, owner, model, and use, for the browser to sum by day, week, or month.
  async function usageView({ timeZone } = {}) {
    const job = scan().catch(error => rt.warn('ds-bot: usage scan failed: %s', error))
    let timer
    await Promise.race([job, new Promise((resolve) => { timer = setTimeout(resolve, VIEW_WAIT_MS) })])
    clearTimeout(timer)
    const ledger = await openLedger()
    const stored = ledger.owners()
    const live = liveOwners(listed, stored)
    const hourOf = hourKeys(typeof timeZone === 'string' ? timeZone : undefined)
    // A deleted Bot or group keeps the name it had when its calls were last read.
    const describe = (key, name) => {
      if (key === 'other') return { key, kind: 'other' }
      if (key.startsWith('room:')) {
        const id = key.slice('room:'.length)
        const room = rt.roomOf(id)
        return { key, kind: 'room', id, name: room?.name ?? name, ...(room ? {} : { deleted: true }) }
      }
      if (key.startsWith('agent:')) {
        const id = key.slice('agent:'.length)
        const agent = rt.own(state.agents, id)
        return { key, kind: 'agent', id, name: agent?.name ?? name, ...(agent ? {} : { deleted: true }) }
      }
      if (key.startsWith('ticket:')) {
        const id = key.slice('ticket:'.length)
        const ticket = rt.hasTicketStore?.() ? rt.openTicketStore().get(id) : undefined
        return { key, kind: 'ticket', id, name: ticket?.title || name || id, status: ticket?.status, ...(ticket ? {} : { deleted: true }) }
      }
      const bot = rt.botOf(key)
      return { key, kind: 'bot', id: key, name: bot?.name ?? name, ...(bot ? {} : { deleted: true }) }
    }
    const owners = []
    const ownerIndex = new Map()
    const ownerOf = (sessionId) => {
      const found = live.get(sessionId) ?? stored.get(sessionId)
      const key = found?.owner ?? 'other'
      if (!ownerIndex.has(key)) {
        ownerIndex.set(key, owners.length)
        owners.push(describe(key, found?.name ?? ''))
      }
      return ownerIndex.get(key)
    }
    const catalog = rt.cachedCatalog()
    const models = []
    const modelIndex = new Map()
    const modelOf = (provider, model) => {
      const key = `${provider}/${model}`
      if (!modelIndex.has(key)) {
        modelIndex.set(key, models.length)
        const entry = catalog.find(item => item.ref === key)
        models.push({ key, provider, model, name: entry?.name ?? model, ...(entry?.providerName ? { providerName: entry.providerName } : {}) })
      }
      return modelIndex.get(key)
    }
    const kinds = []
    const kindIndex = new Map()
    const kindOf = (kind) => {
      if (!kindIndex.has(kind)) {
        kindIndex.set(kind, kinds.length)
        kinds.push(kind)
      }
      return kindIndex.get(kind)
    }
    const groupSessions = inGroup()
    const buckets = new Map()
    const storedKinds = ledger.kinds()
    for (const group of ledger.groups()) {
      const ownerIdx = ownerOf(group.session)
      const isWorker = owners[ownerIdx]?.kind === 'ticket' || storedKinds.get(group.session) === 'worker'
      const kind = group.kind === 'turn'
        ? (isWorker ? 'worker' : groupSessions.has(group.session) || storedKinds.get(group.session) === 'group' ? 'group' : 'chat')
        : group.kind
      const row = [hourOf(group.slot * SLOT_MS), ownerIdx, modelOf(group.provider, group.model), kindOf(kind)]
      const id = row.join('\n')
      const bucket = buckets.get(id) ?? [...row, 0, 0, 0, 0, 0]
      bucket[4] += group.input
      bucket[5] += group.cacheRead
      bucket[6] += group.cacheWrite
      bucket[7] += group.output
      bucket[8] += group.calls
      buckets.set(id, bucket)
    }
    return {
      owners,
      models,
      kinds,
      // [hour, owner, model, kind, input, cacheRead, cacheWrite, output, calls]
      rows: [...buckets.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      now: hourOf(Date.now()),
      scanning: scanning !== undefined,
      ticketUsage: await usageTicketSummary({ ledger, stored, live }),
    }
  }

  async function usageTicketSummary({ ticketId, ledger: givenLedger, stored: givenStored, live: givenLive } = {}) {
    const cleanTicketId = typeof ticketId === 'string' && ticketId.trim() !== '' ? ticketId.trim() : undefined
    const ticketMap = rt.ticketUsageMap?.() ?? { bySession: new Map(), tickets: new Map(), assignments: [] }
    const hasLedgerFile = ledger !== undefined || existsSync(path)
    const emptyTotals = { total: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0, steps: 0, ticketCount: 0, assignmentCount: 0 }
    if (!hasLedgerFile && ticketMap.tickets.size === 0) {
      return { tickets: [], totals: emptyTotals }
    }

    const book = givenLedger ?? (hasLedgerFile ? await openLedger() : undefined)
    const bookStored = givenStored ?? book?.owners?.() ?? new Map()
    const bookLive = givenLive ?? liveOwners(listed, bookStored)

    const sessionSums = new Map()
    const sessionTicketIds = new Map()
    const ticketIds = new Set(ticketMap.tickets.keys())

    for (const group of book?.groups?.() ?? []) {
      const mappedTicketId = ticketMap.bySession.get(group.session)?.ticketId
      const ownerEntry = bookLive.get(group.session) ?? bookStored.get(group.session)
      const ownerTicketId = ownerEntry?.owner?.startsWith('ticket:') ? ownerEntry.owner.slice('ticket:'.length) : undefined
      const resolvedTicketId = mappedTicketId ?? ownerTicketId
      if (!resolvedTicketId) continue
      if (cleanTicketId !== undefined && resolvedTicketId !== cleanTicketId) continue

      ticketIds.add(resolvedTicketId)
      if (!sessionTicketIds.has(group.session)) sessionTicketIds.set(group.session, new Set())
      sessionTicketIds.get(group.session).add(resolvedTicketId)

      const cur = sessionSums.get(group.session) ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0, total: 0 }
      cur.input += group.input
      cur.cacheRead += group.cacheRead
      cur.cacheWrite += group.cacheWrite
      cur.output += group.output
      cur.calls += group.calls
      cur.total = cur.input + cur.cacheRead + cur.cacheWrite + cur.output
      sessionSums.set(group.session, cur)
    }

    const assignmentsByTicket = new Map()
    for (const assignment of ticketMap.assignments) {
      if (cleanTicketId !== undefined && assignment.ticketId !== cleanTicketId) continue
      if (!assignmentsByTicket.has(assignment.ticketId)) assignmentsByTicket.set(assignment.ticketId, [])
      assignmentsByTicket.get(assignment.ticketId).push(assignment)
      ticketIds.add(assignment.ticketId)
    }

    const ticketsOut = []
    const totals = { ...emptyTotals }
    const targetIds = cleanTicketId !== undefined ? (ticketIds.has(cleanTicketId) ? [cleanTicketId] : []) : [...ticketIds]

    for (const id of targetIds) {
      const ticket = ticketMap.tickets.get(id)
      const list = assignmentsByTicket.get(id) ?? []
      const seenSessions = new Set()
      let input = 0
      let cacheRead = 0
      let cacheWrite = 0
      let output = 0
      let calls = 0
      let steps = 0
      let total = 0
      const assignmentRows = []

      for (const assignment of list) {
        const sId = assignment.workerSessionId
        if (sId) seenSessions.add(sId)
        const sSum = sId ? sessionSums.get(sId) : undefined
        const ledgerTotal = sSum?.total ?? 0
        const fallbackTotal = ledgerTotal === 0 && assignment.tokenUsage > 0 ? assignment.tokenUsage : 0
        const aTotal = ledgerTotal > 0 ? ledgerTotal : fallbackTotal
        input += sSum?.input ?? 0
        cacheRead += sSum?.cacheRead ?? 0
        cacheWrite += sSum?.cacheWrite ?? 0
        output += sSum?.output ?? 0
        calls += sSum?.calls ?? 0
        steps += assignment.stepCount ?? 0
        total += aTotal
        assignmentRows.push({
          id: assignment.id,
          workerSessionId: sId,
          status: assignment.status,
          reportStatus: assignment.reportStatus,
          stepCount: assignment.stepCount ?? 0,
          calls: sSum?.calls ?? 0,
          input: sSum?.input ?? 0,
          cacheRead: sSum?.cacheRead ?? 0,
          cacheWrite: sSum?.cacheWrite ?? 0,
          output: sSum?.output ?? 0,
          total: aTotal,
          estimated: fallbackTotal > 0,
          createdAt: assignment.createdAt,
          endedAt: assignment.endedAt,
        })
      }

      for (const [sId, tSet] of sessionTicketIds) {
        if (!tSet.has(id) || seenSessions.has(sId)) continue
        const sSum = sessionSums.get(sId)
        if (!sSum) continue
        input += sSum.input
        cacheRead += sSum.cacheRead
        cacheWrite += sSum.cacheWrite
        output += sSum.output
        calls += sSum.calls
        total += sSum.total
        assignmentRows.push({
          id: sId,
          workerSessionId: sId,
          status: 'ended',
          reportStatus: '',
          stepCount: 0,
          calls: sSum.calls,
          input: sSum.input,
          cacheRead: sSum.cacheRead,
          cacheWrite: sSum.cacheWrite,
          output: sSum.output,
          total: sSum.total,
          estimated: false,
          createdAt: 0,
          endedAt: null,
        })
      }

      if (total === 0 && assignmentRows.length === 0) continue

      const ownerName = ticket?.ownerBotId ? (rt.botOf?.(ticket.ownerBotId)?.name ?? ticket.ownerBotId) : ''
      const storedOwnerName = [...seenSessions].map(sId => (bookLive.get(sId) ?? bookStored.get(sId))?.name).find(Boolean)
      ticketsOut.push({
        id,
        title: ticket?.title || storedOwnerName || id,
        status: ticket?.status ?? 'deleted',
        ownerBotId: ticket?.ownerBotId ?? '',
        ownerBotName: ownerName,
        assignmentCount: assignmentRows.length,
        steps,
        calls,
        input,
        cacheRead,
        cacheWrite,
        output,
        total,
        updatedAt: ticket?.updatedAt ?? 0,
        assignments: assignmentRows,
      })

      totals.input += input
      totals.cacheRead += cacheRead
      totals.cacheWrite += cacheWrite
      totals.output += output
      totals.calls += calls
      totals.steps += steps
      totals.total += total
      totals.assignmentCount += assignmentRows.length
    }

    ticketsOut.sort((a, b) => b.total - a.total || b.updatedAt - a.updatedAt)
    totals.ticketCount = ticketsOut.length
    return { tickets: ticketsOut, totals }
  }

  // DS Bot tags the requests it makes outside a Session with the Session they serve.
  const tags = new WeakMap()
  const tagUsage = (messages, tag) => {
    if (messages !== null && typeof messages === 'object') tags.set(messages, tag)
    return messages
  }
  const carryUsageTag = (from, to) => {
    const tag = from !== null && typeof from === 'object' ? tags.get(from) : undefined
    if (tag !== undefined) tagUsage(to, tag)
  }
  // DS Bot's own requests name the Session they serve, as some routes require, so
  // `sessionId` alone does not make a request that Session's own round; the tag does.
  const ownRequest = options => tags.has(options?.messages)
  // Owner and group use are journaled with the call itself: a Bot or room that
  // is deleted before the first scan still leaves its calls under its own name.
  const journaled = new Map()
  const journal = (book, sessionId, isWorker = false) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const owner = liveOwners(listed, book.owners()).get(sessionId)
    if (owner !== undefined && owner.name !== '') {
      const stamp = `${owner.owner}\n${owner.name}`
      if (journaled.get(sessionId) !== stamp) {
        journaled.set(sessionId, stamp)
        book.setOwner(sessionId, owner)
      }
    }
    if (isWorker && journaled.get(`${sessionId}\nworker`) === undefined) {
      journaled.set(`${sessionId}\nworker`, true)
      book.setKind(sessionId, 'worker')
    } else if (inGroup().has(sessionId) && journaled.get(`${sessionId}\ngroup`) === undefined) {
      journaled.set(`${sessionId}\ngroup`, true)
      book.setKind(sessionId, 'group')
    }
  }
  // Plain Session requests skip the meter, so every caller notes its Session
  // here. The journal needs the team state and the ledger; both load behind
  // the request, and `journaled` keeps the repeat calls from writing again.
  const noteSession = (sessionId, isWorker = false) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    void (async () => {
      await rt.load()
      const book = ledger ?? await openLedger().catch(() => undefined)
      if (book === undefined) return
      try { journal(book, sessionId, isWorker) } catch (error) { rt.warn('ds-bot: usage could not journal %s: %s', sessionId, error) }
    })()
  }
  function record({ sessionId, kind, provider, model, usage, isWorker = false }) {
    noteSession(sessionId, isWorker)
    const row = { key: `live:${randomUUID()}`, session: sessionId ?? '', time: Date.now(), provider: provider ?? '', model: model ?? '', kind, ...tokensOf(usage) }
    if (ledger !== undefined) {
      try {
        ledger.add(row)
        if (isWorker && typeof sessionId === 'string' && sessionId !== '') ledger.setKind(sessionId, 'worker')
      } catch (error) { rt.warn('ds-bot: usage could not record a call: %s', error) }
      return
    }
    early.push(row)
    void openLedger().catch(() => {})
  }

  // A request listener that rewrites a request starts it over, so the same usage chunk
  // can pass here twice; it counts once.
  const counted = new WeakSet()
  // A Session's own requests are in its log; hidden Worker and side-channel requests are metered here.
  ctx.on('llm/stream', (options, next) => {
    const tag = tags.get(options.messages)
    const isWorker = tag === undefined && options.purpose === undefined && rt.workerExecutor?.isWorkerSession?.(options.sessionId) === true
    if (tag === undefined && options.sessionId !== undefined && options.purpose === undefined && !isWorker) {
      noteSession(options.sessionId)
      return next()
    }
    return (async function* meter() {
      let usage
      try {
        for await (const chunk of next()) {
          if (chunk?.type === 'usage' && chunk.usage && typeof chunk === 'object' && !counted.has(chunk)) {
            counted.add(chunk)
            usage = chunk.usage
          }
          yield chunk
        }
      } finally {
        if (usage !== undefined) {
          record({
            sessionId: tag?.sessionId ?? options.sessionId,
            kind: tag?.kind ?? options.purpose ?? (isWorker ? 'worker' : 'other'),
            provider: options.provider,
            model: options.model,
            usage,
            isWorker,
          })
        }
      }
    })()
  })

  Object.assign(rt, { usageView, usageTicketSummary, tagUsage, carryUsageTag, ownRequest })
}
