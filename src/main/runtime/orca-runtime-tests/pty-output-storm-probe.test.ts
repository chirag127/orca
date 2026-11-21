// TEMPORARY measurement probe (not for merge): main-side cost of an agent output storm across many PTYs.
import { describe, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'
// @ts-expect-error -- benchmark helper is plain ESM JS
import { buildFixture } from '../../../../tests/tools/benchmarks/terminal-pipeline-bench.mjs'
import { advertisedUrlWatcher } from '../../ports/advertised-url-watcher'

const PTYS = Number(process.env.STORM_PTYS ?? 150)
const BYTES_PER_PTY = Number(process.env.STORM_BYTES ?? 256 * 1024)
const CHUNK = 4096

async function buildRuntime(): Promise<OrcaRuntimeService> {
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => ({ cols: 120, rows: 40 })
  })
  runtime.attachWindow(1)
  await runtime.syncWindowGraph(1, {
    tabs: Array.from({ length: PTYS }, (_, i) => ({
      tabId: `tab-${i}`,
      worktreeId: TEST_WORKTREE_ID,
      title: 'agent',
      activeLeafId: `pane:${i}`,
      layout: null
    })),
    leaves: Array.from({ length: PTYS }, (_, i) => ({
      tabId: `tab-${i}`,
      worktreeId: TEST_WORKTREE_ID,
      leafId: `pane:${i}`,
      paneRuntimeId: i + 1,
      ptyId: `pty-${i}`,
      paneTitle: null
    }))
  })
  return runtime
}

async function drain(runtime: OrcaRuntimeService): Promise<void> {
  const map = (runtime as unknown as { headlessTerminals: Map<string, { writeChain: Promise<void> }> })
    .headlessTerminals
  await Promise.all([...map.values()].map((s) => s.writeChain))
}

async function run(label: string, mutate?: (runtime: OrcaRuntimeService) => void): Promise<void> {
  const runtime = await buildRuntime()
  mutate?.(runtime)
  const fixture: string = buildFixture('agent-tui', BYTES_PER_PTY, 120, 40)
  const chunks: string[] = []
  for (let o = 0; o < fixture.length; o += CHUNK) {
    chunks.push(fixture.slice(o, o + CHUNK))
  }
  const h = monitorEventLoopDelay({ resolution: 1 })
  h.enable()
  const cpu0 = process.cpuUsage()
  const t0 = performance.now()
  let at = 1
  let syncMs = 0
  for (const chunk of chunks) {
    for (let p = 0; p < PTYS; p++) {
      const s = performance.now()
      runtime.onPtyData(`pty-${p}`, chunk, at++)
      syncMs += performance.now() - s
    }
    // Let queued model writes run between rounds like real socket reads.
    await new Promise((resolve) => setImmediate(resolve))
  }
  await drain(runtime)
  const wallMs = performance.now() - t0
  const cpu = process.cpuUsage(cpu0)
  h.disable()
  const mb = (fixture.length * PTYS) / 1024 / 1024
  console.log(
    `[storm] ${label}: ptys=${PTYS} total=${mb.toFixed(1)}MiB wall=${wallMs.toFixed(0)}ms onPtyDataSync=${syncMs.toFixed(0)}ms cpu=${((cpu.user + cpu.system) / 1000).toFixed(0)}ms loopMax=${(h.max / 1e6).toFixed(1)}ms p99=${(h.percentile(99) / 1e6).toFixed(1)}ms MiB/s=${(mb / (wallMs / 1000)).toFixed(1)}`
  )
}

describe('pty output storm probe', () => {
  it(
    'measures main-side ingestion cost',
    async () => {
      await run('warmup')
      await run('full')
      await run('no-headless', (runtime) => {
        ;(runtime as unknown as { trackHeadlessTerminalData: () => void }).trackHeadlessTerminalData =
          () => {}
      })
      const originalIngest = advertisedUrlWatcher.ingest.bind(advertisedUrlWatcher)
      advertisedUrlWatcher.ingest = () => {}
      await run('no-url')
      await run('no-headless-no-url', (runtime) => {
        ;(runtime as unknown as { trackHeadlessTerminalData: () => void }).trackHeadlessTerminalData =
          () => {}
      })
      advertisedUrlWatcher.ingest = originalIngest
      await run('full-again')
    },
    600_000
  )
})
