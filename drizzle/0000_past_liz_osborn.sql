CREATE TABLE `allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`demand_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`start` text NOT NULL,
	`end` text NOT NULL,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `allocation_employee_period` ON `allocations` (`employee_id`,`start`,`end`);--> statement-breakpoint
CREATE INDEX `allocation_demand` ON `allocations` (`demand_id`);--> statement-breakpoint
CREATE TABLE `app_meta` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`seeded_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`before` text,
	`after` text
);
--> statement-breakpoint
CREATE INDEX `audit_at` ON `audit` (`at`);--> statement-breakpoint
CREATE TABLE `demands` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`project` text NOT NULL,
	`requester` text NOT NULL,
	`priority` text NOT NULL,
	`date` text NOT NULL,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`required` integer NOT NULL,
	`status` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demands_code_unique` ON `demands` (`code`);--> statement-breakpoint
CREATE INDEX `demand_period` ON `demands` (`start`,`end`);--> statement-breakpoint
CREATE TABLE `employees` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`team` text NOT NULL,
	`role` text NOT NULL,
	`journey` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`weekdays` text NOT NULL,
	`breaks` text NOT NULL,
	`weekly_hours` real NOT NULL,
	`weekly_limit` real NOT NULL,
	`eligible_night` integer NOT NULL,
	`max_extra_nights` integer NOT NULL,
	`active` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employees_code_unique` ON `employees` (`code`);--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`failures` integer NOT NULL,
	`window_start` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shift_exceptions` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`date` text NOT NULL,
	`kind` text NOT NULL,
	`start_time` text,
	`end_time` text,
	`note` text DEFAULT '' NOT NULL,
	`approved` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `exception_employee_date` ON `shift_exceptions` (`employee_id`,`date`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`platform_id` text,
	`username` text,
	`password_hash` text,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "valid_user_role" CHECK("users"."role" in ('admin','manager','client'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_platform_id_unique` ON `users` (`platform_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);