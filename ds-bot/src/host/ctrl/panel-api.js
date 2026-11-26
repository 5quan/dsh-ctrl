// Control-plane API endpoints for P3-1 (R-4.1):
// - Serves `dshMemory` panel overview/read/save/confirm endpoints (`ctrl-memory-*`).
// - Aggregates "Needs Attention" inbox (`approvals` + attention `tickets` + pending memory buffer).
// - Preserves `tickets.sqlite` lazy-creation invariant when no tickets exist yet.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { TICKET_MILESTONE_PRODUCER } from './memory-bridge.js'

const SAVE_CONTENT_MAX = 200_000
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/
const JOURNAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const invalid = (message) => Object.assign(new Error(message), { code: 'bot/invalid' })
const notFound = (message) => Object.assign(new Error(message), { code: 'bot/not-found' })

function atomicWriteSync(filePath, content) {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.tmp.${process.pid}.${randomUUID().slice(0, 8)}`)
  writeFileSync(tmpPath, content, 'utf8')
  renameSync(tmpPath, filePath)
}

function safeReadUtf8(filePath) {
  try {
    return { exists: true, content: readFileSync(filePath, 'utf8') }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, content: '' }
    throw error
  }
}

function isAutoMilestoneNote(item) {
  return item?.target === 'note' && item?.producer === TICKET_MILESTONE_PRODUCER
}

function endOfLogicalDayMs(dateStr, now = Date.now()) {
  if (typeof dateStr !== 'string' || !JOURNAL_DATE_RE.test(dateStr.trim())) {
    return now
  }
  const parsed = Date.parse(`${dateStr.trim()}T23:59:59.999`)
  return Number.isNaN(parsed) ? now : Math.max(parsed, now)
}

function assertCleanSlug(rawKey, kind) {
  const key = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (!key || key.includes('..') || key.includes('/') || key.includes('\\') || key.includes('\0') || !SLUG_RE.test(key)) {
    throw invalid(`Invalid ${kind} key.`)
  }
  return key
}

function resolveInside(baseDir, fileName) {
  const root = resolve(baseDir)
  const target = resolve(root, fileName)
  if (!target.startsWith(`${root}${sep}`)) {
    throw invalid('Path escapes memory directory.')
  }
  return target
}

function listJournalDatesDesc(home) {
  if (!home) return []
  const dir = join(home, 'journals')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map(name => name.slice(0, -3))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  } catch {
    return []
  }
}

function collectPendingBuffer(rt) {
  if (!rt.memoryBridge?.isAvailable?.()) {
    return { pending: [], approved: [], totalPending: 0, totalApproved: 0 }
  }
  const briefing = rt.memoryBridge.getMorningBriefing?.({ scope: 'default' })
  const rawPending = Array.isArray(briefing?.buffer?.pending) ? briefing.buffer.pending : []
  const pending = rawPending.filter(item => !isAutoMilestoneNote(item))
  const approved = Array.isArray(briefing?.buffer?.approved) ? briefing.buffer.approved : []
  return {
    pending,
    approved,
    totalPending: pending.length,
    totalApproved: approved.length,
  }
}

function collectAttentionTickets(rt, now = Date.now()) {
  if (!rt.hasTicketStore?.()) return []
  try {
    const store = rt.openTicketStore()
    const todayDate = rt.memoryBridge?.getCurrentLogicalDate?.() ?? ''
    const endOfDay = endOfLogicalDayMs(todayDate, now)
    const active = store.list({ activeOnly: true, limit: 100 })
    const out = []
    for (const ticket of active) {
      const reasons = []
      if (ticket.status === 'waiting_user') reasons.push('waiting_user')
      if (ticket.deadline !== null && ticket.deadline !== undefined && ticket.deadline <= endOfDay) reasons.push('due')
      if (ticket.status === 'review') reasons.push('review')
      if (reasons.length === 0) continue
      const ownerBot = ticket.ownerBotId ? rt.botOf?.(ticket.ownerBotId) : undefined
      out.push({
        id: ticket.id,
        title: ticket.title,
        status: ticket.status,
        ownerBotId: ticket.ownerBotId,
        ownerBotName: ownerBot?.name ?? ticket.ownerBotId ?? '',
        deadline: ticket.deadline ?? null,
        nextStep: ticket.nextStep ?? '',
        waitingOn: ticket.waitingOn ?? '',
        blockers: ticket.blockers ?? '',
        revision: ticket.revision,
        updatedAt: ticket.updatedAt ?? 0,
        reasons,
      })
    }
    const rankOf = (item) => (
      item.reasons.includes('waiting_user') ? 0
        : item.reasons.includes('due') ? 1
          : 2
    )
    out.sort((a, b) => {
      const ra = rankOf(a)
      const rb = rankOf(b)
      if (ra !== rb) return ra - rb
      const da = a.deadline ?? Number.MAX_SAFE_INTEGER
      const db = b.deadline ?? Number.MAX_SAFE_INTEGER
      if (da !== db) return da - db
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
    })
    return out
  } catch (error) {
    rt.warn?.('ds-bot: collectAttentionTickets failed: %s', error?.message ?? error)
    return []
  }
}

export function install(rt) {
  function ctrlInboxSummary() {
    const approvals = Array.isArray(rt.approvalsView?.()) ? rt.approvalsView() : []
    const tickets = collectAttentionTickets(rt)
    const buffer = collectPendingBuffer(rt)
    const counts = {
      approvals: approvals.length,
      tickets: tickets.length,
      memory: buffer.totalPending,
    }
    return {
      total: counts.approvals + counts.tickets + counts.memory,
      counts,
    }
  }

  function ticketUsageMap() {
    const bySession = new Map()
    const tickets = new Map()
    let assignments = []

    if (rt.hasTicketStore?.()) {
      try {
        const store = rt.openTicketStore()
        for (const ticket of store.list({ limit: 200 })) {
          tickets.set(ticket.id, ticket)
        }
        assignments = store.listAssignments({ limit: 200 })
        for (const assignment of assignments) {
          if (!assignment.workerSessionId) continue
          const ticket = tickets.get(assignment.ticketId)
          bySession.set(assignment.workerSessionId, {
            owner: `ticket:${assignment.ticketId}`,
            name: ticket?.title || assignment.ticketId,
            ticketId: assignment.ticketId,
            assignmentId: assignment.id,
          })
        }
      } catch (error) {
        rt.warn?.('ds-bot: ticketUsageMap read failed: %s', error?.message ?? error)
      }
    }

    const activeWorkers = rt.workerExecutor?.listActiveWorkers?.()
    if (Array.isArray(activeWorkers)) {
      for (const worker of activeWorkers) {
        if (!worker?.sessionId || !worker?.ticketId) continue
        const ticket = tickets.get(worker.ticketId)
        bySession.set(worker.sessionId, {
          owner: `ticket:${worker.ticketId}`,
          name: ticket?.title || worker.ticketId,
          ticketId: worker.ticketId,
          assignmentId: worker.assignmentId ?? '',
        })
      }
    }

    return { bySession, tickets, assignments }
  }

  function getMemoryHome() {
    const svc = rt.memoryBridge?.getService?.()
    return typeof svc?.home === 'string' ? svc.home.trim() : ''
  }

  function resolveMemoryTarget(kind, key, { writable = false } = {}) {
    const home = getMemoryHome()
    if (kind === 'profile') {
      return {
        home,
        key: '',
        filePath: home ? resolve(home, 'PROFILE.md') : '',
      }
    }
    if (kind === 'entity') {
      const slug = assertCleanSlug(key, 'entity')
      return {
        home,
        key: slug,
        filePath: home ? resolveInside(join(home, 'entities'), `${slug}.md`) : '',
      }
    }
    if (kind === 'lesson') {
      const slug = assertCleanSlug(key, 'lesson')
      return {
        home,
        key: slug,
        filePath: home ? resolveInside(join(home, 'lessons'), `${slug}.md`) : '',
      }
    }
    if (kind === 'journal') {
      if (writable) throw invalid('Daily journals are immutable and cannot be edited directly.')
      const date = typeof key === 'string' ? key.trim() : ''
      if (!JOURNAL_DATE_RE.test(date)) throw invalid('Journal key must be YYYY-MM-DD.')
      return {
        home,
        key: date,
        filePath: home ? resolveInside(join(home, 'journals'), `${date}.md`) : '',
      }
    }
    throw invalid(`Unsupported memory kind "${kind}".`)
  }

  function memoryOverview() {
    if (!rt.memoryBridge?.isAvailable?.()) {
      return { available: false }
    }
    const svc = rt.memoryBridge.getService()
    const home = getMemoryHome()
    const logicalDate = rt.memoryBridge.getCurrentLogicalDate?.() ?? ''
    const profileRead = home ? safeReadUtf8(resolve(home, 'PROFILE.md')) : { exists: false, content: '' }

    const rawEntities = typeof svc?.listEntities === 'function' ? svc.listEntities() : []
    const entities = Array.isArray(rawEntities)
      ? rawEntities.map(ent => ({
        slug: String(ent.slug ?? ''),
        name: String(ent.name ?? ent.slug ?? ''),
        type: String(ent.type ?? 'general'),
        status: String(ent.status ?? 'active'),
        aliases: Array.isArray(ent.aliases) ? ent.aliases : [],
        factCount: Array.isArray(ent.facts) ? ent.facts.length : 0,
      }))
      : []

    const rawLessons = typeof svc?.listLessons === 'function' ? svc.listLessons() : []
    const lessons = Array.isArray(rawLessons)
      ? rawLessons.map(les => ({
        slug: String(les.slug ?? ''),
        name: String(les.name ?? les.slug ?? ''),
        status: String(les.status ?? 'active'),
        tags: Array.isArray(les.tags) ? les.tags : [],
        triggers: Array.isArray(les.triggers) ? les.triggers : [],
        entryCount: Array.isArray(les.entries) ? les.entries.length : 0,
      }))
      : []

    const dates = listJournalDatesDesc(home)
    const latestDate = dates[0] ?? null
    const latestRead = latestDate && home
      ? safeReadUtf8(resolveInside(join(home, 'journals'), `${latestDate}.md`))
      : { exists: false, content: '' }

    const buffer = collectPendingBuffer(rt)

    return {
      available: true,
      logicalDate,
      home,
      profile: {
        exists: profileRead.exists,
        content: profileRead.content,
        chars: profileRead.content.length,
      },
      entities,
      lessons,
      journals: {
        dates,
        latestDate,
        latestContent: latestRead.content,
      },
      buffer,
    }
  }

  function memoryRead(body = {}) {
    if (!rt.memoryBridge?.isAvailable?.()) {
      return { available: false, exists: false, content: '', editable: false }
    }
    const kind = String(body.kind ?? '').trim()
    const target = resolveMemoryTarget(kind, body.key, { writable: false })
    if (target.filePath) {
      const read = safeReadUtf8(target.filePath)
      if (read.exists) {
        return {
          available: true,
          kind,
          key: target.key,
          exists: true,
          content: read.content,
          editable: kind !== 'journal',
        }
      }
    }
    const svc = rt.memoryBridge.getService()
    if (kind === 'entity' && typeof svc?.getEntity === 'function') {
      const ent = svc.getEntity(target.key)
      if (ent?.raw !== undefined) {
        return { available: true, kind, key: target.key, exists: true, content: ent.raw, editable: true }
      }
    }
    if (kind === 'lesson' && typeof svc?.getLesson === 'function') {
      const les = svc.getLesson(target.key)
      if (les?.raw !== undefined) {
        return { available: true, kind, key: target.key, exists: true, content: les.raw, editable: true }
      }
    }
    return {
      available: true,
      kind,
      key: target.key,
      exists: false,
      content: '',
      editable: kind !== 'journal',
    }
  }

  function memorySave(body = {}) {
    if (!rt.memoryBridge?.isAvailable?.()) {
      throw invalid('dsh-memory service is not available.')
    }
    const kind = String(body.kind ?? '').trim()
    const target = resolveMemoryTarget(kind, body.key, { writable: true })
    if (!target.filePath) {
      throw invalid('dsh-memory home directory is not configured.')
    }
    if (typeof body.content !== 'string') {
      throw invalid('content must be a string.')
    }
    if (body.content.length > SAVE_CONTENT_MAX) {
      throw invalid(`content must be at most ${SAVE_CONTENT_MAX} characters.`)
    }
    atomicWriteSync(target.filePath, body.content)
    return {
      ok: true,
      kind,
      key: target.key,
      chars: body.content.length,
    }
  }

  async function memoryConfirm(body = {}) {
    if (!rt.memoryBridge?.isAvailable?.()) {
      throw invalid('dsh-memory service is not available.')
    }
    const approveIds = Array.isArray(body.approveIds) ? body.approveIds.map(String) : []
    const rejectIds = Array.isArray(body.rejectIds) ? body.rejectIds.map(String) : []
    const result = await rt.memoryBridge.confirmBufferItems({
      approveIds,
      rejectIds,
      settleNow: body.settleNow === true,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
      scope: 'default',
    })
    return {
      ok: result?.ok !== false,
      result,
    }
  }

  function collectInbox() {
    const rawApprovals = Array.isArray(rt.approvalsView?.()) ? rt.approvalsView() : []
    const approvals = rawApprovals.map(entry => ({
      id: entry.id,
      sessionId: entry.sessionId ?? '',
      botId: entry.botId ?? '',
      botName: rt.botOf?.(entry.botId)?.name ?? entry.botId ?? '',
      roomId: entry.roomId,
      worker: entry.worker === true,
      ticketId: entry.ticketId ?? '',
      assignmentId: entry.assignmentId ?? '',
      tool: entry.tool ?? '',
      reason: entry.reason ?? '',
      detail: entry.detail ?? {},
      at: entry.at ?? 0,
    }))
    const tickets = collectAttentionTickets(rt)
    const buffer = collectPendingBuffer(rt)
    const counts = {
      approvals: approvals.length,
      tickets: tickets.length,
      memory: buffer.totalPending,
    }
    return {
      total: counts.approvals + counts.tickets + counts.memory,
      counts,
      approvals,
      tickets,
      memoryPending: buffer.pending,
      generatedAt: Date.now(),
    }
  }

  async function ctrlEndpoint(name, body = {}) {
    switch (name) {
      case 'memory-overview':
        return memoryOverview()
      case 'memory-read':
        return memoryRead(body)
      case 'memory-save':
        return memorySave(body)
      case 'memory-confirm':
        return await memoryConfirm(body)
      case 'inbox':
        return collectInbox()
      case 'ticket-usage':
        return await (rt.usageTicketSummary?.({
          ticketId: typeof body.ticketId === 'string' ? body.ticketId.trim() || undefined : undefined,
          timeZone: typeof body.timeZone === 'string' ? body.timeZone : undefined,
        }) ?? {
          tickets: [],
          totals: { total: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0, steps: 0, ticketCount: 0, assignmentCount: 0 },
        })
      default:
        throw notFound(`Unknown endpoint ctrl-${name}`)
    }
  }

  Object.assign(rt, {
    ctrlInboxSummary,
    ticketUsageMap,
    ctrlEndpoint,
  })
}
