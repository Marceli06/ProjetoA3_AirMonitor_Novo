import { Router, Request, Response } from 'express';
import pool from '../database';
import { authMiddleware } from '../middlewares';
import { CIDADES } from '../data/cidades';
import { COORDENADAS_CIDADES } from '../data/cidadesCoordenadas';
import { OpenAQError } from '../integrations/openaq/client';
import {
  FONTES_HISTORICO,
  FonteHistorico,
  HistoricoErro,
  PERIODOS_HISTORICO,
  PeriodoHistorico,
  consultarHistorico,
  poluenteDaChave,
} from '../services/historico';
import { POLUENTES } from '../integrations/openaq/mapper';
import { responderErro } from './airQuality';

const router = Router();

const ID_MAXIMO = 2147483647; // limite do INTEGER usado nos IDs de estação

// Todas as rotas exigem token válido. O perfil e a cidade vêm do banco, nunca do token ou da requisição.
router.use(authMiddleware);

// Parâmetro de query que, se presente, precisa ser UM texto não vazio (nada de ?a=1&a=2)
const lerTexto = (valor: unknown): string | undefined | null => {
  if (valor === undefined) return undefined;
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : null;
};

const cidadeSuportada = (cidade: string) =>
  Object.prototype.hasOwnProperty.call(CIDADES, cidade) && Object.prototype.hasOwnProperty.call(COORDENADAS_CIDADES, cidade);

const cidadeDoUsuario = async (userId: number): Promise<string | null> => {
  const resultado = await pool.query<{ cidade: string | null }>('SELECT cidade FROM usuarios WHERE id = $1', [userId]);
  const cidade = resultado.rows[0]?.cidade;
  return cidade && cidade.trim() !== '' ? cidade : null;
};

const ehAdmin = (req: Request) => req.user?.perfil === 'ADMIN';

// GET /api/historico?cidade=&poluente=&periodo=&estacaoId=&fonte=
//   cidade   ADMIN: obrigatória (qualquer cidade suportada). USUARIO: só a própria (omitida = a própria; outra = 403)
//   poluente pm25 | pm10 | o3 | no2 | co | so2 (obrigatório)
//   periodo  24H | 7D | 30D (padrão 24H)
//   estacaoId  opcional: estação da cidade (ver "estacoes" na resposta); só vale com fonte AUTO ou OPENAQ
//   fonte    AUTO (padrão: estação mais próxima com dados, senão o modelo) | OPENAQ (só estação) | OPEN_METEO (só modelo)
// Devolve a série temporal em ordem cronológica, cada ponto com valor, unidade, poluente, estação e origem do dado.
router.get('/', async (req: Request, res: Response) => {
  const cidadeTexto = lerTexto(req.query.cidade);
  const poluenteTexto = lerTexto(req.query.poluente);
  const periodoTexto = lerTexto(req.query.periodo);
  const estacaoTexto = lerTexto(req.query.estacaoId);
  const fonteTexto = lerTexto(req.query.fonte);

  if (cidadeTexto === null || (cidadeTexto !== undefined && !cidadeSuportada(cidadeTexto))) return res.status(400).json({ error: 'Cidade inválida' });

  const chavePoluente = poluenteTexto?.toLowerCase();
  if (poluenteTexto === undefined) return res.status(400).json({ error: `Informe o "poluente" (${POLUENTES.map((p) => p.chave).join(', ')})` });
  if (chavePoluente === undefined || !poluenteDaChave(chavePoluente)) {
    return res.status(400).json({ error: `"poluente" deve ser um de: ${POLUENTES.map((p) => p.chave).join(', ')}` });
  }

  const periodo = (periodoTexto === undefined ? '24H' : periodoTexto?.toUpperCase()) as PeriodoHistorico | undefined;
  if (periodoTexto === null || !periodo || !Object.prototype.hasOwnProperty.call(PERIODOS_HISTORICO, periodo)) {
    return res.status(400).json({ error: `"periodo" deve ser um de: ${Object.keys(PERIODOS_HISTORICO).join(', ')}` });
  }

  const fonte = (fonteTexto === undefined ? 'AUTO' : fonteTexto?.toUpperCase()) as FonteHistorico | undefined;
  if (fonteTexto === null || !fonte || !FONTES_HISTORICO.includes(fonte)) {
    return res.status(400).json({ error: `"fonte" deve ser um de: ${FONTES_HISTORICO.join(', ')}` });
  }

  let estacaoId: number | undefined;
  if (estacaoTexto === null) return res.status(400).json({ error: '"estacaoId" deve ser um inteiro positivo' });
  if (estacaoTexto !== undefined) {
    const n = Number(estacaoTexto);
    if (!/^\d+$/.test(estacaoTexto) || !Number.isInteger(n) || n < 1 || n > ID_MAXIMO) {
      return res.status(400).json({ error: '"estacaoId" deve ser um inteiro positivo' });
    }
    if (fonte === 'OPEN_METEO') return res.status(400).json({ error: '"estacaoId" não se aplica à fonte OPEN_METEO (o modelo não tem estação)' });
    estacaoId = n;
  }

  try {
    let cidade: string;
    if (ehAdmin(req)) {
      if (cidadeTexto === undefined) return res.status(400).json({ error: 'Informe a "cidade"' });
      cidade = cidadeTexto;
    } else {
      const propria = await cidadeDoUsuario(req.user!.userId);
      if (!propria || !cidadeSuportada(propria)) return res.status(403).json({ error: 'Seu usuário não tem cidade cadastrada' });
      if (cidadeTexto !== undefined && cidadeTexto !== propria) {
        return res.status(403).json({ error: 'Você só pode consultar o histórico da sua cidade' });
      }
      cidade = propria;
    }

    res.json(await consultarHistorico({ cidade, poluente: chavePoluente, periodo, fonte, estacaoId }));
  } catch (error) {
    if (error instanceof HistoricoErro) return res.status(error.status).json({ error: error.message, codigo: error.codigo });
    if (error instanceof OpenAQError) return responderErro(res, error);
    console.error(error);
    res.status(500).json({ error: 'Erro ao consultar o histórico' });
  }
});

export default router;
