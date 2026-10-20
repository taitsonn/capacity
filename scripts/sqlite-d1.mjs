import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Small D1-compatible adapter. The application runs identical prepared SQL locally. */
class SQLiteStatement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new SQLiteStatement(this.database, this.sql, values); }
  result(statement, values = this.values) {
    const started = performance.now();
    let results = [], changes = 0, lastRowId = 0;
    if (statement.columns().length) results = statement.all(...values);
    else { const result = statement.run(...values); changes = Number(result.changes); lastRowId = Number(result.lastInsertRowid); }
    return { success: true, results, meta: { changes, last_row_id: lastRowId, duration: performance.now() - started, served_by: 'node:sqlite', rows_read: results.length, rows_written: changes } };
  }
  async first(column) { const row = this.database.prepare(this.sql).get(...this.values); return column === undefined ? row ?? null : row?.[column] ?? null; }
  async all() { return this.result(this.database.prepare(this.sql)); }
  async run() { return this.result(this.database.prepare(this.sql)); }
  async raw(options) { const statement = this.database.prepare(this.sql); statement.setReturnArrays(true); const rows = statement.all(...this.values); return options?.columnNames ? [statement.columns().map(c => c.name), ...rows] : rows; }
  execute() { return this.result(this.database.prepare(this.sql)); }
}

export class SQLiteD1 {
  constructor(database) { this.database = database; }
  prepare(sql) { return new SQLiteStatement(this.database, sql); }
  async batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(statement => statement.execute()); this.database.exec('COMMIT'); return results; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  async exec(sql) { const started = performance.now(); this.database.exec(sql); return { count: 1, duration: performance.now() - started }; }
}

export function openLocalDatabase(filename, migrationsDirectory) {
  if(filename!==':memory:')mkdirSync(path.dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename);
  try {
    database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    database.exec('CREATE TABLE IF NOT EXISTS __capacity_migrations(filename TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const applied = database.prepare('SELECT checksum FROM __capacity_migrations WHERE filename=?');
    for (const filename of readdirSync(migrationsDirectory).filter(name => name.endsWith('.sql')).sort()) {
      const source = readFileSync(path.join(migrationsDirectory, filename), 'utf8'), checksum = createHash('sha256').update(source).digest('hex'), previous = applied.get(filename);
      if (previous) { if (previous.checksum !== checksum) throw new Error(`A migração ${filename} foi alterada após sua aplicação. Restaure o arquivo e crie uma nova migração.`); continue; }
      database.exec('BEGIN IMMEDIATE');
      try { database.exec(source); database.prepare('INSERT INTO __capacity_migrations(filename,checksum,applied_at) VALUES(?,?,?)').run(filename, checksum, new Date().toISOString()); database.exec('COMMIT'); }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    }
    return { binding: new SQLiteD1(database), close: () => database.close() };
  } catch (error) { database.close(); throw error; }
}
