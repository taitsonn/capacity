import type { State, DemandType } from './types';
import { capacity } from './engine';
import { typeCapacity } from './type-capacity';
import { dateAt } from './time';

type Cell = string | number;
export type Sheet = { name: string; rows: Cell[][] };
const enc = new TextEncoder();
const xml = (x: Cell) => String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
const col = (n:number):string => n < 26 ? String.fromCharCode(65+n) : col(Math.floor(n/26)-1)+col(n%26);
const crcTable = Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc(bytes:Uint8Array){let n=0xffffffff;for(const b of bytes)n=crcTable[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
function join(parts:Uint8Array[]){const a=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let o=0;for(const p of parts){a.set(p,o);o+=p.length;}return a;}
function zip(files:{name:string;data:string}[]){
  const pieces:Uint8Array[]=[],central:Uint8Array[]=[];let offset=0;
  for(const f of files){const name=enc.encode(f.name),data=enc.encode(f.data),sum=crc(data),head=new Uint8Array(30+name.length),v=new DataView(head.buffer);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint32(14,sum,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,name.length,true);head.set(name,30);pieces.push(head,data);
    const c=new Uint8Array(46+name.length),cv=new DataView(c.buffer);cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x800,true);cv.setUint32(16,sum,true);cv.setUint32(20,data.length,true);cv.setUint32(24,data.length,true);cv.setUint16(28,name.length,true);cv.setUint32(42,offset,true);c.set(name,46);central.push(c);offset+=head.length+data.length;
  }
  const directory=join(central),end=new Uint8Array(22),ev=new DataView(end.buffer);ev.setUint32(0,0x06054b50,true);ev.setUint16(8,files.length,true);ev.setUint16(10,files.length,true);ev.setUint32(12,directory.length,true);ev.setUint32(16,offset,true);return join([...pieces,directory,end]);
}
export function makeXlsx(sheets:Sheet[]){
  const files=[{name:'[Content_Types].xml',data:`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`},
  {name:'_rels/.rels',data:'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'},
  {name:'xl/workbook.xml',data:`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s,i)=>`<sheet name="${xml(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`},
  {name:'xl/_rels/workbook.xml.rels',data:`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}</Relationships>`}];
  sheets.forEach((s,i)=>files.push({name:`xl/worksheets/sheet${i+1}.xml`,data:`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="20" width="26" customWidth="1"/></cols><sheetData>${s.rows.map((row,j)=>`<row r="${j+1}">${row.map((c,k)=>typeof c==='number'&&Number.isFinite(c)?`<c r="${col(k)}${j+1}"><v>${c}</v></c>`:`<c r="${col(k)}${j+1}" t="inlineStr"><is><t xml:space="preserve">${xml(c)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`}));
  return zip(files);
}
const statuses:Record<string,string>={requested:'Solicitada',planning:'Em planejamento',confirmed:'Confirmada',running:'Em execução',completed:'Concluída',cancelled:'Cancelada'};
export function reportSheets(state:State,from:string,to:string,filters:{type?:string;status?:string}={}):Sheet[]{
  const selectedType=['TSD','BSIM','CHG'].includes(filters.type||'')?filters.type as DemandType:undefined;
  const typed=selectedType?typeCapacity(state,from,to,selectedType):undefined;
  const m=typed||capacity(state,from,to),fmt=(iso:string)=>new Intl.DateTimeFormat('pt-BR',{timeZone:state.settings.timezone,dateStyle:'short',timeStyle:'short'}).format(new Date(iso));
  const budgetRows:Cell[][]=selectedType==='CHG'&&typed?[
    ['Capacidade semanal planejável (h)',typed.planningTotal],['Saldo semanal planejável (h)',typed.planningFree],['Escopo do orçamento semanal','Semanas completas de início; a cota extraordinária depende de data, aprovação e descanso.']
  ]:[];
  const weekly:Sheet[]=selectedType==='CHG'&&typed?[{name:'Orçamento semanal CHG',rows:[['Início da semana','Fim da semana','Regular (h)','Cota extra total (h)','Cota extra utilizada (h)','Cota extra restante (h)','Total planejável (h)','Comprometida na semana de início (h)','Saldo planejável (h)'],...typed.weeklyPlanning.map(w=>[w.weekStart,w.weekEnd,w.regular,w.extraQuota,w.extraActivated,w.extraQuotaRemaining,w.total,w.committed,w.free])]}]:[];
  return [{name:'Resumo',rows:[['Capacity Manager','Gestão de capacidade operacional'],['Período',`${from} a ${to}`],['Tipo de capacidade',selectedType||'Todos'],['Fuso',state.settings.timezone],['Capacidade confirmada (h)',m.confirmed],['Comprometida (h)',m.committed],['Livre (h)',m.free],['Potencial extraordinária (h)',m.potential],['Reservas (h)',m.reserved],['Déficit (h)',m.deficit],['Ocupação (%)',m.occupancy],...budgetRows,['Critério','Todos os compromissos na janela elegível ao tipo consomem capacidade.']]},...weekly,
  {name:'Projeção diária',rows:[['Data','Confirmada (h)','Comprometida (h)','Livre (h)','Reservas (h)','Déficit (h)'],...m.daily.map(d=>[d.date,d.confirmed,d.committed,d.free,d.reserved,d.deficit])]},
  {name:'Alocações',rows:[['Código','Demanda','Tipo','Status','Colaborador','Início','Término'],...state.demands.filter(d=>(!filters.type||d.type===filters.type)&&(!filters.status||d.status===filters.status)&&dateAt(d.end,state.settings.timezone)>=from&&dateAt(d.start,state.settings.timezone)<=to).flatMap(d=>d.allocations.length?d.allocations.map(a=>[d.code,d.title,d.type,statuses[d.status],state.employees.find(e=>e.id===a.employeeId)?.name||a.employeeId,fmt(a.start),fmt(a.end)]):[[d.code,d.title,d.type,statuses[d.status],'Sem alocação',fmt(d.start),fmt(d.end)]])]}];
}
// Self-contained paginated PDF using WinAnsi Helvetica; data are escaped as hexadecimal text.
export function makePdf(sheets:Sheet[]){
  const lines=sheets.flatMap(s=>[s.name.toUpperCase(),...s.rows.map(r=>r.join('  |  ')),'']).flatMap(line=>{
    const result:string[]=[];let text=line;while(text.length>100){let at=text.lastIndexOf(' ',100);if(at<20)at=100;result.push(text.slice(0,at));text=text.slice(at).trimStart();}result.push(text);return result;
  });
  const pages:string[][]=[];for(let i=0;i<lines.length;i+=47)pages.push(lines.slice(i,i+47));
  const objects:string[]=['','', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
  const hex=(s:string)=>Array.from(s.normalize('NFC')).map(c=>{const n=c.charCodeAt(0);return (n<=255?n:c==='—'||c==='–'?45:63).toString(16).padStart(2,'0');}).join('');
  const pageIds:number[]=[];
  pages.forEach((page,i)=>{const pageId=objects.length+1,streamId=pageId+1;pageIds.push(pageId);objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`);const stream=`BT /F1 15 Tf 40 800 Td <${hex('Capacity Manager')}> Tj /F1 9 Tf 0 -24 Td 15 TL ${page.map(l=>`<${hex(l)}> Tj T*`).join('\n')} ET BT /F1 8 Tf 40 22 Td <${hex(`Relatório operacional | Página ${i+1}/${pages.length}`)}> Tj ET`;objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);});
  objects[0]='<< /Type /Catalog /Pages 2 0 R >>';objects[1]=`<< /Type /Pages /Kids [${pageIds.map(p=>`${p} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((s,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${s}\nendobj\n`;});const start=pdf.length;pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;return enc.encode(pdf);
}
