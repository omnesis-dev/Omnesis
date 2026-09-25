# @omnesis/source-sdk

## 0.5.13

### Patch Changes

- @omnesis/config@0.5.13
- @omnesis/core@0.5.13
- @omnesis/types@0.5.13

## 0.5.12

### Patch Changes

- @omnesis/config@0.5.12
- @omnesis/core@0.5.12
- @omnesis/types@0.5.12

## 0.5.11

### Patch Changes

- @omnesis/config@0.5.11
- @omnesis/core@0.5.11
- @omnesis/types@0.5.11

## 0.5.10

### Patch Changes

- @omnesis/config@0.5.10
- @omnesis/core@0.5.10
- @omnesis/types@0.5.10

## 0.5.9

### Patch Changes

- @omnesis/config@0.5.9
- @omnesis/core@0.5.9
- @omnesis/types@0.5.9

## 0.5.8

### Patch Changes

- @omnesis/config@0.5.8
- @omnesis/core@0.5.8
- @omnesis/types@0.5.8

## 0.5.7

### Patch Changes

- @omnesis/config@0.5.7
- @omnesis/core@0.5.7
- @omnesis/types@0.5.7

## 0.5.6

### Patch Changes

- @omnesis/config@0.5.6
- @omnesis/core@0.5.6
- @omnesis/types@0.5.6

## 0.5.5

### Patch Changes

- @omnesis/config@0.5.5
- @omnesis/core@0.5.5
- @omnesis/types@0.5.5

## 0.5.4

### Patch Changes

- @omnesis/config@0.5.4
- @omnesis/core@0.5.4
- @omnesis/types@0.5.4

## 0.5.3

### Patch Changes

- @omnesis/config@0.5.3
- @omnesis/core@0.5.3
- @omnesis/types@0.5.3

## 0.5.2

### Patch Changes

- @omnesis/config@0.5.2
- @omnesis/core@0.5.2
- @omnesis/types@0.5.2

## 0.5.1

### Patch Changes

- @omnesis/config@0.5.1
- @omnesis/core@0.5.1
- @omnesis/types@0.5.1

## 0.5.0

### Source authoring contract

- Declare API generation and required host capabilities independently of cursor
  state version and output revision. The host advertises state envelopes,
  multi-table batches, scoped snapshot sessions, tuple deletes, scoped services,
  and typed configuration. Opaque connection allocation is not advertised.
- State declarations cover installed bare cursors, migrations, unreadable-state
  policy and encoded size ceilings. Stop policies and ceilings require envelope
  support even at version 1. Wrapping a class instance preserves its lifecycle
  hooks and getters; an empty initial bookmark is reported as a first run.
- Typed configuration validates declaration defaults and list element host checks.
  Lists accept an explicit newline-only separator for comma-containing values.
- Authentication sessions expose typed challenges and client capabilities;
  required credential fields follow their specification. Unsupported questions
  fail without waiting for timeout.
- Local session snapshots retain last-known IDs for unreadable files while
  reconciling readable siblings, and protect moves into unavailable archives.

### Patch Changes

- @omnesis/config@0.5.0
- @omnesis/core@0.5.0
- @omnesis/types@0.5.0

## 0.4.23

### Patch Changes

- @omnesis/config@0.4.23
- @omnesis/core@0.4.23
- @omnesis/types@0.4.23

## 0.4.22

### Patch Changes

- @omnesis/config@0.4.22
- @omnesis/core@0.4.22
- @omnesis/types@0.4.22

## 0.4.21

### Patch Changes

- @omnesis/config@0.4.21
- @omnesis/core@0.4.21
- @omnesis/types@0.4.21

## 0.4.20

### Patch Changes

- @omnesis/config@0.4.20
- @omnesis/core@0.4.20
- @omnesis/types@0.4.20

## 0.4.19

### Patch Changes

- @omnesis/config@0.4.19
- @omnesis/core@0.4.19
- @omnesis/types@0.4.19

## 0.4.18

### Patch Changes

- @omnesis/config@0.4.18
- @omnesis/core@0.4.18
- @omnesis/types@0.4.18

## 0.4.17

### Patch Changes

- @omnesis/config@0.4.17
- @omnesis/core@0.4.17
- @omnesis/types@0.4.17

## 0.4.16

### Patch Changes

- @omnesis/config@0.4.16
- @omnesis/core@0.4.16
- @omnesis/types@0.4.16

## 0.4.15

### Patch Changes

- @omnesis/config@0.4.15
- @omnesis/core@0.4.15
- @omnesis/types@0.4.15

## 0.4.14

### Patch Changes

- @omnesis/config@0.4.14
- @omnesis/core@0.4.14
- @omnesis/types@0.4.14

## 0.4.13

### Patch Changes

- @omnesis/config@0.4.13
- @omnesis/core@0.4.13
- @omnesis/types@0.4.13

## 0.4.12

### Patch Changes

- @omnesis/config@0.4.12
- @omnesis/core@0.4.12
- @omnesis/types@0.4.12

## 0.4.11

### Patch Changes

- @omnesis/config@0.4.11
- @omnesis/core@0.4.11
- @omnesis/types@0.4.11

## 0.4.10

### Patch Changes

- @omnesis/config@0.4.10
- @omnesis/core@0.4.10
- @omnesis/types@0.4.10

## 0.4.9

### Patch Changes

- @omnesis/config@0.4.9
- @omnesis/core@0.4.9
- @omnesis/types@0.4.9

## 0.4.8

### Patch Changes

- @omnesis/config@0.4.8
- @omnesis/core@0.4.8
- @omnesis/types@0.4.8

## 0.4.7

### Patch Changes

- @omnesis/config@0.4.7
- @omnesis/core@0.4.7
- @omnesis/types@0.4.7

## 0.4.6

### Patch Changes

- @omnesis/config@0.4.6
- @omnesis/core@0.4.6
- @omnesis/types@0.4.6

## 0.4.5

### Patch Changes

- @omnesis/config@0.4.5
- @omnesis/core@0.4.5
- @omnesis/types@0.4.5

## 0.4.4

### Patch Changes

- @omnesis/config@0.4.4
- @omnesis/core@0.4.4
- @omnesis/types@0.4.4

## 0.4.3

### Patch Changes

- Declare self-identity source hooks using merge-safe gateway semantics.

- @omnesis/config@0.4.3
- @omnesis/core@0.4.3
- @omnesis/types@0.4.3

## 0.4.2

### Patch Changes

- @omnesis/config@0.4.2
- @omnesis/core@0.4.2
- @omnesis/types@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies
  - @omnesis/core@0.4.1
  - @omnesis/config@0.4.1
  - @omnesis/types@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [56a13a5]
  - @omnesis/config@0.4.0
  - @omnesis/core@0.4.0
  - @omnesis/types@0.4.0

## 0.3.0

### Minor Changes

- 0399f47: Add local Pi, Claude Code, and Codex session sources. Index prompts and completed replies. Exclude tool traces, hidden reasoning, and subagent sessions.

### Patch Changes

- Updated dependencies [0399f47]
  - @omnesis/core@0.3.0
  - @omnesis/config@0.3.0
  - @omnesis/types@0.3.0
