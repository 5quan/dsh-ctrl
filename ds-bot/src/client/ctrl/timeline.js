// Pure date-based timeline helpers: collapses same-day Part handoff seams into
// continuous daily history and removes internal `Part` terminology from the UI.
import { dateLocale } from '../i18n.js'
import { ct } from './copy.js'

export function logicalDayKey(ms) {
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const midnight = value => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
const daysBefore = (date, now) => Math.round((midnight(new Date(now)) - midnight(date)) / 86_400_000)

export function formatTimelineDate(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const days = daysBefore(date, now)
  if (days === 0) return ct('今天', 'Today')
  if (days === 1) return ct('昨天', 'Yesterday')
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(dateLocale(), {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

export function normalizeTimelineItems(items) {
  if (!Array.isArray(items) || items.length === 0) return []
  const out = []
  let lastDay = ''

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    if (!item) continue
    if (item.kind === 'divider') {
      const day = logicalDayKey(item.time)
      // Preserve an explicit leading divider at the very top of a feed,
      // and otherwise render a divider only when crossing into a new calendar day.
      if (out.length === 0) {
        out.push(item)
        if (day !== '') lastDay = day
      } else if (day !== '' && day !== lastDay) {
        out.push(item)
        lastDay = day
      }
      continue
    }
    const day = logicalDayKey(item.time)
    if (day !== '' && lastDay !== '' && day !== lastDay && out.at(-1)?.kind !== 'divider') {
      out.push({ kind: 'divider', time: item.time })
    }
    out.push(item)
    if (day !== '') lastDay = day
  }

  return out
}

export function shouldShowPartBoundary(items, startedAt) {
  if (!Number.isFinite(startedAt)) return false
  if (!Array.isArray(items) || items.length === 0) return true
  const startDay = logicalDayKey(startedAt)
  if (startDay === '') return false
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (!item || item.kind === 'divider') continue
    const day = logicalDayKey(item.time)
    if (day !== '') return day !== startDay
  }
  return true
}
