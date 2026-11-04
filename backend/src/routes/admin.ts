import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../database';
import { authMiddleware, requireAdmin } from '../middlewares';
import { CIDADES } from '../data/cidades';
import { COORDENADAS_CIDADES } from '../data/cidadesCoordenadas';
import { buscarEstacoes } from '../services/airQuality';
import { obterConfiguracoes, obterResumoUsuarios, resumirEstacao } from '../services/adminDashboard';
import { RAIO_MAXIMO_M, responderErro } from './airQuality';

const router = Router();
const SALT_ROUNDS = 12;
const COLUNAS_USUARIO = 'id, nome, email, perfil, ativo, cidade, regiao, criado_em';

// Todas as rotas deste arquivo exigem token válido e perfil ADMIN
router.use(authMiddleware, requireAdmin);

const normalizarEmail = (email: unknown) => String(email).trim().toLowerCase();
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const regiaoValida = (cidade: unknown, regiao: unknown) => {
  if (typeof cidade !== 'string' || typeof regiao !== 'string') return false;
  const regioes = Object.prototype.hasOwnProperty.call(CIDADES, cidade) ? CIDADES[cidade] : [];
  return regioes.includes(regiao);
};

// Valida os dados básicos (compartilhado por criação e edição). Retorna a mensagem de erro ou null
const validarDadosBasicos = (nome: unknown, email: unknown, cidade: unknown, regiao: unknown) => {
  if (!nome || !email || !cidade || !regiao) return 'Nome, e-mail, cidade e região são obrigatórios';
  if (String(nome).trim().length < 2 || String(nome).trim().length > 120) return 'Nome deve ter entre 2 e 120 caracteres';
  if (!EMAIL_REGEX.test(normalizarEmail(email))) return 'E-mail inválido';
  if (!regiaoValida(cidade, regiao)) return 'Cidade ou região inválida';
  return null;
};

const lerId = (req: Request) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// Cidades e regiões aceitas (mesma fonte usada na validação do backend)
router.get('/cidades', (req: Request, res: Response) => {
  res.json(CIDADES);
});

router.get('/usuarios', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`SELECT ${COLUNAS_USUARIO} FROM usuarios ORDER BY nome`);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao listar usuários' });
  }
});

// Cria usuário comum: o perfil enviado pelo cliente é ignorado, sempre USUARIO
router.post('/usuarios', async (req: Request, res: Response) => {
  try {
    const { nome, email, password, cidade, regiao } = req.body;

    const erro = validarDadosBasicos(nome, email, cidade, regiao);
    if (erro) return res.status(400).json({ error: erro });

    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'A senha deve ter no mínimo 6 caracteres' });
    }

    const senhaHash = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await pool.query(
      `INSERT INTO usuarios (nome, email, senha_hash, perfil, cidade, regiao)
       VALUES ($1, $2, $3, 'USUARIO', $4, $5)
       RETURNING ${COLUNAS_USUARIO}`,
      [String(nome).trim(), normalizarEmail(email), senhaHash, cidade, regiao]
    );

    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(400).json({ error: 'Email já cadastrado' });
    }
    console.error(error);
    res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

// Edita dados básicos (nome, e-mail, cidade, região). Perfil e senha não são alterados aqui
router.put('/usuarios/:id', async (req: Request, res: Response) => {
  try {
    const id = lerId(req);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { nome, email, cidade, regiao } = req.body;

    const erro = validarDadosBasicos(nome, email, cidade, regiao);
    if (erro) return res.status(400).json({ error: erro });

    const result = await pool.query(
      `UPDATE usuarios
       SET nome = $1, email = $2, cidade = $3, regiao = $4, atualizado_em = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING ${COLUNAS_USUARIO}`,
      [String(nome).trim(), normalizarEmail(email), cidade, regiao, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    res.json(result.rows[0]);
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(400).json({ error: 'Email já cadastrado' });
    }
    console.error(error);
    res.status(500).json({ error: 'Erro ao atualizar usuário' });
  }
});

// Ativa ou desativa um usuário
router.patch('/usuarios/:id/status', async (req: Request, res: Response) => {
  try {
    const id = lerId(req);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { ativo } = req.body;
    if (typeof ativo !== 'boolean') {
      return res.status(400).json({ error: 'O campo "ativo" deve ser verdadeiro ou falso' });
    }

    // Evita o ADMIN se trancar para fora do sistema
    if (!ativo && req.user?.userId === id) {
      return res.status(400).json({ error: 'Você não pode desativar a sua própria conta' });
    }

    const result = await pool.query(
      `UPDATE usuarios SET ativo = $1, atualizado_em = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING ${COLUNAS_USUARIO}`,
      [ativo, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao alterar status do usuário' });
  }
});

// Contadores reais de usuários (banco), usados pelo Dashboard Admin e pelos Relatórios
router.get('/resumo', async (req: Request, res: Response) => {
  try {
    res.json(await obterResumoUsuarios());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao obter o resumo de usuários' });
  }
});

// Informações do sistema em modo leitura. Nunca inclui chaves, JWT_SECRET, DATABASE_URL, senhas ou tokens
router.get('/configuracoes', async (req: Request, res: Response) => {
  try {
    res.json(await obterConfiguracoes());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao obter as configurações do sistema' });
  }
});

const LIMITE_ESTACOES_PADRAO = 20;
const LIMITE_ESTACOES_MAXIMO = 50;

// Estações devolvidas pela OpenAQ para uma das cidades suportadas (não há cadastro manual de estações)
// GET /api/admin/estacoes?cidade=São Paulo&limite=20
router.get('/estacoes', async (req: Request, res: Response) => {
  const { cidade, limite } = req.query;

  const centro = typeof cidade === 'string' && Object.prototype.hasOwnProperty.call(COORDENADAS_CIDADES, cidade)
    ? COORDENADAS_CIDADES[cidade]
    : null;
  if (!centro) return res.status(400).json({ error: 'Cidade inválida' });

  const limiteEstacoes = limite === undefined ? LIMITE_ESTACOES_PADRAO : typeof limite === 'string' && limite.trim() !== '' ? Number(limite) : NaN;
  if (!Number.isInteger(limiteEstacoes) || limiteEstacoes < 1 || limiteEstacoes > LIMITE_ESTACOES_MAXIMO) {
    return res.status(400).json({ error: `"limite" deve ser um inteiro entre 1 e ${LIMITE_ESTACOES_MAXIMO}` });
  }

  try {
    const estacoes = await buscarEstacoes({ ...centro, raioMetros: RAIO_MAXIMO_M, limite: limiteEstacoes });
    res.json({
      cidade,
      origem: { ...centro, raioMetros: RAIO_MAXIMO_M },
      total: estacoes.length,
      estacoes: estacoes.map(resumirEstacao),
      mensagem: estacoes.length === 0 ? 'Nenhuma estação com os poluentes monitorados foi encontrada perto desta cidade' : null,
      fonte: 'OpenAQ',
    });
  } catch (error) {
    responderErro(res, error);
  }
});

export default router;
