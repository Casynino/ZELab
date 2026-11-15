"""Put a new QR code into a factory die-line PDF, ready to print (15 Nov 2026).

    python3 dieline_qr.py <factory die-line.pdf> <out.pdf> <70x36|77x44>

Needs pymupdf, segno and numpy (a scratch venv, not the repo).

What it does, and why each step is there:
  * The box's QR is ONE image object placed several times (70x36: xref 2449, 3 places;
    77x44: xref 5539, 4 places). Its stream is rewritten in place, so every placement keeps
    its exact position and size and nothing else in the file moves.
  * The new code is drawn on the original picture's pixel grid x8, with the code in the
    same box inside the picture, so it prints at the same size in the same spot.
  * 1 bit per pixel, palette white / C0 M0 Y0 K100: black ink only, even through a
    colour-managed RIP (an ICC grey image turns into four-colour black there).
  * The page's /PieceInfo is removed. It holds Illustrator's own hidden copy of the
    artwork (AIPDFPrivateData) — with the OLD codes — and Illustrator opens that copy
    instead of the PDF page. A factory opens die-lines in Illustrator. The page
    thumbnails and the XMP (which carries old thumbnails) go with it.

Then check the result: decode every placement and every image object, and compare a
render with the factory file pixel by pixel outside the codes (must be 0 changed).
"""
import re
import sys

import numpy as np
import pymupdf
import segno

BOXES = {
    # image xref, encoded text, original picture size (px), code box inside it (x0, y0, x1, y1 inclusive)
    "70x36": (2449, "HTTPS://WWW.ZELAB.SITE/P", (708, 704), (15, 9, 694, 688)),
    "77x44": (5539, "HTTPS://WWW.ZELAB.SITE/P2", (303, 295), (9, 7, 291, 289)),
}

def main(src, out, box):
    xref, text, (w, h), (x0, y0, x1, y1) = BOXES[box]
    q = segno.make(text, error="q", boost_error=False, micro=False)
    assert q.version == 2 and q.error == "Q", "the code must stay 25 x 25 modules"
    m = np.array([[1 if v else 0 for v in row] for row in q.matrix], dtype=np.uint8)
    n = m.shape[0]
    S = 8
    img = np.zeros((h * S, w * S), np.uint8)                      # palette 0 = white
    xs = [round(x0 * S + i * (x1 + 1 - x0) * S / n) for i in range(n + 1)]
    ys = [round(y0 * S + i * (y1 + 1 - y0) * S / n) for i in range(n + 1)]
    for r in range(n):
        for c in range(n):
            if m[r, c]:
                img[ys[r]:ys[r + 1], xs[c]:xs[c + 1]] = 1         # palette 1 = K100
    doc = pymupdf.open(src)
    assert doc.xref_get_key(xref, "Subtype") == ("name", "/Image"), "not the QR picture — wrong file?"
    doc.update_stream(xref, np.packbits(img, axis=1).tobytes(), compress=True)
    for key, value in (("Width", str(w * S)), ("Height", str(h * S)), ("BitsPerComponent", "1"),
                       ("ColorSpace", "[/Indexed /DeviceCMYK 1 <00000000000000FF>]"),
                       ("Decode", "null"), ("DecodeParms", "null")):
        doc.xref_set_key(xref, key, value)
    targets = [doc.pdf_catalog()] + [page.xref for page in doc]
    for x in targets:
        for key in ("PieceInfo", "Thumb", "LastModified", "Metadata"):
            doc.xref_set_key(x, key, "null")
        src_obj = doc.xref_object(x, compressed=True)
        clean = re.sub(r"/(PieceInfo|Thumb|LastModified|Metadata) null", "", src_obj)
        if clean != src_obj:
            doc.update_object(x, clean)
    names = {"70x36": "Pepa Ndogo (Brown) Bila Filter", "77x44": "Pepa Ndogo Kubwa (Brown) Bila Filter"}
    doc.set_metadata({"title": f"{names[box]} - {box} die-line - print file 15 Nov 2026", "author": "ZELab",
                      "subject": "Print file. QR codes open " + text,
                      "creator": doc.metadata.get("creator", ""), "producer": doc.metadata.get("producer", "")})
    doc.save(out, garbage=1, deflate=False)                       # garbage=1 drops the orphaned private data
    print(out, "->", text)

if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[3] not in BOXES:
        raise SystemExit(__doc__)
    main(*sys.argv[1:])
