/** Calendar arithmetic uses civil dates; instants always carry an explicit offset. */
const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(instant: number, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(timezone, formatter);
  }
  const values = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(p => [p.type, p.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) };
}
const pad = (n: number) => String(n).padStart(2, '0');
function parseDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Data inválida. Use AAAA-MM-DD.');
  const value = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) throw new Error('Data inválida.');
  return value;
}
function offsetAt(instant: number, timezone: string) {
  const p = parts(instant, timezone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000) / 60000);
}
export function zoned(date: string, time: string, timezone = 'America/Sao_Paulo'): string {
  parseDate(date);
  if (!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) throw new Error('Horário inválido.');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second = 0] = time.split(':').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  // Resolve IANA offsets at both sides of a possible DST transition. Ambiguous
  // local times choose the earlier instant; nonexistent civil times are rejected.
  const offsets = new Set([-86400000, 0, 86400000].map(delta => offsetAt(wall + delta, timezone)));
  const candidates = [...offsets].map(offset => ({ instant: wall - offset * 60000, offset })).filter(({ instant }) => {
    const p = parts(instant, timezone);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute && p.second === second;
  }).sort((a, b) => a.instant - b.instant);
  if (!candidates.length) throw new Error(`Horário inexistente no fuso ${timezone}.`);
  const offset = candidates[0].offset;
  return `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
export function dateAt(iso: string, timezone = 'America/Sao_Paulo'): string {
  const instant = Date.parse(iso);
  if (!Number.isFinite(instant)) throw new Error('Data e hora inválidas.');
  const p = parts(instant, timezone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
export function addDays(date: string, days: number): string {
  const value = parseDate(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function weekStart(date: string, weekStartsOn = 1): string {
  const weekday = parseDate(date).getUTCDay() || 7;
  const start = weekStartsOn === 0 ? 7 : Math.min(7, Math.max(1, weekStartsOn));
  return addDays(date, -((weekday - start + 7) % 7));
}
export function hours(start: string, end: string): number {
  return Math.max(0, (Date.parse(end) - Date.parse(start)) / 3600000) || 0;
}
