// Lightweight idle day rollover: subscribes to `dsh-memory/day-rolled-over` via
// memoryBridge and moves Main Bot (Chief) to a fresh Part once idle, without
// generating a redundant LLM handoff note or copying 16k of yesterday's messages.

export function install(rt) {
  const { ctx } = rt
  const pendingRollovers = new Map()
  const completedDates = new Map()
  const inFlight = new Map()

  function lastRolledDateFor(botId) {
    if (completedDates.has(botId)) return completedDates.get(botId)
    if (!rt.hasTicketStore?.()) return undefined
    try {
      const meta = rt.openTicketStore().getMeta(`dayRollover:${botId}`)
      const date = typeof meta?.lastRolledDate === 'string' ? meta.lastRolledDate : undefined
      if (date !== undefined) completedDates.set(botId, date)
      return date
    } catch (error) {
      rt.warn?.('ds-bot: failed to read dayRollover meta for %s: %s', botId, error?.message ?? error)
      return undefined
    }
  }

  async function tryRollover(botId) {
    if (inFlight.has(botId)) return inFlight.get(botId)
    const run = (async () => {
      const pending = pendingRollovers.get(botId)
      if (pending === undefined) return false
      if (rt.readOnly?.() !== undefined) return false
      if (lastRolledDateFor(botId) === pending.date) {
        pendingRollovers.delete(botId)
        return false
      }
      const sessionId = rt.chatOf(botId)
      if (sessionId === undefined) return false
      const started = await rt.rolloverPart?.(sessionId, pending)
      if (started !== true) return false
      pendingRollovers.delete(botId)
      completedDates.set(botId, pending.date)
      try {
        rt.openTicketStore?.().setMeta(`dayRollover:${botId}`, { lastRolledDate: pending.date, at: Date.now() })
      } catch (error) {
        rt.warn?.('ds-bot: failed to persist dayRollover meta for %s: %s', botId, error?.message ?? error)
      }
      return true
    })().finally(() => { inFlight.delete(botId) })
    inFlight.set(botId, run)
    return run
  }

  async function handleDayRolledOver(payload = {}) {
    if (rt.readOnly?.() !== undefined) return
    if (payload?.scope && payload.scope !== 'default') return
    const date = String(payload?.date ?? '').trim()
    if (date === '') return

    await rt.load()
    if (rt.readOnly?.() !== undefined) return
    const summary = typeof payload?.summary?.text === 'string' && payload.summary.text.trim() !== ''
      ? payload.summary.text.trim()
      : typeof payload?.summary === 'string' ? payload.summary.trim() : ''

    const targets = Object.values(rt.state.bots ?? {}).filter(bot => rt.isMain(bot.id) && bot.private !== true)
    for (const bot of targets) {
      if (lastRolledDateFor(bot.id) === date) continue
      pendingRollovers.set(bot.id, { date, summary })
      await tryRollover(bot.id)
    }
  }

  rt.memoryBridge?.onDayRolledOver((payload) => {
    void handleDayRolledOver(payload).catch((error) => {
      rt.warn?.('ds-bot: handling day-rolled-over failed: %s', error?.message ?? error)
    })
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || pendingRollovers.size === 0) return
    const botId = rt.chatOwners.get(agent?.id)
    if (botId !== undefined && pendingRollovers.has(botId)) {
      void tryRollover(botId).catch((error) => {
        rt.warn?.('ds-bot: deferred day rollover for %s failed: %s', botId, error?.message ?? error)
      })
    }
  })

  rt.dayRollover = {
    handleDayRolledOver,
    tryRollover,
    pendingFor: botId => pendingRollovers.get(botId),
  }
}
