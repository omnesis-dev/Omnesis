---
"omnesis": patch
---

Source icons rasterize much faster, which matters most on a Mac. Drawing an SVG icon read every font installed on the machine, once per icon, and sources waited their turn for it when they first synced and the first time the Add Source list opened. An icon now reads the fonts only if it draws text. Icons look the same.
