---
'@hames-ai/harness-baml': patch
---

Reject temperature and bias calibration for Jev clients instead of silently ignoring them; fitted confidence and margin cuts remain supported. Store a frozen snapshot of the validated table, including entries and bias, so caller mutation cannot bypass validation.
