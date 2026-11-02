/**
 * The retrieval-quality scenario's corpus — SYNTHETIC, written for this eval.
 *
 * Every company, product, code, name and number below is invented. Nothing
 * here is drawn from a real deployment, a real hostname or a real document;
 * the repo is public and this file ships in it.
 *
 * The corpus is graded against KNOWN answers: each question names an
 * `answerMarker`, a string that appears in exactly one chunk of exactly one
 * document. That locates the ground-truth chunk deterministically — see
 * `deriveGroundTruth()`, which runs the same `chunkDocument()` call
 * `ingestDocument()` runs, so the ground truth and the indexed corpus cannot
 * disagree. The hermetic proof (`evals/retrieval-quality.hermetic.ts`) pins
 * marker uniqueness, and the scenario re-checks it live against the ingested
 * chunk counts.
 *
 * The corpus deliberately exceeds the largest graded k (roughly 22 chunks
 * against k=20) so recall@20 is a measurement and not a tautology, and so an
 * answer can genuinely rank below the production page size of 5.
 *
 * Four question categories, the three the owner asked for plus a sanity floor
 * (#928/#927):
 *
 * - `exact-term`  — the answer hangs off an exact code, name or number. A
 *   keyword match finds it; an embedding match tends to blur it. These are the
 *   questions #928 slice 1 (BM25 + RRF) exists to move.
 * - `paraphrase`  — the answer shares almost no surface terms with the
 *   question. An embedding match finds it; a keyword match tends to miss it.
 * - `deep`        — the answer sits in a late chunk of the corpus, beyond the
 *   first page of 5, among distractor chunks that share its generic
 *   vocabulary. recall@10 / recall@20 measure what paging (#927 slice 2) can
 *   reach that a single k=5 read cannot.
 * - `easy`        — the floor both matchers should clear; a red `easy` row
 *   indicts the run, not the backend.
 */

import { chunkDocument } from '@hames-ai/harness-patterns/stash/chunking.server'

export interface FixtureDoc {
  /** Deterministic doc id — the scenario stores/ingests under exactly this id,
   *  so the ground truth can name it up front. */
  id: string
  filename: string
  mimeType: string
  content: string
}

export type QuestionCategory = 'exact-term' | 'paraphrase' | 'deep' | 'easy'

export interface FixtureQuestion {
  id: string
  category: QuestionCategory
  /** Asked verbatim of the backend. */
  text: string
  /** A substring of the one chunk that holds the answer. Must be unique across
   *  the whole corpus AND unique across the chunker's overlapping window —
   *  `deriveGroundTruth` refuses anything that lands in two chunks or two
   *  documents. Keep markers away from chunk boundaries, and never let a
   *  single section exceed the 1000-character chunk budget, which sub-splits
   *  with an overlapping window and would duplicate the marker. */
  answerMarker: string
}

// ============================================================================
// Corpus
// ============================================================================

export const DOCS: FixtureDoc[] = [
  {
    id: 'fx-aurora',
    filename: 'aurora-9-service-manual.md',
    mimeType: 'text/markdown',
    content: `# AURORA-9 Field Sensor — Service Manual

Fictional device used by the Harrowfield Environmental Trust for peatland
monitoring. This manual covers hardware revision C and firmware 3.2 or later;
earlier revisions are serviced against the revision B supplement, which the
stores desk keeps as a separate binder. Read the whole manual before opening
an enclosure for the first time: three of the procedures below interact, and
performing them out of order voids the calibration record.

## Fault codes

The status LED blinks a two-digit pattern, and the diagnostic log records the
matching fault code. Codes are stable across firmware 3.x, so a code noted in
a 3.1 log can be read against this table without translation.

- **ERR-2210** — battery cell imbalance. Charge the pack on the bench cradle
  and re-run the self-test before redeploying.
- **ERR-7A42** — Hall sensor phase dropout on the anemometer bearing. In the
  field this is almost always grit ingress, not a failed sensor: blow out the
  bearing seat with dry nitrogen and retry. Replace the bearing assembly only
  if the code returns within one logging cycle.
- **ERR-9015** — flash wear limit reached. The logging partition must be
  reformatted; logs older than 90 days are lost.
- **ERR-3308** — RTC drift beyond 4 seconds per day. Replace the backup cell
  and resynchronise against the depot reference clock.

## Torque specifications

Do not exceed the published limits when servicing the mast clamp, and always
torque in the crosswise pattern shown on the enclosure's inside lid. A clamp
that has been over-torqued once must be inspected for thread deformation even
if it later passes the pull test; deformation is progressive, and a clamp that
fails in the field drops the mast onto the sensor head, which is the single
most expensive failure this manual covers.

- Mast clamp screws: 2.1 N·m nominal, 2.4 N·m absolute maximum.
- Bearing retainer ring: 0.9 N·m.
- The drain plug on the enclosure base takes 1.6 N·m and must be fitted with a
  fresh sealing washer (service part **PG-4411-B**) every time it is removed.
  Reusing the washer is the most common cause of the humidity drift reported
  against revision B enclosures.

## Thermal behaviour

During sustained high-rate logging the AURORA-9 protects itself by derating:
the sample clock steps down from 10 Hz to 2 Hz once the internal thermistor
reads 58 degrees C, and logging pauses entirely at 71 degrees C. This is the
designed duty-cycle limit, not a fault. Mounting the unit with the fins in
shade and the vent facing away from the afternoon sun keeps the derate from
engaging in normal summer operation. Enclosures painted dark colours void the
thermal margin entirely, and the trust will not accept summer data from a
dark-painted installation.

## Battery and power

The standard pack is a 6-cell lithium iron phosphate string, 18 Ah nominal.
Below minus 15 degrees C the pack's internal protection limits charge current,
so a pack that spent the night in the cold must be brought indoors and warmed
before a bench charge. A pack that has cycled more than 1,200 times is retired
regardless of measured capacity, because the imbalance rate rises steeply
after that point. Solar input is sized for the summer schedule; winter
operation relies on the scheduled sleep windows in firmware 3.2 and later.

## Firmware updates

Firmware ships as a signed image on the service tablet. Never interrupt a
write: a failed image leaves the unit in recovery, and recovery mode accepts
only a full reflash plus a recalibration. Update the tablet's signer keys
before the field season, not during it — the key rotation in spring 3.2
disabled every tablet that had not been updated, which cost the trust two
weeks of gaps.

## Calibration

The humidity and temperature channels are calibrated as a pair against the
depot reference; the anemometer is calibrated separately on the wind tunnel
rig. A calibration is valid for 400 days, after which the log stamps a warning
banner into every subsequent record rather than silently continuing. Keep the
calibration certificate with the unit's service history — auditors of the
peatland grant ask for certificate and data together, and a record without its
certificate is treated as uncalibrated.

## Storage and transport

Units in storage are cycled monthly: a full self-test and one hour of logging
onto the bench harness. A unit left unpowered for a season arrives with a
flat RTC cell and a drifted humidity zero, and both must be serviced before
deployment. Transport cases hold one unit, one mast clamp set and one
nitrogen duster; do not stack cases more than four high, because the lid foam
of the bottom case takes a permanent set.

## Spares

Order consumables through the trust stores desk quoting the service part
number. A field kit holds two sealing washers, one bearing assembly, one RTC
cell and a nitrogen duster canister. Kits are checked out against a person,
not against a vehicle, and the stores desk reconciles kits at the end of each
field week.`,
  },
  {
    id: 'fx-cobalt',
    filename: 'cobalt-seasonal-logistics-memo.md',
    mimeType: 'text/markdown',
    content: `# Project Cobalt — seasonal logistics memo

Circulated to the Harrowfield depot coordinators ahead of the winter
fisheries season. Planning document; figures are budgeted, not actuals, and
the finance office reconciles them against the season ledger in April. Read
this memo together with the depot standing orders, which it amends in three
places; where the two disagree, this memo wins for the season's duration.

## Cold chain

Perishable catch survives the coastal leg only inside the insulated containers.
Pre-chill each box to 2 degrees C before loading, pack gelant packs against
the long walls, and never stack a chilled box above a dry-goods one. The
refrigerated trailer holds 4 degrees C set point; the depot's thermographs
record the whole journey and a break above 8 degrees C for more than forty
minutes quarantines the affected pallets on arrival. Quarantined pallets are
held in the chilled annex, not the yard, while QA decides.

## Damage handling

Bruised or crushed consignments go to the cold-chain QA desk, not to the
driver. QA photographs every damaged unit against its manifest line within
twelve hours of landing, because the insurer rejects claims photographed
later. The claims window closes at 72 hours; after that the depot absorbs the
loss. Coordinators keep the QA desk's direct line on the shift clipboard and
are reminded not to email photographs to the general depot address, which is
monitored by the office, not by QA.

## Scheduling

Deck crews rotate on a 14-day pattern with two vessels in refit at any time.
The refit plan is published six weeks ahead and may not be traded against
landings without the harbourmaster's sign-off. Night landings during the
herring run run through the east gate only; the west gate closes at 19:00
during the season and reopens for the herring weeks by exception.

## Vehicle maintenance

Refrigerated trailers are serviced every 12,000 km or 90 days, whichever
comes first, and the thermograph is calibrated at every service. A trailer
whose thermograph is out of calibration may not carry chilled goods — no
exception, because an uncalibrated trace is evidence of nothing and the
insurer says so in writing.

## Budget

The season budget reserves 18,400 units for refrigerated transport, 6,200 for
packaging consumables and 2,750 for the QA desk's overtime. The insulated
container fleet is 340 boxes, of which 12 are conventionally out for repair
at any time; a fleet count below 320 grounded triggers the lease rider, so
report damaged boxes the day they are found.

## Contacts

- Cold-chain QA desk (damage claims, quarantines): ext. 4471.
- Depot shift supervisor: ext. 4402.
- Fisheries union liaison: ext. 4488.
- Harbourmaster's office (gate exceptions, refit trades): ext. 4455.`,
  },
  {
    id: 'fx-meridian',
    filename: 'meridian-grant-handbook.md',
    mimeType: 'text/markdown',
    content: `# Meridian Grant Programme — administrative handbook

Governs the Harrowfield Trust's research grants. This handbook is the
controlling document where a grant letter is silent, and the grant letter may
only be more generous to the grantee, never less. Where neither document
answers a question, the programme office decides and records the decision in
the grants register, which is itself binding on later grants of the same kind.

## Eligibility

Applicants must hold a research post at a recognised institution and may not
hold two Meridian awards concurrently. Early-career applicants within five
years of their doctorate qualify for the accelerated track, which shortens
review to six weeks. Emeritus and honorary posts do not count as research
posts for this purpose, however senior their holders; the trust's position is
that the award funds active research leadership, not title.

## Eligible costs

Staff time directly attributed to the project, equipment under 4,000 units per
item, consumables, and travel necessarily undertaken for the work. Venue hire
for dissemination events is eligible up to 1,500 units; hospitality is not
eligible at all, in any category, and never becomes eligible by being renamed.
Costs incurred before the start date are never eligible, even when they were
unavoidable and even when the delay was the trust's own.

## Award structure

Awards are paid in three tranches: 50 percent at acceptance, 30 percent at the
mid-term report, and the remaining 20 percent on acceptance of the final
report. The mid-term report is due 14 months after the start date; a grant
that misses it by more than 60 days is suspended automatically and the
unspent balance is recalled to the central fund. Suspension is lifted only by
the programme office, and only once the report is accepted.

## Mid-term review

The mid-term review panel meets quarterly. Panel comments are advisory; the
programme office decides. A grantee may respond to panel comments in writing
within 20 working days, and the response is appended to the grant file. A
panel may recommend a scope change, a budget reallocation between eligible
heads, or early closure; only the programme office may act on a
recommendation, and it must give reasons when it declines one.

## Progress reporting

Between the mid-term and final reports, grantees file a one-page progress note
every six months. The note is not assessed, but a grant two notes in arrears
is placed on the watch list, and the watch list is reviewed at every panel
meeting. Repeated arrears across two grants closes the grantee's eligibility
for the accelerated track for five years.

## Travel and fieldwork

Fieldwork away from the institution for more than 15 nights requires a
fieldwork plan lodged before departure, covering insurance, lone-working
arrangements and data custody while away. International travel books the
lowest logical fare; the programme office will not reimburse a fare booked
against a personal loyalty programme when a cheaper logical fare existed.
Carbon offsets are not an eligible cost.

## Consortium applications

A consortium grant names one lead applicant, who holds the award and pays the
partners; the trust signs no sub-agreements. The lead reports on behalf of
every partner, and a partner's breach is the lead's breach for clawback
purposes — a rule partners see when they sign the collaboration letter, not
when something goes wrong. A consortium may not exceed five partners without
the steering committee's consent, which is sought through the programme
office in writing and granted rarely, because each partner multiplies the
reporting the panel must read.

## Open access and data

Outputs are deposited open access within 12 months of publication; where the
publisher's embargo is longer, the accepted manuscript is deposited at once
and released when the embargo lifts. Project data is deposited under the data
plan lodged at acceptance, and a dataset that cannot be shared — patient
data, licensed instruments — is registered with a metadata record and a
contact route instead. The trust pays no article processing charges directly;
they come out of the grant's eligible costs, capped at 2,000 units per
output.

## Changes and variations

A change of principal investigator, a scope change, or a budget move above
10 percent of the award needs the programme office's written approval before
it takes effect; anything else the grantee records and moves on. A variation
applied for after the fact is treated as an unapproved change even when it
would have been approved — the point of the rule is the order of events, not
the outcome. Extensions of the end date are variations of scope and follow
the same route.

## Visiting researchers

A grant may fund visits by researchers from other institutions for up to 90
nights per visit and 180 nights per grant. Visits are treated as eligible
travel plus a subsistence allowance at the published daily rate; hosting
fees, bench fees and honoraria are not eligible in this line. The visiting
researcher's home institution remains their employer for insurance purposes,
and the visiting plan says so, because two insurers arguing after an incident
is the failure this rule exists to prevent.

## Procurement and equipment

Equipment above 4,000 units per item needs three quotations or a single-source
justification countersigned by the grantee's procurement office. Equipment
bought with grant funds above 10,000 units carries a disposal obligation: at
grant end the grantee offers it back to the trust at residual value before
disposing of it any other way. Equipment below that line is the grantee's to
keep, which is deliberately the case, because the trust does not want a
storeroom of three-year-old laptops.

## Clawback and remedies

Where expenditure is found to be outside the approved budget, the programme
office recovers the disallowed amount from the next tranche first, and only
then from grantee funds. The recovery window — the period during which the
office may open a recovery action — is **30 months** from the date of the
expenditure report in question. After the window closes, an error may still
be recorded against the grant's compliance history, but no money moves.
Recovery is never retroactive against a closed grant, and interest is not
charged on recovered amounts.

## Final report

The final report is due within 90 days of the end date. It must include the
expenditure statement signed by the grantee's finance office. Two extensions
of 30 days each may be granted by the programme office on written request;
further extension requires the steering committee. A final report accepted
late is still accepted in full; lateness is recorded, but the remaining
tranche is not withheld on that ground alone.

## Records and appeals

Grant files are retained for ten years after closure. A grantee may appeal a
recovery action to the steering committee within 40 working days; the
committee's decision is final and is not published. Appeals are decided on
the papers alone; there is no oral hearing, and the committee may vary,
uphold or cancel the recovery in whole or in part. A cancelled recovery is
returned to the central fund's contingency line, not to the grant.`,
  },
]

export const QUESTIONS: FixtureQuestion[] = [
  // ── exact-term: keyword-friendly, embedding-hard ─────────────────────────
  {
    id: 'q-exact-code',
    category: 'exact-term',
    text: 'What does fault code ERR-7A42 mean on the AURORA-9?',
    // The code itself is the marker: BM25 scores it as a rare exact term,
    // while an embedder blurs it into "error / fault / sensor" soup.
    answerMarker: 'Hall sensor phase dropout on the anemometer bearing',
  },
  {
    id: 'q-exact-part',
    category: 'exact-term',
    text: 'Which service part number must be fitted fresh every time the drain plug is removed?',
    answerMarker: 'PG-4411-B',
  },
  {
    id: 'q-exact-figure',
    category: 'exact-term',
    text: 'What is the recovery window for opening a Meridian recovery action?',
    answerMarker: '30 months',
  },

  // ── paraphrase: embedding-friendly, keyword-hard ─────────────────────────
  {
    id: 'q-para-thermal',
    category: 'paraphrase',
    text: 'How do I stop my field sensor from overheating when it logs at high rates?',
    // The answer paragraph never says "overheat" or "stop" — it talks about
    // derating, duty-cycle limits, shade and vents.
    answerMarker: 'sample clock steps down from 10 Hz to 2 Hz',
  },
  {
    id: 'q-para-damage',
    category: 'paraphrase',
    text: 'Who at the depot should I go to when a consignment arrives bruised?',
    // The answer says "cold-chain QA desk" and "damage handling"; the question
    // says "bruised" and "go to". Almost no lexical overlap.
    answerMarker: 'QA photographs every damaged unit',
  },
  {
    id: 'q-para-storage',
    category: 'paraphrase',
    text: 'What must be done before putting a sensor back into service after a long time in storage?',
    // The answer talks about monthly cycling, a flat RTC cell and a drifted
    // humidity zero — it never says "before putting back into service".
    answerMarker: 'flat RTC cell and a drifted humidity zero',
  },

  // ── deep: the answer sits beyond the first page of 5 ─────────────────────
  // All three live in the handbook's last sections, whose generic vocabulary
  // (grant, report, records, committee, recovery) recurs in ~10 earlier chunks.
  {
    id: 'q-deep-records',
    category: 'deep',
    text: 'How long are Meridian grant files kept after a grant closes?',
    answerMarker: 'Grant files are retained for ten years',
  },
  {
    id: 'q-deep-appeal',
    category: 'deep',
    text: 'Can a grantee appeal a recovery action, and to whom?',
    // Linebreak-safe: the phrase "may appeal a↵recovery action" wraps across a
    // source line, so the marker names the sentence's tail instead.
    answerMarker: "committee's decision is final",
  },
  {
    id: 'q-deep-disposal',
    category: 'deep',
    text: 'What happens to equipment bought with grant money when the grant ends?',
    answerMarker: 'offers it back to the trust at residual value',
  },

  // ── easy: the sanity floor both matchers should clear ────────────────────
  {
    id: 'q-easy-quarantine',
    category: 'easy',
    text: 'When does the depot quarantine pallets on arrival?',
    answerMarker: 'quarantines the affected pallets',
  },
  {
    id: 'q-easy-tranches',
    category: 'easy',
    text: 'How much of a Meridian award is paid at acceptance?',
    answerMarker: '50 percent at acceptance',
  },
  {
    id: 'q-easy-led',
    category: 'easy',
    text: 'What does fault code ERR-9015 on the AURORA-9 require?',
    answerMarker: 'flash wear limit reached',
  },
]

// ============================================================================
// Ground truth
// ============================================================================

export interface GroundTruthEntry {
  question: FixtureQuestion
  doc: FixtureDoc
  /** Chunk count `chunkDocument` produced for this doc — the scenario asserts
   *  the ingested corpus chunked to the same count. */
  chunkCount: number
  truth: { docId: string; chunkIndex: number }
}

/**
 * Locate every question's ground-truth chunk by running the SAME chunker with
 * the SAME default config `ingestDocument` uses, then finding the one chunk
 * whose content contains the marker.
 *
 * Throws when a marker lands in zero chunks, in more than one document, or in
 * more than one chunk: the overlap window duplicates boundary text, so a
 * marker placed too close to a chunk boundary would name two ground truths —
 * the grader would then grade against a chunk the answer is only half in.
 * Refusing here keeps a future edit of the corpus or of the chunker from
 * shipping a silently wrong answer key.
 */
export function deriveGroundTruth(): GroundTruthEntry[] {
  const out: GroundTruthEntry[] = []
  for (const q of QUESTIONS) {
    const docs = DOCS.filter((d) => d.content.includes(q.answerMarker))
    if (docs.length !== 1) {
      throw new Error(
        `answerMarker for ${q.id} appears in ${docs.length} documents (need exactly 1): ` +
          JSON.stringify(q.answerMarker),
      )
    }
    const doc = docs[0]
    const chunks = chunkDocument(doc.content, doc.mimeType)
    const owners = chunks.filter((c) => c.content.includes(q.answerMarker))
    if (owners.length !== 1) {
      throw new Error(
        `answerMarker for ${q.id} lands in ${owners.length} chunks (need exactly 1; the overlap ` +
          'window duplicates boundary text — move the marker away from the boundary): ' +
          JSON.stringify(q.answerMarker),
      )
    }
    out.push({
      question: q,
      doc,
      chunkCount: chunks.length,
      truth: { docId: doc.id, chunkIndex: owners[0].index },
    })
  }
  return out
}
