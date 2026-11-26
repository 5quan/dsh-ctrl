import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatTimelineDate, logicalDayKey, normalizeTimelineItems, shouldShowPartBoundary } from '../../src/client/ctrl/timeline.js'

test('formatTimelineDate renders date labels without Part terminology', () => {
  const now = new Date(2026, 10, 26, 14, 0, 0).getTime()
  const todayMsg = new Date(2026, 10, 26, 9, 30, 0).getTime()
  const yesterdayMsg = new Date(2026, 10, 25, 22, 15, 0).getTime()
  const olderMsg = new Date(2026, 9, 3, 11, 0, 0).getTime()

  const tLabel = formatTimelineDate(todayMsg, now)
  const yLabel = formatTimelineDate(yesterdayMsg, now)
  const oLabel = formatTimelineDate(olderMsg, now)

  assert.equal(tLabel, 'Today')
  assert.equal(yLabel, 'Yesterday')
  assert.doesNotMatch(`${tLabel} ${yLabel} ${oLabel}`, /\bpart\b/i)
  assert.equal(formatTimelineDate(Number.NaN, now), '')
})

test('normalizeTimelineItems collapses same-day part seams and preserves cross-day separators', () => {
  const day1Morning = new Date(2026, 10, 24, 9, 0, 0).getTime()
  const day1Afternoon = new Date(2026, 10, 24, 15, 0, 0).getTime()
  const day2Morning = new Date(2026, 10, 25, 10, 0, 0).getTime()
  const day2Evening = new Date(2026, 10, 25, 20, 0, 0).getTime()

  const items = [
    { kind: 'divider', time: day1Morning },
    { kind: 'user', text: 'first', time: day1Morning },
    { kind: 'divider', time: day1Afternoon },
    { kind: 'bot', text: 'same-day handoff reply', time: day1Afternoon },
    { kind: 'user', text: 'crossed midnight', time: day2Morning },
    { kind: 'divider', time: day2Evening },
    { kind: 'bot', text: 'same-day evening', time: day2Evening },
  ]

  const normalized = normalizeTimelineItems(items)
  assert.deepEqual(
    normalized.map(item => [item.kind, logicalDayKey(item.time), item.text ?? '']),
    [
      ['divider', '2026-11-24', ''],
      ['user', '2026-11-24', 'first'],
      ['bot', '2026-11-24', 'same-day handoff reply'],
      ['divider', '2026-11-25', ''],
      ['user', '2026-11-25', 'crossed midnight'],
      ['bot', '2026-11-25', 'same-day evening'],
    ],
  )
})

test('shouldShowPartBoundary hides same-day boundary and shows cross-day boundary', () => {
  const day1 = new Date(2026, 10, 25, 18, 0, 0).getTime()
  const sameDay = new Date(2026, 10, 25, 21, 0, 0).getTime()
  const nextDay = new Date(2026, 10, 26, 8, 0, 0).getTime()

  const items = [{ kind: 'user', text: 'hi', time: day1 }]
  assert.equal(shouldShowPartBoundary(items, sameDay), false)
  assert.equal(shouldShowPartBoundary(items, nextDay), true)
  assert.equal(shouldShowPartBoundary([], nextDay), true)
  assert.equal(shouldShowPartBoundary(items, undefined), false)
})
