import pool from '../database';
import { CIDADES } from '../data/cidades';
import { LIMIARES, NIVEIS_ALERTA, NivelAlerta } from '../data/limiaresAlertas';

// Ocorrências ambientais persistidas. Nesta etapa NÃO há integração automática com os Alertas: o registro vem do
// próprio usuário (MANUAL). A origem AUTOMATICA existe no modelo para a integração futura. Ver backend/docs/OCORRENCIAS.md

export const TIPOS_OCORRENCIA = ['POLUICAO', 'QUEIMADA', 'EMISSAO', 'COMUNIDADE', 'NORMALIZACAO'] as const;
export type TipoOcorrencia = (typeof TIPOS_OCORRENCIA)[number];

export const STATUS_OCORRENCIA = ['ABERTA', 'EM_ANDAMENTO', 'CONCLUIDA'] as const;
export type StatusOcorrencia = (typeof STATUS_OCORRENCIA)[number];

export const ORIGENS_OCORRENCIA = ['AUTOMATICA', 'MANUAL'] as const;
export type OrigemOcorrencia = (typeof ORIGENS_OCORRENCIA)[number];

export const LIMITES_TEXTO = {
  titulo: { min: 3, max: 160 },
  descricao: { min: 3, max: 2000 },
  local: { min: 2, max: 160 },
  estacaoNome: { min: 1, max: 255 },
  unidade: { min: 1, max: 20 },
} as const;

const VALOR_MAXIMO = 1_000_000_000;
const ID_ESTACAO_REGEX = /^[\w.-]{1,40}$/;

const temChave = (objeto: object, chave: string) => Object.prototype.hasOwnProperty.call(objeto, chave);

export const cidadeSuportada = (cidade: string) => temChave(CIDADES, cidade);
export const normalizarPoluente = (poluente: unknown) => (typeof poluente === 'string' ? poluente.trim().toLowerCase() : '');
export const poluenteSuportado = (poluente: string) => temChave(LIMIARES, poluente);

export interface Ocorrencia {
  id: number;
  usuarioId: number | null; // quem registrou (somente MANUAL)
  cidade: string;
  local: string; // estação, quando houver, ou a região/local informado
  estacaoId: string | null;
  estacaoNome: string | null;
  tipo: TipoOcorrencia;
  titulo: string;
  descricao: string;
  status: StatusOcorrencia;
  origem: OrigemOcorrencia;
  poluente: string | null;
  valor: number | null;
  unidade: string | null;
  nivel: NivelAlerta | null;
  criadoEm: string;
  iniciadoEm: string | null; // quando passou para EM_ANDAMENTO
  atualizadoEm: string;
  concluidoEm: string | null;
}

interface OcorrenciaRow {
  id: number;
  usuario_id: number | null;
  cidade: string;
  local: string;
  estacao_id: string | null;
  estacao_nome: string | null;
  tipo: TipoOcorrencia;
  titulo: string;
  descricao: string;
  status: StatusOcorrencia;
  origem: OrigemOcorrencia;
  poluente: string | null;
  valor: number | null;
  unidade: string | null;
  nivel: NivelAlerta | null;
  criado_em: Date;
  iniciado_em: Date | null;
  atualizado_em: Date;
  concluido_em: Date | null;
}

const iso = (data: Date | null) => (data ? data.toISOString() : null);

const paraOcorrencia = (r: OcorrenciaRow): Ocorrencia => ({
  id: r.id,
  usuarioId: r.usuario_id,
  cidade: r.cidade,
  local: r.local,
  estacaoId: r.estacao_id,
  estacaoNome: r.estacao_nome,
  tipo: r.tipo,
  titulo: r.titulo,
  descricao: r.descricao,
  status: r.status,
  origem: r.origem,
  poluente: r.poluente,
  valor: r.valor,
  unidade: r.unidade,
  nivel: r.nivel,
  criadoEm: r.criado_em.toISOString(),
  iniciadoEm: iso(r.iniciado_em),
  atualizadoEm: r.atualizado_em.toISOString(),
  concluidoEm: iso(r.concluido_em),
});

// ---------------------------------------------------------------- Validação da entrada (pura, sem banco)
export interface NovaOcorrencia {
  cidade: string | null; // ADMIN informa; para USUARIO a cidade vem sempre do cadastro
  local: string;
  titulo: string;
  descricao: string;
  tipo: TipoOcorrencia;
  estacaoId: string | null;
  estacaoNome: string | null;
  poluente: string | null;
  valor: number | null;
  unidade: string | null;
  nivel: NivelAlerta | null;
}

const CAMPOS_PERMITIDOS = ['cidade', 'local', 'titulo', 'descricao', 'tipo', 'estacaoId', 'estacaoNome', 'poluente', 'valor', 'unidade', 'nivel'];

type Lido<T> = { valor: T } | { erro: string };

const lerTexto = (v: unknown, campo: string, limites: { min: number; max: number }, obrigatorio: boolean): Lido<string | null> => {
  if (v === undefined || v === null) return obrigatorio ? { erro: `"${campo}" é obrigatório` } : { valor: null };
  if (typeof v !== 'string') return { erro: `"${campo}" deve ser um texto` };
  // O PostgreSQL rejeita o caractere NUL em texto (viraria erro 500)
  if (v.includes('\u0000')) return { erro: `"${campo}" contém caracteres inválidos` };
  const texto = v.trim();
  if (texto === '') return obrigatorio ? { erro: `"${campo}" é obrigatório` } : { valor: null };
  if (texto.length < limites.min || texto.length > limites.max) return { erro: `"${campo}" deve ter entre ${limites.min} e ${limites.max} caracteres` };
  return { valor: texto };
};

export function validarNovaOcorrencia(corpo: unknown): { dados: NovaOcorrencia } | { erro: string } {
  if (corpo === null || typeof corpo !== 'object' || Array.isArray(corpo)) return { erro: 'Corpo da requisição inválido' };
  const c = corpo as Record<string, unknown>;

  // Nada de preencher status, origem, usuário ou datas pela requisição
  const extra = Object.keys(c).find((k) => !CAMPOS_PERMITIDOS.includes(k));
  if (extra !== undefined) return { erro: `Campo não permitido: "${extra.slice(0, 40)}"` };

  const cidade = lerTexto(c.cidade, 'cidade', { min: 1, max: 80 }, false);
  if ('erro' in cidade) return cidade;
  const local = lerTexto(c.local, 'local', LIMITES_TEXTO.local, true);
  if ('erro' in local) return local;
  const titulo = lerTexto(c.titulo, 'titulo', LIMITES_TEXTO.titulo, true);
  if ('erro' in titulo) return titulo;
  const descricao = lerTexto(c.descricao, 'descricao', LIMITES_TEXTO.descricao, true);
  if ('erro' in descricao) return descricao;
  const estacaoNome = lerTexto(c.estacaoNome, 'estacaoNome', LIMITES_TEXTO.estacaoNome, false);
  if ('erro' in estacaoNome) return estacaoNome;

  if (typeof c.tipo !== 'string') return { erro: '"tipo" é obrigatório' };
  const tipo = c.tipo.trim().toUpperCase() as TipoOcorrencia;
  if (!TIPOS_OCORRENCIA.includes(tipo)) return { erro: `"tipo" deve ser um de: ${TIPOS_OCORRENCIA.join(', ')}` };

  const estacaoIdLido = lerTexto(c.estacaoId, 'estacaoId', { min: 1, max: 40 }, false);
  if ('erro' in estacaoIdLido) return estacaoIdLido;
  if (estacaoIdLido.valor !== null && !ID_ESTACAO_REGEX.test(estacaoIdLido.valor)) return { erro: '"estacaoId" inválido' };

  // Leitura ambiental associada: poluente, valor e unidade andam juntos (ou nenhum deles)
  const poluenteLido = lerTexto(c.poluente, 'poluente', { min: 1, max: 10 }, false);
  if ('erro' in poluenteLido) return poluenteLido;
  const poluente = poluenteLido.valor === null ? null : normalizarPoluente(poluenteLido.valor);
  if (poluente !== null && !poluenteSuportado(poluente)) return { erro: `"poluente" deve ser um de: ${Object.keys(LIMIARES).join(', ')}` };

  let valor: number | null = null;
  if (c.valor !== undefined && c.valor !== null) {
    if (typeof c.valor !== 'number' || !Number.isFinite(c.valor) || c.valor < 0 || c.valor > VALOR_MAXIMO) {
      return { erro: '"valor" deve ser um número maior ou igual a zero' };
    }
    valor = c.valor;
  }
  const unidade = lerTexto(c.unidade, 'unidade', LIMITES_TEXTO.unidade, false);
  if ('erro' in unidade) return unidade;
  const informados = [poluente !== null, valor !== null, unidade.valor !== null].filter(Boolean).length;
  if (informados !== 0 && informados !== 3) return { erro: '"poluente", "valor" e "unidade" devem ser informados juntos' };

  let nivel: NivelAlerta | null = null;
  if (c.nivel !== undefined && c.nivel !== null) {
    if (typeof c.nivel !== 'string') return { erro: '"nivel" deve ser um texto' };
    nivel = c.nivel.trim().toUpperCase() as NivelAlerta;
    if (!NIVEIS_ALERTA.includes(nivel)) return { erro: `"nivel" deve ser um de: ${NIVEIS_ALERTA.join(', ')}` };
    if (poluente === null) return { erro: '"nivel" só pode ser informado junto com poluente, valor e unidade' };
  }

  return {
    dados: {
      cidade: cidade.valor,
      local: local.valor as string,
      titulo: titulo.valor as string,
      descricao: descricao.valor as string,
      tipo,
      estacaoId: estacaoIdLido.valor,
      estacaoNome: estacaoNome.valor,
      poluente,
      valor,
      unidade: unidade.valor,
      nivel,
    },
  };
}

// ---------------------------------------------------------------- Banco
export async function criarOcorrenciaManual(dados: NovaOcorrencia, cidade: string, usuarioId: number): Promise<Ocorrencia> {
  const r = await pool.query<OcorrenciaRow>(
    `INSERT INTO ocorrencias
       (usuario_id, cidade, local, estacao_id, estacao_nome, tipo, titulo, descricao, status, origem, poluente, valor, unidade, nivel)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ABERTA', 'MANUAL', $9, $10, $11, $12)
     RETURNING *`,
    [usuarioId, cidade, dados.local, dados.estacaoId, dados.estacaoNome, dados.tipo, dados.titulo, dados.descricao, dados.poluente, dados.valor, dados.unidade, dados.nivel]
  );
  return paraOcorrencia(r.rows[0]);
}

// Busca de texto sem diferenciar maiúsculas nem acentos (título, descrição, local, estação) ou pelo número da ocorrência
// ("12" ou "OC-0012"). O termo vai sempre como parâmetro; % _ e \ digitados são tratados como texto comum.
const LETRAS_COM_ACENTO = 'áàâãäéèêëíìîïóòôõöúùûüç';
const LETRAS_SEM_ACENTO = 'aaaaaeeeeiiiiooooouuuuc';
const semAcentoSql = (coluna: string) =>
  `lower(translate(${coluna}, '${LETRAS_COM_ACENTO}${LETRAS_COM_ACENTO.toUpperCase()}', '${LETRAS_SEM_ACENTO}${LETRAS_SEM_ACENTO}'))`;
const semAcento = (texto: string) => texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function condicaoBusca(busca: string, primeiroParametro: number): { sql: string; valores: unknown[] } {
  const termo = busca.trim();
  const valores: unknown[] = [`%${semAcento(termo).replace(/[\\%_]/g, '\\$&')}%`];
  const partes = ['titulo', 'descricao', 'local', 'estacao_nome'].map((coluna) => `${semAcentoSql(coluna)} LIKE $${primeiroParametro}`);
  const numero = /^(?:oc-?)?0*(\d{1,9})$/i.exec(termo);
  if (numero) {
    valores.push(Number(numero[1]));
    partes.push(`id = $${primeiroParametro + 1}`);
  }
  return { sql: `(${partes.join(' OR ')})`, valores };
}

export interface FiltroOcorrencias {
  cidade?: string;
  status?: StatusOcorrencia;
  tipo?: TipoOcorrencia;
  busca?: string; // texto livre (ver condicaoBusca)
  de?: string; // YYYY-MM-DD (início do dia em America/Sao_Paulo, inclusivo)
  ate?: string; // YYYY-MM-DD (fim do dia em America/Sao_Paulo, inclusivo)
  limite: number;
  pagina: number;
}

export type ResumoStatus = Record<StatusOcorrencia, number>;

// Ocorrências em aberto primeiro; dentro de cada grupo, as mais recentes. O resumo ignora o filtro de status.
export async function listarOcorrencias(filtro: FiltroOcorrencias): Promise<{ total: number; resumo: ResumoStatus; ocorrencias: Ocorrencia[] }> {
  const condicoes: string[] = [];
  const valores: unknown[] = [];
  const adicionar = (sql: string, valor: unknown) => {
    valores.push(valor);
    condicoes.push(sql.replace('?', `$${valores.length}`));
  };

  if (filtro.cidade !== undefined) adicionar('cidade = ?', filtro.cidade);
  if (filtro.tipo !== undefined) adicionar('tipo = ?', filtro.tipo);
  if (filtro.busca !== undefined) {
    const busca = condicaoBusca(filtro.busca, valores.length + 1);
    valores.push(...busca.valores);
    condicoes.push(busca.sql);
  }
  if (filtro.de !== undefined) adicionar("criado_em >= (((?)::date)::timestamp AT TIME ZONE 'America/Sao_Paulo')", filtro.de);
  if (filtro.ate !== undefined) adicionar("criado_em < ((((?)::date + 1))::timestamp AT TIME ZONE 'America/Sao_Paulo')", filtro.ate);

  const baseResumo = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  const valoresResumo = [...valores];
  if (filtro.status !== undefined) adicionar('status = ?', filtro.status);
  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  const [contagem, lista, porStatus] = await Promise.all([
    pool.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM ocorrencias ${where}`, valores),
    pool.query<OcorrenciaRow>(
      `SELECT * FROM ocorrencias ${where}
       ORDER BY (status <> 'CONCLUIDA') DESC, criado_em DESC, id DESC
       LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
      [...valores, filtro.limite, (filtro.pagina - 1) * filtro.limite]
    ),
    pool.query<{ status: StatusOcorrencia; n: number }>(`SELECT status, COUNT(*)::int AS n FROM ocorrencias ${baseResumo} GROUP BY status`, valoresResumo),
  ]);

  const resumo: ResumoStatus = { ABERTA: 0, EM_ANDAMENTO: 0, CONCLUIDA: 0 };
  for (const linha of porStatus.rows) resumo[linha.status] = linha.n;

  return { total: contagem.rows[0].total, resumo, ocorrencias: lista.rows.map(paraOcorrencia) };
}

export async function obterOcorrencia(id: number): Promise<Ocorrencia | null> {
  const r = await pool.query<OcorrenciaRow>('SELECT * FROM ocorrencias WHERE id = $1', [id]);
  return r.rows[0] ? paraOcorrencia(r.rows[0]) : null;
}

// ABERTA -> EM_ANDAMENTO -> CONCLUIDA (ou ABERTA -> CONCLUIDA direto). CONCLUIDA é final.
const TRANSICOES: Record<StatusOcorrencia, StatusOcorrencia[]> = {
  ABERTA: ['EM_ANDAMENTO', 'CONCLUIDA'],
  EM_ANDAMENTO: ['CONCLUIDA'],
  CONCLUIDA: [],
};

export const transicaoPermitida = (de: StatusOcorrencia, para: StatusOcorrencia) => TRANSICOES[de].includes(para);

export type ResultadoStatus =
  | { resultado: 'nao_encontrada' }
  | { resultado: 'transicao_invalida'; ocorrencia: Ocorrencia }
  | { resultado: 'ok'; ocorrencia: Ocorrencia };

// A linha fica travada (FOR UPDATE) durante a validação e a gravação: duas alterações simultâneas não passam juntas
export async function alterarStatus(id: number, novo: StatusOcorrencia): Promise<ResultadoStatus> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const atual = await cliente.query<OcorrenciaRow>('SELECT * FROM ocorrencias WHERE id = $1 FOR UPDATE', [id]);
    if (atual.rows.length === 0) {
      await cliente.query('ROLLBACK');
      return { resultado: 'nao_encontrada' };
    }
    if (!transicaoPermitida(atual.rows[0].status, novo)) {
      await cliente.query('ROLLBACK');
      return { resultado: 'transicao_invalida', ocorrencia: paraOcorrencia(atual.rows[0]) };
    }
    const r = await cliente.query<OcorrenciaRow>(
      `UPDATE ocorrencias SET
         status = $2::varchar,
         iniciado_em = CASE WHEN $2::varchar = 'EM_ANDAMENTO' THEN NOW() ELSE iniciado_em END,
         concluido_em = CASE WHEN $2::varchar = 'CONCLUIDA' THEN NOW() ELSE NULL END,
         atualizado_em = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, novo]
    );
    await cliente.query('COMMIT');
    return { resultado: 'ok', ocorrencia: paraOcorrencia(r.rows[0]) };
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    cliente.release();
  }
}
