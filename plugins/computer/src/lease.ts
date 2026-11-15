/**
 * Only one helper uses a display's pointer and keyboard at a time (docs/07 section 5, the display lease): two agents moving
 * the same pointer would undo each other. `acquire` returns a release function, or undefined while someone else holds it.
 */
export class DisplayLease {
  private holder: string | undefined;

  acquire(owner: string): (() => void) | undefined {
    if (this.holder !== undefined) return undefined;
    this.holder = owner;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holder = undefined;
    };
  }

  heldBy(): string | undefined {
    return this.holder;
  }
}
