import { requireSession } from '@/lib/auth';
import { getState,redactState } from '@/lib/store';
import { routeError } from '../utils';
export async function GET(request:Request){try{const session=await requireSession(request);return Response.json({state:redactState(await getState(),session),session},{headers:{'Cache-Control':'no-store'}});}catch(error){return routeError(error);}}
