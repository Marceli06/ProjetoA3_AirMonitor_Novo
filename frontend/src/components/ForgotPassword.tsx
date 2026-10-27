import { useState } from 'react';
import './ForgotPassword.css';

interface ForgotPasswordProps {
  onBack: () => void;
}

export default function ForgotPassword({ onBack }: ForgotPasswordProps) {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    setTimeout(() => {
      setSubmitted(true);
      setLoading(false);
    }, 500);
  };

  return (
    <div className="forgot-password-container">
      {/* Header */}
      <header className="forgot-password-header">
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
      <main className="forgot-password-main">
        <div className="forgot-password-card">
          <div className="card-header">
            <div className="card-logo">
              <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                <rect width="100" height="100" rx="15" fill="#E6F4FF" />
                <path d="M40 60 Q40 40, 50 35 Q60 40, 60 60" fill="#0099CC" />
                <path d="M60 60 Q60 40, 70 35 Q80 40, 80 60" fill="#00CC99" />
              </svg>
            </div>
            <h1>Redefinir Senha</h1>
            <p className="subtitle">Digite seu e-mail para receber instruções de recuperação</p>
          </div>

          {!submitted ? (
            <form onSubmit={handleSubmit} className="form">
              <div className="form-group">
                <label htmlFor="email">E-mail</label>
                <input
                  type="email"
                  id="email"
                  placeholder="Ex.: seu@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading}
              >
                {loading ? 'Enviando...' : 'Enviar instruções'}
              </button>
            </form>
          ) : (
            <div className="success-message">
              <div className="success-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              </div>
              <p>Se o e-mail estiver cadastrado, você receberá instruções para redefinir sua senha.</p>
            </div>
          )}

          <button
            type="button"
            className="back-link"
            onClick={onBack}
          >
            ← Voltar para o Login
          </button>
        </div>
      </main>

      {/* Footer */}
      <footer className="forgot-password-footer">
        <p>&copy; 2024 AirMonitor. Todos os direitos reservados.</p>
        <p>Um ar melhor para um futuro mais saudável.</p>
      </footer>
    </div>
  );
}
