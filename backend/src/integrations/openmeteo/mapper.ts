import { OpenMeteoAirQualityResponse, OpenMeteoHourlyResponse } from './types';

// Poluente do AirMonitor (mesma `chave` usada com a OpenAQ) -> variável da Open-Meteo
export const VARIAVEL_POR_POLUENTE: Record<string, string> = {
  pm25: 'pm2_5',
  pm10: 'pm10',
  o3: 'ozone',
  no2: 'nitrogen_dioxide',
  co: 'carbon_monoxide',
  so2: 'sulphur_dioxide',
};

export interface ValorOpenMeteo {
  valor: number;
  unidade: string;
  dataHora: string; // ISO 8601 em UTC
}

export interface DadosOpenMeteo {
  latitudeGrade: number | null;
  longitudeGrade: number | null;
  // Só contém poluentes com valor válido: o que a Open-Meteo não devolveu simplesmente não aparece
  valores: Record<string, ValorOpenMeteo>;
}

// A Open-Meteo escreve "μ" (letra grega mu, U+03BC); a OpenAQ usa "µ" (sinal de micro, U+00B5).
// Igualamos para o frontend ver a mesma unidade independente da fonte.
const normalizarUnidade = (unidade: string) => unidade.replace(/\u03bc/g, '\u00b5');

// `current.time` vem sem fuso; como a requisição pede timezone=GMT, o horário é UTC
const lerDataHora = (resposta: OpenMeteoAirQualityResponse) => {
  if (resposta.utc_offset_seconds !== undefined && resposta.utc_offset_seconds !== 0) return null;
  const texto = String(resposta.current.time);
  const instante = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(texto) ? texto : `${texto}Z`);
  return Number.isNaN(instante) ? null : new Date(instante).toISOString();
};

export function mapOpenMeteo(resposta: OpenMeteoAirQualityResponse): DadosOpenMeteo {
  const valores: Record<string, ValorOpenMeteo> = {};
  const dataHora = lerDataHora(resposta);

  if (dataHora) {
    for (const [chave, variavel] of Object.entries(VARIAVEL_POR_POLUENTE)) {
      const valor = resposta.current[variavel];
      const unidade = resposta.current_units?.[variavel];
      // Valor ausente (null), negativo ou sem unidade informada não é usado: nada é presumido
      if (typeof valor === 'number' && Number.isFinite(valor) && valor >= 0 && typeof unidade === 'string' && unidade) {
        valores[chave] = { valor, unidade: normalizarUnidade(unidade), dataHora };
      }
    }
  }

  return {
    latitudeGrade: typeof resposta.latitude === 'number' ? resposta.latitude : null,
    longitudeGrade: typeof resposta.longitude === 'number' ? resposta.longitude : null,
    valores,
  };
}

export interface PontoOpenMeteo {
  dataHora: string; // ISO 8601 em UTC
  valor: number;
  unidade: string;
}

// Série horária de uma variável -> pontos em ordem cronológica. Hora sem valor (null), negativo ou sem unidade
// informada é descartada; `time` vem sem fuso e, como a requisição pede timezone=GMT, é UTC.
export function mapHorarioOpenMeteo(resposta: OpenMeteoHourlyResponse, variavel: string): PontoOpenMeteo[] {
  if (resposta.utc_offset_seconds !== undefined && resposta.utc_offset_seconds !== 0) return [];
  const unidadeBruta = resposta.hourly_units?.[variavel];
  const valores = resposta.hourly[variavel];
  if (typeof unidadeBruta !== 'string' || !unidadeBruta || !Array.isArray(valores)) return [];
  const unidade = normalizarUnidade(unidadeBruta);

  const pontos: PontoOpenMeteo[] = [];
  resposta.hourly.time.forEach((texto, i) => {
    const valor = valores[i];
    if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0) return;
    const instante = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(String(texto)) ? String(texto) : `${texto}Z`);
    if (Number.isNaN(instante)) return;
    pontos.push({ dataHora: new Date(instante).toISOString(), valor, unidade });
  });
  return pontos.sort((a, b) => Date.parse(a.dataHora) - Date.parse(b.dataHora));
}
