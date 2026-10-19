---
name: Video queue semantics
description: The user's required behavior when new videos arrive during compression.
---

Never cancel an active compression just because another video or link arrives. Keep the current job running, queue the new item, and start it only after the active compression finishes. Stop the active job only after an explicit active-cancel request.

**Why:** The user reiterated this after seeing an upload fail preparation while a later video began compressing.

**How to apply:** When changing Telegram message handling, upload/link preparation, resolution selection, cancellation, or compression lifecycle, distinguish preparation failures from queue cancellation and keep new arrivals independent of the active job.
