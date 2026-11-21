// TEMPORARY measurement probe (not for merge): cost of one background visible-screen read, ANSI snapshot path vs daemon projection.
import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { HeadlessEmulator } from './headless-emulator'
import { projectTerminalVisibleLines } from './terminal-screen-projection'
// @ts-expect-error -- benchmark helper is plain ESM JS
import { buildFixture } from '../../../../tests/tools/benchmarks/terminal-pipeline-bench.mjs'

const READS = Number(process.env.READ_PROBE_READS ?? 300)
const SIZES = [
  { cols: 120, rows: 40 },
  { cols: 200, rows: 50 },
  { cols: 300, rows: 80 }
]

async function oldPath(daemon: HeadlessEmulator): Promise<{ lines: string[]; daemonMs: number; wireBytes: number; mainMs: number }> {
  const d0 = performance.now()
  const snap = daemon.getSnapshot({ scrollbackRows: 0 })
  const wire = JSON.stringify({ snapshot: snap })
  const daemonMs = performance.now() - d0
  const m0 = performance.now()
  const got = JSON.parse(wire).snapshot
  const data = got.rehydrateSequences + got.snapshotAnsi
  const emulator = new HeadlessEmulator({ cols: got.cols, rows: got.rows, scrollback: 0 })
  try {
    await emulator.write(`\x1b[2J\x1b[3J\x1b[H${data}`)
    const projection = projectTerminalVisibleLines(emulator)
    return { lines: projection.lines, daemonMs, wireBytes: wire.length, mainMs: performance.now() - m0 }
  } finally {
    emulator.dispose()
  }
}

function newPath(daemon: HeadlessEmulator): { lines: string[]; daemonMs: number; wireBytes: number; mainMs: number } {
  const d0 = performance.now()
  const wire = JSON.stringify({
    snapshot: { ...daemon.getSnapshotMetadata(), visibleProjection: projectTerminalVisibleLines(daemon), outputSequence: 1 }
  })
  const daemonMs = performance.now() - d0
  const m0 = performance.now()
  const got = JSON.parse(wire).snapshot
  return { lines: got.visibleProjection.lines, daemonMs, wireBytes: wire.length, mainMs: performance.now() - m0 }
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

describe('visible read probe', () => {
  it('measures one provider visible read per path', async () => {
    for (const size of SIZES) {
      const daemon = new HeadlessEmulator({ ...size, scrollback: 1000 })
      await daemon.write(buildFixture('agent-tui', 128 * 1024, size.cols, size.rows))
      const parity = await oldPath(daemon)
      expect(newPath(daemon).lines).toEqual(parity.lines)
      for (let round = 0; round < 5; round++) {
        const o = { d: [] as number[], m: [] as number[], w: 0 }
        const n = { d: [] as number[], m: [] as number[], w: 0 }
        for (let i = 0; i < READS; i++) {
          const a = await oldPath(daemon)
          o.d.push(a.daemonMs)
          o.m.push(a.mainMs)
          o.w = a.wireBytes
          const b = newPath(daemon)
          n.d.push(b.daemonMs)
          n.m.push(b.mainMs)
          n.w = b.wireBytes
        }
        console.log(
          `[read-probe] ${size.cols}x${size.rows} round=${round} lines=${parity.lines.length} old: main=${median(o.m).toFixed(3)}ms daemon=${median(o.d).toFixed(3)}ms wire=${o.w}B | new: main=${median(n.m).toFixed(3)}ms daemon=${median(n.d).toFixed(3)}ms wire=${n.w}B`
        )
      }
      daemon.dispose()
    }
  }, 600_000)
})
