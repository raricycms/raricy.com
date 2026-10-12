#!/usr/bin/env python3
"""Generate the committed Raricy Numeric WOFF2 assets; not part of the app build.

Requires fonttools[woff]==4.60.1 and brotli==1.1.0. See public/static/fonts/README.md.
"""

import argparse
from io import BytesIO
from pathlib import Path

from fontTools import subset
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "public/static/fonts/jetbrains-mono"
DEST = ROOT / "public/static/fonts/raricy-numeric"
# Keep this whitelist in sync with base/_fonts.scss's unicode-range.
CODEPOINTS = {0x23, 0x24, 0x25, *range(0x2B, 0x3B), 0xD7, 0x2030, 0x2212}
STYLES = ("Regular", "Bold", "Italic", "BoldItalic")


def outline(font, glyph):
    pen = RecordingPen()
    font.getGlyphSet()[glyph].draw(pen)
    return pen.value


def generate(style):
    source = TTFont(SOURCE / f"JetBrainsMono-{style}.woff2", recalcTimestamp=False)
    font = TTFont(SOURCE / f"JetBrainsMono-{style}.woff2", recalcTimestamp=False)
    source_cmap = source.getBestCmap()
    # Only the font's character map changes: text, copying and input remain digit 0.
    for table in font["cmap"].tables:
        if table.isUnicode():
            table.cmap[ord("0")] = source_cmap[ord("O")]

    options = subset.Options()
    options.layout_features = []
    options.glyph_names = True
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.name_languages = ["*"]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=CODEPOINTS)
    subsetter.subset(font)

    display_style = "Bold Italic" if style == "BoldItalic" else style
    names = {
        1: "Raricy Numeric",
        2: display_style,
        3: f"1.000;Raricy;RaricyNumeric-{style}",
        4: f"Raricy Numeric {display_style}",
        5: "Version 1.000",
        6: f"RaricyNumeric-{style}",
    }
    for record in font["name"].names:
        if record.nameID in names:
            record.string = names[record.nameID].encode(record.getEncoding())
    font["head"].fontRevision = 1.0
    font.flavor = "woff2"
    output = BytesIO()
    font.save(output)
    data = output.getvalue()

    # Check the serialized result: exact original outlines/metrics, O for 0, no letters.
    result = TTFont(BytesIO(data))
    cmap = result.getBestCmap()
    assert set(cmap) == CODEPOINTS, f"{style}: unexpected character coverage"
    for cp in CODEPOINTS:
        original = source_cmap[ord("O") if cp == ord("0") else cp]
        assert outline(result, cmap[cp]) == outline(source, original), (style, cp)
        assert result["hmtx"][cmap[cp]] == source["hmtx"][original], (style, cp)
    assert len({result["hmtx"][cmap[cp]][0] for cp in CODEPOINTS}) == 1
    assert len(data) < 10_000, f"{style}: subset unexpectedly large"
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify committed assets")
    args = parser.parse_args()
    if not args.check:
        DEST.mkdir(parents=True, exist_ok=True)
    for style in STYLES:
        data = generate(style)
        target = DEST / f"RaricyNumeric-{style}.woff2"
        if args.check:
            assert target.read_bytes() == data, f"Regenerate {target.name}"
        else:
            target.write_bytes(data)
        print(f"{target.name}: {len(data):,} bytes")
    # Preserve the license text, normalizing upstream trailing spaces and line endings.
    license_text = "".join(
        line.rstrip() + "\n"
        for line in (SOURCE / "OFL.txt").read_text(encoding="utf-8").splitlines()
    )
    if args.check:
        assert (DEST / "OFL.txt").read_text(encoding="utf-8") == license_text
    else:
        (DEST / "OFL.txt").write_text(license_text, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
