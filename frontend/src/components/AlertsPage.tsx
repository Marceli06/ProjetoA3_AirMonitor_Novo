import { useEffect, useMemo, useRef, useState } from 'react';
import Icon, { IconName } from './Icon';
import { AlertaAr, NivelAlerta } from '../types';
import { POLLUTANTS, ROTULO_FONTE, formatarDataHora } from '../utils/formatar';
import {
  FiltroStatus,
  NIVEIS_ORDEM,
  ROTULO_NIVEL,
  ROTULO_STATUS,
  filtrarAlertas,
  formatarValorAlerta,
  gerarAlertasIlustrativos,
  ordenarAlertas,
  resumirAlertas,
  tempoRelativo,
  tomDoAlerta,
} from '../utils/alertas';
import { CITIES } from './Register';
import './AlertsPage.css';

interface AlertsPageProps {
  cidades: string[]; // ADMIN: todas as cidades suportadas; USUARIO: somente a própria
  cidade: string;
  onCidadeChange: (cidade: string) => void;
}

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

const nomePoluente = (chave: string) => POLLUTANTS.find((p) => p.chave === chave)?.name ?? chave.toUpperCase();

const plural = (n: number, singular: string, pluralTxt: string) => `${n} ${n === 1 ? singular : pluralTxt}`;

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

export default function AlertsPage({ cidades, cidade, onCidadeChange }: AlertsPageProps) {
  const [status, setStatus] = useState<FiltroStatus>('TODOS');
  const [niveis, setNiveis] = useState<NivelAlerta[]>([]);
  const [selecionadoId, setSelecionadoId] = useState<string | null>(null);
  const botaoFecharRef = useRef<HTMLButtonElement>(null);
  const origemFocoRef = useRef<HTMLElement | null>(null);

  // Hora da "última atualização": renova a cada troca de cidade
  const agora = useMemo(() => new Date(), [cidade]);

  const todos = useMemo(() => ordenarAlertas(gerarAlertasIlustrativos(cidade, CITIES[cidade] ?? [], agora)), [cidade, agora]);
  const resumo = useMemo(() => resumirAlertas(todos), [todos]);
  const visiveis = useMemo(() => filtrarAlertas(todos, status, niveis), [todos, status, niveis]);
  const selecionado = todos.find((a) => a.id === selecionadoId) ?? null;

  const filtrosAtivos = status !== 'TODOS' || niveis.length > 0;
  const podeEscolherCidade = cidades.length > 1;

  const abrir = (alerta: AlertaAr) => {
    origemFocoRef.current = document.activeElement as HTMLElement | null;
    setSelecionadoId(alerta.id);
  };

  const fechar = () => {
    setSelecionadoId(null);
    origemFocoRef.current?.focus();
  };

  useEffect(() => {
    if (!selecionado) return undefined;
    botaoFecharRef.current?.focus();
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelecionadoId(null);
        origemFocoRef.current?.focus();
      }
    };
    document.addEventListener('keydown', aoTeclar);
    return () => document.removeEventListener('keydown', aoTeclar);
  }, [selecionado]);

  const alternarNivel = (nivel: NivelAlerta) =>
    setNiveis((atuais) => (atuais.includes(nivel) ? atuais.filter((n) => n !== nivel) : [...atuais, nivel]));

  const limparFiltros = () => {
    setStatus('TODOS');
    setNiveis([]);
  };

  const cartoes: { chave: string; rotulo: string; valor: number; nota: string; icone: IconName; tom: string }[] = [
    { chave: 'ativos', rotulo: 'Alertas ativos', valor: resumo.ativos, nota: 'Em andamento agora', icone: 'bell', tom: 'ativos' },
    { chave: 'alta', rotulo: 'Alta prioridade', valor: resumo.alta, nota: 'Níveis alto e crítico', icone: 'flame', tom: 'alta' },
    { chave: 'media', rotulo: 'Média prioridade', valor: resumo.media, nota: 'Nível moderado', icone: 'warning', tom: 'media' },
    { chave: 'resolvidos', rotulo: 'Resolvidos', valor: resumo.resolvidos, nota: 'Já normalizados', icone: 'check', tom: 'resolvidos' },
  ];

  const semAlertaAtivo = resumo.ativos === 0;
  // Sem alerta ativo: vale tanto para a lista inteira vazia quanto para o filtro "Ativos"
  const mensagemSemAtivo = semAlertaAtivo && status !== 'RESOLVIDO' && (status === 'ATIVO' || todos.length === 0);

  return (
    <div className="alerts-page">
      <section className="dash-heading">
        <div>
          <h1>Alertas de Qualidade do Ar</h1>
          <p>Acompanhe situações que podem exigir atenção na sua região.</p>
        </div>
        <div className="dash-filters">
          {podeEscolherCidade ? (
            <label className="dash-select">
              <Icon name="pin" />
              <select aria-label="Cidade" value={cidade} onChange={(e) => onCidadeChange(e.target.value)}>
                {cidades.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <Icon name="dropdown" />
            </label>
          ) : (
            <div className="dash-select alerts-city-fixed" aria-label="Cidade">
              <Icon name="pin" />
              <strong>{cidade}</strong>
            </div>
          )}
          <div className="dash-date">
            <Icon name="calendar" />
            <div>
              <strong>{formatarDataHora(agora.toISOString())}</strong>
              <small>Última atualização</small>
            </div>
          </div>
        </div>
      </section>

      <section className={`alerts-hero ${semAlertaAtivo ? 'tom-resolvido' : `tom-${(resumo.maisGrave ?? 'BAIXO').toLowerCase()}`}`} aria-live="polite">
        <span className="alerts-hero-icon"><Icon name={semAlertaAtivo ? 'shield' : ICONE_NIVEL[resumo.maisGrave ?? 'BAIXO']} /></span>
        <div className="alerts-hero-text">
          <strong>{semAlertaAtivo ? 'Situação sob controle' : TITULO_SITUACAO[resumo.maisGrave ?? 'BAIXO']}</strong>
          <span>
            {semAlertaAtivo
              ? `Nenhum alerta ativo em ${cidade} neste momento.`
              : `${plural(resumo.ativos, 'alerta ativo', 'alertas ativos')} em ${cidade}. Pessoas sensíveis devem redobrar a atenção.`}
          </span>
        </div>
        {!semAlertaAtivo && (
          <div className="alerts-hero-levels" aria-label="Alertas ativos por nível">
            {[...NIVEIS_ORDEM].reverse().filter((n) => resumo.ativosPorNivel[n] > 0).map((n) => (
              <span key={n} className={`alerts-mini tom-${n.toLowerCase()}`}>
                <b>{resumo.ativosPorNivel[n]}</b> {ROTULO_NIVEL[n]}
              </span>
            ))}
          </div>
        )}
      </section>

      <div className="alerts-summary">
        {cartoes.map((c) => (
          <article key={c.chave} className={`dash-card alerts-stat stat-${c.tom}`} data-testid={`resumo-${c.chave}`}>
            <span className="alerts-stat-icon"><Icon name={c.icone} /></span>
            <div>
              <span className="alerts-stat-label">{c.rotulo}</span>
              <strong>{c.valor}</strong>
              <small>{c.nota}</small>
            </div>
          </article>
        ))}
      </div>

      <section className="dash-card alerts-list-card">
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
                  onClick={() => setStatus(f.valor)}
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
                  className={`alerts-chip tom-${n.toLowerCase()}${niveis.includes(n) ? ' active' : ''}`}
                  aria-pressed={niveis.includes(n)}
                  onClick={() => alternarNivel(n)}
                >
                  <span className="alerts-chip-dot" />
                  {ROTULO_NIVEL[n]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="alerts-count-row">
          <span data-testid="contagem">
            Mostrando <b>{visiveis.length}</b> de {plural(todos.length, 'alerta', 'alertas')}
          </span>
          {filtrosAtivos && (
            <button type="button" className="alerts-clear" onClick={limparFiltros}>
              <Icon name="close" /> Limpar filtros
            </button>
          )}
        </div>

        {visiveis.length === 0 ? (
          <div className="alerts-empty" data-testid="estado-vazio">
            <span className="alerts-empty-icon"><Icon name={mensagemSemAtivo ? 'shield' : 'bell'} /></span>
            {mensagemSemAtivo ? (
              <>
                <strong>Nenhum alerta ativo no momento.</strong>
                <p>Os níveis monitorados estão dentro dos limites configurados.</p>
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
            {visiveis.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className={`alert-item tom-${tomDoAlerta(a)}${a.status === 'RESOLVIDO' ? ' is-resolvido' : ''}${selecionadoId === a.id ? ' is-selected' : ''}`}
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
                      <span><Icon name="pin" />{a.cidade} · {a.estacao}</span>
                      <span><Icon name="clock" />{tempoRelativo(a.dataHora, agora)} · {formatarDataHora(a.dataHora)}</span>
                      <span className={`alert-origin origem-${a.origem === 'OPENAQ' ? 'estacao' : 'modelo'}`}>{ROTULO_FONTE[a.origem]}</span>
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

        <p className="quality-note">
          Alertas ilustrativos: a geração automática e os limiares definitivos serão entregues em etapa futura. Os valores exibidos não vêm de medições reais.
        </p>
      </section>

      {selecionado && (
        <div className="alerts-overlay" onClick={fechar} data-testid="alerta-overlay">
          <aside
            className={`alerts-drawer tom-${tomDoAlerta(selecionado)}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="alerta-titulo"
            onClick={(e) => e.stopPropagation()}
            data-testid="alerta-detalhe"
          >
            <header className="alerts-drawer-head">
              <span className="alerts-drawer-icon"><Icon name={selecionado.status === 'RESOLVIDO' ? 'check' : ICONE_NIVEL[selecionado.nivel]} /></span>
              <div>
                <span className="alert-pollutant">{nomePoluente(selecionado.poluente)}</span>
                <h2 id="alerta-titulo">{selecionado.titulo}</h2>
              </div>
              <button ref={botaoFecharRef} type="button" className="alerts-drawer-close" onClick={fechar} aria-label="Fechar detalhes">
                <Icon name="close" />
              </button>
            </header>

            <div className="alerts-drawer-badges">
              <NivelBadge alerta={selecionado} />
              <StatusBadge status={selecionado.status} />
            </div>

            <div className="alerts-drawer-value">
              <b>{formatarValorAlerta(selecionado.valor)}</b>
              <span>{selecionado.unidade}</span>
              <small>valor medido ou estimado</small>
            </div>

            <p className="alerts-drawer-desc">{selecionado.detalhe}</p>

            <dl className="alerts-drawer-kv">
              <div><dt>Poluente</dt><dd>{nomePoluente(selecionado.poluente)}</dd></div>
              <div><dt>Nível</dt><dd>{ROTULO_NIVEL[selecionado.nivel]}</dd></div>
              <div><dt>Status</dt><dd>{ROTULO_STATUS[selecionado.status]}</dd></div>
              <div><dt>Cidade</dt><dd>{selecionado.cidade}</dd></div>
              <div><dt>Estação / fonte</dt><dd>{selecionado.estacao}</dd></div>
              <div><dt>Data e hora</dt><dd>{formatarDataHora(selecionado.dataHora)} ({tempoRelativo(selecionado.dataHora, agora)})</dd></div>
              <div><dt>Origem do dado</dt><dd>{ROTULO_FONTE[selecionado.origem]}</dd></div>
            </dl>

            <p className="quality-note">Alerta ilustrativo: exemplo de interface, sem medição real associada.</p>

            <button type="button" className="alerts-drawer-done" onClick={fechar}>Fechar</button>
          </aside>
        </div>
      )}
    </div>
  );
}
