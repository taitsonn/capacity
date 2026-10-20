import test from 'node:test';
import assert from 'node:assert/strict';
import type { Demand, DemandType, Employee, State } from '../lib/types.ts';
// @ts-ignore -- explicit extensions allow the native Node TypeScript test runner.
import { typeCapacity } from '../lib/type-capacity.ts';
// @ts-ignore -- explicit extensions allow the native Node TypeScript test runner.
import { capacity, getAvailability, validateDemand, validateException, weeklyNightPlanning } from '../lib/engine.ts';
// @ts-ignore -- explicit extensions allow the native Node TypeScript test runner.
import { addDays, dateAt, hours, zoned } from '../lib/time.ts';

const at=(date:string,time:string)=>zoned(date,time);
function daytime(id:string):Employee {return {id,code:id,name:id,team:'Operações',role:'Analista',journey:'day',startTime:'09:00',endTime:'18:00',weekdays:[1,2,3,4,5],breaks:[{start:'12:00',end:'13:00'}],weeklyHours:40,weeklyLimit:48,eligibleNight:true,maxExtraNights:1,active:true};}
function initial():State {return {employees:[...['ana','bruno','carla','diego'].map(daytime),{...daytime('lucas'),name:'Lucas Cordeiro',journey:'night',startTime:'17:00',endTime:'02:00',breaks:[{start:'22:00',end:'23:00'}],eligibleNight:false,maxExtraNights:0}],exceptions:[],demands:[],settings:{timezone:'America/Sao_Paulo',restHours:11,nightStart:'23:00',nightEnd:'05:00',weekStartsOn:1,comfortableThreshold:85,saturationThreshold:100,clientShowNames:true,clientShowDetails:true}};}
function demand(id:string,date:string,startTime:string,endTime:string,type:DemandType='CHG',employeeId='lucas'):Demand {
 const start=at(date,startTime),end=at(endTime<=startTime?addDays(date,1):date,endTime);
 return {id,code:id,title:id,type,project:'Projeto',requester:'Gestor',priority:'medium',date,start,end,required:1,status:'confirmed',notes:'',allocations:[{id:`${id}:allocation`,employeeId,start,end}]};
}
const equalInstant=(a:string,b:string)=>Date.parse(a)===Date.parse(b);

test('CHG considera somente capacidade produtiva noturna, sem inflar com jornadas diurnas',()=>{
 const state=initial(),metrics=typeCapacity(state,'2026-10-12','2026-10-18','CHG');
 assert.equal(capacity(state,'2026-10-12','2026-10-18').confirmed,200);
 assert.equal(metrics.confirmed,15);assert.equal(metrics.free,15);assert.equal(metrics.committed,0);assert.equal(metrics.windows.length,5);
 assert.ok(metrics.windows.every(window=>window.employeeId==='lucas'&&window.hours===3));
 assert.ok(metrics.windows.some(window=>equalInstant(window.start,at('2026-10-12','23:00'))&&equalInstant(window.end,at('2026-10-13','02:00'))));
});
test('BSIM confirmada na madrugada ocupa a mesma capacidade compartilhada da CHG',()=>{
 const state=initial();state.demands=[demand('BSIM-NIGHT','2026-10-12','23:00','01:00','BSIM')];
 const metrics=typeCapacity(state,'2026-10-12','2026-10-18','CHG');assert.equal(metrics.confirmed,15);assert.equal(metrics.committed,2);assert.equal(metrics.free,13);assert.deepEqual(metrics.confirmedDemands,[]);
 assert.equal(metrics.daily[0].committed,1);assert.equal(metrics.daily[0].free,0);assert.equal(metrics.daily[0].canAccept,false);assert.equal(metrics.daily[1].committed,1);
 assert.ok(metrics.windows.some(window=>equalInstant(window.start,at('2026-10-13','01:00'))&&equalInstant(window.end,at('2026-10-13','02:00'))));
});
test('BSIM e TSD também descontam compromissos de todos os outros tipos',()=>{
 const state=initial();state.demands=[demand('TSD-DAY','2026-10-13','09:00','12:00','TSD','ana'),demand('CHG-NIGHT','2026-10-13','23:00','02:00')];
 const bsim=typeCapacity(state,'2026-10-13','2026-10-14','BSIM'),tsd=typeCapacity(state,'2026-10-13','2026-10-14','TSD');
 assert.equal(bsim.confirmed,80);assert.equal(bsim.committed,6);assert.equal(bsim.free,74);assert.deepEqual(bsim.confirmedDemands,[]);assert.equal(tsd.committed,6);assert.equal(tsd.confirmedDemands.length,1);
});
test('madrugada termina às 02h de Lucas e respeita os limites civis selecionados',()=>{
 const state=initial(),monday=typeCapacity(state,'2026-10-12','2026-10-12','CHG'),tuesday=typeCapacity(state,'2026-10-13','2026-10-13','CHG');
 assert.equal(monday.confirmed,1);assert.equal(monday.windows.length,1);assert.ok(equalInstant(monday.windows[0].end,at('2026-10-13','00:00')));
 assert.equal(tuesday.confirmed,3);assert.equal(tuesday.windows.length,2);assert.ok(equalInstant(tuesday.windows[0].start,at('2026-10-13','00:00')));assert.ok(equalInstant(tuesday.windows[0].end,at('2026-10-13','02:00')));
 assert.ok(!tuesday.windows.some(window=>Date.parse(window.start)<Date.parse(at('2026-10-13','23:00'))&&Date.parse(window.end)>Date.parse(at('2026-10-13','02:00'))));
});
test('diários somam a disponibilidade semanal e mantêm demanda confirmada em dia sem janela livre',()=>{
 const state=initial();state.demands=[demand('CHG-FULL','2026-10-12','23:00','02:00')];
 const metrics=typeCapacity(state,'2026-10-12','2026-10-18','CHG');assert.equal(metrics.free,12);assert.equal(metrics.daily.reduce((sum,day)=>sum+day.free,0),12);
 const monday=metrics.daily[0],tuesday=metrics.daily[1];assert.equal(monday.canAccept,false);assert.equal(monday.confirmedDemands[0].code,'CHG-FULL');assert.equal(tuesday.confirmedDemands[0].code,'CHG-FULL');assert.equal(tuesday.free,1);
});
test('reservas são exibidas separadas sem reduzir disponibilidade confirmada',()=>{
 const state=initial();const planned=demand('CHG-PLANNED','2026-10-13','23:00','02:00');planned.status='planning';state.demands=[planned];
 const metrics=typeCapacity(state,'2026-10-13','2026-10-14','CHG');assert.equal(metrics.confirmed,6);assert.equal(metrics.committed,0);assert.equal(metrics.free,6);assert.equal(metrics.reserved,3);assert.equal(metrics.pendingDemands.length,1);assert.equal(metrics.daily[0].pendingDemands[0].id,planned.id);assert.equal(metrics.daily[1].pendingDemands[0].id,planned.id);
});
test('finais de semana distinguem potencial da capacidade aprovada sem duplicar ativação semanal',()=>{
 const state=initial(),before=JSON.stringify(state),metrics=typeCapacity(state,'2026-10-17','2026-10-18','CHG');
 assert.equal(metrics.confirmed,2);assert.equal(metrics.free,2);assert.equal(metrics.potential,24);assert.equal(metrics.potentialWindows.length,4);assert.equal(metrics.potentialAlternatives.length,8);
 assert.equal(metrics.daily.reduce((sum,day)=>sum+day.potential,0),24);assert.equal(metrics.daily[1].confirmed,0);assert.equal(metrics.daily[1].canAccept,false);assert.ok(metrics.daily[1].potential>0);assert.equal(JSON.stringify(state),before);
});
test('ativação aprovada aumenta apenas sua capacidade real e reduz a quota potencial restante',()=>{
 const state=initial();state.exceptions=[{id:'extra-ana',employeeId:'ana',date:'2026-10-17',kind:'extra',startTime:'23:00',endTime:'05:00',approved:true}];
 const metrics=typeCapacity(state,'2026-10-17','2026-10-18','CHG');assert.equal(metrics.confirmed,8);assert.equal(metrics.potential,18);assert.ok(!metrics.potentialAlternatives.some(window=>window.employeeId==='ana'));assert.ok(metrics.windows.some(window=>window.employeeId==='ana'&&window.hours===6));
});
test('intervalo intrajornada, ausência e descanso são removidos das janelas produtivas',()=>{
 const state=initial();state.settings.nightStart='21:00';const original=typeCapacity(state,'2026-10-12','2026-10-18','CHG');assert.equal(original.confirmed,20); // 21–22 + 23–02, sem intervalo22–23.
 state.exceptions=[{id:'absent',employeeId:'lucas',date:'2026-10-13',kind:'absence',approved:true}];const absent=typeCapacity(state,'2026-10-13','2026-10-13','CHG');assert.equal(absent.confirmed,0);
 state.exceptions=[{id:'before',employeeId:'ana',date:'2026-10-12',kind:'override',startTime:'09:00',endTime:'12:00',approved:true},{id:'night',employeeId:'ana',date:'2026-10-12',kind:'extra',startTime:'23:00',endTime:'05:00',approved:true}];state.settings.nightStart='23:00';
 const afterNight=typeCapacity(state,'2026-10-13','2026-10-13','BSIM');const ana=afterNight.windows.filter(window=>window.employeeId==='ana');assert.ok(ana.some(window=>equalInstant(window.start,at('2026-10-13','16:00'))));assert.ok(!ana.some(window=>Date.parse(window.start)>=Date.parse(at('2026-10-13','05:00'))&&Date.parse(window.start)<Date.parse(at('2026-10-13','16:00'))));
});
test('déficit CHG mostra períodos solicitados fora da jornada noturna atendível',()=>{
 const state=initial(),request=demand('CHG-NO-CAPACITY','2026-10-17','23:00','02:00');request.status='planning';request.allocations=[];state.demands=[request];const metrics=typeCapacity(state,'2026-10-17','2026-10-18','CHG');assert.equal(metrics.deficit,3);assert.equal(metrics.daily[0].deficit,1);assert.equal(metrics.daily[1].deficit,2);
});
test('alocações múltiplas consomem horas por pessoa e sobreposição não duplica compromisso',()=>{
 const state=initial();state.employees.push({...state.employees[4],id:'night2',code:'N2'});const first=demand('TWO-PEOPLE','2026-10-13','23:00','02:00');first.required=2;first.allocations.push({...first.allocations[0],id:'second',employeeId:'night2'});state.demands=[first];
 const metrics=typeCapacity(state,'2026-10-13','2026-10-14','CHG');assert.equal(metrics.confirmed,12);assert.equal(metrics.committed,6);assert.equal(metrics.deficit,0);
 state.demands.push(demand('CONFLICT','2026-10-13','23:00','01:00','BSIM'));const conflict=typeCapacity(state,'2026-10-13','2026-10-14','CHG');assert.equal(conflict.committed,6);assert.ok(conflict.issues.some(issue=>issue.code==='OVERLAP'));
});
test('filtros não alteram estado e visão sem tipo mantém capacidade produtiva total',()=>{
 const state=initial();state.demands=[demand('DAY','2026-10-13','09:00','12:00','BSIM','ana')];const snapshot=JSON.stringify(state),all=typeCapacity(state,'2026-10-13','2026-10-14');typeCapacity(state,'2026-10-13','2026-10-14','CHG');typeCapacity(state,'2026-10-13','2026-10-14','TSD');assert.equal(all.confirmed,80);assert.equal(all.committed,3);assert.equal(all.free,77);assert.equal(JSON.stringify(state),snapshot);assert.equal(all.daily.reduce((sum,day)=>sum+day.committed,0),3);
});
test('reserva sobreposta a compromisso de outro tipo mantém déficit mesmo com outras janelas livres',()=>{
 const state=initial(),busy=demand('BSIM-BUSY','2026-10-13','23:00','02:00','BSIM'),pending=demand('CHG-RESERVED','2026-10-13','23:00','02:00');pending.status='planning';state.demands=[busy,pending];
 const metrics=typeCapacity(state,'2026-10-13','2026-10-14','CHG');assert.equal(metrics.committed,3);assert.equal(metrics.reserved,3);assert.equal(metrics.deficit,3);assert.equal(metrics.free,3);assert.equal(metrics.canAccept,true);
 pending.allocations=[];const unallocated=typeCapacity(state,'2026-10-13','2026-10-14','CHG');assert.equal(unallocated.deficit,3);assert.equal(unallocated.canAccept,true);
});
test('potencial combinado respeita limite semanal de horas quando duas ativações são permitidas',()=>{
 const state=initial();state.employees=[{...daytime('extra'),weekdays:[],weeklyHours:0,weeklyLimit:8,maxExtraNights:2}];
 const metrics=typeCapacity(state,'2026-10-15','2026-10-16','CHG');assert.equal(metrics.confirmed,0);assert.equal(metrics.potential,6);assert.equal(metrics.potentialWindows.length,1);assert.equal(capacity(state,'2026-10-15','2026-10-16').potential,6);
});
test('potencial combinado não viola descanso parametrizado entre noites extraordinárias',()=>{
 const state=initial();state.employees=[{...daytime('extra'),weekdays:[],weeklyHours:0,weeklyLimit:168,maxExtraNights:7}];state.settings.restHours=24;
 const metrics=typeCapacity(state,'2026-10-17','2026-10-18','CHG');assert.equal(metrics.potential,6);assert.equal(metrics.potentialWindows.length,1);assert.equal(capacity(state,'2026-10-17','2026-10-18').potential,6);
});
test('início de semana configurável determina a quota extraordinária de domingo',()=>{
 const state=initial();state.employees=[{...daytime('extra'),weekdays:[],weeklyHours:0}];state.exceptions=[{id:'approved',employeeId:'extra',date:'2026-10-17',kind:'extra',startTime:'23:00',endTime:'05:00',approved:true}];
 assert.equal(typeCapacity(state,'2026-10-18','2026-10-18','CHG').potential,0);state.settings.weekStartsOn=0;const sunday=typeCapacity(state,'2026-10-18','2026-10-18','CHG');assert.equal(sunday.confirmed,5);assert.equal(sunday.potential,1);assert.equal(sunday.potentialWindows[0].week,'2026-10-18');
});
test('dia CHG sem capacidade explica bloqueio de outro tipo sem incluir BSIM fora da janela',()=>{
 const state=initial(),night=demand('BSIM-BLOCKS-CHG','2026-10-12','23:00','02:00','BSIM'),day=demand('BSIM-DAY','2026-10-12','09:00','12:00','BSIM','ana'),evening=demand('BSIM-EVENING','2026-10-12','17:00','22:00','BSIM');state.demands=[night,day,evening];
 const metrics=typeCapacity(state,'2026-10-12','2026-10-13','CHG');assert.deepEqual(metrics.confirmedDemands,[]);assert.deepEqual(metrics.blockingDemands.map(demand=>demand.id),[night.id]);
 const monday=metrics.daily[0],tuesday=metrics.daily[1];assert.equal(monday.free,0);assert.equal(monday.canAccept,false);assert.deepEqual(monday.confirmedDemands,[]);assert.deepEqual(monday.blockingDemands.map(demand=>demand.code),['BSIM-BLOCKS-CHG']);assert.deepEqual(tuesday.blockingDemands.map(demand=>demand.code),['BSIM-BLOCKS-CHG']);
 const all=typeCapacity(state,'2026-10-12','2026-10-13');assert.deepEqual(all.blockingDemands,[]);assert.ok(all.daily.every(day=>day.blockingDemands.length===0));
});
test('reservas de outro tipo não são listadas como bloqueios confirmados',()=>{
 const state=initial(),planned=demand('PLANNED-BSIM','2026-10-12','23:00','02:00','BSIM');planned.status='planning';state.demands=[planned];const metrics=typeCapacity(state,'2026-10-12','2026-10-13','CHG');assert.equal(metrics.reserved,3);assert.equal(metrics.committed,0);assert.deepEqual(metrics.blockingDemands,[]);assert.ok(metrics.daily.every(day=>day.blockingDemands.length===0));
});
test('alocar em planejamento reserva horas; confirmar transfere imediatamente para comprometidas',()=>{
 const state=initial();state.employees=[daytime('ana')];const planned=demand('ALLOCATION-LIFECYCLE','2026-10-13','09:00','12:00','BSIM','ana');planned.status='planning';planned.allocations=[];state.demands=[planned];
 const initialMetrics=typeCapacity(state,'2026-10-13','2026-10-13');assert.equal(initialMetrics.confirmed,8);assert.equal(initialMetrics.committed,0);assert.equal(initialMetrics.free,8);assert.equal(initialMetrics.reserved,0);
 // Reproduce adding a person to the form's default status, without confirming.
 planned.allocations=[{id:'allocation',employeeId:'ana',start:planned.start,end:planned.end}];
 for(const calculate of [capacity,typeCapacity]){const reserved=calculate(state,'2026-10-13','2026-10-13');assert.equal(reserved.committed,0);assert.equal(reserved.free,8);assert.equal(reserved.reserved,3);}
 // The same state object is intentional: warmed shift caches cannot hide the
 // newly confirmed allocation, even without a revision or object replacement.
 planned.status='confirmed';
 for(const calculate of [capacity,typeCapacity]){const confirmed=calculate(state,'2026-10-13','2026-10-13');assert.equal(confirmed.confirmed,8);assert.equal(confirmed.committed,3);assert.equal(confirmed.free,5);assert.equal(confirmed.reserved,0);assert.equal(confirmed.daily[0].committed,3);}
});
test('remanejar, executar e cancelar atualiza compromisso real sem manter horas antigas em cache',()=>{
 const state=initial();state.employees=[daytime('ana')];const booked=demand('BOOKING-EDIT','2026-10-13','09:00','12:00','TSD','ana');state.demands=[booked];
 assert.equal(typeCapacity(state,'2026-10-13','2026-10-13').committed,3);assert.equal(capacity(state,'2026-10-13','2026-10-13').committed,3);
 booked.start=at('2026-10-13','13:00');booked.end=at('2026-10-13','15:00');booked.allocations[0].start=booked.start;booked.allocations[0].end=booked.end;
 for(const status of ['confirmed','running','completed'] as const){booked.status=status;for(const calculate of [capacity,typeCapacity]){const updated=calculate(state,'2026-10-13','2026-10-13');assert.equal(updated.committed,2);assert.equal(updated.free,6);assert.equal(updated.reserved,0);}}
 booked.status='cancelled';for(const calculate of [capacity,typeCapacity]){const cancelled=calculate(state,'2026-10-13','2026-10-13');assert.equal(cancelled.committed,0);assert.equal(cancelled.free,8);assert.equal(cancelled.reserved,0);}
});
test('snapshot salvo com segundo colaborador conta pessoa-hora sem contaminar snapshot anterior',()=>{
 const original=initial();original.employees=[daytime('ana'),daytime('bruno')];const booked=demand('MULTIPLE-SAVED','2026-10-13','09:00','12:00','BSIM','ana');original.demands=[booked];
 assert.equal(capacity(original,'2026-10-13','2026-10-13').committed,3);assert.equal(typeCapacity(original,'2026-10-13','2026-10-13').committed,3);
 const saved:State={...original,revision:(original.revision||0)+1,demands:[{...booked,required:2,allocations:[...booked.allocations,{...booked.allocations[0],id:'second',employeeId:'bruno'}]}]};
 for(const calculate of [capacity,typeCapacity]){const metrics=calculate(saved,'2026-10-13','2026-10-13');assert.equal(metrics.committed,6);assert.equal(metrics.free,10);assert.equal(calculate(original,'2026-10-13','2026-10-13').committed,3);}
});
test('confirmar BSIM noturna atualiza CHG compartilhada em ambos os dias sem contar horas diurnas',()=>{
 const state=initial();state.employees=[{...state.employees[4],weekdays:[2]}];const booked=demand('NIGHT-CONFIRM','2026-10-13','23:00','02:00','BSIM');booked.status='planning';state.demands=[booked];
 const before=typeCapacity(state,'2026-10-13','2026-10-14','CHG');assert.equal(before.confirmed,3);assert.equal(before.free,3);assert.equal(before.committed,0);assert.equal(before.reserved,3);
 booked.status='confirmed';const confirmed=typeCapacity(state,'2026-10-13','2026-10-14','CHG');assert.equal(confirmed.confirmed,3);assert.equal(confirmed.free,0);assert.equal(confirmed.committed,3);assert.equal(confirmed.reserved,0);assert.equal(confirmed.daily[0].committed,1);assert.equal(confirmed.daily[1].committed,2);assert.equal(confirmed.blockingDemands[0].id,booked.id);assert.deepEqual(confirmed.confirmedDemands,[]);
 const overall=capacity(state,'2026-10-13','2026-10-14');assert.equal(overall.confirmed,8);assert.equal(overall.committed,3);assert.equal(overall.free,5);
});
function sixHourNight():State {const state=initial();state.employees[4]={...state.employees[4],startTime:'23:00',endTime:'05:00',breaks:[],weeklyHours:30};return state;}
test('planejamento CHG semanal soma 30h regulares e quota24h uma única vez, sem aprovar extras',()=>{
 const state=sixHourNight(),snapshot=JSON.stringify(state),metrics=typeCapacity(state,'2026-10-12','2026-10-18','CHG');
 assert.equal(metrics.confirmed,30);assert.equal(metrics.planningTotal,54);assert.equal(metrics.planningFree,54);assert.deepEqual(metrics.weeklyPlanning,[{weekStart:'2026-10-12',weekEnd:'2026-10-18',regular:30,extraQuota:24,extraActivated:0,extraQuotaRemaining:24,total:54,committed:0,free:54}]);
 assert.equal(metrics.daily.reduce((sum,day)=>sum+day.confirmed,0),30);assert.equal(metrics.daily[6].confirmed,0);assert.equal(JSON.stringify(state),snapshot);
 assert.equal(getAvailability(state,'ana',at('2026-10-14','23:00'),at('2026-10-15','05:00')).available,false);
 assert.ok(validateException(state,{id:'not-approved-by-budget',employeeId:'ana',date:'2026-10-14',kind:'extra',startTime:'23:00',endTime:'05:00',approved:true}).some(issue=>issue.code==='MIN_REST'));
});
test('aprovar extra aumenta agenda real30→36h, consome token6h e não altera totalplanejável54h',()=>{
 const state=sixHourNight();state.exceptions=[{id:'before',employeeId:'ana',date:'2026-10-14',kind:'override',startTime:'09:00',endTime:'12:00',approved:true},{id:'night',employeeId:'ana',date:'2026-10-14',kind:'extra',startTime:'23:00',endTime:'05:00',approved:true}];state.demands=[demand('EXTRA-COMMITTED','2026-10-14','23:00','05:00','CHG','ana')];
 const metrics=typeCapacity(state,'2026-10-12','2026-10-18','CHG'),week=metrics.weeklyPlanning[0];assert.equal(metrics.confirmed,36);assert.equal(metrics.committed,6);assert.equal(week.regular,30);assert.equal(week.extraQuota,24);assert.equal(week.extraActivated,6);assert.equal(week.extraQuotaRemaining,18);assert.equal(week.total,54);assert.equal(week.free,48);assert.equal(metrics.planningFree,48);
 assert.equal(getAvailability(state,'ana',at('2026-10-15','09:00'),at('2026-10-15','10:00')).available,false);assert.equal(getAvailability(state,'ana',at('2026-10-15','16:00'),at('2026-10-15','18:00')).available,true);
});
test('várias demandas e ativação parcial3h consomem um único token semanal6h',()=>{
 const state=sixHourNight();state.exceptions=[{id:'partial-night',employeeId:'ana',date:'2026-10-17',kind:'extra',startTime:'23:00',endTime:'02:00',approved:true}];state.demands=[demand('PART1','2026-10-17','23:00','00:00','CHG','ana'),demand('PART2','2026-10-18','00:00','02:00','CHG','ana')];
 const metrics=typeCapacity(state,'2026-10-12','2026-10-18','CHG'),week=metrics.weeklyPlanning[0];assert.equal(metrics.confirmed,33);assert.equal(week.extraActivated,6);assert.equal(week.extraQuotaRemaining,18);assert.equal(week.committed,3);assert.equal(week.total,54);assert.equal(week.free,51);
});
test('noite extraordinária de domingo conta6h na semana de início, sem5h duplicadas na seguinte',()=>{
 const state=sixHourNight();state.exceptions=[{id:'sunday',employeeId:'ana',date:'2026-10-18',kind:'extra',startTime:'23:00',endTime:'05:00',approved:true}];state.demands=[demand('SUNDAY-WORK','2026-10-18','23:00','05:00','CHG','ana')];
 const metrics=typeCapacity(state,'2026-10-18','2026-10-19','CHG');assert.equal(metrics.weeklyPlanning.length,2);assert.equal(metrics.weeklyPlanning[0].committed,6);assert.equal(metrics.weeklyPlanning[0].extraActivated,6);assert.equal(metrics.weeklyPlanning[1].committed,0);assert.equal(metrics.weeklyPlanning[1].extraActivated,0);assert.equal(metrics.planningTotal,108);assert.equal(metrics.planningFree,102);
 // Date-specific reporting remains civil: Sunday1h + Monday5h, never rewritten.
 assert.equal(metrics.daily[0].committed,1);assert.equal(metrics.daily[1].committed,5);assert.equal(metrics.committed,6);
});
test('períodos parciais retornam resumo da semana completa; outros tipos não recebem quotaCHG',()=>{
 const state=sixHourNight(),day=typeCapacity(state,'2026-10-13','2026-10-13','CHG');assert.equal(day.confirmed,6);assert.equal(day.planningTotal,54);assert.equal(day.weeklyPlanning[0].weekStart,'2026-10-12');assert.equal(day.weeklyPlanning[0].weekEnd,'2026-10-18');
 const twoWeeks=typeCapacity(state,'2026-10-12','2026-10-25','CHG');assert.equal(twoWeeks.weeklyPlanning.length,2);assert.equal(twoWeeks.planningTotal,108);const bsim=typeCapacity(state,'2026-10-12','2026-10-18','BSIM');assert.deepEqual(bsim.weeklyPlanning,[]);assert.equal(bsim.planningTotal,0);
});
test('orçamento semanal deriva de horários, elegibilidade, cotas, situação e exceções, sem constante54',()=>{
 const state=sixHourNight();state.employees[0].maxExtraNights=2;state.employees[1].active=false;state.employees[2].eligibleNight=false;state.exceptions=[{id:'short-regular',employeeId:'lucas',date:'2026-10-14',kind:'override',startTime:'23:00',endTime:'02:00',approved:true}];
 const week=weeklyNightPlanning(state,'2026-10-12','2026-10-18')[0];assert.equal(week.regular,27);assert.equal(week.extraQuota,18);assert.equal(week.total,45);
 state.settings.nightStart='00:00';state.settings.nightEnd='03:00';const shorter=weeklyNightPlanning(state,'2026-10-12','2026-10-18')[0];assert.equal(shorter.regular,14);assert.equal(shorter.extraQuota,9);assert.equal(shorter.total,23);
});
test('02h–05h dentro da mesma jornada23h–05h não cria falso descanso entre demandas adjacentes',()=>{
 const state=sixHourNight();state.demands=[demand('FIRST-HALF','2026-10-13','23:00','02:00')];const continuation=demand('SECOND-HALF','2026-10-14','02:00','05:00');assert.deepEqual(validateDemand(state,continuation),[]);
 const old=initial();old.demands=[demand('FIRST-HALF','2026-10-13','23:00','02:00')];const oldIssues=validateDemand(old,continuation);assert.ok(oldIssues.some(issue=>issue.code==='OUTSIDE_SHIFT'));assert.ok(oldIssues.some(issue=>issue.code==='MIN_REST')); // old journey actually ended02h.
});
