// dsh-ctrl host extensions: isolated from upstream ds-bot modules so future
// upstream syncs and post-stabilization pruning stay clean.
import * as tickets from './tickets.js'
import * as ticketQueue from './ticket-queue.js'
import * as artifacts from './artifacts.js'
import * as memoryBridge from './memory-bridge.js'
import * as dayRollover from './day-rollover.js'
import * as briefing from './briefing.js'

const CTRL_MODULES = [tickets, ticketQueue, artifacts, memoryBridge, dayRollover, briefing]

export function install(rt) {
  for (const module of CTRL_MODULES) module.install(rt)
}
