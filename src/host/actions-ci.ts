/**
 * Trusted deterministic CI approval for durable self-target PR candidates.
 *
 * GitHub can park a `pull_request` CI run created by `github-actions[bot]` in
 * `action_required` until a trusted actor approves it. This helper reads the
 * current repair state, selects all eligible nonterminal
 * scope-0 `ubiquity/sentinel` records that carry a durable PR/head/branch
 * candidate, and asks the real `GitHubApiClient` to approve the ONE exact
 * matching run for each through the existing token, HTTP transport, clock and
 * durable cooldown gate. It writes no work/budget state, starts no model,
 * sleeps and loops on nothing, and every failure is a bounded `unavailable`
 * count — an approval problem can never prevent deterministic repair
 * bookkeeping or drain.
 */

import type {
  Clock,
  GitHubCooldownGateV1,
  StateReadView,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { GitHubApiClient } from "../github/client.ts";
import { DEFAULT_HTTP_DEADLINE_MS } from "../github/http.ts";
import type { HttpTransportV1 } from "../github/http.ts";

/** Public GitHub REST API used by the hosted CI approval. */
export const ACTIONS_CI_API_BASE_URL = "https://api.github.com";

const SELF_REPOSITORY: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
};

export interface ActionsCiApprovalInputV1 {
  state: StateReadView;
  gate: GitHubCooldownGateV1;
  http: HttpTransportV1;
  token: string;
  clock: Clock;
  /** Existing absolute host deadline; never restarted for approval. */
  deadline: number;
  /** Trusted API base for tests; production uses the public API. */
  apiBaseUrl?: string;
}

export interface ActionsCiApprovalSummaryV1 {
  approved: number;
  pending: number;
  unavailable: number;
}

/** Approve eligible exact self-target candidate runs. Never throws. */
export async function runActionsCiApproval(
  input: ActionsCiApprovalInputV1,
): Promise<ActionsCiApprovalSummaryV1> {
  const summary: ActionsCiApprovalSummaryV1 = {
    approved: 0,
    pending: 0,
    unavailable: 0,
  };
  try {
    if (
      !Number.isFinite(input.deadline) || input.clock.now() >= input.deadline
    ) {
      summary.unavailable = 1;
      return summary;
    }
    const read = await input.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      summary.unavailable = 1;
      return summary;
    }
    const candidates = read.value.snapshot.work.filter(isSelfCandidate);
    if (candidates.length === 0) return summary;
    const gate: GitHubCooldownGateV1 = {
      beforeRequest: async (installationId) => {
        if (input.clock.now() >= input.deadline) {
          return portError("unavailable", "CI approval deadline reached");
        }
        const result = await input.gate.beforeRequest(installationId);
        if (input.clock.now() >= input.deadline) {
          return portError("unavailable", "CI approval deadline reached");
        }
        return result;
      },
      recordRateLimit: (installationId, rateLimit) =>
        input.gate.recordRateLimit(installationId, rateLimit),
    };
    const http: HttpTransportV1 = (request) => {
      const remaining = Math.min(
        DEFAULT_HTTP_DEADLINE_MS,
        input.deadline - input.clock.now(),
      );
      if (!(remaining > 0)) {
        return Promise.reject(new Error("CI approval deadline reached"));
      }
      return input.http({ ...request, deadlineMs: remaining });
    };
    const client = new GitHubApiClient({
      repository: { ...SELF_REPOSITORY },
      apiBaseUrl: input.apiBaseUrl ?? ACTIONS_CI_API_BASE_URL,
      http,
      auth: {
        authorizationHeader: () =>
          Promise.resolve(portOk(`Bearer ${input.token}`)),
      },
      cooldownGate: gate,
      clock: input.clock,
    });
    for (const record of candidates) {
      if (input.clock.now() >= input.deadline) {
        summary.unavailable++;
        break;
      }
      const pr = record.target.pr;
      const head = record.target.head;
      const headRef = record.target.branch;
      if (pr === null || head === null || headRef === null) continue;
      const result = await client.approveExactCiRun({
        number: pr,
        head,
        headRef,
      });
      if (!result.ok) {
        summary.unavailable++;
        continue;
      }
      if (result.value.status === "approved") summary.approved++;
      else summary.pending++;
    }
  } catch {
    // Bounded unavailable: no raw error, no state write, no rethrow.
    summary.unavailable++;
  }
  return summary;
}

/** Nonterminal scope-0 self-target record with a durable PR/head/branch. */
function isSelfCandidate(record: WorkRecordV1): boolean {
  // New-format candidate records are approved ONLY with an exact preserved
  // descriptor bound to the target and a verified published head equal to the
  // requested head. Ineligible new-format records never reach the API; legacy
  // records keep their normal exact API PR/head/branch verification below.
  const candidateState = record.target.candidateState;
  if (candidateState !== undefined) {
    const preserved = candidateState.preserved;
    if (preserved === null) return false;
    if (
      candidateState.publishedHead === null ||
      record.target.head === null ||
      candidateState.publishedHead !== record.target.head
    ) {
      return false;
    }
    if (
      preserved.head !== record.target.head ||
      preserved.base !== record.target.base
    ) {
      return false;
    }
  }
  return record.repository.owner === SELF_REPOSITORY.owner &&
    record.repository.name === SELF_REPOSITORY.name &&
    record.repository.installationId === SELF_REPOSITORY.installationId &&
    record.nextStep !== "done" &&
    record.target.pr !== null &&
    record.target.head !== null &&
    record.target.branch !== null;
}
