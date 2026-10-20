import { getSession,getSetupState } from '@/lib/auth';
import { routeError } from '../utils';
export async function GET(request:Request){try{const session=await getSession(request);return Response.json({session,...await getSetupState(request,session)},{headers:{'Cache-Control':'no-store'}});}catch(error){return routeError(error);}}
