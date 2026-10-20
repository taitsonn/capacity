export type Role = 'admin' | 'manager' | 'client';
export type DemandType = 'TSD' | 'BSIM' | 'CHG';
export type DemandStatus = 'requested' | 'planning' | 'confirmed' | 'running' | 'completed' | 'cancelled';
export interface Employee { id:string; code:string; name:string; team:string; role:string; journey:'day'|'night'|'custom'; startTime:string; endTime:string; weekdays:number[]; breaks:{start:string;end:string}[]; weeklyHours:number; weeklyLimit:number; eligibleNight:boolean; maxExtraNights:number; active:boolean; }
export interface ShiftException { id:string; employeeId:string; date:string; kind:'off'|'vacation'|'absence'|'holiday'|'override'|'extra'; startTime?:string; endTime?:string; note?:string; approved:boolean; }
export interface Allocation { id:string; employeeId:string; start:string; end:string; }
export interface Demand { id:string; code:string; title:string; type:DemandType; project:string; requester:string; priority:'low'|'medium'|'high'|'critical'; date:string; start:string; end:string; required:number; status:DemandStatus; notes:string; allocations:Allocation[]; }
export interface Settings { timezone:string; restHours:number; nightStart:string; nightEnd:string; weekStartsOn:number; comfortableThreshold:number; saturationThreshold:number; clientShowNames:boolean; clientShowDetails:boolean; }
export interface Audit {id:string; at:string; actor:string; action:string; entity:string; before?:string; after?:string;}
export interface State { employees:Employee[]; exceptions:ShiftException[]; demands:Demand[]; settings:Settings; audit?:Audit[]; revision?:number; }
export interface Session {id:string; name:string; email:string; role:Role;}
export interface Interval { start:string; end:string; }
export interface Issue { code:string; message:string; employeeId?:string; }
