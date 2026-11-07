# Web fonts

These WOFF2 files are served from this site. All families use the
SIL Open Font License 1.1, which permits bundling and redistribution with this
application. Keep each family's `OFL.txt` alongside the font files.

## Outfit

- Authors: The Outfit Project Authors.
- Upstream: https://github.com/Outfitio/Outfit-Fonts
- Distribution: Google Fonts, versioned `v15` URL, weights 100–900, Latin subset.
- Used only for the English navbar brand name, via `--font-brand`.
- `Outfit-Latin-Variable.woff2`:
  https://fonts.gstatic.com/s/outfit/v15/QGYvz_MVcBeNP4NJtEtq.woff2
- License source: https://github.com/google/fonts/blob/main/ofl/outfit/OFL.txt

## Kumbh Sans

- Authors: The KumbhSans Project Authors.
- Upstream: https://github.com/xconsau/KumbhSans
- Distribution: Google Fonts, versioned `v27` URLs, weights 100–900.
- Only the Latin and Latin Extended subsets are bundled. Unicode ranges in
  `src/styles-scss/base/_fonts.scss` match Google's CSS for these files.
- `KumbhSans-Latin-Variable.woff2`:
  https://fonts.gstatic.com/s/kumbhsans/v27/c4mw1n92AsfhuCq6tVsaoIx1LQICk0boNoq0ShNPVo0.woff2
- `KumbhSans-LatinExt-Variable.woff2`:
  https://fonts.gstatic.com/s/kumbhsans/v27/c4mw1n92AsfhuCq6tVsaoIx1LQICk0boNoq0ShNBVo0iPw.woff2
- License source: https://github.com/google/fonts/blob/main/ofl/kumbhsans/OFL.txt

## JetBrains Mono

- Authors: The JetBrains Mono Project Authors.
- Upstream release: https://github.com/JetBrains/JetBrainsMono/tree/v2.304
- Original files: `fonts/webfonts/JetBrainsMono-{Regular,Bold,Italic,BoldItalic}.woff2`.
- License source: https://github.com/JetBrains/JetBrainsMono/blob/v2.304/OFL.txt

## Raricy Numeric

- A modified numeric subset of the bundled JetBrains Mono 2.304 files, under the
  same SIL Open Font License 1.1. Upstream copyright is retained in the fonts and
  `raricy-numeric/OFL.txt`; the derivative has its own family and PostScript names.
- Digit `0` (U+0030) uses the original uppercase `O` outline and metrics. All other
  retained characters keep their original outlines, hinting and equal advance
  widths. Text still contains the digit `0`, including copying and numeric inputs.
- Coverage: `0123456789#$%+,-./:×‰−` (22 characters), matching the CSS unicode range.
  Letters and Chinese text in numeric fields fall back to the body font.
- Four small WOFF2 files preserve regular, bold, italic and bold italic styling.
  Code blocks and editors continue to use the unmodified JetBrains Mono files.
- Rebuild from the committed source fonts with `scripts/make-numeric-fonts.py`.
  Python is only an optional asset-generation tool; normal npm builds and the
  running app use the committed WOFF2 files without Python.

```sh
python -m pip install 'fonttools[woff]==4.60.1' 'brotli==1.1.0'
python scripts/make-numeric-fonts.py          # 重新生成
npm run fonts:check:regen                     # 可复现性校验（需要 Python）
npm run fonts:check                           # 默认守卫：存在性/魔数/哈希/OFL（仅 Node）
```

The generator verifies character coverage, original outlines and widths, the `O`
replacement, and the serialized assets. `--check` also verifies reproducible bytes
and the bundled license without rewriting files.

`npm run fonts:check` is the dependency-free guard: it pins the SHA-256 of every
committed WOFF2 (update it deliberately when regenerating), checks the WOFF2 magic
and that each numeric subset stays small, and requires an `OFL.txt` per family.

The CSS uses `font-display: swap`. Font loading requires no third-party network
requests. Chinese text continues to use system fallback fonts.
