/**
 * Data Stash Panel
 *
 * Displays tool_result events as an icon gallery partitioned into:
 *   - Current Turn: results from the latest user turn
 *   - Previous Turns: results from prior turns (collapsible, open by default)
 *   - Archived: hidden/archived results (collapsible, closed by default)
 *
 * Each icon reflects the tool that produced the result.
 * The label shows a short reference: <tool-prefix>:<short-id>.
 * Hovering shows the LLM summary (or a raw preview if no summary yet).
 */

import { For, Show, createSignal, createMemo, createEffect, on, onCleanup } from 'solid-js'
import { isServer } from 'solid-js/web'
import { Tooltip } from '@ark-ui/solid/tooltip'
import type { ContextEvent, ToolResultEventData } from '~/lib/harness-patterns'
import type { StashDocumentMeta } from '~/lib/document-store.server'
import {
  referencesForDoc,
  type OpenReferenceTarget,
} from '~/lib/harness-client/reference-extractor'

// ============================================================================
// Types
// ============================================================================

export type StashAction = 'hide' | 'unhide' | 'archive' | 'unarchive'
/** Document actions add `delete` (removable) and `download` (fetch the raw
 *  file — base64-decoded for binary via the `?download` route). */
export type DocAction = StashAction | 'delete' | 'download'

export interface DataStashPanelProps {
  events: ContextEvent[]
  sessionId: string
  /** The conversation's selected agent — sent with uploads so the auto-ingest
   *  gate can resolve the harness even before the session is persisted. */
  agentId?: string
  onStashAction: (eventId: string, action: StashAction) => Promise<void>
  /** A citation clicked in the chat — open the inline viewer at this reference. */
  pendingReference?: OpenReferenceTarget | null
  /** Fired after a successful upload (so the route can watch embedding status). */
  onUploaded?: () => void
}

interface ToolResultItem {
  event: ContextEvent
  data: ToolResultEventData
}

// ============================================================================
// Tool → Icon mapping (MDI icons via @iconify-json/mdi + @unocss/preset-icons)
// Usage: class="i-mdi-<icon-name>" renders as CSS background-mask icon
// ============================================================================

function getToolIcon(tool: string): string {
  const t = tool.toLowerCase()
  if (t.includes('neo4j') || t.includes('cypher') || t.includes('graph'))
    return 'i-mdi-graph-outline'
  if (t.includes('search') || t.includes('web') || t.includes('browse') || t.includes('fetch'))
    return 'i-mdi-web'
  if (t.includes('redis') || t.includes('cache')) return 'i-mdi-lightning-bolt-outline'
  if (t.includes('memory') || t.includes('brain')) return 'i-mdi-brain'
  if (t.includes('github') || t.includes('git')) return 'i-mdi-github'
  if (t.includes('file') || t.includes('filesystem') || t.includes('read') || t.includes('write'))
    return 'i-mdi-file-document-outline'
  if (t.includes('context7') || t.includes('doc') || t.includes('library'))
    return 'i-mdi-book-open-variant'
  if (t.includes('code') || t.includes('script') || t.includes('eval')) return 'i-mdi-code-braces'
  if (t.includes('database') || t.includes('sql')) return 'i-mdi-database-outline'
  return 'i-mdi-package-variant'
}

/** Icon tint color — matches the pattern-color scheme loosely */
function getToolColor(tool: string): string {
  const t = tool.toLowerCase()
  if (t.includes('neo4j') || t.includes('cypher') || t.includes('graph')) return '#22d3ee' // cyan
  if (t.includes('search') || t.includes('web') || t.includes('browse')) return '#60a5fa' // blue
  if (t.includes('redis') || t.includes('cache')) return '#f59e0b' // amber
  if (t.includes('memory') || t.includes('brain')) return '#a78bfa' // violet
  if (t.includes('github') || t.includes('git')) return '#94a3b8' // slate
  if (t.includes('file') || t.includes('filesystem')) return '#34d399' // emerald
  if (t.includes('code') || t.includes('script')) return '#f472b6' // pink
  return '#71717a' // zinc default
}

/**
 * Short display label: <tool-prefix>:<last-6-of-id>
 * e.g. "read_neo4j_cypher" + "ev-fr1y8p" → "neo4j:fr1y8p"
 */
function getRefLabel(tool: string, eventId: string): string {
  const shortId = eventId.replace('ev-', '')
  // Extract the most informative segment from the tool name
  const parts = tool.split('_').filter((p) => p.length > 2)
  // Prefer domain keywords over generic verbs
  const skip = new Set([
    'read',
    'write',
    'get',
    'set',
    'list',
    'create',
    'delete',
    'fetch',
    'run',
    'execute',
  ])
  const key = parts.find((p) => !skip.has(p)) ?? parts[0] ?? tool
  return `${key}:${shortId}`
}

/** Audio extensions we render with a player (matches upload-service MIME map). */
const AUDIO_EXT_RE = /\.(m4a|mp3|wav|aac|ogg|oga|opus|flac|caf)$/i

/** Whether a document is playable audio (a voice recording from the agent
 *  trigger endpoint, or any uploaded audio file). */
function isAudioDoc(doc: StashDocumentMeta): boolean {
  return doc.mimeType.toLowerCase().startsWith('audio/') || AUDIO_EXT_RE.test(doc.filename)
}

/** Icon for an uploaded document, chosen from its MIME type / extension. */
function getDocIcon(mimeType: string, filename: string): string {
  const m = mimeType.toLowerCase()
  const f = filename.toLowerCase()
  if (m.startsWith('audio/') || AUDIO_EXT_RE.test(f)) return 'i-mdi-microphone'
  if (m.includes('json') || f.endsWith('.json')) return 'i-mdi-code-json'
  if (m.includes('csv') || m.includes('tab-separated') || f.endsWith('.csv'))
    return 'i-mdi-table-large'
  if (m.includes('markdown') || f.endsWith('.md')) return 'i-mdi-language-markdown-outline'
  if (m.includes('pdf') || f.endsWith('.pdf')) return 'i-mdi-file-pdf-box'
  if (m.includes('html') || m.includes('xml')) return 'i-mdi-file-code-outline'
  return 'i-mdi-file-document-outline'
}

/** URL that streams a document's raw bytes (base64-decoded for binary). Used as
 *  the `<audio>` src — the `?download` Content-Disposition is ignored by media
 *  elements, so the same route serves both download and playback. */
function docDownloadUrl(id: string, sessionId: string): string {
  return `/api/stash/document/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sessionId)}&download`
}

/** Format a byte count compactly (e.g. 2.4 KB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ============================================================================
// Helpers
// ============================================================================

function findLastUserMessageIndex(events: ContextEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'user_message') return i
  }
  return -1
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max) + '…'
}

// ============================================================================
// Collapsible Section
// ============================================================================

const CollapsibleSection = (props: {
  title: string
  count: number
  defaultOpen?: boolean
  children: any
}) => {
  const [open, setOpen] = createSignal(props.defaultOpen ?? true)

  return (
    <div border="b dark-border-primary">
      <button
        onClick={() => setOpen(!open())}
        w="full"
        flex="~"
        items="center"
        p="x-3 y-2"
        bg="dark-bg-secondary hover:dark-bg-tertiary"
        cursor="pointer"
        border="none"
        text="sm dark-text-secondary"
        gap="2"
      >
        <span text="xs" style={{ 'font-family': 'monospace' }}>
          {open() ? '▼' : '▶'}
        </span>
        <span font="medium">{props.title}</span>
        <span text="xs dark-text-tertiary" font="mono">
          ({props.count})
        </span>
      </button>
      <Show when={open()}>
        <div>{props.children}</div>
      </Show>
    </div>
  )
}

// ============================================================================
// Icon Chip — single tool result as an icon with tooltip and context menu
// ============================================================================

const StashIcon = (props: {
  item: ToolResultItem
  isGrayed: boolean
  onAction: (eventId: string, action: StashAction) => Promise<void>
}) => {
  const d = () => props.item.data
  const icon = () => getToolIcon(d().tool)
  const color = () => getToolColor(d().tool)
  const label = () => getRefLabel(d().tool, props.item.event.id!)
  const [loading, setLoading] = createSignal(false)
  const [menuOpen, setMenuOpen] = createSignal(false)

  const tooltipText = () => {
    const data = d()
    if (data.summary) return data.summary
    const raw = typeof data.result === 'string' ? data.result : JSON.stringify(data.result)
    return truncate(raw, 300)
  }

  const handleAction = async (action: StashAction) => {
    setMenuOpen(false)
    setLoading(true)
    try {
      await props.onAction(props.item.event.id!, action)
    } finally {
      setLoading(false)
    }
  }

  const menuActions = () => {
    if (d().archived) return [{ label: 'Unarchive', action: 'unarchive' as StashAction }]
    if (d().hidden)
      return [
        { label: 'Unhide', action: 'unhide' as StashAction },
        { label: 'Archive', action: 'archive' as StashAction },
      ]
    return [
      { label: 'Hide', action: 'hide' as StashAction },
      { label: 'Archive', action: 'archive' as StashAction },
    ]
  }

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <Tooltip.Root openDelay={200} closeDelay={100} positioning={{ placement: 'top' }}>
        <Tooltip.Trigger>
          {/* Icon chip */}
          <div
            flex="~ col"
            items="center"
            gap="1"
            p="2"
            w="16"
            cursor="pointer"
            rounded="lg"
            bg={menuOpen() ? 'dark-bg-tertiary' : 'transparent hover:dark-bg-secondary'}
            border={
              menuOpen() ? '1 dark-border-secondary' : '1 transparent hover:dark-border-primary'
            }
            transition="all"
            opacity={props.isGrayed ? '35' : loading() ? '50' : '100'}
            onClick={() => setMenuOpen(!menuOpen())}
          >
            {/* MDI icon rendered via UnoCSS preset-icons */}
            <span
              class={icon()}
              style={{
                width: '28px',
                height: '28px',
                color: props.isGrayed ? '#52525b' : color(),
                filter: props.isGrayed ? 'grayscale(1)' : 'none',
                transition: 'all 0.15s',
              }}
            />
            {/* Reference label */}
            <span
              style={{
                'font-family': '"Fira Code", ui-monospace, monospace',
                'font-size': '9px',
                color: props.isGrayed ? '#52525b' : '#71717a',
                'text-align': 'center',
                'word-break': 'break-all',
                'line-height': '1.2',
                'max-width': '60px',
              }}
            >
              {label()}
            </span>
            {/* Success/error dot */}
            <Show when={!d().success}>
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  'border-radius': '50%',
                  background: '#ef4444',
                }}
              />
            </Show>
          </div>
        </Tooltip.Trigger>

        <Tooltip.Positioner>
          <Tooltip.Content
            bg="dark-bg-tertiary"
            border="1 dark-border-secondary"
            rounded="md"
            p="3"
            shadow="lg"
            style={{ 'max-width': '280px', 'z-index': '50' }}
          >
            {/* Tool name + ref */}
            <div text="xs dark-text-secondary" font="mono" m="b-2">
              {d().tool} · {props.item.event.id}
            </div>
            {/* Summary or raw preview */}
            <div
              text="xs dark-text-primary"
              style={{
                'line-height': '1.5',
                'white-space': 'pre-wrap',
                'word-break': 'break-word',
              }}
            >
              {tooltipText()}
            </div>
            <Show when={!d().summary}>
              <div text="xs dark-text-tertiary" m="t-2" style={{ 'font-style': 'italic' }}>
                Summary pending…
              </div>
            </Show>
          </Tooltip.Content>
        </Tooltip.Positioner>
      </Tooltip.Root>

      {/* Context menu (open on click) */}
      <Show when={menuOpen()}>
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            'z-index': '100',
            background: '#1a1a24',
            border: '1px solid #2a2a3a',
            'border-radius': '6px',
            padding: '4px',
            'min-width': '100px',
            'box-shadow': '0 4px 16px rgba(0,0,0,0.4)',
          }}
        >
          <For each={menuActions()}>
            {(btn) => (
              <button
                onClick={() => handleAction(btn.action)}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '5px 10px',
                  'text-align': 'left',
                  background: 'transparent',
                  border: 'none',
                  'border-radius': '4px',
                  'font-size': '11px',
                  color: '#a1a1aa',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#22222f')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                {btn.label}
              </button>
            )}
          </For>
          <div style={{ height: '1px', background: '#2a2a3a', margin: '2px 0' }} />
          <button
            onClick={() => setMenuOpen(false)}
            style={{
              display: 'block',
              width: '100%',
              padding: '5px 10px',
              'text-align': 'left',
              background: 'transparent',
              border: 'none',
              'border-radius': '4px',
              'font-size': '11px',
              color: '#52525b',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      </Show>

      {/* Click-away backdrop to close menu */}
      <Show when={menuOpen()}>
        <div
          style={{ position: 'fixed', inset: '0', 'z-index': '99' }}
          onClick={() => setMenuOpen(false)}
        />
      </Show>
    </div>
  )
}

// ============================================================================
// Icon Gallery Section
// ============================================================================

const IconGallery = (props: {
  items: ToolResultItem[]
  onAction: (id: string, action: StashAction) => Promise<void>
}) => (
  <div flex="~ wrap" gap="2" p="3">
    <For each={props.items}>
      {(item) => (
        <StashIcon
          item={item}
          isGrayed={!!(item.data.hidden || item.data.archived)}
          onAction={props.onAction}
        />
      )}
    </For>
  </div>
)

// ============================================================================
// Document Chip — a single uploaded document (Issue #6 upload path)
// ============================================================================

const DocChip = (props: {
  doc: StashDocumentMeta
  sessionId: string
  onAction: (id: string, action: DocAction) => Promise<void>
  onView: () => void
  active?: boolean
}) => {
  const d = () => props.doc
  const grayed = () => !!(d().hidden || d().archived)
  // Vector-ingestion status set by the harness-aware auto-ingest path. `pending`
  // → the upload is being chunked/embedded into the local vector store; `failed`
  // → ingest errored (e.g. embedder offline). Absent → not ingested (the agent
  // has no redis retriever) — show nothing.
  const status = () => d().ingestStatus
  const [loading, setLoading] = createSignal(false)
  const [menuOpen, setMenuOpen] = createSignal(false)
  // Inline audio player toggle (recordings from the agent trigger endpoint).
  const [playing, setPlaying] = createSignal(false)
  const isAudio = () => isAudioDoc(d())

  const handle = async (action: DocAction) => {
    setMenuOpen(false)
    setLoading(true)
    try {
      await props.onAction(d().id, action)
    } finally {
      setLoading(false)
    }
  }

  const menuActions = (): { label: string; action: DocAction }[] => {
    const base: { label: string; action: DocAction }[] = d().archived
      ? [{ label: 'Unarchive', action: 'unarchive' }]
      : d().hidden
        ? [
            { label: 'Unhide', action: 'unhide' },
            { label: 'Archive', action: 'archive' },
          ]
        : [
            { label: 'Hide', action: 'hide' },
            { label: 'Archive', action: 'archive' },
          ]
    return [
      { label: 'Download', action: 'download' as DocAction },
      ...base,
      { label: 'Delete', action: 'delete' },
    ]
  }

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      {/* "Eye" — open the inline file viewer. Text docs, plus converted
          binaries (docx/pdf/… whose derived markdown is viewable); a raw binary
          has no text view. Stops propagation so it doesn't also open the menu. */}
      <Show when={d().encoding !== 'base64' || d().converted}>
        <button
          onClick={(e) => {
            e.stopPropagation()
            props.onView()
          }}
          title="View file"
          style={{
            position: 'absolute',
            top: '0px',
            right: '0px',
            'z-index': '6',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: '2px',
            'line-height': '0',
            opacity: props.active ? '1' : '0.55',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = props.active ? '1' : '0.55')}
        >
          <span
            class={props.active ? 'i-mdi-eye' : 'i-mdi-eye-outline'}
            style={{ width: '13px', height: '13px', color: '#22d3ee', display: 'block' }}
          />
        </button>
      </Show>
      {/* Native title tooltip — keeps the chip simple; Ark's Tooltip is used by
          the tool-result chips above. */}
      <div
        title={`${d().filename}\n${d().mimeType} · ${formatBytes(d().size)}`}
        flex="~ col"
        items="center"
        gap="1"
        p="2"
        w="16"
        cursor="pointer"
        rounded="lg"
        bg={
          props.active
            ? 'dark-bg-tertiary'
            : menuOpen()
              ? 'dark-bg-tertiary'
              : 'transparent hover:dark-bg-secondary'
        }
        border={
          props.active || menuOpen()
            ? '1 dark-border-secondary'
            : '1 transparent hover:dark-border-primary'
        }
        transition="all"
        opacity={grayed() ? '35' : loading() ? '50' : '100'}
        onClick={() => setMenuOpen(!menuOpen())}
      >
        {/* Icon + an ingestion indicator badge over its corner. */}
        <div style={{ position: 'relative', display: 'inline-flex' }}>
          <span
            class={getDocIcon(d().mimeType, d().filename)}
            style={{
              width: '28px',
              height: '28px',
              color: grayed() ? '#52525b' : '#34d399',
              opacity: status() === 'pending' ? '0.5' : '1',
              transition: 'all 0.15s',
            }}
          />
          <Show when={status() === 'pending'}>
            <span
              class="i-mdi-loading"
              title="Embedding into the vector store…"
              style={{
                position: 'absolute',
                top: '-5px',
                right: '-7px',
                width: '14px',
                height: '14px',
                color: '#f59e0b',
                animation: 'spin 1s linear infinite',
              }}
            />
          </Show>
          <Show when={status() === 'failed'}>
            <span
              class="i-mdi-alert-circle"
              title="Ingest failed — not searchable (is the embedder running?)"
              style={{
                position: 'absolute',
                top: '-5px',
                right: '-7px',
                width: '13px',
                height: '13px',
                color: '#f87171',
              }}
            />
          </Show>
        </div>
        <span
          style={{
            'font-family': '"Fira Code", ui-monospace, monospace',
            'font-size': '9px',
            color: grayed() ? '#52525b' : '#a1a1aa',
            'text-align': 'center',
            'word-break': 'break-all',
            'line-height': '1.2',
            'max-width': '60px',
          }}
        >
          {truncate(d().filename, 18)}
        </span>
        {/* "embedding…" / "failed" line below the icon. */}
        <Show when={status() === 'pending'}>
          <span style={{ 'font-size': '8px', color: '#f59e0b', 'line-height': '1.1' }}>
            embedding…
          </span>
        </Show>
        <Show when={status() === 'failed'}>
          <span style={{ 'font-size': '8px', color: '#f87171', 'line-height': '1.1' }}>
            index failed
          </span>
        </Show>
      </div>

      <Show when={menuOpen()}>
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            'z-index': '100',
            background: '#1a1a24',
            border: '1px solid #2a2a3a',
            'border-radius': '6px',
            padding: '4px',
            'min-width': '100px',
            'box-shadow': '0 4px 16px rgba(0,0,0,0.4)',
          }}
        >
          {/* Play toggle — local (audio only), not a server action. */}
          <Show when={isAudio()}>
            <button
              onClick={() => {
                setPlaying((p) => !p)
                setMenuOpen(false)
              }}
              style={{
                display: 'block',
                width: '100%',
                padding: '5px 10px',
                'text-align': 'left',
                background: 'transparent',
                border: 'none',
                'border-radius': '4px',
                'font-size': '11px',
                color: '#22d3ee',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#22222f')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              {playing() ? 'Hide player' : 'Play'}
            </button>
          </Show>
          <For each={menuActions()}>
            {(btn) => (
              <button
                onClick={() => handle(btn.action)}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '5px 10px',
                  'text-align': 'left',
                  background: 'transparent',
                  border: 'none',
                  'border-radius': '4px',
                  'font-size': '11px',
                  color: btn.action === 'delete' ? '#f87171' : '#a1a1aa',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#22222f')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                {btn.label}
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={menuOpen()}>
        <div
          style={{ position: 'fixed', inset: '0', 'z-index': '99' }}
          onClick={() => setMenuOpen(false)}
        />
      </Show>

      {/* Inline audio player — toggled from the Play menu item. Sits below the
          chip; the ?download route streams the recording's bytes. */}
      <Show when={isAudio() && playing()}>
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: '0',
            'z-index': '101',
            'margin-top': '2px',
          }}
        >
          <audio
            controls
            autoplay
            src={docDownloadUrl(d().id, props.sessionId)}
            style={{ width: '180px', height: '32px' }}
          />
        </div>
      </Show>
    </div>
  )
}

// ============================================================================
// Inline File Viewer — raw text + line numbers, scrollable, reference-highlighted
// ============================================================================

/** A char range to highlight in the viewer (from a retrieval reference). Line
 *  numbers are derived here, after the file content is fetched. */
export interface ViewerHighlight {
  startOffset: number
  endOffset: number
}

/** 1-based inclusive line range for a char offset span in `content`. */
function offsetsToLines(
  content: string,
  h: ViewerHighlight,
): { startLine: number; endLine: number } {
  const start = Math.max(0, Math.min(h.startOffset, content.length))
  const end = Math.max(start, Math.min(h.endOffset, content.length))
  return {
    startLine: content.slice(0, start).split('\n').length,
    endLine: content.slice(0, end).split('\n').length,
  }
}

const FileViewer = (props: {
  sessionId: string
  doc: StashDocumentMeta
  highlights: ViewerHighlight[]
  initialIndex?: number
  onClose: () => void
}) => {
  const [content, setContent] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)
  // Which highlight the navigator is focused on (scrolled to + emphasized).
  const [current, setCurrent] = createSignal(props.initialIndex ?? 0)

  // Reset the focused highlight when the target doc or the incoming index
  // changes (the viewer instance is reused across re-opens).
  createEffect(() => {
    // Reading the signal is what subscribes this effect to it; deleting the
    // bare expression stops the highlight resetting when the doc changes.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    props.doc.id
    setCurrent(props.initialIndex ?? 0)
  })

  // Fetch the full document text on open / when the target doc changes.
  createEffect(() => {
    const id = props.doc.id
    const sid = props.sessionId
    setLoading(true)
    setError(null)
    setContent(null)
    fetch(`/api/stash/document/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sid)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      // The route wraps the doc: `{ document: { content, encoding, … } }`.
      .then((body: { document?: { content?: string; encoding?: string } }) => {
        const d = body.document
        if (!d) setError('Document not found')
        else if (d.encoding === 'base64') setError('Binary file — no text preview')
        else setContent(d.content ?? '')
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load file'))
      .finally(() => setLoading(false))
  })

  const lines = createMemo(() => (content() ?? '').split('\n'))

  // All highlight ranges (aligned with props.highlights), once content is in.
  const ranges = createMemo(() => {
    const c = content()
    if (!c) return [] as { startLine: number; endLine: number }[]
    return props.highlights.map((h) => offsetsToLines(c, h))
  })
  const activeRange = createMemo(() => ranges()[current()] ?? null)
  // Every line covered by any highlight (light tint).
  const hotLines = createMemo(() => {
    const s = new Set<number>()
    for (const r of ranges()) for (let n = r.startLine; n <= r.endLine; n++) s.add(n)
    return s
  })
  const total = () => props.highlights.length

  // Scroll the focused range's first line into view when content / current change.
  const lineEls = new Map<number, HTMLDivElement>()
  createEffect(() => {
    const r = activeRange()
    if (content() && r) lineEls.get(r.startLine)?.scrollIntoView({ block: 'center' })
  })

  return (
    <div
      border="t dark-border-primary"
      bg="dark-bg-secondary"
      flex="~ col"
      style={{ 'max-height': '340px' }}
    >
      <div
        flex="~"
        items="center"
        gap="2"
        p="x-3 y-2"
        bg="dark-bg-tertiary"
        border="b dark-border-primary"
      >
        <span
          class={getDocIcon(props.doc.mimeType, props.doc.filename)}
          style={{ width: '14px', height: '14px', color: '#34d399', 'flex-shrink': '0' }}
        />
        <span
          text="xs dark-text-secondary"
          font="mono"
          style={{ flex: '1', 'word-break': 'break-all' }}
        >
          {props.doc.filename}
        </span>
        <Show when={activeRange()}>
          {(r) => (
            <span text="xs" style={{ color: '#f59e0b', 'font-family': 'monospace' }}>
              L{r().startLine}
              {r().endLine !== r().startLine ? `–${r().endLine}` : ''}
            </span>
          )}
        </Show>
        {/* Prev/next navigator across this doc's referenced chunks. */}
        <Show when={total() > 1}>
          <div flex="~" items="center" gap="1">
            <button
              onClick={() => setCurrent((c) => Math.max(0, c - 1))}
              disabled={current() === 0}
              title="Previous reference"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: current() === 0 ? 'default' : 'pointer',
                color: current() === 0 ? '#3f3f46' : '#a1a1aa',
                'font-size': '13px',
                'line-height': '1',
                padding: '0 2px',
              }}
            >
              ‹
            </button>
            <span text="xs dark-text-tertiary" font="mono">
              {current() + 1}/{total()}
            </span>
            <button
              onClick={() => setCurrent((c) => Math.min(total() - 1, c + 1))}
              disabled={current() === total() - 1}
              title="Next reference"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: current() === total() - 1 ? 'default' : 'pointer',
                color: current() === total() - 1 ? '#3f3f46' : '#a1a1aa',
                'font-size': '13px',
                'line-height': '1',
                padding: '0 2px',
              }}
            >
              ›
            </button>
          </div>
        </Show>
        <button
          onClick={() => props.onClose()}
          title="Close viewer"
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: '#71717a',
            'font-size': '13px',
            'line-height': '1',
            padding: '2px 4px',
          }}
        >
          ✕
        </button>
      </div>
      <div
        style={{
          overflow: 'auto',
          'font-family': '"Fira Code", ui-monospace, monospace',
          'font-size': '11px',
          'line-height': '1.55',
        }}
      >
        <Show when={loading()}>
          <div p="3" flex="~" items="center" gap="2" text="xs dark-text-tertiary">
            <span
              class="i-mdi-loading"
              style={{ width: '14px', height: '14px', animation: 'spin 1s linear infinite' }}
            />
            <span>Loading file…</span>
          </div>
        </Show>
        <Show when={error()}>
          <div p="3" text="xs red-400">
            {error()}
          </div>
        </Show>
        <Show when={content() !== null}>
          <For each={lines()}>
            {(line, i) => {
              const n = i() + 1
              const hot = () => hotLines().has(n)
              const r = () => activeRange()
              const active = () => !!r() && n >= r()!.startLine && n <= r()!.endLine
              return (
                <div
                  ref={(el) => lineEls.set(n, el)}
                  flex="~"
                  style={{
                    background: active()
                      ? 'rgba(245,158,11,0.16)'
                      : hot()
                        ? 'rgba(245,158,11,0.07)'
                        : 'transparent',
                  }}
                >
                  <span
                    style={{
                      width: '42px',
                      'flex-shrink': '0',
                      'text-align': 'right',
                      padding: '0 8px',
                      color: '#52525b',
                      'user-select': 'none',
                      'border-right': active()
                        ? '2px solid #f59e0b'
                        : hot()
                          ? '2px solid rgba(245,158,11,0.4)'
                          : '2px solid transparent',
                    }}
                  >
                    {n}
                  </span>
                  <span
                    style={{
                      'white-space': 'pre-wrap',
                      'word-break': 'break-word',
                      padding: '0 10px',
                      color: '#d4d4d8',
                      flex: '1',
                    }}
                  >
                    {line || ' '}
                  </span>
                </div>
              )
            }}
          </For>
        </Show>
      </div>
    </div>
  )
}

// ============================================================================
// Upload Zone — file picker + drag-and-drop (Issue #6)
// ============================================================================

const UploadZone = (props: {
  uploading: boolean
  error: string | null
  onFiles: (files: File[]) => void
}) => {
  const [dragOver, setDragOver] = createSignal(false)
  let inputRef: HTMLInputElement | undefined

  const pick = (list: FileList | null) => {
    if (list && list.length > 0) props.onFiles(Array.from(list))
  }

  return (
    <div p="3" flex="~ col" gap="2">
      <div
        onClick={() => inputRef?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          pick(e.dataTransfer?.files ?? null)
        }}
        flex="~ col"
        items="center"
        justify="center"
        gap="1"
        p="4"
        rounded="lg"
        cursor="pointer"
        border={dragOver() ? '2 dashed neon-cyan/60' : '2 dashed dark-border-primary'}
        bg={dragOver() ? 'cyber-800/40' : 'transparent hover:dark-bg-secondary'}
        transition="all"
      >
        <span
          class={props.uploading ? 'i-mdi-loading' : 'i-mdi-cloud-upload-outline'}
          style={{
            width: '24px',
            height: '24px',
            color: dragOver() ? '#22d3ee' : '#71717a',
            ...(props.uploading ? { animation: 'spin 1s linear infinite' } : {}),
          }}
        />
        <span text="xs dark-text-secondary">
          {props.uploading ? 'Uploading…' : 'Drop a file or click to upload'}
        </span>
        <span text="xs dark-text-tertiary">Text, Markdown, JSON, CSV</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            pick(e.currentTarget.files)
            e.currentTarget.value = '' // allow re-selecting the same file
          }}
        />
      </div>
      <Show when={props.error}>
        <div text="xs red-400" font="mono">
          {props.error}
        </div>
      </Show>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

// Client-side cache of a session's uploaded-doc list. Ark's Tabs unmounts the
// inactive tab, so this panel re-mounts every time it's selected — without the
// cache, each re-mount re-ran a ~12s `listDocuments` and the Suspense boundary
// flashed "Loading data…". We seed the signal from the cache (instant) and
// refresh in the background, so re-selecting the tab is immediate and never
// blanks the panel. (No suspending resource → the Suspense fallback never fires.)
const docCache = new Map<string, StashDocumentMeta[]>()

async function fetchDocuments(sessionId: string): Promise<StashDocumentMeta[]> {
  const res = await fetch(`/api/stash/upload?sessionId=${encodeURIComponent(sessionId)}`)
  if (!res.ok) return []
  const body = (await res.json()) as { documents?: StashDocumentMeta[] }
  return body.documents ?? []
}

export const DataStashPanel = (props: DataStashPanelProps) => {
  // Uploaded documents live in Redis (Issue #6), separate from the tool_result
  // events in `props.events`. Seeded from the module cache, refreshed in the
  // background — see `docCache` above.
  const [docs, setDocs] = createSignal<StashDocumentMeta[]>(
    props.sessionId ? (docCache.get(props.sessionId) ?? []) : [],
  )
  const [loading, setLoading] = createSignal(false)
  const [uploading, setUploading] = createSignal(false)
  const [uploadError, setUploadError] = createSignal<string | null>(null)
  // Post-upload watch window: ingest runs in the background server-side, so we
  // poll briefly after an upload to catch the (absent → pending → indexed)
  // status transitions even before the first `pending` lands.
  const [watching, setWatching] = createSignal(false)
  let watchTimer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  // Inline file viewer: which doc is open + an optional char range to highlight.
  const [viewer, setViewer] = createSignal<{
    doc: StashDocumentMeta
    highlights: ViewerHighlight[]
    index: number
  } | null>(null)

  /** Open the viewer for a doc, highlighting its retrieved chunks (from the
   *  latest retriever result in props.events), focused on `index`. */
  const openViewer = (doc: StashDocumentMeta, index = 0) => {
    const highlights = referencesForDoc(props.events, doc.id).map((r) => ({
      startOffset: r.startOffset,
      endOffset: r.endOffset,
    }))
    setViewer({
      doc,
      highlights,
      index: Math.max(0, Math.min(index, Math.max(0, highlights.length - 1))),
    })
  }

  const applyDocs = (sid: string, list: StashDocumentMeta[]) => {
    docCache.set(sid, list)
    if (sid === props.sessionId) setDocs(list)
  }

  // Close the viewer if its doc disappears (deleted) or the session changes.
  createEffect(() => {
    const v = viewer()
    if (v && !docs().some((d) => d.id === v.doc.id)) setViewer(null)
  })

  // A citation was clicked in the chat → open the viewer at that reference.
  // Scoped to `pendingReference` only (via `on`), so a background doc-list
  // refresh doesn't re-open/reset the viewer while the user navigates chunks.
  createEffect(
    on(
      () => props.pendingReference,
      (ref) => {
        if (!ref) return
        const doc = docs().find((d) => d.id === ref.docId)
        if (!doc) return // not one of this session's uploads
        const refs = referencesForDoc(props.events, ref.docId)
        const idx =
          ref.startOffset != null
            ? refs.findIndex(
                (r) => r.startOffset === ref.startOffset && r.endOffset === ref.endOffset,
              )
            : 0
        openViewer(doc, Math.max(0, idx))
      },
    ),
  )

  // Single-flight background refresh. Shows a spinner only on the cold load
  // (nothing cached yet); otherwise updates silently behind the cached view.
  const refresh = async () => {
    const sid = props.sessionId
    if (!sid || isServer || inFlight) return
    inFlight = true
    if (!docCache.has(sid)) setLoading(true)
    try {
      applyDocs(sid, await fetchDocuments(sid))
    } finally {
      inFlight = false
      setLoading(false)
    }
  }

  // (Re)seed from cache + refresh whenever the session changes.
  createEffect(() => {
    const sid = props.sessionId
    setDocs(sid ? (docCache.get(sid) ?? []) : [])
    if (sid) void refresh()
  })

  const uploadFiles = async (files: File[]) => {
    const sid = props.sessionId
    if (!sid) {
      setUploadError('Start a conversation before uploading')
      return
    }
    setUploading(true)
    setUploadError(null)
    try {
      for (const file of files) {
        const form = new FormData()
        form.set('sessionId', sid)
        if (props.agentId) form.set('agentId', props.agentId)
        form.set('file', file)
        const res = await fetch('/api/stash/upload', { method: 'POST', body: form })
        const body = (await res.json().catch(() => ({}))) as {
          error?: string
          document?: StashDocumentMeta
        }
        if (!res.ok) throw new Error(body.error ?? `Upload failed (${res.status})`)
        // Show each upload the instant it's stored — the POST returns before
        // ingest finishes, so there's no blocking refetch here.
        if (body.document) {
          const doc = body.document
          applyDocs(sid, [doc, ...docs().filter((d) => d.id !== doc.id)])
        }
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      // The upload response already carries `ingestStatus` (the optimistic add
      // shows "embedding…" instantly), so we DON'T refresh immediately — an
      // early fetch would race the background ingest and clobber the optimistic
      // `pending` back to none. Open a ~25s watch window instead; the poll
      // reconciles pending → indexed once redis catches up.
      setWatching(true)
      if (watchTimer) clearTimeout(watchTimer)
      watchTimer = setTimeout(() => setWatching(false), 25000)
      // Let the route track embedding status (to block the chat composer).
      props.onUploaded?.()
    }
  }

  const handleDocAction = async (id: string, action: DocAction) => {
    const sid = props.sessionId
    if (!sid) return
    if (action === 'download') {
      // Stream the raw file via the ?download route (binary is base64-decoded
      // server-side). Anchor-click so the Content-Disposition filename is used.
      const a = document.createElement('a')
      a.href = `/api/stash/document/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sid)}&download`
      a.download = ''
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      return
    }
    if (action === 'delete') {
      applyDocs(
        sid,
        docs().filter((d) => d.id !== id),
      ) // optimistic remove
      await fetch(
        `/api/stash/document/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sid)}`,
        { method: 'DELETE' },
      )
    } else {
      const patch =
        action === 'hide'
          ? { hidden: true }
          : action === 'unhide'
            ? { hidden: false }
            : action === 'archive'
              ? { archived: true, hidden: false }
              : { archived: false }
      await fetch(`/api/stash/document/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, ...patch }),
      })
    }
    void refresh()
  }

  // Gentle, single-flight status poll while an upload is `pending` or within the
  // post-upload watch window. The `inFlight` guard in `refresh` prevents overlap
  // (no 12s list-storm), and the server-side list cache keeps each poll cheap.
  createEffect(() => {
    if (isServer) return
    const active = watching() || docs().some((d) => d.ingestStatus === 'pending')
    if (!active) return
    const timer = setInterval(() => void refresh(), 4000)
    onCleanup(() => clearInterval(timer))
  })
  onCleanup(() => {
    if (watchTimer) clearTimeout(watchTimer)
  })

  const partitioned = createMemo(() => {
    const toolResults: ToolResultItem[] = props.events
      .filter((e) => e.type === 'tool_result' && e.id)
      .map((e) => ({ event: e, data: e.data as ToolResultEventData }))

    const lastUserIdx = findLastUserMessageIndex(props.events)

    const current: ToolResultItem[] = []
    const previous: ToolResultItem[] = []
    const archived: ToolResultItem[] = []

    for (const item of toolResults) {
      if (item.data.archived) {
        archived.push(item)
      } else {
        const eventIdx = props.events.indexOf(item.event)
        if (lastUserIdx >= 0 && eventIdx > lastUserIdx) {
          current.push(item)
        } else {
          previous.push(item)
        }
      }
    }

    return { current, previous, archived }
  })

  const toolCount = createMemo(() => {
    const p = partitioned()
    return p.current.length + p.previous.length + p.archived.length
  })
  const totalCount = createMemo(() => toolCount() + docs().length)

  return (
    <div flex="~ col" h="full" overflow="auto" bg="dark-bg-primary">
      {/* Header */}
      <div
        p="x-3 y-2"
        bg="dark-bg-tertiary"
        border="b dark-border-primary"
        flex="~"
        items="center"
        gap="3"
      >
        <span
          class="i-mdi-package-variant-closed"
          style={{ width: '16px', height: '16px', color: '#71717a' }}
        />
        <span text="sm dark-text-primary" font="medium">
          Data Stash
        </span>
        <span text="xs dark-text-tertiary" font="mono">
          {totalCount()} items
        </span>
      </div>

      {/* ── Your Uploads ── user-provided documents (Redis-backed, Issue #6).
          Always available (the drop zone needs to be reachable with 0 docs). */}
      <CollapsibleSection title="Your Uploads" count={docs().length} defaultOpen={true}>
        <UploadZone uploading={uploading()} error={uploadError()} onFiles={uploadFiles} />
        <Show when={docs().length > 0}>
          <div flex="~ wrap" gap="2" p="x-3 y-2">
            <For each={docs()}>
              {(doc) => (
                <DocChip
                  doc={doc}
                  sessionId={props.sessionId}
                  onAction={handleDocAction}
                  onView={() => (viewer()?.doc.id === doc.id ? setViewer(null) : openViewer(doc))}
                  active={viewer()?.doc.id === doc.id}
                />
              )}
            </For>
          </div>
        </Show>
        {/* Inline viewer for the open file — full width, below the gallery. */}
        <Show when={viewer()}>
          {(v) => (
            <FileViewer
              sessionId={props.sessionId}
              doc={v().doc}
              highlights={v().highlights}
              initialIndex={v().index}
              onClose={() => setViewer(null)}
            />
          )}
        </Show>
        {/* Cold-load only — never blocks the drop zone (background refresh). */}
        <Show when={loading() && docs().length === 0}>
          <div flex="~" items="center" gap="2" p="x-3 y-2" text="xs dark-text-tertiary">
            <span
              class="i-mdi-loading"
              style={{ width: '14px', height: '14px', animation: 'spin 1s linear infinite' }}
            />
            <span>Loading uploads…</span>
          </div>
        </Show>
      </CollapsibleSection>

      {/* ── Agent Findings ── tool results the agent produced (neo4j, web, …). */}
      <CollapsibleSection title="Agent Findings" count={toolCount()} defaultOpen={true}>
        <Show when={toolCount() === 0}>
          <div flex="~ col" items="center" justify="center" p="6" text="dark-text-tertiary" gap="2">
            <span
              class="i-mdi-flask-empty-outline"
              style={{ width: '28px', height: '28px', color: '#3f3f46', opacity: '0.6' }}
            />
            <span text="xs m-t-1">No tool results yet — run an agent to see data here</span>
          </div>
        </Show>

        {/* Current Turn */}
        <Show when={partitioned().current.length > 0}>
          <div>
            <div p="x-3 y-2" flex="~" items="center" gap="2">
              <span text="xs dark-text-tertiary" font="medium">
                Current Turn
              </span>
              <span text="xs dark-text-tertiary" font="mono">
                ({partitioned().current.length})
              </span>
            </div>
            <IconGallery items={partitioned().current} onAction={props.onStashAction} />
          </div>
        </Show>

        {/* Previous Turns */}
        <Show when={partitioned().previous.length > 0}>
          <CollapsibleSection
            title="Previous Turns"
            count={partitioned().previous.length}
            defaultOpen={true}
          >
            <IconGallery items={partitioned().previous} onAction={props.onStashAction} />
          </CollapsibleSection>
        </Show>

        {/* Archived */}
        <Show when={partitioned().archived.length > 0}>
          <CollapsibleSection
            title="Archived"
            count={partitioned().archived.length}
            defaultOpen={false}
          >
            <IconGallery items={partitioned().archived} onAction={props.onStashAction} />
          </CollapsibleSection>
        </Show>
      </CollapsibleSection>
    </div>
  )
}
