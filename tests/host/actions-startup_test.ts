/** Cold executable graph coverage, separate from the injected host lifecycle tests. */
import assert from "node:assert/strict";

const ROOT = new URL("../../", import.meta.url);

async function copyTree(source: URL, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const input = new URL(entry.name, source);
    const output = `${destination}/${entry.name}`;
    if (entry.isDirectory) {
      await copyTree(new URL(`${entry.name}/`, source), output);
    } else if (entry.isFile) {
      await Deno.copyFile(input, output);
    }
  }
}

Deno.test("hosted startup: cold actions entrypoint can load its artifact transport", async () => {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-actions-startup-",
    dir: ROOT.pathname,
  });
  try {
    await copyTree(new URL("src/", ROOT), `${root}/src`);
    await Deno.copyFile(new URL("deno.json", ROOT), `${root}/deno.json`);
    await Deno.copyFile(new URL("deno.lock", ROOT), `${root}/deno.lock`);
    const entrypoint = `${root}/src/host/actions.ts`;
    const source = await Deno.readTextFile(entrypoint);
    const main = source.lastIndexOf("if (import.meta.main) {");
    assert.ok(main > 0, "the production executable must have its main guard");
    // Retain the exact production dependency graph and top-level-await boundary.
    // Replace only the external host setup with the first artifact load: no Git,
    // credential, HTTP or model operation is needed to expose this deadlock.
    // An ordinary test import evaluates actions.ts first and misses the cycle.
    await Deno.writeTextFile(
      entrypoint,
      source.slice(0, main) + `if (import.meta.main) {
  const transport = await import("./matrix-artifacts.ts");
  if (typeof transport.createActionsMatrixArtifactTransport !== "function") {
    throw new Error("artifact transport unavailable");
  }
  console.log("artifact transport loaded");
}\n`,
    );
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "--frozen", "--cached-only", entrypoint],
      clearEnv: true,
      env: { DENO_DIR: `${root}/empty-deno-cache` },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const result = await child.output();
      assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
      assert.equal(
        new TextDecoder().decode(result.stdout).trim(),
        "artifact transport loaded",
      );
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
