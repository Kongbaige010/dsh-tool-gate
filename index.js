/**
 * Tool gate — one bundle, three parts.
 *
 * 1. `gate/mcp.js`      MCP tool gating: managed servers' tools stay out of the
 *                       prompt until a service is explicitly opened, and are
 *                       closed again when the task no longer needs them.
 * 2. `gate/lowfreq.js`  Low-frequency tool groups (Mnemon admin, schedules).
 * 3. `./client.js`      The badge in the assistant action row that shows which
 *                       MCP services are open and how many tools are silenced.
 *
 * The Host half also records this instance's authenticated URL to
 * `~/.dsh/web-url.txt`, because the Desktop host binds a fresh random port on
 * every start and old bookmarks would otherwise be dead.
 *
 * Load order matters: `gate/mcp.js` wraps `systemPrompt.assemble` first, so
 * `gate/lowfreq.js` wraps around it. Both filters therefore see every assembly,
 * and the outer one only ever sees what the inner one already trimmed.
 */

import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { applyLowFreqGate } from './gate/lowfreq.js'
import { applyMcpGate } from './gate/mcp.js'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'tool-gate'

/** Services both gates need; `webServer` is optional and injected per gate. */
export const inject = ['systemPrompt', 'tools', 'agents']

/** Where the current entry point is recorded. */
const URL_FILE = join(homedir(), '.dsh', 'web-url.txt')

/**
 * Mount both gates and the entry-point recorder.
 * @param ctx - plugin context.
 * @param config - `{ mcp?: {...}, groups?: {...} }`, forwarded to each gate.
 */
export function apply(ctx, config = {}) {
  applyMcpGate(ctx, config.mcp ?? {})
  applyLowFreqGate(ctx, config.groups ?? {})

  // Keep a fixed entry point for this instance: the Desktop host uses `--port 0`,
  // so the address changes on every start and the token never reaches disk.
  ctx.inject(['webServer', 'connection'], (scoped) => {
    /** One attempt; true once the port is known and the file is written. */
    const record = () => {
      const port = scoped.webServer.port
      if (port === undefined || port === 0) return false
      const base = `${scoped.webServer.protocol}//127.0.0.1:${String(port)}`
      let url = base
      try {
        url = scoped.connection.authenticatedUrl(base)
      } catch {
        // An implementation without browser auth still gets the plain address.
        url = base
      }
      writeFile(URL_FILE, `${url}\n`, 'utf8').catch(() => {})
      return true
    }

    // The listener binds after plugin activation: poll briefly rather than
    // assuming a service event this DSH version does not emit.
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      if (record() || attempts > 150) clearInterval(timer)
    }, 200)
    scoped.effect(() => () => clearInterval(timer))
    record()
  })
}
