// Minimal "Needs Attention" sidebar pill (zero space when healthy/empty) and
// unified inbox dialog aggregating approvals, attention tickets, and buffer items.
import { createElement as h, Fragment, useCallback, useEffect, useState } from 'react'
import { CloseIcon } from '../icons.js'
import { useEscape } from '../overlay-hooks.js'
import { hostText } from '../i18n.js'
import { ct } from './copy.js'

export function InboxBadge({ roster, actions, wide }) {
  const inbox = roster.ctrlInbox
  const total = inbox?.total ?? 0
  if (total <= 0) return null
  const label = ct('待我处理 · {n}', 'Needs attention · {n}', { n: total })
  if (!wide) {
    return h('div', { className: 'bt-ctrl-inbox-wrap' },
      h('button', {
        type: 'button',
        className: 'bt-ctrl-inbox-pill',
        'data-rail': '',
        title: label,
        'aria-label': label,
        onClick: () => actions.openCtrlInbox(),
      }, h('span', { className: 'bt-ctrl-inbox-count' }, total > 99 ? '99+' : String(total))))
  }
  return h('div', { className: 'bt-ctrl-inbox-wrap' },
    h('button', {
      type: 'button',
      className: 'bt-ctrl-inbox-pill',
      'aria-label': label,
      onClick: () => actions.openCtrlInbox(),
    },
    h('span', { className: 'bt-ctrl-inbox-label' },
      h('span', { className: 'bt-ctrl-inbox-dot', 'aria-hidden': true }),
      ct('待我处理', 'Needs attention')),
    h('span', { className: 'bt-ctrl-inbox-count' }, String(total))))
}

function ticketReasonLabel(reason) {
  if (reason === 'waiting_user') return { tone: 'warn', text: ct('等你拍板', 'Waiting user') }
  if (reason === 'due') return { tone: 'danger', text: ct('到期/逾期', 'Due') }
  if (reason === 'review') return { tone: 'accent', text: ct('待验收', 'Review') }
  return { tone: '', text: reason }
}

export function CtrlInboxDialog({ roster, actions, leaving = false }) {
  const [data, setData] = useState(null)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const close = useCallback(() => actions.closeCtrlInbox(), [actions])
  useEscape(close)

  const reload = useCallback(async () => {
    try {
      const next = await actions.ctrlInbox()
      setData(next)
      setError('')
    } catch (failure) {
      setError(hostText(failure?.message ?? String(failure)))
    }
  }, [actions])

  useEffect(() => { void reload() }, [])

  const answerApproval = async (id, choice) => {
    setBusyId(id)
    setError('')
    try {
      await actions.answerApproval(id, choice)
      await reload()
    } catch (failure) {
      setError(hostText(failure?.message ?? String(failure)))
    } finally {
      setBusyId('')
    }
  }

  const handleMemory = async (id, approve) => {
    setBusyId(id)
    setError('')
    try {
      await actions.ctrlMemoryConfirm(approve ? { approveIds: [id], rejectIds: [], settleNow: false } : { approveIds: [], rejectIds: [id], settleNow: false })
      await reload()
    } catch (failure) {
      setError(hostText(failure?.message ?? String(failure)))
    } finally {
      setBusyId('')
    }
  }

  const openMemoryBuffer = () => {
    const targetId = roster.mainBotId || roster.bots?.[0]?.id
    actions.closeCtrlInbox()
    if (targetId) actions.openMemory(targetId, 'buffer')
  }

  const approvals = data?.approvals ?? []
  const tickets = data?.tickets ?? []
  const memoryPending = data?.memoryPending ?? []
  const total = data?.total ?? 0

  return h('div', { className: 'bt-mem-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim bt-mem-scrim', onMouseDown: close }),
    h('div', { className: 'bt-mem', role: 'dialog', 'aria-modal': true, 'aria-label': ct('待我处理', 'Needs attention') },
      h('div', { className: 'bt-mem-head' },
        h('h2', null, ct('待我处理', 'Needs attention')),
        data ? h('span', { className: 'bt-mem-status' }, total === 0 ? ct('已清空', 'All clear') : ct('{n} 项待处理', '{n} item(s)', { n: total })) : null,
        h('span', { className: 'bt-mem-head-gap' }),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void reload() }, ct('刷新', 'Refresh')),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': ct('关闭待办面板', 'Close inbox'), onClick: close }, h(CloseIcon))),
      h('div', { className: 'bt-ctrl-body' },
        error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null,
        data === null
          ? h('div', { className: 'bt-ctrl-empty' }, ct('正在汇总待办事项…', 'Loading pending items…'))
          : total === 0
            ? h('div', { className: 'bt-ctrl-empty' }, ct('当前没有待审批操作、到期工单或待确认记忆。', 'Everything is caught up.'))
            : h(Fragment, null,
                approvals.length > 0 ? h('section', { className: 'bt-ctrl-list' },
                  h('div', { className: 'bt-ctrl-section-head' }, h('h3', null, ct('待审批操作 ({n})', 'Pending approvals ({n})', { n: approvals.length }))),
                  approvals.map(entry => h('div', { key: entry.id, className: 'bt-ctrl-card' },
                    h('div', { className: 'bt-ctrl-card-head' },
                      h('div', { className: 'bt-ctrl-tags' },
                        h('span', { className: 'bt-ctrl-tag', 'data-tone': 'danger' }, entry.tool || 'tool'),
                        entry.worker ? h('span', { className: 'bt-ctrl-tag', 'data-tone': 'accent' }, `Worker · ${entry.ticketId}`) : null,
                        entry.botName ? h('span', { className: 'bt-ctrl-note' }, entry.botName) : null),
                      h('div', { className: 'bt-ctrl-actions' },
                        h('button', { type: 'button', className: 'bt-ctrl-btn-primary', disabled: busyId === entry.id, onClick: () => void answerApproval(entry.id, 'allow') }, ct('批准一次', 'Allow')),
                        h('button', { type: 'button', className: 'bt-ctrl-btn-danger', disabled: busyId === entry.id, onClick: () => void answerApproval(entry.id, 'reject') }, ct('拒绝', 'Reject')))),
                    entry.detail?.code || entry.detail?.text || entry.reason
                      ? h('div', { className: 'bt-ctrl-meta' }, entry.detail?.code || entry.detail?.text || entry.reason)
                      : null))) : null,
                tickets.length > 0 ? h('section', { className: 'bt-ctrl-list' },
                  h('div', { className: 'bt-ctrl-section-head' }, h('h3', null, ct('待处理 / 到期工单 ({n})', 'Attention tickets ({n})', { n: tickets.length }))),
                  tickets.map(ticket => h('div', { key: ticket.id, className: 'bt-ctrl-card' },
                    h('div', { className: 'bt-ctrl-card-head' },
                      h('div', { className: 'bt-ctrl-pane', style: { gap: '4px' } },
                        h('div', { className: 'bt-ctrl-tags' },
                          ticket.reasons.map((r) => {
                            const tag = ticketReasonLabel(r)
                            return h('span', { key: r, className: 'bt-ctrl-tag', 'data-tone': tag.tone || undefined }, tag.text)
                          }),
                          h('span', { className: 'bt-ctrl-note' }, `${ticket.id}${ticket.ownerBotName ? ` · ${ticket.ownerBotName}` : ''}`)),
                        h('div', { className: 'bt-ctrl-card-title' }, ticket.title)),
                      h('button', {
                        type: 'button',
                        className: 'bt-soft bt-soft-sm',
                        onClick: () => {
                          const target = ticket.ownerBotId || roster.mainBotId
                          close()
                          if (target) actions.openSession(target)
                        },
                      }, ct('前往对话', 'Open chat'))),
                    ticket.waitingOn || ticket.nextStep
                      ? h('div', { className: 'bt-ctrl-meta' }, [ticket.waitingOn ? `${ct('等待', 'Waiting')}: ${ticket.waitingOn}` : '', ticket.nextStep ? `${ct('下一步', 'Next')}: ${ticket.nextStep}` : ''].filter(Boolean).join(' · '))
                      : null))) : null,
                memoryPending.length > 0 ? h('section', { className: 'bt-ctrl-list' },
                  h('div', { className: 'bt-ctrl-section-head' },
                    h('h3', null, ct('待确认记忆 ({n})', 'Pending memory ({n})', { n: memoryPending.length })),
                    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: openMemoryBuffer }, ct('前往批量审核', 'Review all'))),
                  memoryPending.map(item => h('div', { key: item.id, className: 'bt-ctrl-card' },
                    h('div', { className: 'bt-ctrl-card-head' },
                      h('div', { className: 'bt-ctrl-tags' },
                        h('span', { className: 'bt-ctrl-tag', 'data-tone': 'accent' }, item.target || 'profile'),
                        item.logical_date ? h('span', { className: 'bt-ctrl-note' }, item.logical_date) : null),
                      h('div', { className: 'bt-ctrl-actions' },
                        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busyId === item.id, onClick: () => void handleMemory(item.id, true) }, ct('批准', 'Approve')),
                        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busyId === item.id, onClick: () => void handleMemory(item.id, false) }, ct('驳回', 'Reject')))),
                    h('div', { className: 'bt-ctrl-meta' }, item.content)))) : null))))
}
