import { Router, Request, Response } from 'express';
import pool from '../database';
import { authMiddleware, requireAdmin } from '../middlewares';
import { CIDADES } from '../data/cidades';
import { LIMIARES, LIMIARES_PROVISORIOS } from '../data/limiaresAlertas';
import {
  LIMITE_ESTACOES_MAXIMO,
  LIMITE_ESTACOES_PADRAO,
  NIVEIS_ALERTA,
  NivelAlerta,
  STATUS_ALERTA,
  StatusAlerta,
  avaliarCidade,
  listarAlertas,
  normalizarPoluente,
  obterAlerta,
  resolverAlerta,
} from '../services/alertas';
import { responderErro } from './airQuality';

const router = Router();

const LIMITE_PADRAO = 50;
const LIMITE_MAXIMO = 200;
const ID_MAXIMO = 2147483647; // limite do INTEGER do PostgreSQL (acima disso a consulta falharia com 500)

// Todas as rotas exigem token válido. O perfil e a cidade vêm do banco, nunca do token ou da requisição.
router.use(authMiddleware);

const cidadeSuportada = (cidade: string) => Object.prototype.hasOwnProperty.call(CIDADES, cidade);

const lerId = (req: Request) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 && id <= ID_MAXIMO ? id : null;
};

// Parâmetro de query que, se presente, precisa ser UM texto não vazio (nada de ?a=1&a=2)
const lerTexto = (valor: unknown): string | undefined | null => {
  if (valor === undefined) return undefined;
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : null;
};

const lerInteiro = (valor: unknown, padrao: number, minimo: number, maximo: number): number | null => {
  if (valor === undefined) return padrao;
  if (typeof valor !== 'string' || valor.trim() === '') return null;
  const n = Number(valor);
  return Number.isInteger(n) && n >= minimo && n <= maximo ? n : null;
};

const cidadeDoUsuario = async (userId: number): Promise<string | null> => {
  const resultado = await pool.query<{ cidade: string | null }>('SELECT cidade FROM usuarios WHERE id = $1', [userId]);
  const cidade = resultado.rows[0]?.cidade;
  return cidade && cidade.trim() !== '' ? cidade : null;
};

const ehAdmin = (req: Request) => req.user?.perfil === 'ADMIN';

type Escopo = { cidade: string | undefined } | { status: number; error: string };

// ADMIN consulta qualquer cidade suportada (ou todas, sem filtro). USUARIO só enxerga a cidade cadastrada nele.
const resolverEscopo = async (req: Request, cidadeInformada: string | undefined): Promise<Escopo> => {
  if (cidadeInformada !== undefined && !cidadeSuportada(cidadeInformada)) {
    return { status: 400, error: 'Cidade inválida' };
  }
  if (ehAdmin(req)) return { cidade: cidadeInformada };

  const propria = await cidadeDoUsuario(req.user!.userId);
  if (!propria) return { status: 403, error: 'Seu usuário não tem cidade cadastrada' };
  if (cidadeInformada !== undefined && cidadeInformada !== propria) {
    return { status: 403, error: 'Você só pode consultar os alertas da sua cidade' };
  }
  return { cidade: propria };
};

// GET /api/alertas?cidade=&status=&nivel=&poluente=&limite=&pagina=
router.get('/', async (req: Request, res: Response) => {
  const { cidade, status, nivel, poluente, limite, pagina } = req.query;

  const cidadeTexto = lerTexto(cidade);
  const statusTexto = lerTexto(status);
  const nivelTexto = lerTexto(nivel);
  const poluenteTexto = lerTexto(poluente);
  if (cidadeTexto === null) return res.status(400).json({ error: 'Cidade inválida' });
  if (statusTexto === null || (statusTexto !== undefined && !STATUS_ALERTA.includes(statusTexto.toUpperCase() as StatusAlerta))) {
    return res.status(400).json({ error: `"status" deve ser um de: ${STATUS_ALERTA.join(', ')}` });
  }
  if (nivelTexto === null || (nivelTexto !== undefined && !NIVEIS_ALERTA.includes(nivelTexto.toUpperCase() as NivelAlerta))) {
    return res.status(400).json({ error: `"nivel" deve ser um de: ${NIVEIS_ALERTA.join(', ')}` });
  }
  if (poluenteTexto === null || (poluenteTexto !== undefined && !Object.prototype.hasOwnProperty.call(LIMIARES, normalizarPoluente(poluenteTexto)))) {
    return res.status(400).json({ error: `"poluente" deve ser um de: ${Object.keys(LIMIARES).join(', ')}` });
  }

  const limiteItens = lerInteiro(limite, LIMITE_PADRAO, 1, LIMITE_MAXIMO);
  if (limiteItens === null) return res.status(400).json({ error: `"limite" deve ser um inteiro entre 1 e ${LIMITE_MAXIMO}` });
  const paginaAtual = lerInteiro(pagina, 1, 1, 1000000);
  if (paginaAtual === null) return res.status(400).json({ error: '"pagina" deve ser um inteiro maior ou igual a 1' });

  try {
    const escopo = await resolverEscopo(req, cidadeTexto);
    if ('error' in escopo) return res.status(escopo.status).json({ error: escopo.error });

    const { total, alertas } = await listarAlertas({
      cidade: escopo.cidade,
      status: statusTexto?.toUpperCase() as StatusAlerta | undefined,
      nivel: nivelTexto?.toUpperCase() as NivelAlerta | undefined,
      poluente: poluenteTexto === undefined ? undefined : normalizarPoluente(poluenteTexto),
      limite: limiteItens,
      pagina: paginaAtual,
    });

    res.json({ total, pagina: paginaAtual, limite: limiteItens, alertas, limiaresProvisorios: LIMIARES_PROVISORIOS });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao consultar os alertas' });
  }
});

// POST /api/alertas/avaliar   { "cidade": "São Paulo", "limite": 5 }   — somente ADMIN
// Consulta as estações da cidade (OpenAQ, com fallback Open-Meteo pelo consolidador) e aplica as regras.
// Não aceita valores prontos: o alerta só nasce de dado obtido pelo próprio backend.
router.post('/avaliar', requireAdmin, async (req: Request, res: Response) => {
  const { cidade, limite } = (req.body ?? {}) as { cidade?: unknown; limite?: unknown };

  if (typeof cidade !== 'string' || !cidadeSuportada(cidade)) return res.status(400).json({ error: 'Cidade inválida' });
  if (limite !== undefined && (typeof limite !== 'number' || !Number.isInteger(limite) || limite < 1 || limite > LIMITE_ESTACOES_MAXIMO)) {
    return res.status(400).json({ error: `"limite" deve ser um inteiro entre 1 e ${LIMITE_ESTACOES_MAXIMO}` });
  }

  try {
    const resumo = await avaliarCidade(cidade, limite ?? LIMITE_ESTACOES_PADRAO);
    res.json({ ...resumo, limiaresProvisorios: LIMIARES_PROVISORIOS });
  } catch (error) {
    responderErro(res, error);
  }
});

// GET /api/alertas/:id
router.get('/:id', async (req: Request, res: Response) => {
  const id = lerId(req);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  try {
    const alerta = await obterAlerta(id);
    // Para quem não é ADMIN, alerta de outra cidade responde igual a alerta inexistente (não revela que existe)
    if (alerta && !ehAdmin(req) && alerta.cidade !== (await cidadeDoUsuario(req.user!.userId))) {
      return res.status(404).json({ error: 'Alerta não encontrado' });
    }
    if (!alerta) return res.status(404).json({ error: 'Alerta não encontrado' });

    res.json({ alerta, limiaresProvisorios: LIMIARES_PROVISORIOS });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao consultar o alerta' });
  }
});

// POST /api/alertas/:id/resolver — resolução manual, somente ADMIN
router.post('/:id/resolver', requireAdmin, async (req: Request, res: Response) => {
  const id = lerId(req);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  try {
    const { resultado, alerta } = await resolverAlerta(id);
    if (resultado === 'nao_encontrado') return res.status(404).json({ error: 'Alerta não encontrado' });
    if (resultado === 'ja_resolvido') return res.status(409).json({ error: 'O alerta já está resolvido', alerta });
    res.json({ alerta });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao resolver o alerta' });
  }
});

export default router;
