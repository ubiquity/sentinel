import assert from "node:assert/strict";

const workflow = await Deno.readTextFile(".github/workflows/supervisor.yml");
function job(name: string): string {
  const start = workflow.indexOf("  " + name + ":\n");
  assert.ok(start >= 0, "missing job " + name);
  const after = workflow.slice(start + 3);
  const next = after.search(/\n {2}[a-z_]+:\n/);
  return next < 0
    ? workflow.slice(start)
    : workflow.slice(start, start + 3 + next);
}

Deno.test("protected matrix workflow preserves verification, fanout, credentials and immutable artifacts", () => {
  const prepare = job("prepare");
  const plan = job("matrix_plan");
  const cell = job("matrix_cell");
  const repair = job("repair");
  const finalize = job("finalize");
  assert.ok(
    prepare.includes(
      "modelStartsEnabled: $" +
        "{{ steps.prepare.outputs.modelStartsEnabled }}",
    ),
  );
  assert.match(plan, /needs.prepare.outputs.modelStartsEnabled == 'true'/);
  assert.match(cell, /needs.matrix_plan.outputs.hasCells == 'true'/);
  assert.match(cell, /fail-fast: false/);
  assert.ok(!cell.includes("max-parallel"));
  assert.match(repair, /needs: \[prepare, matrix_plan, matrix_cell\]/);
  assert.match(repair, /needs.prepare.outputs.modelStartsEnabled != 'true'/);
  assert.match(
    finalize,
    /needs: \[prepare, matrix_plan, matrix_cell, repair\]/,
  );
  assert.match(cell, /contents: read/);
  assert.ok(!cell.includes("contents: write"));
  assert.match(cell, /permission-contents: read/);
  assert.match(cell, /permission-issues: read/);
  assert.match(cell, /permission-pull-requests: read/);
  assert.ok(!cell.includes("SENTINEL_SUPERVISOR_APP_PRIVATE_KEY:"));
  assert.ok(plan.includes("group: sentinel-repair"));
  assert.ok(!cell.includes("sentinel-repair"));
  assert.ok(repair.includes("group: sentinel-repair"));
  for (
    const [stage, name] of [[plan, "Plan isolated issue matrix"], [
      cell,
      "Run isolated issue cell",
    ], [repair, "Run selected Sentinel runtime"]]
  ) {
    assert.ok(stage.includes("- name: " + name));
    assert.ok(stage.includes("path: launcher"));
    assert.ok(stage.includes("path: runtime"));
    assert.ok(
      stage.includes('ref: $" + "{{ github.sha }}'.replace('" + "', "")),
    );
    assert.ok(stage.includes("src/host/hosted-runtime.ts"));
  }
  assert.match(plan, /path: \.sentinel-matrix\/plan.json/);
  assert.match(plan, /planArtifactDigest:/);
  assert.match(cell, /cellArtifactDigest:/);
  assert.match(cell, /\.sentinel-matrix\/result.json/);
  assert.match(cell, /include-hidden-files: true/);
  assert.ok(
    cell.includes(
      '{"planDigest":"$' +
        '{{ needs.matrix_plan.outputs.planDigest }}","cellId":"$' +
        '{{ matrix.cellId }}"}',
    ),
  );
  assert.ok(
    repair.includes(
      '{"planDigest":"$' + '{{ needs.matrix_plan.outputs.planDigest }}"}',
    ),
  );
  assert.ok(!workflow.includes("GITHUB_JOB:"));
});
