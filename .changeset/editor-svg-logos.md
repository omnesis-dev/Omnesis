---
"omnesis": patch
---

Provider logos that Models.dev serves as editor exports now display in the portal and apps. The gateway strips Inkscape metadata (comments, editor namespaces, `<metadata>` blocks) and rewrites plain paint styles such as `style="fill:#303030"` into attributes before its strict SVG check, instead of refusing the logo; everything else the check refuses, it still refuses. Regolo AI is the first affected provider.
