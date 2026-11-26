// dsh-ctrl host extensions: isolated from upstream ds-bot modules so future
// upstream syncs and post-stabilization pruning stay clean.
import * as tickets from './tickets.js'
import * as ticketQueue from './ticket-queue.js'
import * as artifacts from './artifacts.js'
import * as memoryBridge from './memory-bridge.js'
import * as dayRollover from './day-rollover.js'
import * as briefing from './briefing.js'
import * as workerExecutor from './worker-executor.js'
import * as mandateGuard from './mandate-guard.js'
import * as deadlineWatcher from './deadline-watcher.js'
import * as eventRouter from './event-router.js'

const CTRL_MODULES = [tickets, ticketQueue, artifacts, memoryBridge, dayRollover, briefing, workerExecutor, mandateGuard, deadlineWatcher, eventRouter]

export function install(rt) {
  for (const module of CTRL_MODULES) module.install(rt)
}
