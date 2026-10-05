import { ScrollArea } from '@ark-ui/solid/scroll-area'
import { For, Show, Switch, Match, createEffect, createSignal, type JSX } from 'solid-js'
import type { ToolCallInfo } from './types'
import { ToolCallDisplay } from './ToolCallDisplay'
import { marked } from 'marked'
import type { RetrievalReference } from '@hames-ai/harness-patterns'
import type { OpenReferenceTarget } from '@hames-ai/agents'
import { sanitizeMarkdownHtml } from '~/lib/sanitize-html'

// Rendering options only — marked passes raw HTML in the source through
// untouched, so its output is sanitized downstream (see ~/lib/sanitize-html).
marked.setOptions({
  breaks: true, // Convert \n to <br>
  gfm: true, // GitHub Flavored Markdown
})

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'error' | 'warning'
  content: string
  timestamp: Date
  toolCall?: ToolCallInfo // Single tool call (not array)
  /** User-facing hint for error/warning messages */
  hint?: string
  /** Pattern that produced this error/warning */
  patternId?: string
  /** Turn/iteration context string, e.g. "(turn 3, attempt 2)" */
  turnInfo?: string
  /** Retriever citations for this turn (inline superscripts + sources footer). */
  references?: RetrievalReference[]
}

interface ChatMessagesProps {
  messages: Message[]
  onApproveWrite?: (messageId: string) => void
  onRejectWrite?: (messageId: string) => void
  /** Map of entity/relation names → graph element IDs */
  graphEntityNames?: Map<string, string[]>
  /** Callback to highlight graph element IDs (hover/click) */
  onHighlightEntities?: (ids: string[]) => void
  /** Open the inline file viewer for a cited reference (click on a citation). */
  onOpenReference?: (target: OpenReferenceTarget) => void
  /** Optional slot rendered after the last message, inside the scroll area —
   *  used by ChatInterface to inline the live progress bar where the next
   *  assistant bubble would appear. */
  trailing?: () => JSX.Element
  /** What the empty state says. Undefined while the agent list is still in
   *  flight (and in any caller that has no agent), which is why the generic
   *  pair below stays as the fallback rather than being replaced. The copy is
   *  the AGENT's — `AgentConfig.welcome` — so it is one greeting per agent
   *  rather than one for the whole app. */
  welcome?: { title: string; body: string }
}

// ============================================================================
// Entity Highlighting in Markdown
// ============================================================================

/** Tracks which entity names have been toggled on (click to persist highlight) */
const toggledEntities = new Set<string>()

/**
 * Wrap every whole-word, case-insensitive mention of one of `names` in the
 * prose of `root`: the inert, already-sanitized DOM {@link renderAssistantMarkdown}
 * hands the sanitizer's `annotate` pass. Text inside `code` and `pre` is left
 * alone. Names are tried longest first, so a longer name wins over a prefix
 * of it. `wrap` gets the name as written in `names` and the text it matched.
 *
 * This only ever splits text nodes and inserts elements `wrap` builds with
 * `createElement`/`setAttribute`. It never reads or writes an HTML string, so
 * an attribute value stays an attribute value whatever it holds (#428), and
 * nothing it sets needs escaping. It matches the text the reader sees, so a
 * name cannot match inside `&lt;` and a name containing `&` is found.
 */
function wrapMentions(
  root: Element,
  names: string[],
  wrap: (name: string, match: string, doc: Document) => Element,
): void {
  const byLowerCase = new Map<string, string>()
  for (const name of names)
    if (!byLowerCase.has(name.toLowerCase())) byLowerCase.set(name.toLowerCase(), name)
  const escaped = [...names]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi')

  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    (node) =>
      node.nodeType === Node.TEXT_NODE
        ? NodeFilter.FILTER_ACCEPT
        : node.nodeName === 'CODE' || node.nodeName === 'PRE'
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP,
  )
  // Collected first: replacing a node mid-walk would move the walker.
  const texts: Text[] = []
  while (walker.nextNode()) texts.push(walker.currentNode as Text)

  for (const text of texts) {
    const parts: Array<string | Node> = []
    let last = 0
    for (const match of text.data.matchAll(pattern)) {
      // The `i` flag folds a few letters `toLowerCase` keeps apart (final
      // sigma), so a match can miss the lookup. It stays text, as it did.
      const name = byLowerCase.get(match[0].toLowerCase())
      if (name === undefined) continue
      parts.push(text.data.slice(last, match.index), wrap(name, match[0], doc))
      last = match.index + match[0].length
    }
    if (parts.length === 0) continue
    parts.push(text.data.slice(last))
    text.replaceWith(...parts)
  }
}

/**
 * Wrap known entity/relation names in interactive spans (hover highlights the
 * graph, click pins it). Names of 2+ characters only, to avoid noise.
 */
function annotateEntities(root: Element, entityNames: Map<string, string[]>): void {
  const names = [...entityNames.keys()].filter((n) => n.length >= 2)
  if (names.length === 0) return
  wrapMentions(root, names, (name, match, doc) => {
    const span = doc.createElement('span')
    span.setAttribute('class', toggledEntities.has(name) ? 'graph-entity toggled' : 'graph-entity')
    span.setAttribute('data-entity-name', name)
    span.setAttribute('data-entity-ids', entityNames.get(name)!.join(','))
    span.setAttribute('title', 'Click to pin highlight')
    span.textContent = match
    return span
  })
}

/**
 * Wrap retriever-cited filename mentions in a clickable `.doc-ref` span plus a
 * superscript open-in-new glyph. The click opens the inline file viewer.
 */
function annotateReferences(root: Element, references: RetrievalReference[]): void {
  // filename → docId (first reference for that file)
  const byName = new Map<string, string>()
  for (const r of references) if (r.source && !byName.has(r.source)) byName.set(r.source, r.docId)
  const names = [...byName.keys()].filter((n) => n.length >= 3)
  if (names.length === 0) return
  wrapMentions(root, names, (name, match, doc) => {
    const span = doc.createElement('span')
    span.setAttribute('class', 'doc-ref')
    span.setAttribute('data-doc-id', byName.get(name)!)
    span.setAttribute('title', `Open ${name} in viewer`)
    // The mark is an empty <sup> carrying an icon utility class — the
    // `.doc-ref-mark` preflight gives it the `inline-block` an icon needs, and
    // its `color` is what the mask paints with. It used to be a "↗"
    // character. Both classes are literals here, so UnoCSS extracts them even
    // though the element is built at runtime.
    const mark = doc.createElement('sup')
    mark.setAttribute('class', 'doc-ref-mark i-material-symbols-arrow-outward')
    mark.setAttribute('aria-hidden', 'true')
    span.append(match, mark)
    return span
  })
}

/** Unique references by document (one footer chip per cited file). */
function dedupeReferencesByDoc(references: RetrievalReference[]): RetrievalReference[] {
  return [...new Map(references.map((r) => [r.docId, r])).values()]
}

/**
 * Render an assistant message to the HTML handed to `innerHTML`.
 *
 * The annotators run INSIDE the sanitizer, as its `annotate` pass: on the inert
 * DOM DOMPurify returns, after the model's own markup has been stripped and
 * before the image pass and the single serialization. Nothing touches the
 * string `sanitizeMarkdownHtml` returns, so the sanitizer's output is what
 * `innerHTML` parses. They used to run on that string, splitting it with a
 * regex, and a `>` left raw inside an attribute value turned the attribute's
 * tail back into live markup (#428).
 *
 * The other way to give the sanitizer the last word is to annotate BEFORE it.
 * That is the wrong one here. Running after DOMPurify is what makes the
 * citations trustworthy (SA-M10): DOMPurify strips `class` down to an
 * allowlist and drops the `data-*` hooks entirely, so a `doc-ref` span in
 * *model output* cannot reach the DOM. Annotating first would need those hooks
 * let through for the model too. In this order, every interactive span the
 * click handlers below respond to was built by one of these two annotators,
 * from typed reference data, and the image pass still runs after them.
 */
export function renderAssistantMarkdown(
  content: string,
  entityNames: Map<string, string[]>,
  references: RetrievalReference[],
): string {
  return sanitizeMarkdownHtml(marked.parse(content ?? '') as string, (root) => {
    annotateEntities(root, entityNames)
    annotateReferences(root, references)
  })
}

export const ChatMessages = (props: ChatMessagesProps) => {
  let bottomRef: HTMLDivElement | undefined
  let messagesContainerRef: HTMLDivElement | undefined
  const [prevCount, setPrevCount] = createSignal(0)

  // Auto-scroll ONLY when new messages are added (not on content updates)
  createEffect(() => {
    const currentCount = props.messages.length

    // Only scroll if message count increased (new message added)
    if (currentCount > prevCount() && bottomRef) {
      setTimeout(() => {
        bottomRef?.scrollIntoView({ behavior: 'smooth', block: 'end' })
      }, 50)
    }

    setPrevCount(currentCount)
  })

  // Event delegation for entity hover/click on the messages container
  const handleMouseOver = (e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest('.graph-entity') as HTMLElement | null
    if (!target || !props.onHighlightEntities) return
    const ids = target.dataset.entityIds?.split(',') ?? []
    // Combine with any toggled entities
    const allToggled = getAllToggledIds(props.graphEntityNames)
    props.onHighlightEntities([...new Set([...ids, ...allToggled])])
  }

  const handleMouseOut = (e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest('.graph-entity') as HTMLElement | null
    if (!target || !props.onHighlightEntities) return
    // Restore to only toggled entities
    const allToggled = getAllToggledIds(props.graphEntityNames)
    props.onHighlightEntities(allToggled)
  }

  const handleClick = (e: MouseEvent) => {
    // Reference citation (inline superscript) → open the inline file viewer.
    const refTarget = (e.target as HTMLElement).closest('.doc-ref') as HTMLElement | null
    if (refTarget) {
      const docId = refTarget.dataset.docId
      if (docId) props.onOpenReference?.({ docId })
      return
    }

    const target = (e.target as HTMLElement).closest('.graph-entity') as HTMLElement | null
    if (!target) return
    const name = target.dataset.entityName
    if (!name) return

    // Toggle
    if (toggledEntities.has(name)) {
      toggledEntities.delete(name)
      target.classList.remove('toggled')
    } else {
      toggledEntities.add(name)
      target.classList.add('toggled')
    }

    // Also update all other spans with the same entity name
    messagesContainerRef
      ?.querySelectorAll(`.graph-entity[data-entity-name="${name}"]`)
      .forEach((el) => {
        el.classList.toggle('toggled', toggledEntities.has(name))
      })

    // Update highlights
    if (props.onHighlightEntities) {
      const allToggled = getAllToggledIds(props.graphEntityNames)
      props.onHighlightEntities(allToggled)
    }
  }

  const getInitials = (role: string) => {
    if (role === 'user') return 'U'
    if (role === 'error' || role === 'warning') return '!'
    return 'AI'
  }

  /** Render assistant message with entity + reference annotation */
  const renderAssistantContent = (content: string, references: RetrievalReference[]) =>
    renderAssistantMarkdown(content, props.graphEntityNames ?? new Map(), references)

  return (
    <ScrollArea.Root style={{ flex: 1, overflow: 'hidden', 'min-height': 0 }}>
      <ScrollArea.Viewport style={{ height: '100%' }}>
        <ScrollArea.Content
          ref={messagesContainerRef}
          p="4"
          space="y-4"
          onMouseOver={handleMouseOver}
          onMouseOut={handleMouseOut}
          onClick={handleClick}
        >
          <For each={props.messages}>
            {(message) => (
              <div flex="~ col" gap="2">
                {/* Message Bubble */}
                <div
                  flex="~"
                  gap="3"
                  data-role={message.role}
                  class={message.role === 'user' ? 'flex-row-reverse' : ''}
                >
                  {/* Avatar */}
                  <div
                    flex="~ shrink-0"
                    w="8"
                    h="8"
                    rounded="full"
                    items="center"
                    justify="center"
                    text={
                      // The three coloured avatars are solid in both themes,
                      // so white reads on all of them. The assistant's ground
                      // is the theme's own, and white on it disappears the
                      // moment the theme turns light.
                      message.role === 'user' ||
                      message.role === 'error' ||
                      message.role === 'warning'
                        ? 'white xs'
                        : 'ui-text-primary xs'
                    }
                    font="medium"
                    bg={
                      message.role === 'user'
                        ? 'cyber-700'
                        : message.role === 'error'
                          ? 'red-900/50'
                          : message.role === 'warning'
                            ? 'amber-900/50'
                            : 'ui-bg-tertiary'
                    }
                    border={
                      message.role === 'user'
                        ? '1 cyber-500'
                        : message.role === 'error'
                          ? '1 red-500/50'
                          : message.role === 'warning'
                            ? '1 amber-500/50'
                            : '1 ui-accent/50'
                    }
                    shadow={
                      message.role === 'user'
                        ? '[0_0_10px_rgba(79,70,229,0.3)]'
                        : message.role === 'error'
                          ? '[0_0_10px_rgba(239,68,68,0.2)]'
                          : message.role === 'warning'
                            ? '[0_0_10px_rgba(245,158,11,0.2)]'
                            : '[0_0_10px_rgba(0,255,255,0.2)]'
                    }
                  >
                    {getInitials(message.role)}
                  </div>

                  {/* Message Content */}
                  <div
                    max-w="2xl"
                    p="3"
                    rounded="lg"
                    bg={
                      message.role === 'user'
                        ? 'cyber-800/50'
                        : message.role === 'error'
                          ? 'red-900/20'
                          : message.role === 'warning'
                            ? 'amber-900/20'
                            : 'ui-bg-tertiary'
                    }
                    text="ui-text-primary"
                    border={
                      message.role === 'user'
                        ? '1 cyber-700/50'
                        : message.role === 'error'
                          ? '1 red-500/30'
                          : message.role === 'warning'
                            ? '1 amber-500/30'
                            : '1 ui-border-secondary'
                    }
                    backdrop-blur="sm"
                  >
                    <Switch
                      fallback={
                        <div text="sm" white-space="pre-wrap" break-words>
                          {message.content}
                        </div>
                      }
                    >
                      <Match when={message.role === 'assistant'}>
                        {/* No <think> extraction here (SA-L10). It was a local-GLM
                    leftover: a leading `<think>…</think>` was peeled off the
                    answer and shown as a collapsed reasoning block. The
                    Anthropic clients this app now routes through never expose
                    their trace (empty string + signature, see CLAUDE.md), so
                    the only strings that pattern can still match are answers
                    that legitimately open with those literal characters —
                    which it would silently hide. */}
                        <div
                          text="sm"
                          class="prose-chat"
                          // eslint-disable-next-line solid/no-innerhtml
                          innerHTML={renderAssistantContent(
                            message.content,
                            message.references ?? [],
                          )}
                        />
                        {/* Sources footer — one chip per cited file; opens
                    the inline file viewer (navigator pages chunks). */}
                        <Show when={message.references && message.references.length > 0}>
                          <div class="doc-ref-footer">
                            <span text="xs ui-text-tertiary">Sources:</span>
                            <For each={dedupeReferencesByDoc(message.references!)}>
                              {(r) => (
                                <button
                                  class="doc-ref-chip"
                                  title={`Open ${r.source} in viewer`}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    props.onOpenReference?.({ docId: r.docId })
                                  }}
                                >
                                  <span
                                    class="i-material-symbols-description-outline"
                                    w="[11px]"
                                    h="[11px]"
                                    aria-hidden="true"
                                  />
                                  {r.source}
                                </button>
                              )}
                            </For>
                          </div>
                        </Show>
                      </Match>
                      <Match when={message.role === 'error' || message.role === 'warning'}>
                        <div flex="~ col" gap="1">
                          <div flex="~ items-center" gap="1.5">
                            <span
                              class={
                                message.role === 'error'
                                  ? 'i-material-symbols-error'
                                  : 'i-material-symbols-warning'
                              }
                              style={{
                                width: '16px',
                                height: '16px',
                                'flex-shrink': '0',
                                color: message.role === 'error' ? '#ef4444' : '#f59e0b',
                              }}
                            />
                            <span
                              text="sm"
                              font="medium"
                              style={{ color: message.role === 'error' ? '#ef4444' : '#f59e0b' }}
                            >
                              {message.role === 'error' ? 'Error' : 'Warning'}
                              {message.patternId ? ` in ${message.patternId}` : ''}
                              {message.turnInfo ? ` ${message.turnInfo}` : ''}
                            </span>
                          </div>
                          <div text="sm" white-space="pre-wrap" break-words>
                            {message.content}
                          </div>
                          <Show when={message.hint}>
                            <div
                              text="xs"
                              p="2"
                              m="t-1"
                              rounded="md"
                              bg={message.role === 'error' ? 'red-900/20' : 'amber-900/20'}
                              border={message.role === 'error' ? '1 red-500/30' : '1 amber-500/30'}
                              flex="~ items-center"
                              gap="1.5"
                            >
                              <span
                                class="i-material-symbols-lightbulb-outline"
                                style={{
                                  width: '14px',
                                  height: '14px',
                                  'flex-shrink': '0',
                                  color: '#a3a3a3',
                                }}
                              />
                              <span text="ui-text-secondary">{message.hint}</span>
                            </div>
                          </Show>
                        </div>
                      </Match>
                    </Switch>

                    {/* `data-testid` so the browser suite's screenshot
                        comparison can take it OUT of the page before the shot
                        (`e2e-browser/lib/surfaces.ts#hideVolatile`): a wall-clock
                        time differs between two otherwise identical runs, and a
                        baseline that diffed on the minute hand would be
                        re-recorded until nobody looked at it. Removed rather
                        than masked — a mask paints over an element and leaves it
                        in the flow, so a varying WIDTH still moves everything
                        beside it. */}
                    <div data-testid="message-time" text="xs ui-text-tertiary" m="t-1">
                      {message.timestamp.toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  </div>
                </div>

                {/* Tool Call - SEPARATE from message bubble */}
                <Show when={message.toolCall && message.role === 'assistant'}>
                  <div m="l-11">
                    <ToolCallDisplay
                      toolCall={message.toolCall!}
                      onApprove={() => props.onApproveWrite?.(message.id)}
                      onReject={() => props.onRejectWrite?.(message.id)}
                    />
                  </div>
                </Show>
              </div>
            )}
          </For>

          {/* Empty State */}
          <Show when={props.messages.length === 0}>
            <div flex="~" items="center" justify="center" h="full" min-h="64" text="center">
              <div>
                <div text="2xl ui-accent/50" m="b-2">
                  <svg
                    width="64"
                    height="64"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    style={{ margin: '0 auto' }}
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                    />
                  </svg>
                </div>
                <div text="lg ui-text-secondary" font="medium">
                  {props.welcome?.title ?? 'Start a conversation'}
                </div>
                <div text="sm ui-text-tertiary" m="t-1" max-w="md">
                  {props.welcome?.body ?? 'Type a message below to begin'}
                </div>
              </div>
            </div>
          </Show>

          {/* Trailing slot — e.g. the live progress bar, rendered where the
              next assistant bubble would appear. */}
          <Show when={props.trailing}>{(slot) => slot()()}</Show>

          {/* Sentinel element for auto-scroll */}
          <div ref={bottomRef} />
        </ScrollArea.Content>
      </ScrollArea.Viewport>

      <ScrollArea.Scrollbar orientation="vertical" w="2" bg="ui-bg-tertiary">
        <ScrollArea.Thumb bg="cyber-700/50 hover:cyber-600/70" rounded="full" transition="colors" />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  )
}

// ============================================================================
// Helpers
// ============================================================================

/** Collect all graph element IDs for currently toggled entity names */
function getAllToggledIds(entityNames?: Map<string, string[]>): string[] {
  if (!entityNames) return []
  const ids: string[] = []
  for (const name of toggledEntities) {
    const entityIds = entityNames.get(name)
    if (entityIds) ids.push(...entityIds)
  }
  return [...new Set(ids)]
}
