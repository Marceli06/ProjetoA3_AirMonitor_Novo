import { useEffect, useState } from 'react';
import Icon, { IconName } from './Icon';
import CidadeEData from './CidadeEData';
import DetailDrawer from './DetailDrawer';
import NovaOcorrenciaForm from './NovaOcorrenciaForm';
import { ocorrenciasAPI } from '../api';
import { ListaOcorrenciasResponse, NivelAlerta, Ocorrencia, StatusOcorrencia, TipoOcorrencia } from '../types';
import { formatarDataHora, formatarValor } from '../utils/formatar';
import { ROTULO_NIVEL, nomePoluente } from '../utils/alertas';
import {
  ACOES_STATUS,
  FILTROS_PADRAO,
  FiltrosOcorrencias,
  LIMITES_FORM,
  OPCOES_PERIODO,
  POR_PAGINA,
  ROTULO_ORIGEM,
  ROTULO_STATUS_OC,
  ROTULO_TIPO,
  STATUS_ORDEM,
  TIPOS_ORDEM,
  TOM_STATUS,
  etapasDaOcorrencia,
  formatarIdOcorrencia,
  intervaloDoPeriodo,
  mensagemErroOcorrencia,
  paginasVisiveis,
  partesDataHora,
  statusDoErro,
  temFiltroAtivo,
} from '../utils/ocorrencias';
import './Severidade.css';
import './OccurrencesPage.css';

interface OccurrencesPageProps {
  cidades: string[]; // ADMIN: todas as cidades suportadas; USUARIO: somente a própria
  cidade: string;
  onCidadeChange: (cidade: string) => void;
  isAdmin: boolean; // só controla a exibição das ações de status; o backend é quem autoriza (403 para não ADMIN)
}

const ICONE_TIPO: Record<TipoOcorrencia, IconName> = { POLUICAO: 'warning', QUEIMADA: 'wind', EMISSAO: 'factory', COMUNIDADE: 'users', NORMALIZACAO: 'check' };
const ICONE_STATUS: Record<StatusOcorrencia, IconName> = { ABERTA: 'alert', EM_ANDAMENTO: 'clock', CONCLUIDA: 'check' };
const TOM_NIVEL: Record<NivelAlerta, string> = { BAIXO: 'baixo', MODERADO: 'moderado', ALTO: 'alto', CRITICO: 'critico' };
const NOTA_CARTAO = { total: 'Todas as registradas', filtrado: 'Conforme os filtros', ABERTA: 'Aguardando atendimento', EM_ANDAMENTO: 'Sendo tratadas', CONCLUIDA: 'Já resolvidas' };
const ATRASO_BUSCA_MS = 350;

const plural = (n: number, singular: string, pluralTxt: string) => `${n} ${n === 1 ? singular : pluralTxt}`;
const percentual = (parte: number, total: number) => (total ? Math.round((parte / total) * 100) : 0);

type Aviso = { tipo: 'ok' | 'erro'; texto: string };

function StatusTag({ status }: { status: StatusOcorrencia }) {
  return (
    <span className={`oc-status tom-${TOM_STATUS[status]}`}>
      <span className="oc-status-dot" />
      {ROTULO_STATUS_OC[status]}
    </span>
  );
}

function TipoTag({ tipo }: { tipo: TipoOcorrencia }) {
  return (
    <span className={`oc-tipo oc-tipo-${tipo.toLowerCase()}`}>
      <span className="oc-tipo-dot" />
      {ROTULO_TIPO[tipo]}
    </span>
  );
}

const ETAPAS: { etapa: StatusOcorrencia; rotulo: string }[] = [
  { etapa: 'ABERTA', rotulo: 'Registrada' },
  { etapa: 'EM_ANDAMENTO', rotulo: 'Em andamento' },
  { etapa: 'CONCLUIDA', rotulo: 'Concluída' },
];

function LinhaDoTempo({ ocorrencia }: { ocorrencia: Ocorrencia }) {
  const alcancadas = etapasDaOcorrencia(ocorrencia);
  return (
    <ol className="oc-timeline" aria-label="Linha do tempo da ocorrência">
      {ETAPAS.map(({ etapa, rotulo }) => {
        const feita = alcancadas.find((e) => e.etapa === etapa);
        return (
          <li key={etapa} className={feita ? 'is-done' : 'is-pending'}>
            <span className="oc-timeline-dot">{feita && <Icon name="check" />}</span>
            <div>
              <strong>{rotulo}</strong>
              <small>{feita ? formatarDataHora(feita.dataHora) : 'Pendente'}</small>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default function OccurrencesPage({ cidades, cidade, onCidadeChange, isAdmin }: OccurrencesPageProps) {
  const [filtros, setFiltros] = useState<FiltrosOcorrencias>(FILTROS_PADRAO);
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [pagina, setPagina] = useState(1);
  const [selecionada, setSelecionada] = useState<Ocorrencia | null>(null);
  const [formAberto, setFormAberto] = useState(false);

  const [lista, setLista] = useState<ListaOcorrenciasResponse | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [atualizadoEm, setAtualizadoEm] = useState(() => new Date());
  const [recarga, setRecarga] = useState(0);
  const [aviso, setAviso] = useState<Aviso | null>(null);

  const [alterando, setAlterando] = useState(false);
  const [confirmandoConcluir, setConfirmandoConcluir] = useState(false);
  const [erroStatus, setErroStatus] = useState<string | null>(null);

  // Trocar de cidade (só ADMIN) volta à primeira página e fecha painéis; os filtros escolhidos continuam
  const [cidadeAtual, setCidadeAtual] = useState(cidade);
  if (cidadeAtual !== cidade) {
    setCidadeAtual(cidade);
    setLista(null);
    setPagina(1);
    setSelecionada(null);
    setFormAberto(false);
    setAviso(null);
  }

  const recarregar = () => setRecarga((n) => n + 1);

  // A busca só vai para o servidor depois de uma pausa na digitação
  useEffect(() => {
    const t = window.setTimeout(() => {
      setBuscaAplicada(filtros.busca.trim());
      setPagina(1);
    }, ATRASO_BUSCA_MS);
    return () => window.clearTimeout(t);
  }, [filtros.busca]);

  // Filtros e paginação são feitos pelo backend (GET /api/ocorrencias)
  useEffect(() => {
    const controle = new AbortController();
    setCarregando(true);
    setErro(null);
    const { de, ate } = intervaloDoPeriodo(filtros.periodo);
    ocorrenciasAPI
      .listar(
        {
          cidade,
          status: filtros.status === 'TODOS' ? undefined : filtros.status,
          tipo: filtros.tipo === 'TODOS' ? undefined : filtros.tipo,
          busca: buscaAplicada || undefined,
          de,
          ate,
          limite: POR_PAGINA,
          pagina,
        },
        controle.signal
      )
      .then(({ data }) => {
        setLista(data);
        setAtualizadoEm(new Date());
        setCarregando(false);
      })
      .catch((e) => {
        if (controle.signal.aborted) return;
        setLista(null);
        setErro(mensagemErroOcorrencia(e, 'carregar'));
        setCarregando(false);
      });
    return () => controle.abort();
  }, [cidade, filtros.status, filtros.tipo, filtros.periodo, buscaAplicada, pagina, recarga]);

  const total = lista?.total ?? 0;
  const totalPaginas = Math.max(1, Math.ceil(total / POR_PAGINA));

  // Se a página atual esvaziou (ex.: ocorrência concluída com o filtro "Em aberto"), volta para a última existente
  useEffect(() => {
    if (lista && lista.ocorrencias.length === 0 && lista.total > 0 && pagina > 1) setPagina(totalPaginas);
  }, [lista, pagina, totalPaginas]);

  // Ao abrir o painel, busca a ocorrência de novo (GET /api/ocorrencias/:id): se foi removida (404), fecha e avisa
  const selecionadaId = selecionada?.id ?? null;
  useEffect(() => {
    if (selecionadaId === null) return;
    const controle = new AbortController();
    ocorrenciasAPI
      .obter(selecionadaId, controle.signal)
      .then(({ data }) => setSelecionada((atual) => (atual && atual.id === data.ocorrencia.id ? data.ocorrencia : atual)))
      .catch((e) => {
        if (controle.signal.aborted || statusDoErro(e) !== 404) return;
        setSelecionada(null);
        setAviso({ tipo: 'erro', texto: mensagemErroOcorrencia(e, 'detalhar') });
        setRecarga((n) => n + 1);
      });
    return () => controle.abort();
  }, [selecionadaId]);

  const resumo = lista?.resumo ?? null;
  const totalGeral = resumo ? resumo.ABERTA + resumo.EM_ANDAMENTO + resumo.CONCLUIDA : 0;
  const filtrosAtivos = temFiltroAtivo(filtros);
  const filtroSemStatus = filtros.busca.trim() !== '' || filtros.tipo !== 'TODOS' || filtros.periodo !== 'TODOS';
  const ocorrencias = lista?.ocorrencias ?? [];
  const de = ocorrencias.length ? (pagina - 1) * POR_PAGINA + 1 : 0;
  const ate = ocorrencias.length ? de + ocorrencias.length - 1 : 0;

  // Qualquer mudança de filtro volta para a primeira página
  const alterarFiltros = (parcial: Partial<FiltrosOcorrencias>) => {
    setFiltros((atuais) => ({ ...atuais, ...parcial }));
    setPagina(1);
  };
  const limparFiltros = () => {
    setFiltros(FILTROS_PADRAO);
    setBuscaAplicada('');
    setPagina(1);
  };

  const abrir = (o: Ocorrencia) => {
    setSelecionada(o);
    setConfirmandoConcluir(false);
    setErroStatus(null);
  };
  const fechar = () => setSelecionada(null);

  // ADMIN: ABERTA -> EM_ANDAMENTO | CONCLUIDA e EM_ANDAMENTO -> CONCLUIDA (PATCH /api/ocorrencias/:id/status)
  const alterarStatus = async (novo: StatusOcorrencia) => {
    if (!selecionada) return;
    const alvo = selecionada;
    setAlterando(true);
    setErroStatus(null);
    try {
      const { data } = await ocorrenciasAPI.alterarStatus(alvo.id, novo);
      setSelecionada(data.ocorrencia);
      setConfirmandoConcluir(false);
      setAviso({ tipo: 'ok', texto: `Ocorrência ${formatarIdOcorrencia(alvo.id)} atualizada: ${ROTULO_STATUS_OC[novo]}.` });
      recarregar();
    } catch (e) {
      const codigo = statusDoErro(e);
      if (codigo === 409) {
        // Outra pessoa já mudou o status: mostra o estado atual devolvido pelo servidor
        const atual = (e as { response?: { data?: { ocorrencia?: Ocorrencia } } }).response?.data?.ocorrencia;
        if (atual) setSelecionada(atual);
        setConfirmandoConcluir(false);
        setErroStatus(mensagemErroOcorrencia(e, 'alterar'));
        recarregar();
      } else if (codigo === 404) {
        setSelecionada(null);
        setAviso({ tipo: 'erro', texto: mensagemErroOcorrencia(e, 'alterar') });
        recarregar();
      } else {
        setErroStatus(mensagemErroOcorrencia(e, 'alterar'));
      }
    } finally {
      setAlterando(false);
    }
  };

  const aoCriar = (nova: Ocorrencia) => {
    setFormAberto(false);
    setFiltros(FILTROS_PADRAO);
    setBuscaAplicada('');
    setPagina(1);
    setAviso({ tipo: 'ok', texto: `Ocorrência ${formatarIdOcorrencia(nova.id)} registrada com sucesso.` });
    recarregar();
  };

  const cartoes: { chave: string; filtro: FiltrosOcorrencias['status']; rotulo: string; valor: number | undefined; nota: string; icone: IconName; tom: string }[] = [
    { chave: 'total', filtro: 'TODOS', rotulo: 'Total de ocorrências', valor: resumo ? totalGeral : undefined, nota: filtroSemStatus ? NOTA_CARTAO.filtrado : NOTA_CARTAO.total, icone: 'file', tom: 'total' },
    { chave: 'abertas', filtro: 'ABERTA', rotulo: 'Em aberto', valor: resumo?.ABERTA, nota: NOTA_CARTAO.ABERTA, icone: 'alert', tom: 'critico' },
    { chave: 'andamento', filtro: 'EM_ANDAMENTO', rotulo: 'Em andamento', valor: resumo?.EM_ANDAMENTO, nota: NOTA_CARTAO.EM_ANDAMENTO, icone: 'clock', tom: 'moderado' },
    { chave: 'concluidas', filtro: 'CONCLUIDA', rotulo: 'Concluídas', valor: resumo?.CONCLUIDA, nota: NOTA_CARTAO.CONCLUIDA, icone: 'check', tom: 'resolvido' },
  ];

  const semRegistros = total === 0 && !filtrosAtivos;
  const acoes = selecionada ? ACOES_STATUS[selecionada.status] : [];
  const acaoConcluir = acoes.find((a) => a.para === 'CONCLUIDA');
  const acaoIniciar = acoes.find((a) => a.para === 'EM_ANDAMENTO');
  const dadosMomento =
    selecionada && selecionada.poluente !== null && selecionada.valor !== null && selecionada.unidade !== null
      ? { poluente: selecionada.poluente, valor: selecionada.valor, unidade: selecionada.unidade, nivel: selecionada.nivel }
      : null;

  return (
    <div className="oc-page">
      <section className="dash-heading">
        <div className="oc-title">
          <span className="oc-title-icon"><Icon name="clipboard" /></span>
          <div>
            <h1>Ocorrências Ambientais</h1>
            <p>Registre e acompanhe situações relacionadas à qualidade do ar.</p>
          </div>
        </div>
        <div className="oc-head-right">
          <CidadeEData cidades={cidades} cidade={cidade} onCidadeChange={onCidadeChange} atualizadoEm={atualizadoEm} />
          <button type="button" className="oc-btn is-primary oc-new" onClick={() => setFormAberto(true)} data-testid="nova-ocorrencia">
            <span aria-hidden="true">+</span> Nova ocorrência
          </button>
        </div>
      </section>

      {aviso && (
        <p className={`oc-aviso is-${aviso.tipo}`} role={aviso.tipo === 'erro' ? 'alert' : 'status'} data-testid="aviso">
          <span>{aviso.texto}</span>
          <button type="button" className="oc-aviso-close" onClick={() => setAviso(null)} aria-label="Fechar aviso"><Icon name="close" /></button>
        </p>
      )}

      <section className="oc-summary" aria-label="Resumo das ocorrências">
        <div className="oc-summary-cards">
          {cartoes.map((c) => (
            <button
              key={c.chave}
              type="button"
              className={`dash-card oc-stat tom-${c.tom}${filtros.status === c.filtro ? ' is-active' : ''}`}
              aria-pressed={filtros.status === c.filtro}
              onClick={() => alterarFiltros({ status: c.filtro })}
              title={c.filtro === 'TODOS' ? 'Mostrar todas as ocorrências' : `Filtrar por: ${c.rotulo}`}
              data-testid={`resumo-${c.chave}`}
            >
              <span className="oc-stat-icon"><Icon name={c.icone} /></span>
              <span className="oc-stat-body">
                <span className="oc-stat-label">{c.rotulo}</span>
                <strong>{c.valor ?? '–'}</strong>
                <small>{c.filtro === 'TODOS' || c.valor === undefined ? c.nota : `${percentual(c.valor, totalGeral)}% do total · ${c.nota}`}</small>
              </span>
            </button>
          ))}
        </div>
        {resumo && totalGeral > 0 && (
          <div className="oc-bar" role="img" aria-label={`${resumo.ABERTA} em aberto, ${resumo.EM_ANDAMENTO} em andamento e ${resumo.CONCLUIDA} concluídas`} data-testid="barra">
            <span className="oc-bar-seg tom-critico" style={{ flexGrow: resumo.ABERTA }} />
            <span className="oc-bar-seg tom-moderado" style={{ flexGrow: resumo.EM_ANDAMENTO }} />
            <span className="oc-bar-seg tom-resolvido" style={{ flexGrow: resumo.CONCLUIDA }} />
          </div>
        )}
      </section>

      <section className={`dash-card oc-list-card${carregando && lista ? ' is-loading' : ''}`} aria-busy={carregando}>
        <div className="oc-toolbar">
          <label className="oc-search">
            <Icon name="search" />
            <input
              type="search"
              value={filtros.busca}
              maxLength={LIMITES_FORM.busca.max}
              onChange={(e) => setFiltros((atuais) => ({ ...atuais, busca: e.target.value }))}
              placeholder="Buscar por título, descrição, local ou estação..."
              aria-label="Buscar ocorrências"
            />
          </label>
          <label className="oc-select">
            <span>Status:</span>
            <select aria-label="Status" value={filtros.status} onChange={(e) => alterarFiltros({ status: e.target.value as FiltrosOcorrencias['status'] })}>
              <option value="TODOS">Todos</option>
              {STATUS_ORDEM.map((s) => (
                <option key={s} value={s}>{ROTULO_STATUS_OC[s]}</option>
              ))}
            </select>
            <Icon name="dropdown" />
          </label>
          <label className="oc-select">
            <span>Tipo:</span>
            <select aria-label="Tipo" value={filtros.tipo} onChange={(e) => alterarFiltros({ tipo: e.target.value as FiltrosOcorrencias['tipo'] })}>
              <option value="TODOS">Todos</option>
              {TIPOS_ORDEM.map((t) => (
                <option key={t} value={t}>{ROTULO_TIPO[t]}</option>
              ))}
            </select>
            <Icon name="dropdown" />
          </label>
          <label className="oc-select">
            <Icon name="calendar" />
            <span>Período:</span>
            <select aria-label="Período" value={filtros.periodo} onChange={(e) => alterarFiltros({ periodo: e.target.value as FiltrosOcorrencias['periodo'] })}>
              {OPCOES_PERIODO.map((p) => (
                <option key={p.valor} value={p.valor}>{p.rotulo}</option>
              ))}
            </select>
            <Icon name="dropdown" />
          </label>
        </div>

        {filtrosAtivos && !erro && lista && (
          <div className="oc-active-row">
            <span data-testid="contagem-filtrada">{plural(total, 'ocorrência encontrada', 'ocorrências encontradas')}</span>
            <button type="button" className="oc-clear" onClick={limparFiltros}>
              <Icon name="close" /> Limpar filtros
            </button>
          </div>
        )}

        {erro ? (
          <div className="oc-empty" data-testid="estado-erro" role="alert">
            <span className="oc-empty-icon"><Icon name="warning" /></span>
            <strong>{erro}</strong>
            <button type="button" className="oc-btn is-primary" onClick={recarregar}>Tentar novamente</button>
          </div>
        ) : !lista ? (
          <div className="oc-empty" data-testid="carregando" role="status">
            <span className="oc-empty-icon"><Icon name="clock" /></span>
            <strong>Carregando ocorrências…</strong>
          </div>
        ) : ocorrencias.length === 0 ? (
          <div className="oc-empty" data-testid="estado-vazio">
            <span className="oc-empty-icon"><Icon name={semRegistros ? 'clipboard' : 'search'} /></span>
            {semRegistros ? (
              <>
                <strong>Nenhuma ocorrência registrada para esta região.</strong>
                <p>Use “Nova ocorrência” para registrar uma situação observada.</p>
              </>
            ) : (
              <>
                <strong>Nenhuma ocorrência encontrada.</strong>
                <p>Tente alterar os filtros ou o período selecionado.</p>
              </>
            )}
          </div>
        ) : (
          <>
            <table className="oc-table">
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Título / Descrição</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Local / Estação</th>
                  <th scope="col">Data e Hora</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {ocorrencias.map((o) => {
                  const { data, hora } = partesDataHora(o.criadoEm);
                  return (
                    <tr
                      key={o.id}
                      className={`oc-row tom-${TOM_STATUS[o.status]}${selecionada?.id === o.id ? ' is-selected' : ''}`}
                      onClick={() => abrir(o)}
                      data-testid="ocorrencia"
                    >
                      <td className="oc-cell-id"><span className="oc-id">{formatarIdOcorrencia(o.id)}</span></td>
                      <td className="oc-cell-main">
                        <span className="oc-main">
                          <span className={`oc-main-icon oc-tipo-${o.tipo.toLowerCase()}`}><Icon name={ICONE_TIPO[o.tipo]} /></span>
                          <span className="oc-main-text">
                            <button type="button" className="oc-open" aria-label={`Ver detalhes: ${formatarIdOcorrencia(o.id)} ${o.titulo}`}>{o.titulo}</button>
                            <span className="oc-desc">{o.descricao}</span>
                          </span>
                        </span>
                      </td>
                      <td className="oc-cell-tipo"><TipoTag tipo={o.tipo} /></td>
                      <td className="oc-cell-local">
                        <span className="oc-with-icon"><Icon name="pin" /><span className="oc-local-text">{o.local}{o.estacaoNome && <small>{o.estacaoNome}</small>}</span></span>
                      </td>
                      <td className="oc-cell-data">
                        <span className="oc-with-icon"><Icon name="calendar" /><span className="oc-datetime"><b>{data}</b><small>{hora}</small></span></span>
                      </td>
                      <td className="oc-cell-status"><StatusTag status={o.status} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="oc-footer">
              <span className="oc-range" data-testid="faixa">
                Mostrando {de} a {ate} de {plural(total, 'ocorrência', 'ocorrências')}
              </span>
              {totalPaginas > 1 && (
                <nav className="oc-pager" aria-label="Paginação" data-testid="paginacao">
                  <button type="button" className="oc-page-btn oc-page-prev" aria-label="Página anterior" disabled={pagina <= 1} onClick={() => setPagina(pagina - 1)}>
                    <Icon name="chevron" />
                  </button>
                  {paginasVisiveis(pagina, totalPaginas).map((p) =>
                    typeof p === 'string' ? (
                      <span key={p} className="oc-page-gap" aria-hidden="true">…</span>
                    ) : (
                      <button
                        key={p}
                        type="button"
                        className={`oc-page-btn${p === pagina ? ' active' : ''}`}
                        aria-label={`Página ${p}`}
                        aria-current={p === pagina ? 'page' : undefined}
                        onClick={() => setPagina(p)}
                      >
                        {p}
                      </button>
                    )
                  )}
                  <button type="button" className="oc-page-btn" aria-label="Próxima página" disabled={pagina >= totalPaginas} onClick={() => setPagina(pagina + 1)}>
                    <Icon name="chevron" />
                  </button>
                </nav>
              )}
            </div>
          </>
        )}
      </section>

      {formAberto && <NovaOcorrenciaForm cidade={cidade} onCancelar={() => setFormAberto(false)} onCriada={aoCriar} />}

      {selecionada && (
        <DetailDrawer
          titulo={selecionada.titulo}
          tituloId="ocorrencia-titulo"
          testId="ocorrencia"
          className={`tom-${TOM_STATUS[selecionada.status]}`}
          icone={<Icon name={ICONE_STATUS[selecionada.status]} />}
          etiqueta={<span className="oc-id">{formatarIdOcorrencia(selecionada.id)}</span>}
          onClose={fechar}
        >
          <div className="detail-badges">
            <StatusTag status={selecionada.status} />
            <TipoTag tipo={selecionada.tipo} />
            <span className={`oc-registro is-${selecionada.origem.toLowerCase()}`}>
              <Icon name={selecionada.origem === 'AUTOMATICA' ? 'antenna' : 'users'} />
              {ROTULO_ORIGEM[selecionada.origem]}
            </span>
          </div>

          <p className="detail-desc">{selecionada.descricao}</p>

          <dl className="detail-kv">
            <div><dt>ID</dt><dd>{formatarIdOcorrencia(selecionada.id)}</dd></div>
            <div><dt>Tipo</dt><dd>{ROTULO_TIPO[selecionada.tipo]}</dd></div>
            <div><dt>Status</dt><dd>{ROTULO_STATUS_OC[selecionada.status]}</dd></div>
            <div><dt>Cidade</dt><dd>{selecionada.cidade}</dd></div>
            <div><dt>Local</dt><dd>{selecionada.local}</dd></div>
            {selecionada.estacaoNome && <div><dt>Estação</dt><dd>{selecionada.estacaoNome}</dd></div>}
            <div><dt>Data e hora</dt><dd>{formatarDataHora(selecionada.criadoEm)}</dd></div>
            <div><dt>Atualizada em</dt><dd>{formatarDataHora(selecionada.atualizadoEm)}</dd></div>
          </dl>

          {dadosMomento && (
            <section className={`oc-moment tom-${dadosMomento.nivel ? TOM_NIVEL[dadosMomento.nivel] : 'total'}`} aria-labelledby="oc-momento-titulo" data-testid="dados-momento">
              <h3 id="oc-momento-titulo"><Icon name="chart" /> Dados do Momento</h3>
              <div className="oc-moment-body">
                <div>
                  <span className="oc-moment-label">{nomePoluente(dadosMomento.poluente)}</span>
                  <b>{formatarValor(dadosMomento.valor)}</b> <span className="oc-moment-unit">{dadosMomento.unidade}</span>
                </div>
                {dadosMomento.nivel && (
                  <div className="oc-moment-level">
                    <span className="oc-moment-label">Nível</span>
                    <span className="alert-level"><Icon name="info" />{ROTULO_NIVEL[dadosMomento.nivel]}</span>
                  </div>
                )}
              </div>
            </section>
          )}

          <section className="oc-block">
            <h3><Icon name="clock" /> Linha do tempo</h3>
            <LinhaDoTempo ocorrencia={selecionada} />
          </section>

          {isAdmin && acoes.length > 0 && (
            <div className="oc-admin-action" data-testid="acoes-status">
              {confirmandoConcluir ? (
                <>
                  <p>Concluir esta ocorrência? Depois de concluída, ela não pode ser reaberta.</p>
                  <div className="oc-admin-buttons">
                    <button type="button" className="oc-btn is-primary" onClick={() => alterarStatus('CONCLUIDA')} disabled={alterando} data-testid="confirmar-concluir">
                      {alterando ? 'Concluindo…' : 'Confirmar'}
                    </button>
                    <button type="button" className="oc-btn" onClick={() => setConfirmandoConcluir(false)} disabled={alterando}>Cancelar</button>
                  </div>
                </>
              ) : (
                <div className="oc-admin-buttons">
                  {acaoIniciar && (
                    <button type="button" className="oc-btn" onClick={() => alterarStatus('EM_ANDAMENTO')} disabled={alterando} data-testid="iniciar">
                      <Icon name="clock" /> {alterando ? 'Atualizando…' : acaoIniciar.rotulo}
                    </button>
                  )}
                  {acaoConcluir && (
                    <button type="button" className="oc-btn is-primary" onClick={() => setConfirmandoConcluir(true)} disabled={alterando} data-testid="concluir">
                      <Icon name="check" /> {acaoConcluir.rotulo}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {erroStatus && <p className="oc-aviso is-erro" role="alert" data-testid="erro-status">{erroStatus}</p>}
          {!isAdmin && selecionada.status !== 'CONCLUIDA' && (
            <p className="quality-note">Somente administradores alteram o status das ocorrências.</p>
          )}
        </DetailDrawer>
      )}
    </div>
  );
}
