import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../database';
import { Usuario, JWTPayload, Perfil } from '../types';
import { CIDADES } from '../data/cidades';

const router = Router();
const SALT_ROUNDS = 12;

const normalizarEmail = (email: string) => String(email).trim().toLowerCase();

const gerarToken = (id: number, email: string, perfil: Perfil) =>
  jwt.sign(
    { userId: id, email, perfil } as JWTPayload,
    process.env.JWT_SECRET || 'secret',
    { expiresIn: '24h' }
  );

// Login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
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

// Cadastro público: sempre cria USUARIO; o perfil enviado pelo cliente é ignorado
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { nome, email, password, confirmPassword, cidade, regiao } = req.body;

    if (!nome || !email || !password || !confirmPassword || !cidade || !regiao) {
      return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'As senhas não correspondem' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'A senha deve ter no mínimo 6 caracteres' });
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