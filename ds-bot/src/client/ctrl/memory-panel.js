// Unified dshMemory panel replacing the legacy Bot-scoped memory dialog when
// peer plugin `dsh-memory` is mounted (P3-1 / R-4.1).
import { createElement as h, Fragment, useCallback, useEffect, useState } from 'react'
import { ChevronRightIcon, CloseIcon, MemoryIcon } from '../icons.js'
import { useEscape } from '../overlay-hooks.js'
import { hostText } from '../i18n.js'
import { ct } from './copy.js'

const TABS = [
  { id: 'buffer', zh: '待确认', en: 'Pending' },
  { id: 'profile', zh: '核心画像', en: 'Profile' },
  { id: 'entities', zh: '实体卡', en: 'Entities' },
  { id: 'lessons', zh: '避坑卡', en: 'Lessons' },
  { id: 'journals', zh: '每日日报', en: 'Journals' },
]

export function CtrlMemoryRow({ owner, roster, actions }) {
  const pendingCount = roster.ctrlInbox?.counts?.memory ?? 0
  return h('div', null,
    h('div', { className: 'bt-section-title' }, ct('记忆系统', 'Memory')),
    h('button', {
      type: 'button',
      className: 'bt-mem-row',
      'aria-label': ct('管理 dsh-memory 记忆', 'Manage dsh-memory'),
      onClick: () => actions.openMemory(owner.id),
    },
    h(MemoryIcon),
    h('span', { className: 'bt-mem-row-copy' }, ct('dsh-memory（画像 · 卡片 · 日报）', 'dsh-memory (Profile · Cards · Journals)')),
    pendingCount > 0 ? h('span', { className: 'bt-ctrl-row-badge' }, ct('{n} 待确认', '{n} pending', { n: pendingCount })) : null,
    h('span', { className: 'bt-mem-row-go' }, ct('管理', 'Manage'), h(ChevronRightIcon))))
}

function BufferPane({ overview, busy, setBusy, setNotice, setError, reload, actions }) {
  const pending = overview.buffer?.pending ?? []
  const approved = overview.buffer?.approved ?? []
  const [selected, setSelected] = useState(() => new Set(pending.map(item => item.id)))

  useEffect(() => {
    setSelected(new Set((overview.buffer?.pending ?? []).map(item => item.id)))
  }, [overview])

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => setSelected(new Set(pending.map(item => item.id)))
  const clearAll = () => setSelected(new Set())

  const submit = async (mode, singleId) => {
    const ids = singleId ? [singleId] : [...selected]
    if (ids.length === 0 || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const payload = mode === 'reject'
        ? { approveIds: [], rejectIds: ids, settleNow: false }
        : { approveIds: ids, rejectIds: [], settleNow: mode === 'settle' }
      await actions.ctrlMemoryConfirm(payload)
      setNotice(mode === 'reject'
        ? ct('已驳回 {n} 条记忆条目', 'Rejected {n} item(s)', { n: ids.length })
        : mode === 'settle'
          ? ct('已批准并立即落盘 {n} 条条目', 'Approved and settled {n} item(s)', { n: ids.length })
          : ct('已批准 {n} 条条目（待日结落盘）', 'Approved {n} item(s) for rollover', { n: ids.length }))
      await reload()
    } catch (failure) {
      setError(hostText(failure?.message ?? String(failure)))
    } finally {
      setBusy(false)
    }
  }

  return h('div', { className: 'bt-ctrl-pane' },
    pending.length === 0
      ? h('div', { className: 'bt-ctrl-empty' }, ct('当前没有待确认的记忆缓冲区条目。', 'No pending memory buffer items.'))
      : h(Fragment, null,
          h('div', { className: 'bt-ctrl-bar' },
            h('span', { className: 'bt-ctrl-note' }, ct('已选 {a} / {b} 条待确认记忆', 'Selected {a} of {b} pending items', { a: selected.size, b: pending.length })),
            h('div', { className: 'bt-ctrl-actions' },
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: selectAll }, ct('全选', 'Select all')),
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: clearAll }, ct('清空', 'Clear')),
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || selected.size === 0, onClick: () => void submit('approve') }, ct('批准（日结落盘）', 'Approve')),
              h('button', { type: 'button', className: 'bt-ctrl-btn-primary', disabled: busy || selected.size === 0, onClick: () => void submit('settle') }, ct('批准并立即落盘', 'Approve & settle')),
              h('button', { type: 'button', className: 'bt-ctrl-btn-danger', disabled: busy || selected.size === 0, onClick: () => void submit('reject') }, ct('驳回', 'Reject')))),
          h('div', { className: 'bt-ctrl-list' }, pending.map(item => h('div', { key: item.id, className: 'bt-ctrl-card' },
            h('label', { className: 'bt-ctrl-check-row' },
              h('input', { type: 'checkbox', checked: selected.has(item.id), disabled: busy, onChange: () => toggle(item.id) }),
              h('div', { className: 'bt-ctrl-pane' },
                h('div', { className: 'bt-ctrl-card-head' },
                  h('span', { className: 'bt-ctrl-tags' },
                    h('span', { className: 'bt-ctrl-tag', 'data-tone': 'accent' }, item.target || 'profile'),
                    h('span', { className: 'bt-ctrl-tag' }, item.source_type || 'extracted'),
                    item.logical_date ? h('span', { className: 'bt-ctrl-note' }, item.logical_date) : null),
                  h('div', { className: 'bt-ctrl-actions' },
                    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void submit('approve', item.id) }, ct('批准', 'Approve')),
                    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void submit('reject', item.id) }, ct('驳回', 'Reject')))),
                h('div', { className: 'bt-ctrl-card-title' }, item.content))))))),
    approved.length > 0
      ? h('div', { className: 'bt-ctrl-list' },
          h('div', { className: 'bt-ctrl-section-head' }, h('h3', null, ct('已批准待日结落盘 ({n})', 'Approved awaiting rollover ({n})', { n: approved.length }))),
          approved.map(item => h('div', { key: item.id, className: 'bt-ctrl-card' },
            h('div', { className: 'bt-ctrl-tags' },
              h('span', { className: 'bt-ctrl-tag' }, item.target || 'profile'),
              item.logical_date ? h('span', { className: 'bt-ctrl-note' }, item.logical_date) : null),
            h('div', { className: 'bt-ctrl-meta' }, item.content))))
      : null)
}

function ProfilePane({ overview, busy, setBusy, setNotice, setError, reload, actions }) {
  const original = overview.profile?.content ?? ''
  const [draft, setDraft] = useState(original)
  useEffect(() => { setDraft(overview.profile?.content ?? '') }, [overview.profile?.content])
  const dirty = draft !== original

  const save = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await actions.ctrlMemorySave('profile', '', draft)
      setNotice(ct('PROFILE.md 已保存', 'PROFILE.md saved'))
      await reload()
    } catch (failure) {
      setError(hostText(failure?.message ?? String(failure)))
    } finally {
      setBusy(false)
    }
  }

  return h('div', { className: 'bt-ctrl-pane' },
    h('div', { className: 'bt-ctrl-bar' },
      h('span', { className: 'bt-ctrl-note' }, ct('核心画像 Markdown · {n} 字符', 'Profile Markdown · {n} chars', { n: draft.length })),
      h('div', { className: 'bt-ctrl-actions' },
        dirty ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => setDraft(original) }, ct('还原', 'Revert')) : null,
        h('button', { type: 'button', className: 'bt-ctrl-btn-primary', disabled: busy || !dirty, onClick: () => void save() }, busy ? ct('保存中…', 'Saving…') : ct('保存画像', 'Save profile')))),
    h('textarea', {
      className: 'bt-ctrl-editor',
      value: draft,
      disabled: busy,
      'aria-label': ct('编辑核心画像', 'Edit profile markdown'),
      onChange: event => setDraft(event.target.value),
    }))
}

function MarkdownCardPane({ kind, items, busy, setBusy, setNotice, setError, reload, actions }) {
  const [selectedSlug, setSelectedSlug] = useState(() => items[0]?.slug ?? '')
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (items.length === 0) { setSelectedSlug(''); setContent(''); setOriginal(''); return }
    if (!items.some(item => item.slug === selectedSlug)) {
      setSelectedSlug(items[0].slug)
    }
  }, [items, selectedSlug])

  useEffect(() => {
    if (!selectedSlug) return undefined
    let stop = false
    setLoading(true)
    setError('')
    actions.ctrlMemoryRead(kind, selectedSlug).then(
      (res) => {
        if (stop) return
        const text = res?.content ?? ''
        setOriginal(text)
        setContent(text)
      },
      (failure) => {
        if (!stop) setError(hostText(failure?.message ?? String(failure)))
      },
    ).finally(() => {
      if (!stop) setLoading(false)
    })
    return () => { stop = true }
  }, [kind, selectedSlug])

  if (items.length === 0) {
    return h('div', { className: 'bt-ctrl-empty' }, kind === 'entity'
      ? ct('暂无实体卡。', 'No entity cards yet.')
      : ct('暂无避坑卡。', 'No lesson cards yet.'))
  }

  const dirty = content !== original
  const save = async () => {
    if (!selectedSlug || busy || loading) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await actions.ctrlMemorySave(kind, selectedSlug, content)
      setOriginal(content)
      setNotice(ct('已保存 {slug}.md', 'Saved {slug}.md', { slug: selectedSlug }))
      await reload()
    } catch (failure) {
      setError(hostText(failure?.message ?? String(failure)))
    } finally {
      setBusy(false)
    }
  }

  return h('div', { className: 'bt-ctrl-split' },
    h('div', { className: 'bt-ctrl-side-list', role: 'listbox' }, items.map((item) => {
      const sub = kind === 'entity'
        ? `${item.type} · ${ct('{n} 条事实', '{n} facts', { n: item.factCount ?? 0 })}`
        : `${(item.tags ?? []).slice(0, 3).join(', ') || 'lesson'} · ${ct('{n} 条经验', '{n} entries', { n: item.entryCount ?? 0 })}`
      return h('button', {
        key: item.slug,
        type: 'button',
        className: 'bt-ctrl-side-item',
        'aria-current': item.slug === selectedSlug ? 'true' : undefined,
        onClick: () => { setNotice(''); setSelectedSlug(item.slug) },
      },
      h('span', { className: 'bt-ctrl-side-title' }, item.name || item.slug),
      h('span', { className: 'bt-ctrl-side-sub' }, sub))
    })),
    h('div', { className: 'bt-ctrl-pane' },
      h('div', { className: 'bt-ctrl-bar' },
        h('span', { className: 'bt-ctrl-note' }, `${selectedSlug}.md${loading ? ` · ${ct('加载中…', 'Loading…')}` : ''}`),
        h('div', { className: 'bt-ctrl-actions' },
          dirty ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => setContent(original) }, ct('还原', 'Revert')) : null,
          h('button', { type: 'button', className: 'bt-ctrl-btn-primary', disabled: busy || loading || !dirty, onClick: () => void save() }, busy ? ct('保存中…', 'Saving…') : ct('保存卡片', 'Save card')))),
      h('textarea', {
        className: 'bt-ctrl-editor',
        value: content,
        disabled: busy || loading,
        onChange: event => setContent(event.target.value),
      })))
}

function JournalsPane({ overview, actions, setError }) {
  const dates = overview.journals?.dates ?? []
  const [selectedDate, setSelectedDate] = useState(() => dates[0] ?? '')
  const [content, setContent] = useState(() => overview.journals?.latestContent ?? '')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (dates.length === 0) { setSelectedDate(''); setContent(''); return }
    if (!dates.includes(selectedDate)) setSelectedDate(dates[0])
  }, [dates, selectedDate])

  useEffect(() => {
    if (!selectedDate) return undefined
    if (selectedDate === overview.journals?.latestDate && overview.journals?.latestContent !== undefined) {
      setContent(overview.journals.latestContent)
      return undefined
    }
    let stop = false
    setLoading(true)
    setError('')
    actions.ctrlMemoryRead('journal', selectedDate).then(
      (res) => { if (!stop) setContent(res?.content ?? '') },
      (failure) => { if (!stop) setError(hostText(failure?.message ?? String(failure))) },
    ).finally(() => { if (!stop) setLoading(false) })
    return () => { stop = true }
  }, [selectedDate, overview.journals?.latestDate])

  if (dates.length === 0) {
    return h('div', { className: 'bt-ctrl-empty' }, ct('暂无已归档的每日日报。', 'No daily journals yet.'))
  }

  return h('div', { className: 'bt-ctrl-split' },
    h('div', { className: 'bt-ctrl-side-list', role: 'listbox' }, dates.map(date => h('button', {
      key: date,
      type: 'button',
      className: 'bt-ctrl-side-item',
      'aria-current': date === selectedDate ? 'true' : undefined,
      onClick: () => setSelectedDate(date),
    }, h('span', { className: 'bt-ctrl-side-title' }, date)))),
    h('div', { className: 'bt-ctrl-pane' },
      h('div', { className: 'bt-ctrl-bar' },
        h('span', { className: 'bt-ctrl-note' }, ct('{date}.md · 不可变归档（只读）', '{date}.md · Immutable journal (read-only)', { date: selectedDate })),
        loading ? h('span', { className: 'bt-ctrl-note' }, ct('加载中…', 'Loading…')) : null),
      h('pre', { className: 'bt-ctrl-pre' }, content || ct('（空）', '(empty)'))))
}

export function CtrlMemoryDialog({ owner, initialTab = null, actions, leaving = false }) {
  const [overview, setOverview] = useState(null)
  const [tab, setTab] = useState(initialTab)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const close = useCallback(() => actions.closeMemory(), [actions])
  useEscape(close)

  const reload = useCallback(async () => {
    try {
      const next = await actions.ctrlMemoryOverview()
      setOverview(next)
      setError('')
      setTab((current) => {
        if (current) return current
        return (next?.buffer?.totalPending ?? 0) > 0 ? 'buffer' : 'profile'
      })
    } catch (failure) {
      setError(hostText(failure?.message ?? String(failure)))
    }
  }, [actions])

  useEffect(() => { void reload() }, [owner?.id])

  const counts = {
    buffer: overview?.buffer?.totalPending ?? 0,
    profile: 0,
    entities: overview?.entities?.length ?? 0,
    lessons: overview?.lessons?.length ?? 0,
    journals: overview?.journals?.dates?.length ?? 0,
  }
  const activeTab = tab ?? 'profile'

  return h('div', { className: 'bt-mem-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim bt-mem-scrim', onMouseDown: close }),
    h('div', { className: 'bt-mem bt-ctrl-mem-wide', role: 'dialog', 'aria-modal': true, 'aria-label': ct('记忆管理（dsh-memory）', 'Memory (dsh-memory)') },
      h('div', { className: 'bt-mem-head' },
        h('h2', null, ct('记忆管理', 'Memory')),
        h('span', { className: 'bt-mem-status' }, overview?.logicalDate ? `dsh-memory · ${overview.logicalDate}` : 'dsh-memory'),
        h('span', { className: 'bt-mem-head-gap' }),
        notice ? h('span', { className: 'bt-ctrl-ok', role: 'status' }, notice) : null,
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void reload() }, ct('刷新', 'Refresh')),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': ct('关闭记忆面板', 'Close memory'), onClick: close }, h(CloseIcon))),
      h('div', { className: 'bt-ctrl-tabs', role: 'tablist' }, TABS.map(item => h('button', {
        key: item.id,
        type: 'button',
        role: 'tab',
        className: 'bt-ctrl-tab',
        'aria-selected': activeTab === item.id,
        onClick: () => { setNotice(''); setError(''); setTab(item.id) },
      },
      ct(item.zh, item.en),
      counts[item.id] > 0 ? h('span', { className: 'bt-ctrl-tab-badge' }, String(counts[item.id])) : null))),
      h('div', { className: 'bt-ctrl-body' },
        error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null,
        overview === null
          ? h('div', { className: 'bt-ctrl-empty' }, ct('正在读取 dsh-memory…', 'Loading dsh-memory…'))
          : overview.available === false
            ? h('div', { className: 'bt-ctrl-empty' }, ct('dsh-memory 服务当前未就绪。', 'dsh-memory service is unavailable.'))
            : activeTab === 'buffer'
              ? h(BufferPane, { overview, busy, setBusy, setNotice, setError, reload, actions })
              : activeTab === 'profile'
                ? h(ProfilePane, { overview, busy, setBusy, setNotice, setError, reload, actions })
                : activeTab === 'entities'
                  ? h(MarkdownCardPane, { kind: 'entity', items: overview.entities ?? [], busy, setBusy, setNotice, setError, reload, actions })
                  : activeTab === 'lessons'
                    ? h(MarkdownCardPane, { kind: 'lesson', items: overview.lessons ?? [], busy, setBusy, setNotice, setError, reload, actions })
                    : h(JournalsPane, { overview, actions, setError }))))
}
