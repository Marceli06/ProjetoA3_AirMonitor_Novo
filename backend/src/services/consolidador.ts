import { Estacao, LIMITE_DEFASAGEM_HORAS, MotivoIndisponivel, POLUENTES, UltimasMedicoes } from '../integrations/openaq/mapper';
import { DadosOpenMeteo, ValorOpenMeteo } from '../integrations/openmeteo/mapper';

export type Fonte = 'OPENAQ' | 'OPEN_METEO';
// MEDICAO: sensor de uma estação (OpenAQ). MODELO: estimativa do modelo CAMS (Open-Meteo), não é medição local.
export type TipoDado = 'MEDICAO' | 'MODELO';
export type MotivoFallback = 'sem_dado_open_meteo' | 'falha_open_meteo' | 'sem_coordenadas';

// Resultado da tentativa de usar a Open-Meteo. Nunca carrega exceção: falha vira status.
export type ResultadoOpenMeteo =
  | { status: 'nao_necessaria' | 'falha' | 'sem_coordenadas' }
  | { status: 'ok'; dados: DadosOpenMeteo };

export interface MedicaoConsolidada {
  chave: string;
  poluente: string;
  disponivel: boolean;
  valor: number | null;
  unidade: string | null;
  dataHora: string | null;
  fonte: Fonte | null;
  tipoDado: TipoDado | null;
  desatualizada: boolean | null;
  sensorId: number | null; // só para OPENAQ
  // Por que a OpenAQ não forneceu dado atual ('openaq_indisponivel': a OpenAQ inteira falhou na consulta)
  motivo: MotivoIndisponivel | 'openaq_indisponivel' | null;
  motivoFallback: MotivoFallback | null; // por que a Open-Meteo não resolveu (quando foi necessária)
}

export interface UltimasMedicoesConsolidadas {
  estacao: Estacao;
  atualizadoEm: string | null;
  medicoes: MedicaoConsolidada[];
  fontesUtilizadas: Fonte[];
  statusFontes: {
    OPENAQ: 'ok' | 'falha';
    OPEN_METEO: ResultadoOpenMeteo['status'];
    erroOpenAQ: string | null; // tipo da falha (timeout, rate_limit, unavailable) quando OPENAQ = 'falha'
  };
  atribuicoes: string[];
}

// Exigência da licença CC BY 4.0 da Open-Meteo: o frontend deve exibir quando houver dado dela
export const ATRIBUICAO_OPEN_METEO = 'Dados de modelo (CAMS / Copernicus) fornecidos por Open-Meteo.com, licença CC BY 4.0';

// A Open-Meteo só é consultada se algum poluente da OpenAQ estiver ausente ou desatualizado
export const precisaDeFallback = (openaq: UltimasMedicoes) =>
  openaq.medicoes.some((m) => !m.disponivel || m.desatualizada === true);

const motivoDoFallback = (openMeteo: ResultadoOpenMeteo): MotivoFallback | null => {
  if (openMeteo.status === 'falha') return 'falha_open_meteo';
  if (openMeteo.status === 'sem_coordenadas') return 'sem_coordenadas';
  if (openMeteo.status === 'ok') return 'sem_dado_open_meteo';
  return null;
};

type Base = { chave: string; poluente: string };

const daOpenAQ = (base: Base, m: UltimasMedicoes['medicoes'][number], desatualizada: boolean, motivoFallback: MotivoFallback | null): MedicaoConsolidada => ({
  ...base,
  disponivel: true,
  valor: m.valor,
  unidade: m.unidade,
  dataHora: m.medidoEm,
  fonte: 'OPENAQ',
  tipoDado: 'MEDICAO',
  desatualizada,
  sensorId: m.sensorId,
  motivo: null,
  motivoFallback,
});

const daOpenMeteo = (base: Base, alternativa: ValorOpenMeteo, motivo: MedicaoConsolidada['motivo'], agora: Date): MedicaoConsolidada => ({
  ...base,
  disponivel: true,
  valor: alternativa.valor,
  unidade: alternativa.unidade,
  dataHora: alternativa.dataHora,
  fonte: 'OPEN_METEO',
  tipoDado: 'MODELO',
  desatualizada: agora.getTime() - Date.parse(alternativa.dataHora) > LIMITE_DEFASAGEM_HORAS * 60 * 60 * 1000,
  sensorId: null,
  motivo,
  motivoFallback: null,
});

const semDado = (base: Base, motivo: MedicaoConsolidada['motivo'], motivoFallback: MotivoFallback | null): MedicaoConsolidada => ({
  ...base,
  disponivel: false,
  valor: null,
  unidade: null,
  dataHora: null,
  fonte: null,
  tipoDado: null,
  desatualizada: null,
  sensorId: null,
  motivo,
  motivoFallback,
});

function montarResultado(
  estacao: Estacao,
  medicoes: MedicaoConsolidada[],
  openMeteo: ResultadoOpenMeteo,
  erroOpenAQ: string | null
): UltimasMedicoesConsolidadas {
  const fontesUtilizadas = (['OPENAQ', 'OPEN_METEO'] as Fonte[]).filter((fonte) =>
    medicoes.some((m) => m.disponivel && m.fonte === fonte)
  );
  const instantes = medicoes.filter((m) => m.dataHora).map((m) => Date.parse(m.dataHora!));

  return {
    estacao,
    atualizadoEm: instantes.length > 0 ? new Date(Math.max(...instantes)).toISOString() : null,
    medicoes,
    fontesUtilizadas,
    statusFontes: { OPENAQ: erroOpenAQ ? 'falha' : 'ok', OPEN_METEO: openMeteo.status, erroOpenAQ },
    atribuicoes: fontesUtilizadas.includes('OPEN_METEO') ? [ATRIBUICAO_OPEN_METEO] : [],
  };
}

// Decide a fonte de CADA poluente, individualmente:
//   OpenAQ atual                       -> OpenAQ
//   OpenAQ ausente/desatualizada       -> Open-Meteo, se ela tiver valor válido (e mais recente)
//   sem alternativa                    -> mantém a OpenAQ desatualizada (sinalizada) ou fica indisponível
export function consolidar(openaq: UltimasMedicoes, openMeteo: ResultadoOpenMeteo, agora = new Date()): UltimasMedicoesConsolidadas {
  const medicoes = openaq.medicoes.map((m): MedicaoConsolidada => {
    const base = { chave: m.chave, poluente: m.nome };

    if (m.disponivel && !m.desatualizada) return daOpenAQ(base, m, false, null);

    const alternativa = openMeteo.status === 'ok' ? openMeteo.dados.valores[m.chave] : undefined;
    if (alternativa && (!m.disponivel || Date.parse(alternativa.dataHora) > Date.parse(m.medidoEm!))) {
      return daOpenMeteo(base, alternativa, m.motivo, agora);
    }

    // A Open-Meteo não resolveu: o dado válido (porém antigo) da OpenAQ não é descartado
    if (m.disponivel) return daOpenAQ(base, m, true, motivoDoFallback(openMeteo));

    return semDado(base, m.motivo, motivoDoFallback(openMeteo));
  });

  return montarResultado(openaq.estacao, medicoes, openMeteo, null);
}

// OpenAQ inteira indisponível (timeout, rate limit, 5xx): tudo o que existir vem da Open-Meteo,
// na coordenada da estação já conhecida. O que a Open-Meteo não tiver fica indisponível.
export function consolidarSemOpenAQ(
  estacao: Estacao,
  erroOpenAQ: string,
  openMeteo: ResultadoOpenMeteo,
  agora = new Date()
): UltimasMedicoesConsolidadas {
  const medicoes = POLUENTES.map(({ chave, nome }): MedicaoConsolidada => {
    const base = { chave, poluente: nome };
    const alternativa = openMeteo.status === 'ok' ? openMeteo.dados.valores[chave] : undefined;
    return alternativa
      ? daOpenMeteo(base, alternativa, 'openaq_indisponivel', agora)
      : semDado(base, 'openaq_indisponivel', motivoDoFallback(openMeteo));
  });

  return montarResultado(estacao, medicoes, openMeteo, erroOpenAQ);
}
