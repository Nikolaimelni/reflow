import { z } from 'zod';

// Zod compiles parsers with `new Function` unless told not to, and the site's CSP has no
// 'unsafe-eval', so every page load would report a violation.
z.config({ jitless: true });

/** The viewport input holds to the same range, or it could make links that do not open. */
export const WIDTH = { min: 120, max: 4000 } as const;

const MAX_SOURCE = 40_000;

/**
 * The most a valid link inflates to: both sources at the limit, every character escaped to
 * six bytes by JSON.stringify. A few kilobytes of deflate can claim gigabytes, so inflating
 * stops here rather than after the schema has had a look.
 */
const MAX_JSON_BYTES = 2 * MAX_SOURCE * 6 + 1024;

/**
 * The URL is the one input here that a stranger controls, so it gets a schema. Everything
 * else in the app comes from the engine or from the editors.
 */
const sharedSchema = z.object({
  html: z.string().max(MAX_SOURCE),
  css: z.string().max(MAX_SOURCE),
  width: z.number().int().min(WIDTH.min).max(WIDTH.max),
});

export type Shared = z.infer<typeof sharedSchema>;

/** null when decode would turn the link down, rather than a link that opens the sample. */
export async function encode(shared: Shared): Promise<string | null> {
  if (!sharedSchema.safeParse(shared).success) return null;

  const stream = new Blob([JSON.stringify(shared)])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

export async function decode(fragment: string): Promise<Shared | null> {
  if (fragment === '') return null;

  try {
    const json = await inflate(fromBase64Url(fragment));
    if (json === null) return null;
    const parsed = sharedSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    // A hand-edited or truncated link. Nothing to recover, so the sample stays.
    return null;
  }
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<string | null> {
  const reader = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();

    size += value.byteLength;
    if (size > MAX_JSON_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
