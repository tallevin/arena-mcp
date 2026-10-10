import { randomUUID } from "node:crypto";
import type { StringKv } from "../auth/kv";
import { CACHE_TTL_SECONDS } from "./cache";

interface RedisStrings {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { ex: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

type Entry = { text: string } | { revision: string; chunks: number };
const CHUNK_CHARS = 64 * 1024;
const MAX_CHUNKS = 512;

/** Versioned chunks avoid per-command limits and partial/concurrent cache reads. */
export class RedisKv implements StringKv {
  constructor(
    private redis: RedisStrings,
    private prefix: string,
  ) {}

  async get(key: string): Promise<string | null> {
    const raw = await this.redis.get(`${this.prefix}:${key}`);
    if (raw === null) return null;
    const entry = JSON.parse(raw) as Entry;
    if ("text" in entry) return entry.text;
    if (
      !Number.isInteger(entry.chunks) ||
      entry.chunks < 1 ||
      entry.chunks > MAX_CHUNKS ||
      !/^[a-f0-9-]{36}$/.test(entry.revision)
    )
      return null;
    const chunks: string[] = [];
    for (let start = 0; start < entry.chunks; start += 8) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(8, entry.chunks - start) }, (_, i) =>
          this.redis.get(this.chunkKey(key, entry.revision, start + i)),
        ),
      );
      if (batch.some((chunk) => chunk === null)) return null;
      chunks.push(...(batch as string[]));
    }
    return chunks.join("");
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    const ex = options?.expirationTtl ?? CACHE_TTL_SECONDS;
    const count = Math.ceil(value.length / CHUNK_CHARS);
    if (count > MAX_CHUNKS)
      throw new Error("Cache entry exceeds storage limit");
    let entry: Entry;
    if (count <= 1) {
      entry = { text: value };
    } else {
      const revision = randomUUID();
      // Publish the manifest only after all chunks exist. Older revisions expire.
      for (let start = 0; start < count; start += 8) {
        await Promise.all(
          Array.from({ length: Math.min(8, count - start) }, (_, i) => {
            const index = start + i;
            return this.redis.set(
              this.chunkKey(key, revision, index),
              value.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS),
              { ex: ex + 60 },
            );
          }),
        );
      }
      entry = { revision, chunks: count };
    }
    await this.redis.set(`${this.prefix}:${key}`, JSON.stringify(entry), {
      ex,
    });
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(`${this.prefix}:${key}`);
  }

  private chunkKey(key: string, revision: string, index: number) {
    return `${this.prefix}:chunk:${key}:${revision}:${index}`;
  }
}
