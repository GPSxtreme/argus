CREATE TABLE `applied_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`config_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`applied_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `artifact_media` (
	`artifact_id` text NOT NULL,
	`media_asset_id` text NOT NULL,
	`position` integer NOT NULL,
	`disposition` text NOT NULL,
	PRIMARY KEY(`artifact_id`, `media_asset_id`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_asset_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_media_position_idx` ON `artifact_media` (`artifact_id`,`position`);--> statement-breakpoint
CREATE TABLE `artifact_records` (
	`artifact_id` text NOT NULL,
	`record_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`artifact_id`, `record_id`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_records_position_idx` ON `artifact_records` (`artifact_id`,`position`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`provider` text,
	`model` text,
	`provenance_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `checkpoints` (
	`target_id` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversation_snapshot_items` (
	`snapshot_id` text NOT NULL,
	`reply_record_id` text NOT NULL,
	`rank` integer NOT NULL,
	`sort_value` integer,
	PRIMARY KEY(`snapshot_id`, `reply_record_id`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `conversation_snapshots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reply_record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_snapshot_rank_idx` ON `conversation_snapshot_items` (`snapshot_id`,`rank`);--> statement-breakpoint
CREATE TABLE `conversation_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`root_record_id` text NOT NULL,
	`observed_count` integer NOT NULL,
	`retained_count` integer NOT NULL,
	`order_by` text NOT NULL,
	`pages_fetched` integer NOT NULL,
	`complete` integer NOT NULL,
	`truncated` integer NOT NULL,
	`truncation_reason` text,
	`upstream_cursor` text,
	`collected_at` text NOT NULL,
	FOREIGN KEY (`root_record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_snapshots_root_collected_idx` ON `conversation_snapshots` (`root_record_id`,`collected_at`);--> statement-breakpoint
CREATE TABLE `conversation_tracking` (
	`root_record_id` text PRIMARY KEY NOT NULL,
	`watch_id` text NOT NULL,
	`status` text NOT NULL,
	`order_by` text NOT NULL,
	`max_per_post` integer NOT NULL,
	`max_tracking_hours` integer NOT NULL,
	`published_at` text NOT NULL,
	`next_run_at` text,
	`stops_at` text NOT NULL,
	`last_observed_replies` integer,
	`burst_until` text,
	`last_error` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`root_record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_tracking_due_idx` ON `conversation_tracking` (`status`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `diagnostic_watches` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`source` text NOT NULL,
	`target_json` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnostic_watches_target_id_unique` ON `diagnostic_watches` (`target_id`);--> statement-breakpoint
CREATE INDEX `diagnostic_watches_expiry_idx` ON `diagnostic_watches` (`expires_at`);--> statement-breakpoint
CREATE TABLE `engagement_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`likes` integer,
	`replies` integer,
	`reposts` integer,
	`quotes` integer,
	`views` integer,
	`bookmarks` integer,
	`collected_at` text NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `engagement_record_collected_idx` ON `engagement_snapshots` (`record_id`,`collected_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer NOT NULL,
	`run_at` text NOT NULL,
	`lease_owner` text,
	`lease_token` text,
	`lease_expires_at` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `jobs_due_idx` ON `jobs` (`status`,`run_at`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`source_media_id` text,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`preview_url` text,
	`mime_type` text,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`alt_text` text,
	`position` integer NOT NULL,
	`metadata_json` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_assets_position_nonnegative" CHECK("media_assets"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_record_position_idx` ON `media_assets` (`record_id`,`position`);--> statement-breakpoint
CREATE INDEX `media_assets_record_idx` ON `media_assets` (`record_id`);--> statement-breakpoint
CREATE TABLE `record_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_record_id` text NOT NULL,
	`kind` text NOT NULL,
	`object_source` text NOT NULL,
	`object_external_id` text NOT NULL,
	`object_record_id` text,
	`object_url` text,
	`metadata_json` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`subject_record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`object_record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `record_relations_edge_idx` ON `record_relations` (`subject_record_id`,`kind`,`object_source`,`object_external_id`);--> statement-breakpoint
CREATE INDEX `record_relations_object_idx` ON `record_relations` (`object_source`,`object_external_id`);--> statement-breakpoint
CREATE TABLE `record_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `record_revisions_record_hash_idx` ON `record_revisions` (`record_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `record_revisions_record_created_idx` ON `record_revisions` (`record_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `record_watches` (
	`record_id` text NOT NULL,
	`watch_id` text NOT NULL,
	`target_id` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	PRIMARY KEY(`record_id`, `watch_id`, `target_id`),
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `record_watches_watch_idx` ON `record_watches` (`watch_id`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `record_watches_target_idx` ON `record_watches` (`target_id`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `records` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`text` text NOT NULL,
	`author` text,
	`published_at` text,
	`raw_json` text NOT NULL,
	`metadata_json` text,
	`content_hash` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	CONSTRAINT "records_id_sha256" CHECK(length("records"."id") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `records_source_external_idx` ON `records` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `records_last_seen_idx` ON `records` (`last_seen_at`,`id`);--> statement-breakpoint
CREATE INDEX `records_source_idx` ON `records` (`source`);--> statement-breakpoint
CREATE TABLE `schema_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `schema_meta` (`id`, `version`, `created_at`)
VALUES (1, 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
