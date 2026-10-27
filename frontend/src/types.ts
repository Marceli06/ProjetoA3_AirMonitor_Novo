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

export interface RegisterPayload {
  nome: string;
  email: string;
  password: string;
  confirmPassword: string;
  cidade: string;
  regiao: string;
}
