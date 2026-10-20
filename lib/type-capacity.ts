import type { Demand, DemandType, Interval, Issue, State } from './types.ts';
import type { CapacityWindow, PotentialCapacityWindow, WeeklyNightPlanning } from './engine.ts';
// @ts-ignore -- explicit extensions allow the native Node TypeScript test runner.
import { approvedCapacityWindows, potentialCapacityWindows, selectedPotentialCapacityWindows, validateDemand, weeklyNightPlanning } from './engine.ts';
// @ts-ignore -- explicit extensions allow the native Node TypeScript test runner.
import { addDays, zoned } from './time.ts';

interface Span { start:number;end:number; }
export interface TypeCapacityDay {
 date:string;confirmed:number;committed:number;free:number;potential:number;reserved:number;deficit:number;occupancy:number;canAccept:boolean;
 confirmedDemands:Demand[];pendingDemands:Demand[];blockingDemands:Demand[];
}
export interface TypeCapacity {
 type?:DemandType;confirmed:number;committed:number;free:number;potential:number;reserved:number;deficit:number;occupancy:number;canAccept:boolean;
 confirmedDemands:Demand[];pendingDemands:Demand[];blockingDemands:Demand[];daily:TypeCapacityDay[];windows:CapacityWindow[];
 potentialWindows:PotentialCapacityWindow[];potentialAlternatives:PotentialCapacityWindow[];issues:Issue[];
 /** CHG-only nominal budget for complete weeks, never copied into daily metrics. */
 weeklyPlanning:WeeklyNightPlanning[];planningTotal:number;planningFree:number;
}
const H=3600000;
const committedStatuses=new Set(['confirmed','running','completed']);
const pendingStatuses=new Set(['requested','planning']);
const instant=(value:string)=>Date.parse(value);
const iso=(value:number)=>new Date(value).toISOString();
const span=(value:Interval):Span=>({start:instant(value.start),end:instant(value.end)});
const valid=(value:Span)=>Number.isFinite(value.start)&&Number.isFinite(value.end)&&value.end>value.start;
const overlaps=(a:Span,b:Span)=>a.start<b.end&&b.start<a.end;
const intersect=(a:Span,b:Span):Span=>({start:Math.max(a.start,b.start),end:Math.min(a.end,b.end)});
const round=(value:number)=>Math.round(value*100)/100;
function union(values:Span[]):Span[] {
 const result:Span[]=[];
 for(const value of values.filter(valid).sort((a,b)=>a.start-b.start)){const previous=result[result.length-1];if(previous&&value.start<=previous.end)previous.end=Math.max(previous.end,value.end);else result.push({...value});}
 return result;
}
function subtract(values:Span[],blocked:Span[]):Span[] {
 let result=union(values);
 for(const block of union(blocked))result=result.flatMap(value=>overlaps(value,block)?[{start:value.start,end:Math.min(value.end,block.start)},{start:Math.max(value.start,block.end),end:value.end}].filter(valid):[value]);
 return result;
}
const duration=(values:Span[])=>union(values).reduce((sum,value)=>sum+(value.end-value.start)/H,0);
const clippedHours=(values:Span[],bounds:Span)=>duration(values.map(value=>intersect(value,bounds)));
function dates(from:string,to:string):string[] {const result:string[]=[];for(let date=from;date<=to;date=addDays(date,1)){result.push(date);if(result.length>1100)throw new Error('Período máximo de consulta: 1.100 dias.');}return result;}
function boundsFor(state:State,from:string,to:string):Span {return {start:instant(zoned(from,'00:00',state.settings.timezone)),end:instant(zoned(addDays(to,1),'00:00',state.settings.timezone))};}
function nightWindows(state:State,from:string,to:string):Span[] {
 return dates(addDays(from,-1),to).map(date=>({start:instant(zoned(date,state.settings.nightStart,state.settings.timezone)),end:instant(zoned(state.settings.nightEnd<=state.settings.nightStart?addDays(date,1):date,state.settings.nightEnd,state.settings.timezone))}));
}
function countMissing(demand:Demand,coverage:Map<string,Span[]>,bounds:Span):number {
 const wanted=intersect(span(demand),bounds);if(!valid(wanted))return 0;
 const byEmployee=new Map<string,Span[]>();
 for(const allocation of demand.allocations){const intervals=byEmployee.get(allocation.employeeId)||[];for(const work of coverage.get(allocation.employeeId)||[])intervals.push(intersect(intersect(span(allocation),work),wanted));byEmployee.set(allocation.employeeId,intervals);}
 const events=[{at:wanted.start,delta:0},{at:wanted.end,delta:0}];
 for(const intervals of byEmployee.values())for(const value of union(intervals))events.push({at:value.start,delta:1},{at:value.end,delta:-1});
 events.sort((a,b)=>a.at-b.at);let active=0,previous=wanted.start,missing=0;
 for(const event of events){missing+=Math.max(0,demand.required-active)*(event.at-previous)/H;active+=event.delta;previous=event.at;}
 return missing;
}

/** Capacity to accept work of a given type. Type filters affect demand records
 * and required hours; ALL approved commitments still occupy shared resources.
 * canAccept only means at least one positive free productive interval exists.
 * Exact duration, concurrency and extraordinary activation require simulate(). */
export function typeCapacity(state:State,fromDate:string,toDate:string,type?:DemandType):TypeCapacity {
 const bounds=boundsFor(state,fromDate,toDate),days=dates(fromDate,toDate),night=type==='CHG'?nightWindows(state,fromDate,toDate):null;
 const productive=approvedCapacityWindows(state,fromDate,toDate),eligibleByEmployee=new Map<string,Span[]>();
 for(const employee of state.employees.filter(e=>e.active)){
  const own=productive.filter(window=>window.employeeId===employee.id).map(span);
  eligibleByEmployee.set(employee.id,union(night?own.flatMap(value=>night.map(allowed=>intersect(value,allowed))):own));
 }
 const confirmedDemands=state.demands.filter(demand=>committedStatuses.has(demand.status)&&(!type||demand.type===type)&&overlaps(span(demand),bounds));
 const pendingDemands=state.demands.filter(demand=>pendingStatuses.has(demand.status)&&(!type||demand.type===type)&&overlaps(span(demand),bounds));
 const allCommitted=state.demands.filter(demand=>committedStatuses.has(demand.status));
 const allPending=state.demands.filter(demand=>pendingStatuses.has(demand.status));
 const blocksWindow=(demand:Demand,window:Span)=>demand.allocations.some(allocation=>{const allocated=intersect(span(allocation),window);return valid(allocated)&&(eligibleByEmployee.get(allocation.employeeId)||[]).some(work=>overlaps(allocated,work));});
 const blockingDemands=type?allCommitted.filter(demand=>demand.type!==type&&blocksWindow(demand,bounds)):[];
 const freeByEmployee=new Map<string,Span[]>(),busyByEmployee=new Map<string,Span[]>(),reservedByEmployee=new Map<string,Span[]>();
 for(const [employeeId,work] of eligibleByEmployee){
  const commitments=union(allCommitted.flatMap(demand=>demand.allocations.filter(allocation=>allocation.employeeId===employeeId).map(span)));
  const reservations=union(allPending.flatMap(demand=>demand.allocations.filter(allocation=>allocation.employeeId===employeeId).map(span)));
  freeByEmployee.set(employeeId,subtract(work,commitments));
  busyByEmployee.set(employeeId,union(work.flatMap(value=>commitments.map(commitment=>intersect(value,commitment)))));
  reservedByEmployee.set(employeeId,union(work.flatMap(value=>reservations.map(reservation=>intersect(value,reservation)))));
 }
 const windows=[...freeByEmployee].flatMap(([employeeId,values])=>values.map(value=>({employeeId,start:iso(value.start),end:iso(value.end),hours:(value.end-value.start)/H}))).sort((a,b)=>instant(a.start)-instant(b.start)||a.employeeId.localeCompare(b.employeeId));
 const potentialAlternatives=potentialCapacityWindows(state,fromDate,toDate);
 // A daily projection is one feasible scenario: competing dates for the same
 // weekly activation are alternatives; combinations must also respect rest/hours.
 const potentialWindows=selectedPotentialCapacityWindows(state,fromDate,toDate);
 const sum=(values:Map<string,Span[]>,window:Span)=>[...values.values()].reduce((result,intervals)=>result+clippedHours(intervals,window),0);
 const potentialAt=(window:Span)=>potentialWindows.reduce((result,value)=>result+clippedHours([span(value)],window),0);
 const deficits=(window:Span)=>confirmedDemands.reduce((result,demand)=>result+countMissing(demand,eligibleByEmployee,window),0)+pendingDemands.reduce((result,demand)=>result+countMissing(demand,freeByEmployee,window),0);
 const metrics=(window:Span)=>{
  const confirmed=sum(eligibleByEmployee,window),committed=sum(busyByEmployee,window),free=sum(freeByEmployee,window);
  return {confirmed:round(confirmed),committed:round(committed),free:round(free),potential:round(potentialAt(window)),reserved:round(sum(reservedByEmployee,window)),deficit:round(deficits(window)),occupancy:round(confirmed?committed/confirmed*100:0),canAccept:free>0.000001};
 };
 const daily=days.map(date=>{const window=boundsFor(state,date,date);return {date,...metrics(window),confirmedDemands:confirmedDemands.filter(demand=>overlaps(span(demand),window)),pendingDemands:pendingDemands.filter(demand=>overlaps(span(demand),window)),blockingDemands:blockingDemands.filter(demand=>blocksWindow(demand,window))};});
 const issues=confirmedDemands.flatMap(demand=>validateDemand(state,demand));
 const weeklyPlanning=type==='CHG'?weeklyNightPlanning(state,fromDate,toDate):[];
 return {...(type?{type}:{}),...metrics(bounds),confirmedDemands,pendingDemands,blockingDemands,daily,windows,potentialWindows,potentialAlternatives,issues,weeklyPlanning,planningTotal:round(weeklyPlanning.reduce((sum,week)=>sum+week.total,0)),planningFree:round(weeklyPlanning.reduce((sum,week)=>sum+week.free,0))};
}
