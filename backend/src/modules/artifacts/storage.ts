import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { env } from "../../config/env.js";

async function ensureDir() {
  await fs.mkdir(env.ARTIFACT_STORAGE_DIR, { recursive: true });
}

/** Thrown when storing an artifact would take the directory past
 * ARTIFACT_MAX_TOTAL_BYTES. */
export class StorageFullError extends Error {}

interface Tally {
  dir: string;
  bytes: number;
}

let tally: Tally | undefined;
let counting: { dir: string; done: Promise<Tally> } | undefined;

/** The one shared running total for the current storage directory: counted
 * from disk once (half-written temp files are not counted), then kept up to
 * date by storeArtifact. Every caller gets the same object, so concurrent
 * uploads reserve space against the same number. */
async function getTally(): Promise<Tally> {
  const dir = env.ARTIFACT_STORAGE_DIR;
  if (tally?.dir === dir) return tally;
  if (counting?.dir !== dir) {
    const done = (async () => {
      let bytes = 0;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
        bytes += (await fs.stat(path.join(dir, entry.name))).size;
      }
      return (tally = { dir, bytes });
    })();
    // A failed count is not cached; the next upload counts again.
    done.catch(() => {
      if (counting?.done === done) counting = undefined;
    });
    counting = { dir, done };
  }
  return counting.done;
}

/** Content-addressed local disk storage: the file is stored under its own
 * sha256 hash, so `storage_ref` and `content_hash` are always consistent by
 * construction — there is no path where a stored blob doesn't match its
 * claimed hash. Content that is already stored costs nothing; new content
 * that would pass ARTIFACT_MAX_TOTAL_BYTES is refused with StorageFullError. */
export async function storeArtifact(content: Buffer): Promise<{ contentHash: string; storageRef: string }> {
  await ensureDir();
  const contentHash = createHash("sha256").update(content).digest("hex");
  const storageRef = path.join(env.ARTIFACT_STORAGE_DIR, contentHash);
  if (await artifactExists(contentHash)) return { contentHash, storageRef };

  const total = await getTally();
  // No await between this check and the reservation, so concurrent uploads
  // cannot both pass on the same remaining space.
  if (total.bytes + content.byteLength > env.ARTIFACT_MAX_TOTAL_BYTES) {
    throw new StorageFullError("artifact storage is full");
  }
  total.bytes += content.byteLength;

  const tmpPath = `${storageRef}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, content);
    await fs.rename(tmpPath, storageRef);
  } catch (err) {
    total.bytes -= content.byteLength;
    await fs.rm(tmpPath, { force: true });
    throw err;
  }
  return { contentHash, storageRef };
}

export async function readArtifact(storageRef: string): Promise<Buffer> {
  const content = await fs.readFile(storageRef);
  const actualHash = createHash("sha256").update(content).digest("hex");
  const claimedHash = path.basename(storageRef);
  if (actualHash !== claimedHash) {
    throw new Error(`Artifact content hash mismatch: expected ${claimedHash}, got ${actualHash}`);
  }
  return content;
}

/** Path of the artifact stored under a content hash. */
export function artifactPath(contentHash: string): string {
  return path.join(env.ARTIFACT_STORAGE_DIR, contentHash);
}

export async function artifactExists(contentHash: string): Promise<boolean> {
  try {
    await fs.access(artifactPath(contentHash));
    return true;
  } catch {
    return false;
  }
}
