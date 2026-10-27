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
