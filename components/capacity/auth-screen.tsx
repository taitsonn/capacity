"use client";
import { useEffect, useState } from "react";
import { Activity, ArrowRight, CalendarDays, Check, LoaderCircle, ShieldCheck, Users } from "lucide-react";
import type { Session } from "@/lib/types";

export function AuthScreen({ onLogin }: { onLogin: () => Promise<void> }) {
  const [setup, setSetup] = useState<{ needsSetup: boolean; canSetup: boolean } | null>(null);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; fetch("/api/setup", { cache: "no-store" }).then(async response => { const result = await response.json() as { needsSetup: boolean; canSetup: boolean; error?: string }; if (!response.ok) throw new Error(result.error || "Não foi possível consultar a configuração inicial."); if (active) setSetup(result); }).catch(e => { if (active) { setError(e instanceof Error ? e.message : "Falha de conexão."); setSetup({ needsSetup: false, canSetup: false }); } }); return () => { active = false; }; }, []);
  const creating = Boolean(setup?.needsSetup && setup.canSetup);
  const blocked = Boolean(setup?.needsSetup && !setup.canSetup);
  return <div className="login-page">
    <div className="login-visual"><div className="brand spread-brand"><img src="/spread-logo-white.svg" alt="Spread" /><span>Capacity Manager</span></div><div><div className="eyebrow">GESTÃO DE CAPACIDADE OPERACIONAL</div><h1>Planeje o presente.<br /><em>Antecipe o próximo.</em></h1><p>Pessoas, demandas e disponibilidade conectadas para decisões mais claras.</p><div className="login-illustration"><div><Users size={23} /><span>Uma equipe, uma visão da operação</span><Check size={18} /></div><div><CalendarDays size={23} /><span>Jornadas e demandas no mesmo lugar</span><Check size={18} /></div><div><ShieldCheck size={23} /><span>Planejamento com regras e segurança</span><Check size={18} /></div></div></div><small>Operações Spread · Capacity Manager</small></div>
    <div className="login-form-wrap"><form className="login-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError("");
      try {
        if (creating && password !== confirmPassword) throw new Error("As senhas precisam ser iguais.");
        const response = await fetch(creating ? "/api/setup" : "/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(creating ? { name, username, password } : { username, password }) });
        const result = await response.json() as { error?: string; session?: Session };
        if (!response.ok) throw new Error(result.error || "Não foi possível entrar.");
        setPassword(""); setConfirmPassword(""); await onLogin();
      } catch (e) { setError(e instanceof Error ? e.message : "Não foi possível conectar ao servidor."); } finally { setBusy(false); }
    }}>
      <span className="login-icon"><Activity size={25} /></span><div className="eyebrow">{creating ? "PRIMEIRO ACESSO" : "SEU WORKSPACE OPERACIONAL"}</div><h2>{creating ? "Configure o administrador." : "Bem-vindo à operação."}</h2><p>{creating ? "Crie o primeiro acesso para configurar a equipe e cadastrar os perfis de consulta." : "Entre com o usuário e a senha cadastrados pelo administrador."}</p>
      {!setup ? <div className="auth-loading"><LoaderCircle size={22} className="spin" /><span>Verificando acesso…</span></div> : blocked ? <div className="form-error" role="alert">A configuração inicial deve ser concluída pelo administrador no ambiente autorizado.</div> : <>
        {creating && <label className="field"><span>Nome completo</span><input required minLength={2} maxLength={160} autoComplete="name" value={name} onChange={e => setName(e.target.value)} disabled={busy} placeholder="Nome do administrador" /></label>}
        <label className="field"><span>Usuário</span><input required minLength={creating ? 3 : 1} maxLength={100} pattern={creating ? "[a-zA-Z0-9._@-]+" : undefined} autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder={creating ? "Escolha o usuário de acesso" : "Seu usuário de acesso"} value={username} onChange={e => setUsername(e.target.value)} disabled={busy} /></label>
        <label className="field"><span>Senha</span><input type="password" required minLength={creating ? 12 : 1} maxLength={200} autoComplete={creating ? "new-password" : "current-password"} placeholder={creating ? "Pelo menos 12 caracteres" : "Sua senha"} value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></label>
        {creating && <label className="field"><span>Confirmar senha</span><input type="password" required minLength={12} maxLength={200} autoComplete="new-password" placeholder="Repita a senha" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} disabled={busy} /></label>}
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="button primary" disabled={busy} type="submit">{busy ? <LoaderCircle size={17} className="spin" /> : <>{creating ? "Criar administrador e entrar" : "Entrar no workspace"}<ArrowRight size={17} /></>}</button>
      </>}
      <small><ShieldCheck size={15} />{creating ? "Nenhuma credencial padrão é criada." : "Acesso individual. Permissões definidas pelo seu perfil."}</small>
    </form></div>
  </div>;
}
