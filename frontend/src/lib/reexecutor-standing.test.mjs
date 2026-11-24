import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reexecutorStanding } from "./reexecutor-standing.ts";

const makeRx = (overrides = {}) => ({
  id: "rx-1",
  stellar_account: "GA...",
  stake_amount: "1000",
  stake_asset: "XLM",
  active: true,
  approved: true,
  can_vote: true,
  online: true,
  ...overrides,
});

describe("reexecutorStanding priority order", () => {
  it("priority 1: inactive takes precedence over everything", () => {
    // Inactive, even if approved, online, allowlist on/off
    const r1 = makeRx({ active: false, approved: true, online: true });
    assert.deepEqual(reexecutorStanding(r1, true), {
      label: "Below stake floor",
      tone: "expired",
      note: "Stake is under the contract's minimum, so it is not assigned work.",
    });

    // Inactive, also not approved and offline
    const r2 = makeRx({ active: false, approved: false, online: false });
    assert.deepEqual(reexecutorStanding(r2, true), {
      label: "Below stake floor",
      tone: "expired",
      note: "Stake is under the contract's minimum, so it is not assigned work.",
    });
    assert.deepEqual(reexecutorStanding(r2, false), {
      label: "Below stake floor",
      tone: "expired",
      note: "Stake is under the contract's minimum, so it is not assigned work.",
    });
  });

  it("priority 2: allow-list and not approved takes precedence over offline / online", () => {
    // Active, allowlist true, not approved, offline -> Pending approval (not Offline)
    const r1 = makeRx({ active: true, approved: false, online: false });
    assert.deepEqual(reexecutorStanding(r1, true), {
      label: "Pending approval",
      tone: "pending",
      note: "Staked. Waiting for the deployment admin to approve it as a voter.",
    });

    // Active, allowlist true, not approved, online -> Pending approval
    const r2 = makeRx({ active: true, approved: false, online: true });
    assert.deepEqual(reexecutorStanding(r2, true), {
      label: "Pending approval",
      tone: "pending",
      note: "Staked. Waiting for the deployment admin to approve it as a voter.",
    });
  });

  it("priority 3: offline takes precedence over online when active and approved (or no allow-list)", () => {
    // Active, allowlist true, approved true, offline -> Offline
    const r1 = makeRx({ active: true, approved: true, online: false });
    assert.deepEqual(reexecutorStanding(r1, true), {
      label: "Offline",
      tone: "expired",
      note: "Able to vote, but no worker has polled for work recently, so it is not assigned any.",
    });

    // Active, allowlist false, unapproved, offline -> Offline (approval not required without allowlist)
    const r2 = makeRx({ active: true, approved: false, online: false });
    assert.deepEqual(reexecutorStanding(r2, false), {
      label: "Offline",
      tone: "expired",
      note: "Able to vote, but no worker has polled for work recently, so it is not assigned any.",
    });
  });

  it("priority 4: online when active, approved (or no allowlist), and online", () => {
    // Active, allowlist true, approved true, online -> Online
    const r1 = makeRx({ active: true, approved: true, online: true });
    assert.deepEqual(reexecutorStanding(r1, true), {
      label: "Online",
      tone: "verified",
      note: "Staked, able to vote, and its worker is polling for work.",
    });

    // Active, allowlist false, unapproved, online -> Online
    const r2 = makeRx({ active: true, approved: false, online: true });
    assert.deepEqual(reexecutorStanding(r2, false), {
      label: "Online",
      tone: "verified",
      note: "Staked, able to vote, and its worker is polling for work.",
    });
  });
});
