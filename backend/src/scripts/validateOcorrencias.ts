import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import pool from '../database';
import { STATUS_OCORRENCIA, TIPOS_OCORRENCIA, transicaoPermitida, validarNovaOcorrencia } from '../services/ocorrencias';

dotenv.config();

// Valida as Ocorrências reais (estrutura do banco, regras, constraints e rotas). Precisa do backend em execução
// (BASE_URL) e do banco. Todo registro criado aqui tem título começando com "[TESTE]" (ou pertence a usuários
// tmp.ocorr.*) e é apagado no final; as expectativas de contagem vêm de consultas SQL, então registros reais não
// atrapalham nem são tocados. Não imprime senhas, tokens nem a connection string.
// Uso: BASE_URL=http://127.0.0.1:3996/api npm run ocorrencias:validate

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3996/api';
const SP = 'São Paulo';
const CAMPINAS = 'Campinas';
const PREFIXO = '[TESTE] ';

let falhas = 0;
let total = 0;
const ok = (m: string) => { total++; console.log(`  [OK]      ${m}`); };
const falha = (m: string) => { total++; falhas++; console.log(`  [FALHA]   ${m}`); };
const check = (c: boolean, a: string, b: string) => (c ? ok(a) : falha(b));

interface Resposta { status: number; corpo: any }

async function chamar(caminho: string, opcoes: { token?: string; metodo?: string; corpo?: unknown; bruto?: string } = {}): Promise<Resposta> {
  const temCorpo = opcoes.corpo !== undefined || opcoes.bruto !== undefined;
  const metodo = opcoes.metodo ?? (temCorpo ? 'POST' : 'GET');
  const res = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: {
      ...(temCorpo ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      ...(opcoes.token ? { Authorization: `Bearer ${opcoes.token}` } : {}),
    },
    body: opcoes.bruto !== undefined ? Buffer.from(opcoes.bruto, 'utf8') : opcoes.corpo !== undefined ? Buffer.from(JSON.stringify(opcoes.corpo), 'utf8') : undefined,
  });
  let corpo: any = null;
  try { corpo = await res.json(); } catch { /* sem corpo */ }
  return { status: res.status, corpo };
}

const q = (caminho: string, params: Record<string, string | number>) =>
  `${caminho}?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}`;
const contar = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0].n as number;
const diaSP = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);

const emails: string[] = [];
async function criarUsuario(perfil: 'ADMIN' | 'USUARIO', cidade: string | null, ativo = true) {
  const email = `tmp.ocorr.${Date.now()}.${emails.length}@example.com`;
  const senha = `Tmp-${Math.random().toString(36).slice(2)}-9`;
  emails.push(email);
  const r = await pool.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, cidade, regiao) VALUES ($1, $2, $3, $4, $5, $6, 'Centro') RETURNING id`,
    [`Teste Ocorrencias ${perfil}`, email, bcrypt.hashSync(senha, 4), perfil, ativo, cidade]
  );
  const login = await chamar('/auth/login', { corpo: { email, password: senha } });
  if (login.status !== 200 || !login.corpo?.token) throw new Error(`login do usuário temporário (${perfil}) falhou: HTTP ${login.status}`);
  return { id: r.rows[0].id as number, token: login.corpo.token as string, email };
}

async function semear(o: { cidade: string; tipo: string; status: string; minutos: number; titulo: string; origem?: string }) {
  const r = await pool.query(
    `WITH t AS (SELECT NOW() - make_interval(mins => $6::int) AS c)
     INSERT INTO ocorrencias (usuario_id, cidade, local, estacao_id, estacao_nome, tipo, titulo, descricao, status, origem, criado_em, iniciado_em, atualizado_em, concluido_em)
     SELECT NULL, $1, 'Centro', 'TESTE-OC-1', 'Estação de teste', $2, $3, 'Descrição de teste', $4::varchar, $5, t.c,
            CASE WHEN $4::varchar IN ('EM_ANDAMENTO', 'CONCLUIDA') THEN t.c + INTERVAL '1 minute' END, t.c,
            CASE WHEN $4::varchar = 'CONCLUIDA' THEN t.c + INTERVAL '2 minutes' END
     FROM t RETURNING id`,
    [o.cidade, o.tipo, `${PREFIXO}${o.titulo}`, o.status, o.origem ?? 'AUTOMATICA', o.minutos]
  );
  return r.rows[0].id as number;
}

async function limpar() {
  await pool.query(`DELETE FROM ocorrencias WHERE titulo LIKE $1 OR usuario_id IN (SELECT id FROM usuarios WHERE email LIKE 'tmp.ocorr.%')`, [`${PREFIXO}%`]);
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'tmp.ocorr.%'");
}

const valida = { local: 'Zona Norte', titulo: `${PREFIXO}Fumaça visível`, descricao: 'Fumaça densa perto da avenida principal.', tipo: 'COMUNIDADE' };

// Tenta inserir direto no banco algo que as constraints devem barrar; devolve o código SQLSTATE
async function codigoDeRejeicao(sql: string, params: unknown[]): Promise<string> {
  try { await pool.query(sql, params); return 'ACEITO'; } catch (e) { return (e as { code?: string }).code ?? 'ERRO'; }
}

// ---------------------------------------------------------------- 1) estrutura do banco
async function estrutura() {
  console.log('\n=== 1) Estrutura da tabela (banco real) ===');
  const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'ocorrencias'")).rows.map((r) => r.column_name as string);
  const exigidas = ['id', 'usuario_id', 'cidade', 'local', 'estacao_id', 'estacao_nome', 'tipo', 'titulo', 'descricao', 'status', 'origem', 'poluente', 'valor', 'unidade', 'nivel', 'criado_em', 'atualizado_em', 'concluido_em'];
  const faltam = exigidas.filter((c) => !cols.includes(c));
  check(faltam.length === 0, `tabela ocorrencias tem as ${exigidas.length} colunas exigidas (+ iniciado_em: ${cols.includes('iniciado_em')})`, `colunas ausentes: ${faltam.join(',')}`);
  const idx = (await pool.query("SELECT indexname FROM pg_indexes WHERE tablename = 'ocorrencias'")).rows.map((r) => r.indexname as string);
  const idxEsperados = ['idx_ocorrencias_cidade', 'idx_ocorrencias_status', 'idx_ocorrencias_tipo', 'idx_ocorrencias_criado_em', 'idx_ocorrencias_usuario'];
  check(idxEsperados.every((i) => idx.includes(i)), 'índices por cidade, status, tipo, data e usuário existem', `índices ausentes: ${idxEsperados.filter((i) => !idx.includes(i)).join(',')}`);
  const cons = (await pool.query("SELECT conname FROM pg_constraint WHERE conrelid = 'ocorrencias'::regclass")).rows.map((r) => r.conname as string);
  check(['ck_ocorrencias_conclusao', 'ck_ocorrencias_origem_usuario', 'ck_ocorrencias_leitura'].every((c) => cons.includes(c)), 'constraints de conclusão, origem/usuário e leitura ambiental existem', 'constraint ausente');
}

// ---------------------------------------------------------------- 2) regras puras
function regras() {
  console.log('\n=== 2) Validação de entrada e transições (sem banco) ===');
  const v = (c: unknown) => validarNovaOcorrencia(c);
  check('dados' in v(valida), 'registro mínimo válido é aceito', 'registro mínimo rejeitado');
  const completo = v({ ...valida, cidade: SP, estacaoId: 'TESTE-OC-1', estacaoNome: 'Estação X', poluente: 'PM25', valor: 80.5, unidade: 'µg/m³', nivel: 'alto', tipo: 'poluicao' });
  check('dados' in completo && completo.dados.poluente === 'pm25' && completo.dados.nivel === 'ALTO' && completo.dados.tipo === 'POLUICAO',
    'poluente, nível e tipo são normalizados (pm25 / ALTO / POLUICAO)', 'normalização falhou');
  const ruins: [string, unknown][] = [
    ['corpo nulo', null], ['corpo array', []], ['corpo texto', 'x'],
    ['sem título', { ...valida, titulo: undefined }], ['título curto', { ...valida, titulo: 'ab' }], ['título > 160', { ...valida, titulo: 'a'.repeat(161) }],
    ['sem descrição', { ...valida, descricao: '   ' }], ['descrição > 2000', { ...valida, descricao: 'a'.repeat(2001) }], ['sem local', { ...valida, local: undefined }],
    ['título numérico', { ...valida, titulo: 123 }], ['NUL no texto', { ...valida, descricao: 'abc\u0000def' }],
    ['tipo ausente', { ...valida, tipo: undefined }], ['tipo inválido', { ...valida, tipo: 'OUTRO' }], ['tipo não texto', { ...valida, tipo: 1 }],
    ['poluente inválido', { ...valida, poluente: 'xyz', valor: 1, unidade: 'µg/m³' }], ['poluente __proto__', { ...valida, poluente: '__proto__', valor: 1, unidade: 'µg/m³' }],
    ['valor texto', { ...valida, poluente: 'pm25', valor: '80', unidade: 'µg/m³' }], ['valor negativo', { ...valida, poluente: 'pm25', valor: -1, unidade: 'µg/m³' }],
    ['valor infinito', { ...valida, poluente: 'pm25', valor: 1e400, unidade: 'µg/m³' }], ['poluente sem valor', { ...valida, poluente: 'pm25', unidade: 'µg/m³' }],
    ['valor sem poluente', { ...valida, valor: 5, unidade: 'µg/m³' }], ['unidade sem o resto', { ...valida, unidade: 'µg/m³' }],
    ['nível inválido', { ...valida, poluente: 'pm25', valor: 1, unidade: 'µg/m³', nivel: 'GRAVE' }], ['nível sem leitura', { ...valida, nivel: 'ALTO' }],
    ['estacaoId inválido', { ...valida, estacaoId: "x'; DROP" }], ['campo status', { ...valida, status: 'CONCLUIDA' }], ['campo origem', { ...valida, origem: 'AUTOMATICA' }],
    ['campo usuarioId', { ...valida, usuarioId: 1 }], ['campo id', { ...valida, id: 1 }], ['campo criadoEm', { ...valida, criadoEm: '2020-01-01' }],
  ];
  const aceitas = ruins.filter(([, c]) => 'dados' in v(c)).map(([n]) => n);
  check(aceitas.length === 0, `${ruins.length} entradas inválidas são rejeitadas`, `aceitas indevidamente: ${aceitas.join(', ')}`);
  const matriz = STATUS_OCORRENCIA.flatMap((a) => STATUS_OCORRENCIA.map((b) => `${a}>${b}:${transicaoPermitida(a, b)}`)).join(' ');
  check(matriz === 'ABERTA>ABERTA:false ABERTA>EM_ANDAMENTO:true ABERTA>CONCLUIDA:true EM_ANDAMENTO>ABERTA:false EM_ANDAMENTO>EM_ANDAMENTO:false EM_ANDAMENTO>CONCLUIDA:true CONCLUIDA>ABERTA:false CONCLUIDA>EM_ANDAMENTO:false CONCLUIDA>CONCLUIDA:false',
    'transições: ABERTA→EM_ANDAMENTO→CONCLUIDA (ou direto); CONCLUIDA é final', `matriz inesperada: ${matriz}`);
  check(TIPOS_OCORRENCIA.length === 5, 'cinco tipos de ocorrência', 'tipos incorretos');
}

// ---------------------------------------------------------------- 3) constraints do banco
async function constraints() {
  console.log('\n=== 3) Constraints (inserções diretas que o banco deve barrar) ===');
  const base = (campos: string, valores: string) => `INSERT INTO ocorrencias (cidade, local, tipo, titulo, descricao, status, origem${campos}) VALUES ('${SP}', 'Centro', 'POLUICAO', '${PREFIXO}c', 'd', 'ABERTA', 'MANUAL'${valores})`;
  const casos: [string, string, string][] = [
    ['tipo inválido', `INSERT INTO ocorrencias (cidade, local, tipo, titulo, descricao, origem) VALUES ('${SP}', 'x', 'OUTRO', '${PREFIXO}c', 'd', 'MANUAL')`, '23514'],
    ['status inválido', `INSERT INTO ocorrencias (cidade, local, tipo, titulo, descricao, status, origem) VALUES ('${SP}', 'x', 'POLUICAO', '${PREFIXO}c', 'd', 'FECHADA', 'MANUAL')`, '23514'],
    ['origem inválida', `INSERT INTO ocorrencias (cidade, local, tipo, titulo, descricao, origem) VALUES ('${SP}', 'x', 'POLUICAO', '${PREFIXO}c', 'd', 'ROBO')`, '23514'],
    ['poluente inválido', base(", poluente, valor, unidade", ", 'xyz', 1, 'µg/m³'"), '23514'],
    ['nível inválido', base(", poluente, valor, unidade, nivel", ", 'pm25', 1, 'µg/m³', 'GRAVE'"), '23514'],
    ['valor negativo', base(", poluente, valor, unidade", ", 'pm25', -1, 'µg/m³'"), '23514'],
    ['poluente sem valor/unidade', base(", poluente", ", 'pm25'"), '23514'],
    ['nível sem poluente', base(", nivel", ", 'ALTO'"), '23514'],
    ['CONCLUIDA sem concluido_em', `INSERT INTO ocorrencias (cidade, local, tipo, titulo, descricao, status, origem) VALUES ('${SP}', 'x', 'POLUICAO', '${PREFIXO}c', 'd', 'CONCLUIDA', 'MANUAL')`, '23514'],
    ['ABERTA com concluido_em', base(", concluido_em", ", NOW()"), '23514'],
    ['AUTOMATICA com usuario_id', `INSERT INTO ocorrencias (usuario_id, cidade, local, tipo, titulo, descricao, origem) SELECT id, '${SP}', 'x', 'POLUICAO', '${PREFIXO}c', 'd', 'AUTOMATICA' FROM usuarios LIMIT 1`, '23514'],
    ['usuario_id inexistente', base(", usuario_id", ", 2147483000"), '23503'],
    ['título nulo', `INSERT INTO ocorrencias (cidade, local, tipo, descricao, origem) VALUES ('${SP}', 'x', 'POLUICAO', 'd', 'MANUAL')`, '23502'],
    ['origem nula', `INSERT INTO ocorrencias (cidade, local, tipo, titulo, descricao) VALUES ('${SP}', 'x', 'POLUICAO', '${PREFIXO}c', 'd')`, '23502'],
  ];
  for (const [nome, sql, esperado] of casos) {
    const codigo = await codigoDeRejeicao(sql, []);
    check(codigo === esperado, `banco rejeita: ${nome} (${codigo})`, `${nome}: esperado ${esperado}, obtido ${codigo}`);
  }
  const bom = await codigoDeRejeicao(base(", poluente, valor, unidade, nivel", ", 'pm25', 80, 'µg/m³', 'ALTO'"), []);
  check(bom === 'ACEITO', 'banco aceita registro completo e coerente', `registro válido rejeitado (${bom})`);
}

// ---------------------------------------------------------------- 4) rotas
async function rotas() {
  console.log('\n=== 4) API (usuários temporários, banco real) ===');
  const antes = await contar('SELECT COUNT(*)::int AS n FROM ocorrencias');
  const admin = await criarUsuario('ADMIN', 'Osasco');
  const sp = await criarUsuario('USUARIO', SP);
  const camp = await criarUsuario('USUARIO', CAMPINAS);
  const semCidade = await criarUsuario('USUARIO', null);
  const inativo = await criarUsuario('USUARIO', SP);

  // --- dados semeados (automáticos): SP 12, Campinas 6, mais um antigo (40 dias) em SP
  const idsSp: number[] = [];
  for (let i = 0; i < 12; i++) idsSp.push(await semear({ cidade: SP, tipo: TIPOS_OCORRENCIA[i % 5], status: STATUS_OCORRENCIA[i % 3], minutos: 10 + i * 3, titulo: `auto SP ${i}` }));
  const idsCamp: number[] = [];
  for (let i = 0; i < 6; i++) idsCamp.push(await semear({ cidade: CAMPINAS, tipo: TIPOS_OCORRENCIA[(i + 1) % 5], status: STATUS_OCORRENCIA[i % 3], minutos: 20 + i * 4, titulo: `auto Campinas ${i}` }));
  const idAntigo = await semear({ cidade: SP, tipo: 'POLUICAO', status: 'CONCLUIDA', minutos: 40 * 24 * 60, titulo: 'auto SP antigo' });

  console.log('\n--- 401 / autenticação ---');
  const sem = [await chamar('/ocorrencias'), await chamar(`/ocorrencias/${idsSp[0]}`), await chamar('/ocorrencias', { corpo: valida }), await chamar(`/ocorrencias/${idsSp[0]}/status`, { metodo: 'PATCH', corpo: { status: 'CONCLUIDA' } })];
  check(sem.every((r) => r.status === 401), 'sem token: listar, obter, criar e alterar status respondem 401', `sem token: ${sem.map((r) => r.status).join(',')}`);
  const ruim = [await chamar('/ocorrencias', { token: 'token-invalido' }), await chamar('/ocorrencias', { token: `${sp.token.slice(0, -4)}xxxx` })];
  check(ruim.every((r) => r.status === 401), 'token inválido/adulterado responde 401', `token ruim: ${ruim.map((r) => r.status).join(',')}`);
  await pool.query('UPDATE usuarios SET ativo = FALSE WHERE id = $1', [inativo.id]);
  const rInativo = await chamar('/ocorrencias', { token: inativo.token });
  check(rInativo.status === 401, 'usuário desativado perde o acesso na hora (401)', `desativado: ${rInativo.status}`);

  console.log('\n--- criação manual ---');
  const c1 = await chamar('/ocorrencias', { token: sp.token, corpo: valida });
  const o1 = c1.corpo?.ocorrencia;
  check(c1.status === 201 && o1?.origem === 'MANUAL' && o1?.status === 'ABERTA' && o1?.cidade === SP && o1?.usuarioId === sp.id && o1?.concluidoEm === null && o1?.iniciadoEm === null && o1?.poluente === null,
    'USUARIO cria ocorrência manual: 201, origem MANUAL, status ABERTA, cidade e usuário do servidor', `criação: ${c1.status} ${JSON.stringify(c1.corpo).slice(0, 160)}`);
  const linha = (await pool.query('SELECT origem, status, cidade, usuario_id FROM ocorrencias WHERE id = $1', [o1?.id])).rows[0];
  check(linha?.origem === 'MANUAL' && linha?.status === 'ABERTA' && linha?.cidade === SP && linha?.usuario_id === sp.id, 'registro gravado no banco com os mesmos valores', `banco: ${JSON.stringify(linha)}`);
  const c2 = await chamar('/ocorrencias', { token: sp.token, corpo: { ...valida, titulo: `${PREFIXO}Leitura alta`, tipo: 'poluicao', cidade: SP, estacaoId: 'TESTE-OC-9', estacaoNome: 'Estação Teste', poluente: 'PM25', valor: 81.25, unidade: 'µg/m³', nivel: 'alto' } });
  const o2 = c2.corpo?.ocorrencia;
  check(c2.status === 201 && o2?.poluente === 'pm25' && o2?.valor === 81.25 && o2?.unidade === 'µg/m³' && o2?.nivel === 'ALTO' && o2?.tipo === 'POLUICAO' && o2?.estacaoId === 'TESTE-OC-9',
    'ocorrência com leitura ambiental completa (cidade própria explícita, valores normalizados)', `leitura: ${c2.status} ${JSON.stringify(c2.corpo).slice(0, 200)}`);
  const cOutra = await chamar('/ocorrencias', { token: sp.token, corpo: { ...valida, cidade: CAMPINAS } });
  check(cOutra.status === 403, 'USUARIO não cria ocorrência em outra cidade (403)', `outra cidade: ${cOutra.status}`);
  const cAtl = await chamar('/ocorrencias', { token: sp.token, corpo: { ...valida, cidade: 'Atlantis' } });
  check(cAtl.status === 400, 'cidade inexistente é 400', `Atlantis: ${cAtl.status}`);
  const cAdm = await chamar('/ocorrencias', { token: admin.token, corpo: { ...valida, cidade: CAMPINAS, titulo: `${PREFIXO}Admin em Campinas` } });
  check(cAdm.status === 201 && cAdm.corpo?.ocorrencia?.cidade === CAMPINAS && cAdm.corpo?.ocorrencia?.usuarioId === admin.id, 'ADMIN cria em qualquer cidade (informando a cidade)', `admin cria: ${cAdm.status}`);
  const cAdmSem = await chamar('/ocorrencias', { token: admin.token, corpo: valida });
  check(cAdmSem.status === 400, 'ADMIN sem informar a cidade recebe 400', `admin sem cidade: ${cAdmSem.status}`);
  const cCamp = await chamar('/ocorrencias', { token: camp.token, corpo: { ...valida, titulo: `${PREFIXO}Campinas manual` } });
  check(cCamp.status === 201 && cCamp.corpo?.ocorrencia?.cidade === CAMPINAS, 'USUARIO de Campinas registra em Campinas', `camp: ${cCamp.status}`);
  const cSem = [await chamar('/ocorrencias', { token: semCidade.token, corpo: valida }), await chamar('/ocorrencias', { token: semCidade.token })];
  check(cSem.every((r) => r.status === 403), 'usuário sem cidade cadastrada: criar e listar respondem 403', `sem cidade: ${cSem.map((r) => r.status).join(',')}`);

  const invalidos: [string, unknown][] = [
    ['sem título', { ...valida, titulo: undefined }], ['tipo inválido', { ...valida, tipo: 'OUTRO' }], ['sem tipo', { ...valida, tipo: undefined }],
    ['título gigante', { ...valida, titulo: 'a'.repeat(500) }], ['valor texto', { ...valida, poluente: 'pm25', valor: 'alto', unidade: 'µg/m³' }],
    ['poluente inválido', { ...valida, poluente: 'xyz', valor: 1, unidade: 'µg/m³' }], ['nível inválido', { ...valida, poluente: 'pm25', valor: 1, unidade: 'µg/m³', nivel: 'GRAVE' }],
    ['injeção de status', { ...valida, status: 'CONCLUIDA' }], ['injeção de origem', { ...valida, origem: 'AUTOMATICA' }], ['injeção de usuário', { ...valida, usuarioId: admin.id }],
    ['corpo array', [valida]], ['NUL no texto', { ...valida, descricao: 'a\u0000b' }],
  ];
  const resultados = await Promise.all(invalidos.map(async ([n, corpo]) => [n, (await chamar('/ocorrencias', { token: sp.token, corpo })).status] as const));
  check(resultados.every(([, s]) => s === 400), `${invalidos.length} corpos inválidos respondem 400`, `não 400: ${resultados.filter(([, s]) => s !== 400).map(([n, s]) => `${n}=${s}`).join(', ')}`);
  const malformado = await chamar('/ocorrencias', { token: sp.token, bruto: '{"titulo": ' });
  check(malformado.status === 400, 'JSON malformado responde 400 (não 500)', `malformado: ${malformado.status}`);
  const total1 = await contar('SELECT COUNT(*)::int AS n FROM ocorrencias WHERE titulo = $1', [`${PREFIXO}c`]);
  check(total1 === 0, 'nada foi gravado pelas requisições inválidas', 'requisição inválida gravou registro');
  const inj = await chamar('/ocorrencias', { token: sp.token, corpo: { ...valida, titulo: `${PREFIXO}'; DROP TABLE ocorrencias; --`, descricao: "' OR '1'='1" } });
  const injLido = await chamar(`/ocorrencias/${inj.corpo?.ocorrencia?.id}`, { token: sp.token });
  check(inj.status === 201 && injLido.corpo?.ocorrencia?.titulo === `${PREFIXO}'; DROP TABLE ocorrencias; --` && (await contar('SELECT COUNT(*)::int AS n FROM ocorrencias')) > 0,
    'texto com aspas/SQL é gravado literalmente (consultas parametrizadas) e a tabela segue intacta', `injeção: ${inj.status}`);

  console.log('\n--- consulta, ADMIN x USUARIO ---');
  const lSp = await chamar('/ocorrencias?limite=200', { token: sp.token });
  const totSp = await contar('SELECT COUNT(*)::int AS n FROM ocorrencias WHERE cidade = $1', [SP]);
  check(lSp.status === 200 && lSp.corpo.total === totSp && lSp.corpo.ocorrencias.length === totSp && lSp.corpo.ocorrencias.every((o: any) => o.cidade === SP),
    `USUARIO lista só a própria cidade (${totSp} registros, todos de ${SP})`, `lista USUARIO: ${lSp.status} total=${lSp.corpo?.total} esperado=${totSp}`);
  const lSpOutra = await chamar(q('/ocorrencias', { cidade: CAMPINAS }), { token: sp.token });
  const lSpPropria = await chamar(q('/ocorrencias', { cidade: SP }), { token: sp.token });
  check(lSpOutra.status === 403 && lSpPropria.status === 200, '?cidade= de outra cidade é 403 para USUARIO; a própria é aceita', `outra=${lSpOutra.status} propria=${lSpPropria.status}`);
  const lAdm = await chamar('/ocorrencias?limite=200', { token: admin.token });
  const totTudo = await contar('SELECT COUNT(*)::int AS n FROM ocorrencias');
  check(lAdm.status === 200 && lAdm.corpo.total === totTudo && new Set(lAdm.corpo.ocorrencias.map((o: any) => o.cidade)).size >= 2, `ADMIN enxerga todas as cidades (${totTudo} registros)`, `lista ADMIN: ${lAdm.status} total=${lAdm.corpo?.total} esperado=${totTudo}`);
  const lAdmCamp = await chamar(q('/ocorrencias', { cidade: CAMPINAS, limite: 200 }), { token: admin.token });
  const totCamp = await contar('SELECT COUNT(*)::int AS n FROM ocorrencias WHERE cidade = $1', [CAMPINAS]);
  check(lAdmCamp.corpo?.total === totCamp && lAdmCamp.corpo.ocorrencias.every((o: any) => o.cidade === CAMPINAS), `ADMIN filtra por cidade (${CAMPINAS}: ${totCamp})`, `filtro cidade ADMIN: ${lAdmCamp.corpo?.total} esperado=${totCamp}`);
  const lCamp = await chamar('/ocorrencias?limite=200', { token: camp.token });
  check(lCamp.corpo?.ocorrencias?.every((o: any) => o.cidade === CAMPINAS) && !lCamp.corpo.ocorrencias.some((o: any) => idsSp.includes(o.id)), 'USUARIO de Campinas não vê ocorrências de São Paulo', 'vazamento entre cidades');

  console.log('\n--- filtros e paginação ---');
  for (const status of STATUS_OCORRENCIA) {
    const r = await chamar(q('/ocorrencias', { cidade: SP, status: status.toLowerCase(), limite: 200 }), { token: admin.token });
    const esperado = await contar('SELECT COUNT(*)::int AS n FROM ocorrencias WHERE cidade = $1 AND status = $2', [SP, status]);
    check(r.corpo?.total === esperado && r.corpo.ocorrencias.every((o: any) => o.status === status), `filtro status=${status} (minúsculas aceitas): ${esperado}`, `status ${status}: ${r.corpo?.total} esperado=${esperado}`);
  }
  for (const tipo of TIPOS_OCORRENCIA) {
    const r = await chamar(q('/ocorrencias', { cidade: SP, tipo, limite: 200 }), { token: admin.token });
    const esperado = await contar('SELECT COUNT(*)::int AS n FROM ocorrencias WHERE cidade = $1 AND tipo = $2', [SP, tipo]);
    check(r.corpo?.total === esperado && r.corpo.ocorrencias.every((o: any) => o.tipo === tipo), `filtro tipo=${tipo}: ${esperado}`, `tipo ${tipo}: ${r.corpo?.total} esperado=${esperado}`);
  }
  const combinado = await chamar(q('/ocorrencias', { cidade: SP, status: 'ABERTA', tipo: 'POLUICAO', limite: 200 }), { token: admin.token });
  const esperadoComb = await contar("SELECT COUNT(*)::int AS n FROM ocorrencias WHERE cidade = $1 AND status = 'ABERTA' AND tipo = 'POLUICAO'", [SP]);
  check(combinado.corpo?.total === esperadoComb, `filtros combinados cidade+status+tipo: ${esperadoComb}`, `combinado: ${combinado.corpo?.total} esperado=${esperadoComb}`);
  const dia40 = diaSP(new Date(Date.now() - 40 * 24 * 3600 * 1000));
  const hoje = diaSP(new Date());
  const ontem = diaSP(new Date(Date.now() - 24 * 3600 * 1000));
  const pAntigo = await chamar(q('/ocorrencias', { cidade: SP, de: dia40, ate: dia40, limite: 200 }), { token: admin.token });
  check(pAntigo.corpo?.ocorrencias?.some((o: any) => o.id === idAntigo) && pAntigo.corpo.ocorrencias.every((o: any) => diaSP(new Date(o.criadoEm)) === dia40), `período ${dia40}: traz o registro de 40 dias atrás e só do dia`, `período antigo: ${JSON.stringify(pAntigo.corpo?.ocorrencias?.map((o: any) => o.id))}`);
  const pHoje = await chamar(q('/ocorrencias', { cidade: SP, de: hoje, ate: hoje, limite: 200 }), { token: admin.token });
  check(pHoje.corpo?.ocorrencias?.length > 0 && !pHoje.corpo.ocorrencias.some((o: any) => o.id === idAntigo), 'período de hoje inclui os recentes e exclui o antigo', 'período de hoje incorreto');
  const pOntem = await chamar(q('/ocorrencias', { cidade: SP, ate: ontem, limite: 200 }), { token: admin.token });
  check(pOntem.corpo?.ocorrencias?.some((o: any) => o.id === idAntigo) && !pOntem.corpo.ocorrencias.some((o: any) => idsSp.includes(o.id)), 'apenas "ate" (ontem) devolve só o antigo', 'ate=ontem incorreto');
  const pDe = await chamar(q('/ocorrencias', { cidade: SP, de: hoje, limite: 200 }), { token: admin.token });
  check(!pDe.corpo?.ocorrencias?.some((o: any) => o.id === idAntigo), 'apenas "de" (hoje) exclui o antigo', 'de=hoje incorreto');

  const ruinsFiltro = [
    'status=XYZ', "tipo=' OR 1=1--", 'tipo=POLUICAO;DROP', 'cidade=Atlantis', 'limite=0', 'limite=201', 'limite=abc', 'limite=1.5', 'pagina=0', 'pagina=-1', 'pagina=abc',
    'de=2026-02-30', 'de=ontem', 'ate=2026-13-01', `de=${hoje}&ate=${ontem}`, 'status=ABERTA&status=CONCLUIDA', 'status=', 'cidade=',
  ];
  const rf = await Promise.all(ruinsFiltro.map(async (f) => [f, (await chamar(`/ocorrencias?${f}`, { token: admin.token })).status] as const));
  check(rf.every(([, s]) => s === 400), `${ruinsFiltro.length} filtros inválidos respondem 400`, `não 400: ${rf.filter(([, s]) => s !== 400).map(([f, s]) => `${f}=${s}`).join(', ')}`);

  const todas: any[] = [];
  let pagina = 1; let totalPag = 0; let ultimo: Resposta | null = null;
  do {
    ultimo = await chamar(q('/ocorrencias', { cidade: SP, limite: 5, pagina }), { token: admin.token });
    totalPag = ultimo.corpo?.total ?? 0;
    todas.push(...(ultimo.corpo?.ocorrencias ?? []));
    pagina++;
  } while ((ultimo.corpo?.ocorrencias?.length ?? 0) === 5 && pagina < 20);
  const ids = todas.map((o) => o.id);
  check(new Set(ids).size === ids.length && ids.length === totSp + 0 && totalPag === totSp, `paginação (limite 5): ${pagina - 1} páginas, ${ids.length} itens sem repetição, total ${totalPag}`, `paginação: itens=${ids.length} únicos=${new Set(ids).size} total=${totalPag} esperado=${totSp}`);
  const primeiraConcluida = todas.findIndex((o) => o.status === 'CONCLUIDA');
  const ordemOk = (primeiraConcluida === -1 || todas.slice(primeiraConcluida).every((o) => o.status === 'CONCLUIDA'))
    && [todas.filter((o) => o.status !== 'CONCLUIDA'), todas.filter((o) => o.status === 'CONCLUIDA')].every((g) => g.every((o, i) => i === 0 || Date.parse(g[i - 1].criadoEm) >= Date.parse(o.criadoEm)));
  check(ordemOk, 'ordem: em aberto primeiro e, em cada grupo, da mais recente para a mais antiga', 'ordenação incorreta');
  const alem = await chamar(q('/ocorrencias', { cidade: SP, limite: 5, pagina: 99 }), { token: admin.token });
  check(alem.status === 200 && alem.corpo.ocorrencias.length === 0 && alem.corpo.total === totSp, 'página além da última: lista vazia, total preservado', `além: ${alem.status} ${alem.corpo?.ocorrencias?.length}`);
  const rAberta = await chamar(q('/ocorrencias', { cidade: SP, status: 'ABERTA' }), { token: admin.token });
  const rTodas = await chamar(q('/ocorrencias', { cidade: SP }), { token: admin.token });
  const porStatus = (await pool.query('SELECT status, COUNT(*)::int AS n FROM ocorrencias WHERE cidade = $1 GROUP BY status', [SP])).rows;
  const esperadoResumo = { ABERTA: 0, EM_ANDAMENTO: 0, CONCLUIDA: 0, ...Object.fromEntries(porStatus.map((r) => [r.status, r.n])) };
  check(JSON.stringify(rAberta.corpo?.resumo) === JSON.stringify(rTodas.corpo?.resumo) && JSON.stringify(rTodas.corpo?.resumo) === JSON.stringify(esperadoResumo),
    `resumo por status bate com o banco e ignora o filtro de status (${JSON.stringify(esperadoResumo)})`, `resumo: ${JSON.stringify(rTodas.corpo?.resumo)} esperado=${JSON.stringify(esperadoResumo)}`);

  console.log('\n--- busca por texto ---');
  const nCidade = (sql: string, cidade: string) => contar(`SELECT COUNT(*)::int AS n FROM ocorrencias WHERE cidade = $1 AND (${sql})`, [cidade]);
  const bAuto = await chamar(q('/ocorrencias', { cidade: SP, busca: 'AUTO sp', limite: 200 }), { token: admin.token });
  const esperadoAuto = await nCidade("lower(titulo) LIKE '%auto sp%'", SP);
  check(bAuto.status === 200 && bAuto.corpo.total === esperadoAuto && esperadoAuto >= 13, `busca "AUTO sp" (maiúsculas ignoradas): ${esperadoAuto} resultados`, `busca auto: ${bAuto.status} total=${bAuto.corpo?.total} esperado=${esperadoAuto}`);
  const somaResumo = (r: Resposta) => Object.values(r.corpo?.resumo ?? {}).reduce((a: number, b: any) => a + b, 0);
  check(somaResumo(bAuto) === esperadoAuto, 'o resumo por status acompanha a busca', `resumo da busca: ${JSON.stringify(bAuto.corpo?.resumo)}`);
  const bAutoAberta = await chamar(q('/ocorrencias', { cidade: SP, busca: 'auto sp', status: 'ABERTA', limite: 200 }), { token: admin.token });
  const esperadoAutoAberta = await nCidade("lower(titulo) LIKE '%auto sp%' AND status = 'ABERTA'", SP);
  check(bAutoAberta.corpo?.total === esperadoAutoAberta && somaResumo(bAutoAberta) === esperadoAuto, 'busca combinada com status; o resumo ignora o status', `busca+status: ${bAutoAberta.corpo?.total} esperado=${esperadoAutoAberta}`);
  const buscas: [string, string, number][] = [
    ['FUMACA VISIVEL', 'título sem acento e em maiúsculas', o1?.id], ['fumaça visível', 'título com acento', o1?.id],
    ['avenida principal', 'descrição', o1?.id], ['zona norte', 'local', o1?.id], ['estacao teste', 'estação sem acento', o2?.id],
    [`OC-${String(o1?.id).padStart(4, '0')}`, 'número no formato OC-0001', o1?.id], [String(o1?.id), 'número simples', o1?.id],
  ];
  for (const [termo, descricao, idEsperado] of buscas) {
    const r = await chamar(q('/ocorrencias', { cidade: SP, busca: termo, limite: 200 }), { token: admin.token });
    check(r.status === 200 && r.corpo.ocorrencias.some((o: any) => o.id === idEsperado), `busca "${termo}" encontra por ${descricao}`, `busca "${termo}": ${r.status} ids=${JSON.stringify(r.corpo?.ocorrencias?.map((o: any) => o.id))}`);
  }
  const bId = await chamar(q('/ocorrencias', { cidade: SP, busca: `OC-${String(o1?.id).padStart(4, '0')}`, limite: 200 }), { token: admin.token });
  check(bId.corpo?.total === 1, 'busca pelo número da ocorrência devolve só ela', `busca por número: total=${bId.corpo?.total}`);
  for (const simbolo of ['%', '_', '\\']) {
    const r = await chamar(q('/ocorrencias', { cidade: SP, busca: simbolo, limite: 200 }), { token: admin.token });
    const esperado = await nCidade(`position('${simbolo}' in coalesce(titulo, '') || '|' || descricao || '|' || local || '|' || coalesce(estacao_nome, '')) > 0`, SP);
    check(r.status === 200 && r.corpo.total === esperado, `"${simbolo}" digitado é texto comum, não curinga (${esperado} resultados)`, `curinga ${simbolo}: ${r.status} total=${r.corpo?.total} esperado=${esperado}`);
  }
  const bUsuario = await chamar(q('/ocorrencias', { busca: 'auto campinas', limite: 200 }), { token: sp.token });
  const bAdminCamp = await chamar(q('/ocorrencias', { busca: 'auto campinas', limite: 200 }), { token: admin.token });
  const esperadoCamp = await contar("SELECT COUNT(*)::int AS n FROM ocorrencias WHERE lower(titulo) LIKE '%auto campinas%'");
  check(bUsuario.status === 200 && bUsuario.corpo.total === 0 && bAdminCamp.corpo?.total === esperadoCamp && esperadoCamp >= 6, 'busca não atravessa cidades: USUARIO não acha as de Campinas; ADMIN acha', `busca entre cidades: usuário=${bUsuario.corpo?.total} admin=${bAdminCamp.corpo?.total} esperado=${esperadoCamp}`);
  const bRuins = await Promise.all(['busca=', `busca=${'a'.repeat(101)}`, 'busca=a%00b', 'busca=a&busca=b'].map(async (f) => [f.slice(0, 12), (await chamar(`/ocorrencias?${f}`, { token: admin.token })).status] as const));
  check(bRuins.every(([, s]) => s === 400), 'busca vazia, com mais de 100 caracteres, com caractere nulo ou repetida -> 400', `busca inválida: ${bRuins.map(([f, s]) => `${f}=${s}`).join(', ')}`);
  const bInj = await chamar(q('/ocorrencias', { busca: "'; DROP TABLE ocorrencias; --", limite: 200 }), { token: admin.token });
  check(bInj.status === 200 && (await contar('SELECT COUNT(*)::int AS n FROM ocorrencias')) > 0, 'texto de injeção na busca é só um termo (200, tabela intacta)', `injeção na busca: ${bInj.status}`);

  console.log('\n--- consulta por ID (404/400) ---');
  const g = [await chamar(`/ocorrencias/${idsSp[0]}`, { token: sp.token }), await chamar(`/ocorrencias/${idsCamp[0]}`, { token: sp.token }), await chamar(`/ocorrencias/${idsCamp[0]}`, { token: admin.token }), await chamar('/ocorrencias/2147483647', { token: sp.token })];
  check(g[0].status === 200 && g[0].corpo.ocorrencia.id === idsSp[0], 'USUARIO obtém ocorrência da própria cidade (200)', `própria: ${g[0].status}`);
  check(g[1].status === 404 && g[3].status === 404 && JSON.stringify(g[1].corpo) === JSON.stringify(g[3].corpo), 'ocorrência de outra cidade responde 404 igual à inexistente (não revela que existe)', `outra=${g[1].status} inexistente=${g[3].status}`);
  check(g[2].status === 200, 'ADMIN obtém ocorrência de qualquer cidade', `admin: ${g[2].status}`);
  const gi = await Promise.all(['abc', '0', '-5', '1.5', '99999999999'].map(async (i) => [i, (await chamar(`/ocorrencias/${i}`, { token: admin.token })).status] as const));
  check(gi.every(([, s]) => s === 400), 'ID inválido (abc, 0, negativo, decimal, fora do INTEGER) responde 400', `ids: ${gi.map(([i, s]) => `${i}=${s}`).join(',')}`);

  console.log('\n--- alteração de status (somente ADMIN) ---');
  const idA = idsSp.find((_, i) => STATUS_OCORRENCIA[i % 3] === 'ABERTA') as number;
  const pUsuario = [
    await chamar(`/ocorrencias/${idA}/status`, { token: sp.token, metodo: 'PATCH', corpo: { status: 'CONCLUIDA' } }),
    await chamar(`/ocorrencias/${idsCamp[0]}/status`, { token: sp.token, metodo: 'PATCH', corpo: { status: 'CONCLUIDA' } }),
    await chamar(`/ocorrencias/${o1?.id}/status`, { token: sp.token, metodo: 'PATCH', corpo: { status: 'EM_ANDAMENTO' } }),
  ];
  const aindaAberta = await contar("SELECT COUNT(*)::int AS n FROM ocorrencias WHERE id = $1 AND status = 'ABERTA'", [idA]);
  check(pUsuario.every((r) => r.status === 403) && aindaAberta === 1, 'USUARIO não altera status (nem na própria cidade, nem a que ele criou): 403 e nada mudou', `USUARIO PATCH: ${pUsuario.map((r) => r.status).join(',')}`);
  const novaA = (await chamar('/ocorrencias', { token: sp.token, corpo: { ...valida, titulo: `${PREFIXO}Fluxo de status` } })).corpo.ocorrencia;
  const antesAtualiz = Date.parse(novaA.atualizadoEm);
  await new Promise((r) => setTimeout(r, 30));
  const s1 = await chamar(`/ocorrencias/${novaA.id}/status`, { token: admin.token, metodo: 'PATCH', corpo: { status: 'em_andamento' } });
  check(s1.status === 200 && s1.corpo.ocorrencia.status === 'EM_ANDAMENTO' && s1.corpo.ocorrencia.iniciadoEm !== null && s1.corpo.ocorrencia.concluidoEm === null && Date.parse(s1.corpo.ocorrencia.atualizadoEm) > antesAtualiz,
    'ADMIN: ABERTA → EM_ANDAMENTO (iniciadoEm e atualizadoEm preenchidos; minúsculas aceitas)', `em andamento: ${s1.status} ${JSON.stringify(s1.corpo).slice(0, 200)}`);
  const s2 = await chamar(`/ocorrencias/${novaA.id}/status`, { token: admin.token, metodo: 'PATCH', corpo: { status: 'CONCLUIDA' } });
  check(s2.status === 200 && s2.corpo.ocorrencia.status === 'CONCLUIDA' && s2.corpo.ocorrencia.concluidoEm !== null && s2.corpo.ocorrencia.iniciadoEm === s1.corpo.ocorrencia.iniciadoEm,
    'ADMIN: EM_ANDAMENTO → CONCLUIDA (concluidoEm preenchido, iniciadoEm preservado)', `concluída: ${s2.status}`);
  const volta = await Promise.all(['ABERTA', 'EM_ANDAMENTO', 'CONCLUIDA'].map((s) => chamar(`/ocorrencias/${novaA.id}/status`, { token: admin.token, metodo: 'PATCH', corpo: { status: s } })));
  const depois = (await pool.query('SELECT status, concluido_em FROM ocorrencias WHERE id = $1', [novaA.id])).rows[0];
  check(volta.every((r) => r.status === 409) && volta[0].corpo?.ocorrencia?.status === 'CONCLUIDA' && depois.status === 'CONCLUIDA' && depois.concluido_em !== null, 'CONCLUIDA é final: qualquer nova mudança responde 409 e nada muda', `após concluir: ${volta.map((r) => r.status).join(',')}`);
  const direta = (await chamar('/ocorrencias', { token: sp.token, corpo: { ...valida, titulo: `${PREFIXO}Conclusão direta` } })).corpo.ocorrencia;
  const sd = await chamar(`/ocorrencias/${direta.id}/status`, { token: admin.token, metodo: 'PATCH', corpo: { status: 'CONCLUIDA' } });
  check(sd.status === 200 && sd.corpo.ocorrencia.concluidoEm !== null && sd.corpo.ocorrencia.iniciadoEm === null, 'ADMIN: ABERTA → CONCLUIDA direto', `direta: ${sd.status}`);
  const mesma = (await chamar('/ocorrencias', { token: sp.token, corpo: { ...valida, titulo: `${PREFIXO}Mesmo status` } })).corpo.ocorrencia;
  const sm = await chamar(`/ocorrencias/${mesma.id}/status`, { token: admin.token, metodo: 'PATCH', corpo: { status: 'ABERTA' } });
  await chamar(`/ocorrencias/${mesma.id}/status`, { token: admin.token, metodo: 'PATCH', corpo: { status: 'EM_ANDAMENTO' } });
  const sv = await chamar(`/ocorrencias/${mesma.id}/status`, { token: admin.token, metodo: 'PATCH', corpo: { status: 'ABERTA' } });
  check(sm.status === 409 && sv.status === 409, 'mesmo status (ABERTA→ABERTA) e retrocesso (EM_ANDAMENTO→ABERTA) respondem 409', `mesma=${sm.status} volta=${sv.status}`);
  const invalidosPatch: [string, unknown][] = [['status inválido', { status: 'FECHADA' }], ['sem status', {}], ['status número', { status: 1 }], ['campo extra', { status: 'CONCLUIDA', titulo: 'x' }], ['corpo array', ['CONCLUIDA']], ['sem corpo', undefined]];
  const rp = await Promise.all(invalidosPatch.map(async ([n, corpo]) => [n, (await chamar(`/ocorrencias/${mesma.id}/status`, { token: admin.token, metodo: 'PATCH', corpo })).status] as const));
  check(rp.every(([, s]) => s === 400), `${invalidosPatch.length} corpos inválidos no PATCH respondem 400`, `PATCH: ${rp.map(([n, s]) => `${n}=${s}`).join(', ')}`);
  const p404 = await chamar('/ocorrencias/2147483647/status', { token: admin.token, metodo: 'PATCH', corpo: { status: 'CONCLUIDA' } });
  const p400 = await chamar('/ocorrencias/abc/status', { token: admin.token, metodo: 'PATCH', corpo: { status: 'CONCLUIDA' } });
  check(p404.status === 404 && p400.status === 400, 'PATCH em ocorrência inexistente é 404 e em ID inválido é 400', `404=${p404.status} 400=${p400.status}`);
  const corrida = (await chamar('/ocorrencias', { token: sp.token, corpo: { ...valida, titulo: `${PREFIXO}Corrida` } })).corpo.ocorrencia;
  const paralelo = await Promise.all(Array.from({ length: 8 }, () => chamar(`/ocorrencias/${corrida.id}/status`, { token: admin.token, metodo: 'PATCH', corpo: { status: 'CONCLUIDA' } })));
  const contagem = paralelo.map((r) => r.status).sort().join(',');
  check(contagem === '200,409,409,409,409,409,409,409', 'concorrência: 8 conclusões simultâneas → exatamente uma 200 e sete 409', `paralelo: ${contagem}`);
  const incoerentes = await contar(`SELECT COUNT(*)::int AS n FROM ocorrencias WHERE (status = 'CONCLUIDA') <> (concluido_em IS NOT NULL)`);
  check(incoerentes === 0, 'nenhum registro com status e concluido_em incoerentes', `${incoerentes} registros incoerentes`);

  console.log('\n--- usuário removido ---');
  const tmp = await criarUsuario('USUARIO', SP);
  const doTmp = (await chamar('/ocorrencias', { token: tmp.token, corpo: { ...valida, titulo: `${PREFIXO}De usuário removido` } })).corpo.ocorrencia;
  await pool.query('DELETE FROM usuarios WHERE id = $1', [tmp.id]);
  const aposRemocao = (await pool.query('SELECT usuario_id, origem FROM ocorrencias WHERE id = $1', [doTmp.id])).rows[0];
  check(aposRemocao?.usuario_id === null && aposRemocao?.origem === 'MANUAL', 'remover o usuário preserva a ocorrência (usuario_id vira NULL)', `após remoção: ${JSON.stringify(aposRemocao)}`);

  return antes;
}

async function main() {
  const totalAntes = await contar('SELECT COUNT(*)::int AS n FROM ocorrencias');
  console.log(`Ocorrências no banco antes do teste: ${totalAntes} (os registros reais não são tocados)`);
  try {
    await estrutura();
    regras();
    await constraints();
    await limpar();
    await rotas();
  } finally {
    await limpar();
    const restantes = await contar('SELECT COUNT(*)::int AS n FROM ocorrencias WHERE titulo LIKE $1', [`${PREFIXO}%`]);
    const usuarios = await contar("SELECT COUNT(*)::int AS n FROM usuarios WHERE email LIKE 'tmp.ocorr.%'");
    const totalDepois = await contar('SELECT COUNT(*)::int AS n FROM ocorrencias');
    console.log('\n=== Limpeza ===');
    check(restantes === 0 && usuarios === 0, 'registros e usuários de teste removidos', `restaram ${restantes} ocorrências e ${usuarios} usuários de teste`);
    check(totalDepois === totalAntes, `o banco voltou ao mesmo total de ocorrências (${totalDepois})`, `total antes=${totalAntes} depois=${totalDepois}`);
  }
}

main()
  .catch((e) => { falhas++; console.log(`  [ERRO]    ${(e as Error).message}`); })
  .finally(async () => {
    console.log(`\nResumo: ${total - falhas} verificações OK, ${falhas} falha(s) de ${total}.`);
    await pool.end().catch(() => undefined);
    process.exitCode = falhas === 0 ? 0 : 1;
  });
