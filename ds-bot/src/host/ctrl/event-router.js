// Deterministic external event router (R-3.2):
// - Follows Source -> Trigger -> Gate -> Ticket without LLM inference overhead.
// - Deduplicates events via in-memory + lazy ctrl_meta persistence.
// - Matches incoming Mail & IM events directly to active Tickets' wake rules
//   (dispatching to ticketQueue silently without disturbing Chief), drops
//   deterministic noise, and forwards unmatched genuine events to Chief.
import { createHash } from 'node:crypto'
import { TERMINAL_TICKET_STATUSES } from './tickets.js'

export const DEFAULT_MAIL_POLL_MS = 5 * 60 * 1000
export const DEFAULT_MAIL_STARTUP_DELAY_MS = 20_000
export const DEFAULT_DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_DEDUP_ENTRIES = 500

const DEDUP_META_KEY = 'event-router:dedup'

const AUTOMATED_SENDER_RE = /\b(no-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|newsletter|marketing|digest|promo|unsubscribe)@/i
const AUTO_REPLY_SUBJECT_RE = /^(?:auto(?:matic)?\s*reply|out\s+of\s+office|oof\b|undeliverable|delivery\s+status\s+notification|returned\s+mail|自动回复)/i
const AUTO_REPLY_IM_TEXT_RE = /^\[(?:auto-reply|自动回复|system\s+notice)\]/i
const PRECEDENCE_NOISE_RE = /\b(bulk|junk|list)\b/i
const EMAIL_RE = /\b[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+\b/gi

function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function nonNegativeInt(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripOuterQuotes(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}

function splitListValues(raw) {
  if (Array.isArray(raw)) {
    return raw.map(item => String(item ?? '').trim()).filter(Boolean)
  }
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map(item => stripOuterQuotes(item))
    .filter(Boolean)
}

function normalizeEvent(raw = {}) {
  const source = String(raw.source ?? 'unknown').trim().toLowerCase() || 'unknown'
  const platform = String(raw.platform ?? '').trim().toLowerCase()
  const channel = String(raw.channel ?? 'default').trim()
  const externalId = typeof raw.externalId === 'string' ? raw.externalId.trim() : ''
  const sender = String(raw.sender ?? '').trim()
  const senderId = String(raw.senderId ?? '').trim()
  const senderName = String(raw.senderName ?? '').trim()
  const subject = String(raw.subject ?? '').trim()
  const text = String(raw.text ?? '').trim()
  const headers = raw.headers && typeof raw.headers === 'object' ? raw.headers : {}
  return {
    source,
    platform,
    channel,
    externalId,
    requireExternalId: raw.requireExternalId === true,
    sender,
    senderId,
    senderName,
    senderIsBot: raw.senderIsBot === true,
    subject,
    text,
    headers,
    targetBotId: typeof raw.targetBotId === 'string' && raw.targetBotId.trim() !== '' ? raw.targetBotId.trim() : undefined,
  }
}

export function computeEventFingerprint(rawEvent = {}) {
  const event = normalizeEvent(rawEvent)
  const channelNorm = event.channel.toLowerCase() || 'default'
  if (event.externalId !== '') {
    return `${event.source}:${channelNorm}:${event.externalId}`
  }
  if (event.requireExternalId) return null
  const hashInput = [
    event.source,
    channelNorm,
    event.sender.toLowerCase(),
    event.subject,
    event.text.slice(0, 400),
  ].join('\n')
  const digest = createHash('sha256').update(hashInput).digest('hex').slice(0, 16)
  return `${event.source}:${channelNorm}:sha256:${digest}`
}

function matchesPattern(haystack, pattern) {
  const raw = String(pattern ?? '').trim()
  if (raw === '') return false
  const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(raw)
  if (regexMatch) {
    try {
      const safeFlags = regexMatch[2].replace(/[gy]/g, '')
      return new RegExp(regexMatch[1], safeFlags).test(haystack)
    } catch {}
  }
  return haystack.toLowerCase().includes(raw.toLowerCase())
}

export function classifyEventNoise(rawEvent = {}, customPatterns = []) {
  const event = normalizeEvent(rawEvent)
  const lowerHeaders = {}
  for (const [k, v] of Object.entries(event.headers)) {
    if (v === undefined || v === null) continue
    lowerHeaders[String(k).toLowerCase()] = String(v).trim()
  }

  if (event.source === 'mail') {
    const autoSubmitted = lowerHeaders['auto-submitted']
    if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') {
      return { isNoise: true, reason: 'automated_header' }
    }
    if (lowerHeaders['x-auto-response-suppress']) {
      return { isNoise: true, reason: 'automated_header' }
    }
    if (lowerHeaders['precedence'] && PRECEDENCE_NOISE_RE.test(lowerHeaders['precedence'])) {
      return { isNoise: true, reason: 'automated_header' }
    }
    if (lowerHeaders['list-unsubscribe']) {
      return { isNoise: true, reason: 'automated_header' }
    }
    if (event.sender !== '' && AUTOMATED_SENDER_RE.test(event.sender)) {
      return { isNoise: true, reason: 'automated_sender' }
    }
    if (event.subject !== '' && AUTO_REPLY_SUBJECT_RE.test(event.subject)) {
      return { isNoise: true, reason: 'auto_reply_subject' }
    }
  } else if (event.source === 'im') {
    if (event.senderIsBot) {
      return { isNoise: true, reason: 'bot_sender' }
    }
    if (event.text !== '' && AUTO_REPLY_IM_TEXT_RE.test(event.text)) {
      return { isNoise: true, reason: 'auto_reply_text' }
    }
  }

  if (Array.isArray(customPatterns) && customPatterns.length > 0) {
    const combined = `${event.sender}\n${event.subject}\n${event.text}`
    for (const pattern of customPatterns) {
      if (matchesPattern(combined, pattern)) {
        return { isNoise: true, reason: 'custom_noise_rule' }
      }
    }
  }

  return { isNoise: false, reason: '' }
}

export function parseEventWakeRules(ticket = {}) {
  const rules = {
    sources: [],
    senders: [],
    subjects: [],
    keywords: [],
    waitingEmails: [],
  }

  const rawWake = typeof ticket.wakeCondition === 'string' ? ticket.wakeCondition.trim() : ''
  let parsedObj = null
  if (rawWake.startsWith('{')) {
    try {
      const candidate = JSON.parse(rawWake)
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsedObj = candidate
      }
    } catch {}
  }

  if (parsedObj) {
    rules.sources.push(...splitListValues(parsedObj.source ?? parsedObj.sources ?? parsedObj.channel).map(s => s.toLowerCase()))
    rules.senders.push(...splitListValues(parsedObj.from ?? parsedObj.mail_from ?? parsedObj.im_from ?? parsedObj.sender ?? parsedObj.senders))
    rules.subjects.push(...splitListValues(parsedObj.subject ?? parsedObj.subjects))
    rules.keywords.push(...splitListValues(parsedObj.keyword ?? parsedObj.keywords ?? parsedObj.contains))
  } else if (rawWake !== '') {
    for (const rawLine of rawWake.split(/\r?\n/)) {
      const line = rawLine.trim().replace(/^[-*]\s+/, '').trim()
      if (line === '' || line.startsWith('#')) continue
      const sepIdx = line.search(/[:=]/)
      if (sepIdx <= 0) continue
      const key = line.slice(0, sepIdx).trim().toLowerCase().replace(/[\s-]+/g, '_')
      const rawVal = line.slice(sepIdx + 1).trim()
      if (rawVal === '') continue
      switch (key) {
        case 'source':
        case 'sources':
        case 'channel':
          rules.sources.push(...splitListValues(rawVal).map(s => s.toLowerCase()))
          break
        case 'from':
        case 'mail_from':
        case 'im_from':
        case 'sender':
        case 'senders':
          rules.senders.push(...splitListValues(rawVal))
          break
        case 'subject':
        case 'subjects':
          rules.subjects.push(...splitListValues(rawVal))
          break
        case 'keyword':
        case 'keywords':
        case 'contains':
          rules.keywords.push(...splitListValues(rawVal))
          break
        default:
          break
      }
    }
  }

  if (typeof ticket.waitingOn === 'string' && ticket.waitingOn.trim() !== '') {
    let match
    EMAIL_RE.lastIndex = 0
    while ((match = EMAIL_RE.exec(ticket.waitingOn)) !== null) {
      const addr = match[0].toLowerCase()
      if (!rules.waitingEmails.includes(addr)) {
        rules.waitingEmails.push(addr)
      }
    }
  }

  return rules
}

export function matchEventToTicket(rawEvent = {}, ticket) {
  if (!ticket || TERMINAL_TICKET_STATUSES.has(ticket.status)) {
    return { matched: false, score: 0, reason: '' }
  }

  const event = normalizeEvent(rawEvent)
  const bodyHaystack = `${event.subject}\n${event.text}`
  if (typeof ticket.id === 'string' && ticket.id.trim() !== '') {
    const idRe = new RegExp(`(?:^|[^a-zA-Z0-9_-])${escapeRegExp(ticket.id.trim())}(?:$|[^a-zA-Z0-9_-])`, 'i')
    if (idRe.test(bodyHaystack)) {
      return { matched: true, score: 100, reason: 'ticket_id_ref' }
    }
  }

  const rules = parseEventWakeRules(ticket)
  if (rules.sources.length > 0) {
    const eventTags = [event.source, event.platform, event.channel.toLowerCase()].filter(Boolean)
    const sourceMatched = rules.sources.some(src => eventTags.some(tag => tag === src || tag.includes(src)))
    if (!sourceMatched) {
      return { matched: false, score: 0, reason: '' }
    }
  }

  const senderMatchers = [...rules.senders, ...rules.waitingEmails]
  const hasConcreteMatcher = senderMatchers.length > 0 || rules.subjects.length > 0 || rules.keywords.length > 0
  if (!hasConcreteMatcher) {
    return { matched: false, score: 0, reason: '' }
  }

  let matchedCategories = 0
  if (senderMatchers.length > 0) {
    const candidates = [event.sender, event.senderId, event.senderName].filter(Boolean).map(s => s.toLowerCase())
    const ok = senderMatchers.some(matcher => candidates.some(cand => cand.includes(matcher.toLowerCase())))
    if (!ok) return { matched: false, score: 0, reason: '' }
    matchedCategories += 1
  }

  if (rules.subjects.length > 0) {
    const lowerSubj = event.subject.toLowerCase()
    const ok = rules.subjects.some(sub => lowerSubj.includes(sub.toLowerCase()))
    if (!ok) return { matched: false, score: 0, reason: '' }
    matchedCategories += 1
  }

  if (rules.keywords.length > 0) {
    const lowerBody = bodyHaystack.toLowerCase()
    const ok = rules.keywords.some(kw => lowerBody.includes(kw.toLowerCase()))
    if (!ok) return { matched: false, score: 0, reason: '' }
    matchedCategories += 1
  }

  const score = matchedCategories * 20
    + (ticket.status === 'waiting_user' || ticket.status === 'blocked' ? 10 : 0)
    + (rules.sources.length > 0 ? 5 : 0)
  return { matched: true, score, reason: 'wake_rule' }
}

function buildWorkerEventPrompt(event, matchReason) {
  const header = `[Inbound ${event.source.toUpperCase()} Event matched via ${matchReason}]`
  const meta = [
    event.platform ? `Platform: ${event.platform}` : '',
    event.channel ? `Channel: ${event.channel}` : '',
    event.sender ? `From: ${event.sender}` : '',
    event.subject ? `Subject: ${event.subject}` : '',
  ].filter(Boolean)
  return [
    header,
    ...meta,
    event.text ? `\nContent:\n${event.text.slice(0, 4000)}` : '',
    '\nProcess this update within your Ticket mandate and report status via ticket_report.',
  ].filter(Boolean).join('\n')
}

function buildChiefMailNotice(event) {
  const lines = [
    `Inbound mail${event.channel ? ` (${event.channel})` : ''} from ${event.sender || 'unknown sender'}:`,
    event.subject ? `Subject: ${event.subject}` : '',
    event.text ? event.text.slice(0, 1200) : '',
  ].filter(Boolean)
  return lines.join('\n')
}

export function createEventRouter(rt, overrides = {}) {
  const ctrlConfig = rt.config?.ctrl ?? {}
  const mailEnabled = overrides.mailEnabled ?? (ctrlConfig.mailEventPollEnabled !== false)
  const mailPollMs = positiveInt(overrides.mailPollMs ?? ctrlConfig.mailEventPollMs, DEFAULT_MAIL_POLL_MS)
  const mailStartupDelayMs = nonNegativeInt(overrides.mailStartupDelayMs ?? ctrlConfig.mailEventStartupDelayMs, DEFAULT_MAIL_STARTUP_DELAY_MS)
  const dedupTtlMs = positiveInt(overrides.dedupTtlMs ?? ctrlConfig.eventDedupTtlMs, DEFAULT_DEDUP_TTL_MS)
  const customNoisePatterns = Array.isArray(overrides.noisePatterns ?? ctrlConfig.eventNoisePatterns)
    ? (overrides.noisePatterns ?? ctrlConfig.eventNoisePatterns)
    : []
  const clock = overrides.clock ?? { now: () => Date.now() }

  /** @type {Map<string, number>} */
  const seenFingerprints = new Map()
  let metaLoaded = false
  let stopped = false
  let polling = false
  let startupTimer = null
  let pollTimer = null

  function pruneAndSyncDedup(now) {
    for (const [fp, ts] of seenFingerprints.entries()) {
      if (now - ts >= dedupTtlMs) seenFingerprints.delete(fp)
    }
    while (seenFingerprints.size > MAX_DEDUP_ENTRIES) {
      const oldest = seenFingerprints.keys().next().value
      if (oldest === undefined) break
      seenFingerprints.delete(oldest)
    }
  }

  function loadDedupFromStoreIfReady(now) {
    if (metaLoaded || rt.hasTicketStore?.() !== true) return
    metaLoaded = true
    try {
      const saved = rt.openTicketStore().getMeta(DEDUP_META_KEY)
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [fp, ts] of Object.entries(saved)) {
          if (typeof ts === 'number' && Number.isFinite(ts) && (now - ts) < dedupTtlMs) {
            if (!seenFingerprints.has(fp)) seenFingerprints.set(fp, ts)
          }
        }
        pruneAndSyncDedup(now)
      }
    } catch {}
  }

  function rememberFingerprint(fp, now) {
    if (!fp) return
    seenFingerprints.delete(fp)
    seenFingerprints.set(fp, now)
    pruneAndSyncDedup(now)
    if (rt.hasTicketStore?.() === true) {
      metaLoaded = true
      try {
        rt.openTicketStore().setMeta(DEDUP_META_KEY, Object.fromEntries(seenFingerprints.entries()), now)
      } catch {}
    }
  }

  function isDuplicate(fp, now) {
    if (!fp) return false
    loadDedupFromStoreIfReady(now)
    const ts = seenFingerprints.get(fp)
    if (ts === undefined) return false
    if (now - ts >= dedupTtlMs) {
      seenFingerprints.delete(fp)
      return false
    }
    return true
  }

  async function ingestEvent(rawEvent, { now = clock.now(), notifyChiefOnUnmatched = false } = {}) {
    const event = normalizeEvent(rawEvent)
    const fingerprint = computeEventFingerprint(event)

    if (isDuplicate(fingerprint, now)) {
      return { handled: true, action: 'deduplicated', fingerprint }
    }

    if (rt.hasTicketStore?.() === true) {
      const store = rt.openTicketStore()
      const activeTickets = store.list({ activeOnly: true, limit: 200 })
      let best = null
      for (const ticket of activeTickets) {
        if (event.targetBotId !== undefined) {
          if (rt.canViewTicket && !rt.canViewTicket(event.targetBotId, ticket)) continue
        } else if (ticket.ownerBotId && rt.botOf?.(ticket.ownerBotId)?.private === true) {
          continue
        }
        const match = matchEventToTicket(event, ticket)
        if (!match.matched) continue
        if (
          best === null
          || match.score > best.match.score
          || (match.score === best.match.score && ticket.updatedAt > best.ticket.updatedAt)
        ) {
          best = { ticket, match }
        }
      }

      if (best !== null && typeof rt.ticketQueue?.submitAssignment === 'function') {
        rememberFingerprint(fingerprint, now)
        const submitted = rt.ticketQueue.submitAssignment({
          ticketId: best.ticket.id,
          priority: event.source === 'im' ? 'human' : 'normal',
          triggerKind: 'event',
          triggerRef: fingerprint ?? event.source,
          prompt: buildWorkerEventPrompt(event, best.match.reason),
          ...(fingerprint ? { idempotencyKey: `event:${fingerprint}` } : {}),
          extraPayload: {
            eventSource: event.source,
            ...(event.channel ? { eventChannel: event.channel } : {}),
            ...(event.sender ? { eventSender: event.sender } : {}),
            ...(event.subject ? { eventSubject: event.subject } : {}),
          },
        })
        return {
          handled: true,
          action: 'dispatched_worker',
          ticketId: best.ticket.id,
          assignmentId: submitted?.assignment?.id ?? '',
          deduplicated: Boolean(submitted?.deduplicated),
          matchReason: best.match.reason,
          fingerprint,
        }
      }
    }

    const noise = classifyEventNoise(event, customNoisePatterns)
    if (noise.isNoise) {
      rememberFingerprint(fingerprint, now)
      return { handled: true, action: 'dropped_noise', reason: noise.reason, fingerprint }
    }

    rememberFingerprint(fingerprint, now)
    if (notifyChiefOnUnmatched) {
      const targetBotId = event.targetBotId ?? rt.state?.mainBotIds?.[0]
      if (targetBotId && typeof rt.deliver === 'function' && rt.botOf?.(targetBotId)) {
        try {
          await rt.deliver({
            toId: targetBotId,
            fromName: 'Event Router (Mail)',
            role: 'mail',
            text: buildChiefMailNotice(event),
            recordExchange: false,
          })
          return { handled: true, action: 'forwarded_chief', targetBotId, fingerprint }
        } catch (error) {
          rt.warn?.('ds-bot: forwarding unmatched mail event to %s failed: %s', targetBotId, error?.message ?? error)
        }
      }
    }

    return { handled: false, action: 'pass_to_chief', fingerprint }
  }

  async function routeInboundIm({ conn, msg, body, targetBotId, now } = {}) {
    const rawId = msg?.id ?? msg?.messageId ?? ''
    const sender = String(msg?.sender?.name || msg?.sender?.id || '').trim()
    return ingestEvent({
      source: 'im',
      platform: conn?.platform ?? '',
      channel: msg?.chat?.key ?? conn?.id ?? 'im',
      externalId: typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : '',
      requireExternalId: true,
      sender,
      senderId: msg?.sender?.id ? String(msg.sender.id) : '',
      senderName: msg?.sender?.name ? String(msg.sender.name) : '',
      senderIsBot: msg?.sender?.isBot === true,
      text: body ?? msg?.text ?? '',
      targetBotId,
    }, { now, notifyChiefOnUnmatched: false })
  }

  async function pollMailOnce({ now = clock.now() } = {}) {
    if (stopped || polling || rt.mailConnector?.hasAccounts?.() !== true) {
      return { accounts: 0, fetched: 0, dispatched: 0, forwarded: 0, dropped: 0, deduplicated: 0 }
    }

    polling = true
    try {
      const accounts = rt.mailConnector.accounts?.() ?? []
      let fetched = 0
      let dispatched = 0
      let forwarded = 0
      let dropped = 0
      let deduplicated = 0

      for (const account of accounts) {
        try {
          const session = await rt.mailConnector.connect(account)
          const rows = await session.search({ folder: 'INBOX', unread: true, limit: 20 })
          if (!Array.isArray(rows)) continue
          fetched += rows.length
          for (const row of rows) {
            const uid = row?.uid !== undefined ? String(row.uid) : ''
            const res = await ingestEvent({
              source: 'mail',
              channel: account.address || account.id || 'mail',
              externalId: uid !== '' ? `${account.id || account.address}:${uid}` : '',
              sender: row?.from ?? '',
              subject: row?.subject ?? '',
              text: row?.snippet ?? row?.text ?? '',
              headers: row?.headers ?? {},
            }, { now, notifyChiefOnUnmatched: true })
            if (res.action === 'dispatched_worker') dispatched += 1
            else if (res.action === 'forwarded_chief') forwarded += 1
            else if (res.action === 'dropped_noise') dropped += 1
            else if (res.action === 'deduplicated') deduplicated += 1
          }
        } catch (error) {
          rt.warn?.('ds-bot: mail event poll for %s failed: %s', account?.address ?? account?.id ?? 'account', error?.message ?? error)
        }
      }

      return { accounts: accounts.length, fetched, dispatched, forwarded, dropped, deduplicated }
    } finally {
      polling = false
    }
  }

  function start() {
    if (!mailEnabled || stopped || pollTimer !== null || startupTimer !== null) return
    const runSweep = () => {
      void pollMailOnce().catch(error => {
        rt.warn?.('ds-bot: mail event poll failed: %s', error?.message ?? error)
      })
    }
    startupTimer = setTimeout(() => {
      startupTimer = null
      if (!stopped) runSweep()
    }, mailStartupDelayMs)
    startupTimer.unref?.()
    pollTimer = setInterval(runSweep, mailPollMs)
    pollTimer.unref?.()
  }

  function stop() {
    stopped = true
    if (startupTimer !== null) {
      clearTimeout(startupTimer)
      startupTimer = null
    }
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  return {
    ingestEvent,
    routeInboundIm,
    pollMailOnce,
    start,
    stop,
    stats: () => ({
      mailEnabled,
      mailPollMs,
      polling,
      stopped,
      seenCount: seenFingerprints.size,
    }),
  }
}

export function install(rt) {
  const router = createEventRouter(rt)
  rt.ctx.effect(() => {
    router.start()
    return () => router.stop()
  }, 'ds-bot: event router')
  rt.eventRouter = router
}
