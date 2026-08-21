# ADR 0003: MVC + Observable State for UI Architecture

## Status

Accepted

## Context

The secto-chaos-neo UI layer needs a complete redesign. Three architectural patterns were considered:
- **MVC** (Model-View-Controller) — simple, Phaser-native
- **MVVM** (Model-View-ViewModel) — reactive bindings, requires building observation layer
- **ECS-lite** (Entity-Component) — component bags for UI elements

The UI layer must support:
- Shared reusable components (Panel, Button, ProgressBar, etc.)
- Choreographed animations (multi-phase entrance sequences)
- Data-driven design tokens (colors, fonts, spacing, durations)
- Observable state for HUD elements (health, inventory, minimap, kill feed)
- Clean separation between animation orchestration and component rendering

Reference projects analyzed: pixi-gamelab (PixiJS), angry-aliens-phaser, playable-ad-phaser, taarapitas.gamble.

## Decision

**MVC with lightweight observable state** using Phaser's EventEmitter.

- **Model**: Plain state classes (UIState, HUDState) with EventEmitter-based field change notifications
- **View**: Reusable Phaser components (Panel, Button, ProgressBar) built from game-assets textures with nine-slice
- **Controller**: Scene classes + Choreographer classes. Controllers subscribe to Model changes and update Views. Choreographers orchestrate animation sequences without knowing component internals.

Observable pattern: simple `state.on('health:change', callback)` — NOT full reactive binding system. 90% of MVVM benefit at 10% complexity.

## Consequences

### Positive
- No framework-within-framework overhead
- Matches what reference projects (pixi-gamelab, angry-aliens) actually do
- Testable state classes independent of Phaser
- Choreographers are decoupled from components — swap animations without touching rendering
- Observable state enables HUD views to subscribe to specific field changes without polling

### Negative
- Controllers must manually wire subscriptions (no auto-binding)
- No declarative template system — all UI is imperative Phaser code
- Observable pattern requires discipline to unsubscribe on scene shutdown (memory leak risk)

### Risks
- If HUD grows to 100+ dynamic elements, may need to reconsider towards ECS-lite
- EventEmitter discipline must be enforced via code review (cleanup in `destroy()`)
