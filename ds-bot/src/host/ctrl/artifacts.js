// Large tool output offloading: saves oversized tool responses under
// <home>/artifacts/, leaves a concise summary + artifact://<id> handle in
// conversation context, and serves paginated/line/query inspection via artifact_read.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from '../tools.js'

export const ARTIFACT_PREFIX = 'artifact://'
export const DEFAULT_ARTIFACT_RETENTION_DAYS = 14
export const DEFAULT_ARTIFACT_GC_INTERVAL_MS = 6 * 60 * 60 * 1000
export const DEFAULT_ARTIFACT_GC_STARTUP_DELAY_MS = 30_000

const ARTIFACT_ID_RE = /^art-[a-z0-9-]+$/i
const ARTIFACT_FILENAME_RE = /^(art-[a-z0-9-]+)\.(txt|json)$/i
const DEFAULT_THRESHOLD_CHARS = 12_000
const DEFAULT_HEAD_CHARS = 1200
const DEFAULT_TAIL_CHARS = 600
const DEFAULT_PAGE_LIMIT = 4000
const MAX_PAGE_LIMIT = 12_000
const DEFAULT_LINES_PER_PAGE = 200
const SKIP_TOOLS = new Set(['artifact_read', 'show_view', 'ask_user', 'request_secret'])

export function parseArtifactHandle(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const rawId = trimmed.startsWith(ARTIFACT_PREFIX) ? trimmed.slice(ARTIFACT_PREFIX.length) : trimmed
  if (!ARTIFACT_ID_RE.test(rawId)) return undefined
  return rawId
}

function writeAtomic(targetPath, data) {
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`
  writeFileSync(tmpPath, data, 'utf8')
  renameSync(tmpPath, targetPath)
}

export function createArtifactStore({
  dir,
  thresholdChars = DEFAULT_THRESHOLD_CHARS,
  headChars = DEFAULT_HEAD_CHARS,
  tailChars = DEFAULT_TAIL_CHARS,
} = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new Error('Artifact store requires a valid directory path.')
  }
  const safeThreshold = Number.isInteger(thresholdChars) && thresholdChars >= 1 ? thresholdChars : DEFAULT_THRESHOLD_CHARS
  const safeHead = Number.isInteger(headChars) && headChars >= 0 ? headChars : DEFAULT_HEAD_CHARS
  const safeTail = Number.isInteger(tailChars) && tailChars >= 0 ? tailChars : DEFAULT_TAIL_CHARS

  const textPathOf = id => join(dir, `${id}.txt`)
  const metaPathOf = id => join(dir, `${id}.json`)

  function save(text, {
    toolName = 'tool',
    sessionId = '',
    botId = '',
    isPrivate = false,
    isError = false,
    now = Date.now(),
  } = {}) {
    const raw = String(text ?? '')
    mkdirSync(dir, { recursive: true })
    const id = `art-${randomUUID().replace(/-/g, '').slice(0, 10)}`
    const handle = `${ARTIFACT_PREFIX}${id}`
    const meta = {
      id,
      handle,
      toolName: String(toolName || 'tool'),
      sessionId: String(sessionId || ''),
      botId: String(botId || ''),
      private: Boolean(isPrivate),
      isError: Boolean(isError),
      chars: raw.length,
      bytes: Buffer.byteLength(raw, 'utf8'),
      lines: raw === '' ? 0 : raw.split(/\r?\n/).length,
      createdAt: now,
    }
    writeAtomic(textPathOf(id), raw)
    writeAtomic(metaPathOf(id), JSON.stringify(meta, null, 2))
    return meta
  }

  function getMeta(handleOrId) {
    const id = parseArtifactHandle(handleOrId)
    if (id === undefined) return undefined
    const path = metaPathOf(id)
    if (!existsSync(path)) return undefined
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return undefined
    }
  }

  function readRaw(handleOrId) {
    const id = parseArtifactHandle(handleOrId)
    if (id === undefined) return undefined
    const path = textPathOf(id)
    if (!existsSync(path)) return undefined
    return readFileSync(path, 'utf8')
  }

  function readPage(handleOrId, { offset = 0, limit = DEFAULT_PAGE_LIMIT, startLine, endLine, query } = {}) {
    const id = parseArtifactHandle(handleOrId)
    if (id === undefined) return undefined
    const raw = readRaw(id)
    if (raw === undefined) return undefined
    const meta = getMeta(id) ?? {
      id,
      handle: `${ARTIFACT_PREFIX}${id}`,
      chars: raw.length,
      bytes: Buffer.byteLength(raw, 'utf8'),
      lines: raw === '' ? 0 : raw.split(/\r?\n/).length,
    }
    const safeLimit = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, MAX_PAGE_LIMIT) : DEFAULT_PAGE_LIMIT

    if (typeof query === 'string' && query.trim() !== '') {
      const needle = query.trim().toLowerCase()
      const allLines = raw.split(/\r?\n/)
      const matches = []
      let used = 0
      let totalMatches = 0
      let truncated = false
      for (let i = 0; i < allLines.length; i += 1) {
        if (!allLines[i].toLowerCase().includes(needle)) continue
        totalMatches += 1
        const entry = `L${i + 1}: ${allLines[i]}`
        const cost = entry.length + (matches.length > 0 ? 1 : 0)
        if (matches.length > 0 && used + cost > safeLimit) {
          truncated = true
          continue
        }
        matches.push(used + cost > safeLimit ? entry.slice(0, safeLimit) : entry)
        used += cost
        if (entry.length > safeLimit) truncated = true
      }
      return {
        mode: 'query',
        meta,
        query: query.trim(),
        totalMatches,
        shownMatches: matches.length,
        truncated,
        text: matches.join('\n'),
      }
    }

    if (startLine !== undefined || endLine !== undefined) {
      const allLines = raw === '' ? [] : raw.split(/\r?\n/)
      const totalLines = allLines.length
      const start = Math.max(1, Number.isInteger(startLine) ? startLine : Number(startLine) || 1)
      const requestedEnd = endLine !== undefined
        ? Math.max(start, Number.isInteger(endLine) ? endLine : Number(endLine) || start)
        : start + DEFAULT_LINES_PER_PAGE - 1
      const cappedEnd = Math.min(totalLines, requestedEnd)
      const collected = []
      let used = 0
      let lastLine = start - 1
      for (let lineNo = start; lineNo <= cappedEnd; lineNo += 1) {
        const line = allLines[lineNo - 1]
        const cost = line.length + (collected.length > 0 ? 1 : 0)
        if (collected.length > 0 && used + cost > safeLimit) break
        if (collected.length === 0 && line.length > safeLimit) {
          collected.push(line.slice(0, safeLimit))
          lastLine = lineNo
          break
        }
        collected.push(line)
        used += cost
        lastLine = lineNo
      }
      const hasMore = lastLine < totalLines
      return {
        mode: 'lines',
        meta,
        startLine: totalLines === 0 ? 0 : start,
        endLine: totalLines === 0 ? 0 : lastLine,
        totalLines,
        hasMore,
        nextStartLine: hasMore ? lastLine + 1 : null,
        text: collected.join('\n'),
      }
    }

    const start = Math.max(0, Number.isInteger(offset) ? offset : Number(offset) || 0)
    const end = Math.min(raw.length, start + safeLimit)
    const hasMore = end < raw.length
    return {
      mode: 'chars',
      meta,
      offset: start,
      end,
      totalChars: raw.length,
      hasMore,
      nextOffset: hasMore ? end : null,
      text: raw.slice(start, end),
    }
  }

  function offloadContent({
    toolName = 'tool',
    sessionId = '',
    botId = '',
    isPrivate = false,
    isError = false,
    content = [],
  } = {}) {
    if (!Array.isArray(content) || content.length === 0) return { offloaded: false }
    const textBlocks = []
    const nonTextBlocks = []
    let totalChars = 0
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        textBlocks.push(block.text)
        totalChars += block.text.length
      } else if (block !== undefined && block !== null) {
        nonTextBlocks.push(block)
      }
    }
    if (textBlocks.length === 0 || totalChars <= safeThreshold) {
      return { offloaded: false }
    }

    const raw = textBlocks.join('\n')
    const meta = save(raw, { toolName, sessionId, botId, isPrivate, isError })
    const summaryParts = [
      `[Artifact offloaded] ${meta.handle} (${meta.toolName}, ${meta.chars} chars, ${meta.bytes} bytes, ${meta.lines} lines${meta.isError ? ', error output' : ''})`,
      `Full output stored on disk. Call artifact_read with handle "${meta.handle}" (supports offset/limit, start_line/end_line, or query) to inspect any part.`,
    ]
    if (safeHead > 0) {
      summaryParts.push('', '--- Head preview ---', raw.slice(0, safeHead))
    }
    if (safeTail > 0 && raw.length > safeHead) {
      const tailStart = Math.max(safeHead, raw.length - safeTail)
      summaryParts.push('', '--- Tail preview ---', raw.slice(tailStart))
    }
    return {
      offloaded: true,
      handle: meta.handle,
      meta,
      content: [...nonTextBlocks, { type: 'text', text: summaryParts.join('\n') }],
    }
  }

  function pruneExpired({
    retentionDays = DEFAULT_ARTIFACT_RETENTION_DAYS,
    now = Date.now(),
    referencedHandles = [],
  } = {}) {
    if (!existsSync(dir) || typeof retentionDays !== 'number' || !Number.isFinite(retentionDays) || retentionDays <= 0) {
      return { scanned: 0, deleted: 0, keptReferenced: 0, keptFresh: 0, errors: 0 }
    }

    const referencedIds = new Set()
    for (const rawEntry of referencedHandles) {
      if (typeof rawEntry !== 'string') continue
      const directId = parseArtifactHandle(rawEntry)
      if (directId !== undefined) referencedIds.add(directId.toLowerCase())
      const inlineRe = /artifact:\/\/(art-[a-z0-9-]+)/gi
      let match
      while ((match = inlineRe.exec(rawEntry)) !== null) {
        referencedIds.add(match[1].toLowerCase())
      }
    }

    const cutoff = now - retentionDays * 86_400_000
    const ids = new Set()
    for (const fileName of readdirSync(dir)) {
      const m = ARTIFACT_FILENAME_RE.exec(fileName)
      if (m) ids.add(m[1])
    }

    let scanned = 0
    let deleted = 0
    let keptReferenced = 0
    let keptFresh = 0
    let errors = 0

    for (const id of ids) {
      scanned += 1
      if (referencedIds.has(id.toLowerCase())) {
        keptReferenced += 1
        continue
      }

      const textPath = textPathOf(id)
      const metaPath = metaPathOf(id)
      const meta = getMeta(id)
      let createdAt = typeof meta?.createdAt === 'number' && Number.isFinite(meta.createdAt) ? meta.createdAt : null
      if (createdAt === null) {
        for (const p of [textPath, metaPath]) {
          try {
            const st = statSync(p)
            createdAt = createdAt === null ? st.mtimeMs : Math.max(createdAt, st.mtimeMs)
          } catch {}
        }
      }
      if (createdAt !== null && createdAt >= cutoff) {
        keptFresh += 1
        continue
      }

      let failed = false
      for (const p of [textPath, metaPath]) {
        try {
          unlinkSync(p)
        } catch (err) {
          if (err?.code !== 'ENOENT') {
            failed = true
            errors += 1
          }
        }
      }
      if (!failed) deleted += 1
    }

    return { scanned, deleted, keptReferenced, keptFresh, errors }
  }

  return {
    dir,
    thresholdChars: safeThreshold,
    save,
    getMeta,
    readRaw,
    readPage,
    offloadContent,
    pruneExpired,
  }
}

function formatReadPageResult(page) {
  const { meta } = page
  if (page.mode === 'query') {
    const header = `Artifact ${meta.handle} (${meta.toolName}) — query "${page.query}": ${page.shownMatches}/${page.totalMatches} matching line(s)${page.truncated ? ' (truncated to limit)' : ''}`
    return page.text === '' ? `${header}\n(no matches)` : `${header}\n\n${page.text}`
  }
  if (page.mode === 'lines') {
    const nextHint = page.hasMore ? `; next_start_line=${page.nextStartLine}` : '; end of file'
    const header = `Artifact ${meta.handle} (${meta.toolName}) — lines ${page.startLine}..${page.endLine} of ${page.totalLines}${nextHint}`
    return `${header}\n\n${page.text}`
  }
  const nextHint = page.hasMore ? `; next_offset=${page.nextOffset}` : '; end of artifact'
  const header = `Artifact ${meta.handle} (${meta.toolName}) — chars ${page.offset}..${page.end} of ${page.totalChars}${nextHint}`
  return `${header}\n\n${page.text}`
}

export function install(rt) {
  const { ctx, config, home } = rt
  const ctrlConfig = config?.ctrl ?? {}
  const store = createArtifactStore({
    dir: join(home, 'artifacts'),
    thresholdChars: ctrlConfig.artifactThresholdChars,
    headChars: ctrlConfig.artifactHeadChars,
    tailChars: ctrlConfig.artifactTailChars,
  })
  const retentionDays = typeof ctrlConfig.artifactRetentionDays === 'number' && Number.isFinite(ctrlConfig.artifactRetentionDays)
    ? ctrlConfig.artifactRetentionDays
    : DEFAULT_ARTIFACT_RETENTION_DAYS

  function pruneOrphans({ retentionDays: overrideDays = retentionDays, now = Date.now() } = {}) {
    const referencedHandles = rt.hasTicketStore?.() ? rt.openTicketStore().listReferencedArtifacts() : []
    return store.pruneExpired({
      retentionDays: overrideDays,
      now,
      referencedHandles,
    })
  }
  store.pruneOrphans = pruneOrphans

  ctx.on('tools/post-execute', async function offloadLargeToolOutput(exec, result, next) {
    const decision = await next()
    if (decision?.kind !== 'accept' || SKIP_TOOLS.has(exec?.name)) return decision
    const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
    if (!rt.isBotSession?.(sessionId) && rt.isWorkerSession?.(sessionId) !== true) return decision

    const effectiveContent = Array.isArray(decision.content)
      ? decision.content
      : Array.isArray(result?.content) ? result.content : null
    if (effectiveContent === null) return decision

    const botId = rt.selfOf?.(sessionId) ?? ''
    const isPrivate = botId !== '' && rt.botOf?.(botId)?.private === true
    const offloaded = store.offloadContent({
      toolName: exec?.name ?? 'tool',
      sessionId: sessionId ?? '',
      botId,
      isPrivate,
      isError: Boolean(result?.isError),
      content: effectiveContent,
    })
    if (!offloaded.offloaded) return decision

    // NEVER return a `value` key alongside `content` in tools/post-execute accept decisions.
    return {
      kind: 'accept',
      ...(decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {}),
      content: offloaded.content,
    }
  })

  ctx.effect(() => {
    if (!(retentionDays > 0)) return undefined
    const intervalMs = Number.isInteger(ctrlConfig.artifactGcIntervalMs) && ctrlConfig.artifactGcIntervalMs > 0
      ? ctrlConfig.artifactGcIntervalMs
      : DEFAULT_ARTIFACT_GC_INTERVAL_MS
    const startupDelayMs = Number.isInteger(ctrlConfig.artifactGcStartupDelayMs) && ctrlConfig.artifactGcStartupDelayMs >= 0
      ? ctrlConfig.artifactGcStartupDelayMs
      : DEFAULT_ARTIFACT_GC_STARTUP_DELAY_MS
    const runSweep = () => {
      try {
        pruneOrphans()
      } catch (error) {
        rt.warn?.('ds-bot: artifact gc failed: %s', error?.message ?? error)
      }
    }
    const startupTimer = setTimeout(runSweep, startupDelayMs)
    startupTimer.unref?.()
    const intervalTimer = setInterval(runSweep, intervalMs)
    intervalTimer.unref?.()
    return () => {
      clearTimeout(startupTimer)
      clearInterval(intervalTimer)
    }
  }, 'ds-bot: artifact gc')

  rt.teamTools.push(defineTool({
    name: 'artifact_read',
    description: 'Read or search an offloaded tool output by artifact://<id> handle, paginated by char offset/limit, line range, or keyword query.',
    parameters: {
      handle: { type: 'string', required: true, description: 'Artifact handle (e.g. artifact://art-1234567890) or id.' },
      offset: { type: 'integer', description: 'Zero-based char offset for char paging (default 0).' },
      limit: { type: 'integer', description: 'Maximum characters to return per page (1..12000, default 4000).' },
      start_line: { type: 'integer', description: '1-based start line for line-range reading.' },
      end_line: { type: 'integer', description: '1-based inclusive end line for line-range reading.' },
      query: { type: 'string', description: 'Case-insensitive substring to search across lines inside the artifact.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sessionId = exec.agent?.id ?? exec.agent?.session?.id
      const self = rt.selfOf?.(sessionId)
      const caller = self === undefined ? undefined : rt.botOf?.(self)
      const isWorker = rt.isWorkerSession?.(sessionId) === true
      if (caller === undefined && !isWorker) {
        return 'Only Bots or Workers on the team can use artifact_read.'
      }
      const meta = store.getMeta(args.handle)
      if (meta === undefined) {
        return `Artifact not found: ${args.handle}`
      }
      if (meta.private === true && meta.botId !== (caller?.id ?? '')) {
        return `Artifact not found: ${args.handle}`
      }
      const page = store.readPage(meta.id, {
        offset: args.offset,
        limit: args.limit,
        startLine: args.start_line,
        endLine: args.end_line,
        query: args.query,
      })
      if (page === undefined) {
        return `Artifact not found: ${args.handle}`
      }
      return formatReadPageResult(page)
    },
  }))

  rt.artifacts = store
}
