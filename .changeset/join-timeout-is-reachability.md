---
"omnesis": patch
---

A join whose first connection times out (a firewall that drops rather than refuses, such as a cloud security group or a DROP-target zone) now says it cannot reach the gateway at the address it dialled, and the installer says the pairing code was not used. It used to print a stack trace and tell the operator to mint a fresh code.
