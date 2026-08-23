import { ScrollArea } from '@ark-ui/solid/scroll-area'
import { For, Show, Switch, Match, createEffect, createSignal, type JSX } from 'solid-js'
import type { ElementDefinition } from 'cytoscape'
import type { ToolCallInfo } from './types'
import { ToolCallDisplay } from './ToolCallDisplay'
import { marked } from 'marked'
import type { RetrievalReference } from '~/lib/harness-patterns'
import type { OpenReferenceTarget } from '~/lib/harness-client/reference-extractor'
import { escapeHtmlAttribute, sanitizeMarkdownHtml } from '~/lib/sanitize-html'

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
  graphData?: ElementDefinition[]
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
}

// ============================================================================
// Entity Highlighting in Markdown
// ============================================================================

/** Tracks which entity names have been toggled on (click to persist highlight) */
const toggledEntities = new Set<string>()

/**
 * Post-process rendered markdown HTML to wrap known entity/relation names
 * in interactive spans. Matches are case-insensitive, whole-word.
 * Avoids matching inside HTML tags or code blocks.
 */
function annotateEntities(html: string, entityNames: Map<string, string[]>): string {
  if (!entityNames || entityNames.size === 0) return html

  // Sort names by length (longest first) to avoid partial matches
  const names = [...entityNames.keys()].sort((a, b) => b.length - a.length)
  // Only match names with 2+ chars to avoid noise
  const filteredNames = names.filter((n) => n.length >= 2)
  if (filteredNames.length === 0) return html

  // Build regex that matches any entity name as a whole word
  const escaped = filteredNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi')

  // Split HTML into tag vs text segments to avoid matching inside tags
  const segments = html.split(/(<[^>]+>)/g)
  let inCode = false

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]

    // Track code block boundaries
    if (seg.startsWith('<code') || seg.startsWith('<pre')) inCode = true
    if (seg === '</code>' || seg === '</pre>') {
      inCode = false
      continue
    }

    // Skip HTML tags and code content
    if (seg.startsWith('<') || inCode) continue

    // Replace entity names in text segments
    segments[i] = seg.replace(pattern, (match) => {
      // Find the canonical name (case-insensitive lookup)
      const key = [...entityNames.keys()].find((k) => k.toLowerCase() === match.toLowerCase())
      if (!key) return match
      const ids = entityNames.get(key)!
      // Entity names and ids come from tool results — escape them so a quote
      // in a name cannot terminate the attribute it is interpolated into.
      const idsAttr = escapeHtmlAttribute(ids.join(','))
      const nameAttr = escapeHtmlAttribute(key)
      const isToggled = toggledEntities.has(key)
      return `<span class="graph-entity${isToggled ? ' toggled' : ''}" data-entity-name="${nameAttr}" data-entity-ids="${idsAttr}" title="Click to pin highlight">${match}</span>`
    })
  }

  return segments.join('')
}

/**
 * Wrap retriever-cited filename mentions in the rendered markdown with a
 * clickable `.doc-ref` span + a "↗" superscript (mirrors {@link annotateEntities}).
 * Skips HTML tags and code blocks. The click opens the inline file viewer.
 */
function annotateReferences(html: string, references: RetrievalReference[]): string {
  if (!references || references.length === 0) return html
  // filename → docId (first reference for that file)
  const byName = new Map<string, string>()
  for (const r of references) if (r.source && !byName.has(r.source)) byName.set(r.source, r.docId)
  const names = [...byName.keys()].filter((n) => n.length >= 3).sort((a, b) => b.length - a.length)
  if (names.length === 0) return html

  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi')

  const segments = html.split(/(<[^>]+>)/g)
  let inCode = false
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg.startsWith('<code') || seg.startsWith('<pre')) inCode = true
    if (seg === '</code>' || seg === '</pre>') {
      inCode = false
      continue
    }
    if (seg.startsWith('<') || inCode) continue

    segments[i] = seg.replace(pattern, (match) => {
      const key = [...byName.keys()].find((k) => k.toLowerCase() === match.toLowerCase())
      if (!key) return match
      // Filenames and document ids are user/tool supplied — escape them so a
      // quote in a filename cannot terminate the attribute it lands in.
      const docId = escapeHtmlAttribute(byName.get(key)!)
      return `<span class="doc-ref" data-doc-id="${docId}" title="Open ${escapeHtmlAttribute(key)} in viewer">${match}<sup class="doc-ref-mark">↗</sup></span>`
    })
  }

  return segments.join('')
}

/** Unique references by document (one footer chip per cited file). */
function dedupeReferencesByDoc(references: RetrievalReference[]): RetrievalReference[] {
  return [...new Map(references.map((r) => [r.docId, r])).values()]
}

/**
 * Render an assistant message to the HTML handed to `innerHTML`.
 *
 * Order matters: marked's output is sanitized FIRST, then annotated. The
 * annotators emit their own `.graph-entity` / `.doc-ref` spans, so running
 * them after sanitization keeps that code-generated markup intact; the values
 * they interpolate are individually escaped instead (see the annotators
 * above). Sanitizing last would have to allow those spans back in anyway,
 * and would re-parse markup we just produced.
 *
 * This order is also what makes the citations trustworthy (SA-M10):
 * `sanitizeMarkdownHtml` strips `class` down to an allowlist and drops the
 * `data-*` hooks entirely, so a `doc-ref` span in *model output* cannot reach
 * the DOM. Every interactive span the click handlers below respond to was put
 * there by one of these two annotators, from typed reference data.
 */
export function renderAssistantMarkdown(
  content: string,
  entityNames: Map<string, string[]>,
  references: RetrievalReference[],
): string {
  const html = sanitizeMarkdownHtml(marked.parse(content ?? '') as string)
  return annotateReferences(annotateEntities(html, entityNames), references)
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
                    text="white xs"
                    font="medium"
                    bg={
                      message.role === 'user'
                        ? 'cyber-700'
                        : message.role === 'error'
                          ? 'red-900/50'
                          : message.role === 'warning'
                            ? 'amber-900/50'
                            : 'dark-bg-tertiary'
                    }
                    border={
                      message.role === 'user'
                        ? '1 cyber-500'
                        : message.role === 'error'
                          ? '1 red-500/50'
                          : message.role === 'warning'
                            ? '1 amber-500/50'
                            : '1 neon-cyan/50'
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
                            : 'dark-bg-tertiary'
                    }
                    text="dark-text-primary"
                    border={
                      message.role === 'user'
                        ? '1 cyber-700/50'
                        : message.role === 'error'
                          ? '1 red-500/30'
                          : message.role === 'warning'
                            ? '1 amber-500/30'
                            : '1 dark-border-secondary'
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
                            <span text="xs dark-text-tertiary">Sources:</span>
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
                              <span text="dark-text-secondary">{message.hint}</span>
                            </div>
                          </Show>
                        </div>
                      </Match>
                    </Switch>

                    <div text="xs dark-text-tertiary" m="t-1">
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
                <div text="2xl neon-cyan/50" m="b-2">
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
                <div text="lg dark-text-secondary" font="medium">
                  Start a conversation
                </div>
                <div text="sm dark-text-tertiary" m="t-1">
                  Type a message below to begin
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

      <ScrollArea.Scrollbar orientation="vertical" w="2" bg="dark-bg-tertiary">
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
