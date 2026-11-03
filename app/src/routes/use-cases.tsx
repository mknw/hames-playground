/**
 * Use cases (`/use-cases`) — a plain-language guide built from the latest eval
 * round (see `lib/use-cases.ts` for the snapshot and its source).
 *
 * The audience is someone who has never used the app: every question on this
 * page is something they can type into the chat, and "Try this" opens a new
 * chat with that question already filled in — not sent, so they can edit it or
 * just read what is there first. Deliberately no scenario ids, no priorities
 * vocabulary and no eval jargon on the page; the sections carry the catalogue's
 * priority (must / should / nice) under plain headings, each with one plain
 * sentence about how its questions did in the last round.
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
  USE_CASES_TESTED_ON,
  USE_CASE_SECTIONS,
  type UseCaseQuestion,
  type UseCaseResult,
} from '~/lib/use-cases'

/** Section headings in plain words, mapped from the catalogue's priorities. */
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

/** The link's accessible name. 02 and 07 ask the same first question (the
 *  catalogue really does reuse it), so the name must carry more than the turn
 *  text alone: a multi-turn question says a follow-up comes — which is also
 *  exactly what a screen-reader user scanning the link list wants to know. */
const tryThisLabel = (question: UseCaseQuestion): string =>
  question.turns.length > 1
    ? `Try this: ${question.turns[0]} (then a follow-up question)`
    : `Try this: ${question.turns[0]}`

const QuestionCard = (props: { question: UseCaseQuestion }) => (
  <li p="4" rounded="lg" bg="ui-bg-secondary" border="1 ui-border-primary" flex="~ col" gap="3">
    {/* The question as asked — the largest text on the card on purpose. */}
    <p text="lg ui-text-primary" leading="relaxed" m="0">
      {props.question.turns[0]}
    </p>
    <Show when={props.question.turns.length > 1}>
      <div flex="~ col" gap="1" pl="4" border="l-2 ui-border-secondary">
        <span text="lg ui-text-secondary" font="medium">
          Then ask:
        </span>
        <For each={props.question.turns.slice(1)}>
          {(turn) => (
            <p text="lg ui-text-secondary" leading="relaxed" m="0">
              {turn}
            </p>
          )}
        </For>
      </div>
    </Show>
    <div flex="~ wrap" items="center" justify="between" gap="3">
      <ResultBadge result={props.question.result} />
      {/* In-app navigation (router link, not an external link): it lands on a
          brand-new chat — bare `/` with no `?c=` — with the question prefilled
          in the composer, never sent. */}
      <A
        href={`/?${QUESTION_DRAFT_PARAM}=${encodeURIComponent(props.question.turns[0])}`}
        cyber-button=""
        flex="~ items-center gap-2"
        px="5"
        min-h="11"
        text="lg"
        rounded="md"
        aria-label={tryThisLabel(props.question)}
      >
        <span class="i-material-symbols-send-outline" w="5" h="5" aria-hidden="true" />
        Try this
      </A>
    </div>
  </li>
)

// No `min-h="screen"` on <main>: `Nav` sits above this route in the root
// layout, so a full viewport here would always overflow by the nav's height.
export default function UseCases() {
  return (
    <main flex="~ col" gap="6" p="6" bg="ui-bg-primary" text="ui-text-primary" font="sans">
      <div max-w="3xl" mx="auto" w="full" flex="~ col" gap="6">
        <header flex="~ col" gap="2">
          <h1 text="3xl ui-text-primary" font="medium" m="0">
            Use cases
          </h1>
          <p text="lg ui-text-primary" leading="relaxed" m="0">
            This page shows what you can ask the assistant. Every question below is something you
            can type straight into the chat — or press “Try this” and we will put it in for you.
          </p>
          <p text="base ui-text-secondary" m="0">
            Last tested: {USE_CASES_TESTED_ON}
          </p>
        </header>

        <For each={USE_CASE_SECTIONS}>
          {(section) => (
            <section flex="~ col" gap="4">
              <div flex="~ col" gap="1">
                <h2 text="2xl ui-text-primary" font="medium" m="0">
                  {SECTION_LABELS[section.priority]}
                </h2>
                <p text="lg ui-text-secondary" m="0">
                  {sectionSummary(section.questions)}
                </p>
              </div>
              <ul flex="~ col" gap="4" p="0" m="0" list="none">
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
