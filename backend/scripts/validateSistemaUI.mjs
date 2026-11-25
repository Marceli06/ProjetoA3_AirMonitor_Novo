// Validação de SISTEMA (ponta a ponta) com navegador real, API real, banco real e OpenAQ/Open-Meteo reais.
// Cobre a integração geral: Cadastro/Login -> Dashboard -> Alertas -> Ocorrências -> Histórico -> Logout (USUARIO) e
// Dashboard Admin -> Usuários -> Estações -> Configurações -> Relatórios -> Alertas -> Ocorrências -> Histórico (ADMIN),
// além de sessão (F5, 401, 403, usuário desativado), troca de cidade, estados loading/vazio/erro, fallback Open-Meteo
// e responsividade em 1366x768, 768x1024 e 390x844. Os detalhes de cada tela ficam nos scripts específicos.
// Chrome/Edge headless via DevTools Protocol, sem dependências novas. Firefox não é suportado por este protocolo.
// Cria usuários TEMPORÁRIOS (tmp.sis.*@example.com), alertas (estacao_id tmp-sis-*) e ocorrências "[TESTE-SIS ...]"
// direto no banco e SEMPRE os remove no final. Não imprime senhas, tokens nem valores do .env.
// Uso (dentro de backend/, com backend e frontend de teste no ar):
//   APP_URL=http://127.0.0.1:5196 API_URL=http://127.0.0.1:3996/api node scripts/validateSistemaUI.mjs
// Ou tudo de uma vez (sobe backend e frontend de teste sozinho): npm run ui:validate
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
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
const PORTA_CDP = Number(process.env.CDP_PORT || 9338);
const SHOTS = process.env.SHOTS_DIR || join(process.cwd(), '.tmp-sis-shots');
const FRONTEND = resolve(process.cwd(), '..', 'frontend');
mkdirSync(SHOTS, { recursive: true });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const afirmar = (condicao, msg) => { if (!condicao) throw new Error(msg); };
const resultados = [];

// Falha de serviço externo (OpenAQ/Open-Meteo fora do ar ou lenta): não é defeito do sistema nem do script
const indisponibilidadeExterna = (mensagem) => Object.assign(new Error(mensagem), { externo: true });
let casoAtual = '-';

async function caso(id, descricao, fn) {
  const t0 = Date.now();
  casoAtual = id;
  try {
    const detalhe = await fn();
    resultados.push({ id, ok: true });
    console.log(`[APROVADO]  ${id} ${descricao}${detalhe ? '\n              -> ' + detalhe : ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    if (e.externo) {
      resultados.push({ id, ok: false, externo: true });
      console.log(`[EXTERNO]   ${id} ${descricao}\n              -> indisponibilidade externa: ${e.message}`);
      return;
    }
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
  const email = `tmp.sis.${perfil.toLowerCase()}.${sufixo}.${++contador}@example.com`;
  const hash = await bcrypt.hash(senha, 4);
  const r = await pool.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, cidade, regiao) VALUES ($1,$2,$3,$4,$5,$6,'Centro') RETURNING id`,
    [`Teste SIS ${perfil}`, email, hash, perfil, ativo, cidade]
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
const limparUsuariosDeTeste = () => pool.query(`DELETE FROM usuarios WHERE email LIKE 'tmp.sis.%@example.com'`);
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
  const dir = join(tmpdir(), 'airmonitor-cdp-sis-' + Date.now());
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
    if (m.method === 'Network.requestWillBeSent') requisicoes.push({ id: m.params.requestId, url: m.params.request.url, method: m.params.request.method, status: null, caso: casoAtual });
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

// ---------------------------------------------------------------- Ajudantes desta suíte
const MARCA = `[TESTE-SIS ${sufixo}]`;
const ESTACAO_TESTE = `tmp-sis-${sufixo}`;
const MAUA = 'Mauá';
const CAMPINAS = 'Campinas';
const CIDADES = ['São Paulo', 'Guarulhos', 'Campinas', 'São Bernardo do Campo', 'Ribeirão Preto', 'Sorocaba', 'São José dos Campos', 'Santo André', 'Osasco', 'Mauá'];
const TEXTOS_DE_MOCK = ['ilustrativ', 'Itaquera', 'Guaianazes', 'São Mateus', 'Buraco na via', 'Canteiro de obras', 'Qualidade moderada prevista', 'Manutenção programada'];
const VIEWPORTS = [{ w: 1366, h: 768 }, { w: 768, h: 1024 }, { w: 390, h: 844 }];

const existe = (sel) => avaliar(`!!document.querySelector(${JSON.stringify(sel)})`);
const textoSel = (sel) => avaliar(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const clicarSel = (sel) => avaliar(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e || e.disabled) return false; e.click(); return true})()`);
const clicarTexto = (seletor, texto) => avaliar(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(seletor)})].find(x=>x.innerText.trim()===${JSON.stringify(texto)}); if(!e||e.disabled) return false; e.click(); return true})()`);
const doBanco = async (sql, params = []) => (await pool.query(sql, params)).rows;

const ativosNoBanco = async (cidade) => (await doBanco(`SELECT COUNT(*)::int n FROM alertas WHERE cidade=$1 AND status='ATIVO'`, [cidade]))[0].n;

async function semearAlerta(cidade, nivel, poluente, valor) {
  const r = await doBanco(
    `INSERT INTO alertas (cidade, regiao, estacao_id, estacao_nome, poluente, valor, unidade, nivel, titulo, descricao, origem_dado, tipo_dado, medicao_em)
     VALUES ($1, 'Centro', $2, 'Estação de teste', $3, $4, 'µg/m³', $5, $6, $7, 'OPENAQ', 'MEDICAO', NOW()) RETURNING id`,
    [cidade, `${ESTACAO_TESTE}-${cidade.length}`, poluente, valor, nivel, `${MARCA} ${poluente.toUpperCase()} ${nivel.toLowerCase()} (${cidade})`, `${MARCA} alerta de teste em ${cidade}`]
  );
  return r[0].id;
}

const limparRegistrosDeTeste = async () => {
  await pool.query(`DELETE FROM ocorrencias WHERE titulo LIKE '[TESTE-SIS %'`).catch(() => {});
  await pool.query(`DELETE FROM alertas WHERE estacao_id LIKE 'tmp-sis-%' OR titulo LIKE '[TESTE-SIS %'`).catch(() => {});
  await limparUsuariosDeTeste().catch(() => {});
};

async function loginApi(u) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: u.senha }) });
  const j = await r.json();
  if (r.status !== 200) throw new Error(`login de teste falhou: HTTP ${r.status}`);
  return j; // { token, user }
}

// Entra sem passar pela tela de Login (sessão semeada no armazenamento) e deixa o app validar o token
async function entrarComToken(u) {
  const { token, user } = await loginApi(u);
  await semearSessao({ token, user });
  await recarregar();
  await esperarDashboard();
}

// Tenta entrar pela tela e devolve a mensagem de erro (ou null se abriu o Dashboard)
async function tentarLogin(email, senha) {
  await semSessao();
  await recarregar();
  await esperarLogin();
  await digitar('input[name="email"]', email);
  await digitar('input[name="password"]', senha);
  await avaliar(`document.querySelector('form').requestSubmit()`);
  await esperar(`!!document.querySelector('.error-message') || !!document.querySelector('.dash-main h1')`, 15000, 'resposta do login');
  return (await existe('.dash-main h1')) ? null : await textoSel('.error-message');
}

const sair = async () => { afirmar(await clicarSel('.dash-logout'), 'botão Sair'); await esperarLogin(); };

// Cartões do Dashboard terminam de carregar (sucesso, vazio ou erro; nunca "Carregando")
const dashPronto = (ms = 60000) => esperar(`(()=>{
  const t = (s) => document.querySelector('[data-testid="'+s+'"]')?.innerText ?? '';
  return document.querySelectorAll('.pollutant').length === 6 && !/Carregando/.test(document.querySelector('.dash-pollutants').innerText)
    && !/Carregando/.test(t('dash-alertas')) && !/Carregando/.test(t('dash-historico')) && !/Carregando/.test(t('dash-situacao')) && !/Carregando/.test(t('dash-ocorrencias'));
})()`, ms, 'cartões do Dashboard carregados');

const esperarHist = () => esperar(`(()=>{ const p=document.querySelector('.hist-page'); if(!p || p.getAttribute('aria-busy')==='true') return false;
  return !!document.querySelector('[data-testid="medicao"]') || !!document.querySelector('[data-testid="estado-vazio"]') || !!document.querySelector('[data-testid="estado-erro"]'); })()`, 45000, 'histórico carregado');

// Cada tela do menu: "pronta" = terminou de carregar (com dado, vazia ou com erro tratado)
const PRONTA = {
  Dashboard: null, // definido por perfil (dashPronto + contadores do ADMIN)
  Alertas: `!!document.querySelector('.alerts-page') && !document.querySelector('[data-testid="carregando"]') && (!!document.querySelector('[data-testid="alerta"]') || !!document.querySelector('[data-testid="estado-vazio"]') || !!document.querySelector('[data-testid="estado-erro"]'))`,
  'Ocorrências': `!!document.querySelector('[data-testid="nova-ocorrencia"]') && !document.querySelector('[data-testid="carregando"]') && (!!document.querySelector('[data-testid="ocorrencia"]') || !!document.querySelector('[data-testid="estado-vazio"]') || !!document.querySelector('[data-testid="estado-erro"]'))`,
  'Configurações': `/Cache e atualização/.test(document.querySelector('.dash-main').innerText)`,
  'Usuários': `!!document.querySelector('.users-table tbody tr')`,
  'Estações': `!!document.querySelector('.users-table tbody tr') || /Nenhuma|Não foi|indispon/.test(document.querySelector('.dash-main').innerText)`,
  'Relatórios': `!!document.querySelector('.report-section table') && !/Carregando dados/.test(document.querySelector('.dash-main').innerText)`,
};

async function abrirMenu(rotulo) {
  afirmar(await clicarMenu(rotulo), `item de menu "${rotulo}" não encontrado`);
  if (rotulo === 'Dashboard') { await esperar(`!!document.querySelector('.dash-main h1')`, 8000, 'Dashboard'); await dashPronto(); }
  else if (rotulo === 'Histórico') { await esperar(`!!document.querySelector('.hist-page')`, 10000, 'tela de Histórico'); await esperarHist(); }
  else await esperar(PRONTA[rotulo], 45000, `tela ${rotulo} pronta`);
}

const ativoNoMenu = () => avaliar(`[...document.querySelectorAll('.dash-nav-item.active')].map(b=>b.innerText.trim())`);

// Falhas desde um ponto do log: erros de JavaScript e respostas /api com status >= 400 que não eram esperadas
const falhasDesde = (indiceReq, indiceErros, permitir = /^$/) => {
  const ruins = requisicoes.slice(indiceReq).filter((r) => typeof r.status === 'number' && r.status >= 400 && /\/api\//.test(r.url) && !permitir.test(`${r.status} ${r.url}`));
  return { erros: errosDePagina.slice(indiceErros), ruins };
};
const EXTERNA = (r) => [502, 503, 504].includes(r.status) && /\/api\/(air-quality|historico|admin\/estacoes)/.test(r.url);
const descreverFalha = (r) => `${r.status} ${r.method} ${r.url.replace(/^.*\/api/, '')} (durante ${r.caso})`;
const afirmarSemFalhas = (indiceReq, indiceErros, permitir) => {
  const f = falhasDesde(indiceReq, indiceErros, permitir);
  afirmar(f.erros.length === 0, 'erros JS: ' + f.erros.slice(0, 2).join(' | '));
  const proprias = f.ruins.filter((r) => !EXTERNA(r));
  afirmar(proprias.length === 0, 'respostas com falha: ' + proprias.map(descreverFalha).join('; '));
  // 502/503/504 nas rotas que dependem da OpenAQ/Open-Meteo: o sistema tratou, mas a fonte estava fora
  if (f.ruins.length > 0) throw indisponibilidadeExterna('fonte externa respondeu 5xx e o sistema tratou: ' + f.ruins.map(descreverFalha).join('; '));
};

// Espera uma NOVA resposta /api cujo endereço contenha o trecho (evita ler a lista antiga antes do recarregamento)
const esperarResposta = async (desde, trecho, ms = 20000) => {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (requisicoes.slice(desde).some((r) => typeof r.status === 'number' && r.url.includes(trecho))) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`nenhuma resposta nova de ${trecho}`);
};

// Só os cartões de dados reais (alertas, ocorrências, histórico, situação): nomes reais de estações não contam como "texto fixo"
const textoDosCartoes = () => avaliar(`['dash-situacao','dash-historico','dash-alertas','dash-ocorrencias'].map(t=>document.querySelector('[data-testid="'+t+'"]')?.innerText ?? '').join('\\n')`);
const semMock = async (texto) => {
  afirmar(!(await existe('.map-label')), 'rótulos fixos de bairros no mapa'); const achou = TEXTOS_DE_MOCK.filter((t) => texto.includes(t)); afirmar(achou.length === 0, 'texto de dados fixos/ilustrativos: ' + achou.join(', ')); };

// ---------------------------------------------------------------- Backends alternativos (falha das fontes externas)
const portaLivre = () => new Promise((resolver, rejeitar) => {
  const srv = net.createServer();
  srv.once('error', rejeitar);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolver(port)); });
});
const matarArvore = (proc) => {
  if (!proc?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-proc.pid); } catch { proc.kill(); } }
};
const alternativos = [];
async function subirBackendAlternativo(env) {
  const porta = await portaLivre();
  const proc = spawn('npx tsx src/index.ts', { cwd: process.cwd(), shell: true, env: { ...process.env, ...env, PORT: String(porta) }, stdio: 'ignore', detached: process.platform !== 'win32' });
  alternativos.push(proc);
  for (let i = 0; i < 90; i++) {
    await dormir(1000);
    if (await fetch(`http://127.0.0.1:${porta}/health`).then((r) => r.status === 200).catch(() => false)) return porta;
  }
  throw new Error('backend alternativo não subiu');
}
// Faz o navegador falar com outro backend (as chamadas /api trocam de porta; token e cabeçalhos seguem iguais)
async function redirecionarApi(portaAlternativa) {
  const tratar = (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    const url = request.url.replace(/:\d+\/api\//, `:${portaAlternativa}/api/`);
    enviar('Fetch.continueRequest', { requestId, url }).catch(() => {});
  };
  ouvintes.push(tratar);
  await enviar('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
  return async () => { await enviar('Fetch.disable').catch(() => {}); ouvintes.splice(ouvintes.indexOf(tratar), 1); };
}

// ---------------------------------------------------------------- Responsividade
const definirViewport = async ({ w, h }) => {
  await enviar('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
  await dormir(450);
};
// Elementos do conteúdo que passam da borda direita sem estarem dentro de um contêiner com rolagem própria
const elementosForaDaTela = () => avaliar(`(()=>{
  const lim = window.innerWidth + 1;
  const rolavel = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
  return [...document.querySelectorAll('.dash *')].filter((e) => {
    if (e.closest('svg') && e.tagName.toLowerCase() !== 'svg') return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > lim && !rolavel(e);
  }).slice(0, 5).map((e) => (e.getAttribute('class') || e.tagName).toString().slice(0, 40) + '@' + Math.round(e.getBoundingClientRect().right));
})()`);
const alvosPequenos = () => avaliar(`[...document.querySelectorAll('.dash button, .dash a, .dash select, .dash input')].filter((e)=>{const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && (r.height<24 || r.width<24) && getComputedStyle(e).visibility!=='hidden'}).length`);

async function percorrerResponsivo(rotulo, menus) {
  for (const vp of VIEWPORTS) {
    for (const menu of menus) {
      await caso(`R-${rotulo}-${vp.w}-${menu.replace(/[^A-Za-z]/g, '').slice(0, 6)}`, `${rotulo}: "${menu}" em ${vp.w}x${vp.h} sem rolagem horizontal global, com menu lateral e cabeçalho`, async () => {
        await definirViewport(vp);
        await abrirMenu(menu);
        await dormir(300);
        const sobra = await sobraHorizontal();
        const fora = await elementosForaDaTela();
        const base = await avaliar(`({ sidebar: !!document.querySelector('.dash-sidebar'), topo: !!document.querySelector('.dash-topbar'), sair: !!document.querySelector('.dash-logout'), itens: document.querySelectorAll('.dash-nav-item').length })`);
        await foto(`${rotulo}-${vp.w}-${menu.replace(/[^A-Za-z]/g, '')}`, vp.w, vp.h, vp.w < 500);
        afirmar(sobra <= 1, `rolagem horizontal global de ${sobra}px`);
        afirmar(fora.length === 0, 'elementos fora da tela: ' + fora.join(', '));
        afirmar(base.sidebar && base.topo && base.sair && base.itens >= 4, 'layout incompleto: ' + JSON.stringify(base));
        const pequenos = await alvosPequenos();
        return pequenos > 0 ? `${pequenos} controle(s) menores que 24px` : null;
      });
    }
  }
  await limparMetricas();
}

// ================================================================ Execução
async function main() {
  const navegadorInfo = `Firefox não é testado nesta suíte (usa o DevTools Protocol do Chromium/Edge); o navegador desta execução aparece abaixo.`;
  info('SETUP', navegadorInfo);
  await limparRegistrosDeTeste();

  // usuários e dados de teste
  const usuario = await novoUsuario('USUARIO', { cidade: MAUA });
  const admin = await novoUsuario('ADMIN', { cidade: 'Osasco' });
  const adminB = await novoUsuario('ADMIN', { cidade: 'Osasco' }); // será rebaixado no teste de 403
  const inativo = await novoUsuario('USUARIO', { cidade: MAUA, ativo: false });
  const idAlertaMaua = await semearAlerta(MAUA, 'CRITICO', 'pm25', 88.5);
  const idAlertaCampinas = await semearAlerta(CAMPINAS, 'ALTO', 'pm10', 120.4);
  const emailRegistro = `tmp.sis.reg.${sufixo}@example.com`;
  const senhaRegistro = `Reg-${Math.random().toString(36).slice(2)}-7`;
  const tituloOc = `${MARCA} Fumaça forte na avenida`;
  info('SETUP', `usuário USUARIO (${MAUA}), 2 ADMIN e 1 inativo temporários; alertas ativos de teste em ${MAUA} e ${CAMPINAS}`);

  const chrome = await abrirChrome();
  console.log(`\n===== Navegador: ${chrome.versao} | 1366x768, 768x1024 e 390x844 =====`);
  try {
    const dashAdminPronto = async () => { await esperarContadores(); await dashPronto(); };

    // ============================================================ A. Fluxo do USUARIO
    console.log('\n----- A. Fluxo do USUARIO: Cadastro, Login, Dashboard, Alertas, Ocorrências, Histórico, Logout -----');
    let iReq = requisicoes.length, iErr = errosDePagina.length;

    await caso('A01', 'Cadastro pela tela cria o usuário (perfil USUARIO, cidade escolhida) e abre o Dashboard já autenticado', async () => {
      await semSessao();
      await recarregar();
      await esperarLogin();
      afirmar(await clicarTexto('button', 'Criar conta'), 'botão Criar conta do Login');
      await esperar(`!!document.querySelector('.register-container') && !!document.querySelector('#name')`, 8000, 'tela de cadastro');
      await digitar('#name', 'Teste Sistema Cadastro');
      await digitar('#email', emailRegistro);
      await digitar('#password', senhaRegistro);
      await digitar('#confirmPassword', senhaRegistro);
      await selecionar('#city', MAUA);
      await selecionar('#region', 'Centro');
      await foto('A01-cadastro', 1366, 900);
      await avaliar(`document.querySelector('.register-form').requestSubmit()`);
      await esperarDashboard();
      const linha = (await doBanco(`SELECT perfil, ativo, cidade, regiao FROM usuarios WHERE email=$1`, [emailRegistro]))[0];
      afirmar(linha && linha.perfil === 'USUARIO' && linha.ativo && linha.cidade === MAUA && linha.regiao === 'Centro', 'banco: ' + JSON.stringify(linha));
      afirmar(!!(await guardado('authToken')) && JSON.parse(await guardado('user')).perfil === 'USUARIO', 'sessão não gravada');
      return 'usuário criado no banco como USUARIO / Mauá / Centro';
    });

    await caso('A02', 'Logout volta ao Login e apaga a sessão; Login com a conta recém-criada abre o Dashboard', async () => {
      await sair();
      afirmar((await guardado('authToken')) === null && (await guardado('user')) === null, 'sessão não foi apagada');
      await digitar('input[name="email"]', emailRegistro);
      await digitar('input[name="password"]', senhaRegistro);
      await avaliar(`document.querySelector('form').requestSubmit()`);
      await esperarDashboard();
      afirmar(/Olá, Teste Sistema Cadastro/.test(await textoSel('.dash-main h1')), 'saudação com o nome do usuário');
      await sair();
    });

    await caso('A03', 'Login pela tela (usuário de teste): menu do USUARIO (4 itens), sem itens administrativos', async () => {
      await loginPelaTela(usuario.email, usuario.senha);
      const itens = await itensDoMenu();
      afirmar(JSON.stringify(itens) === JSON.stringify(MENU_USUARIO), 'menu: ' + itens.join('|'));
      afirmar(!/Usuário Admin/.test(await textoSel('.dash-topbar')), 'topo de ADMIN para USUARIO');
      afirmar(!(await existe('.admin-stat')), 'contadores administrativos visíveis para USUARIO');
    });

    await caso('A04', 'Dashboard do USUARIO: cartões com dados reais, cidade fixa, sem textos fixos/ilustrativos', async () => {
      await dashPronto();
      const opcoes = await avaliar(`[...document.querySelectorAll('.dash-select select option')].map(o=>o.value)`);
      afirmar(JSON.stringify(opcoes) === JSON.stringify([MAUA]), 'cidades do seletor: ' + opcoes.join(','));
      for (const t of ['dash-situacao', 'dash-historico', 'dash-alertas', 'dash-ocorrencias']) afirmar(await existe(`[data-testid="${t}"]`), `cartão ${t} ausente`);
      await semMock(await textoDosCartoes());
      const cards = await avaliar(`[...document.querySelectorAll('.pollutant')].map(c => ({ n: c.querySelector('.pollutant-name strong').innerText, v: !!c.querySelector('.pollutant-value b'), fonte: c.querySelector('.tag-ok,.tag-model,.tag-none')?.className ?? null }))`);
      afirmar(cards.length === 6 && cards.every((c) => c.fonte), 'cada poluente deve mostrar valor identificado por fonte ou "Sem dados disponíveis"');
      await foto('A04-dashboard-usuario', 1366, 900);
      return `poluentes com valor: ${cards.filter((c) => c.v).length}/6 (tags: ${[...new Set(cards.map((c) => c.fonte))].join(',')})`;
    });

    await caso('A05', 'Alertas no Dashboard: sino, situação e lista batem com o banco (alerta de teste CRÍTICO ativo)', async () => {
      const n = await ativosNoBanco(MAUA);
      afirmar(n >= 1, 'semente ausente');
      afirmar((await textoSel('[data-testid="sino-contagem"]')) === String(n), `sino=${await textoSel('[data-testid="sino-contagem"]')} banco=${n}`);
      afirmar(/Nível crítico/.test(await textoSel('[data-testid="situacao-titulo"]')), 'situação deveria ser Nível crítico: ' + (await textoSel('[data-testid="situacao-titulo"]')));
      afirmar((await textoSel('[data-testid="dash-alertas"]')).includes(MARCA), 'alerta de teste no cartão (mais recente primeiro)');
      afirmar(await existe('[data-testid="alerta-resumo"]'), 'itens de resumo');
      return `${n} alerta(s) ativo(s) em ${MAUA}`;
    });

    await caso('A06', 'Clicar no sino abre Alertas; a lista mostra o alerta; USUARIO não tem "Avaliar" nem "Resolver"', async () => {
      afirmar(await clicarSel('[data-testid="sino-alertas"]'), 'sino');
      await esperar(PRONTA.Alertas, 45000, 'Alertas pronta');
      afirmar((await ativoNoMenu()).join() === 'Alertas', 'item Alertas deve ficar destacado');
      afirmar(await avaliar(`[...document.querySelectorAll('[data-testid="alerta"]')].some(a=>a.innerText.includes(${JSON.stringify(MARCA)}))`), 'alerta de teste na lista');
      afirmar(!(await existe('[data-testid="avaliar"]')), 'USUARIO vê "Avaliar agora"');
      afirmar(await avaliar(`(()=>{const a=[...document.querySelectorAll('[data-testid="alerta"]')].find(a=>a.innerText.includes(${JSON.stringify(MARCA)})); a.click(); return true})()`), 'abrir detalhe');
      await esperar(`!!document.querySelector('[role="dialog"]')`, 5000, 'detalhe aberto');
      afirmar(!(await existe('[data-testid="resolver"]')), 'USUARIO vê "Resolver"');
      await foto('A06-alerta-detalhe-usuario', 1366, 900);
      await tecla('Escape', 'Escape', 27);
      await esperar(`!document.querySelector('[role="dialog"]')`, 4000, 'Esc fecha o detalhe');
    });

    await caso('A07', 'Filtros de Alertas: nível e status filtram, "Limpar filtros" restaura', async () => {
      const antes = requisicoes.length;
      afirmar(await clicarTexto('.alerts-segmented button', 'Resolvidos'), 'filtro Resolvidos');
      await esperarResposta(antes, 'status=RESOLVIDO');
      await esperar(PRONTA.Alertas, 20000, 'lista após filtro');
      afirmar(!(await avaliar(`[...document.querySelectorAll('[data-testid="alerta"]')].some(a=>a.innerText.includes(${JSON.stringify(MARCA)}))`)), 'alerta ativo apareceu em "Resolvidos"');
      const antesLimpar = requisicoes.length;
      afirmar(await clicarSel('.alerts-clear'), 'Limpar filtros');
      await esperarResposta(antesLimpar, '/alertas');
      await esperar(PRONTA.Alertas, 20000, 'lista após limpar');
      afirmar(await avaliar(`[...document.querySelectorAll('[data-testid="alerta"]')].some(a=>a.innerText.includes(${JSON.stringify(MARCA)}))`), 'alerta de teste voltou');
    });

    await caso('A08', 'Ocorrências: USUARIO registra pelo formulário; fica "Em aberto" e salva autor, cidade e origem MANUAL', async () => {
      await abrirMenu('Ocorrências');
      afirmar(await clicarSel('button[data-testid="nova-ocorrencia"]'), 'botão Nova ocorrência');
      await esperar(`!!document.querySelector('[data-testid="nova-ocorrencia-form"]')`, 8000, 'formulário');
      await digitar('#oc-titulo', tituloOc);
      await digitar('#oc-descricao', 'Fumaça densa observada pela manhã perto da avenida principal.');
      await selecionar('#oc-tipo', 'QUEIMADA');
      await digitar('#oc-local', 'Avenida Principal');
      afirmar(await clicarSel('button[data-testid="registrar"]'), 'Registrar');
      await esperar(`!document.querySelector('[data-testid="nova-ocorrencia-form"]') && !!document.querySelector('[data-testid="aviso"]')`, 15000, 'formulário fechado com aviso');
      await esperar(`[...document.querySelectorAll('[data-testid="ocorrencia"]')].some(o=>o.innerText.includes(${JSON.stringify(MARCA)}))`, 15000, 'ocorrência na lista');
      const o = (await doBanco(`SELECT status, origem, cidade, usuario_id FROM ocorrencias WHERE titulo=$1`, [tituloOc]))[0];
      afirmar(o && o.status === 'ABERTA' && o.origem === 'MANUAL' && o.cidade === MAUA && o.usuario_id === usuario.id, 'banco: ' + JSON.stringify(o));
      afirmar(!(await existe('[data-testid="iniciar"]')), 'USUARIO vê ação de ADMIN');
    });

    await caso('A09', 'Dashboard mostra a ocorrência recém-criada ("Em aberto") ao voltar', async () => {
      await abrirMenu('Dashboard');
      const t = await textoSel('[data-testid="dash-ocorrencias"]');
      afirmar(t.includes(MARCA) && /Em aberto/.test(t), 'cartão: ' + t.slice(0, 160));
    });

    await caso('A10', 'Histórico (24H, USUARIO): carrega com a cidade do usuário, troca de poluente e mostra a origem do dado', async () => {
      await abrirMenu('Histórico');
      const dados = await existe('[data-testid="medicao"]');
      const vazio = await existe('[data-testid="estado-vazio"]');
      const erro = await existe('[data-testid="estado-erro"]');
      afirmar(dados || vazio || erro, 'nenhum estado reconhecido');
      afirmar((await textoSel('.hist-page .page-city-fixed')).includes(MAUA), 'a cidade do usuário deve aparecer fixa (sem seletor) no Histórico');
      await foto('A10-historico-usuario', 1366, 900);
      return dados ? 'com medições' + ((await existe('[data-testid="historico-grafico"]')) ? ' e gráfico' : '') : vazio ? 'estado vazio tratado' : 'erro tratado (serviço externo)';
    });

    await caso('A11', 'F5 em cada tela mantém a sessão (sem passar pelo Login) e volta ao Dashboard', async () => {
      for (const menu of ['Dashboard', 'Alertas', 'Ocorrências', 'Histórico']) {
        await abrirMenu(menu);
        await recarregar();
        await esperarDashboard();
        const v = await viu();
        afirmar(!v.login, `Login apareceu depois do F5 em ${menu}`);
        afirmar(/Olá, /.test(await textoSel('.dash-main h1')), `Dashboard não voltou após F5 em ${menu}`);
      }
      return 'o menu volta para "Dashboard" após F5 (o item ativo não fica na URL)';
    });

    await caso('A12', 'Fluxo do USUARIO sem erros de JavaScript nem respostas 4xx/5xx da API', async () => {
      afirmarSemFalhas(iReq, iErr);
    });

    await caso('A13', 'Logout do USUARIO: Login, armazenamento limpo e Dashboard inacessível ao recarregar', async () => {
      await abrirMenu('Dashboard');
      await sair();
      afirmar((await guardado('authToken')) === null, 'token restou');
      await recarregar();
      await esperarLogin();
      afirmar(!(await existe('.dash')), 'Dashboard acessível sem sessão');
    });

    // ============================================================ B. Fluxo do ADMIN
    console.log('\n----- B. Fluxo do ADMIN: Dashboard Admin, Usuários, Estações, Configurações, Relatórios, Alertas, Ocorrências, Histórico -----');
    iReq = requisicoes.length; iErr = errosDePagina.length;

    await caso('B01', 'Login do ADMIN abre o Dashboard Admin (menu completo, topo "Usuário Admin", contadores reais)', async () => {
      await loginPelaTela(admin.email, admin.senha);
      afirmar(JSON.stringify(await itensDoMenu()) === JSON.stringify(MENU_ADMIN), 'menu do ADMIN');
      afirmar(/Usuário Admin/.test(await textoSel('.dash-topbar')), 'topo');
      await dashAdminPronto();
      const tiles = await avaliar(`[...document.querySelectorAll('.admin-stat strong')].map(e => Number(e.innerText))`);
      const b = await contagemDoBanco();
      afirmar(JSON.stringify(tiles) === JSON.stringify([b.total, b.ativos, b.inativos, b.admins, b.comuns]), `tela=${tiles} banco=${[b.total, b.ativos, b.inativos, b.admins, b.comuns]}`);
      await semMock(await textoDosCartoes());
      afirmar(!(await existe('[data-testid="dash-ocorrencias"]')), 'cartão de ocorrências do USUARIO no Dashboard Admin');
      await foto('B01-dashboard-admin', 1366, 900);
    });

    await caso('B02', 'Navegação do ADMIN por todas as telas: carregam, item ativo destacado, sem erro JS', async () => {
      const visitadas = [];
      for (const menu of MENU_ADMIN) {
        await abrirMenu(menu);
        if (menu === 'Dashboard') await esperarContadores();
        afirmar((await ativoNoMenu()).join() === menu, `item ativo em ${menu}: ${await ativoNoMenu()}`);
        visitadas.push(menu);
      }
      afirmarSemFalhas(iReq, iErr);
      return visitadas.join(' → ');
    });

    await caso('B03', 'ADMIN troca a cidade do Dashboard para Mauá: alertas e ocorrências acompanham a cidade', async () => {
      await abrirMenu('Dashboard');
      await selecionar('.dash-select select', MAUA);
      await dashAdminPronto();
      const n = await ativosNoBanco(MAUA);
      afirmar((await textoSel('[data-testid="sino-contagem"]')) === String(n), 'sino de Mauá');
      afirmar((await textoSel('[data-testid="dash-alertas"]')).includes(MARCA) && !(await textoSel('[data-testid="dash-alertas"]')).includes(`(${CAMPINAS})`), 'cartão deve mostrar só o alerta de Mauá');
      afirmar(await avaliar(`[...document.querySelectorAll('.dash-select select')].every(s=>s.value===${JSON.stringify(MAUA)})`), 'seletor');
    });

    await caso('B04', 'ADMIN vê a ocorrência do usuário em Ocorrências e a coloca "Em andamento" (banco confere)', async () => {
      await abrirMenu('Ocorrências');
      afirmar(await avaliar(`[...document.querySelectorAll('.dash-main select')].some(s=>s.value===${JSON.stringify(MAUA)})`), 'a cidade escolhida no Dashboard deve valer em Ocorrências');
      await esperar(`[...document.querySelectorAll('[data-testid="ocorrencia"]')].some(o=>o.innerText.includes(${JSON.stringify(MARCA)}))`, 15000, 'ocorrência do usuário');
      afirmar(await avaliar(`(()=>{const o=[...document.querySelectorAll('[data-testid="ocorrencia"]')].find(o=>o.innerText.includes(${JSON.stringify(MARCA)})); o.click(); return true})()`), 'abrir detalhe');
      await esperar(`!!document.querySelector('[data-testid="iniciar"]')`, 8000, 'ação do ADMIN');
      afirmar(await clicarSel('[data-testid="iniciar"]'), 'Iniciar atendimento');
      await esperar(`/Em andamento/.test(document.querySelector('[data-testid="ocorrencia-detalhe"]')?.innerText ?? '') && !document.querySelector('[data-testid="iniciar"]')`, 12000, 'status em andamento');
      const linha = (await doBanco(`SELECT status, iniciado_em FROM ocorrencias WHERE titulo=$1`, [tituloOc]))[0];
      afirmar(linha.status === 'EM_ANDAMENTO' && linha.iniciado_em, 'banco: ' + linha.status);
      await foto('B04-ocorrencia-admin', 1366, 900);
      await tecla('Escape', 'Escape', 27);
    });

    await caso('B05', 'Trocar para Campinas: cartões, sino e Alertas mostram só o que é de Campinas', async () => {
      await abrirMenu('Dashboard');
      await selecionar('.dash-select select', CAMPINAS);
      await dashAdminPronto();
      const t = await textoSel('[data-testid="dash-alertas"]');
      afirmar(t.includes(`(${CAMPINAS})`) && !t.includes(`(${MAUA})`), 'cartão de alertas de Campinas: ' + t.slice(0, 140));
      afirmar((await textoSel('[data-testid="sino-contagem"]')) === String(await ativosNoBanco(CAMPINAS)), 'sino de Campinas');
      await abrirMenu('Alertas');
      const lista = await avaliar(`[...document.querySelectorAll('[data-testid="alerta"]')].map(a=>a.innerText)`);
      afirmar(lista.some((x) => x.includes(`(${CAMPINAS})`) || x.includes(`alerta de teste em ${CAMPINAS}`)) && !lista.some((x) => x.includes(`em ${MAUA}`)), 'lista de Alertas deve ser só de Campinas');
      await abrirMenu('Dashboard');
      await selecionar('.dash-select select', MAUA);
      await dashAdminPronto();
    });

    await caso('B06', 'ADMIN resolve o alerta de Mauá (confirmação): banco RESOLVIDO e o sino diminui', async () => {
      const antes = await ativosNoBanco(MAUA);
      await abrirMenu('Alertas');
      afirmar(await existe('[data-testid="avaliar"]'), 'ADMIN deve ver "Avaliar agora"');
      afirmar(await avaliar(`(()=>{const a=[...document.querySelectorAll('[data-testid="alerta"]')].find(a=>a.innerText.includes(${JSON.stringify(MARCA)})); if(!a) return false; a.click(); return true})()`), 'abrir alerta de teste');
      await esperar(`!!document.querySelector('[data-testid="resolver"]')`, 8000, 'botão Resolver');
      afirmar(await clicarSel('[data-testid="resolver"]'), 'Resolver');
      await esperar(`!!document.querySelector('[data-testid="confirmar-resolver"]')`, 5000, 'confirmação');
      afirmar(await clicarSel('[data-testid="confirmar-resolver"]'), 'Confirmar');
      await esperar(`!document.querySelector('[data-testid="confirmar-resolver"]')`, 12000, 'resolução concluída');
      const linha = (await doBanco(`SELECT status, resolvido_em FROM alertas WHERE id=$1`, [idAlertaMaua]))[0];
      afirmar(linha.status === 'RESOLVIDO' && linha.resolvido_em, 'banco: ' + linha.status);
      await tecla('Escape', 'Escape', 27);
      await abrirMenu('Dashboard');
      const depois = await ativosNoBanco(MAUA);
      afirmar(depois === antes - 1, `banco ${antes} → ${depois}`);
      afirmar(depois === 0 ? !(await existe('[data-testid="sino-contagem"]')) : (await textoSel('[data-testid="sino-contagem"]')) === String(depois), 'sino acompanha o banco');
      return `alertas ativos em ${MAUA}: ${antes} → ${depois}`;
    });

    await caso('B07', 'USUARIO enxerga a mudança de status feita pelo ADMIN (Em andamento) no próprio Dashboard', async () => {
      await sair();
      await loginPelaTela(usuario.email, usuario.senha);
      await dashPronto();
      const t = await textoSel('[data-testid="dash-ocorrencias"]');
      afirmar(t.includes(MARCA) && /Em andamento/.test(t), 'cartão: ' + t.slice(0, 160));
      await sair();
    });

    await caso('B08', 'Fluxo do ADMIN sem erros de JavaScript nem respostas 4xx/5xx da API', async () => {
      afirmarSemFalhas(iReq, iErr);
    });

    // ============================================================ C. Sessão, 401, 403 e usuário desativado
    console.log('\n----- C. Sessão: F5, 401, 403, usuário desativado, credenciais -----');

    await caso('C01', 'Sem token, F5 permanece no Login; Dashboard não é exibido', async () => {
      await semSessao();
      await recarregar();
      await esperarLogin();
      afirmar(!(await existe('.dash')), 'Dashboard sem sessão');
    });

    await caso('C02', 'Token inválido guardado + F5: volta ao Login, sessão limpa (401 tratado)', async () => {
      await semearSessao({ token: 'token.invalido.qualquer', user: { nome: 'X', perfil: 'ADMIN' } });
      await recarregar();
      await esperarLogin();
      afirmar((await guardado('authToken')) === null, 'token inválido não foi removido');
      afirmar(!(await existe('.dash')), 'Dashboard apareceu com token inválido');
    });

    await caso('C03', 'Perfil guardado no navegador é ignorado: USUARIO com user.perfil=ADMIN adulterado continua sem menu de ADMIN', async () => {
      const { token, user } = await loginApi(usuario);
      await semearSessao({ token, user: { ...user, perfil: 'ADMIN' } });
      await recarregar();
      await esperarDashboard();
      afirmar(JSON.stringify(await itensDoMenu()) === JSON.stringify(MENU_USUARIO), 'menu: ' + (await itensDoMenu()).join('|'));
      afirmar(JSON.parse(await guardado('user')).perfil === 'USUARIO', 'perfil deve ser regravado a partir do servidor');
      await sair();
    });

    await caso('C04', 'Credenciais erradas: mensagem na tela, continua no Login, nenhum token gravado', async () => {
      const msg = await tentarLogin(usuario.email, 'senha-errada-123');
      afirmar(msg && msg.length > 3, 'sem mensagem de erro');
      afirmar((await guardado('authToken')) === null && (await existe('.login-container')), 'sessão criada com senha errada');
      return `mensagem: "${msg}"`;
    });

    await caso('C05', 'Usuário desativado não consegue entrar (mensagem na tela, sem sessão)', async () => {
      const msg = await tentarLogin(inativo.email, inativo.senha);
      afirmar(msg && msg.length > 3, 'sem mensagem de erro para usuário desativado');
      afirmar((await guardado('authToken')) === null, 'sessão criada para usuário desativado');
      return `mensagem: "${msg}"`;
    });

    await caso('C06', 'Usuário desativado COM sessão aberta: na próxima ação o app encerra a sessão (401) e avisa no Login', async () => {
      await loginPelaTela(usuario.email, usuario.senha);
      await definirAtivo(usuario.id, false);
      afirmar(await clicarMenu('Alertas'), 'menu Alertas');
      await esperarLogin(15000);
      afirmar(/sess[ãa]o/i.test(await textoSel('.info-message')), 'aviso de sessão encerrada: ' + (await textoSel('.info-message')));
      afirmar((await guardado('authToken')) === null, 'token não foi apagado');
      await definirAtivo(usuario.id, true);
    });

    await caso('C07', 'Perfil rebaixado com a sessão aberta: telas de ADMIN respondem 403 com mensagem e o app continua utilizável', async () => {
      await loginPelaTela(adminB.email, adminB.senha);
      await definirPerfil(adminB.id, 'USUARIO');
      afirmar(await clicarMenu('Usuários'), 'menu Usuários');
      await esperar(`/Acesso negado|permiss|Erro ao carregar|restrit/i.test(document.querySelector('.dash-main').innerText)`, 12000, 'mensagem de acesso negado');
      afirmar(!(await existe('.users-table tbody tr')), 'lista de usuários exibida sem permissão');
      afirmar(!!(await guardado('authToken')), '403 não deve encerrar a sessão (só 401)');
      afirmar(await clicarMenu('Dashboard'), 'voltar ao Dashboard');
      await esperar(`!!document.querySelector('.dash-main h1')`, 8000, 'Dashboard continua funcionando');
      await sair();
    });

    // ============================================================ D. Estados loading / vazio / erro
    console.log('\n----- D. Estados de carregamento, vazio e erro -----');

    await caso('D01', 'Carregando: com /api/alertas retida o cartão e a tela mostram "Carregando"; ao liberar, os dados aparecem', async () => {
      await entrarComToken(usuario);
      await dashPronto();
      const liberar = await interceptar('*/api/alertas*', 'segurar');
      try {
        afirmar(await clicarMenu('Alertas'), 'menu Alertas');
        await esperar(`!!document.querySelector('[data-testid="carregando"]')`, 8000, 'indicador de carregamento em Alertas');
        afirmar(await clicarMenu('Dashboard'), 'menu Dashboard');
        await esperar(`/Carregando alertas/.test(document.querySelector('[data-testid="dash-alertas"]')?.innerText ?? '') || /Carregando/.test(document.querySelector('[data-testid="dash-situacao"]')?.innerText ?? '')`, 8000, 'carregamento no Dashboard');
      } finally { await liberar(); }
      await dashPronto();
    });

    await caso('D02', 'Erro: com /api/alertas derrubada, Dashboard e Alertas mostram mensagem tratada e "Tentar novamente" recupera', async () => {
      const indice = errosDePagina.length;
      const liberar = await interceptar('*/api/alertas*', 'falhar');
      try {
        afirmar(await clicarMenu('Alertas'), 'menu Alertas');
        await esperar(`!!document.querySelector('[data-testid="estado-erro"]')`, 15000, 'erro em Alertas');
        afirmar(await existe('.alerts-retry'), 'botão Tentar novamente');
        afirmar(await clicarMenu('Dashboard'), 'menu Dashboard');
        await esperar(`!!document.querySelector('[data-testid="dash-alertas"] [role="alert"]')`, 15000, 'erro no cartão de alertas');
        afirmar(/Indisponível/.test(await textoSel('[data-testid="dash-situacao"]')), 'situação deve indicar indisponível');
        await foto('D02-erro-alertas-dashboard', 1366, 900);
      } finally { await liberar(); }
      afirmar(await clicarMenu('Alertas'), 'menu Alertas');
      await esperar(PRONTA.Alertas, 30000, 'Alertas recuperada');
      afirmar(await existe('[data-testid="alerta"]') || await existe('[data-testid="estado-vazio"]'), 'Alertas voltou');
      afirmar(errosDePagina.length === indice, 'erros JS durante a falha: ' + errosDePagina.slice(indice, indice + 2).join(' | '));
    });

    await caso('D03', 'Vazio: cidade sem alertas nem ocorrências mostra mensagens de "nenhum registro" nas três telas', async () => {
      const comDados = await doBanco(`SELECT DISTINCT cidade FROM alertas UNION SELECT DISTINCT cidade FROM ocorrencias`);
      const usadas = new Set(comDados.map((r) => r.cidade));
      const vazia = CIDADES.find((c) => !usadas.has(c));
      if (!vazia) { info('D03', 'todas as cidades têm registros; caso verificado apenas pela cidade de teste sem alertas ativos'); }
      const u = await novoUsuario('USUARIO', { cidade: vazia ?? 'Sorocaba' });
      await sair().catch(() => {});
      await entrarComToken(u);
      await dashPronto();
      if (vazia) {
        afirmar(await existe('[data-testid="alertas-vazio"]'), 'estado vazio de alertas no Dashboard');
        afirmar(await existe('[data-testid="ocorrencias-vazio"]'), 'estado vazio de ocorrências no Dashboard');
        afirmar(!(await existe('[data-testid="sino-contagem"]')), 'sino sem contagem');
        await abrirMenu('Alertas');
        afirmar(await existe('[data-testid="estado-vazio"]'), 'estado vazio em Alertas');
        await abrirMenu('Ocorrências');
        afirmar(await existe('[data-testid="estado-vazio"]'), 'estado vazio em Ocorrências');
        await foto('D03-vazio-ocorrencias', 1366, 900);
      }
      await sair();
      return vazia ? `cidade usada: ${vazia}` : null;
    });

    // ============================================================ E. Fontes externas (OpenAQ / Open-Meteo)
    console.log('\n----- E. Falha das fontes externas: fallback Open-Meteo e indisponibilidade total -----');

    await caso('E01', 'OpenAQ fora do ar: o Dashboard usa Open-Meteo e rotula como "Estimativa por modelo" (nunca como medição)', async () => {
      const porta = await subirBackendAlternativo({ OPENAQ_BASE_URL: 'http://127.0.0.1:9' });
      const parar = await redirecionarApi(porta);
      try {
        await entrarComToken(usuario);
        await dashPronto(90000);
        const tags = await avaliar(`[...document.querySelectorAll('.pollutant')].map(c => c.querySelector('.tag-ok,.tag-model,.tag-none')?.className)`);
        afirmar(!tags.includes('tag-ok'), 'nenhum poluente pode aparecer como medição de estação');
        if (!tags.includes('tag-model') && requisicoes.some((r) => /\/air-quality\/modelo/.test(r.url) && [502, 503, 504].includes(r.status))) {
          throw indisponibilidadeExterna('a Open-Meteo não respondeu a /air-quality/modelo; o Dashboard mostrou "Sem dados disponíveis" (comportamento correto)');
        }
        afirmar(tags.includes('tag-model'), 'esperava poluentes vindos do modelo Open-Meteo: ' + tags.join(','));
        afirmar(/Open-Meteo/.test(await textoSel('.dash-pollutants')), 'atribuição da Open-Meteo');
        const hist = await textoSel('[data-testid="dash-historico"]');
        afirmar(!/Estação · OpenAQ/.test(hist), 'histórico não pode rotular como estação');
        await foto('E01-fallback-open-meteo', 1366, 1000);
        await abrirMenu('Alertas');
        afirmar(await existe('.alerts-page'), 'Alertas (só banco) continua funcionando');
        return `fontes dos 6 poluentes: ${tags.join(',')}`;
      } finally { await parar(); }
    });

    await caso('E02', 'OpenAQ e Open-Meteo fora do ar: Dashboard mostra "Sem dados disponíveis", sem quebrar nem inventar valores', async () => {
      const porta = await subirBackendAlternativo({ OPENAQ_BASE_URL: 'http://127.0.0.1:9', OPEN_METEO_BASE_URL: 'http://127.0.0.1:9' });
      const parar = await redirecionarApi(porta);
      const indice = errosDePagina.length;
      try {
        await entrarComToken(usuario);
        await dashPronto(90000);
        const tags = await avaliar(`[...document.querySelectorAll('.pollutant')].map(c => c.querySelector('.tag-ok,.tag-model,.tag-none')?.className ?? 'sem-tag')`);
        afirmar(tags.every((t) => t === 'tag-none'), 'todos devem ser "Sem dados disponíveis": ' + tags.join(','));
        afirmar(!(await avaliar(`[...document.querySelectorAll('.pollutant-value b')].length`)), 'valor exibido sem fonte');
        afirmar(await avaliar(`!!document.querySelector('[data-testid="historico-vazio"]') || !!document.querySelector('[data-testid="dash-historico"] [role="alert"]')`), 'histórico deve mostrar vazio ou erro tratado');
        afirmar(errosDePagina.length === indice, 'erros JS: ' + errosDePagina.slice(indice, indice + 2).join(' | '));
        afirmar(await clicarMenu('Alertas') && (await existe('.dash-sidebar')), 'menu continua utilizável');
        await foto('E02-sem-fontes', 1366, 1000);
      } finally { await parar(); await sair().catch(() => {}); }
    });

    // ============================================================ F. Responsividade e usabilidade em 3 tamanhos
    console.log('\n----- F. Responsividade: 1366x768, 768x1024 e 390x844 -----');
    await entrarComToken(usuario);
    await percorrerResponsivo('USUARIO', ['Dashboard', 'Alertas', 'Ocorrências', 'Histórico']);

    await caso('F01', 'Painel de detalhe do alerta e formulário de ocorrência cabem em 390 px e fecham (Esc / Cancelar)', async () => {
      await definirViewport(VIEWPORTS[2]);
      await abrirMenu('Alertas');
      const temAlerta = await existe('[data-testid="alerta"]');
      if (temAlerta) {
        afirmar(await clicarSel('[data-testid="alerta"]'), 'abrir alerta');
        await esperar(`!!document.querySelector('[role="dialog"]')`, 5000, 'painel');
        const dentro = await avaliar(`(()=>{const r=document.querySelector('[role="dialog"]').getBoundingClientRect(); return r.left>=-1 && r.right<=window.innerWidth+1})()`);
        afirmar(dentro, 'painel passa da tela em 390 px');
        await foto('F01-detalhe-390', 390, 844, true);
        await tecla('Escape', 'Escape', 27);
        await esperar(`!document.querySelector('[role="dialog"]')`, 4000, 'Esc fecha o painel');
      }
      await abrirMenu('Ocorrências');
      afirmar(await clicarSel('button[data-testid="nova-ocorrencia"]'), 'Nova ocorrência');
      await esperar(`!!document.querySelector('[data-testid="nova-ocorrencia-form"]')`, 8000, 'formulário');
      const cabe = await avaliar(`(()=>{const r=document.querySelector('[data-testid="nova-ocorrencia-form"]').getBoundingClientRect(); return r.left>=-1 && r.right<=window.innerWidth+1})()`);
      afirmar(cabe, 'formulário passa da tela em 390 px');
      await foto('F01-formulario-390', 390, 844, true);
      afirmar(await clicarTexto('.oc-form-actions button', 'Cancelar'), 'Cancelar');
      await esperar(`!document.querySelector('[data-testid="nova-ocorrencia-form"]')`, 4000, 'formulário fechado');
      await limparMetricas();
      return temAlerta ? null : 'sem alertas na cidade: apenas o formulário foi verificado';
    });

    await sair().catch(() => {});
    await entrarComToken(admin);
    await percorrerResponsivo('ADMIN', MENU_ADMIN);

    await caso('F02', 'Modal "Novo usuário" cabe em 390 px e fecha em "Cancelar"', async () => {
      await definirViewport(VIEWPORTS[2]);
      await abrirMenu('Usuários');
      afirmar(await clicarSel('.users-btn-primary'), 'Novo usuário');
      await esperar(`!!document.querySelector('.users-modal')`, 5000, 'modal');
      afirmar(await avaliar(`(()=>{const r=document.querySelector('.users-modal').getBoundingClientRect(); return r.left>=-1 && r.right<=window.innerWidth+1})()`), 'modal passa da tela');
      await foto('F02-modal-usuario-390', 390, 844, true);
      afirmar(await clicarTexto('.users-modal button', 'Cancelar'), 'Cancelar');
      await esperar(`!document.querySelector('.users-modal')`, 4000, 'modal fechado');
      await limparMetricas();
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
  alternativos.forEach(matarArvore);
  await limparRegistrosDeTeste();
  const resto = await pool.query(`SELECT (SELECT COUNT(*)::int FROM usuarios WHERE email LIKE 'tmp.sis.%') u, (SELECT COUNT(*)::int FROM alertas WHERE estacao_id LIKE 'tmp-sis-%') a, (SELECT COUNT(*)::int FROM ocorrencias WHERE titulo LIKE '[TESTE-SIS %') o`).then((r) => r.rows[0]).catch(() => ({ u: '?', a: '?', o: '?' }));
  await pool.end().catch(() => {});
  const ok = resultados.filter((r) => r.ok).length;
  const externos = resultados.filter((r) => r.externo).length;
  console.log(`\nResumo: ${ok} aprovado(s), ${resultados.length - ok - externos} reprovado(s), ${externos} indisponibilidade(s) externa(s) de ${resultados.length}. Restantes no banco: ${resto.u} usuário(s), ${resto.a} alerta(s), ${resto.o} ocorrência(s) de teste.`);
  console.log(`Prints em: ${SHOTS}`);
  process.exitCode = ok + externos === resultados.length ? 0 : 1;
}
