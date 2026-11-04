import { useEffect, useState } from 'react';
import { AxiosResponse } from 'axios';
import { adminAPI } from '../api';
import { ConfiguracoesSistema, EstacoesAdminResponse, ResumoAdminResponse } from '../types';

interface Carga<T> {
  loading: boolean;
  erro: string | null;
  dados: T | null;
}

// Carrega uma rota administrativa e devolve loading/erro/dados. Nada é inventado: sem resposta, sem dados.
function useCarregar<T>(carregar: () => Promise<AxiosResponse<T>>, chaves: unknown[], mensagemPadrao: string): Carga<T> {
  const [estado, setEstado] = useState<Carga<T>>({ loading: true, erro: null, dados: null });

  useEffect(() => {
    let cancelado = false;
    setEstado({ loading: true, erro: null, dados: null });

    carregar()
      .then((res) => {
        if (!cancelado) setEstado({ loading: false, erro: null, dados: res.data });
      })
      .catch((err: any) => {
        if (!cancelado) setEstado({ loading: false, erro: err?.response?.data?.error || mensagemPadrao, dados: null });
      });

    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, chaves);

  return estado;
}

export const useResumoAdmin = () =>
  useCarregar<ResumoAdminResponse>(() => adminAPI.resumo(), [], 'Não foi possível carregar o resumo de usuários.');

export const useConfiguracoes = () =>
  useCarregar<ConfiguracoesSistema>(() => adminAPI.configuracoes(), [], 'Não foi possível carregar as configurações.');

export const useEstacoesAdmin = (cidade: string, limite: number) =>
  useCarregar<EstacoesAdminResponse>(
    () => adminAPI.estacoes(cidade, limite),
    [cidade, limite],
    'Não foi possível carregar as estações.'
  );
