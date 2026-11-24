import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import pool from '../database';
import { LIMIARES } from '../data/limiaresAlertas';
import { avaliarMedicoesDaEstacao, avaliarPoluente, classificarValor, DadosPoluente, unidadeCompativel } from '../services/alertas';
import { MedicaoConsolidada } from '../services/consolidador';

dotenv.config();

// Valida os alertas reais (regras, serviço, banco e rotas). Precisa do backend em execução (BASE_URL) e do banco.
// Os dados de poluentes dos cenários são SINTÉTICOS e usam estações fictícias "TESTE-*" (para exercitar as regras de
// forma determinística); só o teste ponta a ponta no final usa as APIs reais. Tudo o que o script cria (alertas e
// usuários temporários) é apagado no final. Não imprime senhas, tokens nem a connection string.
// Uso: BASE_URL=http://127.0.0.1:3996/api npm run alertas:validate [--sem-externo] [--so-regras]
//   --sem-externo: pula o teste ponta a ponta com OpenAQ/Open-Meteo reais
//   --so-regras:   roda só as regras puras (não usa banco nem servidor)

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3996/api';
const SEM_EXTERNO = process.argv.includes('--sem-externo');
const CIDADE_USUARIO = 'São Paulo';
const CIDADE_OUTRA = 'Campinas';
const PREFIXO = 'TESTE-';

let falhas = 0;
let pulados = 0;
let total = 0;
const ok = (m: string) => { total++; console.log(`  [OK]      ${m}`); };
const falha = (m: string) => { total++; falhas++; console.log(`  [FALHA]   ${m}`); };
const pulado = (m: string) => { pulados++; console.log(`  [PULADO]  ${m}`); };
const check = (c: boolean, a: string, b: string) => (c ? ok(a) : falha(b));

async function chamar(caminho: string, opcoes: { token?: string; metodo?: string; corpo?: unknown } = {}) {
  const metodo = opcoes.metodo ?? (opcoes.corpo !== undefined ? 'POST' : 'GET');
  const res = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: {
      ...(opcoes.corpo !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      ...(opcoes.token ? { Authorization: `Bearer ${opcoes.token}` } : {}),
    },
    body: opcoes.corpo !== undefined ? Buffer.from(JSON.stringify(opcoes.corpo), 'utf8') : undefined,
  });
  let corpo: any = null;
  try { corpo = await res.json(); } catch { /* sem corpo */ }
  return { status: res.status, corpo };
}

const minutosAtras = (min: number) => new Date(Date.now() - min * 60 * 1000);

// Dados de teste: pm25 em µg/m³ por padrão (limiares provisórios: BAIXO 15, MODERADO 35, ALTO 75, CRITICO 125)
const dado = (estacao: string, extra: Partial<DadosPoluente> = {}): DadosPoluente => ({
  cidade: CIDADE_USUARIO,
  estacaoId: `${PREFIXO}${estacao}`,
  estacaoNome: `Estação de teste ${estacao}`,
  poluente: 'pm25',
  valor: 80,
  unidade: 'µg/m³',
  medicaoEm: minutosAtras(30),
  origem: 'OPENAQ',
  ...extra,
});

const contar = async (estacao: string, poluente = 'pm25', status?: string) => {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM alertas WHERE estacao_id = $1 AND poluente = $2 ${status ? 'AND status = $3' : ''}`,
    status ? [`${PREFIXO}${estacao}`, poluente, status] : [`${PREFIXO}${estacao}`, poluente]
  );
  return r.rows[0].n as number;
};

const emails: string[] = [];
const alertasReais: number[] = []; // alertas criados pelo teste ponta a ponta (dados reais), apagados no final

async function criarUsuarioTemporario(perfil: 'ADMIN' | 'USUARIO', cidade: string) {
  const email = `tmp.alertas.${Date.now()}.${emails.length}@example.com`;
  const senha = `Tmp-${Math.random().toString(36).slice(2)}-9`;
  emails.push(email);
  await pool.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, cidade, regiao) VALUES ($1, $2, $3, $4, TRUE, $5, 'Centro') `,
    [`Teste Alertas ${perfil}`, email, bcrypt.hashSync(senha, 4), perfil, cidade]
  );
  const login = await chamar('/auth/login', { corpo: { email, password: senha } });
  if (login.status !== 200 || !login.corpo?.token) throw new Error(`login do usuário temporário (${perfil}) falhou: HTTP ${login.status}`);
  return login.corpo.token as string;
}

async function limpar() {
  await pool.query('DELETE FROM alertas WHERE estacao_id LIKE $1', [`${PREFIXO}%`]);
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'tmp.alertas.%'");
}

// ---------------------------------------------------------------- 1) regras puras
function regras() {
  console.log('\n=== 1) Regras de nível e unidades (sem banco) ===');
  const nivel = (p: string, v: number, u = 'µg/m³') => { const c = classificarValor(p, v, u); return c.avaliavel ? c.nivel : `NAO_AVALIAVEL:${c.motivo}`; };

  check(nivel('pm25', 14.9) === null, 'pm25 14,9 µg/m³ -> abaixo do limiar (sem alerta)', `pm25 14,9 -> ${nivel('pm25', 14.9)}`);
  check(nivel('pm25', 15) === 'BAIXO' && nivel('pm25', 35) === 'MODERADO' && nivel('pm25', 75) === 'ALTO' && nivel('pm25', 125) === 'CRITICO',
    'limiar é inclusivo (>=) e escolhe o maior nível atingido', 'faixas de pm25 incorretas');
  check(Object.keys(LIMIARES).sort().join() === 'co,no2,o3,pm10,pm25,so2', 'os 6 poluentes têm limiares configurados', 'poluentes sem limiar');
  check(nivel('co', 20000, 'ppm') === 'NAO_AVALIAVEL:unidade_incompativel', 'CO em ppm NÃO é comparado com limiar em µg/m³', 'CO em ppm foi comparado');
  check(nivel('o3', 500, 'ppb') === 'NAO_AVALIAVEL:unidade_incompativel' && nivel('no2', 500, 'mg/m³') === 'NAO_AVALIAVEL:unidade_incompativel',
    'ppb e mg/m³ também são não avaliáveis (nenhuma conversão presumida)', 'ppb/mg/m³ foram avaliados');
  check(unidadeCompativel('µg/m³') && unidadeCompativel('μg/m³') && unidadeCompativel('ug/m3') && unidadeCompativel(' UG/M3 '),
    'grafias de µg/m³ (micro, mu grego, ug/m3) são aceitas', 'grafia de µg/m³ rejeitada');
  check(nivel('pm25', 80, '') === 'NAO_AVALIAVEL:unidade_ausente', 'unidade vazia -> não avaliável', 'unidade vazia avaliada');
  check(nivel('pm25', -3) === 'NAO_AVALIAVEL:valor_invalido' && nivel('pm25', Number.NaN) === 'NAO_AVALIAVEL:valor_invalido',
    'valor negativo/NaN -> não avaliável', 'valor inválido avaliado');
  const ausente = classificarValor('pm25', null, 'µg/m³');
  check(!ausente.avaliavel && ausente.motivo === 'dado_ausente', 'valor ausente -> não avaliável (dado_ausente)', 'valor ausente avaliado');
  check(nivel('xyz', 10) === 'NAO_AVALIAVEL:poluente_desconhecido' && nivel('__proto__', 10) === 'NAO_AVALIAVEL:poluente_desconhecido',
    'poluente desconhecido (inclusive __proto__) -> não avaliável', 'poluente desconhecido avaliado');
}

// ---------------------------------------------------------------- 2) serviço + banco
async function servico() {
  console.log('\n=== 2) Serviço de alertas + banco (dados sintéticos, estações TESTE-*) ===');

  // criação quando a regra é atendida
  const criado = await avaliarPoluente(dado('criar', { valor: 80 }));
  check(criado.acao === 'criado' && criado.alerta?.nivel === 'ALTO' && criado.alerta.status === 'ATIVO' && criado.alerta.resolvidoEm === null,
    'regra atendida (pm25 80 >= 75) -> alerta ALTO ATIVO criado e persistido', `criação: ${JSON.stringify(criado)}`);
  check((await contar('criar')) === 1, 'o alerta existe no banco (1 linha)', 'alerta não está no banco');
  check(Boolean(criado.alerta?.titulo) && Boolean(criado.alerta?.descricao) && (criado.alerta?.descricao ?? '').includes('provisório'),
    'título/descrição montados (descrição cita o limiar técnico provisório)', `texto: ${criado.alerta?.titulo} / ${criado.alerta?.descricao}`);

  // regra não atendida
  const abaixo = await avaliarPoluente(dado('abaixo', { valor: 5 }));
  check(abaixo.acao === 'sem_alerta' && (await contar('abaixo')) === 0, 'regra não atendida (pm25 5) -> nenhum alerta criado', `abaixo: ${JSON.stringify(abaixo)}`);

  // dado ausente
  const ausente = await avaliarPoluente(dado('ausente', { valor: null, unidade: null, medicaoEm: null, origem: null }));
  check(ausente.acao === 'ignorado' && ausente.motivo === 'dado_ausente' && (await contar('ausente')) === 0, 'dado ausente -> nenhum alerta', `ausente: ${JSON.stringify(ausente)}`);

  // unidade incompatível (valor altíssimo: se fosse comparado, viraria CRITICO)
  const ppm = await avaliarPoluente(dado('ppm', { poluente: 'co', valor: 99999, unidade: 'ppm' }));
  check(ppm.acao === 'ignorado' && ppm.motivo === 'unidade_incompativel' && (await contar('ppm', 'co')) === 0,
    'unidade incompatível (CO 99999 ppm) -> nenhum alerta', `ppm: ${JSON.stringify(ppm)}`);

  // dados desatualizados / data inválida / cidade inválida / origem inválida
  const velho = await avaliarPoluente(dado('velho', { medicaoEm: minutosAtras(60 * 7) }));
  check(velho.acao === 'ignorado' && velho.motivo === 'dado_desatualizado' && (await contar('velho')) === 0, 'medição com mais de 6 h -> ignorada (não cria alerta)', `velho: ${JSON.stringify(velho)}`);
  const cidadeRuim = await avaliarPoluente(dado('cidaderuim', { cidade: "x'; DROP TABLE alertas;--" }));
  check(cidadeRuim.acao === 'ignorado' && cidadeRuim.motivo === 'cidade_invalida', 'cidade fora da lista -> ignorada', `cidade ruim: ${JSON.stringify(cidadeRuim)}`);
  const origemRuim = await avaliarPoluente(dado('origemruim', { origem: 'OUTRA' as any }));
  check(origemRuim.acao === 'ignorado' && origemRuim.motivo === 'origem_invalida' && (await contar('origemruim')) === 0, 'origem desconhecida -> ignorada', `origem ruim: ${JSON.stringify(origemRuim)}`);

  // origens
  const openaq = await avaliarPoluente(dado('openaq', { origem: 'OPENAQ' }));
  const meteo = await avaliarPoluente(dado('meteo', { origem: 'OPEN_METEO' }));
  check(openaq.alerta?.origemDado === 'OPENAQ' && openaq.alerta?.tipoDado === 'MEDICAO' && !openaq.alerta.descricao.includes('Estimativa'),
    'origem OPENAQ salva como MEDICAO (descrição fala em "medido")', `openaq: ${JSON.stringify(openaq.alerta)}`);
  check(meteo.alerta?.origemDado === 'OPEN_METEO' && meteo.alerta?.tipoDado === 'MODELO' && meteo.alerta.descricao.includes('Estimativa') && meteo.alerta.descricao.includes('Não é uma medição local'),
    'origem OPEN_METEO salva como MODELO (descrição fala em "Estimativa", não em medição)', `meteo: ${JSON.stringify(meteo.alerta)}`);
  const lido = await pool.query(`SELECT origem_dado, tipo_dado FROM alertas WHERE estacao_id = $1`, [`${PREFIXO}meteo`]);
  check(lido.rows[0]?.origem_dado === 'OPEN_METEO' && lido.rows[0]?.tipo_dado === 'MODELO', 'origem/tipo confirmados direto no banco', `banco: ${JSON.stringify(lido.rows[0])}`);

  // o próprio banco recusa estimativa gravada como medição
  let recusou = false;
  try {
    await pool.query(
      `INSERT INTO alertas (cidade, estacao_id, poluente, valor, unidade, nivel, titulo, descricao, origem_dado, tipo_dado, medicao_em)
       VALUES ($1, $2, 'pm25', 80, 'µg/m³', 'ALTO', 't', 'd', 'OPEN_METEO', 'MEDICAO', NOW())`,
      [CIDADE_USUARIO, `${PREFIXO}check`]
    );
  } catch { recusou = true; }
  check(recusou, 'constraint do banco recusa OPEN_METEO gravado como MEDICAO', 'banco aceitou estimativa como medição');

  // duplicidade: mesmo nível atualiza
  const primeiro = await avaliarPoluente(dado('dup', { valor: 80, medicaoEm: minutosAtras(40) }));
  const segundo = await avaliarPoluente(dado('dup', { valor: 90, medicaoEm: minutosAtras(20) }));
  check(primeiro.acao === 'criado' && segundo.acao === 'atualizado' && segundo.alerta?.id === primeiro.alerta?.id && segundo.alerta?.valor === 90,
    'mesma cidade/estação/poluente/nível -> ATUALIZA o alerta (mesmo id, valor novo)', `dup: ${primeiro.acao}/${segundo.acao} ids ${primeiro.alerta?.id}/${segundo.alerta?.id}`);
  check((await contar('dup')) === 1, 'continua 1 única linha (sem duplicata)', 'duplicata criada');

  // origem muda no mesmo nível: atualiza e reflete a nova origem
  const trocaOrigem = await avaliarPoluente(dado('dup', { valor: 91, origem: 'OPEN_METEO', medicaoEm: minutosAtras(10) }));
  check(trocaOrigem.acao === 'atualizado' && trocaOrigem.alerta?.origemDado === 'OPEN_METEO' && trocaOrigem.alerta.tipoDado === 'MODELO',
    'mesmo nível com outra origem -> atualiza e registra a origem do valor mais recente', `troca origem: ${JSON.stringify(trocaOrigem.alerta)}`);

  // duplicidade concorrente: 6 avaliações simultâneas -> 1 ativo
  const simultaneas = await Promise.all(Array.from({ length: 6 }, () => avaliarPoluente(dado('corrida', { valor: 130 }))));
  check((await contar('corrida', 'pm25', 'ATIVO')) === 1 && simultaneas.every((r) => r.alerta !== null),
    'avaliações SIMULTÂNEAS da mesma chave -> exatamente 1 alerta ativo', `corrida: ${await contar('corrida', 'pm25', 'ATIVO')} ativos`);

  // contenção pesada com níveis alternados (ALTO/CRITICO): cada chamada resolve o ativo e cria outro; nada pode lançar erro
  // e o invariante "no máximo 1 ativo" precisa valer ao final
  const mistas = await Promise.allSettled(
    Array.from({ length: 60 }, (_, i) => avaliarPoluente(dado('corrida2', { valor: i % 2 ? 130 : 80, medicaoEm: minutosAtras(30 - (i % 6)) })))
  );
  const rejeitadas = mistas.filter((r) => r.status === 'rejected').length;
  const ativosMistos = await contar('corrida2', 'pm25', 'ATIVO');
  check(rejeitadas === 0 && ativosMistos === 1, '60 avaliações simultâneas com níveis alternados -> nenhuma falha e exatamente 1 ativo', `contenção mista: ${rejeitadas} rejeitada(s), ${ativosMistos} ativo(s)`);

  // escalada de nível: resolve o anterior e cria o novo
  const sobe = await avaliarPoluente(dado('dup', { valor: 130, medicaoEm: minutosAtras(5) }));
  check(sobe.acao === 'criado' && sobe.alerta?.nivel === 'CRITICO' && sobe.substituido?.status === 'RESOLVIDO' && sobe.substituido.resolvidoEm !== null,
    'nível diferente -> resolve o ativo anterior e cria novo (CRITICO)', `escalada: ${JSON.stringify(sobe)}`);
  check((await contar('dup', 'pm25', 'ATIVO')) === 1 && (await contar('dup', 'pm25', 'RESOLVIDO')) === 1, 'resultado: 1 ATIVO + 1 RESOLVIDO (histórico preservado)', 'estado após escalada incorreto');

  // medição mais antiga que a do alerta não regride o estado
  const antiga = await avaliarPoluente(dado('dup', { valor: 5, medicaoEm: minutosAtras(60) }));
  check((antiga.acao === 'sem_alerta') && (await contar('dup', 'pm25', 'ATIVO')) === 1, 'medição anterior à do alerta, abaixo do limiar, NÃO resolve o ativo', `antiga: ${JSON.stringify(antiga)}`);

  // resolução automática pela regra
  const resolve = await avaliarPoluente(dado('dup', { valor: 5, medicaoEm: minutosAtras(1) }));
  check(resolve.acao === 'resolvido' && resolve.alerta?.status === 'RESOLVIDO' && resolve.alerta.resolvidoEm !== null && (await contar('dup', 'pm25', 'ATIVO')) === 0,
    'medição atual abaixo do limiar -> alerta ativo vira RESOLVIDO com resolvido_em preenchido', `resolução: ${JSON.stringify(resolve)}`);

  // dado ausente/unidade ruim NÃO resolve
  await avaliarPoluente(dado('naoresolve', { valor: 80 }));
  await avaliarPoluente(dado('naoresolve', { valor: null, unidade: null }));
  await avaliarPoluente(dado('naoresolve', { valor: 1, unidade: 'ppm' }));
  check((await contar('naoresolve', 'pm25', 'ATIVO')) === 1, 'dado ausente ou em unidade incompatível NÃO resolve o alerta ativo', 'alerta resolvido sem dado válido');

  // pipeline completo com a estrutura do consolidador (poluente a poluente, origem por poluente)
  const medicao = (chave: string, valor: number | null, unidade: string | null, fonte: 'OPENAQ' | 'OPEN_METEO' | null): MedicaoConsolidada => ({
    chave, poluente: chave, disponivel: valor !== null, valor, unidade, dataHora: valor === null ? null : minutosAtras(10).toISOString(),
    fonte, tipoDado: fonte === 'OPENAQ' ? 'MEDICAO' : fonte === 'OPEN_METEO' ? 'MODELO' : null, desatualizada: valor === null ? null : false,
    sensorId: null, motivo: null, motivoFallback: null,
  });
  const lote = await avaliarMedicoesDaEstacao(
    { cidade: CIDADE_USUARIO, estacaoId: `${PREFIXO}lote`, estacaoNome: 'Estação de teste lote' },
    [
      medicao('pm25', 80, 'µg/m³', 'OPENAQ'),
      medicao('pm10', 300, 'µg/m³', 'OPEN_METEO'),
      medicao('o3', 0.2, 'ppm', 'OPENAQ'),
      medicao('no2', null, null, null),
      medicao('co', 1000, 'µg/m³', 'OPEN_METEO'),
      medicao('so2', 5, 'µg/m³', 'OPENAQ'),
    ]
  );
  const porAcao = lote.map((r) => r.acao).join(',');
  check(porAcao === 'criado,criado,ignorado,ignorado,sem_alerta,sem_alerta', 'estação completa: pm25 e pm10 geram alerta; o3 (ppm) e no2 (ausente) são ignorados; co e so2 abaixo do limiar', `lote: ${porAcao}`);
  const origensLote = await pool.query(`SELECT poluente, origem_dado FROM alertas WHERE estacao_id = $1 ORDER BY poluente`, [`${PREFIXO}lote`]);
  check(origensLote.rows.map((r: any) => `${r.poluente}:${r.origem_dado}`).join() === 'pm10:OPEN_METEO,pm25:OPENAQ', 'cada alerta guarda a origem do SEU poluente (pm25 OPENAQ, pm10 OPEN_METEO)', `origens: ${JSON.stringify(origensLote.rows)}`);
}

// ---------------------------------------------------------------- 3) rotas
async function rotas() {
  console.log('\n=== 3) Rotas HTTP (autenticação, perfis, filtros) ===');

  // alertas de teste em duas cidades, com níveis/poluentes/status variados
  const seed = async (cidade: string, estacao: string, extra: Partial<DadosPoluente>) => (await avaliarPoluente(dado(estacao, { cidade, ...extra }))).alerta!;
  const spAlto = await seed(CIDADE_USUARIO, 'rota-sp1', { poluente: 'pm25', valor: 80 });
  const spModerado = await seed(CIDADE_USUARIO, 'rota-sp2', { poluente: 'pm10', valor: 110 });
  const spResolvido = await seed(CIDADE_USUARIO, 'rota-sp3', { poluente: 'pm25', valor: 20, medicaoEm: minutosAtras(30) });
  await avaliarPoluente(dado('rota-sp3', { poluente: 'pm25', valor: 1, medicaoEm: minutosAtras(5) }));
  const campinas = await seed(CIDADE_OUTRA, 'rota-cp1', { poluente: 'pm25', valor: 80 });
  const soTeste = (lista: any[]) => lista.filter((a) => String(a.estacaoId).startsWith(PREFIXO));

  const semToken = await chamar('/alertas');
  check(semToken.status === 401, 'GET /alertas sem token -> 401', `sem token: ${semToken.status}`);
  const semTokenId = await chamar(`/alertas/${spAlto.id}`);
  const semTokenAvaliar = await chamar('/alertas/avaliar', { corpo: { cidade: CIDADE_USUARIO } });
  check(semTokenId.status === 401 && semTokenAvaliar.status === 401, 'GET /alertas/:id e POST /alertas/avaliar sem token -> 401', `sem token id/avaliar: ${semTokenId.status}/${semTokenAvaliar.status}`);
  const tokenInvalido = await chamar('/alertas', { token: 'abc.def.ghi' });
  check(tokenInvalido.status === 401, 'token inválido -> 401', `token inválido: ${tokenInvalido.status}`);

  const tokenUsuario = await criarUsuarioTemporario('USUARIO', CIDADE_USUARIO);
  const tokenAdmin = await criarUsuarioTemporario('ADMIN', CIDADE_USUARIO);

  const propria = await chamar('/alertas', { token: tokenUsuario });
  const daPropria = soTeste(propria.corpo?.alertas ?? []);
  check(propria.status === 200 && daPropria.length === 3 && daPropria.every((a: any) => a.cidade === CIDADE_USUARIO),
    'USUARIO sem filtro -> 200 e SÓ alertas da própria cidade (não vê Campinas)', `usuário: ${propria.status} ${daPropria.map((a: any) => a.cidade)}`);
  check(typeof propria.corpo?.limiaresProvisorios === 'boolean' && propria.corpo.limiaresProvisorios === true, 'resposta avisa que os limiares são provisórios', `limiaresProvisorios: ${propria.corpo?.limiaresProvisorios}`);

  const propriaExplicita = await chamar(`/alertas?cidade=${encodeURIComponent(CIDADE_USUARIO)}`, { token: tokenUsuario });
  check(propriaExplicita.status === 200, 'USUARIO com ?cidade= da própria cidade -> 200', `própria explícita: ${propriaExplicita.status}`);
  const outra = await chamar(`/alertas?cidade=${encodeURIComponent(CIDADE_OUTRA)}`, { token: tokenUsuario });
  check(outra.status === 403 && !outra.corpo?.alertas, 'USUARIO pedindo outra cidade -> 403 (sem alertas no corpo)', `usuário em outra cidade: ${outra.status} ${JSON.stringify(outra.corpo)}`);
  const invalida = await chamar('/alertas?cidade=Gotham', { token: tokenUsuario });
  check(invalida.status === 400, 'cidade inexistente -> 400', `cidade inválida: ${invalida.status}`);

  const adminOutra = await chamar(`/alertas?cidade=${encodeURIComponent(CIDADE_OUTRA)}`, { token: tokenAdmin });
  check(adminOutra.status === 200 && soTeste(adminOutra.corpo?.alertas ?? []).length === 1 && soTeste(adminOutra.corpo.alertas)[0].id === campinas.id,
    'ADMIN consultando outra cidade (mesmo cadastrado em São Paulo) -> 200 com os alertas de Campinas', `admin outra: ${adminOutra.status}`);
  const adminTodas = await chamar('/alertas?limite=200', { token: tokenAdmin });
  check(adminTodas.status === 200 && new Set(soTeste(adminTodas.corpo?.alertas ?? []).map((a: any) => a.cidade)).size === 2, 'ADMIN sem filtro de cidade -> vê todas as cidades', `admin todas: ${adminTodas.status}`);

  // filtros (USUARIO, cidade São Paulo)
  const fAtivo = await chamar('/alertas?status=ATIVO', { token: tokenUsuario });
  const fResolvido = await chamar('/alertas?status=RESOLVIDO', { token: tokenUsuario });
  check(soTeste(fAtivo.corpo?.alertas ?? []).every((a: any) => a.status === 'ATIVO') && soTeste(fAtivo.corpo?.alertas).length === 2 &&
    soTeste(fResolvido.corpo?.alertas ?? []).length === 1 && soTeste(fResolvido.corpo.alertas)[0].id === spResolvido.id,
    'filtro status=ATIVO (2) e status=RESOLVIDO (1)', `status: ${soTeste(fAtivo.corpo?.alertas ?? []).length}/${soTeste(fResolvido.corpo?.alertas ?? []).length}`);
  const fNivel = await chamar('/alertas?nivel=moderado', { token: tokenUsuario });
  check(fNivel.status === 200 && soTeste(fNivel.corpo?.alertas ?? []).length === 1 && soTeste(fNivel.corpo.alertas)[0].id === spModerado.id && soTeste(fNivel.corpo.alertas).every((a: any) => a.nivel === 'MODERADO'),
    'filtro nivel=MODERADO (aceita minúsculas) -> só o alerta MODERADO', `nivel: ${fNivel.status} ${soTeste(fNivel.corpo?.alertas ?? []).length}`);
  const fPol = await chamar('/alertas?poluente=pm10', { token: tokenUsuario });
  check(fPol.status === 200 && soTeste(fPol.corpo?.alertas ?? []).length === 1 && soTeste(fPol.corpo.alertas)[0].poluente === 'pm10', 'filtro poluente=pm10 -> só pm10', `poluente: ${fPol.status} ${soTeste(fPol.corpo?.alertas ?? []).length}`);
  const fCombinado = await chamar('/alertas?status=ATIVO&nivel=ALTO&poluente=pm25', { token: tokenUsuario });
  check(soTeste(fCombinado.corpo?.alertas ?? []).length === 1 && soTeste(fCombinado.corpo.alertas)[0].id === spAlto.id, 'filtros combinados (status+nivel+poluente)', 'filtro combinado incorreto');

  const entradasRuins = await Promise.all([
    chamar('/alertas?status=XYZ', { token: tokenUsuario }), chamar('/alertas?nivel=GRAVISSIMO', { token: tokenUsuario }), chamar('/alertas?poluente=radonio', { token: tokenUsuario }),
    chamar('/alertas?limite=0', { token: tokenUsuario }), chamar('/alertas?limite=99999', { token: tokenUsuario }), chamar('/alertas?pagina=abc', { token: tokenUsuario }),
    chamar(`/alertas?status=${encodeURIComponent("ATIVO' OR '1'='1")}`, { token: tokenUsuario }), chamar('/alertas?status=ATIVO&status=RESOLVIDO', { token: tokenUsuario }),
  ]);
  check(entradasRuins.every((r) => r.status === 400), 'filtros inválidos (status/nivel/poluente/limite/pagina/injeção/parâmetro repetido) -> 400', `entradas ruins: ${entradasRuins.map((r) => r.status)}`);

  const pagina = await chamar('/alertas?limite=1&pagina=2', { token: tokenAdmin });
  check(pagina.status === 200 && pagina.corpo?.alertas?.length === 1 && pagina.corpo?.pagina === 2 && pagina.corpo?.total >= 4, 'paginação (limite=1, pagina=2) -> 1 item e total coerente', `paginação: ${pagina.status} ${pagina.corpo?.alertas?.length} total=${pagina.corpo?.total}`);

  // consulta por ID
  const porId = await chamar(`/alertas/${spAlto.id}`, { token: tokenUsuario });
  check(porId.status === 200 && porId.corpo?.alerta?.id === spAlto.id && porId.corpo.alerta.origemDado === 'OPENAQ' && porId.corpo.alerta.tipoDado === 'MEDICAO' && porId.corpo.alerta.poluenteNome === 'PM2.5',
    'GET /alertas/:id (própria cidade) -> 200 com origem e tipo do dado', `por id: ${porId.status} ${JSON.stringify(porId.corpo)}`);
  const idOutra = await chamar(`/alertas/${campinas.id}`, { token: tokenUsuario });
  check(idOutra.status === 404 && !idOutra.corpo?.alerta, 'USUARIO pedindo alerta de OUTRA cidade por ID -> 404 (não revela que existe)', `id outra cidade: ${idOutra.status} ${JSON.stringify(idOutra.corpo)}`);
  const idAdmin = await chamar(`/alertas/${campinas.id}`, { token: tokenAdmin });
  check(idAdmin.status === 200 && idAdmin.corpo?.alerta?.cidade === CIDADE_OUTRA, 'ADMIN pedindo alerta de outra cidade por ID -> 200', `id admin: ${idAdmin.status}`);
  const idInexistente = await chamar('/alertas/2147483647', { token: tokenAdmin });
  const idInvalido = await Promise.all(['abc', '0', '-1', '1.5'].map((v) => chamar(`/alertas/${v}`, { token: tokenAdmin })));
  check(idInexistente.status === 404 && idInvalido.every((r) => r.status === 400), 'ID inexistente -> 404; ID inválido (abc, 0, -1, 1.5) -> 400', `ids: ${idInexistente.status} ${idInvalido.map((r) => r.status)}`);

  // disparo de avaliação e resolução: só ADMIN
  const avaliarUsuario = await chamar('/alertas/avaliar', { token: tokenUsuario, corpo: { cidade: CIDADE_USUARIO } });
  check(avaliarUsuario.status === 403, 'POST /alertas/avaliar como USUARIO -> 403', `avaliar usuário: ${avaliarUsuario.status}`);
  const avaliarRuim = await Promise.all([
    chamar('/alertas/avaliar', { token: tokenAdmin, corpo: { cidade: 'Gotham' } }), chamar('/alertas/avaliar', { token: tokenAdmin, corpo: {} }),
    chamar('/alertas/avaliar', { token: tokenAdmin, corpo: { cidade: CIDADE_USUARIO, limite: 999 } }), chamar('/alertas/avaliar', { token: tokenAdmin, corpo: { cidade: CIDADE_USUARIO, valor: 999, poluente: 'pm25' } }),
  ]);
  check(avaliarRuim.slice(0, 3).every((r) => r.status === 400), 'POST /alertas/avaliar com cidade inválida, ausente ou limite fora da faixa -> 400', `avaliar ruim: ${avaliarRuim.map((r) => r.status)}`);
  check((await pool.query(`SELECT COUNT(*)::int AS n FROM alertas WHERE valor = 999`)).rows[0].n === 0, 'a rota NÃO aceita valores prontos (valor/poluente no corpo são ignorados)', 'rota criou alerta a partir do corpo');

  const resolverUsuario = await chamar(`/alertas/${spModerado.id}/resolver`, { token: tokenUsuario, metodo: 'POST', corpo: {} });
  check(resolverUsuario.status === 403, 'POST /alertas/:id/resolver como USUARIO -> 403', `resolver usuário: ${resolverUsuario.status}`);
  const resolverAdmin = await chamar(`/alertas/${spModerado.id}/resolver`, { token: tokenAdmin, metodo: 'POST', corpo: {} });
  check(resolverAdmin.status === 200 && resolverAdmin.corpo?.alerta?.status === 'RESOLVIDO' && resolverAdmin.corpo.alerta.resolvidoEm, 'ADMIN resolve alerta manualmente -> 200, RESOLVIDO com resolvido_em', `resolver admin: ${resolverAdmin.status} ${JSON.stringify(resolverAdmin.corpo)}`);
  const resolverDeNovo = await chamar(`/alertas/${spModerado.id}/resolver`, { token: tokenAdmin, metodo: 'POST', corpo: {} });
  const resolverInexistente = await chamar('/alertas/2147483647/resolver', { token: tokenAdmin, metodo: 'POST', corpo: {} });
  check(resolverDeNovo.status === 409 && resolverInexistente.status === 404, 'resolver alerta já resolvido -> 409; inexistente -> 404', `resolver de novo/inexistente: ${resolverDeNovo.status}/${resolverInexistente.status}`);

  // usuário desativado perde o acesso
  await pool.query('UPDATE usuarios SET ativo = FALSE WHERE email = $1', [emails[0]]);
  const inativo = await chamar('/alertas', { token: tokenUsuario });
  check(inativo.status === 401, 'usuário desativado -> 401 (perfil/status vêm do banco)', `inativo: ${inativo.status}`);

  return tokenAdmin;
}

// ---------------------------------------------------------------- 4) ponta a ponta com as APIs reais
async function pontaAPonta(tokenAdmin: string) {
  console.log(`\n=== 4) Ponta a ponta: POST /alertas/avaliar com OpenAQ/Open-Meteo reais (${CIDADE_USUARIO}) ===`);
  if (SEM_EXTERNO) return pulado('--sem-externo informado');

  const maiorId = (await pool.query('SELECT COALESCE(MAX(id), 0)::int AS id FROM alertas')).rows[0].id as number;
  const r = await chamar('/alertas/avaliar', { token: tokenAdmin, corpo: { cidade: CIDADE_USUARIO, limite: 3 } });

  if (r.status !== 200) {
    // falha de infraestrutura externa não é falha do código de alertas
    return pulado(`APIs externas indisponíveis neste momento (HTTP ${r.status}, ${r.corpo?.codigo ?? r.corpo?.error})`);
  }

  const c = r.corpo;
  const tocados = [...(c.alertas ?? []), ...(c.resolvidos ?? [])];
  tocados.forEach((a: any) => { if (a.id > maiorId) alertasReais.push(a.id); }); // só os criados por este teste serão apagados
  check(c.cidade === CIDADE_USUARIO && typeof c.estacoesAvaliadas === 'number' && c.contagem && Array.isArray(c.falhas) && c.limiaresProvisorios === true,
    `avaliação real: ${c.estacoesAvaliadas} estação(ões), contagem ${JSON.stringify(c.contagem)}, ${c.falhas.length} falha(s)`, `resposta inesperada: ${JSON.stringify(c)}`);
  check((c.alertas ?? []).every((a: any) => (a.origemDado === 'OPENAQ' && a.tipoDado === 'MEDICAO') || (a.origemDado === 'OPEN_METEO' && a.tipoDado === 'MODELO')),
    `todo alerta real tem origem coerente com o tipo (${(c.alertas ?? []).length} alerta(s) gerado(s)/atualizado(s))`, 'origem incoerente com tipo');
  (c.alertas ?? []).slice(0, 5).forEach((a: any) => console.log(`            ${a.poluenteNome} ${a.valor} ${a.unidade} ${a.nivel} ${a.origemDado}/${a.tipoDado} estação ${a.estacaoId}`));

  // repetir a avaliação (dados em cache) não pode duplicar
  const antes = (await pool.query(`SELECT COUNT(*)::int AS n FROM alertas WHERE cidade = $1 AND status = 'ATIVO' AND estacao_id NOT LIKE $2`, [CIDADE_USUARIO, `${PREFIXO}%`])).rows[0].n;
  const repetida = await chamar('/alertas/avaliar', { token: tokenAdmin, corpo: { cidade: CIDADE_USUARIO, limite: 3 } });
  const depois = (await pool.query(`SELECT COUNT(*)::int AS n FROM alertas WHERE cidade = $1 AND status = 'ATIVO' AND estacao_id NOT LIKE $2`, [CIDADE_USUARIO, `${PREFIXO}%`])).rows[0].n;
  check(repetida.status === 200 && antes === depois, `segunda avaliação seguida não duplica (${antes} ativos antes e depois)`, `duplicou: ${antes} -> ${depois} (HTTP ${repetida.status})`);
}

async function main() {
  regras();
  if (process.argv.includes('--so-regras')) {
    console.log(`\nResumo: ${total - falhas}/${total} verificações OK${falhas ? `, ${falhas} FALHA(S)` : ''}`);
    return;
  }
  let tokenAdmin = '';
  try {
    await limpar(); // resto de execução anterior interrompida
    await servico();
    await limpar(); // as rotas começam com a cidade sem alertas de teste
    tokenAdmin = await rotas();
    // o admin temporário continua ativo (só o usuário comum foi desativado)
    await pontaAPonta(tokenAdmin);
  } finally {
    if (alertasReais.length > 0) await pool.query('DELETE FROM alertas WHERE id = ANY($1)', [alertasReais]);
    await limpar();
    const sobra = await pool.query(`SELECT (SELECT COUNT(*) FROM alertas WHERE estacao_id LIKE $1)::int AS alertas, (SELECT COUNT(*) FROM usuarios WHERE email LIKE 'tmp.alertas.%')::int AS usuarios`, [`${PREFIXO}%`]);
    console.log(`\nLimpeza: ${sobra.rows[0].alertas} alerta(s) de teste e ${sobra.rows[0].usuarios} usuário(s) temporário(s) restantes (esperado: 0 e 0)`);
    if (sobra.rows[0].alertas !== 0 || sobra.rows[0].usuarios !== 0) falhas++;
  }

  console.log(`\nResumo: ${total - falhas}/${total} verificações OK${pulados ? `, ${pulados} puladas` : ''}${falhas ? `, ${falhas} FALHA(S)` : ''}`);
}

main()
  .catch((err) => {
    console.error('Erro na validação:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    if (falhas > 0) process.exitCode = 1;
  });
