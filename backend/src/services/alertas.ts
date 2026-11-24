import pool from '../database';
import { CIDADES } from '../data/cidades';
import { COORDENADAS_CIDADES } from '../data/cidadesCoordenadas';
import { LIMIARES, NIVEIS_ALERTA, NivelAlerta, UNIDADE_DOS_LIMIARES } from '../data/limiaresAlertas';
import { OpenAQError } from '../integrations/openaq/client';
import { LIMITE_DEFASAGEM_HORAS, POLUENTES } from '../integrations/openaq/mapper';
import { buscarEstacoes, obterUltimasMedicoes } from './airQuality';
import { Fonte, MedicaoConsolidada, TipoDado } from './consolidador';

// Alertas de qualidade do ar. Toda a regra de negócio fica aqui; as rotas só autenticam, validam a entrada e chamam.
//
// Duplicidade: existe no máximo UM alerta ATIVO por (cidade, estação, poluente) — garantido pelo índice único parcial
// uq_alertas_ativo. Uma nova avaliação com o MESMO nível atualiza o alerta ativo (valor, origem, medição, texto);
// com nível DIFERENTE resolve o ativo e cria outro no novo nível, preservando o histórico da escalada.
//
// Resolução automática: uma medição VÁLIDA e ATUAL abaixo do menor limiar resolve o alerta ativo. Dado ausente,
// inválido, desatualizado ou em unidade incompatível NÃO resolve (a condição real é desconhecida). Não há histerese
// nem tempo mínimo de permanência — pendência de decisão. A rota de resolução manual (ADMIN) existe para o resto.
//
// Unidades: só µg/m³ é comparado com os limiares. ppm, ppb, mg/m³ etc. são tratados como não avaliáveis (nenhuma
// conversão é feita: ppm <-> µg/m³ depende de temperatura, pressão e massa molar).

export type StatusAlerta = 'ATIVO' | 'RESOLVIDO';
export const STATUS_ALERTA: readonly StatusAlerta[] = ['ATIVO', 'RESOLVIDO'];
export type { NivelAlerta };
export { NIVEIS_ALERTA };

export interface Alerta {
  id: number;
  cidade: string;
  regiao: string | null;
  estacaoId: string;
  estacaoNome: string | null;
  poluente: string; // chave: pm25, pm10, o3, no2, co, so2
  poluenteNome: string;
  valor: number;
  unidade: string;
  nivel: NivelAlerta;
  titulo: string;
  descricao: string;
  status: StatusAlerta;
  origemDado: Fonte;
  tipoDado: TipoDado; // MEDICAO (estação) ou MODELO (estimativa); nunca confundir
  medicaoEm: string;
  criadoEm: string;
  atualizadoEm: string;
  resolvidoEm: string | null;
}

interface AlertaRow {
  id: number;
  cidade: string;
  regiao: string | null;
  estacao_id: string;
  estacao_nome: string | null;
  poluente: string;
  valor: number;
  unidade: string;
  nivel: NivelAlerta;
  titulo: string;
  descricao: string;
  status: StatusAlerta;
  origem_dado: Fonte;
  tipo_dado: TipoDado;
  medicao_em: Date;
  criado_em: Date;
  atualizado_em: Date;
  resolvido_em: Date | null;
}

const COLUNAS =
  'id, cidade, regiao, estacao_id, estacao_nome, poluente, valor, unidade, nivel, titulo, descricao, status, origem_dado, tipo_dado, medicao_em, criado_em, atualizado_em, resolvido_em';

export const nomeDoPoluente = (chave: string) => POLUENTES.find((p) => p.chave === chave)?.nome ?? chave;

const mapAlerta = (r: AlertaRow): Alerta => ({
  id: r.id,
  cidade: r.cidade,
  regiao: r.regiao,
  estacaoId: r.estacao_id,
  estacaoNome: r.estacao_nome,
  poluente: r.poluente,
  poluenteNome: nomeDoPoluente(r.poluente),
  valor: r.valor,
  unidade: r.unidade,
  nivel: r.nivel,
  titulo: r.titulo,
  descricao: r.descricao,
  status: r.status,
  origemDado: r.origem_dado,
  tipoDado: r.tipo_dado,
  medicaoEm: r.medicao_em.toISOString(),
  criadoEm: r.criado_em.toISOString(),
  atualizadoEm: r.atualizado_em.toISOString(),
  resolvidoEm: r.resolvido_em ? r.resolvido_em.toISOString() : null,
});

// ---------------------------------------------------------------- Regras (funções puras)
export type MotivoIgnorado =
  | 'cidade_invalida'
  | 'estacao_invalida'
  | 'origem_invalida'
  | 'poluente_desconhecido'
  | 'dado_ausente'
  | 'valor_invalido'
  | 'unidade_ausente'
  | 'unidade_incompativel'
  | 'data_invalida'
  | 'dado_desatualizado'
  | 'medicao_anterior';

export type ClassificacaoValor = { avaliavel: true; nivel: NivelAlerta | null } | { avaliavel: false; motivo: MotivoIgnorado };

const temChave = (objeto: object, chave: string) => Object.prototype.hasOwnProperty.call(objeto, chave);

export const normalizarPoluente = (poluente: unknown) => (typeof poluente === 'string' ? poluente.trim().toLowerCase() : '');

// Aceita só µg/m³ (e as grafias com "μ" grego, "ug/m3" e "mcg"): é a unidade dos limiares
const normalizarUnidade = (unidade: string) =>
  unidade.trim().toLowerCase().replace(/[µμ]/g, 'u').replace(/\s+/g, '').replace(/³/g, '3');

export const unidadeCompativel = (unidade: unknown) => typeof unidade === 'string' && normalizarUnidade(unidade) === 'ug/m3';

// Maior nível cujo limiar o valor atingiu; null se não atinge nem o de BAIXO
export function nivelDoValor(poluente: string, valor: number): NivelAlerta | null {
  const limiares = LIMIARES[poluente];
  let nivel: NivelAlerta | null = null;
  for (const candidato of NIVEIS_ALERTA) {
    if (valor >= limiares[candidato]) nivel = candidato;
  }
  return nivel;
}

// Decide se o par valor/unidade pode ser comparado e, se puder, em que nível cai. Nunca compara unidade incompatível.
export function classificarValor(poluente: unknown, valor: unknown, unidade: unknown): ClassificacaoValor {
  const chave = normalizarPoluente(poluente);
  if (!temChave(LIMIARES, chave)) return { avaliavel: false, motivo: 'poluente_desconhecido' };
  if (valor === null || valor === undefined) return { avaliavel: false, motivo: 'dado_ausente' };
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0) return { avaliavel: false, motivo: 'valor_invalido' };
  if (typeof unidade !== 'string' || unidade.trim() === '') return { avaliavel: false, motivo: 'unidade_ausente' };
  if (!unidadeCompativel(unidade)) return { avaliavel: false, motivo: 'unidade_incompativel' };
  return { avaliavel: true, nivel: nivelDoValor(chave, valor) };
}

const ROTULO_NIVEL: Record<NivelAlerta, string> = { BAIXO: 'baixo', MODERADO: 'moderado', ALTO: 'alto', CRITICO: 'crítico' };
const formatarNumero = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

export function montarTexto(poluente: string, nivel: NivelAlerta, valor: number, estacaoNome: string | null, estacaoId: string, tipoDado: TipoDado) {
  const nome = nomeDoPoluente(poluente);
  const estacao = estacaoNome || `estação ${estacaoId}`;
  const limiar = `${formatarNumero(LIMIARES[poluente][nivel])} ${UNIDADE_DOS_LIMIARES}`;
  const faixa = `nível ${ROTULO_NIVEL[nivel]} (a partir de ${limiar}; limiar técnico provisório)`;

  const descricao =
    tipoDado === 'MEDICAO'
      ? `${nome} medido em ${formatarNumero(valor)} ${UNIDADE_DOS_LIMIARES} na estação ${estacao}, ${faixa}.`
      : `Estimativa do modelo CAMS (Open-Meteo) para a localização da estação ${estacao}: ${nome} em ${formatarNumero(valor)} ${UNIDADE_DOS_LIMIARES}, ${faixa}. Não é uma medição local.`;

  return { titulo: `Nível ${ROTULO_NIVEL[nivel]} de ${nome}`, descricao };
}

const tipoDaOrigem = (origem: unknown): TipoDado | null => (origem === 'OPENAQ' ? 'MEDICAO' : origem === 'OPEN_METEO' ? 'MODELO' : null);

// ---------------------------------------------------------------- Avaliação de um poluente
export interface DadosPoluente {
  cidade: string;
  regiao?: string | null;
  estacaoId: string | number;
  estacaoNome?: string | null;
  poluente: string;
  valor: number | null | undefined;
  unidade: string | null | undefined;
  medicaoEm: string | Date | null | undefined;
  origem: Fonte | null | undefined;
}

export type AcaoAlerta = 'criado' | 'atualizado' | 'resolvido' | 'sem_alerta' | 'ignorado';

export interface ResultadoAvaliacao {
  acao: AcaoAlerta;
  alerta: Alerta | null; // criado/atualizado: o alerta ativo; resolvido: o alerta resolvido
  substituido: Alerta | null; // alerta ativo de outro nível que foi resolvido para dar lugar ao novo
  motivo: MotivoIgnorado | null;
}

const ignorado = (motivo: MotivoIgnorado, alerta: Alerta | null = null): ResultadoAvaliacao => ({ acao: 'ignorado', alerta, substituido: null, motivo });

const ID_ESTACAO_REGEX = /^[\w.-]{1,40}$/;

// Aplica as regras a UM valor de UM poluente de uma estação e persiste o resultado.
// Só escreve no banco depois de validar cidade, estação, origem, unidade, valor e data.
export async function avaliarPoluente(dados: DadosPoluente, agora = new Date()): Promise<ResultadoAvaliacao> {
  if (typeof dados.cidade !== 'string' || !temChave(CIDADES, dados.cidade)) return ignorado('cidade_invalida');

  const estacaoId = String(dados.estacaoId ?? '');
  if (!ID_ESTACAO_REGEX.test(estacaoId)) return ignorado('estacao_invalida');

  const classificacao = classificarValor(dados.poluente, dados.valor, dados.unidade);
  if (!classificacao.avaliavel) return ignorado(classificacao.motivo);

  const tipoDado = tipoDaOrigem(dados.origem);
  if (!tipoDado || !dados.origem) return ignorado('origem_invalida');

  const instante = dados.medicaoEm instanceof Date ? dados.medicaoEm.getTime() : Date.parse(String(dados.medicaoEm ?? ''));
  if (Number.isNaN(instante)) return ignorado('data_invalida');
  // Medição antiga não cria nem resolve alerta: não representa a situação atual
  if (agora.getTime() - instante > LIMITE_DEFASAGEM_HORAS * 60 * 60 * 1000) return ignorado('dado_desatualizado');

  const poluente = normalizarPoluente(dados.poluente);
  const medicaoEm = new Date(instante);

  if (classificacao.nivel === null) {
    return resolverPorRegra(dados.cidade, estacaoId, poluente, medicaoEm);
  }

  return registrarAlerta({
    cidade: dados.cidade,
    regiao: dados.regiao ?? null,
    estacaoId,
    estacaoNome: dados.estacaoNome ?? null,
    poluente,
    valor: dados.valor as number,
    nivel: classificacao.nivel,
    origem: dados.origem,
    tipoDado,
    medicaoEm,
  });
}

interface NovoAlerta {
  cidade: string;
  regiao: string | null;
  estacaoId: string;
  estacaoNome: string | null;
  poluente: string;
  valor: number;
  nivel: NivelAlerta;
  origem: Fonte;
  tipoDado: TipoDado;
  medicaoEm: Date;
}

// Cria ou atualiza o alerta ativo da chave (cidade, estação, poluente) numa transação.
// O lock consultivo por chave serializa as avaliações simultâneas; o índice único parcial fica como trava final
// (no conflito, repete uma vez).
async function registrarAlerta(n: NovoAlerta): Promise<ResultadoAvaliacao> {
  const { titulo, descricao } = montarTexto(n.poluente, n.nivel, n.valor, n.estacaoNome, n.estacaoId, n.tipoDado);

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serializa as avaliações da MESMA chave (cidade, estação, poluente): sem isso, sob contenção alta, várias
      // transações disputam o mesmo INSERT e o índice único recusa as perdedoras. O lock é liberado no COMMIT/ROLLBACK.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`alertas|${n.cidade}|${n.estacaoId}|${n.poluente}`]);
      const ativo = await client.query<AlertaRow>(
        `SELECT ${COLUNAS} FROM alertas WHERE cidade = $1 AND estacao_id = $2 AND poluente = $3 AND status = 'ATIVO' FOR UPDATE`,
        [n.cidade, n.estacaoId, n.poluente]
      );
      const existente = ativo.rows[0];
      let resultado: ResultadoAvaliacao;

      if (existente && existente.medicao_em.getTime() > n.medicaoEm.getTime()) {
        // Chegou uma medição mais antiga que a que já gerou o alerta: não regride o estado
        resultado = ignorado('medicao_anterior', mapAlerta(existente));
      } else if (existente && existente.nivel === n.nivel) {
        const atualizado = await client.query<AlertaRow>(
          `UPDATE alertas
           SET regiao = $2, estacao_nome = $3, valor = $4, unidade = $5, titulo = $6, descricao = $7,
               origem_dado = $8, tipo_dado = $9, medicao_em = $10, atualizado_em = NOW()
           WHERE id = $1
           RETURNING ${COLUNAS}`,
          [existente.id, n.regiao, n.estacaoNome, n.valor, UNIDADE_DOS_LIMIARES, titulo, descricao, n.origem, n.tipoDado, n.medicaoEm]
        );
        resultado = { acao: 'atualizado', alerta: mapAlerta(atualizado.rows[0]), substituido: null, motivo: null };
      } else {
        let substituido: Alerta | null = null;
        if (existente) {
          const resolvido = await client.query<AlertaRow>(
            `UPDATE alertas SET status = 'RESOLVIDO', resolvido_em = NOW(), atualizado_em = NOW() WHERE id = $1 RETURNING ${COLUNAS}`,
            [existente.id]
          );
          substituido = mapAlerta(resolvido.rows[0]);
        }
        const criado = await client.query<AlertaRow>(
          `INSERT INTO alertas (cidade, regiao, estacao_id, estacao_nome, poluente, valor, unidade, nivel, titulo, descricao, status, origem_dado, tipo_dado, medicao_em)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ATIVO', $11, $12, $13)
           RETURNING ${COLUNAS}`,
          [n.cidade, n.regiao, n.estacaoId, n.estacaoNome, n.poluente, n.valor, UNIDADE_DOS_LIMIARES, n.nivel, titulo, descricao, n.origem, n.tipoDado, n.medicaoEm]
        );
        resultado = { acao: 'criado', alerta: mapAlerta(criado.rows[0]), substituido, motivo: null };
      }

      await client.query('COMMIT');
      return resultado;
    } catch (error: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error?.code === '23505' && tentativa === 0) continue;
      throw error;
    } finally {
      client.release();
    }
  }

  throw new Error('Não foi possível registrar o alerta');
}

// Medição válida, atual e abaixo de todos os limiares: a condição deixou de existir
async function resolverPorRegra(cidade: string, estacaoId: string, poluente: string, medicaoEm: Date): Promise<ResultadoAvaliacao> {
  const resolvido = await pool.query<AlertaRow>(
    `UPDATE alertas SET status = 'RESOLVIDO', resolvido_em = NOW(), atualizado_em = NOW()
     WHERE cidade = $1 AND estacao_id = $2 AND poluente = $3 AND status = 'ATIVO' AND medicao_em <= $4
     RETURNING ${COLUNAS}`,
    [cidade, estacaoId, poluente, medicaoEm]
  );
  const alerta = resolvido.rows[0] ? mapAlerta(resolvido.rows[0]) : null;
  return { acao: alerta ? 'resolvido' : 'sem_alerta', alerta, substituido: null, motivo: null };
}

// Resolução manual (operação controlada, restrita a ADMIN na rota)
export async function resolverAlerta(id: number): Promise<{ resultado: 'resolvido' | 'ja_resolvido' | 'nao_encontrado'; alerta: Alerta | null }> {
  const atualizado = await pool.query<AlertaRow>(
    `UPDATE alertas SET status = 'RESOLVIDO', resolvido_em = NOW(), atualizado_em = NOW() WHERE id = $1 AND status = 'ATIVO' RETURNING ${COLUNAS}`,
    [id]
  );
  if (atualizado.rows[0]) return { resultado: 'resolvido', alerta: mapAlerta(atualizado.rows[0]) };

  const existente = await obterAlerta(id);
  return existente ? { resultado: 'ja_resolvido', alerta: existente } : { resultado: 'nao_encontrado', alerta: null };
}

// ---------------------------------------------------------------- Avaliação a partir dos dados consolidados
export interface ContextoEstacao {
  cidade: string;
  regiao?: string | null;
  estacaoId: string | number;
  estacaoNome?: string | null;
}

// Recebe o resultado do consolidador (OpenAQ principal, Open-Meteo como fallback) e avalia cada poluente
// com a origem que o consolidador escolheu — a origem do valor que gerou o alerta fica registrada.
export async function avaliarMedicoesDaEstacao(contexto: ContextoEstacao, medicoes: MedicaoConsolidada[], agora = new Date()): Promise<ResultadoAvaliacao[]> {
  const resultados: ResultadoAvaliacao[] = [];
  for (const m of medicoes) {
    resultados.push(
      await avaliarPoluente(
        { ...contexto, poluente: m.chave, valor: m.valor, unidade: m.unidade, medicaoEm: m.dataHora, origem: m.fonte },
        agora
      )
    );
  }
  return resultados;
}

export const LIMITE_ESTACOES_PADRAO = 5;
export const LIMITE_ESTACOES_MAXIMO = 10;
const RAIO_AVALIACAO_M = 25000; // máximo aceito pela OpenAQ

export interface FalhaEstacao {
  estacaoId: string;
  motivo: string;
}

export interface ResumoAvaliacaoCidade {
  cidade: string;
  estacoesAvaliadas: number;
  contagem: Record<AcaoAlerta, number>;
  ignoradosPorMotivo: Partial<Record<MotivoIgnorado, number>>;
  alertas: Alerta[]; // criados ou atualizados nesta avaliação
  resolvidos: Alerta[];
  falhas: FalhaEstacao[];
}

// Reaproveita a infraestrutura existente (busca de estações e consolidador, ambos com cache): nenhuma integração
// nova nem chamada extra. Falha numa estação não interrompe as demais; falha na busca de estações propaga.
export async function avaliarCidade(cidade: string, limite = LIMITE_ESTACOES_PADRAO, agora = new Date()): Promise<ResumoAvaliacaoCidade> {
  if (!temChave(COORDENADAS_CIDADES, cidade)) throw new Error('Cidade inválida');

  const estacoes = await buscarEstacoes({ ...COORDENADAS_CIDADES[cidade], raioMetros: RAIO_AVALIACAO_M, limite });

  const resumo: ResumoAvaliacaoCidade = {
    cidade,
    estacoesAvaliadas: 0,
    contagem: { criado: 0, atualizado: 0, resolvido: 0, sem_alerta: 0, ignorado: 0 },
    ignoradosPorMotivo: {},
    alertas: [],
    resolvidos: [],
    falhas: [],
  };

  for (const estacao of estacoes) {
    try {
      const consolidado = await obterUltimasMedicoes(estacao.id);
      const resultados = await avaliarMedicoesDaEstacao({ cidade, estacaoId: estacao.id, estacaoNome: estacao.nome }, consolidado.medicoes, agora);
      resumo.estacoesAvaliadas++;

      for (const r of resultados) {
        resumo.contagem[r.acao]++;
        if (r.acao === 'ignorado' && r.motivo) resumo.ignoradosPorMotivo[r.motivo] = (resumo.ignoradosPorMotivo[r.motivo] ?? 0) + 1;
        if ((r.acao === 'criado' || r.acao === 'atualizado') && r.alerta) resumo.alertas.push(r.alerta);
        if (r.acao === 'resolvido' && r.alerta) resumo.resolvidos.push(r.alerta);
        if (r.substituido) resumo.resolvidos.push(r.substituido);
      }
    } catch (error) {
      const motivo = error instanceof OpenAQError ? error.kind : 'erro_inesperado';
      console.warn(`[Alertas] estação ${estacao.id} não avaliada (${motivo})`);
      resumo.falhas.push({ estacaoId: String(estacao.id), motivo });
    }
  }

  return resumo;
}

// ---------------------------------------------------------------- Consulta
export interface FiltroAlertas {
  cidade?: string;
  status?: StatusAlerta;
  nivel?: NivelAlerta;
  poluente?: string;
  limite: number;
  pagina: number;
}

// Todas as condições usam parâmetros ($n): nenhum valor do usuário entra concatenado no SQL
export async function listarAlertas(filtro: FiltroAlertas): Promise<{ total: number; alertas: Alerta[] }> {
  const condicoes: string[] = [];
  const valores: unknown[] = [];
  const adicionar = (coluna: string, valor: unknown) => {
    valores.push(valor);
    condicoes.push(`${coluna} = $${valores.length}`);
  };

  if (filtro.cidade !== undefined) adicionar('cidade', filtro.cidade);
  if (filtro.status !== undefined) adicionar('status', filtro.status);
  if (filtro.nivel !== undefined) adicionar('nivel', filtro.nivel);
  if (filtro.poluente !== undefined) adicionar('poluente', filtro.poluente);

  const where = condicoes.length > 0 ? `WHERE ${condicoes.join(' AND ')}` : '';

  const total = await pool.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM alertas ${where}`, valores);
  const lista = await pool.query<AlertaRow>(
    `SELECT ${COLUNAS} FROM alertas ${where}
     ORDER BY (status = 'ATIVO') DESC, medicao_em DESC, id DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, (filtro.pagina - 1) * filtro.limite]
  );

  return { total: total.rows[0].total, alertas: lista.rows.map(mapAlerta) };
}

export async function obterAlerta(id: number): Promise<Alerta | null> {
  const resultado = await pool.query<AlertaRow>(`SELECT ${COLUNAS} FROM alertas WHERE id = $1`, [id]);
  return resultado.rows[0] ? mapAlerta(resultado.rows[0]) : null;
}
