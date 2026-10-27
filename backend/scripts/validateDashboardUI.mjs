// Validação de navegador do Dashboard do Usuário (Chrome headless via DevTools Protocol, sem dependências novas).
// Roda no Node 22 (WebSocket global). Cria usuários temporários pelo cadastro público e SEMPRE os remove no final.
// Respostas "fixture" (Fetch.fulfillRequest) são usadas SOMENTE para provocar estados que a API real não está
// produzindo agora (dado desatualizado, indisponível, erro 500/401...). Os casos de dado real não usam fixture.
// Uso (dentro de backend/): APP_URL=http://127.0.0.1:5196 API_URL=http://127.0.0.1:3996/api node scripts/validateDashboardUI.mjs
// Não imprime senhas nem tokens.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const APP = process.env.APP_URL || 'http://127.0.0.1:5196';
const API = process.env.API_URL || 'http://127.0.0.1:3996/api';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORTA_CDP = Number(process.env.CDP_PORT || 9333);
const SHOTS = process.env.SHOTS_DIR || join(process.cwd(), '.tmp-ui-shots');
mkdirSync(SHOTS, { recursive: true });

const resultados = [];
const emails = [];
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CDP mínimo
let ws, idMsg = 0;
const pendentes = new Map();
const ouvintes = [];
const errosDePagina = [];
const requisicoes = []; // {url, method, status}

function enviar(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++idMsg;
    pendentes.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function avaliar(expressao) {
  const r = await enviar('Runtime.evaluate', { expression: expressao, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('Erro no navegador: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function esperar(expressao, ms = 15000, descricao = expressao) {
  const limite = Date.now() + ms;
  let ultimo;
  while (Date.now() < limite) {
    try { ultimo = await avaliar(expressao); if (ultimo) return ultimo; } catch (e) { ultimo = e.message; }
    await dormir(150);
  }
  throw new Error(`Tempo esgotado esperando: ${descricao}`);
}
const textos = (seletor) => avaliar(`[...document.querySelectorAll(${JSON.stringify(seletor)})].map(e => e.innerText.trim())`);
const texto = (seletor) => avaliar(`(document.querySelector(${JSON.stringify(seletor)})||{}).innerText ?? null`);

async function abrirChrome() {
  const dir = join(tmpdir(), 'airmonitor-cdp-' + Date.now());
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORTA_CDP}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1366,900', 'about:blank',
  ], { stdio: 'ignore' });
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) {
    await dormir(250);
    try {
      const lista = await (await fetch(`http://127.0.0.1:${PORTA_CDP}/json/list`)).json();
      alvo = lista.find((t) => t.type === 'page');
    } catch { /* ainda subindo */ }
  }
  if (!alvo) throw new Error('Chrome não abriu a porta de depuração');
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('falha no WebSocket do Chrome')); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pendentes.has(msg.id)) {
      const p = pendentes.get(msg.id); pendentes.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method) ouvintes.forEach((f) => f(msg));
  };
  const versao = await (await fetch(`http://127.0.0.1:${PORTA_CDP}/json/version`)).json();
  for (const d of ['Page', 'Runtime', 'Network', 'Log']) await enviar(`${d}.enable`);
  ouvintes.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') errosDePagina.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Network.requestWillBeSent') requisicoes.push({ id: m.params.requestId, url: m.params.request.url, method: m.params.request.method, status: null });
    if (m.method === 'Network.responseReceived') { const r = requisicoes.find((x) => x.id === m.params.requestId); if (r) r.status = m.params.response.status; }
    if (m.method === 'Network.loadingFailed') { const r = requisicoes.find((x) => x.id === m.params.requestId); if (r) r.status = 'FALHOU:' + m.params.errorText; }
  });
  return { proc, dir, versao: versao.Browser };
}

// ---------------------------------------------------------------- Interceptação (fixtures) das rotas /air-quality
let rota = null; // (req) => null (segue a API real) | {status, corpo, atrasoMs} | {falhar:true} | {pendurar:true}
const CORS = [
  { name: 'Access-Control-Allow-Origin', value: '*' },
  { name: 'Access-Control-Allow-Headers', value: 'authorization,content-type' },
  { name: 'Access-Control-Allow-Methods', value: 'GET,POST,OPTIONS' },
  { name: 'Content-Type', value: 'application/json' },
];
async function ligarInterceptacao() {
  await enviar('Fetch.enable', { patterns: [{ urlPattern: '*/api/air-quality/*', requestStage: 'Request' }] });
  ouvintes.push(async (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    try {
      if (!rota) return await enviar('Fetch.continueRequest', { requestId });
      if (request.method === 'OPTIONS') return await enviar('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: CORS, body: '' });
      const r = rota({ url: request.url, tipo: /\/latest/.test(request.url) ? 'latest' : 'locations' });
      if (!r) return await enviar('Fetch.continueRequest', { requestId });
      if (r.falhar) return await enviar('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
      if (r.pendurar) return; // nunca responde: valida o estado "Carregando…"
      if (r.atrasoMs) await dormir(r.atrasoMs);
      await enviar('Fetch.fulfillRequest', { requestId, responseCode: r.status, responseHeaders: CORS, body: Buffer.from(JSON.stringify(r.corpo), 'utf8').toString('base64') });
    } catch { /* página trocou durante a interceptação */ }
  });
}

// ---------------------------------------------------------------- Ações de tela
async function navegar(url) {
  await enviar('Page.navigate', { url });
  await esperar(`document.readyState === 'complete'`, 15000, 'carregar a página');
}
async function digitar(seletor, valor) {
  await avaliar(`(()=>{const e=document.querySelector(${JSON.stringify(seletor)}); e.focus(); e.select && e.select(); return true})()`);
  await enviar('Input.insertText', { text: valor });
}
async function loginPelaTela(email, senha) {
  await navegar(APP + '/');
  await avaliar(`localStorage.clear()`);
  await navegar(APP + '/');
  await esperar(`!!document.querySelector('input[name="email"]')`, 15000, 'formulário de login');
  await digitar('input[name="email"]', email);
  await digitar('input[name="password"]', senha);
  await avaliar(`document.querySelector('form button[type="submit"], form .login-button, form button').click()`);
}
const dashboardAberto = () => esperar(`!!document.querySelector('.dash-main h1')`, 20000, 'Dashboard aberto');
const cardsPoluentes = () => avaliar(`[...document.querySelectorAll('.pollutant')].map(c => ({
  nome: c.querySelector('.pollutant-name strong')?.innerText.trim(),
  valor: c.querySelector('.pollutant-value b')?.innerText.trim() ?? null,
  unidade: c.querySelector('.pollutant-value b') ? c.querySelector('.pollutant-value span')?.innerText.trim() : null,
  rotulo: (c.querySelector('.tag-ok, .tag-model, .tag-none')?.innerText || '').replace('●','').trim(),
  meta: c.querySelector('.pollutant-meta')?.innerText.trim() ?? null,
  tudo: c.innerText.replace(/\\s+/g,' ').trim(),
}))`);
const aguardarCarga = () => esperar(`document.querySelectorAll('.pollutant').length === 6 && !/Carregando/.test(document.querySelector('.dash-pollutants').innerText)`, 30000, 'fim do carregamento dos poluentes');
async function foto(nome, largura, altura, mobile = false) {
  await enviar('Emulation.setDeviceMetricsOverride', { width: largura, height: altura, deviceScaleFactor: 1, mobile });
  await dormir(400);
  const m = await enviar('Page.getLayoutMetrics');
  const alturaTotal = Math.ceil(m.cssContentSize?.height || m.contentSize.height);
  const r = await enviar('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: largura, height: Math.min(alturaTotal, 3000), scale: 1 } });
  writeFileSync(join(SHOTS, nome + '.png'), Buffer.from(r.data, 'base64'));
}
const FORMATAR_DATA = (iso) => avaliar(`new Date(${JSON.stringify(iso)}).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })`);
const FORMATAR_VALOR = (v) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

// ---------------------------------------------------------------- Infra de casos
const afirmar = (c, msg) => { if (!c) throw new Error(msg); };
async function caso(id, descricao, fn) {
  const t0 = Date.now();
  try {
    const detalhe = await fn();
    resultados.push({ id, descricao, ok: true, detalhe: detalhe || '' });
    console.log(`[APROVADO]  ${id} ${descricao}${detalhe ? '\n              ↳ ' + detalhe : ''}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    resultados.push({ id, descricao, ok: false, detalhe: e.message });
    console.log(`[REPROVADO] ${id} ${descricao}\n              ↳ ${e.message}`);
  }
}

async function http(caminho, { token, corpo } = {}) {
  const res = await fetch(API + caminho, {
    method: corpo ? 'POST' : 'GET',
    headers: { ...(corpo ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo ? Buffer.from(JSON.stringify(corpo), 'utf8') : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* sem corpo */ }
  return { status: res.status, json };
}
async function criarUsuario(rotulo, cidade) {
  const email = `tmp.ui.${rotulo}.${Date.now()}@example.com`;
  const senha = `Tmp-${Math.random().toString(36).slice(2)}-7`;
  emails.push(email);
  const r = await http('/auth/register', { corpo: { nome: `Teste UI ${rotulo}`, email, password: senha, confirmPassword: senha, cidade, regiao: 'Centro' } });
  if (r.status !== 201) throw new Error(`cadastro do usuário de teste falhou: HTTP ${r.status}`);
  return { email, senha, token: r.json.token, nome: `Teste UI ${rotulo}`, cidade };
}

// ---------------------------------------------------------------- Fixtures
const base = (chave, extra = {}) => ({ chave, poluente: chave, disponivel: false, valor: null, unidade: null, dataHora: null, fonte: null, tipoDado: null, desatualizada: null, ...extra });
const ESTACAO = { id: 999001, nome: 'Estação Fixture', localidade: 'Cidade Fixture', latitude: -23.5, longitude: -46.6, distanciaMetros: 4200, pais: 'BR', ultimaMedicaoEm: null };
const agoraISO = new Date(Date.now() - 20 * 60000).toISOString();
const velhoISO = new Date(Date.now() - 9 * 3600000).toISOString();
const ATRIB = 'Dados de modelo (CAMS / Copernicus) fornecidos por Open-Meteo.com, licença CC BY 4.0';
const listaFixture = { total: 1, estacoes: [ESTACAO], mensagem: null };
const latestMisto = {
  estacao: ESTACAO, atualizadoEm: agoraISO, fontesUtilizadas: ['OPENAQ', 'OPEN_METEO'],
  statusFontes: { OPENAQ: 'ok', OPEN_METEO: 'ok', erroOpenAQ: null }, atribuicoes: [ATRIB],
  medicoes: [
    base('pm25', { disponivel: true, valor: 12.34, unidade: 'µg/m³', dataHora: agoraISO, fonte: 'OPENAQ', tipoDado: 'MEDICAO', desatualizada: false }),
    base('pm10', { disponivel: true, valor: 18, unidade: 'µg/m³', dataHora: velhoISO, fonte: 'OPENAQ', tipoDado: 'MEDICAO', desatualizada: true }),
    base('o3', { disponivel: true, valor: 64.5, unidade: 'µg/m³', dataHora: agoraISO, fonte: 'OPEN_METEO', tipoDado: 'MODELO', desatualizada: false }),
    base('no2', { disponivel: false, motivo: 'sem_sensor' }),
    base('co', { disponivel: true, valor: 0.6, unidade: 'ppm', dataHora: agoraISO, fonte: 'OPENAQ', tipoDado: 'MEDICAO', desatualizada: false }),
    base('so2', { disponivel: true, valor: 0, unidade: 'µg/m³', dataHora: agoraISO, fonte: 'OPENAQ', tipoDado: 'MEDICAO', desatualizada: false }),
  ],
};
const latestSoOpenAQ = { ...latestMisto, fontesUtilizadas: ['OPENAQ'], atribuicoes: [], medicoes: latestMisto.medicoes.map((m) => (m.fonte === 'OPEN_METEO' ? base(m.chave, { disponivel: true, valor: 7, unidade: 'µg/m³', dataHora: agoraISO, fonte: 'OPENAQ', tipoDado: 'MEDICAO', desatualizada: false }) : m)) };
const latestNada = { estacao: ESTACAO, atualizadoEm: null, fontesUtilizadas: [], statusFontes: { OPENAQ: 'falha', OPEN_METEO: 'falha', erroOpenAQ: 'timeout' }, atribuicoes: [], medicoes: ['pm25', 'pm10', 'o3', 'no2', 'co', 'so2'].map((c) => base(c, { motivo: 'openaq_indisponivel' })) };
const rotaFixture = (latest, lista = listaFixture) => (r) => (r.tipo === 'locations' ? { status: 200, corpo: lista } : { status: 200, corpo: latest });

// ---------------------------------------------------------------- Execução
let chrome;
try {
  chrome = await abrirChrome();
  await ligarInterceptacao();
  console.log(`Navegador: ${chrome.versao} (headless) | App: ${APP} | API: ${API}\n`);

  const userA = await criarUsuario('A', 'São Paulo');
  const userB = await criarUsuario('B', 'Mauá');
  let respostaLista, respostaLatest, idEstacao;

  // ===== Fluxo com dados REAIS =====
  await caso('UI-01', 'Login com usuário comum pela tela', async () => {
    rota = null; requisicoes.length = 0;
    await loginPelaTela(userA.email, userA.senha);
    await dashboardAberto();
    const tokenSalvo = await avaliar(`!!localStorage.getItem('authToken')`);
    afirmar(tokenSalvo, 'token não foi salvo no localStorage');
    return 'login pela tela abriu o Dashboard e guardou a sessão';
  });

  await caso('UI-02', 'Dashboard do usuário abre corretamente (saudação, menu, sem erros de JS)', async () => {
    const h1 = await texto('.dash-main h1');
    afirmar(h1 === `Olá, ${userA.nome}!`, `saudação inesperada: ${h1}`);
    const menu = await textos('.dash-nav-item span');
    afirmar(menu.includes('Dashboard'), `menu sem Dashboard: ${menu}`);
    afirmar(errosDePagina.length === 0, `erros de JavaScript na página: ${errosDePagina.join(' | ')}`);
    return `"${h1}" | menu: ${menu.join(', ')}`;
  });

  await caso('UI-03', 'Cidade do usuário carregada (seletor = cidade cadastrada)', async () => {
    const sel = await avaliar(`({v: document.querySelector('.dash-select select').value, opcoes: [...document.querySelectorAll('.dash-select option')].map(o=>o.value), user: JSON.parse(localStorage.getItem('user')).cidade})`);
    afirmar(sel.v === 'São Paulo' && sel.user === 'São Paulo', `seletor=${sel.v} user.cidade=${sel.user}`);
    afirmar(sel.opcoes.length === 1, `usuário comum deveria ter só a própria cidade no seletor, tem: ${sel.opcoes}`);
    return `cidade=${sel.v}, opções=${sel.opcoes.length}`;
  });

  await aguardarCarga().catch(() => {});

  await caso('UI-04/05', 'Estação mais próxima escolhida automaticamente e GET /air-quality/locations real (200)', async () => {
    const r = requisicoes.find((x) => /\/air-quality\/locations\?/.test(x.url));
    afirmar(r, 'a tela não chamou GET /air-quality/locations');
    const u = new URL(r.url);
    afirmar(u.searchParams.get('cidade') === 'São Paulo' && u.searchParams.get('limite') === '1', `parâmetros inesperados: ${u.search}`);
    afirmar(r.status === 200, `status ${r.status}`);
    respostaLista = (await http(`/air-quality/locations${u.search}`, { token: userA.token })).json;
    idEstacao = respostaLista.estacoes[0].id;
    const nomeNaTela = await texto('.station-info strong');
    afirmar(nomeNaTela === (respostaLista.estacoes[0].nome || `Estação ${idEstacao}`), `tela mostra "${nomeNaTela}" mas a API devolveu "${respostaLista.estacoes[0].nome}"`);
    return `GET ${u.pathname}${u.search} → 200; estação #${idEstacao} "${nomeNaTela}"`;
  });

  await caso('UI-06', 'GET /air-quality/locations/:id/latest real (200) usando o ID da estação escolhida', async () => {
    const r = requisicoes.find((x) => /\/air-quality\/locations\/\d+\/latest/.test(x.url));
    afirmar(r, 'a tela não chamou /latest');
    afirmar(r.url.includes(`/locations/${idEstacao}/latest`), `chamou ${r.url}, esperado id ${idEstacao}`);
    afirmar(r.status === 200, `status ${r.status}`);
    respostaLatest = (await http(`/air-quality/locations/${idEstacao}/latest`, { token: userA.token })).json;
    return `GET /air-quality/locations/${idEstacao}/latest → 200`;
  });

  await caso('UI-07', 'Exibe os 6 poluentes (PM2.5, PM10, O₃, NO₂, CO, SO₂)', async () => {
    const cards = await cardsPoluentes();
    const nomes = cards.map((c) => c.nome);
    afirmar(JSON.stringify(nomes) === JSON.stringify(['PM2.5', 'PM10', 'O₃', 'NO₂', 'CO', 'SO₂']), `cards: ${nomes}`);
    return nomes.join(', ');
  });

  await caso('UI-08/09', 'Valor, unidade e rótulo de fonte na tela batem com a API (dado real)', async () => {
    const cards = await cardsPoluentes();
    const chaves = ['pm25', 'pm10', 'o3', 'no2', 'co', 'so2'];
    const linhas = [];
    chaves.forEach((k, i) => {
      const m = respostaLatest.medicoes.find((x) => x.chave === k); const c = cards[i];
      if (m.disponivel && m.valor !== null) {
        afirmar(c.valor === FORMATAR_VALOR(m.valor), `${k}: tela "${c.valor}" ≠ API ${FORMATAR_VALOR(m.valor)}`);
        afirmar(c.unidade === m.unidade, `${k}: unidade tela "${c.unidade}" ≠ API "${m.unidade}"`);
        const esperado = m.fonte === 'OPEN_METEO' ? 'Estimativa por modelo' : 'Medição de estação';
        afirmar(c.rotulo === esperado, `${k}: rótulo "${c.rotulo}" ≠ "${esperado}" (fonte ${m.fonte})`);
        linhas.push(`${c.nome}=${c.valor} ${c.unidade} [${c.rotulo}]`);
      } else {
        afirmar(c.rotulo === 'Sem dados disponíveis' && c.valor === null, `${k}: indisponível na API mas tela mostra ${JSON.stringify(c)}`);
        linhas.push(`${c.nome}=sem dados`);
      }
    });
    return linhas.join(' | ');
  });

  await caso('UI-13', 'Data/hora de "Última atualização" vem do dado real (atualizadoEm)', async () => {
    const tela = await texto('.dash-date strong');
    const esperado = await FORMATAR_DATA(respostaLatest.atualizadoEm);
    afirmar(tela === esperado, `tela "${tela}" ≠ esperado "${esperado}" (atualizadoEm=${respostaLatest.atualizadoEm})`);
    afirmar(!/10\/09\/2026/.test(tela), 'ainda exibe a data mockada');
    return `"${tela}" (atualizadoEm=${respostaLatest.atualizadoEm})`;
  });

  await caso('UI-14a', 'Atribuição Open-Meteo aparece quando algum valor veio do modelo (dado real)', async () => {
    const usouModelo = respostaLatest.medicoes.some((m) => m.disponivel && m.fonte === 'OPEN_METEO');
    const attr = await textos('.air-attribution');
    if (usouModelo) {
      afirmar(attr.length === 1 && attr[0] === respostaLatest.atribuicoes[0], `atribuição na tela: ${JSON.stringify(attr)}`);
      return `exibida: "${attr[0]}"`;
    }
    afirmar(attr.length === 0, 'atribuição exibida sem uso do modelo');
    return 'modelo não usado agora; atribuição corretamente ausente (caso coberto em UI-14b/c)';
  });

  await caso('UI-15', 'Usuário comum não vê recursos administrativos', async () => {
    const menu = await textos('.dash-nav-item span');
    for (const proibido of ['Usuários', 'Configurações', 'Estações', 'Relatórios']) afirmar(!menu.includes(proibido), `menu admin "${proibido}" visível`);
    const html = await avaliar(`document.body.innerText`);
    afirmar(!/Usuário Admin|Visão completa do sistema|Gerenciar usuários|Configurar estações/.test(html), 'texto/elemento de admin visível');
    const r = await http('/admin/usuarios', { token: userA.token });
    afirmar(r.status === 403, `GET /admin/usuarios com token de usuário comum devolveu ${r.status} (esperado 403)`);
    const r2 = await http('/admin/cidades', { token: userA.token });
    afirmar(r2.status === 403, `GET /admin/cidades devolveu ${r2.status} (esperado 403)`);
    return `menu: ${menu.join(', ')} | API admin → 403`;
  });

  // ===== Estados provocados por fixture =====
  await caso('UI-10/11/12/14b', 'Estados: valor null ≠ 0, "Sem dados disponíveis", "Desatualizado", rótulos e atribuição (fixture)', async () => {
    rota = rotaFixture(latestMisto);
    await loginPelaTela(userA.email, userA.senha); await dashboardAberto(); await aguardarCarga();
    const c = Object.fromEntries((await cardsPoluentes()).map((x) => [x.nome, x]));
    afirmar(c['PM2.5'].valor === '12,34' && c['PM2.5'].unidade === 'µg/m³' && c['PM2.5'].rotulo === 'Medição de estação', `PM2.5: ${JSON.stringify(c['PM2.5'])}`);
    afirmar(/Desatualizado/.test(c['PM10'].tudo) && c['PM10'].rotulo === 'Medição de estação', `PM10 desatualizado não identificado: ${c['PM10'].tudo}`);
    afirmar(!/Desatualizado/.test(c['PM2.5'].tudo), 'PM2.5 atual marcado como desatualizado');
    afirmar(c['O₃'].rotulo === 'Estimativa por modelo' && c['O₃'].valor === '64,5', `O₃: ${JSON.stringify(c['O₃'])}`);
    afirmar(c['NO₂'].rotulo === 'Sem dados disponíveis' && c['NO₂'].valor === null && !/\b0\b/.test(c['NO₂'].tudo), `NO₂ indisponível mal exibido: ${c['NO₂'].tudo}`);
    afirmar(c['CO'].valor === '0,6' && c['CO'].unidade === 'ppm', `CO deve manter a unidade da fonte (ppm): ${JSON.stringify(c['CO'])}`);
    afirmar(c['SO₂'].valor === '0' && c['SO₂'].rotulo === 'Medição de estação', `SO₂ = 0 REAL deve aparecer como 0: ${JSON.stringify(c['SO₂'])}`);
    const attr = await textos('.air-attribution');
    afirmar(attr.length === 1 && attr[0] === ATRIB, `atribuição: ${JSON.stringify(attr)}`);
    await foto('desktop-estados-misto', 1366, 768);
    await foto('mobile-estados-misto', 390, 844, true);
    return 'PM2.5 medição | PM10 desatualizado | O₃ modelo | NO₂ sem dados (sem 0) | CO ppm preservado | SO₂ 0 real | atribuição presente';
  });

  await caso('UI-14c', 'Sem uso da Open-Meteo, a atribuição NÃO aparece (fixture)', async () => {
    rota = rotaFixture(latestSoOpenAQ);
    await loginPelaTela(userA.email, userA.senha); await dashboardAberto(); await aguardarCarga();
    const attr = await textos('.air-attribution');
    afirmar(attr.length === 0, `atribuição indevida: ${JSON.stringify(attr)}`);
    const cards = await cardsPoluentes();
    afirmar(cards.every((c) => c.rotulo === 'Medição de estação'), `rótulos: ${cards.map((c) => c.rotulo)}`);
    return 'sem atribuição; 6 cards como "Medição de estação"';
  });

  await caso('UI-11b', 'Tudo indisponível: 6× "Sem dados disponíveis", nenhum zero, data "—" (fixture)', async () => {
    rota = rotaFixture(latestNada);
    await loginPelaTela(userA.email, userA.senha); await dashboardAberto(); await aguardarCarga();
    const cards = await cardsPoluentes();
    afirmar(cards.every((c) => c.rotulo === 'Sem dados disponíveis' && c.valor === null), `cards: ${JSON.stringify(cards.map((c) => c.tudo))}`);
    afirmar(!cards.some((c) => /\d/.test(c.tudo.replace(/PM2\.5|PM10|O₃|NO₂|SO₂/g, ''))), 'algum número apareceu em card sem dados');
    const data = await texto('.dash-date strong');
    afirmar(data === '—', `data deveria ser "—", é "${data}"`);
    return 'nenhum valor/zero exibido; data "—"';
  });

  await caso('UI-18a', 'Sem estação próxima: mensagem clara e interface intacta (fixture)', async () => {
    rota = (r) => (r.tipo === 'locations' ? { status: 200, corpo: { total: 0, estacoes: [], mensagem: null } } : null);
    await loginPelaTela(userA.email, userA.senha); await dashboardAberto();
    await esperar(`!!document.querySelector('.air-error')`, 15000, 'mensagem de erro');
    const msg = await texto('.air-error');
    afirmar(/Nenhuma estação/.test(msg), `mensagem: ${msg}`);
    const cards = await cardsPoluentes();
    afirmar(cards.length === 6 && cards.every((c) => c.rotulo === 'Sem dados disponíveis'), 'cards não ficaram em "Sem dados disponíveis"');
    return `"${msg}"`;
  });

  await caso('UI-18b', 'API com erro 500 / 429 / 504: mensagem compreensível, sem tela branca (fixture)', async () => {
    const saidas = [];
    for (const [status, erro] of [[500, 'Erro interno do servidor'], [429, 'Limite de requisições da OpenAQ atingido. Tente novamente em instantes.'], [504, 'A OpenAQ não respondeu a tempo']]) {
      rota = (r) => (r.tipo === 'locations' ? { status, corpo: { error: erro } } : null);
      await loginPelaTela(userA.email, userA.senha); await dashboardAberto();
      await esperar(`!!document.querySelector('.air-error')`, 15000, 'mensagem de erro');
      const msg = await texto('.air-error');
      afirmar(msg === erro, `HTTP ${status}: mensagem "${msg}"`);
      afirmar((await avaliar(`document.querySelector('#root').children.length > 0`)), 'tela branca');
      saidas.push(`${status}→"${msg}"`);
    }
    return saidas.join(' | ');
  });

  await caso('UI-18c', 'Falha de conexão (rede/servidor fora): mensagem padrão compreensível, interface continua (fixture)', async () => {
    rota = () => ({ falhar: true });
    await loginPelaTela(userA.email, userA.senha); await dashboardAberto();
    await esperar(`!!document.querySelector('.air-error')`, 15000, 'mensagem de erro');
    const msg = await texto('.air-error');
    afirmar(msg === 'Não foi possível carregar os dados de qualidade do ar.', `mensagem: ${msg}`);
    const nav = await textos('.dash-nav-item span');
    afirmar(nav.includes('Dashboard') && (await texto('.dash-logout')) !== null, 'menu/Sair sumiram');
    await foto('desktop-erro-conexao', 1366, 768);
    return `"${msg}"; menu e botão Sair continuam disponíveis`;
  });

  await caso('UI-18d', 'Resposta lenta: estado "Carregando…" visível enquanto aguarda (fixture)', async () => {
    rota = () => ({ pendurar: true });
    await loginPelaTela(userA.email, userA.senha); await dashboardAberto();
    await dormir(800);
    const data = await texto('.dash-date strong');
    const cards = await cardsPoluentes();
    afirmar(data === 'Carregando…', `data durante carga: ${data}`);
    afirmar(cards.every((c) => /Carregando/.test(c.tudo)) && !cards.some((c) => /Sem dados/.test(c.tudo)), `cards durante carga: ${cards.map((c) => c.tudo)}`);
    return 'data e cards mostram "Carregando…" (sem falso "Sem dados")';
  });

  await caso('UI-18e', 'Token inválido/expirado/usuário desativado (401): volta ao login com aviso, sessão limpa (fixture)', async () => {
    rota = (r) => (r.tipo === 'locations' ? { status: 401, corpo: { error: 'Token inválido' } } : null);
    await loginPelaTela(userA.email, userA.senha); await dashboardAberto();
    await esperar(`!!document.querySelector('input[name="email"]')`, 8000, 'voltar para a tela de login');
    const limpo = await avaliar(`!localStorage.getItem('authToken') && !localStorage.getItem('user')`);
    afirmar(limpo, 'sessão não foi limpa');
    const aviso = await avaliar(`document.body.innerText`);
    afirmar(/sessão|expirou|login novamente/i.test(aviso), 'sem aviso de sessão expirada na tela de login');
    return 'redirecionou ao login, limpou token/usuário e avisou';
  });

  // ===== Sessão =====
  await caso('UI-17a', 'Recarregar a página mantém a sessão válida (Dashboard reabre com os dados)', async () => {
    rota = null;
    await loginPelaTela(userA.email, userA.senha); await dashboardAberto(); await aguardarCarga();
    await enviar('Page.reload', { ignoreCache: true });
    await esperar(`document.readyState === 'complete'`, 15000, 'recarregar');
    await dormir(800);
    const naTelaDeLogin = await avaliar(`!!document.querySelector('input[name="email"]')`);
    afirmar(!naTelaDeLogin, 'após F5 a tela voltou para o LOGIN, embora o token continue válido no localStorage');
    await dashboardAberto(); await aguardarCarga();
    const h1 = await texto('.dash-main h1');
    afirmar(h1 === `Olá, ${userA.nome}!`, `saudação após F5: ${h1}`);
    return `após F5: "${h1}" com poluentes carregados`;
  });

  await caso('UI-17b', 'Recarregar SEM sessão (ou após logout) leva ao login', async () => {
    await avaliar(`localStorage.clear()`);
    await enviar('Page.reload', { ignoreCache: true });
    await esperar(`!!document.querySelector('input[name="email"]')`, 15000, 'tela de login');
    return 'sem token → login';
  });

  await caso('UI-17c', 'Recarregar com token adulterado leva ao login (não fica preso em erro)', async () => {
    await avaliar(`localStorage.setItem('authToken','token.invalido.x'); localStorage.setItem('user', JSON.stringify({nome:'X',perfil:'USUARIO',cidade:'São Paulo'}))`);
    await enviar('Page.reload', { ignoreCache: true });
    await esperar(`!!document.querySelector('input[name="email"]')`, 15000, 'tela de login após token inválido');
    return 'token inválido → 401 → login';
  });

  await caso('UI-16', 'Logout limpa a sessão e a troca de usuário não vaza dados do anterior', async () => {
    rota = null;
    await loginPelaTela(userA.email, userA.senha); await dashboardAberto(); await aguardarCarga();
    const estacaoA = await texto('.station-info strong');
    await avaliar(`document.querySelector('.dash-logout').click()`);
    await esperar(`!!document.querySelector('input[name="email"]')`, 8000, 'voltar ao login após Sair');
    const limpo = await avaliar(`!localStorage.getItem('authToken') && !localStorage.getItem('user')`);
    afirmar(limpo, 'token/usuário continuam no localStorage após Sair');
    await loginPelaTela(userB.email, userB.senha); await dashboardAberto(); await aguardarCarga();
    const h1 = await texto('.dash-main h1');
    const cidade = await avaliar(`document.querySelector('.dash-select select').value`);
    const estacaoB = await texto('.station-info strong');
    afirmar(h1 === `Olá, ${userB.nome}!` && cidade === 'Mauá', `após trocar para B: "${h1}" / cidade ${cidade}`);
    afirmar(estacaoB !== estacaoA, `estação de B igual à de A (${estacaoB}) — possível vazamento de estado`);
    const idUsado = requisicoes.filter((x) => /\/latest/.test(x.url)).pop();
    return `A: "${estacaoA}" → B: "${estacaoB}" (${cidade}); requisição de B: ${new URL(idUsado.url).pathname}`;
  });

  // ===== Visual =====
  const viewports = [['desktop-1366', 1366, 768, false], ['laptop-1024', 1024, 768, false], ['tablet-768', 768, 1024, true], ['mobile-390', 390, 844, true], ['mobile-360', 360, 740, true]];
  rota = null;
  await loginPelaTela(userB.email, userB.senha); await dashboardAberto(); await aguardarCarga();
  for (const [nome, w, h, mobile] of viewports) {
    await caso(`VIS-${nome}`, `Layout sem rolagem horizontal nem cartões estourados em ${w}×${h}`, async () => {
      await enviar('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
      await dormir(500);
      const m = await avaliar(`({
        rolagemH: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        corpoH: document.body.scrollWidth - document.body.clientWidth,
        estourados: [...document.querySelectorAll('.pollutant, .dash-card, .station-info, .dash-date, .dash-select')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className.split(' ')[0]),
        foraDaTela: [...document.querySelectorAll('.pollutant')].filter(e => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1; }).length,
        viewportMeta: !!document.querySelector('meta[name="viewport"]'),
      })`);
      await foto(`real-${nome}`, w, h, mobile);
      afirmar(m.rolagemH <= 1 && m.corpoH <= 1, `rolagem horizontal de ${Math.max(m.rolagemH, m.corpoH)}px`);
      afirmar(m.estourados.length === 0, `elementos com conteúdo estourando: ${m.estourados.join(', ')}`);
      afirmar(m.foraDaTela === 0, `${m.foraDaTela} card(s) de poluente fora da tela`);
      return `sem rolagem horizontal; cards dentro da tela; meta viewport=${m.viewportMeta}`;
    });
  }
} catch (e) {
  console.log('ERRO FATAL DO ROTEIRO:', e.message);
  resultados.push({ id: 'FATAL', descricao: 'execução do roteiro', ok: false, detalhe: e.message });
} finally {
  try { ws?.close(); } catch { /* */ }
  try { chrome?.proc.kill(); } catch { /* */ }
  await dormir(500);
  if (chrome?.dir) { try { rmSync(chrome.dir, { recursive: true, force: true }); } catch { /* arquivos em uso */ } }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const r = await pool.query('DELETE FROM usuarios WHERE email = ANY($1::text[])', [emails]);
    console.log(`\nUsuários temporários removidos: ${r.rowCount}/${emails.length}`);
  } catch (e) { console.log('FALHA ao remover usuários temporários:', e.message); } finally { await pool.end(); }
  const reprovados = resultados.filter((r) => !r.ok);
  console.log(`\nResumo: ${resultados.length - reprovados.length} aprovado(s), ${reprovados.length} reprovado(s). Capturas em ${SHOTS}`);
  if (errosDePagina.length) console.log(`Exceções JS não tratadas na página (${errosDePagina.length}):`, [...new Set(errosDePagina)].slice(0, 3));
  writeFileSync(join(SHOTS, 'resultado.json'), JSON.stringify(resultados, null, 2));
  process.exit(reprovados.length ? 1 : 0);
}
