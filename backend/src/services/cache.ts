// Cache em memória com TTL, para poupar o limite de requisições das APIs externas
// (OpenAQ: 60/min por chave; Open-Meteo: 600/min). Só guarda respostas bem-sucedidas: erros nunca são cacheados.

interface Entrada {
  expiraEm: number;
  valor: unknown;
}

const MAX_ENTRADAS = 500;
const entradas = new Map<string, Entrada>();

export async function comCache<T>(chave: string, ttlMs: number, carregar: () => Promise<T>): Promise<T> {
  const existente = entradas.get(chave);
  if (existente && existente.expiraEm > Date.now()) {
    return existente.valor as T;
  }

  const valor = await carregar();

  if (entradas.size >= MAX_ENTRADAS) {
    const maisAntiga = entradas.keys().next().value;
    if (maisAntiga !== undefined) entradas.delete(maisAntiga);
  }
  entradas.set(chave, { expiraEm: Date.now() + ttlMs, valor });
  return valor;
}

// Sem argumento limpa tudo; com prefixo (ex.: 'openmeteo:') limpa só as chaves daquela fonte
export const limparCache = (prefixo?: string) => {
  if (!prefixo) return entradas.clear();
  for (const chave of [...entradas.keys()]) {
    if (chave.startsWith(prefixo)) entradas.delete(chave);
  }
};
