import { ActionError, type Account, type Attachment, type Filter, type MailClient, type Message, type MessageDetail, type Page } from '../shared/protocol'
import { icon, type IconName } from './icons'
import { strings, type en } from './i18n'

type Copy = typeof en
type Settings = Record<string, unknown>
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const node = document.createElement(tag); node.className = className; if (text) node.textContent = text; return node
}
function button(label: string, callback: () => void, className = '', symbol?: IconName) {
  const node = element('button', className); node.type = 'button'; node.title = label; node.setAttribute('aria-label', label)
  if (symbol) node.append(icon(symbol))
  if (!symbol || !className.includes('icon-button')) node.append(document.createTextNode(label))
  node.addEventListener('click', callback); return node
}
function inputField(form: HTMLElement, label: string, name: string, value = '', type = 'text') {
  const wrapper = element('label', 'field'); wrapper.append(element('span', '', label))
  const input = element('input'); input.name = name; input.type = type; input.value = value
  wrapper.append(input); form.append(wrapper); return input
}
function key(message: Message) { return `${message.accountId}:${message.validity}:${message.uid}` }
function sender(value: string) { return value.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '') || value }
function address(value: string) { return value.match(/<([^<>]+)>/)?.[1] ?? value }
function target(message: Message) { return { accountId: message.accountId, uid: message.uid, validity: message.validity } }

export function createWidget(root: HTMLElement, client: MailClient, initial: Settings, demo = false) {
  let settings = initial; let copy = strings(settings.language)
  let accounts: Account[] = []; let messages: Message[] = []; let cursor: Page['cursor'] = {}
  let activeAccount = ''; let filter: Filter = 'all'; let search = ''; let detail: MessageDetail | undefined
  let loading = false; let reloadRequested = false; let listRevision = 0; let readRevision = 0; let stopped = false; let available = true
  let modal: HTMLDialogElement | undefined; let modalReturn: HTMLElement | null = null
  const widget = element('section', 'mail-widget'); widget.setAttribute('aria-label', copy.title)
  const header = element('header', 'mail-header')
  const brand = element('div', 'mail-brand'); brand.append(icon('mail'), element('h1', '', copy.title))
  const accountSelect = element('select', 'account-select'); accountSelect.setAttribute('aria-label', copy.accounts)
  accountSelect.addEventListener('change', () => { activeAccount = accountSelect.value; detail = undefined; readRevision++; renderReader(); void load() })
  const composeButton = button(copy.compose, () => compose(), 'icon-button', 'compose')
  const refreshButton = button(copy.refresh, () => { void load() }, 'icon-button', 'refresh')
  const accountsButton = button(copy.accounts, () => accountManager(), 'icon-button', 'accounts')
  const actions = element('div', 'header-actions'); actions.append(composeButton, refreshButton, accountsButton)
  header.append(brand, accountSelect, actions)
  const preview = element('div', 'demo-label', copy.demoDetail); preview.hidden = !demo
  const notice = element('div', 'mail-notice'); notice.setAttribute('role', 'status'); notice.hidden = true
  const workspace = element('div', 'mail-workspace')
  const inbox = element('div', 'inbox-pane')
  const toolbar = element('div', 'inbox-toolbar'); const tabs = element('div', 'mail-tabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', copy.inbox)
  const tabButtons = (['all', 'unread', 'starred'] as Filter[]).map(value => {
    const node = button(value === 'all' ? copy.inbox : copy[value], () => {
      if (filter === value) return; filter = value; tabButtons.forEach((b, i) => b.setAttribute('aria-pressed', String((['all', 'unread', 'starred'] as Filter[])[i] === value))); void load()
    }, 'tab')
    node.setAttribute('aria-pressed', String(value === filter)); tabs.append(node); return node
  })
  const searchWrapper = element('label', 'mail-search'); searchWrapper.append(icon('search'))
  const searchInput = element('input'); searchInput.type = 'search'; searchInput.placeholder = copy.search; searchInput.setAttribute('aria-label', copy.search)
  searchInput.addEventListener('input', () => { search = searchInput.value; renderList() }); searchWrapper.append(searchInput)
  toolbar.append(tabs, searchWrapper)
  const list = element('div', 'message-list'); list.setAttribute('aria-label', copy.inbox)
  const listContent = element('div'); const moreButton = button(copy.more, () => { void load(true) }, 'load-more')
  list.append(listContent, moreButton); inbox.append(toolbar, list)
  const reader = element('article', 'reader-pane'); workspace.append(inbox, reader)
  widget.append(header, preview, notice, workspace); root.replaceChildren(widget)

  function errorText(error: unknown) {
    const code = error instanceof ActionError ? error.code : 'request-failed'
    return copy.errors[code as keyof Copy['errors']] ?? copy.errors['request-failed']
  }
  function notify(text: string, kind: 'error' | 'info' = 'error') { if (stopped) return; notice.textContent = text; notice.dataset.kind = kind; notice.hidden = !text }
  function updateAccounts() {
    const previous = activeAccount
    accountSelect.replaceChildren(new Option(copy.allAccounts, ''), ...accounts.map(account => new Option(account.name, account.id)))
    if (!accounts.some(a => a.id === previous)) activeAccount = ''
    accountSelect.value = activeAccount; accountSelect.hidden = !accounts.length
    composeButton.disabled = !available || !accounts.some(a => a.smtp); refreshButton.disabled = loading || !available || !accounts.length
    accountsButton.disabled = !available || demo
  }
  function renderList() {
    if (stopped) return
    refreshButton.classList.toggle('spinning', loading); refreshButton.disabled = loading || !available || !accounts.length
    moreButton.hidden = !accounts.length || !Object.values(cursor).some(v => v > 0); moreButton.disabled = loading
    list.setAttribute('aria-busy', String(loading))
    listContent.replaceChildren()
    if (!accounts.length) {
      const empty = element('div', 'empty-inbox'); empty.append(icon('mail'), element('h2', '', copy.intro), element('p', '', copy.introDetail))
      if (available && !demo) empty.append(button(copy.setup, () => accountManager(true), 'primary-button'))
      empty.append(element('small', '', copy.local)); listContent.append(empty); widget.dataset.view = 'setup'; return
    }
    widget.dataset.view = detail ? 'reader' : 'inbox'
    const query = search.trim().toLocaleLowerCase()
    const visible = messages.filter(message => !query || `${message.from} ${message.subject} ${message.to}`.toLocaleLowerCase().includes(query))
    if (!visible.length) { listContent.append(element('div', 'empty-list', loading ? copy.loading : query ? copy.noResults : copy.noMail)); return }
    const fragment = document.createDocumentFragment()
    visible.forEach(message => {
      const account = accounts.find(a => a.id === message.accountId)
      const row = element('div', 'message-row'); row.dataset.read = String(message.read); row.dataset.active = String(detail && key(detail.message) === key(message)); row.style.setProperty('--account-color', account?.color ?? '#9ccfea')
      const open = button(message.subject || copy.noSubject, () => { void read(message) }, 'message-open')
      const top = element('div', 'message-line'); const name = element('span', 'message-sender', sender(message.from)); const time = element('time', '', new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(message.date * 1000))
      time.dateTime = new Date(message.date * 1000).toISOString(); top.append(name, time)
      const subject = element('span', 'message-subject', message.subject || copy.noSubject)
      const meta = element('span', 'message-account', account?.name ?? ''); open.replaceChildren(top, subject, meta)
      const favorite = button(message.starred ? copy.unstar : copy.star, () => { void star(message, favorite) }, 'icon-button star-button', 'star'); favorite.setAttribute('aria-pressed', String(message.starred))
      row.append(open, favorite); fragment.append(row)
    })
    listContent.append(fragment)
  }
  function renderReader() {
    if (stopped) return
    reader.replaceChildren(); widget.dataset.view = !accounts.length ? 'setup' : detail ? 'reader' : 'inbox'
    if (!detail) { const empty = element('div', 'reader-empty'); empty.append(icon('mail'), element('h2', '', copy.choose), element('p', '', copy.chooseDetail)); reader.append(empty); return }
    const current = detail; const account = accounts.find(a => a.id === current.message.accountId)
    const controls = element('div', 'reader-controls')
    const back = button(copy.back, () => { readRevision++; detail = undefined; renderReader(); renderList() }, 'icon-button reader-back', 'back')
    const tag = element('span', 'account-tag', account?.name ?? ''); tag.style.setProperty('--account-color', account?.color ?? '#9ccfea')
    const reply = button(copy.reply, () => compose(current.message), 'quiet-button', 'back'); reply.disabled = !account?.smtp; if (reply.disabled) reply.title = copy.readOnly
    controls.append(back, tag, reply)
    const content = element('div', 'reader-content'); content.append(element('h2', 'reader-subject', current.message.subject || copy.noSubject))
    const from = element('div', 'reader-from', sender(current.message.from)); const fullAddress = element('span', '', address(current.message.from)); if (sender(current.message.from) !== fullAddress.textContent) from.append(fullAddress)
    const date = element('time', 'reader-date', new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(current.message.date * 1000)); date.dateTime = new Date(current.message.date * 1000).toISOString()
    content.append(from, date, element('div', 'reader-body', current.body || copy.noText))
    if (current.truncated) content.append(element('p', 'reader-hint', copy.truncated))
    if (current.attachments.length) {
      const files = element('div', 'attachments'); current.attachments.forEach(file => {
        const node = button(file.name, () => { void download(current.message, file, node) }, 'attachment', 'attach'); node.disabled = file.size > 2 * 1024 * 1024; files.append(node)
      }); content.append(files, element('small', 'reader-hint', copy.attachmentLimit))
    }
    reader.append(controls, content)
  }
  async function load(append = false) {
    if (stopped) return
    // Coalesce fast filter/account changes instead of filling the native queue.
    if (loading) { if (!append) { listRevision++; reloadRequested = true } return }
    const revision = ++listRevision; loading = true; notify(''); renderList()
    const scroll = list.scrollTop
    try {
      const page = await client.request<Page>('list', { filter, ...(activeAccount ? { accountId: activeAccount } : {}), ...(append ? { cursor } : {}) })
      if (stopped || revision !== listRevision) return
      const combined = append ? [...messages, ...page.messages] : page.messages
      messages = [...new Map(combined.map(message => [key(message), message])).values()].sort((a, b) => b.date - a.date || b.uid - a.uid)
      cursor = page.cursor; accounts = page.accounts; updateAccounts()
      if (accounts.some(a => a.status === 'error')) notify(copy.unavailable)
      if (!append) list.scrollTop = 0
    } catch (error) { if (!stopped && revision === listRevision) notify(errorText(error)) }
    finally {
      if (!stopped) {
        loading = false
        if (reloadRequested) { reloadRequested = false; void load() }
        else if (revision === listRevision) { renderList(); if (append) list.scrollTop = scroll }
      }
    }
  }
  async function read(message: Message) {
    const revision = ++readRevision; notify(''); reader.setAttribute('aria-busy', 'true')
    try {
      const value = await client.request<MessageDetail>('read', target(message))
      if (stopped || revision !== readRevision) return
      detail = value; messages.forEach(m => { if (key(m) === key(message)) m.read = value.message.read }); renderReader(); renderList()
    } catch (error) { if (!stopped && revision === readRevision) notify(errorText(error)) }
    finally { if (revision === readRevision) reader.setAttribute('aria-busy', 'false') }
  }
  async function star(message: Message, node: HTMLButtonElement) {
    node.disabled = true
    try { const result = await client.request<{ starred: boolean }>('flag', { ...target(message), flag: !message.starred }); message.starred = result.starred; if (detail && key(detail.message) === key(message)) detail.message.starred = result.starred; renderList() }
    catch (error) { notify(errorText(error)); node.disabled = false }
  }
  async function download(message: Message, attachment: Attachment, node: HTMLButtonElement) {
    node.disabled = true
    try {
      const file = await client.request<{ bytes: string }>('attachment', { ...target(message), part: attachment.part })
      if (stopped) return
      const bytes = Uint8Array.from(atob(file.bytes), c => c.charCodeAt(0)); const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
      const link = element('a'); link.href = url; link.download = attachment.name.replace(/[\x00-\x1f/\\]/g, '_'); link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch (error) { notify(errorText(error)) } finally { node.disabled = false }
  }
  function dialog(title: string) {
    modal?.close(); modal?.remove(); modalReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const node = element('dialog', 'mail-dialog'); const heading = element('header', 'dialog-header'); const id = `title-${crypto.randomUUID()}`
    const h2 = element('h2', '', title); h2.id = id; node.setAttribute('aria-labelledby', id)
    heading.append(h2, button(copy.close, () => node.close(), 'icon-button', 'close')); node.append(heading)
    node.addEventListener('close', () => { node.remove(); if (modal === node) { modal = undefined; modalReturn?.focus() } })
    widget.append(node); modal = node; return node
  }
  function accountManager(add = false) {
    const node = dialog(copy.accounts); const body = element('div', 'dialog-body'); node.append(body)
    accounts.forEach(account => {
      const item = element('div', 'connected-account'); const text = element('div'); text.append(element('strong', '', account.name), element('span', '', account.email))
      if (account.error) text.append(element('small', 'form-error', copy.errors[account.error as keyof Copy['errors']] ?? copy.errors['request-failed']))
      else if (!account.smtp) text.append(element('small', '', copy.readOnly))
      const remove = button(copy.remove, () => {
        if (remove.dataset.confirm !== 'true') { remove.dataset.confirm = 'true'; remove.className = 'quiet-button remove-confirm'; remove.replaceChildren(document.createTextNode(copy.remove + ' ?')); remove.title = copy.confirmRemove; return }
        remove.disabled = true
        void client.request<{ accounts: Account[] }>('remove-account', { accountId: account.id }).then(result => {
          if (stopped) return; accounts = result.accounts; messages = messages.filter(m => m.accountId !== account.id); if (detail?.message.accountId === account.id) detail = undefined
          updateAccounts(); renderList(); renderReader(); accountManager()
        }).catch(error => { notify(errorText(error)); remove.disabled = false })
      }, 'icon-button remove-account', 'trash')
      item.append(text, remove); body.append(item)
    })
    const form = element('form', 'account-form'); const providerLabel = element('label', 'field'); providerLabel.append(element('span', '', copy.provider))
    const provider = element('select'); provider.append(new Option('Gmail', 'gmail'), new Option('Fastmail', 'fastmail'), new Option('Yahoo', 'yahoo'), new Option(copy.custom, 'custom')); providerLabel.append(provider); form.append(providerLabel)
    const name = inputField(form, copy.name, 'name'); name.required = true; name.maxLength = 80; name.autocomplete = 'off'
    const email = inputField(form, copy.email, 'email', '', 'email'); email.required = true; email.autocomplete = 'username'; email.maxLength = 254
    const password = inputField(form, copy.password, 'password', '', 'password'); password.required = true; password.maxLength = 1024; password.autocomplete = 'current-password'
    const show = button(copy.show, () => { password.type = password.type === 'password' ? 'text' : 'password'; show.title = password.type === 'password' ? copy.show : copy.hide; show.setAttribute('aria-label', show.title); show.setAttribute('aria-pressed', String(password.type === 'text')) }, 'icon-button show-password', 'eye'); password.parentElement!.classList.add('password-field'); password.parentElement!.append(show)
    const hint = element('p', 'form-hint', copy.gmailHelp); form.append(hint)
    const link = element('a', 'provider-help', strings('en') === copy ? 'Create an app password ↗' : 'Créer un mot de passe d’application ↗'); link.href = 'https://myaccount.google.com/apppasswords'; link.target = '_blank'; link.rel = 'noopener noreferrer'; form.append(link)
    const advanced = element('details', 'server-settings'); advanced.append(element('summary', '', copy.advanced)); const servers = element('div', 'server-fields'); advanced.append(servers)
    const username = inputField(servers, copy.username, 'username'); username.autocomplete = 'off'; username.maxLength = 254
    const imapRow = element('div', 'server-row'); const imap = inputField(imapRow, copy.imapHost, 'imapHost', 'imap.gmail.com'); const imapPort = inputField(imapRow, copy.port, 'imapPort', '993', 'number'); servers.append(imapRow)
    const smtpRow = element('div', 'server-row'); const smtp = inputField(smtpRow, copy.smtpHost, 'smtpHost', 'smtp.gmail.com'); const smtpPort = inputField(smtpRow, copy.port, 'smtpPort', '465', 'number'); servers.append(smtpRow)
    for (const port of [imapPort, smtpPort]) { port.min = '1'; port.max = '65535'; port.required = true }
    for (const host of [imap, smtp]) { host.spellcheck = false; host.autocomplete = 'off'; host.maxLength = 253 }
    imap.required = true
    email.addEventListener('input', () => { if (!name.value || name.dataset.auto === 'true') { name.value = email.value.split('@')[0]; name.dataset.auto = 'true' } })
    name.addEventListener('input', () => { name.dataset.auto = 'false' })
    provider.addEventListener('change', () => {
      const hosts: Record<string, [string, string]> = { gmail: ['imap.gmail.com', 'smtp.gmail.com'], fastmail: ['imap.fastmail.com', 'smtp.fastmail.com'], yahoo: ['imap.mail.yahoo.com', 'smtp.mail.yahoo.com'], custom: ['', ''] }
      ;[imap.value, smtp.value] = hosts[provider.value]; hint.textContent = provider.value === 'gmail' ? copy.gmailHelp : copy.appPassword; link.hidden = provider.value !== 'gmail'; advanced.open = provider.value === 'custom'
    })
    form.append(advanced, element('p', 'form-hint', copy.secure))
    const error = element('p', 'form-error'); error.setAttribute('role', 'alert'); error.hidden = true
    const submit = button(copy.connect, () => {}, 'primary-button'); submit.type = 'submit'; form.append(error, submit)
    form.addEventListener('submit', event => {
      event.preventDefault(); if (submit.disabled) return
      submit.disabled = true; submit.textContent = copy.connecting; error.hidden = true
      const command = { name: name.value, email: email.value, username: username.value || email.value, password: password.value, imapHost: imap.value, imapPort: Number(imapPort.value), ...(smtp.value.trim() ? { smtpHost: smtp.value, smtpPort: Number(smtpPort.value) } : {}) }
      password.value = ''
      void client.request<{ accounts: Account[] }>('add-account', command).then(result => {
        if (stopped) return; accounts = result.accounts; updateAccounts(); node.close(); renderReader(); void load()
      }).catch(reason => { if (stopped) return; error.textContent = errorText(reason); error.hidden = false; submit.disabled = false; submit.textContent = copy.connect; password.focus() }).finally(() => { command.password = '' })
    })
    if (accounts.length && !add) { const addButton = button(copy.addAccount, () => { addButton.remove(); body.append(form); email.focus() }, 'quiet-button add-account', 'accounts'); body.append(addButton) }
    else body.append(form)
    body.append(element('p', 'privacy-note', copy.privacy)); node.showModal()
    if (!accounts.length || add) email.focus()
  }
  function compose(reply?: Message) {
    const node = dialog(reply ? copy.reply : copy.compose); const form = element('form', 'compose-form'); node.append(form)
    const accountLabel = element('label', 'field'); accountLabel.append(element('span', '', copy.from)); const account = element('select'); account.append(...accounts.filter(a => a.smtp).map(a => new Option(`${a.name} · ${a.email}`, a.id))); account.value = reply?.accountId ?? (activeAccount || account.value); accountLabel.append(account)
    form.append(accountLabel)
    const to = inputField(form, copy.to, 'to', reply ? address(reply.from) : ''); to.required = true; to.spellcheck = false; to.maxLength = 1000; to.autocomplete = 'email'
    const subject = inputField(form, copy.subject, 'subject', reply ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`) : ''); subject.maxLength = 300
    const label = element('label', 'field compose-body'); label.append(element('span', '', copy.body)); const body = element('textarea'); body.required = true; body.maxLength = 100_000; body.name = 'body'; label.append(body); form.append(label)
    if (demo) form.append(element('small', 'form-hint', copy.demoDetail))
    const error = element('p', 'form-error'); error.setAttribute('role', 'alert'); error.hidden = true
    const footer = element('div', 'compose-footer'); const submit = button(copy.send, () => {}, 'primary-button', 'send'); submit.type = 'submit'; submit.disabled = demo; footer.append(button(copy.cancel, () => node.close(), 'quiet-button'), submit); form.append(error, footer)
    let sending = false
    node.addEventListener('cancel', event => { if (sending) event.preventDefault() })
    form.addEventListener('submit', event => {
      event.preventDefault(); if (sending || demo) return; sending = true; submit.disabled = true; submit.textContent = copy.sending; error.hidden = true
      const closeButton = node.querySelector<HTMLButtonElement>('.dialog-header button')!; closeButton.disabled = true; footer.querySelector<HTMLButtonElement>('.quiet-button')!.disabled = true
      void client.request('send', { accountId: account.value, to: to.value, subject: subject.value, body: body.value, ...(reply?.messageId ? { inReplyTo: reply.messageId } : {}) }).then(() => {
        if (stopped) return; sending = false; node.close(); notify(copy.sent, 'info')
      }).catch(reason => {
        if (stopped) return; sending = false; closeButton.disabled = false; footer.querySelector<HTMLButtonElement>('.quiet-button')!.disabled = false
        const unconfirmed = reason instanceof ActionError && reason.code === 'send-unconfirmed'
        submit.disabled = unconfirmed; submit.textContent = copy.send; error.textContent = errorText(reason); error.hidden = false
      })
    })
    node.showModal(); (reply ? body : to).focus()
  }
  const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting) && !loading && !search && Object.values(cursor).some(v => v > 0)) void load(true) }, { root: list, rootMargin: '80px' })
  observer.observe(moreButton)
  const refreshTimer = demo ? undefined : setInterval(() => { if (available && accounts.length && !loading && !modal && !document.hidden && list.scrollTop < 1) void load() }, 60_000)
  function configure(value: Settings) {
    settings = value; widget.style.setProperty('--mail-opacity', String(typeof value.opacity === 'number' ? Math.max(.5, Math.min(1, value.opacity)) : .9)); widget.style.setProperty('--mail-blur', `${typeof value.blur === 'number' ? Math.max(0, Math.min(24, value.blur)) : 16}px`)
    const next = strings(value.language)
    if (next !== copy) { copy = next; brand.querySelector('h1')!.textContent = copy.title; searchInput.placeholder = copy.search; searchInput.setAttribute('aria-label', copy.search); preview.textContent = copy.demoDetail; moreButton.textContent = copy.more; tabButtons.forEach((b, i) => { b.textContent = i === 0 ? copy.inbox : i === 1 ? copy.unread : copy.starred }); updateAccounts(); renderList(); renderReader() }
  }
  configure(initial); updateAccounts(); renderList(); renderReader()
  void client.request<{ accounts: Account[] }>('snapshot').then(result => { if (stopped) return; accounts = result.accounts; updateAccounts(); renderReader(); if (accounts.length) void load(); else renderList() }).catch(error => { available = false; updateAccounts(); renderList(); notify(errorText(error)) })
  return { configure, dispose() { stopped = true; listRevision++; readRevision++; observer.disconnect(); clearInterval(refreshTimer); modal?.close(); widget.remove() } }
}
