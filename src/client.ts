import type { CanvasLayerApi, JsonValue, NativeConnection } from '../generated/mywallpaper-runtime'
import { ActionError, type Action, type Command, type MailClient, type Result } from '../shared/protocol'

export class RpcClient implements MailClient {
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private stopped = false
  constructor(private send: (command: Command) => Promise<void>, private stop: () => void) {}
  receive(raw: unknown) {
    if (this.stopped || !raw || typeof raw !== 'object') return
    const value = raw as Result
    if (value.kind !== 'mail.result' || typeof value.requestId !== 'string') return
    const pending = this.pending.get(value.requestId)
    if (!pending) return
    clearTimeout(pending.timer); this.pending.delete(value.requestId)
    value.ok ? pending.resolve(value.result) : pending.reject(new ActionError(value.error ?? 'request-failed'))
  }
  async request<T>(action: Action, input: Record<string, unknown> = {}): Promise<T> {
    if (this.stopped) throw new ActionError('offline')
    if (this.pending.size >= 8) throw new ActionError('busy')
    const requestId = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new ActionError(action === 'send' ? 'send-unconfirmed' : 'timeout')) }, 120_000)
      this.pending.set(requestId, { resolve: value => resolve(value as T), reject, timer })
      void this.send({ kind: 'mail.command', requestId, action, input }).catch(error => {
        const pending = this.pending.get(requestId)
        if (!pending) return
        clearTimeout(pending.timer); this.pending.delete(requestId)
        pending.reject(error instanceof ActionError ? error : new ActionError('offline'))
      })
    })
  }
  close() {
    if (this.stopped) return
    this.stopped = true
    this.pending.forEach(pending => { clearTimeout(pending.timer); pending.reject(new ActionError('offline')) })
    this.pending.clear(); this.stop()
  }
}

export function createNativeClient(layer: CanvasLayerApi): MailClient {
  let connection: NativeConnection | undefined
  let disposed = false
  let unsubscribe: (() => void) | undefined
  const connecting = layer.native.companion.available ? layer.native.companion.connect() : Promise.reject(new ActionError('desktop-required'))
  const client = new RpcClient(async command => {
    if (!connection) { try { connection = await connecting } catch { throw new ActionError(layer.native.companion.available ? 'offline' : 'desktop-required') } }
    if (disposed) throw new ActionError('offline')
    await connection.send(command as unknown as JsonValue)
  }, () => { disposed = true; unsubscribe?.(); connection?.close() })
  void connecting.then(value => {
    if (disposed) { value.close(); return }
    connection = value; unsubscribe = value.onMessage(payload => client.receive(payload))
  }).catch(() => {})
  return client
}
