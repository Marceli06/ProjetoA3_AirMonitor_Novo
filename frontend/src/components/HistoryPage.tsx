import { PointerEvent, RefObject, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import CidadeEData from './CidadeEData';
import { historicoAPI } from '../api';
import { FonteHistorico, HistoricoResponse, PeriodoHistorico, PontoHistorico } from '../types';
import { NOME_FONTE, POLLUTANTS, formatarDistancia, formatarValor } from '../utils/formatar';
import { paginasVisiveis, partesDataHora, statusDoErro } from '../utils/ocorrencias';
import {
  COR_ORIGEM_HIST,
  OPCOES_FONTE_HIST,
  OPCOES_PERIODO_HIST,
  POR_PAGINA_HIST,
  ROTULO_ORIGEM_HIST,
  escalaDoEixo,
  indiceMaisProximo,
  mensagemErroHistorico,
  rotuloEixoX,
  trechosContinuos,
} from '../utils/historico';
import './HistoryPage.css';

interface HistoryPageProps {
  cidades: string[]; // ADMIN: todas as cidades suportadas; USUARIO: somente a própria
  cidade: string;
  onCidadeChange: (cidade: string) => void;
}

const plural = (n: number, singular: string, pluralTxt: string) => `${n} ${n === 1 ? singular : pluralTxt}`;

const formatarDataHoraCompleta = (iso: string) => {
  const { data, hora } = partesDataHora(iso);
  return `${data} ${hora}`;
};

// Largura em pixels do elemento, acompanhando redimensionamentos (o gráfico é desenhado nessa largura)
function useLargura(ref: RefObject<HTMLElement>) {
  const [largura, setLargura] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setLargura(Math.round(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return;
    const observador = new ResizeObserver(([entrada]) => setLargura(Math.round(entrada.contentRect.width)));
    observador.observe(el);
    return () => observador.disconnect();
  }, [ref]);
  return largura;
}

interface GraficoProps {
  pontos: PontoHistorico[];
  unidade: string;
  periodo: HistoricoResponse['periodo'];
  nomePoluente: string;
  compacto?: boolean; // versão baixa, usada no cartão do Dashboard
}

// Gráfico de evolução em SVG. O eixo X cobre todo o período pedido, então períodos sem dado aparecem como lacunas
// (a linha é interrompida e nada é interpolado). A cor indica a origem: estação (azul) ou modelo (roxo).
export function GraficoEvolucao({ pontos, unidade, periodo, nomePoluente, compacto = false }: GraficoProps) {
  const caixa = useRef<HTMLDivElement>(null);
  const medida = useLargura(caixa);
  const [ativo, setAtivo] = useState<number | null>(null);

  const largura = Math.max(medida, 240);
  const altura = compacto ? 190 : largura < 480 ? 230 : 290;
  const margem = { t: 14, r: 14, b: 30, l: largura < 480 ? 42 : 54 };
  const areaL = largura - margem.l - margem.r;
  const areaA = altura - margem.t - margem.b;

  const de = Date.parse(periodo.de);
  const ate = Date.parse(periodo.ate);
  const maximo = pontos.reduce((m, p) => Math.max(m, p.valor), 0);
  const eixo = useMemo(() => escalaDoEixo(maximo), [maximo]);
  const x = (instante: number) => margem.l + ((instante - de) / (ate - de)) * areaL;
  const y = (valor: number) => margem.t + (1 - valor / eixo.max) * areaA;
  const base = margem.t + areaA;

  const divisoesX = largura < 480 ? 3 : 6;
  const marcasX = Array.from({ length: divisoesX + 1 }, (_, i) => de + ((ate - de) * i) / divisoesX);
  const trechos = useMemo(() => trechosContinuos(pontos), [pontos]);
  const mostrarMarcas = pontos.length <= 48;
  const origem = pontos[0].origem;
  const cor = COR_ORIGEM_HIST[origem];

  const aoMover = (e: PointerEvent<SVGRectElement>) => {
    const caixaSvg = e.currentTarget.getBoundingClientRect();
    const instante = de + ((e.clientX - caixaSvg.left) / caixaSvg.width) * (ate - de);
    setAtivo(indiceMaisProximo(pontos, instante));
  };

  const pontoAtivo = ativo !== null ? pontos[Math.min(ativo, pontos.length - 1)] : null;
  const xAtivo = pontoAtivo ? x(Date.parse(pontoAtivo.dataHora)) : 0;
  const resumoAria = `Gráfico de evolução de ${nomePoluente} em ${unidade}, ${plural(pontos.length, 'medição', 'medições')} entre ${formatarDataHoraCompleta(pontos[0].dataHora)} e ${formatarDataHoraCompleta(pontos[pontos.length - 1].dataHora)}. Os valores também estão na tabela abaixo.`;

  return (
    <div className="hist-chart" ref={caixa} data-testid="historico-grafico">
      <svg width={largura} height={altura} viewBox={`0 0 ${largura} ${altura}`} role="img" aria-label={resumoAria}>
        <text x={margem.l} y={9} className="hist-axis-unit">{unidade}</text>
        {eixo.ticks.map((t) => (
          <g key={t}>
            <line x1={margem.l} x2={largura - margem.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'hist-axis-base' : 'hist-grid'} />
            <text x={margem.l - 7} y={y(t) + 4} textAnchor="end" className="hist-tick">{formatarValor(t)}</text>
          </g>
        ))}
        {marcasX.map((m, i) => (
          <text key={i} x={x(m)} y={altura - 9} textAnchor={i === 0 ? 'start' : i === divisoesX ? 'end' : 'middle'} className="hist-tick">
            {rotuloEixoX(m, periodo.codigo)}
          </text>
        ))}

        {trechos.map((trecho, i) => {
          const coordenadas = trecho.map((p) => `${x(Date.parse(p.dataHora)).toFixed(1)},${y(p.valor).toFixed(1)}`);
          if (trecho.length === 1) {
            const [cx, cy] = coordenadas[0].split(',');
            return <circle key={i} cx={cx} cy={cy} r={3.5} fill={cor} />;
          }
          const primeiro = x(Date.parse(trecho[0].dataHora)).toFixed(1);
          const ultimo = x(Date.parse(trecho[trecho.length - 1].dataHora)).toFixed(1);
          return (
            <g key={i}>
              <polygon points={`${coordenadas.join(' ')} ${ultimo},${base} ${primeiro},${base}`} fill={cor} opacity={0.12} />
              <polyline points={coordenadas.join(' ')} fill="none" stroke={cor} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}

        {mostrarMarcas &&
          pontos.map((p) => <circle key={p.dataHora} cx={x(Date.parse(p.dataHora))} cy={y(p.valor)} r={2.5} fill="#fff" stroke={cor} strokeWidth={1.5} />)}

        {pontoAtivo && (
          <g pointerEvents="none">
            <line x1={xAtivo} x2={xAtivo} y1={margem.t} y2={base} className="hist-cursor" />
            <circle cx={xAtivo} cy={y(pontoAtivo.valor)} r={5} fill={cor} stroke="#fff" strokeWidth={2} />
          </g>
        )}
        <rect
          x={margem.l}
          y={margem.t}
          width={areaL}
          height={areaA}
          fill="transparent"
          onPointerMove={aoMover}
          onPointerDown={aoMover}
          onPointerLeave={() => setAtivo(null)}
        />
      </svg>
      {pontoAtivo && (
        <div
          className="hist-tooltip"
          style={{ left: Math.min(Math.max(xAtivo - 80, 0), largura - 160) }}
          role="status"
          data-testid="grafico-info"
        >
          <strong>{formatarValor(pontoAtivo.valor)} {pontoAtivo.unidade}</strong>
          <span>{formatarDataHoraCompleta(pontoAtivo.dataHora)}</span>
          <small>{ROTULO_ORIGEM_HIST[pontoAtivo.origem]}</small>
        </div>
      )}
    </div>
  );
}

export default function HistoryPage({ cidades, cidade, onCidadeChange }: HistoryPageProps) {
  const [poluente, setPoluente] = useState('pm25');
  const [periodo, setPeriodo] = useState<PeriodoHistorico>('24H');
  const [fonte, setFonte] = useState<FonteHistorico>('AUTO');
  const [estacaoId, setEstacaoId] = useState('');
  const [pagina, setPagina] = useState(1);

  const [dados, setDados] = useState<HistoricoResponse | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [atualizadoEm, setAtualizadoEm] = useState(() => new Date());
  const [recarga, setRecarga] = useState(0);

  // Trocar de cidade descarta a série e a lista de estações (são da cidade anterior) e volta ao modo automático
  const [cidadeAtual, setCidadeAtual] = useState(cidade);
  if (cidadeAtual !== cidade) {
    setCidadeAtual(cidade);
    setDados(null);
    setEstacaoId('');
    setPagina(1);
    setAviso(null);
  }

  useEffect(() => {
    const controle = new AbortController();
    setCarregando(true);
    setErro(null);
    historicoAPI
      .consultar(
        { cidade, poluente, periodo, fonte, estacaoId: estacaoId ? Number(estacaoId) : undefined },
        controle.signal
      )
      .then(({ data }) => {
        setDados(data);
        setAtualizadoEm(new Date());
        setCarregando(false);
      })
      .catch((e) => {
        if (controle.signal.aborted) return;
        if (statusDoErro(e) === 404 && estacaoId) {
          // A estação escolhida deixou de existir para esta cidade/poluente: volta ao modo automático
          setEstacaoId('');
          setAviso('A estação escolhida não está disponível para este poluente. Voltamos para a seleção automática.');
          return;
        }
        setDados(null);
        setErro(mensagemErroHistorico(e));
        setCarregando(false);
      });
    return () => controle.abort();
  }, [cidade, poluente, periodo, fonte, estacaoId, recarga]);

  const aoMudarFiltro = () => {
    setPagina(1);
    setAviso(null);
  };

  const recentesPrimeiro = useMemo(() => (dados ? [...dados.pontos].reverse() : []), [dados]);
  const total = recentesPrimeiro.length;
  const totalPaginas = Math.max(1, Math.ceil(total / POR_PAGINA_HIST));
  const paginaAtual = Math.min(pagina, totalPaginas);
  const fatia = recentesPrimeiro.slice((paginaAtual - 1) * POR_PAGINA_HIST, paginaAtual * POR_PAGINA_HIST);
  const de = total === 0 ? 0 : (paginaAtual - 1) * POR_PAGINA_HIST + 1;
  const ate = Math.min(paginaAtual * POR_PAGINA_HIST, total);

  const unidade = dados?.poluente.unidade ?? '';
  const usouEstacao = dados?.fontesUtilizadas.includes('OPENAQ') ?? false;
  const usouModelo = dados?.fontesUtilizadas.includes('OPEN_METEO') ?? false;
  const distancia = formatarDistancia(dados?.estacao?.distanciaMetros ?? null);

  const cartoes: { chave: string; rotulo: string; valor: string; nota: string }[] = dados?.resumo
    ? [
        { chave: 'ultimo', rotulo: 'Último valor', valor: formatarValor(dados.resumo.ultimo.valor), nota: formatarDataHoraCompleta(dados.resumo.ultimo.dataHora) },
        { chave: 'media', rotulo: 'Média do período', valor: formatarValor(dados.resumo.media), nota: plural(dados.total, 'medição', 'medições') },
        { chave: 'minimo', rotulo: 'Mínimo', valor: formatarValor(dados.resumo.minimo), nota: 'menor valor registrado' },
        { chave: 'maximo', rotulo: 'Máximo', valor: formatarValor(dados.resumo.maximo), nota: 'maior valor registrado' },
      ]
    : [];

  return (
    <div className="hist-page" aria-busy={carregando}>
      <section className="dash-heading">
        <div className="hist-title">
          <span className="hist-title-icon"><Icon name="chart" /></span>
          <div>
            <h1>Histórico da Qualidade do Ar</h1>
            <p>Acompanhe a evolução das medições de cada poluente na sua região.</p>
          </div>
        </div>
        <CidadeEData cidades={cidades} cidade={cidade} onCidadeChange={onCidadeChange} atualizadoEm={atualizadoEm} />
      </section>

      <section className="dash-card hist-filters" aria-label="Filtros do histórico">
        <label className="hist-select">
          <span>Poluente:</span>
          <select aria-label="Poluente" value={poluente} onChange={(e) => { setPoluente(e.target.value); setEstacaoId(''); aoMudarFiltro(); }}>
            {POLLUTANTS.map((p) => (
              <option key={p.chave} value={p.chave}>{p.name} — {p.desc}</option>
            ))}
          </select>
          <Icon name="dropdown" />
        </label>
        <label className="hist-select">
          <Icon name="calendar" />
          <span>Período:</span>
          <select aria-label="Período" value={periodo} onChange={(e) => { setPeriodo(e.target.value as PeriodoHistorico); aoMudarFiltro(); }}>
            {OPCOES_PERIODO_HIST.map((p) => (
              <option key={p.valor} value={p.valor}>{p.rotulo}</option>
            ))}
          </select>
          <Icon name="dropdown" />
        </label>
        <label className="hist-select">
          <Icon name="layers" />
          <span>Origem:</span>
          <select aria-label="Origem do dado" value={fonte} onChange={(e) => { setFonte(e.target.value as FonteHistorico); setEstacaoId(''); aoMudarFiltro(); }}>
            {OPCOES_FONTE_HIST.map((f) => (
              <option key={f.valor} value={f.valor}>{f.rotulo}</option>
            ))}
          </select>
          <Icon name="dropdown" />
        </label>
        <label className="hist-select hist-select-wide">
          <Icon name="antenna" />
          <span>Estação:</span>
          <select
            aria-label="Estação"
            value={estacaoId}
            disabled={fonte === 'OPEN_METEO'}
            onChange={(e) => { setEstacaoId(e.target.value); aoMudarFiltro(); }}
          >
            <option value="">Automática (mais próxima com dados)</option>
            {(dados?.estacoes ?? []).map((e) => (
              <option key={e.id} value={String(e.id)}>
                {e.nome ?? `Estação ${e.id}`}
                {formatarDistancia(e.distanciaMetros) ? ` · ${formatarDistancia(e.distanciaMetros)}` : ''}
                {e.comDadosNoPeriodo ? '' : ' · sem dados no período'}
              </option>
            ))}
          </select>
          <Icon name="dropdown" />
        </label>
      </section>

      {aviso && (
        <p className="hist-aviso is-erro" role="status" data-testid="aviso">
          <span>{aviso}</span>
          <button type="button" className="hist-aviso-close" onClick={() => setAviso(null)} aria-label="Fechar aviso"><Icon name="close" /></button>
        </p>
      )}

      {erro ? (
        <section className="dash-card hist-state" data-testid="estado-erro" role="alert">
          <span className="hist-state-icon"><Icon name="warning" /></span>
          <strong>{erro}</strong>
          <button type="button" className="hist-btn" onClick={() => setRecarga((n) => n + 1)}>Tentar novamente</button>
        </section>
      ) : !dados ? (
        <section className="dash-card hist-state" data-testid="carregando" role="status">
          <span className="hist-state-icon"><Icon name="clock" /></span>
          <strong>Carregando histórico…</strong>
        </section>
      ) : dados.total === 0 ? (
        <section className="dash-card hist-state" data-testid="estado-vazio">
          <span className="hist-state-icon"><Icon name="search" /></span>
          <strong>Nenhum histórico disponível.</strong>
          <p>{dados.mensagem ?? 'Não há dados para os filtros escolhidos.'}</p>
          <p>Tente outro poluente, um período maior ou outra origem do dado.</p>
        </section>
      ) : (
        <div className={`hist-content${carregando ? ' is-loading' : ''}`} aria-busy={carregando}>
          {dados.aviso && (
            <p className="hist-aviso is-info" role="status" data-testid="aviso-fonte">
              <Icon name="info" />
              <span>{dados.aviso}</span>
            </p>
          )}

          <section className="hist-summary" aria-label="Resumo do período">
            {cartoes.map((c) => (
              <div key={c.chave} className="dash-card hist-stat" data-testid={`resumo-${c.chave}`}>
                <span className="hist-stat-label">{c.rotulo}</span>
                <strong>{c.valor} <small>{unidade}</small></strong>
                <span className="hist-stat-note">{c.nota}</span>
              </div>
            ))}
          </section>

          <section className="dash-card hist-chart-card">
            <div className="hist-card-head">
              <div>
                <h2><Icon name="chart" /> Evolução de {dados.poluente.nome}</h2>
                <p className="hist-source" data-testid="origem-dado">
                  <span className={`hist-origin is-${usouModelo && !usouEstacao ? 'modelo' : 'estacao'}`}>
                    {usouModelo && !usouEstacao ? ROTULO_ORIGEM_HIST.OPEN_METEO : ROTULO_ORIGEM_HIST.OPENAQ}
                  </span>
                  {usouEstacao && dados.estacao
                    ? `${dados.estacao.nome ?? `Estação ${dados.estacao.id}`}${distancia ? ` · a ${distancia} do centro` : ''}`
                    : usouModelo
                      ? `Estimativa do modelo CAMS para ${dados.cidade} (não é medição local)`
                      : ''}
                </p>
              </div>
              <span className="hist-period">{dados.periodo.rotulo}</span>
            </div>
            <GraficoEvolucao pontos={dados.pontos} unidade={unidade} periodo={dados.periodo} nomePoluente={dados.poluente.nome} />
            {dados.atribuicoes.map((a) => (
              <p key={a} className="hist-note" data-testid="atribuicao">{a}</p>
            ))}
          </section>

          <section className="dash-card hist-list-card">
            <div className="hist-card-head">
              <h2><Icon name="file" /> Medições</h2>
              <span className="hist-period">{plural(total, 'registro', 'registros')} · mais recentes primeiro</span>
            </div>
            <table className="hist-table">
              <thead>
                <tr>
                  <th scope="col">Data e hora</th>
                  <th scope="col">Valor</th>
                  <th scope="col">Poluente</th>
                  <th scope="col">Estação</th>
                  <th scope="col">Origem</th>
                </tr>
              </thead>
              <tbody>
                {fatia.map((p) => {
                  const { data, hora } = partesDataHora(p.dataHora);
                  return (
                    <tr key={p.dataHora} className="hist-row" data-testid="medicao">
                      <td className="hist-cell-data"><span className="hist-datetime"><b>{data}</b><small>{hora}</small></span></td>
                      <td className="hist-cell-valor"><b>{formatarValor(p.valor)}</b> <small>{p.unidade}</small></td>
                      <td className="hist-cell-poluente">{p.poluenteNome}</td>
                      <td className="hist-cell-estacao">{p.estacaoNome ?? (p.tipoDado === 'MODELO' ? `Modelo · ${dados.cidade}` : `Estação ${p.estacaoId ?? ''}`)}</td>
                      <td className="hist-cell-origem">
                        <span className={`hist-origin is-${p.tipoDado === 'MODELO' ? 'modelo' : 'estacao'}`} title={`${NOME_FONTE[p.origem]} — ${p.tipoDado === 'MODELO' ? 'estimativa por modelo' : 'medição de estação'}`}>
                          {ROTULO_ORIGEM_HIST[p.origem]}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="hist-footer">
              <span className="hist-range" data-testid="faixa">Mostrando {de} a {ate} de {plural(total, 'registro', 'registros')}</span>
              {totalPaginas > 1 && (
                <nav className="hist-pager" aria-label="Paginação" data-testid="paginacao">
                  <button type="button" className="hist-page-btn hist-page-prev" aria-label="Página anterior" disabled={paginaAtual <= 1} onClick={() => setPagina(paginaAtual - 1)}>
                    <Icon name="chevron" />
                  </button>
                  {paginasVisiveis(paginaAtual, totalPaginas).map((p) =>
                    typeof p === 'string' ? (
                      <span key={p} className="hist-page-gap" aria-hidden="true">…</span>
                    ) : (
                      <button
                        key={p}
                        type="button"
                        className={`hist-page-btn${p === paginaAtual ? ' active' : ''}`}
                        aria-label={`Página ${p}`}
                        aria-current={p === paginaAtual ? 'page' : undefined}
                        onClick={() => setPagina(p)}
                      >
                        {p}
                      </button>
                    )
                  )}
                  <button type="button" className="hist-page-btn" aria-label="Próxima página" disabled={paginaAtual >= totalPaginas} onClick={() => setPagina(paginaAtual + 1)}>
                    <Icon name="chevron" />
                  </button>
                </nav>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
