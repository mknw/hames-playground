import { ScrollArea } from '@ark-ui/solid/scroll-area'
import {
  For,
  Show,
  Switch,
  Match,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
} from 'solid-js'
import type { ToolCallInfo } from './types'
import { ToolCallDisplay } from './ToolCallDisplay'
import { marked, Tokenizer } from 'marked'
import type { RetrievalReference } from '@hames-ai/harness-patterns'
import type { OpenReferenceTarget } from '@hames-ai/agents'
import { sanitizeMarkdownHtml } from '~/lib/sanitize-html'
import { annotateLinkVerdicts, type RecognisedLinkHosts } from '~/lib/link-verdicts'
import { createLinkAcceptanceStore, type LinkAcceptanceStore } from '~/lib/link-acceptance'
import { Menu } from '@ark-ui/solid/menu'
import { HitlDialog } from './HitlDialog'

// Rendering options only — marked passes raw HTML in the source through
// untouched, so its output is sanitized downstream (see ~/lib/sanitize-html).
marked.setOptions({
  breaks: true, // Convert \n to <br>
  gfm: true, // GitHub Flavored Markdown
})

/**
 * CommonMark ends a link destination at the first space, so a model writing
 * `[report](https://host/My Report (1).pdf)` — a filename taken verbatim from a
 * tool result — renders as literal text with a stray autolink. This rewrites
 * ONLY that shape: an http(s) destination with an unescaped space, scanned to the
 * balancing `)`, gets its spaces written as `%20`. Nothing is ever decoded; any
 * existing `%xx` stays as the source wrote it. Everything else — the default
 * tokenizer already accepting the link, a non-http(s) scheme (so `javascript:`
 * is untouched), a trailing quoted title, a destination the default tokenizer
 * will not read once encoded (a line break), no closing paren — returns false
 * and the default tokenizer runs exactly as before.
 *
 * Both scans are bounded, because the lexer calls this at every `[` and `(` of
 * untrusted text and the default tokenizer it falls back to is a bounded regex:
 * an unbounded walk to the end of the paragraph made `[` × 32 000 quadratic.
 * The label stops at CommonMark's own 999-character limit and the destination
 * at `MAX_SPACED_DESTINATION` characters. Past either bound the default
 * tokenizer decides, as it always did.
 *
 * Images (`![`) take the same path; the sanitizer still decides what an `<img>`
 * may load. The href reaches the DOM through the sanitizer, which owns
 * `target="_blank"` and `rel="noopener noreferrer"`.
 */
const MAX_LINK_LABEL = 999
const MAX_SPACED_DESTINATION = 2048

function linkWithSpaces(this: Tokenizer, src: string) {
  if (Tokenizer.prototype.link.call(this, src)) return false
  const open = src.startsWith('![') ? 2 : src.startsWith('[') ? 1 : -1
  if (open < 0) return false
  // Everything the label scan may read, so no step can run past the bound.
  const head = src.slice(0, open + MAX_LINK_LABEL + 1)
  let i = open
  for (let depth = 1; depth > 0; i++) {
    const ch = head[i]
    if (ch === undefined) return false
    if (ch === '`') {
      // A code span in the label may hold a `]`: skip to its matching run.
      const run = /^`+/.exec(head.slice(i))![0]
      const close = head.indexOf(run, i + run.length)
      if (close < 0) return false
      i = close + run.length - 1
      continue
    }
    if (ch === '\\') i++
    else if (ch === '[') depth++
    else if (ch === ']') depth--
  }
  if (src[i] !== '(' || !/^https?:\/\//i.test(src.slice(i + 1, i + 9))) return false
  const start = i + 1
  // One past the cap, so the closing `)` may sit right after a destination of exactly MAX characters.
  const limit = Math.min(src.length, start + MAX_SPACED_DESTINATION + 1)
  let end = -1
  for (let j = start, depth = 1; j < limit; j++) {
    const ch = src[j]
    if (ch === '\\') j++
    else if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) {
      end = j
      break
    }
  }
  if (end < 0) return false
  const dest = src.slice(start, end)
  if (!dest.includes(' ') || /\s+(?:"[^"]*"|'[^']*')$/.test(dest.trimEnd())) return false
  const raw = src.slice(0, end + 1)
  const token = Tokenizer.prototype.link.call(
    this,
    raw.slice(0, start) + dest.replaceAll(' ', '%20') + ')',
  )
  // The default must have read the whole rewritten link, and `raw` is what the
  // lexer advances by, so it stays the ORIGINAL length. This and the `end < 0`
  // check back each other up: removing either alone changes no known output.
  if (!token || token.raw.length !== raw.length + (dest.split(' ').length - 1) * 2) return false
  return { ...token, raw }
}
marked.use({ tokenizer: { link: linkWithSpaces } })

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
  /** Server-computed link verdicts (#901 slice 1, ruling Q1): the recognised
   *  hostnames among this message's own http(s) links, filled in where the
   *  content is served (live `done` frame, history load, shared transcript).
   *  Absent = nothing is recognised, so every http(s) link renders unverified —
   *  fail-closed; the tenant host list itself never crosses. */
  recognisedLinkHosts?: RecognisedLinkHosts
}

interface ChatMessagesProps {
  messages: Message[]
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
  /** Session-scoped link acceptance (#901 slice 3): the live mount
   *  (`ChatInterface`) passes one per session; an absent caller (the shared
   *  transcript, tests) gets this component's own fallback, which lives as
   *  long as the component — a page load. Client-side only: nothing
   *  persists, nothing crosses to the server. */
  linkAcceptance?: LinkAcceptanceStore
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
/** One assistant message's render: the HTML for `innerHTML`, plus the
 * per-message unverified-link count the indicator shows (slice 3). The count
 * is a parallel return value — never re-parsed out of `html`, which the
 * sanitizer forbids. */
export interface RenderedAssistantMarkdown {
  html: string
  /** How many http(s) anchors in this message are unverified — unrecognised
   *  and unaccepted. Recognised and non-http(s) anchors are not counted. */
  unverifiedLinks: number
}

export function renderAssistantMarkdown(
  content: string,
  entityNames: Map<string, string[]>,
  references: RetrievalReference[],
  recognisedLinkHosts?: RecognisedLinkHosts,
): RenderedAssistantMarkdown {
  // The link classification's count, threaded out of the annotate callback
  // through a closure: the sanitizer's `annotate` contract is unchanged.
  let unverifiedLinks = 0
  const html = sanitizeMarkdownHtml(marked.parse(content ?? '') as string, (root) => {
    annotateEntities(root, entityNames)
    annotateReferences(root, references)
    // Last of the three: the link verdicts stamp the anchors the others leave
    // behind, and the image pass after the annotate pass keeps the last word.
    unverifiedLinks = annotateLinkVerdicts(root, recognisedLinkHosts)
  })
  return { html, unverifiedLinks }
}

/** The link under review (#901 slice 2): the chosen anchor's own spelling
 *  (slice 1's `data-link-raw` — the defang identity), its resolved destination
 *  (`data-link-dest`, what the dialog shows and opens), and the one message
 *  rendering it lives in. */
interface LinkReviewTarget {
  readonly raw: string
  readonly dest: string
  readonly container: Element
}

/** "Cancel and defang" (#901 slice 2, ruling Q5): replace every anchor in
 *  `container` whose own spelling (`data-link-raw`, the defang identity) is
 *  `raw` with inert text — the anchor's words as a plain text node: no href,
 *  nothing to activate, nothing left in the tab order. Returns how many
 *  anchors were replaced.
 *
 *  This touches the DOM built from `message.content`, never the content
 *  itself. Ruling Q5 as overridden (issue #901 comment 6618793027,
 *  2026-11-04): the dialog's action records a PERSISTED mark on the mount's
 *  acceptance store, and every re-render of the marked message re-derives
 *  this defang from the mark — so the link does not come back with the next
 *  rendering. Still scoped to `container` (one message's rendering), which
 *  keeps "the chosen link in this message" from reaching the same address in
 *  another message, and still client-side: a reload (a fresh store) starts
 *  empty. */
export function defangAnchors(container: Element, raw: string): number {
  let replaced = 0
  for (const anchor of Array.from(container.querySelectorAll('a[data-link-raw]'))) {
    if (anchor.getAttribute('data-link-raw') !== raw) continue
    anchor.replaceWith(document.createTextNode(anchor.textContent ?? ''))
    replaced++
  }
  return replaced
}

export const ChatMessages = (props: ChatMessagesProps) => {
  let bottomRef: HTMLDivElement | undefined
  let messagesContainerRef: HTMLDivElement | undefined
  const [prevCount, setPrevCount] = createSignal(0)
  // The link review under way (#901 slice 2). Client-only state: nothing here
  // crosses to the server, and nothing survives a reload.
  const [reviewTarget, setReviewTarget] = createSignal<LinkReviewTarget | null>(null)
  // Session-scoped "Accept as safe" (#901 slice 3): the passed store is the
  // live mount's, recreated per session by `ChatInterface`; the fallback is
  // this instance's own, so the shared transcript gets one per page load.
  // Either way nothing persists and nothing crosses to the server.
  const ownAcceptance = createLinkAcceptanceStore()
  const linkAcceptance = () => props.linkAcceptance ?? ownAcceptance
  // A defang (slice 2) replaces an anchor with inert text in the CURRENT
  // rendering — no signal fires, so this tick re-runs whatever derives from
  // the rendered DOM: the indicator's count and the Accept-as-safe list.
  const [defangTick, setDefangTick] = createSignal(0)
  // The polite announcement of an acceptance-state change (slice 3), read by
  // the live region below. Only an acceptance writes it.
  const [acceptanceAnnouncement, setAcceptanceAnnouncement] = createSignal('')

  // A link slice 1 stamped `data-link-review="unverified"` never navigates on
  // its own: primary, keyboard and auxiliary activation open the review
  // dialog instead, and the dialog's "Open in another tab" is the reviewed,
  // intended path (#901, approved Q8). Context-menu, drag and address-bar
  // entry stay outside a click handler's reach — the accepted limitation the
  // design names, which the dialog's copy never promises away.
  const interceptLinkReview = (e: MouseEvent): boolean => {
    const anchor = (e.target as HTMLElement).closest('a[data-link-review="unverified"]')
    if (!anchor) return false
    const raw = anchor.getAttribute('data-link-raw')
    const dest = anchor.getAttribute('data-link-dest')
    const container = anchor.closest('.prose-chat')
    // Accepted for this session (#901 slice 3): the anchor navigates exactly
    // as a recognised one does — no dialog, no preventDefault. The STORE
    // decides, never the stamp: slice 1's `data-link-*` stay on the anchor
    // through every re-render, so the sanitizer's string and the stamps are
    // untouched, and a reload reviews the link again. A link this handler
    // cannot key (missing id/dest) cannot prove acceptance and falls through
    // to the fail-closed branch below.
    const messageId = container?.getAttribute('data-message-id') ?? null
    if (messageId !== null && dest !== null && linkAcceptance().isAccepted(messageId, dest)) {
      return false
    }
    // Even a stamped link this handler cannot review (missing stamps, no
    // container) navigates nowhere: fail-closed, the same direction slice 1
    // chose for the verdicts.
    e.preventDefault()
    e.stopPropagation()
    if (raw !== null && dest !== null && container) {
      setReviewTarget({ raw, dest, container })
    }
    return true
  }

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
    // The link review takes the click before anything else (#901 slice 2): an
    // anchor can wrap an entity or citation span, and the navigation is what
    // is being gated.
    if (interceptLinkReview(e)) return

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
  const renderAssistantContent = (message: Message) =>
    renderAssistantMarkdown(
      message.content,
      props.graphEntityNames ?? new Map(),
      message.references ?? [],
      message.recognisedLinkHosts,
    )

  return (
    <>
      <ScrollArea.Root style={{ flex: 1, overflow: 'hidden', 'min-height': 0 }}>
        <ScrollArea.Viewport style={{ height: '100%' }}>
          <ScrollArea.Content
            ref={messagesContainerRef}
            p="4"
            space="y-4"
            onMouseOver={handleMouseOver}
            onMouseOut={handleMouseOut}
            onClick={handleClick}
            on:auxclick={(e: MouseEvent) => {
              interceptLinkReview(e)
            }}
          >
            <For each={props.messages}>
              {(message) => {
                // This message's rendered prose. The strip below derives from
                // the DOM inside it; the ref is assigned during render, before
                // the strip's expressions evaluate, and re-assigned with every
                // re-render (the callback re-runs with the new message object).
                let prose: HTMLDivElement | undefined

                // The rendered assistant content, memoized per message so the
                // innerHTML expression and the mark re-derivation below track
                // the one computation.
                const rendered = createMemo(() => renderAssistantContent(message))

                /** The message's currently-rendered unverified links — slice
                 *  1's stamps read back from the LIVE rendering, deduped by
                 *  resolved destination: two anchors spelling one address are
                 *  one link to review. Re-reads on a defang (the tick) and on
                 *  every re-render. Never counts what the image pass blocked —
                 *  its placeholder is a span, not an anchor. */
                const stampedLinks = (): string[] => {
                  void defangTick()
                  const dests: string[] = []
                  for (const anchor of Array.from(
                    prose?.querySelectorAll('a[data-link-review="unverified"]') ?? [],
                  )) {
                    const dest = anchor.getAttribute('data-link-dest')
                    if (dest !== null && !dests.includes(dest)) dests.push(dest)
                  }
                  return dests
                }

                /** The stamped links acceptance has not yet taken — what the
                 *  indicator counts and the Accept-as-safe list offers. */
                const unacceptedLinks = () =>
                  stampedLinks().filter((dest) => !linkAcceptance().isAccepted(message.id, dest))

                /** What the indicator reads: the unaccepted count while any
                 *  remain, the accepted state once none do — the indicator
                 *  stays visible either way (the merged design, Q2). */
                const indicatorLabel = () => {
                  const unaccepted = unacceptedLinks()
                  return unaccepted.length > 0
                    ? `Links unverified: ${unaccepted.length}`
                    : 'Links accepted'
                }

                /** Accept ONE exact resolved link in THIS message (ruling Q2 —
                 *  accepting one never accepts another) and announce the
                 *  changed state through the polite live region. */
                const acceptLink = (dest: string) => {
                  linkAcceptance().accept(message.id, dest)
                  const remaining = unacceptedLinks()
                  setAcceptanceAnnouncement(
                    remaining.length === 0
                      ? 'All links in this message are accepted for this session.'
                      : `Accepted as safe for this message: ${dest}. ` +
                          `${remaining.length} unverified link${remaining.length === 1 ? '' : 's'} still to review.`,
                  )
                }

                // The persisted mark, re-derived on every rendering of this
                // message (ruling Q5 as overridden — issue #901 comment
                // 6618793027, 2026-11-04): each anchor whose raw spelling the
                // store marks unsafe goes inert text again, so a re-render does
                // not present a marked link back. Client-side, per session — no
                // session state beyond the mark, and a reload (a fresh store)
                // starts empty. Solid effects run after the DOM is written, so
                // `prose` is assigned and `innerHTML` set by the time this
                // runs; when the re-derivation removes an anchor it bumps the
                // strip's tick so the indicator and the Accept-as-safe list
                // re-derive in the same flush.
                createEffect(() => {
                  void rendered().html
                  const el = prose
                  if (!el) return
                  const raws = new Set(
                    Array.from(el.querySelectorAll('a[data-link-raw]')).map((a) =>
                      a.getAttribute('data-link-raw'),
                    ),
                  )
                  for (const raw of raws) {
                    if (raw === null || !linkAcceptance().isMarkedUnsafe(message.id, raw)) continue
                    if (defangAnchors(el, raw) > 0) setDefangTick((t) => t + 1)
                  }
                })

                return (
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
                          // #1008 round 2: the user's ground is the accent's
                          // soft tint (not the solid violet); its initials take
                          // the primary text, because the accent on its own
                          // tint is 4.0:1 in light. Error and warning stay on
                          // solid dark grounds where white reads. The
                          // assistant's ground is the theme's own, and white on
                          // it disappears the moment the theme turns light.
                          message.role === 'error' || message.role === 'warning'
                            ? 'white xs'
                            : 'ui-text-primary xs'
                        }
                        font="medium"
                        bg={
                          message.role === 'user'
                            ? 'ui-accent/20'
                            : message.role === 'error'
                              ? 'red-900/50'
                              : message.role === 'warning'
                                ? 'amber-900/50'
                                : 'ui-bg-tertiary'
                        }
                        border={
                          message.role === 'user'
                            ? '1 ui-accent/50'
                            : message.role === 'error'
                              ? '1 red-500/50'
                              : message.role === 'warning'
                                ? '1 amber-500/50'
                                : '1 ui-accent/50'
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
                            ? // /6: the bubble's tertiary timestamp keeps 4.5:1
                              // on it in dark (4.7; /10 was 4.4) (#1008).
                              'ui-accent/6'
                            : message.role === 'error'
                              ? 'red-900/20'
                              : message.role === 'warning'
                                ? 'amber-900/20'
                                : 'ui-bg-tertiary'
                        }
                        text="ui-text-primary"
                        border={
                          message.role === 'user'
                            ? '1 ui-accent/40'
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
                    their trace (empty string + signature, see AGENTS.md), so
                    the only strings that pattern can still match are answers
                    that legitimately open with those literal characters —
                    which it would silently hide. */}
                            <div
                              text="sm"
                              class="prose-chat"
                              // The acceptance key (#901 slice 3): code-owned,
                              // set here on the component's own element — never
                              // in the model's markup, which DOMPurify strips.
                              data-message-id={message.id}
                              // A callback ref (not `ref={prose}`): the strip
                              // below reads the container the moment it
                              // renders, so the assignment must happen inside
                              // element creation — the one place both the
                              // compiled and the runtime JSX paths call it.
                              ref={(el) => (prose = el)}
                              // eslint-disable-next-line solid/no-innerhtml
                              innerHTML={rendered().html}
                            />
                            {/* #901 slice 3 — the "Links unverified" indicator and
                              the Accept-as-safe action: one strip per assistant
                              message, beside its rendered content. The count
                              is the message's UNACCEPTED unverified links,
                              derived from the live rendering, so acceptance
                              and defang both move it; once every link is
                              accepted the strip stays and reads the accepted
                              state (the merged design, Q2). */}
                            <Show when={stampedLinks().length > 0}>
                              <div
                                data-testid="link-review-strip"
                                flex="~ items-center gap-2"
                                m="t-2"
                                text="xs"
                              >
                                <span
                                  data-testid="links-unverified-indicator"
                                  // Explicit accessible name (a11y pin): the label
                                  // and the visible words agree, and the words are
                                  // aria-hidden so the label is not read twice.
                                  aria-label={indicatorLabel()}
                                  text="xs ui-text-secondary"
                                >
                                  <span
                                    class="i-material-symbols-shield-outline"
                                    w="3.5"
                                    h="3.5"
                                    aria-hidden="true"
                                  />
                                  <span aria-hidden="true">{indicatorLabel()}</span>
                                </span>
                                {/* The message-level action: it presents THIS
                                  message's unverified links for explicit
                                  selection — one item per link, its resolved
                                  address shown — and selecting an item accepts
                                  exactly that link, nothing else. The review
                                  dialog stays reachable the way slice 2 built
                                  it: through the anchor itself. */}
                                <Show when={unacceptedLinks().length > 0}>
                                  <Menu.Root>
                                    <Menu.Trigger
                                      data-testid="accept-as-safe-trigger"
                                      p="x-2 y-1"
                                      bg="transparent hover:ui-bg-hover"
                                      border="1 ui-border-secondary"
                                      rounded="md"
                                      cursor="pointer"
                                    >
                                      Accept as safe
                                    </Menu.Trigger>
                                    <Menu.Positioner>
                                      <Menu.Content
                                        data-testid="accept-as-safe-list"
                                        bg="ui-bg-secondary"
                                        border="1 ui-border-secondary"
                                        rounded="md"
                                        p="1"
                                        min-w="64"
                                        max-w="[28rem]"
                                        shadow="lg"
                                        z="50"
                                      >
                                        <For each={unacceptedLinks()}>
                                          {(dest) => (
                                            <Menu.Item
                                              value={dest}
                                              data-testid="accept-as-safe-item"
                                              // `onSelect`, not `onClick`: zag's
                                              // menu machine invokes selection on
                                              // BOTH pointer and keyboard
                                              // activation — the keyboard path
                                              // never dispatches a DOM click, so
                                              // an onClick here left keyboard
                                              // users with an action that did
                                              // nothing (code review r1, MUST 1).
                                              onSelect={() => acceptLink(dest)}
                                              p="x-2 y-1.5"
                                              text="xs ui-text-primary"
                                              break-all
                                              cursor="pointer"
                                            >
                                              Accept as safe: {dest}
                                            </Menu.Item>
                                          )}
                                        </For>
                                      </Menu.Content>
                                    </Menu.Positioner>
                                  </Menu.Root>
                                </Show>
                              </div>
                            </Show>
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
                                  style={{
                                    color: message.role === 'error' ? '#ef4444' : '#f59e0b',
                                  }}
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
                                  border={
                                    message.role === 'error' ? '1 red-500/30' : '1 amber-500/30'
                                  }
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
                        <ToolCallDisplay toolCall={message.toolCall!} />
                      </div>
                    </Show>
                  </div>
                )
              }}
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
          <ScrollArea.Thumb
            bg="cyber-700/50 hover:cyber-600/70"
            rounded="full"
            transition="colors"
          />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
      {/* The link-review dialog (#901 slice 2), mounted here so the ONE
          renderer serves both surfaces that render assistant markdown — the
          live transcript and the shared transcript. Client-only: no server
          round-trip, no HITL request, nothing persisted. */}
      <HitlDialog
        kind="link-review"
        open={reviewTarget() !== null}
        onClose={() => setReviewTarget(null)}
        address={reviewTarget()?.dest ?? ''}
        onDefang={() => {
          const target = reviewTarget()
          if (!target) return
          defangAnchors(target.container, target.raw)
          // The mark is PERSISTED, not rendering-only (ruling Q5 as
          // overridden — issue #901 comment 6618793027, 2026-11-04): every
          // re-render of this message re-derives the defang from the store.
          // Keyed like acceptance on (message id, the defang identity
          // `data-link-raw`); client-side, per session — no session state
          // beyond the mark, nothing across reloads, nothing to a server.
          const messageId = target.container.getAttribute('data-message-id')
          if (messageId !== null) linkAcceptance().markUnsafe(messageId, target.raw)
          // Re-derive the strip: the anchor left this rendering, so it leaves
          // the indicator's count and the Accept-as-safe list too (slice 3).
          setDefangTick((t) => t + 1)
          setReviewTarget(null)
        }}
      />
      {/* #901 slice 3 — the polite live region: it announces an
          acceptance-state change once, as it happens. Only an acceptance
          writes it, so a streaming content update never re-announces and a
          reload starts it silent. */}
      <div sr-only aria-live="polite" data-testid="link-acceptance-announcer">
        {acceptanceAnnouncement()}
      </div>
    </>
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
