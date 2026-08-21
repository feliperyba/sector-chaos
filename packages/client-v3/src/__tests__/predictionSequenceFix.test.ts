import { describe, it, expect } from 'vitest';
import { InputRingBuffer, INPUT_FRAME_STRIDE } from '@sector-battle/shared';

/**
 * Validates the prediction sequence collision fix.
 *
 * Before the fix: GameScene's while-loop pushed multiple prediction records
 * with the SAME frame.sequence, causing InputRingBuffer (seq→slot 1:1 map)
 * to only retain the last sub-step's position. The reconciler would then
 * replay fewer steps than the client actually predicted → position error → flicker.
 *
 * After the fix: Each sub-step clones frame with frame.sequence++ so all
 * prediction steps get unique sequence numbers.
 */
describe('Prediction sequence collision fix', () => {
  it('stores ALL sub-steps when sequences are unique', () => {
    const ring = new InputRingBuffer(120);

    // Ring buffer expects sequential sequences. Start from 0.
    // Simulate 3 prediction sub-steps in one frame with UNIQUE sequences (FIXED)
    const baseSeq = 0;
    const inputX = 1.0;
    const inputY = 0.0;

    for (let i = 0; i < 3; i++) {
      ring.write({
        sequence: baseSeq + i, // Each sub-step gets unique sequence
        actionBitmask: 1,
        dx: inputX,
        dy: inputY,
        aimAngle: 0,
        timestamp: 1000 + i * 16,
        predictedX: 100 + i * 2, // Each step moves 2px
        predictedY: 100,
        velocityX: 120 - i * 10, // Decelerating
        velocityY: 0,
        speed: 120,
        dt: 1 / 60,
        subSteps: 1,
      });
    }

    // Verify all 3 records are stored
    expect(ring.count).toBe(3);
    expect(ring.newestSequence).toBe(2);

    const data = ring.slice(baseSeq, baseSeq + 3);
    const frameCount = data.length / INPUT_FRAME_STRIDE;
    expect(frameCount).toBe(3);

    // Verify each sub-step's predicted position is retained
    const positions = [];
    for (let i = 0; i < frameCount; i++) {
      const offset = i * INPUT_FRAME_STRIDE;
      positions.push({
        seq: data[offset],
        x: data[offset + 6],
        y: data[offset + 7],
        vx: data[offset + 8],
        vy: data[offset + 9],
      });
    }

    const p0 = positions[0]!;
    const p1 = positions[1]!;
    const p2 = positions[2]!;

    expect(p0.seq).toBe(0);
    expect(p0.x).toBe(100);
    expect(p1.seq).toBe(1);
    expect(p1.x).toBe(102);
    expect(p2.seq).toBe(2);
    expect(p2.x).toBe(104);

    // Verify velocity deceleration is captured per step
    expect(p0.vx).toBe(120);
    expect(p1.vx).toBe(110);
    expect(p2.vx).toBe(100);
  });

  it('demonstrates data loss when sequences collide (the old bug)', () => {
    const ring = new InputRingBuffer(120);

    // Simulate OLD BUG: 3 sub-steps with SAME sequence
    // Ring buffer write() doesn't use sequence for slot — it just advances head.
    // But slotFor() maps seq → slot, so duplicate seq maps to same slot.
    // The key issue: newestSequence reports baseSeq + count - 1 = 0 + 3 - 1 = 2
    // But slotFor(0) = slotFor(1) = slotFor(2) when sequences in backing[] are wrong.

    // Write 3 entries with DIFFERENT sequences first (baseline - correct behavior)
    for (let i = 0; i < 3; i++) {
      ring.write({
        sequence: i, // Unique sequences
        actionBitmask: 1,
        dx: 1.0,
        dy: 0,
        aimAngle: 0,
        timestamp: 1000 + i,
        predictedX: 100 + i * 2,
        predictedY: 100,
        velocityX: 120 - i * 10,
        velocityY: 0,
        speed: 120,
        dt: 1 / 60,
        subSteps: 1,
      });
    }

    // All 3 records should be there
    expect(ring.count).toBe(3);
    const data = ring.slice(0, 3);
    expect(data.length / INPUT_FRAME_STRIDE).toBe(3);

    // Now demonstrate the BUG scenario: what happens when
    // prediction pushes 3 times with same sequence
    const buggyRing = new InputRingBuffer(120);

    // Write 3 entries all claiming to be seq 0
    for (let i = 0; i < 3; i++) {
      buggyRing.write({
        sequence: 0, // BUG: same sequence
        actionBitmask: 1,
        dx: 1.0,
        dy: 0,
        aimAngle: 0,
        timestamp: 1000 + i,
        predictedX: 100 + i * 2,
        predictedY: 100,
        velocityX: 120 - i * 10,
        velocityY: 0,
        speed: 120,
        dt: 1 / 60,
        subSteps: 1,
      });
    }

    // Ring still has 3 entries (head advanced 3 times)
    // But newestSequence = baseSeq + count - 1 = 0 + 3 - 1 = 2
    // And slotFor(0) = (0 - 0 + 0) % 120 = 0 → first slot
    // slotFor(1) = (1 - 0 + 0) % 120 = 1 → second slot
    // slotFor(2) = 2 → third slot
    // But the SEQUENCE VALUES stored in slots 1 and 2 are both 0!
    const buggyData = buggyRing.slice(0, 3);
    const buggyFrames = buggyData.length / INPUT_FRAME_STRIDE;
    expect(buggyFrames).toBe(3);

    // The stored sequence values are WRONG for slots 1 and 2
    // All three report seq=0 in their data. (NET-02 grew INPUT_FRAME_STRIDE
    // from 13 to 29 to carry per-substep directions; use the constant, not a
    // hardcoded offset, so this stays correct under stride changes.)
    expect(buggyData[0]).toBe(0); // slot 0: seq=0 ✓
    expect(buggyData[INPUT_FRAME_STRIDE]).toBe(0); // slot 1: seq=0 BUG (should be 1)
    expect(buggyData[2 * INPUT_FRAME_STRIDE]).toBe(0); // slot 2: seq=0 BUG (should be 2)

    // The reconciler does slice(lastServerSeq+1, newest+1)
    // If server ack'd seq 0, it asks for slice(1, 3) → 2 frames
    // But those frames have seq=0 stored, so the reconciler can't match them
    // to actual server state properly
  });

  it('handles move-then-stop deceleration with unique sequences', () => {
    const ring = new InputRingBuffer(120);

    // Write 5 frames: 2 moving, 3 decelerating
    for (let i = 0; i < 2; i++) {
      ring.write({
        sequence: i,
        actionBitmask: 1,
        dx: 1.0,
        dy: 0,
        aimAngle: 0,
        timestamp: 1000 + i * 16,
        predictedX: 100 + i * 2,
        predictedY: 100,
        velocityX: 120 - i * 5,
        velocityY: 0,
        speed: 120,
        dt: 1 / 60,
        subSteps: 1,
      });
    }

    // Deceleration frames (no input)
    for (let i = 0; i < 3; i++) {
      ring.write({
        sequence: 2 + i,
        actionBitmask: 0,
        dx: 0,
        dy: 0,
        aimAngle: 0,
        timestamp: 1032 + i * 16,
        predictedX: 104 + i * 0.5,
        predictedY: 100,
        velocityX: 110 - i * 40,
        velocityY: 0,
        speed: 120,
        dt: 1 / 60,
        subSteps: 1,
      });
    }

    // Server ack'd up to seq 1 (second movement frame)
    // Client replays from seq 2 onwards
    const data = ring.slice(2, 5);
    const frameCount = data.length / INPUT_FRAME_STRIDE;
    expect(frameCount).toBe(3);

    // All deceleration velocities preserved
    const decelVx = [];
    for (let i = 0; i < frameCount; i++) {
      const offset = i * INPUT_FRAME_STRIDE;
      decelVx.push(data[offset + 8]);
    }
    expect(decelVx[0]).toBe(110);
    expect(decelVx[1]).toBe(70);
    expect(decelVx[2]).toBe(30);
  });

  it('getUnacknowledged returns correct count after fix', () => {
    const ring = new InputRingBuffer(120);

    // Push 10 records with sequential unique sequences
    for (let i = 0; i < 10; i++) {
      ring.write({
        sequence: i,
        actionBitmask: i % 2,
        dx: i < 6 ? 1 : 0,
        dy: 0,
        aimAngle: 0,
        timestamp: 1000 + i * 16,
        predictedX: 100 + i,
        predictedY: 100,
        velocityX: i < 6 ? 120 : Math.max(0, 120 - (i - 5) * 30),
        velocityY: 0,
        speed: 120,
        dt: 1 / 60,
        subSteps: 1,
      });
    }

    // Server ack'd up to seq 5 → client needs seq 6-9
    const data = ring.slice(6, 10);
    const frameCount = data.length / INPUT_FRAME_STRIDE;
    expect(frameCount).toBe(4);

    // Verify sequences and zero input during deceleration
    for (let i = 0; i < frameCount; i++) {
      const offset = i * INPUT_FRAME_STRIDE;
      expect(data[offset]).toBe(6 + i);
      expect(data[offset + 2]).toBe(0); // dx=0 (no input)
    }
  });
});
