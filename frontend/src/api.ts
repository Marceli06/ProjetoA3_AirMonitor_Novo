import axios from 'axios';
import { EstacoesArResponse, UltimasMedicoesArResponse, RegisterPayload, UsuarioAdmin, DadosUsuarioForm, NovoUsuarioData, SessaoResponse,
  ResumoAdminResponse, ConfiguracoesSistema, EstacoesAdminResponse, FiltrosAlertas, ListaAlertasResponse, AlertaResponse,
  ResumoAvaliacaoAlertasResponse, FiltrosOcorrenciasAPI, ListaOcorrenciasResponse, OcorrenciaResponse, NovaOcorrenciaPayload,
  StatusOcorrencia, FiltrosHistoricoAPI, HistoricoResponse, ModeloCidadeResponse } from './types';

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

// Disparado quando o backend recusa o token (401): o App volta para o Login
export const SESSAO_ENCERRADA_EVENTO = 'airmonitor:sessao-encerrada';

export const limparSessao = () => {
  localStorage.removeItem('authToken');
  localStorage.removeItem('user');
};

// Nestas rotas um 401 significa "credenciais inválidas", não sessão expirada
const ROTAS_PUBLICAS = ['/auth/login', '/auth/register', '/auth/esqueci-senha'];

// 401 em rota autenticada (token expirado/inválido, usuário desativado ou removido) encerra a sessão.
// 403 (autenticado, mas sem permissão) não é tratado aqui e segue para quem fez a chamada.
// Só age se o token da requisição ainda for o token guardado: várias respostas 401 simultâneas, ou uma
// resposta atrasada de um token antigo, não derrubam uma sessão nova nem geram redirecionamentos repetidos.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const rotaPublica = ROTAS_PUBLICAS.some((rota) => String(error.config?.url ?? '').startsWith(rota));
    const tokenAtual = localStorage.getItem('authToken');
    const tokenDaRequisicao = String(error.config?.headers?.Authorization ?? '').replace('Bearer ', '');
    if (error.response?.status === 401 && !rotaPublica && tokenAtual && tokenDaRequisicao === tokenAtual) {
      limparSessao();
      window.dispatchEvent(new Event(SESSAO_ENCERRADA_EVENTO));
    }
    return Promise.reject(error);
  }
);

export const authAPI = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  register: (dados: RegisterPayload) => api.post('/auth/register', dados),
  // Valida o token guardado e devolve o usuário (perfil) conforme o banco
  me: () => api.get<SessaoResponse>('/auth/me'),
};

export const adminAPI = {
  listarCidades: () => api.get<Record<string, string[]>>('/admin/cidades'),
  listarUsuarios: () => api.get<UsuarioAdmin[]>('/admin/usuarios'),
  criarUsuario: (dados: NovoUsuarioData) => api.post<UsuarioAdmin>('/admin/usuarios', dados),
  atualizarUsuario: (id: number, dados: DadosUsuarioForm) =>
    api.put<UsuarioAdmin>(`/admin/usuarios/${id}`, dados),
  alterarStatus: (id: number, ativo: boolean) =>
    api.patch<UsuarioAdmin>(`/admin/usuarios/${id}/status`, { ativo }),
  resumo: () => api.get<ResumoAdminResponse>('/admin/resumo'),
  configuracoes: () => api.get<ConfiguracoesSistema>('/admin/configuracoes'),
  estacoes: (cidade: string, limite = 20) =>
    api.get<EstacoesAdminResponse>('/admin/estacoes', { params: { cidade, limite } }),
};

export const airQualityAPI = {
  // Estações que medem algum dos poluentes, da mais próxima do centro da cidade para a mais distante
  estacoesPorCidade: (cidade: string, limite = 1) =>
    api.get<EstacoesArResponse>('/air-quality/locations', { params: { cidade, limite, raio: 25000 } }),
  ultimasMedicoes: (estacaoId: number) =>
    api.get<UltimasMedicoesArResponse>(`/air-quality/locations/${estacaoId}/latest`),
  // Último recurso com a OpenAQ fora do ar: estimativa do modelo no centro da cidade (sem estação)
  modeloPorCidade: (cidade: string) => api.get<ModeloCidadeResponse>('/air-quality/modelo', { params: { cidade } }),
};

// Alertas gerados pelo backend. A cidade e o perfil são validados no servidor: USUARIO só acessa a própria cidade
// (403 para outra) e as ações de escrita são só de ADMIN. O 403 passa adiante sem encerrar a sessão (ver interceptor).
export const alertasAPI = {
  listar: (filtros: FiltrosAlertas = {}, signal?: AbortSignal) =>
    api.get<ListaAlertasResponse>('/alertas', { params: filtros, signal }),
  obter: (id: number) => api.get<AlertaResponse>(`/alertas/${id}`),
  resolver: (id: number) => api.post<AlertaResponse>(`/alertas/${id}/resolver`),
  // A avaliação consulta OpenAQ/Open-Meteo estação por estação: pode levar alguns segundos
  avaliar: (cidade: string, limite?: number) =>
    api.post<ResumoAvaliacaoAlertasResponse>('/alertas/avaliar', { cidade, limite }, { timeout: 90000 }),
};

// Ocorrências persistidas no banco. USUARIO só enxerga e registra na própria cidade (403 para outra); a alteração de
// status é só de ADMIN (403 para os demais; 409 se a transição não for permitida). O 403 não encerra a sessão.
export const ocorrenciasAPI = {
  listar: (filtros: FiltrosOcorrenciasAPI = {}, signal?: AbortSignal) =>
    api.get<ListaOcorrenciasResponse>('/ocorrencias', { params: filtros, signal }),
  obter: (id: number, signal?: AbortSignal) => api.get<OcorrenciaResponse>(`/ocorrencias/${id}`, { signal }),
  criar: (dados: NovaOcorrenciaPayload) => api.post<OcorrenciaResponse>('/ocorrencias', dados),
  alterarStatus: (id: number, status: StatusOcorrencia) => api.patch<OcorrenciaResponse>(`/ocorrencias/${id}/status`, { status }),
};

// Histórico de qualidade do ar (série horária de um poluente). USUARIO só consulta a própria cidade (403 para outra);
// sem histórico disponível a resposta é 200 com total 0 (a tela mostra o estado vazio).
export const historicoAPI = {
  consultar: (filtros: FiltrosHistoricoAPI, signal?: AbortSignal) => api.get<HistoricoResponse>('/historico', { params: filtros, signal }),
};

export default api;
