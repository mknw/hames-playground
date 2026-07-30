/**
 * Settings FloatingPanel — configurable harness parameters.
 *
 * Self-contained: includes FloatingPanel.Root + trigger button.
 * Parent just renders <SettingsPanel />.
 */
import { For } from 'solid-js'
import { FloatingPanel } from '@ark-ui/solid/floating-panel'
import { Slider } from '@ark-ui/solid/slider'
import { NumberInput } from '@ark-ui/solid/number-input'
import { getSettings, updateSetting, resetSettings } from '../../lib/settings-store'
import { MODEL_CONTEXT_WINDOWS, DEFAULT_SETTINGS, type HarnessSettings } from '../../lib/settings'

// ---------------------------------------------------------------------------
// Slider setting row
// ---------------------------------------------------------------------------
function SliderSetting(props: {
  label: string
  settingKey: keyof HarnessSettings
  min: number
  max: number
  step?: number
}) {
  return (
    <Slider.Root
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      value={[getSettings()[props.settingKey] as number]}
      onValueChange={(details) => {
        updateSetting(props.settingKey, details.value[0])
      }}
    >
      <div flex="~" justify="between" items="center" m="b-1">
        <Slider.Label text="xs dark-text-secondary">{props.label}</Slider.Label>
        <Slider.ValueText text="xs cyan-400" font="mono" />
      </div>
      <Slider.Control flex="~" items="center" h="5">
        <Slider.Track
          flex="1"
          h="1"
          bg="dark-bg-tertiary"
          rounded="full"
          style={{ position: 'relative' }}
        >
          <Slider.Range
            h="full"
            bg="cyan-500"
            rounded="full"
            style={{ position: 'absolute', left: '0', top: '0' }}
          />
        </Slider.Track>
        <Slider.Thumb
          index={0}
          w="3.5"
          h="3.5"
          bg="cyan-400"
          rounded="full"
          border="2 dark-bg-primary"
          shadow="sm"
          cursor="pointer"
          style={{ position: 'absolute' }}
        />
      </Slider.Control>
    </Slider.Root>
  )
}

// ---------------------------------------------------------------------------
// NumberInput setting row
// ---------------------------------------------------------------------------
function NumberSetting(props: {
  label: string
  settingKey: keyof HarnessSettings
  min: number
  max: number
  step?: number
}) {
  return (
    <NumberInput.Root
      min={props.min}
      max={props.max}
      step={props.step ?? 100}
      value={String(getSettings()[props.settingKey])}
      onValueChange={(details) => {
        const n = details.valueAsNumber
        if (!Number.isNaN(n)) {
          updateSetting(props.settingKey, n)
        }
      }}
    >
      <NumberInput.Label text="xs dark-text-secondary" m="b-1" style={{ display: 'block' }}>
        {props.label}
      </NumberInput.Label>
      <NumberInput.Control flex="~" items="center" gap="1">
        <NumberInput.DecrementTrigger
          p="x-2 y-1"
          bg="dark-bg-tertiary hover:dark-bg-primary"
          border="1 dark-border-primary"
          rounded="md"
          text="xs dark-text-primary"
          cursor="pointer"
        >
          -
        </NumberInput.DecrementTrigger>
        <NumberInput.Input
          flex="1"
          p="x-2 y-1"
          bg="dark-bg-tertiary"
          border="1 dark-border-primary"
          rounded="md"
          text="xs cyan-400 center"
          font="mono"
          outline="none"
          style={{ 'min-width': '0' }}
        />
        <NumberInput.IncrementTrigger
          p="x-2 y-1"
          bg="dark-bg-tertiary hover:dark-bg-primary"
          border="1 dark-border-primary"
          rounded="md"
          text="xs dark-text-primary"
          cursor="pointer"
        >
          +
        </NumberInput.IncrementTrigger>
      </NumberInput.Control>
    </NumberInput.Root>
  )
}

// ---------------------------------------------------------------------------
// Model context window info
// ---------------------------------------------------------------------------
const modelEntries = Object.entries(MODEL_CONTEXT_WINDOWS).map(([name, tokens]) => ({
  name,
  tokens,
  display: tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(0)}M` : `${(tokens / 1_000).toFixed(0)}K`,
}))

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function SettingsPanel() {
  return (
    <FloatingPanel.Root
      strategy="fixed"
      defaultSize={{ width: 380, height: 520 }}
      minSize={{ width: 300, height: 300 }}
      persistRect
      draggable
      resizable
      closeOnEscape
    >
      {/* Trigger: gear icon button */}
      <FloatingPanel.Trigger
        p="2"
        bg="dark-bg-tertiary hover:cyber-700"
        border="1 dark-border-primary hover:dark-border-secondary"
        rounded="md"
        cursor="pointer"
        transition="all"
        title="Settings"
        flex="~"
        items="center"
        justify="center"
      >
        <span class="i-mdi-cog-outline" style={{ width: '18px', height: '18px', color: '#a1a1aa' }} />
      </FloatingPanel.Trigger>

      {/* Panel */}
      <FloatingPanel.Positioner style={{ 'z-index': '50' }}>
        <FloatingPanel.Content
          bg="dark-bg-secondary/95"
          border="1 dark-border-primary"
          rounded="lg"
          shadow="lg"
          overflow="hidden"
          flex="~ col"
          style={{ 'backdrop-filter': 'blur(8px)' }}
        >
          {/* Header */}
          <FloatingPanel.Header
            flex="~"
            items="center"
            justify="between"
            p="2 3"
            bg="dark-bg-tertiary"
            border="b dark-border-primary"
            cursor="default"
          >
            <FloatingPanel.DragTrigger flex="1 ~" items="center" gap="2" cursor="grab">
              <span class="i-mdi-drag" style={{ width: '16px', height: '16px', color: '#71717a' }} />
              <span text="sm dark-text-primary" font="medium">Settings</span>
            </FloatingPanel.DragTrigger>
          </FloatingPanel.Header>

          {/* Close button — top-right corner */}
          <FloatingPanel.CloseTrigger
            style={{ position: 'absolute', top: '6px', right: '6px', 'z-index': '10' }}
            p="1"
            rounded="sm"
            cursor="pointer"
            bg="hover:dark-bg-primary"
            text="dark-text-tertiary hover:dark-text-primary"
            title="Close"
          >
            <span class="i-mdi-close" style={{ width: '12px', height: '12px' }} />
          </FloatingPanel.CloseTrigger>

          {/* Body */}
          <FloatingPanel.Body flex="1" overflow="y-auto" p="3" style={{ display: 'flex', 'flex-direction': 'column', gap: '16px' }}>

            {/* Loop Settings */}
            <div>
              <div text="xs dark-text-tertiary uppercase" font="semibold" m="b-2" style={{ 'letter-spacing': '0.05em' }}>
                Loop Settings
              </div>
              <div flex="~ col" gap="3">
                <SliderSetting label="Max Tool Turns" settingKey="maxToolTurns" min={1} max={15} />
                <SliderSetting label="Prior Turn Count" settingKey="priorTurnCount" min={1} max={10} />
              </div>
            </div>

            {/* Retry & Routing */}
            <div>
              <div text="xs dark-text-tertiary uppercase" font="semibold" m="b-2" style={{ 'letter-spacing': '0.05em' }}>
                Retry & Routing
              </div>
              <div flex="~ col" gap="3">
                <SliderSetting label="Max Retries" settingKey="maxRetries" min={1} max={10} />
                <SliderSetting label="Router Turn Window" settingKey="routerTurnWindow" min={1} max={20} />
              </div>
            </div>

            {/* Concurrency (#105) */}
            <div>
              <div text="xs dark-text-tertiary uppercase" font="semibold" m="b-2" style={{ 'letter-spacing': '0.05em' }}>
                Concurrency
              </div>
              <div flex="~ col" gap="3">
                <SliderSetting label="Max Concurrent Runs" settingKey="maxConcurrentRuns" min={1} max={10} />
              </div>
            </div>

            {/* Result Limits */}
            <div>
              <div text="xs dark-text-tertiary uppercase" font="semibold" m="b-2" style={{ 'letter-spacing': '0.05em' }}>
                Result Limits
              </div>
              <div flex="~ col" gap="3">
                <NumberSetting label="Max Result Chars" settingKey="maxResultChars" min={500} max={10000} step={500} />
                <NumberSetting label="Max Result for Summary" settingKey="maxResultForSummary" min={500} max={10000} step={500} />
              </div>
            </div>

            {/* Model Context Windows (read-only) */}
            <div>
              <div text="xs dark-text-tertiary uppercase" font="semibold" m="b-2" style={{ 'letter-spacing': '0.05em' }}>
                Model Context Windows
              </div>
              <div
                bg="dark-bg-tertiary/50"
                border="1 dark-border-primary"
                rounded="md"
                p="2"
                style={{ display: 'grid', 'grid-template-columns': '1fr auto', gap: '2px 12px' }}
              >
                <For each={modelEntries}>
                  {(entry) => (
                    <>
                      <span text="xs dark-text-secondary">{entry.name}</span>
                      <span text="xs cyan-400" font="mono">{entry.display}</span>
                    </>
                  )}
                </For>
              </div>
            </div>

            {/* Reset */}
            <button
              w="full"
              p="y-2"
              bg="dark-bg-tertiary hover:red-900/30"
              border="1 dark-border-primary hover:red-500/30"
              rounded="md"
              text="xs dark-text-secondary hover:red-400"
              cursor="pointer"
              transition="all"
              onClick={() => resetSettings()}
            >
              Reset to Defaults
            </button>
          </FloatingPanel.Body>

          {/* Resize handle */}
          <FloatingPanel.ResizeTrigger
            axis="se"
            style={{
              position: 'absolute',
              bottom: '0',
              right: '0',
              width: '16px',
              height: '16px',
              cursor: 'se-resize',
              display: 'flex',
              'align-items': 'flex-end',
              'justify-content': 'flex-end',
              padding: '2px',
            }}
          >
            <span style={{
              width: '8px',
              height: '8px',
              'border-right': '2px solid #52525b',
              'border-bottom': '2px solid #52525b',
            }} />
          </FloatingPanel.ResizeTrigger>
        </FloatingPanel.Content>
      </FloatingPanel.Positioner>
    </FloatingPanel.Root>
  )
}
