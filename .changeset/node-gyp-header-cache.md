---
"omnesis": patch
---

Installing or updating from source no longer fails twice, and on every re-run, because of a broken node-gyp header cache. node-gyp keeps the Node headers that native modules compile against in a per-version cache outside the checkout and trusts it from then on; a header download killed part-way, or several native modules fetching the headers at once into an empty cache, could leave `common.gypi` empty or missing there, and every later `npm ci` failed on it ("common.gypi not found", or a `SyntaxError` in it) — retrying from an empty `node_modules` did not help. Before each `npm ci`, the installer, the source launcher's dependency recovery and `omnesis update` now discard the running Node's header directory unless it is complete and fetch the headers once, before npm builds anything; nothing else in the cache is touched. The Docker image build compiles against the image's own Node headers instead.
