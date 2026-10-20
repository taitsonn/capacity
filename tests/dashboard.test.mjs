import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Module from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { capacity } from '../lib/engine.ts';
import { typeCapacity } from '../lib/type-capacity.ts';
import { zoned } from '../lib/time.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function component(relative) {
  const filename = path.join(root, relative);
  const bundle = await build({ entryPoints: [filename], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'lucide-react'], loader: { '.css': 'empty' }, tsconfig: path.join(root, 'tsconfig.json'), logLevel: 'silent' });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(root);
  loaded._compile(bundle.outputFiles[0].text, filename);
  return loaded.exports;
}
const { ManagementDashboard, ExecutiveDashboard } = await component('components/capacity/dashboards.tsx');
const { DemandForm } = await component('components/capacity/forms.tsx');
const { WeeklyCHGPlanning } = await component('components/capacity/weekly-chg-planning.tsx');
const { statusForDemandAction } = await component('components/capacity/demand-workflow.ts');
const timezone = 'America/Sao_Paulo';
const at = (date, time) => zoned(date, time, timezone);
const settings = { timezone, restHours: 11, nightStart: '23:00', nightEnd: '05:00', weekStartsOn: 1, comfortableThreshold: 85, saturationThreshold: 100, clientShowNames: true, clientShowDetails: true };
const night = { id: 'lucas', name: 'Lucas Cordeiro', code: 'OP-003', team: 'Operações', role: 'Analista noturno', journey: 'night', startTime: '17:00', endTime: '02:00', weekdays: [1, 2, 3, 4, 5], breaks: [{ start: '22:00', end: '23:00' }], weeklyHours: 40, weeklyLimit: 48, eligibleNight: false, maxExtraNights: 0, active: true };
const day = { ...night, id: 'marcelo', name: 'Marcelo', journey: 'day', startTime: '09:00', endTime: '18:00', breaks: [{ start: '12:00', end: '13:00' }] };
function demand(overrides = {}) { const start = at('2026-10-20', '23:00'), end = at('2026-10-21', '05:00'); return { id: 'chg-111', code: 'CHG-111', title: 'Validação de ambiente', type: 'CHG', project: 'Operações', requester: 'Equipe', priority: 'high', date: '2026-10-20', start, end, required: 3, status: 'planning', notes: '', allocations: [{ id: 'a-1', employeeId: night.id, start, end }], ...overrides }; }
const state = { employees: [night], exceptions: [], settings, demands: [demand()], revision: 1 };
const noop = () => {};
function props(value, type = 'CHG', from = '2026-10-20', to = '2026-10-21', writable = true) { return { state: value, metrics: capacity(value, from, to), typed: typeCapacity(value, from, to, type), from, to, type, writable, displayName: id => value.employees.find(e => e.id === id)?.name || id, onDemand: noop, onNavigate: noop, onSimulate: noop }; }
const render = (Component, values) => renderToStaticMarkup(React.createElement(Component, values));

test('manager separates 6h planning / 18h requested from 3h productive and shows 1 of 3 people', () => {
  const p = props(state);
  assert.equal(p.typed.reserved, 3);
  assert.equal(p.typed.committed, 0);
  const html = render(ManagementDashboard, p);
  assert.match(html, /Reservas produtivas/);
  assert.match(html, /3h produtivas reservadas/);
  assert.match(html, /6h alocadas em planejamento/);
  assert.match(html, /18h previstas/);
  assert.match(html, /1 de 3 pessoas/);
  assert.match(html, /Taxa de ocupação oficial/);
  assert.match(html, /Capacidade comprometida/);
  assert.match(html, /Revisar e confirmar/);
  assert.doesNotMatch(html, /Podemos absorver novas demandas/);
});

test('executive has a different decision-first layout, exact deficit and no operational team table', () => {
  const html = render(ExecutiveDashboard, props(state));
  assert.match(html, /Podemos absorver novas demandas/);
  assert.match(html, /Capacidade residual confirmada/);
  assert.match(html, /18h previstas no período/);
  assert.match(html, /15h/);
  assert.match(html, /Janelas para novas solicitações/);
  assert.doesNotMatch(html, /Distribuição da carga entre colaboradores/);
  assert.doesNotMatch(html, /Trabalho por tipo de atividade/);
  assert.doesNotMatch(html, /Demandas de CHG para revisar e confirmar/);
});

test('save reservation and confirm are separate explicit actions; confirmation is default submit order', () => {
  const html = render(DemandForm, { data: demand(), state, displayName: id => id, showDetails: true, onSave: async () => {}, onDelete: async () => {} });
  assert.match(html, /Confirmar alocação/);
  assert.match(html, /Salvar reserva/);
  assert.ok(html.indexOf('value="confirm"') < html.indexOf('value="reserve"'));
  assert.equal(statusForDemandAction('planning', 'confirm'), 'confirmed');
  assert.equal(statusForDemandAction('planning', 'reserve'), 'planning');
  assert.equal(statusForDemandAction('requested', 'reserve'), 'requested');
  assert.equal(statusForDemandAction('planning', 'save'), 'planning');
  assert.equal(statusForDemandAction('running', 'save'), 'running');
  const readonly = render(DemandForm, { data: demand(), state, readonly: true, displayName: id => id, showDetails: false, onSave: async () => {}, onDelete: async () => {} });
  assert.doesNotMatch(readonly, /name="intent"/);
  assert.match(readonly, /Visualização de leitura/);
});

test('manager immediately renders new official figures after explicit confirmation', () => {
  const start = at('2026-10-20', '09:00'), end = at('2026-10-20', '12:00');
  const planned = demand({ id: 'bsim', code: 'BSIM-NEW', type: 'BSIM', start, end, required: 1, allocations: [{ id: 'a-day', employeeId: day.id, start, end }] });
  const before = { ...state, employees: [day], demands: [planned] };
  const after = { ...before, revision: 2, demands: [{ ...planned, status: statusForDemandAction(planned.status, 'confirm') }] };
  const pendingProps = props(before, 'BSIM', '2026-10-20', '2026-10-20');
  const confirmedProps = props(after, 'BSIM', '2026-10-20', '2026-10-20');
  assert.equal(pendingProps.typed.committed, 0);
  assert.equal(pendingProps.typed.free, 8);
  assert.equal(pendingProps.typed.reserved, 3);
  assert.equal(confirmedProps.typed.committed, 3);
  assert.equal(confirmedProps.typed.free, 5);
  assert.equal(confirmedProps.typed.reserved, 0);
  const html = render(ManagementDashboard, confirmedProps);
  assert.match(html, /Nenhuma reserva de BSIM aguardando confirmação/);
  assert.match(html, /<strong>3h<\/strong>/);
  assert.match(html, /<strong>5h<\/strong>/);
});

test('type filter explains productive reservations from other types without a false empty claim', () => {
  const value = { ...state, demands: [demand({ type: 'BSIM', required: 1 })] };
  const p = props(value);
  assert.equal(p.typed.pendingDemands.length, 0);
  assert.equal(p.typed.reserved, 3);
  const html = render(ManagementDashboard, p);
  assert.match(html, /3h produtivas reservadas por outras atividades/);
  assert.match(html, /outras atividades possuem reservas produtivas/);
  assert.doesNotMatch(html, /Nenhuma reserva aguardando confirmação/);
});

test('executive marks forecast overload even when individual reservations fit and official hours remain free', () => {
  const start = at('2026-10-20', '09:00'), end = at('2026-10-20', '12:00');
  const value = { ...state, employees: [day], demands: [1, 2, 3].map(i => demand({ id: `p${i}`, code: `BSIM-${i}`, type: 'BSIM', start, end, required: 1, allocations: [{ id: `a${i}`, employeeId: day.id, start, end }] })) };
  const p = props(value, 'BSIM', '2026-10-20', '2026-10-20', false);
  assert.equal(p.typed.deficit, 0);
  assert.equal(p.typed.free, 8);
  const html = render(ExecutiveDashboard, p);
  assert.match(html, /Previsão acima da capacidade/);
  assert.match(html, /A previsão supera a capacidade aprovada em 1h/);
  assert.doesNotMatch(html, /Nenhum déficit identificado/);
  assert.doesNotMatch(html, /Avaliar nova demanda/);
});

const updatedNight = { ...night, startTime: '23:00', endTime: '05:00', weeklyHours: 30, breaks: [{ start: '22:00', end: '23:00' }] };
const weeklyTeam = { ...state, demands: [], employees: [updatedNight, ...['Marcelo', 'Lizzie', 'Lucas Telesi', 'Tatiane Ramos'].map((name, i) => ({ ...day, id: `diurno-${i}`, name, role: 'Analista diurno', eligibleNight: true, maxExtraNights: 1, weeklyLimit: 48 }))] };

test('weekly CHG presents 30 regular plus 24 quota as 54 planning hours while dated capacity stays 30', () => {
  const p = props(weeklyTeam, 'CHG', '2026-10-19', '2026-10-25');
  assert.equal(p.typed.planningTotal, 54);
  assert.equal(p.typed.planningFree, 54);
  assert.equal(p.typed.confirmed, 30);
  assert.equal(p.typed.weeklyPlanning[0].regular, 30);
  assert.equal(p.typed.weeklyPlanning[0].extraQuota, 24);
  const html = render(WeeklyCHGPlanning, { metrics: p.typed, from: p.from, to: p.to });
  assert.match(html, /Total planejável na semana/);
  assert.match(html, /54/);
  assert.match(html, /30h \+ 24h/);
  assert.match(html, /30h aprovadas/);
  assert.match(render(ManagementDashboard, p), /Total planejável na semana/);
  assert.match(render(ExecutiveDashboard, p), /Saldo planejável semanal/);
});

test('activating and allocating extraordinary hours consumes quota once rather than inflating 54', () => {
  const start = at('2026-10-24', '23:00'), end = at('2026-10-25', '02:00');
  const extra = { id: 'extra-sat', employeeId: 'diurno-0', date: '2026-10-24', kind: 'extra', startTime: '23:00', endTime: '05:00', approved: true, note: '' };
  const request = demand({ id: 'extra-demand', date: '2026-10-24', start, end, status: 'confirmed', required: 1, allocations: [{ id: 'extra-allocation', employeeId: 'diurno-0', start, end }] });
  const value = { ...weeklyTeam, exceptions: [extra], demands: [request] };
  const p = props(value, 'CHG', '2026-10-19', '2026-10-25');
  assert.equal(p.typed.planningTotal, 54);
  assert.equal(p.typed.planningFree, 51);
  assert.equal(p.typed.confirmed, 36);
  assert.equal(p.typed.free, 33);
  assert.equal(p.typed.weeklyPlanning[0].extraActivated, 6);
  assert.equal(p.typed.weeklyPlanning[0].extraQuotaRemaining, 18);
  const html = render(WeeklyCHGPlanning, { metrics: p.typed, from: p.from, to: p.to });
  assert.match(html, /COTA EXTRAORDINÁRIA UTILIZADA/);
  assert.match(html, /54h/);
  assert.match(html, /36h aprovadas/);
  assert.match(html, /33h livres confirmadas/);
  assert.doesNotMatch(html, /60h/);
});

test('one-day filter keeps dated six hours and labels 54 as full-week context', () => {
  const p = props(weeklyTeam, 'CHG', '2026-10-20', '2026-10-20');
  assert.equal(p.typed.confirmed, 6);
  assert.equal(p.typed.planningTotal, 54);
  const html = render(WeeklyCHGPlanning, { metrics: p.typed, from: p.from, to: p.to });
  assert.match(html, /Semana completa de 19\/10 a 25\/10/);
  assert.match(html, /Estes totais não representam a disponibilidade de um único dia/);
  assert.match(html, /6h aprovadas/);
  assert.match(html, /6h livres confirmadas/);
});

test('CHG form explains explicit extraordinary approval and both rest boundaries', () => {
  const html = render(DemandForm, { data: demand(), state: weeklyTeam, displayName: id => id, showDetails: true, onSave: async () => {}, onDelete: async () => {} });
  assert.match(html, /A cota semanal não aprova uma data/);
  assert.match(html, /escala extraordinária por data em Escalas/);
  assert.match(html, /12:00/);
  assert.match(html, /16:00/);
  assert.match(html, /11h de descanso em cada sentido/);
  assert.match(html, /Confirmar alocação/);
});

test('multi-week overview shows complete-week subtotals rather than repeating extra quota per day', () => {
  const two = props(weeklyTeam, 'CHG', '2026-10-19', '2026-11-01');
  assert.equal(two.typed.weeklyPlanning.length, 2);
  assert.equal(two.typed.planningTotal, 108);
  const fortnight = render(WeeklyCHGPlanning, { metrics: two.typed, from: two.from, to: two.to });
  assert.match(fortnight, /2 semanas completas de planejamento/);
  assert.match(fortnight, /Total planejável das semanas/);
  assert.match(fortnight, /19\/10.*25\/10/);
  assert.match(fortnight, /26\/10.*01\/11/);
  const month = props(weeklyTeam, 'CHG', '2026-10-19', '2026-11-17');
  assert.equal(month.typed.weeklyPlanning.length, 5);
  const monthly = render(WeeklyCHGPlanning, { metrics: month.typed, from: month.from, to: month.to });
  assert.match(monthly, /5 semanas completas de planejamento/);
  assert.match(monthly, /Contexto de/);
  assert.match(monthly, /Estes totais não representam a disponibilidade de um único dia/);
});

test('partial extraordinary shift labels six-hour quota consumption separately from three dated hours', () => {
  const extra = { id: 'partial-extra', employeeId: 'diurno-0', date: '2026-10-24', kind: 'extra', startTime: '23:00', endTime: '02:00', approved: true, note: '' };
  const p = props({ ...weeklyTeam, exceptions: [extra] }, 'CHG', '2026-10-19', '2026-10-25');
  assert.equal(p.typed.weeklyPlanning[0].extraActivated, 6);
  assert.equal(p.typed.confirmed, 33);
  const html = render(WeeklyCHGPlanning, { metrics: p.typed, from: p.from, to: p.to });
  assert.match(html, /COTA EXTRAORDINÁRIA UTILIZADA/);
  assert.match(html, /Uma atuação parcial consome a cota da noite inteira/);
  assert.match(html, /33h aprovadas/);
  assert.doesNotMatch(html, /36h aprovadas/);
});

