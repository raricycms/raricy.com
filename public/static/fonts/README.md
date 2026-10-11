# Web fonts

These unmodified WOFF2 files are served from this site. All three families use the
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
- Dynamic numeric fields reuse these files through the CSS family alias
  `JetBrains Mono Numeric`, restricted to digits and numeric punctuation. Other
  characters in these fields fall back to the body font; no additional font
  binaries are bundled.

The CSS uses `font-display: swap`. Font loading requires no third-party network
requests. Chinese text continues to use system fallback fonts; math typography
continues to use the separate MathJax fonts.
