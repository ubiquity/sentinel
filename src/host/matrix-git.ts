/**
 * Real bounded Git bundle transfer for matrix cells.
 *
 * The exporter runs in the trusted per-cell wrapper around its isolated
 * checkout: it creates a bundle containing the exact candidate head reachable
 * from the committed ref, named by the opaque cell id, and returns the SHA-256
 * of the exact bytes. The importer runs in the trusted per-target mirror used
 * by the ordinary preservation/publication consumers: it verifies the digest,
 * verifies the bundle, fetches it, and proves the exact head (and checkpoint)
 * are now real local objects with the planned base as an ancestor before any
 * state update. No snapshot travels; only the bounded candidate delta does.
 */
import type { GitSha } from "../contracts/brands.ts";
import { MAX_MATRIX_BUNDLE_BYTES } from "../contracts/matrix.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";

const BUNDLE_NAME = /^[0-9a-f]{64}\.bundle$/;

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  // Copy the exact view range into an owned ArrayBuffer so the digest input is
  // a plain BufferSource without hiding offset/SharedArrayBuffer risk.
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function runGit(dir: string, args: string[]): Promise<number> {
  try {
    const output = await new DenoReplayRuntime(Deno.execPath()).run({
      executable: "/usr/bin/git",
      args: [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.file.allow=always",
        "-C",
        dir,
        ...args,
      ],
      cwd: dir,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
      maxDurationMs: 60_000,
      maxOutputBytes: 1024 * 1024,
    });
    return output.outcome === "exited" && output.settled && !output.truncated
      ? output.exitCode ?? 1
      : 1;
  } catch {
    return 1;
  }
}

export interface MatrixBundleCreateRequestV1 {
  /** Planned checkout base; bounds the bundle to the candidate delta. */
  base: GitSha;
  head: GitSha;
  checkpointSha: GitSha | null;
  /** Safe basename inside the exporter output directory. */
  file: string;
}

export interface MatrixBundleExporterV1 {
  create(
    request: MatrixBundleCreateRequestV1,
  ): Promise<{ digest: string } | null>;
}

export interface MatrixBundleImportRequestV1 {
  base: GitSha;
  file: string;
  digest: string;
  head: GitSha;
  checkpointSha: GitSha | null;
}

export interface MatrixBundleImporterV1 {
  import(request: MatrixBundleImportRequestV1): Promise<boolean>;
}

/**
 * Exporter over one isolated cell checkout. The temporary committed ref is
 * cell-local trusted bookkeeping and is removed on every exit path.
 */
export function createGitBundleExporter(input: {
  repositoryDir: string;
  outputDir: string;
}): MatrixBundleExporterV1 {
  return {
    create: async (request) => {
      if (!BUNDLE_NAME.test(request.file)) return null;
      if (
        await runGit(input.repositoryDir, [
          "merge-base",
          "--is-ancestor",
          request.base,
          request.head,
        ]) !== 0
      ) return null;
      if (
        request.checkpointSha !== null &&
        (await runGit(input.repositoryDir, [
              "merge-base",
              "--is-ancestor",
              request.base,
              request.checkpointSha,
            ]) !== 0 ||
          await runGit(input.repositoryDir, [
              "merge-base",
              "--is-ancestor",
              request.checkpointSha,
              request.head,
            ]) !== 0)
      ) return null;
      const ref = `refs/sentinel-matrix/${request.file.slice(0, -7)}`;
      const path = `${input.outputDir}/${request.file}`;
      try {
        await Deno.mkdir(input.outputDir, { recursive: true });
      } catch {
        return null;
      }
      if (
        await runGit(input.repositoryDir, ["update-ref", ref, request.head]) !==
          0
      ) {
        return null;
      }
      let code: number;
      try {
        code = await runGit(input.repositoryDir, [
          "bundle",
          "create",
          path,
          ref,
          "^" + request.base,
        ]);
      } finally {
        await runGit(input.repositoryDir, ["update-ref", "-d", ref]);
      }
      if (code !== 0) return null;
      try {
        const info = await Deno.lstat(path);
        if (
          !info.isFile || info.isSymlink || info.size > MAX_MATRIX_BUNDLE_BYTES
        ) {
          return null;
        }
        const bytes = await Deno.readFile(path);
        return { digest: await sha256HexBytes(bytes) };
      } catch {
        return null;
      }
    },
  };
}

/**
 * Importer over the trusted per-target mirror. Every check is an actual Git
 * object query on this repository; a JSON pointer is never proof.
 */
export function createGitBundleImporter(input: {
  repositoryDir: string;
  bundlesDir: string;
}): MatrixBundleImporterV1 {
  return {
    import: async (request) => {
      if (!BUNDLE_NAME.test(request.file)) return false;
      if (!/^[0-9a-f]{64}$/.test(request.digest)) return false;
      const path = `${input.bundlesDir}/${request.file}`;
      let bytes: Uint8Array;
      try {
        const info = await Deno.lstat(path);
        if (
          !info.isFile || info.isSymlink || info.size > MAX_MATRIX_BUNDLE_BYTES
        ) {
          return false;
        }
        bytes = await Deno.readFile(path);
      } catch {
        return false;
      }
      if (await sha256HexBytes(bytes) !== request.digest) return false;
      if (await runGit(input.repositoryDir, ["bundle", "verify", path]) !== 0) {
        return false;
      }
      const ref = `refs/sentinel-matrix/${request.file.slice(0, -7)}`;
      if (await runGit(input.repositoryDir, ["fetch", path, ref]) !== 0) {
        return false;
      }
      if (
        await runGit(input.repositoryDir, [
          "rev-parse",
          "--verify",
          `${request.head}^{commit}`,
        ]) !== 0
      ) {
        return false;
      }
      if (
        await runGit(input.repositoryDir, [
          "merge-base",
          "--is-ancestor",
          request.base,
          request.head,
        ]) !== 0
      ) {
        return false;
      }
      if (request.checkpointSha !== null) {
        if (
          await runGit(input.repositoryDir, [
              "merge-base",
              "--is-ancestor",
              request.base,
              request.checkpointSha,
            ]) !== 0 ||
          await runGit(input.repositoryDir, [
              "merge-base",
              "--is-ancestor",
              request.checkpointSha,
              request.head,
            ]) !== 0
        ) return false;
        if (
          await runGit(input.repositoryDir, [
            "rev-parse",
            "--verify",
            `${request.checkpointSha}^{commit}`,
          ]) !== 0
        ) {
          return false;
        }
      }
      return true;
    },
  };
}
