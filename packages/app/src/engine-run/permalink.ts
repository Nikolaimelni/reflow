import { z } from 'zod';

/**
 * The URL is the one input here that a stranger controls, so it gets a schema. Everything
 * else in the app comes from the engine or from the editors.
 */
const sharedSchema = z.object({
  html: z.string().max(40_000),
  css: z.string().max(40_000),
  width: z.number().int().min(120).max(4000),
});

export type Shared = z.infer<typeof sharedSchema>;

export async function encode(shared: Shared): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(shared));
  return toBase64Url(await squeeze(bytes, new CompressionStream('deflate-raw')));
}

export async function decode(fragment: string): Promise<Shared | null> {
  if (fragment === '') return null;

  try {
    const bytes = fromBase64Url(fragment);
    const plain = await squeeze(bytes, new DecompressionStream('deflate-raw'));
    const parsed = sharedSchema.safeParse(JSON.parse(new TextDecoder().decode(plain)));
    return parsed.success ? parsed.data : null;
  } catch {
    // A hand-edited or truncated link. Nothing to recover, so the sample stays.
    return null;
  }
}

async function squeeze(
  bytes: Uint8Array,
  through: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(through);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
