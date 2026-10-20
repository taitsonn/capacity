import { z } from 'zod';
import { requireSession,assertSameOrigin,denyConsulta } from '@/lib/auth';
import { getState } from '@/lib/store';
import { simulate } from '@/lib/engine';
import { routeError } from '../utils';
const proposal=z.object({type:z.enum(['TSD','BSIM','CHG']),start:z.string().datetime({offset:true}),end:z.string().datetime({offset:true}),required:z.number().int().min(1).max(1000)}).strict().refine(v=>Date.parse(v.end)>Date.parse(v.start),'O fim deve ser posterior ao início.');
export async function POST(request:Request){try{assertSameOrigin(request);const session=await requireSession(request);denyConsulta(session);const input=proposal.parse(await request.json()),state=await getState();return Response.json(simulate(state,input),{headers:{'Cache-Control':'no-store'}});}catch(error){return routeError(error);}}
