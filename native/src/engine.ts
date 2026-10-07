import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAsset, isSea } from 'node:sea'
import { unzipSync } from 'fflate'
import { StringDecoder } from 'node:string_decoder'
import { ActionError } from '../../shared/protocol.js'

export interface Engine { request<T>(action: string, account: Record<string, unknown>, input?: Record<string, unknown>): Promise<T>; close(): void }
export interface EnginePaths { executable: string; directory: string; extensions: string; certificates: string }

export async function runtimePaths(directory: string): Promise<EnginePaths> {
  if (!isSea()) {
    const base = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    if (process.platform !== 'win32') return { executable: process.env.MAIL_PHP_EXECUTABLE ?? 'php', directory: base, extensions: '', certificates: join(base, 'php', 'cacert.pem') }
    return { executable: join(base, '.build', 'php', 'php.exe'), directory: base, extensions: join(base, '.build', 'php', 'ext'), certificates: join(base, 'php', 'cacert.pem') }
  }
  const php = Buffer.from(getAsset('php.zip'))
  const files = JSON.parse(Buffer.from(getAsset('mail-files.json')).toString()) as Record<string, string>
  const digest = createHash('sha256').update(php).update(JSON.stringify(files)).digest('hex')
  const base = join(directory, 'runtime', digest)
  try { if (await readFile(join(base, '.complete'), 'utf8') !== digest) throw new Error('incomplete') }
  catch {
    const staging = `${base}.${process.pid}.tmp`
    await mkdir(staging, { recursive: true, mode: 0o700 })
    // Every shipped archive is pinned at build time; still validate extraction
    // paths so an update can never escape the add-on's private runtime directory.
    const extracted = unzipSync(php, { filter: file => /^(php\.exe|php8\.dll|libcrypto-3-x64\.dll|libssl-3-x64\.dll|ext\/php_mbstring\.dll|ext\/php_openssl\.dll|license\.txt|readme-redist-bins\.txt)$/.test(file.name) })
    for (const [name, bytes] of Object.entries(extracted)) {
      const path = join(staging, 'php-runtime', name)
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { mode: 0o600 })
    }
    for (const [name, source] of Object.entries(files)) {
      if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.split('/').includes('..') || name.startsWith('/')) throw new ActionError('runtime-unavailable')
      const path = join(staging, name)
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, source, { mode: 0o600 })
    }
    await writeFile(join(staging, '.complete'), digest, { mode: 0o600 })
    await mkdir(dirname(base), { recursive: true })
    try { await rename(staging, base) } catch (error) { await rm(staging, { recursive: true, force: true }); if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  return { executable: join(base, 'php-runtime', 'php.exe'), directory: base, extensions: join(base, 'php-runtime', 'ext'), certificates: join(base, 'php', 'cacert.pem') }
}

export class PhpEngine implements Engine {
  private child: ChildProcessWithoutNullStreams | undefined
  private pending: { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined
  private output = ''
  private queue = Promise.resolve()
  private stopped = false
  constructor(private paths: EnginePaths) {}
  private start() {
    if (this.child) return this.child
    const paths = this.paths
    const child = spawn(paths.executable, [
      '-n', ...(paths.extensions ? ['-d', `extension_dir=${paths.extensions.replaceAll('\\', '/')}`] : []),
      '-d', 'extension=mbstring', ...(paths.extensions ? ['-d', 'extension=openssl'] : []),
      '-d', `openssl.cafile=${paths.certificates.replaceAll('\\', '/')}`, '-d', 'memory_limit=96M',
      '-d', 'display_errors=0', '-d', 'log_errors=0', join(paths.directory, 'php', 'worker.php'),
    ], { stdio: ['pipe', 'pipe', 'pipe'], cwd: paths.directory, windowsHide: true })
    this.child = child; this.output = ''
    const decoder = new StringDecoder('utf8')
    // PHP error text can contain server names or credentials. Never forward it.
    child.stderr.resume()
    child.stdout.on('data', bytes => {
      if (this.child !== child) return
      this.output += decoder.write(bytes)
      if (this.output.length > 4 * 1024 * 1024) { this.fail('engine-error'); return }
      const newline = this.output.indexOf('\n')
      if (newline < 0) return
      const line = this.output.slice(0, newline); this.output = this.output.slice(newline + 1)
      const pending = this.pending
      if (!pending) { this.fail('engine-error'); return }
      this.pending = undefined; clearTimeout(pending.timer)
      try {
        const result = JSON.parse(line)
        result.ok ? pending.resolve(result.result) : pending.reject(new ActionError(typeof result.error === 'string' ? result.error : 'engine-error'))
      } catch { pending.reject(new ActionError('engine-error')); this.fail('engine-error') }
    })
    child.once('error', () => { if (this.child === child) this.fail('runtime-unavailable') })
    child.once('exit', code => { if (this.child === child) this.fail(code === 0xc0000135 || code === 0xc000007b ? 'runtime-unavailable' : 'engine-error') })
    child.stdin.on('error', () => { if (this.child === child) this.fail('engine-error') })
    return child
  }
  private fail(code: string) {
    const child = this.child; this.child = undefined; child?.kill()
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new ActionError(code)); this.pending = undefined }
    this.output = ''
  }
  request<T>(action: string, account: Record<string, unknown>, input: Record<string, unknown> = {}): Promise<T> {
    const task = this.queue.then(() => {
      if (this.stopped) throw new ActionError('offline')
      const child = this.start()
      return new Promise<T>((resolve, reject) => {
        this.pending = { resolve: value => resolve(value as T), reject, timer: setTimeout(() => this.fail(action === 'send' ? 'send-unconfirmed' : 'timeout'), 35_000) }
        child.stdin.write(`${JSON.stringify({ action, account, input })}\n`, error => { if (error && this.child === child) this.fail(action === 'send' ? 'send-unconfirmed' : 'engine-error') })
      })
    })
    this.queue = task.then(() => {}, () => {})
    return task
  }
  close() { this.stopped = true; this.fail('offline') }
}
