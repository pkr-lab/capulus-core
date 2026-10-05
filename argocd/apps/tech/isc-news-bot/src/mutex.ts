import { IscBotError } from "./errors.js";

type Waiter = {
  grant: () => void;
  timer: NodeJS.Timeout;
};

export class RunLock {
  private locked = false;
  private waiters: Waiter[] = [];

  constructor(private readonly waitMs: number) {}

  acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          resolve(this.makeRelease());
        },
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new IscBotError("BUSY", `Ein anderer Lauf ist aktiv (Wartezeit ${this.waitMs} ms überschritten)`));
        }, this.waitMs),
      };
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.grant();
      } else {
        this.locked = false;
      }
    };
  }
}
