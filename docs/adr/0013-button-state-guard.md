# ADR 0013: Button isPressed State Guard

## Status

Accepted

## Context

The current `Button` component has no `isPressed` flag. On `pointerup`, the `'button.click'` event fires immediately regardless of whether the button was actually pressed. On `pointerupoutside`, nothing happens — the button stays visually stuck in pressed state (shadow hidden, face offset). A player can:

1. **Spam-click** to fire the handler multiple times in rapid succession (e.g., JOIN button triggers `SketchWipeTransition.perform()` three times, stacking RenderTextures).
2. **Drag off** and release — the button never resets because only `pointerup` restores visual state, and `pointerup` doesn't fire when the pointer is outside the hit area.
3. **Fire action without visual feedback** — the click event and action are simultaneous, giving no perceived "release then act" feel.

The angry-aliens reference uses `isPressed: boolean` with `pointerupoutside` handling and fires `onClick` in the release tween's `onComplete`.

## Decision

Add to `Button`:

1. **`isPressed: boolean` field** — set `true` on `pointerdown`, checked on `pointerup`. If `isPressed` is `false` when `pointerup` fires, the click is ignored (prevents double-fire from rapid clicking).

2. **`pointerupoutside` handler** — resets `isPressed` to `false`, restores visual state (face position, shadow alpha). Prevents stuck buttons from drag-off.

3. **Release tween with `onComplete` callback** — the `'button.click'` event fires in the release tween's `onComplete`, not immediately on `pointerup`. This gives the player visual feedback (button springs back) before the action triggers.

4. **TweenPresets for press/release** — press tweens to 0.95 scale, release tweens back to 1.0 with `Back.easeOut` spring. Hover and reset use matching presets.

## Consequences

### Positive

- Buttons cannot double-fire (core bug fix)
- Drag-off resets button state cleanly (UX fix)
- Visual feedback before action (feel improvement)
- Consistent with angry-aliens reference pattern

### Negative

- Click action is delayed by the release tween duration (~80-120ms). This is intentional (perceived responsiveness) but the delay must be kept short.
- Every Button instance binds 5 event handlers instead of 4 (minor memory increase, negligible).

### Risks

- If the release tween is interrupted (e.g., scene stops mid-release), the `onComplete` callback never fires and the click action is lost. Mitigation: in the cleanup handler, check `isPressed` and emit if needed. In practice, this scenario is rare and acceptable — the player is leaving the scene anyway.
