# Manual test checklist

Automated tests run on synthetic fixtures. This checklist covers what only real comic readers reveal. Run it before
a release on at least three different kinds of sites, for example a webtoon reader with lazy loading, a paged manga
reader, and a reader that loads images from a CDN or inside an iframe.

**Ground rules**

- Test only on sites you read anyway. Real pages stay on your machine: never commit them or attach them to issues.
- Images are uploaded only after you enable a site and accept the privacy notice. Use your own API key or a local
  model.
- Use a production build (`npm run build:prod`) in a normal Chrome profile with DevTools **closed** for the lifetime
  and memory items.

Record one column per site: the date, the build id (popup footer) and the kind of site, not its URL.

| Item                                                                               | Site 1 | Site 2 | Site 3 |
| ---------------------------------------------------------------------------------- | ------ | ------ | ------ |
| Date / build id / kind of site                                                     |        |        |        |
| Privacy notice appears before the first upload; "Don't send" really sends nothing  |        |        |        |
| Enabling the site from the popup starts translation without a page reload          |        |        |        |
| Lazy-loaded images are picked up as they load                                      |        |        |        |
| Images need Referer / cookies / no Origin? Do they load with `referer: auto`?      |        |        |        |
| Canvas-drawn or scrambled images (expected: reported as unavailable)               |        |        |        |
| Reader inside an iframe (needs `extraFrameOrigins`?)                               |        |        |        |
| A balloon split across two strip images is translated once                         |        |        |        |
| Balloon outlines and art stay intact after erasing                                 |        |        |        |
| Lettering size matches the original and stays inside the balloon                   |        |        |        |
| Overlay stays aligned after window resize and browser zoom (90% / 125% / 150%)     |        |        |        |
| Page-turn readers: the next page translates                                        |        |        |        |
| Back / forward navigation restores translations                                    |        |        |        |
| SPA chapter change: new images are discovered                                      |        |        |        |
| % of balloons ready before they scroll into view (normal reading speed)            |        |        |        |
| Re-opening a chapter shows translations immediately (cache)                        |        |        |        |
| Alt+Shift+Y hides/shows the overlay; Alt+Shift+U translates visible images         |        |        |        |
| Context menu "Translate this image" / "Translate this image again"                 |        |        |        |
| Manual mode: hover "Translate" button; "Translate again" after an error            |        |        |        |
| CSP errors in the page console                                                     |        |        |        |
| Memory after one chapter (Chrome Task Manager: tab, extension, offscreen document) |        |        |        |
| Engine closes after `engine.idleCloseMin` with no tabs open                        |        |        |        |
| Expired or invalid API key mid-chapter: clear error, recovery after fixing the key |        |        |        |
| Rate limit (429) from the provider: translation slows down and resumes             |        |        |        |
| Daily upload counter in the popup matches expectations                             |        |        |        |

File anything that fails as an issue. Describe the kind of site, the build id and the provider/model, and never
include API keys or private URLs.
