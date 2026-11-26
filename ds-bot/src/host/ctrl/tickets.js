// Long-horizon tickets: deterministic SQLite state machine (Ticket + Mandate)
// persisted at <home>/tickets.sqlite, team tools for Chief and Workers, and a
// bounded active-ticket summary injected into conversation handoffs.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from '../tools.js'

const SCHEMA_VERSION = 3

export const TICKET_STATUSES = ['open', 'in_progress', 'waiting_user', 'blocked', 'review', 'done', 'failed', 'cancelled']
export const ACTIVE_TICKET_STATUSES = ['open', 'in_progress', 'waiting_user', 'blocked', 'review']
export const TERMINAL_TICKET_STATUSES = new Set(['done', 'failed', 'cancelled'])
export const ASSIGNMENT_STATUSES = ['pending', 'running', 'ended', 'interrupted']
export const ACTIVE_ASSIGNMENT_STATUSES = ['pending', 'running']
export const ASSIGNMENT_PRIORITIES = ['normal', 'human']
export const EFFECT_STATUSES = ['pending', 'running', 'done', 'dead']

export const TICKET_TRANSITIONS = Object.freeze({
  open: ['in_progress', 'waiting_user', 'blocked', 'review', 'done', 'failed', 'cancelled'],
  in_progress: ['open', 'waiting_user', 'blocked', 'review', 'done', 'failed', 'cancelled'],
  waiting_user: ['open', 'in_progress', 'blocked', 'review', 'done', 'failed', 'cancelled'],
  blocked: ['open', 'in_progress', 'waiting_user', 'review', 'done', 'failed', 'cancelled'],
  review: ['open', 'in_progress', 'waiting_user', 'blocked', 'done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
})

const TITLE_MAX = 120
const GOAL_MAX = 1000
const MANDATE_MAX = 1000
const ACCEPTANCE_MAX = 1000
const NEXT_STEP_MAX = 500
const BLOCKERS_MAX = 500
const WAITING_ON_MAX = 120
const WAKE_CONDITION_MAX = 300
const ARTIFACTS_MAX = 20
const ARTIFACT_ITEM_MAX = 300
const SESSION_ID_MAX = 160
const TRIGGER_KIND_MAX = 80
const TRIGGER_REF_MAX = 240
const ASSIGNMENT_PROMPT_MAX = 4000
const REPORT_SUMMARY_MAX = 2000
const RECOVERY_NOTE_MAX = 500
const ERROR_MSG_MAX = 500
const EFFECT_KEY_MAX = 200
const SUMMARY_MAX_TICKETS = 12
const SUMMARY_MAX_CHARS = 3200

export function isValidTransition(from, to) {
  if (!TICKET_STATUSES.includes(from) || !TICKET_STATUSES.includes(to)) return false
  if (TERMINAL_TICKET_STATUSES.has(from)) return false
  if (from === to) return true
  return TICKET_TRANSITIONS[from].includes(to)
}

function cleanText(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required.`)
    return ''
  }
  const text = String(value).trim()
  if (required && text === '') throw new Error(`${field} must not be empty.`)
  if (text.length > max) throw new Error(`${field} must be at most ${max} characters.`)
  return text
}

function cleanDeadline(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new Error('deadline must be a positive epoch ms timestamp or ISO-8601 date string.')
    return Math.trunc(value)
  }
  const text = String(value).trim()
  if (text === '') return null
  if (/^\d+$/.test(text)) {
    const parsed = Number(text)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('deadline timestamp is out of range.')
    return parsed
  }
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) throw new Error(`Invalid deadline "${text}". Use an ISO-8601 date string or epoch ms.`)
  return parsed
}

function cleanArtifacts(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('artifacts must be an array of strings.')
  if (value.length > ARTIFACTS_MAX) throw new Error(`artifacts can hold at most ${ARTIFACTS_MAX} items.`)
  const out = []
  for (const item of value) {
    const text = String(item ?? '').trim()
    if (text === '') continue
    if (text.length > ARTIFACT_ITEM_MAX) throw new Error(`Each artifact entry must be at most ${ARTIFACT_ITEM_MAX} characters.`)
    out.push(text)
  }
  return out
}

function parseArtifacts(raw) {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function rowToAssignment(row) {
  if (row === undefined) return undefined
  return {
    id: row.id,
    ticketId: row.ticket_id,
    workerSessionId: row.worker_session_id ?? '',
    status: row.status,
    priority: row.priority ?? 'normal',
    triggerKind: row.trigger_kind ?? 'manual',
    triggerRef: row.trigger_ref ?? '',
    prompt: row.prompt ?? '',
    mandateSnapshot: row.mandate_snapshot ?? '',
    ticketRevision: row.ticket_revision,
    reportStatus: row.report_status ?? '',
    reportSummary: row.report_summary ?? '',
    reportArtifacts: parseArtifacts(row.report_artifacts),
    recoveryNote: row.recovery_note ?? '',
    error: row.error ?? '',
    stepCount: row.step_count ?? 0,
    tokenUsage: row.token_usage ?? 0,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    updatedAt: row.updated_at,
  }
}

function rowToEffect(row) {
  if (row === undefined) return undefined
  return {
    id: row.id,
    kind: row.kind,
    ticketId: row.ticket_id ?? '',
    assignmentId: row.assignment_id ?? '',
    idempotencyKey: row.idempotency_key ?? null,
    payload: parseJsonObject(row.payload),
    status: row.status,
    attempts: row.attempts ?? 0,
    maxAttempts: row.max_attempts ?? 5,
    nextRunAt: row.next_run_at,
    lastError: row.last_error ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  }
}

function rowToTicket(row) {
  if (row === undefined) return undefined
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    mandate: row.mandate,
    acceptance: row.acceptance ?? '',
    status: row.status,
    ownerBotId: row.owner_bot_id,
    createdByBotId: row.created_by_bot_id,
    nextStep: row.next_step,
    blockers: row.blockers,
    waitingOn: row.waiting_on ?? '',
    wakeCondition: row.wake_condition ?? '',
    deadline: row.deadline ?? null,
    artifacts: parseArtifacts(row.artifacts),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createTicketStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version < SCHEMA_VERSION) {
      db.exec('BEGIN IMMEDIATE')
      try {
        if (version === 0) {
          db.exec(`
            CREATE TABLE IF NOT EXISTS tickets (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              goal TEXT NOT NULL,
              mandate TEXT NOT NULL DEFAULT '',
              acceptance TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL,
              owner_bot_id TEXT NOT NULL,
              created_by_bot_id TEXT NOT NULL,
              next_step TEXT NOT NULL DEFAULT '',
              blockers TEXT NOT NULL DEFAULT '',
              waiting_on TEXT NOT NULL DEFAULT '',
              wake_condition TEXT NOT NULL DEFAULT '',
              deadline INTEGER,
              artifacts TEXT NOT NULL DEFAULT '[]',
              revision INTEGER NOT NULL DEFAULT 1,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tickets_status_updated ON tickets(status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_tickets_owner_status ON tickets(owner_bot_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_tickets_deadline ON tickets(deadline);
          `)
        } else if (version === 1) {
          db.exec(`
            ALTER TABLE tickets ADD COLUMN acceptance TEXT NOT NULL DEFAULT '';
            ALTER TABLE tickets ADD COLUMN waiting_on TEXT NOT NULL DEFAULT '';
            ALTER TABLE tickets ADD COLUMN wake_condition TEXT NOT NULL DEFAULT '';
            ALTER TABLE tickets ADD COLUMN deadline INTEGER;
            CREATE INDEX IF NOT EXISTS idx_tickets_deadline ON tickets(deadline);
          `)
        }
        db.exec(`
          CREATE TABLE IF NOT EXISTS assignments (
            id TEXT PRIMARY KEY,
            ticket_id TEXT NOT NULL,
            worker_session_id TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            priority TEXT NOT NULL DEFAULT 'normal',
            trigger_kind TEXT NOT NULL DEFAULT 'manual',
            trigger_ref TEXT NOT NULL DEFAULT '',
            prompt TEXT NOT NULL DEFAULT '',
            mandate_snapshot TEXT NOT NULL DEFAULT '',
            ticket_revision INTEGER NOT NULL,
            report_status TEXT NOT NULL DEFAULT '',
            report_summary TEXT NOT NULL DEFAULT '',
            report_artifacts TEXT NOT NULL DEFAULT '[]',
            recovery_note TEXT NOT NULL DEFAULT '',
            error TEXT NOT NULL DEFAULT '',
            step_count INTEGER NOT NULL DEFAULT 0,
            token_usage INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            started_at INTEGER,
            ended_at INTEGER,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_assignments_ticket_created ON assignments(ticket_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_assignments_status_created ON assignments(status, created_at ASC);

          CREATE TABLE IF NOT EXISTS effects (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            ticket_id TEXT NOT NULL DEFAULT '',
            assignment_id TEXT NOT NULL DEFAULT '',
            idempotency_key TEXT UNIQUE,
            payload TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 5,
            next_run_at INTEGER NOT NULL,
            last_error TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_effects_status_next_run ON effects(status, next_run_at ASC);
          CREATE INDEX IF NOT EXISTS idx_effects_ticket ON effects(ticket_id, created_at DESC);

          PRAGMA user_version = ${SCHEMA_VERSION};
        `)
        db.exec('COMMIT')
      } catch (migError) {
        try { db.exec('ROLLBACK') } catch {}
        throw migError
      }
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS ctrl_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  } catch (error) {
    db.close()
    throw error
  }

  const stmtInsert = db.prepare(`
    INSERT INTO tickets (
      id, title, goal, mandate, acceptance, status, owner_bot_id, created_by_bot_id,
      next_step, blockers, waiting_on, wake_condition, deadline, artifacts, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `)
  const stmtGet = db.prepare('SELECT * FROM tickets WHERE id = ?')
  const stmtUpdate = db.prepare(`
    UPDATE tickets
    SET title = ?, goal = ?, mandate = ?, acceptance = ?, status = ?, owner_bot_id = ?,
        next_step = ?, blockers = ?, waiting_on = ?, wake_condition = ?, deadline = ?, artifacts = ?,
        revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ?
  `)
  const stmtGetMeta = db.prepare('SELECT value FROM ctrl_meta WHERE key = ?')
  const stmtSetMeta = db.prepare(`
    INSERT INTO ctrl_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `)

  function getMeta(key) {
    if (typeof key !== 'string' || key.trim() === '') return undefined
    const row = stmtGetMeta.get(key.trim())
    if (row === undefined) return undefined
    try {
      return JSON.parse(row.value)
    } catch {
      return undefined
    }
  }

  function setMeta(key, value, now = Date.now()) {
    const cleanKey = cleanText(key, 'meta key', 200, { required: true })
    stmtSetMeta.run(cleanKey, JSON.stringify(value), now)
    return value
  }

  function create({
    title,
    goal,
    mandate = '',
    acceptance = '',
    status = 'open',
    ownerBotId,
    createdByBotId,
    nextStep = '',
    blockers = '',
    waitingOn = '',
    wakeCondition = '',
    deadline = null,
    artifacts = [],
  }) {
    const cleanTitle = cleanText(title, 'title', TITLE_MAX, { required: true })
    const cleanGoal = cleanText(goal, 'goal', GOAL_MAX, { required: true })
    const cleanMandate = cleanText(mandate, 'mandate', MANDATE_MAX)
    const cleanAcceptance = cleanText(acceptance, 'acceptance', ACCEPTANCE_MAX)
    const cleanNext = cleanText(nextStep, 'next_step', NEXT_STEP_MAX)
    const cleanBlockers = cleanText(blockers, 'blockers', BLOCKERS_MAX)
    const cleanWaitingOn = cleanText(waitingOn, 'waiting_on', WAITING_ON_MAX)
    const cleanWakeCondition = cleanText(wakeCondition, 'wake_condition', WAKE_CONDITION_MAX)
    const cleanDue = cleanDeadline(deadline)
    const cleanOwner = cleanText(ownerBotId, 'owner', 120, { required: true })
    const cleanCreator = cleanText(createdByBotId, 'created_by', 120, { required: true })
    if (!ACTIVE_TICKET_STATUSES.includes(status)) {
      throw new Error(`Initial status must be one of: ${ACTIVE_TICKET_STATUSES.join(', ')}.`)
    }
    const cleanArts = cleanArtifacts(artifacts)
    const now = Date.now()
    const id = `tkt-${randomUUID().slice(0, 8)}`
    stmtInsert.run(
      id,
      cleanTitle,
      cleanGoal,
      cleanMandate,
      cleanAcceptance,
      status,
      cleanOwner,
      cleanCreator,
      cleanNext,
      cleanBlockers,
      cleanWaitingOn,
      cleanWakeCondition,
      cleanDue,
      JSON.stringify(cleanArts),
      now,
      now,
    )
    return rowToTicket(stmtGet.get(id))
  }

  function get(id) {
    if (typeof id !== 'string' || id.trim() === '') return undefined
    return rowToTicket(stmtGet.get(id.trim()))
  }

  function list({ status, ownerBotId, activeOnly = false, limit = 50 } = {}) {
    const where = []
    const args = []
    if (status !== undefined) {
      if (!TICKET_STATUSES.includes(status)) throw new Error(`Unknown status "${status}". Valid: ${TICKET_STATUSES.join(', ')}.`)
      where.push('status = ?')
      args.push(status)
    } else if (activeOnly) {
      where.push(`status IN (${ACTIVE_TICKET_STATUSES.map(() => '?').join(', ')})`)
      args.push(...ACTIVE_TICKET_STATUSES)
    }
    if (ownerBotId !== undefined) {
      where.push('owner_bot_id = ?')
      args.push(ownerBotId)
    }
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50
    const sql = `SELECT * FROM tickets${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, created_at DESC LIMIT ?`
    return db.prepare(sql).all(...args, safeLimit).map(rowToTicket)
  }

  function listDue(now = Date.now(), limit = 50) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50
    const placeholders = ACTIVE_TICKET_STATUSES.map(() => '?').join(', ')
    const sql = `SELECT * FROM tickets WHERE status IN (${placeholders}) AND deadline IS NOT NULL AND deadline <= ? ORDER BY deadline ASC LIMIT ?`
    return db.prepare(sql).all(...ACTIVE_TICKET_STATUSES, now, safeLimit).map(rowToTicket)
  }

  function update(id, patch = {}, { expectedRevision } = {}) {
    const existing = get(id)
    if (existing === undefined) throw new Error(`Ticket not found: ${id}`)
    if (TERMINAL_TICKET_STATUSES.has(existing.status)) {
      throw new Error(`Ticket ${existing.id} is already ${existing.status} and cannot be modified.`)
    }
    if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
      throw new Error(`Revision conflict: ticket ${existing.id} is at revision ${existing.revision}, expected ${expectedRevision}.`)
    }
    const nextStatus = patch.status === undefined ? existing.status : patch.status
    if (!TICKET_STATUSES.includes(nextStatus)) {
      throw new Error(`Unknown status "${nextStatus}". Valid: ${TICKET_STATUSES.join(', ')}.`)
    }
    if (!isValidTransition(existing.status, nextStatus)) {
      throw new Error(`Invalid status transition from "${existing.status}" to "${nextStatus}".`)
    }
    const nextTitle = patch.title === undefined ? existing.title : cleanText(patch.title, 'title', TITLE_MAX, { required: true })
    const nextGoal = patch.goal === undefined ? existing.goal : cleanText(patch.goal, 'goal', GOAL_MAX, { required: true })
    const nextMandate = patch.mandate === undefined ? existing.mandate : cleanText(patch.mandate, 'mandate', MANDATE_MAX)
    const nextAcceptance = patch.acceptance === undefined ? existing.acceptance : cleanText(patch.acceptance, 'acceptance', ACCEPTANCE_MAX)
    const nextOwner = patch.ownerBotId === undefined ? existing.ownerBotId : cleanText(patch.ownerBotId, 'owner', 120, { required: true })
    const nextStep = patch.nextStep === undefined ? existing.nextStep : cleanText(patch.nextStep, 'next_step', NEXT_STEP_MAX)
    const nextBlockers = patch.blockers === undefined ? existing.blockers : cleanText(patch.blockers, 'blockers', BLOCKERS_MAX)
    const nextWaitingOn = patch.waitingOn === undefined ? existing.waitingOn : cleanText(patch.waitingOn, 'waiting_on', WAITING_ON_MAX)
    const nextWakeCondition = patch.wakeCondition === undefined ? existing.wakeCondition : cleanText(patch.wakeCondition, 'wake_condition', WAKE_CONDITION_MAX)
    const nextDeadline = patch.deadline === undefined ? existing.deadline : cleanDeadline(patch.deadline)
    const nextArtifacts = patch.artifacts === undefined ? existing.artifacts : cleanArtifacts(patch.artifacts)

    const now = Date.now()
    const result = stmtUpdate.run(
      nextTitle,
      nextGoal,
      nextMandate,
      nextAcceptance,
      nextStatus,
      nextOwner,
      nextStep,
      nextBlockers,
      nextWaitingOn,
      nextWakeCondition,
      nextDeadline,
      JSON.stringify(nextArtifacts),
      now,
      existing.id,
      existing.revision,
    )
    if (result.changes === 0) {
      const current = get(existing.id)
      throw new Error(`Revision conflict: ticket ${existing.id} is at revision ${current?.revision ?? 'unknown'}, expected ${existing.revision}.`)
    }
    return get(existing.id)
  }

  let txDepth = 0
  function inTransaction(fn) {
    if (txDepth > 0) return fn()
    db.exec('BEGIN IMMEDIATE')
    txDepth += 1
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    } finally {
      txDepth -= 1
    }
  }

  const stmtInsertAssignment = db.prepare(`
    INSERT INTO assignments (
      id, ticket_id, worker_session_id, status, priority, trigger_kind, trigger_ref,
      prompt, mandate_snapshot, ticket_revision, created_at, updated_at
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const stmtGetAssignment = db.prepare('SELECT * FROM assignments WHERE id = ?')
  const stmtStartAssignment = db.prepare(`
    UPDATE assignments
    SET status = 'running',
        worker_session_id = CASE WHEN ? <> '' THEN ? ELSE worker_session_id END,
        started_at = COALESCE(started_at, ?),
        updated_at = ?
    WHERE id = ? AND status = 'pending'
  `)
  const stmtCompleteAssignment = db.prepare(`
    UPDATE assignments
    SET status = 'ended',
        report_status = ?,
        report_summary = ?,
        report_artifacts = ?,
        error = ?,
        step_count = COALESCE(?, step_count),
        token_usage = COALESCE(?, token_usage),
        ended_at = ?,
        updated_at = ?
    WHERE id = ? AND status IN ('pending', 'running')
  `)
  const stmtInterruptAssignment = db.prepare(`
    UPDATE assignments
    SET status = 'interrupted',
        recovery_note = ?,
        error = ?,
        ended_at = ?,
        updated_at = ?
    WHERE id = ? AND status = 'running'
  `)
  const stmtUpdateAssignmentUsage = db.prepare(`
    UPDATE assignments
    SET step_count = COALESCE(?, step_count),
        token_usage = COALESCE(?, token_usage),
        updated_at = ?
    WHERE id = ?
  `)

  const stmtInsertEffect = db.prepare(`
    INSERT INTO effects (
      id, kind, ticket_id, assignment_id, idempotency_key, payload,
      status, attempts, max_attempts, next_run_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
  `)
  const stmtGetEffect = db.prepare('SELECT * FROM effects WHERE id = ?')
  const stmtGetEffectByKey = db.prepare('SELECT * FROM effects WHERE idempotency_key = ?')
  const stmtClaimEffect = db.prepare(`
    UPDATE effects
    SET status = 'running', updated_at = ?
    WHERE id = ? AND status = 'pending'
  `)
  const stmtCompleteEffect = db.prepare(`
    UPDATE effects
    SET status = 'done', completed_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('pending', 'running')
  `)
  const stmtFailEffect = db.prepare(`
    UPDATE effects
    SET status = ?, attempts = ?, next_run_at = ?, last_error = ?, completed_at = ?, updated_at = ?
    WHERE id = ?
  `)
  const stmtRequeueRunningEffects = db.prepare(`
    UPDATE effects
    SET status = 'pending', next_run_at = ?, updated_at = ?
    WHERE status = 'running'
  `)

  function createAssignment({
    ticketId,
    priority = 'normal',
    triggerKind = 'manual',
    triggerRef = '',
    prompt = '',
    workerSessionId = '',
    now = Date.now(),
  }) {
    const cleanTicketId = cleanText(ticketId, 'ticket_id', 120, { required: true })
    const ticket = get(cleanTicketId)
    if (ticket === undefined) throw new Error(`Ticket not found: ${cleanTicketId}`)
    if (TERMINAL_TICKET_STATUSES.has(ticket.status)) {
      throw new Error(`Cannot create assignment for ${ticket.status} ticket ${ticket.id}.`)
    }
    if (!ASSIGNMENT_PRIORITIES.includes(priority)) {
      throw new Error(`Invalid assignment priority "${priority}". Valid: ${ASSIGNMENT_PRIORITIES.join(', ')}.`)
    }
    const cleanSession = cleanText(workerSessionId, 'worker_session_id', SESSION_ID_MAX)
    const cleanTriggerKind = cleanText(triggerKind, 'trigger_kind', TRIGGER_KIND_MAX) || 'manual'
    const cleanTriggerRef = cleanText(triggerRef, 'trigger_ref', TRIGGER_REF_MAX)
    const cleanPrompt = cleanText(prompt, 'prompt', ASSIGNMENT_PROMPT_MAX)
    const id = `asg-${randomUUID().slice(0, 8)}`
    stmtInsertAssignment.run(
      id,
      ticket.id,
      cleanSession,
      priority,
      cleanTriggerKind,
      cleanTriggerRef,
      cleanPrompt,
      ticket.mandate,
      ticket.revision,
      now,
      now,
    )
    return rowToAssignment(stmtGetAssignment.get(id))
  }

  function getAssignment(id) {
    if (typeof id !== 'string' || id.trim() === '') return undefined
    return rowToAssignment(stmtGetAssignment.get(id.trim()))
  }

  function listAssignments({ ticketId, status, activeOnly = false, limit = 50 } = {}) {
    const where = []
    const args = []
    if (ticketId !== undefined) {
      where.push('ticket_id = ?')
      args.push(String(ticketId).trim())
    }
    if (status !== undefined) {
      if (!ASSIGNMENT_STATUSES.includes(status)) {
        throw new Error(`Unknown assignment status "${status}". Valid: ${ASSIGNMENT_STATUSES.join(', ')}.`)
      }
      where.push('status = ?')
      args.push(status)
    } else if (activeOnly) {
      where.push(`status IN (${ACTIVE_ASSIGNMENT_STATUSES.map(() => '?').join(', ')})`)
      args.push(...ACTIVE_ASSIGNMENT_STATUSES)
    }
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50
    const sql = `SELECT * FROM assignments${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`
    return db.prepare(sql).all(...args, safeLimit).map(rowToAssignment)
  }

  function startAssignment(id, { workerSessionId = '', now = Date.now() } = {}) {
    const cleanId = cleanText(id, 'assignment_id', 120, { required: true })
    const cleanSession = cleanText(workerSessionId, 'worker_session_id', SESSION_ID_MAX)
    const res = stmtStartAssignment.run(cleanSession, cleanSession, now, now, cleanId)
    if (res.changes === 0) {
      const existing = getAssignment(cleanId)
      if (existing === undefined) throw new Error(`Assignment not found: ${cleanId}`)
      throw new Error(`Assignment ${existing.id} cannot start from status "${existing.status}".`)
    }
    return getAssignment(cleanId)
  }

  function completeAssignment(id, {
    reportStatus = 'done',
    reportSummary = '',
    reportArtifacts = [],
    stepCount,
    tokenUsage,
    error = '',
    now = Date.now(),
  } = {}) {
    const cleanId = cleanText(id, 'assignment_id', 120, { required: true })
    const cleanReportStatus = cleanText(reportStatus, 'report_status', 60) || 'done'
    const cleanSummary = cleanText(reportSummary, 'report_summary', REPORT_SUMMARY_MAX)
    const cleanArts = cleanArtifacts(reportArtifacts)
    const cleanError = cleanText(error, 'error', ERROR_MSG_MAX)
    const nextSteps = Number.isInteger(stepCount) && stepCount >= 0 ? stepCount : null
    const nextTokens = Number.isInteger(tokenUsage) && tokenUsage >= 0 ? tokenUsage : null
    const res = stmtCompleteAssignment.run(
      cleanReportStatus,
      cleanSummary,
      JSON.stringify(cleanArts),
      cleanError,
      nextSteps,
      nextTokens,
      now,
      now,
      cleanId,
    )
    if (res.changes === 0) {
      const existing = getAssignment(cleanId)
      if (existing === undefined) throw new Error(`Assignment not found: ${cleanId}`)
      throw new Error(`Assignment ${existing.id} cannot end from status "${existing.status}".`)
    }
    return getAssignment(cleanId)
  }

  function interruptAssignment(id, {
    recoveryNote = '',
    error = '',
    now = Date.now(),
  } = {}) {
    const cleanId = cleanText(id, 'assignment_id', 120, { required: true })
    const cleanNote = cleanText(recoveryNote, 'recovery_note', RECOVERY_NOTE_MAX)
    const cleanError = cleanText(error, 'error', ERROR_MSG_MAX)
    const res = stmtInterruptAssignment.run(cleanNote, cleanError, now, now, cleanId)
    if (res.changes === 0) {
      const existing = getAssignment(cleanId)
      if (existing === undefined) throw new Error(`Assignment not found: ${cleanId}`)
      throw new Error(`Assignment ${existing.id} cannot be interrupted from status "${existing.status}".`)
    }
    return getAssignment(cleanId)
  }

  function updateAssignmentUsage(id, { stepCount, tokenUsage, now = Date.now() } = {}) {
    const cleanId = cleanText(id, 'assignment_id', 120, { required: true })
    const existing = getAssignment(cleanId)
    if (existing === undefined) throw new Error(`Assignment not found: ${cleanId}`)
    const nextSteps = Number.isInteger(stepCount) && stepCount >= 0 ? stepCount : null
    const nextTokens = Number.isInteger(tokenUsage) && tokenUsage >= 0 ? tokenUsage : null
    stmtUpdateAssignmentUsage.run(nextSteps, nextTokens, now, cleanId)
    return getAssignment(cleanId)
  }

  function getEffect(id) {
    if (typeof id !== 'string' || id.trim() === '') return undefined
    return rowToEffect(stmtGetEffect.get(id.trim()))
  }

  function getEffectByKey(idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') return undefined
    return rowToEffect(stmtGetEffectByKey.get(idempotencyKey.trim()))
  }

  function enqueueEffect({
    kind,
    ticketId = '',
    assignmentId = '',
    idempotencyKey = null,
    payload = {},
    maxAttempts = 5,
    runAt = Date.now(),
    now = Date.now(),
  } = {}) {
    const cleanKind = cleanText(kind, 'effect kind', 80, { required: true })
    const cleanTicketId = cleanText(ticketId, 'ticket_id', 120)
    const cleanAssignmentId = cleanText(assignmentId, 'assignment_id', 120)
    const cleanKey = idempotencyKey === null || idempotencyKey === undefined || String(idempotencyKey).trim() === ''
      ? null
      : cleanText(idempotencyKey, 'idempotency_key', EFFECT_KEY_MAX, { required: true })
    const safeMaxAttempts = Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 100 ? maxAttempts : 5
    const safeRunAt = Number.isFinite(runAt) ? Math.trunc(runAt) : now
    const payloadJson = JSON.stringify(payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {})

    return inTransaction(() => {
      if (cleanKey !== null) {
        const existing = getEffectByKey(cleanKey)
        if (existing !== undefined) return { effect: existing, deduplicated: true }
      }
      const id = `eff-${randomUUID().slice(0, 8)}`
      stmtInsertEffect.run(
        id,
        cleanKind,
        cleanTicketId,
        cleanAssignmentId,
        cleanKey,
        payloadJson,
        safeMaxAttempts,
        safeRunAt,
        now,
        now,
      )
      return { effect: rowToEffect(stmtGetEffect.get(id)), deduplicated: false }
    })
  }

  function listEffects({ status, ticketId, assignmentId, limit = 50 } = {}) {
    const where = []
    const args = []
    if (status !== undefined) {
      if (!EFFECT_STATUSES.includes(status)) {
        throw new Error(`Unknown effect status "${status}". Valid: ${EFFECT_STATUSES.join(', ')}.`)
      }
      where.push('status = ?')
      args.push(status)
    }
    if (ticketId !== undefined) {
      where.push('ticket_id = ?')
      args.push(String(ticketId).trim())
    }
    if (assignmentId !== undefined) {
      where.push('assignment_id = ?')
      args.push(String(assignmentId).trim())
    }
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50
    const sql = `SELECT * FROM effects${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY next_run_at ASC, created_at ASC LIMIT ?`
    return db.prepare(sql).all(...args, safeLimit).map(rowToEffect)
  }

  function claimDueEffects({ now = Date.now(), limit = 20, kinds } = {}) {
    if (Array.isArray(kinds) && kinds.length === 0) return []
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20
    const where = ["status = 'pending'", 'next_run_at <= ?']
    const args = [now]
    if (Array.isArray(kinds)) {
      where.push(`kind IN (${kinds.map(() => '?').join(', ')})`)
      args.push(...kinds.map(k => String(k)))
    }
    return inTransaction(() => {
      const rows = db.prepare(
        `SELECT id FROM effects WHERE ${where.join(' AND ')} ORDER BY next_run_at ASC, created_at ASC LIMIT ?`,
      ).all(...args, safeLimit)
      const claimed = []
      for (const row of rows) {
        const res = stmtClaimEffect.run(now, row.id)
        if (res.changes > 0) claimed.push(getEffect(row.id))
      }
      return claimed
    })
  }

  function completeEffect(id, { now = Date.now() } = {}) {
    const cleanId = cleanText(id, 'effect_id', 120, { required: true })
    const res = stmtCompleteEffect.run(now, now, cleanId)
    if (res.changes === 0) {
      const existing = getEffect(cleanId)
      if (existing === undefined) throw new Error(`Effect not found: ${cleanId}`)
      throw new Error(`Effect ${existing.id} cannot complete from status "${existing.status}".`)
    }
    return getEffect(cleanId)
  }

  function failEffect(id, error, { now = Date.now(), baseDelayMs = 1000, maxDelayMs = 60_000 } = {}) {
    const cleanId = cleanText(id, 'effect_id', 120, { required: true })
    const msg = oneLine(error?.message ?? String(error ?? 'Unknown error'), ERROR_MSG_MAX)
    return inTransaction(() => {
      const existing = getEffect(cleanId)
      if (existing === undefined) throw new Error(`Effect not found: ${cleanId}`)
      if (existing.status === 'done' || existing.status === 'dead') {
        throw new Error(`Effect ${existing.id} is already ${existing.status}.`)
      }
      const nextAttempts = existing.attempts + 1
      const isDead = nextAttempts >= existing.maxAttempts
      const nextStatus = isDead ? 'dead' : 'pending'
      const delay = Math.min(maxDelayMs, Math.max(0, baseDelayMs) * (2 ** Math.max(0, nextAttempts - 1)))
      const nextRunAt = isDead ? existing.nextRunAt : now + delay
      const completedAt = isDead ? now : null
      stmtFailEffect.run(nextStatus, nextAttempts, nextRunAt, msg, completedAt, now, cleanId)
      return getEffect(cleanId)
    })
  }

  function dispatchWithEffect({
    ticketId,
    priority = 'normal',
    triggerKind = 'manual',
    triggerRef = '',
    prompt = '',
    effectKind = 'dispatch_assignment',
    idempotencyKey = null,
    maxAttempts = 5,
    extraPayload = {},
    now = Date.now(),
  } = {}) {
    const cleanKey = idempotencyKey === null || idempotencyKey === undefined || String(idempotencyKey).trim() === ''
      ? null
      : cleanText(idempotencyKey, 'idempotency_key', EFFECT_KEY_MAX, { required: true })
    const extra = extraPayload !== null && typeof extraPayload === 'object' && !Array.isArray(extraPayload)
      ? extraPayload
      : {}

    return inTransaction(() => {
      if (cleanKey !== null) {
        const existingEffect = getEffectByKey(cleanKey)
        if (existingEffect !== undefined) {
          return {
            deduplicated: true,
            assignment: existingEffect.assignmentId ? getAssignment(existingEffect.assignmentId) : undefined,
            effect: existingEffect,
          }
        }
      }
      const assignment = createAssignment({
        ticketId,
        priority,
        triggerKind,
        triggerRef,
        prompt,
        now,
      })
      const { effect } = enqueueEffect({
        kind: effectKind,
        ticketId: assignment.ticketId,
        assignmentId: assignment.id,
        idempotencyKey: cleanKey,
        payload: {
          ...extra,
          assignmentId: assignment.id,
          ticketId: assignment.ticketId,
          priority: assignment.priority,
          ticketRevision: assignment.ticketRevision,
          triggerKind: assignment.triggerKind,
          triggerRef: assignment.triggerRef,
        },
        maxAttempts,
        runAt: now,
        now,
      })
      return { deduplicated: false, assignment, effect }
    })
  }

  function recoverInterrupted({
    now = Date.now(),
    note = 'Interrupted by host restart before completion.',
  } = {}) {
    const cleanNote = cleanText(note, 'recovery_note', RECOVERY_NOTE_MAX) || 'Interrupted by host restart before completion.'
    return inTransaction(() => {
      const staleEffects = db.prepare("SELECT id FROM effects WHERE status = 'running' ORDER BY created_at ASC").all()
      if (staleEffects.length > 0) {
        stmtRequeueRunningEffects.run(now, now)
      }
      const requeuedEffects = staleEffects.map(row => getEffect(row.id)).filter(Boolean)

      const staleAssignments = db.prepare("SELECT * FROM assignments WHERE status = 'running' ORDER BY created_at ASC").all()
      const interruptedAssignments = []
      const recoveryEffects = []
      for (const row of staleAssignments) {
        const interrupted = interruptAssignment(row.id, { recoveryNote: cleanNote, now })
        interruptedAssignments.push(interrupted)
        const { effect } = enqueueEffect({
          kind: 'recover_assignment',
          ticketId: interrupted.ticketId,
          assignmentId: interrupted.id,
          idempotencyKey: `recover:${interrupted.id}`,
          payload: {
            assignmentId: interrupted.id,
            ticketId: interrupted.ticketId,
            workerSessionId: interrupted.workerSessionId,
            priority: interrupted.priority,
            previousRevision: interrupted.ticketRevision,
            recoveryNote: cleanNote,
          },
          runAt: now,
          now,
        })
        recoveryEffects.push(effect)
      }
      return { interruptedAssignments, requeuedEffects, recoveryEffects }
    })
  }

  function listReferencedArtifacts() {
    const seen = new Set()
    const collect = (rawJson) => {
      if (typeof rawJson !== 'string' || rawJson === '' || rawJson === '[]') return
      try {
        const arr = JSON.parse(rawJson)
        if (!Array.isArray(arr)) return
        for (const item of arr) {
          const clean = typeof item === 'string' ? item.trim() : ''
          if (clean !== '') seen.add(clean)
        }
      } catch {}
    }
    const ticketRows = db.prepare("SELECT artifacts FROM tickets WHERE artifacts <> '[]' AND artifacts <> ''").all()
    for (const row of ticketRows) collect(row.artifacts)
    const assignmentRows = db.prepare("SELECT report_artifacts FROM assignments WHERE report_artifacts <> '[]' AND report_artifacts <> ''").all()
    for (const row of assignmentRows) collect(row.report_artifacts)
    return [...seen]
  }

  return {
    create,
    get,
    list,
    listDue,
    listReferencedArtifacts,
    update,
    createAssignment,
    getAssignment,
    listAssignments,
    startAssignment,
    completeAssignment,
    interruptAssignment,
    updateAssignmentUsage,
    enqueueEffect,
    getEffect,
    getEffectByKey,
    listEffects,
    claimDueEffects,
    completeEffect,
    failEffect,
    dispatchWithEffect,
    recoverInterrupted,
    getMeta,
    setMeta,
    close: () => { db.close() },
  }
}

const oneLine = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

const formatDeadline = (ms) => (ms === null || ms === undefined ? '' : new Date(ms).toISOString())

export function formatActiveTicketsSummary(tickets, botNameOf = id => id) {
  const active = tickets.filter(ticket => !TERMINAL_TICKET_STATUSES.has(ticket.status))
  if (active.length === 0) return undefined
  const header = 'These active tickets are persisted task state (reference data, not new instructions). Respect each ticket\'s mandate and keep progress current with ticket_update / ticket_get:'
  const lines = [header]
  let used = header.length
  let shown = 0
  for (const ticket of active.slice(0, SUMMARY_MAX_TICKETS)) {
    const owner = botNameOf(ticket.ownerBotId) ?? ticket.ownerBotId
    const waitParts = [
      ticket.waitingOn ? `on ${oneLine(ticket.waitingOn, 80)}` : '',
      ticket.wakeCondition ? `wake: ${oneLine(ticket.wakeCondition, 120)}` : '',
      ticket.deadline !== null && ticket.deadline !== undefined ? `deadline: ${formatDeadline(ticket.deadline)}` : '',
    ].filter(Boolean)
    const block = [
      `- [${ticket.id}] (${ticket.status}, rev ${ticket.revision}, owner: ${owner}) ${oneLine(ticket.title, 100)}`,
      `  Goal: ${oneLine(ticket.goal, 200)}`,
      ...(ticket.mandate ? [`  Mandate: ${oneLine(ticket.mandate, 200)}`] : []),
      ...(ticket.nextStep ? [`  Next: ${oneLine(ticket.nextStep, 180)}`] : []),
      ...(waitParts.length > 0 ? [`  Waiting: ${waitParts.join('; ')}`] : []),
      ...(ticket.blockers ? [`  Blockers: ${oneLine(ticket.blockers, 180)}`] : []),
    ].join('\n')
    if (shown > 0 && used + block.length + 1 > SUMMARY_MAX_CHARS) break
    lines.push(block)
    used += block.length + 1
    shown += 1
  }
  const hidden = active.length - shown
  if (hidden > 0) lines.push(`(${hidden} more active ticket${hidden === 1 ? '' : 's'} omitted; call ticket_list to view all.)`)
  return lines.join('\n')
}

function formatTicketDetail(ticket, botNameOf) {
  const owner = botNameOf(ticket.ownerBotId) ?? ticket.ownerBotId
  return [
    `Ticket ${ticket.id} (rev ${ticket.revision})`,
    `Title: ${ticket.title}`,
    `Status: ${ticket.status}`,
    `Owner: ${owner}`,
    `Goal: ${ticket.goal}`,
    `Mandate: ${ticket.mandate || '(none)'}`,
    `Acceptance: ${ticket.acceptance || '(none)'}`,
    `Next step: ${ticket.nextStep || '(none)'}`,
    `Waiting on: ${ticket.waitingOn || '(none)'}`,
    `Wake condition: ${ticket.wakeCondition || '(none)'}`,
    `Deadline: ${formatDeadline(ticket.deadline) || '(none)'}`,
    `Blockers: ${ticket.blockers || '(none)'}`,
    `Artifacts: ${ticket.artifacts.length > 0 ? ticket.artifacts.join(', ') : '(none)'}`,
  ].join('\n')
}

function formatTicketLine(ticket, botNameOf) {
  const owner = botNameOf(ticket.ownerBotId) ?? ticket.ownerBotId
  const parts = [`[${ticket.id}] (${ticket.status}, rev ${ticket.revision}, owner: ${owner}) ${ticket.title}`]
  if (ticket.nextStep) parts.push(`next: ${oneLine(ticket.nextStep, 120)}`)
  if (ticket.waitingOn) parts.push(`waiting: ${oneLine(ticket.waitingOn, 80)}`)
  if (ticket.deadline !== null && ticket.deadline !== undefined) parts.push(`due: ${formatDeadline(ticket.deadline)}`)
  if (ticket.blockers) parts.push(`blockers: ${oneLine(ticket.blockers, 120)}`)
  return `- ${parts.join(' — ')}`
}

export function install(rt) {
  const { ctx, home } = rt
  const dbPath = join(home, 'tickets.sqlite')
  let store

  function openStore() {
    if (store !== undefined) return store
    store = createTicketStore(dbPath)
    return store
  }

  ctx.effect(() => () => {
    store?.close()
    store = undefined
  }, 'ds-bot: tickets')

  const hasTicketStore = () => store !== undefined || existsSync(dbPath)
  const isPrivate = botId => rt.botOf(botId)?.private === true
  const botNameOf = botId => rt.botOf(botId)?.name ?? botId

  function canView(viewerBotId, ticket) {
    const viewer = rt.botOf(viewerBotId)
    if (viewer === undefined || ticket === undefined) return false
    if (ticket.ownerBotId === viewer.id) return true
    if (isPrivate(ticket.ownerBotId) || isPrivate(viewer.id)) return false
    return rt.isMain(viewer.id)
  }

  function resolveOwner(ref, fallbackBot) {
    if (ref === undefined || ref === null || String(ref).trim() === '') return { bot: fallbackBot }
    const wanted = String(ref).trim()
    const bot = rt.botOf(wanted) ?? rt.findBot(wanted)
    if (bot === undefined) return { error: `No Bot named "${wanted}". Call list_bots to see the team.` }
    return { bot }
  }

  function activeTicketsSummary(botId) {
    if (botId === undefined) return undefined
    if (store === undefined && !existsSync(dbPath)) return undefined
    try {
      const tickets = openStore().list({ activeOnly: true, limit: 100 }).filter(ticket => canView(botId, ticket))
      return formatActiveTicketsSummary(tickets, botNameOf)
    } catch (error) {
      rt.warn?.('ds-bot: reading active tickets for handoff failed: %s', error)
      return undefined
    }
  }

  rt.teamTools.push(defineTool({
    name: 'ticket_create',
    description: 'Create a persistent long-horizon Ticket with a goal, mandate (authorization boundaries), acceptance criteria, and optional wait/deadline metadata. Only Main Bots can create team tickets; a private Bot can only create tickets for itself.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short ticket title (up to 120 characters).' },
      goal: { type: 'string', required: true, description: 'Concrete definition of what done looks like.' },
      mandate: { type: 'string', description: 'Authorization boundaries: what may be done autonomously and what must ask the user.' },
      acceptance: { type: 'string', description: 'Verification criteria and method (machine check, independent review, or user approval).' },
      owner: { type: 'string', description: 'Owner Bot name or id. Defaults to you.' },
      status: { type: 'string', enum: ACTIVE_TICKET_STATUSES, description: 'Initial status (default "open").' },
      next_step: { type: 'string', description: 'Immediate next concrete action.' },
      waiting_on: { type: 'string', description: 'Who/what the ticket is waiting on (e.g. "user", "external_event", "time", "ticket:<id>").' },
      wake_condition: { type: 'string', description: 'Condition or event that should wake this ticket.' },
      deadline: { type: 'string', description: 'Optional ISO-8601 date string or epoch ms deadline.' },
      blockers: { type: 'string', description: 'Current blockers or dependencies, if any.' },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Relevant file paths, URLs, or artifact handles.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const readOnly = rt.readOnly?.()
      if (readOnly !== undefined) return `Cannot create ticket: ${readOnly}`
      const self = rt.selfOf(exec.agent?.id)
      const caller = rt.botOf(self)
      if (caller === undefined) return 'Only Bots on the team can use ticket_create.'
      const callerIsMain = rt.isMain(caller.id)
      const callerIsPrivate = isPrivate(caller.id)
      if (!callerIsMain && !callerIsPrivate) {
        return 'Only a Main Bot can create team tickets. Ask a Main Bot to create one, or update tickets assigned to you with ticket_update.'
      }
      const resolved = resolveOwner(args.owner, caller)
      if (resolved.error !== undefined) return resolved.error
      const owner = resolved.bot
      if (callerIsPrivate && owner.id !== caller.id) {
        return 'A private Bot can only create tickets owned by itself.'
      }
      if (!callerIsPrivate && isPrivate(owner.id)) {
        return `Cannot assign a ticket to private Bot ${owner.name}.`
      }
      try {
        const ticket = openStore().create({
          title: args.title,
          goal: args.goal,
          mandate: args.mandate,
          acceptance: args.acceptance,
          status: args.status ?? 'open',
          ownerBotId: owner.id,
          createdByBotId: caller.id,
          nextStep: args.next_step,
          waitingOn: args.waiting_on,
          wakeCondition: args.wake_condition,
          deadline: args.deadline,
          blockers: args.blockers,
          artifacts: args.artifacts,
        })
        return `Created ${formatTicketDetail(ticket, botNameOf)}`
      } catch (error) {
        return `Could not create ticket: ${error.message}`
      }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'ticket_update',
    description: 'Update an existing Ticket. Main Bots can edit any non-private ticket; ordinary Bots can only update status (except cancelled), next_step, waiting_on, wake_condition, deadline, blockers, and artifacts on tickets owned by themselves.',
    parameters: {
      id: { type: 'string', required: true, description: 'Ticket id (e.g. tkt-1234abcd).' },
      expected_revision: { type: 'integer', description: 'Optional optimistic lock revision number.' },
      title: { type: 'string', description: 'New title (Main Bot only).' },
      goal: { type: 'string', description: 'New goal (Main Bot only).' },
      mandate: { type: 'string', description: 'New authorization boundary (Main Bot only).' },
      acceptance: { type: 'string', description: 'New acceptance criteria (Main Bot only).' },
      owner: { type: 'string', description: 'Reassign owner Bot name or id (Main Bot only).' },
      status: { type: 'string', enum: TICKET_STATUSES, description: 'New ticket status.' },
      next_step: { type: 'string', description: 'Updated next concrete action.' },
      waiting_on: { type: 'string', description: 'Updated wait target (pass empty string to clear).' },
      wake_condition: { type: 'string', description: 'Updated wake condition (pass empty string to clear).' },
      deadline: { type: 'string', description: 'Updated ISO-8601 date string or epoch ms (pass empty string to clear).' },
      blockers: { type: 'string', description: 'Updated blockers (pass empty string to clear).' },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Updated list of artifact paths/handles.' },
      retrospective: { type: 'string', description: 'Optional lesson learned, pitfall, or verified fact when closing a ticket (done or failed); forwarded as a pending candidate to dsh-memory buffer (never writes PROFILE.md directly).' },
      retrospective_target: { type: 'string', description: 'Optional dsh-memory buffer target ("note", "profile", "entity:<name>", or "lesson:<name>"). Defaults to "lesson:<title>" when status is "failed" and "note" when status is "done".' },
      retrospective_tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for lesson:<name> retrospective candidates.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const readOnly = rt.readOnly?.()
      if (readOnly !== undefined) return `Cannot update ticket: ${readOnly}`
      const self = rt.selfOf(exec.agent?.id)
      const caller = rt.botOf(self)
      if (caller === undefined) return 'Only Bots on the team can use ticket_update.'
      const existing = openStore().get(args.id)
      if (existing === undefined || !canView(caller.id, existing)) {
        return `Ticket not found: ${args.id}`
      }
      const callerIsMain = rt.isMain(caller.id)
      const callerIsPrivate = isPrivate(caller.id)
      const ownsTicket = existing.ownerBotId === caller.id
      if (!callerIsMain && !ownsTicket) {
        return `Permission denied: ticket ${existing.id} is owned by ${botNameOf(existing.ownerBotId)}.`
      }
      if (!callerIsMain && !callerIsPrivate) {
        const forbidden = []
        if (args.title !== undefined) forbidden.push('title')
        if (args.goal !== undefined) forbidden.push('goal')
        if (args.mandate !== undefined) forbidden.push('mandate')
        if (args.acceptance !== undefined) forbidden.push('acceptance')
        if (args.owner !== undefined) forbidden.push('owner')
        if (args.status === 'cancelled') forbidden.push('status="cancelled"')
        if (forbidden.length > 0) {
          return `Permission denied: only a Main Bot can change ${forbidden.join(', ')}. You may update status (except cancelled), next_step, waiting_on, wake_condition, deadline, blockers, and artifacts.`
        }
      }
      let ownerBotId
      if (args.owner !== undefined) {
        const resolved = resolveOwner(args.owner, caller)
        if (resolved.error !== undefined) return resolved.error
        if (callerIsPrivate && resolved.bot.id !== caller.id) {
          return 'A private Bot cannot reassign a ticket to another Bot.'
        }
        if (!callerIsPrivate && isPrivate(resolved.bot.id)) {
          return `Cannot assign a ticket to private Bot ${resolved.bot.name}.`
        }
        ownerBotId = resolved.bot.id
      }
      try {
        const updated = openStore().update(existing.id, {
          title: args.title,
          goal: args.goal,
          mandate: args.mandate,
          acceptance: args.acceptance,
          ownerBotId,
          status: args.status,
          nextStep: args.next_step,
          waitingOn: args.waiting_on,
          wakeCondition: args.wake_condition,
          deadline: args.deadline,
          blockers: args.blockers,
          artifacts: args.artifacts,
        }, {
          expectedRevision: args.expected_revision,
        })
        let suffix = ''
        if (updated.status === 'done' && existing.status !== 'done' && !isPrivate(updated.ownerBotId)) {
          try {
            await rt.memoryBridge?.recordTicketMilestone?.({
              ticket: updated,
              summary: updated.goal,
              artifacts: updated.artifacts,
              sessionId: exec.agent?.id,
            })
          } catch {}
        }
        if (typeof args.retrospective === 'string' && args.retrospective.trim() !== '') {
          if (updated.status !== 'done' && updated.status !== 'failed') {
            suffix = '\nRetrospective skipped: only recorded when status transitions to "done" or "failed".'
          } else if (isPrivate(updated.ownerBotId)) {
            suffix = '\nRetrospective skipped: private Bot tickets do not write to shared dsh-memory.'
          } else {
            try {
              const res = await rt.memoryBridge?.submitTicketRetrospective({
                ticket: updated,
                content: args.retrospective,
                target: args.retrospective_target,
                tags: args.retrospective_tags,
                sessionId: exec.agent?.id,
              })
              if (res?.ok === true) {
                suffix = `\nMemory buffer candidate queued (${res.id}, target: ${res.target}, status: ${res.status}).`
              } else if (res) {
                suffix = `\nMemory buffer skipped (${res.reason ?? 'unavailable'}).`
              } else {
                suffix = '\nMemory buffer skipped (memoryBridge unavailable).'
              }
            } catch (bridgeError) {
              suffix = `\nMemory buffer skipped (${bridgeError.message}).`
            }
          }
        }
        return `Updated ${formatTicketDetail(updated, botNameOf)}${suffix}`
      } catch (error) {
        return `Could not update ticket: ${error.message}`
      }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'ticket_list',
    description: 'List persistent Tickets visible to you. By default returns active tickets (excluding done, failed, and cancelled).',
    parameters: {
      status: { type: 'string', enum: TICKET_STATUSES, description: 'Filter by exact status.' },
      owner: { type: 'string', description: 'Filter by owner Bot name or id.' },
      include_closed: { type: 'boolean', description: 'Include done, failed, and cancelled tickets (default false).' },
      limit: { type: 'integer', description: 'Maximum number of tickets to return (default 50).' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const caller = rt.botOf(self)
      if (caller === undefined) return 'Only Bots on the team can use ticket_list.'
      let ownerBotId
      if (args.owner !== undefined && String(args.owner).trim() !== '') {
        const resolved = resolveOwner(args.owner, caller)
        if (resolved.error !== undefined) return resolved.error
        if (isPrivate(resolved.bot.id) && resolved.bot.id !== caller.id) {
          return 'No matching tickets.'
        }
        ownerBotId = resolved.bot.id
      }
      try {
        const rows = openStore().list({
          status: args.status,
          ownerBotId,
          activeOnly: args.status === undefined && args.include_closed !== true,
          limit: args.limit,
        }).filter(ticket => canView(caller.id, ticket))
        if (rows.length === 0) return 'No matching tickets.'
        return rows.map(ticket => formatTicketLine(ticket, botNameOf)).join('\n')
      } catch (error) {
        return `Could not list tickets: ${error.message}`
      }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'ticket_get',
    description: 'Read full details (goal, mandate, acceptance, status, revision, next step, waiting/deadline, blockers, artifacts) of one Ticket.',
    parameters: {
      id: { type: 'string', required: true, description: 'Ticket id (e.g. tkt-1234abcd).' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const caller = rt.botOf(self)
      if (caller === undefined) return 'Only Bots on the team can use ticket_get.'
      const ticket = openStore().get(args.id)
      if (ticket === undefined || !canView(caller.id, ticket)) {
        return `Ticket not found: ${args.id}`
      }
      return formatTicketDetail(ticket, botNameOf)
    },
  }))

  Object.assign(rt, { openTicketStore: openStore, hasTicketStore, canViewTicket: canView, activeTicketsSummary })
}
