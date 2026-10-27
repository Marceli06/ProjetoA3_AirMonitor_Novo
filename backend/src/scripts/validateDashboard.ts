import dotenv from 'dotenv';
import pool from '../database';

dotenv.config();

// Valida, contra o backend em execução (BASE_URL), exatamente o fluxo que o Dashboard faz:
// login/cadastro (user com cidade) -> GET /air-quality/locations?cidade&limite=1&raio=25000 -> GET /locations/:id/latest.
// Cria usuários temporários pelo cadastro público e SEMPRE os apaga no final. Não imprime senhas nem tokens.
// Uso: BASE_URL=http://127.0.0.1:3996/api npm run dashboard:validate

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3996/api';
const CIDADES_TESTE = (process.argv[2] ? [process.argv[2]] : ['São Paulo', 'Campinas', 'Mauá']);
const CHAVES = ['pm25', 'pm10', 'o3', 'no2', 'co', 'so2'];
let falhas = 0;
const ok = (m: string) => console.log(`  [OK]    ${m}`);
const falha = (m: string) => { falhas++; console.log(`  [FALHA] ${m}`); };
const check = (c: boolean, a: string, b: string) => (c ? ok(a) : falha(b));

async function chamar(caminho: string, opcoes: { token?: string; corpo?: unknown } = {}) {
  const res = await fetch(`${BASE}${caminho}`, {
    method: opcoes.corpo ? 'POST' : 'GET',
    headers: {
      ...(opcoes.corpo ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      ...(opcoes.token ? { Authorization: `Bearer ${opcoes.token}` } : {}),
    },
    body: opcoes.corpo ? Buffer.from(JSON.stringify(opcoes.corpo), 'utf8') : undefined,
  });
  let corpo: any = null;
  try { corpo = await res.json(); } catch { /* sem corpo */ }
  return { status: res.status, corpo };
}

const emails: string[] = [];

async function main() {
  const semToken = await chamar('/air-quality/locations?cidade=S%C3%A3o%20Paulo&limite=1&raio=25000');
  check(semToken.status === 401, 'sem token -> 401', `sem token devolveu ${semToken.status}`);

  for (const cidade of CIDADES_TESTE) {
    console.log(`\n=== Usuário cadastrado em ${cidade} ===`);
    const email = `tmp.dash.${Date.now()}.${emails.length}@example.com`;
    const senha = `Tmp-${Math.random().toString(36).slice(2)}-9`;
    emails.push(email);

    const reg = await chamar('/auth/register', { corpo: { nome: 'Teste Dashboard', email, password: senha, confirmPassword: senha, cidade, regiao: 'Centro' } });
    check(reg.status === 201 && reg.corpo?.user?.cidade === cidade && reg.corpo?.user?.regiao === 'Centro',
      `cadastro devolve user.cidade/regiao (${reg.corpo?.user?.cidade}/${reg.corpo?.user?.regiao})`, `cadastro: HTTP ${reg.status} user=${JSON.stringify(reg.corpo?.user)}`);

    const login = await chamar('/auth/login', { corpo: { email, password: senha } });
    check(login.status === 200 && login.corpo?.user?.cidade === cidade && login.corpo?.user?.regiao === 'Centro',
      `login devolve user.cidade/regiao (${login.corpo?.user?.cidade}/${login.corpo?.user?.regiao})`, `login: HTTP ${login.status} user=${JSON.stringify(login.corpo?.user)}`);
    const token = login.corpo?.token;
    if (!token) { falha('login sem token'); continue; }

    const lista = await chamar(`/air-quality/locations?cidade=${encodeURIComponent(cidade)}&limite=1&raio=25000`, { token });
    check(lista.status === 200, `GET /locations -> 200 (${lista.corpo?.total} estação(ões))`, `GET /locations -> ${lista.status} ${JSON.stringify(lista.corpo)}`);
    const est = lista.corpo?.estacoes?.[0];
    if (!est) { console.log(`  [INFO]  sem estação perto de ${cidade}: mensagem = ${lista.corpo?.mensagem}`); continue; }
    check(typeof est.id === 'number' && typeof est.distanciaMetros === 'number',
      `estação mais próxima: #${est.id} "${est.nome}" (${est.localidade ?? 'sem localidade'}) a ${(est.distanciaMetros / 1000).toFixed(1)} km do centro`,
      `estação sem id/distância: ${JSON.stringify(est)}`);

    const ult = await chamar(`/air-quality/locations/${est.id}/latest`, { token });
    check(ult.status === 200, 'GET /locations/:id/latest -> 200', `latest -> ${ult.status} ${JSON.stringify(ult.corpo)}`);
    const d = ult.corpo;
    if (!d) continue;

    check(CHAVES.every((c) => d.medicoes.some((m: any) => m.chave === c)) && d.medicoes.length === 6, '6 poluentes presentes (um card cada)', `poluentes: ${d.medicoes.map((m: any) => m.chave)}`);
    for (const m of d.medicoes) {
      const linha = m.disponivel
        ? `${m.chave}: ${m.valor} ${m.unidade} | ${m.fonte}/${m.tipoDado} | ${m.dataHora}${m.desatualizada ? ' | DESATUALIZADA' : ''}`
        : `${m.chave}: sem dados (motivo=${m.motivo})`;
      console.log(`          ${linha}`);
      if (m.disponivel) {
        check(typeof m.valor === 'number' && !!m.unidade && !!m.dataHora && (m.fonte === 'OPENAQ' || m.fonte === 'OPEN_METEO'),
          `${m.chave}: valor/unidade/data/fonte completos`, `${m.chave}: campos incompletos ${JSON.stringify(m)}`);
      } else {
        check(m.valor === null && m.fonte === null, `${m.chave}: indisponível vem com valor=null (nunca 0)`, `${m.chave}: indisponível mas ${JSON.stringify(m)}`);
      }
    }
    const usaModelo = d.medicoes.some((m: any) => m.disponivel && m.fonte === 'OPEN_METEO');
    check(usaModelo === (d.atribuicoes.length > 0), `atribuição Open-Meteo ${usaModelo ? 'presente' : 'ausente'} (coerente com o uso do modelo)`, `atribuição incoerente: usaModelo=${usaModelo} atribuicoes=${JSON.stringify(d.atribuicoes)}`);
    check(!!d.atualizadoEm, `atualizadoEm real: ${d.atualizadoEm}`, 'atualizadoEm ausente');
    check(!!d.statusFontes && ['ok', 'falha'].includes(d.statusFontes.OPENAQ), `statusFontes: ${JSON.stringify(d.statusFontes)}`, 'statusFontes ausente');
    const co = d.medicoes.find((m: any) => m.chave === 'co');
    if (co?.disponivel) console.log(`          [INFO] CO exibido na unidade da própria fonte (${co.fonte}): ${co.unidade} (sem conversão)`);
  }

  console.log('\n=== Credencial inválida ===');
  const login0 = await chamar('/auth/login', { corpo: { email: emails[0], password: 'x' } });
  check(login0.status === 401, 'login com senha errada -> 401', `login errado -> ${login0.status}`);
}

main()
  .catch((e) => { falha(`erro inesperado: ${e?.message}`); })
  .finally(async () => {
    try {
      const r = await pool.query('DELETE FROM usuarios WHERE email = ANY($1::text[])', [emails]);
      console.log(`\nUsuários temporários removidos: ${r.rowCount}/${emails.length}`);
    } catch (e: any) { console.log(`Falha ao remover temporários: ${e?.message}`); falhas++; }
    await pool.end();
    console.log(falhas === 0 ? '\nResultado: TODAS as validações passaram.' : `\nResultado: ${falhas} falha(s).`);
    process.exit(falhas === 0 ? 0 : 1);
  });
