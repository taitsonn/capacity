# Validação do Capacity Manager — revisão 0.3.0

Verificação em 19/10/2026, com Node.js 24. Entrega local com código-fonte, aplicação compilada, banco demonstrativo e instruções de execução. Os testes não alteram o banco de trabalho do usuário.

## Resultado automatizado

`npm test`: **97 testes aprovados, zero falhas**.

| Grupo | Testes | Cobertura principal |
|---|---:|---|
| Motor de capacidade e datas | 32 | Jornadas, conflitos, descanso, ativações, calendário e simulação |
| Capacidade por tipo de demanda | 29 | CHG, ocupação compartilhada, reservas, orçamento semanal, cotas e limites civis |
| Integração SQL, APIs e autenticação | 20 | Persistência, rollback, login, perfis, migrações e atualização dos indicadores |
| Relatórios | 4 | Capacidade CHG, orçamento semanal e estrutura Excel/PDF |
| Componentes de interface renderizados no servidor (SSR) | 12 | Indicadores, ações, dashboards distintos, cotas, semanas e saturação prevista |

| Verificação desta revisão | Resultado |
|---|---|
| 97 testes automatizados | Aprovado |
| TypeScript | Aprovado, sem erros |
| Build final 0.3.0 | Aprovado |
| Smoke do build compilado, com SQLite temporário em memória | Aprovado |
| Smoke e integridade do pacote isolado 0.3.0 | Aprovado, sem node_modules e com SQLite temporário em memória |
| Conferência visual em navegador | Não realizada; acesso bloqueado pela política do ambiente |

## Jornada vigente e capacidade CHG

A premissa atual de **Lucas Cordeiro é 23h–05h, de segunda a sexta**, com seis horas produtivas por jornada e **30h regulares semanais**. A pausa antiga, 22h–23h, foi preservada no cadastro existente, mas fica fora da jornada e não reduz essas seis horas. O limite semanal de 48h foi mantido.

Os quatro diurnos têm uma cota inicial de uma atuação extraordinária semanal de seis horas cada. O resumo de planejamento CHG distingue:

| Componente semanal inicial | Horas | Significado |
|---|---:|---|
| Jornada regular de Lucas | 30h | Capacidade com datas na escala regular |
| Cota extraordinária dos quatro diurnos | 24h | Orçamento semanal ainda sem datas aprovadas |
| Total nominal planejável | **54h** | Composição 30h + 24h, sujeita à aprovação das datas e às regras operacionais |

As 54h não são apresentadas como capacidade já confirmada em datas específicas. Antes de aprovar extras, a capacidade datada regular é de 30h. Aprovar uma extra completa de seis horas leva a capacidade datada para 36h, consome 6h da cota e deixa 18h de cota para novas ativações; o total nominal semanal permanece 54h. Uma demanda confirmada de seis horas compromete essas horas e reduz o saldo planejável de 54h para 48h.

Uma ativação parcial também consome uma noite da cota. No caso de três horas aprovadas, a capacidade datada cresce apenas 3h, enquanto uma cota nominal de 6h é utilizada. A diferença não autoriza outra noite extraordinária na mesma semana. Interface e relatórios separam horas produtivas reais de cota nominal utilizada.

O orçamento deriva da configuração de jornadas, elegibilidade, limites e janela CHG; 54h não é uma constante fixa no código. BSIM e TSD confirmadas nos mesmos horários continuam ocupando a capacidade compartilhada, mesmo quando o filtro mostra somente CHG.

## Datas, semanas e descanso

- O orçamento semanal usa a semana completa e exibe seu intervalo, inclusive quando o filtro diário seleciona uma única data. A cota de 24h não é repetida em cada dia.
- Uma escala iniciada domingo às 23h e terminada segunda às 05h consome a cota e os compromissos da semana em que começou. As horas continuam aparecendo nas datas civis corretas no calendário.
- Uma jornada de seis horas atravessando a meia-noite é distribuída entre os dois dias. A escala regular iniciada sexta-feira termina sábado às 05h; não há escala fixa iniciada no sábado ou domingo por padrão.
- Para um diurno começar às 23h, a jornada anterior deve terminar até 12h para garantir 11h de intervalo. O administrador precisa cadastrar esse ajuste antes de aprovar a extra; o sistema não altera compromissos silenciosamente.
- Após terminar às 05h, o retorno diurno é permitido às 16h. Na jornada padrão, restam horas produtivas das 16h às 18h. O bloqueio é validado nos dois sentidos.
- Lucas permanece trabalhando entre 02h e 05h na jornada atual. Esse intervalo não pode ser marcado como descanso de uma jornada que ainda não terminou.

Excluir uma demanda libera suas alocações. Uma escala extraordinária explicitamente aprovada permanece vigente até ser removida ou ajustada, incluindo o descanso associado.

## Diagnóstico da CHG-111 e atualização dos indicadores

A investigação inicial encontrou Lucas cadastrado na antiga jornada 17h–02h. Naquela configuração, uma reserva 23h–05h tinha apenas três horas produtivas e gerava bloqueios ao tentar confirmar. Esse caso permanece apenas como **fixture histórica explícita** nos testes; não descreve a jornada atual.

Após a correção da jornada, a verificação somente leitura do banco na revisão 7 mostrou:

| Item | Resultado |
|---|---|
| CHG-111 | Em planejamento, 20/10 às 23h até 21/10 às 05h |
| Necessidade | Três pessoas por seis horas: 18 pessoa-horas |
| Alocação existente | Lucas Cordeiro por seis horas |
| Disponibilidade individual de Lucas | Válida, sem issues e sem necessidade de escala extraordinária |
| Reserva produtiva da demanda | 6h |
| Capacidade CHG datada da semana | 30h |
| Orçamento semanal | 30h regulares + 24h de cota = 54h; nenhuma cota extraordinária usada |
| Bloqueio restante da demanda | Cobertura insuficiente: faltam duas pessoas, ou 12 pessoa-horas |

A demanda do usuário **não foi confirmada nem alterada automaticamente**. Enquanto continuar em planejamento, modifica reservas e projeções; não aumenta o comprometimento ou a ocupação oficiais.

A regressão de integração verifica retorno de estado e revisão novos após salvar; rejeição HTTP 422 de confirmação inválida sem alterar dados, revisão ou auditoria; correção explícita seguida de confirmação; e leitura seguinte com os mesmos indicadores. As respostas de estado usam `Cache-Control: no-store`.

Outro teste confirma Lucas das 23h às 05h com uma pessoa necessária: acrescenta 6h ao comprometimento, retira 6h da capacidade livre e não cria escala extraordinária. Também verifica que 02h–05h permanece disponível, sem falso bloqueio de descanso.

## Componentes de interface e regras adicionais

Os 12 testes SSR renderizam os componentes reais com estados conhecidos. Eles não executam um navegador nem substituem inspeção visual.

Foram verificados o gerencial operacional e o executivo de decisão como visões distintas; confirmação primária separada de salvar reserva; estados de leitura sem ações de edição; atualização dos números após confirmar; reservas de outros tipos sob um filtro; previsão acima da capacidade; composição 30h + 24h; consumo da cota sem duplicação; contexto semanal em filtro diário; períodos com múltiplas semanas; orientação para aprovação explícita de extras; e ativação parcial com cota de 6h separada de três horas datadas.

Os cenários de jornada anterior 17h–02h identificam a premissa histórica no próprio teste. As verificações atuais de jornada e capacidade usam 23h–05h.

Também estão cobertos conflitos simultâneos, pausas, ausências, limites semanais, fusos, transição histórica de horário de verão, cobertura parcial, capacidade potencial, simulação sem gravação e recorrências inválidas mesmo sem demandas cadastradas. Duas pessoas por três horas consomem seis pessoa-horas.

## Autenticação e preservação dos dados

O acesso local começa sem sessão, sem senha padrão e sem administrador automático. A configuração inicial segura solicita nome, usuário e senha de pelo menos 12 caracteres. Ela é atômica, permite converter a conta local antiga sem senha e não substitui credenciais existentes após haver administrador ativo com senha.

Senhas usam PBKDF2 com salt individual. Cookies são HttpOnly; logout revoga a sessão, e a inativação impede acesso. Administrador gerencia a operação. Consulta acessa somente visão geral e calendário; o servidor rejeita mutações, usuários, simulador e exportações desse perfil. Dados internos, solicitantes, notas e auditoria permanecem ocultos de Consulta.

Os testes SQL verificam persistência, revisão otimista e rollback integral de falhas, incluindo falha depois do incremento da revisão.

### Histórico das migrações autorizadas

A atualização inicial da equipe preservou identificadores e códigos:

| Identificador | Profissional |
|---|---|
| ana / OP-001 | Marcelo — Analista |
| bruno / OP-002 | Lizzie — Analista |
| carla / OP-003 | Lucas Telesi — Analista |
| diego / OP-004 | Tatiane Ramos — Ponto focal |
| elisa / OP-005 | Lucas Cordeiro — Analista |

Naquela migração inicial, Lucas recebeu a antiga jornada 17h–02h, e apenas a demanda demonstrativa CHG-109 foi encurtada até 02h. A demanda real **Teste** e o histórico foram preservados. O resultado histórico imediato foi revisão 2, 14 demandas e dois registros de auditoria; não corresponde ao estado posterior do banco.

Backup dessa etapa: `.data/backups/capacity-before-team-2026-10-19T12-05-19-860Z-da23720c.sqlite`.

A correção posterior de Lucas para **23h–05h, 30h semanais**, foi revisada e aplicada com **zero conflitos**, passando da revisão 6 para a revisão 7. Alterou somente os campos de jornada de Lucas; preservou as **14 demandas, 17 alocações, quatro exceções e uma conta de usuário**. Os seis registros anteriores de auditoria foram mantidos, com um novo registro da migração, totalizando sete naquela execução. Nenhuma demanda foi reescrita ou confirmada nessa correção.

Backup anterior à correção: `.data/backups/capacity-before-night-2026-10-19T14-16-02-718Z-4245ee4a.sqlite`.

Ambas as migrações usam backup consistente pela API SQLite, incluindo WAL, guardas de revisão/fingerprint e transação. Os testes usam bancos temporários para verificar preservação integral, bloqueio de revisão incorreta e idempotência.

## Smoke compilado e pacote

O smoke da revisão 0.3.0 foi **aprovado** com SQLite temporário em memória. Verificou:

- Página, API, sete bundles, favicon, logotipo Spread e fontes locais Outfit/DM Sans.
- Configuração inicial, login e logout reais; relatórios Excel/PDF.
- Duas pessoas por duas horas: reserva de 4h, confirmação com comprometimento +4h e capacidade livre −4h, e exclusão restaurando os indicadores.
- CHG semanal nominal 30h + 24h = 54h.
- Lucas trabalhando 23h–05h, confirmação de seis horas e ausência de falso descanso entre 02h e 05h.
- Extra aprovada após ajuste da jornada anterior até 12h: capacidade datada 36h, cota utilizada 6h, cota restante 18h e total nominal ainda 54h.
- Retorno diurno após a noite restrito às 16h–18h.
- Remoção dos registros de teste ao final do roteiro.

O banco temporário apresentou cinco colaboradores e treze demandas demonstrativas. O smoke não modifica o banco do usuário nem cria credenciais nele.

A validação do **pacote isolado 0.3.0** foi aprovada: executado sem `node_modules`, passou no mesmo smoke, incluindo Lucas 23h–05h, orçamento 30h + 24h, consumo de cota e retorno diurno às 16h. O ZIP de 250 arquivos passou na verificação de integridade e de exclusões: banco de trabalho, contas, sessões, metadados Git, dependências instaladas e arquivos SQLite WAL/SHM não foram incluídos.

A **conferência visual em navegador não foi realizada**: houve bloqueio pela política de segurança do navegador neste ambiente e expiração de conexões de loopback entre processos. Não houve nova tentativa de navegador nesta revisão. SSR e smoke compilado não substituem uma inspeção visual.
