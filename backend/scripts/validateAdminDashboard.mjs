// Validação do Dashboard Admin, das permissões e da sessão (Sprint 6 - TEST - Validar Dashboard Admin e permissões).
// Parte 1 (A): API real por HTTP. Parte 2 (B-F): navegador (Chrome headless via DevTools Protocol, sem dependências novas).
// Cria usuários TEMPORÁRIOS (tmp.vad.*@example.com) direto no banco e SEMPRE os remove no final.
// Não imprime senhas, tokens nem valores do .env.
// Uso (dentro de backend/, com backend e frontend de teste já no ar):
//   APP_URL=http://127.0.0.1:5196 API_URL=http://127.0.0.1:3996/api node scripts/validateAdminDashboard.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import dotenv from 'dotenv';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

dotenv.config();

const APP = process.env.APP_URL || 'http://127.0.0.1:5196';
const API = process.env.API_URL || 'http://127.0.0.1:3996/api';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORTA_CDP = Number(process.env.CDP_PORT || 9334);
const SHOTS = process.env.SHOTS_DIR || join(process.cwd(), '.tmp-vad-shots');
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
  const email = `tmp.vad.${perfil.toLowerCase()}.${sufixo}.${++contador}@example.com`;
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
const limparUsuariosDeTeste = () => pool.query(`DELETE FROM usuarios WHERE email LIKE 'tmp.vad.%@example.com'`);

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
  const dir = join(tmpdir(), 'airmonitor-cdp-vad-' + Date.now());
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

// ---------------------------------------------------------------- Segurança: varredura de arquivos do frontend
function* arquivosDe(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.vite') yield* arquivosDe(p); } else yield p;
  }
}

// ================================================================ EXECUÇÃO
async function main() {
  const admin = await novoUsuario('ADMIN', { cidade: 'Campinas' });
  const comum = await novoUsuario('USUARIO');
  const inativo = await novoUsuario('USUARIO', { ativo: false });
  let tokenAdmin, tokenComum, usuarioAdminApi;

  // ============================================================ A - API
  console.log('\n===== A. API (HTTP real) =====');
  await caso('A01', 'login ADMIN e USUARIO pela API: perfis corretos, token JWT e resposta sem senha/hash', async () => {
    const a = await login(admin);
    const u = await login(comum);
    afirmar(a.user.perfil === 'ADMIN' && u.user.perfil === 'USUARIO', 'perfis inesperados');
    afirmar(!/senha|hash|password/i.test(JSON.stringify(a.user)) && !/senha|hash|password/i.test(JSON.stringify(u.user)), 'a resposta do login expõe campo de senha');
    const p = jwt.decode(a.token);
    afirmar(p.userId === admin.id && p.perfil === 'ADMIN' && p.exp > p.iat, 'payload do JWT inesperado');
    tokenAdmin = a.token; tokenComum = u.token; usuarioAdminApi = a.user;
    return `ADMIN id=${a.user.id}, USUARIO id=${u.user.id}; JWT expira em ${Math.round((p.exp - p.iat) / 3600)}h`;
  });

  const ESTACOES = '/admin/estacoes?cidade=' + encodeURIComponent('São Paulo');
  const ROTAS_GET = ['/admin/resumo', '/admin/configuracoes', ESTACOES, '/admin/usuarios', '/admin/cidades'];
  const chamarTodas = (token) => Promise.all([
    ...ROTAS_GET.map((p) => http(p, { token })),
    http('/admin/usuarios', { method: 'POST', token, corpo: { nome: 'Nao Deve Criar', email: 'nao.deve.criar@example.com', password: '123456', cidade: 'Osasco', regiao: 'Centro' } }),
    http(`/admin/usuarios/${comum.id}`, { method: 'PUT', token, corpo: { nome: 'Nao Deve Editar', email: comum.email, cidade: 'Osasco', regiao: 'Centro' } }),
    http(`/admin/usuarios/${comum.id}/status`, { method: 'PATCH', token, corpo: { ativo: false } }),
  ]);
  const ROTULOS = ['resumo', 'configuracoes', 'estacoes', 'usuarios(GET)', 'cidades', 'usuarios(POST)', 'usuarios/:id(PUT)', 'usuarios/:id/status(PATCH)'];

  await caso('A02', 'sem autenticação: as 8 rotas/operações administrativas respondem 401', async () => {
    const r = await chamarTodas(undefined);
    afirmar(r.every((x) => x.status === 401), 'status: ' + statusDe(r));
    return `${ROTULOS.length} operações -> ${statusDe(r)}`;
  });
  await caso('A03', 'USUARIO comum: as 8 rotas/operações administrativas respondem 403 (nada é criado/alterado)', async () => {
    const r = await chamarTodas(tokenComum);
    afirmar(r.every((x) => x.status === 403), 'status: ' + statusDe(r));
    const efeito = await pool.query(`SELECT ativo, nome FROM usuarios WHERE id = $1`, [comum.id]);
    afirmar(efeito.rows[0].ativo === true && efeito.rows[0].nome === 'Teste VAD USUARIO', 'o usuário comum conseguiu alterar dados');
    const criou = await pool.query(`SELECT 1 FROM usuarios WHERE email = 'nao.deve.criar@example.com'`);
    afirmar(criou.rowCount === 0, 'o usuário comum conseguiu criar um usuário');
    return `${ROTULOS.length} operações -> ${statusDe(r)}`;
  });
  await caso('A04', 'token inválido/forjado/expirado/malformado: 401 (não 403, não 200)', async () => {
    const mal = [
      ['texto aleatório', 'abc.def.ghi'],
      ['assinado com outro segredo', assinar({ userId: admin.id, email: admin.email, perfil: 'ADMIN' }, {}, 'segredo-errado-de-teste')],
      ['expirado', assinar({ userId: admin.id, email: admin.email, perfil: 'ADMIN' }, { expiresIn: -60 })],
    ];
    const r = [];
    for (const [, t] of mal) r.push(await http('/admin/resumo', { token: t }));
    r.push(await http('/admin/resumo', { cabecalhos: { Authorization: 'Bearer ' } }));
    r.push(await http('/admin/resumo', { cabecalhos: { Authorization: 'Basic abc' } }));
    afirmar(r.every((x) => x.status === 401), 'status: ' + statusDe(r));
    return `texto aleatório, outro segredo, expirado, "Bearer " vazio, esquema Basic -> ${statusDe(r)}`;
  });
  await caso('A05', 'perfil vem do banco: token válido de USUARIO com perfil ADMIN forjado no payload continua 403', async () => {
    const forjado = assinar({ userId: comum.id, email: comum.email, perfil: 'ADMIN' }, { expiresIn: '1h' });
    const r = await Promise.all(ROTAS_GET.map((p) => http(p, { token: forjado })));
    afirmar(r.every((x) => x.status === 403), 'status: ' + statusDe(r));
    return `payload dizia ADMIN, banco diz USUARIO -> ${statusDe(r)}`;
  });
  await caso('A06', 'ADMIN: as 5 rotas administrativas de leitura respondem 200', async () => {
    const r = await Promise.all(ROTAS_GET.map((p) => http(p, { token: tokenAdmin })));
    afirmar(r.every((x) => x.status === 200), 'status: ' + statusDe(r) + ' ' + r.filter((x) => x.status !== 200).map((x) => x.json?.error).join(';'));
    return statusDe(r);
  });
  await caso('A07', 'ADMIN: /admin/resumo bate com o banco, é consistente e não expõe dado sensível', async () => {
    const r = await http('/admin/resumo', { token: tokenAdmin });
    const u = r.json.usuarios; const b = await contagemDoBanco();
    afirmar(u.total === b.total && u.ativos === b.ativos && u.inativos === b.inativos && u.administradores === b.admins && u.usuariosComuns === b.comuns, `divergência: api=${JSON.stringify(u)} banco=${JSON.stringify(b)}`);
    afirmar(u.ativos + u.inativos === u.total && u.administradores + u.usuariosComuns === u.total, 'somas inconsistentes');
    afirmar(!/senha|hash|token|email/i.test(r.texto), 'resposta contém campo sensível');
    return `total=${u.total} ativos=${u.ativos} inativos=${u.inativos} admins=${u.administradores} comuns=${u.usuariosComuns}`;
  });
  await caso('A08', 'ADMIN: /admin/configuracoes é somente leitura e não devolve chave, JWT_SECRET, DATABASE_URL, senha nem token', async () => {
    const r = await http('/admin/configuracoes', { token: tokenAdmin });
    const segredos = [process.env.OPENAQ_API_KEY, process.env.JWT_SECRET, process.env.DATABASE_URL].filter(Boolean);
    afirmar(segredos.length === 3, 'ambiente de teste sem as 3 variáveis para comparar');
    for (const s of segredos) afirmar(!r.texto.includes(s), 'a resposta contém um valor secreto');
    afirmar(!/password|senha|secret|apikey|api_key|token|DATABASE_URL|postgres(ql)?:\/\//i.test(r.texto), 'a resposta contém nome/valor de segredo');
    afirmar(typeof r.json.integracoes.openaq.configurada === 'boolean', 'openaq.configurada deveria ser booleano (Sim/Não)');
    const rotas = await Promise.all(['POST', 'PUT', 'PATCH', 'DELETE'].map((m) => http('/admin/configuracoes', { method: m, token: tokenAdmin, corpo: {} })));
    afirmar(rotas.every((x) => x.status === 404), 'a rota aceita escrita: ' + statusDe(rotas));
    return `OpenAQ configurada=${r.json.integracoes.openaq.configurada}; POST/PUT/PATCH/DELETE -> ${statusDe(rotas)} (sem rota de escrita)`;
  });
  await caso('A09', 'ADMIN: /admin/estacoes traz estações reais e valida cidade/limite (400)', async () => {
    const r = await http(ESTACOES + '&limite=5', { token: tokenAdmin });
    afirmar(r.status === 200 && r.json.total > 0 && r.json.fonte === 'OpenAQ', 'HTTP ' + r.status);
    const ruins = await Promise.all([http('/admin/estacoes?cidade=Atlantida', { token: tokenAdmin }), http('/admin/estacoes', { token: tokenAdmin }),
      http('/admin/estacoes?cidade=Osasco&limite=999', { token: tokenAdmin }), http('/admin/estacoes?cidade=Osasco&limite=abc', { token: tokenAdmin })]);
    afirmar(ruins.every((x) => x.status === 400), 'status: ' + statusDe(ruins));
    return `${r.json.total} estações reais; parâmetros inválidos -> ${statusDe(ruins)}`;
  });

  let criado;
  await caso('A10', 'gestão: listar (sem senha_hash) e criar (perfil sempre USUARIO, senha guardada só como hash)', async () => {
    const lista = await http('/admin/usuarios', { token: tokenAdmin });
    afirmar(lista.status === 200 && Array.isArray(lista.json) && lista.json.some((x) => x.id === admin.id), 'lista incompleta');
    afirmar(!/senha|hash|password/i.test(lista.texto), 'a listagem expõe campo de senha');
    const senha = 'Senha-Teste-123';
    const c = await http('/admin/usuarios', { method: 'POST', token: tokenAdmin, corpo: { nome: 'Teste VAD Criado', email: `tmp.vad.criado.${sufixo}@example.com`, password: senha, cidade: 'Mauá', regiao: 'Centro', perfil: 'ADMIN' } });
    afirmar(c.status === 201 && c.json.perfil === 'USUARIO', `criar: HTTP ${c.status} perfil=${c.json?.perfil} (o perfil do corpo deveria ser ignorado)`);
    afirmar(!/senha|hash|password/i.test(c.texto), 'a criação devolveu campo de senha');
    const linha = (await pool.query('SELECT senha_hash FROM usuarios WHERE id = $1', [c.json.id])).rows[0];
    afirmar(linha.senha_hash !== senha && /^\$2[aby]\$/.test(linha.senha_hash), 'senha não está em hash bcrypt');
    criado = { ...c.json, senha };
    const invalidos = await Promise.all([
      http('/admin/usuarios', { method: 'POST', token: tokenAdmin, corpo: { nome: 'X', email: 'a@example.com', password: '123', cidade: 'Mauá', regiao: 'Centro' } }),
      http('/admin/usuarios', { method: 'POST', token: tokenAdmin, corpo: { nome: 'Fulano', email: 'invalido', password: '123456', cidade: 'Mauá', regiao: 'Centro' } }),
      http('/admin/usuarios', { method: 'POST', token: tokenAdmin, corpo: { nome: 'Fulano', email: 'b@example.com', password: '123456', cidade: 'Mauá', regiao: 'Regiao Inexistente' } }),
      http('/admin/usuarios', { method: 'POST', token: tokenAdmin, corpo: { nome: 'Fulano' } }),
    ]);
    afirmar(invalidos.every((x) => x.status === 400), 'validações: ' + statusDe(invalidos));
    return `criado id=${c.json.id} perfil=${c.json.perfil}, hash bcrypt; dados inválidos -> ${statusDe(invalidos)}`;
  });
  await caso('A11', 'gestão: e-mail duplicado é bloqueado (criar, em MAIÚSCULAS e ao editar) e o próprio e-mail pode ser mantido', async () => {
    const corpo = (email) => ({ nome: 'Duplicado', email, password: '123456', cidade: 'Mauá', regiao: 'Centro' });
    const d1 = await http('/admin/usuarios', { method: 'POST', token: tokenAdmin, corpo: corpo(criado.email) });
    const d2 = await http('/admin/usuarios', { method: 'POST', token: tokenAdmin, corpo: corpo('  ' + criado.email.toUpperCase() + ' ') });
    afirmar(d1.status === 400 && /já cadastrado/i.test(d1.json?.error) && d2.status === 400, `criar: ${d1.status}/${d2.status}`);
    const ed1 = await http(`/admin/usuarios/${criado.id}`, { method: 'PUT', token: tokenAdmin, corpo: { nome: 'Teste VAD Criado', email: comum.email, cidade: 'Mauá', regiao: 'Centro' } });
    afirmar(ed1.status === 400 && /já cadastrado/i.test(ed1.json?.error), 'editar para e-mail alheio: HTTP ' + ed1.status);
    const ed2 = await http(`/admin/usuarios/${criado.id}`, { method: 'PUT', token: tokenAdmin, corpo: { nome: 'Teste VAD Criado', email: criado.email, cidade: 'Mauá', regiao: 'Centro' } });
    afirmar(ed2.status === 200, 'manter o próprio e-mail: HTTP ' + ed2.status);
    const total = (await pool.query('SELECT COUNT(*)::int n FROM usuarios WHERE lower(email) = lower($1)', [criado.email])).rows[0].n;
    afirmar(total === 1, 'e-mail duplicado chegou ao banco');
    return `criar=${d1.status}, criar(MAIÚSCULAS)=${d2.status}, editar p/ e-mail alheio=${ed1.status}, manter o próprio=${ed2.status}`;
  });
  await caso('A12', 'gestão: editar (perfil e senha não mudam por PUT; 404 e 400 corretos)', async () => {
    const antes = (await pool.query('SELECT senha_hash FROM usuarios WHERE id = $1', [criado.id])).rows[0].senha_hash;
    const ed = await http(`/admin/usuarios/${criado.id}`, { method: 'PUT', token: tokenAdmin, corpo: { nome: 'Teste VAD Editado', email: criado.email, cidade: 'Mauá', regiao: 'Zona Sul', perfil: 'ADMIN', password: 'OutraSenha-999' } });
    afirmar(ed.status === 200 && ed.json.nome === 'Teste VAD Editado' && ed.json.regiao === 'Zona Sul', 'editar: HTTP ' + ed.status);
    const depois = (await pool.query('SELECT senha_hash, perfil FROM usuarios WHERE id = $1', [criado.id])).rows[0];
    afirmar(depois.perfil === 'USUARIO' && depois.senha_hash === antes, 'PUT alterou perfil ou senha');
    const nf = await http('/admin/usuarios/999999999', { method: 'PUT', token: tokenAdmin, corpo: { nome: 'Fulano', email: 'x@example.com', cidade: 'Mauá', regiao: 'Centro' } });
    const ruim = await http('/admin/usuarios/abc', { method: 'PUT', token: tokenAdmin, corpo: { nome: 'Fulano', email: 'x@example.com', cidade: 'Mauá', regiao: 'Centro' } });
    afirmar(nf.status === 404 && ruim.status === 400, `inexistente=${nf.status} inválido=${ruim.status}`);
    return `editado; perfil e hash intactos; inexistente=${nf.status}; id inválido=${ruim.status}`;
  });
  await caso('A13', 'gestão: desativar e reativar (e entradas inválidas)', async () => {
    const off = await http(`/admin/usuarios/${criado.id}/status`, { method: 'PATCH', token: tokenAdmin, corpo: { ativo: false } });
    afirmar(off.status === 200 && off.json.ativo === false, 'desativar: HTTP ' + off.status);
    afirmar((await pool.query('SELECT ativo FROM usuarios WHERE id = $1', [criado.id])).rows[0].ativo === false, 'banco não refletiu a desativação');
    const on = await http(`/admin/usuarios/${criado.id}/status`, { method: 'PATCH', token: tokenAdmin, corpo: { ativo: true } });
    afirmar(on.status === 200 && on.json.ativo === true, 'reativar: HTTP ' + on.status);
    const ruim = await http(`/admin/usuarios/${criado.id}/status`, { method: 'PATCH', token: tokenAdmin, corpo: { ativo: 'false' } });
    const nf = await http('/admin/usuarios/999999999/status', { method: 'PATCH', token: tokenAdmin, corpo: { ativo: false } });
    afirmar(ruim.status === 400 && nf.status === 404, `corpo inválido=${ruim.status} inexistente=${nf.status}`);
    return `desativar=${off.status}, reativar=${on.status}, corpo inválido=${ruim.status}, inexistente=${nf.status}`;
  });
  await caso('A14', 'gestão: ADMIN não consegue desativar a própria conta (400) e segue ativo', async () => {
    const eu = await http(`/admin/usuarios/${admin.id}/status`, { method: 'PATCH', token: tokenAdmin, corpo: { ativo: false } });
    afirmar(eu.status === 400 && /própria conta/i.test(eu.json?.error), `HTTP ${eu.status}`);
    afirmar((await pool.query('SELECT ativo FROM usuarios WHERE id = $1', [admin.id])).rows[0].ativo === true, 'o ADMIN foi desativado');
    const mesmo = await http(`/admin/usuarios/${admin.id}/status`, { method: 'PATCH', token: tokenAdmin, corpo: { ativo: true } });
    afirmar(mesmo.status === 200, 'ativar a si mesmo deveria ser permitido: HTTP ' + mesmo.status);
    return `autodesativação=${eu.status} ("${eu.json.error}")`;
  });
  await caso('A15', 'usuário desativado não consegue logar (mesma mensagem de senha errada, sem revelar o estado)', async () => {
    const a = await http('/auth/login', { method: 'POST', corpo: { email: inativo.email, password: inativo.senha } });
    const b = await http('/auth/login', { method: 'POST', corpo: { email: comum.email, password: 'senha-errada' } });
    afirmar(a.status === 401 && b.status === 401 && a.json.error === b.json.error, `desativado=${a.status} "${a.json?.error}" / senha errada=${b.status} "${b.json?.error}"`);
    return `desativado -> ${a.status} "${a.json.error}" (igual ao de senha errada)`;
  });
  await caso('A16', 'usuário desativado com token antigo perde o acesso a TODAS as rotas autenticadas (401) e volta ao reativar', async () => {
    const alvo = await novoUsuario('ADMIN');
    const { token } = await login(alvo);
    const rotas = ['/admin/resumo', '/admin/usuarios', '/auth/me', '/dashboard', '/air-quality/locations?cidade=' + encodeURIComponent('Osasco')];
    const antes = await Promise.all(rotas.map((p) => http(p, { token })));
    afirmar(antes.every((x) => x.status !== 401 && x.status !== 403), 'com o usuário ativo: ' + statusDe(antes));
    const off = await http(`/admin/usuarios/${alvo.id}/status`, { method: 'PATCH', token: tokenAdmin, corpo: { ativo: false } });
    afirmar(off.status === 200, 'desativar: HTTP ' + off.status);
    const durante = await Promise.all(rotas.map((p) => http(p, { token })));
    afirmar(durante.every((x) => x.status === 401), 'desativado, com o mesmo token: ' + statusDe(durante));
    await http(`/admin/usuarios/${alvo.id}/status`, { method: 'PATCH', token: tokenAdmin, corpo: { ativo: true } });
    const depois = await http('/admin/resumo', { token });
    afirmar(depois.status === 200, 'reativado: HTTP ' + depois.status);
    return `ativo=${statusDe(antes)} | desativado=${statusDe(durante)} | reativado=${depois.status}`;
  });
  await caso('A17', 'perfil rebaixado no banco vale na hora: o mesmo token de ex-ADMIN passa a receber 403 (sem relogar)', async () => {
    const alvo = await novoUsuario('ADMIN');
    const { token } = await login(alvo);
    afirmar((await http('/admin/resumo', { token })).status === 200, 'como ADMIN deveria ser 200');
    await definirPerfil(alvo.id, 'USUARIO');
    const r = await Promise.all(ROTAS_GET.map((p) => http(p, { token })));
    afirmar(r.every((x) => x.status === 403), 'status: ' + statusDe(r));
    return `rebaixado -> ${statusDe(r)}`;
  });
  await caso('A18', 'GET /auth/me (validação de sessão): usuário do banco, sem senha; 401 sem token/inválido/desativado; perfil do banco', async () => {
    const ok = await http('/auth/me', { token: tokenAdmin });
    afirmar(ok.status === 200 && ok.json?.user?.id === admin.id && ok.json.user.perfil === 'ADMIN' && ok.json.user.email === admin.email, 'HTTP ' + ok.status + ' ' + ok.texto.slice(0, 80));
    afirmar(!/senha|hash|password|token/i.test(ok.texto), '/auth/me expõe campo sensível');
    const forjado = assinar({ userId: comum.id, email: comum.email, perfil: 'ADMIN' }, { expiresIn: '1h' });
    const f = await http('/auth/me', { token: forjado });
    afirmar(f.status === 200 && f.json.user.perfil === 'USUARIO', `token com perfil forjado devolveu perfil=${f.json?.user?.perfil}`);
    const sem = await http('/auth/me');
    const lixo = await http('/auth/me', { token: 'abc.def.ghi' });
    afirmar(sem.status === 401 && lixo.status === 401, `sem token=${sem.status} lixo=${lixo.status}`);
    const tInativo = assinar({ userId: inativo.id, email: inativo.email, perfil: 'USUARIO' }, { expiresIn: '1h' });
    const i = await http('/auth/me', { token: tInativo });
    afirmar(i.status === 401, 'desativado: HTTP ' + i.status);
    return `válido=200 (perfil do banco), perfil forjado -> ${f.json.user.perfil}, sem token=401, lixo=401, desativado=401`;
  });
  await caso('A19', 'senhas: nenhuma em texto puro no banco (todo senha_hash é bcrypt) e não há outra coluna de senha', async () => {
    const ruins = (await pool.query(`SELECT COUNT(*)::int n FROM usuarios WHERE senha_hash NOT LIKE '$2%'`)).rows[0].n;
    afirmar(ruins === 0, `${ruins} usuário(s) com senha_hash que não é bcrypt`);
    const colunas = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'usuarios'`)).rows.map((r) => r.column_name);
    const suspeitas = colunas.filter((c) => /senha|pass|pwd/i.test(c) && c !== 'senha_hash');
    afirmar(suspeitas.length === 0, 'colunas suspeitas: ' + suspeitas.join(','));
    const total = (await pool.query('SELECT COUNT(*)::int n FROM usuarios')).rows[0].n;
    return `${total} usuários, todos com bcrypt; colunas: ${colunas.join(', ')}`;
  });
  await caso('A20', 'segredos fora do frontend: código-fonte e build (dist) não contêm chave da OpenAQ, JWT_SECRET nem DATABASE_URL', async () => {
    const segredos = [process.env.OPENAQ_API_KEY, process.env.JWT_SECRET, process.env.DATABASE_URL].filter(Boolean);
    afirmar(segredos.length === 3, 'ambiente de teste sem as 3 variáveis');
    let lidos = 0;
    for (const base of [join(FRONTEND, 'src'), join(FRONTEND, 'dist')]) {
      for (const arq of arquivosDe(base)) {
        const txt = readFileSync(arq, 'utf8'); lidos++;
        for (const s of segredos) afirmar(!txt.includes(s), 'valor secreto encontrado em ' + arq.replace(FRONTEND, 'frontend'));
        // No código-fonte o nome pode aparecer em comentário; no build (dist) não deve restar nem o nome
        if (base.endsWith('dist')) afirmar(!/OPENAQ_API_KEY|JWT_SECRET|DATABASE_URL/.test(txt), 'nome de variável secreta em ' + arq.replace(FRONTEND, 'frontend'));
      }
    }
    for (const arq of ['.env', '.env.local', '.env.production']) {
      const p = join(FRONTEND, arq);
      if (existsSync(p)) { const txt = readFileSync(p, 'utf8'); for (const s of segredos) afirmar(!txt.includes(s), `valor secreto em frontend/${arq}`); }
    }
    afirmar(existsSync(join(FRONTEND, 'dist')), 'frontend/dist não existe (rode npm run build antes)');
    return `${lidos} arquivos varridos (src + dist): nenhum valor secreto; nenhum nome de variável secreta no build`;
  });

  // ============================================================ Navegador
  const chrome = await abrirChrome();
  console.log(`\n===== B. Navegador (${chrome.versao}) - ADMIN: login, Dashboard e páginas =====`);
  const emailUi = `tmp.vad.ui.${sufixo}@example.com`;
  try {
    await caso('B01', 'login do ADMIN pela tela abre o Dashboard Admin (menu completo, topo "Usuário Admin")', async () => {
      await loginPelaTela(admin.email, admin.senha);
      const itens = await itensDoMenu();
      afirmar(JSON.stringify(itens) === JSON.stringify(MENU_ADMIN), 'menu: ' + itens.join('|'));
      afirmar(/Usuário Admin/.test(await avaliar(`document.querySelector('.dash-topbar').innerText`)), 'topo sem "Usuário Admin"');
      afirmar(!!(await guardado('authToken')) && JSON.parse(await guardado('user')).perfil === 'ADMIN', 'sessão não gravada no armazenamento');
    });
    await caso('B02', 'Dashboard Admin: 5 contadores reais (iguais ao banco), qualidade do ar, estações e aviso de "ilustrativo"', async () => {
      await esperarContadores();
      await esperar(`document.querySelectorAll('.pollutant').length === 6 && !/Carregando/.test(document.querySelector('.dash-pollutants').innerText)`, 30000, 'poluentes carregados');
      await esperar(`!!document.querySelector('.admin-station-list li') || /Nenhuma|indispon|Não foi/.test(document.querySelector('.admin-station-list').innerText)`, 30000, 'lista de estações');
      const tiles = await avaliar(`[...document.querySelectorAll('.admin-stat strong')].map(e => Number(e.innerText))`);
      const b = await contagemDoBanco();
      afirmar(JSON.stringify(tiles) === JSON.stringify([b.total, b.ativos, b.inativos, b.admins, b.comuns]), `tela=${tiles} banco=${[b.total, b.ativos, b.inativos, b.admins, b.comuns]}`);
      const cards = await avaliar(`[...document.querySelectorAll('.pollutant')].map(c => ({n: c.querySelector('.pollutant-name strong').innerText, v: c.querySelector('.pollutant-value b')?.innerText ?? null}))`);
      const estacoes = await avaliar(`document.querySelectorAll('.admin-station-list li').length`);
      afirmar(/ilustrativo/i.test(await avaliar(`document.querySelector('.quality-note').innerText`)), 'IQA sem aviso de ilustrativo');
      await foto('01-dashboard-admin');
      return `contadores=${tiles}; poluentes com valor=${cards.filter((c) => c.v).length}/6; estações no card=${estacoes}`;
    });
    await caso('B03', 'Dashboard Admin: sem erro de JavaScript e sem requisição /api com falha 4xx/5xx', async () => {
      const ruins = requisicoes.filter((r) => typeof r.status === 'number' && r.status >= 400 && /\/api\//.test(r.url));
      afirmar(errosDePagina.length === 0, 'erros JS: ' + errosDePagina.slice(0, 2).join(' | '));
      afirmar(ruins.length === 0, 'falhas: ' + ruins.map((r) => `${r.status} ${r.url.replace(/^.*\/api/, '')}`).join('; '));
    });
    await caso('B04', 'Usuários: menu lateral e cabeçalho visíveis, item "Usuários" destacado, tabela carregada', async () => {
      afirmar(await clicarMenu('Usuários'), 'item Usuários não encontrado');
      await esperar(`!!document.querySelector('.users-table tbody tr')`, 15000, 'tabela de usuários');
      const r = await avaliar(`(()=>{const sb=document.querySelector('.dash-sidebar'), nav=[...document.querySelectorAll('.dash-nav-item')];
        return { sidebar: !!sb && sb.getBoundingClientRect().width>100, itens: nav.length, ativo: nav.filter(b=>b.classList.contains('active')).map(b=>b.innerText.trim()), topo: !!document.querySelector('.dash-topbar'), sair: !!document.querySelector('.dash-logout'), linhas: document.querySelectorAll('.users-table tbody tr').length } })()`);
      afirmar(r.sidebar && r.itens === 8 && r.sair && r.topo, 'layout incompleto: ' + JSON.stringify(r));
      afirmar(JSON.stringify(r.ativo) === '["Usuários"]', 'destaque: ' + r.ativo.join(','));
      await foto('02-usuarios');
      return `${r.itens} itens de menu, ativo=${r.ativo}, ${r.linhas} usuários`;
    });
    await caso('B05', 'Usuários (tela): criar, editar, desativar, reativar', async () => {
      await avaliar(`document.querySelector('.users-btn-primary').click()`);
      await esperar(`!!document.querySelector('.users-modal')`, 5000, 'modal de criação');
      await digitar('.users-modal input[name="nome"]', 'Teste VAD UI');
      await digitar('.users-modal input[name="email"]', emailUi);
      await digitar('.users-modal input[name="password"]', 'Senha-123');
      await selecionar('.users-modal select[name="cidade"]', 'Sorocaba');
      await selecionar('.users-modal select[name="regiao"]', 'Centro');
      await avaliar(`document.querySelector('.users-modal').requestSubmit()`);
      await esperar(`/criado com sucesso/.test(document.querySelector('.users-card').innerText)`, 15000, 'mensagem de criação');
      await esperar(`[...document.querySelectorAll('.users-table tbody tr')].some(t=>t.innerText.includes(${JSON.stringify(emailUi)}))`, 15000, 'linha nova');
      const linha = (acao) => avaliar(`(()=>{const tr=[...document.querySelectorAll('.users-table tbody tr')].find(t=>t.innerText.includes(${JSON.stringify(emailUi)})); if(!tr) return false; const b=[...tr.querySelectorAll('button')].find(x=>x.innerText.trim()===${JSON.stringify(acao)}); if(!b) return false; b.click(); return true})()`);
      afirmar(await linha('Editar'), 'linha criada não encontrada');
      await esperar(`!!document.querySelector('.users-modal')`, 5000, 'modal de edição');
      await digitar('.users-modal input[name="nome"]', 'Teste VAD UI Editado');
      await avaliar(`document.querySelector('.users-modal').requestSubmit()`);
      await esperar(`/atualizado com sucesso/.test(document.querySelector('.users-card').innerText)`, 15000, 'mensagem de edição');
      await esperar(`[...document.querySelectorAll('.users-table tbody tr')].some(t=>t.innerText.includes('Teste VAD UI Editado'))`, 8000, 'nome editado');
      afirmar(await linha('Desativar'), 'botão Desativar não encontrado');
      await esperar(`/Usuário desativado com sucesso/.test(document.querySelector('.users-card').innerText)`, 15000, 'mensagem de desativação');
      await esperar(`[...document.querySelectorAll('.users-table tbody tr')].some(t=>t.innerText.includes(${JSON.stringify(emailUi)}) && /Inativo/.test(t.innerText))`, 8000, 'linha inativa');
      afirmar(await linha('Ativar'), 'botão Ativar não encontrado');
      await esperar(`/Usuário ativado com sucesso/.test(document.querySelector('.users-card').innerText)`, 15000, 'mensagem de ativação');
      await esperar(`[...document.querySelectorAll('.users-table tbody tr')].some(t=>t.innerText.includes(${JSON.stringify(emailUi)}) && /Ativo/.test(t.innerText) && !/Inativo/.test(t.innerText))`, 8000, 'linha ativa de novo');
      afirmar(await linha('Desativar'), 'não conseguiu desativar de novo');
      await esperar(`[...document.querySelectorAll('.users-table tbody tr')].some(t=>t.innerText.includes(${JSON.stringify(emailUi)}) && /Inativo/.test(t.innerText))`, 15000, 'ficar inativo para o teste de login');
    });
    await caso('B06', 'Usuários (tela): e-mail duplicado mostra erro no formulário e o botão Desativar da própria conta está bloqueado', async () => {
      await avaliar(`document.querySelector('.users-btn-primary').click()`);
      await esperar(`!!document.querySelector('.users-modal')`, 5000, 'modal');
      await digitar('.users-modal input[name="nome"]', 'Duplicado UI');
      await digitar('.users-modal input[name="email"]', admin.email);
      await digitar('.users-modal input[name="password"]', 'Senha-123');
      await selecionar('.users-modal select[name="cidade"]', 'Sorocaba');
      await selecionar('.users-modal select[name="regiao"]', 'Centro');
      await avaliar(`document.querySelector('.users-modal').requestSubmit()`);
      await esperar(`/já cadastrado/i.test((document.querySelector('.users-modal .users-alert-error')||{}).innerText||'')`, 10000, 'erro de e-mail duplicado');
      await avaliar(`document.querySelector('.users-overlay').click()`);
      await esperar(`!document.querySelector('.users-modal')`, 5000, 'fechar o modal');
      const propria = await avaliar(`(()=>{const tr=[...document.querySelectorAll('.users-table tbody tr')].find(t=>t.innerText.includes(${JSON.stringify(admin.email)})); const b=[...tr.querySelectorAll('button')].find(x=>x.innerText.trim()==='Desativar'); return { desabilitado: b.disabled, dica: b.title }})()`);
      afirmar(propria.desabilitado === true, 'o botão Desativar da própria conta deveria estar desabilitado');
      return `duplicado bloqueado na tela; própria conta: botão desabilitado ("${propria.dica}")`;
    });
    await caso('B07', 'Dashboard Admin reflete as mudanças feitas em Usuários (contadores iguais ao banco ao voltar)', async () => {
      afirmar(await clicarMenu('Dashboard'), 'menu Dashboard');
      await esperarContadores();
      const v = await avaliar(`[...document.querySelectorAll('.admin-stat strong')].map(e => Number(e.innerText))`);
      const b = await contagemDoBanco();
      afirmar(JSON.stringify(v) === JSON.stringify([b.total, b.ativos, b.inativos, b.admins, b.comuns]), `tela=${v} banco=${[b.total, b.ativos, b.inativos, b.admins, b.comuns]}`);
      return `contadores=${v}`;
    });
    await caso('B08', 'Estações: tabela real, menu/cabeçalho presentes, troca de cidade recarrega a lista', async () => {
      afirmar(await clicarMenu('Estações'), 'menu Estações');
      await esperar(`!!document.querySelector('.users-table tbody tr') || /Nenhuma|Não foi|indispon/.test(document.querySelector('.dash-main').innerText)`, 30000, 'tabela de estações');
      const cab = await avaliar(`[...document.querySelectorAll('.users-table th')].map(t=>t.innerText.toLowerCase())`);
      afirmar(JSON.stringify(cab) === JSON.stringify(['id', 'nome', 'localização', 'latitude', 'longitude', 'distância', 'poluentes', 'origem', 'situação', 'última medição']), 'colunas: ' + cab.join('|'));
      const linhas = await avaliar(`document.querySelectorAll('.users-table tbody tr').length`);
      afirmar((await avaliar(`document.querySelector('.dash-nav-item.active').innerText.trim()`)) === 'Estações', 'destaque do menu');
      const antes = await avaliar(`[...document.querySelectorAll('.users-table tbody tr td:first-child')].map(t=>t.innerText).join()`);
      const cidadeAntes = await avaliar(`document.querySelector('.admin-select select').value`);
      const nova = cidadeAntes === 'Osasco' ? 'Guarulhos' : 'Osasco';
      await selecionar('.admin-select select', nova);
      await esperar(`new RegExp('para ' + ${JSON.stringify(nova)}).test(document.querySelector('.dash-main').innerText) || /Nenhuma estação/.test(document.querySelector('.dash-main').innerText)`, 30000, 'estações de ' + nova);
      const depois = await avaliar(`[...document.querySelectorAll('.users-table tbody tr td:first-child')].map(t=>t.innerText).join()`);
      afirmar(antes !== depois, `a lista não mudou de ${cidadeAntes} para ${nova}`);
      return `${cidadeAntes}: ${linhas} estações -> ${nova}: lista diferente`;
    });
    await caso('B09', 'Configurações: somente leitura, sem segredos na tela', async () => {
      afirmar(await clicarMenu('Configurações'), 'menu');
      await esperar(`/Cache e atualização/.test(document.querySelector('.dash-main').innerText)`, 15000, 'página de configurações');
      const txt = await textoMain();
      for (const s of [process.env.OPENAQ_API_KEY, process.env.JWT_SECRET, process.env.DATABASE_URL]) afirmar(!txt.includes(s), 'a tela exibe um valor secreto');
      afirmar(!/postgres(ql)?:\/\/|api[_ -]?key:|JWT_SECRET/i.test(txt), 'a tela exibe nome/valor de segredo');
      afirmar(/Configurada\s*●?\s*(Sim|Não)/.test(txt.replace(/\s+/g, ' ')), 'sem "Configurada: Sim/Não"');
      const editaveis = await avaliar(`document.querySelectorAll('.dash-main input, .dash-main textarea, .dash-main form').length`);
      afirmar(editaveis === 0, `a página tem ${editaveis} campo(s) editável(is)`);
      await foto('03-configuracoes');
    });
    await caso('B10', 'Relatórios: usuários (iguais ao banco), cidade, estação, poluentes com fonte e data/hora', async () => {
      afirmar(await clicarMenu('Relatórios'), 'menu');
      await esperar(`!!document.querySelector('.report-section table') && /Qualidade do ar/.test(document.querySelector('.dash-main').innerText) && !/Carregando dados/.test(document.querySelector('.dash-main').innerText)`, 30000, 'relatórios');
      await esperar(`document.querySelectorAll('.report-section .admin-stat strong').length === 5 && ![...document.querySelectorAll('.report-section .admin-stat strong')].some(e => e.innerText === '…')`, 20000, 'contadores dos relatórios');
      const txt = (await textoMain()).replace(/\s+/g, ' ');
      afirmar(/Usuários cadastrados/i.test(txt) && /Estação/i.test(txt) && /Fonte/i.test(txt) && /Data\/hora do dado/i.test(txt), 'seções ausentes');
      const v = await avaliar(`[...document.querySelectorAll('.report-section .admin-stat strong')].map(e => Number(e.innerText))`);
      const b = await contagemDoBanco();
      afirmar(JSON.stringify(v) === JSON.stringify([b.total, b.ativos, b.inativos, b.admins, b.comuns]), `relatório=${v} banco=${[b.total, b.ativos, b.inativos, b.admins, b.comuns]}`);
      await foto('04-relatorios');
      return `contadores=${v}`;
    });
    await caso('B11', 'Alertas, Ocorrências e Histórico seguem como placeholders (navegação funcionando)', async () => {
      for (const m of ['Alertas', 'Ocorrências', 'Histórico']) {
        afirmar(await clicarMenu(m), 'menu ' + m);
        await esperar(`/Esta tela ainda não foi implementada/.test(document.querySelector('.dash-main').innerText) && document.querySelector('.dash-main h2').innerText.trim() === ${JSON.stringify(m)}`, 5000, 'placeholder ' + m);
      }
    });
    await caso('B12', 'Acesso rápido do Dashboard Admin navega para Usuários, Estações, Relatórios e Configurações', async () => {
      afirmar(await clicarMenu('Dashboard'), 'menu');
      await esperar(`document.querySelectorAll('.quick-item').length === 4`, 10000, 'acesso rápido');
      for (const [titulo, destino] of [['Gerenciar usuários', 'Usuários'], ['Consultar estações', 'Estações'], ['Ver relatórios', 'Relatórios'], ['Configurações', 'Configurações']]) {
        await avaliar(`[...document.querySelectorAll('.quick-item')].find(b=>b.innerText.includes(${JSON.stringify(titulo)})).click()`);
        await esperar(`document.querySelector('.dash-nav-item.active').innerText.trim() === ${JSON.stringify(destino)}`, 5000, 'ir para ' + destino);
        afirmar(await clicarMenu('Dashboard'), 'voltar');
        await esperar(`document.querySelectorAll('.quick-item').length === 4`, 10000, 'voltar ao dashboard');
      }
    });

    // ============================================================ F - Responsividade (ADMIN ainda logado)
    console.log('\n===== F. Responsividade e interface =====');
    await caso('F01', 'desktop 1366px: nenhuma das 5 páginas administrativas tem rolagem horizontal; menu clicável', async () => {
      await enviar('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
      const sobras = [];
      for (const p of PAGINAS) {
        afirmar(await clicarMenu(p.menu), 'menu ' + p.menu);
        await esperar(p.pronta, 30000, 'página ' + p.menu);
        const sobra = await sobraHorizontal();
        sobras.push(`${p.menu}=${sobra}px`);
        afirmar(sobra <= 1, `rolagem horizontal em ${p.menu}: ${sobra}px`);
      }
      const livres = await avaliar(`[...document.querySelectorAll('.dash-nav-item')].every(b => { b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); const el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return r.width>0 && (el===b || b.contains(el)); })`);
      afirmar(livres, 'algum item do menu está coberto/invisível');
      return 'sobra horizontal: ' + sobras.join(', ');
    });
    await caso('F02', 'mobile 390px: 5 páginas sem estourar a largura, menu utilizável, tabelas rolam dentro do próprio card', async () => {
      await enviar('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await dormir(400);
      const sobras = []; const tabelas = [];
      for (const p of PAGINAS) {
        afirmar(await clicarMenu(p.menu), 'menu ' + p.menu);
        await esperar(p.pronta, 30000, 'página ' + p.menu);
        await dormir(300);
        const sobra = await sobraHorizontal();
        sobras.push(`${p.menu}=${sobra}px`);
        afirmar(sobra <= 1, `rolagem horizontal em ${p.menu}: ${sobra}px`);
        const t = await avaliar(`[...document.querySelectorAll('.users-table')].map(t => { const w=t.parentElement; return { noWrap: w.classList.contains('users-table-wrap'), overflowX: getComputedStyle(w).overflowX, tabela: t.scrollWidth, area: w.clientWidth } })`);
        for (const x of t) afirmar(x.tabela <= x.area + 1 || ['auto', 'scroll'].includes(x.overflowX), `tabela de ${p.menu} sem rolagem própria: ${JSON.stringify(x)}`);
        if (t.length) tabelas.push(`${p.menu}: ${t.map((x) => (x.tabela > x.area ? `rola (${x.tabela}>${x.area})` : 'cabe')).join('/')}`);
        await foto(`05-mobile-${p.menu.toLowerCase().replace(/[^a-z]/g, '')}`, 390, 844, true);
      }
      const menu = await avaliar(`[...document.querySelectorAll('.dash-nav-item')].map(b => { b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); const el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return { t:b.innerText.trim(), ok: r.width>0 && r.height>0 && (el===b || b.contains(el)) } })`);
      afirmar(menu.length === 8 && menu.every((m) => m.ok), 'itens de menu inutilizáveis: ' + menu.filter((m) => !m.ok).map((m) => m.t).join(','));
      const sair = await avaliar(`(()=>{const b=document.querySelector('.dash-logout'); b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); const el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return r.width>0 && (el===b || b.contains(el))})()`);
      afirmar(sair, 'botão Sair inutilizável');
      afirmar(errosDePagina.length === 0, 'erros JS: ' + errosDePagina.slice(0, 2).join(' | '));
      await enviar('Emulation.clearDeviceMetricsOverride');
      return `sobra horizontal: ${sobras.join(', ')}; 8/8 itens de menu e Sair clicáveis; ${tabelas.join('; ')}`;
    });

    // ============================================================ C - Sessão (D1)
    console.log('\n===== C. Sessão / F5 (D1) =====');
    await caso('C01', 'F5 com sessão válida de ADMIN mantém o Dashboard Admin, sem passar pelo Login', async () => {
      await loginPelaTela(admin.email, admin.senha);
      await recarregar();
      await esperarDashboard();
      const v = await viu();
      afirmar(v.login === false, 'a tela de Login apareceu durante o F5');
      const itens = await itensDoMenu();
      afirmar(JSON.stringify(itens) === JSON.stringify(MENU_ADMIN), 'menu após o F5: ' + itens.join('|'));
      await esperarContadores();
      afirmar(JSON.parse(await guardado('user')).perfil === 'ADMIN' && !!(await guardado('authToken')), 'armazenamento perdido');
      return 'Dashboard Admin restaurado com os dados reais; Login nunca exibido';
    });
    await caso('C02', 'F5 com sessão válida de USUARIO mantém o perfil USUARIO (sem menus administrativos)', async () => {
      await semearSessao(await login(comum));
      await recarregar();
      await esperarDashboard();
      afirmar((await viu()).login === false, 'a tela de Login apareceu');
      const itens = await itensDoMenu();
      afirmar(JSON.stringify(itens) === JSON.stringify(MENU_USUARIO), 'menu: ' + itens.join('|'));
      afirmar((await avaliar(`document.querySelectorAll('.admin-stat').length`)) === 0, 'cartões administrativos visíveis para USUARIO');
      return 'menu do USUARIO: ' + itens.join(', ');
    });
    await caso('C03', 'a sessão é validada ANTES de mostrar o Dashboard: com /auth/me retido não há Dashboard, Login nem chamadas administrativas', async () => {
      await semearSessao(await login(admin));
      const liberar = await interceptar('*/api/auth/me', 'segurar');
      const desde = requisicoes.length;
      try {
        await recarregar();
        await dormir(1500);
        const estado = await avaliar(`({ dash: !!document.querySelector('.dash'), login: !!document.querySelector('.login-container'), verificando: !!document.querySelector('.session-check') })`);
        afirmar(estado.dash === false && estado.login === false, `enquanto valida: Dashboard=${estado.dash} Login=${estado.login}`);
        afirmar(estado.verificando === true, 'não há indicação de "Verificando sessão"');
        const indevidas = requisicoesDesde(desde, /\/api\/(admin|air-quality|dashboard)/);
        afirmar(indevidas.length === 0, 'requisições feitas antes da validação: ' + indevidas.map((r) => r.url.replace(/^.*\/api/, '')).join(','));
      } finally {
        await liberar();
      }
      await esperarDashboard();
      afirmar((await itensDoMenu()).length === 8, 'Dashboard Admin não apareceu depois da validação');
      return 'durante a validação: nem Dashboard nem Login, só "Verificando sessão"; depois de validada, o Dashboard Admin abriu';
    });
    await caso('C04', 'token inválido no armazenamento: volta ao Login, limpa a sessão, sem loop e sem ter exibido o Dashboard', async () => {
      await semearSessao({ token: 'token.invalido.qualquer', user: { id: admin.id, nome: 'X', email: admin.email, perfil: 'ADMIN' } });
      const desde = requisicoes.length;
      await recarregar();
      await esperarLogin();
      afirmar((await viu()).dash === false, 'o Dashboard chegou a aparecer');
      afirmar((await guardado('authToken')) === null && (await guardado('user')) === null, 'a sessão inválida não foi limpa');
      await dormir(2500);
      const chamadas = requisicoesDesde(desde, /\/api\/auth\/me/);
      afirmar(chamadas.length >= 1 && chamadas.length <= 2, `chamadas a /auth/me: ${chamadas.length} (esperado 1, ou 2 no StrictMode do dev)`);
      afirmar(chamadas.every((c) => c.status === 401), 'status: ' + chamadas.map((c) => c.status).join(','));
      afirmar(requisicoesDesde(desde, /\/api\//).length === chamadas.length, 'há outras requisições /api além da validação');
      return `${chamadas.length} chamada(s) a /auth/me -> 401; sessão limpa; estável por 2,5 s`;
    });
    await caso('C05', 'sem sessão: abre o Login direto, sem chamar /auth/me e sem exibir o Dashboard', async () => {
      await semSessao();
      const desde = requisicoes.length;
      await recarregar();
      await esperarLogin();
      await dormir(800);
      afirmar((await viu()).dash === false, 'o Dashboard apareceu');
      afirmar(requisicoesDesde(desde, /\/api\//).length === 0, 'chamadas desnecessárias: ' + requisicoesDesde(desde, /\/api\//).map((r) => r.url).join(','));
    });
    await caso('C06', 'perfil adulterado no armazenamento (USUARIO com user.perfil=ADMIN): o F5 usa o perfil do backend', async () => {
      const s = await login(comum);
      await semearSessao({ token: s.token, user: { ...s.user, perfil: 'ADMIN' } });
      await recarregar();
      await esperarDashboard();
      const itens = await itensDoMenu();
      afirmar(JSON.stringify(itens) === JSON.stringify(MENU_USUARIO), 'menu com perfil adulterado: ' + itens.join('|'));
      afirmar(JSON.parse(await guardado('user')).perfil === 'USUARIO', 'o user armazenado continuou com perfil ADMIN');
      return 'Dashboard de USUARIO; o user armazenado foi corrigido para USUARIO';
    });
    await caso('C07', 'usuário desativado com token antigo: o F5 volta ao Login e limpa a sessão', async () => {
      const alvo = await novoUsuario('ADMIN');
      await semearSessao(await login(alvo));
      await definirAtivo(alvo.id, false);
      await recarregar();
      await esperarLogin();
      afirmar((await viu()).dash === false, 'o Dashboard chegou a aparecer');
      afirmar((await guardado('authToken')) === null && (await guardado('user')) === null, 'sessão não limpa');
    });
    await caso('C08', 'token expirado: o F5 volta ao Login e limpa a sessão', async () => {
      const s = await login(comum);
      await semearSessao({ token: assinar({ userId: comum.id, email: comum.email, perfil: 'USUARIO' }, { expiresIn: -30 }), user: s.user });
      await recarregar();
      await esperarLogin();
      afirmar((await viu()).dash === false, 'o Dashboard chegou a aparecer');
      afirmar((await guardado('authToken')) === null && (await guardado('user')) === null, 'sessão não limpa');
    });
    await caso('C09', 'backend indisponível durante a validação: não mostra o Dashboard; ao voltar, o F5 restaura a sessão', async () => {
      await semearSessao(await login(admin));
      const liberar = await interceptar('*/api/auth/me', 'falhar');
      try {
        await recarregar();
        await esperarLogin();
        afirmar((await viu()).dash === false, 'o Dashboard apareceu sem validar a sessão');
      } finally {
        await liberar();
      }
      const preservada = !!(await guardado('authToken'));
      await recarregar();
      await esperarDashboard();
      afirmar((await itensDoMenu()).length === 8, 'sessão não restaurada quando o backend voltou');
      info('C09', `falha de rede não apaga a sessão (token preservado=${preservada}); o Login é exibido até conseguir validar`);
    });

    // ============================================================ D - 401 global (D2) e 403
    console.log('\n===== D. Tratamento global de 401 (D2) e 403 =====');
    await caso('D01', '401 em rota autenticada: remove authToken/user, volta ao Login com aviso e sem loop', async () => {
      const alvo = await novoUsuario('ADMIN');
      await loginPelaTela(alvo.email, alvo.senha);
      await esperarContadores();
      await esperar(`document.querySelectorAll('.pollutant').length === 6 && !/Carregando/.test(document.querySelector('.dash-pollutants').innerText)`, 30000, 'poluentes');
      await definirAtivo(alvo.id, false);
      const desde = requisicoes.length;
      afirmar(await clicarMenu('Usuários'), 'menu Usuários');
      await esperarLogin(10000);
      afirmar((await guardado('authToken')) === null && (await guardado('user')) === null, 'a sessão não foi limpa no 401');
      afirmar((await avaliar(`!document.querySelector('.dash')`)), 'o Dashboard continua na tela');
      afirmar(/sessão/i.test(await avaliar(`document.querySelector('.login-container').innerText`)), 'sem aviso de sessão encerrada no Login');
      const respostas401 = requisicoesDesde(desde, /\/api\//).filter((r) => r.status === 401).length;
      const total1 = requisicoesDesde(desde, /\/api\//).length;
      await dormir(2500);
      const total2 = requisicoesDesde(desde, /\/api\//).length;
      afirmar(total1 === total2, `loop de requisições após o redirecionamento: ${total1} -> ${total2}`);
      afirmar((await avaliar(`document.querySelectorAll('.login-container').length`)) === 1, 'mais de uma tela de Login');
      D01 = alvo;
      return `${respostas401} resposta(s) 401 -> sessão limpa, Login com aviso; ${total2} requisição(ões) e nenhuma nova em 2,5 s`;
    });
    await caso('D02', 'depois do 401 o login normal volta a funcionar (conta reativada)', async () => {
      afirmar(D01, 'sem usuário do caso anterior');
      await definirAtivo(D01.id, true);
      await digitar('input[name="email"]', D01.email);
      await digitar('input[name="password"]', D01.senha);
      await avaliar(`document.querySelector('form').requestSubmit()`);
      await esperarDashboard();
      afirmar((await itensDoMenu()).length === 8, 'menu do ADMIN incompleto');
    });
    await caso('D03', '403 NÃO é tratado como 401: a sessão é mantida, o app permanece e mostra a mensagem de permissão', async () => {
      const alvo = await novoUsuario('ADMIN');
      await loginPelaTela(alvo.email, alvo.senha);
      await esperarContadores();
      await definirPerfil(alvo.id, 'USUARIO');
      const desde = requisicoes.length;
      afirmar(await clicarMenu('Usuários'), 'menu Usuários');
      await esperar(`/Acesso restrito/.test(document.querySelector('.dash-main').innerText)`, 10000, 'mensagem de 403');
      afirmar(requisicoesDesde(desde, /\/api\/admin\/usuarios/).some((r) => r.status === 403), 'não houve resposta 403');
      await dormir(1500);
      afirmar(!!(await guardado('authToken')) && !!(await guardado('user')), 'o 403 limpou a sessão');
      const v = await avaliar(`({ dash: !!document.querySelector('.dash'), login: !!document.querySelector('.login-container') })`);
      afirmar(v.dash === true && v.login === false, 'o 403 redirecionou ao Login');
      return 'HTTP 403 -> permaneceu no Dashboard com "Acesso restrito a administradores"; token e user preservados';
    });
    await caso('D04', 'credenciais erradas no Login (401 de /auth/login) não disparam o tratamento de sessão expirada', async () => {
      await semSessao();
      await recarregar();
      await esperarLogin();
      await digitar('input[name="email"]', comum.email);
      await digitar('input[name="password"]', 'senha-errada-123');
      await avaliar(`document.querySelector('form').requestSubmit()`);
      await esperar(`/Credenciais inválidas/.test((document.querySelector('.error-message')||{}).innerText||'')`, 10000, 'mensagem de credenciais inválidas');
      afirmar((await avaliar(`document.querySelector('input[name="email"]').value`)) === comum.email, 'o formulário foi recriado/limpo');
      afirmar(!/sessão/i.test(await avaliar(`document.querySelector('.login-container').innerText`)), 'o aviso de sessão expirada apareceu no login com senha errada');
    });
    await caso('D05', 'sessão expirada em outra aba: com a rota autenticada em 401 a tela volta ao Login uma única vez (várias chamadas em paralelo)', async () => {
      const alvo = await novoUsuario('ADMIN');
      await semearSessao(await login(alvo));
      await recarregar();
      await esperarDashboard();
      await definirAtivo(alvo.id, false);
      const desde = requisicoes.length;
      // Relatórios dispara resumo + estações + qualidade do ar em paralelo
      afirmar(await clicarMenu('Relatórios'), 'menu');
      await esperarLogin(10000);
      await dormir(2000);
      const novas = requisicoesDesde(desde, /\/api\//);
      const quantos401 = novas.filter((r) => r.status === 401).length;
      afirmar(quantos401 >= 1, 'nenhum 401 observado');
      afirmar((await avaliar(`document.querySelectorAll('.login-container').length`)) === 1 && (await guardado('authToken')) === null, 'estado final inconsistente');
      return `${quantos401} resposta(s) 401 em paralelo -> 1 tela de Login, sessão limpa`;
    });

    // ============================================================ E - Logout
    console.log('\n===== E. Logout =====');
    let tokenAntigo;
    await caso('E01', 'Sair: remove authToken e user e volta ao Login', async () => {
      const alvo = await novoUsuario('ADMIN');
      await loginPelaTela(alvo.email, alvo.senha);
      tokenAntigo = await guardado('authToken');
      afirmar(!!tokenAntigo, 'sem token antes de sair');
      await avaliar(`document.querySelector('.dash-logout').click()`);
      await esperarLogin();
      afirmar((await guardado('authToken')) === null && (await guardado('user')) === null, 'token/user não removidos');
      afirmar(await avaliar(`!document.querySelector('.dash')`), 'Dashboard ainda na tela');
    });
    await caso('E02', 'F5 depois do logout não restaura a sessão encerrada', async () => {
      const desde = requisicoes.length;
      await recarregar();
      await esperarLogin();
      await dormir(600);
      afirmar((await viu()).dash === false, 'o Dashboard apareceu depois do F5');
      afirmar(requisicoesDesde(desde, /\/api\//).length === 0, 'houve chamadas à API sem sessão');
    });
    await caso('E03', 'depois do logout, abrir páginas/rotas administrativas direto exige novo login', async () => {
      for (const caminho of ['/admin', '/admin/usuarios', '/usuarios', '/#/admin']) {
        await navegar(APP + caminho);
        await dormir(400);
        await esperarLogin();
        afirmar((await viu()).dash === false, `o Dashboard apareceu em ${caminho}`);
      }
      await avaliar(`history.back()`);
      await dormir(500);
      afirmar((await avaliar(`!document.querySelector('.dash')`)), 'o Dashboard voltou pelo botão Voltar');
      const semToken = await avaliar(`fetch(${JSON.stringify(API + '/admin/usuarios')}).then(r => r.status)`);
      afirmar(semToken === 401, 'rota administrativa sem token respondeu ' + semToken);
      return 'rotas /admin, /admin/usuarios, /usuarios e /#/admin -> Login; API sem token -> 401';
    });
    {
      const r = await http('/auth/me', { token: tokenAntigo });
      info('E04', `OBSERVAÇÃO: o JWT emitido antes do logout ainda é aceito pelo servidor até expirar (HTTP ${r.status}); não há revogação no servidor (estratégia JWT sem estado já existente, não alterada nesta etapa)`);
    }
    await caso('E05', 'usuário desativado pela tela não consegue logar pela tela (mensagem de credenciais inválidas, sem abrir o Dashboard)', async () => {
      await semSessao();
      await recarregar();
      await esperarLogin();
      await digitar('input[name="email"]', emailUi);
      await digitar('input[name="password"]', 'Senha-123');
      await avaliar(`document.querySelector('form').requestSubmit()`);
      await esperar(`/Credenciais inválidas/.test((document.querySelector('.error-message')||{}).innerText||'')`, 10000, 'mensagem de erro');
      afirmar((await viu()).dash === false && (await guardado('authToken')) === null, 'o desativado entrou ou gravou sessão');
    });
    await caso('E06', 'login do USUARIO comum pela tela: Dashboard de usuário, sem itens administrativos', async () => {
      await loginPelaTela(comum.email, comum.senha);
      const itens = await itensDoMenu();
      afirmar(JSON.stringify(itens) === JSON.stringify(MENU_USUARIO), 'menu: ' + itens.join('|'));
      afirmar(!/Usuário Admin/.test(await avaliar(`document.querySelector('.dash-topbar').innerText`)), 'topo de ADMIN para USUARIO');
      const rotas = await avaliar(`(async () => { const t = localStorage.getItem('authToken'); const h = { Authorization: 'Bearer ' + t }; return Promise.all(['/admin/resumo','/admin/configuracoes','/admin/usuarios','/admin/cidades'].map(p => fetch(${JSON.stringify(API)} + p, { headers: h }).then(r => r.status))) })()`);
      afirmar(rotas.every((s) => s === 403), 'rotas admin pelo navegador do USUARIO: ' + rotas.join(','));
      return `menu do USUARIO: ${itens.join(', ')}; rotas /admin digitadas direto com o token do USUARIO -> ${rotas.join(',')}`;
    });
    await caso('E07', 'a execução inteira não gerou erro de JavaScript não tratado na página', async () => {
      afirmar(errosDePagina.length === 0, 'erros JS: ' + errosDePagina.slice(0, 3).join(' | '));
    });
  } finally {
    try { ws?.close(); } catch { /* ignora */ }
    chrome.proc.kill();
    await dormir(500);
    try { rmSync(chrome.dir, { recursive: true, force: true }); } catch { /* pasta em uso */ }
  }
}

let D01;
try {
  await main();
} catch (e) {
  console.log('[ERRO FATAL] ' + e.message);
  resultados.push({ id: 'FATAL', ok: false });
} finally {
  await limparUsuariosDeTeste().catch(() => {});
  const restantes = await pool.query(`SELECT COUNT(*)::int n FROM usuarios WHERE email LIKE 'tmp.vad.%@example.com'`).then((r) => r.rows[0].n).catch(() => '?');
  await pool.end().catch(() => {});
  const ok = resultados.filter((r) => r.ok).length;
  console.log(`\nResumo: ${ok} aprovado(s), ${resultados.length - ok} reprovado(s) de ${resultados.length}. Usuários temporários restantes no banco: ${restantes}.`);
  console.log(`Prints em: ${SHOTS}`);
  process.exitCode = ok === resultados.length ? 0 : 1;
}
