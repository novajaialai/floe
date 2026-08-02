/**
 * Out-of-band control over a running agent.
 *
 * The agent loop is a sequence of steps, so the only safe place to interrupt it
 * is *between* steps: a half-finished tool call has real side effects on a real
 * browser. `gate()` is therefore awaited at the top of every step.
 *
 * Stop is deliberately NOT a kill: it reuses the same "wrap up now" injection as
 * the wall-clock deadline, so the agent saves its work and produces an honest
 * summary. A hard kill is the caller's job (kill the process).
 */
export class RunControl {
  private paused = false;
  private stopping = false;
  private waiters: Array<() => void> = [];
  /** Notified on every state change, so a UI can show pause/resume/stop. */
  onChange?: (state: RunControlState) => void;

  get isPaused(): boolean {
    return this.paused;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  get state(): RunControlState {
    return this.stopping ? "stopping" : this.paused ? "paused" : "running";
  }

  pause(): void {
    if (this.paused || this.stopping) return;
    this.paused = true;
    this.onChange?.(this.state);
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.release();
    this.onChange?.(this.state);
  }

  /** Graceful stop: the agent is told to wrap up and call done. */
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.paused = false;
    this.release();
    this.onChange?.(this.state);
  }

  private release(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  /** Blocks while paused; returns immediately otherwise. */
  async gate(): Promise<void> {
    while (this.paused && !this.stopping) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

export type RunControlState = "running" | "paused" | "stopping";
