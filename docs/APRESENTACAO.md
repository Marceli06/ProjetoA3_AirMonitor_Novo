# AirMonitor — Roteiro de apresentação (~5 minutos)

Duas pessoas ou uma só: o roteiro segue o fluxo real do sistema. Tempo total estimado: **5 min** (10 etapas de cerca de 30 s).

## Antes de começar (2 minutos de preparo, fora do tempo)

- Backend (`npm run dev`, porta 3000) e frontend (`npm run dev`, porta 5173) rodando; internet ativa (OpenAQ e Open-Meteo são consultadas ao vivo).
- Duas contas prontas: um **USUARIO** da cidade que será mostrada (por exemplo Mauá ou Campinas) e um **ADMIN** (criado com `npm run admin:create`). Não coloque senhas em slides.
- Faça **antes**, como ADMIN, "Avaliar agora" em Alertas para a cidade escolhida: os alertas só existem depois dessa avaliação, e a demonstração fica mais clara com pelo menos um alerta ativo (ou, se a cidade estiver com ar bom, com o estado "nenhum alerta ativo" explicado).
- Deixe uma ocorrência de exemplo já criada (o Dashboard mostra "Ocorrências recentes") e abra o navegador na tela de Login.
- Plano B: se a OpenAQ estiver fora, o Dashboard mostra "Estimativa de modelo" (Open-Meteo) — use isso como demonstração do fallback.

## Roteiro

| # | Etapa | Tela | Ação | Frase curta |
| --- | --- | --- | --- | --- |
| 1 | O problema | slide ou Login | Mostrar a tela inicial | "A qualidade do ar muda a saúde de quem vive na cidade, mas os dados estão espalhados e difíceis de usar. O AirMonitor reúne medições reais, alertas e ocorrências em um só lugar." |
| 2 | Login | Login | Entrar com o USUARIO (mostrar o link "Criar conta") | "O acesso tem dois perfis. O cadastro cria sempre um usuário comum; administrador só é criado pela equipe." |
| 3 | Dashboard do usuário | Dashboard | Percorrer "Situação do ar agora" e o cabeçalho com a cidade | "Cada usuário vê a própria cidade. Tudo que aparece é real: se não houver dado, o sistema diz 'Sem dados disponíveis' em vez de inventar." |
| 4 | Dados ambientais | Dashboard | Apontar "Principais poluentes", a estação e o gráfico "Últimas 24 horas"; trocar a aba de poluente | "Os valores vêm da OpenAQ, de estações reais. Quando a estação não mede um poluente, a Open-Meteo estima — e vem sempre rotulado como modelo, nunca como medição." |
| 5 | Alertas | Alertas (pelo sino do Dashboard) | Clicar no sino, abrir um alerta e mostrar os filtros | "O sino leva aos alertas ativos da cidade. Os níveis seguem limiares técnicos provisórios, e o sistema deixa isso claro na tela — não são limites oficiais." |
| 6 | Ocorrências | Ocorrências | Registrar uma ocorrência pelo formulário e ver o status "Em aberto" | "O cidadão também participa: registra fumaça, queimada ou emissão. A ocorrência fica salva no banco, com autor, cidade e status." |
| 7 | Histórico | Histórico | Escolher 7 dias e outro poluente; mostrar o resumo (mínimo, média, máximo) e a origem do dado | "O histórico mostra a evolução e diz de onde veio cada ponto. Se a estação não tem dados, cai para o modelo e avisa." |
| 8 | Perfil ADMIN | Login → Dashboard Admin | Sair, entrar como ADMIN e mostrar os contadores e a troca de cidade | "O administrador enxerga todas as cidades e os números do sistema. O que ele pode fazer é decidido pelo servidor, não pela tela." |
| 9 | Gestão administrativa | Alertas, Ocorrências, Usuários | Em Alertas: "Avaliar agora" e "Resolver" (com confirmação). Em Ocorrências: colocar a ocorrência "Em andamento". Em Usuários: mostrar ativar/desativar | "Só o administrador avalia e resolve alertas, trata ocorrências e gerencia usuários. Desativar uma conta bloqueia o acesso: na próxima ação do usuário, a sessão é encerrada." |
| 10 | Encerramento | slide de arquitetura | Mostrar o diagrama (navegador → API → PostgreSQL/Supabase, OpenAQ e Open-Meteo) | "Frontend React, backend Express com TypeScript e banco PostgreSQL. Duas fontes públicas, com fallback entre elas. Foram 848 verificações automatizadas aprovadas, em Chrome e Edge. As limitações estão documentadas: limiares provisórios e alertas ainda não viram ocorrências automaticamente." |

## Perguntas prováveis

- **"Os limiares de alerta são oficiais?"** Não. São provisórios, num único arquivo, e a escolha da norma de referência é uma decisão da equipe. Não há cálculo de IQA.
- **"Por que não aparecem alertas?"** Eles só nascem quando o administrador avalia a cidade; "sem alertas" não significa ar bom.
- **"Os alertas geram ocorrências?"** Ainda não: é uma evolução prevista (a origem `AUTOMATICA` já existe no banco).
- **"E se a OpenAQ cair?"** A Open-Meteo assume, rotulada como estimativa; se as duas caírem, o sistema avisa que não há dados.
- **"Um usuário vê dados de outra cidade?"** Em Alertas, Ocorrências e Histórico não: o servidor recusa (403/404). A consulta de qualidade do ar usa dados públicos.
- **"Testado em quais navegadores?"** Chrome e Edge. Firefox não foi testado.
