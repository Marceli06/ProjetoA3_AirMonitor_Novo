// =====================================================================================================
// LIMIARES DE ALERTA — PARÂMETROS TÉCNICOS PROVISÓRIOS
//
// O projeto não define limites oficiais de concentração por poluente (nenhuma norma, resolução ou
// tabela de faixas foi adotada até aqui). Os valores abaixo existem apenas para que a arquitetura de
// alertas funcione e possa ser testada. Eles NÃO são limites oficiais, NÃO foram validados por
// nenhum órgão e NÃO devem ser apresentados como tal.
//
// PENDENTE (decisão da equipe): definir a norma/tabela de referência, os valores finais e se a
// unidade de referência continua sendo µg/m³. Basta editar esta tabela: o restante do código
// (serviço, rotas, banco) não contém limiares.
//
// Regra de uso: o nível de um valor é o MAIOR nível cujo limiar ele atingiu (valor >= limiar).
// Valor abaixo do limiar de BAIXO não gera alerta.
// Todos os limiares estão em µg/m³; valores em outra unidade nunca são comparados (ver services/alertas.ts).
// =====================================================================================================

export type NivelAlerta = 'BAIXO' | 'MODERADO' | 'ALTO' | 'CRITICO';

// Do menos para o mais grave
export const NIVEIS_ALERTA: readonly NivelAlerta[] = ['BAIXO', 'MODERADO', 'ALTO', 'CRITICO'];

// Enquanto for true, as respostas da API avisam que os limiares ainda não são oficiais
export const LIMIARES_PROVISORIOS = true;

export const UNIDADE_DOS_LIMIARES = 'µg/m³';

// Chave do poluente (a mesma usada em integrations/openaq/mapper.ts) -> limiar mínimo de cada nível
export const LIMIARES: Record<string, Record<NivelAlerta, number>> = {
  pm25: { BAIXO: 15, MODERADO: 35, ALTO: 75, CRITICO: 125 },
  pm10: { BAIXO: 45, MODERADO: 100, ALTO: 150, CRITICO: 250 },
  o3: { BAIXO: 100, MODERADO: 130, ALTO: 160, CRITICO: 200 },
  no2: { BAIXO: 100, MODERADO: 200, ALTO: 240, CRITICO: 320 },
  co: { BAIXO: 5000, MODERADO: 10000, ALTO: 15000, CRITICO: 30000 },
  so2: { BAIXO: 40, MODERADO: 125, ALTO: 250, CRITICO: 500 },
};
