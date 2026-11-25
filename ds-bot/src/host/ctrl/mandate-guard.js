import os from 'node:os'
import path from 'node:path'

export const DEFAULT_MAX_WORKER_STEPS = 25
export const DEFAULT_MAX_WORKER_TOKENS = 200_000

const SHORT_TEXT_MAX = 500
const ALWAYS_ALLOWED_TOOLS = new Set(['ticket_report', 'artifact_read'])

const SHELL_TOOL_NAMES = new Set([
  'bash',
  'shell',
  'sh',
  'zsh',
  'powershell',
  'pwsh',
  'cmd',
  'exec',
  'run_command',
  'command',
  'terminal',
  'execute_command',
])

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'file_read',
  'view_file',
  'cat',
  'read',
  'head',
  'tail',
  'list_dir',
  'list_files',
  'dir_list',
  'ls',
  'glob',
  'find_files',
  'find_by_name',
  'grep',
  'search_grep',
  'grep_search',
  'ripgrep',
  'rg',
  'pwd',
  'which',
  'stat',
  'git_status',
  'git_diff',
  'git_log',
  'ticket_get',
  'ticket_list',
  'recall',
  'list_bots',
  'list_bot_models',
  'list_capabilities',
  'list_connectors',
  'list_secrets',
  'read_own_chat',
  'read_group_chat',
  'schedule_list',
  'browser_snapshot',
  'browser_get',
  'web_search',
])

const READ_ONLY_TOOL_PREFIXES = /^(read|get|list|view|show|search|find|grep|glob|ls|inspect|check|describe)_/i

const WRITE_MUTATING_TOOLS = new Set([
  'write_file',
  'file_write',
  'create_file',
  'write_to_file',
  'edit_file',
  'file_edit',
  'multi_edit',
  'replace_file_content',
  'multi_replace_file_content',
  'str_replace',
  'patch_file',
  'apply_patch',
  'delete_file',
  'remove_file',
  'unlink_file',
  'rm',
  'mv',
  'cp',
  'mkdir',
  'touch',
  'save_capability',
  'delete_capability',
  'attach_capability',
  'detach_capability',
  'create_bot',
  'update_bot',
  'stop_bot',
  'create_group',
  'update_group',
  'delete_group',
  'post_to_group',
  'message_bot',
  'group_relay',
  'remember',
  'forget',
  'ticket_create',
  'ticket_update',
  'ticket_dispatch',
  'schedule_create',
  'schedule_update',
  'schedule_delete',
  'email_send',
  'send_email',
  'mail_send',
  'im_send',
  'send_message',
])

const OUTBOUND_TOOL_PREFIXES = /^(send_|post_|publish_|upload_|email_send|mail_send|smtp_send|im_send|webhook|slack_|discord_|telegram_|feishu_|message_bot|post_to_group|group_relay)/i
const OUTBOUND_TOOL_SUFFIXES = /(_send|_post|_publish|_upload|_webhook)$/i
const HTTP_REQUEST_TOOLS = new Set(['http_request', 'fetch', 'fetch_url', 'request_url', 'web_request'])

const PATH_ARG_KEYS = [
  'file_path',
  'path',
  'target_file',
  'target_path',
  'dir',
  'directory',
  'cwd',
  'work_dir',
  'workdir',
  'destination',
  'dest',
  'source',
  'src',
  'file',
  'folder',
  'root',
]
const PATH_ARRAY_KEYS = ['paths', 'files', 'targets', 'dirs']

const READ_ONLY_SHELL_SEGMENT_RE = /^(?:ls|dir|pwd|cat|head|tail|wc|grep|rg|ripgrep|find|stat|which|where|type|file|readlink|realpath|basename|dirname|echo|printf|true|false|test|git\s+(?:status|diff|log|show|branch|tag|ls-files|rev-parse)|get-childitem|gci|get-content|gc|select-string|sls|get-location|gl)(?:\s|$)/i
const MUTATING_SHELL_RE = /(?:>>?|\|\s*tee\b|`|\$\(|\b(?:rm|rmdir|unlink|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|dd|truncate|install|shred|tee|Remove-Item|Move-Item|Copy-Item|New-Item|Set-Content|Add-Content|Out-File|Clear-Content|sed\s+-i|perl\s+-[pi]\w*e|git\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|clean|stash|cherry-pick|revert)|(?:npm|pnpm|yarn|bun)\s+(?:install|ci|add|remove|uninstall|update|publish)|pip\s+(?:install|uninstall))\b)/i

const OUTBOUND_SHELL_PATTERNS = [
  /\bgit\s+(?:push|send-email)\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+publish\b/i,
  /\bgh\s+(?:pr\s+(?:create|merge|comment|review|edit|close)|issue\s+(?:create|comment|close|edit)|release\s+create)\b/i,
  /\bgh\s+api\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--method(?:=|\s+)(?:POST|PUT|PATCH|DELETE)|(?:^|\s)-[fF]\b)/i,
  /\bcurl\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request(?:=|\s+)(?:POST|PUT|PATCH|DELETE)|(?:^|\s)(?:-d|--data(?:-[a-z]+)?|-F|--form|-T|--upload-file)(?:=|\s|$))/i,
  /\bwget\b[^\n]*--post-(?:data|file)\b/i,
  /\b(?:Invoke-RestMethod|Invoke-WebRequest|irm|iwr)\b[^\n]*(?:-Method\s*(?:Post|Put|Patch|Delete)\b|-Body\b)/i,
  /\b(?:sendmail|sftp|scp)\b/i,
  /\bmail\b[^\n]*\s-s\b/i,
  /\brsync\b[^\n]*:/i,
]

function positiveInt(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return null
}

function parseBooleanValue(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const norm = value.trim().toLowerCase()
    if (norm === 'true' || norm === '1' || norm === 'yes' || norm === 'on') return true
    if (norm === 'false' || norm === '0' || norm === 'no' || norm === 'off') return false
  }
  return undefined
}

function stripOuterQuotes(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}

function splitDirectiveList(raw, { preserveRegexCommas = false } = {}) {
  let body = String(raw ?? '').trim()
  if (body.startsWith('[') && body.endsWith(']')) {
    try {
      const parsed = JSON.parse(body)
      if (Array.isArray(parsed)) {
        return parsed.map(item => String(item ?? '').trim()).filter(Boolean)
      }
    } catch {}
    body = body.slice(1, -1).trim()
  }
  if (body === '') return []

  const items = []
  let current = ''
  let quote = null
  let inRegex = false
  let escaped = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && (quote !== null || inRegex)) {
      current += ch
      escaped = true
      continue
    }
    if (!inRegex && (ch === '"' || ch === "'")) {
      quote = quote === ch ? null : (quote ?? ch)
      current += ch
      continue
    }
    if (preserveRegexCommas && quote === null && ch === '/' && current.trim() === '') {
      inRegex = true
      current += ch
      continue
    }
    if (inRegex && ch === '/') {
      inRegex = false
      current += ch
      continue
    }
    if (quote === null && !inRegex && ch === ',') {
      const token = stripOuterQuotes(current)
      if (token !== '') items.push(token)
      current = ''
      continue
    }
    current += ch
  }
  const tail = stripOuterQuotes(current)
  if (tail !== '') items.push(tail)
  return items
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item ?? '').trim()).filter(Boolean)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return splitDirectiveList(value)
  }
  return []
}

export function parseMandatePolicy(rawMandate) {
  const policy = {
    readOnly: false,
    allowDirs: [],
    denyDirs: [],
    allowTools: [],
    denyTools: [],
    denyCommands: [],
    denyExternal: false,
    maxSteps: null,
    maxTokens: null,
  }

  if (rawMandate === null || rawMandate === undefined) return policy

  let obj = null
  if (typeof rawMandate === 'object' && !Array.isArray(rawMandate)) {
    obj = rawMandate
  } else if (typeof rawMandate === 'string') {
    const trimmed = rawMandate.trim()
    if (trimmed === '') return policy
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          obj = parsed
        }
      } catch {}
    }
    if (!obj) {
      const lines = trimmed.split(/\r?\n/)
      for (const rawLine of lines) {
        const line = rawLine.trim().replace(/^[-*]\s+/, '').trim()
        if (line === '' || line.startsWith('#')) continue
        const flag = line.toLowerCase()
        if (flag === 'read_only' || flag === 'readonly' || flag === 'read-only') {
          policy.readOnly = true
          continue
        }
        if (flag === 'no_external' || flag === 'no-external' || flag === 'deny_external' || flag === 'deny-external') {
          policy.denyExternal = true
          continue
        }

        const sepIdx = line.search(/[:=]/)
        if (sepIdx <= 0) continue
        const rawKey = line.slice(0, sepIdx).trim().toLowerCase().replace(/[\s-]+/g, '_')
        const rawVal = line.slice(sepIdx + 1).trim()
        if (rawVal === '') continue

        switch (rawKey) {
          case 'mode': {
            const mode = stripOuterQuotes(rawVal).toLowerCase()
            if (mode === 'read-only' || mode === 'read_only' || mode === 'readonly') {
              policy.readOnly = true
            } else if (mode === 'read-write' || mode === 'write' || mode === 'rw') {
              policy.readOnly = false
            }
            break
          }
          case 'read_only':
          case 'readonly': {
            const b = parseBooleanValue(stripOuterQuotes(rawVal))
            if (b !== undefined) policy.readOnly = b
            break
          }
          case 'allow_external': {
            const b = parseBooleanValue(stripOuterQuotes(rawVal))
            if (b !== undefined) policy.denyExternal = !b
            break
          }
          case 'deny_external':
          case 'no_external': {
            const b = parseBooleanValue(stripOuterQuotes(rawVal))
            if (b !== undefined) policy.denyExternal = b
            break
          }
          case 'allow_dir':
          case 'allow_dirs':
          case 'allowed_dir':
          case 'allowed_dirs':
          case 'allow_path':
          case 'allow_paths':
          case 'allowed_paths':
            policy.allowDirs.push(...splitDirectiveList(rawVal))
            break
          case 'deny_dir':
          case 'deny_dirs':
          case 'denied_dir':
          case 'denied_dirs':
          case 'deny_path':
          case 'deny_paths':
          case 'denied_paths':
            policy.denyDirs.push(...splitDirectiveList(rawVal))
            break
          case 'allow_tool':
          case 'allow_tools':
          case 'allowed_tool':
          case 'allowed_tools':
            policy.allowTools.push(...splitDirectiveList(rawVal))
            break
          case 'deny_tool':
          case 'deny_tools':
          case 'denied_tool':
          case 'denied_tools':
            policy.denyTools.push(...splitDirectiveList(rawVal))
            break
          case 'deny_command':
          case 'deny_commands':
          case 'denied_command':
          case 'denied_commands':
            policy.denyCommands.push(...splitDirectiveList(rawVal, { preserveRegexCommas: true }))
            break
          case 'max_steps':
          case 'maxsteps': {
            const n = positiveInt(stripOuterQuotes(rawVal))
            if (n !== null) policy.maxSteps = n
            break
          }
          case 'max_tokens':
          case 'maxtokens': {
            const n = positiveInt(stripOuterQuotes(rawVal))
            if (n !== null) policy.maxTokens = n
            break
          }
          default:
            break
        }
      }
      return policy
    }
  } else {
    return policy
  }

  const mode = typeof obj.mode === 'string' ? obj.mode.trim().toLowerCase() : ''
  const readOnlyFlag = obj.readOnly ?? obj.read_only ?? obj.readonly
  if (mode === 'read-only' || mode === 'read_only' || mode === 'readonly') {
    policy.readOnly = true
  } else if (readOnlyFlag !== undefined) {
    policy.readOnly = parseBooleanValue(readOnlyFlag) ?? Boolean(readOnlyFlag)
  }

  if (obj.denyExternal !== undefined || obj.deny_external !== undefined || obj.noExternal !== undefined || obj.no_external !== undefined) {
    const val = obj.denyExternal ?? obj.deny_external ?? obj.noExternal ?? obj.no_external
    policy.denyExternal = parseBooleanValue(val) ?? Boolean(val)
  } else if (obj.allowExternal !== undefined || obj.allow_external !== undefined) {
    const val = obj.allowExternal ?? obj.allow_external
    const parsed = parseBooleanValue(val)
    policy.denyExternal = parsed !== undefined ? !parsed : !val
  }

  policy.allowDirs = normalizeStringArray(obj.allowDirs ?? obj.allow_dirs ?? obj.allowedDirs ?? obj.allowed_dirs ?? obj.allowPaths ?? obj.allow_paths)
  policy.denyDirs = normalizeStringArray(obj.denyDirs ?? obj.deny_dirs ?? obj.deniedDirs ?? obj.denied_dirs ?? obj.denyPaths ?? obj.deny_paths)
  policy.allowTools = normalizeStringArray(obj.allowTools ?? obj.allow_tools ?? obj.allowedTools ?? obj.allowed_tools)
  policy.denyTools = normalizeStringArray(obj.denyTools ?? obj.deny_tools ?? obj.deniedTools ?? obj.denied_tools)
  policy.denyCommands = normalizeStringArray(obj.denyCommands ?? obj.deny_commands ?? obj.deniedCommands ?? obj.denied_commands)
  policy.maxSteps = positiveInt(obj.maxSteps ?? obj.max_steps)
  policy.maxTokens = positiveInt(obj.maxTokens ?? obj.max_tokens)
  return policy
}

function isShellTool(toolName) {
  const lower = String(toolName ?? '').trim().toLowerCase()
  if (SHELL_TOOL_NAMES.has(lower)) return true
  return /_(?:bash|shell|command|exec)$/.test(lower)
}

function matchesToolPattern(toolName, pattern) {
  const normPattern = String(pattern ?? '').trim().toLowerCase()
  if (normPattern === '') return false
  if (normPattern === '*') return true
  const escaped = normPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(String(toolName ?? '').trim().toLowerCase())
}

function extractCommandString(args) {
  for (const key of ['command', 'cmd', 'CommandLine', 'script']) {
    const val = args?.[key]
    if (typeof val === 'string' && val.trim() !== '') return val.trim()
  }
  return ''
}

function isReadOnlyToolName(toolName) {
  const lower = String(toolName ?? '').trim().toLowerCase()
  if (READ_ONLY_TOOLS.has(lower)) return true
  if (WRITE_MUTATING_TOOLS.has(lower)) return false
  return READ_ONLY_TOOL_PREFIXES.test(lower)
}

function isReadOnlyShellCommand(cmd) {
  const trimmed = String(cmd ?? '').trim()
  if (trimmed === '') return false
  if (MUTATING_SHELL_RE.test(trimmed)) return false
  const segments = trimmed
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map(seg => seg.trim())
    .filter(Boolean)
  if (segments.length === 0) return false
  return segments.every(seg => READ_ONLY_SHELL_SEGMENT_RE.test(seg))
}

function isOutboundCall(toolName, args, cmd) {
  const lower = String(toolName ?? '').trim().toLowerCase()
  if (OUTBOUND_TOOL_PREFIXES.test(lower) || OUTBOUND_TOOL_SUFFIXES.test(lower)) {
    return true
  }
  if (HTTP_REQUEST_TOOLS.has(lower)) {
    const method = typeof args?.method === 'string' ? args.method.trim().toUpperCase() : 'GET'
    if (method !== 'GET' && method !== 'HEAD') return true
  }
  if (cmd !== '') {
    return OUTBOUND_SHELL_PATTERNS.some(re => re.test(cmd))
  }
  return false
}

function matchesDeniedCommand(cmd, pattern) {
  const raw = String(pattern ?? '').trim()
  if (raw === '') return null
  const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(raw)
  if (regexMatch) {
    try {
      const safeFlags = regexMatch[2].replace(/[gy]/g, '')
      const re = new RegExp(regexMatch[1], safeFlags)
      if (re.test(cmd)) return raw
      return null
    } catch {}
  }
  return cmd.toLowerCase().includes(raw.toLowerCase()) ? raw : null
}

function expandHomePath(candidate) {
  const home = os.homedir()
  if (candidate === '~') return home
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    return path.join(home, candidate.slice(2))
  }
  return candidate
}

function resolveCandidatePath(rawPath, workDir) {
  const expanded = expandHomePath(stripOuterQuotes(rawPath))
  if (expanded === '') return ''
  const base = typeof workDir === 'string' && workDir.trim() !== '' ? workDir.trim() : process.cwd()
  return path.resolve(base, expanded)
}

function normalizeForCompare(resolvedPath) {
  let normalized = resolvedPath.replace(/\\/g, '/')
  if (normalized.length > 1 && normalized.endsWith('/') && !/^[a-zA-Z]:\/$/.test(normalized)) {
    normalized = normalized.slice(0, -1)
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isWithinDir(targetPath, dirPath) {
  const normDir = normalizeForCompare(dirPath)
  const normTarget = normalizeForCompare(targetPath)
  const rel = path.relative(normDir, normTarget)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function tokenizeShellArgs(cmd) {
  const cleaned = String(cmd ?? '').replace(/https?:\/\/[^\s"'`]+/gi, ' ')
  const tokens = []
  let cur = ''
  let quote = null
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else {
        cur += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/[\s|;&<>]/.test(ch)) {
      if (cur !== '') {
        tokens.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur !== '') tokens.push(cur)
  return tokens
}

function isRelevantShellPathToken(token) {
  if (token === '' || token === '.' || token === './' || token === '.\\') return false
  if (token === '/dev/null') return false
  if (/^-[a-zA-Z0-9_-]+$/.test(token)) return false
  if (/^\/[a-zA-Z]$/.test(token)) return false
  if (/^[a-zA-Z]:[\\/]/.test(token)) return true
  if (token.startsWith('~/') || token.startsWith('~\\') || token === '~') return true
  if (token.startsWith('..') || token.startsWith('./') || token.startsWith('.\\')) return true
  if (token.startsWith('/') && token.length >= 2) return true
  if (token.includes('\\')) return true
  return false
}

function collectCandidatePaths(toolName, args, cmd) {
  const paths = []
  for (const key of PATH_ARG_KEYS) {
    const val = args?.[key]
    if (typeof val === 'string' && val.trim() !== '') {
      paths.push(val.trim())
    }
  }
  for (const key of PATH_ARRAY_KEYS) {
    const arr = args?.[key]
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item === 'string' && item.trim() !== '') {
          paths.push(item.trim())
        }
      }
    }
  }
  if (isShellTool(toolName) && cmd !== '') {
    const tokens = tokenizeShellArgs(cmd)
    for (let i = 0; i < tokens.length; i++) {
      let token = tokens[i]
      const eqIdx = token.indexOf('=')
      if (token.startsWith('--') && eqIdx > 0) {
        token = token.slice(eqIdx + 1)
      }
      if (isRelevantShellPathToken(token)) {
        paths.push(token)
        continue
      }
      const prev = i > 0 ? tokens[i - 1].toLowerCase() : ''
      if (
        (prev === 'cd' || prev === 'cat' || prev === 'rm' || prev === 'mv' || prev === 'cp' || prev === 'ls' || prev === 'touch' || prev === 'mkdir')
        && !token.startsWith('-')
      ) {
        paths.push(token)
      }
    }
  }
  return paths
}

export function evaluateMandateCall({ toolName, args, mandate, policy: providedPolicy, workDir = '' }) {
  const cleanTool = String(toolName ?? '').trim()
  if (ALWAYS_ALLOWED_TOOLS.has(cleanTool)) {
    return { allowed: true }
  }

  const policy = providedPolicy ?? parseMandatePolicy(mandate)
  const cleanArgs = args && typeof args === 'object' ? args : {}
  const shellTool = isShellTool(cleanTool)
  const cmd = shellTool ? extractCommandString(cleanArgs) : ''

  if (policy.allowTools.length > 0 && !policy.allowTools.some(pattern => matchesToolPattern(cleanTool, pattern))) {
    return {
      allowed: false,
      rule: 'allow_tools',
      reason: `Tool "${cleanTool}" is not permitted by ticket mandate allow_tools (${policy.allowTools.join(', ')}).`,
    }
  }

  if (policy.denyTools.some(pattern => matchesToolPattern(cleanTool, pattern))) {
    return {
      allowed: false,
      rule: 'deny_tools',
      reason: `Tool "${cleanTool}" is explicitly blocked by ticket mandate deny_tools.`,
    }
  }

  if (policy.readOnly) {
    if (shellTool) {
      if (!isReadOnlyShellCommand(cmd)) {
        return {
          allowed: false,
          rule: 'read_only',
          reason: `Shell command "${cmd.slice(0, 120)}" is blocked because ticket mandate is read-only.`,
        }
      }
    } else if (!isReadOnlyToolName(cleanTool)) {
      return {
        allowed: false,
        rule: 'read_only',
        reason: `Tool "${cleanTool}" is blocked because ticket mandate is read-only.`,
      }
    }
  }

  if (policy.denyExternal && isOutboundCall(cleanTool, cleanArgs, cmd)) {
    return {
      allowed: false,
      rule: 'deny_external',
      reason: `External/outbound operation via "${cleanTool}" is blocked by ticket mandate (allow_external=false).`,
    }
  }

  if (shellTool && cmd !== '' && policy.denyCommands.length > 0) {
    for (const pattern of policy.denyCommands) {
      const matched = matchesDeniedCommand(cmd, pattern)
      if (matched !== null) {
        return {
          allowed: false,
          rule: 'deny_commands',
          reason: `Shell command matches denied pattern "${matched}" in ticket mandate.`,
        }
      }
    }
  }

  if (policy.denyDirs.length > 0 || policy.allowDirs.length > 0) {
    const resolvedDenyDirs = policy.denyDirs.map(dir => resolveCandidatePath(dir, workDir)).filter(Boolean)
    const resolvedAllowDirs = policy.allowDirs.map(dir => resolveCandidatePath(dir, workDir)).filter(Boolean)
    const candidates = collectCandidatePaths(cleanTool, cleanArgs, cmd)

    for (const rawPath of candidates) {
      const resolved = resolveCandidatePath(rawPath, workDir)
      if (!resolved) continue
      const deniedDir = resolvedDenyDirs.find(dir => isWithinDir(resolved, dir))
      if (deniedDir) {
        return {
          allowed: false,
          rule: 'deny_dirs',
          reason: `Path "${rawPath}" (${resolved}) falls inside denied directory "${deniedDir}".`,
        }
      }
      if (resolvedAllowDirs.length > 0 && !resolvedAllowDirs.some(dir => isWithinDir(resolved, dir))) {
        return {
          allowed: false,
          rule: 'allow_dirs',
          reason: `Path "${rawPath}" (${resolved}) escapes allowed directories (${policy.allowDirs.join(', ')}).`,
        }
      }
    }
  }

  return { allowed: true }
}

function summarizeWorkerCallArgs(args) {
  const first = keys => keys.map(key => args?.[key]).find(value => typeof value === 'string' && value.trim() !== '')
  const text = first(['description', 'justification', 'reason', 'summary'])
  const code = first(['command', 'cmd', 'script', 'file_path', 'path', 'target_file', 'url', 'to', 'query'])
  return {
    ...(text ? { text: text.trim().slice(0, 300) } : {}),
    ...(code ? { code: code.trim().slice(0, 400) } : {}),
  }
}

export function createMandateGuard(rt) {
  const { ctx } = rt
  /** @type {Map<string, Map<string, { text?: string, code?: string }>>} */
  const callDetailsBySession = new Map()

  function resolveWorkerBudgets(worker) {
    const ctrlConfig = rt.config?.ctrl ?? {}
    const configMaxSteps = positiveInt(ctrlConfig.maxWorkerSteps) ?? DEFAULT_MAX_WORKER_STEPS
    const configMaxTokens = positiveInt(ctrlConfig.maxWorkerTokens) ?? DEFAULT_MAX_WORKER_TOKENS
    const policy = parseMandatePolicy(worker?.mandate ?? worker?.ticket?.mandate)
    return {
      maxSteps: policy.maxSteps !== null ? Math.min(policy.maxSteps, configMaxSteps) : configMaxSteps,
      maxTokens: policy.maxTokens !== null ? Math.min(policy.maxTokens, configMaxTokens) : configMaxTokens,
    }
  }

  function rememberWorkerCall(sessionId, callId, args) {
    if (!sessionId || !callId) return
    let map = callDetailsBySession.get(sessionId)
    if (!map) {
      map = new Map()
      callDetailsBySession.set(sessionId, map)
    }
    if (map.size >= 64) {
      const oldestKey = map.keys().next().value
      if (oldestKey !== undefined) map.delete(oldestKey)
    }
    map.set(callId, summarizeWorkerCallArgs(args))
  }

  function workerCallDetail(sessionId, callId) {
    return callDetailsBySession.get(sessionId)?.get(callId) ?? {}
  }

  function clearWorkerCalls(sessionId) {
    if (sessionId) callDetailsBySession.delete(sessionId)
  }

  function checkBudget(worker) {
    if (!worker) return null
    if (worker.circuitBreak) return worker.circuitBreak
    if (worker.mandateViolation || worker.report) return null

    const { maxSteps, maxTokens } = resolveWorkerBudgets(worker)
    let metric = null
    let reason = null
    if (worker.stepCount >= maxSteps) {
      metric = 'steps'
      reason = `Circuit breaker tripped for ticket ${worker.ticketId}: reached max steps (${worker.stepCount}/${maxSteps}).`
    } else if (worker.tokenUsage >= maxTokens) {
      metric = 'tokens'
      reason = `Circuit breaker tripped for ticket ${worker.ticketId}: reached token limit (${worker.tokenUsage}/${maxTokens}).`
    }
    if (!reason) return null

    worker.circuitBreak = {
      metric,
      stepCount: worker.stepCount,
      tokenUsage: worker.tokenUsage,
      maxSteps,
      maxTokens,
      reason,
      at: Date.now(),
    }
    try {
      worker.agent?.cancel?.({ kind: 'hook', reason: 'dsh-ctrl/circuit-breaker' })
    } catch {}
    return worker.circuitBreak
  }

  function latchMandateViolation(worker, exec, verdict) {
    const cleanReason = String(verdict.reason ?? 'Tool call violated ticket mandate.').slice(0, SHORT_TEXT_MAX)
    worker.mandateViolation = {
      toolName: exec.name,
      rule: verdict.rule ?? 'mandate',
      reason: cleanReason,
      callId: exec.callId,
      at: Date.now(),
    }
    worker.report = {
      status: 'waiting_user',
      summary: `Mandate guard blocked "${exec.name}" (${verdict.rule ?? 'mandate'}): ${cleanReason}`,
      artifacts: [],
      waitingOn: 'user',
      wakeCondition: `Approve or revise mandate for ${exec.name}`,
      nextStep: `Review blocked tool "${exec.name}" (${cleanReason}), adjust ticket mandate if intended, and re-dispatch`,
      blockers: cleanReason,
    }
    try {
      const targetAgent = exec.agent ?? worker.agent
      targetAgent?.cancel?.({ kind: 'hook', reason: 'dsh-ctrl/mandate-violation' })
    } catch {}
  }

  function workerApprovalChanged(kind, entry) {
    const sessionId = entry?.sessionId
    const worker = sessionId ? rt.workerContextOf?.(sessionId) : undefined
    if (!worker) return
    if (kind === 'open') {
      worker.pendingApprovals?.add?.(entry.id)
      if (worker.ticket && typeof rt.workerExecutor?.notifyChief === 'function') {
        const detailLine = entry.detail?.code || entry.detail?.text || ''
        const text = [
          `Ticket ${worker.ticketId} (${worker.ticket.title}) hidden Worker paused for **tool approval** (\`${entry.tool}\`, id \`${entry.id}\`).`,
          ...(entry.reason ? [`Reason: ${entry.reason}`] : []),
          ...(detailLine ? [`Detail: ${detailLine}`] : []),
          'Please approve or reject via the approval card / IM prompt so the Worker can proceed or exit.',
        ].join('\n\n')
        void Promise.resolve(
          rt.workerExecutor.notifyChief(worker.ticket, text, {
            assignmentId: worker.assignmentId,
            approvalId: entry.id,
            status: 'approval_requested',
          }),
        ).catch(error => {
          rt.warn?.('ds-bot: notifying chief of worker approval %s failed: %s', entry.id, error?.message ?? error)
        })
      }
    } else if (kind === 'settled') {
      worker.pendingApprovals?.delete?.(entry.id)
    }
  }

  ctx.on('tools/pre-execute', async function mandateGuard(exec, next) {
    const sessionId = exec.agent?.session?.id ?? exec.agent?.id
    const worker = sessionId === undefined ? undefined : rt.workerContextOf?.(sessionId)
    if (worker === undefined) return next()

    if (worker.circuitBreak) {
      return { kind: 'deny', reason: worker.circuitBreak.reason }
    }
    if (worker.mandateViolation) {
      return { kind: 'deny', reason: worker.mandateViolation.reason }
    }

    const tripped = checkBudget(worker)
    if (tripped) {
      return { kind: 'deny', reason: tripped.reason }
    }

    const verdict = evaluateMandateCall({
      toolName: exec.name,
      args: exec.arguments,
      mandate: worker.mandate ?? worker.ticket?.mandate,
      workDir: worker.workDir,
    })

    if (!verdict.allowed) {
      latchMandateViolation(worker, exec, verdict)
      return {
        kind: 'deny',
        reason: `MANDATE_VIOLATION (${verdict.rule}): ${verdict.reason} Escalating ticket ${worker.ticketId} to waiting_user.`,
      }
    }

    rememberWorkerCall(sessionId, exec.callId, exec.arguments)
    return next()
  })

  return {
    parseMandatePolicy,
    evaluateMandateCall,
    resolveWorkerBudgets,
    checkBudget,
    workerCallDetail,
    clearWorkerCalls,
    workerApprovalChanged,
  }
}

export function install(rt) {
  const guard = createMandateGuard(rt)
  rt.mandateGuard = guard
  rt.workerCallDetail = guard.workerCallDetail
  rt.workerApprovalChanged = guard.workerApprovalChanged
}
