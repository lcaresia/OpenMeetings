# 0007: Boards as columns in the panel, Excalidraw as the export

Status: accepted

## Context

The spec asks for boards (kanban or whiteboard) built during the meeting, and suggests tldraw
or Excalidraw for the canvas.

- tldraw's license is not open source: production use needs a license key, or shows a
  watermark. It cannot ship inside an Apache-2.0 project that anyone may deploy.
- Excalidraw is MIT, but `@excalidraw/excalidraw` adds several megabytes to the panel and
  brings its own state model, which would have to be kept in sync with `MeetingState` and the
  AG-UI deltas.
- What the agent creates in a meeting is structured: columns with cards ("blockers", "next
  steps"). A free-form canvas is what people do after the meeting, not what a model fills in
  while it listens.

## Decision

- A board is structured data (`{ columns: [{ title, cards }] }`) in `MeetingState`, rendered by
  the panel as columns, edited by the agent through tools and streamed like every other change.
- `GET /api/artifacts/:id/export?format=excalidraw` writes a `.excalidraw`
  scene (one column of cards per board column) that opens on excalidraw.com or in any
  Excalidraw app, for free drawing afterwards.
- No canvas library in the panel.

## Consequences

The panel stays small and has no license question. Boards are not free-form during the meeting;
drawing happens in Excalidraw after the export. If a canvas inside the panel becomes worth its
weight, Excalidraw (MIT) is the option, rendering the same board data.
