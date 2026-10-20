import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { makeSeed } from './seed';
import { validateDemand, validateException, validateRecurringSchedule } from './engine';
import type { State, Session, Employee, Demand, ShiftException, Settings, Issue, Audit } from './types';

export class ApiError extends Error { status:number;issues?:Issue[];constructor(message:string,status=400,issues?:Issue[]){super(message);this.status=status;this.issues=issues;} }
export function getDatabase():D1Database { if(!env.DB)throw new ApiError('Banco não configurado. Aplique as migrações e configure a conexão DB.',503);return env.DB; }
const id=z.string().trim().min(1).max(100).regex(/^[\w.-]+$/);
const text=z.string().trim().max(4000);
const time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/,'Horário inválido.');
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(`${v}T12:00:00Z`))&&new Date(`${v}T12:00:00Z`).toISOString().slice(0,10)===v,'Data inválida.');
const instant=z.string().datetime({offset:true});
const allocationSchema=z.object({id:id.default(()=>crypto.randomUUID()),employeeId:id,start:instant,end:instant}).strict().refine(v=>Date.parse(v.end)>Date.parse(v.start),'A alocação deve terminar após o início.');
export const employeeSchema=z.object({id:id.default(()=>crypto.randomUUID()),code:text.min(1).max(40),name:text.min(2).max(160),team:text.min(1).max(100),role:text.min(1).max(100),journey:z.enum(['day','night','custom']),startTime:time,endTime:time,weekdays:z.array(z.number().int().min(1).max(7)).max(7).refine(v=>new Set(v).size===v.length),breaks:z.array(z.object({start:time,end:time}).strict()).max(12),weeklyHours:z.number().min(0).max(168),weeklyLimit:z.number().min(0).max(168),eligibleNight:z.boolean(),maxExtraNights:z.number().int().min(0).max(7),active:z.boolean()}).strict().refine(v=>v.startTime!==v.endTime,'A jornada precisa ter duração positiva.');
export const demandSchema=z.object({id:id.default(()=>crypto.randomUUID()),code:text.min(1).max(40),title:text.min(2).max(200),type:z.enum(['TSD','BSIM','CHG']),project:text.max(160),requester:text.max(160),priority:z.enum(['low','medium','high','critical']),date,start:instant,end:instant,required:z.number().int().min(1).max(1000),status:z.enum(['requested','planning','confirmed','running','completed','cancelled']),notes:text,allocations:z.array(allocationSchema).max(1000)}).strict().refine(v=>Date.parse(v.end)>Date.parse(v.start),'A demanda deve terminar após o início.').refine(v=>new Set(v.allocations.map(a=>a.id)).size===v.allocations.length,'Identificadores de alocação duplicados.').refine(v=>v.allocations.every(a=>Date.parse(a.start)>=Date.parse(v.start)&&Date.parse(a.end)<=Date.parse(v.end)),'As alocações precisam estar dentro do período da demanda.');
export const exceptionSchema=z.object({id:id.default(()=>crypto.randomUUID()),employeeId:id,date,kind:z.enum(['off','vacation','absence','holiday','override','extra']),startTime:time.optional(),endTime:time.optional(),note:text.optional(),approved:z.boolean()}).strict().refine(v=>!['extra','override'].includes(v.kind)||(!!v.startTime&&!!v.endTime&&v.startTime!==v.endTime),'Informe início e fim da escala.');
export const settingsSchema=z.object({timezone:text.min(1).max(80).refine(v=>{try{new Intl.DateTimeFormat('pt-BR',{timeZone:v});return true;}catch{return false;}},'Fuso horário inválido.'),restHours:z.number().min(0).max(72),nightStart:time,nightEnd:time,weekStartsOn:z.number().int().min(0).max(6),comfortableThreshold:z.number().min(0).max(200),saturationThreshold:z.number().min(1).max(300),clientShowNames:z.boolean(),clientShowDetails:z.boolean()}).strict().refine(v=>v.comfortableThreshold<v.saturationThreshold,'O limite confortável deve ser inferior ao limite de saturação.').refine(v=>v.nightStart!==v.nightEnd,'A janela noturna precisa ter duração positiva.');

type Row=Record<string,unknown>;
function statement(sql:string,values:unknown[]=[]){return getDatabase().prepare(sql).bind(...values.map(v=>v===undefined?null:typeof v==='boolean'?Number(v):v));}
function insert(table:string,row:Row,replace=false){const keys=Object.keys(row);return statement(`INSERT ${replace?'OR REPLACE ':''}INTO ${table} (${keys.map(k=>`"${k}"`).join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,Object.values(row));}
const employeeRow=(e:Employee):Row=>({id:e.id,code:e.code,name:e.name,team:e.team,role:e.role,journey:e.journey,start_time:e.startTime,end_time:e.endTime,weekdays:JSON.stringify(e.weekdays),breaks:JSON.stringify(e.breaks),weekly_hours:e.weeklyHours,weekly_limit:e.weeklyLimit,eligible_night:e.eligibleNight,max_extra_nights:e.maxExtraNights,active:e.active});
const exceptionRow=(e:ShiftException):Row=>({id:e.id,employee_id:e.employeeId,date:e.date,kind:e.kind,start_time:e.startTime,end_time:e.endTime,note:e.note??'',approved:e.approved});
const demandRow=(d:Demand):Row=>({id:d.id,code:d.code,title:d.title,type:d.type,project:d.project,requester:d.requester,priority:d.priority,date:d.date,start:d.start,end:d.end,required:d.required,status:d.status,notes:d.notes});
export async function ensureSeed(){
  const db=getDatabase();const existing=await db.prepare("SELECT id FROM app_meta WHERE id='main'").first();if(existing)return;
  const seed=makeSeed(),batch:D1PreparedStatement[]=[];
  for(const e of seed.employees)batch.push(insert('employees',employeeRow(e)));
  for(const e of seed.exceptions)batch.push(insert('shift_exceptions',exceptionRow(e)));
  for(const d of seed.demands){batch.push(insert('demands',demandRow(d)));for(const a of d.allocations)batch.push(insert('allocations',{id:a.id,demand_id:d.id,employee_id:a.employeeId,start:a.start,end:a.end}));}
  batch.push(insert('settings',{id:'main',value:JSON.stringify(seed.settings)}),insert('app_meta',{id:'main',revision:0,seeded_at:new Date().toISOString()}));
  try{await db.batch(batch);}catch(error){if(!await db.prepare("SELECT id FROM app_meta WHERE id='main'").first())throw error;}
}
export async function getState():Promise<State>{
  await ensureSeed();const results=await getDatabase().batch([
    statement('SELECT * FROM employees ORDER BY code'),statement('SELECT * FROM shift_exceptions ORDER BY date'),statement('SELECT * FROM demands ORDER BY julianday(start)'),statement('SELECT * FROM allocations ORDER BY julianday(start)'),statement("SELECT value FROM settings WHERE id='main'"),statement('SELECT * FROM audit ORDER BY at DESC LIMIT 300'),statement("SELECT revision FROM app_meta WHERE id='main'"),
  ]);
  const rows=results.map(r=>r.results as Row[]);
  return {employees:rows[0].map(r=>({id:String(r.id),code:String(r.code),name:String(r.name),team:String(r.team),role:String(r.role),journey:r.journey as Employee['journey'],startTime:String(r.start_time),endTime:String(r.end_time),weekdays:JSON.parse(String(r.weekdays)),breaks:JSON.parse(String(r.breaks)),weeklyHours:Number(r.weekly_hours),weeklyLimit:Number(r.weekly_limit),eligibleNight:!!r.eligible_night,maxExtraNights:Number(r.max_extra_nights),active:!!r.active})),exceptions:rows[1].map(r=>({id:String(r.id),employeeId:String(r.employee_id),date:String(r.date),kind:r.kind as ShiftException['kind'],startTime:r.start_time?String(r.start_time):undefined,endTime:r.end_time?String(r.end_time):undefined,note:String(r.note??''),approved:!!r.approved})),demands:rows[2].map(r=>({id:String(r.id),code:String(r.code),title:String(r.title),type:r.type as Demand['type'],project:String(r.project),requester:String(r.requester),priority:r.priority as Demand['priority'],date:String(r.date),start:String(r.start),end:String(r.end),required:Number(r.required),status:r.status as Demand['status'],notes:String(r.notes),allocations:rows[3].filter(a=>a.demand_id===r.id).map(a=>({id:String(a.id),employeeId:String(a.employee_id),start:String(a.start),end:String(a.end)}))})),settings:JSON.parse(String(rows[4][0].value)) as Settings,audit:rows[5].map(r=>({id:String(r.id),at:String(r.at),actor:String(r.actor),action:String(r.action),entity:String(r.entity),before:r.before?String(r.before):undefined,after:r.after?String(r.after):undefined})),revision:Number(rows[6][0].revision)};
}
export function redactState(state:State,session:Session):State {
  if(session.role!=='client')return state;
  // Pending work remains visible as a separate forecast/reservation. Removing it
  // here would hide real deficits and give the client an incorrect capacity view.
  return {...state,audit:undefined,employees:state.employees.map(e=>({...e,name:state.settings.clientShowNames?e.name:e.code,role:'Colaborador',team:'Operação'})),exceptions:state.exceptions.filter(e=>e.approved).map(e=>({...e,note:''})),demands:state.demands.filter(d=>d.status!=='cancelled').map(d=>{const confirmed=['confirmed','running','completed'].includes(d.status);return {...d,code:confirmed?d.code:`PREV-${d.type}`,title:confirmed?d.title:`Atividade ${d.type}`,priority:confirmed?d.priority:'medium',project:'',requester:'',notes:''};})};
}
export function assertWrite(session:Session,entity:string){if(session.role==='client')throw new ApiError('Seu acesso é somente leitura.',403);if(['employee','settings','user'].includes(entity)&&session.role!=='admin')throw new ApiError('Esta operação exige perfil de administrador.',403);}
export async function atomicWrite(revision:number,queries:D1PreparedStatement[],entry:Omit<Audit,'id'|'at'>){
  const auditEntry={id:crypto.randomUUID(),at:new Date().toISOString(),...entry};
  try{await getDatabase().batch([statement("UPDATE app_meta SET revision=CASE WHEN revision=? THEN revision+1 ELSE NULL END WHERE id='main'",[revision]),...queries,insert('audit',{...auditEntry,before:auditEntry.before??null,after:auditEntry.after??null})]);}
  catch(error){const message=String(error);if(message.includes('NOT NULL')&&message.includes('revision'))throw new ApiError('Outro usuário alterou o planejamento. Atualize a página antes de salvar.',409);if(message.includes('UNIQUE'))throw new ApiError('Já existe um registro com este código ou identificação.',409);if(message.includes('FOREIGN KEY'))throw new ApiError('Há referências a este registro. Remova os vínculos ou inative o cadastro.',409);throw error;}
}
export async function mutate(session:Session,payload:unknown):Promise<State>{
  const input=z.object({entity:z.enum(['employee','demand','exception','settings']),action:z.enum(['upsert','delete']),data:z.unknown(),revision:z.number().int().nonnegative()}).strict().parse(payload);
  assertWrite(session,input.entity);const state=await getState();if(input.revision!==state.revision)throw new ApiError('O planejamento foi atualizado. Recarregue antes de salvar.',409);
  const next:State=structuredClone(state),queries:D1PreparedStatement[]=[];let before:unknown,after:unknown;
  if(input.entity==='settings'){
    if(input.action==='delete')throw new ApiError('As configurações não podem ser excluídas.');
    after=settingsSchema.parse(input.data);before=state.settings;next.settings=after as Settings;
    queries.push(statement("UPDATE settings SET value=? WHERE id='main'",[JSON.stringify(after)]));
  } else {
    const parsed=input.action==='delete'?z.object({id}).parse(input.data):input.entity==='employee'?employeeSchema.parse(input.data):input.entity==='demand'?demandSchema.parse(input.data):exceptionSchema.parse(input.data);
    const key=input.entity==='employee'?'employees':input.entity==='demand'?'demands':'exceptions';
    const records=next[key] as (Employee|Demand|ShiftException)[];
    before=records.find(e=>e.id===parsed.id);if(input.action==='delete'&&!before)throw new ApiError('Registro não encontrado.',404);
    if(input.entity==='employee'&&input.action==='delete'&&(state.demands.some(d=>d.allocations.some(a=>a.employeeId===parsed.id))||state.exceptions.some(e=>e.employeeId===parsed.id)))throw new ApiError('Este colaborador possui histórico. Inative seu cadastro para preservá-lo.',409);
    const index=records.findIndex(e=>e.id===parsed.id);if(index>=0)records.splice(index,1);
    if(input.action==='upsert'){records.push(parsed as Employee|Demand|ShiftException);after=parsed;}
    const table=input.entity==='employee'?'employees':input.entity==='demand'?'demands':'shift_exceptions';
    if(input.entity==='demand')queries.push(statement('DELETE FROM allocations WHERE demand_id=?',[parsed.id]));
    if(input.action==='delete')queries.push(statement(`DELETE FROM ${table} WHERE id=?`,[parsed.id]));
    else {
      const row=input.entity==='employee'?employeeRow(parsed as Employee):input.entity==='demand'?demandRow(parsed as Demand):exceptionRow(parsed as ShiftException);
      // ON CONFLICT UPDATE preserves FK links, unlike SQLite REPLACE's delete/insert behavior.
      const keys=Object.keys(row);queries.push(statement(`INSERT INTO ${table} (${keys.map(k=>`"${k}"`).join(',')}) VALUES (${keys.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${keys.filter(k=>k!=='id').map(k=>`"${k}"=excluded."${k}"`).join(',')}`,Object.values(row)));
      if(input.entity==='demand')for(const a of (parsed as Demand).allocations)queries.push(insert('allocations',{id:a.id,demand_id:parsed.id,employee_id:a.employeeId,start:a.start,end:a.end}));
    }
  }
  if(input.action==='upsert'&&(input.entity==='employee'||input.entity==='settings')){
    const recurringIssues=validateRecurringSchedule(next,input.entity==='employee'?(after as Employee).id:undefined);
    if(recurringIssues.length)throw new ApiError('A jornada recorrente viola as regras de descanso ou os limites semanais.',409,recurringIssues);
  }
  const issues:Issue[]=[];
  for(const d of next.demands){
    for(const a of d.allocations)if(!next.employees.some(e=>e.id===a.employeeId))issues.push({code:'EMPLOYEE',message:`Colaborador não encontrado na demanda ${d.code}.`,employeeId:a.employeeId});
    if(['confirmed','running','completed'].includes(d.status))issues.push(...validateDemand(next,d,d.id));
  }
  for(const e of next.exceptions){if(!next.employees.some(p=>p.id===e.employeeId))issues.push({code:'EMPLOYEE',message:'Colaborador da escala não encontrado.',employeeId:e.employeeId});if(e.approved)issues.push(...validateException(next,e,e.id));}
  if(issues.length)throw new ApiError('O planejamento contém violações de jornada ou capacidade.',422,issues.filter((v,i,a)=>a.findIndex(x=>x.code===v.code&&x.message===v.message&&x.employeeId===v.employeeId)===i));
  await atomicWrite(input.revision,queries,{actor:session.name,entity:input.entity,action:input.action,before:before?JSON.stringify(before):undefined,after:after?JSON.stringify(after):undefined});
  return getState();
}
