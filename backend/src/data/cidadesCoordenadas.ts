// Coordenadas APROXIMADAS do centro de cada município de data/cidades.ts.
// Servem apenas como ponto de partida para buscar estações da OpenAQ num raio ao redor da cidade.
export const COORDENADAS_CIDADES: Record<string, { latitude: number; longitude: number }> = {
  'São Paulo': { latitude: -23.5505, longitude: -46.6333 },
  'Guarulhos': { latitude: -23.4543, longitude: -46.5333 },
  'Campinas': { latitude: -22.9099, longitude: -47.0626 },
  'São Bernardo do Campo': { latitude: -23.6914, longitude: -46.5646 },
  'Ribeirão Preto': { latitude: -21.1775, longitude: -47.8103 },
  'Sorocaba': { latitude: -23.5015, longitude: -47.4526 },
  'São José dos Campos': { latitude: -23.2237, longitude: -45.9009 },
  'Santo André': { latitude: -23.6737, longitude: -46.5432 },
  'Osasco': { latitude: -23.5329, longitude: -46.7918 },
  'Mauá': { latitude: -23.6677, longitude: -46.4613 },
};
