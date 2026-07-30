# Asking the Microsoft 365 agent — what works, what doesn't

A user-facing guide to the **Microsoft 365** agent: the questions it can answer,
the ones it can't, and why. Written in example phrasings rather than tool names —
you talk to it in plain language, and it picks the tools itself.

**This is a living document.** When a connector is added or a limit changes,
the tables here are the record. (Developer counterpart:
[`docs/MICROSOFT_GRAPH.md`](../MICROSOFT_GRAPH.md) — how the tools work inside.)

Everything below acts **as you**: the agent sees exactly the calendar, mail and
files your Microsoft account can open — nothing more. It only ever **reads**;
it cannot send, create, edit or delete anything.

---

## ✅ Things you can ask

### Your day

| Ask something like | Notes |
|---|---|
| *"What's on my calendar today?"* / *"…tomorrow?"* / *"…yesterday?"* | Times, locations, organizers; recurring meetings included |
| *"Any unread emails?"* / *"What's new in my inbox?"* | Sender, subject and a short preview — **not full bodies** |
| *"What's my job title / office?"* | Your own profile |
| *"Give me a morning briefing"* | Combines calendar + mail + profile in one answer |

### Finding files

| Ask something like | What powers it |
|---|---|
| *"Find files about financial projections"* | Keyword search across your OneDrive **and** every SharePoint site you can open |
| *"Find the Q3 budget — the Excel one"* | `file_type` filter |
| *"TRACEFORM documents changed since July 1"* | date filter |
| *"The last 5 files edited by Thibault"* | author filter + newest-first — first name is enough |
| *"Newest PDFs on the Finance site"* | site + type + sort |
| *"Files Marco authored about CORTEX in June"* | author + both date bounds |
| *"What's in my STIPP folder?"* | folder browsing, can walk into subfolders |

Search is **keyword matching**, not meaning: asking for "revenue forecast"
won't find a file that only says "sales projections". Use the words the
document itself would use.

### Recency and sharing

| Ask something like | Notes |
|---|---|
| *"What did I work on this week?"* / *"my last 10 files"* | Your own recently opened/edited files |
| *"What was shared with me recently?"* | Files **and** email attachments, with who shared each and when |
| *"What did Thibault share with me?"* | Same, filtered to one person |
| *"What files did I email to Thibault since July?"* | Your sent mail with attachments — see the caveat below ⚠ |
| *"What attachments did Marco send me?"* | Received mail with attachments |

⚠ **"What did I email X" is not "what did I share with X".** Sent mail only
shows files that travelled *through email*. Sharing a file from OneDrive's
**Share** button doesn't pass through your sent mail, so those shares are
invisible from your side (see the first row of the ❌ table for why).

---

## ❌ Things it cannot answer (yet, or ever)

| If you ask | What happens & why | Workaround |
|---|---|---|
| *"What files did **I** share with Thibault?"* | **Structurally impossible from your account.** Microsoft records sharing on the *recipient's* side — your outbound shares are written to Thibault's activity, not yours. | Ask *"what did I **email** Thibault"* (partial). Or Thibault signs in and asks *"what did Michael share with me?"* — that works perfectly. |
| *"What does the contract **say** about notice periods?"* | Search returns ~300-character snippets, not file contents. This agent can find the file, not read it. | Open the link it gives you. (A future assistant with document retrieval will close this gap.) |
| *"Summarize the 'Meeting with Sudeesh' Loop page"* | Loop **pages and workspaces** are stored where the app's permissions can't reach (only title/link/snippet come back). Tracked as #137. | Open the Loop link it finds for you. |
| *"What's on **Thibault's** calendar?"* / *"his unread mail"* | Deliberate boundary: the agent acts as you, and only you. | Ask Thibault — or ask *"when am I free"* and coordinate. |
| *"Files in Thibault's OneDrive"* | You only see what's shared with you or in shared sites. Not a bug — that's your real Microsoft access. | — |
| *"Search my email for the DTalk thread from May"* | No mail *search* yet — only recent inbox and attachment listings. | Scroll Outlook, or ask for it as a new connector. |
| *"Send Thibault a reminder"* / *"book a meeting"* / *"delete that file"* | **No write actions exist.** Read-only by design for now; writes will arrive with an explicit confirmation step. | Do it in Outlook/Teams. |
| *"List ALL 1,600 of Thibault's files"* | Results cap at 25 per call. The agent is told to *narrow* (dates, type, site, author) instead of paging. | Ask a narrower question. |
| *"My most-opened file this month"* (stats/counts) | The activity feed is a recency stream, not analytics. | — |
| *"Who has access to this file?"* | No permissions connector. | Check in OneDrive/SharePoint UI. |
| *"What did X post in Teams?"* | No Teams connector. | — |

---

## Reading the agent's answers

- **Links are real.** File answers carry the actual SharePoint/OneDrive/Loop
  links — click through to open the file in Microsoft 365.
- **Counts mean something.** "Showing 10 of 1,685 matches" is Microsoft's real
  total; if the list looks incomplete, narrow the question (by person, date,
  type or site) rather than asking for more results.
- **"Edited by" is really "authored by."** The author filter matches a
  document's creators/co-authors. In practice that's usually the same person
  who last edited it, but a file someone merely touched last can be missed.
- **Dates need to be dates.** "Since July 1" works (the agent converts it);
  if it ever answers with a complaint about an invalid date, rephrase with a
  concrete one ("since 2026-07-01").

---

## Changelog

| Date | Change |
|---|---|
| 2026-07-30 | Added: recent files, shared-with-me, mail attachments (sent/received), author + date + newest-first search filters, folder paths on search results. This guide created. |
| 2026-07-29 | Initial file tools: search, browse. Calendar, inbox, profile. |
