export interface User {
  id: string;
  email: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface LoginFormData {
  email: string;
  password: string;
}

export interface RegisterFormData {
  email: string;
  password: string;
  confirmPassword: string;
}

export interface UsuarioAdmin {
  id: number;
  nome: string;
  email: string;
  perfil: 'ADMIN' | 'USUARIO';
  ativo: boolean;
  cidade: string | null;
  regiao: string | null;
  criado_em: string;
}

export interface DadosUsuarioForm {
  nome: string;
  email: string;
  cidade: string;
  regiao: string;
}

export interface NovoUsuarioData extends DadosUsuarioForm {
  password: string;
}

export interface RegisterPayload {
  nome: string;
  email: string;
  password: string;
  confirmPassword: string;
  cidade: string;
  regiao: string;
}
