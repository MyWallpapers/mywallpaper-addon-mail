import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { ActionError, type Account, type AccountInput, type Command, type Page, type MessageDetail, type Result } from '../../shared/protocol.js'
import type { Engine } from './engine.js'
import { Vault } from './vault.js'

interface StoredAccount extends AccountInput { id: string; color: string }
const colors = ['#9ccfea', '#d2b5ed', '#abd8c5', '#f0c595', '#ebacc3']
const maxAccounts = 10
const validActions = new Set(['snapshot', 'add-account', 'remove-account', 'list', 'read', 'flag', 'send', 'attachment'])
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ActionError('invalid-input'); return value as Record<string, unknown> }
function field(value: unknown, max: number, empty = false): string { if (typeof value !== 'string' || value.length > max || !empty && !value.trim() || /[\r\n\0]/.test(value)) throw new ActionError('invalid-input'); return value.trim() }
function integer(value: unknown, max = 0xffffffff): number { if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new ActionError('invalid-input'); return value as number }
function hostname(value: unknown): string { const host = field(value, 253).toLowerCase(); if (!isIP(host) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) throw new ActionError('invalid-input'); if (host.includes('..')) throw new ActionError('invalid-input'); return host }
export function emailAddress(value: unknown): string { const email = field(value, 254); if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(email)) throw new ActionError('invalid-input'); return email }
export function accountInput(value: unknown): AccountInput {
  const input = record(value)
  field(input.password, 1024)
  const password = input.password as string
  return { name: field(input.name, 80), email: emailAddress(input.email), username: field(input.username, 254), password,
    imapHost: hostname(input.imapHost), imapPort: integer(input.imapPort, 65535),
    ...(input.smtpHost ? { smtpHost: hostname(input.smtpHost), smtpPort: integer(input.smtpPort, 65535) } : {}) }
}
function errorCode(error: unknown) { return error instanceof ActionError ? error.code : 'request-failed' }
export class Session {
  private accounts: StoredAccount[] = []
  private health = new Map<string, string>()
  private pending = 0
  private stopped = false
  private mutations = Promise.resolve()
  private engines: Engine[]
  constructor(private vault: Vault, engines: Engine[]) { this.engines = engines }
  async open() {
    await this.vault.open()
    const source = await this.vault.read('auth')
    if (source) {
      const value = JSON.parse(source)
      if (!Array.isArray(value) || value.length > maxAccounts) throw new ActionError('storage-failed')
      this.accounts = value.map(raw => { const item = record(raw); return { ...accountInput(item), id: field(item.id, 64), color: colors.includes(item.color as string) ? item.color as string : colors[0] } })
    }
  }
  private publicAccounts(): Account[] { return this.accounts.map(account => ({ id: account.id, name: account.name, email: account.email, color: account.color, smtp: !!account.smtpHost, status: this.health.has(account.id) ? 'error' : 'ready', ...(this.health.has(account.id) ? { error: this.health.get(account.id) } : {}) })) }
  private async persist() { await this.vault.write('auth', JSON.stringify(this.accounts)) }
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation)
    this.mutations = result.then(() => {}, () => {})
    return result
  }
  async handle(raw: unknown): Promise<Result | undefined> {
    if (this.stopped) return
    let command: Command
    try {
      const value = record(raw)
      if (value.kind !== 'mail.command' || !validActions.has(value.action as string)) return
      command = { kind: 'mail.command', action: value.action as Command['action'], requestId: field(value.requestId, 80), input: record(value.input) }
    } catch { return }
    if (this.pending >= 8) return { kind: 'mail.result', requestId: command.requestId, ok: false, error: 'busy' }
    this.pending++
    try { const result = await this.execute(command); return { kind: 'mail.result', requestId: command.requestId, ok: true, result } }
    catch (error) { return { kind: 'mail.result', requestId: command.requestId, ok: false, error: errorCode(error) } }
    finally { this.pending-- }
  }
  private async execute({ action, input }: Command): Promise<unknown> {
    if (action === 'snapshot') return { accounts: this.publicAccounts() }
    if (action === 'add-account') return this.mutate(async () => {
      if (this.accounts.length >= maxAccounts) throw new ActionError('account-limit')
      const parsed = accountInput(input)
      if (this.accounts.some(a => a.email.toLowerCase() === parsed.email.toLowerCase() && a.imapHost === parsed.imapHost)) throw new ActionError('account-exists')
      const account = { ...parsed, id: randomUUID(), color: colors[this.accounts.length % colors.length] }
      await this.engines[0].request('check', { ...account })
      if (this.stopped) throw new ActionError('offline')
      this.accounts.push(account)
      try { await this.persist() } catch (error) { this.accounts.pop(); throw error }
      return { accounts: this.publicAccounts() }
    })
    if (action === 'remove-account') return this.mutate(async () => {
      const id = field(input.accountId, 64)
      if (!this.accounts.some(a => a.id === id)) throw new ActionError('account-missing')
      const previous = this.accounts
      this.accounts = previous.filter(a => a.id !== id)
      try { await this.persist() } catch (error) { this.accounts = previous; throw error }
      this.health.delete(id)
      return { accounts: this.publicAccounts() }
    })
    if (action === 'list') {
      const filter = input.filter ?? 'all'
      if (!['all', 'unread', 'starred'].includes(filter as string)) throw new ActionError('invalid-input')
      const cursor = input.cursor ? record(input.cursor) : undefined
      const selected = input.accountId ? this.accounts.filter(a => a.id === field(input.accountId, 64)) : [...this.accounts]
      if (input.accountId && !selected.length) throw new ActionError('account-missing')
      const page: Page = { messages: [], cursor: {}, accounts: [] }
      const tasks = selected.map(async (account, index) => {
        const before = cursor?.[account.id]
        if (before === 0) { page.cursor[account.id] = 0; return }
        if (before !== undefined) integer(before)
        try {
          const batch = await this.engines[index % this.engines.length].request<{ messages: Page['messages']; cursor: number }>('list', { ...account }, { filter, ...(before !== undefined ? { before } : {}) })
          if (!this.accounts.some(a => a.id === account.id)) return
          page.messages.push(...batch.messages); page.cursor[account.id] = batch.cursor; this.health.delete(account.id)
        } catch (error) { page.cursor[account.id] = 0; this.health.set(account.id, errorCode(error)) }
      })
      await Promise.all(tasks)
      if (this.stopped) throw new ActionError('offline')
      page.messages.sort((a, b) => b.date - a.date || b.uid - a.uid); page.accounts = this.publicAccounts()
      return page
    }
    const account = this.accounts.find(a => a.id === input.accountId)
    if (!account) throw new ActionError('account-missing')
    const engine = this.engines[this.accounts.indexOf(account) % this.engines.length]
    if (action === 'send') {
      const to = typeof input.to === 'string' ? input.to.split(',').map(v => emailAddress(v)) : []
      if (!to.length || to.length > 20 || typeof input.body !== 'string' || !input.body.trim() || input.body.length > 100_000 || input.body.includes('\0')) throw new ActionError('invalid-input')
      const subject = field(input.subject, 300, true)
      const inReplyTo = input.inReplyTo ? field(input.inReplyTo, 900) : undefined
      return engine.request('send', { ...account }, { to, subject, body: input.body, ...(inReplyTo ? { inReplyTo } : {}) })
    }
    const target: Record<string, unknown> = { uid: integer(input.uid), validity: integer(input.validity) }
    if (action === 'flag') { if (typeof input.flag !== 'boolean') throw new ActionError('invalid-input'); target.flag = input.flag }
    if (action === 'attachment') { const part = field(input.part, 80); if (!/^\d+(\.\d+)*$/.test(part)) throw new ActionError('invalid-input'); target.part = part }
    const result = await engine.request<MessageDetail>(action, { ...account }, target)
    if (!this.accounts.some(a => a.id === account.id)) throw new ActionError('account-missing')
    return result
  }
  async close() { this.stopped = true; this.engines.forEach(engine => engine.close()); await this.mutations; this.accounts.forEach(a => { a.password = '' }); this.accounts = []; await this.vault.close() }
}
