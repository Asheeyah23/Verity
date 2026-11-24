import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/plugin.js";
import { storeArtifact, readArtifact, StorageFullError } from "./storage.js";
import { env } from "../../config/env.js";
import * as path from "node:path";

export async function artifactsRoutes(app: FastifyInstance) {
  // Stricter than the global limit: each upload can write up to ARTIFACT_MAX_BYTES
  // to disk. The limit applies per account and per client address, so rotating
  // tokens while keeping the same address cannot buy more uploads.
  const uploadOptions = {
    preHandler: requireAuth,
    config: { rateLimit: { max: env.ARTIFACT_UPLOADS_PER_MINUTE, timeWindow: "1 minute" } },
  };

  app.post("/v1/artifacts", uploadOptions, async (req, reply) => {
    const body = z
      .object({
        content_base64: z.string().min(1),
        content_type: z.string().optional(),
      })
      .parse(req.body);

    const isBase64 =
      body.content_base64.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(body.content_base64);
    if (!isBase64) {
      reply.code(400);
      return { error: "content_base64 is not valid base64" };
    }

    const content = Buffer.from(body.content_base64, "base64");
    if (content.byteLength === 0) {
      reply.code(400);
      return { error: "artifact content cannot be empty" };
    }

    if (content.byteLength > env.ARTIFACT_MAX_BYTES) {
      reply.code(413);
      return { error: `artifact is larger than the ${env.ARTIFACT_MAX_BYTES}-byte limit` };
    }
    let contentHash: string;
    try {
      ({ contentHash } = await storeArtifact(content));
    } catch (err) {
      if (err instanceof StorageFullError) {
        reply.code(507);
        return { error: "artifact storage is full; try again later" };
      }
      throw err;
    }
    reply.code(201);
    return {
      content_hash: contentHash,
      storage_ref: contentHash,
      size_bytes: content.byteLength,
      content_type: body.content_type ?? null,
    };
  });

  app.get<{ Params: { hash: string } }>("/v1/artifacts/:hash", async (req, reply) => {
    const hash = req.params.hash;
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      reply.code(400);
      return { error: "invalid content hash" };
    }
    try {
      const content = await readArtifact(path.join(env.ARTIFACT_STORAGE_DIR, hash));
      return { content_hash: hash, content_base64: content.toString("base64") };
    } catch {
      reply.code(404);
      return { error: "not found" };
    }
  });
}
