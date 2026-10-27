---
"omnesis": patch
---

Settings survive a rollback or a move to an older release. An older gateway drops the settings it does not know from `omnesis.json` when it next changes the configuration, so upgrading again used to bring them back at their defaults — the note agent switched back on, Brain source exclusions and the transcription vocabulary opt-out gone. The update now saves the configuration as `omnesis.json.newer-settings` before handing it to an older release, and the next release that knows those settings restores the ones missing when its gateway starts, keeping any change made on the older release.
