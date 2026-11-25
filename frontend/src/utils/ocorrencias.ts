import axios from 'axios';
import { Ocorrencia, OrigemOcorrencia, StatusOcorrencia, TipoOcorrencia } from '../types';

// Rótulos, filtros e formatação da tela de Ocorrências. Os dados vêm da API (/api/ocorrencias); aqui ficam só os
// textos, as regras de apresentação e a tradução dos erros da API em mensagens para o usuário.

export const TIPOS_ORDEM: TipoOcorrencia[] = ['POLUICAO', 'QUEIMADA', 'EMISSAO', 'COMUNIDADE', 'NORMALIZACAO'];
export const STATUS_ORDEM: StatusOcorrencia[] = ['ABERTA', 'EM_ANDAMENTO', 'CONCLUIDA'];

export const ROTULO_TIPO: Record<TipoOcorrencia, string> = {
  POLUICAO: 'Poluição',
  QUEIMADA: 'Queimada',
  EMISSAO: 'Emissão',
  COMUNIDADE: 'Comunidade',
  NORMALIZACAO: 'Normalização',
};

export const ROTULO_STATUS_OC: Record<StatusOcorrencia, string> = { ABERTA: 'Em aberto', EM_ANDAMENTO: 'Em andamento', CONCLUIDA: 'Concluída' };

export const ROTULO_ORIGEM: Record<OrigemOcorrencia, string> = { AUTOMATICA: 'Registro automático', MANUAL: 'Registro manual' };

// Mesmas cores de severidade dos Alertas: em aberto vermelho, em andamento amarelo/laranja, concluída verde
export const TOM_STATUS: Record<StatusOcorrencia, string> = { ABERTA: 'critico', EM_ANDAMENTO: 'moderado', CONCLUIDA: 'resolvido' };

// Mudanças de status que o ADMIN pode pedir (o backend valida de novo: CONCLUIDA é final)
export const ACOES_STATUS: Record<StatusOcorrencia, { para: StatusOcorrencia; rotulo: string }[]> = {
  ABERTA: [
    { para: 'EM_ANDAMENTO', rotulo: 'Iniciar atendimento' },
    { para: 'CONCLUIDA', rotulo: 'Concluir ocorrência' },
  ],
  EM_ANDAMENTO: [{ para: 'CONCLUIDA', rotulo: 'Concluir ocorrência' }],
  CONCLUIDA: [],
};

export type FiltroStatusOc = 'TODOS' | StatusOcorrencia;
export type FiltroTipo = 'TODOS' | TipoOcorrencia;
export type FiltroPeriodo = 'TODOS' | 'HOJE' | '7D' | '30D';

export const OPCOES_PERIODO: { valor: FiltroPeriodo; rotulo: string }[] = [
  { valor: 'TODOS', rotulo: 'Todos' },
  { valor: 'HOJE', rotulo: 'Hoje' },
  { valor: '7D', rotulo: 'Últimos 7 dias' },
  { valor: '30D', rotulo: 'Últimos 30 dias' },
];

export const POR_PAGINA = 5;

// Mesmos limites validados pelo backend (services/ocorrencias.ts)
export const LIMITES_FORM = {
  titulo: { min: 3, max: 160 },
  descricao: { min: 3, max: 2000 },
  local: { min: 2, max: 160 },
  estacao: { max: 255 },
  busca: { max: 100 },
};

export interface FiltrosOcorrencias {
  busca: string;
  status: FiltroStatusOc;
  tipo: FiltroTipo;
  periodo: FiltroPeriodo;
}

export const FILTROS_PADRAO: FiltrosOcorrencias = { busca: '', status: 'TODOS', tipo: 'TODOS', periodo: 'TODOS' };

export const temFiltroAtivo = (f: FiltrosOcorrencias) => f.busca.trim() !== '' || f.status !== 'TODOS' || f.tipo !== 'TODOS' || f.periodo !== 'TODOS';

// ID numérico do banco apresentado como OC-0012 (a busca também entende esse formato)
export const formatarIdOcorrencia = (id: number) => `OC-${String(id).padStart(4, '0')}`;

const diaEmSaoPaulo = (data: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(data);

// Período escolhido -> datas AAAA-MM-DD (inclusivas) no fuso do backend. "Últimos N dias" conta o dia de hoje.
export function intervaloDoPeriodo(periodo: FiltroPeriodo, agora: Date = new Date()): { de?: string; ate?: string } {
  if (periodo === 'TODOS') return {};
  const dias = periodo === 'HOJE' ? 0 : periodo === '7D' ? 6 : 29;
  return { de: diaEmSaoPaulo(new Date(agora.getTime() - dias * 24 * 60 * 60_000)), ate: diaEmSaoPaulo(agora) };
}

// Linha do tempo: registrada -> em andamento -> concluída (só as etapas já alcançadas)
export function etapasDaOcorrencia(o: Ocorrencia): { etapa: StatusOcorrencia; dataHora: string }[] {
  const etapas: { etapa: StatusOcorrencia; dataHora: string }[] = [{ etapa: 'ABERTA', dataHora: o.criadoEm }];
  if (o.iniciadoEm) etapas.push({ etapa: 'EM_ANDAMENTO', dataHora: o.iniciadoEm });
  if (o.concluidoEm) etapas.push({ etapa: 'CONCLUIDA', dataHora: o.concluidoEm });
  return etapas;
}

// Páginas exibidas na paginação: sempre a primeira, a última e as vizinhas da atual; "gap-*" vira reticências
export function paginasVisiveis(atual: number, total: number): (number | string)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const fixas = new Set([1, total, atual - 1, atual, atual + 1]);
  const ordenadas = [...fixas].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const saida: (number | string)[] = [];
  ordenadas.forEach((p, i) => {
    if (i > 0 && p - ordenadas[i - 1] > 1) saida.push(`gap-${p}`);
    saida.push(p);
  });
  return saida;
}

export function partesDataHora(iso: string) {
  const d = new Date(iso);
  return {
    data: d.toLocaleDateString('pt-BR', { dateStyle: 'short' }),
    hora: d.toLocaleTimeString('pt-BR', { timeStyle: 'short' }),
  };
}

// ---------------------------------------------------------------- Erros da API
export type AcaoOcorrencia = 'carregar' | 'detalhar' | 'registrar' | 'alterar';

const MENSAGEM_PADRAO: Record<AcaoOcorrencia, string> = {
  carregar: 'Não foi possível carregar as ocorrências. Tente novamente.',
  detalhar: 'Não foi possível carregar os detalhes da ocorrência.',
  registrar: 'Não foi possível registrar a ocorrência. Tente novamente.',
  alterar: 'Não foi possível alterar o status da ocorrência. Tente novamente.',
};

export const statusDoErro = (erro: unknown): number | null => (axios.isAxiosError(erro) && erro.response ? erro.response.status : null);

// Traduz a resposta da API (400, 401, 403, 404, 409...) em texto para a tela. A mensagem do servidor só é repassada
// em 400 e 403, onde ela explica o que corrigir (campo inválido, cidade não permitida).
export function mensagemErroOcorrencia(erro: unknown, acao: AcaoOcorrencia): string {
  const status = statusDoErro(erro);
  const doServidor = axios.isAxiosError<{ error?: string }>(erro) ? erro.response?.data?.error : undefined;
  switch (status) {
    case 400:
      return doServidor ? `Dados inválidos: ${doServidor}` : 'Dados inválidos. Revise as informações e tente novamente.';
    case 401:
      return 'Sua sessão expirou. Entre novamente.';
    case 403:
      return doServidor || (acao === 'alterar' ? 'Somente administradores podem alterar o status.' : 'Você não tem permissão para esta ação.');
    case 404:
      return 'Ocorrência não encontrada. Ela pode ter sido removida.';
    case 409:
      return 'O status desta ocorrência já havia sido alterado. Os dados foram atualizados.';
    default:
      return MENSAGEM_PADRAO[acao];
  }
}
