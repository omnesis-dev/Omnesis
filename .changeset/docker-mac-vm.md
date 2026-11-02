---
"omnesis": patch
---

Docker installs under colima, OrbStack or Rancher Desktop on a Mac can update. The update container mounted the Mac-side path of the Docker socket, which only Docker Desktop's VM can bind-mount, so `omnesis update` stopped with "error while creating mount source path … operation not supported"; it now mounts the VM's own socket. Re-run the installer once on such an install to rewrite its compose file. The gateway's online backup, which every update takes first, also copies its directories entry by entry: colima's file share refused the bulk copy with "Permission denied".
