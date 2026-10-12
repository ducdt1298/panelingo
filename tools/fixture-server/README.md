# Fixture server

A local stand-in for comic reader sites, for tests, E2E runs and manual checks. Two origins on purpose, so images
are cross-site for the page, as on real comic readers:

| Origin | Default                 | Serves                                                                    |
| ------ | ----------------------- | ------------------------------------------------------------------------- |
| reader | `http://127.0.0.1:8080` | fixture pages from `test/fixtures/sites/<site>/`, `POST /__results/<exp>` |
| CDN    | `http://localhost:8081` | images from `test/fixtures/generated/**`, gates, redirects, `GET /__log`  |

```sh
npm run serve:fixtures            # node tools/fixture-server/cli.ts [--reader-port 8080] [--cdn-port 8081]
                                  #   [--root test/fixtures] [--host 127.0.0.1] [--results-dir reports/fixture-results] [--quiet]
```

In tests, start it in-process on ephemeral ports and close it:

```ts
const fx = await createFixtureServer({ root: "test/fixtures", readerPort: 0, cdnPort: 0, quiet: true });
// fx.readerUrl, fx.cdnUrl, fx.requests() (CDN log), fx.clearLog()
await fx.close(); // also ends responses still waiting on ?delay
```

Options `sitesDir` and `generatedDir` override `<root>/sites` and `<root>/generated`. The CDN binds both
`127.0.0.1` and `[::1]` on one port, so `localhost` resolves either way. Nothing is cached by surprise: images send
`Cache-Control: no-store` unless `?cache=1`; pages send `no-cache` (still back/forward-cache eligible) unless
`?nostore=1`.

## CDN routes

| Route                                        | Behaviour                                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /img/<path>`                            | the image, `Content-Type` from the extension (png, jpeg, webp, avif, gif)                           |
| `GET /protected/<path>`                      | 403 unless `Referer` starts with `<reader>/` (what Chrome's default policy sends)                   |
| `GET /protected-full/<path>`                 | 403 unless `Referer` is a full reader page URL (path beyond `/`), not origin-only                   |
| `GET /protected-cookie/<path>`               | 403 unless cookie `ctv_gate=1`                                                                      |
| `GET /__set-cookie?samesite=lax\|none&next=` | sets `ctv_gate=1`; with `next` (a reader URL), a 302 back to it (top-level hop)                     |
| `GET /__clear-cookie`                        | expires `ctv_gate`                                                                                  |
| `GET /redirect?to=<url>&status=30x`          | 302 (or 301/303/307/308) to an absolute http(s) URL or a `/path` (SSRF-guard tests)                 |
| `GET /frame/?set=`                           | the cross-origin frame of `/iframe/` (its images are same-origin on the CDN)                        |
| `GET /frame/capture/<set>.html?set=`         | the capture-only canvas page of `/capture/` on the CDN origin (the frame of `/capture/iframe.html`) |
| `GET /__log`, `POST /__log/clear`            | the request log, see below                                                                          |

Log entries: `{t, method, path, referer, origin, cookie, secFetchSite, secFetchMode, secFetchDest, userAgentShort,
status}`, oldest first, capped at 5000. The log routes themselves are not logged; `status` is null while a response
is pending (`?delay`) or when the client left before the headers.

Image query knobs (all image routes, also forwarded from page URLs to every image they render):

| Knob                | Effect                                                                              |
| ------------------- | ----------------------------------------------------------------------------------- |
| `delay=<ms>`        | wait before the headers (max 600000)                                                |
| `status=<code>`     | answer with that status; 2xx still sends the image                                  |
| `cors=1\|*\|origin` | `Access-Control-Allow-Origin: *`, or echo `Origin` with credentials; none otherwise |
| `cache=0\|1`        | `1`: `max-age=3600` + `ETag`/`Last-Modified` (304 on `If-None-Match`)               |
| `origin=strict`     | also 403 when an `Origin` header other than the reader's is present (cors fetches)  |

Bad values answer 400. Paths with `..`, empty or absolute segments, encoded separators, drive letters, NUL or
Windows device names answer 400; files outside the root (also through links or junctions) answer 404.

### The gate cookie and SameSite

`/__set-cookie` sets `SameSite=Lax` by default. That is enough for the point of the route: an extension fetch with
`credentials: 'omit'` gets 403, `'include'` gets 200 (extension requests with host permissions count as
same-site). But the reader page's own `<img>` requests are cross-site (127.0.0.1 to localhost) and never carry a
Lax cookie, so its images would be broken too.

`SameSite=None` needs `Secure`, which plain http normally cannot set, except that Chrome treats `http://localhost`
as potentially trustworthy. Verified on Chrome 154.0.8037.98 (headless, 2026-10-09): `?samesite=none` stores
`ctv_gate` as `SameSite=None; Secure` and Chrome sends it on the reader page's cross-site image requests (third-party
cookies are allowed by default; a profile that blocks them gets 403 again). `/webtoon/?protected=cookie` therefore
hops through `/__set-cookie?samesite=none` so the page renders like a logged-in reader;
`/webtoon/?protected=cookie&samesite=lax` reproduces the Lax case.

## Reader pages

Every page embeds its data as JSON in `#ctv-fixture-data`; `/_shared/fixture.js` exposes it as
`window.__ctvFixture` (`data`, CSP `violations`, `events`, `prerenderedAtLoad`). Images carry `width`/`height`
from the file headers and `data-fixture-file` (path under `generated/`).

| Page                                                                | What it models                                                                                                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/paged/?set=ko-p01`                                                | one page image; `via=blob\|data` shows it through a `blob:`/`data:` URL fetched with CORS                                                                                    |
| `/webtoon/?set=chapter-ko-60&n=60&lazy=none\|native\|io&margin=300` | vertical strip; `io` = `data-src` + IntersectionObserver (`attr=data-lazy-src\|data-original`, `placeholder=gif`); `protected=referer\|full\|cookie`                         |
| `/seam/?gap=0\|4`                                                   | `ko-seam01` slices stacked with that gap                                                                                                                                     |
| `/webp/`                                                            | the WebP slices of `ko-strip01`                                                                                                                                              |
| `/srcset/`                                                          | `srcset` 1x/2x (same bytes, the URL shows the choice) and `<picture>` with AVIF/WebP sources                                                                                 |
| `/protected/`                                                       | images via `/protected/`                                                                                                                                                     |
| `/protected-full/`                                                  | images via `/protected-full/`, page sends full-URL Referers (`<meta name=referrer content=no-referrer-when-downgrade>`)                                                      |
| `/infinite/?per=10`                                                 | next chapter appended near the bottom, URL follows with `pushState`                                                                                                          |
| `/spa/`, `/spa/ch/<n>`                                              | pushState router on `<div id=root data-reactroot>`; every render replaces all `<img>` nodes                                                                                  |
| `/canvas/?src=same\|cors\|cdn`                                      | pages drawn into `<canvas>` only; `same` fetches same-origin (`/img/` on the reader), `cdn` taints                                                                           |
| `/capture/ko-p01.html?set=ko-p01`                                   | the set drawn at natural size into a canvas tainted by the CDN (no CORS): only a screen capture can read it; the file name lets the mock's oracle find the ground truth      |
| `/capture/iframe.html?set=ko-p01`                                   | the same canvas page in a cross-origin frame (CDN `/frame/capture/ko-p01.html`, tainted by a reader-origin image), 1000 px tall and scrolling inside a page that scrolls too |
| `/csp/`                                                             | `Content-Security-Policy: default-src 'none'; script-src 'self'; img-src <CDN>; style-src 'self'; font-src 'none'; require-trusted-types-for 'script'`                       |
| `/iframe/`                                                          | top frame, same-origin frame, `about:blank` frame filled by script, `srcdoc` frame, cross-origin frame on the CDN                                                            |
| `/prerender/?n=10`                                                  | Speculation Rules prerender of a `/webtoon/` chapter (or `?target=/path`), activated by `#activate`                                                                          |

Common page knobs: `set`, `fmt=jpg|png|webp|avif`, `crossorigin=anonymous|use-credentials`, `policy=<referrer policy>`,
`nostore=1`, plus the image knobs above. Other reader endpoints: `GET /__fixtures[?set=&prefer=single|sequence&fmt=]`
(how sets resolve), `GET /img/<path>` (same-origin images), `POST /__results/<exp>` (JSON body saved pretty-printed
as `<resultsDir>/<exp>.json`, answers `{saved}`; `<exp>` matches `[A-Za-z0-9][A-Za-z0-9._-]*`).

## How a set name finds its images

1. `generated/manifest.json` from `tools/fixtures/make_fixtures.py`: `fixtures[].name` lists `images[].image`
   (paths under `generated/`) in the generator's order. `fmt=` swaps in a sibling `<stem>.<fmt>` when present.
2. Otherwise by file name: a directory named after the set (natural order), a numbered sequence
   (`<set>-1.webp`, `<set>_02.png`, `<set>.s3.jpg`, ...), or a single `<set>.<ext>`; jpg > png > webp > avif > gif.
   Masks and debug renders (`*.mask.png`, `*.textmask.png`, ...) are skipped.

A set that resolves to nothing answers 404 with a hint to run `npm run fixtures`.
