import http from 'http';
import { AddressInfo } from 'net';
import { limparCache } from '../services/cache';
import { OpenAQError } from '../integrations/openaq/client';
import { POLUENTES } from '../integrations/openaq/mapper';
import { buscarEstacoes, obterEstacao, obterUltimasMedicoesOpenAQ } from '../services/airQuality';
import { COORDENADAS_CIDADES } from '../data/cidadesCoordenadas';
import dotenv from 'dotenv';

dotenv.config();

// Valida a integração contra a OpenAQ REAL (sem mocks) e imprime só códigos, ids e valores de medição.
// Uso: npm run openaq:validate [cidade]      (padrão: São Paulo)
// Nunca imprime a chave. Os cenários de falha trocam variáveis de ambiente apenas dentro deste processo.

const cidade = process.argv[2] || 'São Paulo';
let falhas = 0;

const ok = (msg: string) => console.log(`  [OK]    ${msg}`);
const falha = (msg: string) => {
  falhas++;
  console.log(`  [FALHA] ${msg}`);
};

async function esperaErro(titulo: string, esperado: string, fn: () => Promise<unknown>) {
  limparCache();
  try {
    await fn();
    falha(`${titulo}: esperava erro "${esperado}", mas a chamada funcionou`);
  } catch (error) {
    if (error instanceof OpenAQError && error.kind === esperado) ok(`${titulo}: erro "${error.kind}" tratado (${error.message})`);
    else falha(`${titulo}: erro inesperado -> ${error instanceof OpenAQError ? error.kind : String(error)}`);
  }
}

type Centro = { latitude: number; longitude: number };

async function validarSucesso(centro: Centro) {
  console.log(`\n1) Estações próximas de ${cidade} (raio 25 km)`);
  const estacoes = await buscarEstacoes({ ...centro, raioMetros: 25000, limite: 100 });
  if (estacoes.length === 0) {
    falha('nenhuma estação com os poluentes monitorados encontrada');
    return;
  }
  ok(`${estacoes.length} estação(ões) encontrada(s)`);
  estacoes.slice(0, 5).forEach((e) =>
    console.log(`          #${e.id} ${e.nome} (${e.latitude}, ${e.longitude}) a ${e.distanciaMetros}m — ${e.poluentes.map((p) => p.nome).join(', ')}`)
  );

  console.log('\n2) Detalhes de uma estação e medições mais recentes');
  // Escolhe a estação com mais poluentes; empate: a mais recentemente atualizada
  const escolhida = [...estacoes].sort(
    (a, b) => b.poluentes.length - a.poluentes.length || String(b.ultimaMedicaoEm).localeCompare(String(a.ultimaMedicaoEm))
  )[0];
  const info = await obterEstacao(escolhida.id);
  ok(`estação #${info.id} "${info.nome}" — sensores: ${info.poluentes.map((p) => `${p.nome}(${p.unidade})`).join(', ')}`);

  const ultimas = await obterUltimasMedicoesOpenAQ(escolhida.id);
  ultimas.medicoes.forEach((m) =>
    console.log(
      m.disponivel
        ? `          ${m.nome.padEnd(6)} ${String(m.valor).padStart(8)} ${m.unidade}  em ${m.medidoEm}${m.desatualizada ? '  (DESATUALIZADA)' : ''}`
        : `          ${m.nome.padEnd(6)} indisponível (${m.motivo})`
    )
  );
  const encontrados = ultimas.medicoes.filter((m) => m.disponivel).length;
  encontrados > 0 ? ok(`${encontrados} de ${POLUENTES.length} poluentes com medição`) : falha('nenhum poluente com medição');
  ultimas.medicoes.filter((m) => !m.disponivel).every((m) => m.valor === null && m.unidade === null)
    ? ok('poluentes sem dado voltam com valor null (nada foi inventado)')
    : falha('poluente indisponível com valor preenchido');

}

async function validarFalhas(centro: Centro) {
  console.log('\n3) Estação inexistente');
  await esperaErro('GET estação 999999999', 'not_found', () => obterEstacao(999999999));

  console.log('\n4) Chave inválida');
  const chaveReal = process.env.OPENAQ_API_KEY;
  process.env.OPENAQ_API_KEY = 'chave-invalida-de-teste-0000';
  await esperaErro('chave inválida', 'auth', () => buscarEstacoes({ ...centro, raioMetros: 5000, limite: 5 }));

  console.log('\n5) Chave ausente');
  process.env.OPENAQ_API_KEY = '';
  await esperaErro('chave ausente', 'config', () => buscarEstacoes({ ...centro, raioMetros: 5000, limite: 5 }));

  console.log('\n6) OpenAQ fora do ar / sem responder (servidores locais; chave fictícia só neste processo)');
  process.env.OPENAQ_API_KEY = 'chave-ficticia-para-servidores-locais';
  process.env.OPENAQ_BASE_URL = 'http://127.0.0.1:9';
  await esperaErro('conexão recusada', 'unavailable', () => buscarEstacoes({ ...centro, raioMetros: 5000, limite: 5 }));

  const servidorMudo = http.createServer(() => {}); // aceita a conexão e nunca responde
  await new Promise<void>((resolve) => servidorMudo.listen(0, '127.0.0.1', resolve));
  process.env.OPENAQ_BASE_URL = `http://127.0.0.1:${(servidorMudo.address() as AddressInfo).port}`;
  process.env.OPENAQ_TIMEOUT_MS = '1500';
  await esperaErro('sem resposta (timeout 1,5 s)', 'timeout', () => buscarEstacoes({ ...centro, raioMetros: 5000, limite: 5 }));

  const servidorLixo = http.createServer((_req, res) => res.end('<html>nao sou json</html>'));
  await new Promise<void>((resolve) => servidorLixo.listen(0, '127.0.0.1', resolve));
  process.env.OPENAQ_BASE_URL = `http://127.0.0.1:${(servidorLixo.address() as AddressInfo).port}`;
  await esperaErro('resposta que não é JSON', 'invalid_response', () => buscarEstacoes({ ...centro, raioMetros: 5000, limite: 5 }));

  const servidor429 = http.createServer((_req, res) => {
    res.writeHead(429, { 'x-ratelimit-reset': '42' }).end();
  });
  await new Promise<void>((resolve) => servidor429.listen(0, '127.0.0.1', resolve));
  process.env.OPENAQ_BASE_URL = `http://127.0.0.1:${(servidor429.address() as AddressInfo).port}`;
  await esperaErro('limite de requisições (429)', 'rate_limit', () => buscarEstacoes({ ...centro, raioMetros: 5000, limite: 5 }));

  [servidorMudo, servidorLixo, servidor429].forEach((s) => s.close());
  if (chaveReal === undefined) delete process.env.OPENAQ_API_KEY;
  else process.env.OPENAQ_API_KEY = chaveReal;
}

async function main() {
  const centro = COORDENADAS_CIDADES[cidade];
  if (!centro) throw new Error(`Cidade desconhecida: ${cidade}`);

  // Os cenários de falha rodam mesmo que o de sucesso falhe (ex.: chave ainda não configurada)
  try {
    await validarSucesso(centro);
  } catch (error) {
    falha(error instanceof OpenAQError ? `${error.kind}: ${error.message}` : String(error));
  }
  await validarFalhas(centro);
}

main()
  .catch((error) => {
    falha(error instanceof OpenAQError ? `${error.kind}: ${error.message}` : String(error));
  })
  .finally(() => {
    console.log(falhas === 0 ? '\nResultado: TODAS as validações passaram.' : `\nResultado: ${falhas} validação(ões) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
  });
