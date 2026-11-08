CREATE TYPE "public"."approval_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('connected', 'needs_setup', 'expired', 'error');--> statement-breakpoint
CREATE TYPE "public"."deployment_trigger" AS ENUM('manual', 'webhook', 'fixture_apply');--> statement-breakpoint
CREATE TYPE "public"."destination_type" AS ENUM('mailpit', 'imap', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."incident_state" AS ENUM('open', 'investigating', 'needs_configuration', 'repair_unavailable', 'patch_proposed', 'investigation_failed', 'patch_testing', 'patch_ready', 'patch_failed', 'awaiting_approval', 'approved', 'rejected', 'awaiting_deployment', 'rechecking', 'verified_recovered', 'still_failing', 'closed');--> statement-breakpoint
CREATE TYPE "public"."investigation_origin" AS ENUM('vultr_inference', 'non_ai_harness');--> statement-breakpoint
CREATE TYPE "public"."investigation_state" AS ENUM('queued', 'running', 'patch_ready', 'no_code_cause', 'needs_configuration', 'failed', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."patch_status" AS ENUM('proposed', 'testing', 'ready', 'failed', 'guard_rejected', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('owner', 'admin', 'maintainer', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."run_kind" AS ENUM('delivery', 'containment');--> statement-breakpoint
CREATE TYPE "public"."run_result" AS ENUM('received', 'not_received', 'unverified', 'browser_failed', 'canceled', 'expired', 'blocked', 'containment_failed');--> statement-breakpoint
CREATE TYPE "public"."run_state" AS ENUM('queued', 'provisioning', 'opening_form', 'mapping_fields', 'submitting', 'observing_destination', 'complete', 'cleanup_complete');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('manual', 'schedule', 'first_check', 'recheck', 'demo', 'lab');--> statement-breakpoint
CREATE TYPE "public"."source_provider" AS ENUM('github', 'local_upload');--> statement-breakpoint
CREATE TYPE "public"."verification_method" AS ENUM('dns_txt', 'html_meta', 'controlled_fixture');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('pending', 'verified', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "api_idempotency" (
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"action" text NOT NULL,
	"resource_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_idempotency_organization_id_key_action_pk" PRIMARY KEY("organization_id","key","action")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"patch_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"decision" "approval_decision" NOT NULL,
	"decision_reason" text NOT NULL,
	"risk_acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"actor_user_id" uuid,
	"actor_kind" text DEFAULT 'user' NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"safe_metadata" jsonb,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "check_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"kind" "run_kind" DEFAULT 'delivery' NOT NULL,
	"scenario" text,
	"demo_session_id" uuid,
	"incident_id" uuid,
	"trigger" "run_trigger" NOT NULL,
	"reason" text,
	"state" "run_state" DEFAULT 'queued' NOT NULL,
	"result" "run_result",
	"idempotency_key" text,
	"test_token_hash" text NOT NULL,
	"test_token_encrypted" text NOT NULL,
	"token_suffix" text NOT NULL,
	"destination_id" uuid,
	"form_config_id" uuid,
	"sandbox_id" uuid,
	"actor_user_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"submission_intent_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"browser_outcome" jsonb,
	"observation_deadline_at" timestamp with time zone,
	"observation_window_seconds" integer DEFAULT 30 NOT NULL,
	"result_summary" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cleanup_at" timestamp with time zone,
	"duration_ms" integer,
	"stage_version" integer DEFAULT 0 NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"destination_id" uuid,
	"search_started_at" timestamp with time zone NOT NULL,
	"search_ended_at" timestamp with time zone,
	"poll_count" integer DEFAULT 0 NOT NULL,
	"status" text,
	"match_found" boolean DEFAULT false NOT NULL,
	"match_source" text,
	"remote_message_id_hash" text,
	"matched_at" timestamp with time zone,
	"matched_recipient" text,
	"matched_subject" text,
	"verifier_version" text NOT NULL,
	"error_code" text
);
--> statement-breakpoint
CREATE TABLE "demo_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"ip_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "demo_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"patch_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"trigger" "deployment_trigger" NOT NULL,
	"deployment_ref" text,
	"deployed_at" timestamp with time zone NOT NULL,
	"attested_by_user_id" uuid,
	"webhook_verified" boolean DEFAULT false NOT NULL,
	"recheck_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "destinations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"type" "destination_type" NOT NULL,
	"display_name" text NOT NULL,
	"host" text,
	"port" integer,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_credential_id" uuid,
	"status" "connection_status" DEFAULT 'needs_setup' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"field_map" jsonb NOT NULL,
	"synthetic_identity" jsonb NOT NULL,
	"consent_mode" text DEFAULT 'none' NOT NULL,
	"max_submission_frequency_minutes" integer DEFAULT 15 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_discoveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"proposal" jsonb,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_pull_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"patch_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"repo_ref" text NOT NULL,
	"branch" text NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_url" text NOT NULL,
	"current_state" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"destination_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"remote_id_hash" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_transitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"from_state" "incident_state" NOT NULL,
	"to_state" "incident_state" NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"opened_by_run_id" uuid NOT NULL,
	"recovery_run_id" uuid,
	"title" text NOT NULL,
	"cause_category" text,
	"state" "incident_state" DEFAULT 'open' NOT NULL,
	"severity" text DEFAULT 'high' NOT NULL,
	"current_patch_id" uuid,
	"owner_user_id" uuid,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"human_diagnosis" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investigation_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"investigation_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"summary" text NOT NULL,
	"attempt" integer,
	"payload" jsonb,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investigations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"origin" "investigation_origin" NOT NULL,
	"model_id" text,
	"prompt_version" text NOT NULL,
	"input_artifact_manifest_id" uuid,
	"base_commit_sha" text,
	"state" "investigation_state" DEFAULT 'queued' NOT NULL,
	"event_sequence" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_estimate_usd" numeric(12, 6),
	"error_code" text,
	"error_detail" text,
	"hypothesis" jsonb,
	"non_code_cause" text,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "role" NOT NULL,
	"invite_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_invite_token_hash_unique" UNIQUE("invite_token_hash")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invite_accepted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"investigation_id" uuid NOT NULL,
	"provider" text DEFAULT 'vultr-serverless-inference' NOT NULL,
	"model_id" text NOT NULL,
	"request_id" text,
	"response_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"finish_reason" text,
	"tool_names" jsonb,
	"http_status" integer,
	"error_code" text
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"notify_failure" boolean DEFAULT true NOT NULL,
	"notify_recovery" boolean DEFAULT true NOT NULL,
	"notify_action_required" boolean DEFAULT true NOT NULL,
	"notify_connection_expired" boolean DEFAULT true NOT NULL,
	"daily_digest" boolean DEFAULT false NOT NULL,
	"dedup_window_minutes" integer DEFAULT 360 NOT NULL,
	"quiet_hours_start" integer,
	"quiet_hours_end" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"incident_id" uuid,
	"kind" text NOT NULL,
	"recipient" text NOT NULL,
	"subject" text NOT NULL,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"dedup_key" text NOT NULL,
	"grouped_count" integer DEFAULT 1 NOT NULL,
	"sent_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"maintainers_may_approve" boolean DEFAULT false NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"aggregate_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"ready_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patch_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"patch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"command_profile" text NOT NULL,
	"variant" text DEFAULT 'patched' NOT NULL,
	"exit_code" integer,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"log_artifact_id" uuid,
	"pass" boolean NOT NULL,
	"detail" text,
	"run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "patch_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"patch_id" uuid NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"investigation_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"origin" "investigation_origin" NOT NULL,
	"base_commit_sha" text NOT NULL,
	"candidate_commit_sha" text,
	"diff_text" text NOT NULL,
	"diff_artifact_id" uuid,
	"changed_files" jsonb NOT NULL,
	"changed_file_count" integer NOT NULL,
	"changed_line_count" integer NOT NULL,
	"risk_level" text DEFAULT 'medium' NOT NULL,
	"risk_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rationale" text,
	"status" "patch_status" DEFAULT 'proposed' NOT NULL,
	"guard_failures" jsonb,
	"sha256" text NOT NULL,
	"preview_run_evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sandbox_id" uuid,
	"investigation_id" uuid,
	"layer" text NOT NULL,
	"action_type" text NOT NULL,
	"action_target_redacted" text NOT NULL,
	"allowed" boolean NOT NULL,
	"reason_code" text NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE "run_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid,
	"investigation_id" uuid,
	"kind" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mime" text NOT NULL,
	"redaction_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"stage" text NOT NULL,
	"safe_public_summary" text NOT NULL,
	"redacted_payload" jsonb,
	"artifact_ids" jsonb,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_trace_id" text
);
--> statement-breakpoint
CREATE TABLE "sandbox_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"run_id" uuid,
	"investigation_id" uuid,
	"role" text NOT NULL,
	"provider" text NOT NULL,
	"oci_runtime" text,
	"container_id" text,
	"container_name" text,
	"runtime_image_digest" text,
	"cpu_limit" numeric(6, 2) NOT NULL,
	"memory_limit_mb" integer NOT NULL,
	"pids_limit" integer NOT NULL,
	"wall_limit_seconds" integer NOT NULL,
	"network_policy_hash" text NOT NULL,
	"network_policy" jsonb NOT NULL,
	"hardening" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"exit_code" integer,
	"exit_reason" text,
	"oom_killed" boolean,
	"cleanup_verified" boolean DEFAULT false NOT NULL,
	"cleanup_verified_at" timestamp with time zone,
	"cleanup_attempts" integer DEFAULT 0 NOT NULL,
	"cleanup_error" text,
	"denial_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"interval_minutes" integer,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"max_daily_runs" integer DEFAULT 24 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_site_id_unique" UNIQUE("site_id")
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"key_alias" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"active_organization_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"verified_origin" text NOT NULL,
	"form_url" text NOT NULL,
	"form_purpose" text DEFAULT 'contact' NOT NULL,
	"owner_user_id" uuid,
	"authorization_accepted_at" timestamp with time zone NOT NULL,
	"authorization_accepted_by" uuid,
	"verification_status" "verification_status" DEFAULT 'pending' NOT NULL,
	"verification_method" "verification_method",
	"verification_token" text,
	"verification_expires_at" timestamp with time zone,
	"verification_last_error" text,
	"verified_at" timestamp with time zone,
	"setup_step" integer DEFAULT 1 NOT NULL,
	"setup_completed_at" timestamp with time zone,
	"fixture_slot" text,
	"active" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"last_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"provider" "source_provider" NOT NULL,
	"repo_slug" text NOT NULL,
	"base_branch" text DEFAULT 'main' NOT NULL,
	"base_commit_sha" text,
	"installation_id" text,
	"approved_paths" jsonb DEFAULT '["src"]'::jsonb NOT NULL,
	"package_manager" text DEFAULT 'pnpm' NOT NULL,
	"build_profile" text DEFAULT 'next-pnpm' NOT NULL,
	"preview_env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"storage_ref" text,
	"is_controlled_fixture" boolean DEFAULT false NOT NULL,
	"status" "connection_status" DEFAULT 'needs_setup' NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_error" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"investigation_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"tool_name" text NOT NULL,
	"redacted_args" jsonb,
	"allowed" boolean NOT NULL,
	"reason_code" text,
	"duration_ms" integer NOT NULL,
	"result_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "api_idempotency" ADD CONSTRAINT "api_idempotency_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_patch_id_patches_id_fk" FOREIGN KEY ("patch_id") REFERENCES "public"."patches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_demo_session_id_demo_sessions_id_fk" FOREIGN KEY ("demo_session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_destination_id_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destinations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_form_config_id_form_configs_id_fk" FOREIGN KEY ("form_config_id") REFERENCES "public"."form_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_observations" ADD CONSTRAINT "delivery_observations_run_id_check_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."check_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_observations" ADD CONSTRAINT "delivery_observations_destination_id_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destinations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_patch_id_patches_id_fk" FOREIGN KEY ("patch_id") REFERENCES "public"."patches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_attested_by_user_id_users_id_fk" FOREIGN KEY ("attested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_encrypted_credential_id_secrets_id_fk" FOREIGN KEY ("encrypted_credential_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_configs" ADD CONSTRAINT "form_configs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_configs" ADD CONSTRAINT "form_configs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_discoveries" ADD CONSTRAINT "form_discoveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_discoveries" ADD CONSTRAINT "form_discoveries_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_pull_requests" ADD CONSTRAINT "git_pull_requests_patch_id_patches_id_fk" FOREIGN KEY ("patch_id") REFERENCES "public"."patches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_pull_requests" ADD CONSTRAINT "git_pull_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_receipts" ADD CONSTRAINT "inbound_receipts_destination_id_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_transitions" ADD CONSTRAINT "incident_transitions_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_opened_by_run_id_check_runs_id_fk" FOREIGN KEY ("opened_by_run_id") REFERENCES "public"."check_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_events" ADD CONSTRAINT "investigation_events_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_checks" ADD CONSTRAINT "patch_checks_patch_id_patches_id_fk" FOREIGN KEY ("patch_id") REFERENCES "public"."patches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_checks" ADD CONSTRAINT "patch_checks_log_artifact_id_run_artifacts_id_fk" FOREIGN KEY ("log_artifact_id") REFERENCES "public"."run_artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_checks" ADD CONSTRAINT "patch_checks_run_id_check_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."check_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_comments" ADD CONSTRAINT "patch_comments_patch_id_patches_id_fk" FOREIGN KEY ("patch_id") REFERENCES "public"."patches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_comments" ADD CONSTRAINT "patch_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patches" ADD CONSTRAINT "patches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patches" ADD CONSTRAINT "patches_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patches" ADD CONSTRAINT "patches_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patches" ADD CONSTRAINT "patches_diff_artifact_id_run_artifacts_id_fk" FOREIGN KEY ("diff_artifact_id") REFERENCES "public"."run_artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_sandbox_id_sandbox_sessions_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandbox_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_run_id_check_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."check_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_check_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."check_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_sessions" ADD CONSTRAINT "sandbox_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_sessions" ADD CONSTRAINT "sandbox_sessions_run_id_check_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."check_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_sessions" ADD CONSTRAINT "sandbox_sessions_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_authorization_accepted_by_users_id_fk" FOREIGN KEY ("authorization_accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_org_created_idx" ON "audit_events" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auth_tokens_user_idx" ON "auth_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "check_runs_site_started_idx" ON "check_runs" USING btree ("site_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "check_runs_org_result_started_idx" ON "check_runs" USING btree ("organization_id","result","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "check_runs_site_idempotency_idx" ON "check_runs" USING btree ("site_id","idempotency_key") WHERE "check_runs"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "check_runs_lease_idx" ON "check_runs" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_observations_run_idx" ON "delivery_observations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "destinations_site_idx" ON "destinations" USING btree ("site_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "form_configs_site_version_idx" ON "form_configs" USING btree ("site_id","version");--> statement-breakpoint
CREATE INDEX "form_discoveries_site_idx" ON "form_discoveries" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "inbound_receipts_lookup_idx" ON "inbound_receipts" USING btree ("destination_id","token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_receipts_remote_idx" ON "inbound_receipts" USING btree ("destination_id","remote_id_hash");--> statement-breakpoint
CREATE INDEX "incident_transitions_incident_idx" ON "incident_transitions" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "incidents_org_state_updated_idx" ON "incidents" USING btree ("organization_id","state","updated_at");--> statement-breakpoint
CREATE INDEX "incidents_site_idx" ON "incidents" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investigation_events_seq_idx" ON "investigation_events" USING btree ("investigation_id","sequence");--> statement-breakpoint
CREATE INDEX "investigations_incident_idx" ON "investigations" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "invitations_org_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user_idx" ON "memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "model_calls_investigation_idx" ON "model_calls" USING btree ("investigation_id");--> statement-breakpoint
CREATE INDEX "notifications_dedup_idx" ON "notifications" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "notifications_org_idx" ON "notifications" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_events" USING btree ("dispatched_at","ready_at");--> statement-breakpoint
CREATE INDEX "patch_checks_patch_idx" ON "patch_checks" USING btree ("patch_id");--> statement-breakpoint
CREATE INDEX "patches_incident_idx" ON "patches" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "policy_decisions_sandbox_ts_idx" ON "policy_decisions" USING btree ("sandbox_id","timestamp");--> statement-breakpoint
CREATE INDEX "run_artifacts_run_idx" ON "run_artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_artifacts_expiry_idx" ON "run_artifacts" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_sequence_idx" ON "run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "sandbox_sessions_run_idx" ON "sandbox_sessions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "sandbox_sessions_investigation_idx" ON "sandbox_sessions" USING btree ("investigation_id");--> statement-breakpoint
CREATE INDEX "sandbox_sessions_cleanup_idx" ON "sandbox_sessions" USING btree ("cleanup_verified","stopped_at");--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sites_org_idx" ON "sites" USING btree ("organization_id","archived_at");--> statement-breakpoint
CREATE INDEX "tool_calls_investigation_idx" ON "tool_calls" USING btree ("investigation_id");