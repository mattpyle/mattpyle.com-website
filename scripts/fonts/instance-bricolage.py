"""Pin Bricolage Grotesque's optical-size axis and re-emit the two woff2 subsets.

WHY: the variable latin subset Google serves is 77KB, and it gates the hero H1 —
the LCP element on every redesigned page. Pinning `opsz` drops a whole set of
deltas and takes the file to 39KB, a 49% cut on the critical path. Limiting
`wght` to the 400-800 the site actually declares takes a further 1.3KB.

WHAT IT COSTS: with the axis gone, `font-optical-sizing: auto` has nothing to
track, so every size renders with ONE optical cut instead of its own. The pin is
96 — the axis maximum, and the file's own default instance — which is chosen so
that:

  * the hero H1 is unchanged. At 176px (and at the 82px post H1) the browser was
    already clamping opsz to the axis maximum, so those render byte-for-byte as
    they did before;
  * the metric-matched fallback in src/styles/global.css stays valid. Those
    numbers were computed from the default instance, and pinning at the default
    leaves the default's metrics alone — measured after the fact with
    @capsizecss/unpack, which reports the same values.

Text set between 22px and 34px — list titles, section headings, prose h2 — is
about 8% tighter than it was, because it used to get its own optical cut and now
wears the display one. That is the deliberate trade, and it is one number: change
OPSZ below and re-run to move it.

PREREQUISITES, not repo dependencies: Python 3 with fonttools and brotli.
This runs by hand when a font changes, never in CI or in `npm run build`.

    python -m venv .fontenv
    .fontenv/Scripts/pip install fonttools brotli      # POSIX: .fontenv/bin/pip
    .fontenv/Scripts/python scripts/fonts/instance-bricolage.py

It reads the CURRENT files in public/fonts/ and writes the pinned pair beside
them under a new name. The rename is required, not cosmetic: /fonts/* is served
with an immutable cache header (vercel.json), so a changed file at an unchanged
URL is a file some browsers never fetch again. Delete the old pair and update the
two `src:` URLs and the two preloads in src/layouts/Layout.astro by hand.
"""

import os
import sys

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

OPSZ = 96
WGHT = (400, 800, 800)

SUBSETS = [
    ("public/fonts/bricolage-grotesque-latin.woff2", "public/fonts/bricolage-grotesque-opsz96-latin.woff2"),
    ("public/fonts/bricolage-grotesque-latin-ext.woff2", "public/fonts/bricolage-grotesque-opsz96-latin-ext.woff2"),
]


def main() -> int:
    for source, target in SUBSETS:
        if not os.path.exists(source):
            print(f"missing {source} — run this from the repo root", file=sys.stderr)
            return 1

        font = TTFont(source)
        # No separate `subset` pass: the input is already Google's unicode-range
        # subset, and instancing is what removes the bytes here. Re-subsetting to
        # the same cmap would only risk dropping layout features the design uses.
        instancer.instantiateVariableFont(
            font, {"opsz": OPSZ, "wght": WGHT}, inplace=True, updateFontNames=False
        )
        font.flavor = "woff2"
        font.save(target)

        before = os.path.getsize(source)
        after = os.path.getsize(target)
        print(f"{target}  {before} -> {after} bytes  ({100 - round(after / before * 100)}% smaller)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
