CREATE TABLE `bodies` (
	`call_id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`request_gz` blob,
	`response_gz` blob,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `calls` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`harness` text NOT NULL,
	`harness_version` text,
	`session_id` text,
	`turn_id` text,
	`kind` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`http_status` integer,
	`completion` text NOT NULL,
	`error_type` text,
	`model` text,
	`input_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`output_tokens` integer,
	`reasoning_tokens` integer,
	`tokens_estimated` integer NOT NULL,
	`time_to_response_headers_ms` real,
	`time_to_first_chunk_ms` real,
	`time_to_first_token_ms` real,
	`time_to_stream_end_ms` real,
	`tools_count` integer,
	`tools_chars` integer,
	`instructions_chars` integer,
	`quota` text
);
--> statement-breakpoint
CREATE INDEX `calls_started_at` ON `calls` (`started_at`);--> statement-breakpoint
CREATE INDEX `calls_session` ON `calls` (`session_id`,`started_at`);