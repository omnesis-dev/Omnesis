# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

import gzip
import hashlib
import pathlib
import tempfile
import unittest

from footprint import measure, totals


class FootprintTests(unittest.TestCase):
    def test_one_pass_extension_roles_include_both_size_measurements(self):
        files = {"cli": {"bytes": 100, "gzip6_bytes": 50},
                 "core": {"bytes": 80, "gzip6_bytes": 30},
                 "adapter": {"bytes": 20, "gzip6_bytes": 8},
                 "model": {"bytes": 300, "gzip6_bytes": 100}}
        result = totals(files, (role for role in files if role != "cli"))
        self.assertEqual(result, {"bytes": 400, "gzip6_bytes": 138})
        self.assertEqual(totals(files, ("core", "adapter")),
                         {"bytes": 100, "gzip6_bytes": 38})

    def test_streamed_measurements_match_actual_file_and_gzip(self):
        payload = "Synthetic Unicode artifact é 漢字\n".encode() * 4096
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "artifact"
            path.write_bytes(payload)
            result = measure(path)
        self.assertEqual(result["bytes"], len(payload))
        self.assertEqual(result["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(result["gzip6_bytes"], len(gzip.compress(payload, compresslevel=6, mtime=0)))


if __name__ == "__main__":
    unittest.main()
