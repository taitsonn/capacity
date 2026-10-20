"use client";
import "./weekly-chg-planning.css";
import { CalendarDays, Clock3, Moon, ShieldCheck } from "lucide-react";
import type { TypeCapacity } from "@/lib/type-capacity";
const n = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const date = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });

export function WeeklyCHGPlanning({ metrics, from, to }: { metrics: TypeCapacity; from: string; to: string }) {
  const weeks = metrics.weeklyPlanning;
  if (!weeks?.length) return null;
  const fullPeriod = from === weeks[0].weekStart && to === weeks[weeks.length - 1].weekEnd;
  return <section className="weekly-chg-planning" aria-label="Planejamento semanal de CHG">
    <div className="weekly-chg-heading"><span><Moon size={24} /></span><div><div className="section-kicker">CHG · CAPACIDADE PLANEJÁVEL SEMANAL</div><h2>{weeks.length === 1 ? `Semana completa de ${date(weeks[0].weekStart)} a ${date(weeks[0].weekEnd)}` : `${weeks.length} semanas completas de planejamento`}</h2><p>Capacidade regular + cota extraordinária. Cada cota aparece uma única vez em sua semana.</p></div></div>
    <div className="weekly-chg-totals"><div className="weekly-chg-primary"><span>Total planejável{weeks.length > 1 ? " das semanas" : " na semana"}</span><strong>{n(metrics.planningTotal)}<small>h</small></strong></div><div><span>Comprometidas nas semanas completas</span><strong>{n(weeks.reduce((sum, week) => sum + week.committed, 0))}<small>h</small></strong></div><div><span>Saldo planejável semanal</span><strong>{n(metrics.planningFree)}<small>h</small></strong><small>Inclui cota ainda sujeita a aprovação por data</small></div></div>
    <div className="weekly-chg-table"><table><thead><tr><th>SEMANA COMPLETA</th><th>REGULAR</th><th>COTA EXTRA</th><th>COTA EXTRAORDINÁRIA UTILIZADA</th><th>COTA RESTANTE</th><th>TOTAL PLANEJÁVEL</th><th>SALDO</th></tr></thead><tbody>{weeks.map(week => <tr key={week.weekStart}><td>{date(week.weekStart)} — {date(week.weekEnd)}</td><td>{n(week.regular)}h</td><td>{n(week.extraQuota)}h</td><td>{n(week.extraActivated)}h</td><td>{n(week.extraQuotaRemaining)}h</td><td><strong>{n(week.total)}h</strong><small>{n(week.regular)}h + {n(week.extraQuota)}h</small></td><td><strong>{n(week.free)}h</strong></td></tr>)}</tbody></table></div>
    {!fullPeriod && <div className="weekly-chg-partial"><CalendarDays size={16} /><span>Contexto de <b>semanas completas</b>, inclusive quando o filtro mostra apenas {date(from)}{from !== to ? ` a ${date(to)}` : ""}. Estes totais não representam a disponibilidade de um único dia.</span></div>}
    <div className="weekly-chg-approved"><ShieldCheck size={18} /><span><strong>Capacidade com datas aprovadas no filtro:</strong> {n(metrics.confirmed)}h aprovadas · {n(metrics.committed)}h comprometidas · <b>{n(metrics.free)}h livres confirmadas</b>.</span></div>
    <div className="weekly-chg-conditions"><Clock3 size={17} /><p>A cota extraordinária exige escolha da data, aprovação da escala e descanso entre jornadas. Ao aprovar uma extra, a ativação consome a cota e somente suas horas efetivas passam a ter data, sem somar a cota novamente ao total semanal. Uma atuação parcial consome a cota da noite inteira; não libera outra noite na mesma semana. A mesma ativação pode atender várias demandas. Os gráficos e a tabela diária abaixo mostram apenas jornadas e alocações com datas reais.</p></div>
  </section>;
}

