# Mail for MyWallpaper

A local Windows inbox widget powered by Cypht 2.12.2. Connect several IMAP accounts, read messages, star them, download small attachments, and reply or compose through SMTP. The widget follows MyWallpaper’s Outfit typography, quiet glass surfaces and compact controls. Narrow layers use a list/read navigation; wide layers show both panes.

## First run

Install this add-on through MyWallpaper’s creator development workflow or, after publication, its catalogue. Allow its native companion when MyWallpaper asks. Open **Accounts** in the widget and enter an email address and app password. Gmail, Fastmail and Yahoo server presets are provided; other IMAP providers can use custom servers. An SMTP server is optional for read-only accounts.

This version supports password/app-password authentication over **implicit TLS**: IMAP 993 and SMTP 465 by default. It does not implement OAuth, Microsoft 365/Outlook sign-in, JMAP, EWS, POP, or STARTTLS. Server support for password-based IMAP is required. [Google app passwords](https://support.google.com/accounts/answer/185833) require 2-Step Verification and may be unavailable for some accounts. See also [Fastmail’s server settings](https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports) and [Yahoo’s IMAP settings](https://help.yahoo.com/kb/SLN4075.html).

The native binary includes Node and PHP. No PHP installation, Docker, personal server, Cypht web server or extra WebView is needed. PHP’s standard [Visual C++ runtime requirement](https://www.php.net/manual/en/install.windows.requirements.php) still applies; install Microsoft’s official x64 Visual C++ 2015–2022 runtime if it is missing on the computer.

## Data and limits

- Account credentials are encrypted locally with AES-256-GCM. Windows DPAPI protects the key for the current Windows user. Credentials never enter the add-on manifest, layer settings, MyWallpaper sync, or diagnostic logs. Native companions run with the user’s OS permissions; this is not an OS sandbox or protection against other code running as that same user.
- Each layer has its own local account store. Removing an account removes its saved connection from that widget; emails remain on the provider’s server. Revoke the app password at the provider to revoke access completely.
- Up to 10 accounts, 2 lazy mail workers. Each page retrieves at most 20 message headers per account through bounded UID windows, then loads older pages while scrolling. There is no full-folder sort, complete mailbox download, or permanent mail-body cache.
- Automatic refresh runs at most once per minute while the document is visible, no dialog is open, and the list is at its top. Scrolled lists and open forms are left undisturbed. Fast filter changes are coalesced rather than flooding the companion.
- Search is explicitly limited to loaded message headers. Filters are server-side inbox/unread/starred; the widget currently reads **INBOX only**.
- Reading marks messages as read. Mail bodies are shown as plain text; HTML is converted to text, with no script execution, remote images or tracking-pixel requests. Text parts are limited to 256 KiB. Attachments are limited to 2 MiB each. Compose/reply sends plain text; adding outgoing attachments, archive/delete and additional folders are not implemented in this first version.
- An unconfirmed send is not automatically retried. Check the provider before sending again. This widget does not currently save an outgoing copy into the provider’s Sent folder; provider-side saving may vary.

## Development

Prerequisites for **building**: Node 22+, pnpm 10.33, npm. The pinned Windows PHP archive is downloaded and checksum-verified by the native build. Sources/lockfiles are the publication inputs; prebuilt author binaries are not required.

```sh
pnpm install --frozen-lockfile
pnpm build
node native/build.mjs --target x86_64-pc-windows-msvc
mywallpaper generate
mywallpaper check
mywallpaper dev
```

The companion is rebuilt into `native/out/windows-x86_64/bin/mail.exe`; the frontend exports the canonical Canvas `mount(context)` entry. Packaging uses the existing process-v2 framing and native SDK bridge. It adds no mail-specific code to MyWallpaper itself.

### Standalone preview

```sh
pnpm preview
```

Open <http://localhost:5192/?demo=1&wide=1> for an explicitly labelled fictional inbox, or <http://localhost:5192/?demo=1> for a narrow widget. Nothing is sent from demo mode. It is never used as live fallback data.

To connect real accounts in the standalone preview, start `npm run preview` from `native/` **on Windows**, then open <http://localhost:5192/?wide=1>. Its development-only bridge is bound to `127.0.0.1:5193`, accepts only the preview origin, limits message sizes and clients, and uses a separate DPAPI-protected preview store. The published companion opens **no HTTP/WebSocket listener** and communicates only through host-managed process pipes.

On a WSL source checkout, the equivalent preview command is:

```sh
# WSL: build a JS-only development bridge so Windows needs no dev dependency install.
cd native
node_modules/.bin/esbuild src/preview-server.ts --bundle --platform=node --format=esm --packages=external --outfile=.build/preview.mjs
```

Then run `node native/.build/preview.mjs` from the repository in Windows PowerShell. For source preview, extract the pinned archive `native/.build/php.zip` into `native/.build/php/` after the native build.

### Verification

`npm test` from `native/` checks account validation, header/protocol injection, secret redaction, encrypted persistence, bounded pagination and partial account errors. The Windows-only integration test starts isolated loopback TLS IMAP/SMTP peers and exercises the actual Cypht code: MIME headers/body, attachments, UIDVALIDITY, flags, SMTP and certificate refusal before authentication. The fixture key is public test material and is trusted only by those explicit test processes, never added to Windows’s certificate store.

For a WSL checkout, bundle `test/integration.test.ts` to `.build/integration-test.mjs` with the same esbuild options as above, then run `node --test native/.build/integration-test.mjs` on Windows. The packaged executable is also checked through process-v2 initialization, account RPC and clean shutdown. Tests do not use human mail credentials or send to real recipients.

## Upstream and licensing

Cypht sources are vendored **unchanged** under `native/vendor/cypht`. `UPSTREAM.json` pins the tag, exact commit and each file’s SHA-256. The native build fails if a vendored source differs from that record. `native/php/worker.php` adapts Cypht’s transport/framework hooks to private stdin/stdout, enforces certificate validation, and restricts the operations the widget offers.

To update Cypht, select and review a new upstream tag, replace the same listed files from that tag, update `UPSTREAM.json`, and run the focused integration checks before release. Upstream updates are not silently installed into the user’s widget. Node, PHP and the CA bundle are separately pinned; updating them is an explicit source change and rebuild.

This add-on’s original code is **GPL-2.0-only**, not MIT. Cypht’s overall licence is LGPL-2.1; its IMAP base file also retains an explicit GPL2 notice from Hastymail2. Both original notices are preserved. Node, PHP, OpenSSL, fflate and Outfit retain their own licences; see `THIRD-PARTY-NOTICES.md` and the notices shipped beside the native executable. Source for the complete add-on must accompany a published build in its public repository.
