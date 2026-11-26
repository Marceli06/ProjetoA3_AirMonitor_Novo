import { MedicaoAr, NivelAlerta } from '../types';
import { NIVEIS_ORDEM } from './alertas';

// Nível de cada poluente no Dashboard. Usa EXATAMENTE a classificação de Alertas (backend/src/data/limiaresAlertas.ts
// e services/alertas.ts → classificarValor): mesmos limiares técnicos PROVISÓRIOS, mesma regra "maior nível cujo limiar
// o valor atingiu" e só µg/m³ é comparado. Não há limiares novos nem IQA oficial.
// Esta tabela é uma cópia da do backend: se mudar lá, mude aqui (o teste ui:validate "niveis" compara as duas).
const LIMIARES: Record<string, Record<NivelAlerta, number>> = {
  pm25: { BAIXO: 15, MODERADO: 35, ALTO: 75, CRITICO: 125 },
  pm10: { BAIXO: 45, MODERADO: 100, ALTO: 150, CRITICO: 250 },
  o3: { BAIXO: 100, MODERADO: 130, ALTO: 160, CRITICO: 200 },
  no2: { BAIXO: 100, MODERADO: 200, ALTO: 240, CRITICO: 320 },
  co: { BAIXO: 5000, MODERADO: 10000, ALTO: 15000, CRITICO: 30000 },
  so2: { BAIXO: 40, MODERADO: 125, ALTO: 250, CRITICO: 500 },
};

// Mesma normalização do backend: aceita µg/m³, μg/m³ (mu grego), ug/m3 e variações de espaço
const normalizarUnidade = (unidade: string) =>
  unidade.trim().toLowerCase().replace(/[µμ]/g, 'u').replace(/\s+/g, '').replace(/³/g, '3');

const unidadeCompativel = (unidade: string | null) => unidade !== null && normalizarUnidade(unidade) === 'ug/m3';

// Nível exibido de uma medição, ou null quando ela não pode ser classificada: sem valor, valor inválido, unidade diferente
// de µg/m³ (ex.: CO em ppm) ou dado desatualizado (a avaliação de alertas também ignora dado desatualizado).
// Abaixo do limiar de BAIXO o backend não gera alerta; aqui o valor aparece como BAIXO (o menor nível).
export function nivelDaMedicao(medicao: MedicaoAr | undefined): NivelAlerta | null {
  if (!medicao || !medicao.disponivel || medicao.fonte === null || medicao.valor === null || medicao.desatualizada) return null;
  if (!Object.prototype.hasOwnProperty.call(LIMIARES, medicao.chave)) return null;
  if (!Number.isFinite(medicao.valor) || medicao.valor < 0 || !unidadeCompativel(medicao.unidade)) return null;
  const limiares = LIMIARES[medicao.chave];
  let nivel: NivelAlerta = 'BAIXO';
  for (const candidato of NIVEIS_ORDEM) {
    if (medicao.valor >= limiares[candidato]) nivel = candidato;
  }
  return nivel;
}

// Motivo de uma medição com valor não ter nível (texto do selo "Sem nível")
export const motivoSemNivel = (medicao: MedicaoAr) =>
  medicao.desatualizada ? 'Dado desatualizado: nível não calculado' : 'Unidade diferente de µg/m³: nível não calculado';

// Situação geral = maior nível entre os poluentes avaliáveis; null se nenhum pôde ser avaliado (dados insuficientes)
export function situacaoGeral(niveis: (NivelAlerta | null)[]): NivelAlerta | null {
  const avaliados = niveis.filter((n): n is NivelAlerta => n !== null);
  if (avaliados.length === 0) return null;
  return avaliados.reduce((maior, atual) => (NIVEIS_ORDEM.indexOf(atual) > NIVEIS_ORDEM.indexOf(maior) ? atual : maior));
}
