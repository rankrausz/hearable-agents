// packages/core/src/events/schema.ts — the single normalized event vocabulary
// that every adapter, the daemon and the recorder validate against. It is a
// faithful transcription of docs/EVENTS.md §Shape, §Capabilities and §Kinds
// into zod; the exported types are inferred from the schemas and are the only
// shapes consumers need. This module must not classify tools, redact payloads,
// or mention any agent beyond the AgentId union that docs/EVENTS.md fixes.
// Unknown keys are rejected everywhere (fail closed) so uncontracted data is
// surfaced at the boundary instead of being silently stripped or recorded; if
// that ever rejects a real payload, the fix is a deliberate schema change,
// never a quiet widening.

import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

export const AgentIdSchema = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "acp",
  "emit",
  "replay",
  "sandbox",
]);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const EventKindSchema = z.enum([
  "session.start",
  "session.end",
  "turn.start",
  "turn.end",
  "tool.start",
  "tool.end",
  "tool.fail",
  "permission.request",
  "question.asked",
  "notification",
  "subagent.start",
  "subagent.end",
  "compaction",
  "agent.report",
]);
export type EventKind = z.infer<typeof EventKindSchema>;

const MetaValueSchema = z.union([z.string(), z.number(), z.boolean()]);

// `meta` is deliberately flat and small; structure requires a schema change,
// which is why nested values are rejected rather than tolerated.
const MetaSchema = z.record(z.string(), MetaValueSchema);

const TestSummarySchema = z.strictObject({
  passed: z.number().optional(),
  failed: z.number().optional(),
  skipped: z.number().optional(),
});

export const ToolOutcomeSchema = z.strictObject({
  ok: z.boolean(),
  exitCode: z.number().optional(),
  errorClass: z.string().optional(),
  testSummary: TestSummarySchema.optional(),
  outputChars: z.number().optional(),
});
export type ToolOutcome = z.infer<typeof ToolOutcomeSchema>;

export const ToolInfoSchema = z.strictObject({
  name: z.string(),
  category: z.enum(["read", "search", "edit", "exec", "web", "other"]),
  execKind: z.enum(["test", "build", "lint", "git", "install", "run", "other"]).optional(),
  fingerprint: z.string(),
  target: z.string().optional(),
  durationMs: z.number().optional(),
  outcome: ToolOutcomeSchema.optional(),
});
export type ToolInfo = z.infer<typeof ToolInfoSchema>;

export const LifecycleHintSchema = z.strictObject({
  reason: z.enum([
    "completed",
    "question",
    "permission",
    "idle_prompt",
    "error",
    "cancelled",
    "unknown",
  ]),
  confidence: z.enum(["observed", "inferred"]),
  message: z.string().optional(),
});
export type LifecycleHint = z.infer<typeof LifecycleHintSchema>;

const EventBaseSchema = z.strictObject({
  v: z.literal(SCHEMA_VERSION),
  id: z.string(),
  ts: z.number(),
  receivedAt: z.number(),
  agent: AgentIdSchema,
  via: z.string().optional(),
  sessionId: z.string(),
  parentSessionId: z.string().optional(),
  kind: EventKindSchema,
  tool: ToolInfoSchema.optional(),
  lifecycle: LifecycleHintSchema.optional(),
  meta: MetaSchema.optional(),
});

// The per-kind members below carry the requirements of docs/EVENTS.md §Kinds
// in the type system, not just the validator, which is why they extend the
// base shape instead of refining one loose object.

const SessionStartEventSchema = EventBaseSchema.extend({ kind: z.literal("session.start") });
const SessionEndEventSchema = EventBaseSchema.extend({ kind: z.literal("session.end") });
const TurnStartEventSchema = EventBaseSchema.extend({ kind: z.literal("turn.start") });

const TurnEndEventSchema = EventBaseSchema.extend({
  kind: z.literal("turn.end"),
  lifecycle: LifecycleHintSchema,
});

const ToolStartEventSchema = EventBaseSchema.extend({
  kind: z.literal("tool.start"),
  tool: ToolInfoSchema,
});

const SucceededToolOutcomeSchema = ToolOutcomeSchema.extend({ ok: z.literal(true) });
const FailedToolOutcomeSchema = ToolOutcomeSchema.extend({ ok: z.literal(false) });

const ToolEndEventSchema = EventBaseSchema.extend({
  kind: z.literal("tool.end"),
  tool: ToolInfoSchema.extend({ outcome: SucceededToolOutcomeSchema }),
});

const ToolFailEventSchema = EventBaseSchema.extend({
  kind: z.literal("tool.fail"),
  tool: ToolInfoSchema.extend({ outcome: FailedToolOutcomeSchema }),
});

const PermissionRequestEventSchema = EventBaseSchema.extend({
  kind: z.literal("permission.request"),
  lifecycle: LifecycleHintSchema.extend({ reason: z.literal("permission") }),
});

const QuestionAskedEventSchema = EventBaseSchema.extend({
  kind: z.literal("question.asked"),
  lifecycle: LifecycleHintSchema.extend({ reason: z.literal("question") }),
});

// A notification must name what it carries in `meta.kind`; remaining meta keys
// stay free-form but flat.
const NotificationMetaSchema = z.object({ kind: z.string() }).catchall(MetaValueSchema);

const NotificationEventSchema = EventBaseSchema.extend({
  kind: z.literal("notification"),
  meta: NotificationMetaSchema,
});

const SubagentStartEventSchema = EventBaseSchema.extend({
  kind: z.literal("subagent.start"),
  parentSessionId: z.string(),
});

const SubagentEndEventSchema = EventBaseSchema.extend({
  kind: z.literal("subagent.end"),
  parentSessionId: z.string(),
});

const CompactionEventSchema = EventBaseSchema.extend({ kind: z.literal("compaction") });

const AgentReportEventSchema = EventBaseSchema.extend({ kind: z.literal("agent.report") });

export const NormalizedEventSchema = z.discriminatedUnion("kind", [
  SessionStartEventSchema,
  SessionEndEventSchema,
  TurnStartEventSchema,
  TurnEndEventSchema,
  ToolStartEventSchema,
  ToolEndEventSchema,
  ToolFailEventSchema,
  PermissionRequestEventSchema,
  QuestionAskedEventSchema,
  NotificationEventSchema,
  SubagentStartEventSchema,
  SubagentEndEventSchema,
  CompactionEventSchema,
  AgentReportEventSchema,
]);
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

// Every key is required so no adapter can forget to think about a capability;
// unknown keys are rejected so a typo cannot silently disable a heuristic.
export const AdapterCapabilitiesSchema = z.strictObject({
  sessionEvents: z.boolean(),
  turnStart: z.enum(["observed", "inferred", "none"]),
  turnEnd: z.enum(["observed", "inferred", "none"]),
  toolEvents: z.boolean(),
  toolFailures: z.boolean(),
  editEvents: z.boolean(),
  execEvents: z.boolean(),
  permissionEvents: z.boolean(),
  questionEvents: z.boolean(),
  subagents: z.boolean(),
  compaction: z.boolean(),
  toolKinds: z.enum(["typed", "byName", "none"]),
  durations: z.boolean(),
});
export type AdapterCapabilities = z.infer<typeof AdapterCapabilitiesSchema>;
