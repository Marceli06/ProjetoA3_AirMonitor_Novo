export type Perfil = 'ADMIN' | 'USUARIO';

export interface Usuario {
  id: number;
  nome: string;
  email: string;
  senha_hash: string;
  perfil: Perfil;
  ativo: boolean;
  cidade: string | null;
  regiao: string | null;
  criado_em: Date;
  atualizado_em: Date;
}

export interface JWTPayload {
  userId: number;
  email: string;
  perfil: Perfil;
}