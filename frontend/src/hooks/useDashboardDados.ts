import axios from 'axios';
import { useEffect, useState } from 'react';
import { alertasAPI, historicoAPI, ocorrenciasAPI } from '../api';
import { AlertaAr, HistoricoResponse, NivelAlerta, Ocorrencia } from '../types';
import { NIVEIS_ORDEM } from '../utils/alertas';

// Dados reais dos cartões do Dashboard (Alertas, Ocorrências e Histórico). Nada é inventado: sem dado, a tela
// mostra o estado vazio; com falha, a mensagem de erro. Cada leitura cancela a anterior ao mudar cidade ou filtro.

export interface Carga<T> {
  carregando: boolean;
  erro: string | null;
  dados: T | null;
}

const mensagemDoServidor = (erro: unknown, padrao: string) => {
  if (axios.isAxiosError(erro)) {
    const texto = erro.response?.data?.error;
    if (typeof texto === 'string' && texto) return texto;
    if (!erro.response) return 'Sem conexão com o servidor. Verifique a internet e tente novamente.';
  }
  return padrao;
};

function useCarga<T>(carregar: (signal: AbortSignal) => Promise<T>, chaves: unknown[], padrao: string, ativo = true): Carga<T> {
  const [estado, setEstado] = useState<Carga<T>>({ carregando: ativo, erro: null, dados: null });

  useEffect(() => {
    if (!ativo) {
      setEstado({ carregando: false, erro: null, dados: null });
      return;
    }
    const controle = new AbortController();
    // Mantém o dado anterior enquanto recarrega (o selo do sino não pisca); os cartões mostram "carregando"
    setEstado((anterior) => ({ carregando: true, erro: null, dados: anterior.dados }));

    carregar(controle.signal)
      .then((dados) => {
        if (!controle.signal.aborted) setEstado({ carregando: false, erro: null, dados });
      })
      .catch((erro) => {
        if (controle.signal.aborted || axios.isCancel(erro)) return;
        setEstado({ carregando: false, erro: mensagemDoServidor(erro, padrao), dados: null });
      });

    return () => controle.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...chaves, ativo]);

  return estado;
}

export interface AlertasAtivos {
  total: number;
  alertas: AlertaAr[];
  maisGrave: NivelAlerta | null;
}

// Alertas ATIVOS da cidade (mais recentes primeiro). `recarga` muda quando o usuário volta ao Dashboard, para
// refletir alertas resolvidos ou avaliados em outra tela.
export const useAlertasAtivos = (cidade: string, recarga: unknown) =>
  useCarga<AlertasAtivos>(
    async (signal) => {
      const { data } = await alertasAPI.listar({ cidade, status: 'ATIVO', limite: 200 }, signal);
      const maisGrave = [...NIVEIS_ORDEM].reverse().find((n) => data.alertas.some((a) => a.nivel === n)) ?? null;
      return { total: data.total, alertas: data.alertas, maisGrave };
    },
    [cidade, recarga],
    'Não foi possível carregar os alertas.'
  );

// Ocorrências mais recentes da cidade do USUARIO (o servidor só devolve a cidade cadastrada dele)
export const useOcorrenciasRecentes = (ativo: boolean, cidade: string, recarga: unknown) =>
  useCarga<{ total: number; ocorrencias: Ocorrencia[] }>(
    async (signal) => {
      const { data } = await ocorrenciasAPI.listar({ cidade, limite: 3 }, signal);
      return { total: data.total, ocorrencias: data.ocorrencias };
    },
    [cidade, recarga],
    'Não foi possível carregar as ocorrências.',
    ativo
  );

// Últimas 24 horas de um poluente (estação da OpenAQ ou, na falta dela, o modelo Open-Meteo, sempre identificado)
export const useHistoricoDoDia = (ativo: boolean, cidade: string, poluente: string) =>
  useCarga<HistoricoResponse>(
    async (signal) => (await historicoAPI.consultar({ cidade, poluente, periodo: '24H', fonte: 'AUTO' }, signal)).data,
    [cidade, poluente],
    'Não foi possível carregar o histórico.',
    ativo
  );

