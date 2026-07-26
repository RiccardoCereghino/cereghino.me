#!/usr/bin/env python3
"""Reproduce every number quoted in .github/docs/performance.md.

Run it whenever the page changes materially; if the output disagrees with the
doc, the doc is stale and this is right.

    python3 .github/scripts/measure.py

Add --check-live to also confirm GitHub Pages is still serving the site gzipped
(needs network; skipped by default so this stays usable offline).
"""

import argparse
import gzip
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# RFC 6928: initial congestion window of 10 segments. Whatever fits inside it
# arrives in one round trip; anything beyond costs at least one more.
MSS = 1460
INITCWND = 10
WINDOW = MSS * INITCWND

FOURG_BYTES_PER_SEC = 1_600_000  # ~1.6 MB/s, a reasonable 4G figure


def strip_comments(s: str) -> str:
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)     # CSS
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)    # HTML
    return re.sub(r"^\s*//.*$", "", s, flags=re.M)  # JS line comments


def minify(s: str) -> str:
    s = strip_comments(s)
    s = re.sub(r"^[ \t]+", "", s, flags=re.M)
    return re.sub(r"\n{2,}", "\n", s)


def sizes(s: str):
    raw = len(s.encode())
    return raw, len(gzip.compress(s.encode(), 9))


def ms(byte_delta: int) -> float:
    return byte_delta / FOURG_BYTES_PER_SEC * 1000


def segments(n: int) -> int:
    return (n + MSS - 1) // MSS


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check-live", action="store_true",
                    help="also verify Pages still serves the site gzipped")
    args = ap.parse_args()

    src = (ROOT / "index.html").read_text(encoding="utf-8")
    raw, gz = sizes(src)
    nc_raw, nc_gz = sizes(strip_comments(src))
    mn_raw, mn_gz = sizes(minify(src))

    print("  variant                 raw    gzipped   segments")
    for name, r, g in (("as shipped", raw, gz),
                       ("comments stripped", nc_raw, nc_gz),
                       ("fully minified", mn_raw, mn_gz)):
        print(f"  {name:<20} {r:>6}   {g:>6}   {segments(g):>4}")

    print()
    print(f"  first congestion window   {WINDOW} bytes ({INITCWND} x {MSS})")
    pct = 100 * gz / WINDOW
    print(f"  this page gzipped         {gz} bytes ({pct:.0f}% of the window)")
    print(f"  headroom                  {WINDOW - gz} bytes")
    print(f"  round trips for the page  {1 if gz <= WINDOW else 2}")

    print()
    print("  change                saves (gz)   on 4G      round trips saved")
    for label, delta in (("strip all comments", gz - nc_gz),
                         ("full minification", gz - mn_gz)):
        rt = segments(gz) - segments(gz - delta)
        # A saving only matters if it removes a round trip, i.e. drops the
        # payload below the congestion window. It cannot here.
        rt_saved = 0 if gz <= WINDOW else rt
        print(f"  {label:<20}  {delta:>6} B   {ms(delta):>6.2f} ms   {rt_saved:>10}")

    print()
    print("  splitting into index.html + style.css + script.js")
    print("    requests                    1 -> 3")
    print("    round trips to first paint  1 -> 2   (CSS is render-blocking and")
    print("                                          undiscoverable until the")
    print("                                          HTML has arrived)")
    print("    bytes saved                 0        (+2 sets of headers)")

    if args.check_live:
        import urllib.request
        url = "https://riccardocereghino.github.io/cereghino.me/"
        req = urllib.request.Request(url, headers={"Accept-Encoding": "br, gzip"})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                enc = r.headers.get("content-encoding")
                length = r.headers.get("content-length")
            print()
            print(f"  live: content-encoding: {enc}  content-length: {length}")
            if enc not in ("gzip", "br"):
                print("  WARNING: Pages is not compressing; performance.md assumes it does",
                      file=sys.stderr)
                return 1
        except Exception as e:  # network is optional, never fail the run on it
            print(f"\n  live check skipped: {e}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
