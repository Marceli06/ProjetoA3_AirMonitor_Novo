import { Router, Request, Response } from 'express';
import pool from '../database';
import { authMiddleware, requireAdmin } from '../middlewares';
import {
  STATUS_OCORRENCIA,
  StatusOcorrencia,
  TIPOS_OCORRENCIA,
  TipoOcorrencia,
  alterarStatus,
  cidadeSuportada,
  criarOcorrenciaManual,
  listarOcorrencias,
  obterOcorrencia,
  validarNovaOcorrencia,
} from '../services/ocorrencias';

const router = Router();

const LIMITE_PADRAO = 50;
const LIMITE_MAXIMO = 200;
const ID_MAXIMO = 2147483647; // limite do INTEGER do PostgreSQL (acima disso a consulta falharia com 500)
const BUSCA_MAXIMA = 100;

// Todas as rotas exigem token válido. O perfil e a cidade vêm do banco, nunca do token ou da requisição.
router.use(authMiddleware);

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

// Data de calendário real no formato YYYY-MM-DD (rejeita 2026-02-30, por exemplo)
const lerData = (valor: unknown): string | undefined | null => {
  const texto = lerTexto(valor);
  if (texto === undefined || texto === null) return texto;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return null;
  const data = new Date(`${texto}T00:00:00Z`);
  return !Number.isNaN(data.getTime()) && data.toISOString().slice(0, 10) === texto ? texto : null;
};

const cidadeDoUsuario = async (userId: number): Promise<string | null> => {
  const resultado = await pool.query<{ cidade: string | null }>('SELECT cidade FROM usuarios WHERE id = $1', [userId]);
  const cidade = resultado.rows[0]?.cidade;
  return cidade && cidade.trim() !== '' ? cidade : null;
};

const ehAdmin = (req: Request) => req.user?.perfil === 'ADMIN';

// GET /api/ocorrencias?cidade=&status=&tipo=&busca=&de=&ate=&limite=&pagina=
// ADMIN consulta qualquer cidade (ou todas); USUARIO só enxerga a cidade cadastrada nele.
router.get('/', async (req: Request, res: Response) => {
  const { cidade, status, tipo, busca, de, ate, limite, pagina } = req.query;

  const cidadeTexto = lerTexto(cidade);
  const statusTexto = lerTexto(status);
  const tipoTexto = lerTexto(tipo);
  const buscaTexto = lerTexto(busca);
  const deData = lerData(de);
  const ateData = lerData(ate);
  if (cidadeTexto === null || (cidadeTexto !== undefined && !cidadeSuportada(cidadeTexto))) return res.status(400).json({ error: 'Cidade inválida' });
  if (statusTexto === null || (statusTexto !== undefined && !STATUS_OCORRENCIA.includes(statusTexto.toUpperCase() as StatusOcorrencia))) {
    return res.status(400).json({ error: `"status" deve ser um de: ${STATUS_OCORRENCIA.join(', ')}` });
  }
  if (tipoTexto === null || (tipoTexto !== undefined && !TIPOS_OCORRENCIA.includes(tipoTexto.toUpperCase() as TipoOcorrencia))) {
    return res.status(400).json({ error: `"tipo" deve ser um de: ${TIPOS_OCORRENCIA.join(', ')}` });
  }
  if (deData === null) return res.status(400).json({ error: '"de" deve ser uma data válida no formato AAAA-MM-DD' });
  if (ateData === null) return res.status(400).json({ error: '"ate" deve ser uma data válida no formato AAAA-MM-DD' });
  if (deData !== undefined && ateData !== undefined && deData > ateData) return res.status(400).json({ error: '"de" não pode ser posterior a "ate"' });

  if (buscaTexto === null || (buscaTexto !== undefined && (buscaTexto.length > BUSCA_MAXIMA || buscaTexto.includes('\u0000')))) {
    return res.status(400).json({ error: `"busca" deve ter de 1 a ${BUSCA_MAXIMA} caracteres` });
  }

  const limiteItens = lerInteiro(limite, LIMITE_PADRAO, 1, LIMITE_MAXIMO);
  if (limiteItens === null) return res.status(400).json({ error: `"limite" deve ser um inteiro entre 1 e ${LIMITE_MAXIMO}` });
  const paginaAtual = lerInteiro(pagina, 1, 1, 1000000);
  if (paginaAtual === null) return res.status(400).json({ error: '"pagina" deve ser um inteiro maior ou igual a 1' });

  try {
    let cidadeEscopo = cidadeTexto;
    if (!ehAdmin(req)) {
      const propria = await cidadeDoUsuario(req.user!.userId);
      if (!propria) return res.status(403).json({ error: 'Seu usuário não tem cidade cadastrada' });
      if (cidadeTexto !== undefined && cidadeTexto !== propria) {
        return res.status(403).json({ error: 'Você só pode consultar as ocorrências da sua cidade' });
      }
      cidadeEscopo = propria;
    }

    const { total, resumo, ocorrencias } = await listarOcorrencias({
      cidade: cidadeEscopo,
      status: statusTexto?.toUpperCase() as StatusOcorrencia | undefined,
      tipo: tipoTexto?.toUpperCase() as TipoOcorrencia | undefined,
      busca: buscaTexto,
      de: deData,
      ate: ateData,
      limite: limiteItens,
      pagina: paginaAtual,
    });

    res.json({ total, pagina: paginaAtual, limite: limiteItens, resumo, ocorrencias });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao consultar as ocorrências' });
  }
});

// GET /api/ocorrencias/:id
router.get('/:id', async (req: Request, res: Response) => {
  const id = lerId(req);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  try {
    const ocorrencia = await obterOcorrencia(id);
    // Para quem não é ADMIN, ocorrência de outra cidade responde igual a ocorrência inexistente (não revela que existe)
    if (ocorrencia && !ehAdmin(req) && ocorrencia.cidade !== (await cidadeDoUsuario(req.user!.userId))) {
      return res.status(404).json({ error: 'Ocorrência não encontrada' });
    }
    if (!ocorrencia) return res.status(404).json({ error: 'Ocorrência não encontrada' });

    res.json({ ocorrencia });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao consultar a ocorrência' });
  }
});

// POST /api/ocorrencias — registro MANUAL. Status ABERTA, origem MANUAL e usuário vêm do servidor, nunca do corpo.
// USUARIO registra na própria cidade (o campo "cidade" é opcional e, se vier, precisa ser a mesma); ADMIN informa a cidade.
router.post('/', async (req: Request, res: Response) => {
  const validacao = validarNovaOcorrencia(req.body);
  if ('erro' in validacao) return res.status(400).json({ error: validacao.erro });
  const { dados } = validacao;

  if (dados.cidade !== null && !cidadeSuportada(dados.cidade)) return res.status(400).json({ error: 'Cidade inválida' });

  try {
    let cidade: string;
    if (ehAdmin(req)) {
      if (dados.cidade === null) return res.status(400).json({ error: '"cidade" é obrigatória' });
      cidade = dados.cidade;
    } else {
      const propria = await cidadeDoUsuario(req.user!.userId);
      if (!propria) return res.status(403).json({ error: 'Seu usuário não tem cidade cadastrada' });
      if (dados.cidade !== null && dados.cidade !== propria) {
        return res.status(403).json({ error: 'Você só pode registrar ocorrências na sua cidade' });
      }
      cidade = propria;
    }

    const ocorrencia = await criarOcorrenciaManual(dados, cidade, req.user!.userId);
    res.status(201).json({ ocorrencia });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao registrar a ocorrência' });
  }
});

// PATCH /api/ocorrencias/:id/status   { "status": "EM_ANDAMENTO" | "CONCLUIDA" } — somente ADMIN
// Transições: ABERTA -> EM_ANDAMENTO -> CONCLUIDA (ou ABERTA -> CONCLUIDA). CONCLUIDA é final (409 nas demais).
router.patch('/:id/status', requireAdmin, async (req: Request, res: Response) => {
  const id = lerId(req);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const corpo = req.body as unknown;
  if (corpo === null || typeof corpo !== 'object' || Array.isArray(corpo) || Object.keys(corpo).some((k) => k !== 'status')) {
    return res.status(400).json({ error: 'Informe apenas o campo "status"' });
  }
  const novo = typeof (corpo as { status?: unknown }).status === 'string' ? ((corpo as { status: string }).status.trim().toUpperCase() as StatusOcorrencia) : null;
  if (novo === null || !STATUS_OCORRENCIA.includes(novo)) {
    return res.status(400).json({ error: `"status" deve ser um de: ${STATUS_OCORRENCIA.join(', ')}` });
  }

  try {
    const r = await alterarStatus(id, novo);
    if (r.resultado === 'nao_encontrada') return res.status(404).json({ error: 'Ocorrência não encontrada' });
    if (r.resultado === 'transicao_invalida') {
      return res.status(409).json({ error: `Não é possível mudar a ocorrência de ${r.ocorrencia.status} para ${novo}`, ocorrencia: r.ocorrencia });
    }
    res.json({ ocorrencia: r.ocorrencia });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao alterar o status da ocorrência' });
  }
});

export default router;
