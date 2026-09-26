---
"omnesis": patch
---

The list of sources you can add opens quickly again on slower machines: the gateway draws each source's SVG icon once and reuses it, where it used to redraw every icon on every request, which took tens of seconds on a small machine.
