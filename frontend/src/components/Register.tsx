import { useState } from 'react';
import { authAPI } from '../api';
import { UserRole } from './Dashboard';
import './Register.css';

export const CITIES: Record<string, string[]> = {
  'São Paulo': ['Centro', 'Zona Norte', 'Zona Sul', 'Zona Leste', 'Zona Oeste'],
  'Guarulhos': ['Centro', 'Zona Norte', 'Zona Sul', 'Zona Leste', 'Zona Oeste'],
  'Campinas': ['Centro', 'Zona Norte', 'Zona Sul', 'Zona Leste', 'Zona Oeste'],
  'São Bernardo do Campo': ['Centro', 'Zona Norte', 'Zona Sul', 'Zona Leste', 'Zona Oeste'],
  'Ribeirão Preto': ['Centro', 'Zona Norte', 'Zona Sul', 'Zona Leste', 'Zona Oeste'],
  'Sorocaba': ['Centro', 'Zona Norte', 'Zona Sul', 'Zona Leste', 'Zona Oeste'],
  'São José dos Campos': ['Centro', 'Zona Norte', 'Zona Sul', 'Zona Leste', 'Zona Oeste'],
  'Santo André': ['Centro', 'Zona Norte', 'Zona Sul', 'Zona Leste', 'Zona Oeste'],
  'Osasco': ['Centro', 'Zona Norte', 'Zona Sul', 'Zona Leste', 'Zona Oeste'],
  'Mauá': ['Centro', 'Zona Norte', 'Zona Sul', 'Zona Leste', 'Zona Oeste'],
};

const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

interface RegisterProps {
  onBackToLogin: () => void;
  onRegistered: (role: UserRole, name: string) => void;
}

export default function Register({ onBackToLogin, onRegistered }: RegisterProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const regions = city ? CITIES[city] : [];

  const handleCityChange = (value: string) => {
    setCity(value);
    setRegion('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError('As senhas não coincidem.');
      return;
    }
    setError('');
    setLoading(true);

    try {
      const response = await authAPI.register({
        nome: name,
        email,
        password,
        confirmPassword,
        cidade: city,
        regiao: region,
      });
      localStorage.setItem('authToken', response.data.token);
      localStorage.setItem('user', JSON.stringify(response.data.user));
      const user = response.data.user;
      onRegistered(user?.perfil === 'ADMIN' ? 'admin' : 'user', user?.nome || name);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao criar conta');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="register-container">
      <header className="register-header">
        <div className="register-brand">
          <svg className="register-brand-icon" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
            <rect width="100" height="100" rx="15" fill="#E6F4FF" />
            <path d="M40 60 Q40 40, 50 35 Q60 40, 60 60" fill="#0099CC" />
            <path d="M60 60 Q60 40, 70 35 Q80 40, 80 60" fill="#00CC99" />
          </svg>
          <span>AirMonitor</span>
        </div>
        <nav className="register-nav">
          <a href="#">Sobre</a>
          <a href="#">Recursos</a>
          <a href="#">Ajuda</a>
        </nav>
      </header>

      <main className="register-main">
        <div className="register-card">
          <div className="register-card-header">
            <svg className="register-card-logo" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
              <rect width="100" height="100" rx="15" fill="#E6F4FF" />
              <path d="M40 60 Q40 40, 50 35 Q60 40, 60 60" fill="#0099CC" />
              <path d="M60 60 Q60 40, 70 35 Q80 40, 80 60" fill="#00CC99" />
            </svg>
            <h1>Criar conta</h1>
            <p className="register-subtitle">Cadastre-se para monitorar a qualidade do ar da sua cidade e região</p>
          </div>

          {error && <div className="register-error">{error}</div>}

          <form onSubmit={handleSubmit} className="register-form">
            <div className="register-field">
              <label htmlFor="name">Nome completo</label>
              <div className="input-wrap">
                <span className="input-icon"><Icon><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></Icon></span>
                <input id="name" type="text" placeholder="Ex.: Maria Silva" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
            </div>

            <div className="register-field">
              <label htmlFor="email">E-mail</label>
              <div className="input-wrap">
                <span className="input-icon"><Icon><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 6-10 7L2 6" /></Icon></span>
                <input id="email" type="email" placeholder="Ex.: seu@email.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
            </div>

            <div className="register-field">
              <label htmlFor="password">Senha</label>
              <div className="input-wrap">
                <span className="input-icon"><Icon><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></Icon></span>
                <input id="password" type={showPassword ? 'text' : 'password'} placeholder="Digite sua senha" value={password} onChange={(e) => setPassword(e.target.value)} required />
                <button type="button" className="input-action" onClick={() => setShowPassword(!showPassword)} aria-label="Mostrar/ocultar senha">
                  <Icon><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></Icon>
                </button>
              </div>
            </div>

            <div className="register-field">
              <label htmlFor="confirmPassword">Confirmar senha</label>
              <div className="input-wrap">
                <span className="input-icon"><Icon><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></Icon></span>
                <input id="confirmPassword" type={showConfirmPassword ? 'text' : 'password'} placeholder="Digite sua senha novamente" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
                <button type="button" className="input-action" onClick={() => setShowConfirmPassword(!showConfirmPassword)} aria-label="Mostrar/ocultar confirmação de senha">
                  <Icon><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></Icon>
                </button>
              </div>
            </div>

            <div className="register-field">
              <label htmlFor="city">Cidade</label>
              <div className="input-wrap">
                <span className="input-icon"><Icon><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></Icon></span>
                <select id="city" value={city} onChange={(e) => handleCityChange(e.target.value)} required>
                  <option value="" disabled>Selecione sua cidade</option>
                  {Object.keys(CITIES).map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <span className="chevron"><Icon><polyline points="6 9 12 15 18 9" /></Icon></span>
              </div>
            </div>

            <div className="register-field">
              <label htmlFor="region">Região / Zona</label>
              <div className="input-wrap">
                <span className="input-icon"><Icon><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" /><line x1="8" y1="2" x2="8" y2="18" /><line x1="16" y1="6" x2="16" y2="22" /></Icon></span>
                <select id="region" value={region} onChange={(e) => setRegion(e.target.value)} disabled={!city} required>
                  <option value="" disabled>Selecione a zona ou região</option>
                  {regions.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <span className="chevron"><Icon><polyline points="6 9 12 15 18 9" /></Icon></span>
              </div>
            </div>

            <button type="submit" className="register-submit" disabled={loading}>{loading ? 'Criando conta...' : 'Criar conta'}</button>
          </form>

          <button type="button" className="register-link" onClick={onBackToLogin}>
            Já tenho uma conta
          </button>
        </div>
      </main>

      <footer className="register-footer">
        <p>&copy; 2026 AirMonitor. Todos os direitos reservados.</p>
        <p>Um ar melhor para um futuro mais saudável.</p>
      </footer>
    </div>
  );
}