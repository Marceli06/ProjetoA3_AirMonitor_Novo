import { OpenMeteoAirQualityResponse } from './types';

// Tipos de falha da Open-Meteo. Ficam separados dos da OpenAQ: aqui nenhum erro derruba a rota,
// o serviço apenas deixa de usar a fonte complementar.
export type OpenMeteoErrorKind = 'timeout' | 'unavailable' | 'rate_limit' | 'bad_request' | 'invalid_response';

export class OpenMeteoError extends Error {
  constructor(
    public kind: OpenMeteoErrorKind,
    message: string,
    public status?: number
  ) {
    super(message);
    this.name = 'OpenMeteoError';
  }
}

const DEFAULT_BASE_URL = 'https://air-quality-api.open-meteo.com/v1';
// Menor que o da OpenAQ: é fonte complementar e não deve segurar a resposta por muito tempo
const DEFAULT_TIMEOUT_MS = 5000;

// Variáveis da API para PM2.5, PM10, O3, NO2, CO e SO2 (todas em µg/m³ segundo a documentação)
const VARIAVEIS = ['pm2_5', 'pm10', 'ozone', 'nitrogen_dioxide', 'carbon_monoxide', 'sulphur_dioxide'];

// Lidos a cada chamada para respeitar o .env carregado depois dos imports
const baseUrl = () => (process.env.OPEN_METEO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

const timeoutMs = () => {
  const valor = Number(process.env.OPEN_METEO_TIMEOUT_MS);
  return Number.isFinite(valor) && valor > 0 ? valor : DEFAULT_TIMEOUT_MS;
};

const ehTimeout = (error: any) => error?.name === 'TimeoutError' || error?.name === 'AbortError';

// Qualidade do ar "atual" (modelo CAMS) na célula da grade que contém a coordenada. Não exige chave.
// `domains` e `variaveis` são opcionais (padrão: domínio auto e os 6 poluentes) e existem para diagnóstico/validação.
export async function getCurrentAirQuality(
  latitude: number,
  longitude: number,
  opcoes: { domains?: string; variaveis?: string[] } = {}
): Promise<OpenMeteoAirQualityResponse> {
  const url = new URL(`${baseUrl()}/air-quality`);
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set('current', (opcoes.variaveis ?? VARIAVEIS).join(','));
  url.searchParams.set('timezone', 'GMT');
  if (opcoes.domains) url.searchParams.set('domains', opcoes.domains);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (error: any) {
    if (ehTimeout(error)) throw new OpenMeteoError('timeout', 'A Open-Meteo não respondeu a tempo');
    throw new OpenMeteoError('unavailable', 'Falha de rede ao consultar a Open-Meteo');
  }

  const { status } = response;
  if (status === 429) throw new OpenMeteoError('rate_limit', 'Limite de requisições da Open-Meteo atingido', status);
  if (status === 400) throw new OpenMeteoError('bad_request', 'Parâmetros recusados pela Open-Meteo', status);
  if (!response.ok) throw new OpenMeteoError('unavailable', `Open-Meteo respondeu com status ${status}`, status);

  let corpo: any;
  try {
    corpo = await response.json();
  } catch (error: any) {
    if (ehTimeout(error)) throw new OpenMeteoError('timeout', 'A Open-Meteo não respondeu a tempo');
    throw new OpenMeteoError('invalid_response', 'Resposta da Open-Meteo não é um JSON válido', status);
  }

  if (!corpo || typeof corpo !== 'object' || !corpo.current || typeof corpo.current.time !== 'string') {
    throw new OpenMeteoError('invalid_response', 'Resposta da Open-Meteo em formato inesperado', status);
  }

  return corpo as OpenMeteoAirQualityResponse;
}
