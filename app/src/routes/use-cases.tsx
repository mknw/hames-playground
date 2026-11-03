/**
 * Use cases (`/use-cases`) — a plain-language guide built from the latest eval
 * round (see `lib/use-cases.ts` for the snapshot and its source).
 *
 * The audience is someone who has never used the app: every question on this
 * page is something they can type into the chat, and "Try this" opens a new
 * chat with that question already filled in — not sent, so they can edit it or
 * just read what is there first. Two texts ride on every question (see
 * `lib/use-cases.ts`): the page shows its own PM wording, and "Try this" sends
 * the catalogue's question — the wording the eval round actually measured —
 * verbatim. "Try this" is offered only on questions marked Works.
 * Deliberately no scenario ids, no priorities vocabulary and no eval jargon on
 * the page; the sections carry the catalogue's priority with the developer
 * terms mapped to plain words at render (`PLAIN_WORDS`), and each opens with
 * one plain sentence about how its questions did in the last round.
 *
 * Layout: tiled — one card per question in a responsive grid (one column at
 * phone width, two from md up), each card opening with its short title so an
 * instruction-shaped question ("Edit the org graph") carries its own context.
 * The look is deliberately quiet: the ui-* theme tokens only, tinted accents,
 * no glow — in both themes.
 *
 * Auth matches the rest of the app: the route renders behind `AuthProvider`
 * (see `app.tsx`) and reads nothing from the server, so there is no server
 * action here to gate — the page is a static snapshot module plus markup.
 *
 * Boomer-proofness is a requirement, not a garnish: 18px question text, 44px+
 * click targets, result words that never rely on colour alone, and a layout
 * that works at 390px.
 */

import { A } from '@solidjs/router'
import { For, Show } from 'solid-js'
import {
  QUESTION_DRAFT_PARAM,
  USE_CASES_TESTED_AT,
  USE_CASES_TESTED_ON,
  USE_CASE_SECTIONS,
  plainWords,
  type UseCaseQuestion,
  type UseCaseResult,
} from '~/lib/use-cases'

/** Section headings: the catalogue's priority terms, kept as the developer
 *  vocabulary they are — `plainWords` maps them to plain words at render, so
 *  the page never shows the term itself. */
const SECTION_LABELS: Record<UseCaseSection['priority'], string> = {
  must: 'Must',
  should: 'Should',
  nice: 'Nice to have',
}
type UseCaseSection = (typeof USE_CASE_SECTIONS)[number]

/** One plain sentence on how the section's questions did in the last round.
 *  "Coming soon" is never read as a failure: a section whose misses are all
 *  not-runnable-yet says so instead of quoting a zero. */
const sectionSummary = (questions: UseCaseQuestion[]): string => {
  const worked = questions.filter((q) => q.result === 'works').length
  const failed = questions.filter((q) => q.result === 'not-yet').length
  if (worked === questions.length) return `All ${questions.length} worked in the last test.`
  if (failed > 0) return `${worked} of ${questions.length} worked in the last test.`
  return 'Coming soon — these were not runnable in the last test.'
}

/** The badge for one result. Three explicit branches rather than a lookup
 *  table: the palette classes must be literal in the source for UnoCSS to
 *  extract them — a runtime-composed `bg-${tone}/10` emits no CSS at all.
 *  The word is the accessible content, the colour only reinforces it. The
 *  branches stay inside one returned element (no early returns: Solid
 *  components run once, and an early return reads as one). */
const ResultBadge = (props: { result: UseCaseResult }) => (
  <Show
    when={props.result === 'works'}
    fallback={
      <Show
        when={props.result === 'not-yet'}
        fallback={
          <span
            flex="~ items-center gap-2"
            p="x-3 y-1.5"
            rounded="full"
            bg="ui-accent/10"
            text="base ui-accent"
            font="medium"
          >
            <span class="i-material-symbols-schedule" w="5" h="5" aria-hidden="true" />
            Coming soon
          </span>
        }
      >
        <span
          flex="~ items-center gap-2"
          p="x-3 y-1.5"
          rounded="full"
          bg="ui-danger/10"
          text="base ui-danger"
          font="medium"
        >
          <span class="i-material-symbols-error" w="5" h="5" aria-hidden="true" />
          Not yet reliable
        </span>
      </Show>
    }
  >
    <span
      flex="~ items-center gap-2"
      p="x-3 y-1.5"
      rounded="full"
      bg="ui-success/8"
      text="base ui-success"
      font="medium"
    >
      <span class="i-material-symbols-task-alt" w="5" h="5" aria-hidden="true" />
      Works
    </span>
  </Show>
)

/** The link's accessible name. 02 and 07 open on the same first question,
 *  so the name must carry more than the turn text alone: the title
 *  distinguishes them — which is also exactly what a screen-reader user
 *  scanning the link list wants to know, and a multi-turn question says a
 *  follow-up comes. The name quotes the question that will be SENT (the
 *  catalogue's verbatim), not the page's wording of it. */
const tryThisLabel = (question: UseCaseQuestion): string =>
  question.turns.length > 1
    ? `Try this — ${question.title}: ${question.turns[0]} (then a follow-up question)`
    : `Try this — ${question.title}: ${question.turns[0]}`

const QuestionCard = (props: { question: UseCaseQuestion }) => (
  <li
    flex="~ col"
    gap="3"
    p="5"
    rounded="lg"
    bg="ui-bg-secondary"
    border="1 ui-border-primary"
    h="full"
  >
    {/* The short title — the context an instruction-shaped question needs. */}
    <h3 text="base ui-text-secondary" font="medium" m="0">
      {props.question.title}
    </h3>
    {/* The question as the page words it — the largest text on the card on purpose. */}
    <p text="lg ui-text-primary" leading="relaxed" m="0">
      {plainWords(props.question.pageTurns[0])}
    </p>
    <Show when={props.question.pageTurns.length > 1}>
      <div flex="~ col" gap="1" pl="4" border="l-2 ui-border-secondary">
        <span text="lg ui-text-secondary" font="medium">
          Then ask:
        </span>
        <For each={props.question.pageTurns.slice(1)}>
          {(turn) => (
            <p text="lg ui-text-secondary" leading="relaxed" m="0">
              {plainWords(turn)}
            </p>
          )}
        </For>
      </div>
    </Show>
    {/* mt-auto pins the footer to the tile's bottom, so badges and buttons
        line up across a grid row whatever the questions' lengths. */}
    <div flex="~ wrap" items="center" justify="between" gap="3" mt="auto" pt="1">
      <ResultBadge result={props.question.result} />
      {/* Owner decision, #937 round 3: only a question marked Works offers
          "Try this" — not "Not yet reliable", not "Coming soon". In-app
          navigation (router link, not an external link): it lands on a
          brand-new chat — bare `/` with no `?c=` — with the catalogue's
          question prefilled in the composer, never sent. The quiet tinted
          button, not the chat app's cyber-button: this page is a guide, not
          the product. */}
      <Show when={props.question.result === 'works'}>
        <A
          href={`/?${QUESTION_DRAFT_PARAM}=${encodeURIComponent(props.question.turns[0])}`}
          flex="~ items-center gap-2"
          px="4"
          min-h="11"
          text="lg ui-accent"
          font="medium"
          rounded="md"
          bg="ui-accent/10 hover:ui-accent/20"
          border="1 ui-border-accent"
          aria-label={tryThisLabel(props.question)}
        >
          <span class="i-material-symbols-send-outline" w="5" h="5" aria-hidden="true" />
          Try this
        </A>
      </Show>
    </div>
  </li>
)

// No `min-h="screen"` on <main>: `Nav` sits above this route in the root
// layout, so a full viewport here would always overflow by the nav's height.
export default function UseCases() {
  return (
    <main flex="~ col" gap="6" p="6" bg="ui-bg-primary" text="ui-text-primary" font="sans">
      <div max-w="5xl" mx="auto" w="full" flex="~ col" gap="6">
        <header flex="~ col" gap="2">
          <h1 text="3xl ui-text-primary" font="medium" m="0">
            Use cases
          </h1>
          <p text="lg ui-text-primary" leading="relaxed" m="0">
            This page shows what you can ask the assistant. Every question below is something you
            can type straight into the chat — or press “Try this” on a question marked Works, and we
            will put it in for you.
          </p>
          {/* The snapshot's own timestamp, never a build or render time: the
              line describes the data, not this deploy. */}
          <p flex="~ items-center" gap="1.5" text="base ui-text-secondary" m="0">
            <span class="i-material-symbols-history" w="4" h="4" aria-hidden="true" />
            Data updated: {USE_CASES_TESTED_ON}
            <Show when={USE_CASES_TESTED_AT !== undefined}>, {USE_CASES_TESTED_AT}</Show>
          </p>
        </header>

        <For each={USE_CASE_SECTIONS}>
          {(section) => (
            <section flex="~ col" gap="4">
              <div flex="~ col" gap="1">
                <h2 text="2xl ui-text-primary" font="medium" m="0">
                  {plainWords(SECTION_LABELS[section.priority])}
                </h2>
                <p text="lg ui-text-secondary" m="0">
                  {sectionSummary(section.questions)}
                </p>
              </div>
              {/* Tiled: one card per question, two columns from md up. */}
              <ul grid="~ cols-1 md:cols-2" gap="4" p="0" m="0" list="none">
                <For each={section.questions}>
                  {(question) => <QuestionCard question={question} />}
                </For>
              </ul>
            </section>
          )}
        </For>
      </div>
    </main>
  )
}
