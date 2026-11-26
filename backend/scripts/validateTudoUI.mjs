// Executa as validações de INTERFACE (navegador real, via DevTools Protocol) em sequência e soma os resultados.
// Sobe sozinho um backend e um Vite de teste em portas livres (não mexe no que o desenvolvedor já tem rodando),
// roda cada script em cada navegador pedido e imprime o resumo. Os scripts criam usuários/registros temporários
// (tmp.*@example.com, "[TESTE...]") e os removem no final.
//
// Uso (dentro de backend/):   npm run ui:validate
//   UI_SCRIPTS=dashboard,admin,alertas,ocorrencias,historico,sistema,niveis   (padrão: todos)
//   UI_BROWSERS=chrome,edge                                             (padrão: chrome)
//   UI_PAUSA=20                                                         (segundos entre scripts que usam a OpenAQ)
// Firefox não é suportado: os scripts usam o DevTools Protocol (Chromium/Edge).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(AQUI, '..');
const FRONTEND = resolve(BACKEND, '..', 'frontend');

const SCRIPTS = [
  { nome: 'dashboard', arquivo: 'validateDashboardUI.mjs', usaOpenAQ: true },
  { nome: 'admin', arquivo: 'validateAdminDashboard.mjs', usaOpenAQ: true },
  { nome: 'alertas', arquivo: 'validateAlertasUI.mjs', usaOpenAQ: true },
  { nome: 'ocorrencias', arquivo: 'validateOcorrenciasUI.mjs', usaOpenAQ: false },
  { nome: 'historico', arquivo: 'validateHistoricoUI.mjs', usaOpenAQ: true },
  { nome: 'sistema', arquivo: 'validateSistemaUI.mjs', usaOpenAQ: true },
  { nome: 'niveis', arquivo: 'validateNiveisUI.mjs', usaOpenAQ: false },
];

const CAMINHOS_NAVEGADOR = {
  chrome: [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ],
  edge: [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/microsoft-edge',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
};

const lista = (nome, padrao) => (process.env[nome] ?? padrao).split(',').map((s) => s.trim()).filter(Boolean);
const selecionados = lista('UI_SCRIPTS', SCRIPTS.map((s) => s.nome));
const navegadores = lista('UI_BROWSERS', 'chrome');
const PAUSA_S = Number(process.env.UI_PAUSA ?? 20);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const portaLivre = () => new Promise((resolver, rejeitar) => {
  const srv = net.createServer();
  srv.once('error', rejeitar);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolver(port)); });
});

const matar = (proc) => {
  if (!proc?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-proc.pid); } catch { proc.kill(); } }
};

const subir = (comando, cwd, env) => spawn(comando, { cwd, shell: true, env: { ...process.env, ...env }, stdio: 'ignore', detached: process.platform !== 'win32' });

async function esperarUrl(url, rotulo) {
  for (let i = 0; i < 90; i++) {
    await dormir(1000);
    if (await fetch(url).then((r) => r.status < 500).catch(() => false)) return;
  }
  throw new Error(`${rotulo} não respondeu em ${url}`);
}

function rodarScript(script, navegador, caminhoNavegador, env) {
  return new Promise((resolver) => {
    const inicio = Date.now();
    const r = { script: script.nome, navegador, aprovados: 0, reprovados: 0, externos: 0, exit: null, segundos: 0, falhas: [] };
    const proc = spawn(process.execPath, [join(AQUI, script.arquivo)], {
      cwd: BACKEND,
      env: { ...process.env, ...env, CHROME_PATH: caminhoNavegador, SHOTS_DIR: join(BACKEND, '.tmp-ui-shots', navegador, script.nome) },
    });
    let resto = '';
    let aguardandoDetalhe = null;
    const tratar = (pedaco) => {
      const texto = pedaco.toString('utf8');
      process.stdout.write(texto);
      const linhas = (resto + texto).split('\n');
      resto = linhas.pop() ?? '';
      for (const l of linhas) {
        if (aguardandoDetalhe && l.includes('->')) { aguardandoDetalhe.push(l.trim().slice(0, 240)); aguardandoDetalhe = null; }
        if (/\[APROVADO\]/.test(l)) r.aprovados++;
        else if (/\[EXTERNO\]/.test(l)) { r.externos++; r.externosTexto = [...(r.externosTexto ?? []), l.trim().slice(0, 200)]; }
        else if (/\[REPROVADO\]/.test(l)) { r.reprovados++; const f = [l.trim().slice(0, 200)]; r.falhas.push(f); aguardandoDetalhe = f; }
      }
    };
    proc.stdout.on('data', tratar);
    proc.stderr.on('data', tratar);
    proc.on('close', (codigo) => { r.exit = codigo; r.segundos = Math.round((Date.now() - inicio) / 1000); resolver(r); });
  });
}

async function main() {
  const escolhidos = SCRIPTS.filter((s) => selecionados.includes(s.nome));
  if (escolhidos.length === 0) throw new Error('Nenhum script selecionado em UI_SCRIPTS');
  const encontrados = {};
  for (const nav of navegadores) {
    const caminho = (CAMINHOS_NAVEGADOR[nav] ?? []).find((c) => c && existsSync(c));
    if (!caminho) console.log(`[AVISO] navegador "${nav}" não encontrado neste computador: será pulado.`);
    else encontrados[nav] = caminho;
  }
  if (Object.keys(encontrados).length === 0) throw new Error('Nenhum navegador disponível (suportados: chrome, edge)');

  const portaApi = await portaLivre();
  const portaApp = await portaLivre();
  const processos = [];
  try {
    processos.push(subir('npx tsx src/index.ts', BACKEND, { PORT: String(portaApi) }));
    processos.push(subir(`npx vite --port ${portaApp} --strictPort --host 127.0.0.1`, FRONTEND, { BROWSER: 'none', VITE_API_URL: `http://localhost:${portaApi}/api` }));
    await esperarUrl(`http://127.0.0.1:${portaApi}/health`, 'Backend de teste');
    await esperarUrl(`http://127.0.0.1:${portaApp}/`, 'Frontend de teste');
    console.log(`Backend de teste na porta ${portaApi}; frontend de teste na porta ${portaApp}`);

    const env = { APP_URL: `http://127.0.0.1:${portaApp}`, API_URL: `http://127.0.0.1:${portaApi}/api` };
    const resultados = [];
    let anteriorUsouOpenAQ = false;
    for (const [nav, caminho] of Object.entries(encontrados)) {
      for (const script of escolhidos) {
        if (anteriorUsouOpenAQ && script.usaOpenAQ && PAUSA_S > 0) {
          console.log(`\n(pausa de ${PAUSA_S}s para respeitar o limite de requisições da OpenAQ)`);
          await dormir(PAUSA_S * 1000);
        }
        console.log(`\n${'='.repeat(78)}\nUI ${script.nome} (${script.arquivo}) no ${nav}\n${'='.repeat(78)}`);
        resultados.push(await rodarScript(script, nav, caminho, { ...env, CDP_PORT: String(await portaLivre()) }));
        anteriorUsouOpenAQ = script.usaOpenAQ;
      }
    }

    console.log(`\n${'='.repeat(78)}\nRESUMO DA INTERFACE\n${'='.repeat(78)}`);
    console.log('navegador'.padEnd(11) + 'script'.padEnd(14) + 'aprovados'.padStart(10) + 'reprovados'.padStart(12) + 'externos'.padStart(10) + 'exit'.padStart(6) + 'tempo'.padStart(8));
    for (const r of resultados) {
      console.log(r.navegador.padEnd(11) + r.script.padEnd(14) + String(r.aprovados).padStart(10) + String(r.reprovados).padStart(12) + String(r.externos).padStart(10) + String(r.exit).padStart(6) + `${r.segundos}s`.padStart(8));
    }
    const soma = (k) => resultados.reduce((t, r) => t + r[k], 0);
    console.log('-'.repeat(71));
    console.log(`TOTAL: ${soma('aprovados') + soma('reprovados') + soma('externos')} verificações, ${soma('aprovados')} aprovadas, ${soma('reprovados')} reprovadas, ${soma('externos')} com indisponibilidade externa (OpenAQ/Open-Meteo)`);
    for (const r of resultados.filter((x) => x.externos > 0)) (r.externosTexto ?? []).forEach((t) => console.log(`  [externo] ${r.script} (${r.navegador}): ${t}`));
    for (const r of resultados.filter((x) => x.reprovados > 0 || x.exit !== 0)) {
      console.log(`\nFalhas em ${r.script} (${r.navegador}, exit ${r.exit}):`);
      r.falhas.forEach((f) => f.forEach((t) => console.log(`  ${t}`)));
    }
    process.exitCode = resultados.every((r) => r.exit === 0 && r.reprovados === 0) ? 0 : 1;
  } finally {
    processos.forEach(matar);
  }
}

main().catch((e) => {
  console.error(`Erro: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
