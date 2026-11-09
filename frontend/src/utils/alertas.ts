import { AlertaAr, NivelAlerta, OrigemAlerta, StatusAlerta } from '../types';

// Alertas ILUSTRATIVOS da tela de Alertas. Ainda não existe geração automática, limiares definitivos nem
// persistência: estes dados só alimentam a interface e serão trocados por uma API em etapa futura.

export const NIVEIS_ORDEM: NivelAlerta[] = ['BAIXO', 'MODERADO', 'ALTO', 'CRITICO'];

export const ROTULO_NIVEL: Record<NivelAlerta, string> = { BAIXO: 'Baixo', MODERADO: 'Moderado', ALTO: 'Alto', CRITICO: 'Crítico' };

export const ROTULO_STATUS: Record<StatusAlerta, string> = { ATIVO: 'Ativo', RESOLVIDO: 'Resolvido' };

export type FiltroStatus = 'TODOS' | StatusAlerta;

// Alerta resolvido tem sempre o visual verde, qualquer que tenha sido o nível
export const tomDoAlerta = (alerta: Pick<AlertaAr, 'nivel' | 'status'>) =>
  alerta.status === 'RESOLVIDO' ? 'resolvido' : alerta.nivel.toLowerCase();

// ---------------------------------------------------------------- Dados de protótipo
interface ModeloAlerta {
  id: string;
  poluente: string;
  titulo: string;
  descricao: string;
  detalhe: string;
  valor: number;
  unidade: string;
  nivel: NivelAlerta;
  status: StatusAlerta;
  minutosAtras: number;
  origem: OrigemAlerta;
  estacao: number;
}

const UG = 'µg/m³';

const PM25_CRITICO: ModeloAlerta = {
  id: 'pm25', poluente: 'pm25', titulo: 'PM2.5 elevado', valor: 85.4, unidade: UG, nivel: 'CRITICO', status: 'ATIVO',
  descricao: 'A concentração de PM2.5 ultrapassou o nível definido para atenção.',
  detalhe: 'A concentração de PM2.5 está muito acima do limite recomendado, podendo aumentar o risco de problemas respiratórios, especialmente em crianças, idosos e pessoas com doenças pulmonares.',
  minutosAtras: 10, origem: 'OPENAQ', estacao: 0,
};

const O3_ALTO: ModeloAlerta = {
  id: 'o3', poluente: 'o3', titulo: 'O₃ (Ozônio) em nível alto', valor: 70.1, unidade: UG, nivel: 'ALTO', status: 'ATIVO',
  descricao: 'O nível de ozônio está acima do recomendado, podendo causar desconforto respiratório.',
  detalhe: 'O ozônio acima do recomendado pode causar tosse, irritação na garganta e desconforto respiratório, principalmente durante atividades físicas ao ar livre.',
  minutosAtras: 20, origem: 'OPENAQ', estacao: 1,
};

const NO2_MODERADO: ModeloAlerta = {
  id: 'no2', poluente: 'no2', titulo: 'NO₂ (Dióxido de Nitrogênio) em nível moderado', valor: 42.7, unidade: UG, nivel: 'MODERADO', status: 'ATIVO',
  descricao: 'A concentração de NO₂ está em nível moderado. Pessoas sensíveis devem redobrar a atenção.',
  detalhe: 'O NO₂ em nível moderado pode agravar sintomas de asma e de outras doenças respiratórias em pessoas sensíveis. A maioria da população não deve sentir efeitos.',
  minutosAtras: 30, origem: 'OPENAQ', estacao: 2,
};

const SO2_NORMALIZADO: ModeloAlerta = {
  id: 'so2', poluente: 'so2', titulo: 'SO₂ (Dióxido de Enxofre) normalizado', valor: 7.5, unidade: UG, nivel: 'BAIXO', status: 'RESOLVIDO',
  descricao: 'Os níveis de SO₂ retornaram à faixa considerada segura.',
  detalhe: 'Os níveis de SO₂ voltaram à faixa considerada segura e o alerta foi encerrado.',
  minutosAtras: 160, origem: 'OPEN_METEO', estacao: 3,
};

const PM10_NORMALIZADO: ModeloAlerta = {
  id: 'pm10', poluente: 'pm10', titulo: 'PM10 normalizado', valor: 38, unidade: UG, nivel: 'BAIXO', status: 'RESOLVIDO',
  descricao: 'A concentração de PM10 voltou aos níveis adequados.',
  detalhe: 'A concentração de PM10 voltou aos níveis adequados e o alerta foi encerrado.',
  minutosAtras: 225, origem: 'OPENAQ', estacao: 4,
};

type Cenario = 'CRITICO' | 'MODERADO' | 'CALMO';

const CENARIOS: Record<Cenario, ModeloAlerta[]> = {
  // Igual ao protótipo aprovado: 3 ativos (crítico, alto, moderado) e 2 resolvidos
  CRITICO: [PM25_CRITICO, O3_ALTO, NO2_MODERADO, SO2_NORMALIZADO, PM10_NORMALIZADO],
  // Só situações moderadas ativas
  MODERADO: [
    { ...NO2_MODERADO, valor: 41.3, minutosAtras: 15, origem: 'OPEN_METEO', estacao: 1 },
    {
      id: 'pm10', poluente: 'pm10', titulo: 'PM10 em nível moderado', valor: 62.8, unidade: UG, nivel: 'MODERADO', status: 'ATIVO',
      descricao: 'A concentração de PM10 está em nível moderado. Pessoas sensíveis devem redobrar a atenção.',
      detalhe: 'O PM10 em nível moderado pode causar irritação nos olhos e na garganta em pessoas sensíveis.',
      minutosAtras: 45, origem: 'OPENAQ', estacao: 0,
    },
    {
      ...O3_ALTO, titulo: 'O₃ (Ozônio) normalizado', valor: 58, nivel: 'BAIXO', status: 'RESOLVIDO', minutosAtras: 140, estacao: 2,
      descricao: 'Os níveis de O₃ retornaram à faixa considerada segura.',
      detalhe: 'Os níveis de O₃ voltaram à faixa considerada segura e o alerta foi encerrado.',
    },
    { ...PM25_CRITICO, titulo: 'PM2.5 normalizado', valor: 14.2, nivel: 'BAIXO', status: 'RESOLVIDO', minutosAtras: 300, estacao: 3,
      descricao: 'A concentração de PM2.5 voltou aos níveis adequados.',
      detalhe: 'A concentração de PM2.5 voltou aos níveis adequados e o alerta foi encerrado.',
    },
  ],
  // Nenhum alerta ativo: só histórico recente resolvido
  CALMO: [
    { ...O3_ALTO, titulo: 'O₃ (Ozônio) normalizado', valor: 61, nivel: 'BAIXO', status: 'RESOLVIDO', minutosAtras: 190, origem: 'OPEN_METEO', estacao: 0,
      descricao: 'Os níveis de O₃ retornaram à faixa considerada segura.',
      detalhe: 'Os níveis de O₃ voltaram à faixa considerada segura e o alerta foi encerrado.',
    },
    { ...PM25_CRITICO, titulo: 'PM2.5 normalizado', valor: 16.5, nivel: 'BAIXO', status: 'RESOLVIDO', minutosAtras: 320, estacao: 1,
      descricao: 'A concentração de PM2.5 voltou aos níveis adequados.',
      detalhe: 'A concentração de PM2.5 voltou aos níveis adequados e o alerta foi encerrado.',
    },
  ],
};

const CENARIO_POR_CIDADE: Record<string, Cenario> = {
  'Campinas': 'CRITICO',
  'São Paulo': 'CRITICO',
  'Guarulhos': 'CRITICO',
  'Osasco': 'CRITICO',
  'São Bernardo do Campo': 'MODERADO',
  'Santo André': 'MODERADO',
  'Mauá': 'MODERADO',
  'Ribeirão Preto': 'MODERADO',
  'Sorocaba': 'CALMO',
  'São José dos Campos': 'CALMO',
};

const ESTACOES_CAMPINAS = ['Campinas-Centro', 'Campinas-Taquaral', 'Campinas-V.União', 'Paulínia-Sul', 'Paulínia-Sta Terezinha'];
const ESTACAO_MODELO = 'Modelo CAMS (Open-Meteo)';

const nomeDaEstacao = (cidade: string, regioes: string[], indice: number) =>
  cidade === 'Campinas'
    ? ESTACOES_CAMPINAS[indice % ESTACOES_CAMPINAS.length]
    : `${cidade}-${regioes.length ? regioes[indice % regioes.length] : 'Centro'}`;

// Alertas de exemplo da cidade, com horários relativos a "agora" (a hora da última atualização)
export function gerarAlertasIlustrativos(cidade: string, regioes: string[], agora: Date): AlertaAr[] {
  const modelos = CENARIOS[CENARIO_POR_CIDADE[cidade] ?? 'MODERADO'];
  return modelos.map((m) => ({
    id: `${cidade}-${m.id}`,
    poluente: m.poluente,
    titulo: m.titulo,
    descricao: m.descricao,
    detalhe: m.detalhe,
    valor: m.valor,
    unidade: m.unidade,
    nivel: m.nivel,
    status: m.status,
    cidade,
    estacao: m.origem === 'OPEN_METEO' ? ESTACAO_MODELO : nomeDaEstacao(cidade, regioes, m.estacao),
    dataHora: new Date(agora.getTime() - m.minutosAtras * 60_000).toISOString(),
    origem: m.origem,
  }));
}

// ---------------------------------------------------------------- Resumo, filtros e formatação
export interface ResumoAlertas {
  ativos: number;
  alta: number;
  media: number;
  resolvidos: number;
  ativosPorNivel: Record<NivelAlerta, number>;
  maisGrave: NivelAlerta | null;
}

export function resumirAlertas(alertas: AlertaAr[]): ResumoAlertas {
  const ativosPorNivel: Record<NivelAlerta, number> = { BAIXO: 0, MODERADO: 0, ALTO: 0, CRITICO: 0 };
  let resolvidos = 0;
  for (const a of alertas) {
    if (a.status === 'ATIVO') ativosPorNivel[a.nivel] += 1;
    else resolvidos += 1;
  }
  const ativos = alertas.length - resolvidos;
  const maisGrave = [...NIVEIS_ORDEM].reverse().find((n) => ativosPorNivel[n] > 0) ?? null;
  // Alta prioridade = crítico + alto; média prioridade = moderado (somente alertas ativos)
  return { ativos, alta: ativosPorNivel.ALTO + ativosPorNivel.CRITICO, media: ativosPorNivel.MODERADO, resolvidos, ativosPorNivel, maisGrave };
}

// Ativos primeiro, do mais grave ao menos grave e, em empate, do mais recente ao mais antigo
export const ordenarAlertas = (alertas: AlertaAr[]) =>
  [...alertas].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'ATIVO' ? -1 : 1;
    const porNivel = NIVEIS_ORDEM.indexOf(b.nivel) - NIVEIS_ORDEM.indexOf(a.nivel);
    return porNivel || Date.parse(b.dataHora) - Date.parse(a.dataHora);
  });

// Sem nível selecionado, todos os níveis passam
export const filtrarAlertas = (alertas: AlertaAr[], status: FiltroStatus, niveis: NivelAlerta[]) =>
  alertas.filter((a) => (status === 'TODOS' || a.status === status) && (niveis.length === 0 || niveis.includes(a.nivel)));

export const formatarValorAlerta = (valor: number) =>
  valor.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function tempoRelativo(iso: string, agora: Date) {
  const minutos = Math.max(0, Math.round((agora.getTime() - Date.parse(iso)) / 60_000));
  if (minutos < 1) return 'agora';
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  return resto ? `há ${horas} h ${resto} min` : `há ${horas} h`;
}
