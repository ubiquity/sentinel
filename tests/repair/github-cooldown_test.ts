import assert from "node:assert/strict";
import { makeRepairRig } from "../integration/helpers.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";

Deno.test("cooldown durable: actual HTTP through durable Git gate with restart/shared installation, deadlines, backoff, manual hold and fault latch", async () => {
  const rig = await makeRepairRig("cooldown-durable-primary", {
    summaries: false,
  });
  try {
    await rig.run();
    const gate = new DurableGitHubCooldownGate({
      state: rig.store,
      clock: rig.clock,
    });
    let auth = 0, http = 0;
    const client = (g = gate, name = "first") =>
      new GitHubApiClient({
        repository: { owner: "uos", name, installationId: 7 },
        apiBaseUrl: "https://api.github.com",
        clock: rig.clock,
        cooldownGate: g,
        auth: {
          authorizationHeader: () => {
            auth++;
            return Promise.resolve(portOk("Bearer synthetic"));
          },
        },
        http: () => {
          http++;
          return Promise.resolve({
            status: 429,
            headers: new Headers({ "retry-after": "7200" }),
            bodyText: "",
          });
        },
      });
    const observedAt = rig.clock.now();
    const first = await client().listOpenIssues();
    assert.equal(first.ok, false);
    let snapshot = await rig.snapshot();
    assert.equal(
      snapshot.githubCooldowns[0].retryNotBefore,
      observedAt + 7200000,
    );
    const restarted = new DurableGitHubCooldownGate({
      state: rig.store,
      clock: rig.clock,
    });
    assert.equal(
      (await client(restarted, "second").listOpenIssues()).ok,
      false,
    );
    assert.equal(auth, 1);
    assert.equal(http, 1);
    assert.equal(snapshot.reservations.length, 0);
    assert.equal((await restarted.beforeRequest(8)).ok, true);
    rig.clock.advance(7200000);
    assert.equal((await restarted.beforeRequest(7)).ok, true);
    const before = rig.clock.now();
    const fallback = (time: number, id: string) => ({
      kind: "secondary" as const,
      observedAt: time,
      retryNotBefore: time + 60000,
      observationId: id.repeat(64),
      fallback: true,
    });
    assert.equal(
      (await restarted.recordRateLimit(7, fallback(before, "a"))).ok,
      true,
    );
    snapshot = await rig.snapshot();
    assert.equal(snapshot.githubCooldowns[0].secondaryBackoff, 1);
    const sequence = snapshot.sequence;
    assert.equal(
      (await restarted.recordRateLimit(7, fallback(before, "a"))).ok,
      true,
    );
    assert.equal((await rig.snapshot()).sequence, sequence);
    rig.clock.advance(1);
    assert.equal(
      (await restarted.recordRateLimit(7, fallback(before + 1, "b"))).ok,
      true,
    );
    snapshot = await rig.snapshot();
    assert.equal(snapshot.githubCooldowns[0].secondaryBackoff, 2);
    assert.equal(snapshot.githubCooldowns[0].retryNotBefore, before + 120001);
    assert.equal(
      (await restarted.recordRateLimit(7, {
        kind: "primary",
        observedAt: before + 2,
        retryNotBefore: null,
        observationId: "c".repeat(64),
        fallback: false,
      })).ok,
      true,
    );
    rig.clock.advance(99999999);
    assert.equal((await restarted.beforeRequest(7)).ok, false);
    let writes = 0;
    const faulty = {
      readRepair: rig.store.readRepair.bind(rig.store),
      readRelease: rig.store.readRelease.bind(rig.store),
      writeRepair: () => {
        writes++;
        return Promise.resolve(portError("unavailable", "synthetic"));
      },
    };
    const faultGate = new DurableGitHubCooldownGate({
      state: faulty,
      clock: rig.clock,
    });
    assert.equal(
      (await faultGate.recordRateLimit(8, fallback(rig.clock.now(), "d"))).ok,
      false,
    );
    assert.equal((await faultGate.beforeRequest(8)).ok, false);
    assert.equal(
      (await faultGate.recordRateLimit(8, fallback(rig.clock.now(), "e"))).ok,
      false,
    );
    assert.equal(writes, 1);
    for (const status of ["conflict", "ambiguous"] as const) {
      let attempts = 0;
      const state = {
        readRepair: rig.store.readRepair.bind(rig.store),
        readRelease: rig.store.readRelease.bind(rig.store),
        writeRepair: () => {
          attempts++;
          return Promise.resolve(portOk({ status, currentHead: null }));
        },
      };
      const failedGate = new DurableGitHubCooldownGate({
        state,
        clock: rig.clock,
      });
      assert.equal(
        (await failedGate.recordRateLimit(9, fallback(rig.clock.now(), "f")))
          .ok,
        false,
      );
      assert.equal((await failedGate.beforeRequest(9)).ok, false);
      assert.equal(
        (await failedGate.recordRateLimit(9, fallback(rig.clock.now(), "e")))
          .ok,
        false,
      );
      assert.equal(attempts, 1, `${status} must latch without retry`);
    }
    let readUnavailable = true;
    const failingRead = {
      readRepair: () =>
        readUnavailable
          ? Promise.resolve(portError("unavailable", "synthetic read failure"))
          : rig.store.readRepair(),
      readRelease: rig.store.readRelease.bind(rig.store),
      writeRepair: rig.store.writeRepair.bind(rig.store),
    };
    const readFault = new DurableGitHubCooldownGate({
      state: failingRead,
      clock: rig.clock,
    });
    const faulted = await readFault.beforeRequest(9);
    assert.equal(faulted.ok, false);
    if (!faulted.ok) {
      assert.equal(faulted.error.kind, "unavailable");
      assert.match(faulted.error.detail, /state unavailable/);
    }
    // The source recovers, but the BOUNDED window still refuses: a request is
    // never gated open on trust while a fault is unproven.
    readUnavailable = false;
    assert.equal(
      (await readFault.beforeRequest(9)).ok,
      false,
      "the open fault window keeps refusing after source recovery",
    );
    // Once the window elapses the gate re-reads the recovered state instead of
    // refusing forever, so a bookkeeping problem can never freeze the lane.
    rig.clock.advance(61_000);
    assert.ok(
      (await readFault.beforeRequest(9)).ok,
      "the bounded window reopens on a readable state",
    );
    // A fault that is still real after the window re-arms the refusal.
    readUnavailable = true;
    assert.equal((await readFault.beforeRequest(9)).ok, false);
    readUnavailable = false;
    rig.clock.advance(61_000);
    assert.ok((await readFault.beforeRequest(9)).ok);

    console.log(
      "PASS actual HTTP -> durable Git store -> restart/shared installation, deadlines, backoff, manual hold and fault latch",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});
