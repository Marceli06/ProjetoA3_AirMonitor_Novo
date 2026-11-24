import { useEffect, useState } from 'react';
import axios from 'axios';
import Icon, { IconName } from './Icon';
import CidadeEData from './CidadeEData';
import DetailDrawer from './DetailDrawer';
import { alertasAPI } from '../api';
import { AlertaAr, ListaAlertasResponse, NivelAlerta } from '../types';
import { NOME_FONTE, POLLUTANTS, formatarDataHora } from '../utils/formatar';
import {
  FiltroStatus,
  NIVEIS_ORDEM,
  ROTULO_NIVEL,
  ROTULO_STATUS,
  formatarValorAlerta,
  nomeDaEstacaoDoAlerta,
  nomePoluente,
  resumirAlertas,
  rotuloOrigem,
  rotuloValor,
  tempoRelativo,
  tomDoAlerta,
} from '../utils/alertas';
import './Severidade.css';
import './AlertsPage.css';

interface AlertsPageProps {
  cidades: string[]; // ADMIN: todas as cidades suportadas; USUARIO: somente a própria
  cidade: string;
  onCidadeChange: (cidade: string) => void;
  isAdmin: boolean; // só controla a exibição das ações; o backend é quem autoriza (403 para não ADMIN)
}

const LIMITE_POR_PAGINA = 10;
// A API devolve no máximo 200 por consulta: alertas ativos são poucos (no máximo 1 por estação e poluente)
const LIMITE_ATIVOS_RESUMO = 200;

const FILTROS_STATUS: { valor: FiltroStatus; rotulo: string }[] = [
  { valor: 'TODOS', rotulo: 'Todos' },
  { valor: 'ATIVO', rotulo: 'Ativos' },
  { valor: 'RESOLVIDO', rotulo: 'Resolvidos' },
];

const ICONE_NIVEL: Record<NivelAlerta, IconName> = { BAIXO: 'info', MODERADO: 'warning', ALTO: 'alert', CRITICO: 'flame' };

const TITULO_SITUACAO: Record<NivelAlerta, string> = {
  BAIXO: 'Atenção leve',
  MODERADO: 'Atenção moderada',
  ALTO: 'Atenção: nível alto',
  CRITICO: 'Atenção: nível crítico',
};

const plural = (n: number, singular: string, pluralTxt: string) => `${n} ${n === 1 ? singular : pluralTxt}`;

interface DadosResumo {
  ativos: AlertaAr[];
  totalAtivos: number;
  totalResolvidos: number;
}

function NivelBadge({ alerta }: { alerta: AlertaAr }) {
  return (
    <span className={`alert-level tom-${tomDoAlerta(alerta)}`}>
      <Icon name={ICONE_NIVEL[alerta.nivel]} />
      {ROTULO_NIVEL[alerta.nivel]}
    </span>
  );
}

function StatusBadge({ status }: { status: AlertaAr['status'] }) {
  return (
    <span className={`alert-status is-${status.toLowerCase()}`}>
      <span className="alert-status-dot" />
      {ROTULO_STATUS[status]}
    </span>
  );
}

export default function AlertsPage({ cidades, cidade, onCidadeChange, isAdmin }: AlertsPageProps) {
  const [status, setStatus] = useState<FiltroStatus>('TODOS');
  const [nivel, setNivel] = useState<NivelAlerta | null>(null);
  const [poluente, setPoluente] = useState('');
  const [pagina, setPagina] = useState(1);
  const [selecionado, setSelecionado] = useState<AlertaAr | null>(null);

  const [lista, setLista] = useState<ListaAlertasResponse | null>(null);
  const [carregandoLista, setCarregandoLista] = useState(true);
  const [erroLista, setErroLista] = useState(false);
  const [dadosResumo, setDadosResumo] = useState<DadosResumo | null>(null);
  const [erroResumo, setErroResumo] = useState(false);
  const [atualizadoEm, setAtualizadoEm] = useState(() => new Date());
  const [recarga, setRecarga] = useState(0);

  const [avaliando, setAvaliando] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [confirmandoResolver, setConfirmandoResolver] = useState(false);
  const [resolvendo, setResolvendo] = useState(false);
  const [erroResolver, setErroResolver] = useState<string | null>(null);

  // Trocar de cidade volta à primeira página e fecha o detalhe (os filtros escolhidos continuam)
  const [cidadeAtual, setCidadeAtual] = useState(cidade);
  if (cidadeAtual !== cidade) {
    setCidadeAtual(cidade);
    setDadosResumo(null);
    setLista(null);
    setPagina(1);
    setSelecionado(null);
    setAviso(null);
  }

  const recarregar = () => setRecarga((n) => n + 1);

  // Página de alertas: filtros e paginação são feitos pelo backend
  useEffect(() => {
    const controle = new AbortController();
    setCarregandoLista(true);
    setErroLista(false);
    alertasAPI
      .listar(
        {
          cidade,
          status: status === 'TODOS' ? undefined : status,
          nivel: nivel ?? undefined,
          poluente: poluente || undefined,
          limite: LIMITE_POR_PAGINA,
          pagina,
        },
        controle.signal
      )
      .then(({ data }) => {
        setLista(data);
        setAtualizadoEm(new Date());
        setCarregandoLista(false);
      })
      .catch(() => {
        if (controle.signal.aborted) return;
        setLista(null);
        setErroLista(true);
        setCarregandoLista(false);
      });
    return () => controle.abort();
  }, [cidade, status, nivel, poluente, pagina, recarga]);

  // Resumo da cidade (cartões e destaque): não depende dos filtros da lista
  useEffect(() => {
    const controle = new AbortController();
    setErroResumo(false);
    Promise.all([
      alertasAPI.listar({ cidade, status: 'ATIVO', limite: LIMITE_ATIVOS_RESUMO }, controle.signal),
      alertasAPI.listar({ cidade, status: 'RESOLVIDO', limite: 1 }, controle.signal),
    ])
      .then(([ativos, resolvidos]) =>
        setDadosResumo({ ativos: ativos.data.alertas, totalAtivos: ativos.data.total, totalResolvidos: resolvidos.data.total })
      )
      .catch(() => {
        if (controle.signal.aborted) return;
        setDadosResumo(null);
        setErroResumo(true);
      });
    return () => controle.abort();
  }, [cidade, recarga]);

  const total = lista?.total ?? 0;
  const totalPaginas = Math.max(1, Math.ceil(total / LIMITE_POR_PAGINA));

  // Se a página atual esvaziou (ex.: alerta resolvido com filtro "Ativos"), volta para a última existente
  useEffect(() => {
    if (lista && lista.alertas.length === 0 && lista.total > 0 && pagina > 1) setPagina(totalPaginas);
  }, [lista, pagina, totalPaginas]);

  const resumo = dadosResumo ? resumirAlertas(dadosResumo.ativos, dadosResumo.totalAtivos, dadosResumo.totalResolvidos) : null;
  const erro = erroLista || erroResumo;
  const alertas = lista?.alertas ?? [];
  const filtrosAtivos = status !== 'TODOS' || nivel !== null || poluente !== '';
  const semAlertaAtivo = resumo !== null && resumo.ativos === 0;
  // "Nenhum alerta ativo" vale para a lista inteira vazia ou para o filtro "Ativos" sem outros filtros
  const mensagemSemAtivo = total === 0 && nivel === null && poluente === '' && status !== 'RESOLVIDO';

  const abrir = (alerta: AlertaAr) => {
    setSelecionado(alerta);
    setConfirmandoResolver(false);
    setErroResolver(null);
  };
  const fechar = () => setSelecionado(null);

  const mudarStatus = (novo: FiltroStatus) => {
    setStatus(novo);
    setPagina(1);
  };
  // A API filtra um nível por vez: clicar de novo no nível selecionado limpa o filtro
  const alternarNivel = (novo: NivelAlerta) => {
    setNivel((atual) => (atual === novo ? null : novo));
    setPagina(1);
  };
  const mudarPoluente = (novo: string) => {
    setPoluente(novo);
    setPagina(1);
  };
  const limparFiltros = () => {
    setStatus('TODOS');
    setNivel(null);
    setPoluente('');
    setPagina(1);
  };

  // Ações de ADMIN (o backend responde 403 para qualquer outro perfil, sem encerrar a sessão)
  const avaliarAgora = async () => {
    setAvaliando(true);
    setAviso(null);
    try {
      const { data } = await alertasAPI.avaliar(cidade);
      const c = data.contagem;
      const falhas = data.falhas.length ? ` ${plural(data.falhas.length, 'estação com falha', 'estações com falha')}.` : '';
      setAviso({
        tipo: 'ok',
        texto: `Avaliação concluída (${plural(data.estacoesAvaliadas, 'estação', 'estações')}): ${plural(c.criado, 'alerta criado', 'alertas criados')}, ${plural(c.atualizado, 'atualizado', 'atualizados')}, ${plural(c.resolvido, 'resolvido', 'resolvidos')}.${falhas}`,
      });
      recarregar();
    } catch {
      setAviso({ tipo: 'erro', texto: 'Não foi possível avaliar os dados agora. Tente novamente.' });
    } finally {
      setAvaliando(false);
    }
  };

  const resolverAlerta = async () => {
    if (!selecionado) return;
    setResolvendo(true);
    setErroResolver(null);
    try {
      const { data } = await alertasAPI.resolver(selecionado.id);
      setSelecionado(data.alerta);
      setConfirmandoResolver(false);
      recarregar();
    } catch (e) {
      if (axios.isAxiosError<{ alerta?: AlertaAr }>(e) && e.response?.status === 409) {
        // Já estava resolvido (outra pessoa ou a avaliação automática): só atualiza a tela
        if (e.response.data?.alerta) setSelecionado(e.response.data.alerta);
        setConfirmandoResolver(false);
        recarregar();
      } else {
        setErroResolver('Não foi possível resolver o alerta. Tente novamente.');
      }
    } finally {
      setResolvendo(false);
    }
  };

  const cartoes: { chave: string; rotulo: string; valor: number | undefined; nota: string; icone: IconName; tom: string }[] = [
    { chave: 'ativos', rotulo: 'Alertas ativos', valor: resumo?.ativos, nota: 'Em andamento agora', icone: 'bell', tom: 'ativos' },
    { chave: 'alta', rotulo: 'Alta prioridade', valor: resumo?.alta, nota: 'Níveis alto e crítico', icone: 'flame', tom: 'alta' },
    { chave: 'media', rotulo: 'Média prioridade', valor: resumo?.media, nota: 'Nível moderado', icone: 'warning', tom: 'media' },
    { chave: 'resolvidos', rotulo: 'Resolvidos', valor: resumo?.resolvidos, nota: 'Já normalizados', icone: 'check', tom: 'resolvidos' },
  ];

  const tomHero = !resumo ? 'resolvido' : semAlertaAtivo ? 'resolvido' : (resumo.maisGrave ?? 'BAIXO').toLowerCase();

  return (
    <div className="alerts-page">
      <section className="dash-heading">
        <div>
          <h1>Alertas de Qualidade do Ar</h1>
          <p>Acompanhe situações que podem exigir atenção na sua região.</p>
        </div>
        <div className="alerts-head-right">
          <CidadeEData cidades={cidades} cidade={cidade} onCidadeChange={onCidadeChange} atualizadoEm={atualizadoEm} />
          {isAdmin && (
            <button type="button" className="alerts-eval" onClick={avaliarAgora} disabled={avaliando} data-testid="avaliar">
              <Icon name="antenna" />
              {avaliando ? 'Avaliando…' : 'Avaliar dados agora'}
            </button>
          )}
        </div>
      </section>

      {aviso && (
        <p className={`alerts-aviso is-${aviso.tipo}`} role="status" data-testid="aviso-avaliacao">
          {aviso.texto}
        </p>
      )}

      {!erro && (
        <section className={`alerts-hero tom-${tomHero}`} aria-live="polite">
          <span className="alerts-hero-icon">
            <Icon name={!resumo ? 'clock' : semAlertaAtivo ? 'shield' : ICONE_NIVEL[resumo.maisGrave ?? 'BAIXO']} />
          </span>
          <div className="alerts-hero-text">
            {!resumo ? (
              <>
                <strong>Carregando situação…</strong>
                <span>Consultando os alertas de {cidade}.</span>
              </>
            ) : (
              <>
                <strong>{semAlertaAtivo ? 'Situação sob controle' : TITULO_SITUACAO[resumo.maisGrave ?? 'BAIXO']}</strong>
                <span>
                  {semAlertaAtivo
                    ? `Nenhum alerta ativo em ${cidade} neste momento.`
                    : `${plural(resumo.ativos, 'alerta ativo', 'alertas ativos')} em ${cidade}. Pessoas sensíveis devem redobrar a atenção.`}
                </span>
              </>
            )}
          </div>
          {resumo && !semAlertaAtivo && (
            <div className="alerts-hero-levels" aria-label="Alertas ativos por nível">
              {[...NIVEIS_ORDEM].reverse().filter((n) => resumo.ativosPorNivel[n] > 0).map((n) => (
                <span key={n} className={`alerts-mini tom-${n.toLowerCase()}`}>
                  <b>{resumo.ativosPorNivel[n]}</b> {ROTULO_NIVEL[n]}
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="alerts-summary">
        {cartoes.map((c) => (
          <article key={c.chave} className={`dash-card alerts-stat stat-${c.tom}`} data-testid={`resumo-${c.chave}`}>
            <span className="alerts-stat-icon"><Icon name={c.icone} /></span>
            <div>
              <span className="alerts-stat-label">{c.rotulo}</span>
              <strong>{c.valor ?? '–'}</strong>
              <small>{c.nota}</small>
            </div>
          </article>
        ))}
      </div>

      <section className="dash-card alerts-list-card" aria-busy={carregandoLista}>
        <div className="alerts-toolbar">
          <div className="alerts-filter-group">
            <span className="alerts-filter-label" id="rotulo-status">Status</span>
            <div className="alerts-segmented" role="group" aria-labelledby="rotulo-status">
              {FILTROS_STATUS.map((f) => (
                <button
                  key={f.valor}
                  type="button"
                  className={status === f.valor ? 'active' : ''}
                  aria-pressed={status === f.valor}
                  onClick={() => mudarStatus(f.valor)}
                >
                  {f.rotulo}
                </button>
              ))}
            </div>
          </div>

          <div className="alerts-filter-group">
            <span className="alerts-filter-label" id="rotulo-nivel">Nível</span>
            <div className="alerts-chips" role="group" aria-labelledby="rotulo-nivel">
              {NIVEIS_ORDEM.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`alerts-chip tom-${n.toLowerCase()}${nivel === n ? ' active' : ''}`}
                  aria-pressed={nivel === n}
                  onClick={() => alternarNivel(n)}
                >
                  <span className="alerts-chip-dot" />
                  {ROTULO_NIVEL[n]}
                </button>
              ))}
            </div>
          </div>

          <div className="alerts-filter-group">
            <span className="alerts-filter-label" id="rotulo-poluente">Poluente</span>
            <label className="dash-select alerts-select">
              <select aria-labelledby="rotulo-poluente" value={poluente} onChange={(e) => mudarPoluente(e.target.value)} data-testid="filtro-poluente">
                <option value="">Todos</option>
                {POLLUTANTS.map((p) => (
                  <option key={p.chave} value={p.chave}>{p.name}</option>
                ))}
              </select>
              <Icon name="dropdown" />
            </label>
          </div>
        </div>

        {!erro && !carregandoLista && lista && (
          <div className="alerts-count-row">
            <span data-testid="contagem">
              Mostrando <b>{alertas.length}</b> de {plural(total, 'alerta', 'alertas')}
            </span>
            {filtrosAtivos && (
              <button type="button" className="alerts-clear" onClick={limparFiltros}>
                <Icon name="close" /> Limpar filtros
              </button>
            )}
          </div>
        )}

        {erro ? (
          <div className="alerts-empty" data-testid="estado-erro" role="alert">
            <span className="alerts-empty-icon"><Icon name="warning" /></span>
            <strong>Não foi possível carregar os alertas. Tente novamente.</strong>
            <button type="button" className="alerts-retry" onClick={recarregar}>Tentar novamente</button>
          </div>
        ) : carregandoLista ? (
          <div className="alerts-empty" data-testid="carregando" role="status">
            <span className="alerts-empty-icon"><Icon name="clock" /></span>
            <strong>Carregando alertas…</strong>
          </div>
        ) : alertas.length === 0 ? (
          <div className="alerts-empty" data-testid="estado-vazio">
            <span className="alerts-empty-icon"><Icon name={mensagemSemAtivo ? 'shield' : 'bell'} /></span>
            {mensagemSemAtivo ? (
              <>
                <strong>Nenhum alerta ativo no momento.</strong>
                <p>Os níveis monitorados estão abaixo dos limiares técnicos provisórios.</p>
              </>
            ) : (
              <>
                <strong>Nenhum alerta encontrado.</strong>
                <p>Nenhum alerta corresponde aos filtros selecionados. Tente outros filtros.</p>
              </>
            )}
          </div>
        ) : (
          <ul className="alerts-list">
            {alertas.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className={`alert-item tom-${tomDoAlerta(a)}${a.status === 'RESOLVIDO' ? ' is-resolvido' : ''}${selecionado?.id === a.id ? ' is-selected' : ''}`}
                  onClick={() => abrir(a)}
                  aria-label={`Ver detalhes: ${a.titulo}`}
                  data-testid="alerta"
                >
                  <span className="alert-item-icon"><Icon name={a.status === 'RESOLVIDO' ? 'check' : ICONE_NIVEL[a.nivel]} /></span>
                  <span className="alert-item-main">
                    <span className="alert-item-top">
                      <span className="alert-pollutant">{nomePoluente(a.poluente)}</span>
                      <strong>{a.titulo}</strong>
                    </span>
                    <span className="alert-item-desc">{a.descricao}</span>
                    <span className="alert-item-meta">
                      <span><Icon name="pin" />{a.cidade} · {nomeDaEstacaoDoAlerta(a)}</span>
                      <span><Icon name="clock" />{tempoRelativo(a.medicaoEm, atualizadoEm)} · {formatarDataHora(a.medicaoEm)}</span>
                      <span className={`alert-origin origem-${a.tipoDado === 'MEDICAO' ? 'estacao' : 'modelo'}`}>{rotuloOrigem(a.tipoDado)}</span>
                    </span>
                  </span>
                  <span className="alert-item-value">
                    <b>{formatarValorAlerta(a.valor)}</b>
                    <small>{a.unidade}</small>
                  </span>
                  <span className="alert-item-badges">
                    <NivelBadge alerta={a} />
                    <StatusBadge status={a.status} />
                  </span>
                  <span className="alert-item-chevron"><Icon name="chevron" /></span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {!erro && !carregandoLista && totalPaginas > 1 && (
          <nav className="alerts-pager" aria-label="Paginação dos alertas" data-testid="paginacao">
            <button type="button" onClick={() => setPagina((p) => Math.max(1, p - 1))} disabled={pagina <= 1}>Anterior</button>
            <span>Página <b>{pagina}</b> de {totalPaginas}</span>
            <button type="button" onClick={() => setPagina((p) => Math.min(totalPaginas, p + 1))} disabled={pagina >= totalPaginas}>Próxima</button>
          </nav>
        )}

        {lista?.limiaresProvisorios && (
          <p className="quality-note" data-testid="nota-limiares">Os níveis de alerta utilizam parâmetros técnicos provisórios.</p>
        )}
      </section>

      {selecionado && (
        <DetailDrawer
          titulo={selecionado.titulo}
          tituloId="alerta-titulo"
          testId="alerta"
          className={`tom-${tomDoAlerta(selecionado)}`}
          icone={<Icon name={selecionado.status === 'RESOLVIDO' ? 'check' : ICONE_NIVEL[selecionado.nivel]} />}
          etiqueta={<span className="alert-pollutant">{nomePoluente(selecionado.poluente)}</span>}
          onClose={fechar}
        >
          <div className="detail-badges">
            <NivelBadge alerta={selecionado} />
            <StatusBadge status={selecionado.status} />
          </div>

          <div className="alerts-drawer-value">
            <b>{formatarValorAlerta(selecionado.valor)}</b>
            <span>{selecionado.unidade}</span>
            <small>{rotuloValor(selecionado.tipoDado)}</small>
          </div>

          <p className="detail-desc">{selecionado.descricao}</p>

          <dl className="detail-kv">
            <div><dt>Poluente</dt><dd>{nomePoluente(selecionado.poluente)}</dd></div>
            <div><dt>Nível</dt><dd>{ROTULO_NIVEL[selecionado.nivel]}</dd></div>
            <div><dt>Status</dt><dd>{ROTULO_STATUS[selecionado.status]}</dd></div>
            <div><dt>Cidade</dt><dd>{selecionado.cidade}</dd></div>
            <div><dt>Estação / fonte</dt><dd>{nomeDaEstacaoDoAlerta(selecionado)}</dd></div>
            <div><dt>Data e hora da medição</dt><dd>{formatarDataHora(selecionado.medicaoEm)} ({tempoRelativo(selecionado.medicaoEm, atualizadoEm)})</dd></div>
            <div><dt>Origem do dado</dt><dd>{rotuloOrigem(selecionado.tipoDado)} ({NOME_FONTE[selecionado.origemDado]})</dd></div>
            <div><dt>Criado em</dt><dd>{formatarDataHora(selecionado.criadoEm)}</dd></div>
            <div><dt>Atualizado em</dt><dd>{formatarDataHora(selecionado.atualizadoEm)}</dd></div>
            {selecionado.resolvidoEm && <div><dt>Resolvido em</dt><dd>{formatarDataHora(selecionado.resolvidoEm)}</dd></div>}
          </dl>

          {isAdmin && selecionado.status === 'ATIVO' && (
            <div className="alerts-admin-action">
              {confirmandoResolver ? (
                <>
                  <p>Resolver este alerta manualmente?</p>
                  <div className="alerts-admin-buttons">
                    <button type="button" className="alerts-eval is-primary" onClick={resolverAlerta} disabled={resolvendo} data-testid="confirmar-resolver">
                      {resolvendo ? 'Resolvendo…' : 'Confirmar'}
                    </button>
                    <button type="button" className="alerts-eval" onClick={() => setConfirmandoResolver(false)} disabled={resolvendo}>Cancelar</button>
                  </div>
                </>
              ) : (
                <button type="button" className="alerts-eval" onClick={() => setConfirmandoResolver(true)} data-testid="resolver">
                  <Icon name="check" />
                  Resolver alerta
                </button>
              )}
              {erroResolver && <p className="alerts-aviso is-erro" role="alert">{erroResolver}</p>}
            </div>
          )}

          {selecionado.tipoDado === 'MODELO' && (
            <p className="quality-note">Estimativa do modelo CAMS, fornecida pela Open-Meteo. Não é uma medição local.</p>
          )}
          <p className="quality-note">Os níveis de alerta utilizam parâmetros técnicos provisórios.</p>
        </DetailDrawer>
      )}
    </div>
  );
}
