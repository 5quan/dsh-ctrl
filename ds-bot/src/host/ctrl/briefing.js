// Unified morning briefing: merges dsh-memory highlights and pending buffer
// confirmations with due, waiting_user, and review Tickets into one daily card,
// coordinating markBriefingDelivered() before next() to prevent duplicate pushes.
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { REPLY_KIND } from '../constants.js'
import { output } from '../tools.js'

const ACTION_ENUM = ['get', 'confirm', 'dismiss']
const BRIEFING_SOURCE_KIND = 'dsh-ctrl/briefing'

function localDateToday(timeZone) {
  try {
    const tz = timeZone ? { timeZone } : {}
    return new Intl.DateTimeFormat('en-CA', { ...tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

function endOfLogicalDayMs(dateStr, now = Date.now()) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) {
    return now
  }
  const parsed = Date.parse(`${dateStr.trim()}T23:59:59.999`)
  if (Number.isNaN(parsed)) return now
  return Math.max(parsed, now)
}

function hasRealUserMessage(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some(msg => msg?.role === 'user' && (msg?.source?.kind === 'user' || msg?.source?.kind === REPLY_KIND))
}

function formatDeadline(ms) {
  return ms === null || ms === undefined ? '' : new Date(ms).toISOString()
}

function formatUnifiedMarkdown({ date, memory, tickets }) {
  const lines = [`# ${date} 每日综合晨报`]

  if (memory) {
    if (memory.yesterday) {
      lines.push('', `### 昨日日报亮点（${memory.yesterday.date}）`)
      const h = memory.yesterday.highlights ?? {}
      if (h.decisions?.length > 0) {
        lines.push('**做出的决定**：', ...h.decisions.map(item => `- ${item}`))
      }
      if (h.lessons?.length > 0) {
        lines.push('**纠正与教训**：', ...h.lessons.map(item => `- ${item}`))
      }
      if (h.openQuestions?.length > 0) {
        lines.push('**悬而未决的问题**：', ...h.openQuestions.map(item => `- ${item}`))
      }
      if (h.happened?.length > 0 && !(h.decisions?.length > 0) && !(h.lessons?.length > 0)) {
        lines.push('**发生了什么**：', ...h.happened.map(item => `- ${item}`))
      }
      if (!h.hasContent) {
        lines.push('- （昨日日报无重点摘要）')
      }
    }

    const pending = memory.buffer?.pending ?? []
    const approved = memory.buffer?.approved ?? []
    lines.push('', `### 待确认记忆缓冲区（待确认 ${pending.length} 条 / 已批准待落盘 ${approved.length} 条）`)
    if (pending.length === 0 && approved.length === 0) {
      lines.push('- （当前无待处理缓冲条目）')
    } else {
      for (const item of pending) {
        lines.push(`- [待确认] \`${item.id}\` (${item.logical_date} · ${item.source_type} -> ${item.target}) ${item.content}`)
      }
      for (const item of approved) {
        lines.push(`- [已批准待落盘] \`${item.id}\` (${item.logical_date} · ${item.source_type} -> ${item.target}) ${item.content}`)
      }
    }
  }

  if (tickets.hasAttention || tickets.otherActiveCount > 0) {
    lines.push('', '### 今日关注工单（Tickets）')
    if (tickets.due.length > 0) {
      lines.push(`**今日到期 / 已逾期 (${tickets.due.length})**：`)
      for (const t of tickets.due) {
        lines.push(`- [${t.id}] (${t.status}, rev ${t.revision}) ${t.title} — due: ${formatDeadline(t.deadline)}`)
      }
    }
    if (tickets.waitingUser.length > 0) {
      lines.push(`**等待你拍板 (waiting_user · ${tickets.waitingUser.length})**：`)
      for (const t of tickets.waitingUser) {
        const extra = [t.waitingOn ? `waiting: ${t.waitingOn}` : '', t.nextStep ? `next: ${t.nextStep}` : ''].filter(Boolean).join(' · ')
        lines.push(`- [${t.id}] (rev ${t.revision}) ${t.title}${extra ? ` · ${extra}` : ''}`)
      }
    }
    if (tickets.review.length > 0) {
      lines.push(`**等待验收 (review · ${tickets.review.length})**：`)
      for (const t of tickets.review) {
        lines.push(`- [${t.id}] (rev ${t.revision}) ${t.title}${t.nextStep ? ` · next: ${t.nextStep}` : ''}`)
      }
    }
    if (tickets.otherActiveCount > 0) {
      lines.push(`- （另有 ${tickets.otherActiveCount} 条进行中/待办工单，可调用 \`ticket_list\` 查看）`)
    }
  }

  return lines.join('\n')
}

export function install(rt) {
  const { ctx } = rt
  const deliveredDates = new Map()

  function collectTicketBriefing(botId, todayDate, now = Date.now()) {
    if (!rt.hasTicketStore?.()) {
      return { due: [], waitingUser: [], review: [], otherActiveCount: 0, hasAttention: false }
    }
    try {
      const endOfDay = endOfLogicalDayMs(todayDate, now)
      const active = rt.openTicketStore().list({ activeOnly: true, limit: 100 })
        .filter(ticket => (rt.canViewTicket ? rt.canViewTicket(botId, ticket) : true))
      const due = active.filter(ticket => ticket.deadline !== null && ticket.deadline <= endOfDay)
      const waitingUser = active.filter(ticket => ticket.status === 'waiting_user')
      const review = active.filter(ticket => ticket.status === 'review')
      const attentionIds = new Set([...due, ...waitingUser, ...review].map(ticket => ticket.id))
      const otherActiveCount = active.filter(ticket => !attentionIds.has(ticket.id)).length
      const hasAttention = due.length > 0 || waitingUser.length > 0 || review.length > 0
      return { due, waitingUser, review, otherActiveCount, hasAttention }
    } catch (error) {
      rt.warn?.('ds-bot: collecting ticket briefing failed: %s', error?.message ?? error)
      return { due: [], waitingUser: [], review: [], otherActiveCount: 0, hasAttention: false }
    }
  }

  function isDeliveredLocally(scope, todayDate) {
    if (deliveredDates.get(scope) === todayDate) return true
    if (!rt.hasTicketStore?.()) return false
    try {
      const meta = rt.openTicketStore().getMeta(`briefing:${scope}`)
      if (meta?.lastBriefedDate === todayDate) {
        deliveredDates.set(scope, todayDate)
        return true
      }
    } catch (error) {
      rt.warn?.('ds-bot: reading briefing meta failed: %s', error?.message ?? error)
    }
    return false
  }

  function getUnifiedBriefing({ botId, date, scope = 'default', now = Date.now() } = {}) {
    const todayDate = date || rt.memoryBridge?.getCurrentLogicalDate?.() || localDateToday(rt.config?.timeZone)
    const memory = rt.memoryBridge?.getMorningBriefing?.({ date: todayDate, scope }) ?? null
    const tickets = collectTicketBriefing(botId, todayDate, now)
    const alreadyDelivered = isDeliveredLocally(scope, todayDate) || (Boolean(memory?.alreadyDelivered) && !tickets.hasAttention)
    const hasContent = Boolean(memory?.hasContent || tickets.hasAttention)
    const markdown = formatUnifiedMarkdown({ date: todayDate, memory, tickets })
    return {
      date: todayDate,
      scope,
      hasContent,
      alreadyDelivered,
      memory,
      tickets,
      markdown,
    }
  }

  function markDelivered({ date, scope = 'default', sessionId } = {}) {
    const todayDate = date || rt.memoryBridge?.getCurrentLogicalDate?.() || localDateToday(rt.config?.timeZone)
    const now = Date.now()
    deliveredDates.set(scope, todayDate)
    try {
      rt.openTicketStore?.().setMeta(`briefing:${scope}`, {
        lastBriefedDate: todayDate,
        deliveredAt: now,
        ...(sessionId ? { sessionId } : {}),
      }, now)
    } catch (error) {
      rt.warn?.('ds-bot: persisting briefing meta failed: %s', error?.message ?? error)
    }
    rt.memoryBridge?.markBriefingDelivered?.({ date: todayDate, scope, sessionId })
    return { ok: true, date: todayDate, scope, deliveredAt: now }
  }

  async function confirmBriefing({
    approveIds = [],
    rejectIds = [],
    reason,
    settleNow = false,
    scope = 'default',
    date,
    sessionId,
  } = {}) {
    if (!rt.memoryBridge?.isAvailable?.()) {
      return { ok: false, reason: 'MEMORY_UNAVAILABLE' }
    }
    const result = await rt.memoryBridge.confirmBufferItems({
      approveIds,
      rejectIds,
      reason,
      settleNow,
      scope,
    })
    if (result?.ok !== false) {
      markDelivered({ date, scope, sessionId })
    }
    return result
  }

  function buildBriefingNotice(unified) {
    const pendingCount = unified.memory?.buffer?.totalPending ?? 0
    const needsTicketAction = unified.tickets.hasAttention
    const parts = [
      `## 每日综合晨报（${unified.date}）`,
      '这是今日首次正常交互汇总（已合并记忆系统与工单账本）。请在自然回应用户的同时简明带出要点，不要阻塞用户当前请求：',
      unified.markdown,
    ]
    if (pendingCount > 0 || needsTicketAction) {
      parts.push(
        '建议用单个低摩擦的 `show_view` 交互卡片（若不可用则用 `ask_user`）展示以上待确认记忆条目与待拍板/到期工单；'
        + '收到用户选择后，调用 `ctrl_briefing`（`action: "confirm"`, 传入 `approve_ids` / `reject_ids` 与可选 `settle_now: true`）或 `ticket_update` 完成过账。',
      )
    }
    return parts.join('\n\n')
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    let briefingMsg
    try {
      await rt.load()
      const sessionId = payload?.agent?.id
      const botId = sessionId === undefined ? undefined : rt.chatOwners.get(sessionId)
      if (
        botId !== undefined
        && rt.isMain(botId)
        && rt.botOf(botId)?.private !== true
        && rt.readOnly?.() === undefined
        && payload?.step === 1
        && hasRealUserMessage(payload?.messages)
      ) {
        const unified = getUnifiedBriefing({ botId, scope: 'default' })
        if (unified.hasContent && !unified.alreadyDelivered) {
          // Mark delivered BEFORE next() so peer dsh-memory sees alreadyDelivered === true
          // regardless of plugin registration order and skips its standalone briefing notice.
          markDelivered({ date: unified.date, scope: 'default', sessionId })
          briefingMsg = createUserMessage({
            content: [{ type: 'text', text: buildBriefingNotice(unified) }],
            source: { kind: BRIEFING_SOURCE_KIND, form: 'notice', date: unified.date },
          })
        }
      }
    } catch (error) {
      rt.warn?.('ds-bot: unified briefing pre-step failed: %s', error?.message ?? error)
    }

    const decision = await next()
    if (!briefingMsg || decision?.kind !== 'enter' || !Array.isArray(decision.messages)) {
      return decision
    }
    return {
      ...decision,
      messages: [briefingMsg, ...decision.messages],
    }
  })

  rt.teamTools.push(defineTool({
    name: 'ctrl_briefing',
    description: 'Read today\'s unified morning briefing (merging dsh-memory highlights/pending buffer items with due, waiting_user, and review Tickets), batch-confirm memory buffer items, or dismiss today\'s briefing.',
    parameters: {
      action: { type: 'string', required: true, enum: ACTION_ENUM, description: 'Operation: "get" reads current unified briefing; "confirm" approves/rejects pending memory buffer entries; "dismiss" marks today\'s briefing delivered.' },
      date: { type: 'string', description: 'Optional logical date (YYYY-MM-DD).' },
      approve_ids: { type: 'array', items: { type: 'string' }, description: 'Buffer entry IDs to approve (for action="confirm").' },
      reject_ids: { type: 'array', items: { type: 'string' }, description: 'Buffer entry IDs to reject (for action="confirm").' },
      reason: { type: 'string', description: 'Optional confirmation or rejection reason.' },
      settle_now: { type: 'boolean', description: 'Immediately settle approved buffer items into PROFILE.md / entities / lessons.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const caller = rt.botOf(self)
      if (caller === undefined || !rt.isMain(caller.id) || caller.private === true) {
        return 'Only a non-private Main Bot can use ctrl_briefing.'
      }
      if (args.action === 'get') {
        const unified = getUnifiedBriefing({ botId: caller.id, date: args.date })
        if (!unified.hasContent) {
          return `${unified.markdown}\n\nNo pending memory items or attention-requiring tickets for today.`
        }
        return unified.markdown
      }
      const readOnly = rt.readOnly?.()
      if (readOnly !== undefined) return `Cannot update briefing: ${readOnly}`
      if (args.action === 'dismiss') {
        const res = markDelivered({ date: args.date, sessionId: exec.agent?.id })
        return `Dismissed unified briefing for ${res.date}.`
      }
      if (args.action === 'confirm') {
        if (!rt.memoryBridge?.isAvailable?.()) {
          return 'Cannot confirm memory buffer items: dshMemory service is not available.'
        }
        const res = await confirmBriefing({
          approveIds: args.approve_ids,
          rejectIds: args.reject_ids,
          reason: args.reason,
          settleNow: args.settle_now === true,
          date: args.date,
          sessionId: exec.agent?.id,
        })
        if (res?.ok === false) {
          return `Could not confirm memory buffer items: ${res.reason ?? 'unknown error'}`
        }
        const approvedCount = Array.isArray(res?.approved) ? res.approved.length : 0
        const rejectedCount = Array.isArray(res?.rejected) ? res.rejected.length : 0
        const settledText = res?.settlement ? '; settled approved entries immediately' : ''
        return `Confirmed briefing buffer items: ${approvedCount} approved, ${rejectedCount} rejected${settledText}.`
      }
      return `Unknown action "${args.action}". Use one of: ${ACTION_ENUM.join(', ')}.`
    },
  }))

  rt.ctrlBriefing = {
    getUnifiedBriefing,
    markDelivered,
    confirmBriefing,
  }
}
