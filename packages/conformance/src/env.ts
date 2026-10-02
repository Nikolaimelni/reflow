import { z } from 'zod';

const schema = z.object({
  REFLOW_RUNS: z.coerce.number().int().positive().default(60),
});

export const env = schema.parse(process.env);
