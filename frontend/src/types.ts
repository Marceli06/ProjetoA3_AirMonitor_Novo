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

// ---- Qualidade do ar (respostas de /api/air-quality)
export interface EstacaoAr {
  id: number;
  nome: string | null;
  localidade: string | null;
  latitude: number | null;
  longitude: number | null;
  distanciaMetros: number | null;
  pais: string | null;
  ultimaMedicaoEm: string | null;
}

export interface EstacoesArResponse {
  total: number;
  estacoes: EstacaoAr[];
  mensagem: string | null;
}

export interface MedicaoAr {
  chave: string;
  poluente: string;
  disponivel: boolean;
  valor: number | null;
  unidade: string | null;
  dataHora: string | null;
  fonte: 'OPENAQ' | 'OPEN_METEO' | null;
  tipoDado: 'MEDICAO' | 'MODELO' | null;
  desatualizada: boolean | null;
}

export interface StatusFontesAr {
  OPENAQ: 'ok' | 'falha';
  OPEN_METEO: 'nao_necessaria' | 'ok' | 'falha' | 'sem_coordenadas';
  erroOpenAQ: string | null;
}

export interface UltimasMedicoesArResponse {
  estacao: EstacaoAr;
  atualizadoEm: string | null;
  medicoes: MedicaoAr[];
  fontesUtilizadas: string[];
  statusFontes: StatusFontesAr;
  atribuicoes: string[];
}

// ---- Painel administrativo (respostas de /api/admin)
export interface ResumoUsuarios {
  total: number;
  ativos: number;
  inativos: number;
  administradores: number;
  usuariosComuns: number;
  semCidade: number;
}

export interface UsuariosPorCidade {
  cidade: string;
  total: number;
  ativos: number;
}

export interface ResumoAdminResponse {
  usuarios: ResumoUsuarios;
  porCidade: UsuariosPorCidade[];
  geradoEm: string;
}

export type SituacaoDados = 'ATUALIZADA' | 'DESATUALIZADA' | 'SEM_MEDICAO';

export interface EstacaoAdmin {
  id: number;
  nome: string | null;
  localidade: string | null;
  pais: string | null;
  latitude: number | null;
  longitude: number | null;
  distanciaMetros: number | null;
  poluentes: { chave: string; nome: string; unidade: string }[];
  ultimaMedicaoEm: string | null;
  situacao: SituacaoDados;
  fonte: 'OpenAQ';
}

export interface EstacoesAdminResponse {
  cidade: string;
  total: number;
  estacoes: EstacaoAdmin[];
  mensagem: string | null;
  fonte: 'OpenAQ';
}

export interface ConfiguracoesSistema {
  sistema: { nome: string; ambiente: string };
  banco: { tipo: string; conectado: boolean };
  integracoes: {
    openaq: { funcao: string; configurada: boolean; exigeChave: boolean; host: string | null; timeoutMs: number };
    openMeteo: { funcao: string; disponivel: boolean; exigeChave: boolean; host: string | null; timeoutMs: number; licenca: string };
  };
  cache: { estacoesMs: number; ultimasMedicoesMs: number; openMeteoMs: number };
  parametros: { defasagemHoras: number };
  cidades: string[];
  geradoEm: string;
}
