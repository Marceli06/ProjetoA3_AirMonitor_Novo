import { FonteHistorico, PeriodoHistorico, PontoHistorico } from '../types';
import { statusDoErro } from './ocorrencias';

// Constantes, escalas do gráfico e mensagens de erro da tela de Histórico. Os dados em si vêm todos de /api/historico.

export const POR_PAGINA_HIST = 10;

export const OPCOES_PERIODO_HIST: { valor: PeriodoHistorico; rotulo: string }[] = [
  { valor: '24H', rotulo: 'Últimas 24 horas' },
  { valor: '7D', rotulo: 'Últimos 7 dias' },
  { valor: '30D', rotulo: 'Últimos 30 dias' },
];

export const OPCOES_FONTE_HIST: { valor: FonteHistorico; rotulo: string }[] = [
  { valor: 'AUTO', rotulo: 'Automática' },
  { valor: 'OPENAQ', rotulo: 'Estação (OpenAQ)' },
  { valor: 'OPEN_METEO', rotulo: 'Modelo (Open-Meteo)' },
];

export const ROTULO_ORIGEM_HIST = { OPENAQ: 'Estação · OpenAQ', OPEN_METEO: 'Modelo · Open-Meteo' } as const;
export const COR_ORIGEM_HIST = { OPENAQ: '#0b3b8c', OPEN_METEO: '#6b4fbb' } as const;

// A série é horária: uma lacuna maior que isso entre dois pontos interrompe a linha (nada é interpolado)
export const LACUNA_MAXIMA_MS = 90 * 60 * 1000;

// Divide a série (cronológica) em trechos contínuos
export function trechosContinuos(pontos: PontoHistorico[]): PontoHistorico[][] {
  const trechos: PontoHistorico[][] = [];
  let atual: PontoHistorico[] = [];
  for (const p of pontos) {
    const anterior = atual[atual.length - 1];
    if (anterior && Date.parse(p.dataHora) - Date.parse(anterior.dataHora) > LACUNA_MAXIMA_MS) {
      trechos.push(atual);
      atual = [];
    }
    atual.push(p);
  }
  if (atual.length > 0) trechos.push(atual);
  return trechos;
}

// Eixo Y de 0 até um máximo "redondo" com divisões de 1, 2, 2,5 ou 5 (x 10^n)
export function escalaDoEixo(maximo: number, divisoes = 4): { max: number; ticks: number[] } {
  if (!(maximo > 0)) return { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const bruto = maximo / divisoes;
  const potencia = Math.pow(10, Math.floor(Math.log10(bruto)));
  const fracao = bruto / potencia;
  const passo = (fracao <= 1 ? 1 : fracao <= 2 ? 2 : fracao <= 2.5 ? 2.5 : fracao <= 5 ? 5 : 10) * potencia;
  const max = Math.ceil(maximo / passo) * passo;
  const ticks: number[] = [];
  for (let v = 0; v <= max + passo / 1000; v += passo) ticks.push(Number(v.toFixed(6)));
  return { max, ticks };
}

// Ponto mais próximo (no tempo) de um instante, por busca binária na série ordenada
export function indiceMaisProximo(pontos: PontoHistorico[], instante: number): number {
  let baixo = 0;
  let alto = pontos.length - 1;
  while (baixo < alto) {
    const meio = (baixo + alto) >> 1;
    if (Date.parse(pontos[meio].dataHora) < instante) baixo = meio + 1;
    else alto = meio;
  }
  if (baixo > 0 && instante - Date.parse(pontos[baixo - 1].dataHora) < Date.parse(pontos[baixo].dataHora) - instante) return baixo - 1;
  return baixo;
}

export const rotuloEixoX = (instante: number, periodo: PeriodoHistorico) =>
  periodo === '24H'
    ? new Date(instante).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : new Date(instante).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

export function mensagemErroHistorico(erro: unknown): string {
  const codigo = statusDoErro(erro);
  const doServidor = (erro as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  const texto = typeof doServidor === 'string' && doServidor ? doServidor : null;
  if (codigo === undefined) return 'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.';
  if (codigo === 400 || codigo === 403) return texto ?? 'Consulta não permitida.';
  if (codigo === 401) return 'Sua sessão expirou. Entre novamente.';
  if (codigo === 404) return 'Estação não encontrada para esta cidade e poluente.';
  if (codigo === 429) return 'O limite de consultas às fontes de dados foi atingido. Tente novamente em instantes.';
  if (codigo === 502 || codigo === 503 || codigo === 504) return texto ? `${texto}. Tente novamente em instantes.` : 'As fontes de dados estão indisponíveis no momento.';
  return 'Não foi possível carregar o histórico. Tente novamente.';
}
