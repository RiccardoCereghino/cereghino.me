# Why this site is one file, unminified, with comments

Loading-speed decisions for `cereghino.me`, with the measurements behind them.
Written 2026-07-26 against the v2 landing page.

Everything here was measured, not assumed. **Reproduce it any time** with
`.github/scripts/measure.py` — if the numbers below have drifted, that script is
the source of truth and this page is stale.

---

## The one number that decides everything

The first TCP congestion window is **10 segments × 1460 bytes = 14,600 bytes**
(RFC 6928, the initcwnd every modern server uses). Whatever fits inside it
arrives in a **single round trip**. Whatever does not costs at least one more.

```
first congestion window   ██████████████████████████████  14,600 bytes
this page, gzipped        █████████▌                       4,750 bytes  (33%)
                                     └── 9,850 bytes of headroom
```

For a page with no subresources, load time is **round trips, not bytes**. Every
decision below follows from having 9,850 bytes of slack in the only round trip
that matters.

---

## Measurements

| | raw | gzipped |
| --- | ---: | ---: |
| As shipped | 12,568 | **4,750** |
| Comments stripped | 9,172 | 3,055 |
| Fully minified | 8,482 | 2,945 |

| Change | Saves (gzipped) | On 4G @ 1.6 MB/s | Round trips saved |
| --- | ---: | ---: | ---: |
| Strip all comments | 1,695 B | 1.06 ms | **0** |
| Full minification | 1,805 B | 1.13 ms | **0** |

---

## Decisions

### Keep everything in one file

Splitting into `index.html` + `style.css` + `script.js` would be **strictly
worse**:

| | one file | three files |
| --- | ---: | ---: |
| Requests | 1 | 3 |
| Round trips to first paint | **1** | **2** |
| Bytes saved | — | 0 |

The browser cannot *discover* `style.css` until the HTML has arrived, and CSS is
render-blocking. So the split buys a guaranteed second round trip in exchange
for zero bytes, plus two extra sets of request/response headers.

**Revisit when:** the site grows to several pages sharing a stylesheet. Then the
cross-page cache hit becomes real and the maths flips. With one page it cannot.

### Keep the comments

They cost 1,695 gzipped bytes — about **1 ms** on 4G — and **zero round trips**,
because the page sits at 33% of the congestion window. Parse cost is
microseconds; tokenizers skip comments without allocating.

The comments are load-bearing in a different sense: several of them exist to
stop a future editor cheerfully undoing a deliberate choice (why there is no
`text-shadow` on the logo, why the logo's line breaks come from `display:block`
rather than newlines, why the uptime epoch must stay on 1 January). That is
worth 1 ms.

### No minification

1,805 gzipped bytes, ~1.13 ms, **no change in round trips**. It does drop the
payload from 4 TCP segments to 3 — but both numbers are far inside the
10-segment first window, so all of it ships in the same single round trip
either way. Saving segments only buys latency when it saves a *window*.

Against that: the file stops being readable, and a build step means either
committing generated output or migrating Pages off the `legacy` build type (see
below).

**Revisit when:** the page approaches ~14,000 gzipped bytes. That is the point
where trimming bytes starts removing a round trip instead of shaving
microseconds. There is currently 3× headroom.

### Compression is not ours to add

GitHub Pages already does it. Verified against the live site:

```
$ curl -sI -H 'Accept-Encoding: br, gzip' https://riccardocereghino.github.io/cereghino.me/
content-encoding: gzip
content-length: 3497
```

Brotli would be ~15% better again, but Pages decides the encoding — we cannot
ship precompressed `.br` assets or set the header. Nothing to do here.

### No build step, and no Pages deploy workflow

Pushing to `main` **is** the deploy. The repo uses the **legacy** Pages build
type with source `main:/`.

Two reasons not to change that:

1. `RiccardoCereghino/edge#1` manages this repo's Pages configuration as
   OpenTofu (`github_repository` … `pages`). Switching the build type here would
   surface as **state drift** there. Coordinate before touching it.
2. Legacy Pages only reads `CNAME` from the publishing source root, and only
   offers `/` or `/docs` as that root. This is why `CNAME` lives at the repo
   root and not in a subdirectory.

### Why these docs are not in `/docs`

`/docs` is a *selectable Pages publishing source*. A directory with that name at
the repo root is a standing footgun: switching the source to `/docs` — a
two-click change in the settings UI — would silently start serving this file as
the website. `.github/` is excluded from the published site by Jekyll, so the
deployed root stays exactly `index.html` + `CNAME`, which CI asserts.

Move this to `/docs` only if you want it publicly readable at `cereghino.me`,
and know that it makes the source-path setting dangerous.

---

## What CI enforces

`.github/workflows/ci.yml` guards the properties this page argues for:

- **size budget** under 100 KB (`check_spec.py`)
- **zero external subresources** — no CDN, font, or script host may appear
  (`check_spec.py`)

Neither is close to binding today. They exist so that "one file, one round trip"
fails loudly rather than eroding.
