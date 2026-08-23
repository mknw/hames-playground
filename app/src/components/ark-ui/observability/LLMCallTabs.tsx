/**
 * LLM call drill-down — the usage/cost bar and the Prompt/Output tab pair
 * over a captured BAML call. Split out of `ObservabilityPanel.tsx` (#226 B5).
 */

import { Match, Show, Switch, createSignal } from 'solid-js'
import { Accordion } from '@ark-ui/solid/accordion'
import type { LLMCallData } from '~/lib/harness-patterns'
import { fmtUsd } from '~/lib/observability/token-totals'
import { CodeBlock, ParsedPromptView } from './PromptView'

type LLMTab = 'prompt' | 'output'

const TabButton = (props: { active: boolean; label: string; onClick: () => void }) => (
  <button
    onClick={props.onClick}
    p="x-3 y-1.5"
    text={`xs ${props.active ? 'neon-cyan' : 'dark-text-secondary hover:dark-text-primary'}`}
    bg={props.active ? 'neon-cyan/10' : 'transparent hover:dark-bg-hover'}
    border={props.active ? '1 neon-cyan/30' : '1 transparent'}
    rounded="md"
    cursor="pointer"
    transition="all"
    font="medium"
  >
    {props.label}
  </button>
)

const UsageStats = (props: { llmCall: LLMCallData }) => (
  <div bg="dark-bg-tertiary" p="3" rounded="md" m="b-3">
    <div flex="~ wrap" gap="4" items="center">
      {/* Function & Provider */}
      <div flex="~ col" gap="0.5">
        <span text="xs dark-text-tertiary">Function</span>
        <span text="sm neon-cyan" font="mono">
          {props.llmCall.functionName}
        </span>
      </div>
      <Show when={props.llmCall.provider}>
        <div flex="~ col" gap="0.5">
          <span text="xs dark-text-tertiary">Provider</span>
          <span text="sm dark-text-primary" font="mono">
            {props.llmCall.provider}
          </span>
        </div>
      </Show>
      <Show when={props.llmCall.clientName}>
        <div flex="~ col" gap="0.5">
          <span text="xs dark-text-tertiary">Client</span>
          <span text="sm dark-text-primary" font="mono">
            {props.llmCall.clientName}
          </span>
        </div>
      </Show>

      {/* Separator */}
      <div w="px" h="8" bg="dark-border-secondary" />

      {/* Token stats — selected exchange (full breakdown, #122) */}
      <Show when={props.llmCall.usage}>
        <div flex="~ col" gap="0.5" title="Input tokens billed at the full base rate">
          <span text="xs dark-text-tertiary">Input (fresh)</span>
          <span text="sm neon-green" font="mono">
            {props.llmCall.usage!.inputTokens.toLocaleString()}
          </span>
        </div>
        <Show when={props.llmCall.usage!.cachedInputTokens > 0}>
          <div
            flex="~ col"
            gap="0.5"
            title="Input tokens read from cache — billed at 0.1× the base rate"
          >
            <span text="xs dark-text-tertiary">Cache read</span>
            <span text="sm violet-400" font="mono">
              {props.llmCall.usage!.cachedInputTokens.toLocaleString()}
            </span>
          </div>
        </Show>
        <Show when={(props.llmCall.usage!.cacheCreationInputTokens ?? 0) > 0}>
          <div
            flex="~ col"
            gap="0.5"
            title="Input tokens written to cache — billed at 1.25× the base rate"
          >
            <span text="xs dark-text-tertiary">Cache write</span>
            <span text="sm amber-400" font="mono">
              {props.llmCall.usage!.cacheCreationInputTokens!.toLocaleString()}
            </span>
          </div>
        </Show>
        <div flex="~ col" gap="0.5">
          <span text="xs dark-text-tertiary">Output</span>
          <span text="sm neon-cyan" font="mono">
            {props.llmCall.usage!.outputTokens.toLocaleString()}
          </span>
        </div>
        <div
          flex="~ col"
          gap="0.5"
          title="All tokens processed: fresh + cache read + cache write + output"
        >
          <span text="xs dark-text-tertiary">Total</span>
          <span text="sm amber-400" font="mono">
            {props.llmCall.usage!.totalTokens.toLocaleString()}
          </span>
        </div>
      </Show>

      {/* Step accounting — summed across ALL attempts (retries/fallbacks) */}
      <Show when={props.llmCall.metrics}>
        <Show when={props.llmCall.metrics!.attempts > 1}>
          <div
            flex="~ col"
            gap="0.5"
            title="This step needed multiple API calls (truncation retry / fallback chain); tokens and cost below include all of them"
          >
            <span text="xs dark-text-tertiary">Attempts</span>
            <span text="sm red-400" font="mono">
              {props.llmCall.metrics!.attempts}
            </span>
          </div>
        </Show>
        <Show when={props.llmCall.metrics!.costUsd !== undefined}>
          <div
            flex="~ col"
            gap="0.5"
            title={`At $${props.llmCall.metrics!.rates?.inPerMTok}/$${props.llmCall.metrics!.rates?.outPerMTok} per MTok; uncached this call would be ${fmtUsd(props.llmCall.metrics!.noCacheUsd ?? props.llmCall.metrics!.costUsd!)}`}
          >
            <span text="xs dark-text-tertiary">Cost (step)</span>
            <span text="sm dark-text-primary" font="mono">
              {fmtUsd(props.llmCall.metrics!.costUsd!)}
            </span>
          </div>
        </Show>
      </Show>

      {/* Duration */}
      <Show when={props.llmCall.durationMs}>
        <div flex="~ col" gap="0.5">
          <span text="xs dark-text-tertiary">Duration</span>
          <span text="sm dark-text-primary" font="mono">
            {props.llmCall.durationMs}ms
          </span>
        </div>
      </Show>
    </div>
  </div>
)

/** One section inside the Prompt accordion. */
const PromptAccordionItem = (props: {
  value: string
  label: string
  hint?: string
  children: import('solid-js').JSX.Element
}) => (
  <Accordion.Item
    value={props.value}
    border="1 dark-border-secondary/40"
    rounded="md"
    overflow="hidden"
  >
    <Accordion.ItemTrigger
      w="full"
      p="x-3 y-2"
      flex="~"
      items="center"
      justify="between"
      gap="3"
      bg="dark-bg-tertiary hover:dark-bg-hover"
      cursor="pointer"
      text="left"
      style={{ border: 'none' }}
    >
      <div flex="~" items="center" gap="2">
        <span text="xs neon-cyan" font="mono medium">
          {props.label}
        </span>
        <Show when={props.hint}>
          <span text="xs dark-text-tertiary">{props.hint}</span>
        </Show>
      </div>
      <Accordion.ItemIndicator
        text="xs dark-text-secondary"
        style={{ transition: 'transform 150ms', 'transform-origin': 'center' }}
      >
        ▼
      </Accordion.ItemIndicator>
    </Accordion.ItemTrigger>
    <Accordion.ItemContent p="3" bg="dark-bg-secondary">
      {props.children}
    </Accordion.ItemContent>
  </Accordion.Item>
)

const PromptAccordion = (props: { llmCall: LLMCallData }) => {
  const hasTemplate = () => Boolean(props.llmCall.promptTemplate)
  const hasMessages = () => Boolean(props.llmCall.rawInput)
  const variableKeys = () => Object.keys(props.llmCall.variables ?? {})

  // Default-open the most informative section that has data
  const defaultValue = () => {
    if (hasTemplate()) return ['template']
    if (hasMessages()) return ['messages']
    return ['variables']
  }

  return (
    <Accordion.Root multiple defaultValue={defaultValue()} flex="~ col" gap="2">
      <PromptAccordionItem
        value="template"
        label="Template"
        hint={hasTemplate() ? 'Jinja source with {{ vars }} and conditionals' : 'not captured'}
      >
        <Show
          when={hasTemplate()}
          fallback={
            <div text="xs dark-text-tertiary">
              BAML prompt template not captured. Run <code>pnpm baml-generate</code> or verify the
              function name <code>{props.llmCall.functionName}</code> exists in{' '}
              <code>baml_src/</code>.
            </div>
          }
        >
          <CodeBlock content={props.llmCall.promptTemplate} />
        </Show>
      </PromptAccordionItem>

      <PromptAccordionItem
        value="variables"
        label="Variables"
        hint={`${variableKeys().length} input${variableKeys().length === 1 ? '' : 's'}`}
      >
        <Show
          when={variableKeys().length > 0}
          fallback={<div text="xs dark-text-tertiary">No variables passed to this function.</div>}
        >
          <CodeBlock content={JSON.stringify(props.llmCall.variables, null, 2)} />
        </Show>
      </PromptAccordionItem>

      <PromptAccordionItem
        value="messages"
        label="Rendered messages"
        hint={hasMessages() ? 'what actually went to the LLM' : 'not captured'}
      >
        <Show
          when={hasMessages()}
          fallback={
            <div text="xs dark-text-tertiary">
              HTTP request body not captured by the BAML collector.
            </div>
          }
        >
          <ParsedPromptView rawInput={props.llmCall.rawInput!} />
        </Show>
      </PromptAccordionItem>
    </Accordion.Root>
  )
}

export const LLMCallTabs = (props: { llmCall: LLMCallData }) => {
  /** What the model actually said, before BAML coerced it into a value. */
  const rawOutput = () => (props.llmCall.rawOutput?.trim() ? props.llmCall.rawOutput : undefined)
  const parsedText = () =>
    props.llmCall.parsedOutput == null
      ? undefined
      : typeof props.llmCall.parsedOutput === 'string'
        ? props.llmCall.parsedOutput
        : JSON.stringify(props.llmCall.parsedOutput, null, 2)

  /**
   * A response the model produced that BAML could NOT turn into a value — the
   * shape of every parse failure (`BamlValidationError`, a truncated
   * `tool_args`, a controller that answered in prose). `rawOutput` is then the
   * only record of what was said, so the tabs open on it: this panel used to
   * render "Output not captured" over a response that had been captured all
   * along, which is why a recurring class of failure was undebuggable from the
   * UI (#225 owner review).
   */
  const unparsed = () => parsedText() === undefined && rawOutput() !== undefined

  const [activeTab, setActiveTab] = createSignal<LLMTab>(unparsed() ? 'output' : 'prompt')

  return (
    <div border="b dark-border-primary" m="b-4" p="b-4">
      {/* Usage stats bar */}
      <UsageStats llmCall={props.llmCall} />

      {/* Tab buttons */}
      <div flex="~ wrap" gap="2" m="b-3">
        <TabButton
          active={activeTab() === 'prompt'}
          label="Prompt"
          onClick={() => setActiveTab('prompt')}
        />
        <TabButton
          active={activeTab() === 'output'}
          label="Output"
          onClick={() => setActiveTab('output')}
        />
      </div>

      {/* Tab content */}
      <Switch>
        <Match when={activeTab() === 'prompt'}>
          <PromptAccordion llmCall={props.llmCall} />
        </Match>
        <Match when={activeTab() === 'output'}>
          {/* Both blocks, each only when captured. Parsed leads when it
              exists (it is what the harness acted on); on a parse failure
              there is no parsed value and the raw response is the whole tab. */}
          <Show
            when={parsedText() !== undefined || rawOutput() !== undefined}
            fallback={<CodeBlock content={undefined} placeholder="Output not captured" />}
          >
            <div flex="~ col" gap="3">
              <Show when={parsedText() !== undefined}>
                <div>
                  <div text="xs dark-text-tertiary" m="b-1">
                    Parsed output
                  </div>
                  <CodeBlock content={parsedText()} />
                </div>
              </Show>
              <Show when={rawOutput() !== undefined}>
                <div>
                  <div text={`xs ${unparsed() ? 'amber-400' : 'dark-text-tertiary'}`} m="b-1">
                    {unparsed() ? 'Raw response — BAML could not parse this' : 'Raw response'}
                  </div>
                  <CodeBlock content={rawOutput()} />
                </div>
              </Show>
            </div>
          </Show>
        </Match>
      </Switch>
    </div>
  )
}
