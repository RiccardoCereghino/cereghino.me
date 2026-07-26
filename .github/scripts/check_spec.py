#!/usr/bin/env python3
"""Static guards for the properties the landing page spec locks down.

Everything here is checkable without a browser. Anything that needs layout or
computed style lives in check_render.mjs instead.

stdlib only, on purpose: this repo ships one self-contained file and should not
grow a dependency tree to test it.
"""

import re
import sys
from html.parser import HTMLParser
from pathlib import Path

# Optional argv[1] lets the guards run against a mutated copy of the site, which
# is how they are tested for the ability to actually fail.
ROOT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]
INDEX = ROOT / "index.html"
CNAME = ROOT / "CNAME"

SIZE_LIMIT = 100_000  # spec: "under 100KB total"
CANONICAL = "https://cereghino.me/"
LOCKED_ROWS = [
    "Name", "Location", "Role", "Stack", "Languages",
    "Packages", "Uptime", "LinkedIn", "GitHub", "dev.to",
]
# Subresource-loading attributes. A page with zero external requests is the
# whole performance argument, so treat any of these pointing off-box as fatal.
SUBRESOURCE = {
    "script": "src", "img": "src", "iframe": "src", "source": "src",
    "video": "src", "audio": "src", "embed": "src", "track": "src",
}

results = []


def check(name, ok, detail=""):
    results.append((bool(ok), name, detail))


class Doc(HTMLParser):
    """Collects just enough structure for the assertions below."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tags = []                # (tag, dict(attrs))
        self.dt_text = []             # ordered <dt> contents
        self.classes = []             # (class-list, tag, dict(attrs))
        self._stack = []
        self._capture = None
        self._buf = []
        self.sr_only_text = []
        self.uptime_dd_children = 0
        self.uptime_dd_text = ""
        self._in_uptime_dd = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        self.tags.append((tag, a))
        self._stack.append(tag)
        cls = (a.get("class") or "").split()
        if cls:
            self.classes.append((cls, tag, a))
        if tag == "dt":
            self._capture = "dt"
            self._buf = []
        elif "sr-only" in cls:
            self._capture = "sr"
            self._buf = []
        elif tag == "dd" and a.get("id") == "uptime":
            self._in_uptime_dd = True
        elif self._in_uptime_dd:
            self.uptime_dd_children += 1

    def handle_endtag(self, tag):
        if tag == "dt" and self._capture == "dt":
            self.dt_text.append("".join(self._buf).strip())
            self._capture = None
        elif self._capture == "sr" and tag in ("span", "div", "p"):
            self.sr_only_text.append("".join(self._buf).strip())
            self._capture = None
        elif tag == "dd" and self._in_uptime_dd:
            self._in_uptime_dd = False
        if self._stack and self._stack[-1] == tag:
            self._stack.pop()

    def handle_data(self, data):
        if self._capture:
            self._buf.append(data)
        if self._in_uptime_dd:
            self.uptime_dd_text += data


def main():
    if not INDEX.exists():
        print("FATAL: index.html missing", file=sys.stderr)
        return 1

    src = INDEX.read_text(encoding="utf-8")
    raw = INDEX.stat().st_size
    doc = Doc()
    doc.feed(src)

    def meta(prop=None, name=None):
        for tag, a in doc.tags:
            if tag == "meta" and (
                (prop and a.get("property") == prop) or (name and a.get("name") == name)
            ):
                return a.get("content")
        return None

    def link(rel):
        for tag, a in doc.tags:
            if tag == "link" and a.get("rel") == rel:
                return a.get("href")
        return None

    # ---- budget -----------------------------------------------------------
    check("size under 100KB", raw <= SIZE_LIMIT, f"{raw:,} bytes")

    # ---- CNAME: the spec says ship it and never delete it -----------------
    check("CNAME exists at repo root", CNAME.exists())
    if CNAME.exists():
        check(
            "CNAME contains cereghino.me",
            CNAME.read_text().strip() == "cereghino.me",
            repr(CNAME.read_text().strip()),
        )

    # ---- exactly one blinking cursor --------------------------------------
    cursors = [c for c in doc.classes if "cursor" in c[0]]
    check("exactly one cursor element", len(cursors) == 1, f"found {len(cursors)}")

    # ---- uptime is computed, never hardcoded ------------------------------
    has_uptime_dd = any(
        t == "dd" and a.get("id") == "uptime" for t, a in doc.tags
    )
    check("<dd id=\"uptime\"> present", has_uptime_dd)
    check(
        "uptime <dd> ships empty",
        doc.uptime_dd_text.strip() == "" and doc.uptime_dd_children == 0,
        repr(doc.uptime_dd_text.strip()),
    )
    # A hardcoded value looks like two or more comma-joined "<N> <unit>" pairs.
    # Matching a single pair would false-positive on prose in the comments
    # (e.g. "counted as 366 days"), which is why the pair is required.
    literal = re.search(
        r"\d+\s*(?:years?|days?|hours?)\s*,\s*\d+\s*(?:days?|hours?|mins?)", src)
    check(
        "no hardcoded uptime literal in source",
        literal is None,
        literal.group(0) if literal else "",
    )
    # Epoch year only. Whether the arithmetic is *correct* is not a job for a
    # regex — check_uptime.mjs executes the shipped algorithm against real
    # leap-year boundaries instead.
    check("uptime computed from a 2010 epoch", "Date.UTC(2010" in src)

    # ---- the noscript coupling --------------------------------------------
    # If the row id is renamed, the <noscript> rule silently stops working and
    # JS-off visitors get a bare "Uptime:" key again. Assert both halves agree.
    row_ids = [a.get("id") for t, a in doc.tags if a.get("id", "").startswith("row-")]
    noscript_rule = re.search(r"<noscript><style>#([\w-]+)\{display:none\}", src)
    check("noscript hides a row", noscript_rule is not None)
    if noscript_rule:
        target = noscript_rule.group(1)
        check(
            "noscript target element exists",
            target in row_ids,
            f"rule targets #{target}; row ids: {row_ids}",
        )

    # ---- locked row order -------------------------------------------------
    check(
        "row order matches spec",
        doc.dt_text == LOCKED_ROWS,
        " | ".join(doc.dt_text) if doc.dt_text != LOCKED_ROWS else "",
    )

    # ---- canonical identity ----------------------------------------------
    check("canonical is cereghino.me", link("canonical") == CANONICAL, str(link("canonical")))
    check("og:url is cereghino.me", meta(prop="og:url") == CANONICAL, str(meta(prop="og:url")))
    for m in ("og:title", "og:description", "og:type"):
        check(f"{m} present", meta(prop=m) is not None)
    for m in ("twitter:card", "twitter:title", "twitter:description"):
        check(f"{m} present", meta(name=m) is not None)

    # ---- favicon preserved ------------------------------------------------
    icon = link("icon") or ""
    check("inline svg favicon intact", icon.startswith("data:image/svg+xml"), icon[:40])

    # ---- zero external requests ------------------------------------------
    external = []
    for tag, a in doc.tags:
        attr = SUBRESOURCE.get(tag)
        if attr and re.match(r"https?://", a.get(attr, "")):
            external.append(f"<{tag} {attr}={a[attr]}>")
        if tag == "link" and a.get("rel") in ("stylesheet", "preload", "prefetch"):
            external.append(f"<link rel={a.get('rel')}>")
    check("no external subresources", not external, "; ".join(external))

    # ---- accessibility / structure ---------------------------------------
    check("prefers-reduced-motion handled", "prefers-reduced-motion" in src)
    logo = [a for cls, t, a in doc.classes if "logo" in cls and t == "pre"]
    check("logo <pre> is aria-hidden", bool(logo) and logo[0].get("aria-hidden") == "true")
    check("sr-only \"RC\" label present", "RC" in doc.sr_only_text, str(doc.sr_only_text))
    h1s = [t for t, _ in doc.tags if t == "h1"]
    check("exactly one <h1>", len(h1s) == 1, f"found {len(h1s)}")
    html_tag = next((a for t, a in doc.tags if t == "html"), {})
    check("<html lang> set", bool(html_tag.get("lang")), str(html_tag.get("lang")))

    # ---- report -----------------------------------------------------------
    width = max(len(n) for _, n, _ in results)
    failed = 0
    for ok, name, detail in results:
        mark = "ok  " if ok else "FAIL"
        line = f"  [{mark}] {name.ljust(width)}"
        if detail and not ok:
            line += f"   <- {detail}"
        elif detail and ok:
            line += f"   {detail}"
        print(line)
        failed += (not ok)

    print()
    print(f"  {len(results) - failed}/{len(results)} checks passed")
    if failed:
        print(f"\n  {failed} spec guard(s) failed.", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
