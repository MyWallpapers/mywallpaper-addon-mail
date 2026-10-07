import './styles.css'
import { RpcClient } from './client'
import { createDemoClient } from './demo'
import { createWidget } from './widget'
const params = new URLSearchParams(location.search)
const demo = params.get('demo') === '1'
document.documentElement.lang = navigator.language.startsWith('fr') ? 'fr' : 'en'
const style = document.createElement('style'); style.textContent = `html,body{box-sizing:border-box;margin:0;min-height:100%;background:#141e2b}body{display:grid;place-items:center;min-height:100dvh;padding:24px;background:radial-gradient(ellipse at 20% 20%,#32495d66,transparent 65%),radial-gradient(ellipse at 85% 75%,#44385366,transparent 60%),#111821}#preview{width:min(920px,100%);height:min(640px,calc(100dvh - 48px))}body[data-narrow] #preview{width:min(360px,100%)}@media(max-width:480px){body{padding:12px}#preview{height:calc(100dvh - 24px)}}`; document.head.append(style)
if (params.get('wide') !== '1') document.body.dataset.narrow = ''
const root = document.querySelector<HTMLElement>('#preview')!
let socket: WebSocket | undefined
const client = demo ? createDemoClient() : new RpcClient(async command => {
  if (!socket) throw new Error('offline')
  if (socket.readyState === WebSocket.CONNECTING) await new Promise<void>((resolve, reject) => { socket!.addEventListener('open', () => resolve(), { once: true }); socket!.addEventListener('error', () => reject(new Error('offline')), { once: true }) })
  if (socket.readyState !== WebSocket.OPEN) throw new Error('offline'); socket.send(JSON.stringify(command))
}, () => socket?.close())
if (!demo) { socket = new WebSocket(`ws://${location.hostname}:5193`); socket.addEventListener('message', event => { try { (client as RpcClient).receive(JSON.parse(event.data)) } catch {} }) }
const widget = createWidget(root, client, { opacity: .88, blur: 16, language: params.get('lang') ?? 'auto' }, demo)
window.addEventListener('pagehide', () => { widget.dispose(); client.close() }, { once: true })
