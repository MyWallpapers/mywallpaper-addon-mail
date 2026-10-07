import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { accountInput, Session } from '../src/session.js'
import { PhpEngine, runtimePaths, type Engine } from '../src/engine.js'
import { Vault } from '../src/vault.js'
import { ActionError, type MessageDetail, type Page } from '../../shared/protocol.js'
import { mailServer } from './mail-server.js'

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const input = { name: 'Test', email: 'reader@example.com', username: 'reader@example.com', password: ' test password ', imapHost: 'localhost', imapPort: 993 }
test('account boundaries preserve passwords and reject header/protocol injection', () => {
  assert.equal(accountInput(input).password, input.password)
  for (const invalid of [{ email: 'reader@example.com\r\nBcc: other@example.com' }, { imapHost: 'tls://localhost' }, { imapPort: 0 }, { password: 'a\0b' }]) assert.throws(() => accountInput({ ...input, ...invalid }), ActionError)
})
test('session redacts secrets, paginates and preserves account failures', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'mywallpaper-mail-test-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const calls: string[] = []
  const engine: Engine = { async request<T>(action: string, account: Record<string, unknown>) { calls.push(action); if (account.imapHost === 'unavailable.example' && action === 'list') throw new ActionError('account-unavailable'); return (action === 'list' ? { messages: [], cursor: 980 } : { ready: true }) as T }, close() {} }
  const session = new Session(new Vault(scratch), [engine]); await session.open(); t.after(() => session.close())
  const execute = (action: string, value = {}) => session.handle({ kind: 'mail.command', requestId: action, action, input: value })
  assert.equal((await execute('add-account', input))?.ok, true)
  const snapshot = await execute('snapshot'); assert.ok(snapshot?.ok)
  const source = JSON.stringify(snapshot); assert.ok(!source.includes(input.password)); assert.ok(!source.includes('imapHost')); assert.ok(!source.includes('username'))
  assert.ok(!(await readFile(join(scratch, 'auth.bin'))).includes(Buffer.from(input.password)))
  await execute('add-account', { ...input, email: 'other@example.com', imapHost: 'unavailable.example' })
  const list = (await execute('list', { filter: 'all' }))?.result as Page; assert.equal(list.accounts.filter(a => a.status === 'error').length, 1); assert.equal(Object.values(list.cursor).includes(980), true)
  const before = calls.length; await execute('list', { cursor: Object.fromEntries(list.accounts.map(a => [a.id, 0])) }); assert.equal(calls.length, before)
  assert.equal((await execute('send', { accountId: list.accounts[0].id, to: 'victim@example.com\r\nBcc: bad@example.com', subject: 'Test', body: 'Test' }))?.error, 'invalid-input')
})
test('Cypht over verified TLS: bounded inbox, MIME, attachment, flags, SMTP and certificate refusal', { skip: process.platform !== 'win32' }, async t => {
  const imap = await mailServer(join(base, 'test'), 'imap'); const smtp = await mailServer(join(base, 'test'), 'smtp')
  t.after(() => Promise.all([imap.close(), smtp.close()]))
  const paths = await runtimePaths(join(base, '.build', 'probe'))
  const engine = new PhpEngine({ ...paths, certificates: join(base, 'test', 'fixtures', 'localhost-cert.pem') }); t.after(() => engine.close())
  const account = { ...input, id: 'test', imapPort: imap.port, smtpHost: 'localhost', smtpPort: smtp.port }
  await engine.request('check', account)
  const page = await engine.request<{ messages: Page['messages']; cursor: number }>('list', account, { filter: 'all' })
  assert.equal(page.messages.length, 20, JSON.stringify({ page, commands: imap.commands })); assert.equal(page.cursor, 980); assert.ok(page.messages.every(m => m.subject.includes('Café') && m.validity === 42)); assert.ok(imap.commands.filter(c => c.includes('HEADER.FIELDS')).every(c => c.split(' ')[3].split(',').length <= 20))
  const next = await engine.request<{ messages: Page['messages']; cursor: number }>('list', account, { filter: 'all', before: page.cursor }); assert.equal(next.messages.length, 20); assert.equal(next.cursor, 960)
  const detail = await engine.request<MessageDetail>('read', account, { uid: 1000, validity: 42 }); assert.match(detail.body, /Bonjour Alex/); assert.equal(detail.attachments[0]?.name, 'notes.txt'); assert.equal(detail.message.read, true)
  const file = await engine.request<{ bytes: string }>('attachment', account, { uid: 1000, validity: 42, part: '2' }); assert.equal(Buffer.from(file.bytes, 'base64').toString(), 'Test attachment\n')
  assert.deepEqual(await engine.request('flag', account, { uid: 1000, validity: 42, flag: true }), { starred: true })
  await assert.rejects(engine.request('read', account, { uid: 1000, validity: 99 }), (error: unknown) => error instanceof ActionError && error.code === 'mailbox-changed')
  assert.deepEqual(await engine.request('send', account, { to: ['recipient@example.com'], subject: 'Café', body: 'Hello\n.\nThis must not terminate SMTP.' }), { sent: true }); assert.equal(smtp.sent.length, 1); assert.match(smtp.sent[0], /Content-Transfer-Encoding: base64/); assert.ok(smtp.sent[0].includes(Buffer.from('Café').toString('base64')))
  const untrusted = new PhpEngine(paths); t.after(() => untrusted.close()); const before = imap.commands.length
  await assert.rejects(untrusted.request('check', account), (error: unknown) => error instanceof ActionError && error.code === 'account-unavailable'); assert.equal(imap.commands.length, before, 'No credentials sent before verifying the certificate')
})
