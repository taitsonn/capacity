import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync,backup } from 'node:sqlite';
import { registerHooks } from 'node:module';
import { existsSync, readdirSync, readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
process.env.NODE_ENV='test';
globalThis.__capacityTestEnv={};
// The production store uses Cloudflare D1; this adapter runs the same SQL on SQLite.
registerHooks({
  resolve(specifier,context,next){
    if(specifier==='cloudflare:workers')return {url:'capacity-test:env',shortCircuit:true};
    if(specifier.startsWith('@/'))specifier=pathToFileURL(path.join(root,specifier.slice(2))).href;
    if(specifier.startsWith('.')||specifier.startsWith('file:')){
      const url=new URL(specifier,context.parentURL||import.meta.url);
      if(!path.extname(url.pathname)){for(const suffix of ['.ts','/index.ts']){const candidate=new URL(url.href+suffix);if(existsSync(fileURLToPath(candidate)))return next(candidate.href,context);}}
    }
    return next(specifier,context);
  },
  load(url,context,next){if(url==='capacity-test:env')return {format:'module',source:'export const env = globalThis.__capacityTestEnv;',shortCircuit:true};return next(url,context);},
});
class D1Statement {
  constructor(database,sql,values=[]){this.database=database;this.sql=sql;this.values=values;}
  bind(...values){return new D1Statement(this.database,this.sql,values);}
  async first(key){const value=this.database.prepare(this.sql).get(...this.values);return key?value?.[key]??null:value??null;}
  async all(){return {results:this.database.prepare(this.sql).all(...this.values),success:true,meta:{}};}
  async run(){const result=this.database.prepare(this.sql).run(...this.values);return {results:[],success:true,meta:{changes:result.changes,last_row_id:Number(result.lastInsertRowid)}};}
  execute(){const statement=this.database.prepare(this.sql);return {results:statement.columns().length?statement.all(...this.values):(statement.run(...this.values),[]),success:true,meta:{}};}
}
class D1Adapter {
  constructor(db){this.db=db;}
  prepare(sql){return new D1Statement(this.db,sql);}
  async batch(statements){this.db.exec('BEGIN IMMEDIATE');try{const result=statements.map(s=>s.execute());this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
}
let sqlite;
beforeEach(()=>{
  sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
  const migrations=readdirSync(path.join(root,'drizzle')).filter(f=>f.endsWith('.sql')).sort();assert.ok(migrations.length,'Generate the checked-in migration before running backend tests.');
  for(const file of migrations)sqlite.exec(readFileSync(path.join(root,'drizzle',file),'utf8'));
  globalThis.__capacityTestEnv.DB=new D1Adapter(sqlite);
  globalThis.__capacityTestEnv.CAPACITY_LOCAL_SETUP_TOKEN='test-only-local-setup-secret';
});
afterEach(()=>sqlite?.close());
const store=await import('../lib/store.ts');
const auth=await import('../lib/auth.ts');
const {capacity,getAvailability}=await import('../lib/engine.ts');
const {typeCapacity}=await import('../lib/type-capacity.ts');
const {zoned,addDays}=await import('../lib/time.ts');
const admin={id:'test-admin',name:'Administrador',email:'admin@test.local',role:'admin'};
const manager={...admin,id:'test-manager',role:'manager'};
const client={...admin,id:'test-client',role:'client'};
test('seed persists once, with five employees and valid relational allocations',async()=>{
  const first=await store.getState();assert.equal(first.employees.length,5);assert.equal(first.demands.length,13);
  assert.deepEqual(first.employees.map(e=>e.name),['Marcelo','Lizzie','Lucas Telesi','Tatiane Ramos','Lucas Cordeiro']);const night=first.employees.find(e=>e.id==='elisa');assert.equal(night.startTime,'23:00');assert.equal(night.endTime,'05:00');assert.deepEqual(night.breaks,[{start:'22:00',end:'23:00'}]);assert.equal(night.weeklyHours,30);assert.equal(night.weeklyLimit,48);
  const employee={...first.employees[0],name:'Nome alterado'};
  const updated=await store.mutate(admin,{entity:'employee',action:'upsert',data:employee,revision:first.revision});
  assert.equal(updated.revision,1);assert.equal((await store.getState()).employees.find(e=>e.id===employee.id).name,'Nome alterado');
  assert.equal(updated.audit.length,1);
});
test('optimistic revision and database transaction roll back stale mutations',async()=>{
  const state=await store.getState();const employee={...state.employees[0],name:'Primeira alteração'};
  await store.mutate(admin,{entity:'employee',action:'upsert',data:employee,revision:0});
  await assert.rejects(store.mutate(admin,{entity:'employee',action:'upsert',data:{...employee,name:'Alteração obsoleta'},revision:0}),error=>error.status===409);
  await assert.rejects(store.atomicWrite(0,[globalThis.__capacityTestEnv.DB.prepare("UPDATE employees SET name='Não persistir' WHERE id=?").bind(employee.id)],{actor:'test',action:'upsert',entity:'employee'}),error=>error.status===409);
  const saved=await store.getState();assert.equal(saved.revision,1);assert.equal(saved.employees.find(e=>e.id===employee.id).name,'Primeira alteração');
});
test('SQL failure after revision update rolls back the entire mutation batch',async()=>{
  const state=await store.getState(),duplicate={...state.employees[0],id:'duplicate-code',name:'Cadastro duplicado',active:false};
  await assert.rejects(store.mutate(admin,{entity:'employee',action:'upsert',data:duplicate,revision:0}),error=>error.status===409);
  const after=await store.getState();assert.equal(after.revision,0);assert.equal(after.audit.length,0);assert.equal(after.employees.length,5);assert.ok(!after.employees.some(e=>e.id===duplicate.id));
});
test('simultaneous first platform sessions provision exactly one administrator',async()=>{
  const requests=['first-platform-user','second-platform-user'].map(id=>new Request('https://capacity.test/api/session',{headers:{'oai-authenticated-user-id':id}}));
  const sessions=await Promise.all(requests.map(auth.getSession));assert.equal(sessions.filter(s=>s.role==='admin').length,1);assert.equal(sessions.filter(s=>s.role==='client').length,1);
  const same=await auth.getSession(requests[0]);assert.equal(same.id,sessions[0].id);assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM users').get().count,2);
});
test('role authorization and client redaction are enforced by the server',async()=>{
  const state=await store.getState();
  await assert.rejects(store.mutate(client,{entity:'demand',action:'delete',data:{id:state.demands[0].id},revision:0}),error=>error.status===403);
  await assert.rejects(store.mutate(manager,{entity:'employee',action:'upsert',data:state.employees[0],revision:0}),error=>error.status===403);
  const redacted=store.redactState(state,client);assert.equal(redacted.audit,undefined);assert.ok(redacted.employees.every(e=>e.name===state.employees.find(p=>p.id===e.id).name));assert.ok(redacted.demands.every(d=>!d.requester&&!d.notes));
  const hidden=store.redactState({...state,settings:{...state.settings,clientShowNames:false,clientShowDetails:false}},client);assert.ok(hidden.employees.every(e=>e.name===e.code));assert.equal(hidden.demands.find(d=>d.status==='confirmed').title,state.demands.find(d=>d.status==='confirmed').title);
});
test('client forecast preserves pending reservations and real capacity deficits without internal details',async()=>{
  const state=await store.getState(),redacted=store.redactState(state,client);
  const pending=state.demands.filter(d=>['requested','planning'].includes(d.status));assert.ok(pending.length>0);
  for(const d of pending){const visible=redacted.demands.find(v=>v.id===d.id);assert.ok(visible);assert.equal(visible.code,`PREV-${d.type}`);assert.equal(visible.title,`Atividade ${d.type}`);assert.equal(visible.notes,'');assert.equal(visible.requester,'');assert.equal(visible.project,'');}
  const from=state.demands[0].date,to=state.demands[state.demands.length-1].date,internal=capacity(state,from,to),external=capacity(redacted,from,to);
  assert.ok(internal.deficit>0,'Seed must contain a pending demand without confirmed capacity.');
  assert.equal(external.deficit,internal.deficit);assert.equal(external.reserved,internal.reserved);assert.equal(external.uncovered,internal.uncovered);assert.equal(external.confirmed,internal.confirmed);assert.equal(external.committed,internal.committed);
  assert.ok(redacted.exceptions.every(e=>!e.note));
});
test('overlapping confirmed demand is rejected without revision or audit changes',async()=>{
  const state=await store.getState(),existing=state.demands.find(d=>d.allocations.length&&d.type==='BSIM'&&d.status==='confirmed');
  const duplicate={...existing,id:'overlap',code:'BSIM-OVERLAP',allocations:existing.allocations.map(a=>({...a,id:`duplicate-${a.id}`}))};
  await assert.rejects(store.mutate(manager,{entity:'demand',action:'upsert',data:duplicate,revision:0}),error=>error.status===422&&error.issues.some(i=>i.code==='OVERLAP'));
  const after=await store.getState();assert.equal(after.revision,0);assert.equal(after.audit.length,0);assert.equal(after.demands.length,state.demands.length);
});
test('allocation API refreshes planning reservations and confirmed metrics with invalid-confirmation rollback',async()=>{
  // Reproduce the previous 17–02 registration explicitly; current seed is 23–05.
  await store.getState();sqlite.prepare("UPDATE employees SET start_time='17:00',end_time='02:00',weekly_hours=40 WHERE id='elisa'").run();
  const stateRoute=await import('../app/api/state/route.ts'),mutateRoute=await import('../app/api/mutate/route.ts');
  const headers={'oai-authenticated-user-id':'allocation-api-admin'};
  const read=async()=>{const response=await stateRoute.GET(new Request('https://capacity.test/api/state',{headers}));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');return (await response.json()).state;};
  const save=async(state,demand)=>mutateRoute.POST(new Request('https://capacity.test/api/mutate',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({entity:'demand',action:'upsert',data:demand,revision:state.revision})}));
  const initial=await read(),date=initial.demands.find(d=>d.code==='BSIM-101').date,to=addDays(date,6),start=zoned(date,'23:00'),end=zoned(addDays(date,1),'05:00');
  const baseline=typeCapacity(initial,date,to,'CHG');
  const proposal={id:'api-allocation-flow',code:'CHG-API-FLOW',title:'Validação do fluxo de alocação',type:'CHG',project:'Operação',requester:'Gestor',priority:'medium',date,start,end,required:3,status:'planning',notes:'',allocations:[{id:'api-allocation-flow-lucas',employeeId:'elisa',start,end}]};
  const plannedResponse=await save(initial,proposal);assert.equal(plannedResponse.status,200);const planned=(await plannedResponse.json()).state,plannedMetrics=typeCapacity(planned,date,to,'CHG');
  assert.equal(planned.revision,initial.revision+1);assert.equal(plannedMetrics.confirmed,baseline.confirmed);assert.equal(plannedMetrics.committed,baseline.committed);assert.equal(plannedMetrics.free,baseline.free);assert.equal(plannedMetrics.reserved,baseline.reserved+3);
  const snapshot=await read();assert.equal(snapshot.revision,planned.revision);assert.deepEqual(snapshot.demands.find(d=>d.id===proposal.id).allocations,proposal.allocations);
  const rejected=await save(planned,{...proposal,status:'confirmed'});assert.equal(rejected.status,422);const error=await rejected.json();assert.ok(error.issues.some(i=>i.code==='OUTSIDE_SHIFT'));assert.ok(error.issues.some(i=>i.code==='UNDERSTAFFED'));
  const afterFailure=await read();assert.equal(afterFailure.revision,planned.revision);assert.equal(afterFailure.audit.length,planned.audit.length);assert.equal(afterFailure.demands.find(d=>d.id===proposal.id).status,'planning');
  const correctedEnd=zoned(addDays(date,1),'02:00'),corrected={...proposal,end:correctedEnd,required:1,allocations:[{...proposal.allocations[0],end:correctedEnd}]};
  const correctedResponse=await save(afterFailure,corrected);assert.equal(correctedResponse.status,200);const correctedState=(await correctedResponse.json()).state;
  const confirmedResponse=await save(correctedState,{...corrected,status:'confirmed'});assert.equal(confirmedResponse.status,200);const confirmed=(await confirmedResponse.json()).state,confirmedMetrics=typeCapacity(confirmed,date,to,'CHG');
  assert.equal(confirmedMetrics.confirmed,baseline.confirmed);assert.equal(confirmedMetrics.committed,baseline.committed+3);assert.equal(confirmedMetrics.free,baseline.free-3);assert.equal(confirmedMetrics.reserved,baseline.reserved);assert.ok(confirmedMetrics.occupancy>baseline.occupancy);
  const fresh=await read();assert.equal(fresh.revision,confirmed.revision);assert.equal(fresh.demands.find(d=>d.id===proposal.id).status,'confirmed');assert.deepEqual(typeCapacity(fresh,date,to,'CHG'),confirmedMetrics);
});
test('corrected regular night accepts Lucas CHG 23–05 and never blocks 02–05 as false rest',async()=>{
  const initial=await store.getState(),date=initial.demands.find(d=>d.code==='BSIM-101').date,start=zoned(date,'23:00'),end=zoned(addDays(date,1),'05:00'),to=addDays(date,6);
  const before=typeCapacity(initial,date,to,'CHG'),availability=getAvailability(initial,'elisa',zoned(addDays(date,1),'02:00'),end);assert.equal(availability.available,true);assert.ok(!availability.issues.some(i=>i.code==='MIN_REST'));
  const demand={id:'correct-night-api',code:'CHG-CORRECT-NIGHT',title:'Jornada noturna regular corrigida',type:'CHG',project:'Operação',requester:'Gestor',priority:'medium',date,start,end,required:1,status:'confirmed',notes:'',allocations:[{id:'correct-night-api-lucas',employeeId:'elisa',start,end}]};
  const route=await import('../app/api/mutate/route.ts');
  const response=await route.POST(new Request('https://capacity.test/api/mutate',{method:'POST',headers:{'oai-authenticated-user-id':'correct-night-owner','content-type':'application/json'},body:JSON.stringify({entity:'demand',action:'upsert',data:demand,revision:initial.revision})}));
  assert.equal(response.status,200);const state=(await response.json()).state,metrics=typeCapacity(state,date,to,'CHG');assert.equal(metrics.confirmed,before.confirmed);assert.equal(metrics.committed,before.committed+6);assert.equal(metrics.free,before.free-6);assert.equal(state.exceptions.length,initial.exceptions.length);assert.equal(state.demands.find(d=>d.id===demand.id).status,'confirmed');
});
test('employee and absence changes cannot invalidate already confirmed work',async()=>{
  const state=await store.getState(),demand=state.demands.find(d=>d.type==='BSIM'&&d.status==='confirmed'),employee=state.employees.find(e=>e.id===demand.allocations[0].employeeId);
  await assert.rejects(store.mutate(admin,{entity:'employee',action:'upsert',data:{...employee,active:false},revision:0}),error=>error.status===422&&error.issues.some(i=>i.code==='INACTIVE'));
  await assert.rejects(store.mutate(manager,{entity:'exception',action:'upsert',data:{id:'absence',employeeId:employee.id,date:demand.date,kind:'absence',approved:true,note:'Conflita com compromisso existente'},revision:0}),error=>error.status===422);
  const after=await store.getState();assert.equal(after.revision,0);assert.equal(after.employees.find(e=>e.id===employee.id).active,true);assert.ok(!after.exceptions.some(e=>e.id==='absence'));
});
test('recurring schedule and rule edits are validated even without any demands',async()=>{
  const state=await store.getState();sqlite.exec('DELETE FROM allocations; DELETE FROM demands; DELETE FROM shift_exceptions;');
  const employee={...state.employees.find(e=>e.journey==='day'),startTime:'09:00',endTime:'23:00',breaks:[],weeklyLimit:100};
  await assert.rejects(store.mutate(admin,{entity:'employee',action:'upsert',data:employee,revision:0}),error=>error.status===409&&error.issues.some(i=>i.code==='MIN_REST'));
  await assert.rejects(store.mutate(admin,{entity:'settings',action:'upsert',data:{...state.settings,restHours:16},revision:0}),error=>error.status===409&&error.issues.some(i=>i.code==='MIN_REST'));
  await assert.rejects(store.mutate(admin,{entity:'employee',action:'upsert',data:{...state.employees.find(e=>e.journey==='day'),weeklyLimit:20},revision:0}),error=>error.status===409&&error.issues.some(i=>i.code==='WEEKLY_HOURS'));
  const after=await store.getState();assert.equal(after.revision,0);assert.equal(after.settings.restHours,11);assert.equal(after.audit.length,0);
});
test('password accounts use salted hashes, support login and revoke on deactivation',async()=>{
  await store.getState();
  // Bootstrap through the actual trusted identity flow, then create a client account.
  const bootstrap=await auth.getSession(new Request('https://capacity.test/api/session',{headers:{'oai-authenticated-user-id':'owner'}}));assert.equal(bootstrap.role,'admin');
  await auth.manageUser(bootstrap,{entity:'user',action:'upsert',revision:0,data:{name:'Cliente teste',email:'cliente@example.com',username:'cliente',password:'Senha-forte-12345',role:'client',active:true}});
  const row=sqlite.prepare('SELECT * FROM users WHERE username=?').get('cliente');assert.ok(row.password_hash.startsWith('pbkdf2-sha256$'));assert.ok(!row.password_hash.includes('Senha-forte-12345'));
  const response=await auth.login(new Request('https://capacity.test/api/auth',{method:'POST',headers:{'content-type':'application/json','origin':'https://capacity.test'},body:JSON.stringify({username:'cliente',password:'Senha-forte-12345'})}));
  assert.equal(response.status,200);const cookie=response.headers.get('set-cookie').split(';')[0];assert.ok(response.headers.get('set-cookie').includes('HttpOnly'));
  const request=new Request('https://capacity.test/api/session',{headers:{cookie}});assert.equal((await auth.getSession(request)).role,'client');
  await auth.manageUser(bootstrap,{entity:'user',action:'upsert',revision:1,data:{id:row.id,name:row.name,email:row.email,username:'cliente',role:'client',active:false}});
  assert.equal(await auth.getSession(request),null);
});
test('Consulta can read confirmed planning but cannot simulate or export',async()=>{
  const state=await store.getState();await auth.getSession(new Request('https://capacity.test',{headers:{'oai-authenticated-user-id':'owner'}}));
  const route=await import('../app/api/simulate/route.ts'),period=state.demands.find(d=>d.type==='CHG');
  const response=await route.POST(new Request('https://capacity.test/api/simulate',{method:'POST',headers:{'content-type':'application/json','origin':'https://capacity.test','oai-authenticated-user-id':'client-viewer'},body:JSON.stringify({type:'CHG',start:period.start,end:period.end,required:2})}));
  assert.equal(response.status,403);
  const after=await store.getState();assert.equal(after.revision,state.revision);assert.equal(after.demands.length,state.demands.length);assert.equal(after.exceptions.length,state.exceptions.length);
});

test('export endpoint authenticates and permits reports only for operational profiles',async()=>{
  const state=await store.getState();await auth.getSession(new Request('https://capacity.test',{headers:{'oai-authenticated-user-id':'owner'}}));
  const route=await import('../app/api/export/route.ts');
  const anonymous=await route.GET(new Request('https://capacity.test/api/export?format=xlsx'));
  assert.equal(anonymous.status,401);
  const from=state.demands.map(d=>d.date).sort()[0],base=`https://capacity.test/api/export?from=${from}&to=${from}&format=`;
  const headers={'oai-authenticated-user-id':'client-report'};
  assert.equal((await route.GET(new Request(base+'xlsx',{headers}))).status,403);
  assert.equal((await route.GET(new Request(base+'pdf',{headers}))).status,403);
  const adminHeaders={'oai-authenticated-user-id':'owner'};
  const excel=await route.GET(new Request(base+'xlsx',{headers:adminHeaders}));assert.equal(excel.status,200);assert.ok(excel.headers.get('content-type').includes('spreadsheetml'));
  const xlsx=new Uint8Array(await excel.arrayBuffer()),text=new TextDecoder().decode(xlsx);assert.equal(xlsx[0],0x50);assert.equal(xlsx[1],0x4b);
  assert.ok(text.includes(state.employees[0].name));
  const pdf=await route.GET(new Request(base+'pdf',{headers:adminHeaders}));assert.equal(pdf.status,200);assert.ok((await pdf.text()).startsWith('%PDF-1.4'));
  assert.equal((await store.getState()).revision,state.revision);
});

const setupRequest=(body,headers={})=>new Request('https://capacity.test/api/setup',{method:'POST',headers:{'content-type':'application/json','origin':'https://capacity.test','x-capacity-local-setup':globalThis.__capacityTestEnv.CAPACITY_LOCAL_SETUP_TOKEN,...headers},body:JSON.stringify(body)});
const setupAccount={name:'Administrador teste',username:'admin-test',password:'Senha-inicial-segura-123'};
test('local login starts unauthenticated even in development and setup requires trusted context',async()=>{
  process.env.NODE_ENV='development';try{assert.equal(await auth.getSession(new Request('http://127.0.0.1:5173/api/session')),null);}finally{process.env.NODE_ENV='test';}
  const setupRoute=await import('../app/api/setup/route.ts');
  const denied=await setupRoute.POST(setupRequest(setupAccount,{'x-capacity-local-setup':'forged'}));assert.equal(denied.status,403);
  const result=await setupRoute.POST(setupRequest(setupAccount));assert.equal(result.status,200);const cookie=result.headers.get('set-cookie').split(';')[0];
  const request=new Request('https://capacity.test/api/session',{headers:{cookie}});assert.equal((await auth.getSession(request)).role,'admin');
  const second=await setupRoute.POST(setupRequest({...setupAccount,password:'Outra-senha-nao-autorizada'}));assert.equal(second.status,409);
  await auth.logout(new Request('https://capacity.test/api/auth',{method:'DELETE',headers:{cookie}}));assert.equal(await auth.getSession(request),null);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM users').get().count,1);
});
test('bootstrap is atomic for concurrent requests and preserves legacy local administrator id',async()=>{
  const original=await auth.getSession(new Request('https://capacity.test',{headers:{'oai-authenticated-user-id':'capacity-local-server'}}));
  const results=await Promise.allSettled([auth.bootstrap(setupRequest(setupAccount)),auth.bootstrap(setupRequest({...setupAccount,username:'second-admin'}))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  const row=sqlite.prepare('SELECT * FROM users').get();assert.equal(row.id,original.id);assert.equal(row.role,'admin');assert.ok(row.password_hash);assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM users').get().count,1);
});
test('bootstrap permits the hosted owner and never overwrites an existing password account',async()=>{
  const ownerRequest=setupRequest(setupAccount,{'x-capacity-local-setup':'','oai-authenticated-user-id':'hosted-owner'});
  const response=await auth.bootstrap(ownerRequest);assert.equal(response.status,200);const owner=await response.json();
  await auth.manageUser(owner.session,{entity:'user',action:'upsert',revision:1,data:{name:'Consulta existente',email:'',username:'existing-client',password:'Senha-cliente-existente-123',role:'client',active:true}});
  const existing=sqlite.prepare("SELECT * FROM users WHERE username='existing-client'").get();
  await assert.rejects(auth.bootstrap(setupRequest({...setupAccount,username:'existing-client',password:'Senha-intrusa-nova-123'})),error=>error.status===409);
  assert.equal(sqlite.prepare("SELECT password_hash FROM users WHERE id=?").get(existing.id).password_hash,existing.password_hash);
});
test('Consulta API state includes confirmed titles and allocated people but hides internal notes',async()=>{
  const state=await store.getState();await auth.getSession(new Request('https://capacity.test',{headers:{'oai-authenticated-user-id':'owner'}}));
  const stateRoute=await import('../app/api/state/route.ts'),usersRoute=await import('../app/api/users/route.ts'),mutateRoute=await import('../app/api/mutate/route.ts');
  const headers={'oai-authenticated-user-id':'consulta-user'};
  const result=await(await stateRoute.GET(new Request('https://capacity.test/api/state',{headers}))).json();
  const demand=state.demands.find(d=>d.status==='confirmed'&&d.allocations.length),visible=result.state.demands.find(d=>d.id===demand.id);
  assert.equal(visible.title,demand.title);assert.equal(visible.code,demand.code);assert.equal(visible.start,demand.start);assert.deepEqual(visible.allocations,demand.allocations);assert.equal(visible.notes,'');assert.equal(visible.requester,'');assert.equal(result.state.audit,undefined);
  assert.equal((await usersRoute.GET(new Request('https://capacity.test/api/users',{headers}))).status,403);
  const denied=await mutateRoute.POST(new Request('https://capacity.test/api/mutate',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({entity:'employee',action:'delete',data:{id:state.employees[0].id},revision:0})}));assert.equal(denied.status,403);
});
test('team migration backs up SQLite and preserves user-created demands and existing audit',async()=>{
  await store.getState();const oldNames={ana:'Ana Souza',bruno:'Bruno Costa',carla:'Carla Oliveira',diego:'Diego Santos',elisa:'Elisa Martins'};
  for(const [id,name] of Object.entries(oldNames))sqlite.prepare('UPDATE employees SET name=? WHERE id=?').run(name,id);
  sqlite.prepare("UPDATE employees SET start_time='23:00',end_time='05:00',breaks='[]',weekly_hours=30,weekly_limit=40 WHERE id='elisa'").run();
  sqlite.prepare("UPDATE demands SET end=replace(end,'02:00:00','05:00:00') WHERE code='CHG-109'").run();sqlite.prepare("UPDATE allocations SET end=replace(end,'02:00:00','05:00:00') WHERE demand_id='chg-109'").run();
  sqlite.prepare("INSERT INTO demands SELECT 'real-demand','Teste','Demanda real',type,project,requester,priority,date,start,end,required,'planning','Observação real' FROM demands LIMIT 1").run();
  sqlite.prepare("INSERT INTO audit(id,at,actor,action,entity,before,after) VALUES('existing-audit','2026-10-19T12:00:00Z','Usuário','upsert','demand',NULL,'{\"id\":\"real-demand\",\"code\":\"Teste\"}')").run();
  const folder=mkdtempSync(path.join(tmpdir(),'capacity-migration-')),filename=path.join(folder,'capacity.sqlite');
  try{
    await backup(sqlite,filename);const {updateTeam}=await import('../scripts/update-team.mjs');
    const report=await updateTeam(filename);assert.equal(report.canApply,true);assert.equal(report.employees.length,5);assert.equal(report.demands.length,1);
    const applied=await updateTeam(filename,{apply:true,expectedRevision:0});assert.equal(applied.applied,true);assert.ok(existsSync(applied.backup));
    const db=new DatabaseSync(filename);try{assert.equal(db.prepare("SELECT notes FROM demands WHERE id='real-demand'").get().notes,'Observação real');assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE id='existing-audit'").get().count,1);assert.equal(db.prepare("SELECT name FROM employees WHERE id='elisa'").get().name,'Lucas Cordeiro');assert.equal(db.prepare('SELECT COUNT(*) AS count FROM demands').get().count,14);}finally{db.close();}
    assert.equal((await updateTeam(filename,{apply:true})).applied,false);
  }finally{const resolved=path.resolve(folder);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));assert.ok(path.basename(resolved).startsWith('capacity-migration-'));rmSync(resolved,{recursive:true,force:true});}
});
test('night-shift correction changes only Lucas journey, preserves every demand/account, backs up and is revision guarded',async()=>{
  await store.getState();sqlite.prepare("UPDATE employees SET start_time='17:00',end_time='02:00',weekly_hours=40 WHERE id='elisa'").run();
  sqlite.prepare("INSERT INTO users(id,name,email,role,active,created_at,username,password_hash) VALUES('preserved-account','Conta existente','','client',1,'2026-10-19T12:00:00Z','consulta-existente','test-fixture-hash')").run();
  const preserved={demands:sqlite.prepare('SELECT * FROM demands ORDER BY id').all(),allocations:sqlite.prepare('SELECT * FROM allocations ORDER BY id').all(),exceptions:sqlite.prepare('SELECT * FROM shift_exceptions ORDER BY id').all(),users:sqlite.prepare('SELECT * FROM users ORDER BY id').all(),otherEmployees:sqlite.prepare("SELECT * FROM employees WHERE id<>'elisa' ORDER BY id").all()};
  const folder=mkdtempSync(path.join(tmpdir(),'capacity-migration-')),filename=path.join(folder,'capacity.sqlite');
  try{
    await backup(sqlite,filename);const {updateNightShift}=await import('../scripts/update-night-shift.mjs');
    const report=await updateNightShift(filename);assert.equal(report.canApply,true);assert.equal(report.changed,true);assert.equal(report.employee.after.weeklyHours,30);assert.equal(report.employee.after.weeklyLimit,48);
    await assert.rejects(updateNightShift(filename,{apply:true,expectedRevision:5}),/revisão exata/);
    const applied=await updateNightShift(filename,{apply:true,expectedRevision:0});assert.equal(applied.applied,true);assert.equal(applied.newRevision,1);assert.ok(existsSync(applied.backup));
    const db=new DatabaseSync(filename);try{
      assert.deepEqual(db.prepare('SELECT * FROM demands ORDER BY id').all(),preserved.demands);assert.deepEqual(db.prepare('SELECT * FROM allocations ORDER BY id').all(),preserved.allocations);assert.deepEqual(db.prepare('SELECT * FROM shift_exceptions ORDER BY id').all(),preserved.exceptions);assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(),preserved.users);assert.deepEqual(db.prepare("SELECT * FROM employees WHERE id<>'elisa' ORDER BY id").all(),preserved.otherEmployees);
      const night=db.prepare("SELECT * FROM employees WHERE id='elisa'").get();assert.equal(night.start_time,'23:00');assert.equal(night.end_time,'05:00');assert.equal(night.weekly_hours,30);assert.equal(night.weekly_limit,48);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE entity='night-shift-migration'").get().count,1);
    }finally{db.close();}
    assert.equal((await updateNightShift(filename,{apply:true,expectedRevision:1})).applied,false);
  }finally{const resolved=path.resolve(folder);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));assert.ok(path.basename(resolved).startsWith('capacity-migration-'));rmSync(resolved,{recursive:true,force:true});}
});
