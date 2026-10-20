import { login,logout } from '@/lib/auth';
import { routeError } from '../utils';
export async function POST(request:Request){try{return await login(request);}catch(error){return routeError(error);}}
export async function DELETE(request:Request){try{return await logout(request);}catch(error){return routeError(error);}}
