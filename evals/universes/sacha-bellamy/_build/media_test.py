# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Binary structure checks for the local generator; no OCR/STT inference."""

import base64
from pathlib import Path
import re
import struct
import subprocess
import tempfile
import unittest
import wave
import zlib
import zipfile
import xml.etree.ElementTree as ET

from media import spoken_dates, residence_worksheet_docx


def page_streams(path):
    """Decode ReportLab's non-image content streams, preserving real PDF operators."""
    data = path.read_bytes()
    if not data.startswith(b"%PDF-"):
        raise AssertionError("Expected actual PDF bytes")
    streams = []
    for match in re.finditer(rb"\d+ 0 obj\s*(.*?)\s*endobj", data, re.S):
        obj = match.group(1)
        if b"stream" not in obj or b"/Subtype /Image" in obj:
            continue
        header, content = obj.split(b"stream\n", 1)
        content = content.rsplit(b"endstream", 1)[0].strip()
        if b"/ASCII85Decode" in header:
            content = base64.a85decode(content, adobe=True)
        if b"/FlateDecode" in header:
            content = zlib.decompress(content)
        streams.append(content)
    return data, b"\n".join(streams)


class MediaTests(unittest.TestCase):
    def test_blank_residence_docx_is_a_valid_empty_word_package(self):
        with tempfile.TemporaryDirectory(prefix="worksheet-test-") as directory:
            path = Path(directory) / "blank.docx"
            residence_worksheet_docx(path)
            with zipfile.ZipFile(path) as package:
                self.assertIsNone(package.testzip())
                namespaces = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
                document = ET.fromstring(package.read("word/document.xml"))
                relationships = ET.fromstring(package.read("_rels/.rels"))
                self.assertEqual(next(iter(relationships)).attrib["Target"], "word/document.xml")
                content_types = package.read("[Content_Types].xml")
                self.assertIn(b"wordprocessingml.document.main+xml", content_types)
                rows = document.findall(".//w:tbl/w:tr", namespaces)
                self.assertEqual(len(rows), 11)
                self.assertEqual([cell.find(".//w:t", namespaces).text for cell in rows[0].findall("w:tc", namespaces)],
                                 ["From", "To", "UK address", "Evidence / notes"])
                for row in rows[1:]:
                    cells = row.findall("w:tc", namespaces)
                    self.assertEqual(len(cells), 4)
                    self.assertTrue(all(not cell.find(".//w:t", namespaces).text for cell in cells))
                text = " ".join(node.text or "" for node in document.findall(".//w:t", namespaces))
                self.assertIn("past ten years", text)
                self.assertIn("Not an official citizenship form", text)
                self.assertNotIn("Bellamy", text)
                self.assertNotIn("Example Street", text)
            copy = Path(directory) / "copy.docx"
            residence_worksheet_docx(copy)
            self.assertEqual(path.read_bytes(), copy.read_bytes())

    def test_spoken_date_preserves_exact_day_without_iso_digits(self):
        self.assertEqual(spoken_dates("Tuesday 2026-10-06 at five thirty"),
                         "Tuesday October 6, 2026 at five thirty")

    def test_real_generator_emits_scans_native_pdf_and_pcm_speech(self):
        module = Path(__file__).with_name("media.mjs").as_uri()
        script = """
          const { generateMedia } = await import(process.argv[1]);
          generateMedia(process.argv[2], {
            receipt: 'Studio Northstar receipt SN-0042\\nPaper lantern lights: 42.00',
            tenancy: [{content: 'Oldest tenancy\\n42 Example Street\\nDeposit: 900.00'}],
            warranty: 'Stellar Sound warranty\\nCoverage through October 6, 2028',
            eveningTicket: 'Fictional tickets\\nStalls, Row H, Seat 12\\nStalls, Row H, Seat 13',
            eveningTenancy: 'Fictional short-let\\nFlat Example, Example House, Gower Street, Bloomsbury, London',
            audioText: 'Collect the lantern lights on Tuesday 2026-10-06 at five thirty.'
          });
        """
        with tempfile.TemporaryDirectory(prefix="omnesis-media-test-") as directory:
            subprocess.run(["node", "--input-type=module", "-e", script, module, directory],
                           check=True, capture_output=True, text=True)
            root = Path(directory) / "assets"
            self.assertTrue(zipfile.is_zipfile(root / "uk-residence-history-blank.docx"))
            for name in ["receipt-wa8842", "oldest-tenancy"]:
                data, content = page_streams(root / f"{name}.pdf")
                self.assertIn(b"/Subtype /Image", data)
                self.assertIn(b" Do", content)  # A rendered image is present on the page.
                self.assertNotRegex(content, rb"\b(?:Tj|TJ)\b")  # No native/hidden OCR text.
                self.assertTrue((root / f"{name}.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))
            _, content = page_streams(root / "ember-mini-warranty.pdf")
            self.assertIn(b"Stellar Sound warranty", content)
            self.assertRegex(content, rb"\bTj\b")
            _, ticket_content = page_streams(root / "evening-tickets.pdf")
            self.assertIn(b"Seat 12", ticket_content)
            self.assertIn(b"Seat 13", ticket_content)
            _, tenancy_content = page_streams(root / "evening-shortlet.pdf")
            self.assertIn(b"Gower Street", tenancy_content)
            self.assertRegex(tenancy_content, rb"\bTj\b")
            with wave.open(str(root / "lantern-promise.wav"), "rb") as audio:
                self.assertEqual(audio.getnchannels(), 1)
                self.assertEqual(audio.getsampwidth(), 2)
                self.assertGreater(audio.getframerate(), 8000)
                self.assertGreater(audio.getnframes() / audio.getframerate(), 3)
                samples = struct.unpack("<" + "h" * audio.getnframes(), audio.readframes(audio.getnframes()))
                self.assertGreater(max(samples), 100)
                self.assertLess(min(samples), -100)


if __name__ == "__main__":
    unittest.main()
