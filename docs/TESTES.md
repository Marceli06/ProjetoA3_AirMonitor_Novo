# AirMonitor — Testes e validação final

## 1. Estratégia

| Nível | Como | Onde |
| --- | --- | --- |
| API e banco | scripts em TypeScript que sobem as rotas reais contra o PostgreSQL (Supabase) e as APIs externas | `backend/src/scripts/validate*.ts`, agrupados por `npm run validate:all` |
| Interface | navegador real (Chrome e Edge) controlado pelo DevTools Protocol; o runner sobe um backend e um Vite de teste em portas livres | `backend/scripts/validate*UI.mjs`, agrupados por `npm run ui:validate` |
| Tipos e build | compilador TypeScript e `vite build` | `npx tsc --noEmit` (backend e frontend) e `npm run build` (frontend) |

Todas as suítes criam dados temporários (`tmp.*@example.com`, `[TESTE…]`, estações `tmp-…`) e os removem ao final; ao término de cada suíte o banco ficou com 0 registros de teste.

Execução: `npm run validate:all` e `npm run ui:validate` (`UI_BROWSERS=chrome,edge`, `UI_SCRIPTS=dashboard,admin,alertas,ocorrencias,historico,sistema`). Há pausas entre as suítes que usam a OpenAQ para respeitar o limite de 60 requisições por minuto.

## 2. Resultado da validação final

| Verificação | Resultado |
| --- | --- |
| `tsc --noEmit` do backend | 0 erros |
| `tsc --noEmit` do frontend | 0 erros |
| `npm run build` do frontend | concluído (122 módulos) |
| API/banco — `validate:all` | **434 verificações, 434 aprovadas, 0 reprovadas** |
| Interface — Chrome | **207 verificações, 207 aprovadas, 0 reprovadas** |
| Interface — Edge | **207 verificações, 207 aprovadas, 0 reprovadas** |
| **Total** | **848 verificações, 848 aprovadas, 0 reprovadas, 0 falhas por serviço externo** |

Detalhe por suíte:

| API/banco | Verificações | | Interface (cada navegador) | Verificações |
| --- | --- | --- | --- | --- |
| `auth` | 67 | | Dashboard | 27 |
| `openaq` | 11 | | Admin | 54 |
| `fallback` | 40 | | Alertas | 18 |
| `fallback-total` | 32 | | Ocorrências | 21 |
| `dashboard` | 59 | | Histórico | 16 |
| `alertas` | 66 | | Sistema (fluxos completos) | 71 |
| `ocorrencias` | 96 | | | |
| `historico` | 63 | | | |

Observação: a interface foi executada duas vezes em cada navegador durante a QA (rodadas com defeitos e a passada final sobre o código final). Os números acima são os da **passada final**; os defeitos das rodadas anteriores estão na seção 7.

## 3. Testes funcionais

Os fluxos completos estão na suíte de **Sistema** (`validateSistemaUI.mjs`, 71 verificações por navegador); as suítes de Dashboard, Admin, Alertas, Ocorrências e Histórico aprofundam cada área.

**Fluxo USUARIO (A)**: cadastro pela tela (perfil USUARIO e cidade gravados no banco) → logout → login → Dashboard com cartões reais e sem texto fixo → sino e alertas batendo com o banco → lista de Alertas sem "Avaliar"/"Resolver" para USUARIO → filtros de nível e status e "Limpar filtros" → registro de ocorrência pelo formulário (status "Em aberto", autor, cidade e origem MANUAL conferidos no banco) → ocorrência aparece no Dashboard → Histórico da própria cidade (troca de poluente e origem do dado) → F5 em cada tela mantém a sessão → logout e Dashboard inacessível ao recarregar → sem erro de JavaScript nem 4xx/5xx inesperados.

**Fluxo ADMIN (B)**: login (menu completo, contadores reais) → navegação por Dashboard Admin, Usuários, Estações, Configurações, Relatórios, Alertas, Ocorrências e Histórico → troca de cidade (alertas e ocorrências acompanham) → ADMIN vê a ocorrência do usuário e a coloca "Em andamento" → resolve um alerta com confirmação (banco `RESOLVIDO`, sino diminui) → o USUARIO enxerga a mudança de status → acesso rápido do Dashboard Admin.

**Sessão e permissões (C)**: F5; token inválido guardado (401, sessão limpa); perfil adulterado no navegador é ignorado; credenciais erradas; usuário desativado não entra e, com sessão aberta, é desconectado com aviso; ADMIN rebaixado recebe 403 nas telas administrativas sem perder a sessão.

**Estados (D)**: carregando (com `/api/alertas` retida), erro (com `/api/alertas` derrubada, mensagem tratada e "Tentar novamente" recupera) e vazio (cidade sem alertas nem ocorrências).

**Fontes externas (E)**: OpenAQ fora do ar → Dashboard usa a Open-Meteo e rotula como estimativa de modelo, nunca como medição; OpenAQ e Open-Meteo fora → "Sem dados disponíveis", sem quebrar nem inventar valores.

## 4. Testes de integração

| Integração | Evidência |
| --- | --- |
| Frontend ↔ backend | todas as suítes de interface (as telas chamam a API real); 401 limpa a sessão, 403 mostra mensagem |
| Backend ↔ PostgreSQL/Supabase | `auth`, `alertas`, `ocorrencias` (constraints, transações, concorrência); a interface confere o banco após cada ação (criação, status, resolução) |
| Backend ↔ OpenAQ | `openaq` (11), `dashboard`, `historico` |
| Backend ↔ Open-Meteo | `fallback`, `fallback-total`, rota `/air-quality/modelo` (`dashboard`), `historico` (fonte `OPEN_METEO`) |
| Autenticação ↔ permissões | `auth` (67): 401, 403, perfil e atividade lidos do banco, IDs inválidos; Admin A16–A17; Sistema C |
| Cidade ↔ dados | `alertas`, `ocorrencias`, `historico` (USUARIO só a própria cidade); Sistema B03/B05 (troca de cidade); Histórico HS20–HS21 (cliente adulterado recebe 403) |
| Alertas ↔ banco | `alertas` (66): avaliação, duplicidade, resolução, concorrência; Sistema A05–A07, B06 |
| Ocorrências ↔ banco | `ocorrencias` (96): constraints, transições de status, concorrência; Sistema A08–A09, B04, B07 |
| Histórico ↔ APIs | `historico` (63); interface compara os totais da tela com a resposta da API (HS20) |
| Alertas → Ocorrências | **não existe e não foi testada** (não há integração implementada) |

## 5. Usabilidade (revisão prática, sem redesenho)

Revisão prática a partir dos fluxos executados e das capturas de tela de cada etapa (textos, botões, filtros, estados vazio/erro/carregando, modais e painéis; Esc fecha os painéis). Não houve avaliação com usuários nem teste de acessibilidade automatizado. Correções feitas apenas onde havia problema claro:

- Cabeçalho de Login, Cadastro e "Esqueci a senha" tinha os links **"Sobre", "Recursos" e "Ajuda" sem destino** (`href="#"`): foram removidos.
- Rodapé de "Esqueci a senha" mostrava "© 2024"; corrigido para 2026, como nas demais telas.
- Dashboard: textos ajustados para não afirmar que o ar está bom quando não há alertas (alertas só existem após a avaliação do ADMIN) e aviso de limiares provisórios.
- Dashboard: cartões mostram "Carregando" em vez de dados antigos ao trocar de cidade.

Observações **não alteradas** (registradas, sem correção): o menu volta ao Dashboard após F5 (o item ativo não fica na URL); alguns controles têm menos de 24 px de altura nas telas administrativas e de tabelas (medidos, sem mudança de desenho); mensagem de login inválido é a mesma para conta desativada (intencional, evita enumerar contas).

## 6. Compatibilidade

| Item | Resultado |
| --- | --- |
| Chrome | 207/207 |
| Edge | 207/207 |
| Firefox | **não testado**: os scripts usam o DevTools Protocol (Chromium/Edge) e o Firefox não está instalado no ambiente de testes |
| 1366 × 768, 768 × 1024 e 390 × 844 | USUARIO (Dashboard, Alertas, Ocorrências, Histórico) e ADMIN (todas as telas do menu): **sem rolagem horizontal global**, nenhum elemento além da borda direita fora de contêiner com rolagem própria (tabelas largas rolam dentro do próprio contêiner) e menu lateral, cabeçalho e botão Sair presentes (suíte Sistema, seção F). O Histórico tem verificação própria do gráfico, dos filtros e da tabela/cartões nas três larguras (RS01). Capturas de tela salvas para inspeção visual |
| Formulários, modais e painéis em 390 px | painel de detalhe do alerta, formulário de nova ocorrência e modal "Novo usuário" cabem na tela e fecham por Esc/"Cancelar" (Sistema F01–F02) |

## 7. QA — defeitos encontrados e corrigidos

### 7.1 Defeitos do sistema (corrigidos e retestados)

| # | Defeito | Correção |
| --- | --- | --- |
| 1 | Dashboard com dados fixos/ilustrativos nos cartões de Situação, Alertas, Ocorrências e Histórico | cartões ligados às APIs reais, com estados de carregando, vazio e erro (`useDashboardDados`) |
| 2 | Rota mock `/api/dashboard` no backend, com dados inventados | rota removida |
| 3 | `JWT_SECRET` com valor padrão (`'secret'`) quando a variável faltava | `config.ts`: o servidor não sobe sem `JWT_SECRET` |
| 4 | IDs numéricos gigantes em rotas administrativas e de estações geravam erro 5xx (502) | limite máximo de ID: resposta 400 |
| 5 | Validação de entrada fraca em cadastro e administração (tipos, tamanhos, senha > 72 bytes, e-mail) | validações adicionadas em `routes/auth.ts` e `routes/admin.ts` |
| 6 | Com a OpenAQ fora do ar desde o início, o Dashboard não tinha fallback por cidade | rota `GET /api/air-quality/modelo` (Open-Meteo, sem estação), hook e aviso no Dashboard |
| 7 | Cartões do Dashboard mostravam dado da cidade anterior durante o recarregamento | cartões mostram "Carregando" enquanto recarregam |
| 8 | Após logout ou troca de cidade, o hook de qualidade do ar ainda consultava as medições (requisição desnecessária, 401 sem token) | o hook confere o cancelamento antes de consultar |
| 9 | Links sem destino e ano de rodapé desatualizado (usabilidade) | ver seção 5 |

### 7.2 Defeitos dos scripts de teste (corrigidos)

| Script | Defeito |
| --- | --- |
| Sistema A10 | esperava um seletor de cidade que o USUARIO não tem (a cidade é fixa) |
| Sistema A07 | lia a lista de alertas antes do recarregamento do filtro (condição de corrida) |
| Sistema E01 / A12 / B08 | tratavam 502/503/504 de fonte externa como defeito; passaram a ser classificados como indisponibilidade externa (`[EXTERNO]`) |
| Admin A16 | usava a rota `/dashboard`, removida de propósito (defeito nº 2) |
| Admin B11 | esperava o Histórico como "placeholder", que já foi implementado |
| Alertas AR01 | contava como falha uma requisição sem resposta registrada (artefato do registro de rede) |
| Histórico HS20 | contava como falha a consulta do cartão do Dashboard cancelada ao trocar de tela |

### 7.3 Indisponibilidade externa e do ambiente de teste (não são defeitos do sistema)

- Perda momentânea de DNS para o banco (Supabase) no meio de uma rodada: falhas em cascata (500, telas sem abrir) e rodada descartada; repetida com sucesso.
- Processos de teste de rodadas interrompidas ficaram vivos e seguraram conexões do banco, o que gerou 500 em uma rodada do Histórico; processos encerrados e rodada repetida.
- Timeouts (504) e 503 transitórios da OpenAQ e da Open-Meteo em algumas rodadas; o sistema os tratou com fallback ou mensagem, e o runner passou a contá-los em separado.
- Registros temporários deixados por rodadas interrompidas foram removidos (restaram 0).

## 8. Limitações da validação

- Firefox não testado.
- Os dados das fontes externas variam com o tempo; as suítes comparam o sistema com a própria resposta das APIs, não com valores fixos.
- Não há teste de carga nem de acessibilidade automatizada (leitor de tela).
- A integração Alertas → Ocorrências não existe e, portanto, não é testada.
