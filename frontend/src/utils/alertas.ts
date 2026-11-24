import { AlertaAr, NivelAlerta, StatusAlerta, TipoDadoAlerta } from '../types';
import { POLLUTANTS } from './formatar';

// Helpers da tela de Alertas (dados reais de /api/alertas). Os níveis dependem de limiares técnicos PROVISÓRIOS.

export const NIVEIS_ORDEM: NivelAlerta[] = ['BAIXO', 'MODERADO', 'ALTO', 'CRITICO'];

export const ROTULO_NIVEL: Record<NivelAlerta, string> = { BAIXO: 'Baixo', MODERADO: 'Moderado', ALTO: 'Alto', CRITICO: 'Crítico' };

export const ROTULO_STATUS: Record<StatusAlerta, string> = { ATIVO: 'Ativo', RESOLVIDO: 'Resolvido' };

export type FiltroStatus = 'TODOS' | StatusAlerta;

// Alerta resolvido tem sempre o visual verde, qualquer que tenha sido o nível
export const tomDoAlerta = (alerta: Pick<AlertaAr, 'nivel' | 'status'>) =>
  alerta.status === 'RESOLVIDO' ? 'resolvido' : alerta.nivel.toLowerCase();

// Uma estimativa de modelo nunca é apresentada como medição de estação
export const rotuloOrigem = (tipo: TipoDadoAlerta) => (tipo === 'MEDICAO' ? 'Medição de estação' : 'Estimativa por modelo');

export const rotuloValor = (tipo: TipoDadoAlerta) => (tipo === 'MEDICAO' ? 'valor medido na estação' : 'valor estimado pelo modelo');

export const nomeDaEstacaoDoAlerta = (alerta: Pick<AlertaAr, 'estacaoNome' | 'estacaoId' | 'tipoDado'>) =>
  alerta.estacaoNome?.trim() || (alerta.tipoDado === 'MODELO' ? ESTACAO_MODELO : `Estação ${alerta.estacaoId}`);

// Estação exibida quando o alerta de modelo não traz o nome da estação
const ESTACAO_MODELO = 'Modelo CAMS (Open-Meteo)';

// ---------------------------------------------------------------- Resumo e formatação
export interface ResumoAlertas {
  ativos: number;
  alta: number;
  media: number;
  resolvidos: number;
  ativosPorNivel: Record<NivelAlerta, number>;
  maisGrave: NivelAlerta | null;
}

// Os totais vêm da API; os níveis, da lista completa de alertas ativos da cidade
export function resumirAlertas(ativos: Pick<AlertaAr, 'nivel'>[], totalAtivos: number, totalResolvidos: number): ResumoAlertas {
  const ativosPorNivel: Record<NivelAlerta, number> = { BAIXO: 0, MODERADO: 0, ALTO: 0, CRITICO: 0 };
  for (const a of ativos) ativosPorNivel[a.nivel] += 1;
  const maisGrave = [...NIVEIS_ORDEM].reverse().find((n) => ativosPorNivel[n] > 0) ?? null;
  // Alta prioridade = crítico + alto; média prioridade = moderado (somente alertas ativos)
  return {
    ativos: totalAtivos,
    alta: ativosPorNivel.ALTO + ativosPorNivel.CRITICO,
    media: ativosPorNivel.MODERADO,
    resolvidos: totalResolvidos,
    ativosPorNivel,
    maisGrave,
  };
}

export const nomePoluente = (chave: string) => POLLUTANTS.find((p) => p.chave === chave)?.name ?? chave.toUpperCase();

export const formatarValorAlerta = (valor: number) =>
  valor.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function tempoRelativo(iso: string, agora: Date) {
  const minutos = Math.max(0, Math.round((agora.getTime() - Date.parse(iso)) / 60_000));
  if (minutos < 1) return 'agora';
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas >= 48) return `há ${Math.floor(horas / 24)} dias`;
  const resto = minutos % 60;
  return resto ? `há ${horas} h ${resto} min` : `há ${horas} h`;
}
