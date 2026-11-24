# Alertas de qualidade do ar (backend)

Os alertas são gerados pelo backend a partir dos dados ambientais que o AirMonitor já consulta
(OpenAQ como fonte principal, Open-Meteo como complementar), gravados no PostgreSQL/Supabase e
expostos pela API `/api/alertas`, que a tela `AlertsPage.tsx` consome (USUARIO vê só a sua cidade; ADMIN vê qualquer cidade e pode avaliar e resolver).

## Atenção: limiares provisórios

O projeto **não define limites oficiais** por poluente. Os valores em `src/data/limiaresAlertas.ts` são
**parâmetros técnicos provisórios**, criados só para a arquitetura funcionar e ser testada. Não são limites
oficiais, não foram validados por nenhum órgão e não devem ser apresentados como tais.
As respostas da API trazem `limiaresProvisorios: true` e a descrição de cada alerta cita "limiar técnico provisório".

**Pendente (decisão da equipe):** escolher a norma/tabela de referência e os valores finais. Basta editar
`limiaresAlertas.ts`; nenhum outro arquivo contém limiares. Não há cálculo de IQA.

Limiares mínimos em µg/m³ (provisórios):

| Poluente | BAIXO | MODERADO | ALTO | CRÍTICO |
|----------|-------|----------|------|---------|
| PM2.5 (`pm25`) | 15 | 35 | 75 | 125 |
| PM10 (`pm10`) | 45 | 100 | 150 | 250 |
| O₃ (`o3`) | 100 | 130 | 160 | 200 |
| NO₂ (`no2`) | 100 | 200 | 240 | 320 |
| CO (`co`) | 5000 | 10000 | 15000 | 30000 |
| SO₂ (`so2`) | 40 | 125 | 250 | 500 |

O nível é o **maior** cujo limiar o valor atingiu (`valor >= limiar`). Abaixo do limiar de BAIXO não há alerta.

## Fluxo

```
POST /api/alertas/avaliar (ADMIN)
  -> services/alertas.ts: avaliarCidade
     -> buscarEstacoes (OpenAQ, com cache)            [services/airQuality.ts]
     -> obterUltimasMedicoes por estação (consolidador: OpenAQ, ou Open-Meteo no fallback)
     -> avaliarPoluente por poluente: valida -> classifica -> cria/atualiza/resolve -> grava
```

Nada é duplicado: a avaliação reaproveita a busca de estações, o consolidador e o cache já existentes.
A rota **não aceita valores prontos**: o alerta só nasce de dado obtido pelo próprio backend.
As regras ficam em `services/alertas.ts`; as rotas só autenticam, validam a entrada e chamam o serviço.

## Tabela `alertas`

Criada por `init.sql` (`CREATE TABLE IF NOT EXISTS`, aplicada com `npm run db:migrate`; não altera dados existentes).

| Coluna | Tipo | Observação |
|--------|------|------------|
| `id` | SERIAL PK | |
| `cidade` | VARCHAR(80) | uma das cidades de `data/cidades.ts` |
| `regiao` | VARCHAR(80) NULL | as estações da OpenAQ não pertencem a uma região do AirMonitor: hoje fica `NULL` |
| `estacao_id` | VARCHAR(40) | id da estação OpenAQ; no fallback, a estação cuja coordenada consultou a Open-Meteo |
| `estacao_nome` | VARCHAR(255) NULL | |
| `poluente` | VARCHAR(10) | `pm25, pm10, o3, no2, co, so2` (CHECK) |
| `valor` | DOUBLE PRECISION | em µg/m³, `>= 0` |
| `unidade` | VARCHAR(20) | sempre `µg/m³` |
| `nivel` | VARCHAR(10) | `BAIXO, MODERADO, ALTO, CRITICO` (CHECK) |
| `titulo`, `descricao` | VARCHAR(160), TEXT | montados pelo serviço |
| `status` | VARCHAR(10) | `ATIVO` (padrão) ou `RESOLVIDO` (CHECK) |
| `origem_dado` | VARCHAR(20) | `OPENAQ` ou `OPEN_METEO` (CHECK) |
| `tipo_dado` | VARCHAR(10) | `MEDICAO` ou `MODELO` (CHECK) |
| `medicao_em` | TIMESTAMPTZ | instante do dado que gerou/atualizou o alerta |
| `criado_em`, `atualizado_em` | TIMESTAMPTZ | padrão `NOW()` |
| `resolvido_em` | TIMESTAMPTZ NULL | preenchido se, e somente se, `status = RESOLVIDO` (CHECK) |

Constraints: `OPENAQ` só com `MEDICAO` e `OPEN_METEO` só com `MODELO` (uma estimativa nunca é gravada como medição).
Índices: `cidade`, `status`, `poluente`, `medicao_em DESC` e o índice único parcial `uq_alertas_ativo`.

Diferença de padrão: as tabelas antigas usam `TIMESTAMP` (sem fuso); `alertas` usa `TIMESTAMPTZ` para que o horário
não dependa do fuso do servidor Node.

## Unidades

Só **µg/m³** é comparado com os limiares (aceita as grafias `µg/m³`, `μg/m³` e `ug/m3`). Qualquer outra unidade
(`ppm`, `ppb`, `mg/m³`...) torna o poluente **não avaliável**: nenhum alerta é criado nem resolvido. Nenhuma
conversão é feita (ppm <-> µg/m³ depende de temperatura, pressão e massa molar).
**Pendente:** decidir se haverá conversão (por exemplo mg/m³ -> µg/m³, que é exata) para aproveitar sensores da
OpenAQ que reportam em outra unidade.

Também não geram nem resolvem alerta: valor ausente, negativo ou não numérico; unidade ausente; data inválida;
medição com mais de 6 h (`LIMITE_DEFASAGEM_HORAS`); cidade, estação ou origem inválidas.

## Origem do dado

O consolidador decide a fonte de cada poluente. O alerta guarda a origem **do valor que o gerou**:
`OPENAQ` (`MEDICAO`: sensor de estação) ou `OPEN_METEO` (`MODELO`: estimativa CAMS, não é medição local).
A descrição diferencia os dois ("medido" x "Estimativa do modelo CAMS ... Não é uma medição local").
Quando a Open-Meteo é usada, o frontend deve exibir a atribuição exigida pela licença (ver `ATRIBUICAO_OPEN_METEO`).

## Duplicidade

Existe no máximo **um alerta ATIVO por (cidade, estação, poluente)**, garantido pelo índice único parcial.

- mesmo nível: **atualiza** o alerta ativo (valor, origem, tipo, medição, texto, `atualizado_em`);
- nível diferente: **resolve** o ativo anterior e **cria** outro no novo nível (preserva o histórico da escalada);
- medição mais antiga que a do alerta ativo: ignorada (não regride o estado);
- avaliações simultâneas: cada transação pega um lock consultivo (`pg_advisory_xact_lock`) da chave
  cidade+estação+poluente, então as avaliações da mesma chave rodam em fila; o índice único parcial continua como
  trava final (se ainda assim houver conflito, a operação repete como atualização).

## Resolução

- **Automática:** uma medição válida, atual e abaixo do limiar de BAIXO resolve o alerta ativo (`status = RESOLVIDO`,
  `resolvido_em` preenchido). Dado ausente/inválido/antigo/em outra unidade **não** resolve, porque a condição real é desconhecida.
- **Manual:** `POST /api/alertas/:id/resolver` (ADMIN).
- **Pendente:** não há histerese nem tempo mínimo de permanência; o alerta resolve na primeira leitura abaixo do limiar.
  Também não há execução periódica: a avaliação roda quando um ADMIN chama `/api/alertas/avaliar`
  (o serviço `avaliarCidade` está pronto para ser chamado por um agendador futuro).

## API (todas exigem token)

| Rota | Quem | Descrição |
|------|------|-----------|
| `GET /api/alertas` | USUARIO e ADMIN | filtros `cidade, status, nivel, poluente, limite (1-200, padrão 50), pagina` |
| `GET /api/alertas/:id` | USUARIO e ADMIN | USUARIO só vê alerta da sua cidade (outra cidade responde 404) |
| `POST /api/alertas/avaliar` | só ADMIN | corpo `{ "cidade": "São Paulo", "limite": 5 }` (limite de estações 1-10, padrão 5) |
| `POST /api/alertas/:id/resolver` | só ADMIN | 200 resolvido, 404 inexistente, 409 já resolvido |

- **USUARIO:** só a cidade cadastrada nele (lida do banco). `?cidade=` de outra cidade devolve 403; usuário sem cidade, 403.
- **ADMIN:** qualquer cidade suportada, ou todas se omitir `cidade`. Cidade fora da lista devolve 400.
- Perfil e status do usuário vêm do banco a cada requisição (`authMiddleware`); filtros inválidos devolvem 400;
  todas as consultas usam parâmetros (`$n`).
- A avaliação exige `cidade` (uma por chamada) para respeitar o limite de 60 req/min da OpenAQ.

## Validação

```
npm run db:migrate
BASE_URL=http://127.0.0.1:3996/api npm run alertas:validate            # regras, serviço, banco, rotas e ponta a ponta real
npm run alertas:validate -- --so-regras                                # só as regras puras (sem banco nem servidor)
```

Os cenários usam estações fictícias `TESTE-*` e usuários `tmp.alertas.*`, apagados no final.
