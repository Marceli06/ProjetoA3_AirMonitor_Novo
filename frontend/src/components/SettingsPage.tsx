import { useConfiguracoes } from '../hooks/useAdmin';
import { CIDADE_PADRAO } from '../hooks/useQualidadeAr';
import './AdminPages.css';

const minutos = (ms: number) => `${(ms / 60000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} min`;
const segundos = (ms: number) => `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;

const Sim = ({ valor, sim = 'Sim', nao = 'Não' }: { valor: boolean; sim?: string; nao?: string }) => (
  <span className={valor ? 'tag-ok' : 'tag-none'}>● {valor ? sim : nao}</span>
);

// Informações do sistema em modo leitura. O backend nunca devolve chaves, JWT_SECRET, DATABASE_URL, senhas ou tokens.
export default function SettingsPage() {
  const { loading, erro, dados } = useConfiguracoes();

  return (
    <>
      <section className="dash-card">
        <div className="admin-page-head">
          <h2>Configurações</h2>
          <p>Informações do sistema em modo leitura. Ajustes são feitos nas variáveis de ambiente do servidor.</p>
        </div>
        {erro && <div className="users-alert users-alert-error">{erro}</div>}
        {loading && <p className="users-empty">Carregando configurações...</p>}
      </section>

      {dados && (
        <div className="admin-info-grid">
          <section className="dash-card">
            <h2>Sistema</h2>
            <dl className="admin-kv">
              <dt>Nome</dt><dd>{dados.sistema.nome}</dd>
              <dt>Ambiente</dt><dd>{dados.sistema.ambiente}</dd>
              <dt>Cidade padrão</dt><dd>{CIDADE_PADRAO} <small>(usada quando o usuário não tem cidade cadastrada)</small></dd>
            </dl>
          </section>

          <section className="dash-card">
            <h2>Banco de dados</h2>
            <dl className="admin-kv">
              <dt>Tipo</dt><dd>{dados.banco.tipo}</dd>
              <dt>Conexão</dt><dd><Sim valor={dados.banco.conectado} sim="Ativa" nao="Falhou" /></dd>
            </dl>
          </section>

          <section className="dash-card">
            <h2>OpenAQ</h2>
            <dl className="admin-kv">
              <dt>Função</dt><dd>{dados.integracoes.openaq.funcao}</dd>
              <dt>Configurada</dt><dd><Sim valor={dados.integracoes.openaq.configurada} /></dd>
              <dt>Chave de acesso</dt>
              <dd>{dados.integracoes.openaq.configurada ? 'Definida no servidor (não exibida)' : 'Não definida'}</dd>
              <dt>Endereço</dt><dd>{dados.integracoes.openaq.host ?? '—'}</dd>
              <dt>Tempo limite</dt><dd>{segundos(dados.integracoes.openaq.timeoutMs)}</dd>
            </dl>
          </section>

          <section className="dash-card">
            <h2>Open-Meteo</h2>
            <dl className="admin-kv">
              <dt>Função</dt><dd>{dados.integracoes.openMeteo.funcao}</dd>
              <dt>Disponível</dt><dd><Sim valor={dados.integracoes.openMeteo.disponivel} /> <small>não exige chave de acesso</small></dd>
              <dt>Endereço</dt><dd>{dados.integracoes.openMeteo.host ?? '—'}</dd>
              <dt>Tempo limite</dt><dd>{segundos(dados.integracoes.openMeteo.timeoutMs)}</dd>
              <dt>Licença dos dados</dt><dd>{dados.integracoes.openMeteo.licenca}</dd>
            </dl>
          </section>

          <section className="dash-card">
            <h2>Cache e atualização dos dados</h2>
            <dl className="admin-kv">
              <dt>Estações</dt><dd>{minutos(dados.cache.estacoesMs)}</dd>
              <dt>Últimas medições (OpenAQ)</dt><dd>{minutos(dados.cache.ultimasMedicoesMs)}</dd>
              <dt>Open-Meteo</dt><dd>{minutos(dados.cache.openMeteoMs)}</dd>
              <dt>Dado desatualizado após</dt><dd>{dados.parametros.defasagemHoras} h</dd>
            </dl>
          </section>

          <section className="dash-card">
            <h2>Cidades suportadas ({dados.cidades.length})</h2>
            <div className="admin-chips">
              {dados.cidades.map((c) => (
                <span key={c} className="admin-chip">{c}</span>
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
