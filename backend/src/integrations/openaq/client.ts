import { OpenAQListResponse, OpenAQLocation, OpenAQLatest, OpenAQMeasurement } from './types';

// Tipos de falha da integração. As rotas traduzem cada um em um HTTP próprio do AirMonitor.
export type OpenAQErrorKind =
  | 'config' // OPENAQ_API_KEY ausente
  | 'auth' // chave recusada pela OpenAQ (401/403)
  | 'rate_limit' // 429
  | 'not_found' // 404
  | 'bad_request' // 422/400
  | 'timeout'
  | 'unavailable' // rede fora do ar, 5xx ou outro status inesperado
  | 'invalid_response'; // 200 com corpo que não é o esperado

export class OpenAQError extends Error {
  constructor(
    public kind: OpenAQErrorKind,
    message: string,
    public status?: number,
    public retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'OpenAQError';
  }
}

const DEFAULT_BASE_URL = 'https://api.openaq.org/v3';
const DEFAULT_TIMEOUT_MS = 8000;

// Lidos a cada chamada (e não na importação) para respeitar o .env carregado depois dos imports
const baseUrl = () => (process.env.OPENAQ_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

const timeoutMs = () => {
  const valor = Number(process.env.OPENAQ_TIMEOUT_MS);
  return Number.isFinite(valor) && valor > 0 ? valor : DEFAULT_TIMEOUT_MS;
};

const ehTimeout = (error: any) => error?.name === 'TimeoutError' || error?.name === 'AbortError';

// x-ratelimit-reset vem em segundos até o fim da janela; ignora valores que não pareçam isso
const lerRetryAfter = (valor: string | null) => {
  const segundos = Number(valor);
  return Number.isFinite(segundos) && segundos >= 1 && segundos <= 3600 ? Math.ceil(segundos) : undefined;
};

type Params = Record<string, string | number | undefined>;

async function request<T>(path: string, params: Params = {}): Promise<OpenAQListResponse<T>> {
  // A chave só existe no backend e só é enviada no header X-API-Key
  const apiKey = process.env.OPENAQ_API_KEY?.trim();
  if (!apiKey) {
    throw new OpenAQError('config', 'OPENAQ_API_KEY não configurada');
  }

  const url = new URL(`${baseUrl()}${path}`);
  for (const [nome, valor] of Object.entries(params)) {
    if (valor !== undefined) url.searchParams.set(nome, String(valor));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (error: any) {
    if (ehTimeout(error)) throw new OpenAQError('timeout', 'A OpenAQ não respondeu a tempo');
    throw new OpenAQError('unavailable', 'Falha de rede ao consultar a OpenAQ');
  }

  const { status } = response;
  if (status === 401 || status === 403) throw new OpenAQError('auth', 'Chave da OpenAQ ausente ou inválida', status);
  if (status === 404) throw new OpenAQError('not_found', 'Recurso não encontrado na OpenAQ', status);
  if (status === 429) {
    throw new OpenAQError(
      'rate_limit',
      'Limite de requisições da OpenAQ atingido',
      status,
      lerRetryAfter(response.headers.get('x-ratelimit-reset'))
    );
  }
  if (status === 400 || status === 422) throw new OpenAQError('bad_request', 'Parâmetros recusados pela OpenAQ', status);
  if (!response.ok) throw new OpenAQError('unavailable', `OpenAQ respondeu com status ${status}`, status);

  let corpo: any;
  try {
    corpo = await response.json();
  } catch (error: any) {
    if (ehTimeout(error)) throw new OpenAQError('timeout', 'A OpenAQ não respondeu a tempo');
    throw new OpenAQError('invalid_response', 'Resposta da OpenAQ não é um JSON válido', status);
  }

  if (!corpo || !Array.isArray(corpo.results)) {
    throw new OpenAQError('invalid_response', 'Resposta da OpenAQ em formato inesperado', status);
  }

  return corpo as OpenAQListResponse<T>;
}

// Estações dentro de um raio (m) ao redor de uma coordenada. A OpenAQ aceita raio máximo de 25000 m
export async function searchLocations(params: { latitude: number; longitude: number; radius: number; limit: number }) {
  const resposta = await request<OpenAQLocation>('/locations', {
    coordinates: `${params.latitude.toFixed(4)},${params.longitude.toFixed(4)}`,
    radius: params.radius,
    limit: params.limit,
  });
  return resposta.results;
}

export async function getLocation(id: number) {
  const resposta = await request<OpenAQLocation>(`/locations/${id}`);
  const localizacao = resposta.results[0];
  if (!localizacao) throw new OpenAQError('not_found', 'Localização não encontrada na OpenAQ', 404);
  return localizacao;
}

// Últimos valores por sensor da localização (identifica o sensor só pelo id: cruzar com getLocation)
export async function getLocationLatest(id: number) {
  const resposta = await request<OpenAQLatest>(`/locations/${id}/latest`, { limit: 100 });
  return resposta.results;
}

// Preparado para a etapa de histórico: medições de um sensor em um intervalo (ainda sem rota)
export async function getSensorMeasurements(
  sensorId: number,
  params: { from: string; to: string; limit?: number; page?: number }
) {
  const resposta = await request<OpenAQMeasurement>(`/sensors/${sensorId}/measurements`, {
    datetime_from: params.from,
    datetime_to: params.to,
    limit: params.limit ?? 100,
    page: params.page,
  });
  return resposta.results;
}
