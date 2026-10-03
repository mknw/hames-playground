/**
 * Skills — the Sandbox panel's third section (#415).
 *
 * A skill is an uploaded agentskills.io `SKILL.md`. The user's own skills and
 * every other user's global skills are mounted in their sandbox as
 * `/skills/<name>/SKILL.md`, and the actor is shown a one-line index of them;
 * this panel is where a user adds, inspects and controls that set.
 *
 * Layout: an Ark UI Tree View with two branches — "My skills" and "Global" —
 * and, under it, the selected skill's detail: what it is, whether this user's
 * sandbox mounts it (and if not, why), its actions, and its file as plain text.
 * The actions live in the detail rather than on the tree rows, so a tree item
 * stays a single focusable `treeitem` with no controls nested inside it.
 *
 * Actions, per owner decision (2026-10-02/03): upload only (no URL install);
 * the author deletes their skill, or makes it global or private — any user may
 * make a skill global; every user may hide or unhide another user's global
 * skill. Making a skill global and deleting one each take a confirmation,
 * because the first puts the text in every other user's sandbox and the second
 * cannot be undone (and does not erase copies already read into past
 * conversations — the confirmation says so).
 *
 * The file is shown as TEXT (`<pre>`), never rendered: a skill can be another
 * user's, and rendering would add a second Markdown path beside the one
 * sanitiser (kg-dtalk-ui §6) for no gain.
 */
import { For, Show, createMemo, createResource, createSignal } from 'solid-js'
import { TreeView, createTreeCollection } from '@ark-ui/solid/tree-view'
import { FileUpload, useFileUpload } from '@ark-ui/solid/file-upload'
import { MAX_MOUNTED_SKILLS, SKILLS_DIR, SKILL_FILE_MAX_BYTES } from '@hames-ai/sandbox/skills'
import {
  deleteSkill,
  getSkillContent,
  listSkills,
  setSkillGlobal,
  setSkillHidden,
  uploadSkill,
  type SkillView,
} from '~/lib/skills/actions.server'

interface SkillNode {
  id: string
  label: string
  skill?: SkillView
  /** A group's "nothing here" row: disabled, never selectable. */
  placeholder?: boolean
  /** Read by Ark's tree for `aria-disabled` (zag reads the node's own field). */
  disabled?: boolean
  children?: SkillNode[]
}

const GROUP_MINE = 'group:mine'
const GROUP_GLOBAL = 'group:global'

/** Why a skill is or is not in this user's sandbox, in words. */
export function statusText(skill: SkillView): string {
  switch (skill.status) {
    case 'mounted':
      // Another user's skill reaches only the runs someone is watching: a
      // routine or a triggered action mounts its owner's own skills alone.
      return skill.mine
        ? `Mounted in your sandbox at ${SKILLS_DIR}/${skill.name}/SKILL.md.`
        : `Mounted in your sandbox at ${SKILLS_DIR}/${skill.name}/SKILL.md, ` +
            'except in routines and triggered runs, which mount only your own skills.'
    case 'hidden':
      return 'Hidden: not mounted in your sandbox.'
    case 'shadowed':
      return `Not mounted: another skill named "${skill.name}" is mounted instead.`
    case 'over-limit':
      return `Not mounted: a sandbox holds at most ${MAX_MOUNTED_SKILLS} skills.`
  }
}

/** The tree's data: two branches, each with a placeholder row when empty. */
export function buildSkillTree(skills: readonly SkillView[]): SkillNode {
  const leaf = (s: SkillView): SkillNode => ({ id: s.id, label: s.name, skill: s })
  const group = (id: string, label: string, members: SkillView[], empty: string): SkillNode => ({
    id,
    label,
    children: members.length
      ? members.map(leaf)
      : [{ id: `${id}:empty`, label: empty, placeholder: true, disabled: true }],
  })
  return {
    id: 'root',
    label: 'Skills',
    children: [
      group(
        GROUP_MINE,
        'My skills',
        skills.filter((s) => s.mine),
        'No skills yet — upload a SKILL.md',
      ),
      group(
        GROUP_GLOBAL,
        'Global',
        skills.filter((s) => !s.mine),
        'No global skills from other users',
      ),
    ],
  }
}

/** A rejected file, in words. */
function rejectionText(codes: readonly string[]): string {
  if (codes.includes('FILE_TOO_LARGE')) {
    return `That file is larger than ${SKILL_FILE_MAX_BYTES / 1024} KiB, the limit for a SKILL.md.`
  }
  if (codes.includes('FILE_INVALID_TYPE')) return 'Upload a Markdown file (SKILL.md).'
  return 'That file could not be uploaded.'
}

type Pending = { kind: 'delete' | 'global'; id: string } | null

export const SkillsPanel = () => {
  const [skills, { refetch }] = createResource(listSkills)
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [message, setMessage] = createSignal<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [pending, setPending] = createSignal<Pending>(null)

  const list = () => skills() ?? []
  const selected = createMemo(() => list().find((s) => s.id === selectedId()) ?? null)
  const collection = createMemo(() =>
    createTreeCollection<SkillNode>({
      rootNode: buildSkillTree(list()),
      nodeToValue: (node) => node.id,
      nodeToString: (node) => node.label,
      isNodeDisabled: (node) => node.placeholder === true,
    }),
  )
  const [content] = createResource(selectedId, (id) => getSkillContent(id))

  /** Run an action, show its outcome, refresh the list. */
  const act = async (run: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(true)
    setPending(null)
    try {
      const result = await run()
      setMessage(result.ok ? { tone: 'ok', text: done } : { tone: 'error', text: result.error! })
      await refetch()
    } catch {
      setMessage({ tone: 'error', text: 'The request failed. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  const upload = async (file: File) => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await uploadSkill(await file.text())
      if (result.ok) {
        setMessage({ tone: 'ok', text: `Uploaded "${result.skill.name}".` })
        await refetch()
        setSelectedId(result.skill.id)
      } else {
        setMessage({ tone: 'error', text: result.error })
      }
    } catch {
      setMessage({ tone: 'error', text: 'The upload failed. Try again.' })
    } finally {
      setBusy(false)
      fileUpload().clearFiles()
    }
  }

  const fileUpload = useFileUpload({
    maxFiles: 1,
    maxFileSize: SKILL_FILE_MAX_BYTES,
    accept: { 'text/markdown': ['.md'] },
    onFileAccept: (details) => {
      const file = details.files[0]
      if (file) void upload(file)
    },
    // Both callbacks also fire when the machine's lists are CLEARED (with an
    // empty list) — that is not a file, so it says nothing.
    onFileReject: (details) => {
      const rejected = details.files[0]
      if (!rejected) return
      setMessage({ tone: 'error', text: rejectionText(rejected.errors) })
    },
  })

  return (
    <div flex="~ col" h="full" overflow="hidden" bg="ui-bg-primary">
      {/* Header: count + upload */}
      <div
        flex="~"
        items="center"
        justify="between"
        p="2 3"
        bg="ui-bg-tertiary"
        border="b ui-border-primary"
      >
        <span text="xs ui-text-secondary">
          {list().length} {list().length === 1 ? 'skill' : 'skills'} visible to you
        </span>
        <FileUpload.RootProvider value={fileUpload}>
          <FileUpload.Trigger
            disabled={busy()}
            flex="~"
            items="center"
            gap="1"
            p="x-2 y-1"
            text="xs ui-text-primary"
            bg="transparent hover:ui-bg-hover"
            border="1 ui-border-secondary"
            rounded="md"
            cursor="pointer"
            ring="2 transparent focus-visible:ui-accent/40"
            transition="all"
          >
            <span class="i-material-symbols-upload-file-outline" w="4" h="4" aria-hidden="true" />
            Upload SKILL.md
          </FileUpload.Trigger>
          <FileUpload.HiddenInput data-testid="skill-upload-input" />
        </FileUpload.RootProvider>
      </div>

      {/* Outcome of the last action. One polite live region (A11Y
          contextual-live-badge-updates); an error also carries a glyph. */}
      <div role="status" aria-live="polite">
        <Show when={message()}>
          {(m) => (
            <div
              flex="~"
              items="start"
              gap="2"
              p="2 3"
              text={m().tone === 'error' ? 'xs ui-danger' : 'xs ui-success'}
              border="b ui-border-primary"
            >
              <span
                class={
                  m().tone === 'error'
                    ? 'i-material-symbols-warning-outline'
                    : 'i-material-symbols-check'
                }
                w="4"
                h="4"
                flex="shrink-0"
                aria-hidden="true"
              />
              <span>{m().text}</span>
            </div>
          )}
        </Show>
      </div>

      <div flex="1" overflow="auto" p="2">
        <Show
          when={!skills.error}
          fallback={
            <div text="xs ui-danger" p="2" role="alert">
              Skills could not be loaded.
            </div>
          }
        >
          <TreeView.Root
            collection={collection()}
            defaultExpandedValue={[GROUP_MINE, GROUP_GLOBAL]}
            selectedValue={selectedId() ? [selectedId()!] : []}
            onSelectionChange={(details) => {
              const id = details.selectedValue[0]
              // Selecting a branch row expands it; only a skill opens a detail.
              if (id && !id.startsWith('group:')) {
                setSelectedId(id)
                setPending(null)
              }
            }}
          >
            <TreeView.Label sr-only="">Skills</TreeView.Label>
            <TreeView.Tree flex="~ col" gap="0.5">
              <For each={collection().rootNode.children}>
                {(node, index) => (
                  <SkillTreeNode node={node} indexPath={[index()]} selectedId={selectedId()} />
                )}
              </For>
            </TreeView.Tree>
          </TreeView.Root>
        </Show>

        <Show when={selected()}>
          {(skill) => (
            <SkillDetail
              skill={skill()}
              content={content.loading ? undefined : (content() ?? null)}
              busy={busy()}
              pending={pending()}
              onAsk={(kind) => setPending({ kind, id: skill().id })}
              onCancel={() => setPending(null)}
              onToggleGlobal={() =>
                act(
                  () => setSkillGlobal(skill().id, !skill().isGlobal),
                  skill().isGlobal
                    ? `"${skill().name}" is private again.`
                    : `"${skill().name}" is now global.`,
                )
              }
              onToggleHidden={() =>
                act(
                  () => setSkillHidden(skill().id, !skill().hidden),
                  skill().hidden
                    ? `"${skill().name}" is back in your sandbox.`
                    : `"${skill().name}" is hidden.`,
                )
              }
              onDelete={() => {
                const { id, name } = skill()
                void act(async () => {
                  const r = await deleteSkill(id)
                  if (r.ok) setSelectedId(null)
                  return r
                }, `Deleted "${name}".`)
              }}
            />
          )}
        </Show>
      </div>
    </div>
  )
}

// ============================================================================
// One tree node — a branch (a group) or an item (a skill / placeholder)
// ============================================================================

const SkillTreeNode = (props: {
  node: SkillNode
  indexPath: number[]
  selectedId: string | null
}) => (
  <TreeView.NodeProvider node={props.node} indexPath={props.indexPath}>
    <Show
      when={props.node.children}
      fallback={
        <TreeView.Item
          flex="~"
          items="center"
          gap="2"
          p="x-2 y-1"
          rounded="md"
          text={props.node.placeholder ? 'xs ui-text-tertiary' : 'xs ui-text-primary'}
          cursor={props.node.placeholder ? 'default' : 'pointer'}
          bg={props.node.id === props.selectedId ? 'ui-bg-hover' : 'transparent hover:ui-bg-hover'}
          ring="2 transparent focus-visible:ui-accent/40"
          outline="none"
        >
          <Show
            when={props.node.skill}
            fallback={<TreeView.ItemText font="italic">{props.node.label}</TreeView.ItemText>}
          >
            {(skill) => <SkillRow skill={skill()} />}
          </Show>
        </TreeView.Item>
      }
    >
      <TreeView.Branch>
        <TreeView.BranchControl
          flex="~"
          items="center"
          gap="1"
          p="x-1 y-1"
          rounded="md"
          text="xs ui-text-secondary"
          font="semibold"
          cursor="pointer"
          bg="transparent hover:ui-bg-hover"
          ring="2 transparent focus-visible:ui-accent/40"
          outline="none"
        >
          <TreeView.BranchIndicator flex="~" items="center">
            <TreeView.NodeContext>
              {(node) => (
                <span
                  class={
                    node().expanded
                      ? 'i-material-symbols-expand-more'
                      : 'i-material-symbols-chevron-right'
                  }
                  w="4"
                  h="4"
                  aria-hidden="true"
                />
              )}
            </TreeView.NodeContext>
          </TreeView.BranchIndicator>
          <span
            class={
              props.node.id === GROUP_MINE
                ? 'i-material-symbols-folder-outline'
                : 'i-material-symbols-public'
            }
            w="4"
            h="4"
            aria-hidden="true"
          />
          <TreeView.BranchText>{props.node.label}</TreeView.BranchText>
        </TreeView.BranchControl>
        <TreeView.BranchContent flex="~ col" gap="0.5" pl="5">
          <For each={props.node.children}>
            {(child, index) => (
              <SkillTreeNode
                node={child}
                indexPath={[...props.indexPath, index()]}
                selectedId={props.selectedId}
              />
            )}
          </For>
        </TreeView.BranchContent>
      </TreeView.Branch>
    </Show>
  </TreeView.NodeProvider>
)

/** A skill's row: its name, and what about it needs to be visible at a glance. */
const SkillRow = (props: { skill: SkillView }) => (
  <>
    <span
      class="i-material-symbols-description-outline"
      w="4"
      h="4"
      flex="shrink-0"
      aria-hidden="true"
    />
    <TreeView.ItemText font="mono" truncate="">
      {props.skill.name}
    </TreeView.ItemText>
    <Show when={props.skill.mine && props.skill.isGlobal}>
      <span text="xs ui-accent" bg="ui-accent/10" p="x-1.5 y-0.5" rounded="sm" font="mono">
        global
      </span>
    </Show>
    <Show when={!props.skill.mine && props.skill.author}>
      <span text="xs ui-text-tertiary" truncate="">
        by {props.skill.author}
      </span>
    </Show>
    <Show when={props.skill.status !== 'mounted'}>
      <span
        text="xs ui-text-tertiary"
        bg="ui-text-tertiary/10"
        p="x-1.5 y-0.5"
        rounded="sm"
        font="mono"
      >
        {props.skill.status === 'hidden' ? 'hidden' : 'not mounted'}
      </span>
    </Show>
  </>
)

// ============================================================================
// The selected skill
// ============================================================================

const SkillDetail = (props: {
  skill: SkillView
  /** `undefined` while loading, `null` when unreadable. */
  content: string | null | undefined
  busy: boolean
  pending: Pending
  onAsk: (kind: 'delete' | 'global') => void
  onCancel: () => void
  onToggleGlobal: () => void
  onToggleHidden: () => void
  onDelete: () => void
}) => {
  const asking = (kind: 'delete' | 'global') =>
    props.pending?.kind === kind && props.pending.id === props.skill.id

  return (
    <section
      aria-label={`Skill ${props.skill.name}`}
      m="t-3"
      p="3"
      flex="~ col"
      gap="2"
      border="1 ui-border-primary"
      rounded="md"
      bg="ui-bg-secondary"
    >
      <div flex="~ col" gap="1">
        <span text="sm ui-text-primary" font="mono">
          {props.skill.name}
        </span>
        <span text="xs ui-text-secondary">{props.skill.description}</span>
        <span text="xs ui-text-tertiary">
          {props.skill.mine
            ? props.skill.isGlobal
              ? 'Yours · global: in every user’s sandbox unless they hide it.'
              : 'Yours · private: only in your sandbox.'
            : `Global · shared by ${props.skill.author ?? 'another user'}.`}
        </span>
        <span text="xs ui-text-tertiary">{statusText(props.skill)}</span>
      </div>

      {/* Actions */}
      <div flex="~ wrap" items="center" gap="2">
        <Show
          when={props.skill.mine}
          fallback={
            <ActionButton
              icon={
                props.skill.hidden
                  ? 'i-material-symbols-visibility-outline'
                  : 'i-material-symbols-visibility-off-outline'
              }
              label={props.skill.hidden ? 'Unhide' : 'Hide'}
              disabled={props.busy}
              onClick={props.onToggleHidden}
            />
          }
        >
          <Show
            when={props.skill.isGlobal}
            fallback={
              <ActionButton
                icon="i-material-symbols-public"
                label="Make global"
                disabled={props.busy || asking('global')}
                onClick={() => props.onAsk('global')}
              />
            }
          >
            <ActionButton
              icon="i-material-symbols-public-off"
              label="Make private"
              disabled={props.busy}
              onClick={props.onToggleGlobal}
            />
          </Show>
          <ActionButton
            icon="i-material-symbols-delete-outline"
            label="Delete"
            danger
            disabled={props.busy || asking('delete')}
            onClick={() => props.onAsk('delete')}
          />
        </Show>
      </div>

      <Show when={asking('global')}>
        <Confirm
          text={
            'Every other user’s sandbox will mount this skill and show its description to their ' +
            'agent, unless they hide it. They will see your name as its author.'
          }
          confirmLabel="Make global"
          busy={props.busy}
          onConfirm={props.onToggleGlobal}
          onCancel={props.onCancel}
        />
      </Show>
      <Show when={asking('delete')}>
        <Confirm
          text={
            'This removes the skill for you and for everyone it is shared with. Text an agent ' +
            'already read from it stays in those conversations.'
          }
          confirmLabel="Delete"
          danger
          busy={props.busy}
          onConfirm={props.onDelete}
          onCancel={props.onCancel}
        />
      </Show>

      {/* The file, as text */}
      <Show
        when={props.content !== undefined}
        fallback={<span text="xs ui-text-tertiary">Loading SKILL.md…</span>}
      >
        <Show
          when={props.content !== null}
          fallback={<span text="xs ui-danger">This skill’s file could not be read.</span>}
        >
          <pre
            aria-label="SKILL.md"
            m="0"
            p="2"
            max-h="64"
            overflow="auto"
            text="xs ui-text-primary"
            font="mono"
            bg="ui-bg-primary"
            border="1 ui-border-primary"
            rounded="md"
            style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word' }}
          >
            {props.content}
          </pre>
        </Show>
      </Show>
    </section>
  )
}

const ActionButton = (props: {
  icon: string
  label: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) => (
  <button
    type="button"
    onClick={() => props.onClick()}
    disabled={props.disabled}
    flex="~"
    items="center"
    gap="1"
    p="x-2 y-1"
    text={props.danger ? 'xs ui-danger' : 'xs ui-text-primary'}
    bg="transparent hover:ui-bg-hover"
    border={props.danger ? '1 ui-danger/40' : '1 ui-border-secondary'}
    rounded="md"
    cursor={props.disabled ? 'not-allowed' : 'pointer'}
    op={props.disabled ? '50' : '100'}
    ring="2 transparent focus-visible:ui-accent/40"
    transition="all"
  >
    <span class={props.icon} w="4" h="4" aria-hidden="true" />
    {props.label}
  </button>
)

const Confirm = (props: {
  text: string
  confirmLabel: string
  danger?: boolean
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) => (
  <div
    role="group"
    aria-label={`Confirm: ${props.confirmLabel}`}
    flex="~ col"
    gap="2"
    p="2"
    border="1 ui-border-secondary"
    rounded="md"
    bg="ui-bg-tertiary"
  >
    <span text="xs ui-text-secondary">{props.text}</span>
    <div flex="~" gap="2">
      <ActionButton
        icon={props.danger ? 'i-material-symbols-delete-outline' : 'i-material-symbols-check'}
        label={`Confirm: ${props.confirmLabel}`}
        danger={props.danger}
        disabled={props.busy}
        onClick={props.onConfirm}
      />
      <ActionButton
        icon="i-material-symbols-close"
        label="Cancel"
        disabled={props.busy}
        onClick={props.onCancel}
      />
    </div>
  </div>
)
