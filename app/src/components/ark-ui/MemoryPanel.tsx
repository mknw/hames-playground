import { For, Show, createResource, createSignal } from 'solid-js'
import { Dialog } from '@ark-ui/solid/dialog'
import { Switch } from '@ark-ui/solid/switch'
import { Tabs } from '@ark-ui/solid/tabs'
import {
  listMyMemories,
  forgetMemory,
  forgetAllMemories,
  setMemoryEnabled,
  exportMyMemories,
} from '../../lib/memory/actions.server'

const kinds = ['all', 'episodic', 'semantic', 'preference', 'trait'] as const

export function MemoryPanel() {
  const [data, { refetch }] = createResource(listMyMemories)
  const [kind, setKind] = createSignal<string>('all')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const [confirmOpen, setConfirmOpen] = createSignal(false)
  const rows = () => data()?.memories.filter((row) => kind() === 'all' || row.kind === kind()) ?? []
  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await action()
      await refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Memory action failed. Please retry.')
      await Promise.resolve(refetch()).catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }
  async function download() {
    const exported = await exportMyMemories()
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }),
    )
    try {
      const link = document.createElement('a')
      link.href = url
      link.download = 'my-memories.json'
      link.click()
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  return (
    <section
      aria-label="What I remember about you"
      p="4"
      flex="~ col"
      gap="4"
      text="sm ui-text-primary"
      overflow="y-auto"
      h="full"
    >
      <h2 text="lg" font="semibold">
        What I remember about you
      </h2>
      <p text="ui-text-secondary">
        Memory is off until you enable it. Turning it off deletes saved memories. Forget everything
        also turns memory off.
      </p>
      <p text="ui-text-secondary">
        Forget deletes rows; it does not reach the responder's recorded prompt or the nightly
        pg_dump.
      </p>
      <Show when={data.error}>
        <p role="alert">Unable to load memory. Please retry.</p>
        <button
          cyber-button
          ring="2 transparent focus-visible:ui-accent"
          onClick={() => void refetch()}
        >
          Retry
        </button>
      </Show>
      <Show when={data.loading}>
        <p role="status">Loading memories…</p>
      </Show>
      <Show when={!data.error && data()}>
        {(state) => (
          <>
            <Switch.Root
              ring="2 transparent focus-within:ui-accent"
              checked={state().enabled}
              disabled={busy()}
              onCheckedChange={(d) => void run(() => setMemoryEnabled(d.checked))}
              flex="~"
              items="center"
              gap="2"
            >
              <Switch.Label>Memory enabled</Switch.Label>
              <Switch.Control
                bg="ui-bg-tertiary"
                border="1 ui-border-primary"
                rounded="full"
                p="1"
                ring="2 transparent focus-within:ui-accent"
              >
                <Switch.Thumb text="ui-accent">{state().enabled ? 'On' : 'Off'}</Switch.Thumb>
              </Switch.Control>
              <Switch.HiddenInput />
            </Switch.Root>
            <div flex="~ wrap" gap="2">
              <button
                cyber-button
                ring="2 transparent focus-visible:ui-accent"
                disabled={busy()}
                onClick={() => void run(download)}
              >
                Export my memories (Art. 15)
              </button>
              <button
                cyber-button
                ring="2 transparent focus-visible:ui-accent"
                disabled={busy() || state().memories.length === 0}
                onClick={() => setConfirmOpen(true)}
              >
                Forget everything
              </button>
            </div>
            <Tabs.Root
              lazyMount
              unmountOnExit
              value={kind()}
              onValueChange={(d) => setKind(d.value)}
            >
              <Tabs.List flex="~ wrap" gap="2" aria-label="Memory kind">
                <For each={kinds}>
                  {(value) => (
                    <Tabs.Trigger
                      value={value}
                      p="2"
                      text="ui-text-primary"
                      border="b-2 ui-border-primary"
                      ring="2 transparent focus-visible:ui-accent"
                      style={{
                        'border-bottom-color':
                          kind() === value ? 'var(--ui-accent)' : 'transparent',
                      }}
                    >
                      {value}
                    </Tabs.Trigger>
                  )}
                </For>
              </Tabs.List>
              <For each={kinds}>
                {(value) => (
                  <Tabs.Content value={value}>
                    <Show when={rows().length} fallback={<p p="y-4">No saved memories.</p>}>
                      <ul flex="~ col" gap="3" p="y-3">
                        <For each={rows()}>
                          {(row) => (
                            <li
                              p="3"
                              border="1 ui-border-primary"
                              rounded="md"
                              flex="~ col"
                              gap="2"
                            >
                              <p style={{ 'white-space': 'pre-wrap' }}>{row.content}</p>
                              <p text="xs ui-text-secondary">
                                {row.kind} · {row.tier} · First seen{' '}
                                {new Date(row.createdAt).toLocaleDateString()} · Last seen{' '}
                                {new Date(row.lastSeenAt).toLocaleDateString()}
                              </p>
                              <Show when={row.compactedFrom > 0}>
                                <p text="xs ui-text-secondary">Merged from {row.compactedFrom}</p>
                              </Show>
                              <For each={row.sourceConversationIds}>
                                {(id) => (
                                  <a
                                    href={`/?c=${encodeURIComponent(id)}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    text="ui-accent underline"
                                  >
                                    Source conversation {id}
                                  </a>
                                )}
                              </For>
                              <button
                                cyber-button
                                ring="2 transparent focus-visible:ui-accent"
                                disabled={busy()}
                                aria-label={`Forget ${row.content}`}
                                onClick={() => void run(() => forgetMemory(row.id))}
                              >
                                Forget
                              </button>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </Tabs.Content>
                )}
              </For>
            </Tabs.Root>
          </>
        )}
      </Show>
      <Show when={error()}>
        <p role="alert" text="ui-danger">
          {error()} Please retry the action.
        </p>
      </Show>
      <Dialog.Root
        open={confirmOpen()}
        onOpenChange={(d) => {
          if (!busy()) setConfirmOpen(d.open)
        }}
      >
        <Dialog.Backdrop position="fixed" style={{ inset: '0' }} bg="ui-bg-primary/80" z="50" />
        <Dialog.Positioner
          position="fixed"
          style={{ inset: '0' }}
          flex="~"
          items="center"
          justify="center"
          z="50"
        >
          <Dialog.Content
            bg="ui-bg-secondary"
            text="ui-text-primary"
            border="1 ui-border-primary"
            rounded="lg"
            p="6"
            max-w="lg"
            flex="~ col"
            gap="4"
          >
            <Dialog.Title>Forget everything?</Dialog.Title>
            <Dialog.Description>
              This deletes all your saved memories and turns memory off. Recorded prompts and
              backups remain.
            </Dialog.Description>
            <button
              cyber-button
              ring="2 transparent focus-visible:ui-accent"
              disabled={busy()}
              onClick={() => setConfirmOpen(false)}
            >
              Cancel
            </button>
            <button
              cyber-button
              ring="2 transparent focus-visible:ui-accent"
              disabled={busy()}
              onClick={() =>
                void run(async () => {
                  await forgetAllMemories()
                  setConfirmOpen(false)
                })
              }
            >
              Confirm forget everything
            </button>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
    </section>
  )
}
