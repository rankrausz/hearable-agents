// packages/core/src/classify/schema.ts — the zod schemas that guard the
// classifier's data boundaries and the types inferred from them: the
// (agent, toolName) fixture rows, the ACP typed kind, the classify() input and
// the classification output. Types are inferred from these schemas and are the
// only shapes consumers of classify/ need. This module must not compute
// anything — schemas and types only. The category and execKind unions mirror
// docs/EVENTS.md §Shape exactly; they are separate schemas (not imports from
// events/schema.ts) so this subtree stays a self-contained unit that the
// events schema does not need to know about.

import { z } from "zod";

import { AgentIdSchema } from "../events/schema.js";

export type { AgentId } from "../events/schema.js";

export const ToolCategorySchema = z.enum(["read", "search", "edit", "exec", "web", "other"]);
export type ToolCategory = z.infer<typeof ToolCategorySchema>;

export const ExecKindSchema = z.enum(["test", "build", "lint", "git", "install", "run", "other"]);
export type ExecKind = z.infer<typeof ExecKindSchema>;

// The ACP ToolKind values that docs/EVENTS.md §Classification maps. The schema
// enumerates only the mapped kinds, never all kinds ACP defines: an unmapped
// kind that reaches this boundary (for example ACP's `switch_mode`, which the
// doc does not cover) is rejected here rather than silently binned, and is
// surfaced for the schema review (p1-t10) to extend the mapping.
export const ACPKindSchema = z.enum([
  "read",
  "search",
  "edit",
  "delete",
  "move",
  "execute",
  "fetch",
  "think",
  "other",
]);
export type ACPKind = z.infer<typeof ACPKindSchema>;

// One row of the (agent, toolName) -> category table. `verified` tells the
// adapter tasks (p1-t04, Phase 1b) whether a live agent confirmed the mapping
// or the row is assumed from docs/EVENTS.md and must be re-checked. Rows carry
// no execKind: for `exec` rows it is derived from the command head at classify
// time (docs/EVENTS.md §Classification).
export const ToolNameRowSchema = z.strictObject({
  agent: AgentIdSchema,
  toolName: z.string().min(1),
  category: ToolCategorySchema,
  verified: z.boolean(),
  note: z.string().optional(),
});
export type ToolNameRow = z.infer<typeof ToolNameRowSchema>;

export const ToolNameTableSchema = z.strictObject({
  schema: z.literal(1),
  rows: z.array(ToolNameRowSchema),
});
export type ToolNameTable = z.infer<typeof ToolNameTableSchema>;

export const ClassifyInputSchema = z.strictObject({
  agent: AgentIdSchema,
  toolName: z.string().min(1),
  kind: ACPKindSchema.optional(),
  toolInput: z.unknown().optional(),
  title: z.string().optional(),
  cwd: z.string().optional(),
});
export type ClassifyInput = z.infer<typeof ClassifyInputSchema>;

export const ClassificationSchema = z.strictObject({
  category: ToolCategorySchema,
  execKind: ExecKindSchema.optional(),
  fingerprint: z.string().min(16),
  target: z.string().optional(),
});
export type Classification = z.infer<typeof ClassificationSchema>;
