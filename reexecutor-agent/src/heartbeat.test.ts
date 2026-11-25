import assert from "node:assert/strict";
import test from "node:test";
import { startHeartbeat } from "./heartbeat.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `done()` holds, failing after `capMs`, so the tests wait for
 * an outcome rather than guess how many timer ticks a busy machine delivers. */
async function waitFor(done: () => boolean, what: string, capMs = 3000) {
  const deadline = Date.now() + capMs;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

test("beats repeatedly until stopped", async () => {
  let beats = 0;
  const hb = startHeartbeat(async () => void beats++, 10);
  await waitFor(() => beats >= 3, "three beats");
  hb.stop();
  const atStop = beats;
  await sleep(60);
  assert.equal(beats, atStop);
});

test("a slow beat is never overlapped by the next one", async () => {
  let running = 0;
  let maxRunning = 0;
  let finished = 0;
  const hb = startHeartbeat(async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await sleep(40);
    running--;
    finished++;
  }, 5);
  await waitFor(() => finished >= 2, "two completed beats");
  hb.stop();
  assert.equal(maxRunning, 1);
});

test("failures are reported once per run and do not stop the timer", async () => {
  const errors: string[] = [];
  let calls = 0;
  const hb = startHeartbeat(
    async () => {
      calls++;
      if (calls <= 3) throw new Error(`down ${calls}`);
    },
    10,
    (err) => errors.push(err.message)
  );
  await waitFor(() => calls >= 5, "beats after the failures");
  hb.stop();
  assert.deepEqual(errors, ["down 1"]);
});

test("a failure after a recovery is reported again", async () => {
  const errors: string[] = [];
  let calls = 0;
  const hb = startHeartbeat(
    async () => {
      calls++;
      if (calls === 1 || calls === 3) throw new Error(`down ${calls}`);
    },
    10,
    (err) => errors.push(err.message)
  );
  await waitFor(() => calls >= 4, "a beat after the second failure");
  hb.stop();
  assert.deepEqual(errors, ["down 1", "down 3"]);
});

test("can be stopped and restarted without duplicating the timer", async () => {
  let beats = 0;
  const hb = startHeartbeat(async () => void beats++, 10);
  await waitFor(() => beats >= 2, "initial beats");
  hb.stop();
  hb.stop();
  const pausedAt = beats;
  await sleep(50);
  assert.equal(beats, pausedAt);

  hb.start();
  hb.start();
  await waitFor(() => beats >= pausedAt + 2, "beats after restart");
  hb.stop();
  const stoppedAgainAt = beats;
  await sleep(50);
  assert.equal(beats, stoppedAgainAt);
});
