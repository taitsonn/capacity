import { bootstrap,getSetupState } from '@/lib/auth';
import { routeError } from '../utils';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{return Response.json(await getSetupState(request),{headers:{'Cache-Control':'no-store'}});}catch(error){return routeError(error);}}
export async function POST(request:Request){try{return await bootstrap(request);}catch(error){return routeError(error);}}
