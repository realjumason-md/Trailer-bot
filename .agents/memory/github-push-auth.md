---
name: GitHub push authentication
description: Recovering when the workspace GitHub connection and Git CLI write access disagree.
---

When an HTTPS push fails with an invalid-credential message, do not assume the repository or local commit is wrong. In this workspace, GitHub can report an active, healthy connection while integration discovery still shows it as unattached; reauthorization may also fail if the connector cannot be resolved. Do not request a personal access token or force-push to work around this state.

**Why:** A public fetch succeeded but push authentication failed, and the integration status and setup actions disagreed.

**How to apply:** Ask the user to reconnect GitHub through the project integration UI, then retry a normal fast-forward push. Keep the prepared commit local until write access is confirmed.
