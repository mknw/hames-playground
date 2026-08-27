# The organizational graph — ontology, enforcement, and the roster ingest

**Status:** ontology defined, schema applied, roster ingested and verified
against the live tenant on 2026-08-25. `MEMBER_OF` is defined but **not
populated** — see [Teams are blocked on a tenant
permission](#teams-are-blocked-on-a-tenant-permission).

The graph holds **organizational structure only**: members, resources,
knowledge. The pre-existing content (a `Concept`/`Class`/`Individual` ontology
sketch and some `GitHubRepository` nodes) was disposable and was wiped once, on
authorisation, as part of this migration.

Two rules that shape everything below:

- **Org data never enters the repo.** The schema does — this doc, the constraint
  definitions, the ingestion code. Not one display name or address.
- **The ontology is defined first and the ingest conforms to it**, not the other
  way round. Where the database cannot enforce a rule, the ingest does, and this
  doc says which is which rather than implying the database holds everything.

| Concern              | Lives in                                        |
| -------------------- | ----------------------------------------------- |
| Machine-readable     | `app/src/lib/org-graph/ontology.ts`             |
| Schema setup         | `app/src/lib/org-graph/schema.server.ts`        |
| Roster ingest        | `app/src/lib/org-graph/roster-ingest.server.ts` |
| Roster read-back     | `app/src/lib/org-graph/roster-source.server.ts` |
| Pseudonymisation     | `app/src/lib/privacy/org-roster.ts`             |
| How to run any of it | `app/src/lib/org-graph/scripts/README.md`       |

---

## 1. Node labels

Four, and nothing else is conforming data.

| Label       | What it is                                       | Unique key        | Required (hard)                  | Required (soft)          |
| ----------- | ------------------------------------------------ | ----------------- | -------------------------------- | ------------------------ |
| `Member`    | A person in the tenant directory                 | `entraId`, `mail` | `entraId`, `displayName`, `mail` | `department`, `jobTitle` |
| `Team`      | A named group people belong to (an Entra group)  | `entraId`         | `entraId`, `name`                | —                        |
| `Resource`  | A system, tool or asset the organisation runs    | `key`             | `key`, `name`                    | —                        |
| `Knowledge` | A documented item — a note, a decision, a how-to | `key`             | `key`, `title`                   | —                        |

`Member` also carries `syncedAt`, stamped with `datetime()` on every ingest and
therefore on the **database** clock. It is not part of the ontology's contract;
it is what makes "not seen in the last run" answerable.

Stamping it server-side buys nothing on its own — what matters is that the
threshold it is compared against comes from the same clock, which is why
`ingestRoster` opens with a `databaseNow()` round trip instead of `new Date()`.
Two clocks would make the `stale` count skew-dependent in the one direction
that hurts: a database running behind the app container by more than the
directory fetch takes would report every member just written as stale.

### Why "required" has two tiers

`Member` declares four required properties. Splitting them was not a hedge — it
is what the live directory forced:

| Property      | Tier | Set on the live directory |
| ------------- | ---- | ------------------------- |
| `displayName` | hard | 49 / 49                   |
| `mail`        | hard | 49 / 49                   |
| `jobTitle`    | soft | 32 / 49                   |
| `department`  | soft | **1 / 49**                |

A row missing a **hard** property is rejected — without a name or an address it
is not a member this graph can be about, and it is useless to the
pseudonymisation roster. A row missing a **soft** property is written through
and **counted** in the ingest report.

The two alternatives were both worse. Making `department` hard would have
discarded 48 of 49 people to satisfy a schema. Writing a placeholder value would
have put a falsehood in the graph that every downstream query would then have to
know about. Counting it makes the gap visible on every run, which is the
information the owner actually needs: the fix is in Entra, not here. Promoting a
soft property to hard is a one-line change in `LABEL_SPECS` once the directory
is filled in.

## 2. Relation types

`MEMBER_OF` was confirmed and `COORDINATES` was wanted. The other four are the
minimum that lets resources and knowledge attach to anything at all. One line of
rationale each, as asked:

| Relation      | Shape                                                | Why                                                                                                                           |
| ------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `MEMBER_OF`   | `(:Member)-[:MEMBER_OF]->(:Team)`                    | Who belongs to which team — the one relation the roster ingest exists for. **Confirmed.**                                     |
| `COORDINATES` | `(:Member)-[:COORDINATES]->(:Team)`                  | Who convenes a team, as its own edge so coordination is stated rather than inferred from membership. **Wanted.**              |
| `PART_OF`     | `(:Team)-[:PART_OF]->(:Team)`                        | Team nesting: Entra groups nest and `MEMBER_OF` cannot express a sub-team. Structural only — explicitly not a reporting line. |
| `STEWARDS`    | `(:Team)-[:STEWARDS]->(:Resource)`                   | Which team is accountable for a resource, so "who do I ask about X" is one hop from the resource.                             |
| `ABOUT`       | `(:Knowledge)-[:ABOUT]->(:Member\|:Team\|:Resource)` | What a knowledge item documents — one polymorphic attach edge instead of three near-identical typed ones.                     |
| `AUTHORED`    | `(:Member)-[:AUTHORED]->(:Knowledge)`                | Provenance of a knowledge item, and the reason `Knowledge` needs no author property of its own.                               |

### There is deliberately no reports-to

No `REPORTS_TO`, `MANAGES`, `LEADS` or `SUPERVISES` edge exists, and
`COORDINATES` is not a stand-in for one: it points at a **team**, never at a
person. The decision takes a structural form — **nothing in this ontology joins
one `Member` to another** — so a hierarchy is not merely absent, it is
unexpressible in the declared relation set.

Microsoft Graph's `/users` resource does expose a `manager` relationship. The
ingest does not read it, and `$select` never asks for it. Two tests pin this: one
asserts the forbidden type names are absent, one asserts no relation has `Member`
at both ends.

### Only `MEMBER_OF` is populated today

`COORDINATES`, `PART_OF`, `STEWARDS`, `ABOUT` and `AUTHORED` are **declared and
constrained, not written**. Nothing in the ingest creates them: coordination,
resources and knowledge have no source feed yet, and inventing one would have
been the scaffolding this repo's own rules tell you not to build. They are in the
ontology so the shape is fixed before data arrives, and so the conformance check
below does not flag them as drift the day something does write one.

## 3. What enforces each rule — honestly

The compose stack runs **Neo4j 5.26 Community**, and this matters more than it
sounds. Community supports exactly one of the four constraint kinds this ontology
would want. Verified by attempting each against the running container rather than
read off a feature matrix:

| Constraint kind             | Community 5.26 | The server's own answer                                           |
| --------------------------- | -------------- | ----------------------------------------------------------------- |
| `REQUIRE n.p IS UNIQUE`     | **supported**  | created                                                           |
| `REQUIRE n.p IS NOT NULL`   | no             | `Property existence constraint requires Neo4j Enterprise Edition` |
| `REQUIRE (n.p) IS NODE KEY` | no             | `Node Key constraint requires Neo4j Enterprise Edition`           |
| `REQUIRE n.p IS :: STRING`  | no             | `Property type constraint requires Neo4j Enterprise Edition`      |

So enforcement splits:

| Rule                                                   | Enforced by                                              | Strength                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `Member.entraId` unique                                | Neo4j uniqueness constraint `org_member_entra_id`        | **Database.** Holds against every writer, including the browser edit UI. |
| `Member.mail` unique                                   | Neo4j uniqueness constraint `org_member_mail`            | **Database.**                                                            |
| `Team.entraId`, `Resource.key`, `Knowledge.key` unique | Neo4j uniqueness constraints                             | **Database.**                                                            |
| Hard properties present                                | `validateMember` in `ontology.ts`, at the write boundary | **App-side.** Holds only for callers that route through the ingest.      |
| Soft properties present                                | `validateMember`, reported not rejected                  | **App-side, advisory.** Counted in the ingest report.                    |
| Only the four labels exist                             | nothing, at write time                                   | **Measured, not enforced** — see below.                                  |
| Only the six relation types exist                      | nothing, at write time                                   | **Measured, not enforced** — see below.                                  |
| Relation endpoint labels                               | the ingest's own Cypher, which matches on label          | **App-side.**                                                            |

### The gap app-side validation leaves

App-side validation binds the callers that route through it. Two do not:

1. **`neo4j/graph-edit.server.ts`** — the graph visualisation's edit
   affordances. `createGraphNode` and `linkGraphNodes` validate a label or
   relationship type by **shape** (`/^[A-Za-z_][A-Za-z0-9_]*$/`), not by
   membership in this ontology, and they do so deliberately: the UI legitimately
   mints new labels, so a catalog check would reject the first node of every new
   one. Consequence: the browser can create a `Concept` node or a `REPORTS_TO`
   edge, and nothing stops it.
2. **`neo4j/queries.ts` → `runManualCypher`** cannot write at all (READ-mode
   session and transaction), so it is not a path here — noted only because it is
   the other place query text reaches the graph.

That gap is **not closed in this change**, because closing it means changing UI
behaviour nobody asked to change. Instead it is made countable:
`countNonConforming()` (`schema.server.ts`, over `NON_CONFORMING_CYPHER`) returns
every non-conforming label, every non-conforming relation type and every `Member`
missing a hard property, as counts. Both live scripts print it, and both fail
their exit code on a non-zero result. Run it after any session of manual graph
editing.

**Open for the owner:** whether `graph-edit.server.ts` should reject labels and
relation types outside `NODE_LABELS` / `RELATION_TYPES`. It would make the
ontology enforced rather than measured, at the cost of the UI's ability to mint
a new label ad hoc. Not decided here.

## 4. The setup path, and the one authorised wipe

Two functions, deliberately unequal:

```ts
ensureOrgGraphSchema(); // idempotent. Creates missing constraints. NEVER deletes.
wipeAndApplyOrgGraphSchema(WIPE_CONFIRMATION); // one-shot. Drops everything first.
```

`ensureOrgGraphSchema` issues nothing but `CREATE CONSTRAINT … IF NOT EXISTS`, so
a second run is a no-op and it is safe on every boot. A test reads every
statement it issues and fails on any other write clause — so a cleanup added
here later fails the suite instead of deleting a graph. It is memoized per
process, and the memo is cleared on failure so one transient Neo4j hiccup does
not become permanent (the Postgres house pattern from
`auth/session-store.server.ts`).

The wipe takes the literal phrase `WIPE-AND-REBUILD-ORG-GRAPH` as a **required
argument**. Not a flag, not an env var, not a default: making it an argument is
what stops it from ever becoming a side effect of ordinary setup. It drops every
constraint as well as every node, because the pre-ontology constraints
(`class_iri`, `change_id`, …) belong to labels that ceased to exist and leaving
them behind makes `SHOW CONSTRAINTS` unreadable against `CONSTRAINT_NAMES`.
Deletion runs in batches of 10,000 so a large graph is not one transaction the
size of the store.

Neither is a `'use server'` export, and neither ever should be: every export of
such a module is an RPC the browser can call, and a function that drops a graph
must not be reachable that way at any privilege level. They are `.server.ts` +
`assertServerOnImport()`, invoked from the CLI scripts. If a UI ever needs the
setup path, it gets an authenticated, intent-shaped wrapper around
`ensureOrgGraphSchema` **only**.

## 5. The roster ingest

### The credential

The roster is the whole tenant, so there is no user whose delegated view of it
would be the right one. It therefore uses the **client-credentials** grant:
`getAppGraphToken()` / `graphAppFetch()` in `auth/graph-token.server.ts`, asking
for `https://graph.microsoft.com/.default` — which means "exactly the
application roles the tenant admin-consented", the only thing client credentials
can ask for.

This is a separate function from the per-user `getUserGraphToken`, not a flag on
it. A flag would have put "act as the app, unbounded by any user's scope" one
boolean away from every existing per-user call site, which is the opposite of
what that module's header promises. A denial raises `GraphAppPermissionError`,
never the delegated `GraphAuthRequiredError`: no user can sign in to fix a
missing application permission, and telling them to try would send them
somewhere that cannot help.

Both paths now share one request builder, so the credential is attached in
exactly one place and neither can drift into letting a caller override
`Authorization`. That builder composes the request through a `Headers` object
rather than an object literal, which is what makes the sentence true: header
names are case-insensitive and `Headers` **appends**, so writing `Authorization`
last into a spread only outranked that exact spelling — a caller passing
lowercase `authorization` got `attacker, Bearer real` on the wire. `Headers.set`
replaces whatever the casing. Three spellings are pinned by test.

### The read

```
GET /users
  ?$select=id,displayName,mail,department,jobTitle,accountEnabled,userType
  &$filter=accountEnabled eq true and userType eq 'Member'
  &$top=999
```

`$select` is not an optimisation: without it Graph returns the full user
resource, which is far more personal data than this graph holds. `@odata.nextLink`
is followed, so the read is not silently truncated at one page.

### Exclusions

| Excluded                   | How                                 | Honest caveat                                                                                                                                                                                                                                       |
| -------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disabled accounts          | `accountEnabled eq true`            | —                                                                                                                                                                                                                                                   |
| Guests (B2B invitees)      | `userType eq 'Member'`              | People, but not this organisation's structure.                                                                                                                                                                                                      |
| Accounts with no mailbox   | app-side: `mail` is a hard property | A **proxy**, not a classification. It catches never-provisioned and unlicensed accounts; a _licensed_ service account with a mailbox still gets through, and no Graph field would separate it from a person. No name heuristic is applied.          |
| Room / equipment mailboxes | mostly by `accountEnabled eq true`  | These are `/places` resources; where a tenant also materialises them as user objects they are normally disabled. A licensed, enabled one would survive. Cross-checking `/places` needs `Place.Read.All`, which this app registration does not have. |

On the live tenant: 61 user objects → 56 enabled → 54 members → **49 eligible**,
0 rejected.

### Upsert, not sync

Every write is a `MERGE` on the ontology's unique key, so a second run changes
nothing but `syncedAt`. A member who has **left** the tenant is not deleted: what
happens to a departed employee's node is a retention decision (the graph is
covered by no erasure path today), and an ingest should not make it silently. The
report counts them as `stale` so the decision is visible.

**Open for the owner:** whether a departed member's node is deleted, tombstoned,
or left. It interacts with the erasure gap in `docs/data-privacy/plan.md`.

### Teams are blocked on a tenant permission

`Team` and `MEMBER_OF` are implemented end-to-end and write nothing, because the
app registration holds `User.Read.All` and no group permission. The failure is
not a clean 403 everywhere, which is what makes it worth writing down:

- `GET /users/{id}/memberOf/microsoft.graph.group` returns **200** with the
  user's group ids — six of them for the account probed.
- Every group **property** is withheld: `displayName` is absent, and
  `groupTypes` / `mailEnabled` / `securityEnabled` come back `null`.
- `GET /groups` returns **403 `Authorization_RequestDenied`**.

So the credential can see _that_ groups exist and not _what they are_. A `Team`
node whose `name` is unknowable violates the ontology's hard properties, and
id-only memberships would be worse than none — a graph of opaque GUIDs no query
could resolve. `probeGroupReadAccess()` therefore spends **one** request to
decide, before N per-member requests are spent, and reports a reason code instead
of degrading silently.

**Members-only is v1, and it is a permission boundary rather than a shortcut.**
Granting `Group.Read.All` (application) to the app registration is the whole fix;
no code change is needed. The per-member read is `/memberOf` cast to
`microsoft.graph.group`, one request per member, which is cheap at this
directory's size and would want revisiting at a few hundred people.

## 6. The roster as a pseudonymisation mapping source

`docs/plan/graph-pseudonymisation.md` builds a no-NER pseudonymisation layer over
the roster **the payload itself declares**, and records the cost of that choice
as limitation 1:

> A person named ONLY in free text, never in a labelled field, is not in the
> roster and is therefore not replaced.

That limitation existed because the payload was the only roster available. It is
not any more. `lib/privacy/org-roster.ts` turns directory members into the same
`RosterEntry[]` shape `buildTable` already consumes — **that type is the seam,
and it already existed**, so nothing in `pseudonymise.ts` changed:

```ts
const directory = rosterFromDirectory(await loadDirectoryRoster());
const merged = mergeRosters(extractRoster(payload), directory);
apply(payload, buildTable(merged));
```

`mergeRosters` does three things per directory entry: **match** (by address, or
by a shared name variant), **fill** (a matched entry with a null `name` or
`address` takes the directory's), **append** (an unmatched entry joins the end).

- **Fill** closes **limitation 3** — `shapeMessages` flattens a sender to
  `name ?? address`, so a payload learns one half of an identity and the body
  text uses the other. The directory supplies the missing half.
- **Append** closes **limitation 1 for colleagues**. It does not close it in
  general: a customer, a supplier or a private individual named in prose is
  invisible to any roster mechanism and always will be. That is the honest
  boundary to put in front of a DPO, and it has a passing test.

Only `displayName` and `mail` are read. `buildTable` already derives the
given/family parts, the address's local part and the SharePoint URL slug from
those two, so pulling `givenName`/`surname` out of Graph would add personal data
for no coverage gain.

### What this is not

**It is a mapping source, not a hook.** Nothing here calls `apply` on a
production path. Where the substitution runs, whether the conversation store
holds clear or pseudonymised text, and where the (itself-personal-data)
substitution table lives are the three open questions in the plan doc, and they
are owner decisions. `roster-source.server.ts` deliberately returns plain
`{ displayName, mail }` rows rather than `RosterEntry[]`, so no server module
imports `lib/privacy/*` and the "wired to nothing" status of that layer is
unchanged by this work.

### Two costs a caller must know

1. **A wide roster over-claims as an audit record.** `buildTable` mints an entry
   per person whether or not that person occurs in the payload, and `apply`
   reports nothing about which literals fired — so a 49-entry table proves what
   the substitution _could_ have replaced, not what it did. The fix is `apply`
   returning a replacement count; that changes a public signature in a sensitive
   area and is not done here.
2. **Numbering is roster-positional**, so stability across payloads is a property
   of the caller's query, not of the module. `loadDirectoryRoster` orders by
   `entraId` — immutable per person, unlike `displayName` and `mail` — so the
   numbering changes only when the roster's membership does.

## 7. Not in scope

A later enrichment lane owns crawling the company website and M365 content, and
these seams are left for it deliberately:

- **`Knowledge` is declared, constrained and empty.** Its unique key is `key`, a
  caller-chosen slug rather than an Entra id, precisely because its source is
  not the directory. `Resource` is no longer empty — see §8 — but its key stays
  a caller-chosen slug for the same reason: not every `Resource` will come from
  the directory either.
- **`STEWARDS`, `ABOUT` and `AUTHORED` are declared and unwritten**, so an
  enrichment writer has a fixed shape to target and `countNonConforming` will not
  flag its first edge as drift.
- **`ensureOrgGraphSchema` is idempotent and safe to call from any new ingest**,
  which is the intended entry point for one — not the wipe.
- **`graphAppFetch` is the app-only transport** for anything else that must read
  the tenant rather than one user. It is one function, and the blast radius of
  adding a caller is visible at its call site.

Nothing here reads M365 content, and the `$select` list is the whole of what
leaves Graph.

## 8. The first enrichment lane: structure inferred from the roster already in place

The graph shipped from #264 with 48-odd `Member` nodes and zero relationships —
the roster ingest writes people, nothing wrote structure between them. A first
enrichment lane closes part of that gap **from data already in the graph**, no
new Graph permission needed: `lib/org-graph/edge-inference.ts` (pure — the
judgement calls) and `lib/org-graph/enrich-org-edges.server.ts` (the writes),
run via `scripts/enrich-org-edges.ts`.

**Every inferred node and edge carries provenance** — `inferred: true`, a
`basis`, a `confidence`, an `inferredAt` — so inferred structure is never
mistaken for ingested fact. Three things it does, on a run against the local
graph:

1. **Shared-mailbox accounts become `Resource`, not `Member`.** A member with
   no `jobTitle`, no `department`, and a mail local-part that does not follow
   this tenant's `firstname.lastname` convention is reclassified
   (`RESOURCE_BASIS = 'account-shape'`). This is a `MERGE` onto `Resource.key`
   plus a `DETACH DELETE` of the source node, not a label flip — a label flip
   would drop the node out of `Member`'s uniqueness constraints and let the next
   roster re-ingest recreate a duplicate `Member` with the same `entraId`;
   `enrich-org-edges.server.ts`'s header has the full reasoning.
2. **Members sharing a `jobTitle` are grouped onto an inferred `Team`**
   (`JOB_TITLE_BASIS = 'job-title'`), one node per distinct title, joined by
   `MEMBER_OF` — the relation the roster ingest already declared, reused rather
   than extended.
3. **Members sharing a `department` are grouped the same way**
   (`DEPARTMENT_BASIS = 'department'`), which today is one department (the
   ontology's own §1 already notes how sparse `department` is on the live
   tenant: 1/49).

**This widens what a `Team` node can mean.** §1 introduces `Team` as "a named
group people belong to (an Entra group)"; an inferred role or department
grouping has no Entra group behind it. Rather than add a fifth node label for
an otherwise-identical shape, an inferred `Team`'s `entraId` carries a `role:`
or `dept:` prefix — which a real Entra group id (a GUID) can never collide
with — and `inferred: true` marks the instance. Flagged here as a widening
rather than folded in silently; a future reader comparing a `Team` node's
`entraId` against Entra's `/groups` should not assume every hit is real.

**Idempotent by delete-and-recreate, not by diffing.** Every run clears every
relationship carrying `inferred: true` — regardless of type or basis — before
re-deriving groupings from the roster's _current_ `jobTitle`/`department`
values. A re-run against an unchanged roster reproduces exactly what it just
deleted; a re-run after a title changes drops the stale grouping and adds the
new one. Resource reclassification does not need the same treatment — matching
is already scoped to nodes still labelled `:Member`, so a second run converts
nothing new rather than double-applying.

**No new relation type, and no `Member`↔`Member` edge.** `ontology.test.ts`
pins that nothing in `RELATIONS` joins two `Member` nodes — the structural form
the no-reports-to decision takes (§2, "There is deliberately no reports-to")
— and this lane does not touch that file. Every inferred edge points a
`Member` at a `Team`.

**What this lane did not attempt — and §9 is what replaced the plan.** A
second, evidence-based half — co-work edges from M365 activity such as
recently-edited file titles or shared calendar events — was scoped for the
same change and was **not implemented** here: the app-only credential this
doc's ingest uses holds `User.Read.All` only (no `Files.Read.All` /
`Sites.Read.All` / `Calendars.Read`), and the app's delegated Graph path
(`lib/auth/graph-token.server.ts`'s `getUserGraphToken`, what the
`microsoft-365` agent's `graph_files_recent` etc. run on) is scoped to
whichever single user is signed in, not the roster — neither reached "this
activity, for all 48 members" at the time. Filed as a scope/consent gap for
the owner rather than worked around.

The owner's answer (2026-08-27) was not to widen the app-only credential — see
§9 for why, and for the `COLLABORATES_WITH` relation type that closes the
"any collaboration edge would need a relation this ontology does not declare"
gap this section used to end on.

## 9. The second enrichment lane: co-work edges from the owner's own SharePoint visibility

§8's gap stood on a false choice: either widen the roster ingest's app-only
credential to `Files.Read.All` / `Sites.Read.All` — which, granted at the
**application** level, would see every private file in the tenant, not just
internally-public ones — or leave co-work structure unimplemented. The
owner's ruling closed it differently: **"the delegated file permission does
not allow to see private users' files (and it shouldn't)"**, so use the
owner's own **delegated** token instead of a new application permission.
`Sites.Read.All` and `Files.Read.All` were already in `DEFAULT_GRAPH_SCOPES`
(`auth/entra-config.server.ts`) — the same scopes the `microsoft-365` agent's
`graph_files_search` etc. already run on — and already consented at the
owner's last interactive sign-in. What made this reachable from a background
script rather than only from a live chat turn is `#205`'s offline-token
machinery (`docs/plan/offline-agent-auth.md`): an encrypted, per-user MSAL
cache that outlives any browser session and is redeemed with
`acquireTokenSilent`. Nothing about that machinery changed here — this lane
is Pattern C (#110), consumed for one named user (`ORG_GRAPH_OWNER_EMAIL`)
instead of "whoever is signed in".

The consequence worth stating plainly: this lane's coverage is bounded by
what the owner personally has access to. A site the owner cannot open is
invisible to this run, by construction — not a bug to fix, but the whole
point of using a delegated token instead of an app-only one. "Internally
public" SharePoint content is exactly the content a delegated org member's
own sign-in reaches; a colleague's private OneDrive never enters this token's
reach at all, so there is no scoping logic in this lane standing between the
identities it sees and the identities it is allowed to see — Entra already
drew that line before any Graph response reaches this code.

### The evidence, and what never reaches the graph

`lib/org-graph/sharepoint-coactivity.ts` (pure) and
`lib/org-graph/enrich-sharepoint-edges.server.ts` (the Graph reads and Neo4j
writes) enumerate the SharePoint sites and document-library drives the
owner's token can see, and read each drive's items via Graph's `/delta`
endpoint — `createdBy`, `lastModifiedBy`, `lastModifiedDateTime` and
`parentReference` only. **File names and titles are never requested at all**:
the `$select` list has no `name` field, so there is nothing to redact on the
way out — a title can carry sensitive content verbatim, and the lane never
holds one in memory to begin with. `parentReference.path` is read only long
enough to count its segments (a folder-depth integer); the path text itself
is discarded in the same expression. What is kept, briefly, per item: an
opaque site id, an opaque folder id, the depth integer, the timestamp, and
whichever of `createdBy`/`lastModifiedBy` resolves against the roster already
in the graph (by `entraId`, then by `mail`) — an identity matching neither is
dropped without a trace.

**Co-work is inferred from folder co-occurrence, not edit history**: Graph's
driveItem carries only the creator and the last editor, never a full history,
so "two people worked together" is read off two _different_ items landing in
the _same folder_ — weighted by how deep that folder sits (a specific
project folder is stronger evidence than a document library's root) and how
recently the more recent of the two touches happened. A shared _site_ with no
shared folder is kept as a much weaker, separate signal, for the same reason
a shared department outweighs a shared job title in §8's grouping: a fact
everyone in a large group shares proves less than one only a few people
share. A pair's confidence is the sum of its evidence-event weights, capped
below 1.0 (this is always an inference over metadata) and floored — a pair
scoring under the noise threshold is dropped rather than written. The full
formula, as constants rather than prose, is `sharepoint-coactivity.ts`'s own
header and exports (`FOLDER_BASE_WEIGHT`, `SITE_BASE_WEIGHT`, `depthWeight`,
`recencyWeight`, `MAX_CONFIDENCE`, `MIN_CONFIDENCE`).

**No LLM reads any of this.** Pair extraction is the pure, deterministic
function above — re-running it on the same Graph state reproduces the same
edges — so there is no `tool_result` here and no injection-guard boundary to
cross. An LLM pass that names or summarises a pair's basis in prose was
scoped as optional by the task this lane was built for; it was not added,
because it would trade determinism and re-runnability for a description this
doc, the PR body and the edge's own `basis` string already give in full.

### The one ontology change this lane authorised

`Member`↔`Member` was structurally forbidden (§2, "There is deliberately no
reports-to") to keep a hierarchy unexpressible, not merely absent. Observed
collaboration is not a hierarchy, so `ontology.ts` adds exactly one relation,
`COLLABORATES_WITH` (`from: ['Member'], to: ['Member']`), undirected in
meaning — written once per pair in an arbitrary canonical direction, never
read as "A reports into B" — and marked `requiresInferred: true`, the first
use of that field. That flag is what keeps the no-reports-to decision intact
rather than merely relocated: `COLLABORATES_WITH` can express observed
co-work, but **can never be an ingested fact**, and
`NON_CONFORMING_CYPHER` now flags any instance missing `inferred: true` as
drift, the same way it already flags an out-of-ontology label. `ontology.test.ts`
pins both halves — that `COLLABORATES_WITH` is the only Member↔Member relation
declared, and that a non-inferred instance is non-conforming.

### Idempotence, and what it does not attempt

Every run clears every `COLLABORATES_WITH` edge (scoped to that type only —
**not** the blanket "every `inferred: true` relationship" delete
`enrich-org-edges.server.ts` uses, because this lane must not clear that
one's `MEMBER_OF` groupings, or vice versa; see the scripts' `README.md` for
the one ordering consequence this leaves) before re-deriving from Graph's
current state, so a re-run reproduces the same edges from the same tenant
state and nothing is left half-written by an interrupted run. This is the
same "resumable/re-runnable" contract §8's lane already uses — **idempotent
full re-derivation**, not an incremental delta-token resume. A true
incremental resume (persisting Graph's own `/delta` link between runs) was
judged more machinery than a first cut over a tenant this small needs;
flagged here rather than silently assumed. Requests are sequential and every
collection read is capped (`MAX_SITES`, `MAX_DRIVES_PER_SITE`,
`MAX_PAGES_PER_DRIVE` in `enrich-sharepoint-edges.server.ts`) as the
rate-limit courtesy a background job owes a live tenant.
