---
"omnesis": patch
---

An Obsidian vault with a symlink to another note, or two notes sharing a frontmatter `id`, syncs again. Each note keeps an identity of its own, a file symlink is skipped and its target is read once under its real path, and a note whose identity changes removes its old document.
