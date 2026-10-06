# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Deterministic local assets. Requires Pillow, reportlab and libespeak-ng.

Use through media.mjs; OMNESIS_SYNTH_PYTHON selects an optional virtualenv.
Image-only PDFs contain no hidden OCR text. Speech uses the system's local
eSpeak NG library in retrieval mode and never opens a sound device or network.
Validate binary structure with `python3 _build/media_test.py`.
"""

import ctypes
import ctypes.util
import datetime
import json
from pathlib import Path
import re
import sys
import textwrap
import wave
import zipfile
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


def residence_worksheet_docx(path):
    """Create an empty personal worksheet, without names or reconstructed answers."""
    word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    ET.register_namespace("w", word)

    def tag(name):
        return f"{{{word}}}{name}"

    document = ET.Element(tag("document"))
    body = ET.SubElement(document, tag("body"))

    def paragraph(parent, text):
        node = ET.SubElement(parent, tag("p"))
        run = ET.SubElement(node, tag("r"))
        ET.SubElement(run, tag("t")).text = text

    paragraph(body, "UK residence history worksheet")
    paragraph(body, "Fictional personal worksheet for the past ten years. Not an official citizenship form.")
    paragraph(body, "Name: ____________________    Period from: __________    To: __________")
    paragraph(body, "Enter residence dates and supporting evidence. Add rows when needed; leave uncertain dates marked for review.")
    table = ET.SubElement(body, tag("tbl"))
    properties = ET.SubElement(table, tag("tblPr"))
    ET.SubElement(properties, tag("tblW"), {tag("w"): "0", tag("type"): "auto"})
    borders = ET.SubElement(properties, tag("tblBorders"))
    for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
        ET.SubElement(borders, tag(side), {tag("val"): "single", tag("sz"): "4", tag("color"): "888888"})
    grid = ET.SubElement(table, tag("tblGrid"))
    widths = (1300, 1300, 3500, 3100)
    for width in widths:
        ET.SubElement(grid, tag("gridCol"), {tag("w"): str(width)})
    for row_index in range(11):
        row = ET.SubElement(table, tag("tr"))
        row_properties = ET.SubElement(row, tag("trPr"))
        if row_index == 0:
            ET.SubElement(row_properties, tag("tblHeader"))
        else:
            ET.SubElement(row_properties, tag("trHeight"), {tag("val"): "500", tag("hRule"): "atLeast"})
        for index, width in enumerate(widths):
            cell = ET.SubElement(row, tag("tc"))
            cell_properties = ET.SubElement(cell, tag("tcPr"))
            ET.SubElement(cell_properties, tag("tcW"), {tag("w"): str(width), tag("type"): "dxa"})
            paragraph(cell, ("From", "To", "UK address", "Evidence / notes")[index] if row_index == 0 else "")
    section = ET.SubElement(body, tag("sectPr"))
    ET.SubElement(section, tag("pgSz"), {tag("w"): "11906", tag("h"): "16838"})
    ET.SubElement(section, tag("pgMar"), {tag("top"): "1000", tag("bottom"): "1000", tag("left"): "1000", tag("right"): "1000"})
    content_types = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    relationships = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    parts = {"[Content_Types].xml": content_types.encode(), "_rels/.rels": relationships.encode(),
             "word/document.xml": ET.tostring(document, encoding="utf-8", xml_declaration=True)}
    with zipfile.ZipFile(path, "w") as package:
        for name, content in parts.items():
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            package.writestr(info, content)


def spoken_dates(text):
    months = ("January", "February", "March", "April", "May", "June", "July",
              "August", "September", "October", "November", "December")

    def replace(match):
        date = datetime.date.fromisoformat(match.group())
        return f"{months[date.month - 1]} {date.day}, {date.year}"
    return re.sub(r"\b\d{4}-\d{2}-\d{2}\b", replace, text)


def scan_pdf(path, text):
    image = Image.new("RGB", (1654, 2339), "#faf9f5")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("DejaVuSans.ttf", 30)
    y = 140
    for paragraph in text.splitlines():
        for line in textwrap.wrap(paragraph, width=75) or [""]:
            if y > 2190:
                raise ValueError("Scanned fixture text exceeds one page")
            draw.text((120, y), line, fill="#292929", font=font)
            y += 46
    image.save(path.with_suffix(".png"))
    pdf = canvas.Canvas(str(path), pagesize=A4, invariant=1, pageCompression=1)
    pdf.setTitle("Synthetic scanned document")
    pdf.drawImage(ImageReader(image), 0, 0, width=A4[0], height=A4[1])
    pdf.showPage()
    pdf.save()


def native_pdf(path, text, title="Synthetic warranty document"):
    pdf = canvas.Canvas(str(path), pagesize=A4, invariant=1, pageCompression=1)
    pdf.setTitle(title)
    cursor = pdf.beginText(50, A4[1] - 60)
    cursor.setFont("Helvetica", 12)
    for paragraph in text.splitlines():
        for line in textwrap.wrap(paragraph, width=78) or [""]:
            cursor.textLine(line)
    pdf.drawText(cursor)
    pdf.showPage()
    pdf.save()


def speech_wav(path, text):
    library = ctypes.util.find_library("espeak-ng")
    if not library:
        raise RuntimeError("Install libespeak-ng and its voice data to render local speech")
    synth = ctypes.CDLL(library)
    synth.espeak_Initialize.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    synth.espeak_Initialize.restype = ctypes.c_int
    sample_rate = synth.espeak_Initialize(1, 0, None, 0)
    if sample_rate <= 0:
        raise RuntimeError("eSpeak NG initialization failed")
    chunks = []
    callback_type = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.c_void_p)

    @callback_type
    def collect(samples, count, _events):
        if count > 0:
            chunks.append(ctypes.string_at(samples, count * 2))
        return 0

    synth.espeak_SetSynthCallback.argtypes = [callback_type]
    synth.espeak_SetSynthCallback(collect)
    synth.espeak_SetVoiceByName.argtypes = [ctypes.c_char_p]
    synth.espeak_SetParameter.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
    synth.espeak_Synth.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint, ctypes.c_int,
                                 ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
    try:
        if synth.espeak_SetVoiceByName(b"en") != 0:
            raise RuntimeError("eSpeak NG English voice unavailable")
        synth.espeak_SetParameter(1, 145, 0)
        encoded = text.encode("utf-8") + b"\0"
        data = ctypes.create_string_buffer(encoded)
        if synth.espeak_Synth(data, len(encoded), 0, 1, 0, 1, None, None) != 0:
            raise RuntimeError("eSpeak NG synthesis failed")
        if synth.espeak_Synchronize() != 0:
            raise RuntimeError("eSpeak NG speech rendering failed")
        pcm = b"".join(chunks)
        if not pcm:
            raise RuntimeError("eSpeak NG produced no audio")
        with wave.open(str(path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(sample_rate)
            audio.writeframes(pcm)
    finally:
        synth.espeak_Terminate()


def main():
    out_dir = Path(sys.argv[1])
    assets = json.load(sys.stdin)
    out_dir.mkdir(parents=True, exist_ok=True)
    residence_worksheet_docx(out_dir / "uk-residence-history-blank.docx")
    scan_pdf(out_dir / "receipt-wa8842.pdf", assets["receipt"])
    scan_pdf(out_dir / "oldest-tenancy.pdf", assets["tenancy"][0]["content"])
    native_pdf(out_dir / "ember-mini-warranty.pdf", assets["warranty"])
    if assets.get("eveningTicket"):
        native_pdf(out_dir / "evening-tickets.pdf", assets["eveningTicket"], "Synthetic demonstration tickets")
    if assets.get("eveningTenancy"):
        native_pdf(out_dir / "evening-shortlet.pdf", assets["eveningTenancy"], "Synthetic demonstration tenancy")
    spoken = spoken_dates(assets["audioText"])
    speech_wav(out_dir / "lantern-promise.wav", spoken)
    if assets.get("symptomAudioText"):
        speech_wav(out_dir / "symptom-diary.wav", spoken_dates(assets["symptomAudioText"]))
    print(json.dumps({"receipt": "receipt-wa8842.pdf", "tenancy": "oldest-tenancy.pdf",
                      "warranty": "ember-mini-warranty.pdf", "audio": "lantern-promise.wav",
                      "spokenText": spoken, "residenceWorksheet": "uk-residence-history-blank.docx"}))


if __name__ == "__main__":
    main()
