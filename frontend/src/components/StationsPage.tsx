import { useEstacoesAdmin } from '../hooks/useAdmin';
import { CidadeSelect, SituacaoTag } from './AdminWidgets';
import { formatarCoordenada, formatarDataHora, formatarDistancia } from '../utils/formatar';

interface StationsPageProps {
  cidades: string[];
  cidade: string;
  onCidadeChange: (cidade: string) => void;
}

const LIMITE = 50;

// Consulta das estações devolvidas pela OpenAQ para a cidade escolhida. Não há cadastro manual de estações.
export default function StationsPage({ cidades, cidade, onCidadeChange }: StationsPageProps) {
  const { loading, erro, dados } = useEstacoesAdmin(cidade, LIMITE);

  return (
    <section className="dash-card users-card">
      <div className="card-head">
        <div className="admin-page-head">
          <h2>Estações</h2>
          <p>Estações de monitoramento obtidas das APIs ambientais perto do centro da cidade (raio de 25 km).</p>
        </div>
        <CidadeSelect cidades={cidades} cidade={cidade} onChange={onCidadeChange} />
      </div>

      {erro && <div className="users-alert users-alert-error">{erro}</div>}

      {loading ? (
        <p className="users-empty">Carregando estações...</p>
      ) : dados && dados.estacoes.length === 0 ? (
        <p className="users-empty">{dados.mensagem}</p>
      ) : (
        dados && (
          <>
            <p className="admin-note">
              {dados.total} {dados.total === 1 ? 'estação encontrada' : 'estações encontradas'} para {dados.cidade} · fonte: {dados.fonte}
            </p>
            <div className="users-table-wrap">
              <table className="users-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Nome</th>
                    <th>Localização</th>
                    <th>Latitude</th>
                    <th>Longitude</th>
                    <th>Distância</th>
                    <th>Poluentes</th>
                    <th>Origem</th>
                    <th>Situação</th>
                    <th>Última medição</th>
                  </tr>
                </thead>
                <tbody>
                  {dados.estacoes.map((e) => (
                    <tr key={e.id}>
                      <td>{e.id}</td>
                      <td>{e.nome || '—'}</td>
                      <td>{[e.localidade, e.pais].filter(Boolean).join(' · ') || '—'}</td>
                      <td>{formatarCoordenada(e.latitude)}</td>
                      <td>{formatarCoordenada(e.longitude)}</td>
                      <td>{formatarDistancia(e.distanciaMetros) ?? '—'}</td>
                      <td>
                        <div className="admin-chips">
                          {e.poluentes.map((p) => (
                            <span key={p.chave} className="admin-chip" title={`Unidade: ${p.unidade}`}>{p.nome}</span>
                          ))}
                        </div>
                      </td>
                      <td>{e.fonte}</td>
                      <td><SituacaoTag situacao={e.situacao} /></td>
                      <td>{formatarDataHora(e.ultimaMedicaoEm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      )}

      <p className="admin-note">
        As estações vêm somente da OpenAQ. A Open-Meteo (fallback) não fornece estações: ela entrega valores de modelo na
        coordenada de uma estação.
      </p>
    </section>
  );
}
