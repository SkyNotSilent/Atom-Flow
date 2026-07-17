# AtomFlow AI Creative Infinite Canvas PRD

## Product Goal

Turn Magic Writing into a canvas-native creation system. Users place arbitrary source material on a pure infinite canvas, derive reusable insights, run explicit or one-off AI tasks, and produce a complete editable document whose outline and body remain one source of truth.

The first validated scenario is long-form social-media writing, especially WeChat public-account articles. The domain model must also support scripts, reports, tutorials, podcasts, and future formats without introducing format-specific node kinds.

## Product Principles

- The canvas is the primary workspace. Drawers and editors overlay it; no permanent rail resizes the camera.
- Every business object uses one visual node shell with a title, role, status, content preview, ports, and a contextual plus action.
- `kind` remains a physical compatibility field. `role`, `contentType`, `origin`, and `status` express product semantics.
- AI never overwrites source material or an accepted document without an explicit user action.
- Connections are persisted business relationships, not decorative tldraw arrows.
- Full business data lives in AtomFlow and PostgreSQL; tldraw stores presentation references and geometry only.

## Node Roles

- `material`: files, web pages, images, screenshots, audio/video, pasted text, saved articles, and external data.
- `insight`: viewpoints, facts, data, quotes, stories, cases, questions, hypotheses, and custom knowledge types.
- `task`: reusable Agent work, one-off AI runs, and later Agent groups.
- `document`: a complete deliverable containing title candidates, summary, ordered outline sections, body, citations, visual placements, and versions.
- `group`: a visual organization container with no independent content semantics.

Origins are `existing`, `extracted`, `manual`, and `generated`. Statuses cover parsing, ready, running, review, acceptance/rejection, editing, completion, and failure.

## Core Flows

1. Add material from the global plus button or an existing node's plus action.
2. Parse source data without deleting the original when parsing fails.
3. Run a quick AI action or connect material to a configured Agent.
4. Write derived insights back as child nodes with traceable source relations.
5. Create a document from selected context; edit its ordered outline and section bodies in one Tiptap surface.
6. Expand a document section on the canvas when it needs dedicated sources or AI work, while keeping the document as canonical storage.
7. Later, run one shared prompt through an Agent group and place candidate results side by side for explicit adoption or rejection.

## Relationships

- `context`: an owned non-Agent node is authorized as input to an Agent.
- `derived_from`: an insight or analysis was extracted from another node.
- `generated`: a task or Agent produced a result or document.
- `structure`: parent/child canvas branches and document-section projections.

Only `context` changes model input. Removing another relation affects lineage or layout, not Agent authorization.

## Delivery Order

1. Backward-compatible node semantics, relation matrix, document/version storage, and contract tests.
2. Unified node shell, node plus actions, stable branch placement, statuses, and keyboard branching.
3. Quick AI actions with durable runs and traceable insight output.
4. Document outline/body editor, scenario templates, versions, and export.
5. Agent groups, bounded multi-model batches, candidate comparison, and run history.

## Acceptance

- Existing canvas projects open without migration loss.
- Users can complete material ingestion, analysis, Agent generation, and document editing without leaving the canvas workspace.
- Refresh restores geometry, roles, statuses, relations, document content, and run results.
- Reordering outline sections reorders the corresponding body sections.
- Only explicit `context` connections enter Agent requests.
- Desktop supports the complete workflow; narrow screens use full-screen sheets for inspectors and document editing.

