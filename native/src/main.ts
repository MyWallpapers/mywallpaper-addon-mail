import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { FramedTransport } from './transport.js'
import { PhpEngine, runtimePaths } from './engine.js'
import { Session } from './session.js'
import { Vault } from './vault.js'
import { ActionError } from '../../shared/protocol.js'

console.log = console.info = console.debug = console.warn = console.error = () => {}
const transport = new FramedTransport(process.stdin, process.stdout)
let session: Session | undefined
let opening: Promise<Session> | undefined
let closing = false
async function close() { if (closing) return; closing = true; await opening?.catch(() => {}); await session?.close(); await transport.flush() }
process.once('SIGTERM', () => { void close().finally(() => process.exit()) })
process.once('SIGINT', () => { void close().finally(() => process.exit()) })
async function main() {
  try {
    for await (const raw of transport.records()) {
      const frame = raw as { type?: string; v?: number; addonId?: string; scratchDirectory?: string; payload?: unknown }
      if (frame.v !== transport.version) throw new Error('protocol')
      if (frame.type === 'init') {
        if (opening || typeof frame.addonId !== 'string' || !frame.addonId || frame.addonId.length > 200 || typeof frame.scratchDirectory !== 'string' || process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('initialization')
        const layerKey = basename(frame.scratchDirectory)
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(layerKey)) throw new Error('scope')
        const addonKey = createHash('sha256').update(frame.addonId).digest('hex')
        const directory = join(process.env.LOCALAPPDATA, 'MyWallpaper', 'Addons', 'Mail', addonKey, layerKey)
        // Ready means the process-v2 channel can receive RPCs. The host's
        // two-second handshake must not wait for cold extraction or DPAPI.
        await transport.send({ type: 'ready', v: transport.version })
        opening = (async () => {
          const paths = await runtimePaths(directory)
          session = new Session(new Vault(directory), [new PhpEngine(paths), new PhpEngine(paths)])
          await session.open(); return session
        })()
        void opening.catch(() => {})
      } else if (!opening) throw new Error('not-initialized')
      else if (frame.type === 'message') void opening.then(value => value.handle(frame.payload)).then(payload => { if (payload && !closing) return transport.send({ type: 'message', v: transport.version, target: 'broadcast', payload }) }).catch(error => {
        const command = frame.payload as { kind?: string; requestId?: string } | undefined
        if (!closing && command?.kind === 'mail.command' && typeof command.requestId === 'string' && command.requestId.length <= 80) return transport.send({ type: 'message', v: transport.version, target: 'broadcast', payload: { kind: 'mail.result', requestId: command.requestId, ok: false, error: error instanceof ActionError ? error.code : 'runtime-unavailable' } })
      }).catch(() => {})
      else if (frame.type === 'settings') continue
      else if (frame.type === 'shutdown') break
      else throw new Error('protocol')
    }
  } catch {
    await transport.send({ type: 'error', v: transport.version, code: 'mail-companion-error', message: 'The local Mail companion could not complete this request.' }).catch(() => {})
    process.exitCode = 1
  } finally { await close() }
}
void main()
