---
"omnesis": patch
---

Re-running the Connect an agent command for OpenClaw or Hermes on a machine that is already connected now reconnects it instead of failing with a device conflict. The machine proves it is the same installation with the credentials it already holds, so the agent device keeps its id, watches, and history, and its old credentials stop working. When the harness is already connected, the portal card asks whether the code reconnects that device or connects another machine, and a machine that lost its saved credentials is told which card choice to use.
