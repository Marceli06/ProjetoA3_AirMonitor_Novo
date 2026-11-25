// Validacao da tela de Alertas com a API real (frontend + backend + banco). Chrome headless via DevTools Protocol, sem dependencias novas.
// Semeia alertas de teste (estacoes TESTE-UI-*) e usuarios temporarios (tmp.val.*@example.com) direto no banco e SEMPRE os remove no final;
// o "Avaliar dados agora" consulta a OpenAQ de verdade e os alertas que ele criar tambem sao removidos (id maior que o do inicio da execucao).
// Cobre ADMIN (lista, filtros, paginacao, detalhe, resolver, avaliar), USUARIO (so a propria cidade, sem acoes de ADMIN, 403/404/401),
// estados (carregando, erro, vazio), origem (medicao x modelo), responsividade (1366/768/390) e regressao (Dashboard e Ocorrencias).
// Nao imprime senhas, tokens nem valores do .env.
// Uso (dentro de backend/, com backend e frontend de teste ja no ar, em portas livres, nunca nas do usuario):
//   APP_URL=http://127.0.0.1:5196 API_URL=http://127.0.0.1:3996/api node scripts/validateAlertasUI.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const req = createRequire(resolve(process.cwd(), 'package.json'));
const dotenv = req('dotenv');
const pg = req('pg');
const bcrypt = req('bcryptjs');
const jwt = req('jsonwebtoken');

dotenv.config({ path: resolve(process.cwd(), '.env') });

const APP = process.env.APP_URL || 'http://127.0.0.1:5196';
const API = process.env.API_URL || 'http://127.0.0.1:3996/api';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORTA_CDP = Number(process.env.CDP_PORT || 9336);
const SHOTS = process.env.SHOTS_DIR || join(tmpdir(), 'airmonitor-alertas-ui-shots');
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

// ---------------------------------------------------------------- HTTP
async function http(caminho, { method = 'GET', token, corpo, cabecalhos } = {}) {
  const res = await fetch(API + caminho, {
    method,
    headers: { ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...cabecalhos },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await res.text();
  let json = null;
  try { json = JSON.parse(texto); } catch { /* sem corpo JSON */ }
  return { status: res.status, json, texto };
}
const statusDe = (lista) => lista.map((x) => x.status).join(',');
const assinar = (payload, opcoes = {}, segredo = process.env.JWT_SECRET) => jwt.sign(payload, segredo, opcoes);

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
async function login(u) {
  const r = await http('/auth/login', { method: 'POST', corpo: { email: u.email, password: u.senha } });
  afirmar(r.status === 200, `login de ${u.perfil} de teste: HTTP ${r.status}`);
  return r.json; // { token, user }
}
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

// ---------------------------------------------------------------- Ajudantes da tela de Alertas (API real)
let maxIdAntes = 0;
async function semearAlerta(a) {
  const tipo = a.origem === 'OPEN_METEO' ? 'MODELO' : 'MEDICAO';
  const status = a.status || 'ATIVO';
  const medicao = new Date(Date.now() - a.minutosAtras * 60000);
  await pool.query(
    `INSERT INTO alertas (cidade, regiao, estacao_id, estacao_nome, poluente, valor, unidade, nivel, titulo, descricao, status, origem_dado, tipo_dado, medicao_em, criado_em, atualizado_em, resolvido_em)
     VALUES ($1, NULL, $2, $3, $4, $5, 'µg/m³', $6, $7, $8, $9, $10, $11, $12, $12, $12, $13)`,
    [a.cidade, a.estacao, a.nome, a.poluente, a.valor, a.nivel, a.titulo, a.descricao || `Descrição do alerta de teste ${a.titulo}`, status, a.origem || 'OPENAQ', tipo, medicao, status === 'RESOLVIDO' ? medicao : null]
  );
}
const limparAlertasDeTeste = () => pool.query(`DELETE FROM alertas WHERE estacao_id LIKE 'TESTE-UI%' OR id > $1`, [maxIdAntes]);

const ALERTAS = `[...document.querySelectorAll('[data-testid="alerta"]')]`;
const itens = () => avaliar(`${ALERTAS}.map(b=>({titulo:b.querySelector('strong').innerText, nivel:b.querySelector('.alert-level').innerText.trim(), status:b.querySelector('.alert-status').innerText.trim(), origem:b.querySelector('.alert-origin').innerText.trim(), texto:b.innerText}))`);
const resumoTela = () => avaliar(`Object.fromEntries(['ativos','alta','media','resolvidos'].map(k=>[k, Number(document.querySelector('[data-testid="resumo-'+k+'"] strong').innerText)]))`);
const contagemTexto = () => avaliar(`document.querySelector('[data-testid="contagem"]')?.innerText ?? ''`);
const clicarGrupo = (grupo, texto) => avaliar(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(grupo)}+' button')].find(x=>x.innerText.trim()===${JSON.stringify(texto)}); if(!b) return false; b.click(); return true})()`);
const clicarBotao = (texto) => avaliar(`(()=>{const b=[...document.querySelectorAll('.dash-main button, .detail-drawer button')].find(x=>x.innerText.trim()===${JSON.stringify(texto)}); if(!b) return false; b.click(); return true})()`);
const temBotao = (texto) => avaliar(`[...document.querySelectorAll('.dash-main button, .detail-drawer button')].some(x=>x.innerText.trim()===${JSON.stringify(texto)})`);
const paginaAlertas = () => esperar(`!!document.querySelector('.alerts-page h1') && /Alertas de Qualidade do Ar/.test(document.querySelector('.alerts-page h1').innerText)`, 15000, 'tela de Alertas');
const esperarLista = () => esperar(`(()=>{ if (document.querySelector('[data-testid="carregando"]')) return false;
  const c = document.querySelector('[data-testid="resumo-ativos"] strong'); const resumoOk = !!c && c.innerText !== '–';
  const erro = !!document.querySelector('[data-testid="estado-erro"]');
  const lista = !!document.querySelector('[data-testid="alerta"]') || !!document.querySelector('[data-testid="estado-vazio"]');
  return erro || (lista && resumoOk); })()`, 20000, 'lista de alertas carregada');
const acao = async (fn) => { const r = await fn(); await dormir(150); await esperarLista(); return r; };
const abrirDetalhe = (i = 0) => avaliar(`(()=>{const b=${ALERTAS}[${i}]; if(!b) return false; b.click(); return true})()`);
const detalheAberto = () => avaliar(`!!document.querySelector('[data-testid="alerta-detalhe"]')`);
const textoDetalhe = () => avaliar(`document.querySelector('[data-testid="alerta-detalhe"]')?.innerText ?? ''`);
const tecla = async (key, code, vk) => {
  await enviar('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
  await enviar('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
};
const metricasMobile = (largura, altura) => enviar('Emulation.setDeviceMetricsOverride', { width: largura, height: altura, deviceScaleFactor: 1, mobile: true });
const limparMetricas = () => enviar('Emulation.clearDeviceMetricsOverride');
const forasDaTela = () => avaliar(`[...document.querySelectorAll('.alerts-page *')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>0 && (r.right>window.innerWidth+1 || r.left<-1)}).slice(0,5).map(e=>e.className||e.tagName)`);
const rotulos = (o) => `ativos=${o.ativos} alta=${o.alta} media=${o.media} resolvidos=${o.resolvidos}`;
const chamadasAlertas = (indice = 0) => requisicoes.slice(indice).filter((r) => r.method === 'GET' && /\/api\/alertas(\?|$)/.test(r.url));

async function reescreverCidade(de, para) {
  const tratar = (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    if (request.method === 'OPTIONS') return enviar('Fetch.continueRequest', { requestId }).catch(() => {});
    return enviar('Fetch.continueRequest', { requestId, url: request.url.replace(`cidade=${de}`, `cidade=${para}`) }).catch(() => {});
  };
  ouvintes.push(tratar);
  await enviar('Fetch.enable', { patterns: [{ urlPattern: '*/api/alertas*', requestStage: 'Request' }] });
  return async () => { await enviar('Fetch.disable').catch(() => {}); ouvintes.splice(ouvintes.indexOf(tratar), 1); };
}

async function main() {
  maxIdAntes = (await pool.query('SELECT COALESCE(MAX(id),0)::int m FROM alertas')).rows[0].m;
  const antes = (await pool.query('SELECT COUNT(*)::int n FROM alertas')).rows[0].n;
  info('SETUP', `alertas no banco antes: ${antes} (maior id ${maxIdAntes})`);
  await limparAlertasDeTeste();

  // Campinas: 3 ativos (crítico OpenAQ, alto Open-Meteo, moderado OpenAQ) + 13 resolvidos = 16 (2 páginas de 10)
  await semearAlerta({ cidade: 'Campinas', estacao: 'TESTE-UI-1', nome: 'Estação Teste Centro', poluente: 'pm25', valor: 130.2, nivel: 'CRITICO', titulo: 'PM2.5 crítico (teste UI)', minutosAtras: 10 });
  await semearAlerta({ cidade: 'Campinas', estacao: 'TESTE-UI-2', nome: 'Modelo CAMS (teste)', poluente: 'o3', valor: 165, nivel: 'ALTO', titulo: 'O3 alto por modelo (teste UI)', origem: 'OPEN_METEO', minutosAtras: 20 });
  await semearAlerta({ cidade: 'Campinas', estacao: 'TESTE-UI-3', nome: 'Estação Teste Norte', poluente: 'no2', valor: 210.5, nivel: 'MODERADO', titulo: 'NO2 moderado (teste UI)', minutosAtras: 30 });
  for (let i = 1; i <= 13; i++) {
    await semearAlerta({ cidade: 'Campinas', estacao: `TESTE-UI-R${i}`, nome: `Estação Teste R${i}`, poluente: i <= 7 ? 'so2' : 'pm10', valor: 45 + i, nivel: 'BAIXO', status: 'RESOLVIDO', titulo: `Resolvido ${i} (teste UI)`, minutosAtras: 100 + i * 10 });
  }
  await semearAlerta({ cidade: 'Osasco', estacao: 'TESTE-UI-O1', nome: 'Estação Teste Osasco', poluente: 'pm10', valor: 110, nivel: 'MODERADO', titulo: 'PM10 moderado Osasco (teste UI)', minutosAtras: 15 });

  const admin = await novoUsuario('ADMIN', { cidade: 'Osasco' });
  const comum = await novoUsuario('USUARIO', { cidade: 'Osasco' });
  const chrome = await abrirChrome();
  console.log(`===== AlertsPage com API real (${chrome.versao}) =====`);
  try {
    console.log('\n--- ADMIN ---');
    await caso('AR01', 'ADMIN: lista real de Campinas, cards calculados e nenhum mock', async () => {
      const i0 = requisicoes.length;
      await loginPelaTela(admin.email, admin.senha);
      afirmar(await clicarMenu('Alertas'), 'item Alertas');
      await paginaAlertas();
      await selecionar('.alerts-page select[aria-label="Cidade"]', 'Campinas');
      await dormir(200);
      await esperarLista();
      const r = await resumoTela();
      afirmar(r.ativos === 3 && r.alta === 2 && r.media === 1 && r.resolvidos === 13, 'resumo ' + rotulos(r));
      const c = await contagemTexto();
      afirmar(/Mostrando 10 de 16 alertas/.test(c), 'contagem: ' + c);
      const l = await itens();
      const ordem = l.slice(0, 3).map((x) => `${x.nivel}/${x.status}`).join(' | ');
      afirmar(ordem === 'Crítico/Ativo | Alto/Ativo | Moderado/Ativo', 'ordem: ' + ordem);
      const txt = await textoMain();
      afirmar(!/ilustrativ/i.test(txt) && !/Campinas-Centro/.test(txt) && !/Paulínia/.test(txt), 'sobrou texto de mock');
      afirmar(/Campinas · Estação Teste Centro/.test(l[0].texto) && /130,2/.test(l[0].texto) && /µg\/m³/.test(l[0].texto), 'item 0: ' + l[0].texto.replace(/\n/g, ' | '));
      const todas = chamadasAlertas(i0).filter((x) => /cidade=Campinas/.test(x.url));
      const pendentes = todas.filter((x) => x.status === null);
      if (pendentes.length) console.log(`[INFO]      AR01 ${pendentes.length} chamada(s) sem resposta registrada: ${pendentes.map((x) => x.url.split('?')[1]).join(' | ')}`);
      const chamadas = todas.filter((x) => x.status !== null);
      afirmar(chamadas.length >= 2 && chamadas.every((x) => x.status === 200), 'chamadas: ' + chamadas.map((x) => x.status).join(','));
      await foto('ar-admin-campinas-1366');
      return rotulos(r) + '; ' + c;
    });
    await caso('AR02', 'paginação pelo backend: página 2 (6 alertas) e volta para a 1', async () => {
      afirmar(await clicarBotao('Próxima'), 'botão Próxima');
      await dormir(150); await esperarLista();
      let c = await contagemTexto();
      afirmar(/Mostrando 6 de 16 alertas/.test(c), 'página 2: ' + c);
      const pag = await avaliar(`document.querySelector('[data-testid="paginacao"]').innerText`);
      afirmar(/Página 2 de 2/.test(pag), 'paginador: ' + pag);
      afirmar(await avaliar(`[...document.querySelectorAll('[data-testid="paginacao"] button')].find(b=>b.innerText==='Próxima').disabled`), 'Próxima deveria estar desabilitada');
      afirmar(await clicarBotao('Anterior'), 'botão Anterior');
      await dormir(150); await esperarLista();
      c = await contagemTexto();
      afirmar(/Mostrando 10 de 16/.test(c), 'página 1: ' + c);
    });
    await caso('AR03', 'filtros no backend: Status, Nível (um por vez), Poluente, combinação sem resultado e Limpar', async () => {
      await acao(() => clicarGrupo('.alerts-segmented', 'Ativos'));
      let c = await contagemTexto();
      afirmar(/Mostrando 3 de 3 alertas/.test(c), 'Ativos: ' + c);
      await acao(() => clicarGrupo('.alerts-chips', 'Crítico'));
      c = await contagemTexto();
      afirmar(/Mostrando 1 de 1 alerta\b/.test(c), 'Ativos+Crítico: ' + c);
      await acao(() => clicarGrupo('.alerts-chips', 'Crítico')); // desmarca
      afirmar(/Mostrando 3 de 3/.test(await contagemTexto()), 'depois de desmarcar o nível');
      await acao(() => clicarGrupo('.alerts-segmented', 'Todos'));
      await acao(() => selecionar('[data-testid="filtro-poluente"]', 'o3'));
      c = await contagemTexto();
      afirmar(/Mostrando 1 de 1 alerta\b/.test(c), 'poluente O3: ' + c);
      await acao(() => selecionar('[data-testid="filtro-poluente"]', ''));
      await acao(() => clicarGrupo('.alerts-segmented', 'Resolvidos'));
      c = await contagemTexto();
      afirmar(/Mostrando 10 de 13 alertas/.test(c), 'Resolvidos: ' + c);
      await acao(() => clicarGrupo('.alerts-segmented', 'Ativos'));
      await acao(() => selecionar('[data-testid="filtro-poluente"]', 'so2'));
      afirmar(await avaliar(`/Nenhum alerta encontrado\\./.test(document.querySelector('[data-testid="estado-vazio"]')?.innerText ?? '')`), 'estado "filtro sem resultado" ausente');
      afirmar(await avaliar(`!/Nenhum alerta ativo no momento/.test(document.querySelector('[data-testid="estado-vazio"]').innerText)`), 'mensagem errada no filtro sem resultado');
      await acao(() => avaliar(`document.querySelector('.alerts-clear').click()`));
      c = await contagemTexto();
      afirmar(/Mostrando 10 de 16/.test(c), 'depois de Limpar: ' + c);
    });
    await caso('AR04', 'detalhe de alerta real (medição): título, poluente, valor, unidade, nível, cidade, estação, data/hora, origem, descrição, status', async () => {
      afirmar(await abrirDetalhe(0), 'abrir detalhe');
      afirmar(await detalheAberto(), 'drawer não abriu');
      const t = await textoDetalhe();
      for (const p of [/PM2\.5 crítico \(teste UI\)/, /130,2/, /µg\/m³/, /Crítico/, /Ativo/, /Campinas/, /Estação Teste Centro/, /\d{2}\/\d{2}\/\d{4}/, /Medição de estação \(OpenAQ\)/, /Descrição do alerta de teste/, /valor medido na estação/, /parâmetros técnicos provisórios/, /Criado em/, /Atualizado em/]) {
        afirmar(p.test(t), 'faltou ' + p + ' em: ' + t.replace(/\n/g, ' | '));
      }
      afirmar(!/Resolvido em/.test(t) && !/ilustrativ/i.test(t) && !/Estimativa/.test(t), 'texto indevido no detalhe');
      await foto('ar-admin-detalhe-1366');
    });
    await caso('AR05', 'drawer fecha pelo X, botão Fechar, clique fora e Esc', async () => {
      await avaliar(`document.querySelector('.detail-close').click()`); await dormir(120);
      afirmar(!(await detalheAberto()), 'X não fechou');
      await abrirDetalhe(0); await avaliar(`document.querySelector('.detail-done').click()`); await dormir(120);
      afirmar(!(await detalheAberto()), 'Fechar não fechou');
      await abrirDetalhe(0); await avaliar(`document.querySelector('[data-testid="alerta-overlay"]').click()`); await dormir(120);
      afirmar(!(await detalheAberto()), 'clique fora não fechou');
      await abrirDetalhe(0); await tecla('Escape', 'Escape', 27); await dormir(150);
      afirmar(!(await detalheAberto()), 'Esc não fechou');
    });
    await caso('AR06', 'origem: OpenAQ = "Medição de estação"; Open-Meteo = "Estimativa por modelo" (nunca como medição)', async () => {
      const l = await itens();
      afirmar(l[0].origem === 'Medição de estação' && l[1].origem === 'Estimativa por modelo' && l[2].origem === 'Medição de estação', 'origens: ' + l.slice(0, 3).map((x) => x.origem).join(','));
      afirmar(await abrirDetalhe(1), 'abrir modelo');
      const t = await textoDetalhe();
      afirmar(/Estimativa por modelo \(Open-Meteo\)/.test(t) && /valor estimado pelo modelo/.test(t) && /Não é uma medição local/.test(t), 'detalhe modelo: ' + t.replace(/\n/g, ' | '));
      afirmar(!/Medição de estação/.test(t) && !/valor medido/.test(t), 'estimativa apresentada como medição');
      await avaliar(`document.querySelector('.detail-close').click()`);
    });
    await caso('AR07', 'troca de cidade recarrega: Osasco (1 alerta) e Sorocaba (vazio: "Nenhum alerta ativo no momento.")', async () => {
      await acao(() => selecionar('.alerts-page select[aria-label="Cidade"]', 'Osasco'));
      let r = await resumoTela();
      afirmar(r.ativos === 1 && r.media === 1 && r.alta === 0 && r.resolvidos === 0, 'Osasco ' + rotulos(r));
      afirmar(/PM10 moderado Osasco/.test((await itens())[0].titulo), 'item de Osasco');
      await acao(() => selecionar('.alerts-page select[aria-label="Cidade"]', 'Sorocaba'));
      r = await resumoTela();
      afirmar(r.ativos === 0 && r.resolvidos === 0, 'Sorocaba ' + rotulos(r));
      const v = await avaliar(`document.querySelector('[data-testid="estado-vazio"]')?.innerText ?? ''`);
      afirmar(/Nenhum alerta ativo no momento\./.test(v), 'vazio: ' + v);
      const h = await avaliar(`document.querySelector('.alerts-hero').innerText`);
      afirmar(/Situação sob controle/.test(h) && /Nenhum alerta ativo em Sorocaba/.test(h), 'hero: ' + h);
      afirmar(await avaliar(`!!document.querySelector('[data-testid="nota-limiares"]')`), 'nota de limiares ausente');
      const nota = await avaliar(`document.querySelector('[data-testid="nota-limiares"]').innerText`);
      afirmar(nota === 'Os níveis de alerta utilizam parâmetros técnicos provisórios.', 'nota: ' + nota);
      await foto('ar-admin-sorocaba-vazio-1366');
    });
    await caso('AR08', 'estados: carregando, erro de API (mensagem + Tentar novamente), recuperação e sem fallback para mock', async () => {
      const liberar1 = await interceptar('*/api/alertas*', 'segurar');
      await selecionar('.alerts-page select[aria-label="Cidade"]', 'Campinas');
      await esperar(`!!document.querySelector('[data-testid="carregando"]')`, 8000, 'estado carregando');
      afirmar(await avaliar(`/Carregando alertas/.test(document.querySelector('[data-testid="carregando"]').innerText) && document.querySelectorAll('[data-testid="alerta"]').length === 0`), 'carregando');
      await foto('ar-admin-carregando-1366');
      await liberar1();
      await dormir(150); await esperarLista();
      afirmar((await itens()).length === 10, 'lista não voltou');

      const liberar2 = await interceptar('*/api/alertas*', 'falhar');
      await selecionar('.alerts-page select[aria-label="Cidade"]', 'Osasco');
      await esperar(`!!document.querySelector('[data-testid="estado-erro"]')`, 10000, 'estado de erro');
      const e = await avaliar(`document.querySelector('[data-testid="estado-erro"]').innerText`);
      afirmar(/Não foi possível carregar os alertas\. Tente novamente\./.test(e), 'erro: ' + e);
      afirmar(await avaliar(`document.querySelectorAll('[data-testid="alerta"]').length === 0`), 'itens exibidos durante o erro (fallback)');
      const tx = await textoMain();
      afirmar(!/PM2\.5 elevado|Alertas ilustrativos/.test(tx), 'mock apareceu no erro');
      await foto('ar-admin-erro-1366');
      await liberar2();
      afirmar(await clicarBotao('Tentar novamente'), 'botão Tentar novamente');
      await dormir(150); await esperarLista();
      afirmar((await itens()).length === 1, 'não recuperou após tentar novamente');
    });
    await caso('AR09', 'ADMIN resolve alerta manualmente (confirmação, banco e cards atualizados)', async () => {
      await acao(() => selecionar('.alerts-page select[aria-label="Cidade"]', 'Campinas'));
      await acao(() => clicarGrupo('.alerts-segmented', 'Ativos'));
      const l = await itens();
      const idx = l.findIndex((x) => /NO2 moderado/.test(x.titulo));
      afirmar(idx >= 0, 'alerta NO2 não achado');
      await abrirDetalhe(idx);
      afirmar(await temBotao('Resolver alerta'), 'botão Resolver alerta ausente para ADMIN');
      await clicarBotao('Resolver alerta');
      afirmar(/Resolver este alerta manualmente\?/.test(await textoDetalhe()), 'sem confirmação');
      await clicarBotao('Cancelar');
      afirmar(await temBotao('Resolver alerta'), 'cancelar não voltou');
      await clicarBotao('Resolver alerta');
      await clicarBotao('Confirmar');
      await esperar(`/Resolvido/.test(document.querySelector('[data-testid="alerta-detalhe"] .alert-status')?.innerText ?? '')`, 10000, 'status Resolvido no detalhe');
      afirmar(!(await temBotao('Resolver alerta')), 'botão ainda aparece após resolver');
      const t = await textoDetalhe();
      afirmar(/Resolvido em/.test(t), 'sem data de resolução: ' + t.replace(/\n/g, ' | '));
      const bd = (await pool.query(`SELECT status, resolvido_em FROM alertas WHERE estacao_id='TESTE-UI-3'`)).rows[0];
      afirmar(bd.status === 'RESOLVIDO' && bd.resolvido_em, 'banco: ' + JSON.stringify(bd));
      await avaliar(`document.querySelector('.detail-close').click()`);
      await dormir(200); await esperarLista();
      const r = await resumoTela();
      afirmar(r.ativos === 2 && r.resolvidos === 14, 'cards após resolver ' + rotulos(r));
      afirmar((await itens()).length === 2, 'lista Ativos após resolver: ' + (await itens()).length);
    });
    await caso('AR10', 'ADMIN: "Avaliar dados agora" (cidade selecionada) mostra aviso e recarrega', async () => {
      await acao(() => selecionar('.alerts-page select[aria-label="Cidade"]', 'Sorocaba'));
      const i0 = requisicoes.length;
      await avaliar(`document.querySelector('[data-testid="avaliar"]').click()`);
      await esperar(`/Avaliando/.test(document.querySelector('[data-testid="avaliar"]').innerText) && document.querySelector('[data-testid="avaliar"]').disabled`, 5000, 'botão em avaliação');
      await esperar(`!!document.querySelector('[data-testid="aviso-avaliacao"]')`, 100000, 'aviso da avaliação');
      const a = await avaliar(`document.querySelector('[data-testid="aviso-avaliacao"]').innerText`);
      const post = requisicoes.slice(i0).find((x) => x.method === 'POST' && /\/api\/alertas\/avaliar$/.test(x.url));
      afirmar(post, 'POST /avaliar não enviado');
      afirmar(/^(Avaliação concluída|Não foi possível avaliar)/.test(a), 'aviso: ' + a);
      await esperarLista();
      afirmar(await avaliar(`!document.querySelector('[data-testid="estado-erro"]')`), 'tela em erro após avaliar');
      return `HTTP ${post.status}: ${a}`;
    });

    console.log('\n--- USUARIO ---');
    await caso('US01', 'USUARIO: só a própria cidade, sem seletor, sem ações de ADMIN', async () => {
      await loginPelaTela(comum.email, comum.senha);
      const i0 = requisicoes.length;
      afirmar(await clicarMenu('Alertas'), 'Alertas');
      await paginaAlertas(); await esperarLista();
      afirmar(await avaliar(`!document.querySelector('.alerts-page select[aria-label="Cidade"]')`), 'seletor de cidade apareceu');
      afirmar(await avaliar(`/Osasco/.test(document.querySelector('.page-city-fixed')?.innerText ?? '')`), 'cidade fixa ausente');
      const r = await resumoTela();
      afirmar(r.ativos === 1 && r.media === 1, 'resumo ' + rotulos(r));
      const l = await itens();
      afirmar(l.length === 1 && /PM10 moderado Osasco/.test(l[0].titulo), 'itens: ' + l.map((x) => x.titulo).join(','));
      afirmar(!(await temBotao('Avaliar dados agora')), 'botão de avaliar visível para USUARIO');
      await abrirDetalhe(0);
      afirmar(!(await temBotao('Resolver alerta')), 'botão de resolver visível para USUARIO');
      await avaliar(`document.querySelector('.detail-close').click()`);
      const cs = chamadasAlertas(i0);
      afirmar(cs.length >= 2 && cs.every((x) => /cidade=Osasco/.test(x.url) && x.status === 200), 'chamadas: ' + cs.map((x) => x.url.split('?')[1] + '=' + x.status).join(' | '));
      await foto('ar-usuario-osasco-1366');
    });
    await caso('US02', 'parâmetro de cidade adulterado no navegador: 403, mensagem de erro, sessão preservada', async () => {
      const parar = await reescreverCidade('Osasco', 'Campinas');
      const i0 = requisicoes.length;
      await avaliar(`[...document.querySelectorAll('.alerts-segmented button')].find(b=>b.innerText.trim()==='Ativos').click()`);
      await esperar(`!!document.querySelector('[data-testid="estado-erro"]')`, 10000, 'erro após 403');
      await parar();
      const cs = chamadasAlertas(i0);
      afirmar(cs.some((x) => x.status === 403), 'sem 403: ' + cs.map((x) => x.status).join(','));
      afirmar(await avaliar(`document.querySelectorAll('[data-testid="alerta"]').length === 0 && !/Campinas/.test(document.querySelector('.alerts-page').innerText.replace('Campinas',''))`), 'dados de outra cidade na tela');
      afirmar(await avaliar(`!!document.querySelector('.dash') && !document.querySelector('.login-container')`), 'sessão encerrada por causa do 403');
      afirmar(!!(await guardado('authToken')), 'token removido por causa do 403');
    });
    await caso('US03', 'API: USUARIO não avalia nem resolve (403) e não vê alerta de outra cidade por ID (404)', async () => {
      const sessao = await login(comum);
      const idCampinas = (await pool.query(`SELECT id FROM alertas WHERE estacao_id='TESTE-UI-1'`)).rows[0].id;
      const a = await http('/alertas/avaliar', { method: 'POST', token: sessao.token, corpo: { cidade: 'Osasco' } });
      const r = await http(`/alertas/${idCampinas}/resolver`, { method: 'POST', token: sessao.token });
      const g = await http(`/alertas/${idCampinas}`, { token: sessao.token });
      const o = await http('/alertas?cidade=Campinas', { token: sessao.token });
      afirmar(a.status === 403 && r.status === 403 && g.status === 404 && o.status === 403, `avaliar ${a.status}, resolver ${r.status}, obter ${g.status}, listar outra cidade ${o.status}`);
      const intacto = (await pool.query(`SELECT status FROM alertas WHERE id=$1`, [idCampinas])).rows[0].status;
      afirmar(intacto === 'ATIVO', 'alerta alterado por USUARIO');
      return `avaliar ${a.status}, resolver ${r.status}, obter outra cidade ${g.status}, listar outra cidade ${o.status}`;
    });
    await caso('US04', '401 (token inválido) segue o tratamento global: sessão limpa e volta ao Login', async () => {
      await avaliar(`localStorage.setItem('authToken','token-invalido'); true`);
      await avaliar(`[...document.querySelectorAll('.alerts-segmented button')].find(b=>b.innerText.trim()==='Todos').click()`);
      await esperarLogin(15000);
      afirmar(!(await guardado('authToken')), 'token não foi limpo');
    });

    console.log('\n--- Responsividade e regressão ---');
    await caso('RE01', 'ADMIN: Alertas sem overflow em 1366, 768 e 390 (lista, drawer e ação de ADMIN)', async () => {
      await loginPelaTela(admin.email, admin.senha);
      await clicarMenu('Alertas'); await paginaAlertas();
      await acao(() => selecionar('.alerts-page select[aria-label="Cidade"]', 'Campinas'));
      for (const [w, h] of [[1366, 900], [768, 1024], [390, 844]]) {
        if (w === 1366) await limparMetricas(); else await metricasMobile(w, h);
        await dormir(300);
        const s = await sobraHorizontal();
        const fora = await forasDaTela();
        afirmar(s <= 0 && fora.length === 0, `${w}px: overflow ${s}px; fora: ${fora.join(',')}`);
        await abrirDetalhe(0); await dormir(250);
        const d = await avaliar(`(()=>{const r=document.querySelector('[data-testid="alerta-detalhe"]').getBoundingClientRect(); return r.left>=-1 && r.right<=window.innerWidth+1})()`);
        afirmar(d, `${w}px: drawer fora da tela`);
        await foto(`ar-admin-detalhe-${w}`, w, h, w < 1366);
        await avaliar(`document.querySelector('.detail-close').click()`);
        await foto(`ar-admin-lista-${w}`, w, h, w < 1366);
      }
      await limparMetricas();
    });
    await caso('RG01', 'regressão: Dashboard (admin), Ocorrências (working tree) e volta para Alertas', async () => {
      afirmar(await clicarMenu('Dashboard'), 'Dashboard'); await esperarDashboard(); await esperarContadores();
      afirmar(await avaliar(`document.querySelectorAll('.dash-nav-item svg').length`) === 8, 'ícones do menu');
      afirmar(await clicarMenu('Ocorrências'), 'Ocorrências');
      await esperar(`/Ocorrências Ambientais/.test(document.querySelector('.dash-main h1')?.innerText ?? '')`, 10000, 'tela de Ocorrências');
      afirmar(await avaliar(`document.querySelectorAll('.dash-main [data-testid]').length > 0`), 'Ocorrências sem conteúdo');
      afirmar(await clicarMenu('Alertas'), 'Alertas'); await paginaAlertas(); await esperarLista();
      afirmar((await itens()).length > 0, 'lista vazia ao voltar');
    });
    await caso('ZZ01', 'nenhum erro de JavaScript não tratado', async () => {
      afirmar(errosDePagina.length === 0, 'erros JS: ' + errosDePagina.slice(0, 3).join(' | '));
    });
    await caso('ZZ02', 'nenhuma resposta 5xx nas chamadas da tela', async () => {
      const f = requisicoes.filter((r) => typeof r.status === 'number' && r.status >= 500);
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
  await limparAlertasDeTeste().catch((e) => console.log('falha ao limpar alertas: ' + e.message));
  await limparUsuariosDeTeste().catch(() => {});
  const restUsuarios = await pool.query(`SELECT COUNT(*)::int n FROM usuarios WHERE email LIKE 'tmp.val.%@example.com'`).then((r) => r.rows[0].n).catch(() => '?');
  const restAlertas = await pool.query(`SELECT COUNT(*)::int n FROM alertas WHERE estacao_id LIKE 'TESTE-UI%' OR id > $1`, [maxIdAntes]).then((r) => r.rows[0].n).catch(() => '?');
  const totalAlertas = await pool.query(`SELECT COUNT(*)::int n FROM alertas`).then((r) => r.rows[0].n).catch(() => '?');
  await pool.end().catch(() => {});
  const ok = resultados.filter((r) => r.ok).length;
  console.log(`\nResumo: ${ok} aprovado(s), ${resultados.length - ok} reprovado(s) de ${resultados.length}. Usuários temporários restantes: ${restUsuarios}. Alertas de teste restantes: ${restAlertas} (total de alertas no banco: ${totalAlertas}).`);
  console.log(`Prints em: ${SHOTS}`);
  process.exitCode = ok === resultados.length ? 0 : 1;
}
