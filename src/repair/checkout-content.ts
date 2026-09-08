/**
 * Trusted local checkout content checkpoint (m04-repair Slice A support).
 *
 * Produces a SHA-256 of the canonical tuple (HEAD, index entries, and every
 * path/mode/content-hash under the checkout root) ONLY when the checkout is
 * attested stable: the same HEAD/index identity is read before and after the
 * content scan, every file is hashed with before/after lstat identity checks,
 * and a second full walk rechecks all entries and metadata. Any failure,
 * bound breach or race returns null; errors never contain raw paths or output.
 *
 * The function is read-only for the checkout (no index/tree/checkpoint
 * writes), uses credential-free local Git (no remotes), and is bounded in
 * time, output and scanned bytes. It is deliberately small: not a general
 * filesystem framework.
 */

const GIT_TIMEOUT_MS = 1_000;
const GIT_MAX_OUTPUT = 2 * 1024 * 1024;
const SNAPSHOT_TIMEOUT_MS = 5_000;
const MAX_ENTRIES = 4_096;
const MAX_DEPTH = 32;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const READ_CHUNK = 64 * 1024;

interface Deadline {
  promise: Promise<never>;
  clear(): void;
}

/** A rejecting deadline; the caller must clear() it once the work settles. */
function deadline(ms: number, onTimeout: () => void): Deadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error("deadline exceeded"));
    }, ms);
  });
  return {
    promise,
    clear(): void {
      clearTimeout(timer);
    },
  };
}

/** Race a step against the snapshot deadline; the winner is the step. */
function step<T>(work: Promise<T>, at: Promise<never>): Promise<T> {
  return Promise.race([work, at]);
}

/** Wait for the child status but never longer than `ms`. */
async function reap(
  child: Deno.ChildProcess,
  ms: number,
): Promise<Deno.CommandStatus | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  const status = await Promise.race([child.status, timeout]);
  clearTimeout(timer);
  return status;
}

interface Meta {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

/**
 * Identity metadata, or null when the platform did not report a required
 * field. Missing identity (dev/ino/mode/mtime/ctime) is inconclusive: the
 * entry must be rejected, never guessed with a substitute value.
 */
function metaOf(info: Deno.FileInfo): Meta | null {
  if (
    info.dev === null || info.ino === null || info.mode === null ||
    info.mtime === null || info.ctime === null
  ) {
    return null;
  }
  return {
    dev: Number(info.dev),
    ino: Number(info.ino),
    mode: info.mode,
    size: info.size,
    mtimeMs: info.mtime.getTime(),
    ctimeMs: info.ctime.getTime(),
  };
}

function sameMeta(a: Meta, b: Meta): boolean {
  return a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs;
}

function modeStr(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function parseHead(out: string): string | null {
  const hex = out.trim();
  return /^[0-9a-f]{40}$/i.test(hex) ? hex.toLowerCase() : null;
}

interface IndexEntry {
  mode: string;
  sha: string;
  stage: number;
  path: string;
}

function untrustedPath(path: string): boolean {
  return path === "" || path.startsWith("/") || path === ".." ||
    path.startsWith("../") || path.includes("/../") || path.endsWith("/..");
}

/** Parse `git ls-files --stage -z` output into canonical entries. */
function parseIndex(out: string): IndexEntry[] | null {
  const entries: IndexEntry[] = [];
  for (const record of out.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab <= 0) return null;
    const header = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (header.length !== 3) return null;
    const [mode, sha, stage] = header;
    if (!/^[0-7]{6}$/.test(mode)) return null;
    if (!/^[0-9a-f]{40}$/i.test(sha)) return null;
    if (!/^[0-3]$/.test(stage)) return null;
    if (untrustedPath(path)) return null;
    entries.push({ mode, sha: sha.toLowerCase(), stage: Number(stage), path });
  }
  entries.sort((a, b) =>
    a.path === b.path ? a.stage - b.stage : a.path < b.path ? -1 : 1
  );
  return entries;
}

/** Kill the child if it is still running, then wait bounded for its status. */
async function settleChild(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch {
    // already exited
  }
  await reap(child, 1_000);
}

/**
 * Run one local Git command with a bounded pipe, a 1s deadline and a bound of
 * 2MiB of output; the child is killed and reaped if it misbehaves. Returns
 * null on any failure, never the raw output of a failed call. `active` tracks
 * the current child so the snapshot deadline can kill it.
 *
 * The child is settled (killed if needed, status awaited) exactly once on
 * every error/bound path and after a drained stream, and the pipe reader
 * lock is always released in cleanup, so no task-owned Git process or stream
 * stays live when the checkpoint returns.
 */
async function runGit(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  active: { kill?: () => void },
): Promise<string | null> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("git", {
      args,
      cwd,
      clearEnv: true,
      env,
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch {
    return null;
  }
  const killFn = (): void => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  };
  active.kill = killFn;
  const perGit = deadline(GIT_TIMEOUT_MS, () => {
    try {
      child.kill();
    } catch {
      // already exited
    }
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let drained = false;
  let failed = false;
  try {
    const stdout = child.stdout;
    if (stdout !== null) {
      reader = stdout.getReader();
      for (;;) {
        const r = await Promise.race([reader.read(), perGit.promise]);
        if (r.done) {
          drained = true;
          break;
        }
        total += r.value.byteLength;
        if (total > GIT_MAX_OUTPUT) break;
        chunks.push(r.value);
      }
    }
  } catch {
    // Per-command deadline or pipe error: the failure path below settles the
    // child before the reader is released.
    failed = true;
  }
  if (!drained || total > GIT_MAX_OUTPUT) {
    // Error, timeout or output overflow: kill and settle the child FIRST,
    // while the per-Git deadline and `active.kill` still hold handles on it.
    failed = true;
    await settleChild(child);
  } else {
    // Drained normally: await the bounded status with the per-Git deadline
    // still armed, then kill and settle on timeout or failure.
    const status = await reap(child, 1_000);
    if (status === null || !status.success) {
      failed = true;
      await settleChild(child);
    }
  }
  // The child is fully settled; only now release the stream lock and drop
  // `active.kill`, in that order, so the deadline always has the live child.
  perGit.clear();
  if (reader !== null) {
    try {
      await reader.cancel();
    } catch {
      // stream already closed
    }
    try {
      reader.releaseLock();
    } catch {
      // the lock is already released
    }
    reader = null;
  }
  if (active.kill === killFn) active.kill = undefined;
  if (failed) return null;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

async function gitRead(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  active: { kill?: () => void },
  at: Promise<never>,
): Promise<string | null> {
  // Keep the pending command: when the snapshot deadline wins the race, wait
  // for runGit's own cleanup (kill + bounded reap) so no task-owned Git
  // process outlives this call. The caller returns null next and never
  // starts another Git command after the deadline has won.
  const run = runGit(args, cwd, env, active);
  try {
    return await Promise.race([run, at]);
  } catch {
    active.kill?.();
    await run;
    return null;
  }
}

interface FileRec {
  rel: string;
  meta: Meta;
}

interface DirRec {
  rel: string;
  meta: Meta;
}

function relativePath(parentRel: string, name: string): string {
  return parentRel === "" ? name : `${parentRel}/${name}`;
}

function byRel(a: { rel: string }, b: { rel: string }): number {
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

/**
 * Recursive scan of the checkout root, excluding ONLY the root `.git` entry.
 * Tracked, untracked and ignored entries are all included. Rejects symlinks,
 * non-regular files, and any entry/depth/byte bound breach.
 */
async function scanTree(
  realRoot: string,
  at: Promise<never>,
): Promise<{ files: FileRec[]; dirs: DirRec[] } | null> {
  const files: FileRec[] = [];
  const dirs: DirRec[] = [];
  let entries = 0;
  let totalBytes = 0;
  const stack: { abs: string; rel: string; depth: number }[] = [
    { abs: realRoot, rel: "", depth: 0 },
  ];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.depth > MAX_DEPTH) return null;
    const dirStat = await step(Deno.lstat(item.abs), at);
    if (!dirStat.isDirectory || dirStat.isSymlink) return null;
    for await (const entry of Deno.readDir(item.abs)) {
      if (item.rel === "" && entry.name === ".git") continue;
      entries++;
      if (entries > MAX_ENTRIES) return null;
      const rel = relativePath(item.rel, entry.name);
      const abs = `${item.abs}/${entry.name}`;
      const stat = await step(Deno.lstat(abs), at);
      if (stat.isSymlink || (!stat.isFile && !stat.isDirectory)) return null;
      const meta = metaOf(stat);
      if (meta === null) return null;
      if (stat.isDirectory) {
        if (item.depth + 1 > MAX_DEPTH) return null;
        dirs.push({ rel, meta });
        stack.push({ abs, rel, depth: item.depth + 1 });
      } else {
        if (stat.size > MAX_FILE_BYTES) return null;
        totalBytes += stat.size;
        if (totalBytes > MAX_TOTAL_BYTES) return null;
        files.push({ rel, meta });
      }
    }
  }
  files.sort(byRel);
  dirs.sort(byRel);
  return { files, dirs };
}

/**
 * Hash one regular file, attesting that the path inside the checkout was not
 * replaced and that no external file was read: lstat before, realpath (inside
 * the checkout) immediately before open, fstat identity of the opened handle,
 * exact-size bounded read, fstat after, then lstat/realpath after. The file is
 * never read if it is oversized, a symlink, or outside the checkout.
 */
async function hashFile(
  realRoot: string,
  rec: FileRec,
  at: Promise<never>,
): Promise<string | null> {
  const abs = `${realRoot}/${rec.rel}`;
  const before = await step(Deno.lstat(abs), at);
  if (before.isSymlink || !before.isFile) return null;
  const metaBefore = metaOf(before);
  if (metaBefore === null || !sameMeta(metaBefore, rec.meta)) return null;
  const realBefore = await step(Deno.realPath(abs), at);
  if (realBefore !== realRoot && !realBefore.startsWith(`${realRoot}/`)) {
    return null;
  }
  const data = new Uint8Array(rec.meta.size);
  const opening = Deno.open(abs, { read: true });
  let handle: Deno.FsFile;
  try {
    handle = await step(opening, at);
  } catch {
    // The snapshot deadline won while open was still in flight: close the
    // late-resolving handle as soon as it appears so no descriptor outlives
    // this step.
    opening.then(
      (late) => {
        try {
          late.close();
        } catch {
          // already closed
        }
      },
      () => {
        // open failed: nothing to close
      },
    );
    return null;
  }
  try {
    const opened = await step(handle.stat(), at);
    const metaOpened = metaOf(opened);
    if (metaOpened === null || !sameMeta(metaOpened, rec.meta)) return null;
    let offset = 0;
    while (offset < data.length) {
      const read = await step(
        handle.read(
          data.subarray(offset, Math.min(offset + READ_CHUNK, data.length)),
        ),
        at,
      );
      if (read === null || read === 0) return null;
      offset += read;
    }
    const extra = new Uint8Array(1);
    const grew = await step(handle.read(extra), at);
    if (grew !== null && grew > 0) return null;
    const after = await step(handle.stat(), at);
    const metaAfter = metaOf(after);
    if (metaAfter === null || !sameMeta(metaAfter, rec.meta)) return null;
    const digest = await crypto.subtle.digest("SHA-256", data);
    const hash = toHex(new Uint8Array(digest));
    const post = await step(Deno.lstat(abs), at);
    const metaPost = metaOf(post);
    if (metaPost === null || !sameMeta(metaPost, rec.meta)) return null;
    const realAfter = await step(Deno.realPath(abs), at);
    if (realAfter !== realBefore) return null;
    return hash;
  } finally {
    try {
      handle.close();
    } catch {
      // already closed
    }
  }
}

/**
 * Second full walk: reject any new/deleted entry or any metadata drift
 * (identity/mode/size/mtime/ctime) after hashing.
 */
async function recheckTree(
  realRoot: string,
  files: FileRec[],
  dirs: DirRec[],
  at: Promise<never>,
): Promise<boolean> {
  const fileByRel = new Map(files.map((f) => [f.rel, f.meta]));
  const dirByRel = new Map(dirs.map((d) => [d.rel, d.meta]));
  let entries = 0;
  const stack: { abs: string; rel: string; depth: number }[] = [
    { abs: realRoot, rel: "", depth: 0 },
  ];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.depth > MAX_DEPTH) return false;
    const dirStat = await step(Deno.lstat(item.abs), at);
    if (!dirStat.isDirectory || dirStat.isSymlink) return false;
    for await (const entry of Deno.readDir(item.abs)) {
      if (item.rel === "" && entry.name === ".git") continue;
      entries++;
      if (entries > MAX_ENTRIES) return false;
      const rel = relativePath(item.rel, entry.name);
      const stat = await step(Deno.lstat(`${item.abs}/${entry.name}`), at);
      if (stat.isSymlink || (!stat.isFile && !stat.isDirectory)) return false;
      const observed = metaOf(stat);
      if (observed === null) return false;
      const expected = stat.isDirectory
        ? dirByRel.get(rel)
        : fileByRel.get(rel);
      if (expected === undefined || !sameMeta(expected, observed)) {
        return false;
      }
      if (stat.isDirectory) {
        if (item.depth + 1 > MAX_DEPTH) return false;
        stack.push({
          abs: `${item.abs}/${entry.name}`,
          rel,
          depth: item.depth + 1,
        });
      }
    }
  }
  return entries === files.length + dirs.length;
}

/**
 * Return a SHA-256 checkpoint of the trusted, stable contents of a local Git
 * checkout, or null when the checkout cannot be attested (missing Git,
 * unstable/oversized/racing entries, symlinks, bounds breached, timeouts).
 */
export async function checkoutContentCheckpoint(
  checkoutDir: string,
): Promise<string | null> {
  const active: { kill?: () => void } = {};
  const overall = deadline(SNAPSHOT_TIMEOUT_MS, () => {
    active.kill?.();
  });
  let home: string | undefined;
  try {
    // Same late-resource guard: if the snapshot deadline wins while the
    // temporary home is still being created, remove the directory as soon as
    // it appears so no temp directory outlives the checkpoint.
    const homeDir = Deno.makeTempDir({ prefix: "sentinel-checkout-home-" });
    try {
      home = await step(homeDir, overall.promise);
    } catch {
      homeDir.then(
        (late) => {
          Deno.remove(late, { recursive: true }).catch(() => {
            // best-effort cleanup
          });
        },
        () => {
          // creation failed: nothing to remove
        },
      );
      return null;
    }
    const pathEnv = Deno.env.get("PATH");
    if (pathEnv === undefined) return null;
    const env: Record<string, string> = {
      PATH: pathEnv,
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    const realRoot = await step(Deno.realPath(checkoutDir), overall.promise);
    const rootStat = await step(Deno.lstat(realRoot), overall.promise);
    if (!rootStat.isDirectory || rootStat.isSymlink) return null;
    const rootMeta = metaOf(rootStat);
    if (rootMeta === null) return null;

    const headRaw0 = await gitRead(
      ["rev-parse", "HEAD"],
      realRoot,
      env,
      active,
      overall.promise,
    );
    if (headRaw0 === null) return null;
    const head = parseHead(headRaw0);
    if (head === null) return null;
    const indexRaw0 = await gitRead(
      ["ls-files", "--stage", "-z"],
      realRoot,
      env,
      active,
      overall.promise,
    );
    if (indexRaw0 === null) return null;
    const index = parseIndex(indexRaw0);
    if (index === null) return null;

    const scanned = await scanTree(realRoot, overall.promise);
    if (scanned === null) return null;

    const hashed: { rel: string; hash: string; meta: Meta }[] = [];
    for (const rec of scanned.files) {
      const hash = await hashFile(realRoot, rec, overall.promise);
      if (hash === null) return null;
      hashed.push({ rel: rec.rel, hash, meta: rec.meta });
    }

    const headRaw1 = await gitRead(
      ["rev-parse", "HEAD"],
      realRoot,
      env,
      active,
      overall.promise,
    );
    if (headRaw1 === null) return null;
    const indexRaw1 = await gitRead(
      ["ls-files", "--stage", "-z"],
      realRoot,
      env,
      active,
      overall.promise,
    );
    if (
      headRaw1 === null || headRaw1 !== headRaw0 ||
      indexRaw1 === null || indexRaw1 !== indexRaw0
    ) {
      return null;
    }

    if (
      !await recheckTree(realRoot, scanned.files, scanned.dirs, overall.promise)
    ) {
      return null;
    }
    const rootPost = await step(Deno.lstat(realRoot), overall.promise);
    const rootPostMeta = metaOf(rootPost);
    if (rootPostMeta === null || !sameMeta(rootMeta, rootPostMeta)) return null;
    const rootRealAfter = await step(Deno.realPath(realRoot), overall.promise);
    if (rootRealAfter !== realRoot) return null;

    const canonical = JSON.stringify({
      head,
      index: index.map((e) => [e.mode, e.sha, e.stage, e.path]),
      files: hashed.map((f) => [f.rel, modeStr(f.meta.mode), f.hash]),
      dirs: scanned.dirs.map((d) => [d.rel, modeStr(d.meta.mode)]),
    });
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical),
    );
    return toHex(new Uint8Array(digest));
  } catch {
    return null;
  } finally {
    overall.clear();
    active.kill?.();
    if (home !== undefined) {
      try {
        await Deno.remove(home, { recursive: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}
