import type { Demand, DemandType, Employee, Interval, Issue, ShiftException, State } from './types.ts';
// @ts-ignore -- explicit extension also supports Node's built-in TypeScript test runner.
import { addDays, dateAt, hours, weekStart, zoned } from './time.ts';

export interface Shift { id:string; employeeId:string; date:string; start:string; end:string; extra:boolean; breaks:Interval[]; }
export interface CalendarCell { employeeId:string; date:string; hour:number; status:'free'|'off'|'rest'|'potential'|'absence'|'BSIM'|'TSD'|'CHG'|'reservation'|'conflict'; demandId?:string; label:string; returnAt?:string; }
type Span = { start:number; end:number };
const H = 3600000;
const committedStatuses = new Set(['confirmed', 'running', 'completed']);
const blockedKinds = new Set(['off', 'vacation', 'absence', 'holiday']);
const n = (value:string) => Date.parse(value);
const iso = (value:number) => new Date(value).toISOString();
const span = (value:Interval):Span => ({ start:n(value.start), end:n(value.end) });
const overlaps = (a:Span,b:Span) => a.start < b.end && b.start < a.end;
const intersection = (a:Span,b:Span):Span => ({start:Math.max(a.start,b.start),end:Math.min(a.end,b.end)});
const good = (a:Span) => Number.isFinite(a.start) && Number.isFinite(a.end) && a.end > a.start;
const round = (value:number) => Math.round(value * 100) / 100;
const tz = (state:State) => state.settings.timezone || 'America/Sao_Paulo';
const humanFormatters=new Map<string,Intl.DateTimeFormat>();
function humanTime(state:State,value:string|number):string {let formatter=humanFormatters.get(tz(state));if(!formatter){formatter=new Intl.DateTimeFormat('pt-BR',{timeZone:tz(state),day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});humanFormatters.set(tz(state),formatter);}return formatter.format(new Date(typeof value==='number'?value:n(value)));}
const civilTimes=new Map<string,string>(),nightTests=new Map<string,boolean>();
function civil(state:State,date:string,time:string):string {const key=`${tz(state)}|${date}|${time}`;let value=civilTimes.get(key);if(!value){value=zoned(date,time,tz(state));if(civilTimes.size>20000)civilTimes.clear();civilTimes.set(key,value);}return value;}
type ScheduleCache = { signature:string; raw:Map<string,Shift[]>; shifts:Map<string,Shift[]>; work:Map<string,Span[]>; weekly:Map<string,number> };
const scheduleCaches=new WeakMap<State,ScheduleCache>();
const potentialCaches=new WeakMap<State,{signature:string;values:Map<string,{employee:Employee;date:string;interval:Interval}[]>}>();
const selectedPotentialCaches=new WeakMap<State,{signature:string;values:Map<string,PotentialCapacityWindow[]>}>();
function cacheFor(state:State):ScheduleCache {
 const signature=JSON.stringify([state.employees,state.exceptions,state.settings]);
 let cache=scheduleCaches.get(state);
 if(!cache||cache.signature!==signature){cache={signature,raw:new Map(),shifts:new Map(),work:new Map(),weekly:new Map()};scheduleCaches.set(state,cache);}
 return cache;
}
function dates(from:string,to:string):string[] { const result:string[]=[]; for(let d=from;d<=to;d=addDays(d,1)) {result.push(d);if(result.length>1100)throw new Error('Período máximo de consulta: 1.100 dias.');} return result; }
function range(state:State,from:string,to:string):Span {return {start:n(civil(state,from,'00:00')),end:n(civil(state,addDays(to,1),'00:00'))};}
function windowFor(state:State,date:string,startTime:string,endTime:string):Interval { return { start:civil(state,date,startTime),end:civil(state,endTime<=startTime?addDays(date,1):date,endTime) }; }
function union(intervals:Span[]):Span[] {const out:Span[]=[];for(const item of intervals.filter(good).sort((a,b)=>a.start-b.start)){const last=out[out.length-1];if(last&&item.start<=last.end)last.end=Math.max(last.end,item.end);else out.push({...item});}return out;}
function subtract(intervals:Span[],blocked:Span[]):Span[] {let result=intervals.filter(good);for(const block of union(blocked)){result=result.flatMap(item=>!overlaps(item,block)?[item]:[{start:item.start,end:Math.min(item.end,block.start)},{start:Math.max(item.start,block.end),end:item.end}].filter(good));}return result;}
const total = (intervals:Span[]) => union(intervals).reduce((sum,x)=>sum+(x.end-x.start)/H,0);
const issue = (code:string,message:string,employeeId?:string):Issue => ({code,message,...(employeeId?{employeeId}:{})});
function uniqueIssues(issues:Issue[]):Issue[] {const seen=new Set<string>();return issues.filter(x=>{const key=`${x.code}:${x.employeeId}:${x.message}`;if(seen.has(key))return false;seen.add(key);return true;});}
function isNight(state:State,s:Interval):boolean {const key=`${tz(state)}|${state.settings.nightStart}|${state.settings.nightEnd}|${s.start}|${s.end}`,cached=nightTests.get(key);if(cached!==undefined)return cached;const a=dateAt(s.start,tz(state)),value=[addDays(a,-1),a].some(d=>overlaps(span(s),span(windowFor(state,d,state.settings.nightStart,state.settings.nightEnd))));if(nightTests.size>20000)nightTests.clear();nightTests.set(key,value);return value;}
function absenceWindows(state:State,employeeId:string):Span[] {return state.exceptions.filter(x=>x.approved&&x.employeeId===employeeId&&blockedKinds.has(x.kind)).map(x=>range(state,x.date,x.date));}
function rawShifts(state:State,from:string,to:string):Shift[] {
 const cache=cacheFor(state),key=`${from}:${to}`,cached=cache.raw.get(key);if(cached)return cached;
 const result:Shift[]=[];
 for(const employee of state.employees.filter(e=>e.active))for(const date of dates(from,to)){
  const exceptions=state.exceptions.filter(x=>x.approved&&x.employeeId===employee.id&&x.date===date);
  if(exceptions.some(x=>blockedKinds.has(x.kind)))continue;
  const overrides=exceptions.filter(x=>x.kind==='override');
  const weekday=new Date(`${date}T12:00:00Z`).getUTCDay()||7;
  const specs:{id:string;startTime:string;endTime:string;extra:boolean;useBreaks:boolean}[]=[];
  if(overrides.length)for(const x of overrides)specs.push({id:x.id,startTime:x.startTime||employee.startTime,endTime:x.endTime||employee.endTime,extra:false,useBreaks:true});
  else if(employee.weekdays.includes(weekday))specs.push({id:`regular:${employee.id}:${date}`,startTime:employee.startTime,endTime:employee.endTime,extra:false,useBreaks:true});
  for(const x of exceptions.filter(x=>x.kind==='extra'))specs.push({id:x.id,startTime:x.startTime||state.settings.nightStart,endTime:x.endTime||state.settings.nightEnd,extra:true,useBreaks:false});
  for(const spec of specs){
   if(spec.startTime===spec.endTime)continue;
   const value=windowFor(state,date,spec.startTime,spec.endTime);
   const breaks:Interval[]=[];
   if(spec.useBreaks)for(const b of employee.breaks){let bdate=b.start<spec.startTime&&spec.endTime<=spec.startTime?addDays(date,1):date;const valueB=windowFor(state,bdate,b.start,b.end);if(overlaps(span(value),span(valueB)))breaks.push(valueB);}
   // Recurring custom/night journeys are regular capacity. A date override that
   // moves an ordinary daytime journey into the night is an extra activation.
   const movedToNight=overrides.length>0&&!isNight(state,windowFor(state,date,employee.startTime,employee.endTime))&&isNight(state,value);
   result.push({id:spec.id,employeeId:employee.id,date,...value,extra:spec.extra||movedToNight,breaks});
  }
 }
 result.sort((a,b)=>n(a.start)-n(b.start));cache.raw.set(key,result);return result;
}
/** Validate the recurring configuration itself, independent of existing demands
 * and date exceptions. Neighbouring weeks cover Sunday/Monday rest boundaries. */
export function validateRecurringSchedule(state:State,employeeId?:string):Issue[] {
 const employees=state.employees.filter(e=>e.active&&(!employeeId||e.id===employeeId)),issues:Issue[]=[];
 const base:State={...state,employees,exceptions:[],demands:[]};
 const begin=weekStart('2026-10-12',state.settings.weekStartsOn),end=addDays(begin,6),bounds=range(state,begin,end);
 let raw:Shift[];
 try{raw=rawShifts(base,addDays(begin,-7),addDays(end,7));}catch{return [issue('INVALID_INTERVAL','A configuração recorrente contém data, horário ou fuso inválido.',employeeId)];}
 for(const employee of employees){
  if(employee.startTime===employee.endTime){issues.push(issue('INVALID_INTERVAL',`${employee.name}: início e término da jornada devem ser diferentes.`,employee.id));continue;}
  const own=raw.filter(s=>s.employeeId===employee.id).sort((a,b)=>n(a.start)-n(b.start));
  for(let index=1;index<own.length;index++){
   const current=own[index],previous=own[index-1];if(current.date<begin||current.date>end)continue;
   const gap=n(current.start)-n(previous.end);
   if(gap<0){issues.push(issue('OVERLAP',`${employee.name}: a jornada recorrente se sobrepõe à anterior.`,employee.id));break;}
   if(gap<state.settings.restHours*H){issues.push(issue('MIN_REST',`${employee.name}: a escala recorrente permite apenas ${round(gap/H)}h entre jornadas; mínimo de ${state.settings.restHours}h. Ajuste os horários ou dias trabalhados.`,employee.id));break;}
  }
  const scheduled=total(own.flatMap(s=>productive(base,s)).map(s=>intersection(s,bounds)));
  if(scheduled>employee.weeklyLimit+0.00001)issues.push(issue('WEEKLY_HOURS',`${employee.name}: a escala recorrente prevê ${round(scheduled)}h produtivas por semana, acima do limite de ${employee.weeklyLimit}h.`,employee.id));
 }
 return uniqueIssues(issues);
}
/** Returns approved shifts intersecting the inclusive civil-date range. */
export function getShifts(state:State,fromDate:string,toDate:string):Shift[] {
 const cache=cacheFor(state),key=`${fromDate}:${toDate}`,cached=cache.shifts.get(key);if(cached)return cached;
 const bounds=range(state,fromDate,toDate);
 const lookback=Math.max(3,Math.ceil(state.settings.restHours/24)+2);
 const raw=rawShifts(state,addDays(fromDate,-lookback),addDays(toDate,1));
 const nights=raw.filter(s=>isNight(state,s));
 const result=raw.map(shift=>{
  let start=n(shift.start);
  if(!isNight(state,shift))for(const previous of nights){if(previous.employeeId===shift.employeeId&&previous.id!==shift.id&&n(previous.start)<start&&n(previous.end)<=n(shift.end)){start=Math.max(start,n(previous.end)+state.settings.restHours*H);}}
  return {...shift,start:iso(start)};
 }).filter(s=>good(span(s))&&overlaps(span(s),bounds));
 cache.shifts.set(key,result);return result;
}
function productive(state:State,s:Shift):Span[] {return subtract([span(s)],[...s.breaks.map(span),...absenceWindows(state,s.employeeId)]);}
function workIntervals(state:State,employeeId:string,bounds:Span):Span[] {
 const cache=cacheFor(state),key=`${employeeId}:${bounds.start}:${bounds.end}`,cached=cache.work.get(key);if(cached)return cached;
 const from=dateAt(iso(bounds.start),tz(state)),to=dateAt(iso(bounds.end-1),tz(state));
 const result=union(getShifts(state,from,to).filter(s=>s.employeeId===employeeId).flatMap(s=>productive(state,s)).map(x=>intersection(x,bounds)));cache.work.set(key,result);return result;
}
function activations(state:State,employeeId:string,date:string):Set<string> {
 const begin=weekStart(date,state.settings.weekStartsOn),end=addDays(begin,6);
 return new Set(rawShifts(state,begin,end).filter(s=>s.employeeId===employeeId&&s.extra&&isNight(state,s)).map(s=>s.date));
}
function shiftIssues(state:State,shift:Shift,all:Shift[]):Issue[] {
 const employee=state.employees.find(e=>e.id===shift.employeeId);
 if(!employee)return [issue('UNKNOWN_EMPLOYEE','Colaborador não encontrado.',shift.employeeId)];
 const issues:Issue[]=[];
 if(shift.extra){
  if(!employee.eligibleNight)issues.push(issue('INELIGIBLE_EXTRA',`${employee.name} não é elegível para escala extraordinária.`,employee.id));
  if(activations(state,employee.id,shift.date).size>employee.maxExtraNights)issues.push(issue('WEEKLY_EXTRA_LIMIT',`${employee.name}: limite de ${employee.maxExtraNights} atuação(ões) extraordinária(s) na semana excedido.`,employee.id));
 }
 // Two assignments inside the same shift are one journey. Rest applies between shifts.
 for(const other of all.filter(s=>s.employeeId===shift.employeeId&&s.id!==shift.id)){
  if(overlaps(span(shift),span(other))){issues.push(issue('OVERLAP',`${employee.name}: escalas se sobrepõem.`,employee.id));continue;}
  const gap=n(other.end)<=n(shift.start)?n(shift.start)-n(other.end):n(other.start)-n(shift.end);
  if(gap>=0&&gap<state.settings.restHours*H)issues.push(issue('MIN_REST',`${employee.name}: descanso de ${round(gap/H)}h entre jornadas; mínimo de ${state.settings.restHours}h. Retorno permitido: ${humanTime(state,(n(other.end)<=n(shift.start)?n(other.end):n(shift.end))+state.settings.restHours*H)}.`,employee.id));
 }
 const week=weekStart(shift.date,state.settings.weekStartsOn),weekBounds=range(state,week,addDays(week,6));
 const cache=cacheFor(state),weeklyKey=`${employee.id}:${week}`;
 const scheduled=cache.weekly.get(weeklyKey)??total(getShifts(state,week,addDays(week,6)).filter(s=>s.employeeId===employee.id).flatMap(s=>productive(state,s)).map(s=>intersection(s,weekBounds)));
 cache.weekly.set(weeklyKey,scheduled);
 if(scheduled>employee.weeklyLimit+0.00001)issues.push(issue('WEEKLY_HOURS',`${employee.name}: ${round(scheduled)}h previstas excedem o limite semanal de ${employee.weeklyLimit}h.`,employee.id));
 return uniqueIssues(issues);
}
export function getAvailability(state:State,employeeId:string,start:string,end:string):{available:boolean;issues:Issue[];requiresExtra:boolean;returnAt?:string} {
 const employee=state.employees.find(e=>e.id===employeeId),requested=span({start,end});
 const issues:Issue[]=[];
 if(!good(requested))return {available:false,issues:[issue('INVALID_INTERVAL','O término deve ser posterior ao início.',employeeId)],requiresExtra:false};
 if(!employee||!employee.active)return {available:false,issues:[issue('INACTIVE','Colaborador inexistente ou inativo.',employeeId)],requiresExtra:false};
 const startDate=dateAt(start,tz(state)),endDate=dateAt(iso(requested.end-1),tz(state));
 const padding=Math.max(3,Math.ceil(state.settings.restHours/24)+2);
 const all=getShifts(state,addDays(startDate,-padding),addDays(endDate,padding)).filter(s=>s.employeeId===employeeId);
 const covering=all.filter(s=>productive(state,s).some(x=>overlaps(x,requested)));
 let returnAt:string|undefined;
 for(const previous of all.filter(s=>isNight(state,s))){const rest={start:n(previous.end),end:n(previous.end)+state.settings.restHours*H};if(overlaps(rest,requested)){returnAt=iso(Math.max(n(returnAt||previous.end),rest.end));issues.push(issue('MIN_REST',`${employee.name}: descanso obrigatório até ${humanTime(state,returnAt)}.`,employeeId));}}
 if(absenceWindows(state,employeeId).some(x=>overlaps(x,requested)))issues.push(issue('ABSENCE',`${employee.name}: folga, férias, feriado ou ausência no período.`,employeeId));
 if(total(workIntervals(state,employeeId,requested))+0.00001<(requested.end-requested.start)/H)issues.push(issue('OUTSIDE_SHIFT',`${employee.name}: período fora da escala aprovada ou dentro de intervalo.`,employeeId));
 for(const s of covering)issues.push(...shiftIssues(state,s,all));
 for(const demand of state.demands.filter(d=>committedStatuses.has(d.status)))for(const allocation of demand.allocations.filter(a=>a.employeeId===employeeId)){if(overlaps(requested,span(allocation)))issues.push(issue('OVERLAP',`${employee.name}: conflito com ${demand.code}.`,employeeId));}
 return {available:issues.length===0,issues:uniqueIssues(issues),requiresExtra:covering.length===0&&employee.eligibleNight&&isNight(state,{start,end}),...(returnAt?{returnAt}:{})};
}
function nightWindowContains(state:State,start:string,end:string):boolean {
 const d=dateAt(start,tz(state)),requested=span({start,end});
 return [addDays(d,-1),d].some(date=>{const w=span(windowFor(state,date,state.settings.nightStart,state.settings.nightEnd));return requested.start>=w.start&&requested.end<=w.end;});
}
function uncoveredHours(demand:Demand,bounds?:Span):number {
 let interval=span(demand);if(bounds)interval=intersection(interval,bounds);if(!good(interval))return 0;
 const employeeIntervals=new Map<string,Span[]>();
 for(const a of demand.allocations){const entries=employeeIntervals.get(a.employeeId)||[];entries.push(intersection(span(a),interval));employeeIntervals.set(a.employeeId,entries);}
 const events:{at:number;delta:number}[]=[{at:interval.start,delta:0},{at:interval.end,delta:0}];
 for(const items of employeeIntervals.values())for(const a of union(items)){events.push({at:a.start,delta:1},{at:a.end,delta:-1});}
 events.sort((a,b)=>a.at-b.at);
 let active=0,previous=interval.start,deficit=0;
 for(const event of events){deficit+=Math.max(0,demand.required-active)*(event.at-previous)/H;active+=event.delta;previous=event.at;}
 return deficit;
}
export function validateDemand(state:State,demand:Demand,excludeId?:string):Issue[] {
 const issues:Issue[]=[];
 if(!good(span(demand)))return [issue('INVALID_INTERVAL','O término da demanda deve ser posterior ao início.')];
 if(!Number.isInteger(demand.required)||demand.required<1)issues.push(issue('INVALID_REQUIRED','Informe ao menos um colaborador necessário.'));
 if(demand.type==='CHG'&&!nightWindowContains(state,demand.start,demand.end))issues.push(issue('CHG_WINDOW',`CHG deve ocorrer integralmente entre ${state.settings.nightStart} e ${state.settings.nightEnd}.`));
 const clean={...state,demands:state.demands.filter(d=>d.id!==(excludeId||demand.id))};
 for(const a of demand.allocations){
  if(!good(span(a))){issues.push(issue('INVALID_INTERVAL','Alocação com intervalo inválido.',a.employeeId));continue;}
  if(n(a.start)<n(demand.start)||n(a.end)>n(demand.end))issues.push(issue('OUTSIDE_DEMAND','A alocação deve estar dentro do período da demanda.',a.employeeId));
  issues.push(...getAvailability(clean,a.employeeId,a.start,a.end).issues);
  if(demand.allocations.some(b=>b.id!==a.id&&b.employeeId===a.employeeId&&overlaps(span(a),span(b))))issues.push(issue('OVERLAP','O mesmo colaborador possui alocações sobrepostas nesta demanda.',a.employeeId));
 }
 if(committedStatuses.has(demand.status)&&uncoveredHours(demand)>0.00001)issues.push(issue('UNDERSTAFFED',`Demanda sem capacidade confirmada: faltam ${round(uncoveredHours(demand))} pessoa-hora de alocação.`));
 return uniqueIssues(issues);
}
export function validateException(state:State,exception:ShiftException,excludeId?:string):Issue[] {
 if(!state.employees.some(e=>e.id===exception.employeeId&&e.active))return [issue('INACTIVE','Colaborador inexistente ou inativo.',exception.employeeId)];
 try {range(state,exception.date,exception.date);if(['extra','override'].includes(exception.kind)&&exception.startTime&&exception.endTime&&exception.startTime===exception.endTime)return [issue('INVALID_INTERVAL','A escala deve ter início e término diferentes.',exception.employeeId)];}catch{return [issue('INVALID_INTERVAL','Data ou horário de escala inválido.',exception.employeeId)];}
 const next={...state,exceptions:[...state.exceptions.filter(x=>x.id!==(excludeId||exception.id)),exception]};
 const issues:Issue[]=[];
 if(exception.approved){
  let shifts:Shift[];
  try{shifts=getShifts(next,addDays(exception.date,-3),addDays(exception.date,3));}catch{return [issue('INVALID_INTERVAL','Data ou horário de escala inválido.',exception.employeeId)];}
  for(const s of shifts.filter(s=>s.id===exception.id))issues.push(...shiftIssues(next,s,shifts));
  const window=range(state,addDays(exception.date,-1),addDays(exception.date,2));
  for(const demand of next.demands.filter(d=>committedStatuses.has(d.status)&&overlaps(span(d),window)&&d.allocations.some(a=>a.employeeId===exception.employeeId))){issues.push(...validateDemand(next,demand).filter(i=>i.employeeId===exception.employeeId));}
 }
 return uniqueIssues(issues);
}
function potentialWindows(state:State,from:string,to:string):{employee:Employee;date:string;interval:Interval}[] {
 const signature=JSON.stringify([state.employees,state.exceptions,state.settings,state.demands]);
 let cache=potentialCaches.get(state);if(!cache||cache.signature!==signature){cache={signature,values:new Map()};potentialCaches.set(state,cache);}
 const key=`${from}:${to}`,cached=cache.values.get(key);if(cached)return cached;
 const result:{employee:Employee;date:string;interval:Interval}[]=[];
 for(const employee of state.employees.filter(e=>e.active&&e.eligibleNight&&e.maxExtraNights>0)){
  const own:State={...state,employees:[employee],exceptions:state.exceptions.filter(e=>e.employeeId===employee.id),demands:state.demands.filter(d=>d.allocations.some(a=>a.employeeId===employee.id)).map(d=>({...d,allocations:d.allocations.filter(a=>a.employeeId===employee.id)}))};
  const padding=Math.max(3,Math.ceil(state.settings.restHours/24)+2),existing=getShifts(own,addDays(from,-padding),addDays(to,padding));
  for(const date of dates(addDays(from,-1),to)){
  const used=activations(own,employee.id,date);if(used.has(date)||used.size>=employee.maxExtraNights)continue;
  const interval=windowFor(state,date,state.settings.nightStart,state.settings.nightEnd);
  const bounds=range(state,from,to);if(!overlaps(span(interval),bounds))continue;
  if(absenceWindows(own,employee.id).some(x=>overlaps(x,span(interval))))continue;
  if(existing.some(s=>overlaps(span(s),span(interval))))continue;
  const previous=existing.filter(s=>n(s.end)<=n(interval.start)).sort((a,b)=>n(b.end)-n(a.end))[0];
  if(previous&&n(interval.start)-n(previous.end)<state.settings.restHours*H)continue;
  const exception:ShiftException={id:`potential:${employee.id}:${date}`,employeeId:employee.id,date,kind:'extra',startTime:state.settings.nightStart,endTime:state.settings.nightEnd,approved:true};
  if(!validateException(own,exception).length){const next={...own,exceptions:[...own.exceptions,exception]};if(getAvailability(next,employee.id,interval.start,interval.end).available)result.push({employee,date,interval});}
  }
 }
 cache.values.set(key,result);return result;
}
export interface CapacityWindow { employeeId:string;start:string;end:string;hours:number; }
export interface PotentialCapacityWindow extends CapacityWindow { date:string;week:string;remainingActivations:number; }
export interface WeeklyNightPlanning {
 weekStart:string;weekEnd:string;regular:number;extraQuota:number;extraActivated:number;extraQuotaRemaining:number;total:number;committed:number;free:number;
}
/** Nominal CHG planning budget for COMPLETE weeks touched by the query. This is
 * distinct from date-specific approved capacity: activating an extraordinary
 * night consumes a quota token; it never creates another copy of that quota.
 * Work after midnight belongs to the week in which its approved journey began.
 * Quotas describe a planning envelope; prior rest, future rest, absences and
 * productive weekly-hour limits still require approval through the validators. */
export function weeklyNightPlanning(state:State,fromDate:string,toDate:string):WeeklyNightPlanning[] {
 const first=weekStart(fromDate,state.settings.weekStartsOn),last=weekStart(toDate,state.settings.weekStartsOn),weeks:string[]=[];
 for(let date=first;date<=last;date=addDays(date,7)){weeks.push(date);if(weeks.length>160)throw new Error('Período máximo de consulta: 160 semanas.');}
 if(!weeks.length)return [];
 const end=addDays(last,6),shifts=getShifts(state,first,end).filter(shift=>shift.date>=first&&shift.date<=end);
 const employees=state.employees.filter(employee=>employee.active),quotaOwners=employees.filter(employee=>employee.eligibleNight);
 const clockMinutes=(time:string)=>{const [hour,minute]=time.split(':').map(Number);return hour*60+minute;};
 const windowHours=((clockMinutes(state.settings.nightEnd)-clockMinutes(state.settings.nightStart)+1440)%1440)/60;
 const quota=quotaOwners.reduce((sum,employee)=>sum+Math.max(0,employee.maxExtraNights)*windowHours,0);
 const commitments=new Map(employees.map(employee=>[employee.id,union(state.demands.filter(demand=>committedStatuses.has(demand.status)).flatMap(demand=>demand.allocations.filter(allocation=>allocation.employeeId===employee.id).map(span)))]));
 const nightParts=new Map(shifts.map(shift=>{
  const windows=[addDays(shift.date,-1),shift.date,addDays(shift.date,1)].map(date=>span(windowFor(state,date,state.settings.nightStart,state.settings.nightEnd)));
  return [shift,union(productive(state,shift).flatMap(work=>windows.map(window=>intersection(work,window))))];
 }));
 return weeks.map(begin=>{
  const weekEnd=addDays(begin,6),own=shifts.filter(shift=>shift.date>=begin&&shift.date<=weekEnd);
  let regular=0,committed=0,extraActivated=0,extraQuotaRemaining=0;
  for(const employee of employees){
   const ownShifts=own.filter(shift=>shift.employeeId===employee.id),work=union(ownShifts.flatMap(shift=>nightParts.get(shift)||[]));
   regular+=total(ownShifts.filter(shift=>!shift.extra).flatMap(shift=>nightParts.get(shift)||[]));
   committed+=total(work.flatMap(value=>(commitments.get(employee.id)||[]).map(allocation=>intersection(value,allocation))));
  }
  for(const employee of quotaOwners){const limit=Math.max(0,employee.maxExtraNights),used=Math.min(limit,activations(state,employee.id,begin).size);extraActivated+=used*windowHours;extraQuotaRemaining+=(limit-used)*windowHours;}
  const planned=regular+quota;
  return {weekStart:begin,weekEnd,regular:round(regular),extraQuota:round(quota),extraActivated:round(extraActivated),extraQuotaRemaining:round(extraQuotaRemaining),total:round(planned),committed:round(committed),free:round(Math.max(0,planned-committed))};
 });
}
/** Productive approved capacity, with breaks, absences and derived rest removed. */
export function approvedCapacityWindows(state:State,fromDate:string,toDate:string):CapacityWindow[] {
 const bounds=range(state,fromDate,toDate),shifts=getShifts(state,fromDate,toDate);
 return state.employees.filter(e=>e.active).flatMap(employee=>union(shifts.filter(s=>s.employeeId===employee.id).flatMap(s=>productive(state,s)).map(s=>intersection(s,bounds))).map(s=>({employeeId:employee.id,start:iso(s.start),end:iso(s.end),hours:(s.end-s.start)/H})));
}
/** Eligible alternative activations. Callers must cap by employee/week quota;
 * these are alternatives, never additional approved capacity. */
export function potentialCapacityWindows(state:State,fromDate:string,toDate:string):PotentialCapacityWindow[] {
 const bounds=range(state,fromDate,toDate);
 return potentialWindows(state,fromDate,toDate).map(p=>{const value=intersection(span(p.interval),bounds);return {employeeId:p.employee.id,date:p.date,week:weekStart(p.date,state.settings.weekStartsOn),remainingActivations:Math.max(0,p.employee.maxExtraNights-activations(state,p.employee.id,p.date).size),start:iso(value.start),end:iso(value.end),hours:(value.end-value.start)/H};}).filter(s=>s.hours>0);
}
/** One feasible projection of alternatives. Validate combinations as well as
 * individual activations: a configurable quota of two nights must not bypass
 * weekly productive-hour limits or rest between those two projected nights. */
export function selectedPotentialCapacityWindows(state:State,fromDate:string,toDate:string):PotentialCapacityWindow[] {
 const signature=JSON.stringify([state.employees,state.exceptions,state.settings,state.demands]);
 let cache=selectedPotentialCaches.get(state);if(!cache||cache.signature!==signature){cache={signature,values:new Map()};selectedPotentialCaches.set(state,cache);}
 const key=`${fromDate}:${toDate}`,cached=cache.values.get(key);if(cached)return cached;
 const alternatives=potentialCapacityWindows(state,fromDate,toDate).sort((a,b)=>b.hours-a.hours||n(a.start)-n(b.start)||a.employeeId.localeCompare(b.employeeId));
 const selected:PotentialCapacityWindow[]=[],counts=new Map<string,number>();let projection=state;
 for(const window of alternatives){
  const quotaKey=`${window.employeeId}:${window.week}`,count=counts.get(quotaKey)||0;if(count>=window.remainingActivations)continue;
  const exception:ShiftException={id:`projection:${window.employeeId}:${window.date}`,employeeId:window.employeeId,date:window.date,kind:'extra',startTime:state.settings.nightStart,endTime:state.settings.nightEnd,approved:true};
  if(validateException(projection,exception).length)continue;
  projection={...projection,exceptions:[...projection.exceptions,exception]};counts.set(quotaKey,count+1);selected.push(window);
 }
 cache.values.set(key,selected);return selected;
}
export function buildCalendar(state:State,fromDate:string,toDate:string):CalendarCell[] {
 const shifts=getShifts(state,addDays(fromDate,-2),toDate),potential=potentialWindows(state,fromDate,toDate),result:CalendarCell[]=[];
 const active=state.demands.filter(d=>d.status!=='cancelled');
 const byEmployee=new Map(state.employees.filter(e=>e.active).map(employee=>{
  const present=shifts.filter(s=>s.employeeId===employee.id);
  return [employee.id,{work:union(present.flatMap(s=>productive(state,s))),rests:present.filter(s=>isNight(state,s)).map(s=>({start:n(s.end),end:n(s.end)+state.settings.restHours*H})),absences:absenceWindows(state,employee.id),allocations:active.flatMap(d=>d.allocations.filter(a=>a.employeeId===employee.id).map(a=>({d,a})))}];
 }));
 const invalidAllocations=new Set<string>();
 for(const demand of active.filter(d=>committedStatuses.has(d.status))){const clean={...state,demands:state.demands.filter(d=>d.id!==demand.id)};for(const allocation of demand.allocations)if(getAvailability(clean,allocation.employeeId,allocation.start,allocation.end).issues.length)invalidAllocations.add(`${demand.id}:${allocation.id}`);}
 for(const employee of state.employees.filter(e=>e.active))for(const date of dates(fromDate,toDate))for(let hour=0;hour<24;hour++){
  const start=civil(state,date,`${String(hour).padStart(2,'0')}:00`),cell={start:n(start),end:n(start)+H};
  let status:CalendarCell['status']='off',label='Fora da jornada',demandId:string|undefined,returnAt:string|undefined;
  const data=byEmployee.get(employee.id)!;
  const productiveHours=total(data.work.map(x=>intersection(x,cell)));
  if(productiveHours>0){status='free';label=`Disponível: ${round(productiveHours)}h produtiva(s) nesta faixa`;}
  if(potential.some(p=>p.employee.id===employee.id&&overlaps(span(p.interval),cell))&&status==='off'){status='potential';label='Potencial extraordinário — requer aprovação da escala';}
  const rest=data.rests.find(s=>overlaps(s,cell));
  if(rest){returnAt=iso(rest.end);if(productiveHours===0){status='rest';label=`Descanso obrigatório. Retorno permitido: ${humanTime(state,returnAt)}`;}else label+=` · Retorno permitido: ${humanTime(state,returnAt)}`;}
  if(data.absences.some(s=>overlaps(s,cell))){status='absence';label='Folga, férias, feriado ou ausência';}
  const found=data.allocations.filter(({a})=>overlaps(span(a),cell));
  const confirmed=found.filter(x=>committedStatuses.has(x.d.status));
  const conflicted=confirmed.some((x,index)=>confirmed.some((y,j)=>j!==index&&overlaps(span(x.a),span(y.a))))||confirmed.some(x=>invalidAllocations.has(`${x.d.id}:${x.a.id}`));
  const chosen=confirmed[0]||found[0];
  if(chosen){status=conflicted?'conflict':committedStatuses.has(chosen.d.status)?chosen.d.type:'reservation';demandId=chosen.d.id;label=`${chosen.d.code} · ${chosen.d.title} · ${humanTime(state,chosen.a.start)} → ${humanTime(state,chosen.a.end)}${status==='reservation'?' · Reserva de planejamento':''}${conflicted?' · Conflito de planejamento':''}`;}
  result.push({employeeId:employee.id,date,hour,status,label,...(demandId?{demandId}:{}),...(returnAt?{returnAt}:{})});
 }
 return result;
}
export function capacity(state:State,fromDate:string,toDate:string) {
 const bounds=range(state,fromDate,toDate),shifts=getShifts(state,fromDate,toDate),employees=state.employees.filter(e=>e.active);
 const active=state.demands.filter(d=>d.status!=='cancelled'&&overlaps(span(d),bounds));
 const confirmedDemands=active.filter(d=>committedStatuses.has(d.status)),reservations=active.filter(d=>['planning','requested'].includes(d.status));
 const productiveByEmployee=new Map(employees.map(e=>[e.id,union(shifts.filter(s=>s.employeeId===e.id).flatMap(s=>productive(state,s)))]));
 const coveredDemands=active.map(d=>({...d,allocations:d.allocations.flatMap(a=>(productiveByEmployee.get(a.employeeId)||[]).map((w,index)=>({...a,id:`${a.id}:${index}`,start:iso(Math.max(n(a.start),w.start)),end:iso(Math.min(n(a.end),w.end))})).filter(a=>good(span(a))))}));
 const allocationHours=(demands:Demand[],window:Span)=>employees.reduce((sum,e)=>sum+total(demands.flatMap(d=>d.allocations.filter(a=>a.employeeId===e.id).map(a=>intersection(span(a),window)))),0);
 const scheduled=(window:Span)=>employees.reduce((sum,e)=>sum+total(shifts.filter(s=>s.employeeId===e.id).flatMap(s=>productive(state,s)).map(s=>intersection(s,window))),0);
 const confirmed=scheduled(bounds),committed=allocationHours(confirmedDemands,bounds),reserved=allocationHours(reservations,bounds);
 const potentialItems=potentialWindows(state,fromDate,toDate);
 const potential=selectedPotentialCapacityWindows(state,fromDate,toDate).reduce((sum,window)=>sum+window.hours,0);
 const byType={BSIM:0,TSD:0,CHG:0};for(const type of ['BSIM','TSD','CHG'] as DemandType[])byType[type]=round(allocationHours(confirmedDemands.filter(d=>d.type===type),bounds));
 const deficit=coveredDemands.reduce((sum,d)=>sum+uncoveredHours(d,bounds),0);
 const daily=dates(fromDate,toDate).map(date=>{const w=range(state,date,date),c=scheduled(w),a=allocationHours(confirmedDemands,w),r=allocationHours(reservations,w);return {date,confirmed:round(c),committed:round(a),free:round(Math.max(0,c-a)),reserved:round(r),deficit:round(coveredDemands.reduce((sum,d)=>sum+uncoveredHours(d,w),0))};});
 const issues=uniqueIssues(confirmedDemands.flatMap(d=>validateDemand(state,d)));
 const resting=new Set(shifts.filter(s=>isNight(state,s)&&overlaps({start:n(s.end),end:n(s.end)+state.settings.restHours*H},bounds)).map(s=>s.employeeId)).size;
 return {confirmed:round(confirmed),committed:round(committed),free:round(Math.max(0,confirmed-committed)),potential:round(potential),reserved:round(reserved),deficit:round(deficit),occupancy:round(confirmed?committed/confirmed*100:committed?100:0),byType,daily,eligibleNight:new Set(potentialItems.map(p=>p.employee.id)).size,resting,uncovered:coveredDemands.filter(d=>uncoveredHours(d,bounds)>0.00001).length,issues};
}
export function simulate(state:State,proposal:{type:DemandType;start:string;end:string;required:number}) {
 const issues:Issue[]=[],eligible:Employee[]=[],potential:Employee[]=[],impactNextDay:string[]=[],potentialExceptions:ShiftException[]=[];
 const potentialImpacts=new Map<string,string>();
 const employeeStates=new Map<string,State>();
 if(!good(span(proposal))||!Number.isInteger(proposal.required)||proposal.required<1)return {canAbsorb:false,eligible,potential,occupancyAfter:0,issues:[issue('INVALID_INTERVAL','Informe período e quantidade válidos.')],requiresExtra:false,impactNextDay,alternatives:[] as {start:string;end:string;eligibleCount:number}[]};
 const startDate=dateAt(proposal.start,tz(state));
 let toDate=dateAt(iso(n(proposal.end)-1),tz(state));
 if(proposal.type==='CHG'&&!nightWindowContains(state,proposal.start,proposal.end))issues.push(issue('CHG_WINDOW',`CHG deve ocorrer entre ${state.settings.nightStart} e ${state.settings.nightEnd}.`));
 for(const employee of state.employees.filter(e=>e.active)){
  const own:State={...state,employees:[employee],exceptions:state.exceptions.filter(e=>e.employeeId===employee.id),demands:state.demands.filter(d=>d.allocations.some(a=>a.employeeId===employee.id)).map(d=>({...d,allocations:d.allocations.filter(a=>a.employeeId===employee.id)}))};
  employeeStates.set(employee.id,own);
  const availability=getAvailability(own,employee.id,proposal.start,proposal.end);
  if(availability.available){eligible.push(employee);continue;}
  const nightAnchor=(()=>{const before=addDays(startDate,-1);return state.settings.nightEnd<=state.settings.nightStart&&nightWindowContains(state,proposal.start,proposal.end)&&n(proposal.start)<n(civil(state,startDate,state.settings.nightEnd))?before:startDate;})();
  const exception:ShiftException={id:`sim:${employee.id}`,employeeId:employee.id,date:nightAnchor,kind:'extra',startTime:state.settings.nightStart,endTime:state.settings.nightEnd,approved:true};
  if(employee.eligibleNight&&nightWindowContains(state,proposal.start,proposal.end)&&!validateException(own,exception).length){
   const next={...own,exceptions:[...own.exceptions,exception]};
   if(getAvailability(next,employee.id,proposal.start,proposal.end).available){potential.push(employee);potentialExceptions.push(exception);const regular=rawShifts(own,addDays(nightAnchor,1),addDays(nightAnchor,1)).find(s=>s.employeeId===employee.id);const end=windowFor(state,nightAnchor,state.settings.nightStart,state.settings.nightEnd).end;const returnAt=n(end)+state.settings.restHours*H;if(regular&&n(regular.start)<returnAt)potentialImpacts.set(employee.id,`${employee.name}: jornada seguinte inicia após ${humanTime(state,returnAt)}.`);continue;}
  }
  issues.push(...availability.issues);
 }
 const requiresExtra=eligible.length<proposal.required&&potential.length>0,canAbsorb=eligible.length+potential.length>=proposal.required&&!issues.some(i=>i.code==='CHG_WINDOW');
 const extraNeeded=Math.max(0,proposal.required-eligible.length);
 const selectedExtras=potentialExceptions.slice(0,extraNeeded);
 for(const exception of selectedExtras){
  const impact=potentialImpacts.get(exception.employeeId);if(impact)impactNextDay.push(impact);
  const nightEnd=windowFor(state,exception.date,exception.startTime||state.settings.nightStart,exception.endTime||state.settings.nightEnd).end;
  const affectedDate=dateAt(iso(n(nightEnd)+state.settings.restHours*H-1),tz(state));
  if(affectedDate>toDate)toDate=affectedDate;
 }
 const simulatedState={...state,exceptions:[...state.exceptions,...selectedExtras]};
 // The report includes the complete approved activation and its following rest,
 // even when the proposed activity itself ends before midnight.
 const base=capacity(simulatedState,startDate,toDate);
 const occupied=base.committed+hours(proposal.start,proposal.end)*proposal.required;
 const alternatives:{start:string;end:string;eligibleCount:number}[]=[];
 const duration=n(proposal.end)-n(proposal.start);
 const alternativeEnd=addDays(startDate,8),approved=getShifts(state,startDate,alternativeEnd),activeEmployees=state.employees.filter(e=>e.active);
 const availableWindows=new Map(activeEmployees.map(employee=>[employee.id,subtract(approved.filter(s=>s.employeeId===employee.id).flatMap(s=>productive(state,s)),state.demands.filter(d=>committedStatuses.has(d.status)).flatMap(d=>d.allocations.filter(a=>a.employeeId===employee.id).map(span)))]));
 // Two options per date preserve room for both different hours and later days.
 for(let delta=0;delta<=7&&alternatives.length<4;delta++){
  const date=addDays(startDate,delta),day=range(state,date,date),starts=new Set<number>();
  for(let hour=0;hour<24;hour++){
   try{starts.add(n(civil(state,date,`${String(hour).padStart(2,'0')}:00`)));}catch{/* A skipped DST hour has no corresponding instant. */}
  }
  for(const windows of availableWindows.values())for(const window of windows)if(window.start>=day.start&&window.start<day.end)starts.add(window.start);
  const ordered=[...starts].sort((a,b)=>delta===0?(a>=n(proposal.start)?0:1)-(b>=n(proposal.start)?0:1)||a-b:a-b);
  let foundToday=0;
  for(const candidate of ordered){
   if(alternatives.length>=4||foundToday>=2)break;
   if(candidate===n(proposal.start))continue;
   const start=iso(candidate),end=iso(candidate+duration);
   if(proposal.type==='CHG'&&!nightWindowContains(state,start,end))continue;
   const count=activeEmployees.filter(employee=>(availableWindows.get(employee.id)||[]).some(window=>window.start<=candidate&&window.end>=candidate+duration)&&getAvailability(employeeStates.get(employee.id)||state,employee.id,start,end).available).length;
   if(count>=proposal.required){alternatives.push({start,end,eligibleCount:count});foundToday++;}
  }
 }
 if(!canAbsorb)issues.unshift(issue('INSUFFICIENT_CAPACITY',`Disponíveis ${eligible.length} em escala e ${potential.length} mediante ativação; necessários ${proposal.required}.`));
 return {canAbsorb,eligible,potential,occupancyAfter:round(base.confirmed?occupied/base.confirmed*100:occupied?100:0),issues:uniqueIssues(issues),requiresExtra,impactNextDay,alternatives};
}
