import { z } from 'zod';

export const GameIdSchema = z.string().min(1).max(32).regex(/^[a-z0-9-]+$/);
export const KeySchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/);
export const VisibilitySchema = z.enum(['private', 'lobby', 'public']);

export const BulkEntriesSchema = z
  .array(z.object({ key: KeySchema, value: z.any(), visibility: VisibilitySchema.optional() }))
  .min(1)
  .max(100);

export const IncrementBodySchema = z.object({
  by: z.number().finite(),
  visibility: VisibilitySchema.optional(),
});

export const SetIfBodySchema = z.object({
  value: z.unknown(),
  expectedVersion: z.number().int().min(0),
  visibility: VisibilitySchema.optional(),
});

export const OpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), key: KeySchema, value: z.unknown(), visibility: VisibilitySchema.optional() }),
  z.object({ op: z.literal('increment'), key: KeySchema, by: z.number().finite(), visibility: VisibilitySchema.optional() }),
  z.object({ op: z.literal('setIf'), key: KeySchema, value: z.unknown(), expectedVersion: z.number().int().min(0), visibility: VisibilitySchema.optional() }),
  z.object({ op: z.literal('delete'), key: KeySchema }),
]);

export const OpsSchema = z.array(OpSchema).min(1).max(100);
