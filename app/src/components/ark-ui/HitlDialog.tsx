/**
 * HitlDialog — the Review dialog every HITL surface opens (#433 S8).
 *
 * The toast, the card under the reply and the header inbox all end here, so the
 * confirmation is ONE component. It is presentational: the controller
 * (`MemoryProposalPrompt`) owns the selection, the answer RPC and the bound
 * answer, and passes them in. Today its body is the `memory.confirm` list; a
 * `provenance` body arrives with its producer (#433 S10a) and is chosen by
 * `kind` here.
 *
 * Every string shown is model-derived from the person's own message, so it is
 * untrusted. It is rendered as a text node and never as markup, and the server
 * has already stripped what a text node cannot defend against (`displayText`).
 * Escape or the backdrop closes the dialog and DECIDES NOTHING (A11Y
 * `escape-routes`): the request stays pending.
 */
import { Checkbox } from '@ark-ui/solid/checkbox'
import { Dialog } from '@ark-ui/solid/dialog'
import { For, Show } from 'solid-js'
import type { MemoryProposalView } from '~/lib/memory/proposals.server'

const EFFECT_COPY = {
  new: 'New memory',
  reinforces: 'Already remembered',
  updates: 'Replaces an older memory',
} as const

export interface HitlDialogProps {
  open: boolean
  /** Close WITHOUT deciding. */
  onClose: () => void
  proposal: MemoryProposalView | undefined
  busy: boolean
  notice: string | null
  isChecked: (p: MemoryProposalView, ref: string) => boolean
  /** The answer already bound server-side to this proposal, if any. */
  bound: (p: MemoryProposalView) => string | null
  selectedCount: number
  onToggle: (requestId: string, ref: string, checked: boolean) => void
  onAnswer: (choice: 'save' | 'discard') => void
}

export function HitlDialog(props: HitlDialogProps) {
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(d) => {
        // Closing decides nothing: the notice stays until a choice is made.
        if (!d.open && !props.busy) props.onClose()
      }}
      lazyMount
      unmountOnExit
    >
      <Dialog.Backdrop
        style={{
          position: 'fixed',
          inset: '0',
          'z-index': '40',
          background: 'rgba(0, 0, 0, 0.5)',
        }}
      />
      <Dialog.Positioner
        style={{
          position: 'fixed',
          inset: '0',
          'z-index': '50',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
        }}
      >
        <Dialog.Content
          data-testid="memory-proposal-dialog"
          bg="ui-bg-secondary"
          border="1 ui-border-primary"
          rounded="lg"
          shadow="2xl"
          p="5"
          m="4"
          style={{ 'max-width': '34rem', width: '100%', 'max-height': '90vh', overflow: 'auto' }}
        >
          <Dialog.Title text="sm ui-text-primary" font="medium">
            Save to memory?
          </Dialog.Title>
          <Dialog.Description text="xs ui-text-secondary" m="t-2" style={{ 'line-height': '1.5' }}>
            These were taken from what you said. Nothing is saved until you choose.
          </Dialog.Description>

          <Show when={props.proposal}>
            {(p) => (
              <ul m="t-4" p="0" flex="~ col" gap="3" style={{ 'list-style': 'none' }}>
                <For each={p().items}>
                  {(item) => (
                    <li border="1 ui-border-secondary" rounded="md" p="3" bg="ui-bg-tertiary">
                      <Checkbox.Root
                        checked={props.isChecked(p(), item.ref)}
                        disabled={props.bound(p()) !== null}
                        onCheckedChange={(d) =>
                          props.onToggle(p().requestId, item.ref, d.checked === true)
                        }
                        data-testid={`memory-proposal-item-${item.ref}`}
                        flex="~"
                        gap="2"
                        items="start"
                      >
                        <Checkbox.Control
                          w="4"
                          h="4"
                          m="t-0.5"
                          flex="~"
                          items="center"
                          justify="center"
                          border="1 ui-border-primary"
                          rounded="sm"
                          style={{ 'flex-shrink': 0 }}
                        >
                          <Checkbox.Indicator>
                            <span
                              class="i-material-symbols-check-small"
                              w="4"
                              h="4"
                              text="ui-accent"
                              aria-hidden="true"
                            />
                          </Checkbox.Indicator>
                        </Checkbox.Control>
                        <div flex="~ col" gap="1" style={{ 'min-width': 0 }}>
                          <Checkbox.Label text="sm ui-text-primary">
                            <span
                              text="xs ui-text-primary"
                              border="1 ui-accent/50"
                              p="x-1.5 y-0.5"
                              rounded="sm"
                              font="mono"
                              m="r-2"
                            >
                              {item.kind}
                            </span>
                            {item.content}
                          </Checkbox.Label>
                          <span text="xs ui-text-secondary">
                            from your message: “{item.evidence}”
                          </span>
                          <span text="xs ui-text-secondary">
                            {EFFECT_COPY[item.effect]}
                            <Show when={item.previous}>{(prev) => <>: “{prev()}”</>}</Show>
                          </span>
                        </div>
                        <Checkbox.HiddenInput />
                      </Checkbox.Root>
                    </li>
                  )}
                </For>
              </ul>
            )}
          </Show>

          <Show when={props.notice}>
            <p text="xs ui-danger" m="t-3" role="alert">
              {props.notice}
            </p>
          </Show>

          <div flex="~" gap="2" justify="end" m="t-4">
            <button
              type="button"
              data-testid="memory-proposal-discard"
              onClick={() => props.onAnswer('discard')}
              disabled={props.busy || (!!props.proposal && props.bound(props.proposal) === 'save')}
              p="x-3 y-1.5"
              text="xs ui-text-secondary"
              bg="transparent hover:ui-bg-hover"
              border="1 ui-border-secondary"
              rounded="md"
              cursor="pointer"
            >
              Don't save
            </button>
            <button
              type="button"
              data-testid="memory-proposal-save"
              cyber-button=""
              onClick={() => props.onAnswer('save')}
              disabled={
                props.busy ||
                !props.proposal ||
                props.bound(props.proposal) === 'discard' ||
                props.selectedCount === 0
              }
              p="x-3 y-1.5"
              text="xs"
            >
              Save selected
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  )
}
