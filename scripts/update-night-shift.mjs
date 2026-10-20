import { DatabaseSync,backup } from 'node:sqlite';
import { existsSync,mkdirSync } from 'node:fs';
import { createHash,randomUUID } from 'node:crypto';
import { fileURLToPath,pathToFileURL } from 'node:url';
import path from 'node:path';
import { readMigrationState } from './update-team.mjs';
import { validateDemand,validateException,validateRecurringSchedule } from '../lib/engine.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function planNightShiftUpdate(db){
  const state=readMigrationState(db),employee=state.employees.find(e=>e.id==='elisa'&&e.code==='OP-005'&&e.name==='Lucas Cordeiro'),issues=[];
  const next=structuredClone(state),proposed=employee?{...employee,journey:'night',startTime:'23:00',endTime:'05:00',weekdays:[1,2,3,4,5],weeklyHours:30}:null;
  if(!employee)issues.push({code:'IDENTITY',message:'O cadastro esperado de Lucas Cordeiro (elisa / OP-005) não foi encontrado. Nenhum cadastro será alterado.'});
  if(proposed){next.employees=next.employees.map(e=>e.id===proposed.id?proposed:e);issues.push(...validateRecurringSchedule(next,proposed.id));for(const d of next.demands.filter(d=>['confirmed','running','completed'].includes(d.status)))issues.push(...validateDemand(next,d,d.id));for(const exception of next.exceptions.filter(e=>e.approved))issues.push(...validateException(next,exception,exception.id));}
  const unique=issues.filter((issue,index,all)=>all.findIndex(i=>i.code===issue.code&&i.message===issue.message&&i.employeeId===issue.employeeId)===index);
  return {state,employee,proposed,fingerprint:fingerprint(state),revision:state.revision,changed:!!employee&&fingerprint(employee)!==fingerprint(proposed),canApply:!!employee&&unique.length===0,issues:unique,users:db.prepare('SELECT COUNT(*) AS count FROM users').get().count};
}
export async function updateNightShift(filename,{apply=false,expectedRevision}={}){
  if(!existsSync(filename))throw new Error(`Banco não encontrado: ${filename}`);
  const reader=new DatabaseSync(filename,{readOnly:true});let plan;try{plan=planNightShiftUpdate(reader);}finally{reader.close();}
  const fields=e=>e?{id:e.id,code:e.code,name:e.name,journey:e.journey,startTime:e.startTime,endTime:e.endTime,weekdays:e.weekdays,breaks:e.breaks,weeklyHours:e.weeklyHours,weeklyLimit:e.weeklyLimit}:null;
  const report={database:filename,revision:plan.revision,canApply:plan.canApply,changed:plan.changed,employee:{before:fields(plan.employee),after:fields(plan.proposed)},preserved:{demands:plan.state.demands.length,allocations:plan.state.demands.reduce((n,d)=>n+d.allocations.length,0),exceptions:plan.state.exceptions.length,users:plan.users,audit:plan.state.audit.length},issues:plan.issues};
  if(!apply)return report;
  if(!plan.canApply)throw new Error('A jornada proposta conflita com os registros existentes. Consulte o relatório sem --apply.');
  if(expectedRevision===undefined||Number(expectedRevision)!==plan.revision)throw new Error('Informe --expected-revision com a revisão exata do relatório revisado.');
  if(!plan.changed)return {...report,applied:false,message:'A jornada já está atualizada.'};
  const db=new DatabaseSync(filename);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const directory=path.join(path.dirname(filename),'backups');mkdirSync(directory,{recursive:true});const backupFile=path.join(directory,`capacity-before-night-${new Date().toISOString().replaceAll(':','-').replaceAll('.','-')}-${randomUUID().slice(0,8)}.sqlite`);
  try{
    await backup(db,backupFile);db.exec('BEGIN IMMEDIATE');
    try{
      if(fingerprint(readMigrationState(db))!==plan.fingerprint)throw new Error('O banco mudou após a análise. Gere e revise o relatório novamente.');
      const e=plan.proposed;
      db.prepare('UPDATE employees SET journey=?,start_time=?,end_time=?,weekdays=?,weekly_hours=? WHERE id=?').run(e.journey,e.startTime,e.endTime,JSON.stringify(e.weekdays),e.weeklyHours,e.id);
      db.prepare("UPDATE app_meta SET revision=revision+1 WHERE id='main'").run();
      db.prepare('INSERT INTO audit(id,at,actor,action,entity,before,after) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),'Atualização da jornada noturna','upsert','night-shift-migration',JSON.stringify(plan.employee),JSON.stringify(plan.proposed));
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return {...report,applied:true,newRevision:plan.revision+1,backup:backupFile};
  }finally{db.close();}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const dbIndex=process.argv.indexOf('--db'),revisionIndex=process.argv.indexOf('--expected-revision'),filename=path.resolve(root,dbIndex>=0?process.argv[dbIndex+1]:process.env.CAPACITY_DB_PATH||'.data/capacity.sqlite');
  try{console.log(JSON.stringify(await updateNightShift(filename,{apply:process.argv.includes('--apply'),expectedRevision:revisionIndex>=0?process.argv[revisionIndex+1]:undefined}),null,2));}catch(error){console.error(error.message);process.exitCode=1;}
}
