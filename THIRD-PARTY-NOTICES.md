# Third-party components

No third-party notices have been removed from the imported sources.

| Component | Pinned version/source | Licence / retained notice |
| --- | --- | --- |
| Cypht mail modules | v2.12.2, commit `fbaf979c3740a6e0f72e3a6c96e4a5102aae2133` | LGPL-2.1, `native/vendor/cypht/LICENSE`; the IMAP base additionally states GPL2/Hastymail2. Original file headers remain intact. |
| Node.js runtime | 22.22.3 | Node and dependency licences in `native/NODE-LICENSE.txt`. |
| PHP Windows NTS x64 | 8.4.26, SHA-256 `da68394f9193b7f6b89d0c76861a4034ae10efee7fd55a7255d8118c2acf70d7` | PHP licence and bundled library notices extracted from the official archive into the native output. |
| Mozilla CA bundle via curl.se | SHA-256 `a41b5d356aea97a529fe27e0f7316d2f9d946d75927476cf9cf1b90637d00505` | MPL-2.0; retained bundle header and `native/licenses/MPL-2.0.txt`. |
| fflate | 0.8.2 | MIT; licence copied from the installed, lockfile-pinned package into the output notices. |
| ws | 8.20.0 | MIT; development preview only, not bundled into the published companion. |
| Outfit | Variable font, from the existing MyWallpaper/WhatsApp asset | SIL Open Font License, `assets/OFL.txt`. |
| SDK-generated type declarations | Installed MyWallpaper creator SDK | Public contract declarations; no third-party runtime library bundled. |

`native/build.mjs` includes the licence texts of the dependencies actually compiled into `mail.exe`, alongside the PHP archive’s notices, Cypht, GPL2 and the CA bundle notice, in `native/out/windows-x86_64/bin/THIRD-PARTY-NOTICES.txt`. Both source and published binary retain the notices of every upstream component.
