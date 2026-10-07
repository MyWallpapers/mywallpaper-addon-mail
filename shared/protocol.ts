export type Action = 'snapshot' | 'add-account' | 'remove-account' | 'list' | 'read' | 'flag' | 'send' | 'attachment'
export type Filter = 'all' | 'unread' | 'starred'
export interface Account { id: string; name: string; email: string; color: string; status: 'ready' | 'error'; error?: string; smtp: boolean }
export interface AccountInput { name: string; email: string; username: string; password: string; imapHost: string; imapPort: number; smtpHost?: string; smtpPort?: number }
export interface Message { accountId: string; uid: number; validity: number; subject: string; from: string; to: string; date: number; read: boolean; starred: boolean; size: number; messageId: string }
export interface Attachment { part: string; name: string; size: number; type: string }
export interface MessageDetail { message: Message; body: string; attachments: Attachment[]; truncated: boolean }
export interface Page { messages: Message[]; cursor: Record<string, number>; accounts: Account[] }
export interface Command { kind: 'mail.command'; requestId: string; action: Action; input: Record<string, unknown> }
export interface Result { kind: 'mail.result'; requestId: string; ok: boolean; result?: unknown; error?: string }
export class ActionError extends Error { constructor(readonly code: string) { super(code); this.name = 'ActionError' } }
export interface MailClient { request<T>(action: Action, input?: Record<string, unknown>): Promise<T>; close(): void }
