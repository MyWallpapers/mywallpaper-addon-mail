// Deliberately local test peers. This public test key is never a user credential.
import { readFile } from 'node:fs/promises'
import { createServer, type TLSSocket } from 'node:tls'
import { join } from 'node:path'

export async function mailServer(directory: string, kind: 'imap' | 'smtp') {
  const commands: string[] = []; const sent: string[] = []; const sockets = new Set<TLSSocket>()
  const body = 'Bonjour Alex,\r\n\r\nVoici un message de test.\r\n'
  const attachment = Buffer.from('Test attachment\n').toString('base64')
  const server = createServer({ key: await readFile(join(directory, 'fixtures', 'localhost-key.pem')), cert: await readFile(join(directory, 'fixtures', 'localhost-cert.pem')) }, socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {})
    let buffer = ''; let authStep = 0; let data = false
    socket.write(kind === 'imap' ? '* OK IMAP test peer\r\n' : '220 localhost SMTP test peer\r\n')
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 1024 * 1024) { socket.destroy(); return }
      while (true) {
        if (data) {
          const end = buffer.indexOf('\r\n.\r\n'); if (end < 0) break
          sent.push(buffer.slice(0, end)); buffer = buffer.slice(end + 5); data = false; socket.write('250 Message accepted\r\n'); continue
        }
        const end = buffer.indexOf('\r\n'); if (end < 0) break
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); commands.push(line)
        if (kind === 'smtp') {
          if (authStep) { socket.write(authStep++ === 1 ? '334 UGFzc3dvcmQ6\r\n' : '235 Authenticated\r\n'); if (authStep > 2) authStep = 0 }
          else if (/^EHLO/i.test(line)) socket.write('250-localhost\r\n250 AUTH LOGIN\r\n')
          else if (/^AUTH LOGIN/i.test(line)) { authStep = 1; socket.write('334 VXNlcm5hbWU6\r\n') }
          else if (/^(MAIL FROM|RCPT TO)/i.test(line)) socket.write('250 OK\r\n')
          else if (line === 'DATA') { data = true; socket.write('354 Continue\r\n') }
          else if (line === 'QUIT') socket.end('221 Bye\r\n')
          else socket.write('500 Unsupported test command\r\n')
          continue
        }
        const split = line.indexOf(' '); const tag = line.slice(0, split); const command = line.slice(split + 1)
        const ok = () => socket.write(`${tag} OK Completed\r\n`)
        if (command === 'CAPABILITY') { socket.write('* CAPABILITY IMAP4rev1 AUTH=LOGIN\r\n'); ok() }
        else if (command.startsWith('LOGIN ')) ok()
        else if (command.startsWith('STATUS ')) { socket.write('* STATUS "INBOX" (MESSAGES 1000 UNSEEN 500 UIDNEXT 1001 UIDVALIDITY 42)\r\n'); ok() }
        else if (command.startsWith('SELECT ')) { socket.write('* FLAGS (\\Seen \\Flagged)\r\n* 1000 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 42] UIDs valid\r\n* OK [UIDNEXT 1001] Next UID\r\n* OK [PERMANENTFLAGS (\\Seen \\Flagged \\*)] Flags\r\n'); ok() }
        else if (command.startsWith('UID SEARCH ')) {
          const requested = command.match(/UID ([\d,:]+)/)?.[1] ?? '1:1000'
          const uids = requested.split(',').flatMap(atom => { const [lower, upper] = atom.split(':').map(Number); return upper ? Array.from({ length: upper - lower + 1 }, (_, i) => lower + i) : [lower] }).filter(uid => !command.includes('UNSEEN') || uid % 2 === 1).filter(uid => !command.includes('FLAGGED') || uid % 5 === 0)
          socket.write(`* SEARCH ${uids.join(' ')}\r\n`); ok()
        } else if (command.startsWith('UID STORE ')) { socket.write('* 1000 FETCH (UID 1000 FLAGS (\\Seen \\Flagged))\r\n'); ok() }
        else if (command.startsWith('UID FETCH ')) {
          const uids = command.split(' ')[2].split(',').map(Number)
          for (const uid of uids) {
            if (command.includes('BODYSTRUCTURE') && !command.includes('HEADER.FIELDS')) {
              socket.write(`* ${uid} FETCH (UID ${uid} BODYSTRUCTURE (("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" ${Buffer.byteLength(body)} 3 NIL NIL NIL) ("APPLICATION" "OCTET-STREAM" ("NAME" "notes.txt") NIL NIL "BASE64" ${attachment.length} NIL ("ATTACHMENT" ("FILENAME" "notes.txt")) NIL) "MIXED" ("BOUNDARY" "test") NIL NIL))\r\n`)
            } else if (command.includes('HEADER.FIELDS')) {
              const headers = `Subject: =?UTF-8?B?${Buffer.from('Café ' + uid).toString('base64')}?=\r\nFrom: Test <sender@example.com>\r\nTo: reader@example.com\r\nDate: Wed, 7 Oct 2026 10:00:00 +0000\r\nMessage-ID: <test-${uid}@example.com>\r\nContent-Type: multipart/mixed; boundary=test\r\n\r\n`
              socket.write(`* ${uid} FETCH (UID ${uid} FLAGS (${uid % 2 === 0 ? '\\Seen' : ''}) INTERNALDATE "07-Oct-2026 10:00:00 +0000" RFC822.SIZE 1000 BODY[HEADER.FIELDS (SUBJECT FROM TO DATE MESSAGE-ID CONTENT-TYPE)] {${Buffer.byteLength(headers)}}\r\n${headers})\r\n`)
            } else {
              const part = command.match(/BODY\[(.+?)\]/)?.[1]; const content = part === '2' ? attachment : body
              socket.write(`* ${uid} FETCH (UID ${uid} BODY[${part}] {${Buffer.byteLength(content)}}\r\n${content})\r\n`)
            }
          }
          ok()
        } else if (command === 'LOGOUT') { socket.write('* BYE Closing\r\n'); ok(); socket.end() }
        else if (command === 'NOOP' || command === 'CLOSE') ok()
        else socket.write(`${tag} BAD Unsupported test command\r\n`)
      }
    })
  })
  server.on('tlsClientError', () => {})
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
  return { port: (server.address() as { port: number }).port, commands, sent, async close() { sockets.forEach(s => s.destroy()); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
