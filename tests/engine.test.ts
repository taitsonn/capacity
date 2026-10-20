import test from 'node:test';
import assert from 'node:assert/strict';
import type { Demand, Employee, ShiftException, State } from '../lib/types.ts';
// @ts-ignore -- executable directly with node --experimental-strip-types.
import { buildCalendar, capacity, getAvailability, getShifts, simulate, validateDemand, validateException, validateRecurringSchedule } from '../lib/engine.ts';
// @ts-ignore -- executable directly with node --experimental-strip-types.
import { addDays, dateAt, hours, weekStart, zoned } from '../lib/time.ts';

function employee(id='a',changes:Partial<Employee>={}):Employee {return {id,code:id,name:`Analista ${id.toUpperCase()}`,team:'Operações',role:'Analista',journey:'day',startTime:'09:00',endTime:'18:00',weekdays:[1,2,3,4,5],breaks:[{start:'12:00',end:'13:00'}],weeklyHours:40,weeklyLimit:60,eligibleNight:true,maxExtraNights:1,active:true,...changes};}
function initial():State {return {employees:[employee()],exceptions:[],demands:[],settings:{timezone:'America/Sao_Paulo',restHours:11,nightStart:'23:00',nightEnd:'05:00',weekStartsOn:1,comfortableThreshold:85,saturationThreshold:100,clientShowNames:false,clientShowDetails:false}};}
const at=(date:string,time:string)=>zoned(date,time);
function extra(date='2026-10-13',employeeId='a'):ShiftException{return {id:`extra:${employeeId}:${date}`,employeeId,date,kind:'extra',startTime:'23:00',endTime:'05:00',approved:true};}
function adjusted(date='2026-10-13',employeeId='a'):ShiftException{return {id:`adjust:${employeeId}:${date}`,employeeId,date,kind:'override',startTime:'09:00',endTime:'12:00',approved:true};}
function demand(id:string,date:string,startTime:string,endTime:string,changes:Partial<Demand>={}):Demand {const start=at(date,startTime),end=at(endTime<=startTime?addDays(date,1):date,endTime);return {id,code:id,title:id,type:'BSIM',project:'Projeto',requester:'Gestor',priority:'medium',date,start,end,required:1,status:'confirmed',notes:'',allocations:[{id:`${id}:a`,employeeId:'a',start,end}],...changes};}
function codes(result:{code:string}[]){return result.map(i=>i.code);}

test('1 · CHG finalizada às 05h bloqueia até 16h e reduz capacidade da próxima jornada',()=>{
 const state=initial();state.exceptions=[adjusted(),extra()];state.demands=[demand('CHG-1','2026-10-13','23:00','05:00',{type:'CHG'})];
 assert.equal(getAvailability(state,'a',at('2026-10-14','09:00'),at('2026-10-14','10:00')).available,false);
 assert.ok(codes(getAvailability(state,'a',at('2026-10-14','15:00'),at('2026-10-14','16:00')).issues).includes('MIN_REST'));
 assert.equal(getAvailability(state,'a',at('2026-10-14','16:00'),at('2026-10-14','18:00')).available,true);
 const day=getShifts(state,'2026-10-14','2026-10-14').find(s=>s.date==='2026-10-14');assert.equal(day?.start,new Date(at('2026-10-14','16:00')).toISOString());
 assert.equal(capacity(state,'2026-10-14','2026-10-14').confirmed,7); // 00–05 night + 16–18 day.
 assert.equal(buildCalendar(state,'2026-10-14','2026-10-14').find(c=>c.hour===10)?.status,'rest');
});
test('2 · jornada encerrada às 18h impede ativação às 23h; ajuste para 12h libera',()=>{
 const state=initial();assert.ok(codes(validateException(state,extra())).includes('MIN_REST'));
 state.exceptions=[adjusted()];assert.deepEqual(validateException(state,extra()),[]);
});
test('3 · atuação extraordinária é contada por ativação, com limite semanal',()=>{
 const state=initial();state.exceptions=[adjusted(),extra()];
 assert.ok(codes(validateException(state,extra('2026-10-17'))).includes('WEEKLY_EXTRA_LIMIT'));
 state.demands=[demand('CHG-1','2026-10-13','23:00','01:00',{type:'CHG'}),demand('CHG-2','2026-10-14','01:00','03:00',{type:'CHG'})];
 assert.deepEqual(validateDemand(state,state.demands[0]),[]);assert.deepEqual(validateDemand(state,state.demands[1]),[]);
 assert.ok(!codes(validateDemand(state,state.demands[1])).includes('WEEKLY_EXTRA_LIMIT'));
});
test('4 · demanda de 3h com dois analistas consome 6 pessoa-hora',()=>{
 const state=initial();state.employees.push(employee('b'));const d=demand('BSIM-1','2026-10-13','09:00','12:00',{required:2});d.allocations.push({...d.allocations[0],id:'second',employeeId:'b'});state.demands=[d];
 assert.deepEqual(validateDemand(state,d),[]);assert.equal(capacity(state,'2026-10-13','2026-10-13').committed,6);assert.equal(capacity(state,'2026-10-13','2026-10-13').free,10);
});
test('5 · sexta 23h a sábado 05h aparece em ambos os dias, sem horas duplicadas',()=>{
 const state=initial();state.employees=[employee('a',{journey:'night',startTime:'23:00',endTime:'05:00',breaks:[],eligibleNight:false})];state.demands=[demand('CHG-1','2026-10-16','23:00','05:00',{type:'CHG'})];
 const cells=buildCalendar(state,'2026-10-16','2026-10-17');assert.equal(cells.filter(c=>c.status==='CHG').length,6);assert.equal(cells.find(c=>c.date==='2026-10-16'&&c.hour===23)?.status,'CHG');assert.equal(cells.find(c=>c.date==='2026-10-17'&&c.hour===4)?.status,'CHG');
 assert.equal(capacity(state,'2026-10-17','2026-10-17').committed,5);assert.equal(capacity(state,'2026-10-17','2026-10-17').confirmed,5);
});
test('6 · final de semana sem elegível apresenta falta de capacidade',()=>{
 const state=initial();state.employees[0].eligibleNight=false;state.demands=[demand('CHG-WE','2026-10-17','23:00','02:00',{type:'CHG',status:'planning',allocations:[]})];
 const metrics=capacity(state,'2026-10-17','2026-10-18');assert.equal(metrics.confirmed,0);assert.equal(metrics.potential,0);assert.equal(metrics.deficit,3);assert.equal(metrics.uncovered,1);
 const sim=simulate(state,{type:'CHG',start:at('2026-10-17','23:00'),end:at('2026-10-18','02:00'),required:1});assert.equal(sim.canAbsorb,false);
});
test('7 · sobreposição bloqueia confirmação, adjacência é permitida',()=>{
 const state=initial();state.demands=[demand('BSIM-1','2026-10-13','09:00','11:00')];
 assert.ok(codes(validateDemand(state,demand('TSD-2','2026-10-13','10:00','12:00',{type:'TSD'}))).includes('OVERLAP'));
 assert.deepEqual(validateDemand(state,demand('TSD-3','2026-10-13','11:00','12:00',{type:'TSD'})),[]);
});
test('8 · simulação é pura e potencial permanece separado da capacidade aprovada',()=>{
 const state=initial(),before=JSON.stringify(state),baseline=capacity(state,'2026-10-17','2026-10-18');
 const sim=simulate(state,{type:'CHG',start:at('2026-10-17','23:00'),end:at('2026-10-18','02:00'),required:1});assert.equal(sim.canAbsorb,true);assert.equal(sim.requiresExtra,true);assert.equal(sim.potential.length,1);assert.equal(sim.eligible.length,0);assert.equal(JSON.stringify(state),before);assert.deepEqual(capacity(state,'2026-10-17','2026-10-18'),baseline);assert.equal(baseline.confirmed,0);assert.equal(baseline.potential,6);
});
test('9 · remoção da escala da CHG recalcula descanso e capacidade sem estados derivados persistidos',()=>{
 const state=initial();state.exceptions=[adjusted(),extra()];state.demands=[demand('CHG-1','2026-10-13','23:00','05:00',{type:'CHG'})];
 assert.equal(getAvailability(state,'a',at('2026-10-14','09:00'),at('2026-10-14','10:00')).available,false);
 state.demands=[];state.exceptions=state.exceptions.filter(e=>e.kind!=='extra');
 assert.equal(getAvailability(state,'a',at('2026-10-14','09:00'),at('2026-10-14','10:00')).available,true);assert.equal(capacity(state,'2026-10-14','2026-10-14').confirmed,8);assert.ok(!buildCalendar(state,'2026-10-14','2026-10-14').some(c=>c.status==='rest'));
});
test('domingo 23h conta na semana que começou, segunda pertence à próxima',()=>{
 const state=initial();state.exceptions=[extra('2026-10-18')];assert.equal(weekStart('2026-10-18'),'2026-10-12');
 assert.ok(codes(validateException(state,extra('2026-10-17'))).includes('WEEKLY_EXTRA_LIMIT'));
 state.exceptions.push(adjusted('2026-10-20'));assert.ok(!codes(validateException(state,extra('2026-10-20'))).includes('WEEKLY_EXTRA_LIMIT'));
});
test('intervalo intrajornada, férias e inatividade excluem a disponibilidade',()=>{
 const state=initial();assert.equal(getAvailability(state,'a',at('2026-10-13','12:00'),at('2026-10-13','13:00')).available,false);assert.equal(capacity(state,'2026-10-13','2026-10-13').confirmed,8);
 state.exceptions=[{id:'vac',employeeId:'a',date:'2026-10-13',kind:'vacation',approved:true}];assert.equal(capacity(state,'2026-10-13','2026-10-13').confirmed,0);assert.ok(codes(getAvailability(state,'a',at('2026-10-13','09:00'),at('2026-10-13','10:00')).issues).includes('ABSENCE'));
 state.employees[0].active=false;assert.ok(codes(getAvailability(state,'a',at('2026-10-14','09:00'),at('2026-10-14','10:00')).issues).includes('INACTIVE'));
});
test('CHG exige janela completa, alocação dentro da demanda e cobertura durante todo intervalo',()=>{
 const state=initial();assert.ok(codes(validateDemand(state,demand('CHG-BAD','2026-10-13','22:00','02:00',{type:'CHG'}))).includes('CHG_WINDOW'));
 const partial=demand('PARTIAL','2026-10-13','09:00','12:00');partial.allocations[0].end=at('2026-10-13','11:00');assert.ok(codes(validateDemand(state,partial)).includes('UNDERSTAFFED'));
 partial.allocations[0].start=at('2026-10-13','08:00');assert.ok(codes(validateDemand(state,partial)).includes('OUTSIDE_DEMAND'));
});
test('nova escala não pode invalidar alocação confirmada na jornada seguinte',()=>{
 const state=initial();state.exceptions=[adjusted()];state.demands=[demand('NEXT','2026-10-14','09:00','11:00')];assert.ok(codes(validateException(state,extra())).includes('MIN_REST'));
});
test('limite contratual semanal é validado e reservas não consomem compromisso confirmado',()=>{
 const state=initial();state.employees[0].weeklyLimit=40;assert.ok(codes(validateException(state,extra('2026-10-17'))).includes('WEEKLY_HOURS'));
 state.demands=[demand('RES','2026-10-14','09:00','11:00',{status:'planning'})];const metrics=capacity(state,'2026-10-14','2026-10-14');assert.equal(metrics.committed,0);assert.equal(metrics.reserved,2);assert.equal(metrics.free,8);
});
test('capacidade potencial não soma duas noites alternativas para uma ativação semanal',()=>{
 const state=initial();const metrics=capacity(state,'2026-10-17','2026-10-18');assert.equal(metrics.potential,6);assert.equal(metrics.confirmed,0);assert.equal(metrics.eligibleNight,1);
});
test('fuso usa offset real, inclusive transição histórica de verão e aritmética de datas',()=>{
 assert.equal(at('2026-10-13','23:00'),'2026-10-13T23:00:00-03:00');assert.equal(zoned('2018-12-01','23:00'),'2018-12-01T23:00:00-02:00');assert.equal(dateAt('2026-10-14T02:00:00Z'),'2026-10-13');assert.equal(addDays('2028-02-28',1),'2028-02-29');assert.equal(hours(at('2026-10-13','23:00'),at('2026-10-14','05:00')),6);assert.throws(()=>zoned('2018-11-04','00:30'));assert.throws(()=>zoned('2026-02-30','09:00'));
});
test('ausência de um alocado gera déficit mesmo havendo capacidade de outro colaborador',()=>{
 const state=initial();state.employees.push(employee('b'));state.exceptions=[{id:'off',employeeId:'a',date:'2026-10-13',kind:'off',approved:true}];state.demands=[demand('IMPOSSIBLE','2026-10-13','09:00','12:00')];const metrics=capacity(state,'2026-10-13','2026-10-13');assert.equal(metrics.confirmed,8);assert.equal(metrics.deficit,3);assert.equal(metrics.uncovered,1);assert.ok(metrics.issues.some(i=>i.code==='ABSENCE'));
});
test('simulação de domingo inclui redução da jornada seguinte ao calcular ocupação',()=>{
 const state=initial();const result=simulate(state,{type:'CHG',start:at('2026-10-18','23:00'),end:at('2026-10-19','02:00'),required:1});assert.equal(result.canAbsorb,true);assert.equal(result.occupancyAfter,37.5); // 6h extra + 2h diurnas, em vez de 6 + 8.
 assert.equal(result.impactNextDay.length,1);
});
test('janela noturna parametrizada sem cruzar meia-noite também funciona',()=>{
 const state=initial();state.settings.nightStart='01:00';state.settings.nightEnd='07:00';const result=simulate(state,{type:'CHG',start:at('2026-10-18','01:00'),end:at('2026-10-18','03:00'),required:1});assert.equal(result.canAbsorb,true);assert.equal(result.potential.length,1);
});
test('remover só a demanda mantém descanso da escala extraordinária ainda aprovada',()=>{
 const state=initial();state.exceptions=[adjusted(),extra()];state.demands=[];assert.equal(getAvailability(state,'a',at('2026-10-14','09:00'),at('2026-10-14','10:00')).available,false);assert.equal(capacity(state,'2026-10-14','2026-10-14').committed,0);
});
test('simulador oferece outros horários livres no mesmo dia e nos próximos dias sem persistir',()=>{
 const state=initial();state.demands=[demand('BUSY','2026-10-13','09:00','10:00')];const snapshot=JSON.stringify(state);
 const result=simulate(state,{type:'BSIM',start:at('2026-10-13','09:00'),end:at('2026-10-13','10:00'),required:1});
 assert.equal(result.canAbsorb,false);assert.ok(result.alternatives.some(a=>dateAt(a.start)==='2026-10-13'&&new Date(a.start).getTime()===new Date(at('2026-10-13','10:00')).getTime()));
 assert.ok(result.alternatives.some(a=>dateAt(a.start)>'2026-10-13'));assert.equal(JSON.stringify(state),snapshot);
 for(const alternative of result.alternatives){assert.equal(hours(alternative.start,alternative.end),1);assert.equal(getAvailability(state,'a',alternative.start,alternative.end).available,true);}
});
test('horários alternativos exigem toda a equipe simultânea e preservam intervalos',()=>{
 const state=initial();state.employees.push(employee('b'));const first=demand('A-BUSY','2026-10-13','09:00','10:00'),second=demand('B-BUSY','2026-10-13','10:00','11:00');second.allocations[0].employeeId='b';state.demands=[first,second];
 const result=simulate(state,{type:'TSD',start:at('2026-10-13','09:00'),end:at('2026-10-13','10:00'),required:2});assert.ok(result.alternatives.some(a=>nEqual(a.start,at('2026-10-13','11:00'))));
 for(const alternative of result.alternatives){assert.equal(alternative.eligibleCount,2);for(const e of state.employees)assert.equal(getAvailability(state,e.id,alternative.start,alternative.end).available,true);}
});
function nEqual(a:string,b:string){return Date.parse(a)===Date.parse(b);}
test('alternativas incluem fim de alocação em minutos, sem se limitar à hora cheia',()=>{
 const state=initial();state.demands=[demand('BUSY-MINUTES','2026-10-13','09:00','10:30')];const result=simulate(state,{type:'BSIM',start:at('2026-10-13','09:00'),end:at('2026-10-13','10:00'),required:1});assert.ok(result.alternatives.some(a=>nEqual(a.start,at('2026-10-13','10:30'))));
});
test('alternativas CHG respeitam janela noturna e somente escalas já aprovadas',()=>{
 const state=initial();state.employees=[employee('a',{journey:'night',startTime:'23:00',endTime:'05:00',breaks:[],eligibleNight:false})];state.demands=[demand('NIGHT-BUSY','2026-10-13','23:00','01:00',{type:'CHG'})];
 const result=simulate(state,{type:'CHG',start:at('2026-10-13','23:00'),end:at('2026-10-14','01:00'),required:1});assert.ok(result.alternatives.some(a=>nEqual(a.start,at('2026-10-14','01:00'))));
 for(const alternative of result.alternatives){const check=demand('ALTERNATIVE',dateAt(alternative.start),'23:00','01:00',{type:'CHG',start:alternative.start,end:alternative.end,allocations:[{id:'alternative',employeeId:'a',start:alternative.start,end:alternative.end}]});assert.deepEqual(validateDemand(state,check),[]);}
 const onlyPotential=simulate(initial(),{type:'CHG',start:at('2026-10-17','23:00'),end:at('2026-10-18','01:00'),required:1});assert.equal(onlyPotential.canAbsorb,true);assert.deepEqual(onlyPotential.alternatives,[]);
});
test('CHG curta antes de meia-noite inclui a noite completa e o descanso no denominador',()=>{
 const state=initial(),before=JSON.stringify(state);const result=simulate(state,{type:'CHG',start:at('2026-10-18','23:00'),end:at('2026-10-18','23:30'),required:1});assert.equal(result.canAbsorb,true);assert.equal(result.occupancyAfter,6.25);assert.equal(result.impactNextDay.length,1);assert.equal(JSON.stringify(state),before);
});
test('impacto seguinte lista somente os extras efetivamente necessários à simulação',()=>{
 const state=initial();state.employees.push(employee('b'),employee('n',{journey:'night',startTime:'23:00',endTime:'05:00',weekdays:[1,2,3,4,5,6,7],breaks:[],eligibleNight:false,weeklyLimit:60}));
 const proposal={type:'CHG' as const,start:at('2026-10-18','23:00'),end:at('2026-10-19','02:00'),required:1};const normal=simulate(state,proposal);assert.equal(normal.eligible.length,1);assert.equal(normal.potential.length,2);assert.deepEqual(normal.impactNextDay,[]);assert.equal(normal.requiresExtra,false);
 const withExtra=simulate(state,{...proposal,required:2});assert.equal(withExtra.impactNextDay.length,1);assert.ok(withExtra.impactNextDay[0].includes('Analista A'));assert.ok(!withExtra.impactNextDay.some(m=>m.includes('Analista B')));
 assert.ok(withExtra.impactNextDay[0].includes('16:00'));
});
test('caches derivados são invalidados após edição de regras, demandas e escalas',()=>{
 const state=initial();state.exceptions=[adjusted(),extra()];assert.equal(capacity(state,'2026-10-14','2026-10-14').confirmed,7);state.settings.restHours=8;assert.equal(capacity(state,'2026-10-14','2026-10-14').confirmed,10);
 state.exceptions=[];state.settings.restHours=11;assert.equal(capacity(state,'2026-10-14','2026-10-14').confirmed,8);
 assert.equal(buildCalendar(state,'2026-10-18','2026-10-18').find(c=>c.hour===23)?.status,'potential');state.demands.push(demand('NEXT-MORNING','2026-10-19','09:00','10:00'));assert.equal(buildCalendar(state,'2026-10-18','2026-10-18').find(c=>c.hour===23)?.status,'off');
});
test('escala recorrente inválida por descanso é bloqueada mesmo sem demandas',()=>{
 const state=initial();state.employees[0]={...state.employees[0],journey:'custom',startTime:'07:00',endTime:'23:00',weeklyLimit:100};assert.equal(state.demands.length,0);assert.ok(codes(validateRecurringSchedule(state,'a')).includes('MIN_REST'));
 state.exceptions=[{id:'mask',employeeId:'a',date:'2026-10-13',kind:'off',approved:true}];assert.ok(codes(validateRecurringSchedule(state,'a')).includes('MIN_REST'));
});
test('limite semanal recorrente é bloqueado sem demandas e exclui intervalo produtivo',()=>{
 const state=initial();state.employees[0].weeklyLimit=20;assert.ok(codes(validateRecurringSchedule(state,'a')).includes('WEEKLY_HOURS'));
 state.employees[0].weeklyLimit=40;assert.deepEqual(validateRecurringSchedule(state,'a'),[]);assert.equal(capacity(state,'2026-10-12','2026-10-18').confirmed,40);
});
test('recorrência noturna personalizada é regular e não consome limite extraordinário',()=>{
 const state=initial();state.employees[0]={...state.employees[0],journey:'custom',startTime:'23:00',endTime:'05:00',breaks:[],weeklyLimit:30,eligibleNight:false,maxExtraNights:0};assert.deepEqual(validateRecurringSchedule(state),[]);assert.ok(getShifts(state,'2026-10-12','2026-10-18').every(s=>!s.extra));
 assert.equal(getAvailability(state,'a',at('2026-10-13','23:00'),at('2026-10-14','02:00')).available,true);
});
test('validação recorrente considera fronteira semanal e novo parâmetro de descanso',()=>{
 const state=initial();state.employees[0]={...state.employees[0],journey:'custom',startTime:'07:00',endTime:'23:00',weekdays:[1,7],weeklyLimit:40};assert.ok(codes(validateRecurringSchedule(state)).includes('MIN_REST'));
 state.employees[0]=employee();state.settings.restHours=16;assert.ok(codes(validateRecurringSchedule(state)).includes('MIN_REST'));state.settings.restHours=15;assert.deepEqual(validateRecurringSchedule(state),[]);
});
test('validação recorrente permite seleção de colaborador e ignora cadastros inativos',()=>{
 const state=initial();state.employees.push(employee('b',{weeklyLimit:20}));assert.deepEqual(validateRecurringSchedule(state,'a'),[]);assert.ok(validateRecurringSchedule(state).some(i=>i.employeeId==='b'));state.employees[1].active=false;assert.deepEqual(validateRecurringSchedule(state),[]);
});
