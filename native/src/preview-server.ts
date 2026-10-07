// Development-only loopback bridge. The shipped companion uses process pipes.
import { createServer } from 'node:http'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { PhpEngine, runtimePaths } from './engine.js'
import { Session } from './session.js'
import { Vault } from './vault.js'

if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('Run the local account preview on Windows so credentials use DPAPI.')
const directory = join(process.env.LOCALAPPDATA, 'MyWallpaper', 'Addons', 'Mail', 'preview')
const paths = await runtimePaths(directory)
const session = new Session(new Vault(directory), [new PhpEngine(paths), new PhpEngine(paths)])
await session.open()
const server = createServer((_request, response) => { response.writeHead(404); response.end() })
const sockets = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false })
server.on('upgrade', (request, socket, head) => {
  if (!['http://localhost:5192', 'http://127.0.0.1:5192'].includes(request.headers.origin ?? '') || sockets.clients.size >= 2) { socket.destroy(); return }
  sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client, request))
})
sockets.on('connection', socket => {
  socket.on('message', bytes => {
    let input: unknown
    try { input = JSON.parse(bytes.toString()) } catch { socket.close(1008); return }
    void session.handle(input).then(result => { if (result && socket.readyState === socket.OPEN) socket.send(JSON.stringify(result)) }).catch(() => socket.close(1011))
  })
  socket.on('error', () => {})
})
let closing = false
async function close() { if (closing) return; closing = true; sockets.clients.forEach(socket => socket.close()); sockets.close(); server.close(); await session.close() }
process.once('SIGTERM', () => { void close() }); process.once('SIGINT', () => { void close() })
server.on('error', () => { void close(); process.exitCode = 1 })
server.listen(5193, '127.0.0.1', () => console.log('Local Mail bridge: 127.0.0.1:5193 · Windows-protected credentials'))
