/** A clock that moves only when told to. */
export class FakeClock {
  private current: number;

  constructor(start = 1_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }

  set(time: number): number {
    this.current = Math.max(this.current, time);
    return this.current;
  }
}
