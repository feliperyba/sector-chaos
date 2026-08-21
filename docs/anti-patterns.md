# Anti-Patterns Reference — 27 Forbidden Patterns

Code review checklist, PR template reference, and onboarding guide for all forbidden anti-patterns defined in GDD Section 17.

## Client Anti-Patterns

### #1 — No `requestAnimationFrame`

**Enforcement: Code review only — no OxLint rule available in v0.16**

```ts
// Wrong
requestAnimationFrame((ts) => { sprite.x += 1; });
```

```ts
// Correct
class GameScene extends Phaser.Scene {
  update(time: number, delta: number) {
    this.player.sprite.x += delta * 0.1;
  }
}
```

### #2 — No raw `addEventListener` for input

**Enforcement: Code review only — no OxLint rule available in v0.16**

```ts
// Wrong
document.addEventListener("keydown", (e) => { player.jump(); });
```

```ts
// Correct
this.input.keyboard.on("keydown-SPACE", () => { player.jump(); });
```

### #3 — No manual canvas drawing

```ts
// Wrong
const ctx = this.game.canvas.getContext("2d")!;
ctx.fillRect(10, 10, 50, 50);
```

```ts
// Correct
this.add.rectangle(35, 35, 50, 50, 0xffffff);
```

### #4 — No hand-rolled easing/lerp

```ts
// Wrong
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
sprite.x = lerp(sprite.x, targetX, 0.1);
```

```ts
// Correct
this.tweens.add({ targets: sprite, x: targetX, duration: 300, ease: "Linear" });
```

### #5 — No custom particle engine

```ts
// Wrong
class ParticleSystem {
  particles: { x: number; y: number; vx: number; vy: number }[] = [];
  update(dt: number) { /* ... */ }
}
```

```ts
// Correct
this.add.particles(0, 0, "flares", { speed: { min: 40, max: 100 }, lifespan: 800 });
```

### #6 — No manual camera tracking

```ts
// Wrong
this.events.on("update", () => { this.cameras.main.scrollX = player.x - 400; });
```

```ts
// Correct
this.cameras.main.startFollow(player);
```

### #7 — No raw `setTimeout`/`setInterval` for game timing

**Enforced by OxLint: `no-set-timeout`, `no-set-interval`**

```ts
// Wrong
setTimeout(() => { enemy.spawn(); }, 2000);
setInterval(() => { world.tick(); }, 100);
```

```ts
// Correct
this.time.delayedCall(2000, () => { enemy.spawn(); });
this.time.addEvent({ delay: 100, callback: () => { world.tick(); }, loop: true });
```

### #8 — No custom audio system

```ts
// Wrong
const audioCtx = new AudioContext();
const osc = audioCtx.createOscillator();
osc.start();
```

```ts
// Correct
this.sound.play("explosion");
```

### #9 — No custom scene routing

```ts
// Wrong
const scenes: Record<string, Phaser.Scene> = {};
function switchScene(name: string) { scenes[name].scene.start(); }
```

```ts
// Correct
this.scene.start("GameOverScene", { score: 100 });
```

### #10 — No raw `new Image()`

**Enforcement: Code review only — no OxLint rule available in v0.16**

```ts
// Wrong
const img = new Image();
img.src = "assets/player.png";
```

```ts
// Correct
preload() { this.load.image("player", "assets/player.png"); }
create() { this.add.image(400, 300, "player"); }
```

---

## Server Anti-Patterns

### #11 — No `JSON.stringify` for state sync

```ts
// Wrong
this.broadcast(JSON.stringify(state));
```

```ts
// Correct
@defineSchema({ map: schema.map })
class GameState extends Schema { players = new MapSchema<Player>(); }
```

### #12 — No custom room management

```ts
// Wrong
const rooms: Map<string, GameRoom> = new Map();
app.post("/create", (req) => { rooms.set(id, new GameRoom()); });
```

```ts
// Correct
server.define("game", GameRoom);
const room = await matchMaker.createRoom("game", {});
```

### #13 — No custom reconnection logic

```ts
// Wrong
const sessionStore = new Map<string, Session>();
client.on("reconnect", (id) => { sessionStore.get(id)?.reattach(client); });
```

```ts
// Correct
async onLeave(client: Client, consented: boolean) {
  if (!consented) { await this.allowReconnection(client, 30); }
}
```

### #14 — No manual message validation

```ts
// Wrong
onMessage(client: Client, data: unknown) {
  if (typeof data.x !== "number") throw new Error("bad");
}
```

```ts
// Correct
const MoveSchema = z.object({ x: z.number(), y: z.number() });
onMessage(client: Client, data: unknown) {
  const move = MoveSchema.parse(data);
}
```

### #15 — No raw `setTimeout`/`setInterval` in rooms

**Enforced by OxLint: `no-set-timeout`, `no-set-interval`**

```ts
// Wrong
setTimeout(() => { this.broadcast("tick"); }, 1000);
setInterval(() => { this.state.advance(); }, 16);
```

```ts
// Correct
this.clock.setTimeout(() => { this.broadcast("tick"); }, 1000);
this.clock.setInterval(() => { this.state.advance(); }, 16);
```

### #16 — No custom rate limiter

```ts
// Wrong
const rateLimiter = new Map<string, number>();
onMessage(client: Client) {
  const last = rateLimiter.get(client.id) ?? 0;
  if (Date.now() - last < 100) return;
}
```

```ts
// Correct
@defineRoom({ maxMessagesPerSecond: 20 })
class GameRoom extends Room { /* ... */ }
```

### #17 — No manual state filtering per-client

```ts
// Wrong
onMessage(client: Client, data: unknown) {
  const filtered = Object.fromEntries(
    Object.entries(state).filter(([k]) => client.tags.includes(k))
  );
  client.send("state", filtered);
}
```

```ts
// Correct
this.setState(new GameState());
this.views = new StateView(this.state);
this.views.add(client, visibilityTags);
```

### #18 — No custom matchmaking queue

```ts
// Wrong
const queue: Client[] = [];
app.post("/match", (req, res) => {
  queue.push(req.body);
  if (queue.length >= 4) startMatch(queue.splice(0, 4));
});
```

```ts
// Correct
const room = await client.joinOrCreate("game", { mode: "team" });
```

### #19 — No raw Redis for cross-room communication

```ts
// Wrong
const redis = new Redis();
redis.publish("room-events", JSON.stringify({ type: "player_left" }));
```

```ts
// Correct
this.presence.publish("player_left", { roomId: this.roomId, clientId });
```

### #20 — No mock WebSockets in tests

```ts
// Wrong
const ws = new WebSocket("ws://localhost");
ws.onmessage = (msg) => { assert(JSON.parse(msg.data).x === 10); };
```

```ts
// Correct
import { createDummyClient } from "@colyseus/testing";
const client = await createDummyClient(server, "game");
client.send("move", { x: 10, y: 20 });
```

### #21 — No giant message handlers

```ts
// Wrong
onMessage(client: Client, data: unknown) {
  if (data.type === "move") { /* 50 lines */ }
  else if (data.type === "shoot") { /* 40 lines */ }
  else if (data.type === "chat") { /* 30 lines */ }
}
```

```ts
// Correct
import { Dispatcher } from "@colyseus/command";
const dispatcher = new Dispatcher(this);
dispatcher.mapCommand("move", MoveCommand);
dispatcher.mapCommand("shoot", ShootCommand);
```

### #22 — No custom latency measurement

```ts
// Wrong
const start = Date.now();
client.send("ping");
client.on("pong", () => { latency = Date.now() - start; });
```

```ts
// Correct
const latency = client.getLatency();
```

---

## TypeScript Anti-Patterns

### #23 — No `any` type anywhere

**Enforced by OxLint: `ts/no-explicit-any`**

```ts
// Wrong
function process(data: any) { return data.value; }
const config: any = JSON.parse(raw);
```

```ts
// Correct
function process(data: { value: string }) { return data.value; }
const config: Record<string, unknown> = JSON.parse(raw);
```

### #24 — No `@ts-ignore` or `@ts-expect-error`

**Enforced by OxLint: `ts/ban-ts-comment`**

```ts
// Wrong
// @ts-ignore
obj.nonExistentMethod();
// @ts-expect-error
result as MyType;
```

```ts
// Correct
(obj as HasMethod).nonExistentMethod();
const result: MyType = validateAndCast(raw);
```

### #25 — No unused imports or dead code

**Enforced by OxLint: `ts/no-unused-vars`**

```ts
// Wrong
import { UnusedType, UsedType } from "./types";
const deadVariable = 42;
```

```ts
// Correct
import { UsedType } from "./types";
```

### #26 — No `new` in hot-path (update/tick)

In `update()`, `onTick()`, or any per-frame/per-tick method, use object pools or pre-allocated vectors. No `new Vec2()`, `new Set()`, `new Map()`, etc. This cannot be statically analyzed easily — enforce via code review.

```ts
// Wrong
update(time: number, delta: number) {
  const direction = new Vec2(1, 0);
  const visited = new Set<string>();
  const dists = new Map<string, number>();
}
```

```ts
// Correct
private _direction = new Vec2();
private _visited = new Set<string>();
private _dists = new Map<string, number>();

update(time: number, delta: number) {
  this._direction.set(1, 0);
  this._visited.clear();
  this._dists.clear();
}
```

### #27 — No copying code from reference projects

Do not copy-paste code from reference implementations (e.g., Colyseus examples, Phaser tutorials). Use them as conceptual guides and write original code that fits this project's architecture.

```ts
// Wrong (copied from Colyseus docs example)
app.use(cors());
app.use(express.json());
const gameServer = new Server({ transport: new WebSocketTransport({}) });
```

```ts
// Correct (adapted to project structure)
import { createServer } from "../serverFactory";
const server = createServer({ transports: ["websocket"] });
```
