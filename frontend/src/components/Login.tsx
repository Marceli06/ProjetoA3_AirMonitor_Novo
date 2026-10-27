import { useState } from 'react';
import { authAPI } from '../api';
import { LoginFormData } from '../types';
import './Login.css';

interface LoginProps {
  onForgotPassword: () => void;
  onCreateAccount: () => void;
}

export default function Login({ onForgotPassword, onCreateAccount }: LoginProps) {
  const [isLogin, setIsLogin] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState<LoginFormData>({
    email: '',
    password: '',
  });
  const [confirmPassword, setConfirmPassword] = useState('');

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await authAPI.login(formData.email, formData.password);
      localStorage.setItem('authToken', response.data.token);
      localStorage.setItem('user', JSON.stringify(response.data.user));
      window.location.href = '/dashboard';
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao fazer login');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await authAPI.register(
        formData.email,
        formData.password,
        confirmPassword
      );
      localStorage.setItem('authToken', response.data.token);
      localStorage.setItem('user', JSON.stringify(response.data.user));
      window.location.href = '/dashboard';
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao registrar');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAccountClick = () => {
    setIsLogin(false);
    setError('');
    setFormData({ email: '', password: '' });
    setConfirmPassword('');
  };

  return (
    <div className="login-container">
      {/* Header */}
      <header className="login-header">
        <div className="logo-section">
          <div className="logo-icon">
            <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
              <rect width="100" height="100" rx="15" fill="#E6F4FF" />
              <path d="M40 60 Q40 40, 50 35 Q60 40, 60 60" fill="#0099CC" />
              <path d="M60 60 Q60 40, 70 35 Q80 40, 80 60" fill="#00CC99" />
            </svg>
          </div>
          <span className="logo-text">AirMonitor</span>
        </div>
        <nav className="header-nav">
          <a href="#">Sobre</a>
          <a href="#">Recursos</a>
          <a href="#">Ajuda</a>
        </nav>
      </header>

      {/* Main Content */}
      <main className="login-main">
        <div className="login-card">
          <div className="card-header">
            <div className="card-logo">
              <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                <rect width="100" height="100" rx="15" fill="#E6F4FF" />
                <path d="M40 60 Q40 40, 50 35 Q60 40, 60 60" fill="#0099CC" />
                <path d="M60 60 Q60 40, 70 35 Q80 40, 80 60" fill="#00CC99" />
              </svg>
            </div>
            <h1>AirMonitor</h1>
            <p className="subtitle">Monitore a qualidade do ar da sua região</p>
          </div>

          {error && <div className="error-message">{error}</div>}

          <form onSubmit={isLogin ? handleLogin : handleRegister} className="form">
            <div className="form-group">
              <label htmlFor="email">E-mail</label>
              <input
                type="email"
                id="email"
                name="email"
                placeholder="Ex.: seu@email.com"
                value={formData.email}
                onChange={handleInputChange}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="password">Senha</label>
              <div className="password-input-wrapper">
                <input
                  type={showPassword ? 'text' : 'password'}
                  id="password"
                  name="password"
                  placeholder="Digite sua senha"
                  value={formData.password}
                  onChange={handleInputChange}
                  required
                />
                <button
                  type="button"
                  className="toggle-password"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label="Mostrar/ocultar senha"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                  </svg>
                </button>
              </div>
            </div>

            {!isLogin && (
              <div className="form-group">
                <label htmlFor="confirmPassword">Confirmar Senha</label>
                <input
                  type="password"
                  id="confirmPassword"
                  placeholder="Confirme sua senha"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>
            )}

            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
            >
              {loading ? 'Carregando...' : isLogin ? 'Entrar' : 'Criar conta'}
            </button>
          </form>

          {isLogin && (
            <button
              type="button"
              className="forgot-password-btn"
              onClick={onForgotPassword}
            >
              Esqueci minha senha
            </button>
          )}

          <div className="divider">
            <span>ou</span>
          </div>

          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              if (isLogin) {
                handleCreateAccountClick();
                onCreateAccount();
              } else {
                setIsLogin(true);
                setError('');
              }
            }}
          >
            {isLogin ? 'Criar conta' : 'Voltar ao login'}
          </button>
        </div>
      </main>

      {/* Footer */}
      <footer className="login-footer">
        <p>&copy; 2024 AirMonitor. Todos os direitos reservados.</p>
        <p>Um ar melhor para um futuro mais saudável.</p>
      </footer>
    </div>
  );
}
