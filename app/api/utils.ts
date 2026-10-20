import { ZodError } from 'zod';
import { ApiError } from '@/lib/store';
export function routeError(error:unknown){
  if(error instanceof ApiError)return Response.json({error:error.message,issues:error.issues},{status:error.status,headers:{'Cache-Control':'no-store'}});
  if(error instanceof ZodError)return Response.json({error:'Revise os campos informados.',issues:error.issues.map(i=>({code:'INPUT',message:`${i.path.join('.')}: ${i.message}`}))},{status:422,headers:{'Cache-Control':'no-store'}});
  if(error instanceof SyntaxError)return Response.json({error:'O corpo da requisição deve ser JSON válido.'},{status:400});
  console.error('Capacity Manager API:',error);
  return Response.json({error:'Não foi possível concluir a operação. Verifique as migrações do banco e tente novamente.'},{status:500,headers:{'Cache-Control':'no-store'}});
}
