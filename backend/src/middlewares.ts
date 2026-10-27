import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWTPayload, Usuario } from './types';
import pool from './database';

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

// Valida o JWT e consulta o usuário no banco a cada requisição: o perfil e o status vigentes
// vêm do banco, nunca do token
export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  let decoded: JWTPayload;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as JWTPayload;
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  try {
    const result = await pool.query<Pick<Usuario, 'id' | 'email' | 'perfil' | 'ativo'>>(
      'SELECT id, email, perfil, ativo FROM usuarios WHERE id = $1',
      [decoded.userId]
    );
    const usuario = result.rows[0];

    if (!usuario || !usuario.ativo) {
      return res.status(401).json({ error: 'Usuário inexistente ou inativo' });
    }

    req.user = { userId: usuario.id, email: usuario.email, perfil: usuario.perfil };
    next();
  } catch (error) {
    next(error);
  }
};

// Confere no banco (não só no token) se o usuário ainda é ADMIN e está ativo.
// Mantém a consulta própria para continuar seguro mesmo se usado sem o authMiddleware antes
export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  try {
    const result = await pool.query('SELECT perfil, ativo FROM usuarios WHERE id = $1', [req.user.userId]);
    const usuario = result.rows[0];

    if (!usuario || !usuario.ativo || usuario.perfil !== 'ADMIN') {
      return res.status(403).json({ error: 'Acesso restrito a administradores' });
    }

    next();
  } catch (error) {
    next(error);
  }
};

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor' });
};