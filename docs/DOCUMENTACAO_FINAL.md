# AirMonitor — Documentação final

Este documento descreve o sistema **como ele está implementado hoje**. Onde algo ainda não existe, está dito explicitamente (seção 14). Documentos complementares:

| Documento | Conteúdo |
| --- | --- |
| [`TESTES.md`](TESTES.md) | matriz de testes, totais da validação final, defeitos encontrados e corrigidos |
| [`APRESENTACAO.md`](APRESENTACAO.md) | roteiro de apresentação de ~5 minutos |
| [`../backend/docs/ALERTAS.md`](../backend/docs/ALERTAS.md) | regras, limiares provisórios, tabela e API de Alertas |
| [`../backend/docs/OCORRENCIAS.md`](../backend/docs/OCORRENCIAS.md) | tabela, API e permissões de Ocorrências |
| [`../backend/docs/HISTORICO.md`](../backend/docs/HISTORICO.md) | API e fontes do Histórico |

## 1. Objetivo

O AirMonitor mostra a **qualidade do ar de cidades do estado de São Paulo** com dados reais de duas fontes públicas, destaca situações de risco por meio de **alertas**, permite registrar **ocorrências** ambientais (fumaça, queimada, emissão etc.) e consultar o **histórico** das medições. Há dois perfis: o **USUARIO**, que acompanha a própria cidade, e o **ADMIN**, que também administra usuários, avalia e resolve alertas, trata ocorrências e consulta qualquer cidade.

O sistema nunca inventa um valor ambiental: sem dado, a tela mostra "Sem dados disponíveis" ou um estado vazio/erro; toda medição é rotulada com a sua origem.

## 2. Arquitetura

```
 Navegador (React + Vite, :5173)
        │  HTTP/JSON (axios, Bearer JWT)
        ▼
 Backend Express + TypeScript (:3000)  ── /api/auth /api/admin /api/air-quality /api/alertas /api/ocorrencias /api/historico
        │                │                         │
        │ pg (SQL        │ HTTPS (chave só no      │ HTTPS (sem chave)
        │ parametrizado) │ backend, X-API-Key)     │
        ▼                ▼                         ▼
 PostgreSQL (Supabase)   OpenAQ v3                Open-Meteo (qualidade do ar, modelo CAMS)
 usuarios, alertas,      medições de estações     estimativa por coordenada
 ocorrencias
```

Camadas do backend (`backend/src`):

- `routes/` — autenticam, validam a entrada e chamam os serviços (sem regra de negócio).
- `services/` — regras: `airQuality.ts` (busca de estações e medições, cache), `consolidador.ts` (une OpenAQ e Open-Meteo e decide a fonte de cada poluente), `alertas.ts`, `ocorrencias.ts`, `historico.ts`, `adminDashboard.ts`, `cache.ts` (cache em memória com TTL).
- `middlewares.ts` — `authMiddleware` (JWT + consulta ao banco a cada requisição), `requireAdmin`, `errorHandler`.
- `config.ts` — leitura obrigatória do `JWT_SECRET` (sem valor padrão: o servidor não sobe sem ele).
- `data/` — cidades atendidas, coordenadas e limiares provisórios de alerta.
- `scripts/` — migração, criação do primeiro ADMIN e as suítes de validação.

O frontend (`frontend/src`) usa componentes por tela (`Dashboard`, `AlertsPage`, `OccurrencesPage`, `HistoryPage`, `UsersPage`, `StationsPage`, `SettingsPage`, `ReportsPage`, `Login`, `Register`, `ForgotPassword`), hooks de dados (`useQualidadeAr`, `useDashboardDados`) e um cliente `api.ts` com interceptores de autenticação.

## 3. Tecnologias

| Camada | Tecnologia |
| --- | --- |
| Frontend | React 18, TypeScript 5, Vite 4, axios |
| Backend | Node.js, Express 4, TypeScript 5, `pg`, `jsonwebtoken`, `bcryptjs`, `cors`, `dotenv`; `tsx` em desenvolvimento |
| Banco | PostgreSQL hospedado no Supabase (conexão por `DATABASE_URL`) |
| Dados ambientais | OpenAQ API v3 (medições de estações) e Open-Meteo Air Quality API (modelo CAMS) |
| Testes | scripts próprios em TypeScript/Node (API e banco) e navegador real via DevTools Protocol (Chrome e Edge) |

As dependências `@supabase/*` estão no `package.json` do backend, mas o acesso ao banco é feito diretamente com `pg`.

## 4. Perfis e permissões

| Capacidade | USUARIO | ADMIN |
| --- | --- | --- |
| Cadastro e login | sim (o cadastro cria sempre USUARIO) | sim (o primeiro ADMIN é criado por `npm run admin:create`) |
| Dashboard | da própria cidade (seletor fixo) | Dashboard Admin com contadores e escolha de qualquer cidade |
| Alertas | lê os da própria cidade | lê qualquer cidade, **avalia** e **resolve** |
| Ocorrências | lê da própria cidade e **registra** | lê qualquer cidade, registra e **altera o status** |
| Histórico | só a própria cidade (outra cidade responde 403) | qualquer cidade |
| Usuários, Estações, Configurações, Relatórios | sem acesso (403) | sim |

Regras comuns: o perfil e a situação do usuário são lidos **do banco a cada requisição**. Rebaixar um ADMIN ou desativar um usuário vale na hora, com o mesmo token; o perfil guardado no navegador é só visual e adulterá-lo não dá acesso.

## 5. Funcionalidades por tela

- **Login / Cadastro / Esqueci a senha** — o cadastro valida o formato do e-mail e o tipo e o tamanho dos campos; a senha é guardada com bcrypt (limite de 72 bytes). "Esqueci a senha" **não envia e-mail** (ver limitações). Sessão expirada ou encerrada mostra um aviso no Login.
- **Dashboard (USUARIO)** — "Situação do ar agora", "Principais poluentes" (cada um com valor, unidade e a origem: estação OpenAQ ou modelo Open-Meteo), estação usada, "Últimas 24 horas" (gráfico por poluente), "Alertas ativos" (3 primeiros e "Mostrando 3 de N"), "Ocorrências recentes" da cidade e sino com a contagem de alertas ativos.
- **Dashboard Admin** — contadores reais (usuários, alertas, ocorrências), seleção de cidade, acesso rápido às telas administrativas.
- **Alertas** — lista com paginação, filtros de status/nível/poluente, detalhe em painel lateral; ADMIN tem "Avaliar agora" e "Resolver" (com confirmação).
- **Ocorrências** — cartões-resumo por status, busca, filtros, paginação, formulário de nova ocorrência e painel de detalhe; ADMIN inicia e conclui.
- **Histórico** — período (24 h, 7 dias, 30 dias), poluente, fonte, estação, gráfico, resumo (mínimo, média, máximo, último) e tabela/cartões.
- **Usuários / Estações / Configurações / Relatórios (ADMIN)** — cadastro e edição de usuários, ativar/desativar, consulta de estações da OpenAQ por cidade, parâmetros do sistema em somente leitura (sem segredos) e relatórios do sistema.

Cidades atendidas: São Paulo, Guarulhos, Campinas, São Bernardo do Campo, Ribeirão Preto, Sorocaba, São José dos Campos, Santo André, Osasco e Mauá.

## 6. Banco de dados

Definido em `backend/init.sql` (`npm run db:migrate`, idempotente, não altera dados existentes).

| Tabela | Finalidade | Pontos principais |
| --- | --- | --- |
| `usuarios` | contas do sistema | `email` único, `senha_hash`, `perfil` (`ADMIN`/`USUARIO`, CHECK), `ativo`, `cidade`, `regiao` |
| `alertas` | alertas gerados pelo backend | um alerta ATIVO por (cidade, estação, poluente) — índice único parcial; CHECKs de nível, status, origem/tipo (estimativa nunca é gravada como medição) |
| `ocorrencias` | ocorrências ambientais | CHECKs de tipo/status/origem, conclusão coerente, leitura ambiental coerente; `usuario_id` do autor |
| `users` | tabela legada de uma versão inicial | **não é usada** pelo sistema atual |

Detalhes de colunas e constraints: `ALERTAS.md` e `OCORRENCIAS.md`. Todas as consultas SQL são parametrizadas (`$1, $2…`).

## 7. Integração OpenAQ

- Cliente em `backend/src/services` (HTTP com timeout configurável). A chave (`OPENAQ_API_KEY`) é enviada **apenas pelo backend**, no cabeçalho `X-API-Key`; o navegador nunca a vê.
- Busca estações por raio em torno do centro da cidade, ordenadas por distância, e lê a última medição por sensor.
- Cache em memória: busca de estações 10 min; últimas medições 2 min.
- A OpenAQ limita 60 requisições por minuto; o modo automático do Histórico tenta no máximo 3 estações candidatas para respeitar o limite.
- Falhas temporárias (timeout, indisponível, limite de requisições) são tratadas e acionam o fallback; chave ausente/recusada e resposta malformada continuam sendo erro.

## 8. Integração Open-Meteo

- Consulta a estimativa de qualidade do ar do modelo CAMS por **coordenada** (sem chave de API). Cache de 30 min.
- É **complementar**: preenche, por poluente, o que a estação não mediu. Todo valor vem marcado como `MODELO` com a atribuição exigida pela licença; **nunca é apresentado como medição**.
- **Último recurso:** se a OpenAQ está fora do ar e nem uma estação é encontrada, `GET /api/air-quality/modelo?cidade=…` devolve a estimativa do modelo para o centro da cidade, sem estação; o Dashboard a rotula como "Estimativa de modelo". Se a Open-Meteo também falhar, responde 503 e a tela mostra "Sem dados disponíveis".

## 9. Alertas

- Gerados **somente** por `POST /api/alertas/avaliar` (ADMIN): o backend busca os dados, classifica por poluente (BAIXO, MODERADO, ALTO, CRÍTICO), cria/atualiza/resolve e grava. A rota não aceita valores prontos.
- **Os limiares são provisórios**, definidos só para a arquitetura funcionar; **não são limites oficiais e não há cálculo de IQA**. Estão em um único arquivo (`data/limiaresAlertas.ts`); a decisão da norma de referência é da equipe. A API devolve `limiaresProvisorios: true` e o Dashboard avisa na tela.
- Como só nascem sob avaliação do ADMIN, **"sem alertas" não prova que o ar está bom** — o Dashboard foi redigido para não afirmar isso.
- Só mede em µg/m³; medição com mais de 6 h, unidade diferente, valor inválido ou data inválida não geram nem resolvem alerta.
- Não há integração Alertas → Ocorrências (ver seção 14).

## 10. Ocorrências

- Registro manual por USUARIO ou ADMIN (`origem = MANUAL`); status `ABERTA → EM_ANDAMENTO → CONCLUIDA` (ou `ABERTA → CONCLUIDA`); `CONCLUIDA` é final; transição inválida responde 409; a mudança de status usa transação com `SELECT … FOR UPDATE`.
- Só o ADMIN altera o status (decisão restritiva documentada em `OCORRENCIAS.md`).
- USUARIO vê apenas ocorrências da própria cidade (de qualquer autor da cidade); ocorrência de outra cidade responde 404.
- A origem `AUTOMATICA` existe no esquema, mas **nada a gera hoje**.

## 11. Histórico

- `GET /api/historico` com `cidade`, `poluente`, `periodo` (`24H`, `7D`, `30D`) e `fonte` (`AUTO`, `OPENAQ`, `OPEN_METEO`), opcionalmente `estacaoId`.
- `AUTO` usa a estação mais próxima com dados no período e, se nenhuma servir ou a OpenAQ estiver fora, cai para o modelo **com aviso** e status das fontes.
- Devolve a série, o resumo (mínimo, média, máximo, último — nulo quando a série é vazia, sem inventar números), as estações e o status de cada fonte. Cache: 10 min (OpenAQ) e 30 min (Open-Meteo).
- Detalhes: `backend/docs/HISTORICO.md`.

## 12. Segurança

| Item | Como está |
| --- | --- |
| Segredos | `.env` fora do Git (`.gitignore`); só `backend/.env.example` é versionado, com chaves sem valores. Verificado: nenhuma credencial em arquivo rastreado nem no histórico |
| JWT | 24 h; `JWT_SECRET` obrigatório e sem valor padrão (o servidor não inicia sem ele) |
| Autenticação | `authMiddleware` valida o token **e consulta o usuário no banco** a cada requisição: usuário removido ou desativado recebe 401 na hora |
| Autorização | `requireAdmin` nas rotas administrativas, de avaliar/resolver alertas e de alterar status de ocorrência (403); o perfil vem do banco, nunca do cliente |
| Isolamento por cidade | USUARIO: Alertas, Ocorrências e Histórico só da própria cidade (403 ao pedir outra cidade, 404 para registro de outra cidade); a cidade do USUARIO é lida do banco, não do token nem do navegador |
| SQL | 100% parametrizado; filtros e ordenações montados a partir de listas fechadas |
| Entrada | tipos, tamanhos e formatos validados (e-mail, senha ≤ 72 bytes, IDs com limite máximo — ID gigante responde 400, nunca 5xx); campos desconhecidos em `POST /ocorrencias` geram 400 |
| Sessão no navegador | 401 limpa a sessão e avisa no Login; o interceptor só age se o token da resposta ainda for o token atual |
| Configurações | `GET /api/admin/configuracoes` é somente leitura e **não devolve** chaves, `JWT_SECRET`, `DATABASE_URL`, senhas ou tokens (verificado por teste) |
| Mensagens de login | "Credenciais inválidas" é igual para senha errada, e-mail inexistente e usuário desativado (sem enumeração de contas) |

Pontos de atenção (não implementados): CORS aberto a qualquer origem, ausência de limite de tentativas de login e `GET /api/air-quality/*` liberado a qualquer usuário autenticado (dados públicos de qualquer cidade, sem dado de usuário) — ver seção 14.

## 13. Tratamento de falhas

| Situação | Comportamento |
| --- | --- |
| OpenAQ fora do ar, estação conhecida | o consolidador usa só a Open-Meteo para a coordenada da estação; valores rotulados como modelo |
| OpenAQ fora do ar, nenhuma estação | `GET /api/air-quality/modelo` (Open-Meteo para a cidade), "Estimativa de modelo" e aviso no Dashboard |
| OpenAQ e Open-Meteo fora | "Sem dados disponíveis" no Dashboard; Histórico com vazio/erro tratado; Alertas e Ocorrências (só banco) continuam funcionando |
| Histórico AUTO sem estação | cai para o modelo com aviso e `statusFontes` |
| API do sistema com erro | cada cartão/tela mostra a mensagem do servidor e "Tentar novamente"; os demais cartões continuam |
| Carregando | cartões e telas mostram "Carregando", sem exibir dado de cidade anterior |
| Vazio | mensagens específicas ("nenhum alerta ativo", "nenhuma ocorrência" etc.) |
| 401 | sessão limpa, volta ao Login com aviso |
| 403 | mensagem na tela; a sessão **não** é encerrada |
| F5 | a sessão é validada em `/auth/me` ("Verificando sessão…"); o menu volta ao Dashboard |

## 14. Limitações e pendências reais

- **Integração Alertas → Ocorrências não existe** (a origem `AUTOMATICA` está prevista no banco, mas nada a usa).
- **Notificações (RF10)**: só há o sino dentro do sistema; não há envio por e-mail, push ou SMS.
- **Histórico (RF13)**: consulta às fontes externas, sem armazenamento próprio das medições.
- **Região/zona (RF06)**: a busca de estações usa a cidade; a região não refina o resultado.
- **Limiares de alerta provisórios**; sem IQA e sem norma de referência escolhida.
- **Alertas só por avaliação sob demanda do ADMIN**: não há agendador; sem histerese nem tempo mínimo de permanência.
- **"Esqueci a senha" não envia e-mail** (não há serviço de e-mail configurado).
- CORS aberto, **sem limite de tentativas de login**, JWT guardado em `localStorage`.
- `GET /api/air-quality/*` acessível a qualquer autenticado, para qualquer cidade (dados públicos; decisão a confirmar).
- Dependência de serviços externos gratuitos (OpenAQ: 60 req/min; Open-Meteo): indisponibilidade ou limite geram os fallbacks da seção 13.
- A tela não persiste o menu ativo na URL: F5 volta ao Dashboard.
- Tabela legada `users` e componente `ComingSoon.tsx` sem uso.
- Alguns controles pequenos (< 24 px) nas telas administrativas e de tabelas foram apenas medidos, sem alteração de desenho.
- **Firefox não foi testado**: os testes de interface usam o DevTools Protocol (Chromium/Edge) e o Firefox não está instalado no ambiente de testes. Foram validados Chrome e Edge.

## 15. Testes (resumo)

Ver [`TESTES.md`](TESTES.md). Na validação final: 434 verificações de API/banco (8 suítes) e 207 verificações de interface em cada um dos dois navegadores (Chrome e Edge), `tsc` do backend e do frontend sem erros e build do frontend concluído.

## 16. Instruções de execução

Pré-requisitos: Node.js (versão LTS recente) e acesso a um PostgreSQL (Supabase) e a uma chave da OpenAQ v3.

```bash
# 1) Backend
cd backend
npm install
cp .env.example .env        # preencha DATABASE_URL, JWT_SECRET e OPENAQ_API_KEY (nunca versione o .env)
npm run db:migrate          # cria/atualiza as tabelas (idempotente)
ADMIN_EMAIL=admin@exemplo.com ADMIN_SENHA='uma-senha-forte' ADMIN_NOME='Administrador' npm run admin:create
npm run dev                 # http://localhost:3000  (GET /health)

# 2) Frontend (outro terminal)
cd frontend
npm install
npm run dev                 # http://localhost:5173 (o Vite encaminha /api para :3000)
```

No Windows (PowerShell), defina as variáveis do `createAdmin` com `$env:ADMIN_EMAIL='...'` antes de `npm run admin:create`.

Variáveis de ambiente do backend: `DATABASE_URL`, `JWT_SECRET` (obrigatórias), `PORT`, `NODE_ENV`, `OPENAQ_API_KEY`; opcionais `OPENAQ_BASE_URL`, `OPENAQ_TIMEOUT_MS` e `OPEN_METEO_BASE_URL`. No frontend, `VITE_API_URL` (padrão `http://localhost:3000/api`).

Validações:

```bash
cd backend
npx tsc --noEmit                 # tipos do backend
npm run validate:all             # 8 suítes de API/banco (cerca de 6 min; há pausas por causa do limite da OpenAQ)
npm run ui:validate              # interface no Chrome; UI_BROWSERS=chrome,edge para os dois
cd ../frontend
npx tsc --noEmit && npm run build
```

As suítes criam usuários, alertas e ocorrências temporários (`tmp.*@example.com`, `[TESTE…]`) e os removem ao final.

## 17. Rastreabilidade de requisitos (ISO/IEC/IEEE 29148)

A ISO/IEC/IEEE 29148 trata de **engenharia de requisitos** (elicitação, especificação e rastreabilidade); **não é uma norma de arquitetura** e é usada aqui apenas para ligar cada requisito à sua implementação e à sua verificação. Os identificadores e os enunciados (abreviados) são os da **documentação acadêmica oficial do projeto** (seções 7 e 8); nenhum ID foi criado nesta documentação.

Situação: **Atendido** = implementado e verificado; **Parcial** = implementado em parte (a lacuna está descrita); **Não medido** = sem critério quantitativo definido na documentação acadêmica.

### Requisitos funcionais

| ID | Requisito (resumo) | Situação | Implementação | Verificação |
| --- | --- | --- | --- | --- |
| RF01 | Cadastro de usuários | Atendido | `routes/auth.ts`, `Register.tsx` | `auth:validate`; UI Sistema A01–A02 |
| RF02 | Informar cidade e região/zona | Atendido | cadastro grava `cidade` e `regiao` em `usuarios` | UI Sistema A01 (confere o banco) |
| RF03 | Coletar dados de qualidade do ar por API externa | Atendido (sob demanda, com cache; sem coleta periódica) | `services/airQuality.ts`, integrações OpenAQ e Open-Meteo | `openaq:validate`, `dashboard:validate` |
| RF04 | Visualizar os dados de qualidade do ar da região | Atendido | `Dashboard.tsx`, `useQualidadeAr` | `dashboard:validate`; UI Dashboard, Sistema A04 |
| RF05 | Informações das estações de monitoramento | Atendido | estação usada no Dashboard; `StationsPage.tsx` e `GET /api/admin/estacoes` (ADMIN) | UI Admin; Sistema B02 |
| RF06 | Relacionar cidade/região às estações próximas | **Parcial**: a relação é feita pela **cidade** (raio em torno do centro); a região/zona não refina a busca | `buscarEstacoes`, `data/cidadesCoordenadas.ts` | `openaq:validate`, `dashboard:validate` |
| RF07 | Apresentar os dados em um dashboard | Atendido | `Dashboard.tsx`, Dashboard Admin | UI Dashboard e Admin |
| RF08 | Regras predefinidas para alterações relevantes nos poluentes | Atendido, com **limiares provisórios** (não oficiais, sem IQA) | `data/limiaresAlertas.ts`, `services/alertas.ts` | `alertas:validate` |
| RF09 | Gerar alertas automaticamente quando a regra for atendida | **Parcial**: a geração é automática pela regra, mas só ocorre quando o ADMIN executa a avaliação; sem agendador | `POST /api/alertas/avaliar` | `alertas:validate`; UI Alertas, Sistema B06 |
| RF10 | Enviar notificações aos usuários afetados | **Parcial**: só há indicação dentro do sistema (sino com a contagem de alertas ativos da cidade); **não há envio** por e-mail, push ou SMS | sino no `Dashboard.tsx` | UI Sistema A05–A06 |
| RF11 | Registrar manualmente uma ocorrência | Atendido | `routes/ocorrencias.ts`, `NovaOcorrenciaForm.tsx` | `ocorrencias:validate`; UI Ocorrências, Sistema A08 |
| RF12 | Consultar as ocorrências registradas | Atendido | `GET /api/ocorrencias`, `OccurrencesPage.tsx` | `ocorrencias:validate`; UI Ocorrências, Sistema A09, B04 |
| RF13 | Armazenar um histórico das medições para consulta | **Parcial**: a consulta ao histórico (24 h, 7 dias, 30 dias) existe, mas as medições **não são armazenadas** pelo sistema; vêm das fontes externas, com cache em memória | `services/historico.ts`, `HistoryPage.tsx` | `historico:validate`; UI Histórico |
| RF14 | Consultar alertas anteriores da região | Atendido (filtro de status inclui os alertas resolvidos) | `GET /api/alertas`, `AlertsPage.tsx` | `alertas:validate`; UI Alertas, Sistema A07 |
| RF15 | Perfis Administrador e Usuário Comum | Atendido | `usuarios.perfil` (CHECK `ADMIN`/`USUARIO`) | `auth:validate` |
| RF16 | Identificar o perfil após o login e liberar só as funções permitidas | Atendido | `authMiddleware`, `requireAdmin`, menu por perfil | `auth:validate`; UI Sistema A03, B01, C03, C07 |
| RF17 | Usuário Comum sem acesso às funções administrativas | Atendido | `requireAdmin`; 403 | `auth:validate`; UI Admin A16–A17, Sistema C07 |
| RF18 | Administrador com as funções comuns e a gestão de usuários e áreas administrativas | Atendido | `routes/admin.ts`, páginas administrativas | UI Admin (54 verificações), Sistema B |
| RF19 | Fonte complementar quando a principal estiver ausente, desatualizada ou indisponível | Atendido | `consolidador.ts`, rota `/api/air-quality/modelo`, Histórico `AUTO` | `fallback:validate`, `fallback-total:validate`; UI Sistema E01–E02 |
| RF20 | Informar a origem do dado e diferenciar medição de estimativa por modelo | Atendido | campos `fonte`/`tipoDado`, rótulos e atribuições na interface | `fallback:validate`, `historico:validate`; UI Dashboard, Sistema E01 |

### Requisitos não funcionais

| ID | Categoria | Situação | Evidência |
| --- | --- | --- | --- |
| RNF01 | Usabilidade | Atendido de forma qualitativa: revisão prática das telas e correções de usabilidade; **sem avaliação com usuários** | `TESTES.md`, seção 5 |
| RNF02 | Desempenho | **Não medido**: a documentação acadêmica deixa os limites de tempo para a etapa de critérios de qualidade; o cache em memória reduz as consultas às APIs | — |
| RNF03 | Confiabilidade | Atendido: respostas inválidas e indisponibilidade da API externa são tratadas, com aviso na tela e "Tentar novamente" | `fallback*:validate`; UI Sistema D02, E01–E02 |
| RNF04 | Segurança | Atendido: autenticação por JWT, perfil e atividade lidos do banco, SQL parametrizado, `.env` fora do Git (seção 12). Limitações: CORS aberto e sem limite de tentativas de login | `auth:validate`; verificação do Git |
| RNF05 | Compatibilidade | Atendido em **Chrome e Edge**; **Firefox e dispositivos móveis reais não foram testados** | UI nos dois navegadores |
| RNF06 | Manutenibilidade | Atendido: camadas separadas (rotas, serviços, integrações, dados) e limiares em um único arquivo; sem métrica automatizada | estrutura de `backend/src` (seção 2) |
| RNF07 | Disponibilidade e tolerância a falhas | Atendido: com as fontes externas fora do ar, Alertas, Ocorrências e demais telas continuam funcionando | UI Sistema E01–E02 |
| RNF08 | Portabilidade e responsividade | Atendido em **emulação** de 1366 × 768, 768 × 1024 e 390 × 844, sem rolagem horizontal global; **aparelhos reais não foram testados** | UI Sistema, seção F |

Os requisitos RF06, RF09, RF10 e RF13 têm as lacunas acima também listadas na seção 14.
