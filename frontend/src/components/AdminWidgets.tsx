import { useEstacoesAdmin, useResumoAdmin } from '../hooks/useAdmin';
import { ResumoUsuarios, SituacaoDados } from '../types';
import { formatarDistancia } from '../utils/formatar';
import './AdminPages.css';

// Peças compartilhadas pelo Dashboard Admin e pelas páginas Estações, Configurações e Relatórios

const TILES: { chave: keyof ResumoUsuarios; rotulo: string; tom?: 'ok' | 'off' }[] = [
  { chave: 'total', rotulo: 'Usuários cadastrados' },
  { chave: 'ativos', rotulo: 'Usuários ativos', tom: 'ok' },
  { chave: 'inativos', rotulo: 'Usuários inativos', tom: 'off' },
  { chave: 'administradores', rotulo: 'Administradores' },
  { chave: 'usuariosComuns', rotulo: 'Usuários comuns' },
];

// Contadores reais do banco (GET /api/admin/resumo). Com mostrarPorCidade, acrescenta a tabela por cidade (Relatórios).
export function AdminUserStats({ mostrarPorCidade = false }: { mostrarPorCidade?: boolean }) {
  const { loading, erro, dados } = useResumoAdmin();

  if (erro) {
    return (
      <section className="dash-card">
        <p className="air-error">{erro}</p>
      </section>
    );
  }

  return (
    <>
      <div className="admin-stat-grid">
        {TILES.map((t) => (
          <section key={t.chave} className={`dash-card admin-stat${t.tom ? ` is-${t.tom}` : ''}`}>
            <span>{t.rotulo}</span>
            <strong>{dados ? dados.usuarios[t.chave] : loading ? '…' : '—'}</strong>
          </section>
        ))}
      </div>

      {mostrarPorCidade && dados && (
        <>
          {dados.porCidade.length === 0 ? (
            <p className="users-empty">Nenhum usuário com cidade cadastrada.</p>
          ) : (
            <div className="users-table-wrap">
              <table className="users-table">
                <thead>
                  <tr>
                    <th>Cidade</th>
                    <th>Usuários</th>
                    <th>Ativos</th>
                  </tr>
                </thead>
                <tbody>
                  {dados.porCidade.map((c) => (
                    <tr key={c.cidade}>
                      <td>{c.cidade}</td>
                      <td>{c.total}</td>
                      <td>{c.ativos}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {dados.usuarios.semCidade > 0 && (
            <p className="admin-note">{dados.usuarios.semCidade} usuário(s) sem cidade cadastrada.</p>
          )}
        </>
      )}
    </>
  );
}

const SITUACAO: Record<SituacaoDados, { rotulo: string; classe: string }> = {
  ATUALIZADA: { rotulo: 'Atualizada', classe: 'tag-ok' },
  DESATUALIZADA: { rotulo: 'Desatualizada', classe: 'tag-warn' },
  SEM_MEDICAO: { rotulo: 'Sem medição', classe: 'tag-none' },
};

export const SituacaoTag = ({ situacao }: { situacao: SituacaoDados }) => (
  <span className={SITUACAO[situacao].classe}>● {SITUACAO[situacao].rotulo}</span>
);

export function CidadeSelect({ cidades, cidade, onChange }: { cidades: string[]; cidade: string; onChange: (c: string) => void }) {
  return (
    <label className="admin-select">
      <span>Cidade</span>
      <select value={cidade} onChange={(e) => onChange(e.target.value)}>
        {cidades.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
    </label>
  );
}

// Resumo das estações mais próximas do centro da cidade (GET /api/admin/estacoes), usado no card do Dashboard Admin
export function AdminStationSummary({ cidade }: { cidade: string }) {
  const { loading, erro, dados } = useEstacoesAdmin(cidade, 5);

  return (
    <div className="admin-station-list">
      {loading && <p className="users-empty">Carregando estações…</p>}
      {erro && <p className="air-error">{erro}</p>}
      {dados && dados.estacoes.length === 0 && <p className="users-empty">{dados.mensagem}</p>}
      {dados && dados.estacoes.length > 0 && (
        <>
          <ul>
            {dados.estacoes.map((e) => (
              <li key={e.id}>
                <div>
                  <strong>{e.nome || `Estação ${e.id}`}</strong>
                  <small>
                    {e.localidade || cidade}
                    {formatarDistancia(e.distanciaMetros) && ` · ${formatarDistancia(e.distanciaMetros)} do centro`}
                  </small>
                </div>
                <SituacaoTag situacao={e.situacao} />
              </li>
            ))}
          </ul>
          <small className="admin-note">Estações mais próximas do centro de {cidade} · fonte: OpenAQ</small>
        </>
      )}
    </div>
  );
}
