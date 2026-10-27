import * as openaq from '../integrations/openaq/client';
import { OpenAQError } from '../integrations/openaq/client';
import { Estacao, UltimasMedicoes, mapEstacao, mapUltimasMedicoes } from '../integrations/openaq/mapper';
import { comCache } from './cache';

const TTL_ESTACOES_MS = 10 * 60 * 1000;
const TTL_ULTIMAS_MS = 2 * 60 * 1000;
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

const buscarLocalizacao = async (id: number) => {
  const localizacao = await comCache(`localizacao:${id}`, TTL_ESTACOES_MS, () => openaq.getLocation(id));
  return localizacao;
};

// Estações próximas que medem pelo menos um dos poluentes tratados, da mais perto para a mais longe
export async function buscarEstacoes({ latitude, longitude, raioMetros, limite }: BuscaEstacoes): Promise<Estacao[]> {
  const chave = `busca:${latitude.toFixed(4)}:${longitude.toFixed(4)}:${raioMetros}`;
  const brutas = await comCache(chave, TTL_ESTACOES_MS, () =>
    openaq.searchLocations({ latitude, longitude, radius: raioMetros, limit: LIMITE_BUSCA_OPENAQ })
  );

  const estacoes = brutas.map(mapEstacao).filter((estacao) => estacao.poluentes.length > 0);

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
