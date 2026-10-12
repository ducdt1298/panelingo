# Security policy

## Supported versions

Security fixes go into the latest release. Please update to the newest version before reporting.

| Version        | Supported |
| -------------- | --------- |
| latest release | ✅        |
| `main` branch  | ✅        |
| older releases | ❌        |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/ducdt1298/panelingo/security/advisories/new)
(_Security → Report a vulnerability_). Reports stay private between you and the maintainers until a fix is
published.

Please include:

- the affected version or commit, the Chrome version and the operating system;
- a description of the issue and its impact;
- steps to reproduce or a proof of concept (a minimal HTML page is ideal);
- whether the issue is already public.

What to expect:

| Step                                       | Target                                        |
| ------------------------------------------ | --------------------------------------------- |
| Acknowledgement                            | within 3 business days                        |
| Initial assessment and severity            | within 7 days                                 |
| Fix or mitigation for high/critical issues | as soon as possible, typically within 30 days |
| Public advisory and credit (if you wish)   | after a fixed release is available            |

Please give us a reasonable time to fix the issue before you disclose it. We do not currently offer a bug bounty.

## Scope

In scope: the extension's code in this repository and the packages built from it.

Areas we especially care about:

- **API key handling.** The user's API key is stored unencrypted in `chrome.storage.local`, with a mirror in the
  extension's IndexedDB, and is sent only as `Authorization: Bearer` to the configured endpoint. In scope: any way for
  a web page, another extension or the AI endpoint to read the key, or any path that sends it to a different origin.
- **SSRF guard.** The engine fetches images with the extension's `<all_urls>` host permission. `src/shared/url-guard.ts`
  and the declarativeNetRequest block rules in `src/shared/dnr-rules.ts` must stop a page from making the extension
  request private, loopback, link-local or IPv6-literal addresses. Redirects are re-checked. In scope: bypasses through
  URL parsing tricks, redirects, alternative IP notations, or rule gaps.
- **declarativeNetRequest scoping.** Rules must apply only to the extension's own background requests
  (`initiatorDomains: [extension id]`, `tabIds: [-1]`). Any rule that alters page traffic is a bug.
- **Content Security Policy.** Extension pages use `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`. In scope:
  anything that runs remote or injected code in an extension context.
- **Content script and overlay.** Script injection through translated text, original text or page content. The overlay
  builds DOM nodes and never uses `innerHTML`. Also in scope: leaks of extension data to the page, or a page driving
  privileged actions through messages. Senders are allow-listed per message type.
- **Privacy guarantees.** Uploads before the user has accepted the privacy notice, uploads of images with no detected
  text, or data sent anywhere other than the configured endpoint and the image's own host.

Out of scope:

- The behavior, logging or retention of third-party AI providers you configure.
- Attacks that need prior control of the user's machine or browser profile, including reading
  `chrome.storage.local` from a compromised profile.
- DNS rebinding of a public hostname to a private address. This is a documented residual risk of the guard; reports with
  a practical mitigation are welcome.
- Missing hardening headers on third-party sites, or issues in Chrome itself (please report those to Chromium).
- Denial of service against your own browser by loading huge images (limits apply: `privacy.maxImageBytes`,
  `privacy.maxImagePixels`).

## Hardening already in place

- No remote code: the detector models, the WebAssembly runtime and the fonts ship inside the package.
- Sender allow-lists and payload validation on every message and port (see [docs/PROTOCOL.md](docs/PROTOCOL.md)).
- Size limits on messages, image bytes and pixel counts. Image headers are parsed before decoding.
- A closed shadow root for the overlay in production builds. Only the font files are web-accessible, with dynamic URLs.
- Engine image requests omit credentials unless the user enables cookies for a site.
- The production build drops the debug page and the `declarativeNetRequestFeedback` permission.
- An SSRF guard: engine requests to private and loopback addresses are blocked, except the AI endpoint you configured.
- Continuous checks: CodeQL code scanning on every pull request and weekly, Dependabot updates for npm packages and
  GitHub Actions, and exact-pinned dependencies (`save-exact`).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model) for details.
