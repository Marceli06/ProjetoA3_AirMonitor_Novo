# Ocorrências (backend)

Persistência real de ocorrências no PostgreSQL/Supabase. **Alertas não geram ocorrências automaticamente** (integração prevista para uma etapa futura).

## Tabela `ocorrencias` (`backend/init.sql`, aplicada por `npm run db:migrate`)

| Coluna | Observação |
| --- | --- |
| `id` | SERIAL, chave primária |
| `usuario_id` | autor (ocorrência manual); `NULL` se automática ou se o usuário for removido |
| `cidade`, `local` | obrigatórios |
| `estacao_id`, `estacao_nome` | opcionais |
| `tipo` | `POLUICAO`, `QUEIMADA`, `EMISSAO`, `COMUNIDADE`, `NORMALIZACAO` |
| `titulo` (3–160), `descricao` (3–2000) | obrigatórios |
| `status` | `ABERTA` (padrão), `EM_ANDAMENTO`, `CONCLUIDA` |
| `origem` | `AUTOMATICA`, `MANUAL` |
| `poluente`, `valor`, `unidade`, `nivel` | leitura ambiental opcional: poluente/valor/unidade vêm juntos; `nivel` (`BAIXO`..`CRITICO`) exige poluente |
| `criado_em`, `iniciado_em`, `atualizado_em`, `concluido_em` | `concluido_em` preenchido se, e somente se, `status = CONCLUIDA` |

Constraints no banco: enums (`CHECK`), conclusão coerente, `AUTOMATICA` sem usuário, leitura ambiental coerente, `valor >= 0`. Índices: cidade, status, tipo, criado_em, usuário.

## API (`/api/ocorrencias`, todas exigem `Authorization: Bearer <token>`)

| Rota | Quem | Resposta |
| --- | --- | --- |
| `GET /` | ADMIN (todas as cidades) / USUARIO (só a própria) | `{ total, pagina, limite, resumo, ocorrencias }` |
| `GET /:id` | idem; USUARIO recebe 404 para ocorrência de outra cidade | `{ ocorrencia }` |
| `POST /` | ADMIN (informa `cidade`) / USUARIO (cidade do cadastro) | 201 `{ ocorrencia }` |
| `PATCH /:id/status` | somente ADMIN | `{ ocorrencia }` |

Filtros do `GET /`: `cidade`, `status`, `tipo` (case-insensitive), `de` e `ate` (AAAA-MM-DD, fuso America/Sao_Paulo, inclusivos), `pagina` (>= 1), `limite` (1–200, padrão 50). Ordem: não concluídas primeiro, depois mais recentes. `resumo` conta por status na cidade/período, ignorando o filtro de status.

`POST`: corpo com `local`, `titulo`, `descricao`, `tipo` (+ opcionais `cidade`, `estacaoId`, `estacaoNome`, `poluente`, `valor`, `unidade`, `nivel`). `status`, `origem` e `usuarioId` são sempre definidos pelo servidor; qualquer campo desconhecido gera 400.

`PATCH`: corpo apenas `{ "status": "EM_ANDAMENTO" | "CONCLUIDA" }`. Transições: `ABERTA → EM_ANDAMENTO → CONCLUIDA` ou `ABERTA → CONCLUIDA`; `CONCLUIDA` é final. Transição inválida ou repetida: 409. A alteração roda em transação com `SELECT ... FOR UPDATE` (conclusões simultâneas: uma 200, as demais 409).

Códigos: 400 dado/filtro/ID inválido (inclui JSON malformado); 401 sem token/token inválido/usuário inativo; 403 permissão ou cidade alheia/ausente; 404 inexistente (ou de outra cidade para USUARIO); 409 transição inválida.

## Decisão sobre permissões

O pedido dizia que USUARIO "não pode alterar ocorrência de outra cidade" e que ADMIN "pode alterar status". Foi adotada a leitura mais restritiva: **só ADMIN altera status**; USUARIO recebe 403 no `PATCH`, em qualquer cidade. Para permitir que o USUARIO altere ocorrências da própria cidade, basta remover `requireAdmin` da rota e checar a cidade (como em `GET /:id`).

## Validação

`npm run ocorrencias:validate` (backend em `BASE_URL`, padrão `http://127.0.0.1:3996/api`): estrutura da tabela, constraints, validação de entrada, 401/403/404/409, filtros, paginação, ADMIN x USUARIO, fluxo de status, concorrência e limpeza. Registros de teste usam o prefixo `[TESTE]` e usuários `tmp.ocorr.*`, removidos ao final.

## Pendências

- Integração Alertas → Ocorrências (origem `AUTOMATICA`).
- Ligar o frontend (`OccurrencesPage`, hoje com dados ilustrativos) à API; o frontend usa `registro AUTOMATICO|COMUNIDADE`, etapas e observações, que precisam ser mapeados para `origem`/`status`.
