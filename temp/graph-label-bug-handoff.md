# Bug: Batch result name leaks into inner PipeSequence output in graph ViewSpec

## Summary

When rendering the method graph for a PipeSequence that is batched, the **last step's output inside the inner sequence** incorrectly shows the **parent batch's aggregated result name** instead of its own `result` name.

## Reproduction

Use the file `pipelex-demo/hidden/cv_batch2.mthds` and run:

```bash
pipelex-agent validate bundle pipelex-demo/hidden/cv_batch2.mthds --view
```

Look at the ViewSpec/GraphSpec JSON output for the `process_cv` sub-sequence, specifically the output of its last step `analyze_match`.

## What's wrong

In `cv_batch2.mthds`, the relevant pipes are:

```toml
# Parent sequence — batches over process_cv
[pipe.batch_analyze_cvs_for_job_offer]
steps = [
  { pipe = "prepare_job_offer", result = "job_requirements" },
  { pipe = "process_cv", batch_over = "cvs", batch_as = "cv_pdf", result = "match_analyses" },
]

# Inner sequence — called once per CV
[pipe.process_cv]
output = "CandidateMatch"
steps = [
  { pipe = "extract_one_cv", result = "cv_pages" },
  { pipe = "analyze_one_cv", result = "candidate_profile" },
  { pipe = "analyze_match", result = "match_analysis" },
]
```

- The output of `analyze_match` inside `process_cv` should be labeled **`match_analysis`** (line 89, singular).
- The aggregated batch result in the parent sequence is **`match_analyses`** (line 42, plural).
- In the rendered graph, the output of `analyze_match` is incorrectly shown as `match_analyses` instead of `match_analysis`.

## Root cause location

The bug is in the **pipelex Python codebase**, in the ViewSpec/GraphSpec generation code. The relevant code is likely under:

```
pipelex/pipelex/graph/reactflow/
```

Look at `viewspec.py` and/or `viewspec_transformer.py` — specifically the logic that assigns output names to nodes when building the graph for a PipeSequence that is used as a batch step. The parent batch's `result` name (`match_analyses`) is being used for the inner step's output instead of the inner step's own `result` name (`match_analysis`).

## What's NOT the problem

The VS Code extension rendering code is **not** at fault. It passes the ViewSpec/GraphSpec JSON through unmodified and renders labels exactly as received. The node label comes from `output.name` in the graphspec JSON (or `node.label` in the viewspec JSON for orchestration mode). No transformation is applied.

## Expected fix

The graph generation should use each step's own `result` field for its output node label. The parent batch's `result` name should only appear on the aggregated output node that collects results from all batch iterations, not on the inner step's output.
