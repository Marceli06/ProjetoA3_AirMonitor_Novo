// Formatação e rótulos compartilhados pelo Dashboard e pelas páginas administrativas

export const formatarDataHora = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

export const formatarValor = (valor: number) => valor.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

export const formatarDistancia = (metros: number | null) =>
  metros === null ? null : `${(metros / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`;

export const formatarCoordenada = (valor: number | null) =>
  valor === null ? '—' : valor.toLocaleString('pt-BR', { maximumFractionDigits: 5 });

// Apenas nome/descrição de cada poluente: valores, unidades e fontes vêm do backend (/api/air-quality)
export const POLLUTANTS = [
  { chave: 'pm25', name: 'PM2.5', desc: 'Material particulado fino' },
  { chave: 'pm10', name: 'PM10', desc: 'Material particulado' },
  { chave: 'o3', name: 'O₃', desc: 'Ozônio' },
  { chave: 'no2', name: 'NO₂', desc: 'Dióxido de nitrogênio' },
  { chave: 'co', name: 'CO', desc: 'Monóxido de carbono' },
  { chave: 'so2', name: 'SO₂', desc: 'Dióxido de enxofre' },
];

export const ROTULO_FONTE = { OPENAQ: 'Medição de estação', OPEN_METEO: 'Estimativa por modelo' } as const;

export const NOME_FONTE = { OPENAQ: 'OpenAQ', OPEN_METEO: 'Open-Meteo' } as const;
