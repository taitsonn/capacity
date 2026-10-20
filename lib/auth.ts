import { z } from 'zod';
import { ApiError, getDatabase, getState, atomicWrite } from './store';
import type { Role, Session } from './types';
import { env } from 'cloudflare:workers';

type UserRow={id:string;name:string;email:string;role:Role;username:string|null;password_hash:string|null;platform_id:string|null;active:number;created_at:string};
const cookieName='capacity_session';
const encoder=new TextEncoder();
const hex=(v:ArrayBuffer|Uint8Array)=>Array.from(v instanceof Uint8Array?v:new Uint8Array(v),x=>x.toString(16).padStart(2,'0')).join('');
async function digest(value:string){return hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));}
export async function hashPassword(password:string,salt=hex(crypto.getRandomValues(new Uint8Array(16)))){
  const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:encoder.encode(salt),iterations:100000,hash:'SHA-256'},key,256);
  return `pbkdf2-sha256$100000$${salt}$${hex(bits)}`;
}
async function verifyPassword(password:string,stored:string){
  const parts=stored.split('$');if(parts.length!==4||parts[0]!=='pbkdf2-sha256'||parts[1]!=='100000')return false;
  const actual=await hashPassword(password,parts[2]);let diff=actual.length^stored.length;for(let i=0;i<actual.length;i++)diff|=actual.charCodeAt(i)^(stored.charCodeAt(i)||0);return diff===0;
}
function cookie(request:Request){return request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);}
function asSession(row:UserRow):Session{return {id:row.id,name:row.name,email:row.email,role:row.role};}

/** Hosted identity comes exclusively from the platform's trusted reverse proxy. */
export async function getSession(request:Request):Promise<Session|null>{
  const db=getDatabase(),token=cookie(request);
  if(token&&/^[a-f0-9]{64}$/.test(token)){
    const user=await db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1').bind(await digest(token),new Date().toISOString()).first<UserRow>();
    if(user)return asSession(user);
  }
  const platformId=request.headers.get('oai-authenticated-user-id');
  if(!platformId)return null;
  let user=await db.prepare('SELECT * FROM users WHERE platform_id=?').bind(platformId).first<UserRow>();
  if(!user){
    const id=crypto.randomUUID(),email=request.headers.get('oai-authenticated-user-email')?.slice(0,160)||'';
    let fullName=request.headers.get('oai-authenticated-user-full-name')||request.headers.get('oai-authenticated-user-name')||'';
    if(request.headers.get('oai-authenticated-user-full-name-encoding')==='percent-encoded-utf-8'){try{fullName=decodeURIComponent(fullName);}catch{fullName='';}}
    const name=fullName.slice(0,160)||email||(platformId==='capacity-local-development'?'Administrador local':'Usuário da plataforma');
    await db.prepare("INSERT OR IGNORE INTO users(id,platform_id,name,email,role,active,created_at) SELECT ?,?,?,?,CASE WHEN COUNT(*)=0 THEN 'admin' ELSE 'client' END,1,? FROM users").bind(id,platformId,name,email,new Date().toISOString()).run();
    user=await db.prepare('SELECT * FROM users WHERE platform_id=?').bind(platformId).first<UserRow>();
  }
  return user?.active?asSession(user):null;
}
export async function requireSession(request:Request){const session=await getSession(request);if(!session)throw new ApiError('Entre com seu usuário para acessar a plataforma.',401);return session;}
export function requireAdministrativeAccess(session:Session){if(session.role!=='admin')throw new ApiError('Esta funcionalidade exige perfil de administrador.',403);}
export function denyConsulta(session:Session){if(session.role==='client')throw new ApiError('O perfil Consulta permite somente visão geral e calendário.',403);}
export function assertSameOrigin(request:Request){
  const origin=request.headers.get('origin');if(origin){let originHost='';try{originHost=new URL(origin).host;}catch{throw new ApiError('Origem inválida.',403);}
    const requestHost=request.headers.get('host')||new URL(request.url).host;
    if(originHost!==requestHost&&originHost!==new URL(request.url).host)throw new ApiError('A operação deve ser realizada na própria aplicação.',403);
  }
  if(request.method==='POST'&&!request.headers.get('content-type')?.includes('application/json'))throw new ApiError('Envie os dados como application/json.',415);
}
export async function login(request:Request){
  assertSameOrigin(request);
  const input=z.object({username:z.string().trim().toLowerCase().min(1).max(160),password:z.string().min(1).max(200)}).strict().parse(await request.json());
  const db=getDatabase(),now=new Date(),key=await digest(`${input.username}|${request.headers.get('cf-connecting-ip')||'local'}`);
  const attempts=await db.prepare('SELECT failures,window_start FROM login_attempts WHERE key=?').bind(key).first<{failures:number;window_start:string}>();
  const activeWindow=attempts&&now.getTime()-Date.parse(attempts.window_start)<15*60*1000;
  if(activeWindow&&attempts.failures>=8)throw new ApiError('Muitas tentativas. Aguarde 15 minutos para tentar novamente.',429);
  const user=await db.prepare('SELECT * FROM users WHERE username=? AND active=1').bind(input.username).first<UserRow>();
  // Always derive a hash, including an unknown username, to reduce timing disclosure.
  const valid=await verifyPassword(input.password,user?.password_hash||'pbkdf2-sha256$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000');
  if(!valid||!user){
    await db.prepare('INSERT INTO login_attempts(key,failures,window_start) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,window_start=excluded.window_start').bind(key,activeWindow?attempts.failures+1:1,activeWindow?attempts.window_start:now.toISOString()).run();
    throw new ApiError('Usuário ou senha inválidos.',401);
  }
  const token=hex(crypto.getRandomValues(new Uint8Array(32))),expires=new Date(now.getTime()+8*60*60*1000).toISOString();
  await db.batch([db.prepare('DELETE FROM login_attempts WHERE key=?').bind(key),db.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now.toISOString()),db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await digest(token),user.id,expires)]);
  return sessionResponse(request,asSession(user),token);
}
function sessionResponse(request:Request,session:Session,token:string){const secure=new URL(request.url).protocol==='https:'?'; Secure':'';return Response.json({session},{headers:{'Cache-Control':'no-store','Set-Cookie':`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`}});}
function isTrustedLocalSetup(request:Request){const token=(env as unknown as {CAPACITY_LOCAL_SETUP_TOKEN?:string}).CAPACITY_LOCAL_SETUP_TOKEN;return !!token&&request.headers.get('x-capacity-local-setup')===token;}
async function setupEligibility(request:Request,knownSession?:Session|null){
  const db=getDatabase(),local=isTrustedLocalSetup(request),session=knownSession===undefined?await getSession(request):knownSession;
  const count=await db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN role='admin' AND active=1 AND password_hash IS NOT NULL THEN 1 ELSE 0 END) AS password_admins FROM users").first<{total:number;password_admins:number|null}>();
  if(count?.password_admins)return {needsSetup:false,canSetup:false,candidate:null as UserRow|null,empty:false,local:false};
  if(!count?.total)return {needsSetup:true,canSetup:local,candidate:null as UserRow|null,empty:true,local};
  let candidate:UserRow|null=null;
  if(local)candidate=await db.prepare("SELECT * FROM users WHERE platform_id IN ('capacity-local-server','capacity-local-development') AND role='admin' AND active=1 AND password_hash IS NULL ORDER BY created_at LIMIT 1").first<UserRow>();
  if(!candidate&&session?.role==='admin'&&request.headers.get('oai-authenticated-user-id'))candidate=await db.prepare("SELECT * FROM users WHERE id=? AND role='admin' AND active=1 AND password_hash IS NULL").bind(session.id).first<UserRow>();
  return {needsSetup:!!candidate,canSetup:!!candidate,candidate,empty:false,local};
}
export async function getSetupState(request:Request,session?:Session|null){const status=await setupEligibility(request,session);return {needsSetup:status.needsSetup,canSetup:status.canSetup};}
export async function bootstrap(request:Request){
  assertSameOrigin(request);
  const input=z.object({name:z.string().trim().min(2).max(160),username:z.string().trim().toLowerCase().regex(/^[a-z0-9._@+-]{3,160}$/),password:z.string().min(12,'A senha deve ter pelo menos 12 caracteres.').max(200)}).strict().parse(await request.json());
  const eligibility=await setupEligibility(request);if(!eligibility.needsSetup)throw new ApiError('A configuração inicial já foi concluída.',409);if(!eligibility.canSetup)throw new ApiError('A configuração inicial exige acesso local confiável ou o administrador autenticado da plataforma.',403);
  const state=await getState(),db=getDatabase(),id=eligibility.candidate?.id||crypto.randomUUID(),now=new Date().toISOString(),passwordHash=await hashPassword(input.password),token=hex(crypto.getRandomValues(new Uint8Array(32)));
  const guard=eligibility.empty?'NOT EXISTS(SELECT 1 FROM users)':"EXISTS(SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1 AND password_hash IS NULL)";
  const queries=[db.prepare(`UPDATE app_meta SET revision=CASE WHEN ${guard} AND NOT EXISTS(SELECT 1 FROM users WHERE role='admin' AND active=1 AND password_hash IS NOT NULL) THEN revision ELSE NULL END WHERE id='main'`).bind(...(eligibility.empty?[]:[id]))];
  if(eligibility.candidate)queries.push(db.prepare('UPDATE users SET name=?,username=?,password_hash=? WHERE id=?').bind(input.name,input.username,passwordHash,id));
  else queries.push(db.prepare("INSERT INTO users(id,platform_id,username,password_hash,name,email,role,active,created_at) VALUES(?,NULL,?,?,?,'','admin',1,?)").bind(id,input.username,passwordHash,input.name,now));
  queries.push(db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await digest(token),id,new Date(Date.now()+8*60*60*1000).toISOString()));
  await atomicWrite(state.revision??0,queries,{actor:input.name,entity:'user',action:'bootstrap',after:JSON.stringify({id,name:input.name,username:input.username,role:'admin'})});
  return sessionResponse(request,{id,name:input.name,email:eligibility.candidate?.email||'',role:'admin'},token);
}
export async function logout(request:Request){assertSameOrigin(request);const token=cookie(request);if(token)await getDatabase().prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(token)).run();return Response.json({session:null},{headers:{'Cache-Control':'no-store','Set-Cookie':`${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`}});}
export async function listUsers(session:Session){if(session.role!=='admin')throw new ApiError('Esta consulta exige administrador.',403);return (await getDatabase().prepare('SELECT id,name,email,role,username,active,created_at AS createdAt,platform_id IS NOT NULL AS platformAccount FROM users ORDER BY created_at').all()).results;}
const userSchema=z.object({id:z.string().max(100).optional(),name:z.string().trim().min(2).max(160),email:z.string().trim().max(160).refine(v=>v===''||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),'E-mail inválido.'),username:z.string().trim().toLowerCase().regex(/^[a-z0-9._@+-]{3,160}$/).optional(),password:z.string().min(12,'A senha deve ter pelo menos 12 caracteres.').max(200).optional(),role:z.enum(['admin','client']),active:z.boolean().default(true)}).strict();
export async function manageUser(session:Session,payload:unknown){
  if(session.role!=='admin')throw new ApiError('Esta operação exige administrador.',403);
  const input=z.object({entity:z.literal('user'),action:z.enum(['upsert','delete']),data:z.unknown(),revision:z.number().int().nonnegative()}).strict().parse(payload);
  if(input.action==='delete')throw new ApiError('Inative o usuário para preservar o histórico de acesso.');
  const data=userSchema.parse(input.data),db=getDatabase(),state=await getState();if(input.revision!==state.revision)throw new ApiError('O planejamento foi atualizado. Recarregue antes de salvar.',409);
  const before=data.id?await db.prepare('SELECT * FROM users WHERE id=?').bind(data.id).first<UserRow>():null;
  if(data.id&&!before)throw new ApiError('Usuário não encontrado.',404);
  if(!before&&(!data.username||!data.password))throw new ApiError('Informe usuário e senha para criar um acesso.');
  if(before?.id===session.id&&(!data.active||data.role!=='admin'))throw new ApiError('Você não pode remover seu próprio acesso administrativo.');
  if(before?.role==='admin'&&(!data.active||data.role!=='admin')){
    const admins=await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1 AND id<>?").bind(before.id).first<{count:number}>();if(!admins?.count)throw new ApiError('Mantenha pelo menos um administrador ativo.');
  }
  const userId=before?.id||crypto.randomUUID(),passwordHash=data.password?await hashPassword(data.password):before?.password_hash||null;
  const query=db.prepare('INSERT INTO users(id,platform_id,username,password_hash,name,email,role,active,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash,name=excluded.name,email=excluded.email,role=excluded.role,active=excluded.active').bind(userId,before?.platform_id||null,data.username||before?.username||null,passwordHash,data.name,data.email,data.role,Number(data.active),before?.created_at||new Date().toISOString());
  const safe=(u:Partial<UserRow>)=>({id:u.id,name:u.name,email:u.email,role:u.role,username:u.username,active:!!u.active});
  await atomicWrite(input.revision,[query,...(data.active&&!data.password?[]:[db.prepare('DELETE FROM sessions WHERE user_id=?').bind(userId)])],{actor:session.name,entity:'user',action:'upsert',before:before?JSON.stringify(safe(before)):undefined,after:JSON.stringify(safe({id:userId,name:data.name,email:data.email,role:data.role,username:data.username,active:Number(data.active)}))});
}
