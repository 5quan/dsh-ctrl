// Thin unidirectional bridge consuming peer plugin `dsh-memory` via Cordis
// (`ctx.get('dshMemory')` and `'dsh-memory/day-rolled-over'`), with graceful
// degradation when `dsh-memory` is not installed.

export const DSH_MEMORY_SERVICE = 'dshMemory'
export const DAY_ROLLED_OVER_EVENT = 'dsh-memory/day-rolled-over'
export const TICKET_MILESTONE_PRODUCER = 'dsh-ctrl/ticket-milestone'

const EMPTY_MATCH = { totalMatched: 0, matches: [], text: '', estimatedTokens: 0 }
const RETROSPECTIVE_MAX_CHARS = 1000

function firstSentence(text, max = 180) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean === '') return ''
  const match = /[。！？]|(?<=\S)[.!?](?=\s|$)/.exec(clean)
  const sentence = match ? clean.slice(0, match.index + 1).trim() : clean
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`
}

export function install(rt) {
  const { ctx } = rt
  const rolloverListeners = new Set()
  const recordedMilestones = new Set()

  function getService() {
    try {
      const svc = typeof ctx?.get === 'function' ? ctx.get(DSH_MEMORY_SERVICE) : undefined
      if (svc !== undefined && svc !== null) return svc
    } catch {}
    try {
      return ctx?.reflect?.get?.(DSH_MEMORY_SERVICE)
    } catch {
      return undefined
    }
  }

  const isAvailable = () => getService() !== undefined

  function localDateToday() {
    try {
      const tz = rt.config?.timeZone ? { timeZone: rt.config.timeZone } : {}
      return new Intl.DateTimeFormat('en-CA', { ...tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now())
    } catch {
      return new Date().toISOString().slice(0, 10)
    }
  }

  function getCurrentLogicalDate() {
    const svc = getService()
    if (typeof svc?.getCurrentLogicalDate === 'function') {
      try {
        return svc.getCurrentLogicalDate()
      } catch (error) {
        rt.warn?.('ds-bot: dshMemory.getCurrentLogicalDate failed: %s', error?.message ?? error)
      }
    }
    return localDateToday()
  }

  function getMorningBriefing(options = {}) {
    const svc = getService()
    if (typeof svc?.getMorningBriefing !== 'function') return undefined
    try {
      return svc.getMorningBriefing(options)
    } catch (error) {
      rt.warn?.('ds-bot: dshMemory.getMorningBriefing failed: %s', error?.message ?? error)
      return undefined
    }
  }

  function markBriefingDelivered(options = {}) {
    const svc = getService()
    if (typeof svc?.markBriefingDelivered !== 'function') {
      return { ok: false, reason: 'MEMORY_UNAVAILABLE' }
    }
    try {
      return svc.markBriefingDelivered(options)
    } catch (error) {
      rt.warn?.('ds-bot: dshMemory.markBriefingDelivered failed: %s', error?.message ?? error)
      return { ok: false, reason: error?.message ?? String(error) }
    }
  }

  async function confirmBufferItems(options = {}) {
    const svc = getService()
    if (typeof svc?.confirmBufferItems !== 'function') {
      return { ok: false, reason: 'MEMORY_UNAVAILABLE' }
    }
    try {
      return await svc.confirmBufferItems(options)
    } catch (error) {
      rt.warn?.('ds-bot: dshMemory.confirmBufferItems failed: %s', error?.message ?? error)
      return { ok: false, reason: error?.message ?? String(error) }
    }
  }

  function matchEntities(text, options = {}) {
    const svc = getService()
    if (typeof svc?.matchEntities !== 'function') return { ...EMPTY_MATCH }
    try {
      return svc.matchEntities(text, options)
    } catch (error) {
      rt.warn?.('ds-bot: dshMemory.matchEntities failed: %s', error?.message ?? error)
      return { ...EMPTY_MATCH }
    }
  }

  function matchLessons(text, options = {}) {
    const svc = getService()
    if (typeof svc?.matchLessons !== 'function') return { ...EMPTY_MATCH }
    try {
      return svc.matchLessons(text, options)
    } catch (error) {
      rt.warn?.('ds-bot: dshMemory.matchLessons failed: %s', error?.message ?? error)
      return { ...EMPTY_MATCH }
    }
  }

  async function submitBufferCandidate(input = {}) {
    const svc = getService()
    if (typeof svc?.submitBufferCandidate !== 'function') {
      return { ok: false, reason: 'MEMORY_UNAVAILABLE' }
    }
    try {
      return await svc.submitBufferCandidate(input)
    } catch (error) {
      rt.warn?.('ds-bot: dshMemory.submitBufferCandidate failed: %s', error?.message ?? error)
      return { ok: false, reason: error?.message ?? String(error) }
    }
  }

  async function submitTicketRetrospective({ ticket, content, target, tags, sessionId } = {}) {
    if (!ticket) return { ok: false, reason: 'TICKET_REQUIRED' }
    const cleanContent = String(content ?? '').replace(/\s+/g, ' ').trim().slice(0, RETROSPECTIVE_MAX_CHARS)
    if (cleanContent === '') return { ok: false, reason: 'CONTENT_REQUIRED' }

    const explicitTarget = typeof target === 'string' ? target.trim() : ''
    let resolvedTarget = explicitTarget
    if (resolvedTarget === '') {
      if (ticket.status === 'failed') {
        const slugTitle = String(ticket.title ?? '').slice(0, 40).trim() || ticket.id
        resolvedTarget = `lesson:${slugTitle}`
      } else {
        resolvedTarget = 'note'
      }
    }

    const formatted = `[Ticket ${ticket.id} · ${ticket.status}] ${ticket.title}: ${cleanContent}`
    const cleanTags = Array.isArray(tags) ? tags.map(tag => String(tag ?? '').trim()).filter(Boolean) : []
    const res = await submitBufferCandidate({
      content: formatted,
      target: resolvedTarget,
      sourceType: 'extracted',
      sessionId,
      ...(cleanTags.length > 0 ? { tags: cleanTags } : {}),
      producer: 'dsh-ctrl/ticket-retrospective',
    })
    return { ...res, target: resolvedTarget }
  }

  async function recordTicketMilestone({ ticket, summary, artifacts, sessionId } = {}) {
    if (!ticket?.id) return { ok: false, reason: 'TICKET_REQUIRED' }
    if (ticket.status !== 'done') return { ok: false, reason: 'NOT_DONE' }
    if (ticket.ownerBotId && rt.botOf?.(ticket.ownerBotId)?.private === true) {
      return { ok: false, reason: 'PRIVATE_BOT' }
    }
    if (!isAvailable()) return { ok: false, reason: 'MEMORY_UNAVAILABLE' }

    const metaKey = `ticket-milestone:${ticket.id}`
    if (recordedMilestones.has(ticket.id)) {
      return { ok: true, deduplicated: true, target: 'note' }
    }
    if (rt.hasTicketStore?.()) {
      try {
        const prev = rt.openTicketStore().getMeta(metaKey)
        if (prev?.recordedAt) {
          recordedMilestones.add(ticket.id)
          return { ok: true, deduplicated: true, id: prev.bufferId, target: 'note' }
        }
      } catch {}
    }

    const cleanTitle = String(ticket.title ?? ticket.id).replace(/\s+/g, ' ').trim().slice(0, 80)
    const lead = firstSentence(summary) || firstSentence(ticket.goal) || '已完成'
    const artSeen = new Set()
    const artList = []
    for (const raw of [
      ...(Array.isArray(artifacts) ? artifacts : []),
      ...(Array.isArray(ticket.artifacts) ? ticket.artifacts : []),
    ]) {
      const clean = typeof raw === 'string' ? raw.trim() : ''
      if (clean === '' || artSeen.has(clean)) continue
      artSeen.add(clean)
      artList.push(clean)
      if (artList.length >= 3) break
    }
    const rawLine = artList.length > 0
      ? `[Ticket ${ticket.id} 完成] ${cleanTitle}：${lead}（产物：${artList.join(', ')}）`
      : `[Ticket ${ticket.id} 完成] ${cleanTitle}：${lead}`
    const content = rawLine.slice(0, RETROSPECTIVE_MAX_CHARS)

    const res = await submitBufferCandidate({
      content,
      target: 'note',
      sourceType: 'extracted',
      sessionId,
      producer: TICKET_MILESTONE_PRODUCER,
    })
    if (res?.ok === true) {
      recordedMilestones.add(ticket.id)
      if (rt.hasTicketStore?.()) {
        try {
          rt.openTicketStore().setMeta(metaKey, {
            recordedAt: Date.now(),
            bufferId: res.id ?? '',
            status: res.status ?? '',
          })
        } catch {}
      }
    }
    return { ...res, target: 'note', deduplicated: false }
  }

  function onDayRolledOver(listener) {
    if (typeof listener !== 'function') return () => {}
    rolloverListeners.add(listener)
    return () => { rolloverListeners.delete(listener) }
  }

  ctx.on(DAY_ROLLED_OVER_EVENT, (payload) => {
    for (const listener of rolloverListeners) {
      try {
        listener(payload)
      } catch (error) {
        rt.warn?.('ds-bot: day-rolled-over listener failed: %s', error?.message ?? error)
      }
    }
  })

  rt.memoryBridge = {
    getService,
    isAvailable,
    getCurrentLogicalDate,
    getMorningBriefing,
    markBriefingDelivered,
    confirmBufferItems,
    matchEntities,
    matchLessons,
    submitBufferCandidate,
    submitTicketRetrospective,
    recordTicketMilestone,
    onDayRolledOver,
  }
}
