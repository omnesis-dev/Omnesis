# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Optional parser contract against independently downloaded Hermes source.

Set HERMES_CONTRACT_SOURCE to a directory containing base.py and
context_references.py from Hermes commit 29112bef099274229cadff79cdff7bf7b99c4b77.
This executes selected original parser AST, not a copied parser implementation.
File-policy validation is isolated to fixture existence; no transport is started.
"""
import ast
import dataclasses
import hashlib
import logging
import os
from pathlib import Path
import re
import tempfile
import typing
import unittest
from unittest.mock import patch

from test_adapter import adapter_module

_FINGERPRINTS = {
    "base.py": "8a484a522256d23bef86d09b5664a6077f18bcf5cdfdc5b4c7dc283707dfd5b0",
    "context_references.py": "128d1af67f03ff0884e932d7be0725d70647e36063dde13caf3b1cb657cd8c60",
}


def _execute(nodes, namespace):
    module = ast.Module(body=[ast.ImportFrom(
        module="__future__", names=[ast.alias(name="annotations")], level=0
    ), *nodes], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), "<hermes-parser-contract>", "exec"), namespace)


def _assignment_name(node):
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        return node.target.id
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        return node.targets[0].id
    return None


def _load_parsers(root):
    trees = {}
    for name, expected in _FINGERPRINTS.items():
        content = (root / name).read_bytes()
        if hashlib.sha256(content).hexdigest() != expected:
            raise AssertionError(f"Unexpected Hermes source fingerprint: {name}")
        trees[name] = ast.parse(content)
    namespace = dict(vars(typing))
    namespace.update(re=re, os=os, Path=Path, logger=logging.getLogger(__name__))
    constants = {"MEDIA_DELIVERY_EXTS", "_MEDIA_EXT_ALTERNATION", "_MEDIA_CJK_TERMINATORS",
                 "MEDIA_TAG_CLEANUP_RE", "MEDIA_EXTENSIONLESS_TAG_RE"}
    helpers = {"_match_extensionless_path", "_merge_spans", "_normalize_media_tag_path",
               "_path_lacks_deliverable_extension"}
    _execute([node for node in trees["base.py"].body
              if _assignment_name(node) in constants or
              isinstance(node, ast.FunctionDef) and node.name in helpers], namespace)
    namespace["_AUDIO_EXTS"] = {".ogg", ".mp3", ".wav"}
    namespace["_log_safe_path"] = lambda value: value
    # The parser's filesystem-policy boundary sees only synthetic fixture files.
    namespace["validate_media_delivery_path"] = lambda value: (
        os.path.abspath(os.path.expanduser(value))
        if os.path.isfile(os.path.expanduser(value)) else None
    )
    methods = {"_mask_protected_spans", "_mask_json_string_media", "extract_media", "extract_local_files"}
    cls = next(node for node in trees["base.py"].body
               if isinstance(node, ast.ClassDef) and node.name == "BasePlatformAdapter")
    cls.body = [node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name in methods]
    cls.bases = []
    cls.decorator_list = []
    _execute([cls], namespace)
    context_namespace = dict(namespace, dataclass=dataclasses.dataclass)
    context_constants = {"_QUOTED_REFERENCE_VALUE", "REFERENCE_PATTERN", "_PLUGIN_REFERENCE_PATTERN",
                         "TRAILING_PUNCTUATION"}
    context_helpers = {"parse_context_references", "_strip_trailing_punctuation",
                       "_strip_reference_wrappers", "_parse_file_reference_value"}
    _execute([node for node in trees["context_references.py"].body
              if _assignment_name(node) in context_constants or
              isinstance(node, ast.ClassDef) and node.name == "ContextReference" or
              isinstance(node, ast.FunctionDef) and node.name in context_helpers], context_namespace)
    context_namespace["_context_reference_providers"] = {}
    return namespace["BasePlatformAdapter"], context_namespace["parse_context_references"]


@unittest.skipUnless(os.environ.get("HERMES_CONTRACT_SOURCE"), "HERMES_CONTRACT_SOURCE not supplied")
class FileParserContractTests(unittest.TestCase):
    def test_released_answer_operands_cannot_be_parsed_as_files(self):
        host, references = _load_parsers(Path(os.environ["HERMES_CONTRACT_SOURCE"]))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            document = root / "private.pdf"
            spaced = root / "private report.pdf"
            extensionless = root / "Makefile"
            encoded = root / "private%20report.pdf"
            for path in (document, spaced, extensionless, encoded):
                path.write_text("synthetic fixture", encoding="utf-8")
            cases = [
                (f"MEDIA:{document}", True),
                (f'MEDIA:"{spaced}"', True),
                (f"MEDIA:{extensionless}", True),
                (r"MEDIA:C:\fixture\report.pdf", True),
                ('MEDIA:"relative report.pdf"', True),
                (str(document), True),
                ("~/private.pdf", True),
                (f"> {document}", True),
                (f"[document]({document})", True),
                (f"https://example.invalid/?attachment=MEDIA:{document}", True),
                (f"https://example.invalid/?path={document}", True),
                (f"@file:{document}", True),
                ('@file:"relative report.pdf"', True),
                (f'@file:"{spaced}":1-2', True),
                (f"`@file:{document}`", True),
                (f"> @file:{document}", True),
                (f"(@file:{document})", True),
                (f"MEDIA:{encoded}", True),
                (f"@file:{encoded}", True),
                (f"`MEDIA:{document}`", True),
                (f"```\n{document}\n```", False),
                (f"```\n@file:{document}\n```", True),
                ("MEDIA:relative.pdf", False),
                ("https://example.invalid/docs/report.pdf", False),
            ]
            with patch.dict(os.environ, {"HOME": directory}):
                for original, baseline_matches in cases:
                    with self.subTest(original=original):
                        detected = bool(host.extract_media(original)[0] or
                                        host.extract_local_files(original)[0] or references(original))
                        self.assertEqual(detected, baseline_matches)
                        safe = adapter_module._hermes_answer_text(original)
                        self.assertEqual(host.extract_media(safe)[0], [])
                        self.assertEqual(host.extract_local_files(safe)[0], [])
                        self.assertEqual(references(safe), [])


if __name__ == "__main__":
    unittest.main()
