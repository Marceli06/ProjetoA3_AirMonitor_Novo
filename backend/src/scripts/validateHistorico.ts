import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import pool from '../database';
import { mapHoras } from '../integrations/openaq/mapper';
import { mapHorarioOpenMeteo } from '../integrations/openmeteo/mapper';
import { resumir } from '../services/historico';

dotenv.config();

// Valida o Histórico (GET /api/historico) contra as fontes REAIS (OpenAQ e Open-Meteo), com usuários temporários
// (tmp.hist.*@example.com, sempre removidos no final). Não grava nada além desses usuários. Não imprime senhas,
// tokens, chaves nem a connection string. As expectativas de existência de dados vêm da própria OpenAQ/Open-Meteo:
// se uma estação não tem medição recente o teste registra [INFO] em vez de inventar um resultado.
//
// Uso: BASE_URL=http://127.0.0.1:3996/api npm run historico:validate
// Opcionais (instâncias do backend com uma fonte derrubada de propósito, para testar o comportamento em falha):
//   BASE_URL_OPEN_METEO_FORA   backend iniciado com OPEN_METEO_BASE_URL apontando para uma porta fechada
//   BASE_URL_OPENAQ_FORA       backend iniciado com OPENAQ_BASE_URL apontando para uma porta fechada

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3996/api';
const BASE_OM_FORA = process.env.BASE_URL_OPEN_METEO_FORA;
const BASE_OAQ_FORA = process.env.BASE_URL_OPENAQ_FORA;
const SP = 'São Paulo';
const CAMPINAS = 'Campinas';

let falhas = 0;
let total = 0;
const ok = (m: string) => { total++; console.log(`  [OK]      ${m}`); };
const falha = (m: string) => { total++; falhas++; console.log(`  [FALHA]   ${m}`); };
const info = (m: string) => console.log(`  [INFO]    ${m}`);
const check = (c: boolean, a: string, b: string) => (c ? ok(a) : falha(b));

interface Resposta { status: number; corpo: any }

async function chamar(caminho: string, opcoes: { token?: string; base?: string } = {}): Promise<Resposta> {
  const res = await fetch(`${opcoes.base ?? BASE}${caminho}`, { headers: opcoes.token ? { Authorization: `Bearer ${opcoes.token}` } : {} });
  let corpo: any = null;
  try { corpo = await res.json(); } catch { /* sem corpo */ }
  return { status: res.status, corpo };
}

const q = (params: Record<string, string | number>) =>
  `/historico?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}`;

const emails: string[] = [];
async function criarUsuario(perfil: 'ADMIN' | 'USUARIO', cidade: string | null, ativo = true) {
  const email = `tmp.hist.${Date.now()}.${emails.length}@example.com`;
  const senha = `Tmp-${Math.random().toString(36).slice(2)}-9`;
  emails.push(email);
  await pool.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, cidade, regiao) VALUES ($1, $2, $3, $4, true, $5, 'Centro')`,
    [`Teste Historico ${perfil}`, email, bcrypt.hashSync(senha, 4), perfil, cidade]
  );
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: senha }),
  });
  const corpo: any = await login.json();
  if (login.status !== 200 || !corpo?.token) throw new Error(`login do usuário temporário (${perfil}) falhou: HTTP ${login.status}`);
  if (!ativo) await pool.query('UPDATE usuarios SET ativo = false WHERE email = $1', [email]);
  return { token: corpo.token as string, email };
}

const UNIDADE_MICRO = 'µg/m³';

function pontoValido(p: any) {
  return (
    typeof p.dataHora === 'string' && !Number.isNaN(Date.parse(p.dataHora)) && new Date(p.dataHora).toISOString() === p.dataHora &&
    typeof p.valor === 'number' && Number.isFinite(p.valor) && p.valor >= 0 &&
    typeof p.unidade === 'string' && p.unidade !== '' &&
    typeof p.poluente === 'string' && typeof p.poluenteNome === 'string' &&
    (p.origem === 'OPENAQ' || p.origem === 'OPEN_METEO') &&
    ((p.origem === 'OPENAQ' && p.tipoDado === 'MEDICAO' && Number.isInteger(p.estacaoId)) || (p.origem === 'OPEN_METEO' && p.tipoDado === 'MODELO' && p.estacaoId === null && p.estacaoNome === null))
  );
}

const cronologica = (pontos: any[]) => pontos.every((p, i) => i === 0 || Date.parse(pontos[i - 1].dataHora) < Date.parse(p.dataHora));
const dentroDoPeriodo = (corpo: any) => corpo.pontos.every((p: any) => Date.parse(p.dataHora) >= Date.parse(corpo.periodo.de) && Date.parse(p.dataHora) <= Date.parse(corpo.periodo.ate));

async function main() {
  const admin = await criarUsuario('ADMIN', 'Osasco');
  const userSp = await criarUsuario('USUARIO', SP);
  const userCampinas = await criarUsuario('USUARIO', CAMPINAS);
  const userSemCidade = await criarUsuario('USUARIO', null);
  const userInativo = await criarUsuario('USUARIO', SP, false);

  console.log('\n--- autenticação e permissões ---');
  const semToken = await chamar(q({ cidade: SP, poluente: 'pm25' }));
  const tokenRuim = await chamar(q({ cidade: SP, poluente: 'pm25' }), { token: 'abc.def.ghi' });
  const inativo = await chamar(q({ cidade: SP, poluente: 'pm25' }), { token: userInativo.token });
  check(semToken.status === 401 && tokenRuim.status === 401 && inativo.status === 401, 'sem token, token inválido e usuário inativo -> 401', `401: ${semToken.status} ${tokenRuim.status} ${inativo.status}`);
  const adminSemCidade = await chamar(q({ poluente: 'pm25' }), { token: admin.token });
  check(adminSemCidade.status === 400, 'ADMIN sem cidade -> 400', `admin sem cidade: ${adminSemCidade.status}`);
  const uSemCidade = await chamar(q({ poluente: 'pm25', fonte: 'OPEN_METEO' }), { token: userSemCidade.token });
  check(uSemCidade.status === 403, 'USUARIO sem cidade cadastrada -> 403', `usuário sem cidade: ${uSemCidade.status}`);
  const uOutra = await chamar(q({ cidade: SP, poluente: 'pm25', fonte: 'OPEN_METEO' }), { token: userCampinas.token });
  check(uOutra.status === 403, 'USUARIO pedindo a cidade de outro -> 403', `usuário em cidade alheia: ${uOutra.status}`);
  const uPropria = await chamar(q({ poluente: 'pm25', fonte: 'OPEN_METEO' }), { token: userCampinas.token });
  check(uPropria.status === 200 && uPropria.corpo.cidade === CAMPINAS, 'USUARIO sem informar cidade usa a própria (do banco)', `usuário sem cidade na query: ${uPropria.status} ${uPropria.corpo?.cidade}`);
  const uExplicita = await chamar(q({ cidade: CAMPINAS, poluente: 'pm25', fonte: 'OPEN_METEO' }), { token: userCampinas.token });
  check(uExplicita.status === 200, 'USUARIO informando a própria cidade -> 200', `própria cidade: ${uExplicita.status}`);

  console.log('\n--- validação dos parâmetros (400) ---');
  const ruins: [string, string][] = [
    ['cidade inexistente', q({ cidade: 'Atlantida', poluente: 'pm25' })],
    ['cidade __proto__', q({ cidade: '__proto__', poluente: 'pm25' })],
    ['cidade vazia', '/historico?cidade=&poluente=pm25'],
    ['poluente ausente', q({ cidade: SP })],
    ['poluente inexistente', q({ cidade: SP, poluente: 'xyz' })],
    ['poluente repetido', `/historico?cidade=${encodeURIComponent(SP)}&poluente=pm25&poluente=pm10`],
    ['período inválido', q({ cidade: SP, poluente: 'pm25', periodo: '90D' })],
    ['período vazio', `/historico?cidade=${encodeURIComponent(SP)}&poluente=pm25&periodo=`],
    ['fonte inválida', q({ cidade: SP, poluente: 'pm25', fonte: 'NASA' })],
    ['estacaoId texto', q({ cidade: SP, poluente: 'pm25', estacaoId: 'abc' })],
    ['estacaoId zero', q({ cidade: SP, poluente: 'pm25', estacaoId: 0 })],
    ['estacaoId negativo', q({ cidade: SP, poluente: 'pm25', estacaoId: -5 })],
    ['estacaoId decimal', q({ cidade: SP, poluente: 'pm25', estacaoId: '1.5' })],
    ['estacaoId notação científica', q({ cidade: SP, poluente: 'pm25', estacaoId: '1e3' })],
    ['estacaoId gigante', q({ cidade: SP, poluente: 'pm25', estacaoId: '99999999999' })],
    ['estacaoId com fonte OPEN_METEO', q({ cidade: SP, poluente: 'pm25', estacaoId: 5239, fonte: 'OPEN_METEO' })],
    ['injeção em poluente', q({ cidade: SP, poluente: "pm25'; DROP TABLE usuarios; --" })],
  ];
  const resRuins = await Promise.all(ruins.map(async ([nome, caminho]) => [nome, (await chamar(caminho, { token: admin.token })).status] as const));
  for (const [nome, status] of resRuins) check(status === 400, `${nome} -> 400`, `${nome}: HTTP ${status}`);
  const limpo = await pool.query('SELECT COUNT(*)::int AS n FROM usuarios');
  check(limpo.rows[0].n > 0, 'tabela de usuários intacta após o texto de injeção', 'tabela de usuários sumiu');

  console.log('\n--- modelo (Open-Meteo): série horária real ---');
  const periodos: [string, number, number][] = [['24H', 22, 25], ['7D', 160, 169], ['30D', 700, 721]];
  for (const [periodo, minimo, maximo] of periodos) {
    const r = await chamar(q({ cidade: SP, poluente: 'pm25', periodo, fonte: 'OPEN_METEO' }), { token: admin.token });
    const c = r.corpo;
    check(
      r.status === 200 && c.total === c.pontos.length && c.total >= minimo && c.total <= maximo &&
        c.pontos.every(pontoValido) && c.pontos.every((p: any) => p.origem === 'OPEN_METEO') && cronologica(c.pontos) && dentroDoPeriodo(c),
      `OPEN_METEO ${periodo}: ${c?.total} pontos horários, cronológicos, só dentro do período, origem MODELO`,
      `OPEN_METEO ${periodo}: HTTP ${r.status} total=${c?.total} válidos=${c?.pontos?.every(pontoValido)} cron=${c?.pontos && cronologica(c.pontos)} período=${c?.pontos && dentroDoPeriodo(c)}`
    );
    if (periodo === '24H') {
      const futuro = c.pontos.filter((p: any) => Date.parse(p.dataHora) > Date.now());
      check(futuro.length === 0, 'nenhum ponto no futuro (a previsão da Open-Meteo é descartada)', `${futuro.length} ponto(s) futuros`);
      check(c.pontos.every((p: any) => p.unidade === UNIDADE_MICRO), 'unidade normalizada para µg/m³ (sinal de micro)', `unidades: ${[...new Set(c.pontos.map((p: any) => p.unidade))]}`);
      check(c.fontesUtilizadas.join() === 'OPEN_METEO' && c.atribuicoes.length === 1 && /Open-Meteo/.test(c.atribuicoes[0]), 'atribuição (CC BY 4.0) presente quando o modelo é usado', `atribuições: ${JSON.stringify(c.atribuicoes)}`);
      check(c.statusFontes.OPENAQ === 'nao_consultada' && c.statusFontes.OPEN_METEO === 'ok' && c.estacao === null && c.estacoes.length === 0 && c.aviso === null, 'status: OpenAQ não consultada, estação nula, sem aviso', `status: ${JSON.stringify(c.statusFontes)} estacao=${JSON.stringify(c.estacao)}`);
      const esperado = resumir(c.pontos);
      check(JSON.stringify(c.resumo) === JSON.stringify(esperado) && c.resumo.minimo <= c.resumo.media && c.resumo.media <= c.resumo.maximo, 'resumo (mínimo, média, máximo, último) confere com a série devolvida', `resumo: ${JSON.stringify(c.resumo)} esperado ${JSON.stringify(esperado)}`);
    }
  }
  for (const chave of ['pm25', 'pm10', 'o3', 'no2', 'co', 'so2']) {
    const r = await chamar(q({ cidade: CAMPINAS, poluente: chave, fonte: 'OPEN_METEO' }), { token: admin.token });
    const nomes = new Set(r.corpo?.pontos?.map((p: any) => p.poluente));
    check(r.status === 200 && r.corpo.total > 0 && nomes.size === 1 && nomes.has(chave) && r.corpo.pontos.every(pontoValido), `Open-Meteo devolve a série de ${chave} (${r.corpo?.total} pontos, ${r.corpo?.poluente?.unidade})`, `${chave}: HTTP ${r.status} total=${r.corpo?.total}`);
  }

  console.log('\n--- estações (OpenAQ): série horária real ---');
  const oaq30 = await chamar(q({ cidade: SP, poluente: 'pm25', periodo: '30D', fonte: 'OPENAQ' }), { token: admin.token });
  check(oaq30.status === 200 && Array.isArray(oaq30.corpo?.estacoes) && oaq30.corpo.estacoes.every((e: any) => Number.isInteger(e.id) && typeof e.comDadosNoPeriodo === 'boolean'), `lista de estações com sensor de pm25 em ${SP}: ${oaq30.corpo?.estacoes?.length}`, `OPENAQ 30D: HTTP ${oaq30.status} ${JSON.stringify(oaq30.corpo)?.slice(0, 200)}`);
  const lista = oaq30.corpo?.estacoes ?? [];
  const distOrdenadas = lista.every((e: any, i: number) => i === 0 || (lista[i - 1].distanciaMetros ?? Infinity) <= (e.distanciaMetros ?? Infinity));
  check(distOrdenadas, 'estações ordenadas da mais perto para a mais longe', 'estações fora de ordem');

  let estacaoComDados: number | null = null;
  if (oaq30.corpo?.total > 0) {
    const c = oaq30.corpo;
    check(
      c.pontos.every(pontoValido) && c.pontos.every((p: any) => p.origem === 'OPENAQ' && p.tipoDado === 'MEDICAO') && cronologica(c.pontos) && dentroDoPeriodo(c) &&
        new Set(c.pontos.map((p: any) => p.estacaoId)).size === 1 && c.estacao?.id === c.pontos[0].estacaoId && c.estacao.nome === c.pontos[0].estacaoNome,
      `estação ${c.estacao?.nome} (${c.total} medições em 30 dias): todos os pontos da mesma estação, origem MEDICAO, cronológicos`,
      `OPENAQ 30D: pontos inválidos/mistos (estacao=${JSON.stringify(c.estacao)})`
    );
    check(c.atribuicoes.length === 0 && c.fontesUtilizadas.join() === 'OPENAQ' && c.statusFontes.OPENAQ === 'ok' && c.aviso === null, 'sem atribuição da Open-Meteo quando só há OpenAQ', `status: ${JSON.stringify(c.statusFontes)} atrib=${c.atribuicoes.length}`);
    check(JSON.stringify(c.resumo) === JSON.stringify(resumir(c.pontos)), 'resumo confere com a série real da estação', `resumo: ${JSON.stringify(c.resumo)}`);
    estacaoComDados = c.estacao.id;

    const esc = await chamar(q({ cidade: SP, poluente: 'pm25', periodo: '30D', estacaoId: estacaoComDados! }), { token: admin.token });
    check(esc.status === 200 && esc.corpo.total > 0 && esc.corpo.pontos.every((p: any) => p.estacaoId === estacaoComDados && p.origem === 'OPENAQ'), `estacaoId=${estacaoComDados} (fonte AUTO) devolve só essa estação`, `estacaoId explícito: HTTP ${esc.status} total=${esc.corpo?.total}`);
    const periodoCurto = await chamar(q({ cidade: SP, poluente: 'pm25', periodo: '24H', fonte: 'OPENAQ' }), { token: admin.token });
    check(periodoCurto.status === 200 && periodoCurto.corpo.total <= c.total && dentroDoPeriodo(periodoCurto.corpo), `período 24H devolve ${periodoCurto.corpo?.total} (<= ${c.total} dos 30 dias)`, `24H vs 30D: ${periodoCurto.corpo?.total} vs ${c.total}`);
    const outroUsuario = await chamar(q({ poluente: 'pm25', periodo: '30D', fonte: 'OPENAQ' }), { token: userSp.token });
    check(outroUsuario.status === 200 && outroUsuario.corpo.cidade === SP && outroUsuario.corpo.total === c.total, 'USUARIO de São Paulo recebe a mesma série (cidade do banco)', `USUARIO SP: ${outroUsuario.status} total=${outroUsuario.corpo?.total}`);
    const auto = await chamar(q({ cidade: SP, poluente: 'pm25', periodo: '30D' }), { token: admin.token });
    check(auto.status === 200 && auto.corpo.fontesUtilizadas.join() === 'OPENAQ' && auto.corpo.total === c.total && auto.corpo.aviso === null, 'fonte AUTO prefere a estação com dados (sem cair para o modelo)', `AUTO: ${JSON.stringify(auto.corpo?.fontesUtilizadas)} total=${auto.corpo?.total} aviso=${auto.corpo?.aviso}`);
  } else {
    info(`nenhuma estação de ${SP} tem medições de pm25 nos últimos 30 dias na OpenAQ: verificações com dados de estação puladas`);
  }

  const semDados = lista.find((e: any) => !e.comDadosNoPeriodo);
  if (semDados) {
    const r = await chamar(q({ cidade: SP, poluente: 'pm25', periodo: '7D', estacaoId: semDados.id }), { token: admin.token });
    check(
      r.status === 200 && r.corpo.total === 0 && r.corpo.pontos.length === 0 && r.corpo.resumo === null && r.corpo.fontesUtilizadas.length === 0 && r.corpo.statusFontes.OPEN_METEO === 'nao_necessaria' && typeof r.corpo.mensagem === 'string',
      `estação escolhida sem medições (${semDados.nome}): resultado vazio com mensagem, sem trocar pelo modelo`,
      `estação sem dados: HTTP ${r.status} total=${r.corpo?.total} fontes=${JSON.stringify(r.corpo?.fontesUtilizadas)} status=${JSON.stringify(r.corpo?.statusFontes)}`
    );
  } else {
    info('todas as estações listadas têm dados no período: verificação de estação sem medições pulada');
  }

  const campinasLista = await chamar(q({ cidade: CAMPINAS, poluente: 'pm25', periodo: '7D', fonte: 'OPENAQ' }), { token: admin.token });
  const estacaoDeCampinas = campinasLista.corpo?.estacoes?.[0]?.id;
  if (estacaoDeCampinas && !lista.some((e: any) => e.id === estacaoDeCampinas)) {
    const r = await chamar(q({ cidade: SP, poluente: 'pm25', estacaoId: estacaoDeCampinas }), { token: admin.token });
    check(r.status === 404 && r.corpo.codigo === 'ESTACAO_NAO_ENCONTRADA', 'estação de outra cidade -> 404 ESTACAO_NAO_ENCONTRADA', `estação alheia: HTTP ${r.status} ${JSON.stringify(r.corpo)}`);
  }
  const inexistente = await chamar(q({ cidade: SP, poluente: 'pm25', estacaoId: 2147483647 }), { token: admin.token });
  check(inexistente.status === 404, 'estação inexistente (2147483647) -> 404', `estação inexistente: HTTP ${inexistente.status}`);

  console.log('\n--- ausência de dados e fallback automático ---');
  check(campinasLista.status === 200 && campinasLista.corpo.total === 0 && campinasLista.corpo.statusFontes.OPENAQ === 'sem_dado' && typeof campinasLista.corpo.mensagem === 'string', `Campinas (estações sem medição recente), só OpenAQ: vazio com mensagem ("${campinasLista.corpo?.mensagem}")`, `Campinas OPENAQ: HTTP ${campinasLista.status} total=${campinasLista.corpo?.total} status=${JSON.stringify(campinasLista.corpo?.statusFontes)}`);
  const campAuto = await chamar(q({ cidade: CAMPINAS, poluente: 'pm25', periodo: '7D' }), { token: admin.token });
  check(
    campAuto.status === 200 && campAuto.corpo.total > 0 && campAuto.corpo.fontesUtilizadas.join() === 'OPEN_METEO' && /modelo/i.test(campAuto.corpo.aviso ?? '') && campAuto.corpo.atribuicoes.length === 1 && campAuto.corpo.statusFontes.OPENAQ === 'sem_dado',
    `Campinas AUTO: sem estação com dados, cai para o modelo com aviso explícito (${campAuto.corpo?.total} pontos)`,
    `Campinas AUTO: HTTP ${campAuto.status} fontes=${JSON.stringify(campAuto.corpo?.fontesUtilizadas)} aviso=${campAuto.corpo?.aviso}`
  );
  const campEstacao = campinasLista.corpo?.estacoes?.find((e: any) => !e.comDadosNoPeriodo);
  if (campEstacao) {
    const r = await chamar(q({ cidade: CAMPINAS, poluente: 'pm25', periodo: '7D', estacaoId: campEstacao.id }), { token: admin.token });
    check(r.status === 200 && r.corpo.total === 0 && r.corpo.fontesUtilizadas.length === 0 && r.corpo.aviso === null, 'Campinas: estação escolhida sem dados não é trocada pelo modelo (vazio)', `Campinas estação: HTTP ${r.status} total=${r.corpo?.total} fontes=${JSON.stringify(r.corpo?.fontesUtilizadas)}`);
  }

  console.log('\n--- consistência com os mapeadores (dados sintéticos, sem rede) ---');
  const horas = mapHoras([
    { value: 5, parameter: { id: 2, name: 'pm25', units: 'µg/m³' }, period: { datetimeTo: { utc: '2026-01-01T01:00:00Z' } } },
    { value: 5, parameter: { id: 2, name: 'pm25', units: 'µg/m³' }, period: { datetimeTo: { utc: '2026-01-01T01:00:00Z' } } },
    { value: -3, parameter: { id: 2, name: 'pm25', units: 'µg/m³' }, period: { datetimeTo: { utc: '2026-01-01T02:00:00Z' } } },
    { value: 7, parameter: { id: 2, name: 'pm25', units: 'µg/m³' }, period: { datetimeTo: { utc: 'lixo' } } },
    { value: 9, parameter: { id: 2, name: 'pm25', units: '' }, period: { datetimeTo: { utc: '2026-01-01T03:00:00Z' } } },
    { value: 4, parameter: { id: 2, name: 'pm25', units: 'µg/m³' }, period: { datetimeTo: { utc: '2025-12-31T23:00:00Z' } } },
  ] as any);
  check(horas.length === 2 && horas[0].valor === 4 && horas[1].valor === 5, 'mapHoras descarta negativo, hora inválida, sem unidade e duplicata; ordena', `mapHoras: ${JSON.stringify(horas)}`);
  const om = mapHorarioOpenMeteo(
    { latitude: 0, longitude: 0, utc_offset_seconds: 0, hourly_units: { pm2_5: 'μg/m³' }, hourly: { time: ['2026-01-01T00:00', '2026-01-01T01:00', '2026-01-01T02:00', '2026-01-01T03:00'], pm2_5: [3, null, -1, 8] } } as any,
    'pm2_5'
  );
  check(om.length === 2 && om[0].valor === 3 && om[1].valor === 8 && om[0].unidade === UNIDADE_MICRO && om[1].dataHora === '2026-01-01T03:00:00.000Z', 'mapHorarioOpenMeteo descarta null/negativo (sem preencher) e normaliza a unidade', `mapHorarioOpenMeteo: ${JSON.stringify(om)}`);
  check(mapHorarioOpenMeteo({ latitude: 0, longitude: 0, utc_offset_seconds: 3600, hourly_units: { pm2_5: 'x' }, hourly: { time: ['2026-01-01T00:00'], pm2_5: [3] } } as any, 'pm2_5').length === 0, 'fuso diferente de GMT -> série descartada (não presume horário)', 'fuso não-GMT foi aceito');
  check(resumir([]) === null, 'resumo de série vazia é nulo (não inventa números)', 'resumo de série vazia não é nulo');

  console.log('\n--- falha de fonte (instâncias com a fonte derrubada) ---');
  if (BASE_OM_FORA) {
    const r1 = await chamar(q({ cidade: SP, poluente: 'pm25', fonte: 'OPEN_METEO' }), { token: admin.token, base: BASE_OM_FORA });
    check(r1.status === 502 && r1.corpo.codigo === 'OPEN_METEO_INDISPONIVEL', 'Open-Meteo fora do ar e fonte=OPEN_METEO -> 502 OPEN_METEO_INDISPONIVEL', `OM fora (modelo): HTTP ${r1.status} ${JSON.stringify(r1.corpo)}`);
    const r2 = await chamar(q({ cidade: CAMPINAS, poluente: 'pm25' }), { token: admin.token, base: BASE_OM_FORA });
    check(r2.status === 502, 'AUTO sem estação com dados e Open-Meteo fora -> 502 (não finge "sem histórico")', `OM fora (AUTO Campinas): HTTP ${r2.status}`);
    if (estacaoComDados) {
      const r3 = await chamar(q({ cidade: SP, poluente: 'pm25', periodo: '30D' }), { token: admin.token, base: BASE_OM_FORA });
      check(r3.status === 200 && r3.corpo.fontesUtilizadas.join() === 'OPENAQ', 'Open-Meteo fora do ar não afeta a série da estação (OpenAQ)', `OM fora (estação): HTTP ${r3.status} fontes=${JSON.stringify(r3.corpo?.fontesUtilizadas)}`);
    }
  } else {
    info('BASE_URL_OPEN_METEO_FORA não informado: falhas da Open-Meteo não testadas');
  }
  if (BASE_OAQ_FORA) {
    const r1 = await chamar(q({ cidade: SP, poluente: 'pm25', fonte: 'OPENAQ' }), { token: admin.token, base: BASE_OAQ_FORA });
    check([502, 504].includes(r1.status), `OpenAQ fora do ar e fonte=OPENAQ -> erro de gateway (${r1.status})`, `OpenAQ fora (estação): HTTP ${r1.status}`);
    const r2 = await chamar(q({ cidade: SP, poluente: 'pm25' }), { token: admin.token, base: BASE_OAQ_FORA });
    check(
      r2.status === 200 && r2.corpo.fontesUtilizadas.join() === 'OPEN_METEO' && r2.corpo.statusFontes.OPENAQ === 'falha' && /OpenAQ está indisponível/.test(r2.corpo.aviso ?? ''),
      'OpenAQ fora do ar e fonte=AUTO -> modelo assume, com aviso e status OPENAQ=falha',
      `OpenAQ fora (AUTO): HTTP ${r2.status} fontes=${JSON.stringify(r2.corpo?.fontesUtilizadas)} aviso=${r2.corpo?.aviso}`
    );
    const r3 = await chamar(q({ cidade: SP, poluente: 'pm25', fonte: 'OPEN_METEO' }), { token: admin.token, base: BASE_OAQ_FORA });
    check(r3.status === 200 && r3.corpo.total > 0, 'OpenAQ fora do ar não afeta fonte=OPEN_METEO', `OpenAQ fora (modelo): HTTP ${r3.status}`);
  } else {
    info('BASE_URL_OPENAQ_FORA não informado: falhas da OpenAQ não testadas');
  }
}

(async () => {
  try {
    await main();
  } catch (e: any) {
    falha(`erro inesperado: ${e?.message}`);
  } finally {
    await pool.query(`DELETE FROM usuarios WHERE email LIKE 'tmp.hist.%@example.com'`).catch(() => {});
    const restos = await pool.query(`SELECT COUNT(*)::int AS n FROM usuarios WHERE email LIKE 'tmp.hist.%@example.com'`).then((r) => r.rows[0].n).catch(() => '?');
    await pool.end().catch(() => {});
    console.log(`\nResumo: ${total - falhas}/${total} verificações OK, ${falhas} falha(s). Usuários temporários restantes: ${restos}.`);
    process.exitCode = falhas === 0 ? 0 : 1;
  }
})();
