---
"omnesis": patch
---

Experimental Immich source, offered when the gateway and collector run with `OMNESIS_EXPERIMENTAL=1`. Connect one Immich user's library (Immich 3.0 or later) with that user's API key and the address you open Immich at; a key that belongs to an administrator or holds every permission is accepted with a warning. Each photo and video becomes a searchable document with when and where it was taken, the people Immich recognised and you named, its albums, description and camera, and a link back to the asset; the images themselves are never copied. Only the user's own photos are indexed; photos partners share stay with the partner's own source. A photo moved to the trash leaves the index on the next sync, and one deleted for good leaves after daily full reads confirm it is gone.
