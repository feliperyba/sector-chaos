# ADR 0007: Float64 Ring Buffer for Input Storage

## Status

Superseded

## Superseded by

[ADR-0014 — Netcode Overhaul](./0014-netcode-overhaul.md).

The ring-buffer-as-wire design was never implemented. The actual wire is JSON `InputMessage` sent via Colyseus `room.send('input', frame)`. Server-side queuing uses `InputQueue`.

## Context

Current input storage creates significant GC pressure and serialization overhead at scale:

- **Client**: `InputBuffer.ts` stores 120 `InputFrame` objects — each a JS object with typed arrays (`movementX`, `movementY`, `aimAngle`, `sequence`, `actions[]`, `targetId?`)
- **Server**: Inputs are stored as plain objects in per-player queues

At 64 players × 120 frames × multiple fields per frame, this means ~7,680 JS objects allocated per frame window on the server alone, with constant allocation/deallocation as frames rotate. Each object triggers V8 GC sweeps. Additionally, serializing these objects for Colyseus messages requires iteration + structure cloning.

A typed `Float64Array` ring buffer eliminates per-frame allocation entirely, enables zero-copy wire serialization (send a slice of the backing buffer), and allows cheap server-side reconciliation by reading past inputs directly from the buffer without deserialization.

## Decision

Create a shared `InputRingBuffer` class in `packages/shared/` backed by a single `Float64Array`.

### Layout

Each input frame occupies **7 float64s**:

| Index | Field | Notes |
|-------|-------|-------|
| 0 | `playerId` | 0 on client (single player) |
| 1 | `sequence` | Monotonically increasing |
| 2 | `actionBitmask` | Bit flags for `InputAction` enum |
| 3 | `dx` | Movement X (normalized -1 to 1) |
| 4 | `dy` | Movement Y (normalized -1 to 1) |
| 5 | `aimAngle` | Radians |
| 6 | `timestamp` | `performance.now()` value |

### Ring buffer mechanics

- **Circular buffer** with configurable capacity (default 120 frames = 840 float64s per player slot)
- `head` and `tail` pointers for manual pagination
- `write(frame)` writes 7 consecutive float64s and advances `head`
- `read(sequence)` does pointer arithmetic to find the frame by sequence number (O(1))
- Server uses one global ring buffer: `64 players × 120 frames × 7 × 8 bytes = ~430 KB`
- Client serializes directly into the buffer format for network transmission
- Server reads without parsing — the wire format is just a typed array slice

### API

```ts
class InputRingBuffer {
  constructor(capacity?: number);  // default 120 frames
  write(frame: InputFrame): void;
  read(sequence: number): Float64Array | undefined;  // 7-element view
  slice(fromSeq: number, toSeq: number): Float64Array;  // contiguous copy
  reset(): void;
  toDebugView(): InputFrame[];  // reconstruct objects for debugging only
}
```

### Migration

- Replace `packages/client-v3/src/prediction/InputBuffer.ts` with `InputRingBuffer`
- Replace server input queues in `packages/server/src/room/handlers/input.ts` with ring buffer reads
- `Reconciler.ts` reads directly from the ring buffer via `slice(lastAcknowledgedSeq, currentSeq)`

## Consequences

### Positive
- **Memory efficient**: ~430 KB total for 64 players × 120 frames (vs. multi-MB with objects)
- **Zero GC pressure**: No per-frame allocations — single `Float64Array` allocated once
- **Zero-copy wire serialization**: Send `buffer.slice(tail, head)` directly over WebSocket
- **O(1) lookup by sequence**: Pointer arithmetic replaces array scanning
- **Shared code**: One `InputRingBuffer` class used by both client and server

### Negative
- **Pointer arithmetic**: Off-by-one errors in head/tail logic are easy to introduce and hard to debug
- **Loss of debuggability**: Raw float64 arrays are opaque in debugger — `toDebugView()` reconstructs objects but is not suitable for hot paths
- **Fixed schema**: Adding a new input field requires changing the stride constant everywhere (7 → N) — not as flexible as objects
- **Bitmask operations**: `actionBitmask` requires bitwise operators instead of array membership checks

### Risks
- If input frame fields grow beyond 7 float64s, all pointer arithmetic must be updated — a stride constant mitigates this
- Float64 precision is sufficient for all current fields (playerId fits in int53, angles and normalized movement vectors are well within precision)
