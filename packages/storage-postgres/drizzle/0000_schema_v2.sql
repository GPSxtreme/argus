CREATE TABLE "applied_config" (
	"id" integer PRIMARY KEY NOT NULL,
	"config_json" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"applied_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_media" (
	"artifact_id" text NOT NULL,
	"media_asset_id" text NOT NULL,
	"position" integer NOT NULL,
	"disposition" text NOT NULL,
	CONSTRAINT "artifact_media_artifact_id_media_asset_id_pk" PRIMARY KEY("artifact_id","media_asset_id")
);
--> statement-breakpoint
CREATE TABLE "artifact_records" (
	"artifact_id" text NOT NULL,
	"record_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "artifact_records_artifact_id_record_id_pk" PRIMARY KEY("artifact_id","record_id")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"provider" text,
	"model" text,
	"provenance_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"target_id" text PRIMARY KEY NOT NULL,
	"value_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_snapshot_items" (
	"snapshot_id" text NOT NULL,
	"reply_record_id" text NOT NULL,
	"rank" integer NOT NULL,
	"sort_value" integer,
	CONSTRAINT "conversation_snapshot_items_snapshot_id_reply_record_id_pk" PRIMARY KEY("snapshot_id","reply_record_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"root_record_id" text NOT NULL,
	"observed_count" integer NOT NULL,
	"retained_count" integer NOT NULL,
	"order_by" text NOT NULL,
	"pages_fetched" integer NOT NULL,
	"complete" boolean NOT NULL,
	"truncated" boolean NOT NULL,
	"truncation_reason" text,
	"upstream_cursor" text,
	"collected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_tracking" (
	"root_record_id" text PRIMARY KEY NOT NULL,
	"watch_id" text NOT NULL,
	"status" text NOT NULL,
	"order_by" text NOT NULL,
	"max_per_post" integer NOT NULL,
	"max_tracking_hours" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"next_run_at" timestamp with time zone,
	"stops_at" timestamp with time zone NOT NULL,
	"last_observed_replies" integer,
	"burst_until" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnostic_watches" (
	"id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"source" text NOT NULL,
	"target_json" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "diagnostic_watches_target_id_unique" UNIQUE("target_id")
);
--> statement-breakpoint
CREATE TABLE "engagement_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"record_id" text NOT NULL,
	"likes" integer,
	"replies" integer,
	"reposts" integer,
	"quotes" integer,
	"views" integer,
	"bookmarks" integer,
	"collected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"record_id" text NOT NULL,
	"source_media_id" text,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"preview_url" text,
	"mime_type" text,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"alt_text" text,
	"position" integer NOT NULL,
	"metadata_json" jsonb,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "media_assets_position_nonnegative" CHECK ("media_assets"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "record_relations" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_record_id" text NOT NULL,
	"kind" text NOT NULL,
	"object_source" text NOT NULL,
	"object_external_id" text NOT NULL,
	"object_record_id" text,
	"object_url" text,
	"metadata_json" jsonb,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"record_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"snapshot_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_watches" (
	"record_id" text NOT NULL,
	"watch_id" text NOT NULL,
	"target_id" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "record_watches_record_id_watch_id_target_id_pk" PRIMARY KEY("record_id","watch_id","target_id")
);
--> statement-breakpoint
CREATE TABLE "records" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"text" text NOT NULL,
	"author" text,
	"published_at" timestamp with time zone,
	"raw_json" jsonb NOT NULL,
	"metadata_json" jsonb,
	"content_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "records_id_sha256" CHECK (length("records"."id") = 64)
);
--> statement-breakpoint
CREATE TABLE "schema_meta" (
	"id" integer PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
INSERT INTO "schema_meta" ("id", "version", "created_at") VALUES (1, 2, now());
--> statement-breakpoint
ALTER TABLE "artifact_media" ADD CONSTRAINT "artifact_media_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_media" ADD CONSTRAINT "artifact_media_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_records" ADD CONSTRAINT "artifact_records_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_records" ADD CONSTRAINT "artifact_records_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_snapshot_items" ADD CONSTRAINT "conversation_snapshot_items_snapshot_id_conversation_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."conversation_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_snapshot_items" ADD CONSTRAINT "conversation_snapshot_items_reply_record_id_records_id_fk" FOREIGN KEY ("reply_record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_snapshots" ADD CONSTRAINT "conversation_snapshots_root_record_id_records_id_fk" FOREIGN KEY ("root_record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_tracking" ADD CONSTRAINT "conversation_tracking_root_record_id_records_id_fk" FOREIGN KEY ("root_record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_snapshots" ADD CONSTRAINT "engagement_snapshots_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_relations" ADD CONSTRAINT "record_relations_subject_record_id_records_id_fk" FOREIGN KEY ("subject_record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_relations" ADD CONSTRAINT "record_relations_object_record_id_records_id_fk" FOREIGN KEY ("object_record_id") REFERENCES "public"."records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_revisions" ADD CONSTRAINT "record_revisions_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_watches" ADD CONSTRAINT "record_watches_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_media_position_idx" ON "artifact_media" USING btree ("artifact_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_records_position_idx" ON "artifact_records" USING btree ("artifact_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_snapshot_rank_idx" ON "conversation_snapshot_items" USING btree ("snapshot_id","rank");--> statement-breakpoint
CREATE INDEX "conversation_snapshots_root_collected_idx" ON "conversation_snapshots" USING btree ("root_record_id","collected_at");--> statement-breakpoint
CREATE INDEX "conversation_tracking_due_idx" ON "conversation_tracking" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "diagnostic_watches_expiry_idx" ON "diagnostic_watches" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "engagement_record_collected_idx" ON "engagement_snapshots" USING btree ("record_id","collected_at");--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("status","run_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_record_position_idx" ON "media_assets" USING btree ("record_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "record_relations_edge_idx" ON "record_relations" USING btree ("subject_record_id","kind","object_source","object_external_id");--> statement-breakpoint
CREATE INDEX "record_relations_object_idx" ON "record_relations" USING btree ("object_source","object_external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "record_revisions_record_hash_idx" ON "record_revisions" USING btree ("record_id","content_hash");--> statement-breakpoint
CREATE INDEX "record_revisions_record_created_idx" ON "record_revisions" USING btree ("record_id","created_at");--> statement-breakpoint
CREATE INDEX "record_watches_watch_idx" ON "record_watches" USING btree ("watch_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "record_watches_target_idx" ON "record_watches" USING btree ("target_id","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "records_source_external_idx" ON "records" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "records_last_seen_idx" ON "records" USING btree ("last_seen_at","id");
