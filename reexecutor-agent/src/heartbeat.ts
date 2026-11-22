/** Calls `beat` every `intervalMs` until stopped, independently of the work
 * loop: a replay can take far longer than the backend's liveness window, and
 * the worker must not look offline while it is busy. A beat never overlaps
 * the previous one, and a failure is reported (once per run of failures) but
 * never stops the timer or throws. */
export function startHeartbeat(
  beat: () => Promise<void>,
  intervalMs: number,
  onError: (err: Error) => void = () => {}
): { stop: () => void } {
  let inFlight = false;
  let failing = false;
  const timer = setInterval(() => {
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
  }, intervalMs);
  // Never the reason the process stays alive.
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
