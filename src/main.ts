import './styles.css'
import type { CanvasAddonMountContext } from '../generated/mywallpaper-runtime'
import { createNativeClient } from './client'
import { createDemoClient } from './demo'
import { createWidget } from './widget'

export function mount({ layer, runtime }: CanvasAddonMountContext): () => void {
  const demo = runtime.mode === 'thumbnail'
  const client = demo ? createDemoClient() : createNativeClient(layer)
  const widget = createWidget(layer.root, client, layer.settings.get(), demo)
  const unsubscribe = layer.settings.subscribe(settings => widget.configure(settings))
  let disposed = false
  const cleanup = () => { if (disposed) return; disposed = true; unsubscribe(); widget.dispose(); client.close() }
  const stopDispose = layer.lifecycle.onDispose(cleanup)
  return () => { stopDispose(); cleanup() }
}
