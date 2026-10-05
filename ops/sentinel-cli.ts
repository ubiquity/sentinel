#!/usr/bin/env -S deno run --allow-run=gh
/**
 * sentinel - manual dispatcher for ubiquity/sentinel GitHub Actions.
 *
 * Owner decision 2026-10-05: scheduled cron triggers are disabled. Workflows
 * run only when dispatched through this tool (or an equivalent explicit API
 * call). Sentinel's runtime supervisor is dispatched at the protected
 * `sentinel-supervisor` ref; the observer and repair dispatcher run on
 * `development`.
 *
 * Usage:
 *   sentinel status [--json]
 *   sentinel dispatch <observe|supervisor|repair>
 *   sentinel wait <observe|supervisor|repair> [--timeout-min N] [--dispatch]
 *   sentinel run <observe|supervisor> [--timeout-min N]
 *   sentinel receipts <run-id> [--grep <pattern>]
 */

const REPO = "ubiquity/sentinel";

type Target = "observe" | "supervisor" | "repair";
interface TargetSpec {
  workflow: string;
  ref: string;
  label: string;
}
const TARGETS: Record<Target, TargetSpec> = {
  observe: {
    workflow: "observe.yml",
    ref: "development",
    label: "sentinel-observe",
  },
  supervisor: {
    workflow: "supervisor.yml",
    ref: "sentinel-supervisor",
    label: "sentinel-supervisor",
  },
  repair: {
    workflow: "repair.yml",
    ref: "development",
    label: "sentinel-repair",
  },
};

interface Run {
  databaseId: number;
  status: string;
  conclusion: string | null;
  createdAt: string;
  event: string;
  headSha: string;
  url: string;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) out[arg.slice(2, eq)] = arg.slice(eq + 1);
      else out[arg.slice(2)] = argv[++i] ?? "true";
    } else out._ = out._ ? `${out._} ${arg}` : arg;
  }
  return out;
}

async function gh(args: string[]): Promise<string> {
  const command = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const decoder = new TextDecoder();
  if (code !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed (${code}): ${
        decoder.decode(stderr).trim().slice(0, 500)
      }`,
    );
  }
  return decoder.decode(stdout);
}

async function listRuns(workflow: string, limit: number): Promise<Run[]> {
  const raw = await gh([
    "run",
    "list",
    "-R",
    REPO,
    "--workflow",
    workflow,
    "--limit",
    String(limit),
    "--json",
    "databaseId,status,conclusion,createdAt,event,headSha,url",
  ]);
  return JSON.parse(raw) as Run[];
}

async function dispatch(target: Target): Promise<{ run: Run | null }> {
  const spec = TARGETS[target];
  const before = Date.now();
  await gh([
    "api",
    "--method",
    "POST",
    `repos/${REPO}/actions/workflows/${spec.workflow}/dispatches`,
    "-f",
    `ref=${spec.ref}`,
  ]);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const runs = await listRuns(spec.workflow, 5);
    const hit = runs.find((r) =>
      Date.parse(r.createdAt) >= before - 30_000 &&
      r.event === "workflow_dispatch"
    );
    if (hit) return { run: hit };
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return { run: null };
}

async function waitForRun(
  workflow: string,
  runId: number | null,
  timeoutMin: number,
): Promise<Run> {
  const deadline = Date.now() + timeoutMin * 60_000;
  let current: Run | null = null;
  while (Date.now() < deadline) {
    const runs = await listRuns(workflow, 8);
    current = runId === null
      ? runs[0] ?? null
      : runs.find((r) => r.databaseId === runId) ?? null;
    if (current && current.status === "completed") return current;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  if (!current) throw new Error(`no run found for ${workflow}`);
  return current;
}

async function failedJobs(runId: number): Promise<unknown> {
  const raw = await gh([
    "run",
    "view",
    String(runId),
    "-R",
    REPO,
    "--json",
    "jobs",
  ]);
  const parsed = JSON.parse(raw) as {
    jobs: Array<
      {
        name: string;
        conclusion: string;
        steps: Array<{ name: string; conclusion: string }>;
      }
    >;
  };
  return parsed.jobs
    .filter((j) => j.conclusion !== "success")
    .map((j) => ({
      job: j.name,
      failedSteps: j.steps.filter((s) => s.conclusion === "failure").map((s) =>
        s.name
      ),
    }));
}

function requireTarget(value: string | undefined): Target {
  if (value === "observe" || value === "supervisor" || value === "repair") {
    return value;
  }
  throw new Error(
    `target must be observe|supervisor|repair, got '${value ?? ""}'`,
  );
}

async function cmdStatus(json: boolean): Promise<void> {
  const rows: Record<string, unknown> = {};
  for (const target of Object.keys(TARGETS) as Target[]) {
    const runs = await listRuns(TARGETS[target].workflow, 3);
    rows[target] = runs.map((r) => ({
      id: r.databaseId,
      conclusion: r.conclusion ?? r.status,
      event: r.event,
      createdAt: r.createdAt,
      url: r.url,
    }));
  }
  const recentBotMerges = JSON.parse(
    await gh([
      "pr",
      "list",
      "-R",
      REPO,
      "--state",
      "merged",
      "--limit",
      "5",
      "--json",
      "number,mergedAt,author",
    ]),
  );
  if (json) {
    console.log(JSON.stringify({ runs: rows, recentBotMerges }, null, 2));
  } else {
    for (const [target, runs] of Object.entries(rows)) {
      console.log(`${target}:`);
      for (const run of runs as Array<Record<string, unknown>>) {
        console.log(
          `  ${run.createdAt}  ${
            String(run.conclusion).padEnd(9)
          }  #${run.id}  ${run.url}`,
        );
      }
    }
    console.log("recent bot merges:");
    for (
      const pr of recentBotMerges as Array<
        { mergedAt: string; number: number; author?: { login?: string } }
      >
    ) {
      console.log(
        `  ${pr.mergedAt}  #${pr.number}  ${pr.author?.login ?? "?"}`,
      );
    }
  }
}

async function cmdReceipts(
  runId: number,
  pattern: string | undefined,
): Promise<void> {
  const log = await gh(["run", "view", String(runId), "-R", REPO, "--log"]);
  const needles = pattern ? [pattern] : [
    "hosted_runtime_terminal",
    "hosted_runtime_early_failure",
    '"startupReady"',
    "issue_delivery",
    "release_request",
  ];
  const lines = log.split("\n").filter((line) =>
    needles.some((n) => line.includes(n))
  );
  console.log(lines.slice(-80).join("\n"));
}

async function main(): Promise<void> {
  const argv = Deno.args;
  const command = argv[0];
  const opts = parseArgs(argv.slice(1));
  switch (command) {
    case "status":
      await cmdStatus(opts.json === "true");
      break;
    case "dispatch": {
      const target = requireTarget(opts._);
      const { run } = await dispatch(target);
      if (!run) {
        throw new Error(
          `dispatch accepted but no run became visible for ${target}`,
        );
      }
      console.log(
        `dispatched ${TARGETS[target].label} ref=${
          TARGETS[target].ref
        } run=${run.databaseId} ${run.url}`,
      );
      break;
    }
    case "wait": {
      const target = requireTarget(opts._);
      let runId: number | null = null;
      if (opts.dispatch === "true") {
        const { run } = await dispatch(target);
        runId = run?.databaseId ?? null;
      }
      const run = await waitForRun(
        TARGETS[target].workflow,
        runId,
        Number(opts["timeout-min"] ?? 60),
      );
      console.log(
        JSON.stringify(
          {
            target,
            id: run.databaseId,
            status: run.status,
            conclusion: run.conclusion,
            url: run.url,
          },
          null,
          2,
        ),
      );
      if (run.conclusion !== "success") {
        console.log(JSON.stringify(await failedJobs(run.databaseId), null, 2));
        Deno.exit(1);
      }
      break;
    }
    case "run": {
      const target = requireTarget(opts._);
      const { run } = await dispatch(target);
      const timeoutMin = Number(opts["timeout-min"] ?? 60);
      const final = run
        ? await waitForRun(TARGETS[target].workflow, run.databaseId, timeoutMin)
        : await waitForRun(TARGETS[target].workflow, null, timeoutMin);
      console.log(
        JSON.stringify(
          {
            target,
            id: final.databaseId,
            status: final.status,
            conclusion: final.conclusion,
            url: final.url,
          },
          null,
          2,
        ),
      );
      if (final.conclusion !== "success") {
        console.log(
          JSON.stringify(await failedJobs(final.databaseId), null, 2),
        );
        Deno.exit(1);
      }
      break;
    }
    case "receipts":
      await cmdReceipts(Number(opts._), opts.grep);
      break;
    default:
      console.error("usage: sentinel status|dispatch|wait|run|receipts ...");
      Deno.exit(2);
  }
}

await main();
