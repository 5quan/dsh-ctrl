// Ticket / Worker token usage attribution helpers and card for UsagePage (P3-1 / R-4.1).
import { createElement as h } from 'react'
import { dateLocale } from '../i18n.js'
import { compact, percent } from '../usage-data.js'
import { ct } from './copy.js'

const full = count => new Intl.NumberFormat(dateLocale()).format(Math.round(count))

export function ticketOwnerFace(owner) {
  const label = owner.name || owner.id || ct('工单', 'Ticket')
  const subParts = [ct('工单', 'Ticket')]
  if (owner.status) subParts.push(owner.status)
  else if (owner.deleted) subParts.push(ct('已归档', 'Archived'))
  return {
    kind: 'ticket',
    name: label,
    sub: subParts.join(' · '),
    paint: 'var(--bt-accent)',
    glyph: size => h('span', {
      className: 'bt-ctrl-ticket-glyph',
      'aria-hidden': true,
      style: { width: size, height: size, fontSize: Math.round(size * 0.38) },
    }, '#'),
  }
}

export function workerKindLabel(kind) {
  if (kind === 'worker') return ct('后台 Worker 执行', 'Background Worker')
  return null
}

export function TicketUsageCard({ ticketUsage, onPickTicket, index = 4 }) {
  const tickets = ticketUsage?.tickets ?? []
  if (tickets.length === 0) return null
  const totals = ticketUsage?.totals ?? {}
  const whole = Math.max(0, Number(totals.total ?? 0))

  return h('section', { className: 'bt-us-card', style: { '--i': index } },
    h('div', { className: 'bt-us-card-head' },
      h('h3', null, ct('按工单 / Worker 归因', 'By Ticket / Worker'), h('span', null, String(tickets.length))),
      h('span', { className: 'bt-us-head-note' }, ct('{a} 次派工 · {s} 步 · {t} tokens', '{a} assignments · {s} steps · {t} tokens', {
        a: totals.assignmentCount ?? 0,
        s: totals.steps ?? 0,
        t: compact(whole),
      }))),
    h('div', { className: 'bt-us-rows' }, tickets.map((ticket, rowIndex) => {
      const width = whole > 0 ? Math.max(ticket.total > 0 ? 2 : 0, (ticket.total / whole) * 100) : 0
      const sub = [
        ticket.status,
        ct('{n} 次派工', '{n} assignments', { n: ticket.assignmentCount ?? 0 }),
        ticket.steps > 0 ? ct('{n} 步', '{n} steps', { n: ticket.steps }) : '',
        ticket.ownerBotName || '',
      ].filter(Boolean).join(' · ')
      return h('button', {
        key: ticket.id,
        type: 'button',
        className: 'bt-us-row',
        style: { '--i': rowIndex },
        title: `${full(ticket.total)} tokens · ${ticket.calls ?? 0} calls`,
        onClick: () => onPickTicket(ticket.id),
      },
      h('span', { className: 'bt-us-row-glyph' }, h('span', {
        className: 'bt-ctrl-ticket-glyph',
        style: { width: 32, height: 32, fontSize: 13 },
      }, '#')),
      h('span', { className: 'bt-us-row-body' },
        h('span', { className: 'bt-us-row-line' },
          h('span', { className: 'bt-us-row-name' }, ticket.title || ticket.id),
          sub ? h('span', { className: 'bt-us-row-sub' }, sub) : null),
        h('span', { className: 'bt-us-track' }, h('span', { style: { width: `${width}%`, background: 'var(--bt-accent)' } }))),
      h('span', { className: 'bt-us-row-num' }, h('b', null, compact(ticket.total)), h('small', null, `${percent(ticket.total, whole)}%`)))
    })))
}
