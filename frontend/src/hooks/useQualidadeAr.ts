import { useEffect, useState } from 'react';
import { airQualityAPI } from '../api';
import { EstacaoAr, MedicaoAr, StatusFontesAr } from '../types';

// Usado quando o usuário não tem cidade cadastrada (ex.: o ADMIN criado pelo script) e ainda não escolheu uma
export const CIDADE_PADRAO = 'São Paulo';

export interface UsuarioLogado {
  cidade?: string | null;
  regiao?: string | null;
}

export const lerUsuarioLogado = (): UsuarioLogado | null => {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch {
    return null;
  }
};

interface QualidadeAr {
  loading: boolean;
  erro: string | null;
  estacao: EstacaoAr | null;
  distanciaMetros: number | null;
  medicoes: MedicaoAr[];
  atualizadoEm: string | null;
  statusFontes: StatusFontesAr | null;
  atribuicoes: string[];
}

const VAZIO: QualidadeAr = {
  loading: true,
  erro: null,
  estacao: null,
  distanciaMetros: null,
  medicoes: [],
  atualizadoEm: null,
  statusFontes: null,
  atribuicoes: [],
};

// Escolhe a estação mais próxima do centro da cidade (o backend já devolve ordenado por distância)
// e carrega as medições consolidadas (OpenAQ + Open-Meteo) dela. Nada é inventado: sem dado, sem valor.
export function useQualidadeAr(cidade: string): QualidadeAr {
  const [estado, setEstado] = useState<QualidadeAr>(VAZIO);

  useEffect(() => {
    let cancelado = false;
    setEstado(VAZIO);

    (async () => {
      try {
        const lista = await airQualityAPI.estacoesPorCidade(cidade);
        const maisProxima = lista.data.estacoes[0];

        if (!maisProxima) {
          if (!cancelado) {
            setEstado({ ...VAZIO, loading: false, erro: `Nenhuma estação com dados encontrada perto de ${cidade}.` });
          }
          return;
        }

        const ultimas = await airQualityAPI.ultimasMedicoes(maisProxima.id);
        if (cancelado) return;

        setEstado({
          loading: false,
          erro: null,
          estacao: ultimas.data.estacao,
          distanciaMetros: maisProxima.distanciaMetros,
          medicoes: ultimas.data.medicoes,
          atualizadoEm: ultimas.data.atualizadoEm,
          statusFontes: ultimas.data.statusFontes,
          atribuicoes: ultimas.data.atribuicoes,
        });
      } catch (err: any) {
        if (!cancelado) {
          setEstado({
            ...VAZIO,
            loading: false,
            erro: err?.response?.data?.error || 'Não foi possível carregar os dados de qualidade do ar.',
          });
        }
      }
    })();

    return () => {
      cancelado = true;
    };
  }, [cidade]);

  return estado;
}
