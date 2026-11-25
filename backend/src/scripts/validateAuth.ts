import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../database';
import { JWT_SECRET } from '../config';

// Valida, contra o backend em execução (BASE_URL), a autenticação, a sessão e o controle de acesso do sistema:
// cadastro, login, /auth/me, token forjado/expirado, usuário desativado, perfis ADMIN x USUARIO (401/403), IDs
// inválidos, entradas maliciosas (injeção de SQL) e o isolamento de dados por cidade em Alertas, Ocorrências e Histórico.
// Cria usuários e registros de teste (prefixo tmp.auth / [TESTE-AUTH]) e SEMPRE os apaga no final.
// Não imprime senhas nem tokens. Não depende da OpenAQ (o Histórico é consultado só pelo modelo Open-Meteo).
// Uso: BASE_URL=http://127.0.0.1:3996/api npm run auth:validate

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3996/api';
const SP = 'São Paulo';
const CAMPINAS = 'Campinas';
const SUFIXO = Date.now();
const MARCA = `[TESTE-AUTH ${SUFIXO}]`;

let total = 0;
let falhas = 0;
const ok = (m: string) => { total++; console.log(`  [OK]      ${m}`); };
const falha = (m: string) => { total++; falhas++; console.log(`  [FALHA]   ${m}`); };
const info = (m: string) => console.log(`  [INFO]    ${m}`);
const check = (c: boolean, a: string, b: string) => (c ? ok(a) : falha(b));
const secao = (t: string) => console.log(`\n=== ${t} ===`);

interface Resposta { status: number; corpo: any; texto: string }

async function chamar(caminho: string, op: { token?: string; metodo?: string; corpo?: unknown; cru?: string; cabecalho?: string } = {}): Promise<Resposta> {
  const headers: Record<string, string> = {};
  const temCorpo = op.corpo !== undefined || op.cru !== undefined;
  if (temCorpo) headers['Content-Type'] = 'application/json; charset=utf-8';
  if (op.token) headers.Authorization = `Bearer ${op.token}`;
  if (op.cabecalho !== undefined) headers.Authorization = op.cabecalho;
  const res = await fetch(`${BASE}${caminho}`, {
    method: op.metodo || (temCorpo ? 'POST' : 'GET'),
    headers,
    body: op.cru !== undefined ? Buffer.from(op.cru, 'utf8') : op.corpo !== undefined ? Buffer.from(JSON.stringify(op.corpo), 'utf8') : undefined,
  });
  const texto = await res.text();
  let corpo: any = null;
  try { corpo = JSON.parse(texto); } catch { /* sem JSON */ }
  return { status: res.status, corpo, texto };
}

const emails: string[] = [];
let contador = 0;
const novoEmail = (rotulo: string) => { const e = `tmp.auth.${rotulo}.${SUFIXO}.${++contador}@example.com`; emails.push(e); return e; };
const SENHA = `Tmp-${Math.random().toString(36).slice(2)}-Aa9`; // aleatória por execução: nada de senha fixa versionada

async function cadastrar(cidade = SP, regiao = 'Centro', extra: Record<string, unknown> = {}) {
  const email = novoEmail('u');
  const r = await chamar('/auth/register', { corpo: { nome: 'Teste Auth', email, password: SENHA, confirmPassword: SENHA, cidade, regiao, ...extra } });
  return { email, resposta: r, token: r.corpo?.token as string, id: r.corpo?.user?.id as number };
}

async function criarAdminNoBanco() {
  const email = novoEmail('adm');
  const hash = await bcrypt.hash(SENHA, 4);
  const r = await pool.query(`INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, cidade, regiao) VALUES ('Admin Teste Auth', $1, $2, 'ADMIN', TRUE, $3, 'Centro') RETURNING id`, [email, hash, SP]);
  const login = await chamar('/auth/login', { corpo: { email, password: SENHA } });
  return { email, id: r.rows[0].id as number, token: login.corpo?.token as string };
}

async function main() {
  // ------------------------------------------------------------------ preparação
  const health = await fetch(BASE.replace(/\/api$/, '') + '/health').then((r) => r.status).catch(() => 0);
  if (health !== 200) throw new Error(`Backend fora do ar em ${BASE} (health=${health})`);

  const admin = await criarAdminNoBanco();
  check(!!admin.token, 'ADMIN de teste criado e autenticado', 'não foi possível autenticar o ADMIN de teste');

  // ------------------------------------------------------------------ cadastro
  secao('Cadastro');
  const u1 = await cadastrar();
  check(u1.resposta.status === 201 && !!u1.token && u1.resposta.corpo.user.perfil === 'USUARIO' && u1.resposta.corpo.user.cidade === SP, 'cadastro válido -> 201, token e perfil USUARIO', `cadastro: ${u1.resposta.status} ${u1.resposta.texto.slice(0, 120)}`);
  check(!/senha_hash|password|\$2[aby]\$/.test(u1.resposta.texto), 'resposta do cadastro não vaza a senha nem o hash', 'a resposta do cadastro contém a senha ou o hash');

  const escalada = await cadastrar(SP, 'Centro', { perfil: 'ADMIN', ativo: false });
  check(escalada.resposta.status === 201 && escalada.resposta.corpo.user.perfil === 'USUARIO', 'perfil ADMIN enviado no cadastro público é ignorado (sempre USUARIO)', `escalada de perfil: ${escalada.resposta.status} perfil=${escalada.resposta.corpo?.user?.perfil}`);
  const noBanco = await pool.query('SELECT perfil, ativo FROM usuarios WHERE id = $1', [escalada.id]);
  check(noBanco.rows[0]?.perfil === 'USUARIO' && noBanco.rows[0]?.ativo === true, 'no banco o usuário é USUARIO e ativo, mesmo com perfil/ativo forjados', `banco: ${JSON.stringify(noBanco.rows[0])}`);

  const dup = await chamar('/auth/register', { corpo: { nome: 'Outro', email: ` ${u1.email.toUpperCase()} `, password: SENHA, confirmPassword: SENHA, cidade: SP, regiao: 'Centro' } });
  check(dup.status === 400 && /já cadastrado/i.test(dup.corpo?.error ?? ''), 'e-mail duplicado (mesmo com caixa/espaços diferentes) -> 400', `duplicado: ${dup.status} ${dup.texto.slice(0, 100)}`);

  const base = { nome: 'Teste Auth', email: novoEmail('inv'), password: SENHA, confirmPassword: SENHA, cidade: SP, regiao: 'Centro' };
  const invalidos: [string, Record<string, unknown>][] = [
    ['sem nome', { nome: '' }], ['sem e-mail', { email: '' }], ['sem senha', { password: '', confirmPassword: '' }],
    ['sem cidade', { cidade: '' }], ['sem região', { regiao: '' }],
    ['senhas diferentes', { confirmPassword: 'Outra-Senha-1' }], ['senha curta (5)', { password: '12345', confirmPassword: '12345' }],
    ['senha acima de 72 caracteres', { password: 'a'.repeat(73), confirmPassword: 'a'.repeat(73) }],
    ['e-mail sem @', { email: 'semarroba.com' }], ['e-mail sem domínio', { email: 'a@b' }],
    ['nome com 1 caractere', { nome: 'A' }], ['nome com 121 caracteres', { nome: 'N'.repeat(121) }],
    ['cidade inexistente', { cidade: 'Atlântida' }], ['região que não é da cidade', { regiao: 'Zona Inexistente' }],
    ['cidade "__proto__"', { cidade: '__proto__' }], ['cidade "constructor"', { cidade: 'constructor' }],
    ['senha numérica (tipo errado)', { password: 1234567, confirmPassword: 1234567 }],
    ['senha como objeto', { password: { a: 1 }, confirmPassword: { a: 1 } }], ['e-mail como lista', { email: ['a@b.com'] }],
    ['nome como número', { nome: 12345 }],
  ];
  const antes = (await pool.query('SELECT COUNT(*)::int n FROM usuarios')).rows[0].n;
  const resp = await Promise.all(invalidos.map(([, o]) => chamar('/auth/register', { corpo: { ...base, ...o } })));
  const ruins = invalidos.map(([n], i) => [n, resp[i].status] as const).filter(([, s]) => s !== 400);
  check(ruins.length === 0, `${invalidos.length} cadastros inválidos -> 400 (nunca 500)`, `cadastros inválidos sem 400: ${JSON.stringify(ruins)}`);
  const depois = (await pool.query('SELECT COUNT(*)::int n FROM usuarios')).rows[0].n;
  check(depois === antes, 'cadastros inválidos não gravaram nenhum usuário', `cadastros inválidos gravaram ${depois - antes} usuário(s)`);

  const malformado = await chamar('/auth/register', { cru: '{"nome": "x", ' });
  check(malformado.status === 400 && !/at |node_modules|stack/i.test(malformado.texto), 'JSON malformado -> 400 sem stack trace', `malformado: ${malformado.status} ${malformado.texto.slice(0, 100)}`);
  const semCorpo = await chamar('/auth/register', { metodo: 'POST' });
  check(semCorpo.status === 400, 'cadastro sem corpo -> 400', `sem corpo: ${semCorpo.status}`);

  // ------------------------------------------------------------------ login
  secao('Login e sessão');
  const l1 = await chamar('/auth/login', { corpo: { email: `  ${u1.email.toUpperCase()}  `, password: SENHA } });
  check(l1.status === 200 && !!l1.corpo?.token && l1.corpo.user.email === u1.email && l1.corpo.user.perfil === 'USUARIO' && !/senha_hash|\$2[aby]\$/.test(l1.texto), 'login válido (e-mail case-insensitive e com espaços) -> 200, sem hash na resposta', `login: ${l1.status} ${l1.texto.slice(0, 120)}`);
  const errada = await chamar('/auth/login', { corpo: { email: u1.email, password: 'senha-errada' } });
  const inexistente = await chamar('/auth/login', { corpo: { email: `nao.existe.${SUFIXO}@example.com`, password: SENHA } });
  check(errada.status === 401 && inexistente.status === 401 && errada.corpo?.error === inexistente.corpo?.error, 'senha errada e e-mail inexistente -> 401 com a mesma mensagem (não revela se a conta existe)', `senha errada ${errada.status} "${errada.corpo?.error}" x inexistente ${inexistente.status} "${inexistente.corpo?.error}"`);
  const loginsRuins: [string, unknown][] = [['sem e-mail', { password: SENHA }], ['sem senha', { email: u1.email }], ['senha numérica', { email: u1.email, password: 123456 }], ['senha objeto', { email: u1.email, password: { $ne: '' } }], ['e-mail lista', { email: [u1.email], password: SENHA }], ['corpo vazio', {}]];
  const rl = await Promise.all(loginsRuins.map(([, c]) => chamar('/auth/login', { corpo: c })));
  check(rl.every((r) => r.status === 400), `${loginsRuins.length} logins malformados -> 400 (nunca 500)`, `logins malformados: ${JSON.stringify(loginsRuins.map(([n], i) => [n, rl[i].status]))}`);
  const loginInj = await chamar('/auth/login', { corpo: { email: "' OR '1'='1' --", password: "' OR '1'='1" } });
  check(loginInj.status === 401, "injeção de SQL no login (' OR '1'='1) -> 401", `injeção no login: ${loginInj.status}`);
  const esq1 = await chamar('/auth/esqueci-senha', { corpo: { email: u1.email } });
  const esq2 = await chamar('/auth/esqueci-senha', { corpo: { email: `nao.existe.${SUFIXO}@example.com` } });
  check(esq1.status === 200 && esq2.status === 200 && esq1.texto === esq2.texto, 'esqueci-senha responde igual para e-mail existente e inexistente', 'esqueci-senha revela se o e-mail existe');

  const me = await chamar('/auth/me', { token: u1.token });
  check(me.status === 200 && me.corpo.user.id === u1.id && me.corpo.user.perfil === 'USUARIO' && me.corpo.user.cidade === SP, '/auth/me com token válido -> 200 com o usuário vigente', `me: ${me.status} ${me.texto.slice(0, 120)}`);

  const sem = await chamar('/auth/me');
  const lixo = await chamar('/auth/me', { token: 'isto.nao.e-um-jwt' });
  const assinaturaErrada = jwt.sign({ userId: u1.id, email: u1.email, perfil: 'USUARIO' }, 'outro-segredo', { expiresIn: '1h' });
  const forjado = await chamar('/auth/me', { token: assinaturaErrada });
  const expirado = jwt.sign({ userId: u1.id, email: u1.email, perfil: 'USUARIO' }, JWT_SECRET, { expiresIn: -60 });
  const exp = await chamar('/auth/me', { token: expirado });
  const semAlg = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ userId: admin.id, email: admin.email, perfil: 'ADMIN' })).toString('base64url')}.`;
  const algNone = await chamar('/auth/me', { token: semAlg });
  check([sem, lixo, forjado, exp, algNone].every((r) => r.status === 401), 'sem token, token ilegível, assinatura errada, expirado e alg=none -> 401', `401 esperados: sem=${sem.status} lixo=${lixo.status} forjado=${forjado.status} expirado=${exp.status} none=${algNone.status}`);
  const cab = await Promise.all(['Bearer', 'Basic abc', 'Bearer a b', 'token-sem-esquema', ''].map((c) => chamar('/auth/me', { cabecalho: c })));
  check(cab.every((r) => r.status === 401), 'cabeçalho Authorization malformado -> 401 em todos os casos', `cabeçalhos: ${cab.map((r) => r.status)}`);

  // O perfil vem do banco, não do token: um token assinado com perfil ADMIN para um USUARIO não dá acesso de ADMIN
  const tokenAdminFalso = jwt.sign({ userId: u1.id, email: u1.email, perfil: 'ADMIN' }, JWT_SECRET, { expiresIn: '1h' });
  const meFalso = await chamar('/auth/me', { token: tokenAdminFalso });
  const admFalso = await chamar('/admin/usuarios', { token: tokenAdminFalso });
  check(meFalso.status === 200 && meFalso.corpo.user.perfil === 'USUARIO' && admFalso.status === 403, 'token com perfil ADMIN adulterado para um USUARIO: /me devolve USUARIO e /admin responde 403', `token adulterado: me=${meFalso.corpo?.user?.perfil} admin=${admFalso.status}`);

  // ------------------------------------------------------------------ usuário desativado
  secao('Usuário desativado');
  const alvo = await cadastrar();
  const desativa = await chamar(`/admin/usuarios/${alvo.id}/status`, { token: admin.token, metodo: 'PATCH', corpo: { ativo: false } });
  check(desativa.status === 200 && desativa.corpo?.ativo === false, 'ADMIN desativa o usuário -> 200', `desativar: ${desativa.status} ${desativa.texto.slice(0, 100)}`);
  const aposDesativar = await Promise.all(['/auth/me', '/alertas', '/ocorrencias', `/historico?poluente=pm25&periodo=24H&fonte=OPEN_METEO`, '/air-quality/locations?cidade=S%C3%A3o%20Paulo&limite=1'].map((c) => chamar(c, { token: alvo.token })));
  check(aposDesativar.every((r) => r.status === 401), 'token que já existia deixa de funcionar na hora (401 em /me, Alertas, Ocorrências, Histórico e air-quality)', `após desativar: ${aposDesativar.map((r) => r.status)}`);
  const loginDesativado = await chamar('/auth/login', { corpo: { email: alvo.email, password: SENHA } });
  check(loginDesativado.status === 401 && loginDesativado.corpo?.error === errada.corpo?.error, 'login de usuário desativado -> 401 (mesma mensagem de credenciais inválidas)', `login desativado: ${loginDesativado.status} "${loginDesativado.corpo?.error}"`);
  const reativa = await chamar(`/admin/usuarios/${alvo.id}/status`, { token: admin.token, metodo: 'PATCH', corpo: { ativo: true } });
  const loginReativado = await chamar('/auth/login', { corpo: { email: alvo.email, password: SENHA } });
  const tokenAntigoVolta = await chamar('/auth/me', { token: alvo.token });
  check(reativa.status === 200 && loginReativado.status === 200 && tokenAntigoVolta.status === 200, 'reativado, o usuário volta a entrar (login 200) e o token ainda válido volta a funcionar', `reativar: ${reativa.status} login=${loginReativado.status} me=${tokenAntigoVolta.status}`);
  const autoDesativar = await chamar(`/admin/usuarios/${admin.id}/status`, { token: admin.token, metodo: 'PATCH', corpo: { ativo: false } });
  check(autoDesativar.status === 400, 'ADMIN não consegue desativar a própria conta -> 400', `auto-desativar: ${autoDesativar.status}`);
  await pool.query('UPDATE usuarios SET ativo = FALSE WHERE id = $1', [admin.id]);
  const admDesativado = await Promise.all([chamar('/admin/usuarios', { token: admin.token }), chamar('/auth/me', { token: admin.token })]);
  await pool.query('UPDATE usuarios SET ativo = TRUE WHERE id = $1', [admin.id]);
  check(admDesativado.every((r) => r.status === 401), 'ADMIN desativado perde o acesso às rotas /admin e /me (401)', `admin desativado: ${admDesativado.map((r) => r.status)}`);

  // ------------------------------------------------------------------ perfis ADMIN x USUARIO
  secao('Perfis: rotas /admin');
  const rotasAdmin: [string, string, unknown?][] = [
    ['GET', '/admin/cidades'], ['GET', '/admin/usuarios'], ['GET', '/admin/resumo'], ['GET', '/admin/configuracoes'], ['GET', '/admin/estacoes?cidade=S%C3%A3o%20Paulo&limite=1'],
    ['POST', '/admin/usuarios', { nome: 'X Y', email: 'x@y.com', password: '123456', cidade: SP, regiao: 'Centro' }],
    ['PUT', `/admin/usuarios/${u1.id}`, { nome: 'Novo Nome', email: u1.email, cidade: SP, regiao: 'Centro' }],
    ['PATCH', `/admin/usuarios/${u1.id}/status`, { ativo: false }],
  ];
  const semTokenAdm = await Promise.all(rotasAdmin.map(([m, c, b]) => chamar(c, { metodo: m, corpo: b })));
  check(semTokenAdm.every((r) => r.status === 401), `${rotasAdmin.length} rotas /admin sem token -> 401`, `/admin sem token: ${semTokenAdm.map((r) => r.status)}`);
  const comoUsuario = await Promise.all(rotasAdmin.map(([m, c, b]) => chamar(c, { token: u1.token, metodo: m, corpo: b })));
  check(comoUsuario.every((r) => r.status === 403), `${rotasAdmin.length} rotas /admin como USUARIO -> 403`, `/admin como USUARIO: ${comoUsuario.map((r) => r.status)}`);
  const aindaAtivo = await pool.query('SELECT ativo, nome FROM usuarios WHERE id = $1', [u1.id]);
  check(aindaAtivo.rows[0]?.ativo === true && aindaAtivo.rows[0]?.nome === 'Teste Auth', 'as tentativas de USUARIO em /admin não alteraram nenhum dado', `dados alterados por USUARIO: ${JSON.stringify(aindaAtivo.rows[0])}`);
  const comoAdmin = await Promise.all(rotasAdmin.slice(0, 4).map(([m, c]) => chamar(c, { token: admin.token, metodo: m })));
  check(comoAdmin.every((r) => r.status === 200), 'ADMIN acessa cidades, usuários, resumo e configurações -> 200', `ADMIN: ${comoAdmin.map((r) => r.status)}`);
  const lista = comoAdmin[1].corpo as any[];
  check(Array.isArray(lista) && lista.every((u) => !('senha_hash' in u) && !('password' in u)) && lista.some((u) => u.id === u1.id), 'lista de usuários do ADMIN não traz hash de senha', 'a lista de usuários expõe campos de senha');
  const cfg = comoAdmin[3].texto;
  const segredos = [JWT_SECRET, process.env.DATABASE_URL, process.env.OPENAQ_API_KEY].filter((s): s is string => !!s && s.length > 6);
  check(!segredos.some((s) => cfg.includes(s)), '/admin/configuracoes não contém JWT_SECRET, DATABASE_URL nem chave da OpenAQ', '/admin/configuracoes vaza um segredo');
  const resumo = comoAdmin[2].corpo?.usuarios;
  const contagem = (await pool.query(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE ativo)::int ativos, COUNT(*) FILTER (WHERE NOT ativo)::int inativos, COUNT(*) FILTER (WHERE perfil='ADMIN')::int admins FROM usuarios`)).rows[0];
  check(resumo && Math.abs(resumo.total - contagem.total) <= 2 && Math.abs(resumo.ativos - contagem.ativos) <= 2 && resumo.administradores === contagem.admins, `/admin/resumo bate com o banco (total ${resumo?.total}, ativos ${resumo?.ativos}, admins ${resumo?.administradores})`, `resumo ${JSON.stringify(resumo)} x banco ${JSON.stringify(contagem)}`);

  secao('Administração de usuários');
  const emailNovo = novoEmail('crud');
  const cria = await chamar('/admin/usuarios', { token: admin.token, corpo: { nome: 'Criado Pelo Admin', email: emailNovo.toUpperCase(), password: SENHA, cidade: CAMPINAS, regiao: 'Zona Sul', perfil: 'ADMIN' } });
  check(cria.status === 201 && cria.corpo?.perfil === 'USUARIO' && cria.corpo?.email === emailNovo && !/senha_hash/.test(cria.texto), 'ADMIN cria usuário (perfil forjado ignorado, e-mail normalizado, sem hash na resposta)', `criar: ${cria.status} ${cria.texto.slice(0, 120)}`);
  const idNovo = cria.corpo?.id as number;
  const loginCriado = await chamar('/auth/login', { corpo: { email: emailNovo, password: SENHA } });
  check(loginCriado.status === 200 && loginCriado.corpo?.user?.cidade === CAMPINAS, 'o usuário criado pelo ADMIN consegue entrar e já está na cidade informada', `login do criado: ${loginCriado.status}`);
  const edita = await chamar(`/admin/usuarios/${idNovo}`, { token: admin.token, metodo: 'PUT', corpo: { nome: 'Nome Editado', email: emailNovo, cidade: SP, regiao: 'Centro' } });
  check(edita.status === 200 && edita.corpo?.nome === 'Nome Editado' && edita.corpo?.cidade === SP, 'ADMIN edita nome e cidade -> 200', `editar: ${edita.status} ${edita.texto.slice(0, 100)}`);
  const emailDup = await chamar(`/admin/usuarios/${idNovo}`, { token: admin.token, metodo: 'PUT', corpo: { nome: 'Nome Editado', email: u1.email, cidade: SP, regiao: 'Centro' } });
  check(emailDup.status === 400, 'editar para um e-mail já usado -> 400', `e-mail duplicado na edição: ${emailDup.status}`);
  const admRuim: [string, string, string, unknown][] = [
    ['criar sem nome', 'POST', '/admin/usuarios', { email: 'a@b.com', password: SENHA, cidade: SP, regiao: 'Centro' }],
    ['criar e-mail inválido', 'POST', '/admin/usuarios', { nome: 'Fulano', email: 'invalido', password: SENHA, cidade: SP, regiao: 'Centro' }],
    ['criar senha curta', 'POST', '/admin/usuarios', { nome: 'Fulano', email: 'f@b.com', password: '123', cidade: SP, regiao: 'Centro' }],
    ['criar senha acima de 72', 'POST', '/admin/usuarios', { nome: 'Fulano', email: 'f@b.com', password: 'a'.repeat(73), cidade: SP, regiao: 'Centro' }],
    ['criar senha numérica', 'POST', '/admin/usuarios', { nome: 'Fulano', email: 'f@b.com', password: 1234567, cidade: SP, regiao: 'Centro' }],
    ['criar cidade inválida', 'POST', '/admin/usuarios', { nome: 'Fulano', email: 'f@b.com', password: SENHA, cidade: 'Atlântida', regiao: 'Centro' }],
    ['criar nome com 121', 'POST', '/admin/usuarios', { nome: 'N'.repeat(121), email: 'f@b.com', password: SENHA, cidade: SP, regiao: 'Centro' }],
    ['status não booleano', 'PATCH', `/admin/usuarios/${idNovo}/status`, { ativo: 'false' }],
    ['status sem campo', 'PATCH', `/admin/usuarios/${idNovo}/status`, {}],
  ];
  const rAdmRuim = await Promise.all(admRuim.map(([, m, c, b]) => chamar(c, { token: admin.token, metodo: m, corpo: b })));
  check(rAdmRuim.every((r) => r.status === 400), `${admRuim.length} requisições inválidas do ADMIN -> 400 (nunca 500)`, `ADMIN inválidos: ${JSON.stringify(admRuim.map(([n], i) => [n, rAdmRuim[i].status]))}`);
  const idsRuins = ['abc', '0', '-1', '1.5', '2147483648', '99999999999', '1e3x'];
  const idPut = await Promise.all(idsRuins.map((i) => chamar(`/admin/usuarios/${i}`, { token: admin.token, metodo: 'PUT', corpo: { nome: 'Fulano', email: 'f@b.com', cidade: SP, regiao: 'Centro' } })));
  const idPatch = await Promise.all(idsRuins.map((i) => chamar(`/admin/usuarios/${i}/status`, { token: admin.token, metodo: 'PATCH', corpo: { ativo: true } })));
  check([...idPut, ...idPatch].every((r) => r.status === 400), `IDs inválidos (${idsRuins.join(', ')}) em PUT e PATCH -> 400, inclusive acima do INTEGER`, `IDs inválidos: PUT ${idPut.map((r) => r.status)} PATCH ${idPatch.map((r) => r.status)}`);
  const idNao = await chamar('/admin/usuarios/2000000000/status', { token: admin.token, metodo: 'PATCH', corpo: { ativo: true } });
  check(idNao.status === 404, 'ID válido porém inexistente -> 404', `ID inexistente: ${idNao.status}`);
  await chamar(`/admin/usuarios/${idNovo}/status`, { token: admin.token, metodo: 'PATCH', corpo: { ativo: false } });
  const loginInativoCriado = await chamar('/auth/login', { corpo: { email: emailNovo, password: SENHA } });
  check(loginInativoCriado.status === 401, 'usuário desativado pelo ADMIN não consegue entrar', `login após desativar: ${loginInativoCriado.status}`);

  // ------------------------------------------------------------------ isolamento por cidade
  secao('Isolamento por cidade (USUARIO de São Paulo)');
  const alertaAlheio = await pool.query(
    `INSERT INTO alertas (cidade, regiao, estacao_id, estacao_nome, poluente, valor, unidade, nivel, titulo, descricao, origem_dado, tipo_dado, medicao_em)
     VALUES ($1, 'Centro', $2, 'Estação de teste', 'pm25', 80, 'µg/m³', 'ALTO', $3, 'registro de teste', 'OPENAQ', 'MEDICAO', NOW()) RETURNING id`,
    [CAMPINAS, `tmp-auth-${SUFIXO}`, `${MARCA} alerta de Campinas`]
  );
  const ocorrenciaAlheia = await pool.query(
    `INSERT INTO ocorrencias (cidade, local, tipo, titulo, descricao, origem) VALUES ($1, 'Local de teste', 'POLUICAO', $2, 'registro de teste', 'MANUAL') RETURNING id`,
    [CAMPINAS, `${MARCA} ocorrência de Campinas`]
  );
  const idAlerta = alertaAlheio.rows[0].id, idOc = ocorrenciaAlheia.rows[0].id;

  const aOutra = await chamar(`/alertas?cidade=${encodeURIComponent(CAMPINAS)}`, { token: u1.token });
  const aProp = await chamar('/alertas?limite=200', { token: u1.token });
  const aId = await chamar(`/alertas/${idAlerta}`, { token: u1.token });
  const aAdm = await chamar(`/alertas/${idAlerta}`, { token: admin.token });
  check(aOutra.status === 403, 'Alertas: USUARIO pedindo outra cidade -> 403', `alertas outra cidade: ${aOutra.status}`);
  check(aProp.status === 200 && (aProp.corpo.alertas as any[]).every((a) => a.cidade === SP) && !aProp.texto.includes(MARCA), 'Alertas: sem filtro, USUARIO só recebe a própria cidade e nada de Campinas', `alertas próprios: ${aProp.status}`);
  check([403, 404].includes(aId.status) && !aId.texto.includes(MARCA), `Alertas: abrir por ID um alerta de outra cidade -> ${aId.status}, sem expor o conteúdo`, `alerta alheio por ID: ${aId.status} ${aId.texto.slice(0, 100)}`);
  check(aAdm.status === 200 && aAdm.corpo?.alerta?.cidade === CAMPINAS, 'Alertas: ADMIN abre o mesmo alerta de Campinas -> 200', `ADMIN alerta: ${aAdm.status}`);
  const resolverAlheio = await chamar(`/alertas/${idAlerta}/resolver`, { token: u1.token, metodo: 'POST', corpo: {} });
  const resolvido = (await pool.query('SELECT status FROM alertas WHERE id = $1', [idAlerta])).rows[0]?.status;
  check(resolverAlheio.status === 403 && resolvido === 'ATIVO', 'Alertas: USUARIO não resolve alerta (403) e o alerta continua ATIVO no banco', `resolver como USUARIO: ${resolverAlheio.status} status=${resolvido}`);
  const avaliarUsuario = await chamar('/alertas/avaliar', { token: u1.token, corpo: { cidade: SP } });
  check(avaliarUsuario.status === 403, 'Alertas: USUARIO não dispara a avaliação (403)', `avaliar como USUARIO: ${avaliarUsuario.status}`);

  const oOutra = await chamar(`/ocorrencias?cidade=${encodeURIComponent(CAMPINAS)}`, { token: u1.token });
  const oProp = await chamar('/ocorrencias?limite=200', { token: u1.token });
  const oId = await chamar(`/ocorrencias/${idOc}`, { token: u1.token });
  const oAdm = await chamar(`/ocorrencias/${idOc}`, { token: admin.token });
  check(oOutra.status === 403, 'Ocorrências: USUARIO pedindo outra cidade -> 403', `ocorrências outra cidade: ${oOutra.status}`);
  check(oProp.status === 200 && (oProp.corpo.ocorrencias as any[]).every((o) => o.cidade === SP) && !oProp.texto.includes(MARCA), 'Ocorrências: sem filtro, USUARIO só recebe a própria cidade e nada de Campinas', `ocorrências próprias: ${oProp.status}`);
  check(oId.status === 404 && !oId.texto.includes(MARCA), 'Ocorrências: abrir por ID uma ocorrência de outra cidade -> 404 (não revela que existe)', `ocorrência alheia por ID: ${oId.status}`);
  check(oAdm.status === 200 && oAdm.corpo?.ocorrencia?.cidade === CAMPINAS, 'Ocorrências: ADMIN abre a mesma ocorrência -> 200', `ADMIN ocorrência: ${oAdm.status}`);
  const statusAlheio = await chamar(`/ocorrencias/${idOc}/status`, { token: u1.token, metodo: 'PATCH', corpo: { status: 'CONCLUIDA' } });
  const statusBanco = (await pool.query('SELECT status FROM ocorrencias WHERE id = $1', [idOc])).rows[0]?.status;
  check(statusAlheio.status === 403 && statusBanco === 'ABERTA', 'Ocorrências: USUARIO não altera status (403) e o registro continua ABERTA no banco', `status como USUARIO: ${statusAlheio.status} banco=${statusBanco}`);
  const criaOutra = await chamar('/ocorrencias', { token: u1.token, corpo: { cidade: CAMPINAS, titulo: `${MARCA} x`, descricao: 'registro de teste', tipo: 'POLUICAO', local: 'Rua' } });
  check(criaOutra.status === 403, 'Ocorrências: USUARIO registrando em outra cidade -> 403', `criar em outra cidade: ${criaOutra.status}`);
  const gravou = (await pool.query(`SELECT COUNT(*)::int n FROM ocorrencias WHERE titulo = $1`, [`${MARCA} x`])).rows[0].n;
  check(gravou === 0, 'Ocorrências: a tentativa recusada não gravou nada', `tentativa recusada gravou ${gravou} registro(s)`);

  const hOutra = await chamar(`/historico?cidade=${encodeURIComponent(CAMPINAS)}&poluente=pm25&periodo=24H&fonte=OPEN_METEO`, { token: u1.token });
  const hProp = await chamar('/historico?poluente=pm25&periodo=24H&fonte=OPEN_METEO', { token: u1.token });
  const hAdmSem = await chamar('/historico?poluente=pm25&periodo=24H&fonte=OPEN_METEO', { token: admin.token });
  check(hOutra.status === 403, 'Histórico: USUARIO pedindo outra cidade -> 403', `histórico outra cidade: ${hOutra.status}`);
  if (hProp.status === 200) check(hProp.corpo.cidade === SP, 'Histórico: sem informar cidade, USUARIO recebe a própria (São Paulo)', `histórico próprio: cidade=${hProp.corpo?.cidade}`);
  else info(`Histórico próprio indisponível (${hProp.status}: fonte externa) — checagem pulada`);
  check(hAdmSem.status === 400, 'Histórico: ADMIN precisa informar a cidade -> 400', `ADMIN sem cidade: ${hAdmSem.status}`);

  const semCidade = await pool.query(`INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo) VALUES ('Sem Cidade', $1, $2, 'USUARIO', TRUE) RETURNING id`, [novoEmail('semcidade'), await bcrypt.hash(SENHA, 4)]);
  const emailSemCidade = emails[emails.length - 1];
  const tokenSemCidade = (await chamar('/auth/login', { corpo: { email: emailSemCidade, password: SENHA } })).corpo?.token;
  const rSemCidade = await Promise.all(['/alertas', '/ocorrencias', '/historico?poluente=pm25&periodo=24H&fonte=OPEN_METEO'].map((c) => chamar(c, { token: tokenSemCidade })));
  check(semCidade.rowCount === 1 && rSemCidade.every((r) => r.status === 403), 'USUARIO sem cidade cadastrada -> 403 em Alertas, Ocorrências e Histórico (nunca vê dados de todas as cidades)', `sem cidade: ${rSemCidade.map((r) => r.status)}`);

  info('GET /air-quality (estações e medições públicas da OpenAQ) é liberado para qualquer usuário autenticado, de qualquer cidade: são dados ambientais públicos, sem informação de usuários. A tela restringe o seletor de cidade ao USUARIO.');

  // ------------------------------------------------------------------ entradas maliciosas e IDs inválidos
  secao('Entradas maliciosas e IDs inválidos');
  const injecoes = ["' OR '1'='1", "'; DROP TABLE ocorrencias; --", '%27%20OR%201=1--', '1; SELECT pg_sleep(5)'];
  const rotasInj: ((v: string) => string)[] = [
    (v) => `/alertas?cidade=${encodeURIComponent(v)}`, (v) => `/alertas?poluente=${encodeURIComponent(v)}`, (v) => `/alertas?status=${encodeURIComponent(v)}`,
    (v) => `/ocorrencias?busca=${encodeURIComponent(v)}`, (v) => `/ocorrencias?cidade=${encodeURIComponent(v)}`, (v) => `/ocorrencias?tipo=${encodeURIComponent(v)}`, (v) => `/ocorrencias?de=${encodeURIComponent(v)}`,
    (v) => `/historico?cidade=${encodeURIComponent(v)}&poluente=pm25`, (v) => `/historico?cidade=${encodeURIComponent(SP)}&poluente=${encodeURIComponent(v)}`,
    (v) => `/air-quality/locations?cidade=${encodeURIComponent(v)}`, (v) => `/admin/estacoes?cidade=${encodeURIComponent(v)}`,
  ];
  const t0 = Date.now();
  const pedidos = injecoes.flatMap((v) => rotasInj.map((f) => chamar(f(v), { token: admin.token })));
  const rInj = await Promise.all(pedidos);
  const buscaOk = rInj.filter((r) => r.status === 200).length;
  check(rInj.every((r) => r.status >= 200 && r.status < 500) && rInj.every((r) => r.status !== 500), `${rInj.length} requisições com texto de injeção de SQL em filtros -> nenhuma respondeu 5xx (${buscaOk} tratadas como texto e ${rInj.length - buscaOk} recusadas com 4xx)`, `injeção: respostas ${JSON.stringify([...new Set(rInj.map((r) => r.status))])}`);
  check(Date.now() - t0 < 4500, 'nenhuma requisição executou o pg_sleep injetado (todas responderam rápido)', `injeção demorou ${Date.now() - t0} ms`);
  const tabelas = (await pool.query(`SELECT to_regclass('public.ocorrencias') o, to_regclass('public.alertas') a, to_regclass('public.usuarios') u`)).rows[0];
  check(!!tabelas.o && !!tabelas.a && !!tabelas.u, 'as tabelas usuarios, alertas e ocorrencias continuam existindo após as tentativas de injeção', `tabelas: ${JSON.stringify(tabelas)}`);

  const idsInv = ['abc', '0', '-1', '1.5', '2147483648', '99999999999', '9007199254740993'];
  const rotasId: [string, (i: string) => string, string?][] = [['alertas', (i) => `/alertas/${i}`], ['ocorrencias', (i) => `/ocorrencias/${i}`], ['air-quality', (i) => `/air-quality/locations/${i}/latest`], ['air-quality', (i) => `/air-quality/locations/${i}`]];
  for (const [nome, rota] of rotasId) {
    const r = await Promise.all(idsInv.map((i) => chamar(rota(i), { token: admin.token })));
    check(r.every((x) => x.status === 400), `${nome}: IDs inválidos (${idsInv.length} variações) -> 400, nunca 500`, `${nome} IDs inválidos: ${r.map((x) => x.status)}`);
  }
  const rIdPost = await Promise.all(idsInv.map((i) => chamar(`/ocorrencias/${i}/status`, { token: admin.token, metodo: 'PATCH', corpo: { status: 'CONCLUIDA' } })));
  check(rIdPost.every((x) => x.status === 400), 'ocorrências: PATCH de status com ID inválido -> 400', `PATCH IDs inválidos: ${rIdPost.map((x) => x.status)}`);

  const erros500 = [semCorpo, malformado, ...rl, ...rInj].filter((r) => /stack|node_modules|at \w+ \(/.test(r.texto));
  check(erros500.length === 0, 'nenhuma resposta de erro expõe stack trace nem caminhos internos', `${erros500.length} resposta(s) expõem detalhes internos`);
  const inexistente404 = await chamar('/rota/que/nao/existe', { token: admin.token });
  check(inexistente404.status === 404 && !/node_modules|stack/i.test(inexistente404.texto), 'rota inexistente -> 404 sem detalhes internos', `rota inexistente: ${inexistente404.status}`);
}

async function limpar() {
  await pool.query(`DELETE FROM ocorrencias WHERE titulo LIKE '[TESTE-AUTH %'`).catch(() => undefined);
  await pool.query(`DELETE FROM alertas WHERE titulo LIKE '[TESTE-AUTH %' OR estacao_id LIKE 'tmp-auth-%'`).catch(() => undefined);
  await pool.query(`DELETE FROM usuarios WHERE email LIKE 'tmp.auth.%@example.com'`).catch(() => undefined);
  const restantes = await pool.query(`SELECT (SELECT COUNT(*)::int FROM usuarios WHERE email LIKE 'tmp.auth.%') u, (SELECT COUNT(*)::int FROM ocorrencias WHERE titulo LIKE '[TESTE-AUTH %') o, (SELECT COUNT(*)::int FROM alertas WHERE titulo LIKE '[TESTE-AUTH %') a`).then((r) => r.rows[0]).catch(() => null);
  console.log(`\nLimpeza: registros de teste restantes ${JSON.stringify(restantes)}`);
}

main()
  .catch((err) => {
    falhas++;
    console.log(`  [FALHA]   erro inesperado no script: ${err instanceof Error ? err.stack || err.message : err}`);
  })
  .finally(async () => {
    await limpar();
    console.log(`\nResumo: ${total - falhas}/${total} verificações OK${falhas ? `, ${falhas} FALHA(S)` : ''}`);
    await pool.end();
    process.exit(falhas === 0 ? 0 : 1);
  });
