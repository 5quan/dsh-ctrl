// Deterministic deadline & stalled-ticket watcher (R-3.1):
// - Periodically inspects due/overdue deadlines and stalled active tickets
//   without opening tickets.sqlite until a ticket store actually exists.
// - Auto-dispatches open/in_progress/blocked tickets when wake_condition
//   explicitly opts into time-based Worker wakeup (never waiting_user/review).
// - Groups overdue, upcoming, and stalled reminders per recipient with
//   ctrl_meta-persisted cooldown deduplication across restarts and strict
//   private-Bot isolation.
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { TERMINAL_TICKET_STATUSES } from './tickets.js'

export const DEFAULT_WATCH_POLL_MS = 60_000
export const DEFAULT_WATCH_STARTUP_DELAY_MS = 15_000
export const DEFAULT_UPCOMING_LEAD_MS = 30 * 60 * 1000
export const DEFAULT_REMINDER_COOLDOWN_MS = 6 * 60 * 60 * 1000
export const DEFAULT_IN_PROGRESS_STALE_MS = 2 * 60 * 60 * 1000
export const DEFAULT_WAITING_USER_STALE_MS = 24 * 60 * 60 * 1000
export const DEFAULT_REVIEW_STALE_MS = 12 * 60 * 60 * 1000

const AUTO_DISPATCH_ALLOWED_STATUSES = new Set(['open', 'in_progress', 'blocked'])

function positiveMs(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function nonNegativeMs(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
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

function parseTimestamp(raw) {
  const clean = stripOuterQuotes(raw)
  if (clean === '') return null
  if (/^\d+$/.test(clean)) {
    const n = Number(clean)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  const parsed = Date.parse(clean)
  return Number.isFinite(parsed) ? parsed : null
}

function parseBoolDirective(raw) {
  const norm = stripOuterQuotes(raw).toLowerCase()
  if (norm === 'true' || norm === '1' || norm === 'yes' || norm === 'on') return true
  if (norm === 'false' || norm === '0' || norm === 'no' || norm === 'off') return false
  return undefined
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return `${Math.max(1, Math.floor(ms / 1000))}s`
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60
  if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`
}

function formatIso(ms) {
  try {
    return new Date(ms).toISOString()
  } catch {
    return String(ms)
  }
}

export function parseTimeWakeCondition(wakeCondition, deadline = null) {
  const result = { autoDispatch: false, triggerAt: null, mode: 'none' }
  if (typeof wakeCondition !== 'string' || wakeCondition.trim() === '') return result

  const cleanDeadline = typeof deadline === 'number' && Number.isFinite(deadline) ? deadline : null
  let explicitRemindOnly = false
  let scheduledAt = null
  let autoDue = false

  for (const rawLine of wakeCondition.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s+/, '').trim()
    if (line === '' || line.startsWith('#')) continue
    const lower = line.toLowerCase()

    if (lower === 'remind_only' || lower === 'remind-only') {
      explicitRemindOnly = true
      continue
    }
    if (lower === 'auto_wake' || lower === 'auto-wake' || lower === 'auto_dispatch' || lower === 'auto-dispatch') {
      autoDue = true
      continue
    }

    const sepIdx = line.search(/[:=]/)
    if (sepIdx <= 0) continue
    const key = line.slice(0, sepIdx).trim().toLowerCase().replace(/[\s-]+/g, '_')
    const rawVal = line.slice(sepIdx + 1).trim()
    if (rawVal === '') continue

    if (key === 'wake' || key === 'on_due') {
      const val = stripOuterQuotes(rawVal).toLowerCase()
      if (val === 'remind' || val === 'remind_only' || val === 'notify') {
        explicitRemindOnly = true
      } else if (val === 'worker' || val === 'auto' || val === 'dispatch' || val === 'auto_wake') {
        autoDue = true
      }
      continue
    }
    if (key === 'auto_wake' || key === 'auto_dispatch') {
      const b = parseBoolDirective(rawVal)
      if (b === true) autoDue = true
      if (b === false) explicitRemindOnly = true
      continue
    }
    if (key === 'at' || key === 'after' || key === 'wake_at' || key === 'scheduled_at') {
      const ts = parseTimestamp(rawVal)
      if (ts !== null) scheduledAt = ts
    }
  }

  if (explicitRemindOnly) {
    return { autoDispatch: false, triggerAt: null, mode: 'remind' }
  }
  if (scheduledAt !== null) {
    return { autoDispatch: true, triggerAt: scheduledAt, mode: 'scheduled' }
  }
  if (autoDue && cleanDeadline !== null) {
    return { autoDispatch: true, triggerAt: cleanDeadline, mode: 'due' }
  }
  return result
}

export function evaluateTicketWatch({
  ticket,
  now = Date.now(),
  isBusy = false,
  lastActivityAt,
  state = {},
  options = {},
} = {}) {
  if (!ticket || TERMINAL_TICKET_STATUSES.has(ticket.status)) return null

  const upcomingLeadMs = nonNegativeMs(options.upcomingLeadMs, DEFAULT_UPCOMING_LEAD_MS)
  const cooldownMs = positiveMs(options.cooldownMs, DEFAULT_REMINDER_COOLDOWN_MS)
  const inProgressStaleMs = positiveMs(options.inProgressStaleMs, DEFAULT_IN_PROGRESS_STALE_MS)
  const waitingUserStaleMs = positiveMs(options.waitingUserStaleMs, DEFAULT_WAITING_USER_STALE_MS)
  const reviewStaleMs = positiveMs(options.reviewStaleMs, DEFAULT_REVIEW_STALE_MS)

  const autoDispatchAllowed = AUTO_DISPATCH_ALLOWED_STATUSES.has(ticket.status) && !isBusy
  const wake = parseTimeWakeCondition(ticket.wakeCondition, ticket.deadline)
  if (autoDispatchAllowed && wake.autoDispatch && wake.triggerAt !== null && wake.triggerAt <= now) {
    const dispatchKey = `deadline-wake:${ticket.id}:rev${ticket.revision}:${wake.triggerAt}`
    if (state?.dispatches?.[dispatchKey]) return null
    return {
      action: 'dispatch',
      kind: 'time_wake',
      mode: wake.mode,
      dispatchKey,
      triggerAt: wake.triggerAt,
      reason: wake.mode === 'scheduled'
        ? `Scheduled wake time reached (${formatIso(wake.triggerAt)})`
        : `Deadline reached with auto-wake (${formatIso(wake.triggerAt)})`,
    }
  }

  const deadline = typeof ticket.deadline === 'number' && Number.isFinite(ticket.deadline) ? ticket.deadline : null
  if (deadline !== null && deadline <= now) {
    const prev = state?.reminders?.overdue
    if (prev && prev.deadline === deadline && (now - prev.sentAt) < cooldownMs) {
      return null
    }
    const overdueBy = formatDuration(now - deadline)
    return {
      action: 'remind',
      kind: 'overdue',
      deadline,
      summary: overdueBy
        ? `overdue by ${overdueBy} (deadline ${formatIso(deadline)})`
        : `due now (deadline ${formatIso(deadline)})`,
    }
  }

  if (deadline !== null && deadline > now && upcomingLeadMs > 0 && deadline <= now + upcomingLeadMs) {
    const prev = state?.reminders?.upcoming
    if (prev && prev.deadline === deadline) {
      return null
    }
    const remaining = formatDuration(deadline - now)
    return {
      action: 'remind',
      kind: 'upcoming',
      deadline,
      summary: remaining
        ? `due in ${remaining} (deadline ${formatIso(deadline)})`
        : `due soon (deadline ${formatIso(deadline)})`,
    }
  }

  if (!isBusy) {
    let threshold = null
    let since = ticket.updatedAt
    if (ticket.status === 'in_progress') {
      threshold = inProgressStaleMs
      since = typeof lastActivityAt === 'number' && Number.isFinite(lastActivityAt) ? lastActivityAt : ticket.updatedAt
    } else if (ticket.status === 'waiting_user') {
      threshold = waitingUserStaleMs
    } else if (ticket.status === 'review') {
      threshold = reviewStaleMs
    }
    if (threshold !== null && typeof since === 'number' && Number.isFinite(since)) {
      const elapsed = now - since
      if (elapsed >= threshold) {
        const prev = state?.reminders?.stalled
        if (prev && prev.status === ticket.status && prev.revision === ticket.revision && (now - prev.sentAt) < cooldownMs) {
          return null
        }
        return {
          action: 'remind',
          kind: 'stalled',
          staleMs: elapsed,
          status: ticket.status,
          revision: ticket.revision,
          summary: `stalled in "${ticket.status}" for ${formatDuration(elapsed) || 'extended period'}`,
        }
      }
    }
  }

  return null
}

function readWatchState(store, ticketId) {
  const raw = store.getMeta(`deadline-watch:${ticketId}`)
  return raw && typeof raw === 'object' ? raw : {}
}

function writeWatchState(store, ticketId, nextState, now) {
  store.setMeta(`deadline-watch:${ticketId}`, nextState, now)
}

function trimDispatches(dispatches, maxEntries = 10) {
  const entries = Object.entries(dispatches ?? {})
  if (entries.length <= maxEntries) return dispatches ?? {}
  return Object.fromEntries(entries.slice(-maxEntries))
}

function formatGroupedReminderText(items) {
  const overdue = items.filter(item => item.decision.kind === 'overdue')
  const upcoming = items.filter(item => item.decision.kind === 'upcoming')
  const stalled = items.filter(item => item.decision.kind === 'stalled')

  const lines = [`Deadline & progress patrol noticed ${items.length} ticket(s) needing attention:`]
  const appendSection = (heading, list) => {
    if (list.length === 0) return
    lines.push('', `**${heading} (${list.length})**:`)
    for (const { ticket, decision } of list) {
      const next = ticket.nextStep ? ` · next: ${ticket.nextStep}` : ''
      lines.push(`- [${ticket.id}] (${ticket.status}, rev ${ticket.revision}) ${ticket.title} — ${decision.summary}${next}`)
    }
  }

  appendSection('Overdue', overdue)
  appendSection('Due Soon', upcoming)
  appendSection('Stalled', stalled)
  return lines.join('\n')
}

export function createDeadlineWatcher(rt, overrides = {}) {
  const { ctx, config } = rt
  const ctrlConfig = config?.ctrl ?? {}
  const enabled = overrides.enabled ?? (ctrlConfig.deadlineWatcherEnabled !== false)
  const pollMs = positiveMs(overrides.pollMs ?? ctrlConfig.deadlinePollMs, DEFAULT_WATCH_POLL_MS)
  const startupDelayMs = nonNegativeMs(overrides.startupDelayMs ?? ctrlConfig.deadlineStartupDelayMs, DEFAULT_WATCH_STARTUP_DELAY_MS)
  const watchOptions = {
    upcomingLeadMs: nonNegativeMs(overrides.upcomingLeadMs ?? ctrlConfig.deadlineLeadMs, DEFAULT_UPCOMING_LEAD_MS),
    cooldownMs: positiveMs(overrides.cooldownMs ?? ctrlConfig.deadlineCooldownMs, DEFAULT_REMINDER_COOLDOWN_MS),
    inProgressStaleMs: positiveMs(overrides.inProgressStaleMs ?? ctrlConfig.inProgressStaleMs, DEFAULT_IN_PROGRESS_STALE_MS),
    waitingUserStaleMs: positiveMs(overrides.waitingUserStaleMs ?? ctrlConfig.waitingUserStaleMs, DEFAULT_WAITING_USER_STALE_MS),
    reviewStaleMs: positiveMs(overrides.reviewStaleMs ?? ctrlConfig.reviewStaleMs, DEFAULT_REVIEW_STALE_MS),
  }
  const clock = overrides.clock ?? { now: () => Date.now() }

  let stopped = false
  let scanning = false
  let lastScanAt = null
  let startupTimer = null
  let pollTimer = null

  function resolveRecipientBotId(ticket) {
    const ownerBot = ticket?.ownerBotId ? rt.botOf?.(ticket.ownerBotId) : undefined
    if (ownerBot?.private === true) {
      return ownerBot.id
    }
    if (ticket?.ownerBotId && rt.isMain?.(ticket.ownerBotId) === true) {
      return ticket.ownerBotId
    }
    return rt.state?.mainBotIds?.[0] ?? ticket?.ownerBotId
  }

  async function sendGroupedReminder(recipientBotId, items) {
    if (!recipientBotId || items.length === 0) return false
    const text = formatGroupedReminderText(items)

    if (typeof rt.deliver === 'function' && rt.botOf?.(recipientBotId)) {
      try {
        await rt.deliver({
          toId: recipientBotId,
          fromName: 'Deadline Watcher',
          text,
          role: 'deadline_watch',
          recordExchange: false,
        })
        return true
      } catch (error) {
        rt.warn?.('ds-bot: deadline reminder delivery to %s failed: %s', recipientBotId, error?.message ?? error)
        return false
      }
    }

    const sessionId = rt.chatOf?.(recipientBotId) ?? recipientBotId
    const agent = rt.ctx?.agents?.get?.(sessionId) ?? ctx?.agents?.get?.(sessionId)
    if (typeof agent?.followup === 'function') {
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: `[Deadline Watcher]\n${text}` }],
          source: {
            kind: 'bot',
            form: 'relay',
            role: 'deadline_watch',
            senderName: 'Deadline Watcher',
          },
        }))
        return true
      } catch (error) {
        rt.warn?.('ds-bot: deadline followup to %s failed: %s', recipientBotId, error?.message ?? error)
      }
    }
    return false
  }

  async function scanOnce({ now = clock.now() } = {}) {
    if (stopped || scanning) {
      return { scanned: 0, dispatched: [], reminded: [], skipped: 0 }
    }
    if (rt.hasTicketStore?.() !== true) {
      return { scanned: 0, dispatched: [], reminded: [], skipped: 0 }
    }

    scanning = true
    try {
      const store = rt.openTicketStore()
      const byId = new Map()
      for (const ticket of store.listDue(now + watchOptions.upcomingLeadMs, 200)) {
        byId.set(ticket.id, ticket)
      }
      for (const ticket of store.list({ activeOnly: true, limit: 200 })) {
        if (!byId.has(ticket.id)) byId.set(ticket.id, ticket)
      }

      const activeAssignments = store.listAssignments({ activeOnly: true, limit: 200 })
      const busyTicketIds = new Set(activeAssignments.map(a => a.ticketId))
      for (const id of rt.ticketQueue?.stats?.().activeTickets ?? []) {
        busyTicketIds.add(id)
      }

      const latestAssignmentAt = new Map()
      for (const asg of store.listAssignments({ limit: 200 })) {
        const prevAt = latestAssignmentAt.get(asg.ticketId) ?? 0
        if (asg.updatedAt > prevAt) latestAssignmentAt.set(asg.ticketId, asg.updatedAt)
      }

      const dispatched = []
      const reminded = []
      let skipped = 0
      const remindersByRecipient = new Map()

      for (const ticket of byId.values()) {
        const state = readWatchState(store, ticket.id)
        const lastActivityAt = Math.max(ticket.updatedAt, latestAssignmentAt.get(ticket.id) ?? 0)
        const decision = evaluateTicketWatch({
          ticket,
          now,
          isBusy: busyTicketIds.has(ticket.id),
          lastActivityAt,
          state,
          options: watchOptions,
        })
        if (!decision) {
          skipped += 1
          continue
        }

        if (decision.action === 'dispatch') {
          if (typeof rt.ticketQueue?.submitAssignment !== 'function') {
            skipped += 1
            continue
          }
          try {
            const promptParts = [
              `[Scheduled/Deadline Auto-Wake] ${decision.reason}.`,
              ticket.nextStep ? `Next step: ${ticket.nextStep}` : `Advance ticket goal: ${ticket.goal}`,
            ]
            const submitted = rt.ticketQueue.submitAssignment({
              ticketId: ticket.id,
              priority: 'normal',
              triggerKind: 'deadline',
              triggerRef: String(decision.triggerAt),
              prompt: promptParts.join('\n'),
              idempotencyKey: decision.dispatchKey,
            })
            const nextState = {
              ...state,
              dispatches: trimDispatches({
                ...state.dispatches,
                [decision.dispatchKey]: {
                  dispatchedAt: now,
                  revision: ticket.revision,
                  triggerAt: decision.triggerAt,
                  assignmentId: submitted?.assignment?.id ?? '',
                },
              }),
            }
            writeWatchState(store, ticket.id, nextState, now)
            dispatched.push({
              ticketId: ticket.id,
              assignmentId: submitted?.assignment?.id ?? '',
              deduplicated: Boolean(submitted?.deduplicated),
              key: decision.dispatchKey,
            })
          } catch (error) {
            rt.warn?.('ds-bot: deadline auto-dispatch for %s failed: %s', ticket.id, error?.message ?? error)
            skipped += 1
          }
          continue
        }

        const recipientBotId = resolveRecipientBotId(ticket)
        if (!recipientBotId) {
          skipped += 1
          continue
        }
        const batch = remindersByRecipient.get(recipientBotId) ?? []
        batch.push({ ticket, decision, state })
        remindersByRecipient.set(recipientBotId, batch)
      }

      for (const [recipientBotId, batch] of remindersByRecipient.entries()) {
        const ok = await sendGroupedReminder(recipientBotId, batch)
        if (!ok) {
          skipped += batch.length
          continue
        }
        for (const { ticket, decision, state } of batch) {
          const prevReminders = state.reminders ?? {}
          const record = decision.kind === 'stalled'
            ? { sentAt: now, status: decision.status, revision: decision.revision }
            : { sentAt: now, deadline: decision.deadline }
          writeWatchState(store, ticket.id, {
            ...state,
            reminders: {
              ...prevReminders,
              [decision.kind]: record,
            },
          }, now)
          reminded.push({
            ticketId: ticket.id,
            kind: decision.kind,
            recipientBotId,
          })
        }
      }

      lastScanAt = now
      return {
        scanned: byId.size,
        dispatched,
        reminded,
        skipped,
      }
    } finally {
      scanning = false
    }
  }

  function start() {
    if (!enabled || stopped || pollTimer !== null || startupTimer !== null) return
    const runSweep = () => {
      void scanOnce().catch(error => {
        rt.warn?.('ds-bot: deadline watcher scan failed: %s', error?.message ?? error)
      })
    }
    startupTimer = setTimeout(() => {
      startupTimer = null
      if (!stopped) runSweep()
    }, startupDelayMs)
    startupTimer.unref?.()
    pollTimer = setInterval(runSweep, pollMs)
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
    scanOnce,
    start,
    stop,
    stats: () => ({
      enabled,
      scanning,
      stopped,
      lastScanAt,
      pollMs,
      ...watchOptions,
    }),
  }
}

export function install(rt) {
  const watcher = createDeadlineWatcher(rt)
  rt.ctx.effect(() => {
    watcher.start()
    return () => watcher.stop()
  }, 'ds-bot: deadline watcher')
  rt.deadlineWatcher = watcher
}
