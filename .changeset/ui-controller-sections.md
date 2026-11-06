---
"@hames-ai/harness-patterns": minor
---

The observability projection gains `groupControllerRuns` and `buildTimelineSections`: one collapsible section per controller run (a maximal consecutive sequence of `controller_action` / `tool_call` / `tool_result` / `loop_recovery` events under one pattern id), everything else single items. The Context Manager uses it to fold a controller loop behind one header (#1007); grouping is display-only and exports are unchanged.
