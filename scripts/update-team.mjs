import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { makeSeed } from '../lib/seed.ts';
import { addDays, dateAt, zoned } from '../lib/time.ts';
import { validateDemand, validateException, validateRecurringSchedule } from '../lib/engine.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const oldNames={ana:'Ana Souza',bruno:'Bruno Costa',carla:'Carla Oliveira',diego:'Diego Santos',elisa:'Elisa Martins'};
const approvedStatuses=new Set(['confirmed','running','completed']);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function readState(db){
  const allocations=db.prepare('SELECT * FROM allocations').all();
  const employees=db.prepare('SELECT * FROM employees ORDER BY code').all().map(r=>({id:r.id,code:r.code,name:r.name,team:r.team,role:r.role,journey:r.journey,startTime:r.start_time,endTime:r.end_time,weekdays:JSON.parse(r.weekdays),breaks:JSON.parse(r.breaks),weeklyHours:r.weekly_hours,weeklyLimit:r.weekly_limit,eligibleNight:!!r.eligible_night,maxExtraNights:r.max_extra_nights,active:!!r.active}));
  const exceptions=db.prepare('SELECT * FROM shift_exceptions ORDER BY date,id').all().map(r=>({id:r.id,employeeId:r.employee_id,date:r.date,kind:r.kind,startTime:r.start_time||undefined,endTime:r.end_time||undefined,note:r.note||'',approved:!!r.approved}));
  const demands=db.prepare('SELECT * FROM demands ORDER BY start,id').all().map(r=>({id:r.id,code:r.code,title:r.title,type:r.type,project:r.project,requester:r.requester,priority:r.priority,date:r.date,start:r.start,end:r.end,required:r.required,status:r.status,notes:r.notes,allocations:allocations.filter(a=>a.demand_id===r.id).map(a=>({id:a.id,employeeId:a.employee_id,start:a.start,end:a.end}))}));
  const settings=JSON.parse(db.prepare("SELECT value FROM settings WHERE id='main'").get().value),revision=db.prepare("SELECT revision FROM app_meta WHERE id='main'").get().revision;
  const audit=db.prepare('SELECT * FROM audit ORDER BY at,id').all();
  return {employees,exceptions,demands,settings,revision,audit};
}
export {readState as readMigrationState};
function touchedDemand(audit,demand){return audit.filter(a=>a.entity==='demand').some(a=>[a.before,a.after].filter(Boolean).some(value=>{try{const item=JSON.parse(value);return item.id===demand.id||item.code===demand.code;}catch{return true;}}));}
export function planTeamUpdate(database){
  const before=readState(database),next=structuredClone(before),target=makeSeed(),employeeChanges=[],demandChanges=[],warnings=[];
  for(const employee of next.employees){
    const desired=target.employees.find(e=>e.id===employee.id);if(!desired)continue;
    if(employee.code!==desired.code||![oldNames[employee.id],desired.name].includes(employee.name)){warnings.push(`Cadastro ${employee.id} foi personalizado e será preservado.`);continue;}
    const value={...employee,name:desired.name,role:desired.role,journey:desired.journey,startTime:desired.startTime,endTime:desired.endTime,weekdays:desired.weekdays,breaks:desired.breaks,weeklyHours:desired.weeklyHours,weeklyLimit:desired.weeklyLimit};
    if(hash(employee)!==hash(value)){employeeChanges.push({id:employee.id,before:structuredClone(employee),after:value});Object.assign(employee,value);}
  }
  for(const demand of next.demands){
    if(!['CHG-104','CHG-109'].includes(demand.code)||demand.id!==demand.code.toLowerCase()||demand.type!=='CHG')continue;
    if(touchedDemand(before.audit,demand)){warnings.push(`${demand.code} possui alterações de usuário e será preservada.`);continue;}
    if(demand.allocations.length!==1||demand.allocations[0].employeeId!=='elisa')continue;
    const date=dateAt(demand.start,before.settings.timezone),expectedStart=zoned(date,'23:00',before.settings.timezone),expectedEnd=zoned(addDays(date,1),'05:00',before.settings.timezone),newEnd=zoned(addDays(date,1),'02:00',before.settings.timezone);
    if(Date.parse(demand.start)!==Date.parse(expectedStart)||Date.parse(demand.end)!==Date.parse(expectedEnd))continue;
    const original=structuredClone(demand);demand.end=newEnd;for(const allocation of demand.allocations)if(Date.parse(allocation.end)>Date.parse(newEnd))allocation.end=newEnd;
    demandChanges.push({id:demand.id,code:demand.code,before:original,after:structuredClone(demand),reason:'Ajuste da demanda demonstrativa à nova jornada de Lucas Cordeiro, que termina às 02h.'});
  }
  const settingsChange=!before.audit.some(a=>a.entity==='settings')&&(!next.settings.clientShowNames||!next.settings.clientShowDetails)?{before:structuredClone(next.settings),after:{...next.settings,clientShowNames:true,clientShowDetails:true}}:null;
  if(settingsChange)next.settings=settingsChange.after;
  const issues=[...validateRecurringSchedule(next),...next.demands.filter(d=>approvedStatuses.has(d.status)).flatMap(d=>validateDemand(next,d,d.id)),...next.exceptions.filter(e=>e.approved).flatMap(e=>validateException(next,e,e.id))];
  const uniqueIssues=issues.filter((v,i,a)=>a.findIndex(x=>x.code===v.code&&x.message===v.message&&x.employeeId===v.employeeId)===i);
  return {before,next,fingerprint:hash(before),revision:before.revision,employeeChanges,demandChanges,settingsChange,warnings,issues:uniqueIssues,canApply:uniqueIssues.length===0,changed:employeeChanges.length>0||demandChanges.length>0||!!settingsChange};
}
function publicReport(plan,filename){return {database:filename,revision:plan.revision,canApply:plan.canApply,changed:plan.changed,employees:plan.employeeChanges.map(c=>({id:c.id,code:c.before.code,before:{name:c.before.name,role:c.before.role,start:c.before.startTime,end:c.before.endTime,breaks:c.before.breaks,weeklyHours:c.before.weeklyHours,weeklyLimit:c.before.weeklyLimit},after:{name:c.after.name,role:c.after.role,start:c.after.startTime,end:c.after.endTime,breaks:c.after.breaks,weeklyHours:c.after.weeklyHours,weeklyLimit:c.after.weeklyLimit}})),demands:plan.demandChanges.map(c=>({id:c.id,code:c.code,before:{start:c.before.start,end:c.before.end},after:{start:c.after.start,end:c.after.end},reason:c.reason})),settings:plan.settingsChange?{clientShowNames:true,clientShowDetails:true}:null,preserved:{demandCount:plan.before.demands.length,auditCount:plan.before.audit.length,otherEmployees:plan.before.employees.filter(e=>!oldNames[e.id]).map(e=>e.id)},warnings:plan.warnings,issues:plan.issues};}
export async function updateTeam(filename,{apply=false,expectedRevision}={}){
  if(!existsSync(filename))throw new Error(`Banco não encontrado: ${filename}`);
  const reader=new DatabaseSync(filename,{readOnly:true});let plan;try{plan=planTeamUpdate(reader);}finally{reader.close();}
  const report=publicReport(plan,filename);if(!apply)return report;
  if(!plan.canApply)throw new Error(`Migração bloqueada por ${plan.issues.length} conflito(s). Execute sem --apply para revisar o relatório.`);
  if(expectedRevision!==undefined&&Number(expectedRevision)!==plan.revision)throw new Error('A revisão do banco mudou. Gere e revise o relatório novamente.');
  if(!plan.changed)return {...report,applied:false,message:'A equipe já está atualizada.'};
  const db=new DatabaseSync(filename);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const directory=path.join(path.dirname(filename),'backups');mkdirSync(directory,{recursive:true});const backupFile=path.join(directory,`capacity-before-team-${new Date().toISOString().replaceAll(':','-').replaceAll('.','-')}-${randomUUID().slice(0,8)}.sqlite`);
  try{
    await backup(db,backupFile);db.exec('BEGIN IMMEDIATE');
    try{
      if(hash(readState(db))!==plan.fingerprint)throw new Error('O planejamento mudou após a análise. Gere o relatório novamente.');
      for(const change of plan.employeeChanges){const e=change.after;db.prepare('UPDATE employees SET name=?,role=?,journey=?,start_time=?,end_time=?,weekdays=?,breaks=?,weekly_hours=?,weekly_limit=? WHERE id=?').run(e.name,e.role,e.journey,e.startTime,e.endTime,JSON.stringify(e.weekdays),JSON.stringify(e.breaks),e.weeklyHours,e.weeklyLimit,e.id);}
      for(const change of plan.demandChanges){db.prepare('UPDATE demands SET end=? WHERE id=?').run(change.after.end,change.id);for(const a of change.after.allocations)db.prepare('UPDATE allocations SET end=? WHERE id=? AND demand_id=?').run(a.end,a.id,change.id);}
      if(plan.settingsChange)db.prepare("UPDATE settings SET value=? WHERE id='main'").run(JSON.stringify(plan.settingsChange.after));
      db.prepare("UPDATE app_meta SET revision=revision+1 WHERE id='main'").run();
      db.prepare('INSERT INTO audit(id,at,actor,action,entity,before,after) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),'Atualização da equipe','upsert','team-migration',JSON.stringify({employees:plan.employeeChanges.map(c=>c.before),demands:plan.demandChanges.map(c=>c.before),settings:plan.settingsChange?.before}),JSON.stringify({employees:plan.employeeChanges.map(c=>c.after),demands:plan.demandChanges.map(c=>c.after),settings:plan.settingsChange?.after}));
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return {...report,applied:true,newRevision:plan.revision+1,backup:backupFile};
  }finally{db.close();}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const index=process.argv.indexOf('--db'),revisionIndex=process.argv.indexOf('--expected-revision'),filename=path.resolve(root,index>=0?process.argv[index+1]:process.env.CAPACITY_DB_PATH||'.data/capacity.sqlite');
  try{console.log(JSON.stringify(await updateTeam(filename,{apply:process.argv.includes('--apply'),expectedRevision:revisionIndex>=0?process.argv[revisionIndex+1]:undefined}),null,2));}catch(error){console.error(error.message);process.exitCode=1;}
}
