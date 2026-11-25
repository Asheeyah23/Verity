export interface Heartbeat {
  start: () => void;
  stop: () => void;
  restart: () => void;
}

/** Calls `beat` every `intervalMs` until stopped, independently of the work
 * loop: a replay can take far longer than the backend's liveness window, and
 * the worker must not look offline while it is busy. A beat never overlaps
 * the previous one, and a failure is reported (once per run of failures) but
 * never stops the timer or throws. Calling `start` (or `restart`) after `stop`
 * resumes the timer; calling either while already in that state is a no-op. */
export function startHeartbeat(
  beat: () => Promise<void>,
  intervalMs: number,
  onError: (err: Error) => void = () => {}
): Heartbeat {
  let inFlight = false;
  let failing = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = () => {
    if (inFlight) return;
    inFlight = true;
    beat()
      .then(() => {
        failing = false;
      })
      .catch((err: unknown) => {
        if (!failing) onError(err instanceof Error ? err : new Error(String(err)));
        failing = true;
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const start = () => {
    if (timer !== null) return;
    failing = false;
    timer = setInterval(tick, intervalMs);
    // Never the reason the process stays alive.
    timer.unref();
  };

  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  start();
  return { start, stop, restart: start };
}
