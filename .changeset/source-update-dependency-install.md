---
"omnesis": patch
---

Source installs on 0.5.13 can update again. Their update installed the next release's dependencies over the existing `node_modules`, and npm crashed on that install and rolled the update back every time. The next release's dependency tree installs cleanly over 0.5.13's, and an update, a rollback and the source launcher's recovery now retry a failed dependency install once from an empty `node_modules`. The build tooling's YAML parser is also updated to a release with a prototype-pollution fix.
