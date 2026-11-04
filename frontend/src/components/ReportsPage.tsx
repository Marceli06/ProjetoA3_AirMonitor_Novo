import { ReactNode } from 'react';
import { AdminUserStats, CidadeSelect } from './AdminWidgets';
import { useQualidadeAr } from '../hooks/useQualidadeAr';
import { NOME_FONTE, POLLUTANTS, ROTULO_FONTE, formatarDataHora, formatarDistancia, formatarValor } from '../utils/formatar';
import './AdminPages.css';

interface ReportsPageProps {
  cidades: string[];
  cidade: string;
  onCidadeChange: (cidade: string) => void;
  // Mesmos dados que alimentam o Dashboard (cidade selecionada): evita consultar as APIs duas vezes
  qualidade: ReturnType<typeof useQualidadeAr>;
}

// Cada bloco do relatório é uma seção independente: novos relatórios entram como novas <ReportSection>
function ReportSection({ titulo, subtitulo, children }: { titulo: string; subtitulo?: string; children: ReactNode }) {
  return (
    <section className="dash-card report-section">
      <div className="admin-page-head">
        <h2>{titulo}</h2>
        {subtitulo && <p>{subtitulo}</p>}
      </div>
      {children}
    </section>
  );
}

const STATUS_OPEN_METEO = {
  nao_necessaria: 'não foi necessária',
  ok: 'usada como complemento',
  falha: 'indisponível',
  sem_coordenadas: 'sem coordenadas da estação',
} as const;

// Primeira versão: visão resumida na tela, só com dados que o sistema já possui. Sem PDF/Excel e sem histórico inventado.
export default function ReportsPage({ cidades, cidade, onCidadeChange, qualidade }: ReportsPageProps) {
  return (
    <>
      <section className="dash-card">
        <div className="card-head">
          <div className="admin-page-head">
            <h2>Relatórios</h2>
            <p>Resumo do sistema com os dados atuais. A cidade escolhida vale para o bloco de qualidade do ar.</p>
          </div>
          <CidadeSelect cidades={cidades} cidade={cidade} onChange={onCidadeChange} />
        </div>
      </section>

      <ReportSection titulo="Usuários do sistema" subtitulo="Contagens do banco de dados, por situação, perfil e cidade.">
        <AdminUserStats mostrarPorCidade />
      </ReportSection>

      <ReportSection titulo={`Qualidade do ar — ${cidade}`} subtitulo="Últimos valores obtidos das APIs ambientais, com a fonte de cada dado.">
        {qualidade.loading ? (
          <p className="users-empty">Carregando dados de qualidade do ar...</p>
        ) : qualidade.erro ? (
          <p className="air-error">{qualidade.erro}</p>
        ) : (
          <>
            <dl className="admin-kv">
              <dt>Estação</dt>
              <dd>{qualidade.estacao ? `${qualidade.estacao.nome || `Estação ${qualidade.estacao.id}`} (ID ${qualidade.estacao.id})` : '—'}</dd>
              <dt>Localização</dt>
              <dd>
                {qualidade.estacao?.localidade || cidade}
                {formatarDistancia(qualidade.distanciaMetros) && ` · ${formatarDistancia(qualidade.distanciaMetros)} do centro da cidade`}
              </dd>
              <dt>Atualização dos dados</dt>
              <dd>{formatarDataHora(qualidade.atualizadoEm)}</dd>
              {qualidade.statusFontes && (
                <>
                  <dt>OpenAQ</dt>
                  <dd>{qualidade.statusFontes.OPENAQ === 'ok' ? 'disponível' : 'indisponível'}</dd>
                  <dt>Open-Meteo</dt>
                  <dd>{STATUS_OPEN_METEO[qualidade.statusFontes.OPEN_METEO]}</dd>
                </>
              )}
            </dl>

            <div className="users-table-wrap">
              <table className="users-table">
                <thead>
                  <tr>
                    <th>Poluente</th>
                    <th>Valor</th>
                    <th>Fonte</th>
                    <th>Data/hora do dado</th>
                    <th>Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {POLLUTANTS.map((p) => {
                    const m = qualidade.medicoes.find((x) => x.chave === p.chave);
                    const temValor = !!m && m.disponivel && m.valor !== null && m.fonte !== null;
                    return (
                      <tr key={p.chave}>
                        <td>{p.name} <small className="admin-note">{p.desc}</small></td>
                        <td>{temValor ? `${formatarValor(m!.valor!)} ${m!.unidade ?? ''}` : '—'}</td>
                        <td>{temValor ? `${NOME_FONTE[m!.fonte!]} · ${ROTULO_FONTE[m!.fonte!].toLowerCase()}` : '—'}</td>
                        <td>{temValor ? formatarDataHora(m!.dataHora) : '—'}</td>
                        <td>
                          {!temValor ? (
                            <span className="tag-none">● Sem dados disponíveis</span>
                          ) : m!.desatualizada ? (
                            <span className="tag-warn">● Desatualizado</span>
                          ) : (
                            <span className="tag-ok">● Atual</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {qualidade.atribuicoes.map((a) => (
              <p key={a} className="air-attribution">{a}</p>
            ))}
          </>
        )}
      </ReportSection>

      <ReportSection titulo="Histórico e exportação">
        <p className="users-empty">
          O sistema ainda não persiste histórico de medições, então não há séries históricas neste relatório.
          Relatórios completos e exportação em PDF/Excel serão acrescentados em etapas futuras.
        </p>
      </ReportSection>
    </>
  );
}
