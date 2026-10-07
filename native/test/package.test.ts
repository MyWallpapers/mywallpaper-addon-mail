import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..')
for (const version of [4, 5]) test(`packaged companion process-v2 v${version}: initialize, RPC, PHP startup and shutdown`, { skip: process.platform !== 'win32' }, async t => {
  const executable = join(base, 'out', 'windows-x86_64', 'bin', 'mail.exe')
  await access(executable)
  const addonId = `mail-package-fixture-${version}-${process.pid}`
  const privateRoot = join(process.env.LOCALAPPDATA!, 'MyWallpaper', 'Addons', 'Mail')
  const directory = join(privateRoot, createHash('sha256').update(addonId).digest('hex'))
  assert.equal(dirname(directory), privateRoot)
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  let output = Buffer.alloc(0)
  const records: unknown[] = []; let pending: { resolve: (value: any) => void; reject: (error: Error) => void } | undefined
  child.stdout.on('data', bytes => {
    output = Buffer.concat([output, bytes])
    while (output.length >= 4) {
      const size = output.readUInt32LE(0); if (size > 1024 * 1024) { pending?.reject(new Error('Invalid fixture output')); child.kill(); return }
      if (output.length < size + 4) break
      const record = JSON.parse(output.subarray(4, size + 4).toString()); output = output.subarray(size + 4)
      if (pending) { const current = pending; pending = undefined; current.resolve(record) } else records.push(record)
    }
  })
  child.on('error', error => pending?.reject(error)); child.on('exit', code => { if (pending) pending.reject(new Error(`Companion exited with ${code}`)) })
  const next = () => records.length ? Promise.resolve(records.shift() as any) : new Promise<any>((resolve, reject) => { pending = { resolve, reject } })
  function send(frame: unknown) { const bytes = Buffer.from(JSON.stringify(frame)); const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); child.stdin.write(Buffer.concat([header, bytes])) }
  const timeout = setTimeout(() => { pending?.reject(new Error('Packaged companion timeout')); child.kill() }, 45_000)
  t.after(async () => { clearTimeout(timeout); child.kill(); await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()) }); await rm(directory, { recursive: true, force: true }) })
  const started = performance.now()
  send({ type: 'init', v: version, addonId, scratchDirectory: join(base, '.build', 'package-fixture') })
  assert.deepEqual(await next(), { type: 'ready', v: version })
  const initializationMs = performance.now() - started
  assert.ok(initializationMs < 2_000, 'The process-v2 channel must be ready within the host handshake deadline')
  t.diagnostic(`Cold packaged initialization: ${Math.round(initializationMs)} ms`)
  send({ type: 'message', v: version, payload: { kind: 'mail.command', requestId: 'snapshot', action: 'snapshot', input: {} } })
  assert.deepEqual((await next()).payload, { kind: 'mail.result', requestId: 'snapshot', ok: true, result: { accounts: [] } })
  send({ type: 'message', v: version, payload: { kind: 'mail.command', requestId: 'php-probe', action: 'add-account', input: { name: 'Fixture', email: 'fixture@example.com', username: 'fixture', password: 'disposable-test-value', imapHost: '127.0.0.1', imapPort: 1 } } })
  assert.equal((await next()).payload.error, 'account-unavailable', 'Bundled PHP must load and attempt authenticated TLS, rather than fail to start')
  const exit = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
  send({ type: 'shutdown', v: version }); child.stdin.end(); assert.equal(await exit, 0)
})
