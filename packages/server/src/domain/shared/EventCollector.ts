export class EventCollector<T> {
  private events: T[] = [];

  emit(event: T): void {
    this.events.push(event);
  }

  drain(): T[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  clear(): void {
    this.events = [];
  }
}
