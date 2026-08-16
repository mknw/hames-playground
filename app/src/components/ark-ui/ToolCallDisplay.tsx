/**
 * ToolCallDisplay Component
 *
 * Collapsible display for tool calls (KG queries).
 * Renders SEPARATELY from message content for clear visual distinction.
 *
 * States:
 * - pending: Yellow indicator, shows Approve/Reject buttons
 * - executed: Green indicator, shows query + results
 * - error: Red indicator, shows error message
 */

import { Collapsible } from '@ark-ui/solid/collapsible'
import { Show } from 'solid-js'
import type { ToolCallInfo } from './types'

interface ToolCallDisplayProps {
  toolCall: ToolCallInfo
  onApprove?: () => void
  onReject?: () => void
}

export const ToolCallDisplay = (props: ToolCallDisplayProps) => {
  const getStatusColor = () => {
    switch (props.toolCall.status) {
      case 'executed':
        return 'neon-green'
      case 'pending':
        return 'neon-yellow'
      case 'error':
        return 'red-500'
      default:
        return 'dark-text-tertiary'
    }
  }

  const getToolLabel = () => {
    switch (props.toolCall.tool) {
      case 'read_neo4j_cypher':
        return 'KG: Read'
      case 'write_neo4j_cypher':
        return 'KG: Write'
      case 'get_schema':
        return 'KG: Schema'
      default:
        return props.toolCall.tool
    }
  }

  const getStatusLabel = () => {
    switch (props.toolCall.status) {
      case 'executed':
        return 'Executed'
      case 'pending':
        return 'Awaiting approval'
      case 'error':
        return 'Failed'
      default:
        return props.toolCall.status
    }
  }

  return (
    <div m="y-2">
      <Collapsible.Root>
        {/* Collapsed Header */}
        <Collapsible.Trigger
          w="full"
          p="2"
          bg="dark-bg-tertiary/50"
          border={`1 ${getStatusColor()}/30`}
          rounded="md"
          cursor="pointer"
          flex="~"
          items="center"
          gap="2"
          transition="all"
          hover:bg="dark-bg-tertiary"
          text="left"
        >
          {/* Status indicator dot */}
          <div
            w="2"
            h="2"
            rounded="full"
            bg={getStatusColor()}
            shadow={`[0_0_8px_var(--un-shadow-color)]`}
            style={{ '--un-shadow-color': `var(--color-${getStatusColor()})` }}
          />

          {/* Tool name */}
          <div text={`xs ${getStatusColor()}`} font="mono medium">
            {getToolLabel()}
          </div>

          {/* Summary info */}
          <div text="xs dark-text-tertiary" flex="1">
            <Show
              when={props.toolCall.status === 'executed' && props.toolCall.result}
              fallback={getStatusLabel()}
            >
              {props.toolCall.result!.nodeCount} nodes, {props.toolCall.result!.relationshipCount} rels
            </Show>
          </div>

          {/* Chevron indicator */}
          <Collapsible.Indicator>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              style={{ transition: 'transform 0.2s' }}
              data-state-open:style={{ transform: 'rotate(90deg)' }}
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          </Collapsible.Indicator>
        </Collapsible.Trigger>

        {/* Expanded Content */}
        <Collapsible.Content
          bg="dark-bg-secondary"
          border="1 dark-border-secondary"
          border-t="0"
          rounded-b="md"
          overflow="hidden"
        >
          <div p="3" space="y-3">
            {/* Cypher Query */}
            <Show when={props.toolCall.cypher}>
              <div>
                <div text="xs dark-text-tertiary" m="b-1" font="medium">
                  Cypher Query
                </div>
                <pre
                  bg="dark-bg-tertiary"
                  p="2"
                  rounded="md"
                  text="xs neon-cyan"
                  font="mono"
                  overflow-x="auto"
                  white-space="pre-wrap"
                  break-words
                >
                  {props.toolCall.cypher}
                </pre>
              </div>
            </Show>

            {/* Results (for executed queries) */}
            <Show when={props.toolCall.status === 'executed' && props.toolCall.result?.raw}>
              <div>
                <div text="xs dark-text-tertiary" m="b-1" font="medium">
                  Results
                </div>
                <pre
                  bg="dark-bg-tertiary"
                  p="2"
                  rounded="md"
                  text="xs dark-text-secondary"
                  font="mono"
                  max-h="200px"
                  overflow="auto"
                  white-space="pre-wrap"
                >
                  {JSON.stringify(props.toolCall.result?.raw, null, 2)}
                </pre>
              </div>
            </Show>

            {/* Error (for failed queries) */}
            <Show when={props.toolCall.status === 'error' && props.toolCall.error}>
              <div>
                <div text="xs red-500" m="b-1" font="medium">
                  Error
                </div>
                <pre
                  bg="red-900/20"
                  border="1 red-500/30"
                  p="2"
                  rounded="md"
                  text="xs red-400"
                  font="mono"
                >
                  {props.toolCall.error}
                </pre>
              </div>
            </Show>

            {/* Approval buttons (for pending writes) */}
            <Show when={props.toolCall.status === 'pending'}>
              <div flex="~" gap="2" m="t-2">
                <button
                  onClick={() => props.onApprove?.()}
                  p="x-4 y-2"
                  text="sm dark-text-primary"
                  bg="green-600/20 hover:green-600/30"
                  border="1 green-500/50"
                  rounded="md"
                  cursor="pointer"
                  transition="all"
                  font="medium"
                  flex="~"
                  items="center"
                  gap="1"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  Approve
                </button>
                <button
                  onClick={() => props.onReject?.()}
                  p="x-4 y-2"
                  text="sm dark-text-primary"
                  bg="red-600/20 hover:red-600/30"
                  border="1 red-500/50"
                  rounded="md"
                  cursor="pointer"
                  transition="all"
                  font="medium"
                  flex="~"
                  items="center"
                  gap="1"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                  Reject
                </button>
              </div>
            </Show>
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>
  )
}
