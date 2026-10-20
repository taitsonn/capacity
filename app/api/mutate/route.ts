import { requireSession,assertSameOrigin,manageUser } from '@/lib/auth';
import { mutate,getState,redactState } from '@/lib/store';
import { routeError } from '../utils';
export async function POST(request:Request){try{assertSameOrigin(request);const session=await requireSession(request),payload:unknown=await request.json();if(payload!==null&&typeof payload==='object'&&'entity' in payload&&payload.entity==='user')await manageUser(session,payload);else await mutate(session,payload);return Response.json({state:redactState(await getState(),session),session},{headers:{'Cache-Control':'no-store'}});}catch(error){return routeError(error);}}
