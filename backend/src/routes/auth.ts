import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../database';
import { Usuario, JWTPayload, Perfil } from '../types';
import { CIDADES } from '../data/cidades';
import { authMiddleware } from '../middlewares';
import { JWT_SECRET } from '../config';

const router = Router();
const SALT_ROUNDS = 12;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BYTES_SENHA = 72; // o bcrypt ignora o que passa de 72 bytes

const normalizarEmail = (email: string) => String(email).trim().toLowerCase();

const gerarToken = (id: number, email: string, perfil: Perfil) =>
  jwt.sign(
    { userId: id, email, perfil } as JWTPayload,
    JWT_SECRET,
    { expiresIn: '24h' }
  );

// Login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body ?? {};

    // Só texto: número, objeto ou lista no JSON derrubariam o bcrypt (500) em vez de responder 400
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }

    const result = await pool.query<Usuario>('SELECT * FROM usuarios WHERE email = $1', [normalizarEmail(email)]);
    const usuario = result.rows[0];

    // Mesma resposta para e-mail inexistente, conta inativa ou senha errada
    if (!usuario || !usuario.ativo) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const senhaValida = await bcrypt.compare(password, usuario.senha_hash);

    if (!senhaValida) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const token = gerarToken(usuario.id, usuario.email, usuario.perfil);

    res.json({
      token,
      user: { id: usuario.id, nome: usuario.nome, email: usuario.email, perfil: usuario.perfil, cidade: usuario.cidade, regiao: usuario.regiao },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// Valida a sessão e devolve o usuário vigente. O authMiddleware já responde 401 para token inválido/expirado
// e para usuário inexistente ou desativado; o perfil devolvido vem do banco, nunca do token
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const result = await pool.query<Pick<Usuario, 'id' | 'nome' | 'email' | 'perfil' | 'cidade' | 'regiao'>>(
      'SELECT id, nome, email, perfil, cidade, regiao FROM usuarios WHERE id = $1',
      [req.user!.userId]
    );
    const usuario = result.rows[0];

    if (!usuario) {
      return res.status(401).json({ error: 'Usuário inexistente ou inativo' });
    }

    res.json({ user: usuario });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao validar a sessão' });
  }
});

// Cadastro público: sempre cria USUARIO; o perfil enviado pelo cliente é ignorado
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { nome, email, password, confirmPassword, cidade, regiao } = req.body ?? {};

    if ([nome, email, password, confirmPassword, cidade, regiao].some((c) => typeof c !== 'string' || c.trim() === '')) {
      return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
    }

    if (nome.trim().length < 2 || nome.trim().length > 120) {
      return res.status(400).json({ error: 'Nome deve ter entre 2 e 120 caracteres' });
    }

    if (email.trim().length > 255 || !EMAIL_REGEX.test(normalizarEmail(email))) {
      return res.status(400).json({ error: 'E-mail inválido' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'As senhas não correspondem' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'A senha deve ter no mínimo 6 caracteres' });
    }

    if (Buffer.byteLength(password, 'utf8') > MAX_BYTES_SENHA) {
      return res.status(400).json({ error: 'A senha deve ter no máximo 72 caracteres' });
    }

    const regioesDaCidade = Object.prototype.hasOwnProperty.call(CIDADES, cidade) ? CIDADES[cidade] : [];
    if (!regioesDaCidade.includes(regiao)) {
      return res.status(400).json({ error: 'Cidade ou região inválida' });
    }

    const senhaHash = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await pool.query<Usuario>(
      `INSERT INTO usuarios (nome, email, senha_hash, perfil, cidade, regiao)
       VALUES ($1, $2, $3, 'USUARIO', $4, $5)
       RETURNING id, nome, email, perfil, cidade, regiao`,
      [String(nome).trim(), normalizarEmail(email), senhaHash, cidade, regiao]
    );

    const novo = result.rows[0];
    const token = gerarToken(novo.id, novo.email, novo.perfil);

    res.status(201).json({
      token,
      user: { id: novo.id, nome: novo.nome, email: novo.email, perfil: novo.perfil, cidade: novo.cidade, regiao: novo.regiao },
    });
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(400).json({ error: 'Email já cadastrado' });
    }
    console.error(error);
    res.status(500).json({ error: 'Erro ao registrar' });
  }
});

// Esqueci minha senha (ainda sem envio de e-mail): resposta genérica
router.post('/esqueci-senha', (req: Request, res: Response) => {
  res.json({
    message: 'Se o e-mail estiver cadastrado, você receberá instruções para redefinir sua senha.',
  });
});

export default router;