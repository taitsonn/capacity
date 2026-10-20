import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, index, check } from 'drizzle-orm/sqlite-core';

export const employees = sqliteTable('employees', {
  id:text('id').primaryKey(), code:text('code').notNull().unique(), name:text('name').notNull(),
  team:text('team').notNull(), role:text('role').notNull(), journey:text('journey').notNull(),
  startTime:text('start_time').notNull(), endTime:text('end_time').notNull(),
  weekdays:text('weekdays').notNull(), breaks:text('breaks').notNull(),
  weeklyHours:real('weekly_hours').notNull(), weeklyLimit:real('weekly_limit').notNull(),
  eligibleNight:integer('eligible_night',{mode:'boolean'}).notNull(),
  maxExtraNights:integer('max_extra_nights').notNull(), active:integer('active',{mode:'boolean'}).notNull(),
});
export const shiftExceptions = sqliteTable('shift_exceptions', {
  id:text('id').primaryKey(), employeeId:text('employee_id').notNull().references(()=>employees.id,{onDelete:'restrict'}),
  date:text('date').notNull(), kind:text('kind').notNull(), startTime:text('start_time'), endTime:text('end_time'),
  note:text('note').notNull().default(''), approved:integer('approved',{mode:'boolean'}).notNull(),
},t=>[index('exception_employee_date').on(t.employeeId,t.date)]);
export const demands = sqliteTable('demands', {
  id:text('id').primaryKey(), code:text('code').notNull().unique(), title:text('title').notNull(), type:text('type').notNull(),
  project:text('project').notNull(), requester:text('requester').notNull(), priority:text('priority').notNull(),
  date:text('date').notNull(), start:text('start').notNull(), end:text('end').notNull(), required:integer('required').notNull(),
  status:text('status').notNull(), notes:text('notes').notNull().default(''),
},t=>[index('demand_period').on(t.start,t.end)]);
export const allocations = sqliteTable('allocations', {
  id:text('id').primaryKey(), demandId:text('demand_id').notNull().references(()=>demands.id,{onDelete:'cascade'}),
  employeeId:text('employee_id').notNull().references(()=>employees.id,{onDelete:'restrict'}), start:text('start').notNull(),end:text('end').notNull(),
},t=>[index('allocation_employee_period').on(t.employeeId,t.start,t.end),index('allocation_demand').on(t.demandId)]);
export const settings = sqliteTable('settings',{id:text('id').primaryKey(),value:text('value').notNull()});
export const appMeta = sqliteTable('app_meta',{id:text('id').primaryKey(),revision:integer('revision').notNull(),seededAt:text('seeded_at').notNull()});
export const users = sqliteTable('users',{
  id:text('id').primaryKey(), platformId:text('platform_id').unique(),username:text('username').unique(),passwordHash:text('password_hash'),
  name:text('name').notNull(),email:text('email').notNull(),role:text('role').notNull(),active:integer('active',{mode:'boolean'}).notNull().default(true),
  createdAt:text('created_at').notNull(),
},t=>[check('valid_user_role',sql`${t.role} in ('admin','manager','client')`)]);
export const sessions = sqliteTable('sessions',{
  tokenHash:text('token_hash').primaryKey(),userId:text('user_id').notNull().references(()=>users.id,{onDelete:'cascade'}),expiresAt:text('expires_at').notNull(),
});
export const audit = sqliteTable('audit',{
  id:text('id').primaryKey(),at:text('at').notNull(),actor:text('actor').notNull(),action:text('action').notNull(),
  entity:text('entity').notNull(),before:text('before'),after:text('after'),
},t=>[index('audit_at').on(t.at)]);
export const loginAttempts = sqliteTable('login_attempts',{
  key:text('key').primaryKey(),failures:integer('failures').notNull(),windowStart:text('window_start').notNull(),
});
