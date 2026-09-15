/**
 * Trusted deterministic CI approval for durable self-target PR candidates.
 *
 * GitHub can park a `pull_request` CI run created by `github-actions[bot]` in
 * `action_required` until a trusted actor approves it. This helper reads the
 * current repair state, selects at most `MAX_CI_APPROVALS_PER_RUN` nonterminal
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
import { portOk } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { hasCandidateState } from "../contracts/work-record.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { GitHubApiClient } from "../github/client.ts";
import type { HttpTransportV1 } from "../github/http.ts";

/** Public GitHub REST API used by the hosted CI approval. */
export const ACTIONS_CI_API_BASE_URL = "https://api.github.com";
/** Bounded candidates per run: one exclusive writer, no unbounded scan. */
export const MAX_CI_APPROVALS_PER_RUN = 3;

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
  /** Trusted API base for tests; production uses the public API. */
  apiBaseUrl?: string;
}

export interface ActionsCiApprovalSummaryV1 {
  approved: number;
  pending: number;
  unavailable: number;
}

/** Approve at most three exact self-target candidate runs. Never throws. */
export async function runActionsCiApproval(
  input: ActionsCiApprovalInputV1,
): Promise<ActionsCiApprovalSummaryV1> {
  const summary: ActionsCiApprovalSummaryV1 = {
    approved: 0,
    pending: 0,
    unavailable: 0,
  };
  try {
    const read = await input.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      summary.unavailable = 1;
      return summary;
    }
    const candidates = read.value.snapshot.work
      .filter(isSelfCandidate)
      .slice(0, MAX_CI_APPROVALS_PER_RUN);
    if (candidates.length === 0) return summary;
    const client = new GitHubApiClient({
      repository: { ...SELF_REPOSITORY },
      apiBaseUrl: input.apiBaseUrl ?? ACTIONS_CI_API_BASE_URL,
      http: input.http,
      auth: {
        authorizationHeader: () =>
          Promise.resolve(portOk(`Bearer ${input.token}`)),
      },
      cooldownGate: input.gate,
      clock: input.clock,
    });
    for (const record of candidates) {
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
  // Parked V1 candidate work is excluded BEFORE the bounded slice so it can
  // never consume one of the three approval slots or receive an auto-approval;
  // later eligible legacy PRs keep their normal approval behavior.
  if (hasCandidateState(record)) return false;
  return record.repository.owner === SELF_REPOSITORY.owner &&
    record.repository.name === SELF_REPOSITORY.name &&
    record.repository.installationId === SELF_REPOSITORY.installationId &&
    record.nextStep !== "done" &&
    record.target.pr !== null &&
    record.target.head !== null &&
    record.target.branch !== null;
}
