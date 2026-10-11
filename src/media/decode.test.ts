import { describe, expect, it } from 'vitest'
import { planVideoSampling } from './decode'
import { DEFAULT_SETTINGS, type Settings } from '../settings'

function settingsWith(patch: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

describe('planVideoSampling', () => {
  it('samples ~8 frames per 16s segment for a short video', () => {
    const plan = planVideoSampling(600, settingsWith({ videoSegmentSec: 16 }))
    expect(plan.segmentSeconds).toBe(16)
    expect(plan.interval).toBe(2)
    expect(plan.framesPerSegment).toBe(8)
  })

  it('honours an 8s segment setting with 1s sampling', () => {
    const plan = planVideoSampling(600, settingsWith({ videoSegmentSec: 8 }))
    expect(plan.segmentSeconds).toBe(8)
    expect(plan.interval).toBe(1)
    expect(plan.framesPerSegment).toBe(8)
  })

  it('spreads ~120 segments over long videos instead of sampling every second', () => {
    const plan = planVideoSampling(3600, settingsWith({ videoSegmentSec: 16 }))
    expect(plan.segmentSeconds).toBe(30)
    expect(plan.interval).toBe(3.75)
    expect(plan.framesPerSegment).toBe(8)
    // ~960 seeks for a 1h video, vs ~1800 with the old fixed stride
    expect(Math.ceil((3600 - 0.5) / plan.interval)).toBeLessThanOrEqual(960)
  })

  it('never samples faster than every 0.5s', () => {
    const plan = planVideoSampling(4, settingsWith({ videoSegmentSec: 8 }))
    expect(plan.interval).toBeGreaterThanOrEqual(0.5)
  })
})
