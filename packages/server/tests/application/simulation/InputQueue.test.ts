import { InputAction } from '@sector-battle/shared';
import { InputQueue, type QueuedInput } from '../../../src/application/simulation/index.ts';

function makeInput(
  playerId: string,
  serverTick: number,
  action: InputAction = InputAction.MOVE,
): QueuedInput {
  return { playerId, action, data: {}, clientTick: 0, serverTick, receivedAt: Date.now() };
}

describe('InputQueue', () => {
  it('enqueues and dequeues inputs by tick', () => {
    const queue = new InputQueue();
    const input = makeInput('p1', 5);
    queue.enqueue(input);
    const result = queue.dequeueTick(5);
    expect(result).toHaveLength(1);
    expect(result[0].playerId).toBe('p1');
  });

  it('returns multiple inputs per tick from different players', () => {
    const queue = new InputQueue();
    queue.enqueue(makeInput('p1', 5));
    queue.enqueue(makeInput('p2', 5));
    const result = queue.dequeueTick(5);
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.playerId)).toEqual(['p1', 'p2']);
  });

  it('replaces earlier input when same player same action same tick', () => {
    const queue = new InputQueue();
    queue.enqueue(makeInput('p1', 5, InputAction.MOVE));
    queue.enqueue(makeInput('p1', 5, InputAction.MOVE));
    const result = queue.dequeueTick(5);
    expect(result).toHaveLength(1);
  });

  it('keeps different actions for same player same tick', () => {
    const queue = new InputQueue();
    queue.enqueue(makeInput('p1', 5, InputAction.MOVE));
    queue.enqueue(makeInput('p1', 5, InputAction.DASH));
    const result = queue.dequeueTick(5);
    expect(result).toHaveLength(2);
  });

  it('clear emptied the queue', () => {
    const queue = new InputQueue();
    queue.enqueue(makeInput('p1', 1));
    queue.enqueue(makeInput('p2', 2));
    expect(queue.getPendingCount()).toBe(2);
    queue.clear();
    expect(queue.getPendingCount()).toBe(0);
  });

  it('discardBefore removes old inputs', () => {
    const queue = new InputQueue();
    queue.enqueue(makeInput('p1', 3));
    queue.enqueue(makeInput('p2', 5));
    queue.enqueue(makeInput('p3', 7));
    queue.discardBefore(5);
    expect(queue.getPendingCount()).toBe(2);
    expect(queue.dequeueTick(3)).toEqual([]);
    expect(queue.dequeueTick(5)).toHaveLength(1);
    expect(queue.dequeueTick(7)).toHaveLength(1);
  });

  it('dequeueTick removes inputs from queue', () => {
    const queue = new InputQueue();
    queue.enqueue(makeInput('p1', 1));
    queue.enqueue(makeInput('p2', 1));
    expect(queue.getPendingCount()).toBe(2);
    queue.dequeueTick(1);
    expect(queue.getPendingCount()).toBe(0);
  });

  it('returns empty array for tick with no inputs', () => {
    const queue = new InputQueue();
    queue.enqueue(makeInput('p1', 5));
    expect(queue.dequeueTick(3)).toEqual([]);
  });

  it('allows same player to submit different actions in same tick', () => {
    const queue = new InputQueue();
    queue.enqueue(makeInput('p1', 5, InputAction.MOVE));
    queue.enqueue(makeInput('p1', 5, InputAction.DASH));
    const result = queue.dequeueTick(5);
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.action)).toEqual(
      expect.arrayContaining([InputAction.MOVE, InputAction.DASH]),
    );
  });
});
