import type { State, Employee, Demand, DemandStatus, DemandType } from './types';
// @ts-ignore -- explicit extension supports Node's built-in TypeScript test runner.
import { zoned } from './time.ts';

export const defaultSettings:State['settings']={timezone:'America/Sao_Paulo',restHours:11,nightStart:'23:00',nightEnd:'05:00',weekStartsOn:1,comfortableThreshold:85,saturationThreshold:100,clientShowNames:true,clientShowDetails:true};
function add(date:string,days:number){const d=new Date(`${date}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
function local(date:string,time:string){return zoned(date,time,'America/Sao_Paulo');}

/** Demonstration data is inserted once. User edits are never overwritten on reload. */
export function makeSeed(now=new Date()):State {
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const weekday=new Date(`${today}T12:00:00Z`).getUTCDay();
  const monday=add(today,-((weekday+6)%7));
  const employees:Employee[]=[
    ['ana','OP-001','Marcelo','Analista'],['bruno','OP-002','Lizzie','Analista'],
    ['carla','OP-003','Lucas Telesi','Analista'],['diego','OP-004','Tatiane Ramos','Ponto focal'],
    ['elisa','OP-005','Lucas Cordeiro','Analista'],
  ].map(([id,code,name,role],i)=>({id,code,name,role,team:'Operações',journey:i===4?'night':'day',startTime:i===4?'23:00':'09:00',endTime:i===4?'05:00':'18:00',weekdays:[1,2,3,4,5],breaks:i===4?[{start:'22:00',end:'23:00'}]:[{start:'12:00',end:'13:00'}],weeklyHours:i===4?30:40,weeklyLimit:48,eligibleNight:i!==4,maxExtraNights:i===4?0:1,active:true}));
  const demands:Demand[]=[];
  function demand(code:string,title:string,type:DemandType,day:number,startTime:string,endTime:string,people:string[],status:DemandStatus='confirmed',required=people.length||1){
    const date=add(monday,day),endDate=endTime<=startTime?add(date,1):date;
    const id=code.toLowerCase(),start=local(date,startTime),end=local(endDate,endTime);
    demands.push({id,code,title,type,project:type==='CHG'?'Infraestrutura':'Operação contínua',requester:'Equipe de tecnologia',priority:type==='CHG'?'high':'medium',date,start,end,required,status,notes:status==='planning'?'Aguardando confirmação de capacidade.':'',allocations:people.map(employeeId=>({id:`${id}-${employeeId}`,employeeId,start,end}))});
  }
  demand('BSIM-101','Monitoramento de serviços','BSIM',0,'09:00','12:00',['carla']);
  demand('TSD-102','Revisão de acessos críticos','TSD',0,'13:00','16:00',['ana','bruno']);
  demand('BSIM-103','Acompanhamento de integrações','BSIM',1,'09:00','12:00',['diego']);
  demand('CHG-104','Atualização de ambiente produtivo','CHG',1,'23:00','02:00',['elisa']);
  demand('TSD-105','Análise de incidentes recorrentes','TSD',2,'09:00','12:00',['bruno','carla']);
  demand('CHG-106','Validação extraordinária de rede','CHG',2,'23:00','05:00',['ana']);
  demand('BSIM-107','Estabilização pós-mudança','BSIM',3,'16:00','18:00',['ana']);
  demand('TSD-108','Preparação de relatório operacional','TSD',3,'13:00','17:00',['diego']);
  demand('CHG-109','Validação de replicação','CHG',4,'23:00','02:00',['elisa']);
  demand('CHG-110','Manutenção extraordinária de sábado','CHG',5,'23:00','02:00',['bruno']);
  demand('CHG-111','Expansão de infraestrutura','CHG',6,'23:00','05:00',[],'planning',3);
  demand('BSIM-112','Acompanhamento da nova frente','BSIM',7,'09:00','12:00',['carla'],'planning',2);
  demand('TSD-113','Diagnóstico de desempenho','TSD',8,'13:00','17:00',['ana','diego'],'planning',2);
  return {employees,demands,exceptions:[
    {id:'ex-ana-wed',employeeId:'ana',date:add(monday,2),kind:'override',startTime:'09:00',endTime:'12:00',approved:true,note:'Ajuste de jornada anterior à atuação noturna.'},
    {id:'ex-ana-thu',employeeId:'ana',date:add(monday,3),kind:'override',startTime:'16:00',endTime:'18:00',approved:true,note:'Retorno após 11 horas de descanso.'},
    {id:'ex-ana-night',employeeId:'ana',date:add(monday,2),kind:'extra',startTime:'23:00',endTime:'05:00',approved:true,note:'Escala extraordinária aprovada.'},
    {id:'ex-bruno-sat',employeeId:'bruno',date:add(monday,5),kind:'extra',startTime:'23:00',endTime:'05:00',approved:true,note:'Escala extraordinária do fim de semana.'},
  ],settings:{...defaultSettings},revision:0,audit:[]};
}
