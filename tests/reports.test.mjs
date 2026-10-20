import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
registerHooks({resolve(specifier,context,next){if(specifier.startsWith('.')){const u=new URL(specifier,context.parentURL);if(!/\.[a-z]+$/i.test(u.pathname)&&existsSync(fileURLToPath(u.href+'.ts')))return next(u.href+'.ts',context);}return next(specifier,context);}});
const {makeXlsx,makePdf,reportSheets}=await import('../lib/reports.ts');
test('relatório filtrado CHG não apresenta as horas diurnas como capacidade de mudança',async()=>{
 const {makeSeed}=await import('../lib/seed.ts');const state=makeSeed(new Date('2026-10-19T12:00:00Z'));state.demands=[];state.exceptions=[];
 const sheets=reportSheets(state,'2026-10-19','2026-10-25',{type:'CHG'});const rows=new Map(sheets[0].rows.map(row=>[row[0],row[1]]));
 assert.equal(rows.get('Tipo de capacidade'),'CHG');assert.equal(rows.get('Capacidade confirmada (h)'),30);assert.equal(rows.get('Livre (h)'),30);assert.equal(rows.get('Capacidade semanal planejável (h)'),54);assert.equal(rows.get('Saldo semanal planejável (h)'),54);
 const weekly=sheets.find(sheet=>sheet.name==='Orçamento semanal CHG');assert.deepEqual(weekly.rows[1],['2026-10-19','2026-10-25',30,24,0,24,54,0,54]);
});
test('relatório CHG não soma uma escala extraordinária novamente ao orçamento semanal',async()=>{
 const {makeSeed}=await import('../lib/seed.ts');const state=makeSeed(new Date('2026-10-19T12:00:00Z'));state.demands=[];state.exceptions=[{id:'report-extra',employeeId:'ana',date:'2026-10-24',kind:'extra',startTime:'23:00',endTime:'05:00',approved:true}];
 const sheets=reportSheets(state,'2026-10-19','2026-10-25',{type:'CHG'}),rows=new Map(sheets[0].rows.map(row=>[row[0],row[1]]));
 assert.equal(rows.get('Capacidade confirmada (h)'),36);assert.equal(rows.get('Capacidade semanal planejável (h)'),54);assert.equal(rows.get('Saldo semanal planejável (h)'),54);
 assert.deepEqual(sheets.find(sheet=>sheet.name==='Orçamento semanal CHG').rows[1],['2026-10-19','2026-10-25',30,24,6,18,54,0,54]);
});
test('Excel uses valid ZIP/OpenXML with numeric cells and safe inline strings',()=>{
 const data=makeXlsx([{name:'Resumo',rows:[['Capacidade','Horas'],['João & ação',6],['=HYPERLINK("bad")',3]]}]),view=new DataView(data.buffer);assert.equal(view.getUint32(0,true),0x04034b50);
 const files=new Map();let at=0;while(view.getUint32(at,true)===0x04034b50){const size=view.getUint32(at+18,true),nameSize=view.getUint16(at+26,true),extra=view.getUint16(at+28,true),name=new TextDecoder().decode(data.slice(at+30,at+30+nameSize)),start=at+30+nameSize+extra;files.set(name,new TextDecoder().decode(data.slice(start,start+size)));at=start+size;}
 assert.equal(files.size,5);assert.ok(files.has('[Content_Types].xml'));const sheet=files.get('xl/worksheets/sheet1.xml');assert.ok(sheet.includes('João &amp; ação'));assert.ok(sheet.includes('<v>6</v>'));assert.ok(sheet.includes('t="inlineStr"'));assert.ok(!sheet.includes('<f>'));assert.equal(view.getUint32(data.length-22,true),0x06054b50);
});
test('PDF paginates rows and provides consistent byte offsets',()=>{
 const pdf=new TextDecoder().decode(makePdf([{name:'Projeção',rows:Array.from({length:100},(_,i)=>[`Informação ${i}`,i])}]));assert.ok(pdf.startsWith('%PDF-1.4'));assert.ok(pdf.includes('/Count 3'));const offset=Number(pdf.match(/startxref\n(\d+)/)[1]);assert.equal(pdf.slice(offset,offset+4),'xref');for(const m of pdf.matchAll(/(\d{10}) 00000 n/g)){const start=Number(m[1]);assert.match(pdf.slice(start,start+20),/^\d+ 0 obj/);}assert.ok(pdf.endsWith('%%EOF'));
});
