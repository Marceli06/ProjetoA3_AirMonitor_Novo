import { COORDENADAS_CIDADES } from '../data/cidadesCoordenadas';
import * as openaq from '../integrations/openaq/client';
import { OpenAQError } from '../integrations/openaq/client';
import * as openmeteo from '../integrations/openmeteo/client';
import { POLUENTES, mapHoras } from '../integrations/openaq/mapper';
import { VARIAVEL_POR_POLUENTE, mapHorarioOpenMeteo } from '../integrations/openmeteo/mapper';
import { buscarEstacoes } from './airQuality';
import { comCache } from './cache';
import { ATRIBUICAO_OPEN_METEO } from './consolidador';

// Histórico de qualidade do ar. Reaproveita as integrações e o cache já existentes:
//   OpenAQ (principal): médias horárias do sensor da estação (GET /sensors/{id}/hours)
//   Open-Meteo (complementar): série horária do modelo CAMS na coordenada da cidade
// Nada é interpolado nem preenchido: hora sem valor válido simplesmente não aparece na série.

export type PeriodoHistorico = '24H' | '7D' | '30D';
export const PERIODOS_HISTORICO: Record<PeriodoHistorico, { horas: number; rotulo: string }> = {
  '24H': { horas: 24, rotulo: 'Últimas 24 horas' },
  '7D': { horas: 7 * 24, rotulo: 'Últimos 7 dias' },
  '30D': { horas: 30 * 24, rotulo: 'Últimos 30 dias' },
};

// AUTO: estação mais próxima com dados no período; sem nenhuma, cai para o modelo. As demais fixam a fonte.
export type FonteHistorico = 'AUTO' | 'OPENAQ' | 'OPEN_METEO';
export const FONTES_HISTORICO: readonly FonteHistorico[] = ['AUTO', 'OPENAQ', 'OPEN_METEO'];

export type Origem = 'OPENAQ' | 'OPEN_METEO';
export type TipoDado = 'MEDICAO' | 'MODELO';

export interface PontoHistorico {
  dataHora: string; // ISO 8601 em UTC. OpenAQ: fim da hora a que a média se refere; Open-Meteo: instante do modelo
  valor: number;
  unidade: string;
  poluente: string; // chave (pm25, pm10, o3, no2, co, so2)
  poluenteNome: string;
  estacaoId: number | null; // null nos pontos do modelo
  estacaoNome: string | null;
  origem: Origem;
  tipoDado: TipoDado; // MEDICAO (estação) ou MODELO (estimativa, não é medição local)
}

export interface EstacaoHistorico {
  id: number;
  nome: string | null;
  localidade: string | null;
  distanciaMetros: number | null;
  ultimaMedicaoEm: string | null;
  comDadosNoPeriodo: boolean;
  sensorId: number;
  unidade: string;
}

export type StatusFonteHistorico = 'ok' | 'sem_dado' | 'falha' | 'nao_consultada';

export interface ResumoHistorico {
  minimo: number;
  maximo: number;
  media: number;
  ultimo: { valor: number; dataHora: string };
}

export interface RespostaHistorico {
  cidade: string;
  poluente: { chave: string; nome: string; unidade: string | null };
  periodo: { codigo: PeriodoHistorico; rotulo: string; de: string; ate: string };
  fonteSolicitada: FonteHistorico;
  total: number;
  pontos: PontoHistorico[];
  resumo: ResumoHistorico | null;
  estacao: { id: number; nome: string | null; localidade: string | null; distanciaMetros: number | null } | null;
  estacoes: Omit<EstacaoHistorico, 'sensorId' | 'unidade'>[];
  fontesUtilizadas: Origem[];
  statusFontes: { OPENAQ: StatusFonteHistorico; OPEN_METEO: StatusFonteHistorico | 'nao_necessaria' };
  atribuicoes: string[];
  aviso: string | null;
  mensagem: string | null;
}

export class HistoricoErro extends Error {
  constructor(
    public status: number,
    public codigo: string,
    message: string
  ) {
    super(message);
    this.name = 'HistoricoErro';
  }
}

export const TTL_HISTORICO_OPENAQ_MS = 10 * 60 * 1000;
export const TTL_HISTORICO_OPEN_METEO_MS = 30 * 60 * 1000;
const RAIO_ESTACOES_M = 25000; // máximo aceito pela OpenAQ (o mesmo da avaliação de alertas)
const LIMITE_ESTACOES = 100;
const MAX_ESTACOES_NA_RESPOSTA = 50;
// A OpenAQ limita 60 requisições por minuto: no modo automático, no máximo estas estações são tentadas
const MAX_CANDIDATAS_AUTO = 3;

// Só falhas temporárias permitem trocar de fonte; chave ausente/recusada e resposta malformada continuam sendo erro
const FALHAS_TEMPORARIAS = new Set<string>(['timeout', 'unavailable', 'rate_limit']);
const falhaTemporaria = (error: unknown): error is OpenAQError => error instanceof OpenAQError && FALHAS_TEMPORARIAS.has(error.kind);

export const poluenteDaChave = (chave: string) => POLUENTES.find((p) => p.chave === chave);

const arredondar = (n: number) => Math.round(n * 100) / 100;

export function resumir(pontos: PontoHistorico[]): ResumoHistorico | null {
  if (pontos.length === 0) return null;
  let minimo = Infinity;
  let maximo = -Infinity;
  let soma = 0;
  for (const p of pontos) {
    if (p.valor < minimo) minimo = p.valor;
    if (p.valor > maximo) maximo = p.valor;
    soma += p.valor;
  }
  const ultimo = pontos[pontos.length - 1];
  return { minimo: arredondar(minimo), maximo: arredondar(maximo), media: arredondar(soma / pontos.length), ultimo: { valor: ultimo.valor, dataHora: ultimo.dataHora } };
}

// Estações da cidade (raio máximo da OpenAQ ao redor do centro) que têm sensor do poluente, da mais perto à mais longe
export async function listarEstacoesDoPoluente(cidade: string, chave: string, de: Date): Promise<EstacaoHistorico[]> {
  const centro = COORDENADAS_CIDADES[cidade];
  const estacoes = await buscarEstacoes({ ...centro, raioMetros: RAIO_ESTACOES_M, limite: LIMITE_ESTACOES });
  const lista: EstacaoHistorico[] = [];
  for (const e of estacoes) {
    const sensor = e.poluentes.find((p) => p.chave === chave);
    if (!sensor) continue;
    lista.push({
      id: e.id,
      nome: e.nome,
      localidade: e.localidade,
      distanciaMetros: e.distanciaMetros,
      ultimaMedicaoEm: e.ultimaMedicaoEm,
      comDadosNoPeriodo: e.ultimaMedicaoEm !== null && Date.parse(e.ultimaMedicaoEm) >= de.getTime(),
      sensorId: sensor.sensorId,
      unidade: sensor.unidade,
    });
  }
  return lista;
}

async function pontosDaEstacao(estacao: EstacaoHistorico, chave: string, periodo: PeriodoHistorico, de: Date, ate: Date): Promise<PontoHistorico[]> {
  const nome = poluenteDaChave(chave)!.nome;
  const brutas = await comCache(`historico:openaq:${estacao.sensorId}:${periodo}`, TTL_HISTORICO_OPENAQ_MS, () =>
    openaq.getSensorHours(estacao.sensorId, { from: de.toISOString(), to: ate.toISOString() })
  );
  return mapHoras(brutas)
    .filter((p) => Date.parse(p.dataHora) >= de.getTime() && Date.parse(p.dataHora) <= ate.getTime())
    .map((p) => ({
      dataHora: p.dataHora,
      valor: p.valor,
      unidade: p.unidade,
      poluente: chave,
      poluenteNome: nome,
      estacaoId: estacao.id,
      estacaoNome: estacao.nome,
      origem: 'OPENAQ' as const,
      tipoDado: 'MEDICAO' as const,
    }));
}

type ResultadoModelo = { status: 'ok' | 'sem_dado'; pontos: PontoHistorico[] } | { status: 'falha' };

async function pontosDoModelo(cidade: string, chave: string, de: Date, ate: Date): Promise<ResultadoModelo> {
  const centro = COORDENADAS_CIDADES[cidade];
  // 2 casas decimais (~1 km) já são mais finas que a grade do modelo
  const lat = Number(centro.latitude.toFixed(2));
  const lon = Number(centro.longitude.toFixed(2));
  const inicio = de.toISOString().slice(0, 10);
  const fim = ate.toISOString().slice(0, 10);
  const variavel = VARIAVEL_POR_POLUENTE[chave];
  try {
    const bruta = await comCache(`openmeteo:historico:${lat}:${lon}:${variavel}:${inicio}:${fim}`, TTL_HISTORICO_OPEN_METEO_MS, () =>
      openmeteo.getHourlyAirQuality(lat, lon, variavel, inicio, fim)
    );
    const nome = poluenteDaChave(chave)!.nome;
    // A resposta inclui horas futuras (previsão): só entra o que está dentro do período pedido
    const pontos = mapHorarioOpenMeteo(bruta, variavel)
      .filter((p) => Date.parse(p.dataHora) >= de.getTime() && Date.parse(p.dataHora) <= ate.getTime())
      .map((p): PontoHistorico => ({
        dataHora: p.dataHora,
        valor: p.valor,
        unidade: p.unidade,
        poluente: chave,
        poluenteNome: nome,
        estacaoId: null,
        estacaoNome: null,
        origem: 'OPEN_METEO',
        tipoDado: 'MODELO',
      }));
    return { status: pontos.length > 0 ? 'ok' : 'sem_dado', pontos };
  } catch (error) {
    const detalhe =
      error instanceof openmeteo.OpenMeteoError ? `${error.kind} status=${error.status ?? '-'}: ${error.message}` : 'erro inesperado';
    console.warn(`[OpenMeteo] histórico: ${detalhe}`);
    return { status: 'falha' };
  }
}

export interface ConsultaHistorico {
  cidade: string; // já validada pela rota (existe em COORDENADAS_CIDADES)
  poluente: string; // chave já validada
  periodo: PeriodoHistorico;
  fonte: FonteHistorico;
  estacaoId?: number;
}

export async function consultarHistorico(consulta: ConsultaHistorico, agora = new Date()): Promise<RespostaHistorico> {
  const { cidade, poluente: chave, periodo, fonte, estacaoId } = consulta;
  const ate = agora;
  const de = new Date(agora.getTime() - PERIODOS_HISTORICO[periodo].horas * 60 * 60 * 1000);
  const nomePoluente = poluenteDaChave(chave)!.nome;

  let estacoes: EstacaoHistorico[] = [];
  let pontos: PontoHistorico[] = [];
  let estacaoUsada: EstacaoHistorico | null = null;
  let statusOpenAQ: StatusFonteHistorico = 'nao_consultada';
  let statusModelo: StatusFonteHistorico | 'nao_necessaria' = fonte === 'OPENAQ' ? 'nao_consultada' : 'nao_necessaria';
  let erroOpenAQ: OpenAQError | null = null;
  let aviso: string | null = null;
  let mensagem: string | null = null;

  if (fonte !== 'OPEN_METEO') {
    try {
      estacoes = await listarEstacoesDoPoluente(cidade, chave, de);
      statusOpenAQ = 'sem_dado';

      let candidatas: EstacaoHistorico[];
      if (estacaoId !== undefined) {
        const escolhida = estacoes.find((e) => e.id === estacaoId);
        if (!escolhida) throw new HistoricoErro(404, 'ESTACAO_NAO_ENCONTRADA', 'Estação não encontrada para esta cidade e poluente');
        candidatas = [escolhida];
      } else {
        candidatas = estacoes.filter((e) => e.comDadosNoPeriodo).slice(0, MAX_CANDIDATAS_AUTO);
      }

      for (const candidata of candidatas) {
        try {
          const doperiodo = await pontosDaEstacao(candidata, chave, periodo, de, ate);
          if (doperiodo.length > 0) {
            pontos = doperiodo;
            estacaoUsada = candidata;
            statusOpenAQ = 'ok';
            break;
          }
        } catch (error) {
          if (error instanceof OpenAQError && error.kind === 'not_found') continue; // sensor sem registro: tenta a próxima
          throw error;
        }
      }
    } catch (error) {
      if (!falhaTemporaria(error)) throw error;
      console.warn(`[Historico] OpenAQ indisponível (${error.kind}) para ${cidade}`);
      erroOpenAQ = error;
      statusOpenAQ = 'falha';
    }
  }

  // Estação escolhida de propósito não é trocada pelo modelo em silêncio: sem dados, o resultado é vazio
  const precisaDoModelo = fonte === 'OPEN_METEO' || (fonte === 'AUTO' && estacaoId === undefined && pontos.length === 0);
  if (precisaDoModelo) {
    const modelo = await pontosDoModelo(cidade, chave, de, ate);
    statusModelo = modelo.status;
    if (modelo.status === 'falha') {
      if (erroOpenAQ) throw erroOpenAQ;
      throw new HistoricoErro(502, 'OPEN_METEO_INDISPONIVEL', 'A Open-Meteo está indisponível no momento');
    }
    if (modelo.pontos.length > 0) {
      pontos = modelo.pontos;
      if (fonte === 'AUTO') {
        aviso =
          statusOpenAQ === 'falha'
            ? 'A OpenAQ está indisponível no momento: exibindo a estimativa do modelo CAMS (Open-Meteo), que não é medição local.'
            : 'Nenhuma estação com medições neste período: exibindo a estimativa do modelo CAMS (Open-Meteo), que não é medição local.';
      }
    }
  } else if (erroOpenAQ && pontos.length === 0) {
    throw erroOpenAQ;
  }

  pontos.sort((a, b) => Date.parse(a.dataHora) - Date.parse(b.dataHora));

  if (pontos.length === 0) {
    const nomeEstacao = estacaoId !== undefined ? estacoes.find((e) => e.id === estacaoId)?.nome ?? `estação ${estacaoId}` : null;
    mensagem = nomeEstacao
      ? `A estação ${nomeEstacao} não tem medições de ${nomePoluente} no período selecionado.`
      : `Não há dados históricos de ${nomePoluente} para ${cidade} no período selecionado.`;
  }

  const fontesUtilizadas = (['OPENAQ', 'OPEN_METEO'] as Origem[]).filter((o) => pontos.some((p) => p.origem === o));

  return {
    cidade,
    poluente: { chave, nome: nomePoluente, unidade: pontos[0]?.unidade ?? null },
    periodo: { codigo: periodo, rotulo: PERIODOS_HISTORICO[periodo].rotulo, de: de.toISOString(), ate: ate.toISOString() },
    fonteSolicitada: fonte,
    total: pontos.length,
    pontos,
    resumo: resumir(pontos),
    estacao: estacaoUsada
      ? { id: estacaoUsada.id, nome: estacaoUsada.nome, localidade: estacaoUsada.localidade, distanciaMetros: estacaoUsada.distanciaMetros }
      : null,
    estacoes: estacoes.slice(0, MAX_ESTACOES_NA_RESPOSTA).map(({ sensorId, unidade, ...resto }) => resto),
    fontesUtilizadas,
    statusFontes: { OPENAQ: statusOpenAQ, OPEN_METEO: statusModelo },
    atribuicoes: fontesUtilizadas.includes('OPEN_METEO') ? [ATRIBUICAO_OPEN_METEO] : [],
    aviso,
    mensagem,
  };
}
