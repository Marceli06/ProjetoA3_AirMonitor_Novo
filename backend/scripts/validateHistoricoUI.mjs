// Validação da tela de Histórico com a API REAL (OpenAQ/Open-Meteo) e navegador real.
// Chrome headless via DevTools Protocol, sem dependências novas. Backend de teste na 3996 e Vite na 5196.
// Cria usuários TEMPORÁRIOS (tmp.val.*@example.com) direto no banco e SEMPRE remove no final.
// Não imprime senhas, tokens nem valores do .env.
// Uso (dentro de backend/, com backend e frontend de teste no ar):
//   APP_URL=http://127.0.0.1:5196 API_URL=http://127.0.0.1:3996/api node scripts/validateHistoricoUI.mjs
// Ou tudo de uma vez (sobe backend e frontend de teste sozinho): npm run ui:validate
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import dotenv from 'dotenv';
import pg from 'pg';
import bcrypt from 'bcryptjs';

dotenv.config();

const APP = process.env.APP_URL || 'http://127.0.0.1:5196';
const API = process.env.API_URL || 'http://127.0.0.1:3996/api';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORTA_CDP = Number(process.env.CDP_PORT || 9336);
const SHOTS = process.env.SHOTS_DIR || join(process.cwd(), '.tmp-val-shots');
const FRONTEND = resolve(process.cwd(), '..', 'frontend');
mkdirSync(SHOTS, { recursive: true });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const afirmar = (condicao, msg) => { if (!condicao) throw new Error(msg); };
const resultados = [];

async function caso(id, descricao, fn) {
  const t0 = Date.now();
  try {
    const detalhe = await fn();
    resultados.push({ id, ok: true });
    console.log(`[APROVADO]  ${id} ${descricao}${detalhe ? '\n              -> ' + detalhe : ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    resultados.push({ id, ok: false });
    console.log(`[REPROVADO] ${id} ${descricao}\n              -> ${e.message}`);
  }
}
const info = (id, texto) => console.log(`[INFO]      ${id} ${texto}`);
// ---------------------------------------------------------------- Banco / usuários de teste
const sufixo = Date.now();
let contador = 0;
async function novoUsuario(perfil, { ativo = true, cidade = 'Osasco' } = {}) {
  const senha = `Tmp-${Math.random().toString(36).slice(2)}-9`;
  const email = `tmp.val.${perfil.toLowerCase()}.${sufixo}.${++contador}@example.com`;
  const hash = await bcrypt.hash(senha, 4);
  const r = await pool.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, cidade, regiao) VALUES ($1,$2,$3,$4,$5,$6,'Centro') RETURNING id`,
    [`Teste VAD ${perfil}`, email, hash, perfil, ativo, cidade]
  );
  return { id: r.rows[0].id, email, senha, perfil };
}
const definirAtivo = (id, ativo) => pool.query('UPDATE usuarios SET ativo = $1 WHERE id = $2', [ativo, id]);
const definirPerfil = (id, perfil) => pool.query('UPDATE usuarios SET perfil = $1 WHERE id = $2', [perfil, id]);
async function contagemDoBanco() {
  const r = await pool.query(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE ativo)::int ativos, COUNT(*) FILTER (WHERE NOT ativo)::int inativos,
    COUNT(*) FILTER (WHERE perfil='ADMIN')::int admins, COUNT(*) FILTER (WHERE perfil='USUARIO')::int comuns FROM usuarios`);
  return r.rows[0];
}
const limparUsuariosDeTeste = () => pool.query(`DELETE FROM usuarios WHERE email LIKE 'tmp.val.%@example.com'`);
// ---------------------------------------------------------------- CDP mínimo
let ws, idMsg = 0;
const pendentes = new Map();
const ouvintes = [];
const errosDePagina = [];
const requisicoes = []; // {id, url, method, status}

const enviar = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++idMsg;
  pendentes.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
async function avaliar(expressao) {
  const r = await enviar('Runtime.evaluate', { expression: expressao, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('Erro no navegador: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function esperar(expressao, ms = 15000, descricao = expressao) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    try { if (await avaliar(expressao)) return true; } catch { /* ainda carregando */ }
    await dormir(120);
  }
  throw new Error(`Tempo esgotado esperando: ${descricao}`);
}
function aguardarEvento(nome, ms = 20000) {
  return new Promise((resolver, rejeitar) => {
    const t = setTimeout(() => { ouvintes.splice(ouvintes.indexOf(f), 1); rejeitar(new Error('Tempo esgotado no evento ' + nome)); }, ms);
    const f = (m) => { if (m.method === nome) { clearTimeout(t); ouvintes.splice(ouvintes.indexOf(f), 1); resolver(m.params); } };
    ouvintes.push(f);
  });
}

// Marca, dentro do navegador, se a tela de Login / o Dashboard chegaram a existir no DOM (mesmo por instantes)
const OBSERVADOR = `(() => {
  window.__viuLogin = false; window.__viuDash = false;
  const verificar = () => {
    if (document.querySelector('.login-container')) window.__viuLogin = true;
    if (document.querySelector('.dash')) window.__viuDash = true;
  };
  new MutationObserver(verificar).observe(document, { childList: true, subtree: true });
})()`;

async function abrirChrome() {
  const dir = join(tmpdir(), 'airmonitor-cdp-val-' + Date.now());
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORTA_CDP}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1366,900', 'about:blank',
  ], { stdio: 'ignore' });
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) {
    await dormir(250);
    try { alvo = (await (await fetch(`http://127.0.0.1:${PORTA_CDP}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* subindo */ }
  }
  if (!alvo) throw new Error('Chrome não abriu a porta de depuração');
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('falha no WebSocket do Chrome')); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pendentes.has(msg.id)) {
      const p = pendentes.get(msg.id); pendentes.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method) [...ouvintes].forEach((f) => f(msg));
  };
  const versao = await (await fetch(`http://127.0.0.1:${PORTA_CDP}/json/version`)).json();
  for (const d of ['Page', 'Runtime', 'Network']) await enviar(`${d}.enable`);
  await enviar('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVADOR });
  ouvintes.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') errosDePagina.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Network.requestWillBeSent') requisicoes.push({ id: m.params.requestId, url: m.params.request.url, method: m.params.request.method, status: null });
    if (m.method === 'Network.responseReceived') { const r = requisicoes.find((x) => x.id === m.params.requestId); if (r) r.status = m.params.response.status; }
    if (m.method === 'Network.loadingFailed') { const r = requisicoes.find((x) => x.id === m.params.requestId); if (r) r.status = 'FALHOU'; }
    if (m.method === 'Page.javascriptDialogOpening') enviar('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });
  return { proc, dir, versao: versao.Browser };
}

const navegar = async (url) => {
  const carregou = aguardarEvento('Page.loadEventFired');
  await enviar('Page.navigate', { url });
  await carregou;
};
const recarregar = async () => {
  const carregou = aguardarEvento('Page.loadEventFired');
  await enviar('Page.reload');
  await carregou;
};
async function digitar(seletor, valor) {
  await avaliar(`(()=>{const e=document.querySelector(${JSON.stringify(seletor)}); e.focus(); e.select && e.select(); return true})()`);
  await enviar('Input.insertText', { text: valor });
}
const selecionar = (seletor, valor) => avaliar(`(()=>{const s=document.querySelector(${JSON.stringify(seletor)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(valor)}); s.dispatchEvent(new Event('change',{bubbles:true})); return s.value})()`);
const clicarMenu = (rotulo) => avaliar(`(()=>{const b=[...document.querySelectorAll('.dash-nav-item')].find(x=>x.innerText.trim()===${JSON.stringify(rotulo)}); if(!b) return false; b.click(); return true})()`);
const textoMain = () => avaliar(`document.querySelector('.dash-main').innerText`);
const guardado = (chave) => avaliar(`localStorage.getItem(${JSON.stringify(chave)})`);
const itensDoMenu = () => avaliar(`[...document.querySelectorAll('.dash-nav-item')].map(b=>b.innerText.trim())`);
const MENU_ADMIN = ['Dashboard', 'Alertas', 'Ocorrências', 'Histórico', 'Configurações', 'Usuários', 'Estações', 'Relatórios'];
const MENU_USUARIO = ['Dashboard', 'Alertas', 'Ocorrências', 'Histórico'];

const esperarDashboard = (ms = 20000) => esperar(`!!document.querySelector('.dash-main h1')`, ms, 'Dashboard aberto');
const esperarLogin = (ms = 15000) => esperar(`!!document.querySelector('.login-container') && !!document.querySelector('input[name="email"]')`, ms, 'tela de Login');
const esperarContadores = () => esperar(`document.querySelectorAll('.admin-stat strong').length === 5 && ![...document.querySelectorAll('.admin-stat strong')].some(e => e.innerText === '…')`, 25000, 'contadores carregados');
const viu = () => avaliar(`({ login: window.__viuLogin === true, dash: window.__viuDash === true })`);
const requisicoesDesde = (indice, regex) => requisicoes.slice(indice).filter((r) => r.method !== 'OPTIONS' && regex.test(r.url));

async function foto(nome, largura = 1366, altura = 900, mobile = false) {
  await enviar('Emulation.setDeviceMetricsOverride', { width: largura, height: altura, deviceScaleFactor: 1, mobile });
  await dormir(400);
  const m = await enviar('Page.getLayoutMetrics');
  const alturaTotal = Math.ceil(m.cssContentSize?.height || m.contentSize.height);
  const r = await enviar('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: largura, height: Math.min(alturaTotal, 2600), scale: 1 } });
  writeFileSync(join(SHOTS, nome + '.png'), Buffer.from(r.data, 'base64'));
}

// Login real pela tela (digitando no formulário)
async function loginPelaTela(email, senha) {
  await navegar(APP + '/');
  await avaliar(`localStorage.clear()`);
  await recarregar();
  await esperarLogin();
  await digitar('input[name="email"]', email);
  await digitar('input[name="password"]', senha);
  await avaliar(`document.querySelector('form').requestSubmit()`);
  await esperarDashboard();
}
// Semeia uma sessão no armazenamento do navegador sem passar pela tela (token e user como o login grava)
async function semearSessao({ token, user }) {
  await navegar(APP + '/');
  await avaliar(`localStorage.setItem('authToken', ${JSON.stringify(token)}); localStorage.setItem('user', ${JSON.stringify(JSON.stringify(user))}); true`);
}
async function semSessao() {
  await navegar(APP + '/');
  await avaliar(`localStorage.clear(); true`);
}

// Retém ('segurar') ou derruba ('falhar') as requisições que casam com o padrão; o preflight CORS sempre passa
async function interceptar(padrao, modoInicial) {
  let modo = modoInicial;
  const retidas = [];
  const tratar = (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    if (request.method === 'OPTIONS' || modo === 'passar') return enviar('Fetch.continueRequest', { requestId }).catch(() => {});
    if (modo === 'falhar') return enviar('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }).catch(() => {});
    retidas.push(requestId);
  };
  ouvintes.push(tratar);
  await enviar('Fetch.enable', { patterns: [{ urlPattern: padrao, requestStage: 'Request' }] });
  return async () => {
    modo = 'passar';
    for (const id of retidas.splice(0)) await enviar('Fetch.continueRequest', { requestId: id }).catch(() => {});
    await dormir(100);
    await enviar('Fetch.disable').catch(() => {});
    ouvintes.splice(ouvintes.indexOf(tratar), 1);
  };
}

const PAGINAS = [
  { menu: 'Dashboard', pronta: `document.querySelectorAll('.admin-stat strong').length === 5 && ![...document.querySelectorAll('.admin-stat strong')].some(e => e.innerText === '…') && !!document.querySelector('.admin-station-list')` },
  { menu: 'Configurações', pronta: `/Cache e atualização/.test(document.querySelector('.dash-main').innerText)` },
  { menu: 'Usuários', pronta: `!!document.querySelector('.users-table tbody tr')` },
  { menu: 'Estações', pronta: `!!document.querySelector('.users-table tbody tr') || /Nenhuma|Não foi|indispon/.test(document.querySelector('.dash-main').innerText)` },
  { menu: 'Relatórios', pronta: `!!document.querySelector('.report-section table') && !/Carregando dados/.test(document.querySelector('.dash-main').innerText)` },
];
const sobraHorizontal = () => avaliar(`Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth`);
const tecla = async (key, code, vk) => {
  await enviar('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
  await enviar('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
};
const metricasMobile = (largura, altura) => enviar('Emulation.setDeviceMetricsOverride', { width: largura, height: altura, deviceScaleFactor: 1, mobile: true });
const limparMetricas = () => enviar('Emulation.clearDeviceMetricsOverride');

// ---------------------------------------------------------------- Ajudantes da tela de Histórico (API real)
const fmt = (n) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const SP = 'São Paulo';
const CAMPINAS = 'Campinas';

async function tokenDe(u) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: u.senha }) });
  const j = await r.json();
  if (r.status !== 200) throw new Error('login de teste falhou: ' + r.status);
  return j.token;
}
// Consulta direta à API (referência independente da tela) com o token do usuário de teste
async function consultaApi(token, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${API}/historico?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, corpo: await r.json().catch(() => null) };
}

const existe = (sel) => avaliar(`!!document.querySelector(${JSON.stringify(sel)})`);
const textoSel = (sel) => avaliar(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const clicarSel = (sel) => avaliar(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e || e.disabled) return false; e.click(); return true})()`);
const paginaHist = () => esperar(`/Histórico da Qualidade do Ar/.test(document.querySelector('.hist-page h1')?.innerText ?? '')`, 15000, 'tela de Histórico');
// Pronto quando a página não está carregando e mostra dados, estado vazio ou erro
const esperarHist = () => esperar(`(()=>{ const p=document.querySelector('.hist-page'); if(!p || p.getAttribute('aria-busy')==='true') return false;
  return !!document.querySelector('[data-testid="medicao"]') || !!document.querySelector('[data-testid="estado-vazio"]') || !!document.querySelector('[data-testid="estado-erro"]'); })()`, 40000, 'histórico carregado');
const acaoHist = async (fn, extra = 150) => { const r = await fn(); await dormir(extra); await esperarHist(); return r; };
const SEL = { poluente: '.hist-page select[aria-label="Poluente"]', periodo: '.hist-page select[aria-label="Período"]', origem: '.hist-page select[aria-label="Origem do dado"]', estacao: '.hist-page select[aria-label="Estação"]', cidade: '.hist-page select[aria-label="Cidade"]' };
const linhasHist = () => avaliar(`[...document.querySelectorAll('[data-testid="medicao"]')].map(r=>({data:r.querySelector('.hist-cell-data').innerText.replace(/\\s+/g,' ').trim(), valor:r.querySelector('.hist-cell-valor b').innerText.trim(), unidade:r.querySelector('.hist-cell-valor small').innerText.trim(), poluente:r.querySelector('.hist-cell-poluente').innerText.trim(), estacao:r.querySelector('.hist-cell-estacao').innerText.trim(), origem:r.querySelector('.hist-cell-origem').innerText.trim()}))`);
const cartoesHist = () => avaliar(`Object.fromEntries(['ultimo','media','minimo','maximo'].map(k=>[k, document.querySelector('[data-testid="resumo-'+k+'"] strong')?.innerText.replace(/\\s+/g,' ').trim() ?? null]))`);
const chamadasHist = (indice = 0) => requisicoes.slice(indice).filter((r) => r.method === 'GET' && /\/api\/historico(\?|$)/.test(r.url));
const parametrosDe = (url) => Object.fromEntries(new URL(url).searchParams.entries());
const forasHist = () => avaliar(`[...document.querySelectorAll('.hist-page *:not(thead *)')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>0 && (r.right>window.innerWidth+1 || r.left<-1)}).slice(0,5).map(e=>e.getAttribute('class')||e.tagName)`);
const faixaHist = () => textoSel('[data-testid="faixa"]');
const opcoesEstacao = () => avaliar(`[...document.querySelectorAll('.hist-page select[aria-label="Estação"] option')].map(o=>({v:o.value, t:o.textContent.trim()}))`);

async function simular(padrao, status, corpo) {
  let usadas = 0;
  const tratar = (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    if (request.method === 'OPTIONS' || request.method !== 'GET' || usadas > 0) return enviar('Fetch.continueRequest', { requestId }).catch(() => {});
    usadas++;
    return enviar('Fetch.fulfillRequest', {
      requestId, responseCode: status,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
      body: Buffer.from(JSON.stringify(corpo)).toString('base64'),
    }).catch(() => {});
  };
  ouvintes.push(tratar);
  await enviar('Fetch.enable', { patterns: [{ urlPattern: padrao, requestStage: 'Request' }] });
  return async () => { await enviar('Fetch.disable').catch(() => {}); ouvintes.splice(ouvintes.indexOf(tratar), 1); };
}

// Troca "cidade=de" por "cidade=para" nas consultas de histórico (simula um cliente adulterado)
async function reescreverCidade(para) {
  const tratar = (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    if (request.method === 'OPTIONS') return enviar('Fetch.continueRequest', { requestId }).catch(() => {});
    const url = new URL(request.url);
    url.searchParams.set('cidade', para);
    return enviar('Fetch.continueRequest', { requestId, url: url.toString() }).catch(() => {});
  };
  ouvintes.push(tratar);
  await enviar('Fetch.enable', { patterns: [{ urlPattern: '*/api/historico*', requestStage: 'Request' }] });
  return async () => { await enviar('Fetch.disable').catch(() => {}); ouvintes.splice(ouvintes.indexOf(tratar), 1); };
}

async function main() {
  const admin = await novoUsuario('ADMIN', { cidade: 'Osasco' });
  const comum = await novoUsuario('USUARIO', { cidade: SP });
  const tokenAdmin = await tokenDe(admin);
  const tokenComum = await tokenDe(comum);
  const chrome = await abrirChrome();
  console.log(`===== HistoryPage com API real (${chrome.versao}) =====`);
  let refSp = null; // referência da API para São Paulo / pm25 / 24H
  try {
    console.log('\n--- ADMIN ---');
    await caso('HS01', 'ADMIN: abre Histórico, escolhe São Paulo; título, cartões, gráfico e tabela com dados reais', async () => {
      const i0 = requisicoes.length;
      await loginPelaTela(admin.email, admin.senha);
      afirmar(await clicarMenu('Histórico'), 'item Histórico');
      await paginaHist();
      await acaoHist(() => selecionar(SEL.cidade, SP), 200);
      const ultima = chamadasHist(i0).filter((r) => parametrosDe(r.url).cidade === SP).pop();
      afirmar(ultima && ultima.status === 200, 'sem GET /api/historico 200 para São Paulo');
      const p = parametrosDe(ultima.url);
      afirmar(p.poluente === 'pm25' && p.periodo === '24H' && p.fonte === 'AUTO' && !('estacaoId' in p), 'parâmetros padrão: ' + JSON.stringify(p));
      refSp = await consultaApi(tokenAdmin, { cidade: SP, poluente: 'pm25', periodo: '24H', fonte: 'AUTO' });
      afirmar(refSp.status === 200, 'API de referência: ' + refSp.status);
      const ref = refSp.corpo;
      info('HS01', `referência da API: ${ref.total} pontos, fontes ${ref.fontesUtilizadas.join('+') || '—'}, estação ${ref.estacao?.nome ?? '—'}`);
      afirmar(ref.total > 0, 'a API não devolveu dados de São Paulo/PM2.5 nas últimas 24h; ajuste o cenário');
      afirmar(await existe('[data-testid="historico-grafico"] svg polyline'), 'gráfico sem linha');
      const c = await cartoesHist();
      afirmar(c.ultimo?.startsWith(fmt(ref.resumo.ultimo.valor)) && c.media?.startsWith(fmt(ref.resumo.media)) && c.minimo?.startsWith(fmt(ref.resumo.minimo)) && c.maximo?.startsWith(fmt(ref.resumo.maximo)), 'cartões: ' + JSON.stringify(c) + ' vs ' + JSON.stringify(ref.resumo));
      const linhas = await linhasHist();
      afirmar(linhas.length === Math.min(10, ref.total), 'linhas: ' + linhas.length);
      afirmar(linhas[0].valor === fmt(ref.pontos[ref.pontos.length - 1].valor), 'primeira linha não é a medição mais recente: ' + linhas[0].valor + ' vs ' + ref.pontos[ref.pontos.length - 1].valor);
      afirmar(linhas.every((l) => l.poluente === 'PM2.5' && l.unidade === 'µg/m³'), 'poluente/unidade das linhas');
      const faixa = await faixaHist();
      afirmar(new RegExp(`Mostrando 1 a ${Math.min(10, ref.total)} de ${ref.total} registros`).test(faixa), 'faixa: ' + faixa);
      afirmar(/PM2\.5/.test(await textoSel('.hist-chart-card h2')), 'título do gráfico');
      const txt = await textoMain();
      afirmar(!/ilustrativ/i.test(txt), 'texto de dados ilustrativos na tela');
      await foto('hist-admin-1366', 1366, 768);
      return `${ref.total} pontos; origem ${ref.fontesUtilizadas.join('+')}; estação ${ref.estacao?.nome ?? '—'}`;
    });

    await caso('HS02', 'origem do dado: estação (OpenAQ) mostra a estação e a distância; linhas com origem MEDICAO', async () => {
      const ref = refSp.corpo;
      if (!ref.fontesUtilizadas.includes('OPENAQ')) { info('HS02', 'a referência de São Paulo veio do modelo: verificação de estação limitada'); }
      const origem = await textoSel('[data-testid="origem-dado"]');
      const linhas = await linhasHist();
      if (ref.fontesUtilizadas.includes('OPENAQ')) {
        afirmar(/Estação · OpenAQ/.test(origem) && origem.includes(ref.estacao.nome), 'origem: ' + origem);
        afirmar(linhas.every((l) => l.origem === 'Estação · OpenAQ' && l.estacao === ref.estacao.nome), 'linhas: ' + JSON.stringify(linhas[0]));
        afirmar(!(await existe('[data-testid="atribuicao"]')), 'atribuição da Open-Meteo sem uso do modelo');
      } else {
        afirmar(/Modelo · Open-Meteo/.test(origem) && await existe('[data-testid="atribuicao"]'), 'origem do modelo: ' + origem);
      }
      return origem.replace(/\s+/g, ' ');
    });

    await caso('HS03', 'gráfico: passar o mouse mostra o valor, a data e a origem do ponto', async () => {
      await avaliar(`document.querySelector('[data-testid="historico-grafico"]').scrollIntoView({block:'center'})`);
      await dormir(200);
      const alvo = await avaliar(`(()=>{const r=document.querySelector('[data-testid="historico-grafico"] svg rect[fill="transparent"]').getBoundingClientRect(); return {x:r.left+r.width*0.97, y:r.top+r.height/2, esq:r.left+r.width*0.5}})()`);
      await enviar('Input.dispatchMouseEvent', { type: 'mouseMoved', x: alvo.x, y: alvo.y });
      await esperar(`!!document.querySelector('[data-testid="grafico-info"]')`, 5000, 'tooltip do gráfico');
      const info1 = await textoSel('[data-testid="grafico-info"]');
      const ref = refSp.corpo;
      afirmar(/µg\/m³/.test(info1) && /\d{2}\/\d{2}\/\d{4}|\d{2}\/\d{2}\/\d{2}/.test(info1) && /(Estação|Modelo) · /.test(info1), 'tooltip: ' + info1.replace(/\s+/g, ' '));
      afirmar(await existe('[data-testid="historico-grafico"] .hist-cursor'), 'linha vertical do cursor');
      await enviar('Input.dispatchMouseEvent', { type: 'mouseMoved', x: alvo.esq, y: alvo.y });
      await dormir(150);
      const info2 = await textoSel('[data-testid="grafico-info"]');
      afirmar(info2 !== info1, 'tooltip não mudou ao mover o mouse');
      await enviar('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
      await dormir(150);
      afirmar(!(await existe('[data-testid="grafico-info"]')), 'tooltip não sumiu ao sair do gráfico');
      const valores = ref.pontos.map((p) => fmt(p.valor));
      const valorTooltip = info1.split('\n')[0].replace(/\s*µg\/m³.*/, '').trim();
      afirmar(valores.includes(valorTooltip), `valor do tooltip (${valorTooltip}) não existe na série da API`);
      const aria = await avaliar(`document.querySelector('[data-testid="historico-grafico"] svg').getAttribute('aria-label')`);
      afirmar(/Gráfico de evolução de PM2\.5/.test(aria), 'aria-label do gráfico');
    });

    await caso('HS04', 'filtro de período e de poluente refazem a consulta e batem com a API', async () => {
      const i0 = requisicoes.length;
      await acaoHist(() => selecionar(SEL.periodo, '7D'), 200);
      const ref7 = (await consultaApi(tokenAdmin, { cidade: SP, poluente: 'pm25', periodo: '7D', fonte: 'AUTO' })).corpo;
      afirmar(chamadasHist(i0).some((r) => parametrosDe(r.url).periodo === '7D' && r.status === 200), 'requisição com periodo=7D');
      const f7 = await faixaHist();
      afirmar(new RegExp(`de ${ref7.total} registros`).test(f7) && ref7.total >= refSp.corpo.total, `7D: faixa "${f7}" total API ${ref7.total}`);
      afirmar(/Últimos 7 dias/.test(await textoSel('.hist-chart-card .hist-period')), 'rótulo do período');
      for (const chave of ['pm10', 'o3']) {
        await acaoHist(() => selecionar(SEL.poluente, chave), 200);
        const ref = (await consultaApi(tokenAdmin, { cidade: SP, poluente: chave, periodo: '7D', fonte: 'AUTO' })).corpo;
        const nome = ref.poluente.nome;
        if (ref.total === 0) {
          afirmar(await existe('[data-testid="estado-vazio"]'), `${chave}: API vazia mas a tela não mostra o estado vazio`);
        } else {
          const linhas = await linhasHist();
          afirmar(linhas.length > 0 && linhas.every((l) => l.poluente === nome) && new RegExp(`de ${ref.total} registros`).test(await faixaHist()), `${chave}: tela x API (${ref.total})`);
          afirmar(new RegExp(nome.replace('.', '\\.')).test(await textoSel('.hist-chart-card h2')), `${chave}: título do gráfico`);
        }
        afirmar(chamadasHist(i0).some((r) => parametrosDe(r.url).poluente === chave && r.status === 200), `requisição poluente=${chave}`);
      }
      await acaoHist(() => selecionar(SEL.poluente, 'pm25'), 200);
      await acaoHist(() => selecionar(SEL.periodo, '24H'), 200);
    });

    await caso('HS05', 'origem "Modelo (Open-Meteo)": série do modelo, atribuição, estação desabilitada, paginação de 7 dias', async () => {
      await acaoHist(() => selecionar(SEL.origem, 'OPEN_METEO'), 200);
      await acaoHist(() => selecionar(SEL.periodo, '7D'), 200);
      const ref = (await consultaApi(tokenAdmin, { cidade: SP, poluente: 'pm25', periodo: '7D', fonte: 'OPEN_METEO' })).corpo;
      afirmar(ref.total >= 160, 'API do modelo 7D: ' + ref.total);
      const linhas = await linhasHist();
      afirmar(linhas.length === 10 && linhas.every((l) => l.origem === 'Modelo · Open-Meteo' && /^Modelo · /.test(l.estacao) && l.unidade === 'µg/m³'), 'linhas do modelo: ' + JSON.stringify(linhas[0]));
      afirmar(/Modelo · Open-Meteo/.test(await textoSel('[data-testid="origem-dado"]')) && /não é medição local/.test(await textoSel('[data-testid="origem-dado"]')), 'texto da origem');
      afirmar(/Open-Meteo\.com/.test(await textoSel('[data-testid="atribuicao"]')), 'atribuição CC BY 4.0');
      afirmar(await avaliar(`document.querySelector('.hist-page select[aria-label="Estação"]').disabled`), 'seletor de estação deveria estar desabilitado');
      afirmar(new RegExp(`Mostrando 1 a 10 de ${ref.total} registros`).test(await faixaHist()), 'faixa: ' + await faixaHist());
      const paginas = Math.ceil(ref.total / 10);
      const primeira = (await linhasHist())[0].data;
      await acaoHist(() => clicarSel('button[aria-label="Página 2"]'), 100).catch(() => {});
      await dormir(150);
      const l2 = await linhasHist();
      afirmar(l2[0].data !== primeira && new RegExp('Mostrando 11 a 20').test(await faixaHist()), 'página 2');
      afirmar(await clicarSel('button[aria-label="Próxima página"]'), 'próxima'); await dormir(150);
      afirmar(/Mostrando 21 a 30/.test(await faixaHist()), 'página 3');
      afirmar(await clicarSel('button[aria-label="Página anterior"]'), 'anterior'); await dormir(150);
      afirmar(/Mostrando 11 a 20/.test(await faixaHist()), 'voltou à página 2');
      afirmar(await clicarSel(`button[aria-label="Página ${paginas}"]`), 'última página'); await dormir(150);
      const resto = ref.total % 10 || 10;
      afirmar((await linhasHist()).length === resto && /Próxima página/.test('Próxima página') && await avaliar(`document.querySelector('button[aria-label="Próxima página"]').disabled`), `última página com ${resto} linhas e "próxima" desabilitada`);
      afirmar(await clicarSel('button[aria-label="Página 1"]'), 'primeira'); await dormir(150);
      afirmar(await avaliar(`document.querySelector('button[aria-label="Página anterior"]').disabled`), '"anterior" desabilitada na página 1');
      // mudar o filtro volta à página 1
      await clicarSel('button[aria-label="Página 2"]'); await dormir(150);
      await acaoHist(() => selecionar(SEL.periodo, '30D'), 200);
      afirmar(/Mostrando 1 a 10/.test(await faixaHist()), 'trocar o período volta à página 1');
      return `${ref.total} pontos do modelo em ${paginas} páginas`;
    });

    await caso('HS06', 'origem "Estação (OpenAQ)" em São Paulo; seletor de estação lista as estações e filtra a série', async () => {
      await acaoHist(() => selecionar(SEL.origem, 'OPENAQ'), 200);
      await acaoHist(() => selecionar(SEL.periodo, '30D'), 200);
      const ref = (await consultaApi(tokenAdmin, { cidade: SP, poluente: 'pm25', periodo: '30D', fonte: 'OPENAQ' })).corpo;
      const opcoes = await opcoesEstacao();
      afirmar(opcoes.length === ref.estacoes.length + 1 && opcoes[0].v === '', `opções de estação: ${opcoes.length} vs ${ref.estacoes.length + 1}`);
      afirmar(opcoes.some((o) => /sem dados no período/.test(o.t)) === ref.estacoes.some((e) => !e.comDadosNoPeriodo), 'rótulo "sem dados no período" coerente com a API');
      afirmar(!(await avaliar(`document.querySelector('.hist-page select[aria-label="Estação"]').disabled`)), 'seletor de estação habilitado');
      if (ref.total > 0) {
        const linhas = await linhasHist();
        afirmar(linhas.every((l) => l.origem === 'Estação · OpenAQ'), 'origem das linhas');
        afirmar(new RegExp(`de ${ref.total} registros`).test(await faixaHist()), 'total x API');
      }
      // estação explícita com dados
      const comDados = ref.estacao ? ref.estacoes.find((e) => e.id === ref.estacao.id) : null;
      if (comDados) {
        const i0 = requisicoes.length;
        await acaoHist(() => selecionar(SEL.estacao, String(comDados.id)), 200);
        afirmar(chamadasHist(i0).some((r) => parametrosDe(r.url).estacaoId === String(comDados.id) && r.status === 200), 'requisição com estacaoId');
        afirmar((await linhasHist()).every((l) => l.estacao === comDados.nome), 'linhas da estação escolhida');
      }
      // estação sem dados: estado vazio explicativo, sem trocar pelo modelo
      const semDados = ref.estacoes.find((e) => !e.comDadosNoPeriodo);
      if (semDados) {
        await acaoHist(() => selecionar(SEL.estacao, String(semDados.id)), 200);
        afirmar(await existe('[data-testid="estado-vazio"]'), 'estação sem dados deveria mostrar o estado vazio');
        afirmar(new RegExp('não tem medições de PM2\\.5').test(await textoSel('[data-testid="estado-vazio"]')), 'mensagem: ' + await textoSel('[data-testid="estado-vazio"]'));
        afirmar(!(await existe('[data-testid="medicao"]')) && !(await existe('[data-testid="historico-grafico"]')), 'sem gráfico/tabela no estado vazio');
        await foto('hist-vazio-1366', 1366, 768);
      } else info('HS06', 'todas as estações têm dados: caso "estação sem dados" pulado');
      await acaoHist(() => selecionar(SEL.estacao, ''), 200);
      // trocar a cidade zera a estação escolhida
      return `${ref.estacoes.length} estações listadas`;
    });

    await caso('HS07', 'ausência de dados: Campinas só com estações vazio; em AUTO cai para o modelo com aviso', async () => {
      await acaoHist(() => selecionar(SEL.cidade, CAMPINAS), 300);
      await acaoHist(() => selecionar(SEL.periodo, '7D'), 200);
      const i0 = requisicoes.length;
      await acaoHist(() => selecionar(SEL.origem, 'OPENAQ'), 200);
      afirmar(await existe('[data-testid="estado-vazio"]'), 'Campinas/OPENAQ deveria estar vazio');
      const t = await textoSel('[data-testid="estado-vazio"]');
      afirmar(/Nenhum histórico disponível/.test(t) && /Campinas/.test(t), 'mensagem do vazio: ' + t.replace(/\s+/g, ' '));
      afirmar(!(await existe('[data-testid="medicao"]')) && !(await existe('[data-testid="historico-grafico"]')) && !(await existe('[data-testid="resumo-media"]')), 'não pode haver gráfico, cartões ou linhas inventadas');
      await acaoHist(() => selecionar(SEL.origem, 'AUTO'), 200);
      afirmar(await existe('[data-testid="aviso-fonte"]') && /modelo CAMS/.test(await textoSel('[data-testid="aviso-fonte"]')), 'aviso de fallback para o modelo');
      const linhas = await linhasHist();
      afirmar(linhas.length > 0 && linhas.every((l) => l.origem === 'Modelo · Open-Meteo'), 'linhas do modelo no fallback');
      afirmar(/Modelo · Open-Meteo/.test(await textoSel('[data-testid="origem-dado"]')) && await existe('[data-testid="atribuicao"]'), 'origem e atribuição do fallback');
      await foto('hist-fallback-1366', 1366, 768);
      await acaoHist(() => selecionar(SEL.cidade, SP), 300);
      await acaoHist(() => selecionar(SEL.periodo, '24H'), 200);
    });

    await caso('HS08', 'troca de cidade zera a estação escolhida e consulta a nova cidade', async () => {
      await acaoHist(() => selecionar(SEL.origem, 'OPENAQ'), 200);
      await acaoHist(() => selecionar(SEL.periodo, '30D'), 200);
      const ref = (await consultaApi(tokenAdmin, { cidade: SP, poluente: 'pm25', periodo: '30D', fonte: 'OPENAQ' })).corpo;
      if (ref.estacao) await acaoHist(() => selecionar(SEL.estacao, String(ref.estacao.id)), 200);
      const i0 = requisicoes.length;
      await acaoHist(() => selecionar(SEL.cidade, CAMPINAS), 300);
      const cs = chamadasHist(i0).filter((r) => parametrosDe(r.url).cidade === CAMPINAS);
      afirmar(cs.length > 0 && cs.every((r) => !('estacaoId' in parametrosDe(r.url))), 'a estação da cidade anterior vazou para a nova consulta');
      afirmar(await avaliar(`document.querySelector('.hist-page select[aria-label="Estação"]').value === ''`), 'seletor de estação não voltou ao automático');
      await acaoHist(() => selecionar(SEL.cidade, SP), 300);
      await acaoHist(() => selecionar(SEL.origem, 'AUTO'), 200);
      await acaoHist(() => selecionar(SEL.periodo, '24H'), 200);
    });

    await caso('HS09', 'erros: 500 e 502 na API (com nova tentativa), 403 e carregando', async () => {
      let parar = await simular('*/api/historico*', 500, { error: 'falha' });
      await acaoHist(() => selecionar(SEL.poluente, 'no2'), 200);
      afirmar(await existe('[data-testid="estado-erro"]'), 'sem estado de erro (500)');
      afirmar(/Não foi possível carregar o histórico/.test(await textoSel('[data-testid="estado-erro"]')), 'texto do erro 500');
      afirmar(!(await existe('[data-testid="medicao"]')) && !(await existe('[data-testid="historico-grafico"]')), 'sem dados antigos no erro');
      await parar();
      await acaoHist(() => clicarSel('[data-testid="estado-erro"] button'), 100);
      afirmar(!(await existe('[data-testid="estado-erro"]')), 'nova tentativa não recuperou');
      parar = await simular('*/api/historico*', 502, { error: 'A OpenAQ está indisponível no momento', codigo: 'OPENAQ_INDISPONIVEL' });
      await acaoHist(() => selecionar(SEL.poluente, 'so2'), 200);
      afirmar(/OpenAQ está indisponível/.test(await textoSel('[data-testid="estado-erro"]')), '502: ' + await textoSel('[data-testid="estado-erro"]'));
      await parar();
      parar = await simular('*/api/historico*', 403, { error: 'Você só pode consultar o histórico da sua cidade' });
      await acaoHist(() => selecionar(SEL.poluente, 'co'), 200);
      afirmar(/só pode consultar/.test(await textoSel('[data-testid="estado-erro"]')), '403 mostra a mensagem do servidor');
      afirmar(await existe('select[aria-label="Poluente"]') && (await existe('.dash')), '403 não encerra a sessão');
      await parar();
      await acaoHist(() => clicarSel('[data-testid="estado-erro"] button'), 100);
      // loading: retém a requisição
      const liberar = await interceptar('*/api/historico*', 'segurar');
      await selecionar(SEL.poluente, 'pm10');
      await esperar(`document.querySelector('.hist-page')?.getAttribute('aria-busy')==='true'`, 6000, 'página ocupada');
      afirmar(await existe('.hist-content.is-loading') || await existe('[data-testid="carregando"]'), 'estado de carregamento não visível');
      await foto('hist-carregando-1366', 1366, 768);
      await liberar();
      await esperarHist();
      await acaoHist(() => selecionar(SEL.poluente, 'pm25'), 200);
    });

    await caso('HS10', '401: token recusado pela API encerra a sessão e volta ao Login', async () => {
      const parar = await simular('*/api/historico*', 401, { error: 'Token inválido' });
      await selecionar(SEL.poluente, 'o3');
      await esperarLogin(10000);
      afirmar(await guardado('authToken') === null, 'token ainda guardado');
      await parar();
    });

    console.log('\n--- USUARIO ---');
    await caso('HS20', 'USUARIO: cidade fixa, sem seletor de cidade; todas as consultas na própria cidade', async () => {
      const i0 = requisicoes.length;
      await loginPelaTela(comum.email, comum.senha);
      afirmar(await clicarMenu('Histórico'), 'menu Histórico');
      await paginaHist(); await esperarHist();
      afirmar(!(await existe(SEL.cidade)) && /São Paulo/.test(await textoSel('.hist-page .page-city-fixed')), 'cidade fixa São Paulo');
      // Consultas canceladas ao trocar de tela (ex.: o cartão "Últimas 24 horas" do Dashboard) não têm resposta e não contam
      const reqs = chamadasHist(i0).filter((r) => typeof r.status === 'number');
      afirmar(reqs.length > 0 && reqs.every((r) => parametrosDe(r.url).cidade === SP && r.status === 200), 'consultas: ' + reqs.map((r) => `${r.status} ${r.url}`).join(' '));
      const ref = (await consultaApi(tokenComum, { cidade: SP, poluente: 'pm25', periodo: '24H', fonte: 'AUTO' })).corpo;
      afirmar(new RegExp(`de ${ref.total} registros`).test(await faixaHist()), 'dados do USUARIO x API');
      await acaoHist(() => selecionar(SEL.poluente, 'pm10'), 200);
      await acaoHist(() => selecionar(SEL.periodo, '7D'), 200);
      afirmar(chamadasHist(i0).every((r) => parametrosDe(r.url).cidade === SP), 'alguma consulta saiu com outra cidade');
      await foto('hist-usuario-1366', 1366, 768);
    });

    await caso('HS21', 'USUARIO: cliente adulterado pedindo outra cidade recebe 403 e mensagem na tela', async () => {
      const parar = await reescreverCidade(CAMPINAS);
      const i0 = requisicoes.length;
      await acaoHist(() => selecionar(SEL.poluente, 'o3'), 200);
      await parar();
      afirmar(chamadasHist(i0).some((r) => r.status === 403), 'servidor deveria responder 403: ' + JSON.stringify(chamadasHist(i0).map((r) => [parametrosDe(r.url).cidade, r.status])));
      afirmar(/só pode consultar o histórico da sua cidade/.test(await textoSel('[data-testid="estado-erro"]')), 'mensagem: ' + await textoSel('[data-testid="estado-erro"]'));
      afirmar(!(await existe('[data-testid="medicao"]')), 'dados de outra cidade apareceram');
    });

    console.log('\n--- Responsivo ---');
    await caso('RS01', 'ADMIN em 1366, 768 e 390 px: sem rolagem horizontal; gráfico, filtros, tabela/cartões e vazio dentro da tela', async () => {
      await loginPelaTela(admin.email, admin.senha);
      afirmar(await clicarMenu('Histórico'), 'menu'); await paginaHist();
      await acaoHist(() => selecionar(SEL.cidade, SP), 200);
      const resumo = [];
      for (const [w, h] of [[1366, 768], [768, 1024], [390, 844]]) {
        if (w === 1366) await limparMetricas(); else await metricasMobile(w, h);
        await dormir(500);
        const s = await sobraHorizontal();
        const fora = await forasHist();
        afirmar(s <= 0 && fora.length === 0, `${w}px: overflow ${s}px; fora: ${fora.join(' | ')}`);
        const grafico = await avaliar(`(()=>{const c=document.querySelector('[data-testid="historico-grafico"]'); const s=c.querySelector('svg').getBoundingClientRect(); const r=c.getBoundingClientRect(); return {w:Math.round(s.width), caixa:Math.round(r.width), dentro:s.right<=window.innerWidth+1}})()`);
        afirmar(grafico.dentro && grafico.w <= grafico.caixa + 1 && grafico.w >= 240, `${w}px: gráfico ${JSON.stringify(grafico)}`);
        const modo = await avaliar(`getComputedStyle(document.querySelector('.hist-table thead')).position`);
        afirmar((w <= 800) === (modo === 'absolute'), `${w}px: modo da tabela (${modo})`);
        const filtros = await avaliar(`[...document.querySelectorAll('.hist-select')].every(e=>{const r=e.getBoundingClientRect(); return r.left>=-1 && r.right<=window.innerWidth+1})`);
        afirmar(filtros, `${w}px: filtros fora da tela`);
        await avaliar(`document.querySelector('[data-testid="historico-grafico"]').scrollIntoView({block:'center'})`);
        await dormir(150);
        await foto(`hist-admin-${w}`, w, h, w < 1366);
        // estado vazio responsivo
        await acaoHist(() => selecionar(SEL.cidade, CAMPINAS), 250);
        await acaoHist(() => selecionar(SEL.origem, 'OPENAQ'), 200);
        afirmar(await existe('[data-testid="estado-vazio"]') && (await sobraHorizontal()) <= 0, `${w}px: estado vazio`);
        await foto(`hist-vazio-${w}`, w, h, w < 1366);
        await acaoHist(() => selecionar(SEL.origem, 'AUTO'), 200);
        await acaoHist(() => selecionar(SEL.cidade, SP), 250);
        resumo.push(`${w}px ok (tabela: ${modo}, gráfico ${grafico.w}px)`);
      }
      await limparMetricas();
      return resumo.join('; ');
    });

    console.log('\n--- Regressão ---');
    await caso('RG01', 'regressão: Dashboard, Alertas, Ocorrências e volta para o Histórico', async () => {
      afirmar(await clicarMenu('Dashboard'), 'Dashboard'); await esperarDashboard();
      afirmar(await clicarMenu('Alertas'), 'Alertas');
      await esperar(`!!document.querySelector('.alerts-page h1')`, 15000, 'tela de Alertas');
      afirmar(await clicarMenu('Ocorrências'), 'Ocorrências');
      await esperar(`!!document.querySelector('.oc-page h1')`, 15000, 'tela de Ocorrências');
      afirmar(await clicarMenu('Histórico'), 'Histórico'); await paginaHist(); await esperarHist();
      afirmar((await linhasHist()).length > 0, 'histórico vazio ao voltar');
    });
    await caso('ZZ01', 'nenhum erro de JavaScript não tratado', async () => {
      afirmar(errosDePagina.length === 0, 'erros JS: ' + errosDePagina.slice(0, 3).join(' | '));
    });
    await caso('ZZ02', 'nenhuma resposta 5xx real do servidor nas chamadas da tela (os 500/502 simulados não contam)', async () => {
      const f = requisicoes.filter((r) => typeof r.status === 'number' && r.status >= 500 && !/\/api\/historico/.test(r.url));
      afirmar(f.length === 0, f.map((r) => `${r.status} ${r.url}`).join(' | '));
    });
  } finally {
    try { ws?.close(); } catch { /* ignora */ }
    chrome.proc.kill();
    await dormir(500);
    try { rmSync(chrome.dir, { recursive: true, force: true }); } catch { /* pasta em uso */ }
  }
}

try {
  await main();
} catch (e) {
  console.log('[ERRO FATAL] ' + e.message);
  resultados.push({ id: 'FATAL', ok: false });
} finally {
  await limparUsuariosDeTeste().catch(() => {});
  const restUsuarios = await pool.query(`SELECT COUNT(*)::int n FROM usuarios WHERE email LIKE 'tmp.val.%@example.com'`).then((r) => r.rows[0].n).catch(() => '?');
  await pool.end().catch(() => {});
  const ok = resultados.filter((r) => r.ok).length;
  console.log(`\nResumo: ${ok} aprovado(s), ${resultados.length - ok} reprovado(s) de ${resultados.length}. Usuários temporários restantes: ${restUsuarios}.`);
  console.log(`Prints em: ${SHOTS}`);
  process.exitCode = ok === resultados.length ? 0 : 1;
}
