/**
 * AgentSelector Component
 *
 * Dropdown to select which agent/harness to use.
 */

import { createSignal, createResource, For, Show } from 'solid-js'
import { getAgentList } from '~/lib/harness-client'
import { accentColor } from '~/lib/agent-palette'

// ============================================================================
// Types
// ============================================================================

export interface AgentSelectorProps {
  selectedAgent: string
  onAgentChange: (agentId: string) => void
  disabled?: boolean
}

// ============================================================================
// Component
// ============================================================================

export const AgentSelector = (props: AgentSelectorProps) => {
  const [isOpen, setIsOpen] = createSignal(false)

  // Fetch agent metadata from server
  const [agents] = createResource(async () => {
    try {
      return await getAgentList()
    } catch (error) {
      console.error('Failed to fetch agents:', error)
      return []
    }
  })

  const selectedAgentInfo = () => {
    const list = agents()
    if (!list) return null
    return list.find(a => a.id === props.selectedAgent) || list[0]
  }

  const handleSelect = (agentId: string) => {
    props.onAgentChange(agentId)
    setIsOpen(false)
  }

  return (
    <div class="relative" w="full">
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => !props.disabled && setIsOpen(!isOpen())}
        disabled={props.disabled}
        flex="~ items-center gap-2"
        w="full"
        px="3"
        py="2"
        bg="dark-bg-tertiary hover:dark-bg-primary"
        border="~ dark-border-primary rounded-lg"
        text="sm dark-text-primary"
        cursor={props.disabled ? 'not-allowed' : 'pointer'}
        opacity={props.disabled ? '50' : '100'}
        transition="all"
      >
        <Show when={selectedAgentInfo()} fallback={<span text="dark-text-secondary">Loading agents...</span>}>
          {(info) => (
            <>
              {/* Iconify class from the registry — needs class= + inline
                  sizing (attributify doesn't extract dynamic values). The
                  accent-family colour is inline for the same reason. */}
              <span
                class={info().icon}
                aria-hidden="true"
                style={{
                  width: '18px',
                  height: '18px',
                  color: accentColor(info().accent),
                  'flex-shrink': 0,
                }}
              />
              <span flex="1" text="left">{info().name}</span>
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                class={`h-4 w-4 transform transition-transform ${isOpen() ? 'rotate-180' : ''}`}
              >
                <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
              </svg>
            </>
          )}
        </Show>
      </button>

      {/* Dropdown Menu */}
      <Show when={isOpen()}>
        <div
          class="mt-1 border border-dark-border-primary rounded-lg bg-dark-bg-tertiary max-h-80 w-full shadow-lg left-0 top-full absolute z-50 overflow-auto"
        >
          <Show when={agents.loading}>
            <div p="4" text="center dark-text-secondary">
              Loading...
            </div>
          </Show>

          <Show when={agents()}>
            <For each={agents()}>
              {(agent) => (
                <button
                  type="button"
                  onClick={() => handleSelect(agent.id)}
                  flex="~ items-start gap-3"
                  w="full"
                  px="3"
                  py="2"
                  text="left"
                  bg={agent.id === props.selectedAgent ? 'neon-cyan/10' : 'hover:dark-bg-primary'}
                  border={agent.id === props.selectedAgent ? 'l-2 neon-cyan' : 'l-2 transparent'}
                  transition="all"
                >
                  <span
                    class={agent.icon}
                    aria-hidden="true"
                    mt="0.5"
                    style={{
                      width: '20px',
                      height: '20px',
                      color: accentColor(agent.accent),
                      'flex-shrink': 0,
                    }}
                  />
                  <div flex="~ col" overflow="hidden">
                    <span text="sm dark-text-primary font-medium" truncate>
                      {agent.name}
                    </span>
                    <span text="xs dark-text-secondary" line-clamp="2">
                      {agent.description}
                    </span>
                    <div flex="~ wrap gap-1" mt="1">
                      <For each={agent.servers.slice(0, 3)}>
                        {(server) => (
                          <span
                            text="2xs dark-text-tertiary"
                            bg="dark-bg-primary"
                            px="1.5"
                            py="0.5"
                            rounded="full"
                          >
                            {server}
                          </span>
                        )}
                      </For>
                      <Show when={agent.servers.length > 3}>
                        <span text="2xs dark-text-tertiary">+{agent.servers.length - 3}</span>
                      </Show>
                    </div>
                  </div>
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>

      {/* Backdrop to close dropdown */}
      <Show when={isOpen()}>
        <div
          class="inset-0 fixed z-40"
          onClick={() => setIsOpen(false)}
        />
      </Show>
    </div>
  )
}
