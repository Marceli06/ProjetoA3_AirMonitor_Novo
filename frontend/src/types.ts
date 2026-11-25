export interface User {
  id: string;
  email: string;
}

export interface UsuarioLogado {
  id: number;
  nome: string;
  email: string;
  perfil: 'ADMIN' | 'USUARIO';
  cidade: string | null;
  regiao: string | null;
}

export interface SessaoResponse {
  user: UsuarioLogado;
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

// Estimativa do modelo (Open-Meteo) no centro da cidade, usada quando a OpenAQ está fora do ar e não há estação
export interface ModeloCidadeResponse extends Omit<UltimasMedicoesArResponse, 'estacao'> {
  estacao: null;
  cidade: string;
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

// Alertas de qualidade do ar, como devolvidos por /api/alertas (backend/src/services/alertas.ts). Os limiares de
// nível ainda são PROVISÓRIOS (limiaresProvisorios). A origem usa os mesmos conceitos do Dashboard (OpenAQ = medição
// de estação; Open-Meteo = estimativa por modelo) e tipoDado nunca mistura os dois.
export type NivelAlerta = 'BAIXO' | 'MODERADO' | 'ALTO' | 'CRITICO';
export type StatusAlerta = 'ATIVO' | 'RESOLVIDO';
export type OrigemAlerta = 'OPENAQ' | 'OPEN_METEO';

export type TipoDadoAlerta = 'MEDICAO' | 'MODELO';

export interface AlertaAr {
  id: number;
  cidade: string;
  regiao: string | null;
  estacaoId: string;
  estacaoNome: string | null;
  poluente: string; // chave do poluente: pm25, pm10, o3, no2, co, so2
  poluenteNome: string;
  valor: number;
  unidade: string;
  nivel: NivelAlerta;
  titulo: string;
  descricao: string;
  status: StatusAlerta;
  origemDado: OrigemAlerta;
  tipoDado: TipoDadoAlerta; // MEDICAO (estação) ou MODELO (estimativa)
  medicaoEm: string;
  criadoEm: string;
  atualizadoEm: string;
  resolvidoEm: string | null;
}

export interface FiltrosAlertas {
  cidade?: string;
  status?: StatusAlerta;
  nivel?: NivelAlerta;
  poluente?: string;
  limite?: number;
  pagina?: number;
}

export interface ListaAlertasResponse {
  total: number;
  pagina: number;
  limite: number;
  alertas: AlertaAr[];
  limiaresProvisorios: boolean;
}

export interface AlertaResponse {
  alerta: AlertaAr;
  limiaresProvisorios?: boolean;
}

export type AcaoAvaliacaoAlerta = 'criado' | 'atualizado' | 'resolvido' | 'sem_alerta' | 'ignorado';

export interface ResumoAvaliacaoAlertasResponse {
  cidade: string;
  estacoesAvaliadas: number;
  contagem: Record<AcaoAvaliacaoAlerta, number>;
  alertas: AlertaAr[];
  resolvidos: AlertaAr[];
  falhas: { estacaoId: string; motivo: string }[];
  limiaresProvisorios: boolean;
}

// Ocorrências ambientais, como devolvidas por /api/ocorrencias (backend/src/services/ocorrencias.ts). Por enquanto só
// existem ocorrências MANUAIS (registradas por usuários): a origem AUTOMATICA está prevista, mas ainda não há
// integração com os Alertas.
export type TipoOcorrencia = 'POLUICAO' | 'QUEIMADA' | 'EMISSAO' | 'COMUNIDADE' | 'NORMALIZACAO';
export type StatusOcorrencia = 'ABERTA' | 'EM_ANDAMENTO' | 'CONCLUIDA';
export type OrigemOcorrencia = 'AUTOMATICA' | 'MANUAL';

export interface Ocorrencia {
  id: number;
  usuarioId: number | null; // autor, quando manual
  cidade: string;
  local: string;
  estacaoId: string | null;
  estacaoNome: string | null;
  tipo: TipoOcorrencia;
  titulo: string;
  descricao: string;
  status: StatusOcorrencia;
  origem: OrigemOcorrencia;
  // Leitura ambiental associada (opcional): poluente, valor e unidade vêm juntos; o nível exige poluente
  poluente: string | null; // chave do poluente: pm25, pm10, o3, no2, co, so2
  valor: number | null;
  unidade: string | null;
  nivel: NivelAlerta | null;
  criadoEm: string;
  iniciadoEm: string | null; // quando entrou em andamento
  atualizadoEm: string;
  concluidoEm: string | null;
}

export type ResumoStatusOcorrencias = Record<StatusOcorrencia, number>;

export interface FiltrosOcorrenciasAPI {
  cidade?: string;
  status?: StatusOcorrencia;
  tipo?: TipoOcorrencia;
  busca?: string;
  de?: string; // AAAA-MM-DD, inclusivo (fuso America/Sao_Paulo)
  ate?: string;
  limite?: number;
  pagina?: number;
}

export interface ListaOcorrenciasResponse {
  total: number;
  pagina: number;
  limite: number;
  resumo: ResumoStatusOcorrencias; // contagem por status na cidade/filtros, sem considerar o filtro de status
  ocorrencias: Ocorrencia[];
}

export interface OcorrenciaResponse {
  ocorrencia: Ocorrencia;
}

// status, origem e autor são definidos pelo servidor; para USUARIO a cidade é sempre a do cadastro
export interface NovaOcorrenciaPayload {
  cidade?: string;
  titulo: string;
  descricao: string;
  tipo: TipoOcorrencia;
  local: string;
  estacaoNome?: string;
}

// Histórico de qualidade do ar (GET /api/historico): série horária de UM poluente em uma cidade.
// Cada ponto vem de uma estação (OpenAQ, medição) ou do modelo CAMS (Open-Meteo, estimativa).
export type PeriodoHistorico = '24H' | '7D' | '30D';
export type FonteHistorico = 'AUTO' | 'OPENAQ' | 'OPEN_METEO';

export interface PontoHistorico {
  dataHora: string; // ISO 8601 em UTC
  valor: number;
  unidade: string;
  poluente: string; // chave: pm25, pm10, o3, no2, co, so2
  poluenteNome: string;
  estacaoId: number | null; // null nos pontos do modelo
  estacaoNome: string | null;
  origem: OrigemAlerta;
  tipoDado: TipoDadoAlerta;
}

export interface EstacaoHistorico {
  id: number;
  nome: string | null;
  localidade: string | null;
  distanciaMetros: number | null;
  ultimaMedicaoEm: string | null;
  comDadosNoPeriodo: boolean;
}

export interface ResumoHistorico {
  minimo: number;
  maximo: number;
  media: number;
  ultimo: { valor: number; dataHora: string };
}

export type StatusFonteHistorico = 'ok' | 'sem_dado' | 'falha' | 'nao_consultada';

export interface HistoricoResponse {
  cidade: string;
  poluente: { chave: string; nome: string; unidade: string | null };
  periodo: { codigo: PeriodoHistorico; rotulo: string; de: string; ate: string };
  fonteSolicitada: FonteHistorico;
  total: number;
  pontos: PontoHistorico[]; // ordem cronológica
  resumo: ResumoHistorico | null;
  estacao: { id: number; nome: string | null; localidade: string | null; distanciaMetros: number | null } | null;
  estacoes: EstacaoHistorico[];
  fontesUtilizadas: OrigemAlerta[];
  statusFontes: { OPENAQ: StatusFonteHistorico; OPEN_METEO: StatusFonteHistorico | 'nao_necessaria' };
  atribuicoes: string[];
  aviso: string | null;
  mensagem: string | null;
}

export interface FiltrosHistoricoAPI {
  cidade: string;
  poluente: string;
  periodo: PeriodoHistorico;
  fonte?: FonteHistorico;
  estacaoId?: number;
}
