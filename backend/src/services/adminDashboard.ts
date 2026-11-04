import pool from '../database';
import * as openaq from '../integrations/openaq/client';
import * as openmeteo from '../integrations/openmeteo/client';
import { Estacao, LIMITE_DEFASAGEM_HORAS } from '../integrations/openaq/mapper';
import { CIDADES } from '../data/cidades';
import { TTL_ESTACOES_MS, TTL_ULTIMAS_MS, TTL_OPEN_METEO_MS } from './airQuality';

// Dados do painel administrativo. Tudo vem do banco ou da configuração real do backend;
// nada aqui devolve segredos (chaves, JWT_SECRET, DATABASE_URL, senhas ou tokens).

// ---------------------------------------------------------------- Usuários
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

export async function obterResumoUsuarios(): Promise<{ usuarios: ResumoUsuarios; porCidade: UsuariosPorCidade[]; geradoEm: string }> {
  const [totais, porCidade] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE ativo)::int AS ativos,
              COUNT(*) FILTER (WHERE NOT ativo)::int AS inativos,
              COUNT(*) FILTER (WHERE perfil = 'ADMIN')::int AS administradores,
              COUNT(*) FILTER (WHERE perfil = 'USUARIO')::int AS usuarios_comuns,
              COUNT(*) FILTER (WHERE cidade IS NULL OR cidade = '')::int AS sem_cidade
       FROM usuarios`
    ),
    pool.query(
      `SELECT cidade, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ativo)::int AS ativos
       FROM usuarios
       WHERE cidade IS NOT NULL AND cidade <> ''
       GROUP BY cidade
       ORDER BY total DESC, cidade`
    ),
  ]);

  const t = totais.rows[0];
  return {
    usuarios: {
      total: t.total,
      ativos: t.ativos,
      inativos: t.inativos,
      administradores: t.administradores,
      usuariosComuns: t.usuarios_comuns,
      semCidade: t.sem_cidade,
    },
    porCidade: porCidade.rows,
    geradoEm: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- Configurações (somente leitura)
const hostDe = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

export async function obterConfiguracoes() {
  let bancoConectado = true;
  try {
    await pool.query('SELECT 1');
  } catch {
    bancoConectado = false;
  }

  return {
    sistema: {
      nome: 'AirMonitor',
      ambiente: process.env.NODE_ENV || 'development',
    },
    banco: {
      tipo: 'PostgreSQL (Supabase)',
      conectado: bancoConectado,
    },
    integracoes: {
      openaq: {
        funcao: 'Fonte principal (medições de estações)',
        configurada: Boolean(process.env.OPENAQ_API_KEY?.trim()),
        exigeChave: true,
        host: hostDe(openaq.baseUrl()),
        timeoutMs: openaq.timeoutMs(),
      },
      openMeteo: {
        funcao: 'Fallback (estimativas do modelo CAMS)',
        disponivel: true,
        exigeChave: false,
        host: hostDe(openmeteo.baseUrl()),
        timeoutMs: openmeteo.timeoutMs(),
        licenca: 'CC BY 4.0',
      },
    },
    cache: {
      estacoesMs: TTL_ESTACOES_MS,
      ultimasMedicoesMs: TTL_ULTIMAS_MS,
      openMeteoMs: TTL_OPEN_METEO_MS,
    },
    parametros: {
      defasagemHoras: LIMITE_DEFASAGEM_HORAS,
    },
    cidades: Object.keys(CIDADES),
    geradoEm: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- Estações
export type SituacaoDados = 'ATUALIZADA' | 'DESATUALIZADA' | 'SEM_MEDICAO';

export const situacaoDosDados = (ultimaMedicaoEm: string | null, agora = new Date()): SituacaoDados => {
  const instante = ultimaMedicaoEm ? Date.parse(ultimaMedicaoEm) : NaN;
  if (!Number.isFinite(instante)) return 'SEM_MEDICAO';
  return agora.getTime() - instante > LIMITE_DEFASAGEM_HORAS * 60 * 60 * 1000 ? 'DESATUALIZADA' : 'ATUALIZADA';
};

export const resumirEstacao = (estacao: Estacao) => ({
  id: estacao.id,
  nome: estacao.nome,
  localidade: estacao.localidade,
  pais: estacao.pais,
  latitude: estacao.latitude,
  longitude: estacao.longitude,
  distanciaMetros: estacao.distanciaMetros,
  poluentes: estacao.poluentes.map(({ chave, nome, unidade }) => ({ chave, nome, unidade })),
  ultimaMedicaoEm: estacao.ultimaMedicaoEm,
  situacao: situacaoDosDados(estacao.ultimaMedicaoEm),
  fonte: 'OpenAQ' as const,
});
