CREATE TABLE "bodies" (
	"call_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"request_gz" "bytea",
	"response_gz" "bytea"
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"harness" text NOT NULL,
	"harness_version" text,
	"session_id" text,
	"turn_id" text,
	"kind" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"http_status" integer,
	"completion" text NOT NULL,
	"error_type" text,
	"model" text,
	"input_tokens" bigint,
	"cache_read_tokens" bigint,
	"cache_write_tokens" bigint,
	"cache_write_5m_tokens" bigint,
	"cache_write_1h_tokens" bigint,
	"output_tokens" bigint,
	"reasoning_tokens" bigint,
	"codex_rollout_budget_units" double precision,
	"server_tool_use" jsonb,
	"tokens_estimated" boolean NOT NULL,
	"time_to_response_headers_ms" double precision,
	"time_to_first_chunk_ms" double precision,
	"time_to_first_token_ms" double precision,
	"time_to_stream_end_ms" double precision,
	"tools_count" bigint,
	"tools_chars" bigint,
	"instructions_chars" bigint,
	"quota" jsonb,
	"flags" jsonb,
	"unknown_events" jsonb,
	"unknown_usage_fields" jsonb
);
--> statement-breakpoint
ALTER TABLE "bodies" ADD CONSTRAINT "bodies_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_started_at" ON "calls" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "calls_session" ON "calls" USING btree ("session_id","started_at");