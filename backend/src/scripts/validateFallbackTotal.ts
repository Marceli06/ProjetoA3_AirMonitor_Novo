import http from 'http';
import { AddressInfo } from 'net';
import dotenv from 'dotenv';
import { OpenAQError } from '../integrations/openaq/client';
import * as openmeteo from '../integrations/openmeteo/client';
import { mapOpenMeteo } from '../integrations/openmeteo/mapper';
import { buscarEstacoes, obterUltimasMedicoes } from '../services/airQuality';
import { ATRIBUICAO_OPEN_METEO } from '../services/consolidador';
import { limparCache } from '../services/cache';
import { COORDENADAS_CIDADES } from '../data/cidadesCoordenadas';

dotenv.config();

// Valida o fallback TOTAL: a OpenAQ inteira fora do ar e a Open-Meteo assumindo.
// A estação vem da OpenAQ real e os valores da Open-Meteo são os da API real (conferidos com uma chamada direta).
// Servidores locais simulam APENAS falhas técnicas da OpenAQ (timeout, 429, 5xx, recusa de conexão, 422, HTML).
// Uso: npm run fallback-total:validate [cidade]      (padrão: São Paulo)
// Nunca imprime a chave da OpenAQ.

const cidade = process.argv[2] || 'São Paulo';
let falhas = 0;
const ok = (msg: string) => console.log(`  [OK]    ${msg}`);
const falha = (msg: string) => {
  falhas++;
  console.log(`  [FALHA] ${msg}`);
};
const check = (cond: boolean, msgOk: string, msgFalha: string) => (cond ? ok(msgOk) : falha(msgFalha));

async function subir(handler: http.RequestListener) {
  const servidor = http.createServer(handler);
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  return { servidor, url: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}` };
}

const arredondar = (n: number) => Number(n.toFixed(2));
const chaveReal = process.env.OPENAQ_API_KEY;
const restaurarAmbiente = () => {
  if (chaveReal === undefined) delete process.env.OPENAQ_API_KEY;
  else process.env.OPENAQ_API_KEY = chaveReal;
  delete process.env.OPENAQ_BASE_URL;
  delete process.env.OPENAQ_TIMEOUT_MS;
  delete process.env.OPEN_METEO_BASE_URL;
  limparCache();
};

async function tentar(id: number) {
  try {
    return { resultado: await obterUltimasMedicoes(id), erro: null as unknown };
  } catch (erro) {
    return { resultado: null, erro };
  }
}

async function main() {
  const centro = COORDENADAS_CIDADES[cidade];
  if (!centro) throw new Error(`Cidade desconhecida: ${cidade}`);

  console.log(`\n0) Preparação: estação real mais próxima de ${cidade} (OpenAQ real) e referência da Open-Meteo real`);
  const estacoes = await buscarEstacoes({ ...centro, raioMetros: 25000, limite: 1 });
  const alvo = estacoes[0];
  if (!alvo || alvo.latitude === null || alvo.longitude === null) throw new Error('nenhuma estação com coordenadas encontrada');
  ok(`estação #${alvo.id} "${alvo.nome}" (${alvo.latitude}, ${alvo.longitude}) agora é "conhecida" pelo serviço`);
  const ref = mapOpenMeteo(await openmeteo.getCurrentAirQuality(arredondar(alvo.latitude), arredondar(alvo.longitude)));
  ok(`Open-Meteo real: ${Object.keys(ref.valores).length} poluentes (${Object.keys(ref.valores).join(', ')})`);

  // Servidores que simulam falhas técnicas da OpenAQ
  const mudo = await subir(() => {}); // aceita e nunca responde
  const r429 = await subir((_q, r) => r.writeHead(429, { 'x-ratelimit-reset': '30' }).end());
  const r500 = await subir((_q, r) => r.writeHead(500).end());
  const r422 = await subir((_q, r) => r.writeHead(422).end('{}'));
  const html = await subir((_q, r) => r.end('<html>nao sou json</html>'));
  // Repassa tudo para a OpenAQ REAL, exceto /latest (500): a localização chega, as medições não
  const soLatestFalha = await subir(async (req, res) => {
    if (req.url?.includes('/latest')) return void res.writeHead(500).end();
    const real = await fetch(`https://api.openaq.org${req.url}`, { headers: { 'X-API-Key': String(chaveReal) } });
    res.writeHead(real.status, { 'content-type': 'application/json' }).end(await real.text());
  });

  const falhasTemporarias: [string, string, string?, string?][] = [
    ['1) OpenAQ timeout (1,5 s)', mudo.url, '1500', 'timeout'],
    ['2) OpenAQ HTTP 429', r429.url, undefined, 'rate_limit'],
    ['3) OpenAQ HTTP 5xx (500)', r500.url, undefined, 'unavailable'],
    ['3b) OpenAQ recusa conexão (rede)', 'http://127.0.0.1:9', undefined, 'unavailable'],
    ['3c) localização OK, mas /latest da OpenAQ dá 500', `${soLatestFalha.url}/v3`, undefined, 'unavailable'],
  ];

  for (const [titulo, url, timeout, tipoEsperado] of falhasTemporarias) {
    console.log(`\n${titulo} + Open-Meteo disponível`);
    restaurarAmbiente();
    process.env.OPENAQ_BASE_URL = url;
    if (timeout) process.env.OPENAQ_TIMEOUT_MS = timeout;
    const { resultado, erro } = await tentar(alvo.id);
    if (!resultado) {
      falha(`a consulta virou erro (${erro instanceof OpenAQError ? erro.kind : String(erro)}) em vez de usar a Open-Meteo`);
      continue;
    }
    check(resultado.statusFontes.OPENAQ === 'falha' && resultado.statusFontes.erroOpenAQ === tipoEsperado, `statusFontes.OPENAQ = "falha" (${resultado.statusFontes.erroOpenAQ}), OPEN_METEO = "${resultado.statusFontes.OPEN_METEO}"`, `statusFontes inesperado: ${JSON.stringify(resultado.statusFontes)}`);
    check(JSON.stringify(resultado.fontesUtilizadas) === JSON.stringify(['OPEN_METEO']), 'fontesUtilizadas = ["OPEN_METEO"]', `fontesUtilizadas inesperado: ${JSON.stringify(resultado.fontesUtilizadas)}`);
    const incorretos = resultado.medicoes.filter((m) => {
      const esperado = ref.valores[m.chave];
      return !(m.disponivel && m.fonte === 'OPEN_METEO' && m.tipoDado === 'MODELO' && m.sensorId === null && esperado && m.valor === esperado.valor && m.unidade === esperado.unidade && m.dataHora === esperado.dataHora && m.motivo === 'openaq_indisponivel');
    });
    check(incorretos.length === 0, `${resultado.medicoes.length} poluentes: fonte OPEN_METEO, tipoDado MODELO, valores idênticos aos da API real`, `poluentes divergentes: ${incorretos.map((m) => m.poluente).join(', ')}`);
    check(resultado.atribuicoes.includes(ATRIBUICAO_OPEN_METEO) && resultado.estacao.id === alvo.id, 'atribuição presente e estação de origem preservada', 'atribuição ausente ou estação incorreta');
    console.log(`          ${resultado.medicoes.map((m) => `${m.poluente}=${m.valor} ${m.unidade}`).join(' | ')}`);
  }

  console.log('\n4) Ambas as fontes indisponíveis -> erro original da OpenAQ (nada é inventado)');
  for (const [titulo, url, timeout, tipoEsperado] of falhasTemporarias.slice(0, 3)) {
    restaurarAmbiente();
    process.env.OPENAQ_BASE_URL = url;
    if (timeout) process.env.OPENAQ_TIMEOUT_MS = timeout;
    process.env.OPEN_METEO_BASE_URL = 'http://127.0.0.1:9'; // Open-Meteo fora do ar
    const { resultado, erro } = await tentar(alvo.id);
    check(
      resultado === null && erro instanceof OpenAQError && erro.kind === tipoEsperado,
      `${titulo.replace(/^\d\) /, '')} + Open-Meteo fora do ar -> erro "${tipoEsperado}" (a rota responde 504/429/502, como antes)`,
      `esperava erro "${tipoEsperado}", obtido: ${resultado ? 'resposta com dados' : String(erro)}`
    );
  }
  restaurarAmbiente();
  process.env.OPENAQ_BASE_URL = mudo.url;
  process.env.OPENAQ_TIMEOUT_MS = '1500';
  process.env.OPEN_METEO_BASE_URL = html.url; // Open-Meteo devolvendo lixo
  const lixo = await tentar(alvo.id);
  check(lixo.resultado === null && lixo.erro instanceof OpenAQError && lixo.erro.kind === 'timeout', 'OpenAQ timeout + Open-Meteo com resposta inválida -> erro "timeout"', 'esperava erro "timeout"');

  console.log('\n5) Casos em que NÃO há fallback (tratamento atual preservado, mesmo com a Open-Meteo disponível)');
  const semFallback: [string, () => void, string][] = [
    ['estação inexistente (OpenAQ real responde 404)', () => {}, 'not_found'],
    ['chave da OpenAQ inválida (configuração local)', () => { process.env.OPENAQ_API_KEY = 'chave-invalida-de-teste-0000'; }, 'auth'],
    ['chave da OpenAQ ausente (configuração local)', () => { process.env.OPENAQ_API_KEY = ''; }, 'config'],
    ['parâmetro recusado pela OpenAQ (422)', () => { process.env.OPENAQ_BASE_URL = r422.url; }, 'bad_request'],
    ['resposta inválida da OpenAQ (HTML)', () => { process.env.OPENAQ_BASE_URL = html.url; }, 'invalid_response'],
  ];
  for (const [titulo, preparar, tipoEsperado] of semFallback) {
    restaurarAmbiente();
    preparar();
    const id = tipoEsperado === 'not_found' ? 999999999 : alvo.id;
    const { resultado, erro } = await tentar(id);
    check(resultado === null && erro instanceof OpenAQError && erro.kind === tipoEsperado, `${titulo} -> erro "${tipoEsperado}" (sem fallback)`, `esperava erro "${tipoEsperado}", obtido: ${resultado ? 'resposta com dados' : erro instanceof OpenAQError ? erro.kind : String(erro)}`);
  }
  restaurarAmbiente();
  process.env.OPENAQ_BASE_URL = r500.url;
  const desconhecida = await tentar(123456789);
  check(desconhecida.resultado === null && desconhecida.erro instanceof OpenAQError && desconhecida.erro.kind === 'unavailable', 'falha temporária da OpenAQ, mas estação nunca vista (sem coordenadas) -> erro original', 'esperava erro "unavailable" para estação desconhecida');

  [mudo, r429, r500, r422, html, soLatestFalha].forEach((s) => s.servidor.close());
  restaurarAmbiente();
}

main()
  .catch((error) => falha(error instanceof Error ? `${error.name}: ${error.message}` : String(error)))
  .finally(() => {
    console.log(`\nResultado: ${falhas === 0 ? 'TODAS as validações passaram.' : `${falhas} validação(ões) FALHARAM.`}`);
    process.exit(falhas === 0 ? 0 : 1);
  });
