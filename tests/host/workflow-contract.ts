/** Exact supported maintenance/prepare contracts; no permissive mixed mode. */
import assert from "node:assert/strict";

export function assertSupervisorMaintenanceContract(
  text: string,
): "ordinary" | "recovery" {
  const maintenanceAt = text.indexOf("\n  maintenance:");
  const prepareAt = text.indexOf("\n  prepare:");
  const matrixAt = text.indexOf("\n  matrix_plan:");
  const finalizeAt = text.indexOf("\n  finalize:");
  assert.ok(
    maintenanceAt > 0 && prepareAt > maintenanceAt && matrixAt > prepareAt &&
      finalizeAt > matrixAt,
  );
  const maintenance = text.slice(maintenanceAt, prepareAt);
  const prepare = text.slice(prepareAt, matrixAt);
  const finalize = text.slice(finalizeAt);
  assert.match(prepare, /prepare:\s*\n\s*needs: maintenance\s*\n/);
  // Scoped owner recovery suppresses the maintenance writer; the removed
  // --startup-recovery markers no longer appear in the workflow, so detect
  // the mode from the suppression itself.
  const recovery = /^ {4}if: \$\{\{ false \}\}$/m.test(maintenance);
  if (recovery) {
    assert.match(
      prepare,
      /^ {4}if: always\(\) && needs\.maintenance\.result == 'skipped' && github\.ref == 'refs\/heads\/sentinel-supervisor'$/m,
    );
    for (const job of [prepare, finalize]) {
      assert.match(job, /^ {8}run: deno task supervisor:run$/m);
    }
    assert.doesNotMatch(
      text,
      /--startup-recovery|--owner-startup-recovery-only/,
    );
    return "recovery";
  }
  assert.doesNotMatch(text, /--startup-recovery|--owner-startup-recovery-only/);
  assert.match(
    maintenance,
    /^ {4}if: github\.ref == 'refs\/heads\/sentinel-supervisor'$/m,
  );
  assert.match(
    prepare,
    /^ {4}if: always\(\) && needs\.maintenance\.result == 'success' && github\.ref == 'refs\/heads\/sentinel-supervisor'$/m,
  );
  for (const job of [prepare, finalize]) {
    assert.match(job, /^ {8}run: deno task supervisor:run$/m);
  }
  return "ordinary";
}
