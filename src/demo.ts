import { ActionError, type Action, type Account, type MailClient, type Message, type MessageDetail, type Page } from '../shared/protocol'
const accounts: Account[] = [
  { id: 'personal', name: 'Personnel', email: 'alex@example.com', color: '#9ccfea', status: 'ready', smtp: true },
  { id: 'studio', name: 'Studio', email: 'studio@example.com', color: '#d2b5ed', status: 'ready', smtp: true },
  { id: 'notes', name: 'Projets', email: 'projets@example.com', color: '#abd8c5', status: 'ready', smtp: true },
]
const samples = [
  ['studio', 'Léa Martin <lea@example.com>', 'Quelques idées pour vendredi', 'Bonjour Alex,\n\nJ’ai rassemblé les pistes dont on parlait hier. L’idée serait de garder une interface légère, avec juste ce qu’il faut pour retrouver ses messages au premier regard.\n\nOn pourrait se retrouver vendredi à 10 h pour en discuter ?\n\nÀ bientôt,\nLéa', false, true],
  ['personal', 'Camille <camille@example.com>', 'Le week-end approche ☀', 'Salut !\n\nLa météo s’annonce parfaite pour une balade. On se retrouve samedi matin au café, puis on improvise ?\n\nÀ très vite,\nCamille', false, false],
  ['notes', 'Atelier <atelier@example.com>', 'Votre prochaine session', 'Bonjour,\n\nVotre atelier de photographie est prévu mardi à 18 h. Pensez à prendre votre appareil et une carte mémoire.\n\nAu plaisir de vous retrouver !', true, false],
  ['studio', 'Julien <julien@example.com>', 'Les premiers retours sont là', 'Bonjour Alex,\n\nLes retours sur la dernière version sont très positifs. Les lecteurs apprécient particulièrement la simplicité des réglages et la qualité des détails.\n\nMerci pour tout ce travail.\nJulien', true, true],
  ['personal', 'Bibliothèque <bibliotheque@example.com>', 'Un livre vous attend', 'Bonjour,\n\nLe livre que vous aviez réservé est disponible. Vous pouvez venir le chercher cette semaine.\n\nBonne lecture !', true, false],
  ['notes', 'Nora <nora@example.com>', 'Une nouvelle piste', 'Bonjour,\n\nJe vous partage une nouvelle piste pour notre projet. Prenons le temps de l’explorer lors de notre prochain échange.\n\nNora', true, false],
] as const
export function createDemoClient(): MailClient {
  let stopped = false
  const messages: Message[] = samples.map((item, i) => ({ accountId: item[0], uid: 100 - i, validity: 1, from: item[1], to: accounts.find(a => a.id === item[0])!.email, subject: item[2], date: Math.floor(Date.now() / 1000) - i * 3600, read: item[4], starred: item[5], size: 512, messageId: `<demo-${i}@example.com>` }))
  return {
    async request<T>(action: Action, input: Record<string, unknown> = {}) {
      if (stopped) throw new ActionError('offline')
      let result: unknown
      if (action === 'snapshot') result = { accounts: [...accounts] }
      else if (action === 'list') result = { accounts: [...accounts], cursor: {}, messages: messages.filter(m => (!input.accountId || m.accountId === input.accountId) && (input.filter !== 'unread' || !m.read) && (input.filter !== 'starred' || m.starred)) } satisfies Page
      else if (action === 'read') {
        const index = messages.findIndex(m => m.accountId === input.accountId && m.uid === input.uid)
        if (index < 0) throw new ActionError('message-missing')
        messages[index].read = true
        result = { message: { ...messages[index] }, body: samples[index][3], attachments: [], truncated: false } satisfies MessageDetail
      } else if (action === 'flag') { const message = messages.find(m => m.accountId === input.accountId && m.uid === input.uid); if (message) message.starred = !!input.flag; result = { starred: !!input.flag } }
      else throw new ActionError('desktop-required')
      return result as T
    },
    close() { stopped = true },
  }
}
