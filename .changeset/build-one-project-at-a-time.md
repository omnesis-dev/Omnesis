---
"omnesis": patch
---

On a machine with less than 14 GB of usable memory, `npm run build` (run by the installer and by `omnesis update` for a source install) builds one TypeScript project at a time. The build peaks at about 2 GB instead of 3.5 GB and produces the same output, but takes about twice as long. A machine with more memory, a 16 GB one included, builds everything in one process, as before.
