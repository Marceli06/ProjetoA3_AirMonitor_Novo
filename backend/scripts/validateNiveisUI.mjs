// Validação de navegador dos NÍVEIS do Dashboard (selo de nível em "Principais poluentes" e "Situação do ar agora").
// Chrome/Edge headless via DevTools Protocol (sem dependências novas). Roda no Node 22.
// Respostas "fixture" (Fetch.fulfillRequest) de /api/air-quality e /api/alertas dão valores determinísticos em cada
// faixa (baixo, moderado, alto, crítico), origens (OpenAQ, Open-Meteo, mistura), ausência de dado e quantidades de alertas.
// O nível esperado é calculado AQUI, a partir da tabela de limiares do BACKEND lida do arquivo do backend (não do frontend).
// Usuários temporários são criados pelo cadastro público e SEMPRE removidos no final. Não imprime senhas nem tokens.
// Uso (dentro de backend/): APP_URL=http://127.0.0.1:5196 API_URL=http://127.0.0.1:3996/api node scripts/validateNiveisUI.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
  while (Date.now() < limite) {
    try { if (await avaliar(expressao)) return true; } catch { /* página trocando */ }
    await dormir(150);
  }
  throw new Error(`Tempo esgotado esperando: ${descricao}`);
}

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
  if (!alvo) throw new Error('O navegador não abriu a porta de depuração');
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('falha no WebSocket do navegador')); });
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
  });
  return { proc, dir, versao: versao.Browser };
}

// ---------------------------------------------------------------- Interceptação (fixtures)
// rota({url, tipo}) → null (segue a API real) | {status, corpo} | {pendurar:true}; tipo: locations | latest | modelo | alertas
let rota = null;
const CORS = [
  { name: 'Access-Control-Allow-Origin', value: '*' },
  { name: 'Access-Control-Allow-Headers', value: 'authorization,content-type' },
  { name: 'Access-Control-Allow-Methods', value: 'GET,POST,OPTIONS' },
  { name: 'Content-Type', value: 'application/json' },
];
async function ligarInterceptacao() {
  await enviar('Fetch.enable', { patterns: [{ urlPattern: '*/api/air-quality/*', requestStage: 'Request' }, { urlPattern: '*/api/alertas*', requestStage: 'Request' }] });
  ouvintes.push(async (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    try {
      if (!rota) return await enviar('Fetch.continueRequest', { requestId });
      if (request.method === 'OPTIONS') return await enviar('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: CORS, body: '' });
      const tipo = /\/api\/alertas/.test(request.url) ? 'alertas' : /\/modelo/.test(request.url) ? 'modelo' : /\/latest/.test(request.url) ? 'latest' : 'locations';
      const r = rota({ url: request.url, tipo });
      if (!r) return await enviar('Fetch.continueRequest', { requestId });
      if (r.pendurar) return; // nunca responde: valida os estados "Carregando…"
      await enviar('Fetch.fulfillRequest', { requestId, responseCode: r.status, responseHeaders: CORS, body: Buffer.from(JSON.stringify(r.corpo), 'utf8').toString('base64') });
    } catch { /* a página trocou durante a interceptação */ }
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
  await avaliar(`document.querySelector('form').requestSubmit()`);
}
const dashboardAberto = () => esperar(`!!document.querySelector('.dash-main h1')`, 20000, 'Dashboard aberto');
const pronto = () => esperar(`document.querySelectorAll('.pollutant').length === 6
  && !/Carregando/.test(document.querySelector('.dash-pollutants').innerText)
  && !/Carregando/.test(document.querySelector('[data-testid="dash-situacao"]').innerText)`, 30000, 'Dashboard pronto (poluentes, situação e alertas)');

// Troca as respostas simuladas e recarrega o Dashboard (a sessão do localStorage é mantida)
async function abrir(novaRota, { aguardar = true } = {}) {
  rota = novaRota;
  await enviar('Page.reload', { ignoreCache: true });
  await esperar(`document.readyState === 'complete'`, 15000, 'recarregar');
  await dashboardAberto();
  if (aguardar) await pronto();
}

const estado = () => avaliar(`({
  titulo: document.querySelector('[data-testid="situacao-titulo"]')?.innerText.trim() ?? null,
  tom: [...(document.querySelector('.dash-quality .quality-value')?.classList ?? [])].find((c) => c.startsWith('tom-')) ?? null,
  tomMsg: [...(document.querySelector('.dash-quality .quality-msg')?.classList ?? [])].find((c) => c.startsWith('tom-')) ?? null,
  alertas: document.querySelector('[data-testid="situacao-alertas"]')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
  mensagem: document.querySelector('[data-testid="situacao-mensagem"]')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
  erroAlertas: document.querySelector('[data-testid="situacao-erro-alertas"]')?.innerText.trim() ?? null,
  nota: document.querySelector('.dash-quality .quality-note')?.innerText.trim() ?? null,
  sino: document.querySelector('[data-testid="sino-contagem"]')?.innerText.trim() ?? null,
  cartao: document.querySelector('[data-testid="dash-situacao"]').innerText.replace(/\\s+/g, ' ').trim(),
  poluentes: document.querySelector('.dash-pollutants').innerText.replace(/\\s+/g, ' ').trim(),
  avisoOpenAQ: !!document.querySelector('[data-testid="aviso-openaq"]'),
  atribuicoes: [...document.querySelectorAll('.air-attribution')].map((e) => e.innerText.trim()),
  erroAr: document.querySelector('.dash-pollutants .air-error')?.innerText.trim() ?? null,
  cards: [...document.querySelectorAll('.pollutant')].map((c) => {
    const selo = c.querySelector('[data-testid="nivel-poluente"]');
    const valor = c.querySelector('.pollutant-value');
    const origem = c.querySelector('.tag-ok, .tag-model, .tag-none');
    return {
      nome: c.querySelector('.pollutant-name strong').innerText.trim(),
      desc: c.querySelector('.pollutant-name small').innerText.trim(),
      valor: c.querySelector('.pollutant-value b')?.innerText.trim() ?? null,
      unidade: c.querySelector('.pollutant-value b') ? c.querySelector('.pollutant-value span').innerText.trim() : null,
      selo: selo?.innerText.trim() ?? null,
      nivel: selo?.dataset.nivel ?? null,
      tomSelo: [...(selo?.classList ?? [])].find((x) => x.startsWith('tom-')) ?? null,
      origem: (origem?.innerText || '').replace('●', '').trim(),
      ordemOk: selo ? !!(valor.compareDocumentPosition(selo) & 4) && !!(selo.compareDocumentPosition(origem) & 4) : null,
    };
  }),
})`);

async function foto(nome, largura, altura, mobile = false) {
  await enviar('Emulation.setDeviceMetricsOverride', { width: largura, height: altura, deviceScaleFactor: 1, mobile });
  await dormir(400);
  const m = await enviar('Page.getLayoutMetrics');
  const alturaTotal = Math.ceil(m.cssContentSize?.height || m.contentSize.height);
  const r = await enviar('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: largura, height: Math.min(alturaTotal, 3000), scale: 1 } });
  writeFileSync(join(SHOTS, nome + '.png'), Buffer.from(r.data, 'base64'));
}

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
  const email = `tmp.ui.${rotulo}.${Date.now()}@example.com`.toLowerCase();
  const senha = `Tmp-${Math.random().toString(36).slice(2)}-7`;
  emails.push(email);
  const r = await http('/auth/register', { corpo: { nome: `Teste UI ${rotulo}`, email, password: senha, confirmPassword: senha, cidade, regiao: 'Centro' } });
  if (r.status !== 201) throw new Error(`cadastro do usuário de teste falhou: HTTP ${r.status}`);
  return { email, senha, token: r.json.token, nome: `Teste UI ${rotulo}`, cidade };
}

// ---------------------------------------------------------------- Tabela de limiares do BACKEND (oráculo) e do frontend
const NIVEIS = ['BAIXO', 'MODERADO', 'ALTO', 'CRITICO'];
const ROTULO = { BAIXO: 'Baixo', MODERADO: 'Moderado', ALTO: 'Alto', CRITICO: 'Crítico' };
const CHAVES = ['pm25', 'pm10', 'o3', 'no2', 'co', 'so2'];
const NOME = { pm25: 'PM2.5', pm10: 'PM10', o3: 'O₃', no2: 'NO₂', co: 'CO', so2: 'SO₂' };
const NOTA = 'Níveis calculados com limiares técnicos provisórios. O IQA oficial ainda não é calculado.';

function lerTabela(url) {
  const texto = readFileSync(url, 'utf8');
  const tabela = {};
  for (const m of texto.matchAll(/^\s*(\w+):\s*\{\s*BAIXO:\s*([\d_.]+),\s*MODERADO:\s*([\d_.]+),\s*ALTO:\s*([\d_.]+),\s*CRITICO:\s*([\d_.]+)\s*\}/gm)) {
    tabela[m[1]] = { BAIXO: Number(m[2].replace(/_/g, '')), MODERADO: Number(m[3].replace(/_/g, '')), ALTO: Number(m[4].replace(/_/g, '')), CRITICO: Number(m[5].replace(/_/g, '')) };
  }
  return tabela;
}
const TAB_BACK = lerTabela(new URL('../src/data/limiaresAlertas.ts', import.meta.url));
const TAB_FRONT = lerTabela(new URL('../../frontend/src/utils/niveisPoluentes.ts', import.meta.url));

// Regra do backend (nivelDoValor): maior nível cujo limiar o valor atingiu; abaixo de BAIXO a tela mostra BAIXO
const nivelEsperado = (chave, valor) => { let n = 'BAIXO'; for (const c of NIVEIS) if (valor >= TAB_BACK[chave][c]) n = c; return n; };
const maior = (niveis) => niveis.reduce((a, b) => (NIVEIS.indexOf(b) > NIVEIS.indexOf(a) ? b : a));
const tituloDe = (nivel) => `Nível ${ROTULO[nivel].toLowerCase()}`;
const FORMATAR_VALOR = (v) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

// ---------------------------------------------------------------- Fixtures
const base = (chave, extra = {}) => ({ chave, poluente: chave, disponivel: false, valor: null, unidade: null, dataHora: null, fonte: null, tipoDado: null, desatualizada: null, ...extra });
const ESTACAO = { id: 999001, nome: 'Estação Fixture', localidade: 'Cidade Fixture', latitude: -23.5, longitude: -46.6, distanciaMetros: 4200, pais: 'BR', ultimaMedicaoEm: null };
const agoraISO = new Date(Date.now() - 20 * 60000).toISOString();
const velhoISO = new Date(Date.now() - 9 * 3600000).toISOString();
const ATRIB = 'Dados de modelo (CAMS / Copernicus) fornecidos por Open-Meteo.com, licença CC BY 4.0';
const listaFixture = { total: 1, estacoes: [ESTACAO], mensagem: null };

const med = (chave, valor, o = {}) => {
  const fonte = o.fonte ?? 'OPENAQ';
  return base(chave, { disponivel: true, valor, unidade: o.unidade ?? 'µg/m³', dataHora: o.desatualizada ? velhoISO : agoraISO, fonte, tipoDado: fonte === 'OPENAQ' ? 'MEDICAO' : 'MODELO', desatualizada: o.desatualizada ?? false });
};
const semDado = (chave) => base(chave, { motivo: 'sem_sensor' });
const medicoesDe = (porChave) => CHAVES.map((k) => porChave[k] ?? semDado(k));
const latestDe = (porChave) => {
  const medicoes = medicoesDe(porChave);
  const usaModelo = medicoes.some((m) => m.fonte === 'OPEN_METEO');
  return {
    estacao: ESTACAO, atualizadoEm: agoraISO, fontesUtilizadas: usaModelo ? ['OPENAQ', 'OPEN_METEO'] : ['OPENAQ'],
    statusFontes: { OPENAQ: 'ok', OPEN_METEO: usaModelo ? 'ok' : 'nao_necessaria', erroOpenAQ: null }, atribuicoes: usaModelo ? [ATRIB] : [], medicoes,
  };
};
const modeloDe = (porChave) => ({
  estacao: null, cidade: 'São Paulo', atualizadoEm: agoraISO, fontesUtilizadas: ['OPEN_METEO'],
  statusFontes: { OPENAQ: 'falha', OPEN_METEO: 'ok', erroOpenAQ: 'indisponível' }, atribuicoes: [ATRIB], medicoes: medicoesDe(porChave),
});
const alertaFalso = (i, nivel) => ({
  id: 9000 + i, cidade: 'São Paulo', regiao: null, estacaoId: '999001', estacaoNome: 'Estação Fixture', poluente: 'pm25', poluenteNome: 'PM2.5',
  valor: 16, unidade: 'µg/m³', nivel, titulo: `Alerta de teste ${i + 1}`, descricao: 'Alerta simulado para o teste de interface.', status: 'ATIVO',
  origemDado: 'OPENAQ', tipoDado: 'MEDICAO', medicaoEm: agoraISO, criadoEm: agoraISO, atualizadoEm: agoraISO, resolvidoEm: null,
});
const listaDeAlertas = (qtd, nivel = 'BAIXO') => ({ status: 200, corpo: { total: qtd, pagina: 1, limite: 200, alertas: Array.from({ length: qtd }, (_, i) => alertaFalso(i, nivel)), limiaresProvisorios: true } });

// Monta a rota de teste: qualidade do ar (latest/modelo/locations) e alertas (padrão: nenhum alerta)
const montarRota = ({ latest, modelo, locations, alertas = listaDeAlertas(0) }) => (r) => {
  if (r.tipo === 'alertas') return alertas;
  if (r.tipo === 'locations') return locations ?? { status: 200, corpo: listaFixture };
  if (r.tipo === 'latest') return latest ? { status: 200, corpo: latest } : { status: 500, corpo: { error: 'sem fixture' } };
  if (r.tipo === 'modelo') return modelo ? { status: 200, corpo: modelo } : { status: 503, corpo: { error: 'Open-Meteo indisponível' } };
  return null;
};
const BAIXOS = latestDe({ pm25: med('pm25', 9.6) });

// ---------------------------------------------------------------- Execução
let chrome;
try {
  chrome = await abrirChrome();
  await ligarInterceptacao();
  console.log(`Navegador: ${chrome.versao} (headless) | App: ${APP} | API: ${API}\n`);

  const usuario = await criarUsuario('N', 'São Paulo');
  rota = null;

  await caso('N01', 'Tabela de limiares do frontend é idêntica à do backend (mesma classificação de Alertas)', async () => {
    afirmar(Object.keys(TAB_BACK).length === 6 && Object.keys(TAB_FRONT).length === 6, `tabelas lidas: backend=${Object.keys(TAB_BACK)} frontend=${Object.keys(TAB_FRONT)}`);
    afirmar(JSON.stringify(TAB_BACK) === JSON.stringify(TAB_FRONT), `tabelas diferentes:\n backend=${JSON.stringify(TAB_BACK)}\n frontend=${JSON.stringify(TAB_FRONT)}`);
    return CHAVES.map((k) => `${k}: ${NIVEIS.map((n) => TAB_BACK[k][n]).join('/')}`).join(' | ');
  });

  await caso('N00', 'Login pela tela e Dashboard abre', async () => {
    await loginPelaTela(usuario.email, usuario.senha);
    await dashboardAberto();
    await pronto();
    return 'ok';
  });

  // ===== Dado REAL (sem fixture): selo e situação coerentes com a API =====
  await caso('N02', 'Dado real (OpenAQ/Open-Meteo): selo de cada poluente e situação geral batem com a API e com a classificação do backend', async () => {
    rota = null;
    await enviar('Page.reload', { ignoreCache: true });
    await esperar(`document.readyState === 'complete'`, 15000, 'recarregar');
    await dashboardAberto(); await pronto();
    const e = await estado();
    const lista = (await http(`/air-quality/locations?cidade=${encodeURIComponent('São Paulo')}&limite=1`, { token: usuario.token })).json;
    let medicoes;
    if (lista?.estacoes?.length) medicoes = (await http(`/air-quality/locations/${lista.estacoes[0].id}/latest`, { token: usuario.token })).json?.medicoes;
    if (!medicoes) medicoes = (await http(`/air-quality/modelo?cidade=${encodeURIComponent('São Paulo')}`, { token: usuario.token })).json?.medicoes;
    afirmar(Array.isArray(medicoes), 'não foi possível obter as medições reais da API (OpenAQ e Open-Meteo)');
    const niveis = []; const linhas = [];
    CHAVES.forEach((k, i) => {
      const m = medicoes.find((x) => x.chave === k); const c = e.cards[i];
      const temValor = m && m.disponivel && m.valor !== null;
      if (!temValor) { afirmar(c.selo === null, `${k}: sem dado mas exibe selo "${c.selo}"`); linhas.push(`${c.nome}=sem dados`); return; }
      const avaliavel = !m.desatualizada && /^[µμ]g\/m[³3]$/i.test(m.unidade.trim());
      if (avaliavel) {
        const n = nivelEsperado(k, m.valor); niveis.push(n);
        afirmar(c.nivel === n && c.selo === ROTULO[n], `${k}: valor ${m.valor} ${m.unidade} → esperado ${ROTULO[n]}, tela "${c.selo}"`);
        linhas.push(`${c.nome}=${FORMATAR_VALOR(m.valor)} ${ROTULO[n]}`);
      } else {
        afirmar(c.nivel === 'NENHUM' && c.selo === 'Sem nível', `${k}: sem classificação esperada ("Sem nível"), tela "${c.selo}" (unidade ${m.unidade}, desatualizada=${m.desatualizada})`);
        linhas.push(`${c.nome}=${m.unidade} sem nível`);
      }
    });
    const esperado = niveis.length ? tituloDe(maior(niveis)) : 'Dados insuficientes';
    afirmar(e.titulo === esperado, `situação "${e.titulo}" ≠ esperado "${esperado}"`);
    const real = await http(`/alertas?cidade=${encodeURIComponent('São Paulo')}&status=ATIVO&limite=200`, { token: usuario.token });
    afirmar(real.status === 200, `GET /alertas → ${real.status}`);
    const total = real.json.total;
    if (total > 0) afirmar(new RegExp(`^${total} alertas? ativos?$`).test(e.alertas ?? ''), `contagem de alertas na tela "${e.alertas}" ≠ ${total}`);
    else afirmar(e.alertas === null, `sem alertas na API mas a tela mostra "${e.alertas}"`);
    return `${e.titulo} | ${total} alerta(s) ativo(s) | ${linhas.join(', ')}`;
  });

  // ===== Faixas: limiar exato e logo abaixo, em TODOS os poluentes e níveis =====
  for (const nivel of NIVEIS) {
    await caso(`N03-${nivel}`, `Todos os poluentes exatamente no limiar de ${ROTULO[nivel].toUpperCase()}: selo "${ROTULO[nivel]}" em cada card e "${tituloDe(nivel)}"`, async () => {
      const porChave = Object.fromEntries(CHAVES.map((k) => [k, med(k, TAB_BACK[k][nivel])]));
      await abrir(montarRota({ latest: latestDe(porChave) }));
      const e = await estado();
      e.cards.forEach((c, i) => afirmar(c.nivel === nivel && c.selo === ROTULO[nivel] && c.tomSelo === `tom-${nivel.toLowerCase()}`, `${c.nome} (${TAB_BACK[CHAVES[i]][nivel]}): selo "${c.selo}" tom ${c.tomSelo}, esperado ${ROTULO[nivel]}`));
      afirmar(e.titulo === tituloDe(nivel) && e.tom === `tom-${nivel.toLowerCase()}`, `situação "${e.titulo}" (${e.tom}), esperado ${tituloDe(nivel)}`);
      afirmar(e.cards.every((c) => c.ordemOk), 'o selo deve ficar depois do valor e antes da origem do dado');
      return `${e.cards.map((c) => `${c.nome}=${c.valor}→${c.selo}`).join(' | ')}`;
    });
    await caso(`N04-${nivel}`, `Todos os poluentes 0,01 abaixo do limiar de ${ROTULO[nivel].toUpperCase()}: cai para o nível anterior (valor < limiar não atinge o nível)`, async () => {
      const porChave = Object.fromEntries(CHAVES.map((k) => [k, med(k, Number((TAB_BACK[k][nivel] - 0.01).toFixed(2)))]));
      await abrir(montarRota({ latest: latestDe(porChave) }));
      const e = await estado();
      const esperados = CHAVES.map((k) => nivelEsperado(k, Number((TAB_BACK[k][nivel] - 0.01).toFixed(2))));
      e.cards.forEach((c, i) => afirmar(c.nivel === esperados[i], `${c.nome}: selo "${c.selo}", esperado ${ROTULO[esperados[i]]}`));
      afirmar(e.titulo === tituloDe(maior(esperados)), `situação "${e.titulo}", esperado ${tituloDe(maior(esperados))}`);
      return `${e.titulo} (selos: ${[...new Set(e.cards.map((c) => c.selo))].join(', ')})`;
    });
  }

  await caso('N05', 'Valor zero e abaixo do primeiro limiar: "Baixo" e "Nível baixo" (exemplo PM2.5 9,6 µg/m³)', async () => {
    await abrir(montarRota({ latest: latestDe({ pm25: med('pm25', 9.6), pm10: med('pm10', 0), o3: med('o3', 0), so2: med('so2', 0) }) }));
    const e = await estado();
    const pm25 = e.cards[0];
    afirmar(pm25.valor === '9,6' && pm25.unidade === 'µg/m³' && pm25.selo === 'Baixo' && pm25.origem === 'Medição de estação', `PM2.5: ${JSON.stringify(pm25)}`);
    afirmar(pm25.nome === 'PM2.5' && pm25.desc === 'Material particulado fino', `nome/descrição: ${pm25.nome} / ${pm25.desc}`);
    afirmar(e.cards[1].valor === '0' && e.cards[1].selo === 'Baixo', `PM10 = 0 real deve ter selo Baixo: ${JSON.stringify(e.cards[1])}`);
    afirmar(e.titulo === 'Nível baixo', `situação "${e.titulo}"`);
    return 'PM2.5 9,6 µg/m³ → Baixo | Medição de estação';
  });

  // ===== Combinações =====
  await caso('N06', 'Níveis diferentes por poluente: cada card tem o seu selo; a situação é o MAIOR nível; CO em ppm e poluente sem dado ficam fora', async () => {
    await abrir(montarRota({ latest: latestDe({ pm25: med('pm25', 9.6), pm10: med('pm10', 120), o3: med('o3', 170), co: med('co', 0.6, { unidade: 'ppm' }), so2: med('so2', 600) }) }));
    let e = await estado();
    const sel = Object.fromEntries(e.cards.map((c) => [c.nome, c.selo]));
    afirmar(sel['PM2.5'] === 'Baixo' && sel['PM10'] === 'Moderado' && sel['O₃'] === 'Alto' && sel['SO₂'] === 'Crítico', `selos: ${JSON.stringify(sel)}`);
    afirmar(sel['NO₂'] === null && e.cards[3].origem === 'Sem dados disponíveis' && e.cards[3].valor === null, `NO₂ sem dado não pode ter selo nem valor: ${JSON.stringify(e.cards[3])}`);
    afirmar(sel['CO'] === 'Sem nível' && e.cards[4].nivel === 'NENHUM' && e.cards[4].unidade === 'ppm', `CO em ppm: ${JSON.stringify(e.cards[4])}`);
    afirmar(e.titulo === 'Nível crítico' && e.tom === 'tom-critico', `situação "${e.titulo}" ${e.tom}`);
    // sem o crítico, o maior passa a ser o alto; CO em ppm nunca eleva a situação, mesmo com valor enorme
    await abrir(montarRota({ latest: latestDe({ pm25: med('pm25', 9.6), o3: med('o3', 170), co: med('co', 99999, { unidade: 'ppm' }) }) }));
    e = await estado();
    afirmar(e.titulo === 'Nível alto' && e.tom === 'tom-alto', `sem SO₂: situação "${e.titulo}"`);
    await abrir(montarRota({ latest: latestDe({ pm25: med('pm25', 9.6), co: med('co', 99999, { unidade: 'ppm' }) }) }));
    e = await estado();
    afirmar(e.titulo === 'Nível baixo', `CO 99999 ppm não pode elevar a situação: "${e.titulo}"`);
    return 'Baixo/Moderado/Alto/(sem dado)/Sem nível (ppm)/Crítico → Nível crítico; sem crítico → alto; CO ppm ignorado';
  });

  await caso('N07', 'Mistura de origens (OpenAQ + Open-Meteo): selo independe da origem; rótulos de origem e atribuição preservados', async () => {
    await abrir(montarRota({ latest: latestDe({ pm25: med('pm25', 80), o3: med('o3', 210, { fonte: 'OPEN_METEO' }), so2: med('so2', 3, { fonte: 'OPEN_METEO' }) }) }));
    const e = await estado();
    afirmar(e.cards[0].selo === 'Alto' && e.cards[0].origem === 'Medição de estação', `PM2.5: ${JSON.stringify(e.cards[0])}`);
    afirmar(e.cards[2].selo === 'Crítico' && e.cards[2].origem === 'Estimativa por modelo', `O₃: ${JSON.stringify(e.cards[2])}`);
    afirmar(e.cards[5].selo === 'Baixo' && e.cards[5].origem === 'Estimativa por modelo', `SO₂: ${JSON.stringify(e.cards[5])}`);
    afirmar(e.titulo === 'Nível crítico', `situação "${e.titulo}" (o crítico veio do modelo)`);
    afirmar(e.atribuicoes.length === 1 && e.atribuicoes[0] === ATRIB, `atribuição: ${JSON.stringify(e.atribuicoes)}`);
    return 'PM2.5 Alto (estação) | O₃ Crítico (modelo) | SO₂ Baixo (modelo) → Nível crítico';
  });

  await caso('N08', 'Somente OpenAQ (todas medições de estação): selos em todos os cards, nenhuma estimativa, sem atribuição', async () => {
    await abrir(montarRota({ latest: latestDe({ pm25: med('pm25', 20), pm10: med('pm10', 110), o3: med('o3', 165), no2: med('no2', 330), co: med('co', 6000), so2: med('so2', 130) }) }));
    const e = await estado();
    afirmar(JSON.stringify(e.cards.map((c) => c.selo)) === JSON.stringify(['Baixo', 'Moderado', 'Alto', 'Crítico', 'Baixo', 'Moderado']), `selos: ${e.cards.map((c) => c.selo)}`);
    afirmar(e.cards.every((c) => c.origem === 'Medição de estação'), `origens: ${e.cards.map((c) => c.origem)}`);
    afirmar(e.atribuicoes.length === 0 && !e.avisoOpenAQ, 'atribuição/aviso indevidos sem uso da Open-Meteo');
    afirmar(e.titulo === 'Nível crítico', `situação "${e.titulo}"`);
    return 'Baixo, Moderado, Alto, Crítico, Baixo, Moderado → Nível crítico';
  });

  await caso('N09', 'Somente Open-Meteo (OpenAQ fora do ar, sem estação): selos nos 6 cards, "Estimativa por modelo", aviso e atribuição', async () => {
    const modelo = modeloDe(Object.fromEntries(CHAVES.map((k) => [k, med(k, TAB_BACK[k].MODERADO, { fonte: 'OPEN_METEO' })])));
    await abrir(montarRota({ locations: { status: 503, corpo: { error: 'OpenAQ indisponível' } }, modelo }));
    const e = await estado();
    afirmar(e.cards.every((c) => c.selo === 'Moderado' && c.origem === 'Estimativa por modelo'), `cards: ${JSON.stringify(e.cards.map((c) => [c.nome, c.selo, c.origem]))}`);
    afirmar(e.titulo === 'Nível moderado' && e.tom === 'tom-moderado', `situação "${e.titulo}" ${e.tom}`);
    afirmar(e.avisoOpenAQ, 'aviso de OpenAQ indisponível ausente');
    afirmar(e.atribuicoes[0] === ATRIB, `atribuição: ${JSON.stringify(e.atribuicoes)}`);
    afirmar(!/Medição de estação/.test(e.poluentes), 'nenhum valor do modelo pode aparecer como medição');
    return 'Moderado ×6 (modelo) → Nível moderado';
  });

  await caso('N10', 'Poluente sem dado: "Sem dados disponíveis", sem valor e sem selo; a situação usa só os poluentes avaliáveis', async () => {
    await abrir(montarRota({ latest: latestDe({ so2: med('so2', 60) }) }));
    const e = await estado();
    const outros = e.cards.filter((c) => c.nome !== 'SO₂');
    afirmar(outros.length === 5 && outros.every((c) => c.origem === 'Sem dados disponíveis' && c.valor === null && c.selo === null), `cards sem dado: ${JSON.stringify(outros.map((c) => [c.nome, c.valor, c.selo, c.origem]))}`);
    afirmar(e.cards[5].selo === 'Baixo' && e.titulo === 'Nível baixo', `SO₂ 60 → ${e.cards[5].selo}; situação "${e.titulo}"`);
    return '5 sem dado (sem selo) + SO₂ 60 µg/m³ → Baixo';
  });

  // ===== Dados insuficientes =====
  await caso('N11', 'Sem nenhum poluente avaliável: "Dados insuficientes" (neutro), sem selos e sem inventar nível', async () => {
    await abrir(montarRota({ latest: latestDe({}) }));
    let e = await estado();
    afirmar(e.titulo === 'Dados insuficientes' && e.tom === 'tom-neutro', `sem dados: "${e.titulo}" ${e.tom}`);
    afirmar(e.cards.every((c) => c.selo === null) && !/Nível (baixo|moderado|alto|crítico)/.test(e.cartao), `texto do cartão: ${e.cartao}`);
    await abrir(montarRota({ latest: latestDe({ co: med('co', 0.6, { unidade: 'ppm' }) }) }));
    e = await estado();
    afirmar(e.titulo === 'Dados insuficientes' && e.cards[4].selo === 'Sem nível', `só CO em ppm: "${e.titulo}" / CO "${e.cards[4].selo}"`);
    await abrir(montarRota({ latest: latestDe({ pm25: med('pm25', 200, { desatualizada: true }) }) }));
    e = await estado();
    afirmar(e.titulo === 'Dados insuficientes' && e.cards[0].selo === 'Sem nível' && /Desatualizado/.test(e.poluentes), `só dado desatualizado: "${e.titulo}" / PM2.5 "${e.cards[0].selo}"`);
    await abrir(montarRota({ locations: { status: 500, corpo: { error: 'Erro interno do servidor' } } }));
    e = await estado();
    afirmar(e.titulo === 'Dados insuficientes' && !!e.erroAr, `OpenAQ e Open-Meteo fora: "${e.titulo}" / erro "${e.erroAr}"`);
    return 'sem dados | só CO ppm | só dado desatualizado | OpenAQ+Open-Meteo fora → Dados insuficientes';
  });

  await caso('N12', 'Carregando: sem selo, sem "Dados insuficientes" e sem nível antigo enquanto a resposta não chega', async () => {
    await abrir(montarRota({ locations: { pendurar: true } }), { aguardar: false });
    await dormir(800);
    const e = await estado();
    afirmar(e.titulo === null && /Carregando/.test(e.cartao) && !/Dados insuficientes|Nível (baixo|moderado|alto|crítico)/.test(e.cartao), `cartão: ${e.cartao}`);
    afirmar(e.cards.every((c) => c.selo === null), 'selo exibido durante o carregamento');
    return `cartão: "${e.cartao.slice(0, 80)}"`;
  });

  // ===== Alertas ativos x situação geral =====
  await caso('N13', 'Nenhum alerta ativo: sem contagem; mensagem neutra; sino sem número; situação continua pelos poluentes', async () => {
    await abrir(montarRota({ latest: BAIXOS, alertas: listaDeAlertas(0) }));
    const e = await estado();
    afirmar(e.titulo === 'Nível baixo', `situação "${e.titulo}"`);
    afirmar(e.alertas === null && e.sino === null, `contagem="${e.alertas}" sino="${e.sino}"`);
    afirmar(/^Nenhum alerta ativo em São Paulo\./.test(e.mensagem ?? ''), `mensagem: ${e.mensagem}`);
    return e.mensagem;
  });

  await caso('N14', 'Múltiplos alertas (5) com "Nível baixo": "5 alertas ativos" + "Consulte os detalhes na tela de Alertas." (sem contradição)', async () => {
    await abrir(montarRota({ latest: BAIXOS, alertas: listaDeAlertas(5, 'BAIXO') }));
    const e = await estado();
    afirmar(e.titulo === 'Nível baixo', `situação "${e.titulo}"`);
    afirmar(e.alertas === '5 alertas ativos', `contagem "${e.alertas}"`);
    afirmar(e.mensagem === 'Consulte os detalhes na tela de Alertas.', `mensagem "${e.mensagem}"`);
    afirmar(e.sino === '5', `sino "${e.sino}"`);
    afirmar(!/acima dos limites|Nenhum alerta|Sem alertas|sob controle/i.test(e.cartao), `texto contraditório no cartão: ${e.cartao}`);
    await foto('N14-cinco-alertas-nivel-baixo', 1366, 768);
    return `${e.titulo} | ${e.alertas} | ${e.mensagem}`;
  });

  await caso('N15', 'Um alerta: singular ("1 alerta ativo"); alertas ALTOS com poluentes baixos não mudam a situação (vem dos poluentes)', async () => {
    await abrir(montarRota({ latest: BAIXOS, alertas: listaDeAlertas(1, 'MODERADO') }));
    let e = await estado();
    afirmar(e.alertas === '1 alerta ativo' && e.mensagem === 'Consulte os detalhes na tela de Alertas.', `1 alerta: "${e.alertas}" / "${e.mensagem}"`);
    await abrir(montarRota({ latest: BAIXOS, alertas: listaDeAlertas(3, 'ALTO') }));
    e = await estado();
    afirmar(e.titulo === 'Nível baixo' && e.alertas === '3 alertas ativos', `3 alertas ALTO: "${e.titulo}" / "${e.alertas}"`);
    return '1 alerta ativo | 3 alertas ativos com Nível baixo (a contagem real é mantida)';
  });

  await caso('N16', 'Alertas indisponíveis (500) ou carregando: a situação pelos poluentes continua, com aviso próprio dos alertas', async () => {
    await abrir(montarRota({ latest: latestDe({ pm25: med('pm25', 80) }), alertas: { status: 500, corpo: { error: 'Erro interno do servidor' } } }));
    let e = await estado();
    afirmar(e.titulo === 'Nível alto' && /^Alertas indisponíveis/.test(e.erroAlertas ?? '') && e.alertas === null, `erro: "${e.titulo}" / "${e.erroAlertas}" / "${e.alertas}"`);
    await abrir(montarRota({ latest: latestDe({ pm25: med('pm25', 80) }), alertas: { pendurar: true } }), { aguardar: false });
    await esperar(`document.querySelectorAll('.pollutant').length === 6 && !/Carregando/.test(document.querySelector('.dash-pollutants').innerText) && !!document.querySelector('[data-testid="situacao-titulo"]')`, 20000, 'poluentes carregados');
    e = await estado();
    afirmar(e.titulo === 'Nível alto' && e.mensagem === 'Carregando alertas…', `carregando alertas: "${e.titulo}" / "${e.mensagem}"`);
    return 'erro e carregamento dos alertas não derrubam a situação dos poluentes';
  });

  // ===== Aviso e textos =====
  await caso('N17', 'Aviso de limiares provisórios mantido (texto exato); sem "Bom/Ruim" nem IQA oficial', async () => {
    const cenarios = [['faixas', latestDe(Object.fromEntries(CHAVES.map((k) => [k, med(k, TAB_BACK[k].ALTO)])))], ['sem dados', latestDe({})]];
    for (const [nome, latest] of cenarios) {
      await abrir(montarRota({ latest }));
      const e = await estado();
      afirmar(e.nota === NOTA, `[${nome}] aviso: "${e.nota}"`);
      afirmar(!/\b(Bom|Boa|Ruim|Regular|Péssim[ao]|Saudável)\b/.test(e.cartao + ' ' + e.poluentes), `[${nome}] classificação de IQA no texto: ${e.cartao}`);
    }
    return `"${NOTA}"`;
  });

  // ===== Responsividade =====
  const rica = latestDe({ pm25: med('pm25', 9.6), pm10: med('pm10', 120), o3: med('o3', 170, { fonte: 'OPEN_METEO' }), no2: med('no2', 330), co: med('co', 0.6, { unidade: 'ppm' }), so2: med('so2', 600, { desatualizada: false }) });
  await abrir(montarRota({ latest: rica, alertas: listaDeAlertas(5, 'ALTO') }));
  for (const [nome, w, h, mobile] of [['1366', 1366, 768, false], ['768', 768, 1024, true], ['390', 390, 844, true]]) {
    await caso(`N18-${nome}`, `Responsividade ${w}×${h}: sem rolagem horizontal, selos e situação cabem nos cartões, nada cortado`, async () => {
      await enviar('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
      await dormir(600);
      const m = await avaliar(`({
        rolagemH: Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, document.body.scrollWidth - document.body.clientWidth),
        estourados: [...document.querySelectorAll('.pollutant, .dash-card, .alert-level, .quality-msg, .quality-value')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className.split(' ')[0]),
        selos: [...document.querySelectorAll('.pollutant')].map((c) => { const s = c.querySelector('[data-testid="nivel-poluente"]'); if (!s) return null; const a = s.getBoundingClientRect(), b = c.getBoundingClientRect(); return { dentro: a.left >= b.left - 1 && a.right <= b.right + 1, naTela: a.right <= innerWidth + 1 && a.left >= -1, altura: Math.round(a.height), largura: Math.round(a.width) }; }),
        situacaoNaTela: (() => { const r = document.querySelector('[data-testid="situacao-titulo"]').getBoundingClientRect(); return r.right <= innerWidth + 1 && r.left >= -1; })(),
      })`);
      await foto(`N18-${nome}`, w, h, mobile);
      afirmar(m.rolagemH <= 1, `rolagem horizontal de ${m.rolagemH}px`);
      afirmar(m.estourados.length === 0, `elementos estourando: ${m.estourados.join(', ')}`);
      const comSelo = m.selos.filter(Boolean);
      afirmar(comSelo.length === 6, `esperava 6 selos, há ${comSelo.length}`);
      afirmar(comSelo.every((s) => s.dentro && s.naTela && s.largura > 0), `selo fora do card/tela: ${JSON.stringify(comSelo.filter((s) => !(s.dentro && s.naTela)))}`);
      afirmar(comSelo.every((s) => s.altura <= 30), `selo quebrando em mais de uma linha: ${JSON.stringify(comSelo.map((s) => s.altura))}`);
      afirmar(m.situacaoNaTela, 'título da situação fora da tela');
      return `sem rolagem horizontal; 6 selos dentro dos cards (altura ${Math.max(...comSelo.map((s) => s.altura))}px)`;
    });
  }
  await enviar('Emulation.clearDeviceMetricsOverride');

  await caso('N19', 'Nenhuma exceção de JavaScript na página durante todos os cenários', async () => {
    afirmar(errosDePagina.length === 0, `erros de JavaScript: ${[...new Set(errosDePagina)].slice(0, 3).join(' | ')}`);
    return 'sem exceções';
  });
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
  writeFileSync(join(SHOTS, 'resultado.json'), JSON.stringify(resultados, null, 2));
  process.exit(reprovados.length ? 1 : 0);
}
