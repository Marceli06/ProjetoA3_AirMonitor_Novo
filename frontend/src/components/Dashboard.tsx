import { useState } from 'react';
import UsersPage from './UsersPage';
import StationsPage from './StationsPage';
import SettingsPage from './SettingsPage';
import ReportsPage from './ReportsPage';
import AlertsPage from './AlertsPage';
import Icon, { IconName } from './Icon';
import { AdminStationSummary, AdminUserStats } from './AdminWidgets';
import { CITIES } from './Register';
import { CIDADE_PADRAO, lerUsuarioLogado, useQualidadeAr } from '../hooks/useQualidadeAr';
import { MedicaoAr } from '../types';
import { POLLUTANTS, ROTULO_FONTE, formatarDataHora, formatarDistancia, formatarValor } from '../utils/formatar';
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

const RANGE_TABS = ['IQA', 'PM2.5', 'PM10', 'O₃', 'NO₂', 'CO', 'SO₂'];

const HISTORY = [28, 35, 38, 44, 50, 54, 58, 63, 70, 86, 96, 90, 78, 72, 69, 66, 60, 52, 50, 50, 44, 38, 36, 34];

const ADMIN_ALERTS = [
  { tone: 'warning', title: 'Qualidade moderada prevista', text: 'Aumento de O₃ nas próximas 24h.', date: '10/09/2026 14:20' },
  { tone: 'ok', title: 'Sem alertas ativos', text: 'A qualidade do ar permanece estável na sua região.', date: '10/09/2026 09:15' },
  { tone: 'info', title: 'Manutenção programada', text: 'Estação Centro - 12/09 das 08h às 12h.', date: '09/09/2026 18:40' },
  { tone: 'warning', title: 'Concentração elevada de PM10', text: 'Região Norte - Atenção.', date: '09/09/2026 11:30' },
];

const USER_ALERTS = [
  { tone: 'warning', title: 'Qualidade moderada prevista', text: 'Aumento de O₃ nas próximas 24h.', date: '10/09/2026 14:20' },
  { tone: 'ok', title: 'Sem alertas ativos', text: 'A qualidade do ar permanece estável na sua região.', date: '10/09/2026 08:15' },
  { tone: 'info', title: 'Manutenção programada', text: 'Estação Zona Leste - 12/09 das 08h às 12h.', date: '08/09/2026 16:30' },
];

const MY_OCCURRENCES = [
  { title: 'Buraco na via', text: 'Registrada em 09/09/2026', status: 'Aguardando análise', tone: 'pending' },
  { title: 'Queimada na região', text: 'Registrada em 05/09/2026', status: 'Em análise', tone: 'analysis' },
  { title: 'Canteiro de obras', text: 'Registrada em 01/09/2026', status: 'Concluída', tone: 'ok' },
];

const ADMIN_QUICK = [
  { title: 'Gerenciar usuários', text: 'Cadastrar e editar usuários do sistema', icon: 'users' as IconName, menu: 'Usuários' },
  { title: 'Consultar estações', text: 'Estações obtidas das APIs ambientais', icon: 'antenna' as IconName, menu: 'Estações' },
  { title: 'Ver relatórios', text: 'Resumo de usuários e da qualidade do ar', icon: 'file' as IconName, menu: 'Relatórios' },
  { title: 'Configurações', text: 'Informações do sistema e das integrações', icon: 'gear' as IconName, menu: 'Configurações' },
];

const toneIcon = (tone: string): IconName => (tone === 'ok' ? 'check' : tone === 'info' ? 'info' : 'warning');

export default function Dashboard({ role, userName, onLogout }: DashboardProps) {
  const isAdmin = role === 'admin';
  const [activeTab, setActiveTab] = useState('IQA');
  const [activeMenu, setActiveMenu] = useState('Dashboard');
  // Cidade cadastrada do usuário (vem do login/cadastro). Usuário comum vê só a sua; admin pode trocar de cidade.
  const cidadeCadastrada = lerUsuarioLogado()?.cidade ?? '';
  const cidadeUsuario = CIDADES.includes(cidadeCadastrada) ? cidadeCadastrada : null;
  const cidadesDisponiveis = isAdmin || !cidadeUsuario ? CIDADES : [cidadeUsuario];
  const [region, setRegion] = useState(cidadeUsuario || CIDADE_PADRAO);
  const qualidade = useQualidadeAr(region);

  const displayName = isAdmin ? 'Administrador' : userName;
  const initials = isAdmin ? 'AD' : userName.slice(0, 2).toUpperCase();
  const alerts = isAdmin ? ADMIN_ALERTS : USER_ALERTS;

  const max = 100;
  const points = HISTORY.map((v, i) => `${(i * 600) / (HISTORY.length - 1)},${200 - (v / max) * 200}`).join(' ');
  const area = `0,200 ${points} 600,200`;

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
            <button type="button" className="dash-bell" aria-label="Notificações">
              <Icon name="bell" />
              <span className="dash-badge">{isAdmin ? 4 : 3}</span>
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
            <AlertsPage cidades={cidadesDisponiveis} cidade={region} onCidadeChange={setRegion} />
          ) : activeMenu !== 'Dashboard' ? (
            <section className="dash-card">
              <h2>{activeMenu}</h2>
              <p className="dash-placeholder">Esta tela ainda não foi implementada.</p>
            </section>
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
                <select value={region} onChange={(e) => setRegion(e.target.value)}>
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
            <section className="dash-card dash-quality">
              <h2>Qualidade do ar agora</h2>
              <div className="quality-ring"><Icon name="leaf" /></div>
              <div className="quality-value">
                <strong>Boa</strong>
                <span>Índice de Qualidade do Ar (IQA)</span>
                <b>32 <small>/ 500</small></b>
              </div>
              <div className="quality-msg">
                <Icon name="smile" />
                <p>A qualidade do ar está dentro dos níveis considerados adequados para a saúde.</p>
              </div>
              <p className="quality-note">Valor ilustrativo: o IQA ainda não é calculado a partir dos dados reais.</p>
            </section>

            <section className="dash-card dash-pollutants">
              <div className="card-head">
                <h2>Principais poluentes</h2>
                <a href="#">Ver todos <Icon name="arrow" /></a>
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
              {qualidade.atribuicoes.map((a) => (
                <p key={a} className="air-attribution">{a}</p>
              ))}
            </section>

            <section className="dash-card dash-station">
              <div className="card-head">
                <h2>{isAdmin ? 'Estações de monitoramento' : 'Estação mais próxima'}</h2>
                <a
                  href="#"
                  onClick={isAdmin ? (e) => { e.preventDefault(); setActiveMenu('Estações'); } : undefined}
                >
                  Ver todas <Icon name="arrow" />
                </a>
              </div>
              {isAdmin ? (
                <AdminStationSummary cidade={region} />
              ) : (
                <div className="map">
                  <span className="map-label" style={{ left: '8%', top: '18%' }}>Itaquera</span>
                  <span className="map-label" style={{ left: '62%', top: '14%' }}>Guaianazes</span>
                  <span className="map-label" style={{ left: '40%', top: '52%' }}>São Mateus</span>
                  <span className="map-pin" style={{ left: '44%', top: '40%' }}><Icon name="pin" /></span>
                </div>
              )}
              <div className="station-info">
                <div>
                  <strong>{qualidade.estacao ? qualidade.estacao.nome || `Estação ${qualidade.estacao.id}` : qualidade.loading ? 'Carregando…' : 'Sem estação'}</strong>
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
            <section className="dash-card dash-history">
              <div className="card-head">
                <h2><Icon name="chart" /> Histórico da qualidade do ar</h2>
                <div className="range-tabs">
                  {RANGE_TABS.map((t) => (
                    <button key={t} type="button" className={activeTab === t ? 'active' : ''} onClick={() => setActiveTab(t)}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <svg className="chart" viewBox="0 0 600 200" preserveAspectRatio="none">
                <polygon points={area} className="chart-area" />
                <polyline points={points} className="chart-line" />
              </svg>
              <div className="chart-axis">
                {HISTORY.map((_, i) => (i % 2 === 0 ? <span key={i}>{String(i).padStart(2, '0')}h</span> : null))}
              </div>
              {isAdmin && <p className="quality-note">Dados ilustrativos: o histórico real será entregue na etapa de Histórico.</p>}
            </section>

            <section className="dash-card dash-alerts">
              <div className="card-head">
                <h2><Icon name="bell" /> Alertas recentes</h2>
                <a href="#" onClick={(e) => { e.preventDefault(); setActiveMenu('Alertas'); }}>Ver todas <Icon name="arrow" /></a>
              </div>
              {alerts.map((a) => (
                <div key={a.title} className="list-item">
                  <span className={`item-icon tone-${a.tone}`}><Icon name={toneIcon(a.tone)} /></span>
                  <div className="item-body">
                    <strong>{a.title}</strong>
                    <small>{a.text}</small>
                  </div>
                  <span className="item-date">{a.date}</span>
                </div>
              ))}
              {isAdmin && <p className="quality-note">Alertas ilustrativos: os alertas reais serão entregues na etapa de Alertas.</p>}
            </section>

            {!isAdmin && (
              <section className="dash-card dash-occurrences">
                <div className="card-head">
                  <h2><Icon name="clipboard" /> Minhas ocorrências recentes</h2>
                  <a href="#">Ver todas <Icon name="arrow" /></a>
                </div>
                {MY_OCCURRENCES.map((o) => (
                  <div key={o.title} className="list-item">
                    <span className={`item-icon tone-${o.tone === 'ok' ? 'ok' : 'info'}`}>
                      <Icon name={o.tone === 'ok' ? 'check' : o.tone === 'analysis' ? 'wind' : 'warning'} />
                    </span>
                    <div className="item-body">
                      <strong>{o.title}</strong>
                      <small>{o.text}</small>
                      <small>{o.status}</small>
                    </div>
                  </div>
                ))}
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