// Validação da tela de Ocorrências com a API REAL (Supabase) e navegador real.
// Chrome headless via DevTools Protocol, sem dependências novas. Backend de teste na 3996 e Vite na 5196.
// Cria usuários TEMPORÁRIOS (tmp.val.*@example.com) e ocorrências "[TESTE]" direto no banco e SEMPRE remove no final.
// Não imprime senhas, tokens nem valores do .env.
// Uso (dentro de backend/, com backend e frontend de teste no ar):
//   APP_URL=http://127.0.0.1:5196 API_URL=http://127.0.0.1:3996/api node scripts/validateOcorrenciasUI.mjs
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

// ---------------------------------------------------------------- Ajudantes da tela de Ocorrências (API real)
const PREFIXO = '[TESTE] ';
const limparOc = () => pool.query(`DELETE FROM ocorrencias WHERE titulo LIKE '[TESTE]%'`);
let realAntes = 0;

async function semearOc(o) {
  const criado = new Date(Date.now() - o.minutosAtras * 60000);
  const iniciado = o.status === 'ABERTA' ? null : new Date(criado.getTime() + 30 * 60000);
  const concluido = o.status === 'CONCLUIDA' ? new Date(criado.getTime() + 90 * 60000) : null;
  const r = await pool.query(
    `INSERT INTO ocorrencias (usuario_id, cidade, local, estacao_id, estacao_nome, tipo, titulo, descricao, status, origem, poluente, valor, unidade, nivel, criado_em, iniciado_em, atualizado_em, concluido_em)
     VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $14, $16) RETURNING id`,
    [o.cidade, o.local || `${o.cidade} - Centro`, o.estacaoNome ? 'TESTE-UI-EST' : null, o.estacaoNome || null, o.tipo, PREFIXO + o.titulo, o.descricao || `Descrição da ocorrência de teste: ${o.titulo}`,
      o.status, o.origem || 'AUTOMATICA', o.poluente || null, o.valor ?? null, o.poluente ? 'µg/m³' : null, o.nivel || null, criado, iniciado, concluido]
  );
  return r.rows[0].id;
}

const ordemDoBanco = async (cidade, extra = '', params = []) =>
  (await pool.query(`SELECT id, titulo, status, tipo FROM ocorrencias WHERE cidade = $1 ${extra} ORDER BY (status <> 'CONCLUIDA') DESC, criado_em DESC, id DESC`, [cidade, ...params])).rows;
const contarOc = async (cidade, extra = '', params = []) =>
  (await pool.query(`SELECT COUNT(*)::int n FROM ocorrencias WHERE cidade = $1 ${extra}`, [cidade, ...params])).rows[0].n;
const linhaDoBanco = async (id) => (await pool.query('SELECT * FROM ocorrencias WHERE id = $1', [id])).rows[0];
const diaSP = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
const rotuloStatus = { ABERTA: 'Em aberto', EM_ANDAMENTO: 'Em andamento', CONCLUIDA: 'Concluída' };

const LINHAS = `[...document.querySelectorAll('[data-testid="ocorrencia"]')]`;
const textoSel = (sel) => avaliar(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const existe = (sel) => avaliar(`!!document.querySelector(${JSON.stringify(sel)})`);
const clicarSel = (sel) => avaliar(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e || e.disabled) return false; e.click(); return true})()`);
const paginaOc = () => esperar(`/Ocorrências Ambientais/.test(document.querySelector('.oc-page h1')?.innerText ?? '')`, 15000, 'tela de Ocorrências');
const esperarListaOc = () => esperar(`(()=>{ const c=document.querySelector('.oc-list-card'); if(!c || c.getAttribute('aria-busy')==='true') return false;
  return !!document.querySelector('[data-testid="ocorrencia"]') || !!document.querySelector('[data-testid="estado-vazio"]') || !!document.querySelector('[data-testid="estado-erro"]'); })()`, 20000, 'lista de ocorrências carregada');
const acaoOc = async (fn, extra = 150) => { const r = await fn(); await dormir(extra); await esperarListaOc(); return r; };
const linhasOc = () => avaliar(`${LINHAS}.map(r=>({id:r.querySelector('.oc-id').innerText.trim(), titulo:r.querySelector('.oc-open').innerText.trim(), status:r.querySelector('.oc-status').innerText.trim(), tipo:r.querySelector('.oc-tipo').innerText.trim()}))`);
const cartoesOc = () => avaliar(`Object.fromEntries(['total','abertas','andamento','concluidas'].map(k=>[k, document.querySelector('[data-testid="resumo-'+k+'"] strong').innerText]))`);
const chamadasOc = (indice = 0, metodo = 'GET') => requisicoes.slice(indice).filter((r) => r.method === metodo && /\/api\/ocorrencias(\/|\?|$)/.test(r.url));
const listagensOc = (indice = 0) => chamadasOc(indice).filter((r) => /\/api\/ocorrencias(\?|$)/.test(r.url));
const abrirLinha = (i = 0) => avaliar(`(()=>{const b=${LINHAS}[${i}]; if(!b) return false; b.click(); return true})()`);
const detalheOc = () => textoSel('[data-testid="ocorrencia-detalhe"]');
const esperarDetalhe = () => esperar(`!!document.querySelector('[data-testid="ocorrencia-detalhe"]')`, 10000, 'painel de detalhes');
const fecharDetalhe = async () => { await avaliar(`document.querySelector('.detail-close')?.click()`); await dormir(150); };
const forasOc = () => avaliar(`[...document.querySelectorAll('.oc-page *:not(thead *)')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>0 && (r.right>window.innerWidth+1 || r.left<-1)}).slice(0,5).map(e=>e.className||e.tagName)`);
const valorDe = (sel) => avaliar(`document.querySelector(${JSON.stringify(sel)}).value`);
const rotulosPagina = () => avaliar(`[...document.querySelectorAll('[data-testid="paginacao"] button')].map(b=>({r:b.getAttribute('aria-label'), d:b.disabled, atual:b.getAttribute('aria-current')==='page'}))`);

// Responde por conta própria às requisições que casam com o padrão/método (a primeira, ou todas); o preflight passa
async function simular(padrao, metodo, status, corpo, todas = false) {
  let usadas = 0;
  const tratar = (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    if (request.method === 'OPTIONS' || request.method !== metodo || (!todas && usadas > 0)) return enviar('Fetch.continueRequest', { requestId }).catch(() => {});
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

// Altera o corpo JSON do POST antes de ir ao servidor (simula um cliente adulterado)
async function adulterarPost(padrao, transformar) {
  const tratar = (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    if (request.method !== 'POST') return enviar('Fetch.continueRequest', { requestId }).catch(() => {});
    const novo = JSON.stringify(transformar(JSON.parse(request.postData)));
    return enviar('Fetch.continueRequest', { requestId, postData: Buffer.from(novo).toString('base64') }).catch(() => {});
  };
  ouvintes.push(tratar);
  await enviar('Fetch.enable', { patterns: [{ urlPattern: padrao, requestStage: 'Request' }] });
  return async () => { await enviar('Fetch.disable').catch(() => {}); ouvintes.splice(ouvintes.indexOf(tratar), 1); };
}

const zerarFiltros = async () => { if (await existe('.oc-clear')) await acaoOc(() => clicarSel('.oc-clear')); };
const abrirFormulario = async () => { afirmar(await clicarSel('button[data-testid="nova-ocorrencia"]'), 'botão Nova ocorrência'); await esperar(`!!document.querySelector('[data-testid="nova-ocorrencia-form"]')`, 8000, 'formulário'); };
async function preencherFormulario({ titulo, descricao, tipo, local, estacao }) {
  if (titulo !== undefined) await digitar('#oc-titulo', titulo);
  if (descricao !== undefined) await digitar('#oc-descricao', descricao);
  if (tipo !== undefined) await selecionar('#oc-tipo', tipo);
  if (local !== undefined) await digitar('#oc-local', local);
  if (estacao !== undefined) await digitar('#oc-estacao', estacao);
}
const enviarFormulario = () => clicarSel('button[data-testid="registrar"]');
const errosDoForm = () => avaliar(`[...document.querySelectorAll('.oc-field-error')].map(e=>e.innerText.trim())`);

async function main() {
  realAntes = (await pool.query(`SELECT COUNT(*)::int n FROM ocorrencias WHERE titulo NOT LIKE '[TESTE]%'`)).rows[0].n;
  info('SETUP', `ocorrências reais no banco antes: ${realAntes} (as de teste têm título começando com "${PREFIXO.trim()}")`);
  await limparOc();

  // Campinas: 3 em aberto, 4 em andamento, 5 concluídas = 12 (3 páginas de 5); Osasco: 1 em aberto + 1 concluída
  const S = [
    { titulo: 'Piora do PM2.5 na região', tipo: 'POLUICAO', status: 'ABERTA', minutosAtras: 10, poluente: 'pm25', valor: 85.4, nivel: 'CRITICO', estacaoNome: 'Estação Teste Centro' },
    { titulo: 'Odor forte de queima', tipo: 'QUEIMADA', status: 'EM_ANDAMENTO', minutosAtras: 100, origem: 'MANUAL' },
    { titulo: 'Emissão industrial acima do esperado', tipo: 'EMISSAO', status: 'EM_ANDAMENTO', minutosAtras: 270, poluente: 'so2', valor: 62.3, nivel: 'ALTO' },
    { titulo: 'Níveis normalizados na estação', tipo: 'NORMALIZACAO', status: 'CONCLUIDA', minutosAtras: 410 },
    { titulo: 'Relato de poeira no bairro', tipo: 'COMUNIDADE', status: 'CONCLUIDA', minutosAtras: 1580, origem: 'MANUAL' },
    { titulo: 'Foco de incêndio detectado', tipo: 'QUEIMADA', status: 'ABERTA', minutosAtras: 2900 },
    { titulo: 'Fumaça em área de mata', tipo: 'QUEIMADA', status: 'EM_ANDAMENTO', minutosAtras: 4300, origem: 'MANUAL' },
    { titulo: 'Chaminé com emissão visível', tipo: 'EMISSAO', status: 'CONCLUIDA', minutosAtras: 6500 },
    { titulo: 'Ozônio acima do recomendado', tipo: 'POLUICAO', status: 'EM_ANDAMENTO', minutosAtras: 8700, poluente: 'o3', valor: 74.2, nivel: 'ALTO' },
    { titulo: 'Poeira de obra em via pública', tipo: 'COMUNIDADE', status: 'ABERTA', minutosAtras: 17300 },
    { titulo: 'Queima controlada em terreno', tipo: 'QUEIMADA', status: 'CONCLUIDA', minutosAtras: 26000 },
    { titulo: 'Material particulado antigo normalizado', tipo: 'NORMALIZACAO', status: 'CONCLUIDA', minutosAtras: 40 * 24 * 60 },
  ];
  for (const s of S) await semearOc({ ...s, cidade: 'Campinas' });
  await semearOc({ cidade: 'Osasco', titulo: 'Osasco em aberto', tipo: 'POLUICAO', status: 'ABERTA', minutosAtras: 30 });
  await semearOc({ cidade: 'Osasco', titulo: 'Osasco concluída', tipo: 'COMUNIDADE', status: 'CONCLUIDA', minutosAtras: 600, origem: 'MANUAL' });

  const admin = await novoUsuario('ADMIN', { cidade: 'Osasco' });
  const comum = await novoUsuario('USUARIO', { cidade: 'Osasco' });
  const chrome = await abrirChrome();
  console.log(`===== OccurrencesPage com API real (${chrome.versao}) =====`);
  try {
    console.log('\n--- ADMIN ---');
    await caso('OC01', 'ADMIN: lista real de Campinas, cards do banco e nenhum dado ilustrativo', async () => {
      const i0 = requisicoes.length;
      await loginPelaTela(admin.email, admin.senha);
      afirmar(await clicarMenu('Ocorrências'), 'item Ocorrências');
      await paginaOc();
      await acaoOc(() => selecionar('.oc-page select[aria-label="Cidade"]', 'Campinas'), 200);
      const c = await cartoesOc();
      afirmar(c.total === '12' && c.abertas === '3' && c.andamento === '4' && c.concluidas === '5', 'cartões: ' + JSON.stringify(c));
      const linhas = await linhasOc();
      const esperado = (await ordemDoBanco('Campinas')).slice(0, 5);
      afirmar(linhas.length === 5, 'linhas: ' + linhas.length);
      afirmar(linhas.every((l, i) => l.titulo === esperado[i].titulo), 'ordem diferente do banco: ' + linhas.map((l) => l.titulo).join(' | '));
      const faixa = await textoSel('[data-testid="faixa"]');
      afirmar(/Mostrando 1 a 5 de 12 ocorrências/.test(faixa), 'faixa: ' + faixa);
      const txt = await textoMain();
      afirmar(!/ilustrativ|exemplo de interface/i.test(txt), 'texto de dados ilustrativos ainda aparece');
      afirmar(!/Piora na qualidade do ar|Odor de queimadas|OC-0012/.test(txt), 'dado de protótipo ainda aparece');
      const lis = listagensOc(i0);
      afirmar(lis.some((r) => /cidade=Campinas/.test(r.url) && /limite=5/.test(r.url) && /pagina=1/.test(r.url) && r.status === 200), 'requisição de listagem: ' + lis.map((r) => r.url).slice(-2).join(' '));
      await foto('oc-admin-1366', 1366, 768);
      return `cartões ${JSON.stringify(c)}, ${faixa.trim()}`;
    });

    await caso('OC02', 'paginação real: páginas 1-3, sem repetir itens, botões anterior/próxima', async () => {
      const ordem = await ordemDoBanco('Campinas');
      const i0 = requisicoes.length;
      afirmar(await acaoOc(() => clicarSel('button[aria-label="Página 2"]')), 'botão página 2');
      let linhas = await linhasOc();
      afirmar(linhas.map((l) => l.titulo).join('|') === ordem.slice(5, 10).map((o) => o.titulo).join('|'), 'página 2: ' + linhas.map((l) => l.titulo).join(' | '));
      afirmar(/Mostrando 6 a 10 de 12/.test(await textoSel('[data-testid="faixa"]')), 'faixa da página 2');
      const p2 = await rotulosPagina();
      afirmar(p2.find((b) => b.r === 'Página 2')?.atual === true && p2.find((b) => b.r === 'Página anterior')?.d === false, 'página 2 atual e anterior habilitado');
      await acaoOc(() => clicarSel('button[aria-label="Próxima página"]'));
      linhas = await linhasOc();
      afirmar(linhas.length === 2 && linhas.map((l) => l.titulo).join('|') === ordem.slice(10).map((o) => o.titulo).join('|'), 'página 3: ' + linhas.map((l) => l.titulo).join(' | '));
      afirmar(/Mostrando 11 a 12 de 12/.test(await textoSel('[data-testid="faixa"]')), 'faixa da página 3');
      const p3 = await rotulosPagina();
      afirmar(p3.find((b) => b.r === 'Próxima página')?.d === true, 'próxima desabilitada na última página');
      afirmar(listagensOc(i0).some((r) => /pagina=3/.test(r.url)), 'requisição pagina=3');
      await acaoOc(() => clicarSel('button[aria-label="Página anterior"]'));
      await acaoOc(() => clicarSel('button[aria-label="Página 1"]'));
      afirmar((await linhasOc())[0].titulo === ordem[0].titulo, 'voltou para a página 1');
    });

    await caso('OC03', 'filtros no servidor: cartão de status, tipo, período, combinação e limpar', async () => {
      const i0 = requisicoes.length;
      await acaoOc(() => clicarSel('[data-testid="resumo-abertas"]'));
      let linhas = await linhasOc();
      afirmar(linhas.length === 3 && linhas.every((l) => l.status === 'Em aberto'), 'status ABERTA: ' + JSON.stringify(linhas.map((l) => l.status)));
      afirmar(listagensOc(i0).some((r) => /status=ABERTA/.test(r.url) && r.status === 200), 'requisição com status=ABERTA');
      const c = await cartoesOc();
      afirmar(c.total === '12' && c.abertas === '3' && c.andamento === '4' && c.concluidas === '5', 'cartões mudaram ao filtrar status: ' + JSON.stringify(c));
      afirmar(/3 ocorrências encontradas/.test(await textoSel('[data-testid="contagem-filtrada"]')), 'contagem filtrada');
      await acaoOc(() => selecionar('.oc-page select[aria-label="Tipo"]', 'QUEIMADA'));
      linhas = await linhasOc();
      const esperadoQ = await contarOc('Campinas', `AND status = 'ABERTA' AND tipo = 'QUEIMADA'`);
      afirmar(linhas.length === esperadoQ && linhas.every((l) => l.tipo === 'Queimada'), `status+tipo: ${linhas.length} esperado ${esperadoQ}`);
      afirmar(listagensOc(i0).some((r) => /status=ABERTA/.test(r.url) && /tipo=QUEIMADA/.test(r.url)), 'requisição com status e tipo');
      await acaoOc(() => clicarSel('[data-testid="resumo-total"]'));
      const cTipo = await cartoesOc();
      const totTipo = await contarOc('Campinas', `AND tipo = 'QUEIMADA'`);
      afirmar(Number(cTipo.total) === totTipo, `cartão total com tipo=QUEIMADA: ${cTipo.total} esperado ${totTipo}`);
      await acaoOc(() => selecionar('.oc-page select[aria-label="Tipo"]', 'TODOS'));
      await acaoOc(() => selecionar('.oc-page select[aria-label="Período"]', '7D'));
      const de = diaSP(new Date(Date.now() - 6 * 24 * 3600 * 1000));
      const esperado7 = await contarOc('Campinas', `AND criado_em >= (($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo')`, [de]);
      const cPer = await cartoesOc();
      afirmar(Number(cPer.total) === esperado7 && esperado7 < 12, `período 7 dias: cartão ${cPer.total}, esperado ${esperado7}`);
      afirmar(listagensOc(i0).some((r) => new RegExp(`de=${de}`).test(r.url) && /ate=/.test(r.url)), 'requisição com de/ate');
      await acaoOc(() => selecionar('.oc-page select[aria-label="Período"]', 'HOJE'));
      const esperadoHoje = await contarOc('Campinas', `AND criado_em >= (($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo')`, [diaSP(new Date())]);
      afirmar(Number((await cartoesOc()).total) === esperadoHoje, 'período hoje');
      await acaoOc(() => clicarSel('.oc-clear'));
      afirmar((await cartoesOc()).total === '12' && (await linhasOc()).length === 5, 'Limpar filtros restaura a lista');
      afirmar(!(await existe('.oc-clear')), 'botão limpar some sem filtros');
    });

    await caso('OC04', 'busca por texto (sem acento/maiúsculas), debounce e estado "nenhum resultado"', async () => {
      const i0 = requisicoes.length;
      await digitar('input[aria-label="Buscar ocorrências"]', 'FUMACA');
      await dormir(900); await esperarListaOc();
      const linhas = await linhasOc();
      afirmar(linhas.length === 1 && /Fumaça em área de mata/.test(linhas[0].titulo), 'busca FUMACA: ' + JSON.stringify(linhas.map((l) => l.titulo)));
      const reqs = listagensOc(i0).filter((r) => /busca=FUMACA/.test(r.url));
      afirmar(reqs.length === 1 && reqs[0].status === 200, 'uma única requisição com busca=FUMACA: ' + reqs.length);
      afirmar(/1 ocorrência encontrada/.test(await textoSel('[data-testid="contagem-filtrada"]')), 'contagem singular');
      await digitar('input[aria-label="Buscar ocorrências"]', 'zzzz-nada');
      await dormir(900); await esperarListaOc();
      afirmar(await existe('[data-testid="estado-vazio"]'), 'sem estado vazio');
      afirmar(/Nenhuma ocorrência encontrada/.test(await textoSel('[data-testid="estado-vazio"]')), 'mensagem do estado vazio');
      afirmar(await acaoOc(() => clicarSel('.oc-clear')), 'limpar');
      afirmar(await valorDe('input[aria-label="Buscar ocorrências"]') === '' && (await linhasOc()).length === 5, 'busca limpa');
      await digitar('input[aria-label="Buscar ocorrências"]', 'poeira');
      await dormir(900); await esperarListaOc();
      const n = await pool.query(`SELECT COUNT(*)::int n FROM ocorrencias WHERE cidade='Campinas' AND (lower(titulo) LIKE '%poeira%' OR lower(descricao) LIKE '%poeira%')`);
      afirmar((await linhasOc()).length === n.rows[0].n, 'busca poeira (título/descrição)');
      await acaoOc(() => clicarSel('.oc-clear'));
    });

    await caso('OC05', 'painel lateral: detalhes reais, dados do momento, linha do tempo, GET por ID e Esc', async () => {
      const i0 = requisicoes.length;
      afirmar(await abrirLinha(0), 'linha 0');
      await esperarDetalhe();
      await dormir(300);
      const t = await detalheOc();
      afirmar(/Piora do PM2\.5 na região/.test(t) && /OC-\d{4}/.test(t), 'título/ID: ' + t.slice(0, 80));
      afirmar(/Dados do Momento/.test(t) && /PM2\.5/.test(t) && /85/.test(t) && /Cr[ií]tico/i.test(t), 'dados do momento');
      afirmar(/Registrada/.test(t) && /Pendente/.test(t) && /Registro automático/.test(t), 'linha do tempo/origem');
      afirmar(/Estação Teste Centro/.test(t), 'estação');
      afirmar((await existe('[data-testid="iniciar"]')) && (await existe('[data-testid="concluir"]')), 'ações de ADMIN');
      for (let k = 0; k < 40 && !chamadasOc(i0).some((r) => /\/api\/ocorrencias\/\d+$/.test(r.url) && r.status === 200); k++) await dormir(150);
      afirmar(chamadasOc(i0).some((r) => /\/api\/ocorrencias\/\d+$/.test(r.url) && r.status === 200), 'GET /api/ocorrencias/:id: ' + JSON.stringify(chamadasOc(i0).map((r) => [r.method, r.url.split('/api')[1], r.status])));
      await foto('oc-admin-detalhe-1366', 1366, 768);
      await tecla('Escape', 'Escape', 27); await dormir(200);
      afirmar(!(await existe('[data-testid="ocorrencia-detalhe"]')), 'Esc não fechou o painel');
      afirmar(await abrirLinha(2), 'linha 2'); await esperarDetalhe();
      const t2 = await detalheOc();
      afirmar(!/Dados do Momento/.test(t2) || /Emissão industrial/.test(t2), 'detalhe da linha 2');
      await fecharDetalhe();
      // ocorrência manual sem leitura ambiental: sem bloco de dados do momento
      await acaoOc(() => selecionar('.oc-page select[aria-label="Tipo"]', 'COMUNIDADE'));
      const idxManual = (await linhasOc()).findIndex((l) => /Relato de poeira/.test(l.titulo));
      afirmar(idxManual >= 0 && await abrirLinha(idxManual), 'linha comunidade manual'); await esperarDetalhe();
      const t3 = await detalheOc();
      afirmar(!/Dados do Momento/.test(t3) && /Registro manual/.test(t3), 'manual sem dados do momento: ' + t3.slice(0, 120));
      await fecharDetalhe();
      await acaoOc(() => clicarSel('.oc-clear'));
    });

    await caso('OC06', 'ADMIN altera status: ABERTA → EM_ANDAMENTO → CONCLUIDA e ABERTA → CONCLUIDA direto', async () => {
      await zerarFiltros();
      const i0 = requisicoes.length;
      const abertas = await ordemDoBanco('Campinas', `AND status = 'ABERTA'`);
      const [a, b] = [abertas[0], abertas[1]];
      afirmar(await abrirLinha(0), 'linha da primeira ABERTA'); await esperarDetalhe();
      afirmar((await detalheOc()).includes(a.titulo.replace(PREFIXO, '')), 'primeira linha é a mais recente em aberto');
      afirmar(await clicarSel('[data-testid="iniciar"]'), 'iniciar');
      await esperar(`/Em andamento/.test(document.querySelector('[data-testid="ocorrencia-detalhe"]')?.innerText ?? '') && !document.querySelector('[data-testid="iniciar"]')`, 10000, 'status em andamento');
      let linha = await linhaDoBanco(a.id);
      afirmar(linha.status === 'EM_ANDAMENTO' && linha.iniciado_em && !linha.concluido_em, 'banco após iniciar: ' + linha.status);
      afirmar(/atualizada: Em andamento/.test(await textoSel('[data-testid="aviso"]')), 'aviso de sucesso');
      afirmar(chamadasOc(i0, 'PATCH').some((r) => r.status === 200 && new RegExp(`/ocorrencias/${a.id}/status`).test(r.url)), 'PATCH 200');
      afirmar(await clicarSel('[data-testid="concluir"]'), 'concluir');
      await esperar(`!!document.querySelector('[data-testid="confirmar-concluir"]')`, 5000, 'confirmação');
      afirmar(/não pode ser reaberta/.test(await detalheOc()), 'texto da confirmação');
      afirmar(await clicarSel('[data-testid="confirmar-concluir"]'), 'confirmar');
      await esperar(`/Concluída/.test(document.querySelector('[data-testid="ocorrencia-detalhe"]')?.innerText ?? '') && !document.querySelector('[data-testid="acoes-status"]')`, 10000, 'status concluída');
      linha = await linhaDoBanco(a.id);
      afirmar(linha.status === 'CONCLUIDA' && linha.concluido_em && linha.iniciado_em, 'banco após concluir');
      afirmar(/Concluída/.test(await detalheOc()) && !/Pendente/.test(await detalheOc()), 'linha do tempo completa');
      await fecharDetalhe(); await dormir(300); await esperarListaOc();
      let c = await cartoesOc();
      afirmar(c.abertas === '2' && c.andamento === '4' && c.concluidas === '6', 'cartões após as mudanças: ' + JSON.stringify(c));
      // conclusão direta da segunda
      await acaoOc(() => clicarSel('[data-testid="resumo-abertas"]'));
      afirmar((await linhasOc()).length === 2, 'duas em aberto restantes');
      afirmar(await abrirLinha(0), 'linha'); await esperarDetalhe();
      afirmar((await detalheOc()).includes(b.titulo.replace(PREFIXO, '')), 'segunda em aberto');
      afirmar(await clicarSel('[data-testid="concluir"]'), 'concluir direto');
      afirmar(await clicarSel('[data-testid="confirmar-concluir"]'), 'confirmar direto');
      await esperar(`!document.querySelector('[data-testid="acoes-status"]') && /Concluída/.test(document.querySelector('[data-testid="ocorrencia-detalhe"]')?.innerText ?? '')`, 10000, 'concluída direta');
      linha = await linhaDoBanco(b.id);
      afirmar(linha.status === 'CONCLUIDA' && linha.concluido_em && !linha.iniciado_em, 'banco após conclusão direta');
      await fecharDetalhe(); await dormir(300); await esperarListaOc();
      afirmar((await linhasOc()).length === 1, 'com o filtro "Em aberto" sobrou 1 (a lista foi atualizada)');
      // cancelar a confirmação não altera nada
      await acaoOc(() => clicarSel('[data-testid="resumo-andamento"]'));
      afirmar(await abrirLinha(0), 'linha em andamento'); await esperarDetalhe();
      afirmar(!(await existe('[data-testid="iniciar"]')) && (await existe('[data-testid="concluir"]')), 'em andamento só oferece concluir');
      const emAndamento = (await ordemDoBanco('Campinas', `AND status = 'EM_ANDAMENTO'`))[0];
      await clicarSel('[data-testid="concluir"]');
      afirmar(await avaliar(`(()=>{const b=[...document.querySelectorAll('[data-testid="acoes-status"] button')].find(x=>x.innerText.trim()==='Cancelar'); if(!b) return false; b.click(); return true})()`), 'cancelar');
      await dormir(200);
      afirmar((await existe('[data-testid="concluir"]')) && (await linhaDoBanco(emAndamento.id)).status === 'EM_ANDAMENTO', 'cancelar mantém o status');
      await fecharDetalhe();
      await acaoOc(() => clicarSel('[data-testid="resumo-total"]'));
      return 'PATCH 200 em todas as mudanças';
    });

    await caso('OC07', 'conflito 409: status mudou por outra pessoa; a tela mostra o estado atual', async () => {
      await zerarFiltros();
      await acaoOc(() => clicarSel('[data-testid="resumo-abertas"]'));
      afirmar(await abrirLinha(0), 'linha em aberto'); await esperarDetalhe();
      const alvo = (await ordemDoBanco('Campinas', `AND status = 'ABERTA'`))[0];
      await pool.query(`UPDATE ocorrencias SET status = 'CONCLUIDA', concluido_em = NOW(), atualizado_em = NOW() WHERE id = $1`, [alvo.id]);
      const i0 = requisicoes.length;
      afirmar(await clicarSel('[data-testid="iniciar"]'), 'iniciar');
      await esperar(`!!document.querySelector('[data-testid="erro-status"]')`, 10000, 'mensagem de conflito');
      afirmar(chamadasOc(i0, 'PATCH').some((r) => r.status === 409), 'PATCH respondeu 409: ' + chamadasOc(i0, 'PATCH').map((r) => r.status));
      afirmar(/já havia sido alterado/.test(await textoSel('[data-testid="erro-status"]')), 'mensagem de 409');
      const t = await detalheOc();
      afirmar(/Concluída/.test(t) && !(await existe('[data-testid="acoes-status"]')), 'painel mostra o estado atual (concluída, sem ações)');
      afirmar((await linhaDoBanco(alvo.id)).status === 'CONCLUIDA', 'banco inalterado pela tentativa');
      await fecharDetalhe();
      await acaoOc(() => clicarSel('[data-testid="resumo-total"]'));
    });

    await caso('OC08', '404 ao alterar: ocorrência removida enquanto o painel estava aberto', async () => {
      await zerarFiltros();
      await acaoOc(() => clicarSel('[data-testid="resumo-andamento"]'));
      afirmar(await abrirLinha(0), 'linha'); await esperarDetalhe();
      const alvo = (await ordemDoBanco('Campinas', `AND status = 'EM_ANDAMENTO'`))[0];
      const antes = await contarOc('Campinas');
      await pool.query('DELETE FROM ocorrencias WHERE id = $1', [alvo.id]);
      await clicarSel('[data-testid="concluir"]');
      afirmar(await clicarSel('[data-testid="confirmar-concluir"]'), 'confirmar');
      await esperar(`!document.querySelector('[data-testid="ocorrencia-detalhe"]') && !!document.querySelector('[data-testid="aviso"]')`, 10000, 'painel fechado e aviso');
      afirmar(/não encontrada/i.test(await textoSel('[data-testid="aviso"]')), 'aviso de 404: ' + await textoSel('[data-testid="aviso"]'));
      await dormir(300); await esperarListaOc();
      afirmar((await linhasOc()).every((l) => !l.titulo.includes(alvo.titulo.replace(PREFIXO, ''))), 'item removido some da lista');
      afirmar(antes - 1 === await contarOc('Campinas'), 'contagem do banco');
      await acaoOc(() => clicarSel('[data-testid="resumo-total"]'));
    });

    await caso('OC09', 'erros simulados: 500 na lista (com nova tentativa), 404 no GET por ID, 403 e 500 no PATCH', async () => {
      // 500 na listagem
      let parar = await simular('*/api/ocorrencias?*', 'GET', 500, { error: 'falha' });
      await acaoOc(() => selecionar('.oc-page select[aria-label="Tipo"]', 'EMISSAO'));
      afirmar(await existe('[data-testid="estado-erro"]'), 'sem estado de erro');
      afirmar(/Não foi possível carregar as ocorrências/.test(await textoSel('[data-testid="estado-erro"]')), 'texto do erro');
      afirmar((await avaliar(`document.querySelectorAll('[data-testid="ocorrencia"]').length`)) === 0, 'tabela some no erro');
      await parar();
      afirmar(await acaoOc(() => clicarSel('[data-testid="estado-erro"] button')), 'tentar novamente');
      afirmar((await linhasOc()).every((l) => l.tipo === 'Emissão') && (await linhasOc()).length > 0, 'nova tentativa recarregou');
      await acaoOc(() => selecionar('.oc-page select[aria-label="Tipo"]', 'TODOS'));
      // 404 no GET por ID: o painel fecha e avisa
      parar = await simular('*/api/ocorrencias/*', 'GET', 404, { error: 'Ocorrência não encontrada' });
      afirmar(await abrirLinha(0), 'linha');
      await esperar(`!document.querySelector('[data-testid="ocorrencia-detalhe"]') && !!document.querySelector('[data-testid="aviso"]')`, 8000, 'painel fecha ao receber 404');
      afirmar(/não encontrada/i.test(await textoSel('[data-testid="aviso"]')), 'aviso do 404');
      await parar();
      await esperarListaOc();
      // 403 no PATCH (semeia uma em aberto: as do cenário já foram concluídas nos casos anteriores)
      await semearOc({ cidade: 'Campinas', titulo: 'Em aberto para erro 403', tipo: 'EMISSAO', status: 'ABERTA', minutosAtras: 1 });
      await acaoOc(() => clicarSel('[data-testid="resumo-total"]'));
      const abertas = await ordemDoBanco('Campinas', `AND status = 'ABERTA'`);
      afirmar(abertas.length > 0, 'sem ocorrência em aberto para o teste');
      await acaoOc(() => clicarSel('[data-testid="resumo-abertas"]'));
      afirmar(await abrirLinha(0), 'linha aberta'); await esperarDetalhe();
      parar = await simular('*/api/ocorrencias/*/status', 'PATCH', 403, { error: 'Acesso restrito a administradores' });
      await clicarSel('[data-testid="iniciar"]');
      await esperar(`!!document.querySelector('[data-testid="erro-status"]')`, 8000, 'erro 403');
      afirmar(/Acesso restrito/.test(await textoSel('[data-testid="erro-status"]')), '403: ' + await textoSel('[data-testid="erro-status"]'));
      afirmar((await existe('[data-testid="iniciar"]')) && (await linhaDoBanco(abertas[0].id)).status === 'ABERTA', '403 mantém o painel e o status');
      await parar();
      parar = await simular('*/api/ocorrencias/*/status', 'PATCH', 500, { error: 'falha' });
      await clicarSel('[data-testid="iniciar"]');
      await esperar(`/Não foi possível alterar o status/.test(document.querySelector('[data-testid="erro-status"]')?.innerText ?? '')`, 8000, 'erro 500');
      await parar();
      await fecharDetalhe();
      await acaoOc(() => clicarSel('[data-testid="resumo-total"]'));
    });

    await caso('OC10', 'ADMIN cria ocorrência manual: validação do formulário, POST 201 e lista atualizada', async () => {
      const i0 = requisicoes.length;
      await abrirFormulario();
      const t0 = await textoSel('[data-testid="nova-ocorrencia-detalhe"]');
      afirmar(/Nova ocorrência/.test(t0) && /Campinas/.test(t0), 'cabeçalho do formulário');
      await enviarFormulario(); await dormir(200);
      const erros = await errosDoForm();
      afirmar(erros.length === 4, 'erros de campo obrigatório: ' + JSON.stringify(erros));
      afirmar(chamadasOc(i0, 'POST').length === 0, 'POST não deve sair com campos inválidos');
      await preencherFormulario({ titulo: PREFIXO + 'Nova pelo admin', descricao: 'Fumaça vista perto da estação de teste.', tipo: 'COMUNIDADE', local: 'Campinas - Centro', estacao: 'Estação UI Teste' });
      await foto('oc-form-1366', 1366, 768);
      afirmar(await enviarFormulario(), 'registrar');
      await esperar(`!document.querySelector('[data-testid="nova-ocorrencia-form"]') && !!document.querySelector('[data-testid="aviso"]')`, 10000, 'formulário fechado com aviso');
      afirmar(/registrada com sucesso/.test(await textoSel('[data-testid="aviso"]')), 'aviso de sucesso');
      afirmar(chamadasOc(i0, 'POST').some((r) => r.status === 201), 'POST 201');
      await dormir(300); await esperarListaOc();
      const linhas = await linhasOc();
      afirmar(linhas[0].titulo === PREFIXO + 'Nova pelo admin' && linhas[0].status === 'Em aberto', 'nova no topo da lista: ' + JSON.stringify(linhas[0]));
      const r = (await pool.query(`SELECT * FROM ocorrencias WHERE titulo = $1`, [PREFIXO + 'Nova pelo admin'])).rows;
      afirmar(r.length === 1 && r[0].origem === 'MANUAL' && r[0].status === 'ABERTA' && r[0].cidade === 'Campinas' && r[0].usuario_id === admin.id && r[0].estacao_nome === 'Estação UI Teste' && r[0].tipo === 'COMUNIDADE', 'registro no banco: ' + JSON.stringify(r[0]));
      afirmar(await abrirLinha(0), 'abrir a nova'); await esperarDetalhe();
      afirmar(/Registro manual/.test(await detalheOc()) && /Estação UI Teste/.test(await detalheOc()), 'detalhe da nova');
      await fecharDetalhe();
    });

    await caso('OC11', 'erros do formulário: 400, 403 e 500 do servidor mantêm o formulário aberto e os dados digitados', async () => {
      await abrirFormulario();
      await preencherFormulario({ titulo: PREFIXO + 'Erro simulado', descricao: 'Descrição para o teste de erro.', tipo: 'QUEIMADA', local: 'Centro' });
      for (const [status, corpo, regex] of [[400, { error: '"titulo" é inválido' }, /Dados inválidos: "titulo" é inválido/], [403, { error: 'Você só pode registrar ocorrências na sua cidade' }, /Você só pode registrar/], [500, { error: 'x' }, /Não foi possível registrar/]]) {
        const parar = await simular('*/api/ocorrencias', 'POST', status, corpo);
        await enviarFormulario();
        await esperar(`!!document.querySelector('[data-testid="erro-formulario"]')`, 8000, `erro ${status}`);
        afirmar(regex.test(await textoSel('[data-testid="erro-formulario"]')), `${status}: ` + await textoSel('[data-testid="erro-formulario"]'));
        afirmar(await valorDe('#oc-titulo') === PREFIXO + 'Erro simulado' && await valorDe('#oc-tipo') === 'QUEIMADA', `${status}: dados digitados mantidos`);
        await parar();
        await avaliar(`document.querySelector('[data-testid="erro-formulario"]') && true`);
      }
      afirmar((await pool.query(`SELECT COUNT(*)::int n FROM ocorrencias WHERE titulo = $1`, [PREFIXO + 'Erro simulado'])).rows[0].n === 0, 'nada foi gravado nos erros simulados');
      await avaliar(`[...document.querySelectorAll('.oc-form-actions button')].find(b=>b.innerText.trim()==='Cancelar').click()`);
      await dormir(200);
      afirmar(!(await existe('[data-testid="nova-ocorrencia-form"]')), 'Cancelar fecha o formulário');
    });

    await caso('OC12', 'estados vazio e carregando: São Paulo sem ocorrências; lista retida mostra "Carregando"', async () => {
      await acaoOc(() => selecionar('.oc-page select[aria-label="Cidade"]', 'São Paulo'), 200);
      afirmar(/Nenhuma ocorrência registrada para esta região/.test(await textoSel('[data-testid="estado-vazio"]')), 'mensagem de lista vazia');
      const c = await cartoesOc();
      afirmar(c.total === '0' && c.abertas === '0' && c.andamento === '0' && c.concluidas === '0', 'cartões zerados: ' + JSON.stringify(c));
      afirmar(!(await existe('[data-testid="barra"]')) && !(await existe('[data-testid="paginacao"]')) && !(await existe('.oc-table')), 'sem barra, paginação e tabela');
      afirmar(!!(await existe('button[data-testid="nova-ocorrencia"]')), 'botão Nova ocorrência continua disponível');
      const liberar = await interceptar('*/api/ocorrencias?*', 'segurar');
      await selecionar('.oc-page select[aria-label="Cidade"]', 'Osasco');
      await esperar(`!!document.querySelector('[data-testid="carregando"]')`, 6000, 'estado carregando');
      afirmar(/Carregando ocorrências/.test(await textoSel('[data-testid="carregando"]')) && (await textoSel('[data-testid="resumo-total"]')).includes('–'), 'texto de carregando e cartões "–"');
      await liberar();
      await esperarListaOc();
      afirmar((await linhasOc()).length === 2, 'Osasco carregou 2 ocorrências');
    });

    await caso('OC13', '401: token recusado pela API encerra a sessão e volta ao Login', async () => {
      const parar = await simular('*/api/ocorrencias?*', 'GET', 401, { error: 'Token inválido' });
      await selecionar('.oc-page select[aria-label="Cidade"]', 'Campinas');
      await esperarLogin(10000);
      afirmar(await guardado('authToken') === null, 'token ainda guardado');
      await parar();
    });

    console.log('\n--- USUARIO ---');
    await caso('OC20', 'USUARIO: vê só a própria cidade, sem seletor, sem ações de status', async () => {
      const i0 = requisicoes.length;
      await loginPelaTela(comum.email, comum.senha);
      afirmar(await clicarMenu('Ocorrências'), 'item Ocorrências');
      await paginaOc(); await esperarListaOc();
      afirmar(!(await existe('.oc-page select[aria-label="Cidade"]')) && /Osasco/.test(await textoSel('.page-city-fixed')), 'cidade fixa Osasco');
      const linhas = await linhasOc();
      afirmar(linhas.length === 2 && linhas.every((l) => /Osasco/.test(l.titulo)), 'linhas: ' + JSON.stringify(linhas.map((l) => l.titulo)));
      const c = await cartoesOc();
      afirmar(c.total === '2' && c.abertas === '1' && c.concluidas === '1', 'cartões: ' + JSON.stringify(c));
      const lis = listagensOc(i0);
      afirmar(lis.length > 0 && lis.every((r) => /cidade=Osasco/.test(r.url)) && !lis.some((r) => /Campinas/.test(r.url)), 'só consulta Osasco: ' + lis.map((r) => r.url).join(' '));
      afirmar(await existe('button[data-testid="nova-ocorrencia"]'), 'botão Nova ocorrência para USUARIO');
      afirmar(await abrirLinha(0), 'linha'); await esperarDetalhe();
      const t = await detalheOc();
      afirmar(!(await existe('[data-testid="acoes-status"]')) && !(await existe('[data-testid="iniciar"]')) && !(await existe('[data-testid="concluir"]')), 'USUARIO não vê botões de status');
      afirmar(/Somente administradores alteram o status/.test(t), 'aviso de permissão');
      afirmar(chamadasOc(i0, 'PATCH').length === 0, 'nenhum PATCH enviado');
      await foto('oc-usuario-detalhe-1366', 1366, 768);
      await fecharDetalhe();
      const filtrado = await acaoOc(() => clicarSel('[data-testid="resumo-abertas"]'));
      afirmar((await linhasOc()).length === 1, 'filtro por status do USUARIO');
      await acaoOc(() => clicarSel('[data-testid="resumo-total"]'));
    });

    await caso('OC21', 'USUARIO cria ocorrência manual na própria cidade', async () => {
      const i0 = requisicoes.length;
      await abrirFormulario();
      afirmar(/Osasco/.test(await textoSel('[data-testid="nova-ocorrencia-detalhe"]')), 'formulário mostra a cidade');
      await preencherFormulario({ titulo: PREFIXO + 'Nova pelo usuário', descricao: 'Cheiro forte de fumaça na rua.', tipo: 'QUEIMADA', local: 'Osasco - Centro' });
      afirmar(await enviarFormulario(), 'registrar');
      await esperar(`!document.querySelector('[data-testid="nova-ocorrencia-form"]') && !!document.querySelector('[data-testid="aviso"]')`, 10000, 'formulário fechado');
      afirmar(chamadasOc(i0, 'POST').some((r) => r.status === 201), 'POST 201');
      await dormir(300); await esperarListaOc();
      const linhas = await linhasOc();
      afirmar(linhas[0].titulo === PREFIXO + 'Nova pelo usuário' && linhas.length === 3, 'lista com a nova: ' + JSON.stringify(linhas.map((l) => l.titulo)));
      const r = (await pool.query(`SELECT * FROM ocorrencias WHERE titulo = $1`, [PREFIXO + 'Nova pelo usuário'])).rows;
      afirmar(r.length === 1 && r[0].origem === 'MANUAL' && r[0].status === 'ABERTA' && r[0].cidade === 'Osasco' && r[0].usuario_id === comum.id && r[0].estacao_nome === null, 'registro no banco: ' + JSON.stringify(r[0]));
      const c = await cartoesOc();
      afirmar(c.total === '3' && c.abertas === '2', 'cartões atualizados: ' + JSON.stringify(c));
    });

    await caso('OC22', 'USUARIO não consegue registrar em outra cidade nem alterar status (servidor responde 403)', async () => {
      const parar = await adulterarPost('*/api/ocorrencias', (c) => ({ ...c, cidade: 'Campinas' }));
      await abrirFormulario();
      await preencherFormulario({ titulo: PREFIXO + 'Em outra cidade', descricao: 'Tentativa de registrar fora da cidade.', tipo: 'EMISSAO', local: 'Centro' });
      const i0 = requisicoes.length;
      await enviarFormulario();
      await esperar(`!!document.querySelector('[data-testid="erro-formulario"]')`, 8000, 'erro 403');
      await parar();
      afirmar(chamadasOc(i0, 'POST').some((r) => r.status === 403), 'POST 403');
      afirmar(/sua cidade/i.test(await textoSel('[data-testid="erro-formulario"]')), 'mensagem: ' + await textoSel('[data-testid="erro-formulario"]'));
      afirmar((await pool.query(`SELECT COUNT(*)::int n FROM ocorrencias WHERE titulo = $1`, [PREFIXO + 'Em outra cidade'])).rows[0].n === 0, 'nada gravado');
      await avaliar(`[...document.querySelectorAll('.oc-form-actions button')].find(b=>b.innerText.trim()==='Cancelar').click()`);
      await dormir(200);
      // PATCH direto com o token do USUARIO: 403 (a tela nem oferece o botão)
      const token = await guardado('authToken');
      const alvo = (await ordemDoBanco('Osasco', `AND status = 'ABERTA'`))[0];
      const r = await fetch(`${API}/ocorrencias/${alvo.id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ status: 'CONCLUIDA' }) });
      afirmar(r.status === 403 && (await linhaDoBanco(alvo.id)).status === 'ABERTA', 'PATCH como USUARIO: ' + r.status);
    });

    console.log('\n--- Responsivo ---');
    await caso('RS01', 'ADMIN em 1366, 768 e 390 px: sem rolagem horizontal; lista, painel e formulário dentro da tela', async () => {
      await loginPelaTela(admin.email, admin.senha);
      afirmar(await clicarMenu('Ocorrências'), 'menu'); await paginaOc();
      await acaoOc(() => selecionar('.oc-page select[aria-label="Cidade"]', 'Campinas'), 200);
      const resumoPorLargura = [];
      for (const [w, h] of [[1366, 768], [768, 1024], [390, 844]]) {
        if (w === 1366) await limparMetricas(); else await metricasMobile(w, h);
        await dormir(300);
        const s = await sobraHorizontal();
        const fora = await forasOc();
        afirmar(s <= 0 && fora.length === 0, `${w}px lista: overflow ${s}px; fora: ${fora.join(',')}`);
        const modo = await avaliar(`getComputedStyle(document.querySelector('.oc-table thead')).position`);
        await foto(`oc-admin-lista-${w}`, w, h, w < 1366);
        afirmar(await abrirLinha(0), `${w}px: abrir linha`); await esperarDetalhe(); await dormir(250);
        const d = await avaliar(`(()=>{const r=document.querySelector('[data-testid="ocorrencia-detalhe"]').getBoundingClientRect(); return r.left>=-1 && r.right<=window.innerWidth+1})()`);
        afirmar(d && (await sobraHorizontal()) <= 0, `${w}px: painel fora da tela`);
        const botoes = await avaliar(`[...document.querySelectorAll('[data-testid="ocorrencia-detalhe"] button')].filter(b=>b.getBoundingClientRect().width>0).every(b=>{const r=b.getBoundingClientRect(); return r.left>=-1 && r.right<=window.innerWidth+1})`);
        afirmar(botoes, `${w}px: botão do painel fora da tela`);
        await foto(`oc-admin-detalhe-${w}`, w, h, w < 1366);
        await fecharDetalhe();
        await abrirFormulario(); await dormir(250);
        const f = await avaliar(`(()=>{const r=document.querySelector('[data-testid="nova-ocorrencia-detalhe"]').getBoundingClientRect(); return r.left>=-1 && r.right<=window.innerWidth+1})()`);
        afirmar(f && (await sobraHorizontal()) <= 0, `${w}px: formulário fora da tela`);
        await enviarFormulario(); await dormir(200);
        afirmar((await errosDoForm()).length === 4, `${w}px: erros do formulário`);
        await foto(`oc-form-${w}`, w, h, w < 1366);
        await avaliar(`document.querySelector('.detail-close').click()`); await dormir(200);
        resumoPorLargura.push(`${w}px ok (cabeçalho da tabela: ${modo})`);
      }
      await limparMetricas();
      return resumoPorLargura.join('; ');
    });

    await caso('RS02', 'USUARIO em 390 px: lista sem rolagem horizontal e botão "Nova ocorrência" na largura toda', async () => {
      await loginPelaTela(comum.email, comum.senha);
      afirmar(await clicarMenu('Ocorrências'), 'menu'); await paginaOc(); await esperarListaOc();
      await metricasMobile(390, 844); await dormir(300);
      const s = await sobraHorizontal(); const fora = await forasOc();
      afirmar(s <= 0 && fora.length === 0, `390px: overflow ${s}px; fora: ${fora.join(',')}`);
      const larg = await avaliar(`document.querySelector('button[data-testid="nova-ocorrencia"]').getBoundingClientRect().width`);
      afirmar(larg > 300, 'botão estreito: ' + larg);
      await foto('oc-usuario-lista-390', 390, 844, true);
      await limparMetricas();
    });

    console.log('\n--- Regressão ---');
    await caso('RG01', 'regressão: Dashboard, Alertas e volta para Ocorrências', async () => {
      afirmar(await clicarMenu('Dashboard'), 'Dashboard'); await esperarDashboard();
      afirmar(await clicarMenu('Alertas'), 'Alertas');
      await esperar(`!!document.querySelector('.alerts-page h1')`, 15000, 'tela de Alertas');
      afirmar(await clicarMenu('Ocorrências'), 'Ocorrências'); await paginaOc(); await esperarListaOc();
      afirmar((await linhasOc()).length > 0, 'lista vazia ao voltar');
    });
    await caso('ZZ01', 'nenhum erro de JavaScript não tratado', async () => {
      afirmar(errosDePagina.length === 0, 'erros JS: ' + errosDePagina.slice(0, 3).join(' | '));
    });
    await caso('ZZ02', 'nenhuma resposta 5xx real do servidor nas chamadas da tela (os 500 simulados não contam)', async () => {
      const f = requisicoes.filter((r) => typeof r.status === 'number' && r.status >= 500 && !/ocorrencias/.test(r.url));
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
  await limparOc().catch((e) => console.log('falha ao limpar ocorrências: ' + e.message));
  await limparUsuariosDeTeste().catch(() => {});
  const restUsuarios = await pool.query(`SELECT COUNT(*)::int n FROM usuarios WHERE email LIKE 'tmp.val.%@example.com'`).then((r) => r.rows[0].n).catch(() => '?');
  const restOc = await pool.query(`SELECT COUNT(*)::int n FROM ocorrencias WHERE titulo LIKE '[TESTE]%'`).then((r) => r.rows[0].n).catch(() => '?');
  const totalOc = await pool.query(`SELECT COUNT(*)::int n FROM ocorrencias`).then((r) => r.rows[0].n).catch(() => '?');
  await pool.end().catch(() => {});
  const ok = resultados.filter((r) => r.ok).length;
  console.log(`\nResumo: ${ok} aprovado(s), ${resultados.length - ok} reprovado(s) de ${resultados.length}. Usuários temporários restantes: ${restUsuarios}. Ocorrências de teste restantes: ${restOc} (total de ocorrências no banco: ${totalOc}; reais antes: ${realAntes}).`);
  console.log(`Prints em: ${SHOTS}`);
  process.exitCode = ok === resultados.length ? 0 : 1;
}
