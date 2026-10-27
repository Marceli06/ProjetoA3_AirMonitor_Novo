import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middlewares';
import { OpenAQError } from '../integrations/openaq/client';
import { buscarEstacoes, obterEstacao } from '../services/airQuality';
import { COORDENADAS_CIDADES } from '../data/cidadesCoordenadas';

const router = Router();

const RAIO_PADRAO_M = 10000;
const RAIO_MAXIMO_M = 25000; // limite da OpenAQ
const LIMITE_PADRAO = 20;
const LIMITE_MAXIMO = 100;

// Qualquer usuário autenticado e ativo pode consultar; a chave da OpenAQ nunca sai do backend
router.use(authMiddleware);

// Traduz a falha da integração no HTTP do AirMonitor, sem repassar o corpo bruto da OpenAQ.
// Um 401 da OpenAQ vira 502: é problema de configuração do servidor, não do login do usuário.
const responderErro = (res: Response, error: unknown) => {
  if (!(error instanceof OpenAQError)) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao consultar a qualidade do ar' });
  }

  console.warn(`[OpenAQ] ${error.kind} status=${error.status ?? '-'}: ${error.message}`);

  switch (error.kind) {
    case 'config':
      return res.status(503).json({ error: 'Integração com a OpenAQ não configurada', codigo: 'OPENAQ_NAO_CONFIGURADA' });
    case 'auth':
      return res.status(502).json({ error: 'A chave de acesso à OpenAQ está inválida ou foi revogada', codigo: 'OPENAQ_CHAVE_INVALIDA' });
    case 'rate_limit':
      if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(429).json({ error: 'Limite de consultas à OpenAQ atingido. Tente novamente em instantes', codigo: 'OPENAQ_LIMITE_REQUISICOES' });
    case 'not_found':
      return res.status(404).json({ error: 'Estação não encontrada', codigo: 'ESTACAO_NAO_ENCONTRADA' });
    case 'timeout':
      return res.status(504).json({ error: 'A OpenAQ demorou demais para responder', codigo: 'OPENAQ_TIMEOUT' });
    case 'invalid_response':
      return res.status(502).json({ error: 'A OpenAQ retornou uma resposta inválida', codigo: 'OPENAQ_RESPOSTA_INVALIDA' });
    default:
      return res.status(502).json({ error: 'A OpenAQ está indisponível no momento', codigo: 'OPENAQ_INDISPONIVEL' });
  }
};

const lerNumero = (valor: unknown) => (typeof valor === 'string' && valor.trim() !== '' ? Number(valor) : NaN);

const lerId = (req: Request) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// GET /api/air-quality/locations?cidade=São Paulo   (ou ?lat=-23.55&lon=-46.63)
//   opcionais: raio (metros, padrão 10000, máx. 25000) e limite (padrão 20, máx. 100)
router.get('/locations', async (req: Request, res: Response) => {
  const { cidade, lat, lon, raio, limite } = req.query;

  let latitude: number;
  let longitude: number;

  if (cidade !== undefined && (lat !== undefined || lon !== undefined)) {
    return res.status(400).json({ error: 'Informe "cidade" ou "lat" e "lon", não ambos' });
  }

  if (cidade !== undefined) {
    const centro = typeof cidade === 'string' && Object.prototype.hasOwnProperty.call(COORDENADAS_CIDADES, cidade)
      ? COORDENADAS_CIDADES[cidade]
      : null;
    if (!centro) return res.status(400).json({ error: 'Cidade inválida' });
    ({ latitude, longitude } = centro);
  } else {
    latitude = lerNumero(lat);
    longitude = lerNumero(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return res.status(400).json({ error: 'Informe "cidade" ou "lat" e "lon" válidos' });
    }
  }

  const raioMetros = raio === undefined ? RAIO_PADRAO_M : lerNumero(raio);
  if (!Number.isInteger(raioMetros) || raioMetros < 1 || raioMetros > RAIO_MAXIMO_M) {
    return res.status(400).json({ error: `"raio" deve ser um inteiro entre 1 e ${RAIO_MAXIMO_M} (metros)` });
  }

  const limiteEstacoes = limite === undefined ? LIMITE_PADRAO : lerNumero(limite);
  if (!Number.isInteger(limiteEstacoes) || limiteEstacoes < 1 || limiteEstacoes > LIMITE_MAXIMO) {
    return res.status(400).json({ error: `"limite" deve ser um inteiro entre 1 e ${LIMITE_MAXIMO}` });
  }

  try {
    const estacoes = await buscarEstacoes({ latitude, longitude, raioMetros, limite: limiteEstacoes });
    res.json({
      origem: { cidade: typeof cidade === 'string' ? cidade : null, latitude, longitude, raioMetros },
      total: estacoes.length,
      estacoes,
      mensagem: estacoes.length === 0 ? 'Nenhuma estação com os poluentes monitorados foi encontrada neste raio' : null,
      fonte: 'OpenAQ',
    });
  } catch (error) {
    responderErro(res, error);
  }
});

// GET /api/air-quality/locations/:id  — dados da estação e poluentes que ela mede
router.get('/locations/:id', async (req: Request, res: Response) => {
  const id = lerId(req);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  try {
    res.json({ estacao: await obterEstacao(id), fonte: 'OpenAQ' });
  } catch (error) {
    responderErro(res, error);
  }
});

export default router;
