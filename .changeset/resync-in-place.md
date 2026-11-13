---
"omnesis": minor
---

Resync has two modes. In place, now the default in the portal and in `omnesis sources resync`, deletes nothing: the source is read again from the start and each item updates the record already indexed, so records keep their ids, items deleted one by one stay deleted, and the source stays searchable throughout. From scratch — `--from-scratch` in the CLI — is the previous behaviour: everything the source indexed is deleted and imported again. `POST /admin/sources/:id/resync` takes a `mode` and reports the one it applied; a request that names none is resynced from scratch, as before. The iOS and Android apps' Resync action offers the same two modes, in place selected; paired with a gateway that predates the modes, they keep the previous from-scratch resync and its confirmation.
