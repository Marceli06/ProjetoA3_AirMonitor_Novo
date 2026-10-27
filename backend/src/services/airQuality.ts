import * as openaq from '../integrations/openaq/client';
import { OpenAQError } from '../integrations/openaq/client';
import * as openmeteo from '../integrations/openmeteo/client';
import { Estacao, UltimasMedicoes, mapEstacao, mapUltimasMedicoes } from '../integrations/openaq/mapper';
import { mapOpenMeteo } from '../integrations/openmeteo/mapper';
import { comCache } from './cache';
import { ResultadoOpenMeteo, UltimasMedicoesConsolidadas, consolidar, consolidarSemOpenAQ, precisaDeFallback } from './consolidador';

const TTL_ESTACOES_MS = 10 * 60 * 1000;
const TTL_ULTIMAS_MS = 2 * 60 * 1000;
// A Open-Meteo entrega o valor "atual" de um modelo (CAMS Global: grade ~45 km, passo de 3 h, interpolado a cada 1 h).
// O dado muda no máximo de hora em hora e vale para toda a célula da grade, então 30 min poupa chamadas
// sem deixar o valor mais de meia hora atrás do que a API entregaria.
const TTL_OPEN_METEO_MS = 30 * 60 * 1000;
// A OpenAQ não ordena por distância: busca-se o máximo e ordena-se aqui
const LIMITE_BUSCA_OPENAQ = 100;

export interface BuscaEstacoes {
  latitude: number;
  longitude: number;
  raioMetros: number;
  limite: number;
}

// Só falhas TEMPORÁRIAS da OpenAQ permitem a Open-Meteo assumir tudo. Estação inexistente, parâmetro inválido,
// chave ausente/recusada (configuração local) e resposta malformada continuam sendo erros.
const FALHAS_TEMPORARIAS = new Set<string>(['timeout', 'unavailable', 'rate_limit']);
const falhaTemporaria = (error: unknown): error is OpenAQError => error instanceof OpenAQError && FALHAS_TEMPORARIAS.has(error.kind);

// Estações já vistas (com coordenadas), para a Open-Meteo conseguir assumir mesmo com o cache expirado
// e a OpenAQ fora do ar. Coordenada de estação não muda, então não há TTL.
const MAX_ESTACOES_CONHECIDAS = 1000;
const estacoesConhecidas = new Map<number, Estacao>();

const lembrarEstacao = (estacao: Estacao) => {
  if (estacoesConhecidas.size >= MAX_ESTACOES_CONHECIDAS && !estacoesConhecidas.has(estacao.id)) {
    const maisAntiga = estacoesConhecidas.keys().next().value;
    if (maisAntiga !== undefined) estacoesConhecidas.delete(maisAntiga);
  }
  estacoesConhecidas.set(estacao.id, estacao);
};

const buscarLocalizacao = async (id: number) => {
  const localizacao = await comCache(`localizacao:${id}`, TTL_ESTACOES_MS, () => openaq.getLocation(id));
  lembrarEstacao(mapEstacao(localizacao));
  return localizacao;
};

// Estações próximas que medem pelo menos um dos poluentes tratados, da mais perto para a mais longe
export async function buscarEstacoes({ latitude, longitude, raioMetros, limite }: BuscaEstacoes): Promise<Estacao[]> {
  const chave = `busca:${latitude.toFixed(4)}:${longitude.toFixed(4)}:${raioMetros}`;
  const brutas = await comCache(chave, TTL_ESTACOES_MS, () =>
    openaq.searchLocations({ latitude, longitude, radius: raioMetros, limit: LIMITE_BUSCA_OPENAQ })
  );

  const estacoes = brutas.map(mapEstacao).filter((estacao) => estacao.poluentes.length > 0);
  estacoes.forEach(lembrarEstacao);

  return estacoes
    .sort((a, b) => (a.distanciaMetros ?? Infinity) - (b.distanciaMetros ?? Infinity))
    .slice(0, limite);
}

export async function obterEstacao(id: number): Promise<Estacao> {
  return mapEstacao(await buscarLocalizacao(id));
}

// Somente OpenAQ (fonte principal). Erros da OpenAQ continuam propagando como OpenAQError.
export async function obterUltimasMedicoesOpenAQ(id: number): Promise<UltimasMedicoes> {
  const [localizacao, ultimas] = await Promise.allSettled([
    buscarLocalizacao(id),
    comCache(`ultimas:${id}`, TTL_ULTIMAS_MS, () => openaq.getLocationLatest(id)),
  ]);

  if (localizacao.status === 'fulfilled' && ultimas.status === 'fulfilled') {
    return mapUltimasMedicoes(localizacao.value, ultimas.value);
  }

  // Havendo erro "definitivo" (estação inexistente, chave inválida...) ele prevalece sobre uma falha temporária
  const erros = [localizacao, ultimas].filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
  throw erros.find((erro) => !falhaTemporaria(erro)) ?? erros[0];
}

// Consulta a Open-Meteo na coordenada da estação. NUNCA lança: qualquer falha vira status 'falha',
// para que a OpenAQ continue sendo entregue.
export async function consultarOpenMeteo(latitude: number | null, longitude: number | null): Promise<ResultadoOpenMeteo> {
  if (latitude === null || longitude === null) return { status: 'sem_coordenadas' };

  // 2 casas decimais (~1 km) já são mais finas que a grade do modelo: estações da mesma célula compartilham o cache
  const lat = Number(latitude.toFixed(2));
  const lon = Number(longitude.toFixed(2));

  try {
    const bruta = await comCache(`openmeteo:${lat}:${lon}`, TTL_OPEN_METEO_MS, () => openmeteo.getCurrentAirQuality(lat, lon));
    return { status: 'ok', dados: mapOpenMeteo(bruta) };
  } catch (error) {
    const detalhe =
      error instanceof openmeteo.OpenMeteoError ? `${error.kind} status=${error.status ?? '-'}: ${error.message}` : 'erro inesperado';
    console.warn(`[OpenMeteo] ${detalhe}`);
    return { status: 'falha' };
  }
}

// OpenAQ como fonte principal; Open-Meteo só entra (poluente a poluente) quando algo está ausente ou desatualizado
// Se a OpenAQ inteira estiver temporariamente fora (timeout, rate limit, 5xx), a Open-Meteo assume na coordenada
// da estação já conhecida. Sem estação conhecida, ou sem nenhum valor da Open-Meteo, vale o erro original da OpenAQ.
export async function obterUltimasMedicoes(id: number): Promise<UltimasMedicoesConsolidadas> {
  let doOpenAQ: UltimasMedicoes;
  try {
    doOpenAQ = await obterUltimasMedicoesOpenAQ(id);
  } catch (error) {
    const estacao = estacoesConhecidas.get(id);
    if (!falhaTemporaria(error) || !estacao) throw error;

    console.warn(`[AirQuality] OpenAQ indisponível (${error.kind}) para a estação ${id}: tentando a Open-Meteo`);
    const openMeteo = await consultarOpenMeteo(estacao.latitude, estacao.longitude);
    const consolidado = consolidarSemOpenAQ(estacao, error.kind, openMeteo);
    if (consolidado.fontesUtilizadas.length === 0) throw error;
    return consolidado;
  }

  const openMeteo: ResultadoOpenMeteo = precisaDeFallback(doOpenAQ)
    ? await consultarOpenMeteo(doOpenAQ.estacao.latitude, doOpenAQ.estacao.longitude)
    : { status: 'nao_necessaria' };

  return consolidar(doOpenAQ, openMeteo);
}
