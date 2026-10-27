import { useState } from 'react';
import UsersPage from './UsersPage';
import './Dashboard.css';

export type UserRole = 'admin' | 'user';

interface DashboardProps {
  role: UserRole;
  userName: string;
  onLogout: () => void;
}

const ICONS = {
  home: <path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  bell: (<><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>),
  clipboard: (<><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4h6v3H9zM9 12h6M9 16h6" /></>),
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  gear: (<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></>),
  users: (<><circle cx="9" cy="8" r="4" /><path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 4a4 4 0 0 1 0 8M22 21v-1a6 6 0 0 0-4-5.6" /></>),
  antenna: (<><circle cx="12" cy="10" r="2" /><path d="M8.5 6.5a5 5 0 0 0 0 7M15.5 6.5a5 5 0 0 1 0 7M5 3a10 10 0 0 0 0 14M19 3a10 10 0 0 1 0 14M12 12v9" /></>),
  file: (<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h8" /></>),
  logout: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
  leaf: <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z" />,
  smile: (<><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" /></>),
  check: <polyline points="20 6 9 17 4 12" />,
  info: (<><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></>),
  warning: (<><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></>),
  pin: (<><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></>),
  calendar: (<><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>),
  chevron: <polyline points="9 6 15 12 9 18" />,
  dropdown: <polyline points="6 9 12 15 18 9" />,
  arrow: <path d="M5 12h14M12 5l7 7-7 7" />,
  crown: <path d="M2 18h20l-2-10-5 4-3-6-3 6-5-4z" />,
  wind: <path d="M9.6 4.6A2 2 0 1 1 11 8H2m10.6 11.4A2 2 0 1 0 14 16H2m15.7-7.7A2.5 2.5 0 1 1 19.5 12H2" />,
};

type IconName = keyof typeof ICONS;

const Icon = ({ name }: { name: IconName }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {ICONS[name]}
  </svg>
);

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

const POLLUTANTS = [
  { name: 'PM2.5', desc: 'Material particulado fino', value: '12', unit: 'µg/m³' },
  { name: 'PM10', desc: 'Material particulado', value: '18', unit: 'µg/m³' },
  { name: 'O₃', desc: 'Ozônio', value: '64', unit: 'µg/m³' },
  { name: 'NO₂', desc: 'Dióxido de nitrogênio', value: '22', unit: 'µg/m³' },
  { name: 'CO', desc: 'Monóxido de carbono', value: '0,6', unit: 'mg/m³' },
  { name: 'SO₂', desc: 'Dióxido de enxofre', value: '5', unit: 'µg/m³' },
];

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
  { title: 'Gerenciar usuários', text: 'Cadastrar e editar usuários do sistema', icon: 'users' as IconName },
  { title: 'Configurar estações', text: 'Gerenciar estações de monitoramento', icon: 'antenna' as IconName },
  { title: 'Gerar relatórios', text: 'Emitir relatórios e análises de dados', icon: 'file' as IconName },
  { title: 'Configurações', text: 'Ajustes gerais do sistema', icon: 'gear' as IconName },
];

const toneIcon = (tone: string): IconName => (tone === 'ok' ? 'check' : tone === 'info' ? 'info' : 'warning');

export default function Dashboard({ role, userName, onLogout }: DashboardProps) {
  const isAdmin = role === 'admin';
  const [activeTab, setActiveTab] = useState('IQA');
  const [activeMenu, setActiveMenu] = useState('Dashboard');
  const [region, setRegion] = useState(isAdmin ? 'São Paulo - SP' : 'São Paulo - Zona Leste');

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
          {activeMenu === 'Usuários' && isAdmin ? (
            <UsersPage />
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
                  <option>São Paulo - SP</option>
                  <option>São Paulo - Zona Leste</option>
                  <option>São Paulo - Zona Norte</option>
                </select>
                <Icon name="dropdown" />
              </label>
              <div className="dash-date">
                <Icon name="calendar" />
                <div>
                  <strong>10/09/2026 19:30</strong>
                  <small>Última atualização</small>
                </div>
              </div>
            </div>
          </section>

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
            </section>

            <section className="dash-card dash-pollutants">
              <div className="card-head">
                <h2>Principais poluentes</h2>
                <a href="#">Ver todos <Icon name="arrow" /></a>
              </div>
              <div className="pollutant-grid">
                {POLLUTANTS.map((p) => (
                  <div key={p.name} className="pollutant">
                    <div className="pollutant-name">
                      <strong>{p.name}</strong>
                      <small>{p.desc}</small>
                    </div>
                    <div className="pollutant-value">
                      <b>{p.value}</b> <span>{p.unit}</span>
                    </div>
                    <span className="tag-ok">● Adequado</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="dash-card dash-station">
              <div className="card-head">
                <h2>{isAdmin ? 'Estações de monitoramento' : 'Estação mais próxima'}</h2>
                <a href="#">Ver todas <Icon name="arrow" /></a>
              </div>
              <div className="map">
                <span className="map-label" style={{ left: '8%', top: '18%' }}>{isAdmin ? 'Osasco' : 'Itaquera'}</span>
                <span className="map-label" style={{ left: '62%', top: '14%' }}>{isAdmin ? 'Guarulhos' : 'Guaianazes'}</span>
                <span className="map-label" style={{ left: '40%', top: '52%' }}>{isAdmin ? 'São Paulo' : 'São Mateus'}</span>
                {isAdmin && <span className="map-label" style={{ left: '72%', top: '72%' }}>Santo André</span>}
                <span className="map-pin" style={{ left: '44%', top: '40%' }}><Icon name="pin" /></span>
                {isAdmin && (
                  <>
                    <span className="map-pin pin-b" style={{ left: '22%', top: '62%' }}><Icon name="pin" /></span>
                    <span className="map-pin pin-b" style={{ left: '56%', top: '28%' }}><Icon name="pin" /></span>
                  </>
                )}
              </div>
              <div className="station-info">
                <div>
                  <strong>Estação Zona Leste</strong>
                  <small>São Paulo - SP</small>
                </div>
                {isAdmin ? <span className="tag-online">● Online</span> : <b>4,2 km <Icon name="chevron" /></b>}
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
            </section>

            <section className="dash-card dash-alerts">
              <div className="card-head">
                <h2><Icon name="bell" /> Alertas recentes</h2>
                <a href="#">Ver todas <Icon name="arrow" /></a>
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
                    onClick={() => q.title === 'Gerenciar usuários' && setActiveMenu('Usuários')}
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