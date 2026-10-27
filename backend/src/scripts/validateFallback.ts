import http from 'http';
import { AddressInfo } from 'net';
import dotenv from 'dotenv';
import * as openaq from '../integrations/openaq/client';
import * as openmeteo from '../integrations/openmeteo/client';
import { UltimasMedicoes } from '../integrations/openaq/mapper';
import { mapOpenMeteo } from '../integrations/openmeteo/mapper';
import { buscarEstacoes, obterUltimasMedicoes, obterUltimasMedicoesOpenAQ } from '../services/airQuality';
import { ATRIBUICAO_OPEN_METEO, MedicaoConsolidada, consolidar } from '../services/consolidador';
import { limparCache } from '../services/cache';
import { COORDENADAS_CIDADES } from '../data/cidadesCoordenadas';

dotenv.config();

// Valida o fallback OpenAQ -> Open-Meteo com as APIs REAIS. Valores de qualidade do ar nunca são simulados:
// só falhas técnicas (recusa de conexão, timeout, JSON inválido, 429) usam servidores locais.
// Uso: npm run fallback:validate [cidade]      (padrão: São Paulo)
// Imprime apenas ids, valores de medição e códigos. Nunca imprime a chave da OpenAQ.

const cidade = process.argv[2] || 'São Paulo';
let falhas = 0;
let pulados = 0;

const ok = (msg: string) => console.log(`  [OK]      ${msg}`);
const falha = (msg: string) => {
  falhas++;
  console.log(`  [FALHA]   ${msg}`);
};
const pulado = (msg: string) => {
  pulados++;
  console.log(`  [PULADO]  ${msg}`);
};
const check = (cond: boolean, msgOk: string, msgFalha: string) => (cond ? ok(msgOk) : falha(msgFalha));

interface Candidata {
  id: number;
  nome: string | null;
  latitude: number;
  longitude: number;
  bruto: UltimasMedicoes;
}

const atual = (m: UltimasMedicoes['medicoes'][number]) => m.disponivel && !m.desatualizada;
const velha = (m: UltimasMedicoes['medicoes'][number]) => m.disponivel && m.desatualizada === true;
const ausente = (m: UltimasMedicoes['medicoes'][number]) => !m.disponivel;

const porChave = (lista: MedicaoConsolidada[], chave: string) => lista.find((m) => m.chave === chave)!;

const tabela = (titulo: string, medicoes: MedicaoConsolidada[]) => {
  console.log(`          ${titulo}`);
  medicoes.forEach((m) =>
    console.log(
      m.disponivel
        ? `            ${m.poluente.padEnd(6)} ${String(m.valor).padStart(7)} ${m.unidade}  ${m.fonte?.padEnd(10)} ${m.tipoDado?.padEnd(8)} ${m.dataHora}${m.desatualizada ? '  (DESATUALIZADA)' : ''}`
        : `            ${m.poluente.padEnd(6)} indisponível (OpenAQ: ${m.motivo}; fallback: ${m.motivoFallback})`
    )
  );
};

const arredondar = (n: number) => Number(n.toFixed(2));
const omDireto = async (c: Candidata) =>
  mapOpenMeteo(await openmeteo.getCurrentAirQuality(arredondar(c.latitude), arredondar(c.longitude)));

async function subirServidor(handler: http.RequestListener) {
  const servidor = http.createServer(handler);
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  return { servidor, url: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}` };
}

async function descobrirEstacoes() {
  console.log(`\n0) Estações reais de ${cidade} (OpenAQ) para os cenários`);
  const centro = COORDENADAS_CIDADES[cidade];
  if (!centro) throw new Error(`Cidade desconhecida: ${cidade}`);

  const estacoes = await buscarEstacoes({ ...centro, raioMetros: 25000, limite: 100 });
  let mista: Candidata | undefined; // tem dado atual e também lacunas
  let antiga: Candidata | undefined; // só dado desatualizado

  for (const e of estacoes.slice(0, 15)) {
    if (mista && antiga) break;
    if (e.latitude === null || e.longitude === null) continue;
    const bruto = await obterUltimasMedicoesOpenAQ(e.id);
    const candidata = { id: e.id, nome: e.nome, latitude: e.latitude, longitude: e.longitude, bruto };
    const m = bruto.medicoes;
    if (!mista && m.some(atual) && m.some((x) => !atual(x))) mista = candidata;
    if (!antiga && !m.some(atual) && m.some(velha)) antiga = candidata;
  }

  const resumo = (c: Candidata) => c.bruto.medicoes.map((m) => `${m.nome}:${atual(m) ? 'atual' : velha(m) ? 'velho' : m.motivo}`).join(' ');
  mista ? ok(`estação com dado atual + lacunas: #${mista.id} ${mista.nome} -> ${resumo(mista)}`) : pulado('nenhuma estação real com dado atual e lacunas encontrada agora');
  antiga ? ok(`estação só com dado desatualizado: #${antiga.id} ${antiga.nome} -> ${resumo(antiga)}`) : pulado('nenhuma estação real só com dado desatualizado encontrada agora');
  return { mista, antiga };
}

async function main() {
  const { mista, antiga } = await descobrirEstacoes();
  limparCache('openmeteo:');

  // ---- 1, 3, 6, 7 (estação com dado atual + lacunas)
  let resMista: Awaited<ReturnType<typeof obterUltimasMedicoes>> | undefined;
  if (mista) {
    console.log(`\n1) OpenAQ atual -> mantém OpenAQ  |  3) OpenAQ sem o poluente -> tenta Open-Meteo   (estação #${mista.id})`);
    resMista = await obterUltimasMedicoes(mista.id);
    tabela('resultado consolidado:', resMista.medicoes);
    const om = await omDireto(mista);

    for (const m of mista.bruto.medicoes.filter(atual)) {
      const c = porChave(resMista.medicoes, m.chave);
      check(
        c.fonte === 'OPENAQ' && c.valor === m.valor && c.dataHora === m.medidoEm && c.sensorId === m.sensorId && c.desatualizada === false,
        `${m.nome}: dado atual da OpenAQ mantido (${c.valor} ${c.unidade}, fonte ${c.fonte})`,
        `${m.nome}: dado atual da OpenAQ foi substituído ou alterado (${JSON.stringify(c)})`
      );
    }
    for (const m of mista.bruto.medicoes.filter(ausente)) {
      const c = porChave(resMista.medicoes, m.chave);
      const esperado = om.valores[m.chave];
      if (!esperado) {
        pulado(`${m.nome}: Open-Meteo não tem valor agora`);
        continue;
      }
      check(
        c.fonte === 'OPEN_METEO' && c.tipoDado === 'MODELO' && c.valor === esperado.valor && c.unidade === esperado.unidade && c.sensorId === null,
        `${m.nome}: sem sensor na OpenAQ (${m.motivo}) -> Open-Meteo (${c.valor} ${c.unidade})`,
        `${m.nome}: fallback para Open-Meteo não ocorreu como esperado (${JSON.stringify(c)})`
      );
    }
    check(
      resMista.fontesUtilizadas.includes('OPENAQ') && resMista.fontesUtilizadas.includes('OPEN_METEO'),
      `6) fontesUtilizadas = ${JSON.stringify(resMista.fontesUtilizadas)}`,
      `6) fontesUtilizadas inesperado: ${JSON.stringify(resMista.fontesUtilizadas)}`
    );
    check(resMista.atribuicoes.includes(ATRIBUICAO_OPEN_METEO), 'atribuição da Open-Meteo presente na resposta', 'atribuição da Open-Meteo ausente');
  } else {
    pulado('cenários 1 e 3 sem estação adequada');
  }

  // ---- 2, 6, 7 (estação só com dado desatualizado)
  let resAntiga: Awaited<ReturnType<typeof obterUltimasMedicoes>> | undefined;
  if (antiga) {
    console.log(`\n2) OpenAQ desatualizada -> Open-Meteo como fallback   (estação #${antiga.id})`);
    resAntiga = await obterUltimasMedicoes(antiga.id);
    tabela('resultado consolidado:', resAntiga.medicoes);
    const om = await omDireto(antiga);

    for (const m of antiga.bruto.medicoes.filter(velha)) {
      const c = porChave(resAntiga.medicoes, m.chave);
      const esperado = om.valores[m.chave];
      if (!esperado) {
        pulado(`${m.nome}: Open-Meteo não tem valor agora`);
        continue;
      }
      check(
        c.fonte === 'OPEN_METEO' && c.valor === esperado.valor && c.desatualizada === false && Date.parse(c.dataHora!) > Date.parse(m.medidoEm!),
        `${m.nome}: OpenAQ de ${m.medidoEm} (desatualizada) -> Open-Meteo ${c.valor} ${c.unidade} de ${c.dataHora}`,
        `${m.nome}: fallback de dado desatualizado falhou (${JSON.stringify(c)})`
      );
    }
    check(
      JSON.stringify(resAntiga.fontesUtilizadas) === JSON.stringify(['OPEN_METEO']),
      `6) fontesUtilizadas = ${JSON.stringify(resAntiga.fontesUtilizadas)} (nenhuma OpenAQ atual nesta estação)`,
      `6) fontesUtilizadas inesperado: ${JSON.stringify(resAntiga.fontesUtilizadas)}`
    );
  } else {
    pulado('cenário 2 sem estação adequada');
  }

  // ---- 4 (ambas sem dado)
  console.log('\n4) OpenAQ e Open-Meteo sem dado -> indisponível');
  const alvo = mista || antiga;
  if (alvo) {
    // (a) resposta REAL da Open-Meteo em que a API só traz pm2_5: os demais poluentes ficam sem dado nas duas fontes
    const parcial = mapOpenMeteo(await openmeteo.getCurrentAirQuality(arredondar(alvo.latitude), arredondar(alvo.longitude), { variaveis: ['pm2_5'] }));
    const cons = consolidar(alvo.bruto, { status: 'ok', dados: parcial });
    const semAmbas = alvo.bruto.medicoes.filter((m) => ausente(m) && m.chave !== 'pm25');
    semAmbas.forEach((m) => {
      const c = porChave(cons.medicoes, m.chave);
      check(
        !c.disponivel && c.valor === null && c.unidade === null && c.dataHora === null && c.fonte === null && c.motivoFallback === 'sem_dado_open_meteo',
        `${m.nome}: sem sensor na OpenAQ e ausente na resposta real da Open-Meteo -> indisponível (valor null)`,
        `${m.nome}: deveria estar indisponível (${JSON.stringify(c)})`
      );
    });
    if (semAmbas.length === 0) pulado('estação não tem poluente ausente na OpenAQ para este teste');
    // (b) Open-Meteo fora do ar (falha técnica) + OpenAQ sem o poluente
    process.env.OPEN_METEO_BASE_URL = 'http://127.0.0.1:9';
    limparCache('openmeteo:');
    const res = await obterUltimasMedicoes(alvo.id);
    alvo.bruto.medicoes.filter(ausente).forEach((m) => {
      const c = porChave(res.medicoes, m.chave);
      check(
        !c.disponivel && c.valor === null && c.fonte === null && c.motivoFallback === 'falha_open_meteo',
        `${m.nome}: sem sensor na OpenAQ + Open-Meteo fora do ar -> indisponível (motivoFallback ${c.motivoFallback})`,
        `${m.nome}: deveria estar indisponível (${JSON.stringify(c)})`
      );
    });
    delete process.env.OPEN_METEO_BASE_URL;
  } else {
    pulado('cenário 4 sem estação');
  }

  // ---- 5 (Open-Meteo indisponível mantém OpenAQ)
  console.log('\n5) Open-Meteo indisponível -> mantém os dados válidos da OpenAQ');
  const mudo = await subirServidor(() => {}); // aceita e nunca responde
  const lixo = await subirServidor((_q, r) => r.end('<html>nao sou json</html>'));
  const r429 = await subirServidor((_q, r) => r.writeHead(429).end());
  const r500 = await subirServidor((_q, r) => r.writeHead(500).end());
  const variantes: [string, string, string?][] = [
    ['conexão recusada', 'http://127.0.0.1:9'],
    ['sem resposta (timeout 1,5 s)', mudo.url, '1500'],
    ['resposta que não é JSON', lixo.url],
    ['429 limite de requisições', r429.url],
    ['500 erro do servidor', r500.url],
  ];
  for (const [nome, url, timeout] of variantes) {
    process.env.OPEN_METEO_BASE_URL = url;
    if (timeout) process.env.OPEN_METEO_TIMEOUT_MS = timeout;
    for (const c of [mista, antiga].filter(Boolean) as Candidata[]) {
      limparCache('openmeteo:');
      try {
        const res = await obterUltimasMedicoes(c.id);
        const intactos = c.bruto.medicoes.filter((m) => m.disponivel).every((m) => {
          const x = porChave(res.medicoes, m.chave);
          return x.disponivel && x.fonte === 'OPENAQ' && x.valor === m.valor && x.dataHora === m.medidoEm && x.desatualizada === (m.desatualizada === true);
        });
        check(
          intactos && res.statusFontes.OPEN_METEO === 'falha' && !res.fontesUtilizadas.includes('OPEN_METEO'),
          `${nome} | #${c.id}: rota respondeu; OpenAQ preservada (fontes ${JSON.stringify(res.fontesUtilizadas)}, status ${res.statusFontes.OPEN_METEO})`,
          `${nome} | #${c.id}: OpenAQ não foi preservada ou status incorreto`
        );
      } catch (error: any) {
        falha(`${nome} | #${c.id}: a falha da Open-Meteo derrubou a consulta -> ${error?.message}`);
      }
    }
  }
  // falha REAL da Open-Meteo: domínio europeu não cobre o Brasil e a API responde 400
  delete process.env.OPEN_METEO_BASE_URL;
  delete process.env.OPEN_METEO_TIMEOUT_MS;
  try {
    await openmeteo.getCurrentAirQuality(-23.54, -46.63, { domains: 'cams_europe' });
    pulado('Open-Meteo aceitou o domínio europeu para o Brasil (esperava HTTP 400)');
  } catch (error: any) {
    check(error instanceof openmeteo.OpenMeteoError && error.kind === 'bad_request', `HTTP 400 REAL da Open-Meteo tratado como "${error.kind}"`, `erro inesperado: ${error?.kind || error?.message}`);
  }
  [mudo, lixo, r429, r500].forEach((s) => s.servidor.close());

  // ---- 7 (nenhum dado fictício)
  console.log('\n7) Nenhum dado fictício: cada valor bate com a API de origem');
  for (const [c, resAnterior] of [[mista, resMista], [antiga, resAntiga]] as const) {
    if (!c || !resAnterior) continue;
    // Sensores ativos recebem leituras novas a cada hora: refaz a consulta (sem cache) logo antes de comparar
    limparCache();
    const res = await obterUltimasMedicoes(c.id);
    const brutosOpenAQ = await openaq.getLocationLatest(c.id);
    const om = await omDireto(c);
    const incoerentes = res.medicoes.filter((m) => {
      if (!m.disponivel) return m.valor !== null || m.unidade !== null || m.dataHora !== null || m.fonte !== null;
      if (!Number.isFinite(m.valor) || m.valor! < 0) return true;
      if (m.fonte === 'OPENAQ') {
        const linha = brutosOpenAQ.find((l) => l.sensorsId === m.sensorId);
        return !linha || linha.value !== m.valor || new Date(linha.datetime.utc).toISOString() !== m.dataHora;
      }
      const esperado = om.valores[m.chave];
      return !esperado || esperado.valor !== m.valor || esperado.unidade !== m.unidade;
    });
    check(incoerentes.length === 0, `#${c.id}: ${res.medicoes.length} poluentes conferidos contra OpenAQ/Open-Meteo diretas`, `#${c.id}: valores sem correspondência na fonte -> ${incoerentes.map((m) => m.poluente).join(', ')}`);
  }

  // ---- cache da Open-Meteo
  console.log('\n8) Cache: a Open-Meteo não é chamada de novo para a mesma coordenada');
  let chamadas = 0;
  const proxy = await subirServidor(async (req, res) => {
    chamadas++;
    const real = await fetch(`https://air-quality-api.open-meteo.com${req.url}`);
    res.writeHead(real.status, { 'content-type': 'application/json' }).end(await real.text());
  });
  process.env.OPEN_METEO_BASE_URL = `${proxy.url}/v1`;
  limparCache('openmeteo:');
  const estacaoCache = antiga || mista;
  if (estacaoCache) {
    await obterUltimasMedicoes(estacaoCache.id);
    const aposPrimeira = chamadas;
    await obterUltimasMedicoes(estacaoCache.id);
    await obterUltimasMedicoes(estacaoCache.id);
    check(aposPrimeira === 1 && chamadas === 1, `3 consultas da mesma estação -> ${chamadas} chamada(s) à Open-Meteo (proxy repassa à API real)`, `esperava 1 chamada à Open-Meteo, houve ${chamadas}`);
  } else {
    pulado('cache sem estação');
  }
  delete process.env.OPEN_METEO_BASE_URL;
  proxy.servidor.close();
}

main()
  .catch((error) => falha(error instanceof Error ? `${error.name}: ${error.message}` : String(error)))
  .finally(() => {
    console.log(`\nResultado: ${falhas === 0 ? 'TODAS as validações executadas passaram' : `${falhas} validação(ões) FALHARAM`}${pulados ? ` (${pulados} item(ns) pulado(s))` : ''}.`);
    process.exit(falhas === 0 ? 0 : 1);
  });
