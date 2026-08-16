<!-- Adapted from nextlevelbuilder/ui-ux-pro-max-skill (MIT © 2024 Next Level Builder),
     .claude/skills/ui-ux-pro-max/data/charts.csv row 16 — "Relationship / Connection
     Data → Network Graph". Thresholds, edge/highlight colours, accessibility risk
     and fallback are upstream's; the mapping onto Cytoscape and onto this repo's
     graph components is ours. Pin + adaptations:
     .claude/skills/PROVENANCE.md · full licence: .claude/skills/NOTICE.md -->

# Network graphs (Cytoscape.js)

Applies to `GraphVisualization.tsx`, the Neo4j / Memory / All tabs inside
`SupportPanel`, and anything else that renders nodes and edges.

Upstream classifies network graphs as **accessibility risk: high**. That is the
frame for everything below — a force-directed canvas is, on its own, unreadable
to a keyboard or screen-reader user, and the mitigation is not "add ARIA to the
canvas", it is "ship the adjacency view alongside it".

---

## 1. Render thresholds

| Node count | Renderer                                                      |
| ---------- | ------------------------------------------------------------- |
| ≤ 100      | SVG is fine                                                   |
| 101 – 500  | Canvas                                                        |
| > 500      | **Must** apply clustering or level-of-detail before rendering |

Cytoscape.js renders to Canvas by default, so the middle band is already
satisfied. The band that is **not** handled is the top one: there is no node cap
anywhere in `GraphVisualization.tsx`, and the accumulating `graphElements` signal
in `index.tsx` grows across a session without bound.

`GraphVisualization` already tracks `nodeCount` (set at lines 390 and 547) — that
is the hook. Before adding a feature that can push past 500 nodes, add
clustering, LOD, or a "showing N of M" cap driven off that signal. Do not let a
long session silently degrade into an unusable hairball.

When the graph exceeds the threshold and cannot be clustered, upstream's
guidance is to **not render the network graph at all** and fall back to the
adjacency view (§3). A frozen canvas is worse than a table.

## 2. Encoding

- **Node types: categorical colour, plus a second channel.** Colour alone fails
  `color-not-only`. Give node types a distinct _shape_ and a _visible label_ as
  well as a hue — Cytoscape's `shape` style property is the cheapest second
  channel.
- **Edges: `#90A4AE` at 60% opacity.** Muted by default, so structure reads
  before detail.
- **Highlight path: `#F59E0B`.** This is the same amber the rest of the UI spends
  on _warning_ (see the role table in `SKILL.md` §4). Inside the graph it means
  _highlighted path_, and that is deliberate: within one canvas there is no
  competing warning semantics. Do not carry the graph's meaning back out into
  chrome, or the other way round.
- **Edge style is a channel too.** Solid vs dashed vs width distinguishes
  relationship kinds without spending another hue.
- The per-turn colour coding on the All tab (`GraphVisualization`'s `extraStyles`
  prop) is an additional layer on top of type colour — check that the two do not
  collide before adding a third.

## 3. The adjacency view is the accessible source of truth

Not a fallback bolted on afterwards. Upstream's phrasing, and it is the load-
bearing rule of this file: the **adjacency list / table is the source of truth**;
the canvas is a view onto it.

What that means concretely for any graph surface:

- Ship an adjacency list or table — source, relationship, target — reachable
  without a pointer, plus a short relationship summary ("12 nodes, 18 edges,
  3 types").
- Offer a tree view where the data is genuinely hierarchical.
- The table is a real DOM table with headers, so it is navigable, searchable and
  copyable. It is also the thing that makes the graph testable.
- Keep the two in sync from one data source. Two derivations of "the graph" is
  how they drift.

## 4. Keyboard contract — it replaces drag, it does not supplement it

Everything the canvas does with a pointer must have a keyboard path. Upstream's
contract, which is the one to implement:

| Interaction        | Keyboard equivalent                                                               |
| ------------------ | --------------------------------------------------------------------------------- |
| Hover a node       | **Focus** reveals the node's details                                              |
| Click / drill down | **Enter** drills into the focused node                                            |
| Drag to reposition | **Move up / down / left / right buttons** — real buttons, not arrow-key-on-canvas |

That last row is the one people get wrong. `dragging-alternative` (WCAG 2.2 AA)
is satisfied by _visible controls_, not by an undiscoverable key binding on a
canvas that never takes focus. Arrow keys on a focused canvas are a fine
addition; they are not the compliance story.

Current state, so the gap is not mistaken for a design: the only `keydown`
handler in `GraphVisualization.tsx` (line 481) is Cmd/Ctrl+Enter to run a Cypher
query. There is no node focus, no drill-down key, and no reposition control.
Layout selection, node properties and the Cypher editor are all pointer-driven.

## 5. When not to use a network graph

Upstream is explicit, and each of these is a real situation here:

- **> 500 nodes without clustering already applied.** See §1.
- **The user needs precise connection counts.** A force layout is bad at
  counting. Ship the table.
- **Mobile.** No touch surface today; if one arrives, the adjacency view is the
  mobile presentation, not a pinch-zoomable canvas.

Secondary options when the network graph is the wrong shape: a **hierarchical
tree** where the data is a hierarchy, an **adjacency matrix** where density
matters more than topology.

---

**Library:** Cytoscape.js, already in use, and one of the three upstream
recommends for this data type (with D3 `d3-force` and Vis.js). No reason to
change; do not introduce a second graph library.
