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

| Ask something like                                                  | Notes                                                     |
| ------------------------------------------------------------------- | --------------------------------------------------------- |
| _"What's on my calendar today?"_ / _"…tomorrow?"_ / _"…yesterday?"_ | Times, locations, organizers; recurring meetings included |
| _"Any unread emails?"_ / _"What's new in my inbox?"_                | Sender, subject and a short preview — **not full bodies** |
| _"What's my job title / office?"_                                   | Your own profile                                          |
| _"Give me a morning briefing"_                                      | Combines calendar + mail + profile in one answer          |

### Finding files

| Ask something like                                | What powers it                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| _"Find files about financial projections"_        | Keyword search across your OneDrive **and** every SharePoint site you can open |
| _"Find the Q3 budget — the Excel one"_            | `file_type` filter                                                             |
| _"Falcon project documents changed since July 1"_ | date filter                                                                    |
| _"The last 5 files edited by Adele"_              | author filter + newest-first — first name is enough                            |
| _"Newest PDFs on the Finance site"_               | site + type + sort                                                             |
| _"Files Diego authored about Atlas in June"_      | author + both date bounds                                                      |
| _"What's in my Proposals folder?"_                | folder browsing, can walk into subfolders                                      |

Search is **keyword matching**, not meaning: asking for "revenue forecast"
won't find a file that only says "sales projections". Use the words the
document itself would use.

### Recency and sharing

| Ask something like                                       | Notes                                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| _"What did I work on this week?"_ / _"my last 10 files"_ | Your own recently opened/edited files                                                                                  |
| _"What was shared with me recently?"_                    | Files, files pasted into a Teams chat, **and** email attachments, with who shared each, when and through which channel |
| _"What did Adele share with me?"_                        | Same, filtered to one person                                                                                           |
| _"Show me what was shared with me via Teams"_            | Filtered to one channel — also `by email`, or `as a link`                                                              |
| _"What files did I email to Adele since July?"_          | Your sent mail with attachments — see the caveat below ⚠                                                               |
| _"What attachments did Diego send me?"_                  | Received mail with attachments                                                                                         |

**Files pasted into a Teams chat show up here** — screenshots and documents
dropped into a 1:1 or group chat live in the sender's OneDrive, and sharing them
with the chat counts as sharing them with you. That is why a colleague's
screenshot can be the most recent thing "shared with you" when nobody clicked
Share. It is _files_ only: the chat **messages** around them are not visible (see
the ❌ table).

**Email attachments link to the email, not the file.** Several attachments from
one message are listed separately but carry the same numbered reference, so one
link covers the set.

⚠ **"What did I email X" is not "what did I share with X".** Sent mail only
shows files that travelled _through email_. Sharing a file from OneDrive's
**Share** button doesn't pass through your sent mail, so those shares are
invisible from your side (see the first row of the ❌ table for why).

---

## ❌ Things it cannot answer (yet, or ever)

| If you ask                                                            | What happens & why                                                                                                                                                                                                                              | Workaround                                                                                                                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| _"What files did **I** share with Adele?"_                            | **Unreliable — some of your own shares appear, but not dependably.** Your sharing feed is mostly what others sent you; a few files you shared do show up (3 of 25 in one sample), so an answer here is a partial list presented as a whole one. | Ask _"what did I **email** Adele"_ (partial, but complete for email). Or Adele signs in and asks _"what did Michael share with me?"_ — that works perfectly. |
| _"What does the contract **say** about notice periods?"_              | Search returns ~300-character snippets, not file contents. This agent can find the file, not read it.                                                                                                                                           | Open the link it gives you. (A future assistant with document retrieval will close this gap.)                                                                |
| _"Summarize the 'Meeting with Sudeesh' Loop page"_                    | Loop **pages and workspaces** are stored where the app's permissions can't reach (only title/link/snippet come back). Tracked as #137.                                                                                                          | Open the Loop link it finds for you.                                                                                                                         |
| _"What's on **Adele's** calendar?"_ / _"her unread mail"_             | Deliberate boundary: the agent acts as you, and only you.                                                                                                                                                                                       | Ask Adele — or ask _"when am I free"_ and coordinate.                                                                                                        |
| _"Files in Adele's OneDrive"_                                         | You only see what's shared with you or in shared sites. Not a bug — that's your real Microsoft access.                                                                                                                                          | —                                                                                                                                                            |
| _"Search my email for the DTalk thread from May"_                     | No mail _search_ yet — only recent inbox and attachment listings.                                                                                                                                                                               | Scroll Outlook, or ask for it as a new connector.                                                                                                            |
| _"Send Adele a reminder"_ / _"book a meeting"_ / _"delete that file"_ | **No write actions exist.** Read-only by design for now; writes will arrive with an explicit confirmation step.                                                                                                                                 | Do it in Outlook/Teams.                                                                                                                                      |
| _"List ALL 1,600 of Adele's files"_                                   | Results cap at 25 per call. The agent is told to _narrow_ (dates, type, site, author) instead of paging.                                                                                                                                        | Ask a narrower question.                                                                                                                                     |
| _"My most-opened file this month"_ (stats/counts)                     | The activity feed is a recency stream, not analytics.                                                                                                                                                                                           | —                                                                                                                                                            |
| _"Who has access to this file?"_                                      | No permissions connector.                                                                                                                                                                                                                       | Check in OneDrive/SharePoint UI.                                                                                                                             |
| _"What did X post in Teams?"_                                         | No Teams connector — chat and channel **messages** are not readable. Note this is narrower than it sounds: files _pasted into_ a chat do appear under "what was shared with me via Teams". The words around them do not.                        | Open the chat in Teams.                                                                                                                                      |

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

| Date       | Change                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-08-15 | Correction: "what was shared with me" is **not** purely inbound — a few files you shared yourself do appear. The guide previously said your own shares were invisible from your account, which was wrong.                                        |
| 2026-08-04 | Shared-with-me now says which channel each item arrived through (email / Teams chat / link) and can filter to one. Email attachments link to the message and keep their file extension; several attachments from one email are cross-referenced. |
| 2026-07-30 | Added: recent files, shared-with-me, mail attachments (sent/received), author + date + newest-first search filters, folder paths on search results. This guide created.                                                                          |
| 2026-07-29 | Initial file tools: search, browse. Calendar, inbox, profile.                                                                                                                                                                                    |
