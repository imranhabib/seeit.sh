CREATE TABLE "body_pieces" (
	"user_id" text NOT NULL,
	"harness" text NOT NULL,
	"scope" text NOT NULL,
	"hash" text NOT NULL,
	"gz" "bytea" NOT NULL,
	"bytes" integer NOT NULL,
	"first_seen_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "body_pieces_user_id_harness_scope_hash_pk" PRIMARY KEY("user_id","harness","scope","hash")
);
--> statement-breakpoint
CREATE TABLE "call_pieces" (
	"call_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"path" text NOT NULL,
	"hash" text NOT NULL,
	"cache_control" jsonb,
	CONSTRAINT "call_pieces_call_id_ordinal_pk" PRIMARY KEY("call_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "context_parts" (
	"call_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"item_id" text,
	"part" integer,
	"section" text NOT NULL,
	"role" text,
	"category" text NOT NULL,
	"label" text,
	"chars" bigint NOT NULL,
	"input_tokens" bigint,
	"cached_tokens" bigint,
	"cache_write_tokens" bigint,
	"tokens_source" text NOT NULL,
	"breakpoint_ttl" text,
	"analysis_version" integer NOT NULL,
	CONSTRAINT "context_parts_call_id_ordinal_pk" PRIMARY KEY("call_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "model_catalog" (
	"user_id" text NOT NULL,
	"harness" text NOT NULL,
	"harness_version" text NOT NULL,
	"model" text NOT NULL,
	"call_id" text NOT NULL,
	"observed_at" timestamp (3) with time zone NOT NULL,
	"context_window" bigint,
	"max_context_window" bigint,
	"auto_compact_token_limit" bigint,
	"comp_hash" text,
	"truncation_mode" text,
	"truncation_limit" bigint,
	"tool_mode" text,
	"base_instructions_chars" bigint,
	"base_instructions_sha256" text,
	CONSTRAINT "model_catalog_user_id_harness_harness_version_model_pk" PRIMARY KEY("user_id","harness","harness_version","model")
);
--> statement-breakpoint
CREATE TABLE "quota_windows" (
	"call_id" text NOT NULL,
	"window" text NOT NULL,
	"harness" text NOT NULL,
	"observed_at" timestamp (3) with time zone NOT NULL,
	"used_percent" double precision,
	"resets_at" timestamp (3) with time zone,
	"window_minutes" integer,
	"status" text,
	CONSTRAINT "quota_windows_call_id_window_pk" PRIMARY KEY("call_id","window")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"user_id" text NOT NULL,
	"harness" text NOT NULL,
	"id" text NOT NULL,
	"harness_version" text,
	"first_call_at" timestamp (3) with time zone NOT NULL,
	"last_call_at" timestamp (3) with time zone NOT NULL,
	"last_started_at" timestamp (3) with time zone,
	"last_seq" bigint,
	"settled_at" timestamp (3) with time zone,
	CONSTRAINT "sessions_user_id_harness_id_pk" PRIMARY KEY("user_id","harness","id")
);
--> statement-breakpoint
CREATE TABLE "tool_uses" (
	"call_id" text NOT NULL,
	"tool_use_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"namespace" text,
	"target" text,
	"plugin" text,
	"duration_ms" double precision,
	"result_chars" bigint,
	CONSTRAINT "tool_uses_call_id_tool_use_id_pk" PRIMARY KEY("call_id","tool_use_id")
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"harness" text NOT NULL,
	"session_id" text,
	"started_by_call_id" text,
	"started_at" timestamp (3) with time zone NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Calls stored before ADR 0009 belong to the default user, "local". The
-- default is dropped again below; the gateway sends the user from now on.
ALTER TABLE "calls" ADD COLUMN "user_id" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "seq" bigint;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "provider_request_id" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "compaction_trigger" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "compaction_reason" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "compaction_phase" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "compaction_strategy" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "cache_ttl" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "cache_write_30m_tokens" bigint;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "cache_write_12h_tokens" bigint;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "prompt_cache_retention" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "context_edits" jsonb;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "cache_miss_reason" jsonb;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "usage_iterations" jsonb;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "request_kind" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "context_window_number" integer;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "history_initialization" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "harness_turn_started_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "harness_build" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "entrypoint" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "retry_count" integer;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "thinking_type" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "service_tier" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "inference_geo" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "features" jsonb;--> statement-breakpoint
-- Backfill from calls already stored, before the foreign keys are added:
-- their user, their sessions, and their turns (the first call of each turn
-- started it; Codex sends its turn IDs, Claude Code turns were inferred).
INSERT INTO "users" ("id") SELECT DISTINCT "user_id" FROM "calls";--> statement-breakpoint
INSERT INTO "sessions" ("user_id", "harness", "id", "harness_version", "first_call_at", "last_call_at")
SELECT "user_id", "harness", "session_id", max("harness_version"), min("started_at"), max("started_at")
FROM "calls" WHERE "session_id" IS NOT NULL GROUP BY "user_id", "harness", "session_id";--> statement-breakpoint
INSERT INTO "turns" ("id", "user_id", "harness", "session_id", "started_by_call_id", "started_at", "source")
SELECT DISTINCT ON ("turn_id") "turn_id", "user_id", "harness", "session_id", "id", "started_at",
  CASE WHEN "harness" = 'codex' THEN 'harness' ELSE 'inferred' END
FROM "calls" WHERE "turn_id" IS NOT NULL ORDER BY "turn_id", "started_at", "id";--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "user_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "body_pieces" ADD CONSTRAINT "body_pieces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_pieces" ADD CONSTRAINT "call_pieces_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_parts" ADD CONSTRAINT "context_parts_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_windows" ADD CONSTRAINT "quota_windows_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_uses" ADD CONSTRAINT "tool_uses_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_started_by_call_id_calls_id_fk" FOREIGN KEY ("started_by_call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_user_id_harness_session_id_sessions_user_id_harness_id_fk" FOREIGN KEY ("user_id","harness","session_id") REFERENCES "public"."sessions"("user_id","harness","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quota_windows_observed" ON "quota_windows" USING btree ("harness","window","observed_at");--> statement-breakpoint
CREATE INDEX "tool_uses_tool_use_id" ON "tool_uses" USING btree ("tool_use_id");--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_user_id_harness_session_id_sessions_user_id_harness_id_fk" FOREIGN KEY ("user_id","harness","session_id") REFERENCES "public"."sessions"("user_id","harness","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_turn" ON "calls" USING btree ("turn_id");