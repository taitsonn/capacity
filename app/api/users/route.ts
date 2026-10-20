import { requireSession,listUsers } from '@/lib/auth';
import { routeError } from '../utils';
export async function GET(request:Request){try{return Response.json({users:await listUsers(await requireSession(request))},{headers:{'Cache-Control':'no-store'}});}catch(error){return routeError(error);}}
