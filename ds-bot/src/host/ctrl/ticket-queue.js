// Single-ticket serial Actor queue + global Worker concurrency slots
// (reserving +1 human-priority slot so human commands are never starved)
// and persisted Effects pump with startup crash recovery.

const DEFAULT_MAX_WORKERS = 2
const DEFAULT_HUMAN_RESERVE = 1
const DEFAULT_EFFECT_POLL_MS = 5000

export function createTicketQueue({
  openStore,
  hasStore = () => true,
  maxWorkers = DEFAULT_MAX_WORKERS,
  humanReserve = DEFAULT_HUMAN_RESERVE,
  effectPollMs = DEFAULT_EFFECT_POLL_MS,
  clock = { now: () => Date.now() },
  warn = () => {},
} = {}) {
  const safeMaxWorkers = Number.isInteger(maxWorkers) && maxWorkers >= 1 ? maxWorkers : DEFAULT_MAX_WORKERS
  const safeHumanReserve = Number.isInteger(humanReserve) && humanReserve >= 0 ? humanReserve : DEFAULT_HUMAN_RESERVE
  const safePollMs = Number.isInteger(effectPollMs) && effectPollMs >= 50 ? effectPollMs : DEFAULT_EFFECT_POLL_MS

  const activeTickets = new Set()
  const humanWaiters = []
  const normalWaiters = []
  const handlers = new Map()
  const drainWaiters = new Set()

  let runningNormal = 0
  let runningHuman = 0
  let inFlightCount = 0
  let activePumpCount = 0
  let stopped = false
  let pollTimer = null

  function notifyIdle() {
    if (inFlightCount === 0 && activePumpCount === 0 && humanWaiters.length === 0 && normalWaiters.length === 0) {
      for (const resolve of drainWaiters) resolve()
      drainWaiters.clear()
    }
  }

  function canRun(item) {
    if (stopped) return false
    if (item.ticketId && activeTickets.has(item.ticketId)) return false
    if (item.priority === 'human') {
      return (runningNormal + runningHuman) < (safeMaxWorkers + safeHumanReserve)
    }
    return runningNormal < safeMaxWorkers
  }

  function pickNext(waiters) {
    for (let i = 0; i < waiters.length; i += 1) {
      if (canRun(waiters[i])) {
        const [item] = waiters.splice(i, 1)
        return item
      }
    }
    return undefined
  }

  function startItem(item) {
    const isHuman = item.priority === 'human'
    if (item.ticketId) activeTickets.add(item.ticketId)
    if (isHuman) runningHuman += 1
    else runningNormal += 1
    inFlightCount += 1

    const finish = () => {
      if (item.ticketId) activeTickets.delete(item.ticketId)
      if (isHuman) runningHuman -= 1
      else runningNormal -= 1
      inFlightCount -= 1
      schedule()
      notifyIdle()
    }

    ;(async () => {
      if (item.expectedRevision !== undefined && item.ticketId) {
        const ticket = openStore().get(item.ticketId)
        if (ticket === undefined) throw new Error(`Ticket not found: ${item.ticketId}`)
        if (ticket.revision !== item.expectedRevision) {
          throw new Error(`Revision conflict: ticket ${item.ticketId} is at revision ${ticket.revision}, expected ${item.expectedRevision}.`)
        }
      }
      return await item.run({ ticketId: item.ticketId, priority: item.priority })
    })().then(
      (value) => {
        finish()
        item.resolve(value)
      },
      (error) => {
        finish()
        item.reject(error)
      },
    )
  }

  function schedule() {
    if (stopped) return
    while (true) {
      const next = pickNext(humanWaiters) ?? pickNext(normalWaiters)
      if (next === undefined) break
      startItem(next)
    }
  }

  function enqueue({ ticketId = '', priority = 'normal', expectedRevision, run } = {}) {
    if (stopped) return Promise.reject(new Error('Ticket queue stopped.'))
    if (typeof run !== 'function') return Promise.reject(new Error('Queue task requires a run function.'))
    const cleanTicketId = typeof ticketId === 'string' ? ticketId.trim() : ''
    const cleanPriority = priority === 'human' ? 'human' : 'normal'

    return new Promise((resolve, reject) => {
      const item = { ticketId: cleanTicketId, priority: cleanPriority, expectedRevision, run, resolve, reject }
      if (cleanPriority === 'human') humanWaiters.push(item)
      else normalWaiters.push(item)
      schedule()
    })
  }

  function registerEffectHandler(kind, handler) {
    if (typeof kind !== 'string' || kind.trim() === '') throw new Error('Effect handler kind must not be empty.')
    if (typeof handler !== 'function') throw new Error(`Effect handler for "${kind}" must be a function.`)
    handlers.set(kind.trim(), handler)
    if (!stopped && hasStore()) {
      void pumpEffects().catch(error => warn('ds-bot: pumping effects after handler registration failed: %s', error?.message ?? error))
    }
  }

  async function runClaimedEffect(effect) {
    const handler = handlers.get(effect.kind)
    if (handler === undefined) {
      openStore().failEffect(effect.id, `No handler registered for effect kind "${effect.kind}".`, { now: clock.now() })
      return false
    }
    const exec = async () => handler(effect, { openStore, clock })
    try {
      if (effect.ticketId) {
        const priority = effect.payload?.priority === 'human' ? 'human' : 'normal'
        await enqueue({ ticketId: effect.ticketId, priority, run: exec })
      } else {
        await exec()
      }
      openStore().completeEffect(effect.id, { now: clock.now() })
      return true
    } catch (error) {
      try {
        openStore().failEffect(effect.id, error?.message ?? String(error), { now: clock.now() })
      } catch (failErr) {
        warn('ds-bot: failing effect %s failed: %s', effect.id, failErr?.message ?? failErr)
      }
      return false
    }
  }

  async function pumpEffects({ now = clock.now(), limit = 20 } = {}) {
    if (stopped || !hasStore() || handlers.size === 0) {
      return { claimed: 0, completed: 0, failed: 0 }
    }
    activePumpCount += 1
    try {
      const store = openStore()
      const due = store.claimDueEffects({ now, limit, kinds: [...handlers.keys()] })
      if (due.length === 0) return { claimed: 0, completed: 0, failed: 0 }

      const outcomes = await Promise.all(due.map(runClaimedEffect))
      let completed = 0
      let failed = 0
      for (const ok of outcomes) {
        if (ok) completed += 1
        else failed += 1
      }
      return { claimed: due.length, completed, failed }
    } finally {
      activePumpCount -= 1
      notifyIdle()
    }
  }

  function submitAssignment(opts = {}) {
    const result = openStore().dispatchWithEffect({ ...opts, now: opts.now ?? clock.now() })
    const effectKind = opts.effectKind ?? 'dispatch_assignment'
    if (handlers.has(effectKind) && !stopped && hasStore()) {
      void pumpEffects({ now: clock.now() }).catch(error => warn('ds-bot: pumping dispatched assignment failed: %s', error?.message ?? error))
    }
    return result
  }

  function recoverOnStartup({ now = clock.now(), note } = {}) {
    if (!hasStore()) {
      return { interruptedAssignments: [], requeuedEffects: [], recoveryEffects: [] }
    }
    const result = openStore().recoverInterrupted({ now, ...(note !== undefined ? { note } : {}) })
    if (handlers.size > 0 && !stopped) {
      void pumpEffects({ now }).catch(error => warn('ds-bot: startup recovery effect pump failed: %s', error?.message ?? error))
    }
    return result
  }

  function startPolling() {
    if (pollTimer !== null || stopped) return
    pollTimer = setInterval(() => {
      if (stopped || !hasStore() || handlers.size === 0) return
      void pumpEffects({ now: clock.now() }).catch(error => warn('ds-bot: effect poll failed: %s', error?.message ?? error))
    }, safePollMs)
    pollTimer.unref?.()
  }

  function stop() {
    stopped = true
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    for (const item of [...humanWaiters.splice(0), ...normalWaiters.splice(0)]) {
      item.reject(new Error('Ticket queue stopped.'))
    }
    notifyIdle()
  }

  function drain() {
    if (inFlightCount === 0 && activePumpCount === 0 && humanWaiters.length === 0 && normalWaiters.length === 0) {
      return Promise.resolve()
    }
    return new Promise(resolve => drainWaiters.add(resolve))
  }

  function stats() {
    return {
      maxWorkers: safeMaxWorkers,
      humanReserve: safeHumanReserve,
      runningNormal,
      runningHuman,
      activeTickets: [...activeTickets],
      queuedHuman: humanWaiters.length,
      queuedNormal: normalWaiters.length,
    }
  }

  return {
    enqueue,
    submitAssignment,
    registerEffectHandler,
    pumpEffects,
    recoverOnStartup,
    startPolling,
    stop,
    drain,
    stats,
  }
}

export function install(rt) {
  const { ctx, config } = rt
  const ctrlConfig = config?.ctrl ?? {}
  const queue = createTicketQueue({
    openStore: () => rt.openTicketStore(),
    hasStore: () => rt.hasTicketStore?.() === true,
    maxWorkers: ctrlConfig.maxWorkers,
    humanReserve: ctrlConfig.humanReserve,
    effectPollMs: ctrlConfig.effectPollMs,
    warn: (...args) => rt.warn?.(...args),
  })

  ctx.effect(() => {
    try {
      queue.recoverOnStartup()
    } catch (error) {
      rt.warn?.('ds-bot: ticket queue startup recovery failed: %s', error?.message ?? error)
    }
    queue.startPolling()
    return () => queue.stop()
  }, 'ds-bot: ticket queue')

  rt.ticketQueue = queue
}
