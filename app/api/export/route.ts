import { requireSession,denyConsulta } from '@/lib/auth';
import { getState, redactState, ApiError } from '@/lib/store';
import { reportSheets, makeXlsx, makePdf } from '@/lib/reports';
import { addDays } from '@/lib/time';
import { routeError } from '../utils';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  try {
    const session=await requireSession(request);denyConsulta(session);const state=redactState(await getState(),session),url=new URL(request.url);
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:state.settings.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const from=url.searchParams.get('from')||today,to=url.searchParams.get('to')||addDays(from,6),format=url.searchParams.get('format')||'xlsx';
    if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||to<from||to>addDays(from,365))throw new ApiError('Informe um período válido de até 366 dias.',422);
    try{addDays(from,0);addDays(to,0);}catch{throw new ApiError('As datas do relatório são inválidas.',422);}
    if(!['xlsx','pdf','csv'].includes(format))throw new ApiError('Formato de exportação inválido.',422);
    const employee=url.searchParams.get('employee'),team=url.searchParams.get('team'),scoped=Boolean(employee||team);
    const employees=state.employees.filter(e=>(!employee||e.id===employee)&&(!team||e.team===team)),ids=new Set(employees.map(e=>e.id));
    const reportState={...state,employees,exceptions:state.exceptions.filter(e=>ids.has(e.employeeId)),demands:state.demands.filter(d=>!scoped||d.allocations.some(a=>ids.has(a.employeeId))).map(d=>{const allocations=d.allocations.filter(a=>ids.has(a.employeeId));return {...d,allocations,required:scoped?Math.min(d.required,Math.max(1,new Set(allocations.map(a=>a.employeeId)).size)):d.required};})};
    const sheets=reportSheets(reportState,from,to,{type:url.searchParams.get('type')||undefined,status:url.searchParams.get('status')||undefined}),headers:Record<string,string>={'Cache-Control':'no-store','Content-Disposition':`attachment; filename="capacity-manager-${from}-${to}.${format}"`};
    if(format==='csv'){
      const safe=(v:string|number)=>typeof v==='string'&&/^[=+@\-\t\r]/.test(v)?`'${v}`:String(v);
      const csv='\uFEFF'+sheets[2].rows.map(r=>r.map(v=>'"'+safe(v).replaceAll('"','""')+'"').join(';')).join('\r\n');
      return new Response(csv,{headers:{...headers,'Content-Type':'text/csv; charset=utf-8'}});
    }
    const bytes=format==='pdf'?makePdf(sheets):makeXlsx(sheets);
    return new Response(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer,{headers:{...headers,'Content-Type':format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}});
  }catch(error){return routeError(error);}
}

