/**
 * Limits how many answers are generated at once, so one slow model server (or one busy user) cannot
 * stall everyone. Work beyond the limits waits its turn in the order it arrived.
 */
export class RunQueue {
  private active = 0;
  private perUser = new Map<string, number>();
  private waiting: Array<{ userId: string; start: () => void }> = [];

  constructor(
    private maxTotal: number,
    private maxPerUser: number,
  ) {}

  private hasRoom(userId: string): boolean {
    return this.active < this.maxTotal && (this.perUser.get(userId) ?? 0) < this.maxPerUser;
  }

  /** Whether a task for this user would have to wait right now. */
  wouldWait(userId: string): boolean {
    return !this.hasRoom(userId);
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  run<T>(userId: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        this.perUser.set(userId, (this.perUser.get(userId) ?? 0) + 1);
        task()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            const left = (this.perUser.get(userId) ?? 1) - 1;
            if (left <= 0) this.perUser.delete(userId);
            else this.perUser.set(userId, left);
            this.drain();
          });
      };
      if (this.hasRoom(userId)) start();
      else this.waiting.push({ userId, start });
    });
  }

  /** Starts waiting tasks, oldest first, skipping any whose user is already at their limit. */
  private drain() {
    for (let i = 0; i < this.waiting.length; ) {
      if (this.active >= this.maxTotal) return;
      const next = this.waiting[i];
      if (this.hasRoom(next.userId)) {
        this.waiting.splice(i, 1);
        next.start();
      } else {
        i++;
      }
    }
  }
}
