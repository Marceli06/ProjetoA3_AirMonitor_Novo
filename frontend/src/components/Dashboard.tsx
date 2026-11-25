import { useState } from 'react';
import UsersPage from './UsersPage';
import StationsPage from './StationsPage';
import SettingsPage from './SettingsPage';
import ReportsPage from './ReportsPage';
import AlertsPage from './AlertsPage';
import OccurrencesPage from './OccurrencesPage';
import HistoryPage, { GraficoEvolucao } from './HistoryPage';
import Icon, { IconName } from './Icon';
import { AdminStationSummary, AdminUserStats } from './AdminWidgets';
import { CITIES } from './Register';
import { CIDADE_PADRAO, lerUsuarioLogado, useQualidadeAr } from '../hooks/useQualidadeAr';
import { useAlertasAtivos, useHistoricoDoDia, useOcorrenciasRecentes } from '../hooks/useDashboardDados';
import { MedicaoAr, StatusOcorrencia } from '../types';
import { ROTULO_NIVEL, formatarValorAlerta, nomePoluente, rotuloOrigem, tempoRelativo, tomDoAlerta } from '../utils/alertas';
import { POLLUTANTS, ROTULO_FONTE, formatarDataHora, formatarDistancia, formatarValor } from '../utils/formatar';
import { ROTULO_ORIGEM_HIST } from '../utils/historico';
import { ROTULO_STATUS_OC, TOM_STATUS, formatarIdOcorrencia, partesDataHora } from '../utils/ocorrencias';
import './Severidade.css';
import './Dashboard.css';

export type UserRole = 'admin' | 'user';

interface DashboardProps {
  role: UserRole;
  userName: string;
  onLogout: () => void;
}

const MAIN_MENU: { label: string; icon: IconName }[] = [
  { label: 'Dashboard', icon: 'home' },
  { label: 'Alertas', icon: 'bell' },
  { label: 'Ocorrências', icon: 'clipboard' },
  { label: 'Histórico', icon: 'chart' },
];

const ADMIN_MENU: { label: string; icon: IconName }[] = [
  { label: 'Configurações', icon: 'gear' },
  { label: 'Usuários', icon: 'users' },
  { label: 'Estações', icon: 'antenna' },
  { label: 'Relatórios', icon: 'file' },
];

const CIDADES = Object.keys(CITIES);

const ADMIN_QUICK = [
  { title: 'Gerenciar usuários', text: 'Cadastrar e editar usuários do sistema', icon: 'users' as IconName, menu: 'Usuários' },
  { title: 'Consultar estações', text: 'Estações obtidas das APIs ambientais', icon: 'antenna' as IconName, menu: 'Estações' },
  { title: 'Ver relatórios', text: 'Resumo de usuários e da qualidade do ar', icon: 'file' as IconName, menu: 'Relatórios' },
  { title: 'Configurações', text: 'Informações do sistema e das integrações', icon: 'gear' as IconName, menu: 'Configurações' },
];

const ICONE_STATUS_OC: Record<StatusOcorrencia, IconName> = { ABERTA: 'warning', EM_ANDAMENTO: 'clock', CONCLUIDA: 'check' };

const ALERTAS_NO_CARTAO = 3;

export default function Dashboard({ role, userName, onLogout }: DashboardProps) {
  const isAdmin = role === 'admin';
  const [poluenteHist, setPoluenteHist] = useState(POLLUTANTS[0].chave);
  const [activeMenu, setActiveMenu] = useState('Dashboard');
  // Cidade cadastrada do usuário (vem do login/cadastro). Usuário comum vê só a sua; admin pode trocar de cidade.
  const cidadeCadastrada = lerUsuarioLogado()?.cidade ?? '';
  const cidadeUsuario = CIDADES.includes(cidadeCadastrada) ? cidadeCadastrada : null;
  const cidadesDisponiveis = isAdmin || !cidadeUsuario ? CIDADES : [cidadeUsuario];
  const [region, setRegion] = useState(cidadeUsuario || CIDADE_PADRAO);
  const qualidade = useQualidadeAr(region);

  // Dados reais dos cartões. Os alertas também alimentam o selo do sino e são relidos a cada troca de tela,
  // para refletir alertas avaliados ou resolvidos nas outras páginas.
  const noDashboard = activeMenu === 'Dashboard';
  const alertas = useAlertasAtivos(region, activeMenu);
  const ocorrencias = useOcorrenciasRecentes(!isAdmin && noDashboard, region, activeMenu);
  const historico = useHistoricoDoDia(noDashboard, region, poluenteHist);

  const displayName = isAdmin ? 'Administrador' : userName;
  const initials = isAdmin ? 'AD' : userName.slice(0, 2).toUpperCase();

  const totalAlertas = alertas.dados?.total ?? 0;
  const maisGrave = alertas.dados?.maisGrave ?? null;
  const tomGeral = maisGrave ? maisGrave.toLowerCase() : 'resolvido';
  const agora = new Date();
  const poluenteSelecionado = POLLUTANTS.find((p) => p.chave === poluenteHist) ?? POLLUTANTS[0];

  return (
    <div className="dash">
      <aside className="dash-sidebar">
        <div className="dash-brand">
          <div className="dash-brand-name">AirMonitor</div>
          <div className="dash-brand-tag">Monitorando hoje,<br />por um amanhã melhor.</div>
        </div>

        <nav className="dash-nav">
          {MAIN_MENU.map((item) => (
            <button
              key={item.label}
              type="button"
              className={`dash-nav-item${activeMenu === item.label ? ' active' : ''}`}
              onClick={() => setActiveMenu(item.label)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}

          {isAdmin && (
            <>
              <div className="dash-nav-sep" />
              {ADMIN_MENU.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className={`dash-nav-item${activeMenu === item.label ? ' active' : ''}`}
                  onClick={() => setActiveMenu(item.label)}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </button>
              ))}
            </>
          )}
        </nav>

        <button type="button" className="dash-logout" onClick={onLogout}>
          <Icon name="logout" />
          <span>Sair</span>
        </button>
        <div className="dash-sidebar-art">
          <Icon name="leaf" />
          <span>Respirar<br />um futuro melhor</span>
        </div>
      </aside>

      <div className="dash-content">
        <header className="dash-topbar">
          {isAdmin ? (
            <div className="dash-topbar-title">
              <span className="dash-crown"><Icon name="crown" /></span>
              <div>
                <strong>Usuário Admin</strong>
                <small>Visão completa do sistema, incluindo configurações e gestão.</small>
              </div>
            </div>
          ) : (
            <div />
          )}

          <div className="dash-topbar-right">
            <button
              type="button"
              className="dash-bell"
              aria-label={totalAlertas > 0 ? `Alertas ativos em ${region}: ${totalAlertas}. Abrir Alertas` : 'Abrir Alertas'}
              title="Ver alertas"
              onClick={() => setActiveMenu('Alertas')}
              data-testid="sino-alertas"
            >
              <Icon name="bell" />
              {totalAlertas > 0 && <span className="dash-badge" data-testid="sino-contagem">{totalAlertas > 99 ? '99+' : totalAlertas}</span>}
            </button>
            <div className="dash-avatar">{initials}</div>
            <span className="dash-username">{displayName}</span>
          </div>
        </header>

        <main className="dash-main">
          {isAdmin && activeMenu === 'Usuários' ? (
            <UsersPage />
          ) : isAdmin && activeMenu === 'Estações' ? (
            <StationsPage cidades={CIDADES} cidade={region} onCidadeChange={setRegion} />
          ) : isAdmin && activeMenu === 'Configurações' ? (
            <SettingsPage />
          ) : isAdmin && activeMenu === 'Relatórios' ? (
            <ReportsPage cidades={CIDADES} cidade={region} onCidadeChange={setRegion} qualidade={qualidade} />
          ) : activeMenu === 'Alertas' ? (
            <AlertsPage cidades={cidadesDisponiveis} cidade={region} onCidadeChange={setRegion} isAdmin={isAdmin} />
          ) : activeMenu === 'Ocorrências' ? (
            <OccurrencesPage cidades={cidadesDisponiveis} cidade={region} onCidadeChange={setRegion} isAdmin={isAdmin} />
          ) : activeMenu === 'Histórico' ? (
            <HistoryPage cidades={cidadesDisponiveis} cidade={region} onCidadeChange={setRegion} />
          ) : (
          <>
          <section className="dash-heading">
            <div>
              <h1>Olá, {displayName}!</h1>
              <p>{isAdmin ? 'Acompanhe em tempo real a qualidade do ar em todas as regiões.' : 'Acompanhe a qualidade do ar na sua região.'}</p>
            </div>
            <div className="dash-filters">
              <label className="dash-select">
                <Icon name="pin" />
                <select value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Cidade">
                  {cidadesDisponiveis.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                <Icon name="dropdown" />
              </label>
              <div className="dash-date">
                <Icon name="calendar" />
                <div>
                  <strong>{qualidade.loading ? 'Carregando…' : formatarDataHora(qualidade.atualizadoEm)}</strong>
                  <small>Última atualização dos dados</small>
                </div>
              </div>
            </div>
          </section>

          {isAdmin && <AdminUserStats />}

          <div className="dash-row dash-row-top">
            <section className="dash-card dash-quality" data-testid="dash-situacao">
              <h2>Situação do ar agora</h2>
              {alertas.carregando ? (
                <>
                  <div className="quality-ring"><Icon name="leaf" /></div>
                  <div className="quality-value"><strong>Carregando…</strong><span>Consultando os alertas de {region}</span></div>
                </>
              ) : alertas.erro ? (
                <>
                  <div className="quality-ring com-tom tom-moderado"><Icon name="warning" /></div>
                  <div className="quality-value"><strong className="quality-indisponivel">Indisponível</strong><span>Não foi possível consultar os alertas</span></div>
                  <p className="air-error" role="alert">{alertas.erro}</p>
                </>
              ) : (
                <>
                  <div className={`quality-ring com-tom tom-${tomGeral}`}><Icon name={maisGrave ? 'alert' : 'leaf'} /></div>
                  <div className={`quality-value com-tom tom-${tomGeral}`}>
                    <strong data-testid="situacao-titulo">{maisGrave ? `Nível ${ROTULO_NIVEL[maisGrave].toLowerCase()}` : 'Sem alertas ativos'}</strong>
                    <span>{maisGrave ? 'Maior nível entre os alertas ativos' : `Nenhum alerta registrado em ${region}`}</span>
                    {maisGrave && (
                      <b>{totalAlertas} <small>{totalAlertas === 1 ? 'alerta ativo' : 'alertas ativos'}</small></b>
                    )}
                  </div>
                  <div className={`quality-msg com-tom tom-${tomGeral}`}>
                    <Icon name={maisGrave ? 'warning' : 'smile'} />
                    <p>
                      {maisGrave
                        ? 'Há poluentes acima dos limites de referência. Consulte os detalhes na tela de Alertas.'
                        : 'Os alertas são gerados quando o administrador avalia as medições; hoje não há nenhum ativo.'}
                    </p>
                  </div>
                </>
              )}
              <p className="quality-note">Níveis calculados com limiares técnicos provisórios; o IQA oficial ainda não é calculado.</p>
            </section>

            <section className="dash-card dash-pollutants">
              <div className="card-head">
                <h2>Principais poluentes</h2>
                <a href="#" onClick={(e) => { e.preventDefault(); setActiveMenu('Histórico'); }}>Ver histórico <Icon name="arrow" /></a>
              </div>
              <div className="pollutant-grid">
                {POLLUTANTS.map((p) => {
                  const m: MedicaoAr | undefined = qualidade.medicoes.find((x) => x.chave === p.chave);
                  const temValor = !!m && m.disponivel && m.valor !== null && m.fonte !== null;
                  return (
                    <div key={p.name} className="pollutant">
                      <div className="pollutant-name">
                        <strong>{p.name}</strong>
                        <small>{p.desc}</small>
                      </div>
                      <div className="pollutant-value">
                        {temValor ? (
                          <>
                            <b>{formatarValor(m!.valor!)}</b> <span>{m!.unidade}</span>
                          </>
                        ) : (
                          <span>{qualidade.loading ? 'Carregando…' : '—'}</span>
                        )}
                      </div>
                      {temValor ? (
                        <>
                          <span className={m!.fonte === 'OPEN_METEO' ? 'tag-model' : 'tag-ok'}>● {ROTULO_FONTE[m!.fonte!]}</span>
                          <small className="pollutant-meta">
                            {formatarDataHora(m!.dataHora)}
                            {m!.desatualizada && <span className="tag-stale"> · Desatualizado</span>}
                          </small>
                        </>
                      ) : (
                        !qualidade.loading && <span className="tag-none">● Sem dados disponíveis</span>
                      )}
                    </div>
                  );
                })}
              </div>
              {qualidade.erro && <p className="air-error">{qualidade.erro}</p>}
              {qualidade.statusFontes?.OPENAQ === 'falha' && (
                <p className="air-aviso" role="status" data-testid="aviso-openaq">
                  As estações da OpenAQ estão indisponíveis no momento; os valores abaixo são estimativas de modelo.
                </p>
              )}
              {qualidade.atribuicoes.map((a) => (
                <p key={a} className="air-attribution">{a}</p>
              ))}
            </section>

            <section className="dash-card dash-station">
              <div className="card-head">
                <h2>{isAdmin ? 'Estações de monitoramento' : 'Estação mais próxima'}</h2>
                {isAdmin && (
                  <a href="#" onClick={(e) => { e.preventDefault(); setActiveMenu('Estações'); }}>
                    Ver todas <Icon name="arrow" />
                  </a>
                )}
              </div>
              {isAdmin ? (
                <AdminStationSummary cidade={region} />
              ) : (
                <div className="map" aria-hidden="true">
                  <span className="map-pin" style={{ left: '50%', top: '58%' }}><Icon name="pin" /></span>
                </div>
              )}
              <div className="station-info">
                <div>
                  <strong>{qualidade.estacao ? qualidade.estacao.nome || `Estação ${qualidade.estacao.id}` : qualidade.loading ? 'Carregando…' : qualidade.statusFontes ? 'Estimativa de modelo' : 'Sem estação'}</strong>
                  <small>{isAdmin && 'Estação usada nos poluentes · '}{qualidade.estacao?.localidade || region}</small>
                </div>
                {isAdmin ? (
                  qualidade.statusFontes && (
                    <span className={qualidade.statusFontes.OPENAQ === 'ok' ? 'tag-online' : 'tag-none'}>
                      ● OpenAQ {qualidade.statusFontes.OPENAQ === 'ok' ? 'disponível' : 'indisponível'}
                    </span>
                  )
                ) : (
                  formatarDistancia(qualidade.distanciaMetros) && (
                    <b title="Distância até o centro da cidade selecionada">{formatarDistancia(qualidade.distanciaMetros)} <Icon name="chevron" /></b>
                  )
                )}
              </div>
            </section>
          </div>

          <div className={`dash-row dash-row-bottom${isAdmin ? ' is-admin' : ' is-user'}`}>
            <section className="dash-card dash-history" data-testid="dash-historico">
              <div className="card-head">
                <h2><Icon name="chart" /> Últimas 24 horas</h2>
                <div className="range-tabs" role="group" aria-label="Poluente do gráfico">
                  {POLLUTANTS.map((p) => (
                    <button
                      key={p.chave}
                      type="button"
                      className={poluenteHist === p.chave ? 'active' : ''}
                      aria-pressed={poluenteHist === p.chave}
                      onClick={() => setPoluenteHist(p.chave)}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
              {historico.carregando ? (
                <p className="dash-vazio" data-testid="historico-carregando">Carregando o histórico de {poluenteSelecionado.name}…</p>
              ) : historico.erro ? (
                <p className="air-error" role="alert">{historico.erro}</p>
              ) : historico.dados && historico.dados.pontos.length > 0 ? (
                <>
                  <GraficoEvolucao
                    compacto
                    pontos={historico.dados.pontos}
                    unidade={historico.dados.poluente.unidade ?? historico.dados.pontos[0].unidade}
                    periodo={historico.dados.periodo}
                    nomePoluente={historico.dados.poluente.nome}
                  />
                  <p className="quality-note">
                    {ROTULO_ORIGEM_HIST[historico.dados.pontos[0].origem]}
                    {historico.dados.estacao?.nome ? ` · ${historico.dados.estacao.nome}` : ''}
                    {historico.dados.aviso ? ` · ${historico.dados.aviso}` : ''}
                    {' · '}
                    <a href="#" onClick={(e) => { e.preventDefault(); setActiveMenu('Histórico'); }}>Ver histórico completo</a>
                  </p>
                </>
              ) : (
                <p className="dash-vazio" data-testid="historico-vazio">
                  {historico.dados?.mensagem ?? `Sem medições de ${poluenteSelecionado.name} nas últimas 24 horas em ${region}.`}
                </p>
              )}
            </section>

            <section className="dash-card dash-alerts" data-testid="dash-alertas">
              <div className="card-head">
                <h2><Icon name="bell" /> Alertas ativos</h2>
                <a href="#" onClick={(e) => { e.preventDefault(); setActiveMenu('Alertas'); }}>Ver todos <Icon name="arrow" /></a>
              </div>
              {alertas.carregando ? (
                <p className="dash-vazio">Carregando alertas…</p>
              ) : alertas.erro ? (
                <p className="air-error" role="alert">{alertas.erro}</p>
              ) : !alertas.dados || alertas.dados.alertas.length === 0 ? (
                <p className="dash-vazio" data-testid="alertas-vazio">Nenhum alerta ativo em {region}.</p>
              ) : (
                <>
                  {alertas.dados.alertas.slice(0, ALERTAS_NO_CARTAO).map((a) => (
                    <div key={a.id} className="list-item" data-testid="alerta-resumo">
                      <span className={`item-icon com-tom tom-${tomDoAlerta(a)}`}><Icon name="warning" /></span>
                      <div className="item-body">
                        <strong>{a.titulo}</strong>
                        <small>
                          {nomePoluente(a.poluente)} · {formatarValorAlerta(a.valor)} {a.unidade} · {rotuloOrigem(a.tipoDado)}
                        </small>
                      </div>
                      <span className="item-date">{tempoRelativo(a.medicaoEm, agora)}</span>
                    </div>
                  ))}
                  {alertas.dados.total > ALERTAS_NO_CARTAO && (
                    <p className="quality-note">
                      Mostrando {ALERTAS_NO_CARTAO} de {alertas.dados.total} alertas ativos.
                    </p>
                  )}
                </>
              )}
            </section>

            {!isAdmin && (
              <section className="dash-card dash-occurrences" data-testid="dash-ocorrencias">
                <div className="card-head">
                  <h2><Icon name="clipboard" /> Ocorrências recentes</h2>
                  <a href="#" onClick={(e) => { e.preventDefault(); setActiveMenu('Ocorrências'); }}>Ver todas <Icon name="arrow" /></a>
                </div>
                {ocorrencias.carregando ? (
                  <p className="dash-vazio">Carregando ocorrências…</p>
                ) : ocorrencias.erro ? (
                  <p className="air-error" role="alert">{ocorrencias.erro}</p>
                ) : !ocorrencias.dados || ocorrencias.dados.ocorrencias.length === 0 ? (
                  <p className="dash-vazio" data-testid="ocorrencias-vazio">
                    Nenhuma ocorrência registrada em {region}.{' '}
                    <a href="#" onClick={(e) => { e.preventDefault(); setActiveMenu('Ocorrências'); }}>Registrar ocorrência</a>
                  </p>
                ) : (
                  ocorrencias.dados.ocorrencias.map((o) => (
                    <div key={o.id} className="list-item" data-testid="ocorrencia-resumo">
                      <span className={`item-icon com-tom tom-${TOM_STATUS[o.status]}`}><Icon name={ICONE_STATUS_OC[o.status]} /></span>
                      <div className="item-body">
                        <strong>{o.titulo}</strong>
                        <small>{formatarIdOcorrencia(o.id)} · registrada em {partesDataHora(o.criadoEm).data}</small>
                        <small>{ROTULO_STATUS_OC[o.status]}</small>
                      </div>
                    </div>
                  ))
                )}
              </section>
            )}
          </div>

          {isAdmin && (
            <section className="dash-card dash-quick">
              <h2>Acesso rápido</h2>
              <div className="quick-grid">
                {ADMIN_QUICK.map((q) => (
                  <button
                    key={q.title}
                    type="button"
                    className="quick-item"
                    onClick={() => setActiveMenu(q.menu)}
                  >
                    <span className="item-icon tone-info"><Icon name={q.icon} /></span>
                    <div className="item-body">
                      <strong>{q.title}</strong>
                      <small>{q.text}</small>
                    </div>
                    <Icon name="chevron" />
                  </button>
                ))}
              </div>
            </section>
          )}
          </>
          )}
        </main>
      </div>
    </div>
  );
}
