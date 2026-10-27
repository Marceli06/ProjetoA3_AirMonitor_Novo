import axios from 'axios';
import { RegisterPayload, UsuarioAdmin, DadosUsuarioForm, NovoUsuarioData } from './types';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Interceptor para adicionar token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('authToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const authAPI = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  register: (dados: RegisterPayload) => api.post('/auth/register', dados),
};

export const adminAPI = {
  listarCidades: () => api.get<Record<string, string[]>>('/admin/cidades'),
  listarUsuarios: () => api.get<UsuarioAdmin[]>('/admin/usuarios'),
  criarUsuario: (dados: NovoUsuarioData) => api.post<UsuarioAdmin>('/admin/usuarios', dados),
  atualizarUsuario: (id: number, dados: DadosUsuarioForm) =>
    api.put<UsuarioAdmin>(`/admin/usuarios/${id}`, dados),
  alterarStatus: (id: number, ativo: boolean) =>
    api.patch<UsuarioAdmin>(`/admin/usuarios/${id}/status`, { ativo }),
};

export default api;
