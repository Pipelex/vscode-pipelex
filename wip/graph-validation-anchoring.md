# Deferred: anchoring policy for panel-less helper saves

From PR #70 bot triage (Greptile P1 "Panel-Open Race Uses Helper Fallback", declined as a code change — this note records the underlying design question).

## Current behavior (by design)

On save, the validator anchors its analysis on the **graph primary** only when the method graph panel is showing the saved file (`panelShowing` → `resolveGraphPrimaryBundle`); with the panel closed, it validates the saved file as its own primary — the longstanding panel-less on-save semantics. The widget never receives a panel-less run (`panelShowing` is captured before the analyze and gates the sink call), so when the panel opens mid-analyze it supplies its own primary-anchored verdict via its own refresh.

## The reported race

Save a helper with the panel closed, open the panel before the verdict returns: the Problems panel places an *unattributed* error (no `source`/`pipe_code`/`concept_code`) on the helper (that run's primary), while the widget — fed by the panel's own analysis — places it on the directory primary. Two different analyses, each self-consistent; the divergence is transient and heals on the next save. Re-anchoring the completed helper-anchored run onto the primary post-hoc would misattribute it.

## The real question to decide later

Should a panel-less save of a helper file anchor on the **directory primary** in general (i.e. make `resolveGraphPrimaryBundle` the anchor for every on-save validation, not just when the panel is open)? That would make Problems-panel placement independent of panel state and kill the race by construction — but it changes the meaning of "validate on save" for helper files (you'd be validating the sibling bundle, not the file you saved), affects diagnostics ownership for every panel-less workflow, and needs its own look at `dirGeneration` and per-URI cancellation. Decide when there's evidence users expect bundle-anchored diagnostics without the graph open.
