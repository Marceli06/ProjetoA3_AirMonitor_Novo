# Histórico de medições (backend)

Consulta a série temporal de um poluente em uma cidade, com a origem de cada ponto. A tela `HistoryPage.tsx` consome esta API; o cartão "Últimas 24 horas" do Dashboard usa a mesma rota (período `24H`, fonte `AUTO`).

Nada é gravado no banco: o histórico é lido das fontes externas (OpenAQ e Open-Meteo) e mantido em cache em memória.

## API

`GET /api/historico` — exige `Authorization: Bearer <token>`.

| Parâmetro | Obrigatório | Valores |
| --- | --- | --- |
| `cidade` | ADMIN: sim. USUARIO: não (omitida = a própria) | uma das cidades atendidas |
| `poluente` | sim | `pm25`, `pm10`, `o3`, `no2`, `co`, `so2` |
| `periodo` | não (padrão `24H`) | `24H`, `7D`, `30D` |
| `fonte` | não (padrão `AUTO`) | `AUTO`, `OPENAQ`, `OPEN_METEO` |
| `estacaoId` | não | inteiro positivo (até 2147483647); só com `AUTO` ou `OPENAQ` |

Cada parâmetro precisa ser **um** texto não vazio (`?a=1&a=2` é recusado).

### Fontes

- `AUTO`: usa a estação mais próxima **com dados no período** (no máximo 3 candidatas por consulta, por causa do limite de 60 requisições por minuto da OpenAQ). Se nenhuma servir, ou se a OpenAQ estiver fora do ar, cai para o **modelo** Open-Meteo e devolve `aviso` explicando.
- `OPENAQ`: só estação; sem dado, resposta vazia com `mensagem`.
- `OPEN_METEO`: só o modelo (CAMS); `estacaoId` não se aplica (400).

Cada ponto indica `origem` e `tipoDado` (`MEDICAO` = estação; `MODELO` = estimativa, **nunca** uma medição local).

### Resposta (200)

| Campo | Conteúdo |
| --- | --- |
| `cidade`, `poluente` | cidade e `{ chave, nome, unidade }` |
| `periodo` | `{ codigo, rotulo, de, ate }` |
| `fonteSolicitada` | a fonte pedida |
| `total`, `pontos` | série em ordem cronológica: `dataHora` (UTC), `valor`, `unidade`, `poluente`, `estacaoId`, `estacaoNome`, `origem`, `tipoDado` |
| `resumo` | `{ minimo, maximo, media, ultimo }`; **`null` quando a série é vazia** (não inventa números) |
| `estacao` / `estacoes` | estação usada e estações da cidade, com `comDadosNoPeriodo` |
| `fontesUtilizadas`, `statusFontes` | origens que contribuíram e o estado de cada fonte (`ok`, `sem_dado`, `falha`, `nao_consultada`; a Open-Meteo também pode ser `nao_necessaria`) |
| `atribuicoes` | textos de atribuição exigidos pelas licenças (exibidos na tela) |
| `aviso`, `mensagem` | aviso de troca de fonte; mensagem quando não há dados |

### Permissões e erros

- **USUARIO**: só a própria cidade. Pedir outra cidade devolve **403**. Usuário sem cidade cadastrada, 403.
- **ADMIN**: qualquer cidade suportada (a `cidade` é obrigatória).
- 400: parâmetro inválido, ausente ou repetido; cidade fora da lista; `estacaoId` inválido.
- 401: sem token, token inválido ou usuário desativado.
- Falhas das fontes externas viram os códigos de erro tratados do serviço (por exemplo 502/503/504 quando a fonte escolhida não responde); em `AUTO` a falha temporária da OpenAQ aciona o modelo em vez de erro. Chave da OpenAQ ausente ou recusada e resposta malformada **não** acionam o fallback: continuam sendo erro.

## Cache

| Dado | TTL |
| --- | --- |
| Série da OpenAQ por sensor e período | 10 min |
| Série da Open-Meteo por coordenada, variável e período | 30 min |

## Validação

`npm run historico:validate` (63 verificações): parâmetros, permissões (ADMIN x USUARIO, 403 em outra cidade), as três fontes, resumo coerente com a série, série vazia com resumo nulo e a falha de fonte (OpenAQ fora do ar com `fonte=AUTO` → modelo com aviso e `OPENAQ=falha`). A interface é validada por `validateHistoricoUI.mjs` (16 verificações por navegador).
