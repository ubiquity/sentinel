// Test-only budget helpers: synthetic repository configs (parsed by the frozen
// parser, never via env/CLI), a deterministic fake clock, and a minimal
// in-memory repair state capability for boundary arithmetic and injected
// faults. Real Git cases in git_budget_test.ts use the shared state helpers.
import {
  parseBudgetReservationV1,
} from "../../src/contracts/budget-reservation.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import {
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type {
  Clock,
  PortResultV1,
  RepairStateWriter,
  StateReadResultV1,
  StateReadView,
  StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import { REPO, reservation, SHA1, T0 } from "../state/helpers.ts";
import type { ReserveModelStartRequestV1 } from "../../src/budget/mod.ts";

/** A second repository for cross-repo global-budget tests. */
export const REPO_2 = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 9,
} as const;

export interface BudgetLimits {
  perHour: number;
  /** Numeric rolling weekly cap, or explicit null for no weekly cap. */
  perSevenDays: number | null;
}

/** Minimal valid config via the frozen parser; explicit synthetic caps only. */
export function repositoryConfig(
  repository: typeof REPO | typeof REPO_2 = REPO,
  limits: BudgetLimits = { perHour: 2, perSevenDays: 5 },
  overrides: Record<string, unknown> = {},
): RepositoryConfigV1 {
  return parseRepositoryConfigV1({
    version: "v1",
    kind: "repository_config",
    repository,
    baseBranch: "development",
    adapter: { kind: "gateway", baseUrl: "https://ai.ubq.fi" },
    commands: { replay: "replay_capture", test: "test_ci" },
    commandRegistry: {
      version: "v1",
      commands: {
        replay_capture: {
          executable: "deno",
          args: ["task", "replay:capture"],
          maxDurationMs: 600000,
          maxOutputBytes: 1048576,
        },
        test_ci: {
          executable: "deno",
          args: ["task", "test-local"],
          maxDurationMs: 1800000,
          maxOutputBytes: 4194304,
        },
      },
    },
    protectedPaths: [],
    build: { projectId: null, acceptance: null },
    secretRef: null,
    liveStartLimits: limits,
    sessionBound: { maxDurationMs: 7200000, maxOutputChars: 400000 },
    retention: null,
    stabilityPolicy: null,
    ...overrides,
  });
}

export function reserveRequest(
  taskId: string,
  overrides: Partial<ReserveModelStartRequestV1> = {},
): ReserveModelStartRequestV1 {
  return {
    repository: REPO,
    taskId: taskId as WorkItemId,
    head: SHA1,
    attempt: 1,
    purpose: "implementation",
    ...overrides,
  };
}

export function seededReservation(
  id: string,
  overrides: Record<string, unknown> = {},
): BudgetReservationV1 {
  return parseBudgetReservationV1(
    reservation(id, overrides) as unknown,
  );
}

export class FakeClock implements Clock {
  private current: number;

  constructor(start: number = T0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  set(value: number): void {
    this.current = value;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export type FaultKind =
  | "read_fail"
  | "read_throw"
  | "write_fail"
  | "write_throw"
  | "write_conflict"
  | "write_ambiguous";

/**
 * Minimal deterministic in-memory repair state: same result shapes as the
 * production store (stateHead CAS: the candidate must extend exactly the
 * current head), full snapshot validation via the frozen parser, and injected
 * faults. Carries no product logic beyond what the production store enforces.
 */
export class MemoryRepairState implements StateReadView, RepairStateWriter {
  private snapshot: RepairStateSnapshotV1 | null = null;
  private head: GitSha | null = null;
  private counter = 0;
  /** Pending fault consumed on the next matching operation. */
  fault: FaultKind | null = null;
  writes = 0;

  private nextHead(): GitSha {
    this.counter++;
    return `${this.counter.toString(16).padStart(40, "0")}` as GitSha;
  }

  readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    if (this.fault === "read_throw") {
      this.fault = null;
      // A raw rejection: the exception text would leak a path if it escaped.
      return Promise.reject(new Error("synthetic transport rejection"));
    }
    if (this.fault === "read_fail") {
      this.fault = null;
      return Promise.resolve(
        portError("unavailable", "synthetic read failure"),
      );
    }
    if (this.snapshot === null || this.head === null) {
      return Promise.resolve(portOk({
        status: "absent",
        currentHead: null,
        ref: "refs/heads/sentinel-state/repair",
      }));
    }
    return Promise.resolve(portOk({
      status: "found",
      snapshot: this.snapshot,
      head: this.head,
      ref: "refs/heads/sentinel-state/repair",
    }));
  }

  // The budget only reads repair state; release is out of scope for this fake.
  readRelease(): Promise<
    PortResultV1<StateReadResultV1<never>>
  > {
    return Promise.resolve(
      portError("unavailable", "release reads are not part of the budget fake"),
    ) as Promise<PortResultV1<StateReadResultV1<never>>>;
  }

  writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    if (this.fault === "write_throw") {
      this.fault = null;
      // A raw rejection after an effect that may have happened: the caller
      // must treat this as ambiguous and reconcile by rereading.
      return Promise.reject(new Error("synthetic transport rejection"));
    }
    if (this.fault === "write_fail") {
      this.fault = null;
      return Promise.resolve(
        portError("unavailable", "synthetic write failure"),
      );
    }
    if (this.head !== expectedHead) {
      return Promise.resolve(portOk({
        status: "conflict",
        currentHead: this.head,
      }));
    }
    try {
      parseRepairStateSnapshotV1(next);
    } catch {
      return Promise.resolve(
        portError("invalid", "state snapshot failed contract validation"),
      );
    }
    this.writes++;
    if (this.fault === "write_conflict") {
      this.fault = null;
      return Promise.resolve(
        portOk({ status: "conflict", currentHead: this.head }),
      );
    }
    // An ambiguous simulation applies the write (the push succeeded but its
    // response may be lost); a later reread then finds the durable record.
    if (this.fault === "write_ambiguous") {
      this.fault = null;
      this.snapshot = next;
      this.head = this.nextHead();
      return Promise.resolve(
        portOk({ status: "ambiguous", currentHead: this.head }),
      );
    }
    this.snapshot = next;
    this.head = this.nextHead();
    return Promise.resolve(portOk({ status: "applied", head: this.head }));
  }

  /** Test-side seeding with a snapshot already validated by the parser. */
  seed(snapshot: RepairStateSnapshotV1, head: GitSha | null = null): void {
    this.snapshot = parseRepairStateSnapshotV1(snapshot);
    this.head = head ?? this.nextHead();
  }

  current(): { snapshot: RepairStateSnapshotV1 | null; head: GitSha | null } {
    return { snapshot: this.snapshot, head: this.head };
  }
}
