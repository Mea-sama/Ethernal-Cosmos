import { z } from 'zod';

export const GameIdSchema = z.string().min(1).max(32).regex(/^[a-z0-9-]+$/);
export const KeySchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/);
export const VisibilitySchema = z.enum(['private', 'lobby', 'public']);

export const BulkEntriesSchema = z
  .array(z.object({ key: KeySchema, value: z.any(), visibility: VisibilitySchema.optional() }))
  .min(1)
  .max(100);
