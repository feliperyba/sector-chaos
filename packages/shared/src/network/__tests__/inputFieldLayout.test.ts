import { describe, it, expect } from 'vitest';
import {
  InputRingBuffer,
  INPUT_FIELD_OFFSET,
  INPUT_FRAME_STRIDE,
  MAX_SUBSTEPS_PER_RECORD,
  SUBSTEP_DIR_X_OFFSET,
  SUBSTEP_DIR_Y_OFFSET,
  decodeFrameInto,
} from '../InputRingBuffer.js';
import type { RingBufferFrame } from '../InputRingBuffer.js';

function makeFrame(sequence: number, overrides?: Partial<RingBufferFrame>): RingBufferFrame {
  return {
    sequence,
    actionBitmask: sequence * 2,
    dx: sequence * 0.1,
    dy: sequence * -0.1,
    aimAngle: sequence * 0.01,
    timestamp: 1000 + sequence,
    predictedX: sequence * 10,
    predictedY: sequence * -10,
    velocityX: sequence * 0.5,
    velocityY: sequence * -0.5,
    speed: sequence * 2,
    dt: 16.67,
    subSteps: 1,
    ...overrides,
  };
}

/**
 * Layout pin (ticket 14): INPUT_FIELD_OFFSET is the published single source of
 * truth for the stride. These literals are an INDEPENDENT transcription of the
 * ADR-0007 layout on purpose — if the module's constants drift, this fails.
 */
describe('INPUT_FIELD_OFFSET stride layout', () => {
  it('pins every slot offset', () => {
    expect(INPUT_FIELD_OFFSET.sequence).toBe(0);
    expect(INPUT_FIELD_OFFSET.actionBitmask).toBe(1);
    expect(INPUT_FIELD_OFFSET.dx).toBe(2);
    expect(INPUT_FIELD_OFFSET.dy).toBe(3);
    expect(INPUT_FIELD_OFFSET.aimAngle).toBe(4);
    expect(INPUT_FIELD_OFFSET.timestamp).toBe(5);
    expect(INPUT_FIELD_OFFSET.predictedX).toBe(6);
    expect(INPUT_FIELD_OFFSET.predictedY).toBe(7);
    expect(INPUT_FIELD_OFFSET.velocityX).toBe(8);
    expect(INPUT_FIELD_OFFSET.velocityY).toBe(9);
    expect(INPUT_FIELD_OFFSET.speed).toBe(10);
    expect(INPUT_FIELD_OFFSET.dt).toBe(11);
    expect(INPUT_FIELD_OFFSET.subSteps).toBe(12);
    expect(INPUT_FIELD_OFFSET.subStepDirsX).toBe(13);
    expect(INPUT_FIELD_OFFSET.subStepDirsY).toBe(17);
  });

  it('substep offsets and stride stay internally consistent', () => {
    expect(SUBSTEP_DIR_X_OFFSET).toBe(INPUT_FIELD_OFFSET.subStepDirsX);
    expect(SUBSTEP_DIR_Y_OFFSET).toBe(INPUT_FIELD_OFFSET.subStepDirsY);
    expect(SUBSTEP_DIR_X_OFFSET).toBe(13);
    expect(SUBSTEP_DIR_Y_OFFSET).toBe(13 + MAX_SUBSTEPS_PER_RECORD);
    // 13 scalars + 2 × MAX substep directions.
    expect(INPUT_FRAME_STRIDE).toBe(21);
    expect(INPUT_FRAME_STRIDE).toBe(SUBSTEP_DIR_Y_OFFSET + MAX_SUBSTEPS_PER_RECORD);
  });

  it('layout is frozen (wire-adjacent — mutation must not be possible)', () => {
    expect(Object.isFrozen(INPUT_FIELD_OFFSET)).toBe(true);
  });
});

describe('decodeFrameInto', () => {
  it('decodes all 13 scalars from a read() view, matching toDebugView', () => {
    const buf = new InputRingBuffer(8);
    const frame = makeFrame(3);
    buf.write(frame);

    const target: RingBufferFrame = makeFrame(0); // garbage receptacle — must be fully overwritten
    decodeFrameInto(buf.read(3)!, target);

    const debug = buf.toDebugView()[0]!;
    expect(target.sequence).toBe(debug.sequence);
    expect(target.actionBitmask).toBe(debug.actionBitmask);
    expect(target.dx).toBe(debug.dx);
    expect(target.dy).toBe(debug.dy);
    expect(target.aimAngle).toBe(debug.aimAngle);
    expect(target.timestamp).toBe(debug.timestamp);
    expect(target.predictedX).toBe(debug.predictedX);
    expect(target.predictedY).toBe(debug.predictedY);
    expect(target.velocityX).toBe(debug.velocityX);
    expect(target.velocityY).toBe(debug.velocityY);
    expect(target.speed).toBe(debug.speed);
    expect(target.dt).toBe(debug.dt);
    expect(target.subSteps).toBe(debug.subSteps);
  });

  it('decodes every frame of a copyRangeInto slice at named offsets (zero-alloc loop shape)', () => {
    const buf = new InputRingBuffer(8);
    const frames = Array.from({ length: 4 }, (_, i) => makeFrame(i));
    for (const f of frames) buf.write(f);

    const slice = new Float64Array(4 * INPUT_FRAME_STRIDE);
    buf.copyRangeInto(slice, 0, 4);

    const target: RingBufferFrame = makeFrame(0);
    for (let i = 0; i < 4; i++) {
      // Sub-view shares the slice's buffer — no per-frame allocation.
      decodeFrameInto(slice.subarray(i * INPUT_FRAME_STRIDE, (i + 1) * INPUT_FRAME_STRIDE), target);
      expect(target.sequence).toBe(frames[i]!.sequence);
      expect(target.timestamp).toBe(frames[i]!.timestamp);
      expect(target.predictedX).toBe(frames[i]!.predictedX);
      expect(target.speed).toBe(frames[i]!.speed);
    }
  });

  it('substep-direction slots are addressed by the exported offsets (not decoded)', () => {
    const buf = new InputRingBuffer(8);
    buf.write(makeFrame(0, { subSteps: 2, subStepDirsX: [1, 0], subStepDirsY: [0, -1] }));
    const view = buf.read(0)!;

    expect(view[SUBSTEP_DIR_X_OFFSET]).toBe(1);
    expect(view[SUBSTEP_DIR_X_OFFSET + 1]).toBe(0);
    expect(view[SUBSTEP_DIR_Y_OFFSET]).toBe(0);
    expect(view[SUBSTEP_DIR_Y_OFFSET + 1]).toBe(-1);
    // Trailing slots beyond subSteps are zeroed by write().
    expect(view[SUBSTEP_DIR_X_OFFSET + 2]).toBe(0);
    expect(view[SUBSTEP_DIR_Y_OFFSET + 3]).toBe(0);
  });
});
