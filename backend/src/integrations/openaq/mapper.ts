import { OpenAQLatest, OpenAQLocation } from './types';

// Poluentes tratados nesta etapa. `chave` é o nome do parâmetro na OpenAQ; `nome` é o rótulo do AirMonitor.
export const POLUENTES = [
  { chave: 'pm25', nome: 'PM2.5', descricao: 'Material particulado fino' },
  { chave: 'pm10', nome: 'PM10', descricao: 'Material particulado' },
  { chave: 'o3', nome: 'O₃', descricao: 'Ozônio' },
  { chave: 'no2', nome: 'NO₂', descricao: 'Dióxido de nitrogênio' },
  { chave: 'co', nome: 'CO', descricao: 'Monóxido de carbono' },
  { chave: 'so2', nome: 'SO₂', descricao: 'Dióxido de enxofre' },
] as const;

// Medições mais antigas que isso continuam sendo devolvidas, mas marcadas como desatualizadas
export const LIMITE_DEFASAGEM_HORAS = 6;

export interface PoluenteDaEstacao {
  chave: string;
  nome: string;
  sensorId: number;
  unidade: string;
}

export interface Estacao {
  id: number;
  nome: string | null;
  localidade: string | null;
  latitude: number | null;
  longitude: number | null;
  distanciaMetros: number | null;
  pais: string | null;
  fuso: string | null;
  estacaoDeReferencia: boolean;
  movel: boolean;
  ultimaMedicaoEm: string | null;
  poluentes: PoluenteDaEstacao[];
}

export type MotivoIndisponivel = 'sem_sensor' | 'sem_medicao' | 'valor_invalido';

export interface Medicao {
  chave: string;
  nome: string;
  disponivel: boolean;
  valor: number | null;
  unidade: string | null;
  medidoEm: string | null;
  desatualizada: boolean | null;
  sensorId: number | null;
  motivo: MotivoIndisponivel | null;
}

export interface UltimasMedicoes {
  estacao: Estacao;
  atualizadoEm: string | null;
  medicoes: Medicao[];
  fonte: 'OpenAQ';
}

const numeroOuNull = (valor: unknown) => (typeof valor === 'number' && Number.isFinite(valor) ? valor : null);

export function mapEstacao(loc: OpenAQLocation): Estacao {
  const poluentes: PoluenteDaEstacao[] = [];

  for (const poluente of POLUENTES) {
    const sensor = (loc.sensors || []).find((s) => s?.parameter?.name === poluente.chave);
    if (sensor) {
      poluentes.push({ chave: poluente.chave, nome: poluente.nome, sensorId: sensor.id, unidade: sensor.parameter.units });
    }
  }

  return {
    id: loc.id,
    nome: loc.name ?? null,
    localidade: loc.locality ?? null,
    latitude: numeroOuNull(loc.coordinates?.latitude),
    longitude: numeroOuNull(loc.coordinates?.longitude),
    distanciaMetros: numeroOuNull(loc.distance),
    pais: loc.country?.name ?? null,
    fuso: loc.timezone ?? null,
    estacaoDeReferencia: Boolean(loc.isMonitor),
    movel: Boolean(loc.isMobile),
    ultimaMedicaoEm: loc.datetimeLast?.utc ?? null,
    poluentes,
  };
}

const indisponivel = (chave: string, nome: string, motivo: MotivoIndisponivel): Medicao => ({
  chave,
  nome,
  disponivel: false,
  valor: null,
  unidade: null,
  medidoEm: null,
  desatualizada: null,
  sensorId: null,
  motivo,
});

// Cruza os valores recentes (identificados só por sensorsId) com os sensores da localização.
// Nunca preenche valor ausente: poluente sem dado volta como indisponível, com o motivo.
export function mapUltimasMedicoes(loc: OpenAQLocation, ultimas: OpenAQLatest[], agora = new Date()): UltimasMedicoes {
  const estacao = mapEstacao(loc);
  const limiteMs = LIMITE_DEFASAGEM_HORAS * 60 * 60 * 1000;

  const medicoes: Medicao[] = POLUENTES.map(({ chave, nome }) => {
    const sensores = (loc.sensors || []).filter((s) => s?.parameter?.name === chave);
    if (sensores.length === 0) return indisponivel(chave, nome, 'sem_sensor');

    const doPoluente = ultimas.filter((u) => sensores.some((s) => s.id === u.sensorsId));
    if (doPoluente.length === 0) return indisponivel(chave, nome, 'sem_medicao');

    // Valores negativos ou não numéricos são erro de sensor: não são exibidos
    const validas = doPoluente
      .map((u) => ({ u, instante: new Date(u.datetime?.utc).getTime() }))
      .filter(({ u, instante }) => typeof u.value === 'number' && Number.isFinite(u.value) && u.value >= 0 && !Number.isNaN(instante));
    if (validas.length === 0) return indisponivel(chave, nome, 'valor_invalido');

    // Com mais de um sensor do mesmo poluente, vale o mais recente
    const maisRecente = validas.reduce((a, b) => (b.instante > a.instante ? b : a));
    const sensor = sensores.find((s) => s.id === maisRecente.u.sensorsId)!;

    return {
      chave,
      nome,
      disponivel: true,
      valor: maisRecente.u.value,
      unidade: sensor.parameter.units,
      medidoEm: new Date(maisRecente.instante).toISOString(),
      desatualizada: agora.getTime() - maisRecente.instante > limiteMs,
      sensorId: sensor.id,
      motivo: null,
    };
  });

  const instantes = medicoes.filter((m) => m.medidoEm).map((m) => new Date(m.medidoEm!).getTime());
  const atualizadoEm = instantes.length > 0 ? new Date(Math.max(...instantes)).toISOString() : null;

  return { estacao, atualizadoEm, medicoes, fonte: 'OpenAQ' };
}
