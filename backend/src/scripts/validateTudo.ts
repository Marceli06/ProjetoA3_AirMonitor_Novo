import { ChildProcess, spawn, spawnSync } from 'child_process';
import net from 'net';
import path from 'path';

// Executa TODAS as suítes de validação do backend em sequência e soma os resultados.
// Sobe três instâncias do backend em portas livres: a normal, uma com a Open-Meteo derrubada e uma com a OpenAQ
// derrubada (usadas pela suíte de Histórico para provar o tratamento de falhas das fontes externas).
// As suítes usam a OpenAQ e a Open-Meteo reais; o limite da OpenAQ é de 60 requisições/min, por isso há uma pausa
// entre as suítes que a consultam.
//
// Uso: npm run validate:all [-- --suites=auth,alertas] [--pausa=25]
//   (nomes: auth, openaq, fallback, fallback-total, dashboard, alertas, ocorrencias, historico)

interface Suite {
  nome: string;
  script: string;
  usaBackend: boolean;
  usaOpenAQ: boolean;
  args?: string[];
}

const SUITES: Suite[] = [
  { nome: 'auth', script: 'validateAuth.ts', usaBackend: true, usaOpenAQ: false },
  { nome: 'openaq', script: 'validateOpenAQ.ts', usaBackend: false, usaOpenAQ: true },
  { nome: 'fallback', script: 'validateFallback.ts', usaBackend: false, usaOpenAQ: true },
  { nome: 'fallback-total', script: 'validateFallbackTotal.ts', usaBackend: false, usaOpenAQ: true },
  { nome: 'dashboard', script: 'validateDashboard.ts', usaBackend: true, usaOpenAQ: true },
  { nome: 'alertas', script: 'validateAlertas.ts', usaBackend: true, usaOpenAQ: true },
  { nome: 'ocorrencias', script: 'validateOcorrencias.ts', usaBackend: true, usaOpenAQ: false },
  { nome: 'historico', script: 'validateHistorico.ts', usaBackend: true, usaOpenAQ: true },
];

const argumento = (nome: string) => process.argv.find((a) => a.startsWith(`--${nome}=`))?.split('=')[1];
// Aceita --suites=a,b (ou a variável VALIDATE_SUITES / npm_config_suites, útil quando o shell não repassa os argumentos)
const selecionadas = (argumento('suites') ?? process.env.VALIDATE_SUITES ?? process.env.npm_config_suites)?.split(',').map((s) => s.trim());
const PAUSA_S = Number(argumento('pausa') ?? process.env.VALIDATE_PAUSA ?? 25);
const BACKEND_DIR = path.resolve(__dirname, '..', '..');
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

const portaLivre = () => new Promise<number>((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address() as net.AddressInfo; srv.close(() => resolve(port)); });
});

const matar = (proc: ChildProcess) => {
  if (!proc.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-proc.pid); } catch { proc.kill(); }
};

async function subirBackend(rotulo: string, env: Record<string, string>) {
  const porta = await portaLivre();
  const proc = spawn('npx tsx src/index.ts', { cwd: BACKEND_DIR, shell: true, env: { ...process.env, ...env, PORT: String(porta) }, stdio: 'ignore', detached: process.platform !== 'win32' });
  for (let i = 0; i < 90; i++) {
    await dormir(1000);
    const ok = await fetch(`http://127.0.0.1:${porta}/health`).then((r) => r.status === 200).catch(() => false);
    if (ok) { console.log(`Backend "${rotulo}" no ar na porta ${porta}`); return { proc, porta }; }
  }
  matar(proc);
  throw new Error(`Backend "${rotulo}" não subiu`);
}

interface Resultado { nome: string; ok: number; falhas: number; pulados: number; exit: number | null; segundos: number; falhasTexto: string[] }

function rodar(suite: Suite, env: Record<string, string>): Promise<Resultado> {
  return new Promise((resolve) => {
    const inicio = Date.now();
    const r: Resultado = { nome: suite.nome, ok: 0, falhas: 0, pulados: 0, exit: null, segundos: 0, falhasTexto: [] };
    const proc = spawn(`npx tsx src/scripts/${suite.script} ${(suite.args ?? []).join(' ')}`, { cwd: BACKEND_DIR, shell: true, env: { ...process.env, ...env } });
    let resto = '';
    const tratar = (pedaco: Buffer) => {
      const texto = pedaco.toString('utf8');
      process.stdout.write(texto);
      const linhas = (resto + texto).split('\n');
      resto = linhas.pop() ?? '';
      for (const l of linhas) {
        if (/\[OK\]/.test(l)) r.ok++;
        else if (/\[FALHA\]/.test(l)) { r.falhas++; r.falhasTexto.push(l.trim().slice(0, 220)); }
        else if (/\[PULADO\]/.test(l)) r.pulados++;
      }
    };
    proc.stdout.on('data', tratar);
    proc.stderr.on('data', tratar);
    proc.on('close', (codigo) => { r.exit = codigo; r.segundos = Math.round((Date.now() - inicio) / 1000); resolve(r); });
  });
}

async function main() {
  const lista = SUITES.filter((s) => !selecionadas || selecionadas.includes(s.nome));
  if (lista.length === 0) throw new Error('Nenhuma suíte selecionada');

  const backends: ChildProcess[] = [];
  const env: Record<string, string> = {};
  try {
    if (lista.some((s) => s.usaBackend)) {
      const normal = await subirBackend('normal', {});
      backends.push(normal.proc);
      env.BASE_URL = `http://127.0.0.1:${normal.porta}/api`;
      if (lista.some((s) => s.nome === 'historico')) {
        const omFora = await subirBackend('Open-Meteo fora do ar', { OPEN_METEO_BASE_URL: 'http://127.0.0.1:9' });
        const oaqFora = await subirBackend('OpenAQ fora do ar', { OPENAQ_BASE_URL: 'http://127.0.0.1:9' });
        backends.push(omFora.proc, oaqFora.proc);
        env.BASE_URL_OPEN_METEO_FORA = `http://127.0.0.1:${omFora.porta}/api`;
        env.BASE_URL_OPENAQ_FORA = `http://127.0.0.1:${oaqFora.porta}/api`;
      }
    }

    const resultados: Resultado[] = [];
    let anteriorUsouOpenAQ = false;
    for (const suite of lista) {
      if (anteriorUsouOpenAQ && suite.usaOpenAQ && PAUSA_S > 0) {
        console.log(`\n(pausa de ${PAUSA_S}s para respeitar o limite de requisições da OpenAQ)`);
        await dormir(PAUSA_S * 1000);
      }
      console.log(`\n${'='.repeat(78)}\nSUÍTE ${suite.nome} (${suite.script})\n${'='.repeat(78)}`);
      resultados.push(await rodar(suite, env));
      anteriorUsouOpenAQ = suite.usaOpenAQ;
    }

    console.log(`\n${'='.repeat(78)}\nRESUMO GERAL\n${'='.repeat(78)}`);
    console.log('suíte'.padEnd(16) + 'ok'.padStart(6) + 'falhas'.padStart(8) + 'puladas'.padStart(9) + 'exit'.padStart(6) + 'tempo'.padStart(8));
    for (const r of resultados) {
      console.log(r.nome.padEnd(16) + String(r.ok).padStart(6) + String(r.falhas).padStart(8) + String(r.pulados).padStart(9) + String(r.exit).padStart(6) + `${r.segundos}s`.padStart(8));
    }
    const soma = (k: 'ok' | 'falhas' | 'pulados') => resultados.reduce((t, r) => t + r[k], 0);
    console.log('-'.repeat(47));
    console.log(`TOTAL: ${soma('ok') + soma('falhas')} verificações, ${soma('ok')} aprovadas, ${soma('falhas')} reprovadas, ${soma('pulados')} puladas`);
    for (const r of resultados.filter((x) => x.falhas > 0 || x.exit !== 0)) {
      console.log(`\nFalhas em ${r.nome} (exit ${r.exit}):`);
      r.falhasTexto.forEach((t) => console.log(`  ${t}`));
    }
    process.exitCode = resultados.every((r) => r.exit === 0 && r.falhas === 0) ? 0 : 1;
  } finally {
    backends.forEach(matar);
  }
}

main().catch((e) => {
  console.error(`Erro: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
